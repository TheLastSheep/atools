<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import SettingsPanel from "./SettingsPanel.svelte";
  import { createSettingsEditingLifecycle } from "../lib/settingsEditingLifecycle";
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";
  import type { SettingsMenuId } from "../lib/settingsPages";
  type Phase = "loading" | "ready" | "error";
  type Props = {
    initialMenu: SettingsMenuId;
    marketRequest?: PluginMarketRequest | null;
  };

  let { initialMenu, marketRequest = null }: Props = $props();
  let phase = $state<Phase>("loading");
  const lifecycle = createSettingsEditingLifecycle({
    onPhaseChange: (nextPhase) => { phase = nextPhase; },
  });

  onMount(() => {
    lifecycle.start();
  });

  onDestroy(() => {
    lifecycle.dispose();
  });
</script>

{#if phase === "ready"}
  <SettingsPanel {initialMenu} {marketRequest} />
{:else if phase === "error"}
  <section class="editing-gate" role="alert" aria-labelledby="settings-editing-error-title">
    <h2 id="settings-editing-error-title">设置加载失败</h2>
    <p>设置暂不可用，请重试。</p>
    <button type="button" onclick={lifecycle.start}>重试</button>
  </section>
{:else}
  <section class="editing-gate" role="status" aria-live="polite">
    <p>正在读取设置…</p>
  </section>
{/if}

<style>
  .editing-gate {
    box-sizing: border-box;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 10px;
    width: 100%;
    min-width: 0;
    height: 100%;
    min-height: 220px;
    padding: 24px;
    color: var(--text-primary);
    background: var(--bg-secondary);
    text-align: center;
  }

  .editing-gate h2,
  .editing-gate p {
    margin: 0;
  }

  .editing-gate h2 {
    font-size: 15px;
    font-weight: 600;
  }

  .editing-gate p {
    color: var(--text-secondary);
    font-size: 13px;
    line-height: 1.5;
  }

  .editing-gate button {
    min-width: 88px;
    min-height: 36px;
    margin-top: 4px;
    padding: 7px 14px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-primary);
    background: var(--bg-elevated);
    cursor: pointer;
  }

  .editing-gate button:hover {
    background: var(--bg-hover);
  }

  .editing-gate button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
