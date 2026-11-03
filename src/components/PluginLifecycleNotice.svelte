<script lang="ts">
  let { message, detached = false, onreturn }: {
    message: string;
    detached?: boolean;
    onreturn: () => void;
  } = $props();
</script>

<div class="lifecycle-notice" role="status" aria-live="polite">
  <span>{message}</span>
  <button type="button" onclick={onreturn}>{detached ? "返回主搜索" : "继续搜索"}</button>
</div>

<style>
  .lifecycle-notice { box-sizing: border-box; height: 52px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); background: var(--bg-secondary); color: var(--text-secondary); font-size: 12px; line-height: 18px; }
  span { min-width: 0; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  button { flex-shrink: 0; min-height: 30px; padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); color: var(--text-primary); font: inherit; cursor: pointer; }
  button:hover { border-color: var(--accent); background: var(--accent-subtle); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>
