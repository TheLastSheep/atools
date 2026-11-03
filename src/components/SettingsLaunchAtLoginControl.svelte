<script lang="ts">
  import { onDestroy, onMount, untrack } from "svelte";
  import {
    createSettingsLaunchAtLoginController,
    nativeSettingsLaunchAtLoginPort,
    type SettingsLaunchAtLoginPort,
    type SettingsLaunchAtLoginState,
  } from "../lib/settingsLaunchAtLogin";

  type Props = {
    onStateChange?: (enabled: boolean | null) => void;
    port?: SettingsLaunchAtLoginPort;
  };

  let { onStateChange = () => {}, port = nativeSettingsLaunchAtLoginPort }: Props = $props();
  const controller = untrack(() => createSettingsLaunchAtLoginController(port));
  let state = $state<SettingsLaunchAtLoginState>(controller.state());
  let checkbox: HTMLInputElement | undefined;
  let unsubscribe: (() => void) | undefined;
  let detachFormGuards: (() => void) | undefined;

  $effect(() => {
    if (checkbox) checkbox.indeterminate = state.enabled === null;
  });

  onMount(() => {
    const input = checkbox;
    if (input) {
      const stopInput = (event: Event) => event.stopPropagation();
      const changeEnabled = (event: Event) => {
        event.stopPropagation();
        void controller.setEnabled(input.checked);
      };
      input.addEventListener("input", stopInput);
      input.addEventListener("change", changeEnabled);
      detachFormGuards = () => {
        input.removeEventListener("input", stopInput);
        input.removeEventListener("change", changeEnabled);
      };
    }
    unsubscribe = controller.subscribe(next => {
      state = next;
      onStateChange(next.enabled);
    });
    void controller.start();
  });

  onDestroy(() => {
    detachFormGuards?.();
    unsubscribe?.();
    controller.dispose();
  });
</script>

<div class="settings-launch-at-login-control">
  <label class="toggle">
    <input
      bind:this={checkbox}
      type="checkbox"
      checked={state.enabled === true}
      aria-label="开机自动启动"
      aria-checked={state.enabled === null ? "mixed" : state.enabled}
      disabled={state.phase !== "ready" || state.enabled === null}
    />
    <span aria-hidden="true"></span>
  </label>
  {#if state.phase === "legacy"}
    <div class="launch-at-login-status" role="status" aria-live="polite">
      <small>{state.message}</small>
      <div class="launch-at-login-choices">
        <button type="button" onclick={() => void controller.resolveLegacy("turnOff")}>关闭旧启动项</button>
        <button type="button" onclick={() => void controller.resolveLegacy("migrate")}>迁移到新机制</button>
        <button type="button" onclick={() => controller.deferLegacy()}>暂不处理</button>
      </div>
    </div>
  {:else if state.phase !== "ready"}
    <div class="launch-at-login-status" role="status" aria-live="polite">
      <small>{state.message}</small>
      {#if state.phase === "error" && state.retryable}
        <button type="button" class="launch-at-login-retry" onclick={() => void controller.refresh()}>
          重新读取
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  .settings-launch-at-login-control {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
    min-width: 86px;
  }

  .toggle {
    position: relative;
    width: 86px;
    height: 48px;
    flex: 0 0 86px;
    display: inline-block;
  }

  .toggle input {
    position: absolute;
    inset: 0;
    z-index: 2;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .toggle input:disabled {
    cursor: not-allowed;
  }

  .toggle input:disabled + span {
    opacity: 0.52;
  }

  .toggle input:focus-visible + span {
    outline: 2px solid var(--settings-primary);
    outline-offset: 3px;
  }

  .toggle span {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: 2px solid rgba(0, 0, 0, 0.12);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.03);
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .toggle span::before {
    content: "";
    position: absolute;
    top: 5px;
    left: 5px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #333333;
    transition: transform 0.18s ease, background 0.18s ease;
  }

  .toggle input:checked + span {
    border-color: color-mix(in srgb, var(--settings-primary) 60%, white);
    background: color-mix(in srgb, var(--settings-primary) 28%, white);
  }

  .toggle input:checked + span::before {
    transform: translateX(38px);
    background: var(--settings-primary);
  }

  .toggle input:indeterminate + span {
    border-color: var(--settings-control-border);
    background: var(--settings-control);
  }

  .toggle input:indeterminate + span::before {
    transform: translateX(19px);
  }

  .launch-at-login-status {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
  }

  .launch-at-login-status small {
    max-width: 220px;
  }

  .launch-at-login-retry {
    min-height: 30px;
    padding: 0 9px;
    border: 1px solid var(--settings-control-border);
    border-radius: 6px;
    color: var(--settings-text-primary);
    background: var(--settings-control);
    cursor: pointer;
  }

  .launch-at-login-choices {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 10px;
  }

  .launch-at-login-choices button {
    border: 0;
    padding: 0;
    color: var(--settings-primary);
    background: transparent;
    font: inherit;
    cursor: pointer;
  }

  .launch-at-login-choices button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  @media (prefers-color-scheme: dark) {
    .toggle span::before {
      background: #d8dbe2;
    }
  }

  :global(:root[data-atools-theme="light"]) .toggle span::before {
    background: #333333;
  }

  :global(:root[data-atools-theme="dark"]) .toggle span::before {
    background: #d8dbe2;
  }

  @media (max-width: 1000px) {
    .toggle {
      width: 52px;
      height: 30px;
      flex-basis: 52px;
    }

    .toggle span::before {
      top: 3px;
      left: 3px;
      width: 22px;
      height: 22px;
    }

    .toggle input:checked + span::before {
      transform: translateX(22px);
    }

    .toggle input:indeterminate + span::before {
      transform: translateX(11px);
    }
  }
</style>
