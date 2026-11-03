<script lang="ts">
  let { pending = false, deferred = 0, message = "" }: { pending?: boolean; deferred?: number; message?: string } = $props();
</script>
{#if pending || deferred || message}
  <div class="main-push-status" role="status" aria-live="polite">
    {#if pending}<span class="progress" aria-hidden="true"></span><span>正在查询插件</span>{/if}
    {#if message}<span>{message}</span>{/if}
    {#if deferred}<span>还有 {deferred} 个匹配插件未查询</span>{/if}
  </div>
{/if}
<style>
  .main-push-status { min-height: 26px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 5px 14px; color: var(--text-secondary); border-top: 1px solid var(--border); font-size: 11px; }
  .progress { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
</style>
