<script lang="ts">
  import { untrack } from "svelte";
  import PluginInventoryPanel from "../../src/components/PluginInventoryPanel.svelte";
  import { providePluginRuntimeControl, type PluginRuntimeControl } from "../../src/lib/pluginRuntimeControl";

  type Props = { control: PluginRuntimeControl };
  let { control }: Props = $props();
  providePluginRuntimeControl(untrack(() => control));
</script>

<main class="fixture-root">
  <aside class="fixture-disclaimer" role="note">
    浏览器验收夹具：以下插件与运行状态均为模拟数据，IPC 受控；不代表真实 Rust、Node 或系统进程。
  </aside>
  <PluginInventoryPanel confirm={async () => false} />
</main>

<style>
  /* Palette mirrors SettingsPanel.svelte's settings-panel tokens at lines 5920-5935 and dark variant at 8543-8552. */
  :global(*) { box-sizing: border-box; }
  :global(html), :global(body), :global(#app) { width: 100%; min-width: 0; min-height: 100%; margin: 0; }
  :global(body) { color: var(--text-primary); background: var(--bg-primary); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .fixture-root {
    width: 100%; min-height: 100vh; padding: 16px; color: #333333; background: rgba(244, 244, 244, 0.72);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 12%, white);
    --settings-divider: rgba(0, 0, 0, 0.1);
    --settings-control: rgba(0, 0, 0, 0.035);
    --settings-control-border: rgba(0, 0, 0, 0.1);
    --settings-text-secondary: #616161;
  }
  .fixture-disclaimer { max-width: 100%; margin: 0 0 12px; padding: 8px 10px; border: 1px solid #dbc98e; border-radius: 7px; color: #604b16; background: #fff9df; font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  @media (max-width: 540px) { .fixture-root { padding: 10px; } }
  :global(:root[data-atools-theme="light"]) .fixture-root {
    color: #333333; background: rgba(244, 244, 244, 0.72);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 12%, white);
    --settings-divider: rgba(0, 0, 0, 0.1);
    --settings-control: rgba(0, 0, 0, 0.035);
    --settings-control-border: rgba(0, 0, 0, 0.1);
    --settings-text-secondary: #616161;
  }
  :global(:root[data-atools-theme="dark"]) .fixture-root {
    color: #f3f4f6; background: rgba(48, 49, 51, 0.92);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 18%, rgba(255, 255, 255, 0.06));
    --settings-divider: rgba(255, 255, 255, 0.1);
    --settings-control: rgba(255, 255, 255, 0.04);
    --settings-control-border: rgba(255, 255, 255, 0.1);
    --settings-text-secondary: #bfc0c3;
  }
  @media (prefers-color-scheme: dark) {
    .fixture-root {
      color: #f3f4f6; background: rgba(48, 49, 51, 0.92);
      --settings-primary: var(--accent);
      --settings-primary-soft: var(--accent-subtle);
      --settings-hover: color-mix(in srgb, var(--accent) 18%, rgba(255, 255, 255, 0.06));
      --settings-divider: rgba(255, 255, 255, 0.1);
      --settings-control: rgba(255, 255, 255, 0.04);
      --settings-control-border: rgba(255, 255, 255, 0.1);
      --settings-text-secondary: #bfc0c3;
    }
    .fixture-disclaimer { color: #f5df9a; border-color: #695d36; background: #2b271b; }
  }
</style>
