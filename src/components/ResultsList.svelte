<script lang="ts">
  import { tick } from "svelte";
  import ResultRow from "./ResultRow.svelte";
  import type { SearchResult } from "../lib/types";
  import type { SearchFeedback } from "../lib/searchFeedback";
  import type { PendingPluginActivation } from "../lib/launcherPendingPluginActivation.svelte";
  import { createResultListIndex, selectedResultScrollTop, visibleResultGroups } from "../lib/resultListViewport";
  import { pageResultSelection } from "../lib/resultListPaging";

  type Props = {
    results: SearchResult[];
    selectedIndex: number;
    query: string;
    feedback?: SearchFeedback;
    pendingPluginActivation?: PendingPluginActivation | null;
    onselect: (index: number) => void;
    onselectionchange?: (index: number) => void;
    oncommandmenu?: (event: MouseEvent | KeyboardEvent, result: SearchResult) => void;
    ongroupenter?: (group: string) => void;
    onretry?: () => void | Promise<void>;
  };

  let {
    results,
    selectedIndex,
    query = "",
    feedback = { mode: "none", title: "", hint: "", showSpinner: false },
    pendingPluginActivation = null,
    onselect,
    onselectionchange = () => {},
    oncommandmenu = undefined,
    ongroupenter,
    onretry,
  }: Props = $props();
  let listEl: HTMLDivElement | undefined = $state();
  let viewportEl: HTMLDivElement | undefined = $state();
  let retryActionEl: HTMLButtonElement | undefined = $state();
  let scrollTop = $state(0);
  let viewportHeight = $state(420);
  let previousQuery: string | undefined;
  const resultIndex = $derived(createResultListIndex(results));
  const groups = $derived(visibleResultGroups(resultIndex, scrollTop, viewportHeight, selectedIndex));

  $effect.pre(() => {
    const canRenderRetry = Boolean(onretry && query.trim()
      && (results.length === 0 && feedback.mode === "error" && feedback.retryOnEnter === true
        || results.length > 0 && feedback.mode === "strip" && feedback.retryOnPointer === true));
    const action = retryActionEl;
    if (!canRenderRetry && action && action.ownerDocument.activeElement === action) {
      action.ownerDocument.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]')?.focus();
    }
  });

  function measureViewport() {
    const rawScrollTop = listEl?.scrollTop ?? 0;
    return {
      top: Math.max(0, rawScrollTop),
      height: Math.max(54, listEl?.clientHeight || 420),
    };
  }

  function updateViewport() {
    const measured = measureViewport();
    scrollTop = measured.top;
    viewportHeight = measured.height;
  }

  export function pageSelection(direction: -1 | 1): boolean {
    if (!listEl) return false;
    const next = pageResultSelection(resultIndex, selectedIndex, direction, measureViewport().height);
    if (next === null) return false;
    onselectionchange(next);
    return true;
  }

  $effect(() => {
    const value = query;
    const list = listEl;
    if (list && value !== previousQuery) {
      previousQuery = value;
      list.scrollTop = 0;
      scrollTop = 0;
    }
  });

  $effect(() => {
    const list = listEl;
    viewportEl;
    feedback.mode;
    let cancelled = false;
    void tick().then(() => { if (!cancelled) updateViewport(); });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateViewport);
    if (list) observer?.observe(list);
    return () => { cancelled = true; observer?.disconnect(); };
  });

  $effect(() => {
    const index = selectedIndex;
    const layout = resultIndex;
    const list = listEl;
    const viewport = viewportEl;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || !list || !viewport) return;
      const measured = measureViewport();
      const nextTop = selectedResultScrollTop(layout, index, measured.top, measured.height);
      if (nextTop !== measured.top) list.scrollTop = nextTop;
      updateViewport();
      list?.querySelector<HTMLElement>(`[data-result-index="${index}"]`)
        ?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
    });
    return () => { cancelled = true; };
  });

  function emptyTitle() {
    return feedback.mode !== "none" ? feedback.title : `没有找到匹配 “${query.trim()}” 的命令`;
  }

  function emptyHint() {
    return feedback.mode !== "none" ? feedback.hint : "输入 “>” 可查看系统命令";
  }
</script>

