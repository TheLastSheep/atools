<script lang="ts">
  import { onMount } from "svelte";
  import { PluginSourceDependencyController } from "../lib/pluginSourceDependencyController";
  import { pluginSourceDependencyServices } from "../lib/pluginSourceDependencyServices";
  import { isDependencyTerminal, type DependencyState } from "../lib/pluginSourceDependencyProtocol";

  type Props = { sourcePath: string; disabled?: boolean; onbusy: (busy: boolean) => void; onrefresh: () => void };
  let { sourcePath, disabled = false, onbusy, onrefresh }: Props = $props();
  let state = $state<DependencyState>({ activePath: null });
  let controller: PluginSourceDependencyController | undefined;
  onMount(() => {
    const instance = new PluginSourceDependencyController(sourcePath, pluginSourceDependencyServices(), value => {
      state = value;
      onbusy(value.activePath === sourcePath);
    }, () => onrefresh());
    controller = instance;
    return () => {
      instance.dispose();
      onbusy(false);
      if (controller === instance) controller = undefined;
    };
  });
  let entry = $derived(state.entry);
  let active = $derived(state.activePath === sourcePath);
  let canDownload = $derived(!!entry?.inspection && entry.inspection.missingCount >= 0
    && !entry.inspection.dependencySetPrepared && !!entry.inspection.sourceRevision);
  let canPrepare = $derived(!!entry?.inspection && !!entry.fetchResult && !entry.prepareResult
    && !entry.inspection.dependencySetPrepared && !active
    && entry.inspection.sourceRevision === entry.fetchResult.sourceRevision
    && entry.inspection.dependencySetIdSha256 === entry.fetchResult.dependencySetIdSha256);
  let cancellable = $derived(active && entry?.phase !== "observing"
    && ["created", "awaiting_permission", "running"].includes(entry?.taskStatus ?? ""));
  let canRecheck = $derived(!active && !!entry?.runId
    && ["failed", "cancelled"].includes(entry?.phase ?? "")
    && !!entry?.taskStatus && isDependencyTerminal(entry.taskStatus));

  function bytes(value: number) {
    if (value < 1024) return `${value} B`;
    const units = ["KiB", "MiB", "GiB"];
    let size = value;
    for (const unit of units) { size /= 1024; if (size < 1024 || unit === "GiB") return `${size.toFixed(size < 10 ? 1 : 0)} ${unit}`; }
    return `${value} B`;
  }
  function targetLabel(os: string, cpu: string): string | null {
    const system = os.toLowerCase();
    const architecture = cpu.toLowerCase();
    if (["darwin", "macos"].includes(system) && ["arm64", "aarch64"].includes(architecture)) return "macOS · Apple 芯片";
    if (["darwin", "macos"].includes(system) && ["x64", "x86_64", "amd64"].includes(architecture)) return "macOS · Intel 芯片";
    if (["windows", "win32"].includes(system) && ["x64", "x86_64", "amd64"].includes(architecture)) return "Windows · x64";
    if (system === "linux" && ["arm64", "aarch64"].includes(architecture)) return "Linux · ARM64";
    if (system === "linux" && ["x64", "x86_64", "amd64"].includes(architecture)) return "Linux · x64";
    return null;
  }
</script>

<section class="dependency-panel" aria-label="构建依赖准备" aria-busy={active}>
  <strong>本地构建依赖</strong>
  <p role="status" aria-live="polite">{entry?.message || "仅处理当前选中的源码目录；依赖准备不会运行安装脚本，也不会自动转换或安装插件。"}</p>
  {#if entry?.error}<p class="error" role="alert">{entry.error}</p>{/if}
  {#if entry?.inspection}
    <dl>
      {#if targetLabel(entry.inspection.target.os, entry.inspection.target.cpu)}
        <div><dt>构建目标</dt><dd>{targetLabel(entry.inspection.target.os, entry.inspection.target.cpu)}</dd></div>
      {/if}
      <div><dt>依赖包</dt><dd>{entry.inspection.packageCount} 个</dd></div>
      <div><dt>跳过的可选依赖</dt><dd>{entry.inspection.skippedOptionalCount} 个</dd></div>
      <div><dt>已缓存大小</dt><dd>{bytes(entry.inspection.cachedBytes)}</dd></div>
      <div><dt>待下载包</dt><dd>{entry.inspection.missingCount} 个</dd></div>
      <div><dt>依赖包总大小</dt><dd>{entry.inspection.archiveBytes === null ? "未知" : bytes(entry.inspection.archiveBytes)}</dd></div>
    </dl>
  {/if}
  {#if entry?.fetchResult}
    <p class="detail">已校验下载：{entry.fetchResult.cachedArchiveCount} 个使用缓存，{entry.fetchResult.fetchedArchiveCount} 个新下载，共 {bytes(entry.fetchResult.verifiedArchiveBytes)}。</p>
  {/if}
  {#if entry?.prepareResult}
    <p class="detail">已将 {entry.prepareResult.packageCount} 个依赖包准备到本地构建目录。ATools 不会运行依赖安装脚本。</p>
  {/if}
  <div class="actions">
    {#if !entry?.inspection && !active}
      <button type="button" disabled={disabled || active} onclick={() => void controller?.inspect()}>检查依赖</button>
    {:else if canDownload && !active && !entry?.fetchResult}
      <button type="button" disabled={disabled || active || entry?.phase === "observing"} onclick={() => void controller?.fetch()}>下载构建依赖</button>
    {/if}
    {#if canPrepare}
      <button type="button" disabled={disabled || active || entry?.phase === "observing"} onclick={() => void controller?.prepare()}>准备本地依赖</button>
    {/if}
    {#if canRecheck}
      <button type="button" disabled={disabled || active} onclick={() => void controller?.recheck()}>重新检查源码</button>
    {/if}
    {#if (entry?.phase === "failed" || entry?.phase === "cancelled") && entry?.action !== "inspect"}
      <button type="button" disabled={disabled || active} onclick={() => void controller?.retry()}>重试</button>
    {/if}
    {#if entry?.phase === "observing" && entry.canResume}
      <button type="button" disabled={disabled} onclick={() => void controller?.resume()}>继续读取任务</button>
    {/if}
    {#if cancellable}
      <button type="button" disabled={disabled || entry?.phase === "cancelling"} onclick={() => void controller?.cancel()}>取消依赖任务</button>
    {/if}
    {#if active && entry?.runId}<small title={entry.runId}>任务已记录在结果中心{entry.phase === "awaiting_permission" ? "；请在授权队列中处理" : ""}。</small>{/if}
  </div>
</section>

<style>
  .dependency-panel { margin: 8px 0 0 28px; padding: 9px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-primary); }
  strong { color: var(--text-secondary); font-size: 11px; font-weight: 650; }
  p { margin: 4px 0 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
  .detail { color: var(--text-tertiary); }
  .error { color: #c03434; }
  dl { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 4px 12px; margin: 7px 0 0; }
  dl div { display: flex; gap: 5px; min-width: 0; font-size: 11px; line-height: 1.4; }
  dt { color: var(--text-tertiary); white-space: nowrap; }
  dd { min-width: 0; margin: 0; color: var(--text-secondary); overflow-wrap: anywhere; }
  .actions { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; margin-top: 7px; }
  button { min-height: 30px; padding: 4px 10px; border: 1px solid var(--border-strong); border-radius: 5px; color: var(--text-primary); background: var(--bg-tertiary); font-size: 12px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-hover); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { cursor: not-allowed; opacity: .55; }
  small { color: var(--text-tertiary); font-size: 10px; overflow-wrap: anywhere; }
</style>
