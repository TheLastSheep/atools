<script lang="ts">
  import type { SourceBuildEntry, SourceBuildStep } from "../lib/pluginSourceBuildProtocol";
  import { presentPluginInstallProblem } from "../lib/pluginInstallProblem";
  import { sourceBuildBlockerText } from "../lib/pluginSourceBuildBlockerText";
  import PluginInstallProblemNotice from "./PluginInstallProblemNotice.svelte";
  import ZToolsSourceDependencyStatus from "./ZToolsSourceDependencyStatus.svelte";
  import SourceBuildManifestChoices from "./SourceBuildManifestChoices.svelte";
  import { parseSourceManifestMetadata, requiresExplicitManifestChoice, type ManifestSelection } from "../lib/pluginSourceBuildManifest";
  type Props = {
    sourcePath: string;
    entry?: SourceBuildEntry;
    disabled?: boolean;
    dependencyActive?: boolean;
    dependencySessionRetained?: boolean;
    oninspect: () => void;
    onconvert: () => void;
    oncancel: () => void;
    onresume: () => void;
    onrescan: () => void;
    onselectmanifest?: (selection: ManifestSelection) => void;
  };
  let { sourcePath, entry, disabled = false, dependencyActive = false, dependencySessionRetained = false,
    oninspect, onconvert, oncancel, onresume, onrescan, onselectmanifest }: Props = $props();
  let dependencyBusy = $state(false);
  let actionsDisabled = $derived(disabled || dependencyBusy || dependencyActive);
  let installProblem = $derived(entry?.phase === "failed"
    ? presentPluginInstallProblem(entry.message, "source-build") : null);
  let canPrepareDependencies = $derived(entry?.phase === "blocked" && entry.inspection?.status === "blocked"
    && entry.inspection.blockers.length === 1
    && entry.inspection.blockers[0]?.code === "dependencies_missing");
  let working = $derived(!!entry && ["checking", "starting", "awaiting_permission", "preparing", "building", "installing", "cancelling"].includes(entry.phase));
  let cancellable = $derived(entry?.taskStatus === "created" || entry?.phase === "awaiting_permission" || entry?.runtime?.cancellable === true
    || entry?.taskKind === "inspection" && entry.taskStatus === "running");
  let manifestChoiceRequired = $derived.by(() => {
    const parsed = entry?.inspection ? parseSourceManifestMetadata(entry.inspection) : null;
    return parsed ? requiresExplicitManifestChoice(parsed) : false;
  });
  let canConvert = $derived(entry?.phase === "eligible" && (!manifestChoiceRequired || entry.manifestChoiceConfirmed === true));
  let caption = $derived(entry ? ({
    checking: "正在检查本地转换条件…", eligible: "本地转换条件已满足。转换后会安装，并替换已安装的同名插件。",
    already_ready: "已有可直接导入的发布目录，请重新扫描后选择导入。",
    blocked: "当前还不能转换。请处理以下问题，再重新检查。", starting: "正在等待创建请求返回。请勿重复操作，可在结果中心检查任务。",
    awaiting_permission: "等待你在授权弹窗中允许构建与安装。", preparing: "正在准备独立构建目录…",
    building: "正在转换插件…", installing: "正在安装转换结果，此步骤不能取消。",
    cancelling: "已请求取消，正在等待构建进程退出…", succeeded: "转换并安装已完成。",
    failed: "转换未完成。", cancelled: "转换已取消。",
  }[entry.phase]) : "检查本地源码条件并查看可转换版本；如果有多个版本，可选择一份后重新检查。");
  let buildSteps = $derived(
    entry?.inspection?.status === "eligible" && (!manifestChoiceRequired || entry.manifestChoiceConfirmed === true)
      && ["eligible", "starting", "awaiting_permission", "preparing", "building", "installing", "cancelling"].includes(entry.phase)
      ? entry.inspection.buildSteps ?? [] : [],
  );
  function stepLabel(step: SourceBuildStep): string {
    if (step.kind === "typecheck") return "类型检查";
    if (step.kind === "nodeTests") return `Node 测试（${step.files} 个文件）`;
    if (step.kind === "viteBuild") return "Vite 打包";
    return "本地项目构建脚本";
  }
