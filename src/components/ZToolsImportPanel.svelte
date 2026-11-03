<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { InstalledPlugin, ZToolsImportCandidate, ZToolsImportReport } from "../lib/types";
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";
  import { PluginOpenController, type PluginOpenState } from "../lib/pluginOpen";
  import { ztoolsImportView } from "../lib/ztoolsImportView";
  import { ZToolsImportController, type ZToolsImportState } from "../lib/ztoolsImportController";
  import { ztoolsImportSelectionSession } from "../lib/ztoolsImportSelectionSession";
  import { PluginSourceBuildController } from "../lib/pluginSourceBuildController";
  import { pluginSourceBuildServices } from "../lib/pluginSourceBuildServices";
  import { pluginSourceDependencySession } from "../lib/pluginSourceDependencySession";
  import type { SourceBuildState } from "../lib/pluginSourceBuildProtocol";
  import type { ManifestSelection } from "../lib/pluginSourceBuildManifest";
  import ZToolsImportCandidateRow from "./ZToolsImportCandidateRow.svelte";
  import ZToolsImportResults from "./ZToolsImportResults.svelte";

  type Props = { onmarketrequest?: (request: PluginMarketRequest) => void };
  let { onmarketrequest }: Props = $props();
  let importState = $state<ZToolsImportState>({ candidates: [], selected: new Set(), report: null, importedPlugins: {}, busy: "idle", error: "", refreshError: "", enableErrors: {}, pendingEnableRefresh: new Set() });
  let pluginOpenState = $state<PluginOpenState>({ requestId: null, pluginId: null, busy: false, message: "" });
  let enableOpenRequest = $state<string | null>(null);
  let sourceBuildState = $state<SourceBuildState>({ entries: {}, activePath: null });
  let dependencyActivePath = $state<string | null>(null);
  let dependencySessionPath = $state<string | null>(null);
  const pluginOpenController = new PluginOpenController(value => { pluginOpenState = value; }, () => {});
  const controller = new ZToolsImportController({
    scanDefault: () => invoke<ZToolsImportCandidate[]>("scan_default_ztools_plugins"),
    scanPath: path => invoke<ZToolsImportCandidate[]>("scan_ztools_plugins", { root: path }),
    chooseDirectory: async () => selectedPath(await open({ directory: true, multiple: false })),
    chooseArchive: async () => selectedPath(await open({ directory: false, multiple: false, filters: [{ name: "ZTools 插件包", extensions: ["zpx", "asar", "zip"] }] })),
    importPaths: paths => invoke<ZToolsImportReport>("import_ztools_plugins", { paths, overwrite: true }),
    listPlugins: () => invoke<InstalledPlugin[]>("list_plugins"),
    enablePlugin: pluginId => invoke<void>("toggle_plugin", { pluginId, enabled: true }),
  }, value => { importState = value; }, ztoolsImportSelectionSession);
  const sourceBuildController = new PluginSourceBuildController(
    pluginSourceBuildServices(pluginId => controller.registerConvertedPlugin(pluginId)),
    value => { sourceBuildState = value; },
  );
  let importView = $derived(ztoolsImportView(importState.candidates, importState.selected));
  let importBusy = $derived(importState.busy !== "idle" || pluginOpenState.busy);
  let busy = $derived(importBusy || !!sourceBuildState.activePath || !!dependencyActivePath);

  $effect(() => {
    const pluginId = enableOpenRequest;
    const plugin = pluginId ? importState.importedPlugins[pluginId] : null;
    if (pluginId && plugin?.enabled && importState.busy === "idle" && !pluginOpenState.busy) {
      enableOpenRequest = null;
      pluginOpenController.open(plugin);
    }
  });

  onMount(() => {
    dependencyActivePath = pluginSourceDependencySession.activePath();
    dependencySessionPath = pluginSourceDependencySession.sessionPath();
    const stopDependencySession = pluginSourceDependencySession.subscribe(event => {
      dependencyActivePath = event.activePath;
      dependencySessionPath = event.sessionPath;
    });
    void controller.scanDefault();
    return () => {
      stopDependencySession();
      controller.dispose(); pluginOpenController.cancel(); sourceBuildController.dispose();
    };
  });

  async function scanDefault() {
    enableOpenRequest = null;
    pluginOpenController.cancel();
    await controller.scanDefault();
  }
  async function chooseDirectory() {
    enableOpenRequest = null;
    pluginOpenController.cancel();
    await controller.chooseDirectory();
  }
  async function chooseArchive() {
    enableOpenRequest = null;
    pluginOpenController.cancel();
    await controller.chooseArchive();
  }
  function openImportedPlugin(pluginId: string) { pluginOpenController.open(importState.importedPlugins[pluginId]); }
  function enableAndOpen(pluginId: string) { enableOpenRequest = pluginId; void controller.enableAndRefresh(pluginId); }
  function selectedPath(result: string | string[] | null): string | null {
    return typeof result === "string" ? result : null;
  }

  function busyLabel(value: ZToolsImportState["busy"], opening: boolean) {
    if (opening) return "正在打开插件…";
    if (value === "scanning") return "正在扫描，已有候选会保留到扫描成功。";
    if (value === "choosing-directory" || value === "choosing-archive") return "等待选择来源…";
    if (value === "importing") return "导入操作已开始，请等待本批完成。";
    if (value === "enabling") return "正在启用插件…";
    if (value === "refreshing") return "正在读取导入后的插件状态…";
    return "";
  }
