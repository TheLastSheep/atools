<script lang="ts">
  type Props = {
    message: string;
    openMessage?: string;
    canOpen?: boolean;
    busy?: boolean;
    onopen?: () => void;
  };

  let {
    message,
    openMessage = "",
    canOpen = false,
    busy = false,
    onopen = () => {},
  }: Props = $props();
</script>

<div class="inline-status action-status" data-plugin-open-status>
  <span class="install-message">{message}</span>
  {#if openMessage}<span class="open-message" role="status">{openMessage}</span>{/if}
  {#if canOpen}
    <button class="plain-button open-button" onclick={onopen} disabled={busy} aria-busy={busy}>
      {busy ? "正在打开…" : openMessage ? "重试打开" : "立即打开"}
    </button>
  {/if}
</div>

<style>
  .action-status {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--settings-control-border, rgba(0, 0, 0, 0.1));
    border-radius: 6px;
    background: var(--settings-control, rgba(0, 0, 0, 0.035));
    font-size: 13px;
    line-height: 1.45;
  }

  .install-message,
  .open-message {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .open-button {
    min-height: 36px;
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 14px;
    border: 1px solid var(--settings-control-border, rgba(0, 0, 0, 0.1));
    border-radius: 8px;
    color: inherit;
    background: var(--settings-control, rgba(0, 0, 0, 0.035));
    font: inherit;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: border-color 0.16s ease, color 0.16s ease, background 0.16s ease;
    white-space: nowrap;
  }

  .open-button:hover:not(:disabled) {
    color: var(--settings-primary, var(--accent));
    border-color: color-mix(in srgb, var(--settings-primary, var(--accent)) 55%, var(--settings-control-border, rgba(0, 0, 0, 0.1)));
    background: var(--settings-hover, var(--accent-subtle));
  }

  .open-button:disabled {
    cursor: progress;
    opacity: 0.62;
  }

  .open-button:focus-visible {
    outline: 2px solid var(--settings-primary, var(--accent));
    outline-offset: 2px;
  }

  @media (max-width: 640px) {
    .action-status {
      align-items: stretch;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
    }

    .open-button {
      align-self: flex-start;
    }
  }
</style>