</script>

<div class="source-build" aria-label="源码转换" aria-busy={working}>
  <p class:error={entry?.phase === "failed"} role="status" aria-live="polite">{installProblem
    ? `${installProblem.title}。转换与安装未提交。请查看处理建议。`
    : entry?.phase === "eligible" && manifestChoiceRequired && !entry.manifestChoiceConfirmed
    ? "检查条件已满足，但尚未确认转换所用的源码清单。请明确选择一份并重新检查后再转换。"
    : entry?.message || caption}</p>
  {#if installProblem}<PluginInstallProblemNotice problem={installProblem} />{/if}
  {#if entry?.inspection && !["failed", "cancelled"].includes(entry.phase)}
    <SourceBuildManifestChoices inspection={entry.inspection} confirmed={entry.manifestChoiceConfirmed === true}
      requested={entry.requestedManifestSelection} disabled={actionsDisabled} onchoose={(selection) => onselectmanifest?.(selection)} />
  {/if}
  {#if entry?.phase === "blocked" && entry.inspection?.blockers.length}
    <ul>
      {#each entry.inspection.blockers as blocker}
        {@const presentation = sourceBuildBlockerText(blocker)}
        <li>
          <span>{presentation.message}</span>
          {#if presentation.guidance}<small class="blocker-guidance">{presentation.guidance}</small>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if buildSteps.length}
    <section aria-label="所选项目的检查步骤">
      <strong>转换计划</strong>
      <ol class="build-steps">{#each buildSteps as step}<li>{stepLabel(step)}</li>{/each}</ol>
    </section>
  {/if}
  {#if entry?.observationError}<p class="error" role="alert">{entry.observationError}</p>{/if}
  {#if canPrepareDependencies || dependencyActive || dependencySessionRetained}
    <ZToolsSourceDependencyStatus {sourcePath} {disabled}
      onbusy={(busy) => { dependencyBusy = busy; }} onrefresh={oninspect} />
  {/if}
  <div class="actions">
    {#if !dependencyActive && (!entry || ["blocked", "failed", "cancelled"].includes(entry.phase))}
      <button type="button" onclick={() => oninspect()} disabled={actionsDisabled}>{entry ? "重新检查转换" : "检查可转换版本"}</button>
    {:else if entry?.phase === "eligible"}
      {#if canConvert}<button class="convert" type="button" onclick={onconvert} disabled={actionsDisabled}>一键转换并安装</button>{/if}
      <button type="button" onclick={() => oninspect()} disabled={actionsDisabled}>重新检查</button>
    {:else if entry?.phase === "already_ready"}
      <button type="button" onclick={onrescan} disabled={actionsDisabled}>重新扫描发布目录</button>
    {/if}
    {#if entry?.observationError}
      <button type="button" onclick={onresume} disabled={actionsDisabled}>继续读取任务</button>
    {/if}
    {#if working && cancellable && !entry?.runtime?.cancelRequested && entry?.phase !== "cancelling"}
      <button type="button" onclick={oncancel} disabled={actionsDisabled}>{entry?.taskKind === "inspection" ? "取消检查" : "取消转换"}</button>
    {/if}
    {#if entry?.runId}<small title={entry.runId}>任务已记录在结果中心{working ? "，离开此页后会继续" : ""}。</small>{/if}
  </div>
</div>

<style>
  .source-build { margin: 8px 0 0 28px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); }
  p, li { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  ul { margin: 5px 0 0; padding-left: 17px; }
  .blocker-guidance { display: block; margin-top: 2px; color: var(--text-tertiary); font-size: 11px; line-height: 1.45; }
  section { margin-top: 7px; }
  strong { color: var(--text-secondary); font-size: 11px; font-weight: 650; }
  .build-steps { margin: 4px 0 0; padding-left: 20px; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 7px; }
  .actions:empty { display: none; }
  button { min-height: 30px; padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-primary); background: var(--bg-tertiary); font-size: 12px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-hover); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button.convert { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: var(--accent-subtle); font-weight: 700; }
  small { min-width: 0; color: var(--text-tertiary); font-size: 10px; overflow-wrap: anywhere; }
  .error { color: inherit; font-weight: 600; }
</style>
