<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { InstalledPlugin, ZToolsImportCandidate, ZToolsImportReport } from "../lib/types";
  import { dispatchPluginOpenRequest, firstOpenablePluginFeature } from "../lib/pluginOpen";
  import { ztoolsImportReportView, ztoolsImportView } from "../lib/ztoolsImportView";

  let candidates: ZToolsImportCandidate[] = $state([]);
  let selected = $state<Set<string>>(new Set());
  let report: ZToolsImportReport | null = $state(null);
  let scanning = $state(false);
  let importing = $state(false);
  let error = $state("");
  let importedPlugins = $state<Record<string, InstalledPlugin>>({});
  let importView = $derived(ztoolsImportView(candidates, selected));
  let reportView = $derived(ztoolsImportReportView(report));

  function applyCandidates(items: ZToolsImportCandidate[]) {
    candidates = items;
    selected = new Set(items.filter((item) => item.errors.length === 0).map((item) => item.path));
    report = null;
    importedPlugins = {};
  }

  async function scanDefault() {
    scanning = true;
    error = "";
    try {
      applyCandidates(await invoke<ZToolsImportCandidate[]>("scan_default_ztools_plugins"));
    } catch (e) {
      error = String(e);
    } finally {
      scanning = false;
    }
  }

  onMount(() => {
    void scanDefault();
  });

  async function chooseAndScan() {
    const root = await open({ directory: true, multiple: false });
    if (typeof root !== "string") return;

    scanning = true;
    error = "";
    try {
      applyCandidates(await invoke<ZToolsImportCandidate[]>("scan_ztools_plugins", { root }));
    } catch (e) {
      error = String(e);
    } finally {
      scanning = false;
    }
  }

  async function chooseArchive() {
    const root = await open({
      directory: false,
      multiple: false,
      filters: [{ name: "ZTools 插件包", extensions: ["zpx", "asar"] }],
    });
    if (typeof root !== "string") return;

    scanning = true;
    error = "";
    try {
      applyCandidates(await invoke<ZToolsImportCandidate[]>("scan_ztools_plugins", { root }));
    } catch (e) {
      error = String(e);
    } finally {
      scanning = false;
    }
  }

  async function importSelected() {
    const paths = importView.rows.filter((row) => row.selected).map((row) => row.path);
    importing = true;
    error = "";
    try {
      report = await invoke<ZToolsImportReport>("import_ztools_plugins", {
        paths,
        overwrite: true,
      });
      const plugins = await invoke<InstalledPlugin[]>("list_plugins");
      const importedIds = new Set(report.imported);
      importedPlugins = Object.fromEntries(plugins.filter((plugin) => importedIds.has(plugin.id)).map((plugin) => [plugin.id, plugin]));
    } catch (e) {
      error = String(e);
    } finally {
      importing = false;
    }
  }

  function toggleCandidate(path: string, checked: boolean) {
    const next = new Set(selected);
    if (checked) {
      next.add(path);
    } else {
      next.delete(path);
    }
    selected = next;
  }

  function selectAllImportable() {
    selected = new Set(importView.rows.filter((row) => row.selectable).map((row) => row.path));
  }

  function clearSelection() {
    selected = new Set();
  }

  function openImportedPlugin(pluginId: string) {
    if (!dispatchPluginOpenRequest(importedPlugins[pluginId])) {
      error = "插件未启用或没有可打开的指令";
    }
  }
</script>

