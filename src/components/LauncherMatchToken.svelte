<script lang="ts">
  let { summary, onedit, onremove }: { summary: string; onedit: () => void; onremove: () => void } = $props();
</script>

<div class="match-token" data-launcher-text-context="true">
  <button class="token-edit" aria-label="编辑固定文本" onclick={onedit}>
    <svg aria-hidden="true" width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5h12M10 5v11M7 16h6" /></svg>
    <span>{summary || "文本"}</span>
  </button>
  <button class="token-remove" aria-label="移除固定文本" onclick={onremove}>
    <svg aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m4 4 8 8M12 4l-8 8" /></svg>
  </button>
</div>

<style>
  .match-token { display: flex; min-width: 0; max-width: 42%; flex-shrink: 1; align-items: center; border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent); border-radius: 8px; color: var(--accent); background: var(--accent-subtle); -webkit-app-region: no-drag; }
  button { display: flex; align-items: center; justify-content: center; border: 0; background: transparent; color: inherit; cursor: pointer; }
  .token-edit { min-width: 0; gap: 4px; padding: 7px 4px 7px 7px; font-size: 12px; line-height: 16px; }
  .token-edit svg { flex: 0 0 auto; }
  .token-edit span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .token-remove { padding: 7px 6px; flex: 0 0 auto; align-self: stretch; border-radius: 0 7px 7px 0; }
  button:hover { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
