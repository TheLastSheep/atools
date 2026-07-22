<script lang="ts">
  import { onMount } from "svelte";
  import { convertFileSrc, invoke } from "@tauri-apps/api/core";
  import {
    pasteboardKindLabel,
    type PasteboardDockEdge,
    type PasteboardPreview,
  } from "../lib/pasteboard";

  type DialogMode = "preview" | "editor" | "settings" | "sync";
  type BudgetUnit = "MB" | "GB" | "TB";

  let mode = $state<DialogMode>(dialogMode());
  let itemId = $state(dialogItemId());
  let preview = $state<PasteboardPreview | null>(null);
  let errorMessage = $state("");
  let saved = $state(false);
  let dockEdge = $state<PasteboardDockEdge>("bottom");
  let compact = $state(false);
  let retentionDays = $state(90);
  let budgetValue = $state(1);
  let budgetUnit = $state<BudgetUnit>("GB");
  let sensitiveFilter = $state(true);
  let settings = $state<Record<string, unknown>>({});
  let ocrBusy = $state(false);
  let editorTitle = $state("");
  let editorText = $state("");
  let editorBusy = $state(false);
  let syncBusy = $state(false);
  let syncMessage = $state("");
  let syncFailed = $state(false);

  onMount(() => {
    const onHashChange = () => {
      mode = dialogMode();
      itemId = dialogItemId();
      void load();
    };
    window.addEventListener("hashchange", onHashChange);
    void load();
    return () => window.removeEventListener("hashchange", onHashChange);
  });

  async function load() {
    errorMessage = "";
    saved = false;
    if (mode === "preview" && itemId) {
      try {
        preview = await invoke<PasteboardPreview>("pasteboard_item_preview", { itemId });
      } catch (error) {
        errorMessage = String(error);
      }
      return;
    }
    if (mode === "editor") {
      if (!itemId) {
        preview = null;
        editorTitle = "";
        editorText = "";
        return;
      }
      try {
        preview = await invoke<PasteboardPreview>("pasteboard_item_preview", { itemId });
        editorTitle = preview.title || "";
        editorText = preview.text || "";
      } catch (error) {
        errorMessage = String(error);
      }
      return;
    }
    try {
      const raw = await invoke<string | null>("get_setting", { key: "settings-general" });
      settings = raw ? JSON.parse(raw) as Record<string, unknown> : {};
      const edge = settings.pasteboardDockEdge;
      if (edge === "top" || edge === "bottom" || edge === "left" || edge === "right") dockEdge = edge;
      compact = settings.pasteboardCompact === true;
      retentionDays = numberSetting(settings.clipboardRetentionDays, 90, 1, 3650);
      const bytes = numberSetting(settings.pasteboardAttachmentBudgetBytes, 1_073_741_824, 16 * 1024 * 1024, 1024 ** 4);
      ({ value: budgetValue, unit: budgetUnit } = displayBudget(bytes));
      sensitiveFilter = settings.pasteboardExcludeSensitiveContent !== false;
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function saveSettings() {
    const bytes = budgetBytes(budgetValue, budgetUnit);
    const next = {
      ...settings,
      pasteboardDockEdge: dockEdge,
      pasteboardCompact: compact,
      clipboardRetentionDays: Math.max(1, Math.min(3650, Math.round(retentionDays))),
      pasteboardAttachmentBudgetBytes: bytes,
      pasteboardExcludeSensitiveContent: sensitiveFilter,
    };
    try {
      await invoke("set_setting", { key: "settings-general", value: JSON.stringify(next) });
      await invoke("reposition_pasteboard_shelf_window");
      settings = next;
      saved = true;
      setTimeout(() => { saved = false; }, 1600);
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function close() {
    await invoke("hide_pasteboard_dialog_window");
  }

  async function recognizeText() {
    if (!preview || ocrBusy) return;
    ocrBusy = true;
    try {
      const text = await invoke<string>("pasteboard_recognize_item", { itemId: preview.itemId });
      preview = { ...preview, ocrText: text };
    } catch (error) {
      errorMessage = String(error);
    } finally {
      ocrBusy = false;
    }
  }

  async function saveEditor() {
    if (!editorText.trim() || editorBusy) return;
    editorBusy = true;
    try {
      if (itemId) {
        await invoke("pasteboard_update_text_item", { itemId, text: editorText, title: editorTitle || null });
      } else {
        await invoke("pasteboard_create_text_item", { text: editorText, title: editorTitle || null });
      }
      await close();
    } catch (error) {
      errorMessage = String(error);
    } finally {
      editorBusy = false;
    }
  }

  async function rotateImage(quarterTurns: number) {
    if (!preview) return;
    try {
      await invoke("pasteboard_rotate_image", { itemId: preview.itemId, quarterTurns });
      preview = await invoke<PasteboardPreview>("pasteboard_item_preview", { itemId: preview.itemId });
    } catch (error) {
      errorMessage = String(error);
    }
  }

  async function syncNow() {
    if (syncBusy) return;
    syncBusy = true;
    syncFailed = false;
    syncMessage = "正在加密并合并远端历史…";
    try {
      const result = await invoke<{ items: number; pinboards: number; blobs: number; retries: number }>("pasteboard_sync_webdav_now");
      syncMessage = `已同步 ${result.items} 条历史、${result.pinboards} 个分组和 ${result.blobs} 个附件${result.retries ? `，重试 ${result.retries} 次` : ""}`;
    } catch (error) {
      syncFailed = true;
      syncMessage = String(error);
    } finally {
      syncBusy = false;
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      void close();
    }
  }

  function dialogParams() {
    return new URLSearchParams(window.location.hash.split("?")[1] || "");
  }

  function dialogMode(): DialogMode {
    const value = dialogParams().get("mode");
    return value === "settings" || value === "sync" || value === "editor" ? value : "preview";
  }

  function dialogItemId() {
    return dialogParams().get("itemId") || "";
  }

  function numberSetting(value: unknown, fallback: number, min: number, max: number) {
    const number = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, number));
  }

  function displayBudget(bytes: number): { value: number; unit: BudgetUnit } {
    if (bytes >= 1024 ** 4 && bytes % 1024 ** 4 === 0) return { value: bytes / 1024 ** 4, unit: "TB" };
    if (bytes >= 1024 ** 3) return { value: Number((bytes / 1024 ** 3).toFixed(2)), unit: "GB" };
    return { value: Math.max(16, Math.round(bytes / 1024 ** 2)), unit: "MB" };
  }

  function budgetBytes(value: number, unit: BudgetUnit) {
    const factor = unit === "TB" ? 1024 ** 4 : unit === "GB" ? 1024 ** 3 : 1024 ** 2;
    return Math.max(16 * 1024 ** 2, Math.min(1024 ** 4, Math.round(Math.max(0, value) * factor)));
  }
</script>

<svelte:window onkeydown={onKeyDown} />

<main>
  <section class="dialog">
    <header>
      <div>
        <span class="mark">P</span>
        <div><strong>{mode === "settings" ? "Paste剪切板设置" : mode === "sync" ? "同步" : mode === "editor" ? (itemId ? "编辑文本" : "新建文本") : "内容预览"}</strong><small>{mode === "preview" && preview ? pasteboardKindLabel(preview.kind) : "Paste剪切板"}</small></div>
      </div>
      <button aria-label="关闭" onclick={close}>×</button>
    </header>

    {#if errorMessage}<p class="error">{errorMessage}</p>{/if}

    {#if mode === "preview"}
      <div class="preview-body">
        {#if !preview && !errorMessage}
          <p class="loading">正在准备预览…</p>
        {:else if preview}
          {#if preview.assetPath && preview.kind === "image"}
            <img src={convertFileSrc(preview.assetPath)} alt="剪贴板图片预览" />
          {:else if preview.assetPath && preview.kind === "pdf"}
            <embed src={convertFileSrc(preview.assetPath)} type="application/pdf" />
          {:else if preview.files.length}
            <ul>{#each preview.files as file}<li>{file}</li>{/each}</ul>
          {:else}
            <pre>{preview.text || "没有可预览的文本"}</pre>
          {/if}
          {#if preview.ocrText}<aside><strong>OCR 文本</strong><p>{preview.ocrText}</p></aside>{/if}
          <div class="preview-actions">
            {#if preview.kind === "image"}<button onclick={recognizeText} disabled={ocrBusy}>{ocrBusy ? "识别中…" : "识别文字"}</button><button onclick={() => rotateImage(-1)}>向左旋转</button><button onclick={() => rotateImage(1)}>向右旋转</button>{/if}
            {#if preview.kind === "image" || preview.kind === "pdf" || preview.kind === "files"}<button onclick={() => invoke("pasteboard_quick_look_item", { itemId: preview?.itemId })}>Quick Look</button>{/if}
          </div>
        {/if}
      </div>
    {:else if mode === "editor"}
      <form class="editor-body" onsubmit={(event) => { event.preventDefault(); void saveEditor(); }}>
        <label><span>标题</span><input bind:value={editorTitle} placeholder="可选标题" /></label>
        <label class="editor-content"><span>内容</span><textarea bind:value={editorText} placeholder="输入要保存的文本"></textarea></label>
        <footer><span>{editorText.length} 个字符</span><button type="submit" disabled={!editorText.trim() || editorBusy}>{editorBusy ? "保存中…" : "保存"}</button></footer>
      </form>
    {:else if mode === "settings"}
      <div class="settings-body">
        <section>
          <h2>显示位置</h2>
          <div class="edge-grid">
            {#each ["bottom", "top", "left", "right"] as edge}
              <button class:active={dockEdge === edge} onclick={() => dockEdge = edge as PasteboardDockEdge}>
                {edge === "bottom" ? "贴底" : edge === "top" ? "贴顶" : edge === "left" ? "贴左" : "贴右"}
              </button>
            {/each}
          </div>
          <label class="switch"><span><strong>紧凑布局</strong><small>左右贴边时会同步缩窄卡片与工具栏</small></span><input type="checkbox" bind:checked={compact} /></label>
        </section>
        <section>
          <h2>历史与附件</h2>
          <label class="field"><span>历史保留</span><div><input type="number" min="1" max="3650" bind:value={retentionDays} /><em>天</em></div></label>
          <label class="field"><span>附件预算</span><div><input type="number" min="0.01" step="0.01" bind:value={budgetValue} /><select bind:value={budgetUnit}><option>MB</option><option>GB</option><option>TB</option></select></div></label>
          <p class="hint">达到预算后只清理最旧、未固定且不属于分组的附件。</p>
          <label class="switch"><span><strong>过滤敏感内容</strong><small>私钥、访问令牌和支付卡在写入本地前排除</small></span><input type="checkbox" bind:checked={sensitiveFilter} /></label>
        </section>
        <footer><span>{saved ? "已保存" : "更改只保存在本机"}</span><button onclick={saveSettings}>保存设置</button></footer>
      </div>
    {:else}
      <div class="sync-body">
        <div class="sync-icon">↻</div>
        <h2>加密 WebDAV 同步</h2>
        <p>剪贴板正文、OCR、分组、图片和 PDF 会在本机加密，并与现有 WebDAV 配置中的独立 Paste 目录双向合并。</p>
        <button onclick={syncNow} disabled={syncBusy}>{syncBusy ? "同步中…" : "立即同步"}</button>
        {#if syncMessage}<p class:sync-error={syncFailed} class="sync-message">{syncMessage}</p>{/if}
        <small>核心历史、搜索和粘贴功能不依赖网络。</small>
      </div>
    {/if}
  </section>
</main>

<style>
  :global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent !important; }
  :global(*) { box-sizing: border-box; }
  main { width: 100%; height: 100%; display: grid; place-items: center; padding: 18px; color: #202027; font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif; }
  .dialog { width: 100%; height: 100%; overflow: hidden; border: 1px solid rgba(30,30,40,.13); border-radius: 20px; background: #f8f8fa; box-shadow: 0 24px 80px rgba(18,18,30,.28); }
  header { height: 64px; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 10px 18px; border-bottom: 1px solid rgba(30,30,40,.08); }
  header > div { display: flex; align-items: center; gap: 10px; } header > div > div { display: grid; line-height: 1.12; } header strong { font-size: 14px; } header small { margin-top: 4px; color: #8b8b96; font-size: 10px; }
  .mark { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: #fff; font-weight: 800; background: linear-gradient(145deg,#8a62ff,#486cff 58%,#30b6e8); }
  header button { width: 34px; height: 34px; border: 0; border-radius: 10px; background: #ececf0; color: #777; font-size: 22px; cursor: pointer; }
  .error { margin: 12px 18px; padding: 9px 11px; border-radius: 9px; color: #a52e3b; background: #ffe8eb; font-size: 12px; }
  .preview-body { height: calc(100% - 64px); display: grid; place-items: center; padding: 18px; overflow: auto; }
  .preview-body img, .preview-body embed { width: 100%; height: 100%; object-fit: contain; border-radius: 12px; background: #eeeef2; }
  .preview-body pre { width: 100%; height: 100%; margin: 0; overflow: auto; padding: 18px; border-radius: 12px; background: #fff; white-space: pre-wrap; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .preview-body ul { width: 100%; align-self: start; margin: 0; padding: 8px 8px 8px 28px; } .preview-body li { padding: 7px; overflow-wrap: anywhere; }
  .preview-body aside { position: absolute; right: 30px; bottom: 30px; max-width: 360px; padding: 12px; border-radius: 12px; background: rgba(255,255,255,.95); box-shadow: 0 12px 30px rgba(20,20,30,.16); } .preview-body aside p { margin: 6px 0 0; font-size: 12px; }
  .preview-actions { position: absolute; left: 30px; bottom: 30px; display: flex; gap: 8px; } .preview-actions button { height: 34px; padding: 0 12px; border: 0; border-radius: 9px; background: rgba(255,255,255,.96); color: #6244c8; box-shadow: 0 8px 22px rgba(20,20,30,.15); cursor: pointer; } .preview-actions button:disabled { opacity: .55; cursor: wait; }
  .loading { color: #888; }
  .settings-body { height: calc(100% - 64px); overflow: auto; padding: 12px 20px 18px; }
  .editor-body { height: calc(100% - 64px); display: grid; grid-template-rows: auto minmax(0,1fr) auto; gap: 14px; padding: 18px 20px; } .editor-body label { display: grid; gap: 7px; color: #777783; font-size: 12px; } .editor-body input, .editor-body textarea { width: 100%; border: 1px solid #dcdbe4; border-radius: 10px; background: #fff; color: #222; padding: 10px 12px; outline: none; font: inherit; } .editor-body textarea { height: 100%; resize: none; font: 13px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; } .editor-body footer { display: flex; align-items: center; justify-content: space-between; color: #888; font-size: 11px; } .editor-body footer button { height: 38px; border: 0; border-radius: 10px; padding: 0 20px; background: #7250dd; color: #fff; cursor: pointer; } .editor-body footer button:disabled { opacity: .5; }
  .settings-body section { padding: 13px 0 17px; border-bottom: 1px solid rgba(30,30,40,.08); } h2 { margin: 0 0 12px; font-size: 14px; }
  .edge-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 8px; } .edge-grid button { height: 44px; border: 1px solid #dedde5; border-radius: 10px; background: #fff; color: #62616b; cursor: pointer; } .edge-grid button.active { border-color: #7654e3; color: #6642d4; background: #eee9ff; box-shadow: 0 0 0 2px rgba(118,84,227,.12); }
  .switch, .field { min-height: 54px; display: flex; align-items: center; justify-content: space-between; gap: 18px; } .switch span { display: grid; gap: 4px; } .switch strong, .field > span { font-size: 13px; } .switch small, .hint { color: #8b8b96; font-size: 11px; } .switch input { width: 38px; height: 22px; accent-color: #7250dd; }
  .field > div { display: flex; align-items: center; gap: 6px; } .field input, .field select { height: 34px; border: 1px solid #dcdbe4; border-radius: 9px; background: #fff; padding: 0 9px; outline: none; } .field input { width: 110px; } .field em { color: #888; font-style: normal; font-size: 12px; }
  .hint { margin: -2px 0 6px; }
  .settings-body footer { display: flex; align-items: center; justify-content: space-between; padding-top: 16px; color: #858590; font-size: 11px; } .settings-body footer button, .sync-body button { height: 38px; border: 0; border-radius: 10px; padding: 0 18px; background: #7250dd; color: #fff; font-weight: 600; cursor: pointer; }
  .sync-body { height: calc(100% - 64px); display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 34px 56px; text-align: center; } .sync-icon { width: 72px; height: 72px; display: grid; place-items: center; border-radius: 22px; color: #fff; background: linear-gradient(145deg,#8762ff,#3d78ef); font-size: 34px; box-shadow: 0 15px 35px rgba(80,67,190,.28); } .sync-body h2 { margin: 22px 0 8px; font-size: 20px; } .sync-body p { margin: 0 0 24px; color: #74747f; font-size: 13px; line-height: 1.65; } .sync-body button:disabled { opacity: .55; cursor: wait; } .sync-body .sync-message { max-width: 420px; margin: 14px 0 0; font-size: 11px; } .sync-body .sync-message.sync-error { color: #b8404c; } .sync-body small { margin-top: 18px; color: #9696a0; }
  @media (prefers-color-scheme: dark) { main { color: #f1eff5; } .dialog { background: #202026; border-color: rgba(255,255,255,.12); } header, .settings-body section { border-color: rgba(255,255,255,.08); } header button { background: #303038; color: #bbb; } .preview-body pre, .edge-grid button, .field input, .field select { background: #292930; border-color: #3b3b45; color: #f1eff5; } .switch small, .hint, .sync-body p { color: #9b99a5; } }
</style>
