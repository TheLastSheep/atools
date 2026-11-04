<script lang="ts">
  import { onMount } from "svelte";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import PasteboardPinboardNav from "./PasteboardPinboardNav.svelte";
  import "./PasteboardShelf.css";
  import {
    pasteboardItemText,
    pasteboardKindLabel,
    relativePasteboardTime,
    type PasteboardCaptureStatus,
    type PasteboardDockEdge,
    type PasteboardItem,
    type PasteboardPasteOutcome,
    type PasteboardPinboard,
    type PasteboardPreview,
  } from "../lib/pasteboard";

  let items = $state<PasteboardItem[]>([]);
  let pinboards = $state<PasteboardPinboard[]>([]);
  let query = $state("");
  let activePinboardId = $state("");
  let selectedIndex = $state(0);
  let selectedIds = $state<Set<string>>(new Set());
  let captureStatus = $state<PasteboardCaptureStatus>({ paused: false, lastChangeCount: -1 });
  let dockEdge = $state<PasteboardDockEdge>("bottom");
  let compact = $state(false);
  let loading = $state(true);
  let errorMessage = $state("");
  let accessibilityRequired = $state(false);
  let scrollOffset = $state(0);
  let viewportLength = $state(1200);
  let timeline: HTMLElement | null = $state(null);
  let userScrollingUntil = 0;
  let scrollTimer: ReturnType<typeof setTimeout> | null = null;
  let thumbnails = $state<Record<string, string>>({});
  let pasteStack = $state<string[]>([]);
  let requestSerial = 0;

  const isVertical = $derived(dockEdge === "left" || dockEdge === "right");
  const itemExtent = $derived(isVertical ? (compact ? 112 : 142) : (compact ? 178 : 226));
  const selectedItem = $derived(items[selectedIndex] ?? null);
  const virtualStart = $derived(Math.max(0, Math.floor(scrollOffset / itemExtent) - 4));
  const virtualCount = $derived(Math.ceil(viewportLength / itemExtent) + 9);
  const virtualEnd = $derived(Math.min(items.length, virtualStart + virtualCount));
  const visibleItems = $derived(items.slice(virtualStart, virtualEnd));

  $effect(() => {
    for (const item of visibleItems) {
      if (item.kind === "image" && !thumbnails[item.id]) void loadThumbnail(item.id);
    }
  });

  onMount(() => {
    let cancelled = false;
    let stopChanged: (() => void) | undefined;
    let stopError: (() => void) | undefined;
    let stopStack: (() => void) | undefined;
    void loadSettings().then(loadAll);
    const onWindowFocus = () => {
      if (accessibilityRequired) void refreshAccessibilityPermission();
    };
    window.addEventListener("focus", onWindowFocus);
    listen<{ status?: string; itemId?: string }>("pasteboard://changed", (event) => {
      if (cancelled) return;
      const shouldFollow = Date.now() >= userScrollingUntil;
      if (event.payload?.itemId && (event.payload.status === "image_updated" || event.payload.status === "ocr_updated")) {
        const next = { ...thumbnails };
        delete next[event.payload.itemId];
        thumbnails = next;
      }
      void loadItems(event.payload?.itemId && shouldFollow ? event.payload.itemId : undefined);
    }).then((stop) => {
      if (cancelled) stop();
      else stopChanged = stop;
    });
    listen<{ message?: string }>("pasteboard://capture-error", (event) => {
      if (!cancelled) errorMessage = event.payload?.message || "剪贴板捕获失败";
    }).then((stop) => {
      if (cancelled) stop();
      else stopError = stop;
    });
    listen<{ itemIds?: string[] }>("pasteboard://stack", (event) => {
      if (!cancelled) pasteStack = event.payload?.itemIds ?? [];
    }).then((stop) => {
      if (cancelled) stop();
      else stopStack = stop;
    });
    invoke<{ itemIds?: string[] }>("pasteboard_stack_status")
      .then((status) => { if (!cancelled) pasteStack = status.itemIds ?? []; })
      .catch(() => {});
    const observer = new ResizeObserver(() => updateViewport());
    if (timeline) observer.observe(timeline);
    updateViewport();
    return () => {
      cancelled = true;
      stopChanged?.();
      stopError?.();
      stopStack?.();
      window.removeEventListener("focus", onWindowFocus);
      observer.disconnect();
      if (scrollTimer) clearTimeout(scrollTimer);
    };
  });

  async function loadSettings() {
    try {
      const raw = await invoke<string | null>("get_setting", { key: "settings-general" });
      const settings = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const edge = settings.pasteboardDockEdge;
      if (edge === "top" || edge === "bottom" || edge === "left" || edge === "right") dockEdge = edge;
      compact = settings.pasteboardCompact === true;
    } catch {
      // Defaults keep the shelf usable.
    }
  }

  async function loadAll() {
    loading = true;
    await Promise.all([loadItems(), loadPinboards(), loadCaptureStatus()]);
    loading = false;
  }

  async function loadItems(followItemId?: string) {
    const serial = ++requestSerial;
    try {
      const next = await invoke<PasteboardItem[]>("pasteboard_list_items", {
        query,
        pinboardId: activePinboardId || null,
        kinds: null,
        limit: 500,
        offset: 0,
      });
      if (serial !== requestSerial) return;
      const previousId = selectedItem?.id;
      items = next;
      const targetId = followItemId || previousId;
      selectedIndex = targetId ? Math.max(0, next.findIndex((item) => item.id === targetId)) : 0;
      if (selectedIndex < 0) selectedIndex = 0;
      selectedIds = new Set(next.filter((item) => selectedIds.has(item.id)).map((item) => item.id));
      errorMessage = "";
      if (followItemId) requestAnimationFrame(() => scrollToSelection("smooth"));
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function loadPinboards() {
    try {
      pinboards = await invoke<PasteboardPinboard[]>("pasteboard_list_pinboards");
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function loadCaptureStatus() {
    captureStatus = await invoke<PasteboardCaptureStatus>("pasteboard_capture_status");
  }

  async function loadThumbnail(itemId: string) {
    try {
      const preview = await invoke<PasteboardPreview>("pasteboard_item_preview", { itemId });
      if (preview.assetPath) thumbnails = { ...thumbnails, [itemId]: convertFileSrc(preview.assetPath) };
    } catch {
      // A missing thumbnail falls back to the lightweight image placeholder.
    }
  }

  function updateViewport() {
    if (!timeline) return;
    viewportLength = isVertical ? timeline.clientHeight : timeline.clientWidth;
  }

  function onScroll() {
    if (!timeline) return;
    scrollOffset = isVertical ? timeline.scrollTop : timeline.scrollLeft;
    userScrollingUntil = Date.now() + 700;
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { userScrollingUntil = Date.now(); }, 720);
  }

  function cardStyle(index: number) {
    const offset = index * itemExtent;
    return isVertical
      ? `transform:translate3d(0,${offset}px,0);height:${itemExtent - 10}px`
      : `transform:translate3d(${offset}px,0,0);width:${itemExtent - 10}px`;
  }

  function canvasStyle() {
    return isVertical
      ? `height:${items.length * itemExtent}px;width:100%`
      : `width:${items.length * itemExtent}px;height:100%`;
  }

  function selectItem(index: number, event?: MouseEvent) {
    if (index < 0 || index >= items.length) return;
    selectedIndex = index;
    const id = items[index].id;
    if (event?.metaKey || event?.ctrlKey) {
      const next = new Set(selectedIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      selectedIds = next;
    } else if (event?.shiftKey && selectedIds.size > 0) {
      const anchorId = [...selectedIds][0];
      const anchor = Math.max(0, items.findIndex((item) => item.id === anchorId));
      const [start, end] = anchor < index ? [anchor, index] : [index, anchor];
      selectedIds = new Set(items.slice(start, end + 1).map((item) => item.id));
    } else {
      selectedIds = new Set([id]);
    }
  }

  function moveSelection(delta: number) {
    if (!items.length) return;
    selectedIndex = Math.max(0, Math.min(items.length - 1, selectedIndex + delta));
    selectedIds = new Set([items[selectedIndex].id]);
    scrollToSelection("smooth");
  }

  function scrollToSelection(behavior: ScrollBehavior = "auto") {
    if (!timeline) return;
    const start = selectedIndex * itemExtent;
    const end = start + itemExtent;
    const current = isVertical ? timeline.scrollTop : timeline.scrollLeft;
    const viewport = isVertical ? timeline.clientHeight : timeline.clientWidth;
    let target = current;
    if (start < current) target = start;
    else if (end > current + viewport) target = end - viewport;
    if (target === current) return;
    timeline.scrollTo(isVertical ? { top: target, behavior } : { left: target, behavior });
  }

  async function pasteSelected(plainText = false) {
    if (!selectedItem) return;
    try {
      const outcome = await invoke<PasteboardPasteOutcome>("pasteboard_paste_item", {
        itemId: selectedItem.id,
        plainText,
      });
      accessibilityRequired = outcome.warningCode === "accessibility_required";
      errorMessage = outcome.warning || "";
    } catch (error) {
      accessibilityRequired = false;
      errorMessage = String(error);
    }
  }

  async function openAccessibilitySettings() {
    try {
      await invoke("open_accessibility_settings");
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function refreshAccessibilityPermission() {
    try {
      const status = await invoke<{ trusted?: boolean }>("get_accessibility_permission_status");
      if (status.trusted === true) {
        accessibilityRequired = false;
        errorMessage = "";
      }
    } catch {
      // Keep the actionable permission message visible when status cannot be read.
    }
  }

  async function copySelected(plainText = false) {
    if (!selectedItem) return;
    try {
      await invoke("pasteboard_copy_item", { itemId: selectedItem.id, plainText });
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function togglePaused() {
    captureStatus = await invoke<PasteboardCaptureStatus>("pasteboard_set_capture_paused", {
      paused: !captureStatus.paused,
    });
  }

  async function activatePinboard(id: string) {
    activePinboardId = id;
    selectedIndex = 0;
    selectedIds = new Set();
    await loadItems();
    timeline?.scrollTo({ top: 0, left: 0 });
  }

  async function onPinboardDeleted(deletedId: string) {
    if (activePinboardId === deletedId) activePinboardId = "";
    await Promise.all([loadPinboards(), loadItems()]);
  }

  async function moveSelectionToPinboard(pinboardId: string | null) {
    const ids = selectedIds.size ? [...selectedIds] : selectedItem ? [selectedItem.id] : [];
    if (!ids.length) return;
    await invoke("pasteboard_assign_items", { itemIds: ids, pinboardId });
    await loadItems();
  }

  async function addToStack() {
    const ids = selectedIds.size ? [...selectedIds] : selectedItem ? [selectedItem.id] : [];
    const itemIds = [...pasteStack, ...ids.filter((id) => !pasteStack.includes(id))];
    const status = await invoke<{ itemIds: string[] }>("pasteboard_set_stack", { itemIds });
    pasteStack = status.itemIds;
  }

  async function openDialog(mode: "preview" | "editor" | "settings" | "sync") {
    await invoke("open_pasteboard_dialog_window", { mode, itemId: mode === "preview" || mode === "editor" ? selectedItem?.id ?? null : null });
  }

  async function hideShelf() {
    await invoke("hide_pasteboard_shelf_window");
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      void hideShelf();
      return;
    }
    if (event.metaKey && /^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1;
      if (items[index]) {
        event.preventDefault();
        selectedIndex = index;
        void pasteSelected(event.shiftKey);
      }
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      document.getElementById("paste-search")?.focus();
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === "e") {
      event.preventDefault();
      void openDialog("editor");
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === "n") {
      event.preventDefault();
      void invoke("open_pasteboard_dialog_window", { mode: "editor", itemId: null });
      return;
    }
    if (event.metaKey && event.key.toLowerCase() === "c") {
      event.preventDefault();
      void copySelected(event.shiftKey);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      void pasteSelected(event.shiftKey);
      return;
    }
    if (event.key === " ") {
      if ((event.target as HTMLElement | null)?.tagName === "INPUT") return;
      event.preventDefault();
      void openDialog("preview");
      return;
    }
    const previousKey = isVertical ? "ArrowUp" : "ArrowLeft";
    const nextKey = isVertical ? "ArrowDown" : "ArrowRight";
    if (event.key === previousKey || event.key === nextKey) {
      event.preventDefault();
      moveSelection(event.key === previousKey ? -1 : 1);
    }
  }

  function cardTitle(item: PasteboardItem) {
    return item.title || pasteboardItemText(item).split(/\r?\n/)[0] || pasteboardKindLabel(item.kind);
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<main data-pasteboard-shelf class:vertical={isVertical} class:compact class={`dock-${dockEdge}`}>
  <section class="shelf">
    <header class="toolbar">
      <div class="brand" aria-label="Paste剪切板">
        <span class="brand-mark">P</span>
        <div><strong>Paste剪切板</strong><small>{items.length} 项</small></div>
      </div>
      <label class="search-wrap">
        <span>⌕</span>
        <input
          id="paste-search"
          value={query}
          oninput={(event) => { query = event.currentTarget.value; void loadItems(); }}
          placeholder="搜索历史、来源、OCR…"
          autocomplete="off"
        />
        {#if query}<button aria-label="清空搜索" onclick={() => { query = ""; void loadItems(); }}>×</button>{/if}
      </label>
      <div class="toolbar-actions">
        <button class:active={pasteStack.length > 0} title="加入粘贴队列；关闭后连续按 Command+V 依次粘贴" onclick={addToStack}>队列 {pasteStack.length || ""}</button>
        <button title="新建文本" onclick={() => invoke("open_pasteboard_dialog_window", { mode: "editor", itemId: null })}>新建</button>
        <button class:paused={captureStatus.paused} title="暂停或继续捕获" onclick={togglePaused}>{captureStatus.paused ? "继续" : "暂停"}</button>
        <button title="同步" onclick={() => openDialog("sync")}>同步</button>
        <button title="设置" onclick={() => openDialog("settings")}>设置</button>
      </div>
    </header>

    <PasteboardPinboardNav
      {pinboards}
      {activePinboardId}
      onactivate={activatePinboard}
      onreloadpinboards={loadPinboards}
      onreloadall={onPinboardDeleted}
      onmoveselection={moveSelectionToPinboard}
    />

    <section class="timeline-wrap">
      {#if loading}
        <div class="empty">正在加载剪贴板历史…</div>
      {:else if errorMessage}
        <div class="empty error">
          {errorMessage}
          {#if accessibilityRequired}
            <button onclick={openAccessibilitySettings}>打开辅助功能设置</button>
          {:else}
            <button onclick={loadAll}>重试</button>
          {/if}
        </div>
      {:else if items.length === 0}
        <div class="empty">复制文本、图片或文件后，它会立即出现在这里。</div>
      {:else}
        <div class="timeline" bind:this={timeline} onscroll={onScroll} class:vertical={isVertical}>
          <div class="virtual-canvas" style={canvasStyle()}>
            {#each visibleItems as item, visibleIndex (item.id)}
              {@const index = virtualStart + visibleIndex}
              <button
                class="paste-card"
                class:selected={index === selectedIndex}
                class:multi={selectedIds.has(item.id)}
                style={cardStyle(index)}
                onclick={(event) => selectItem(index, event)}
                ondblclick={() => pasteSelected(false)}
              >
                <span class="card-type">{pasteboardKindLabel(item.kind)}</span>
                {#if item.kind === "image"}
                  <span class="card-image">
                    {#if thumbnails[item.id]}<img src={thumbnails[item.id]} alt="图片缩略图" decoding="async" />{:else}<b>IMG</b>{/if}
                  </span>
                {:else if item.kind === "color"}
                  <span class="color-preview" style={`--paste-color:${pasteboardItemText(item)}`}></span>
                {:else}
                  <strong>{cardTitle(item)}</strong>
                  <p>{pasteboardItemText(item)}</p>
                {/if}
                <footer>
                  <span>{item.sourceApp?.name || "未知来源"}</span>
                  <time>{relativePasteboardTime(item.copiedAt)}</time>
                </footer>
                {#if index < 9}<kbd>⌘{index + 1}</kbd>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}
    </section>

    <footer class="statusbar">
      <span>{selectedItem ? `${selectedIndex + 1} / ${items.length} · ${selectedItem.sourceApp?.name || "未知来源"}` : "无选中项"}</span>
      <div><kbd>← →</kbd> 选择 <kbd>Enter</kbd> 粘贴 <kbd>Space</kbd> 预览 <kbd>Esc</kbd> 关闭</div>
    </footer>
  </section>
</main>