<section class="import-panel">
  <div class="import-head">
    <div>
      <h3>导入 ZTools 插件</h3>
      <p>自动扫描 ~/.ztools/plugins，也支持目录、ZPX 和 ASAR 文件。</p>
    </div>
    <div class="import-actions">
      <button class="secondary" onclick={scanDefault} disabled={scanning}>
        {scanning ? "扫描中" : "扫描 ZTools"}
      </button>
      <button class="secondary" onclick={chooseAndScan} disabled={scanning}>选择目录</button>
      <button class="secondary" onclick={chooseArchive} disabled={scanning}>选择插件包</button>
    </div>
  </div>

  {#if error}
    <div class="import-error">{error}</div>
  {/if}

  {#if candidates.length > 0}
    <div class="candidate-summary">
      {#each importView.summaryChips as chip}
        <span class={`summary-chip ${chip.tone}`}>{chip.label}</span>
      {/each}
    </div>

    <div class="candidate-list">
      {#each importView.rows as row}
        <label
          class="candidate-row"
          class:warning={row.status === "warning"}
          class:blocked={row.status === "blocked"}
        >
          <input
            type="checkbox"
            disabled={!row.selectable}
            checked={row.selected}
            onchange={(event) => toggleCandidate(row.path, (event.target as HTMLInputElement).checked)}
          />
          <div class="candidate-main">
            <div class="candidate-title-line">
              <strong>{row.title}</strong>
              <span class={`status-pill ${row.status}`}>{row.statusLabel}</span>
            </div>
            <p>{row.subtitle}</p>
            {#if row.missingFlags.length > 0}
              <div class="flag-list">
                {#each row.missingFlags as flag}
                  <span>{flag}</span>
                {/each}
              </div>
            {/if}
            <small>{row.path}</small>
            {#if row.messages.length > 0}
              <div class="message-list">
                {#each row.messages as message}
                  <small class:error-text={row.status === "blocked"} class:warning-text={row.status === "warning"}>
                    {message}
                  </small>
                {/each}
              </div>
            {/if}
          </div>
        </label>
      {/each}
    </div>

    <div class="import-actions">
      <div class="selection-actions">
        <button class="secondary" onclick={selectAllImportable} disabled={importView.summary.selectable === 0 || importing}>
          全选可导入
        </button>
        <button class="secondary" onclick={clearSelection} disabled={importView.summary.selected === 0 || importing}>
          清空选择
        </button>
      </div>
      <button class="primary" onclick={importSelected} disabled={importing || importView.summary.selected === 0}>
        {importing ? "导入中" : `导入 ${importView.summary.selected} 个插件`}
      </button>
    </div>
  {:else}
    <div class="empty-import-state">
      <strong>等待扫描</strong>
      <p>{importView.emptyText}</p>
    </div>
  {/if}

  {#if reportView}
    <div class:has-failures={reportView.hasFailures} class="report">
      <div class="report-head">
        <strong>导入报告</strong>
        <p>
          成功 {reportView.summary.imported} 个，跳过 {reportView.summary.skipped} 个，失败 {reportView.summary.failed} 个。
        </p>
      </div>
      <div class="report-list">
        {#each reportView.rows as row}
          <div class={`report-row ${row.kind}`}>
            <span>{row.title}</span>
            <div>
              <strong>{row.detail}</strong>
              <small>{row.path}</small>
            </div>
            {#if row.kind === "imported" && firstOpenablePluginFeature(importedPlugins[row.path])}
              <button class="secondary" onclick={() => openImportedPlugin(row.path)}>立即打开</button>
            {/if}
          </div>
        {/each}
      </div>
    </div>
  {/if}
</section>

<style>
  .import-panel {
    display: flex;
    flex-direction: column;
    gap: 14px;
    color: var(--text-primary);
  }

  .import-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
  }

  h3 {
    margin: 0 0 4px;
    font-size: 14px;
    font-weight: 700;
  }

  p {
    margin: 0;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.5;
  }

  button {
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    padding: 7px 12px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font-size: 12px;
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    border-color: var(--accent);
    background: var(--bg-hover);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .primary {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border-strong));
    background: var(--accent);
    color: var(--accent-foreground);
    font-weight: 700;
  }

  .secondary {
    flex-shrink: 0;
  }

  .import-error {
    border: 1px solid rgba(255, 94, 94, 0.35);
    border-radius: 6px;
    padding: 10px 12px;
    color: #ff9b9b;
    background: rgba(255, 94, 94, 0.08);
    font-size: 12px;
  }

  .candidate-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .summary-chip {
    min-width: 72px;
    padding: 6px 9px;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    font-size: 12px;
    font-weight: 700;
    text-align: center;
  }

  .summary-chip.success {
    color: #12805c;
    border-color: rgba(18, 128, 92, 0.24);
    background: rgba(18, 128, 92, 0.08);
  }

  .summary-chip.warning {
    color: #9f6a00;
    border-color: rgba(217, 154, 0, 0.3);
    background: rgba(217, 154, 0, 0.1);
  }

  .summary-chip.danger {
    color: #c03434;
    border-color: rgba(220, 38, 38, 0.24);
    background: rgba(220, 38, 38, 0.08);
  }

  .summary-chip.accent {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 28%, transparent);
    background: var(--accent-subtle);
  }

  .candidate-list {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 8px;
  }

  .candidate-row {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    gap: 10px;
    padding: 11px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }

  .candidate-row:last-child {
    border-bottom: 0;
  }

  .candidate-row.blocked {
    opacity: 0.72;
  }

  .candidate-row.warning {
    background: color-mix(in srgb, rgba(217, 154, 0, 0.1) 42%, var(--bg-secondary));
  }

  input {
    margin-top: 2px;
  }

  .candidate-main {
    min-width: 0;
  }

  .candidate-title-line {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    min-width: 0;
  }

  strong {
    display: block;
    margin-bottom: 3px;
    font-size: 13px;
    line-height: 1.3;
  }

  .candidate-title-line strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-pill {
    flex-shrink: 0;
    padding: 3px 7px;
    border-radius: 999px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    font-size: 11px;
    font-weight: 700;
  }

  .status-pill.ready {
    color: #12805c;
    background: rgba(18, 128, 92, 0.1);
  }

  .status-pill.warning {
    color: #9f6a00;
    background: rgba(217, 154, 0, 0.12);
  }

  .status-pill.blocked {
    color: #c03434;
    background: rgba(220, 38, 38, 0.1);
  }

  small {
    display: block;
    overflow: hidden;
    margin-top: 4px;
    color: var(--text-tertiary);
    font-size: 11px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .flag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-top: 7px;
  }

  .flag-list span {
    padding: 3px 6px;
    border-radius: 5px;
    color: var(--text-secondary);
    background: var(--bg-tertiary);
    font-size: 11px;
    font-weight: 650;
  }

  .message-list {
    margin-top: 5px;
  }

  .warning-text {
    color: #d7a94c;
  }

  .error-text {
    color: #ff9b9b;
  }

  .import-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .selection-actions {
    display: flex;
    gap: 8px;
  }

  .empty-import-state {
    border: 1px dashed var(--border-strong);
    border-radius: 8px;
    padding: 18px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
  }

  .empty-import-state strong {
    color: var(--text-primary);
  }

  .report {
    display: flex;
    flex-direction: column;
    gap: 10px;
    border: 1px solid rgba(18, 128, 92, 0.25);
    border-radius: 8px;
    padding: 12px;
    background: rgba(18, 128, 92, 0.08);
  }

  .report.has-failures {
    border-color: rgba(217, 154, 0, 0.28);
    background: rgba(217, 154, 0, 0.08);
  }

  .report strong {
    margin: 0 0 4px;
  }

  .report-head p {
    margin-top: 2px;
  }

  .report-list {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 7px;
  }

  .report-row {
    display: grid;
    grid-template-columns: 72px minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-primary);
  }

  .report-row:last-child {
    border-bottom: 0;
  }

  .report-row > span {
    align-self: start;
    padding-top: 1px;
    color: var(--text-secondary);
    font-size: 12px;
    font-weight: 800;
  }

  .report-row.imported > span {
    color: #12805c;
  }

  .report-row.skipped > span {
    color: #9f6a00;
  }

  .report-row.failed > span {
    color: #c03434;
  }

  .report-row div {
    min-width: 0;
  }

  .report-row strong,
  .report-row small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
