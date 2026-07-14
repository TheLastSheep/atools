<script lang="ts">
  import type { AppUpdaterState } from "../lib/appUpdater";

  type Props = {
    state: AppUpdaterState;
    ondismiss: () => void;
    oninstall: () => void | Promise<void>;
  };

  let { state, ondismiss, oninstall }: Props = $props();
  let percent = $derived(
    state.total !== null && state.total > 0
      ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
      : null,
  );
  let busy = $derived(
    state.phase === "downloading" ||
      state.phase === "installing" ||
      state.phase === "restarting",
  );
  let progressText = $derived.by(() => {
    if (state.phase === "downloading") {
      return percent === null ? "正在下载" : `正在下载 ${percent}%`;
    }
    if (state.phase === "installing") return "正在安装";
    if (state.phase === "restarting") return "正在重启";
    return "";
  });

  function install(): void {
    void Promise.resolve(oninstall()).catch(() => undefined);
  }
</script>

{#if state.update}
  <aside class="update-prompt" role="status" aria-live="polite" aria-label="应用更新">
    <div class="update-accent" aria-hidden="true"></div>
    <div class="update-content">
      <div class="update-heading">
        <div>
          <span class="update-kicker">ATools 更新</span>
          <strong>发现新版本 {state.update.version}</strong>
        </div>
        <span class="version-chip">{state.update.currentVersion} → {state.update.version}</span>
      </div>

      {#if state.update.body}
        <p class="release-notes">{state.update.body}</p>
      {/if}

      {#if progressText}
        <div class="update-progress">
          <div class="progress-label">
            <span>{progressText}</span>
            {#if percent !== null && state.phase === "downloading"}
              <span>{percent}%</span>
            {/if}
          </div>
          <div
            class:indeterminate={percent === null}
            class="progress-track"
            role="progressbar"
            aria-label={progressText}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-valuenow={percent ?? undefined}
          >
            <span style:width={percent === null ? undefined : `${percent}%`}></span>
          </div>
        </div>
      {/if}

      {#if state.phase === "error" && state.errorMessage}
        <p class="update-error">{state.errorMessage}</p>
      {/if}

      <div class="update-actions">
        <button class="secondary" type="button" onclick={ondismiss} disabled={busy}>稍后</button>
        <button class="primary" type="button" onclick={install} disabled={busy}>
          {state.phase === "downloading"
            ? "正在下载"
            : state.phase === "installing"
              ? "正在安装"
              : state.phase === "restarting"
                ? "正在重启"
                : "更新并重启"}
        </button>
      </div>
    </div>
  </aside>
{/if}

<style>
  .update-prompt {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 140;
    width: min(380px, calc(100vw - 36px));
    display: grid;
    grid-template-columns: 3px minmax(0, 1fr);
    overflow: hidden;
    border: 1px solid var(--border-strong);
    border-radius: 12px;
    background: color-mix(in srgb, var(--bg-elevated) 96%, transparent);
    box-shadow: 0 22px 64px -30px rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(20px);
  }

  .update-accent {
    background: linear-gradient(180deg, var(--accent), color-mix(in srgb, var(--accent) 38%, transparent));
  }

  .update-content {
    min-width: 0;
    display: grid;
    gap: 12px;
    padding: 16px;
  }

  .update-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .update-heading > div {
    min-width: 0;
    display: grid;
    gap: 3px;
  }

  .update-kicker {
    color: var(--accent);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.08em;
    line-height: 1.2;
    text-transform: uppercase;
  }

  .update-heading strong {
    color: var(--text-primary);
    font-size: 15px;
    line-height: 1.35;
  }

  .version-chip {
    flex: 0 0 auto;
    padding: 4px 7px;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-secondary);
    font-size: 10px;
    line-height: 1;
  }

  .release-notes {
    max-height: 112px;
    margin: 0;
    overflow: auto;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.55;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
  }

  .update-progress {
    display: grid;
    gap: 6px;
  }

  .progress-label {
    display: flex;
    justify-content: space-between;
    color: var(--text-secondary);
    font-size: 11px;
  }

  .progress-track {
    position: relative;
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--bg-secondary);
  }

  .progress-track span {
    position: absolute;
    inset: 0 auto 0 0;
    border-radius: inherit;
    background: var(--accent);
    transition: width 160ms ease;
  }

  .progress-track.indeterminate span {
    width: 36%;
    animation: update-progress 1.1s ease-in-out infinite;
  }

  .update-error {
    margin: 0;
    padding: 8px 10px;
    border-radius: 8px;
    background: color-mix(in srgb, var(--danger, #e5484d) 10%, transparent);
    color: var(--danger, #e5484d);
    font-size: 11px;
    line-height: 1.45;
  }

  .update-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .update-actions button {
    height: 30px;
    padding: 0 12px;
    border-radius: 8px;
    font-size: 11px;
    font-weight: 600;
  }

  .update-actions button:disabled {
    cursor: wait;
    opacity: 0.62;
  }

  .secondary {
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-secondary);
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: white;
  }

  @keyframes update-progress {
    from {
      transform: translateX(-110%);
    }
    to {
      transform: translateX(280%);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .progress-track.indeterminate span {
      animation: none;
      transform: translateX(90%);
    }
  }
</style>
