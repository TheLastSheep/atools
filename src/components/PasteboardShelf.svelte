<script lang="ts">
  import { onMount } from "svelte";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
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
  let groupMenuId = $state("");
  let renameGroupId = $state("");
  let renameGroupName = $state("");
  let deleteGroupId = $state("");
  let newGroupOpen = $state(false);
  let newGroupName = $state("");
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

  async function createPinboard() {
    const name = newGroupName.trim();
    if (!name) return;
    await invoke("pasteboard_save_pinboard", { id: null, name, color: "#7C5CFF", orderKey: null });
    newGroupName = "";
    newGroupOpen = false;
    await loadPinboards();
  }

  function beginRenamePinboard(pinboard: PasteboardPinboard) {
    renameGroupId = pinboard.id;
    renameGroupName = pinboard.name;
  }

  async function renamePinboard(pinboard: PasteboardPinboard) {
    const name = renameGroupName.trim();
    if (!name || name === pinboard.name) return;
    await invoke("pasteboard_save_pinboard", {
      id: pinboard.id,
      name,
      color: pinboard.color,
      orderKey: pinboard.orderKey,
    });
    renameGroupId = "";
    renameGroupName = "";
    groupMenuId = "";
    await loadPinboards();
  }

  async function deletePinboard(pinboard: PasteboardPinboard) {
    await invoke("pasteboard_delete_pinboard", { id: pinboard.id });
    if (activePinboardId === pinboard.id) activePinboardId = "";
    deleteGroupId = "";
    groupMenuId = "";
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

<main class:vertical={isVertical} class:compact class={`dock-${dockEdge}`}>
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

    <nav class="pinboards" aria-label="分组">
      <button class:active={!activePinboardId} onclick={() => activatePinboard("")}>全部</button>
      {#each pinboards as pinboard}
        <div class="pinboard-item">
          <button class:active={activePinboardId === pinboard.id} onclick={() => activatePinboard(pinboard.id)}>
            <i style={`--group-color:${pinboard.color}`}></i>{pinboard.name}
          </button>
          <button class="more" aria-label={`${pinboard.name}更多操作`} onclick={() => groupMenuId = groupMenuId === pinboard.id ? "" : pinboard.id}>•••</button>
          {#if groupMenuId === pinboard.id}
            <div class="group-menu">
              {#if renameGroupId === pinboard.id}
                <form class="rename-group" onsubmit={(event) => { event.preventDefault(); void renamePinboard(pinboard); }}>
                  <input bind:value={renameGroupName} aria-label="新的分组名称" />
                  <div><button type="submit" disabled={!renameGroupName.trim()}>保存</button><button type="button" onclick={() => { renameGroupId = ""; renameGroupName = ""; }}>取消</button></div>
                </form>
              {:else if deleteGroupId === pinboard.id}
                <div class="delete-group"><p>删除后内容会回到全部历史。</p><div><button class="danger" onclick={() => deletePinboard(pinboard)}>确认删除</button><button onclick={() => deleteGroupId = ""}>取消</button></div></div>
              {:else}
                <button onclick={() => beginRenamePinboard(pinboard)}>重命名分组</button>
                <button onclick={() => moveSelectionToPinboard(pinboard.id)}>移入所选内容</button>
                <button class="danger" onclick={() => deleteGroupId = pinboard.id}>删除分组</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if newGroupOpen}
        <form class="new-group" onsubmit={(event) => { event.preventDefault(); void createPinboard(); }}>
          <input bind:value={newGroupName} placeholder="分组名称" />
          <button type="submit">创建</button>
        </form>
      {:else}
        <button class="add-group" onclick={() => newGroupOpen = true}>＋ 新建分组</button>
      {/if}
    </nav>

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

<style>
  :global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent !important; }
  :global(*) { box-sizing: border-box; }
  main { width: 100%; height: 100%; padding: 8px 10px 0; color: #17171b; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; }
  main.dock-top { padding: 0 10px 8px; }
  main.dock-left { padding: 10px 8px 10px 0; }
  main.dock-right { padding: 10px 0 10px 8px; }
  .shelf { width: 100%; height: 100%; display: grid; grid-template-rows: 58px 38px minmax(0,1fr) 30px; overflow: hidden; background: rgba(247,247,250,.98); border: 1px solid rgba(40,40,50,.13); border-bottom: 0; border-radius: 20px 20px 0 0; box-shadow: 0 -18px 52px rgba(20,20,35,.2); }
  .dock-top .shelf { border-top: 0; border-bottom: 1px solid rgba(40,40,50,.13); border-radius: 0 0 20px 20px; box-shadow: 0 18px 52px rgba(20,20,35,.2); }
  .dock-left .shelf { border-left: 0; border-bottom: 1px solid rgba(40,40,50,.13); border-radius: 0 20px 20px 0; box-shadow: 18px 0 52px rgba(20,20,35,.2); }
  .dock-right .shelf { border-right: 0; border-bottom: 1px solid rgba(40,40,50,.13); border-radius: 20px 0 0 20px; box-shadow: -18px 0 52px rgba(20,20,35,.2); }
  .toolbar { display: flex; align-items: center; gap: 14px; padding: 9px 14px; border-bottom: 1px solid rgba(30,30,40,.08); }
  .brand { display: flex; align-items: center; gap: 9px; min-width: 160px; }
  .brand-mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: white; font-weight: 800; background: linear-gradient(145deg,#8a62ff,#486cff 58%,#30b6e8); box-shadow: 0 5px 14px rgba(90,77,220,.3); }
  .brand div { display: grid; line-height: 1.1; } .brand strong { font-size: 14px; } .brand small { margin-top: 3px; color: #858590; font-size: 10px; }
  .search-wrap { height: 38px; flex: 1; max-width: 560px; display: flex; align-items: center; gap: 8px; padding: 0 11px; border: 1px solid rgba(40,40,50,.1); border-radius: 12px; background: white; box-shadow: inset 0 1px 2px rgba(10,10,20,.03); }
  .search-wrap input { min-width: 0; flex: 1; border: 0; outline: 0; background: transparent; color: inherit; font-size: 13px; }
  button { border: 0; font: inherit; color: inherit; cursor: pointer; }
  .search-wrap button { background: transparent; color: #999; font-size: 18px; }
  .toolbar-actions { margin-left: auto; display: flex; gap: 6px; }
  .toolbar-actions button { height: 32px; padding: 0 11px; border-radius: 9px; background: rgba(80,80,95,.07); color: #4b4b55; font-size: 12px; }
  .toolbar-actions button:hover, .toolbar-actions button.active { background: #ebe6ff; color: #6542dc; }
  .toolbar-actions button.paused { background: #fff0d5; color: #9a5b00; }
  .pinboards { display: flex; align-items: center; gap: 4px; min-width: 0; padding: 4px 14px; overflow: visible; border-bottom: 1px solid rgba(30,30,40,.07); }
  .pinboards > button, .pinboard-item > button:first-child { height: 28px; padding: 0 10px; border-radius: 8px; background: transparent; color: #666671; font-size: 12px; white-space: nowrap; }
  .pinboards button.active { color: #5e39d5; background: #ebe6ff; font-weight: 600; }
  .pinboard-item { position: relative; display: flex; align-items: center; }
  .pinboard-item i { display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--group-color); }
  .pinboard-item .more { width: 24px; height: 28px; margin-left: -5px; border-radius: 7px; color: #aaa; background: transparent; font-size: 10px; }
  .group-menu { position: absolute; z-index: 30; top: 31px; left: 4px; width: 154px; display: grid; gap: 2px; padding: 6px; border: 1px solid rgba(30,30,40,.1); border-radius: 11px; background: #fff; box-shadow: 0 14px 35px rgba(20,20,35,.18); }
  .group-menu button { padding: 8px 9px; border-radius: 7px; background: transparent; text-align: left; font-size: 12px; } .group-menu button:hover { background: #f2f0fa; } .group-menu .danger { color: #d23b4a; }
  .rename-group { display: grid; gap: 6px; } .rename-group input { min-width: 0; width: 100%; height: 32px; border: 1px solid #cfc9e7; border-radius: 7px; padding: 0 8px; outline: 0; } .rename-group div { display: flex; gap: 4px; } .rename-group div button { flex: 1; text-align: center; background: #f1eefb; color: #6542d1; } .rename-group div button:disabled { opacity: .45; cursor: default; }
  .delete-group { display: grid; gap: 6px; padding: 3px; } .delete-group p { margin: 0; color: #777783; font-size: 10px; line-height: 1.4; } .delete-group div { display: flex; gap: 4px; } .delete-group div button { flex: 1; padding: 7px 5px; text-align: center; background: #f1eefb; } .delete-group div .danger { background: #fff0f1; }
  .add-group { color: #6a4bd4 !important; }
  .new-group { display: flex; gap: 4px; } .new-group input { width: 110px; border: 1px solid #cfc9e7; border-radius: 7px; padding: 4px 7px; outline: 0; } .new-group button { border-radius: 7px; padding: 0 8px; background: #7050df; color: #fff; }
  .timeline-wrap { min-width: 0; min-height: 0; position: relative; }
  .timeline { width: 100%; height: 100%; overflow-x: auto; overflow-y: hidden; overscroll-behavior: contain; scrollbar-width: none; }
  .timeline::-webkit-scrollbar { display: none; }
  .timeline.vertical { overflow-x: hidden; overflow-y: auto; }
  .virtual-canvas { position: relative; min-width: 100%; min-height: 100%; }
  .paste-card { position: absolute; top: 10px; bottom: 10px; display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: 8px; padding: 13px; overflow: hidden; border: 1px solid rgba(35,35,45,.1); border-radius: 15px; background: #fff; text-align: left; box-shadow: 0 5px 18px rgba(30,30,45,.07); transition: border-color .14s ease, box-shadow .14s ease, transform .14s ease; }
  .vertical .paste-card { left: 10px; right: 10px; top: 0; bottom: auto; }
  .paste-card:hover { border-color: rgba(103,72,211,.28); box-shadow: 0 8px 24px rgba(40,30,80,.12); }
  .paste-card.selected { border-color: #7454e5; box-shadow: 0 0 0 2px rgba(116,84,229,.18), 0 10px 28px rgba(73,52,150,.18); }
  .paste-card.multi::after { content: "✓"; position: absolute; right: 9px; top: 9px; width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; color: white; background: #7454e5; font-size: 11px; }
  .card-type { width: max-content; padding: 3px 7px; border-radius: 6px; color: #7054cf; background: #f0ecff; font-size: 10px; font-weight: 600; }
  .paste-card strong { align-self: end; max-height: 44px; overflow: hidden; font-size: 14px; line-height: 1.35; }
  .paste-card p { margin: -2px 0 0; overflow: hidden; color: #777783; font-size: 11px; line-height: 1.45; white-space: pre-wrap; }
  .paste-card footer { display: flex; justify-content: space-between; gap: 8px; color: #9696a1; font-size: 10px; }
  .paste-card kbd { position: absolute; right: 10px; bottom: 33px; padding: 2px 5px; border-radius: 5px; background: #f1f1f5; color: #888; font-size: 9px; }
  .card-image { position: relative; width: 100%; min-width: 0; min-height: 0; display: grid; place-items: center; overflow: hidden; border-radius: 10px; background: linear-gradient(135deg,#f1eff8,#e7ebf7); }
  .card-image img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; object-fit: contain; } .card-image b { color: #8e86a8; font-size: 13px; }
  .color-preview { width: 100%; min-height: 70px; border-radius: 10px; background: var(--paste-color,#777); box-shadow: inset 0 0 0 1px rgba(0,0,0,.08); }
  .statusbar { display: flex; align-items: center; justify-content: space-between; padding: 0 14px; border-top: 1px solid rgba(30,30,40,.07); color: #858590; font-size: 10px; }
  kbd { padding: 2px 5px; border-radius: 4px; background: rgba(60,60,75,.08); font-family: inherit; font-size: 9px; }
  .empty { position: absolute; inset: 0; display: grid; place-items: center; color: #8b8b96; font-size: 13px; } .empty.error { color: #b8404c; } .empty button { margin-left: 8px; padding: 6px 10px; border-radius: 8px; background: #eeeaf9; color: #6542d1; }
  main.vertical .shelf { grid-template-rows: auto auto minmax(0,1fr) 34px; }
  main.vertical .toolbar { align-items: stretch; flex-wrap: wrap; padding: 12px; }
  main.vertical .brand { width: 100%; } main.vertical .search-wrap { order: 3; width: 100%; flex-basis: 100%; } main.vertical .toolbar-actions { width: 100%; margin: 0; justify-content: space-between; } main.vertical .toolbar-actions button { flex: 1; padding: 0 5px; }
  main.vertical .pinboards { padding: 7px 10px; overflow-x: auto; }
  main.compact .brand div, main.compact .paste-card p { display: none; }
  main.compact .card-type { height: 0; padding: 0; overflow: hidden; visibility: hidden; line-height: 0; }
  @media (prefers-color-scheme: dark) {
    main { color: #f4f2f7; }
    .shelf { background: rgba(29,29,34,.98); border-color: rgba(255,255,255,.12); }
    .toolbar, .pinboards, .statusbar { border-color: rgba(255,255,255,.08); }
    .search-wrap, .paste-card, .group-menu { background: #25252b; border-color: rgba(255,255,255,.1); }
    .paste-card p, .paste-card footer, .statusbar { color: #9d9ca7; }
    .toolbar-actions button { background: rgba(255,255,255,.07); color: #cac8d1; }
    .card-image { background: #202027; }
  }
</style>
