<script lang="ts">
  import {
    searchStatusBarView,
    type SearchStatusBarMode,
    type SearchStatusBarTabAction,
  } from "../lib/searchStatusBar";

  type Props = {
    mode: SearchStatusBarMode;
    count: number;
    selectedIndex: number;
    selectedLabel: string;
    selectedAction?: string;
    titleOverride?: string;
    detailOverride?: string;
    tabAction?: SearchStatusBarTabAction | string;
  };

  let {
    mode,
    count,
    selectedIndex,
    selectedLabel,
    selectedAction = "",
    titleOverride = "",
    detailOverride = "",
    tabAction = "select",
  }: Props = $props();

  const view = $derived(searchStatusBarView({
    mode,
    count,
    selectedIndex,
    selectedLabel,
    selectedAction,
    titleOverride,
    detailOverride,
    tabAction: tabAction === "target" ? "target" : "select",
  }));
</script>

<footer class="search-status-bar" aria-label="搜索状态和快捷键">
  <div class="status-copy">
    <span class="status-title">{view.title}</span>
    <span class="status-detail">{view.detail}</span>
  </div>

  <div class="status-hints" aria-label="可用快捷键">
    {#each view.hints as hint}
      <span class="hint">
        <kbd class="keycap">{hint.key}</kbd>
        <span>{hint.label}</span>
      </span>
    {/each}
  </div>
</footer>

<style>
  .search-status-bar {
    height: 34px;
    flex: 0 0 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 0 14px 0 16px;
    border-top: 1px solid var(--border);
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-secondary) 72%, var(--bg-primary));
    -webkit-app-region: drag;
  }

  .status-copy {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-title {
    flex: 0 0 auto;
    color: var(--text-primary);
    font-size: 11.5px;
    font-weight: 800;
  }

  .status-detail {
    min-width: 0;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 11px;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .status-hints {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    -webkit-app-region: no-drag;
  }

  .hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--text-tertiary);
    font-size: 10.5px;
    font-weight: 700;
    white-space: nowrap;
  }

  .keycap {
    min-width: 24px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 5px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 28%, transparent);
    border-bottom-color: color-mix(in srgb, var(--text-tertiary) 42%, transparent);
    border-radius: 5px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 84%, transparent);
    box-shadow: 0 1px 0 color-mix(in srgb, var(--text-tertiary) 14%, transparent);
    font-family: inherit;
    font-size: 10px;
    font-weight: 800;
    line-height: 1;
  }

  @media (max-width: 720px) {
    .search-status-bar {
      gap: 10px;
      padding: 0 10px;
    }

    .status-hints {
      gap: 5px;
    }

    .hint:nth-child(n + 4) {
      display: none;
    }
  }
</style>
