<script lang="ts">
  import type { InstalledPlugin, ZToolsImportReport } from "../lib/types";
  import { firstOpenablePluginFeature } from "../lib/pluginOpen";
  import { ztoolsImportReportView } from "../lib/ztoolsImportView";
  import type { PluginOpenState } from "../lib/pluginOpen";

  type Props = {
    report: ZToolsImportReport | null;
    importedPlugins: Record<string, InstalledPlugin>;
    enableErrors: Record<string, string>;
    pendingEnableRefresh: Set<string>;
    busy: boolean;
    refreshError: string;
    pluginOpenState: PluginOpenState;
    onEnable: (pluginId: string) => void;
    onRetryEnableRead: (pluginId: string) => void;
    onOpen: (pluginId: string) => void;
    onRetryList: () => void;
    onRetryFailures: () => void;
  };
  let { report, importedPlugins, enableErrors, pendingEnableRefresh, busy, refreshError, pluginOpenState, onEnable, onRetryEnableRead, onOpen, onRetryList, onRetryFailures }: Props = $props();
  let reportView = $derived(ztoolsImportReportView(report));
</script>

{#if reportView}
  <section class:has-failures={reportView.hasFailures} class="report" aria-label="导入结果" aria-live="polite">
    <div class="report-head">
      <div>
        <strong>导入报告</strong>
        <p>成功 {reportView.summary.imported} 个，跳过 {reportView.summary.skipped} 个，失败 {reportView.summary.failed} 个。</p>
      </div>
      {#if reportView.summary.failed > 0}
        <button class="secondary" onclick={onRetryFailures} disabled={busy}>重试失败 {reportView.summary.failed} 个</button>
      {/if}
    </div>
    {#if refreshError}
      <div class="refresh-error" role="status">
        <span>{refreshError}</span>
        <button class="secondary" onclick={onRetryList} disabled={busy}>重新读取插件列表</button>
      </div>
    {/if}
    <div class="report-list">
      {#each reportView.rows as row, index (`${row.kind}:${row.path}:${index}`)}
        <div class={`report-row ${row.kind}`}>
          <span>{row.title}</span>
          <div class="result-copy">
            <strong>{row.kind === "imported" ? importedPlugins[row.path]?.manifest.title?.trim() || row.detail : row.detail}</strong>
            <small>{row.path}</small>
          </div>
          {#if row.kind === "imported"}
            {@const plugin = importedPlugins[row.path]}
            {@const openRequest = firstOpenablePluginFeature(plugin)}
            <div class="report-actions">
              {#if openRequest}
                {#if pluginOpenState.pluginId === row.path && pluginOpenState.message}<small role="status">{pluginOpenState.message}</small>{/if}
                <button class="secondary" onclick={() => onOpen(row.path)} disabled={busy || pluginOpenState.busy} aria-busy={pluginOpenState.busy}>
                  {pluginOpenState.busy && pluginOpenState.pluginId === row.path ? "正在打开…" : pluginOpenState.pluginId === row.path && pluginOpenState.message ? "重试打开" : "立即打开"}
                </button>
              {:else if plugin && plugin.manifest.features?.some(feature => typeof feature.code === "string" && feature.code.trim()) && pendingEnableRefresh.has(row.path)}
                <button class="secondary" onclick={() => onRetryEnableRead(row.path)} disabled={busy}>重新读取并打开</button>
              {:else if plugin && plugin.manifest.features?.some(feature => typeof feature.code === "string" && feature.code.trim())}
                {#if enableErrors[row.path]}<small role="status">{enableErrors[row.path]}</small>{/if}
                <button class="secondary" onclick={() => onEnable(row.path)} disabled={busy}>
                  {busy ? "正在启用…" : enableErrors[row.path] ? "重试启用并打开" : "启用并打开"}
                </button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  </section>
{/if}

<style>
  .report { display: flex; flex-direction: column; gap: 10px; border: 1px solid rgba(18, 128, 92, .25); border-radius: 8px; padding: 12px; background: rgba(18, 128, 92, .08); }
  .report.has-failures { border-color: rgba(217, 154, 0, .28); background: rgba(217, 154, 0, .08); }
  .report-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .report-head p { margin: 2px 0 0; color: var(--text-secondary); font-size: 12px; }
  .report-list { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border); border-radius: 7px; }
  .report-row { display: grid; grid-template-columns: 72px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 9px 10px; border-bottom: 1px solid var(--border); background: var(--bg-primary); }
  .report-row:last-child { border-bottom: 0; }
  .report-row > span { align-self: start; padding-top: 1px; color: var(--text-secondary); font-size: 12px; font-weight: 800; }
  .report-row.imported > span { color: #12805c; }
  .report-row.skipped > span { color: #9f6a00; }
  .report-row.failed > span { color: #c03434; }
  .result-copy { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .result-copy strong, .result-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .report-row.failed .result-copy strong, .result-copy small { overflow: visible; text-overflow: clip; white-space: normal; overflow-wrap: anywhere; }
  .result-copy small { color: var(--text-secondary); }
  .report-actions { min-width: 0; display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px 8px; }
  .report-actions small { max-width: 200px; color: #c03434; overflow-wrap: anywhere; }
  .refresh-error { display: flex; align-items: center; justify-content: space-between; gap: 10px; color: #c03434; font-size: 12px; }
  button { flex-shrink: 0; border: 1px solid var(--border-strong); border-radius: 6px; padding: 7px 12px; color: var(--text-primary); background: var(--bg-tertiary); font-size: 12px; cursor: pointer; }
  button:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-hover); }
  button:disabled { cursor: not-allowed; opacity: .55; }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  @media (max-width: 560px) { .report-head, .refresh-error { align-items: flex-start; flex-direction: column; } .report-row { grid-template-columns: 58px minmax(0, 1fr); } .report-actions { grid-column: 2; justify-self: stretch; justify-content: flex-start; } }
</style>
