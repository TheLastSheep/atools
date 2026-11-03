<script lang="ts">
  import type { PluginMarketRequest } from "../lib/pluginMarketNavigation";
  import type { ZToolsImportViewRow } from "../lib/ztoolsImportView";
  import type { SourceBuildEntry } from "../lib/pluginSourceBuildProtocol";
  import type { ManifestSelection } from "../lib/pluginSourceBuildManifest";
  import ZToolsSourceBuildStatus from "./ZToolsSourceBuildStatus.svelte";

  type Props = {
    row: ZToolsImportViewRow;
    disabled?: boolean;
    ontoggle: (path: string, checked: boolean) => void;
    onmarketrequest?: (request: PluginMarketRequest) => void;
    sourceBuild?: { entry?: SourceBuildEntry; disabled: boolean; dependencyActive?: boolean; dependencySessionRetained?: boolean; inspect: () => void; selectManifest: (selection: ManifestSelection) => void; convert: () => void; cancel: () => void; resume: () => void; rescan: () => void };
  };

  let { row, disabled = false, ontoggle, onmarketrequest, sourceBuild }: Props = $props();

  function requestMarketSearch() {
    const request = row.marketRequest;
    if (request) onmarketrequest?.(request);
  }
</script>

<div class="candidate-row" class:warning={row.status === "warning"} class:blocked={row.status === "blocked"}>
  <label
    class="candidate-selectable-area"
    class:muted={disabled || !row.selectable}
    for={`ztools-import-${encodeURIComponent(row.path)}`}
  >
    <input
      id={`ztools-import-${encodeURIComponent(row.path)}`}
      type="checkbox"
      disabled={disabled || !row.selectable}
      checked={row.selected}
      aria-describedby={row.sourceChoiceMessage ? `ztools-source-choice-${encodeURIComponent(row.path)}` : undefined}
      onchange={(event) => ontoggle(row.path, (event.currentTarget as HTMLInputElement).checked)}
    />
    <div class="candidate-main">
      <div class="candidate-title-line">
        <strong>{row.title}</strong>
        <span class={`status-pill ${row.status}`}>{row.statusLabel}</span>
      </div>
      <p>{row.subtitle}</p>
      {#if row.sourceChoiceMessage}
        <p id={`ztools-source-choice-${encodeURIComponent(row.path)}`} class="source-choice-message">{row.sourceChoiceMessage}</p>
      {/if}
      {#if row.readinessMessage}
        <p class="readiness-message">{row.readinessMessage}</p>
      {/if}
      {#if row.missingFlags.length > 0}
        <div class="flag-list">
          {#each row.missingFlags as flag}
            <span>{flag}</span>
          {/each}
        </div>
      {/if}
      <small class="candidate-path" title={row.path}>{row.path}</small>
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
  {#if row.sourceBuildCheckable && sourceBuild}
    <ZToolsSourceBuildStatus sourcePath={row.path} entry={sourceBuild.entry} disabled={sourceBuild.disabled}
      dependencyActive={sourceBuild.dependencyActive}
      dependencySessionRetained={sourceBuild.dependencySessionRetained}
      oninspect={sourceBuild.inspect} onconvert={sourceBuild.convert} oncancel={sourceBuild.cancel}
      onresume={sourceBuild.resume} onrescan={sourceBuild.rescan} onselectmanifest={sourceBuild.selectManifest} />
  {/if}
  {#if row.marketRequest && onmarketrequest}
    <button
      class="market-recovery"
      type="button"
      disabled={disabled}
      onclick={requestMarketSearch}
    >
      在官方市场查找发布版
    </button>
  {/if}
</div>

<style>
  .candidate-row {
    padding: 11px 12px;
    background: var(--bg-secondary);
    border-bottom: 1px solid var(--border);
  }

  .candidate-row:last-child { border-bottom: 0; }
  .candidate-row.warning { background: color-mix(in srgb, rgba(217, 154, 0, 0.1) 42%, var(--bg-secondary)); }
  .candidate-selectable-area { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; cursor: pointer; }
  .candidate-selectable-area.muted { opacity: 0.58; cursor: not-allowed; }
  input { margin-top: 2px; align-self: start; }
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
  .candidate-main { min-width: 0; }
  .candidate-title-line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 4px 10px; min-width: 0; }
  strong { display: block; margin-bottom: 3px; font-size: 13px; line-height: 1.3; }
  .candidate-title-line strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  p { margin: 0; color: var(--text-secondary); font-size: 12px; line-height: 1.5; }
  .status-pill { flex-shrink: 0; padding: 3px 7px; border-radius: 999px; color: var(--text-secondary); background: var(--bg-tertiary); font-size: 11px; font-weight: 700; }
  .status-pill.ready { color: #12805c; background: rgba(18, 128, 92, 0.1); }
  .status-pill.warning { color: #9f6a00; background: rgba(217, 154, 0, 0.12); }
  .status-pill.blocked { color: #c03434; background: rgba(220, 38, 38, 0.1); }
  small { display: block; overflow: hidden; margin-top: 4px; color: var(--text-tertiary); font-size: 11px; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
  .readiness-message { margin-top: 5px; color: var(--text-secondary); }
  .source-choice-message { margin-top: 4px; color: var(--text-secondary); }
  .candidate-path { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; white-space: normal; }
  .market-recovery {
    display: block;
    min-height: 32px;
    margin: 8px 0 0 28px;
    padding: 0 10px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .market-recovery:hover:not(:disabled) { border-color: var(--accent); background: var(--bg-hover); }
  .market-recovery:active:not(:disabled) { transform: translateY(1px); }
  .market-recovery:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .market-recovery:disabled { cursor: not-allowed; opacity: 0.55; }
  .flag-list { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
  .flag-list span { padding: 3px 6px; border-radius: 5px; color: var(--text-secondary); background: var(--bg-tertiary); font-size: 11px; font-weight: 650; }
  .message-list { margin-top: 5px; }
  .warning-text { color: #d7a94c; }
  .error-text { color: #ff9b9b; }
</style>
