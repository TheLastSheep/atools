<script lang="ts">
  type Props = { onclose: () => void };
  let { onclose }: Props = $props();
</script>

<div class="window-resize-notice">
  <div class="notice-copy" role="alert" aria-live="assertive" aria-atomic="true">
    <strong>窗口大小调整失败</strong>
    <p>可滚动查看内容或重新打开窗口。</p>
  </div>
  <button type="button" aria-label="关闭窗口大小调整提示" onclick={onclose}>×</button>
</div>

<style>
  .window-resize-notice {
    position: fixed;
    z-index: 80;
    right: 8px;
    bottom: 8px;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: min(360px, calc(100vw - 16px));
    max-height: min(104px, calc(100vh - 16px));
    overflow: auto;
    padding: 10px 12px;
    border: 1px solid var(--border-strong);
    border-left: 3px solid var(--danger);
    border-radius: 8px;
    color: var(--text-primary);
    background: var(--bg-elevated);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
  }

  .notice-copy {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 12px;
    line-height: 1.45;
    overflow-wrap: anywhere;
  }

  .notice-copy strong {
    display: block;
    color: var(--danger);
    font-weight: 650;
  }

  .notice-copy p { margin: 2px 0 0; color: var(--text-secondary); }

  button {
    flex: 0 0 28px;
    width: 28px;
    height: 28px;
    padding: 0;
    border: 0;
    border-radius: 6px;
    color: var(--text-secondary);
    background: transparent;
    font: inherit;
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }

  button:hover { color: var(--text-primary); background: var(--accent-subtle); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
</style>
