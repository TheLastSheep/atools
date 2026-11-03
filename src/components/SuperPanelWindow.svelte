<script lang="ts">
  import AToolsMark from "./AToolsMark.svelte";
  import { invoke } from "@tauri-apps/api/core";

  let {
    clipboardText,
    status,
    onRefresh,
    onCopy,
    onOpenMain,
  }: {
    clipboardText: string;
    status: string;
    onRefresh: () => void | Promise<void>;
    onCopy: () => void | Promise<void>;
    onOpenMain: () => void | Promise<void>;
  } = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      try {
        void invoke("set_super_panel_visible", { visible: false });
      } catch (error) {
        console.warn("Failed to hide super panel on Escape:", error);
      }
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<main class="super-panel-shell">
  <section class="super-panel-surface">
    <div class="super-panel-header">
      <AToolsMark size="small" label="超级面板" />
      <div>
        <strong>超级面板</strong>
        <span>{status || "剪贴板文本入口"}</span>
      </div>
    </div>
    <p class="super-panel-preview">{clipboardText || "剪贴板没有可用文本"}</p>
    <div class="super-panel-actions">
      <button type="button" onclick={onRefresh}>刷新</button>
      <button type="button" onclick={onCopy} disabled={!clipboardText.trim()}>复制</button>
      <button type="button" aria-label="打开 ATools 主搜索" onclick={onOpenMain}>打开主搜索</button>
    </div>
  </section>
</main>

<style>
  .super-panel-shell {
    width: 100vw;
    height: 100vh;
    display: grid;
    place-items: center;
    padding: 10px;
    background: transparent;
    overflow: hidden;
  }

  .super-panel-surface {
    width: min(100%, 440px);
    height: min(100%, 240px);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    gap: 12px;
    padding: 16px;
    border-radius: 8px;
    border: 1px solid var(--border-strong);
    background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
    box-shadow: 0 22px 58px -28px rgba(0, 0, 0, 0.58);
    backdrop-filter: blur(18px);
  }

  .super-panel-header {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .super-panel-header div {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .super-panel-header strong {
    color: var(--text-primary);
    font-size: 14px;
    line-height: 1.2;
  }

  .super-panel-header span {
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .super-panel-preview {
    min-height: 0;
    margin: 0;
    overflow: hidden;
    color: var(--text-primary);
    font-size: 13px;
    line-height: 1.55;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 5;
    line-clamp: 5;
  }

  .super-panel-actions {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .super-panel-actions button {
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--bg-primary);
    color: var(--text-primary);
    font-size: 12px;
    line-height: 1;
    transition:
      transform 120ms var(--ease-out-expo),
      border-color 120ms var(--ease-out-expo),
      background 120ms var(--ease-out-expo);
  }

  .super-panel-actions button:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: var(--accent);
    background: var(--accent-subtle);
  }

  .super-panel-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.48;
  }
</style>
