<script lang="ts">
  import type { PluginInventorySourceFilter, PluginInventoryStatusFilter } from "../lib/pluginInventoryBrowseState";

  type Props = {
    query?: string;
    status?: PluginInventoryStatusFilter;
    source?: PluginInventorySourceFilter;
    searchInput?: HTMLInputElement;
    resultCount: number;
    resultCountReady: boolean;
    onmarket?: () => void;
  };
  let { query = $bindable(""), status = $bindable<PluginInventoryStatusFilter>("all"),
    source = $bindable<PluginInventorySourceFilter>("all"), searchInput = $bindable<HTMLInputElement>(),
    resultCount, resultCountReady, onmarket }: Props = $props();
  const filtered = $derived(Boolean(query || status !== "all" || source !== "all"));
  const countStatus = $derived(filtered && resultCountReady);
</script>

<div class="inventory-toolbar">
  <div class="filters" role="group" aria-label="筛选插件">
    <label class="search">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="6.8" cy="6.8" r="4.2" /><path d="m10 10 3.5 3.5" /></svg>
      <input bind:this={searchInput} bind:value={query} placeholder="搜索名称或功能" aria-label="筛选已安装插件" />
    </label>
    <select bind:value={status} aria-label="插件状态"><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">已停用</option></select>
    <select bind:value={source} aria-label="插件来源"><option value="all">全部来源</option><option value="builtin">内置</option><option value="imported">导入</option></select>
  </div>
  <div class="list-caption">
    <span aria-hidden="true">{filtered ? resultCountReady ? `找到 ${resultCount} 个插件` : "筛选结果待更新" : "全部插件"}</span>
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true" aria-label="筛选插件结果">
      {countStatus ? `找到 ${resultCount} 个插件` : ""}
    </span>
    {#if onmarket}<button class="text-button" onclick={onmarket}>浏览插件市场 <span>→</span></button>{/if}
  </div>
</div>

<style>
  .sr-only {
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
  .inventory-toolbar { min-width: 0; }
  .filters {
    display: grid;
    grid-template-columns: minmax(100px, 1fr) 102px 98px;
    gap: 8px;
  }
  .search { position: relative; min-width: 0; }
  .search svg {
    position: absolute;
    top: 10px;
    left: 10px;
    width: 14px;
    height: 14px;
    stroke: var(--settings-text-secondary, #61616d);
    stroke-width: 1.4;
    stroke-linecap: round;
    pointer-events: none;
  }
  input, select {
    box-sizing: border-box;
    min-width: 0;
    width: 100%;
    height: 34px;
    padding: 6px 9px;
    font: inherit;
    font-size: 12px;
    border-radius: 6px;
    border: 1px solid var(--settings-control-border, #d9d9e0);
    color: inherit;
    background: var(--settings-control, #fafafd);
  }
  input { padding-left: 30px; }
  input:focus-visible, select:focus-visible, button:focus-visible {
    outline: 2px solid var(--settings-primary, #7650d6);
    outline-offset: 2px;
  }
  .list-caption {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    min-height: 30px;
    padding: 3px 0;
    font-size: 11px;
    color: var(--settings-text-secondary, #61616d);
  }
  .text-button {
    flex: 0 0 auto;
    min-height: 28px;
    padding: 4px 0 4px 6px;
    border: 0;
    border-radius: 4px;
    background: none;
    color: var(--settings-primary, #7650d6);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }
  .text-button:hover { text-decoration: underline; text-underline-offset: 3px; }
  @media (max-width: 540px) {
    .filters { grid-template-columns: 1fr 1fr; gap: 7px; }
    .search { grid-column: 1 / -1; }
  }
</style>
