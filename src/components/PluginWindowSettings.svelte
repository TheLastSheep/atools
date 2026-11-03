<script lang="ts">
  import { settingsConfirmFocus } from "../lib/settingsConfirmFocus";
  import type { PluginWindowPreferencesState } from "../lib/pluginWindowPreferences";

  type Props = {
    preferences: PluginWindowPreferencesState;
    pluginName: string;
    onclose: () => void;
    onautoDetach: (enabled: boolean) => void;
    onreset: () => void;
    onretry: () => void;
  };

  let { preferences, pluginName, onclose, onautoDetach, onreset, onretry }: Props = $props();
  let dialogElement = $state<HTMLDialogElement | null>(null);

  function focusCloseButton() {
    dialogElement?.querySelector<HTMLButtonElement>("[data-confirm-cancel]")?.focus({ preventScroll: true });
  }

  function resetToDefault() {
    focusCloseButton();
    onreset();
  }

  function retry() {
    focusCloseButton();
    onretry();
  }
</script>

{#if preferences.open}
  <div class="plugin-window-settings-layer">
    <button class="settings-scrim" type="button" tabindex="-1" aria-label="关闭插件设置" onclick={onclose}></button>
    <dialog
      open
      class="plugin-window-settings-dialog"
      bind:this={dialogElement}
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="plugin-window-settings-title"
      use:settingsConfirmFocus={{ cancel: onclose }}
    >
      <header>
        <div>
          <h2 id="plugin-window-settings-title">{pluginName || "插件"} 设置</h2>
        </div>
        <button class="close-button" type="button" data-confirm-cancel aria-label="关闭" onclick={onclose}>×</button>
      </header>

      <section class="settings-body" aria-busy={preferences.loading || preferences.saving}>
        <div class="preference-row">
          <div class="preference-copy">
            <strong>自动分离为独立窗口</strong>
            <small>下次打开此插件时生效。</small>
          </div>
          <button
            class="preference-switch"
            type="button"
            role="switch"
            aria-label="自动分离为独立窗口"
            aria-checked={preferences.autoDetach}
            aria-disabled={!preferences.loaded || preferences.loading || preferences.saving}
            disabled={!preferences.loaded || preferences.loading}
            onclick={() => { if (preferences.loaded && !preferences.loading && !preferences.saving) onautoDetach(!preferences.autoDetach); }}
          >
            <span aria-hidden="true"></span>
          </button>
        </div>

        {#if preferences.loading}
          <p class="preference-status" role="status" aria-live="polite">正在读取插件设置…</p>
        {:else if preferences.saving}
          <p class="preference-status" role="status" aria-live="polite">{preferences.saveIntent === "reset" ? "正在恢复默认设置…" : "正在保存…"}</p>
        {:else if preferences.notice}
          <p class="preference-status" role="status" aria-live="polite">{preferences.notice}</p>
        {/if}
        {#if preferences.error}
          <div class="preference-error" role="alert">
            <p>{preferences.error}</p>
            <div class="preference-error-actions">
              {#if !preferences.loaded}<button type="button" disabled={preferences.loading || preferences.saving} onclick={resetToDefault}>重置为默认</button>{/if}
              <button type="button" disabled={preferences.loading || preferences.saving} onclick={retry}>重试</button>
            </div>
          </div>
        {/if}
      </section>

      <footer>
        <button class="close-footer-button" type="button" data-confirm-cancel onclick={onclose}>关闭</button>
      </footer>
    </dialog>
  </div>
{/if}

<style>
  .plugin-window-settings-layer { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 24px; box-sizing: border-box; }
  .settings-scrim { position: absolute; inset: 0; border: 0; background: rgba(8, 12, 20, 0.42); cursor: default; }
  .plugin-window-settings-dialog { position: relative; margin: 0; width: min(420px, calc(100vw - 32px)); padding: 0; overflow: hidden; border: 1px solid var(--border-strong); border-radius: 12px; color: var(--text-primary); background: var(--bg-elevated); box-shadow: 0 24px 64px rgba(0, 0, 0, 0.24); }
  .plugin-window-settings-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px 20px 16px; border-bottom: 1px solid var(--border); }
  h2 { margin: 0; font-size: 16px; font-weight: 650; line-height: 1.35; }
  .close-button { width: 32px; height: 32px; flex: 0 0 auto; border: 0; border-radius: 8px; color: var(--text-secondary); background: var(--bg-tertiary); font-size: 20px; line-height: 1; cursor: pointer; }
  .settings-body { display: grid; gap: 12px; padding: 20px; }
  .preference-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 16px; }
  .preference-copy { display: grid; gap: 5px; }
  .preference-copy strong { font-size: 13px; font-weight: 600; line-height: 1.35; }
  .preference-copy small { color: var(--text-secondary); font-size: 12px; line-height: 1.45; }
  .preference-switch { position: relative; width: 44px; height: 26px; padding: 2px; border: 1px solid var(--border-strong); border-radius: 999px; background: var(--bg-tertiary); cursor: pointer; }
  .preference-switch span { display: block; width: 20px; height: 20px; border-radius: 50%; background: var(--text-tertiary); }
  .preference-switch[aria-checked="true"] { border-color: var(--accent); background: var(--accent); }
  .preference-switch[aria-checked="true"] span { margin-left: auto; background: var(--accent-foreground); }
  .preference-switch:disabled, .preference-switch[aria-disabled="true"] { cursor: wait; opacity: 0.55; }
  .preference-status { margin: 0; color: var(--text-tertiary); font-size: 12px; line-height: 1.4; }
  .preference-error { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; padding: 10px 12px; border: 1px solid color-mix(in srgb, #d14343 35%, var(--border)); border-radius: 8px; color: var(--text-primary); background: color-mix(in srgb, #d14343 8%, var(--bg-primary)); }
  .preference-error p { margin: 0; font-size: 12px; line-height: 1.45; overflow-wrap: anywhere; }
  .preference-error-actions { display: flex; flex: 0 0 auto; gap: 8px; }
  .preference-error button, .close-footer-button { min-height: 32px; border: 1px solid var(--border-strong); border-radius: 7px; padding: 0 12px; color: var(--text-primary); background: var(--bg-tertiary); font-size: 12px; font-weight: 600; cursor: pointer; }
  .preference-error button:hover, .close-button:hover, .close-footer-button:hover { background: var(--bg-hover); }
  footer { display: flex; justify-content: flex-end; padding: 0 20px 18px; }
  :global(.plugin-window-settings-dialog button:focus-visible) { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 480px) { .plugin-window-settings-layer { padding: 16px; } .plugin-window-settings-dialog { width: 100%; } }
</style>