<div class="results-list">
  {#if results.length === 0}
    <div class="empty-state" class:loading={feedback.mode === "loading"} class:error={feedback.mode === "error"}>
      <div id="launcher-results" role="listbox" aria-label="搜索结果"></div>
      <div class="empty-status" role="status">
        {#if feedback.showSpinner}
          <span class="spinner" aria-hidden="true"></span>
        {/if}
        <div class="empty-text">{emptyTitle()}</div>
        <div class="empty-hint">{emptyHint()}</div>
      </div>
      {#if onretry && query.trim() && feedback.mode === "error" && feedback.retryOnEnter === true}
        <button bind:this={retryActionEl} class="retry-button" type="button" aria-label="重试搜索" data-launcher-search-retry onclick={() => onretry?.()}>重试</button>
      {/if}
    </div>
  {:else}
    {#if feedback.mode === "strip"}
      <div class="feedback-strip" role="status" class:warning={!feedback.showSpinner}>
        {#if feedback.showSpinner}
          <span class="spinner small" aria-hidden="true"></span>
        {/if}
        <div class="feedback-copy">
          <span>{feedback.title}</span>
          <small>{feedback.hint}</small>
        </div>
        {#if onretry && query.trim() && feedback.retryOnPointer === true}
          <button bind:this={retryActionEl} class="feedback-retry-button" type="button" aria-label="重试搜索" data-launcher-search-retry onclick={() => onretry?.()}>重试</button>
        {/if}
      </div>
    {/if}

    <div id="launcher-results" class="result-scrollport" role="listbox" aria-label="搜索结果"
      bind:this={listEl} onscroll={updateViewport}>
      <div class="result-viewport" style:height={`${resultIndex.height}px`} bind:this={viewportEl}>
        {#each groups as group (group.key)}
          <section class="result-group" style:top={`${group.top}px`} style:height={`${group.height}px`} role="group" aria-label={group.label}>
            <div class="group-header">
              <span>{group.label}</span>
              {#if group.key.startsWith("main-push:") && ongroupenter}
                <button class="group-enter" type="button" onclick={() => ongroupenter?.(group.key)} aria-label={`打开 ${group.label}`}>打开插件</button>
              {/if}
              <span>{group.count}</span>
            </div>

            {#each group.rows as item (item.index)}
              <div class="result-row-window" style:top={`${item.top - group.top}px`}>
                <ResultRow
                  result={item.result}
                  index={item.index}
                  selected={item.index === selectedIndex}
                  {query}
                  {onselect}
                  {onselectionchange}
                  {oncommandmenu}
                  {pendingPluginActivation}
                  position={item.visualIndex + 1}
                  setSize={results.length}
                />
              </div>
            {/each}
          </section>
        {/each}
      </div>
    </div>
  {/if}
</div>

<style>
  .group-enter { margin-left: auto; padding: 0 4px; border: 0; color: var(--accent); background: transparent; font: inherit; cursor: pointer; }
  .group-enter:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; border-radius: 3px; }
  .results-list {
    position: relative;
    display: flex;
    flex-direction: column;
    max-height: 420px;
    min-height: 112px;
    overflow: hidden;
    padding: 6px 0;
    background: var(--bg-primary);
    animation: fadeIn 0.1s ease;
  }

  .result-scrollport {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
  }

  .result-viewport {
    position: relative;
  }

  .result-group {
    position: absolute;
    left: 0;
    right: 0;
  }

  .result-row-window {
    position: absolute;
    left: 0;
    right: 0;
    height: 54px;
  }

  .feedback-strip {
    min-height: 36px;
    display: flex;
    align-items: center;
    gap: 9px;
    margin: 0 10px 6px;
    padding: 6px 10px;
    border: 1px solid color-mix(in srgb, var(--accent) 22%, var(--border));
    border-radius: 7px;
    color: var(--text-primary);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
  }

  .feedback-strip.warning {
    border-color: color-mix(in srgb, #f59e0b 26%, var(--border));
    background: color-mix(in srgb, #f59e0b 9%, var(--bg-secondary));
  }

  .feedback-copy {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .feedback-copy span,
  .feedback-copy small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .feedback-copy span {
    font-size: 12px;
    font-weight: 700;
  }

  .feedback-copy small {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 1.2;
  }

  .group-header {
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
  }

  .empty-state {
    min-height: 112px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 18px 16px;
    text-align: center;
  }

  .empty-status { display: flex; flex-direction: column; align-items: center; }

  .empty-state.loading {
    color: var(--accent);
  }

  .empty-state.error .empty-text {
    color: #dc2626;
  }

  .empty-text {
    max-width: 100%;
    overflow: hidden;
    margin-bottom: 4px;
    color: var(--text-primary);
    font-size: 13px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .empty-hint {
    color: var(--text-secondary);
    font-size: 12px;
  }

  .retry-button {
    margin-top: 8px;
    padding: 4px 10px;
    border: 1px solid var(--border);
    border-radius: 6px;
    color: var(--text-primary);
    background: var(--bg-secondary);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }

  .retry-button:hover { border-color: var(--accent); background: var(--accent-subtle); }
  .retry-button:active { background: color-mix(in srgb, var(--accent-subtle) 72%, var(--bg-secondary)); }
  .retry-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .feedback-retry-button {
    flex: 0 0 auto;
    min-height: 24px;
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: 5px;
    color: var(--text-primary);
    background: var(--bg-secondary);
    font: inherit;
    font-size: 11px;
    cursor: pointer;
  }

  .feedback-retry-button:hover { border-color: var(--accent); background: var(--accent-subtle); }
  .feedback-retry-button:active { background: color-mix(in srgb, var(--accent-subtle) 72%, var(--bg-secondary)); }
  .feedback-retry-button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .spinner {
    width: 18px;
    height: 18px;
    margin-bottom: 8px;
    border: 2px solid color-mix(in srgb, var(--accent) 18%, transparent);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.72s linear infinite;
  }

  .spinner.small {
    width: 14px;
    height: 14px;
    flex: 0 0 14px;
    margin: 0;
    border-width: 2px;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