</script>

<section class="import-panel" aria-label="ZTools 插件导入">
  <div class="import-head">
    <div>
      <h3>导入 ZTools 插件</h3>
      <p>支持插件发布目录、ZIP、ZPX 和 ASAR；源码目录有完整 dist 时会自动选择。</p>
    </div>
    <div class="import-actions">
      <button class="secondary" onclick={scanDefault} disabled={busy} aria-busy={importState.busy === "scanning"}>
        {importState.busy === "scanning" ? "扫描中…" : "扫描 ZTools"}
      </button>
      <button class="secondary" onclick={chooseDirectory} disabled={busy} aria-busy={importState.busy === "choosing-directory" || importState.busy === "scanning"}>
        {importState.busy === "choosing-directory" ? "选择目录中…" : "选择目录"}
      </button>
      <button class="secondary" onclick={chooseArchive} disabled={busy} aria-busy={importState.busy === "choosing-archive" || importState.busy === "scanning"}>
        {importState.busy === "choosing-archive" ? "选择插件包中…" : "选择插件包"}
      </button>
    </div>
  </div>

  {#if importState.error}<div class="import-error" role="alert">{importState.error}</div>{/if}
  {#if importBusy}<div class="busy-line" role="status" aria-live="polite">{busyLabel(importState.busy, pluginOpenState.busy)}</div>{/if}

  {#if importState.candidates.length > 0}
    <div class="candidate-summary" aria-label="预检统计">
      {#each importView.summaryChips as chip}<span class={`summary-chip ${chip.tone}`}>{chip.label}</span>{/each}
    </div>
    {#if importView.sourceChoiceCount > 0}
      <p class="source-choice-note" role="status" aria-live="polite">
        {importView.sourceChoiceCount} 个插件有多个来源，{importView.pendingSourceChoices} 个尚未选择。每个插件只选一个；批量选择会保留已选版本，其余只选无冲突来源。
      </p>
    {/if}
    <div class="candidate-list" aria-busy={busy}>
      {#each importView.rows as row (row.path)}
        <ZToolsImportCandidateRow {row} disabled={busy} ontoggle={(path, checked) => controller.toggle(path, checked)} {onmarketrequest}
          sourceBuild={{ entry: sourceBuildState.entries[row.path], disabled: importBusy
            || !!sourceBuildState.activePath && sourceBuildState.activePath !== row.path
            || !!dependencyActivePath && dependencyActivePath !== row.path,
            dependencyActive: dependencyActivePath === row.path,
            dependencySessionRetained: dependencySessionPath === row.path,
            inspect: () => { pluginSourceDependencySession.clearInactiveForNewState(); void sourceBuildController.inspect(row.path); },
            selectManifest: (selection: ManifestSelection) => { pluginSourceDependencySession.clearInactiveForNewState(); void sourceBuildController.inspect(row.path, selection); },
            convert: () => void sourceBuildController.convert(row.path),
            cancel: () => void sourceBuildController.cancel(row.path), resume: () => void sourceBuildController.resume(row.path),
            rescan: () => void controller.scanPath(row.path) }} />
      {/each}
    </div>
    <div class="import-actions footer-actions">
      <div class="selection-actions">
        <button class="secondary" onclick={() => controller.selectAll()} disabled={busy || importView.summary.selectable === 0}>选择无冲突来源</button>
        <button class="secondary" onclick={() => controller.clearSelection()} disabled={busy || importView.summary.selected === 0}>清空选择</button>
      </div>
      <button class="primary" onclick={() => void controller.importSelected()} disabled={busy || importView.summary.selected === 0}>
        {importState.busy === "importing" || importState.busy === "refreshing" ? "处理中…" : `导入 ${importView.summary.selected} 个插件`}
      </button>
    </div>
  {:else}
    <div class="empty-import-state">
      <strong>{importState.busy === "scanning" ? "正在检查插件" : "等待扫描"}</strong>
      <p>{importView.emptyText}</p>
    </div>
  {/if}

  <ZToolsImportResults
    report={importState.report}
    importedPlugins={importState.importedPlugins}
    enableErrors={importState.enableErrors}
    pendingEnableRefresh={importState.pendingEnableRefresh}
    {busy}
    refreshError={importState.refreshError}
    {pluginOpenState}
    onEnable={enableAndOpen}
    onRetryEnableRead={pluginId => void controller.retryEnabledPluginList(pluginId)}
    onOpen={openImportedPlugin}
    onRetryList={() => void controller.retryPluginList()}
    onRetryFailures={() => void controller.retryFailures()}
  />
</section>

<style>
  .import-panel { display: flex; flex-direction: column; gap: 14px; color: var(--text-primary); }
  .import-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  h3 { margin: 0 0 4px; font-size: 14px; font-weight: 700; }
  p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
  button { border: 1px solid var(--border-strong); border-radius: 6px; padding: 7px 12px; color: var(--text-primary); background: var(--bg-tertiary); font-size: 12px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-hover); }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .primary { border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong)); background: var(--accent); color: var(--accent-foreground); font-weight: 700; }
  .secondary { flex-shrink: 0; }
  .import-actions { display: flex; align-items: center; gap: 8px; }
  .footer-actions { justify-content: space-between; gap: 12px; }
  .selection-actions { display: flex; gap: 8px; }
  .import-error { border: 1px solid rgba(255, 94, 94, .35); border-radius: 6px; padding: 10px 12px; color: #ff9b9b; background: rgba(255, 94, 94, .08); font-size: 12px; }
  .busy-line { color: var(--text-secondary); font-size: 12px; }
  .source-choice-note { padding: 8px 10px; border-left: 2px solid var(--accent); background: var(--accent-subtle); overflow-wrap: anywhere; }
  .candidate-summary { display: flex; flex-wrap: wrap; gap: 8px; }
  .summary-chip { min-width: 72px; padding: 6px 9px; border: 1px solid var(--border); border-radius: 8px; color: var(--text-secondary); background: var(--bg-secondary); font-size: 12px; font-weight: 700; text-align: center; }
  .summary-chip.success { color: #12805c; border-color: rgba(18, 128, 92, .24); background: rgba(18, 128, 92, .08); }
  .summary-chip.warning { color: #9f6a00; border-color: rgba(217, 154, 0, .3); background: rgba(217, 154, 0, .1); }
  .summary-chip.danger { color: #c03434; border-color: rgba(220, 38, 38, .24); background: rgba(220, 38, 38, .08); }
  .summary-chip.accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 28%, transparent); background: var(--accent-subtle); }
  .candidate-list { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 8px; }
  .empty-import-state { border: 1px dashed var(--border-strong); border-radius: 8px; padding: 18px; color: var(--text-secondary); background: var(--bg-secondary); }
  .empty-import-state strong { color: var(--text-primary); }
  @media (max-width: 700px) { .import-head { flex-direction: column; } .import-actions { flex-wrap: wrap; } }
</style>
