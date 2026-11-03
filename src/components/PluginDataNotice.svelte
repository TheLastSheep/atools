<script lang="ts">
  import type { PluginDataStatus } from "../lib/pluginDataController";
  let { status, busy = false, onreopen }: { status: PluginDataStatus; busy?: boolean; onreopen: () => void } = $props();
</script>

<div class="data-notice" role="status" aria-live="polite">
  <span>{status.message}</span>
  {#if status.state !== "pending"}
    <button type="button" disabled={busy} onclick={onreopen}>{busy ? "正在打开…" : "重新打开"}</button>
  {/if}
</div>

<style>
  .data-notice { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 16px; border-bottom: 1px solid var(--border-strong); background: var(--bg-tertiary); color: var(--text-primary); font-size: 12px; line-height: 1.5; }
  button { flex-shrink: 0; min-height: 32px; padding: 4px 12px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-elevated); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:hover { background: var(--bg-hover); }
  button:active { background: var(--accent-subtle); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: .55; cursor: default; }
</style>
