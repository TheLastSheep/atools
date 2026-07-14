<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ResultTypeIcon from "./ResultTypeIcon.svelte";
  import type { SearchResult } from "../lib/types";
  import type { SearchFeedback } from "../lib/searchFeedback";
  import { hasTauriAssetRuntime, resultFallbackIcon, resultIconSrc } from "../lib/resultIcons";
  import {
    groupedResultPresentation,
    resultRowPresentation,
  } from "../lib/resultPresentation";

  type Props = {
    results: SearchResult[];
    selectedIndex: number;
    query: string;
    feedback?: SearchFeedback;
    onselect: (index: number) => void;
  };

  let {
    results,
    selectedIndex,
    query = "",
    feedback = { mode: "none", title: "", hint: "", showSpinner: false },
    onselect,
  }: Props = $props();
  let listEl: HTMLDivElement;

  $effect(() => {
    const selected = listEl?.querySelector(".result-row.selected") as HTMLElement;
    selected?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  });

  function highlight(text: string, q: string): string {
    const normalizedQuery = q.trim().startsWith(">") ? q.trim().slice(1).trim() : q.trim();
    if (!normalizedQuery) return escapeHtml(text);
    const lower = text.toLowerCase();
    const qLower = normalizedQuery.toLowerCase();
    let out = "";
    let i = 0;
    while (i < text.length) {
      const idx = lower.indexOf(qLower, i);
      if (idx === -1) {
        out += escapeHtml(text.slice(i));
        break;
      }
      out += escapeHtml(text.slice(i, idx));
      out += `<mark>${escapeHtml(text.slice(idx, idx + normalizedQuery.length))}</mark>`;
      i = idx + normalizedQuery.length;
    }
    return out;
  }

  function iconSrc(icon: string | null) {
    return resultIconSrc(icon, hasTauriAssetRuntime(), convertFileSrc);
  }

  function emptyTitle() {
    return feedback.mode !== "none" ? feedback.title : `没有找到匹配 “${query.trim()}” 的命令`;
  }

  function emptyHint() {
    return feedback.mode !== "none" ? feedback.hint : "输入 “>” 可查看系统命令";
  }

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[c]!);
  }
</script>

