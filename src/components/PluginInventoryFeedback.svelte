<script lang="ts">
  import type { PluginInventoryFeedback } from "../lib/pluginInventoryFeedback";
  import { presentPluginInstallProblem } from "../lib/pluginInstallProblem";
  import PluginInstallProblemNotice from "./PluginInstallProblemNotice.svelte";

  type Props = {
    feedback: PluginInventoryFeedback | null;
    nativeAvailable: boolean;
    readDisabled: boolean;
    onretry: () => void;
  };
  let { feedback, nativeAvailable, readDisabled, onretry }: Props = $props();
</script>

{#if !nativeAvailable}<p class="preview-notice" role="status">请在桌面应用中管理和打开插件</p>{/if}
{#if feedback?.visibility === "announcement"}
  <p class="inventory-announcement" role="status" aria-live="polite">{feedback.messages.join("；")}</p>
{:else if feedback}
  {@const installProblem = feedback.kind === "action-failure"
    ? feedback.messages.map(message => presentPluginInstallProblem(message, "inventory-action")).find(Boolean) ?? null : null}
  <div class="notice" class:failure={feedback.tone === "error" || feedback.tone === "warning"}
    data-feedback-kind={feedback.kind} role={installProblem ? "group" : "status"} aria-live={installProblem ? undefined : "polite"}>
    {#if installProblem}
      <p class="inventory-announcement" role="status" aria-live="polite">{installProblem.title}。{installProblem.message} {installProblem.recovery}</p>
      <PluginInstallProblemNotice problem={installProblem} />
      <p>如需更换发布包，请使用上方“安装本地插件”入口。</p>
    {:else}<div>{#each feedback.messages as message}<p>{message}</p>{/each}</div>{/if}
    {#if feedback.retryList && nativeAvailable}
      <button disabled={readDisabled} onclick={onretry}>重试读取列表</button>
    {/if}
  </div>
{/if}

<style>
  .inventory-announcement {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    clip-path: inset(50%);
    white-space: nowrap;
    border: 0;
  }
  .preview-notice {
    margin: 0 0 12px;
    color: var(--settings-text-secondary, #61616d);
    font-size: 12px;
  }
  .notice {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
    justify-content: space-between;
    padding: 9px 11px;
    margin-bottom: 12px;
    border: 1px solid var(--settings-control-border, #dedbe8);
    background: var(--settings-primary-soft, #f4f0fd);
    border-radius: 7px;
    font-size: 12px;
    line-height: 1.5;
  }
  .notice > div { flex: 1 1 180px; min-width: 0; }
  .notice p { margin: 0; overflow-wrap: anywhere; }
  .notice p + p { margin-top: 4px; }
  .failure { border-color: #b99152; }
  button {
    flex: 0 0 auto;
    min-height: 32px;
    padding: 5px 10px;
    border-radius: 6px;
    border: 1px solid var(--settings-control-border, #d9d9e0);
    background: var(--settings-control, #fafafd);
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--settings-primary, #7650d6); }
  button:disabled { opacity: .48; cursor: default; }
  button:focus-visible { outline: 2px solid var(--settings-primary, #7650d6); outline-offset: 2px; }
</style>
