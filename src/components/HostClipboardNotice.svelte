<script lang="ts">
  import type { HostClipboardStatus } from "../lib/hostClipboardController";
  let { status, busy = false, onreopen }: { status: HostClipboardStatus; busy?: boolean; onreopen: () => void } = $props();
</script>

<div class="clipboard-notice" role="status" aria-live="polite">
  <span>{status.message}</span>
  {#if status.state !== "pending"}
    <button type="button" disabled={busy} onclick={onreopen}>{busy ? "正在打开…" : "重新打开"}</button>
  {/if}
</div>

<style>
  .clipboard-notice { display: flex; align-items: center; gap: 12px; justify-content: space-between; padding: 10px 16px; border-bottom: 1px solid var(--border-color, #dedee3); background: var(--surface-secondary, #f6f6f8); color: var(--text-primary, #27272a); font-size: 12px; line-height: 1.5; }
  button { flex-shrink: 0; border: 1px solid var(--border-color, #d1d1d6); border-radius: 6px; padding: 4px 10px; background: var(--surface-primary, #fff); color: inherit; font: inherit; cursor: pointer; }
  button:focus-visible { outline: 2px solid var(--accent-color, #5c63e8); outline-offset: 2px; }
  button:disabled { opacity: .55; cursor: default; }
</style>