<div class="results-list" bind:this={listEl}>
  {#if results.length === 0}
    <div class="empty-state" class:loading={feedback.mode === "loading"} class:error={feedback.mode === "error"}>
      {#if feedback.showSpinner}
        <span class="spinner" aria-hidden="true"></span>
      {/if}
      <div class="empty-text">{emptyTitle()}</div>
      <div class="empty-hint">{emptyHint()}</div>
    </div>
  {:else}
    {#if feedback.mode === "strip"}
      <div class="feedback-strip" class:warning={!feedback.showSpinner}>
        {#if feedback.showSpinner}
          <span class="spinner small" aria-hidden="true"></span>
        {/if}
        <div class="feedback-copy">
          <span>{feedback.title}</span>
          <small>{feedback.hint}</small>
        </div>
      </div>
    {/if}

    {#each groupedResultPresentation(results) as group}
      <section class="result-group" aria-label={group.label}>
        <div class="group-header">
          <span>{group.label}</span>
          <span>{group.items.length}</span>
        </div>

        {#each group.items as item}
          {@const src = iconSrc(item.result.icon)}
          {@const rowMeta = resultRowPresentation(item.result, { selected: item.index === selectedIndex })}
          <button
            class="result-row"
            class:selected={item.index === selectedIndex}
            aria-label={rowMeta.ariaLabel}
            onmousedown={(event) => event.preventDefault()}
            onclick={() => onselect(item.index)}
          >
            <div class="result-icon">
              {#if src}
                <img src={src} alt="" width="30" height="30" />
              {:else}
                <ResultTypeIcon icon={resultFallbackIcon(item.result)} />
              {/if}
            </div>

            <div class="result-content">
              <div class="result-title">{@html highlight(item.result.label, query)}</div>
              {#if item.result.explain}
                <div class="result-desc">{@html highlight(item.result.explain, query)}</div>
              {/if}
            </div>

            <div class="result-meta">
              <div class="meta-stack">
                <span class="source-chip" title={rowMeta.sourceDetail}>{rowMeta.sourceLabel}</span>
                <small>{rowMeta.sourceDetail}</small>
              </div>
              <span class={`match-chip tone-${rowMeta.matchTone}`}>{rowMeta.matchLabel}</span>
              {#if rowMeta.shortcutHint}
                <kbd class="shortcut-hint">{rowMeta.shortcutHint}</kbd>
              {/if}
            </div>
          </button>
        {/each}
      </section>
    {/each}
  {/if}
</div>

<style>
  .results-list {
    max-height: 420px;
    min-height: 112px;
    overflow-y: auto;
    padding: 6px 0;
    background: var(--bg-primary);
    animation: fadeIn 0.1s ease;
  }

  .result-group + .result-group {
    margin-top: 4px;
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
    padding: 0 14px;
    color: var(--text-tertiary);
    font-size: 11px;
    font-weight: 700;
  }

  .result-row {
    position: relative;
    width: 100%;
    height: 54px;
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr) minmax(148px, 220px);
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    color: var(--text-primary);
    background: transparent;
    text-align: left;
  }

  .result-row:hover,
  .result-row.selected {
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-hover));
  }

  .result-row.selected {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 24%, transparent);
  }

  .result-row.selected::before {
    content: "";
    position: absolute;
    left: 0;
    top: 6px;
    bottom: 6px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
  }

  .result-icon {
    width: 30px;
    height: 30px;
  }

  .result-icon {
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .result-icon img {
    border-radius: 6px;
  }

  .result-content {
    min-width: 0;
  }

  .result-title {
    overflow: hidden;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 600;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-desc {
    overflow: hidden;
    margin-top: 2px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-title :global(mark),
  .result-desc :global(mark) {
    border-radius: 3px;
    padding: 0 2px;
    color: var(--accent);
    background: var(--accent-subtle);
    font-weight: 700;
  }

  .result-meta {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 5px;
  }

  .meta-stack {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 2px;
  }

  .meta-stack small {
    max-width: 116px;
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 10px;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source-chip,
  .match-chip {
    max-width: 92px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 1px 6px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    font-size: 11px;
    line-height: 18px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .match-chip {
    max-width: 48px;
    color: var(--text-tertiary);
    background: transparent;
  }

  .match-chip.tone-exact,
  .match-chip.tone-prefix,
  .match-chip.tone-contains,
  .match-chip.tone-regex {
    border-color: color-mix(in srgb, var(--accent) 18%, var(--border));
    color: color-mix(in srgb, var(--accent) 72%, var(--text-secondary));
    background: color-mix(in srgb, var(--accent) 6%, transparent);
  }

  .match-chip.tone-alias {
    border-color: color-mix(in srgb, #7c3aed 28%, var(--border));
    color: #6d28d9;
    background: color-mix(in srgb, #7c3aed 9%, transparent);
  }

  .match-chip.tone-pinyin {
    border-color: color-mix(in srgb, #059669 28%, var(--border));
    color: #047857;
    background: color-mix(in srgb, #059669 9%, transparent);
  }

  .match-chip.tone-fuzzy {
    border-color: color-mix(in srgb, #ea580c 28%, var(--border));
    color: #c2410c;
    background: color-mix(in srgb, #ea580c 9%, transparent);
  }

  .match-chip.tone-pending,
  .match-chip.tone-over,
  .match-chip.tone-unknown {
    border-color: color-mix(in srgb, #71717a 22%, var(--border));
    color: var(--text-tertiary);
    background: rgba(113, 113, 122, 0.06);
  }

  .shortcut-hint {
    min-width: 62px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--accent) 28%, var(--border));
    border-radius: 6px;
    padding: 2px 6px;
    color: var(--accent);
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-secondary));
    font-family: inherit;
    font-size: 10px;
    font-weight: 800;
    line-height: 16px;
    white-space: nowrap;
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
