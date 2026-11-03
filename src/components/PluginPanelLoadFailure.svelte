<script lang="ts">
  type Props = {
    errorMessage: string;
    retryable: boolean;
    busy: boolean;
    onretry: (source: HTMLButtonElement) => void;
  };

  let { errorMessage, retryable, busy, onretry }: Props = $props();

  function handleRetry(event: MouseEvent) {
    if (!retryable || busy) return;
    onretry(event.currentTarget as HTMLButtonElement);
  }
</script>

<section class="plugin-load-failure" aria-busy={busy}>
  <div class="err-icon" aria-hidden="true">!</div>
  <div class="err-message" role="alert">{errorMessage}</div>
  {#if retryable}
    <button
      type="button"
      class="retry-button"
      aria-disabled={busy}
      onclick={handleRetry}
    >重试加载</button>
    <div class="retry-status" role="status" aria-live="polite">{busy ? "正在重新加载…" : ""}</div>
  {/if}
</section>

<style>
  .plugin-load-failure {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    box-sizing: border-box;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: auto;
    height: 100%;
    color: var(--danger);
    gap: 8px;
    padding: 20px 12px;
    background: var(--bg-primary, transparent);
  }

  .err-icon { font-size: 24px; }
  .err-message {
    max-width: 400px;
    padding: 0 24px;
    color: var(--text-secondary);
    font-size: 12px;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .retry-button {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-primary, #d0d0d0);
    border-radius: 6px;
    color: var(--text-primary);
    background: var(--bg-secondary, #fff);
    font: inherit;
    cursor: pointer;
  }

  .retry-button:hover:not([aria-disabled="true"]) { background: var(--bg-hover, #f2f2f2); }
  .retry-button:focus-visible { outline: 2px solid var(--accent, #3478f6); outline-offset: 2px; }
  .retry-button[aria-disabled="true"] { cursor: progress; }
  .retry-status { min-height: 1em; color: var(--text-tertiary); font-size: 12px; }
</style>
