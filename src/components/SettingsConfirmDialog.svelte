<script lang="ts">
  type Props = {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "danger";
    onconfirm?: () => void;
    oncancel?: () => void;
  };

  let {
    title,
    message,
    confirmLabel = "确认",
    cancelLabel = "取消",
    tone = "danger",
    onconfirm = () => {},
    oncancel = () => {},
  }: Props = $props();

  function messageLines() {
    return message.split("\n").filter((line) => line.trim().length > 0);
  }

  function onWindowKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      oncancel();
    }
  }
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="confirm-layer">
  <button class="confirm-scrim" aria-label={cancelLabel} onclick={oncancel}></button>
  <div
    class="confirm-panel"
    class:danger={tone === "danger"}
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-confirm-title"
  >
    <div class="confirm-icon" aria-hidden="true">
      {#if tone === "danger"}
        !
      {:else}
        i
      {/if}
    </div>
    <div class="confirm-copy">
      <h3 id="settings-confirm-title">{title}</h3>
      <div class="confirm-message">
        {#each messageLines() as line}
          <p>{line}</p>
        {/each}
      </div>
    </div>
    <div class="confirm-actions">
      <button class="confirm-button" onclick={oncancel}>{cancelLabel}</button>
      <button class="confirm-button primary" class:danger={tone === "danger"} onclick={onconfirm}>
        {confirmLabel}
      </button>
    </div>
  </div>
</div>

<style>
  .confirm-layer {
    position: absolute;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .confirm-scrim {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.18);
    backdrop-filter: blur(8px);
  }

  .confirm-panel {
    position: relative;
    width: min(460px, calc(100vw - 48px));
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr);
    gap: 14px;
    padding: 18px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 12px;
    color: #303236;
    background: color-mix(in srgb, var(--bg-primary) 96%, white);
    box-shadow: 0 26px 70px rgba(0, 0, 0, 0.28);
  }

  .confirm-icon {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    border-radius: 50%;
    color: var(--accent);
    background: var(--accent-subtle);
    font-size: 22px;
    font-weight: 800;
  }

  .confirm-panel.danger .confirm-icon {
    color: #dc2626;
    background: rgba(220, 38, 38, 0.12);
  }

  .confirm-copy {
    min-width: 0;
  }

  .confirm-copy h3 {
    margin: 0 0 8px;
    color: #303236;
    font-size: 17px;
    font-weight: 800;
    line-height: 1.25;
  }

  .confirm-message {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .confirm-message p {
    margin: 0;
    color: rgba(48, 50, 54, 0.68);
    font-size: 13px;
    line-height: 1.45;
  }

  .confirm-actions {
    grid-column: 1 / -1;
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    margin-top: 4px;
  }

  .confirm-button {
    min-width: 86px;
    min-height: 40px;
    padding: 0 16px;
    border: 1px solid rgba(0, 0, 0, 0.12);
    border-radius: 8px;
    color: #303236;
    background: rgba(0, 0, 0, 0.035);
    font-size: 14px;
    font-weight: 700;
  }

  .confirm-button:hover {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 42%, rgba(0, 0, 0, 0.12));
    background: var(--accent-subtle);
  }

  .confirm-button.primary {
    color: #fff;
    border-color: var(--accent);
    background: var(--accent);
  }

  .confirm-button.danger {
    color: #fff;
    border-color: #dc2626;
    background: #dc2626;
  }

  @media (prefers-color-scheme: dark) {
    .confirm-scrim {
      background: rgba(0, 0, 0, 0.38);
    }

    .confirm-panel {
      border-color: rgba(255, 255, 255, 0.12);
      color: #f2f3f5;
      background: rgba(48, 49, 51, 0.98);
      box-shadow: 0 26px 70px rgba(0, 0, 0, 0.46);
    }

    .confirm-copy h3,
    .confirm-button {
      color: #f2f3f5;
    }

    .confirm-message p {
      color: rgba(242, 243, 245, 0.66);
    }

    .confirm-button {
      border-color: rgba(255, 255, 255, 0.14);
      background: rgba(255, 255, 255, 0.06);
    }

    .confirm-button.primary,
    .confirm-button.danger {
      color: #fff;
    }
  }
</style>
