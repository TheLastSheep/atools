<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ResultTypeIcon from "./ResultTypeIcon.svelte";
  import type { SearchResult } from "../lib/types";
  import { hasTauriAssetRuntime, resultFallbackIcon, resultIconSrc } from "../lib/resultIcons";
  import { resultRowPresentation } from "../lib/resultPresentation";
  import { resultOptionId } from "../lib/launcherKeyboard";
  import { isLauncherMenuShortcut } from "../lib/launcherCommandActions";
  import type { PendingPluginActivation } from "../lib/launcherPendingPluginActivation.svelte";

  type Props = {
    result: SearchResult;
    index: number;
    selected: boolean;
    query: string;
    pendingPluginActivation?: PendingPluginActivation | null;
    onselect: (index: number) => void;
    onselectionchange: (index: number) => void;
    position?: number;
    setSize?: number;
    oncommandmenu?: (event: MouseEvent | KeyboardEvent, result: SearchResult) => void;
  };

  let { result, index, selected, query, pendingPluginActivation = null, onselect, onselectionchange, position, setSize, oncommandmenu }: Props = $props();
  const src = $derived(resultIconSrc(result.icon, hasTauriAssetRuntime(), convertFileSrc));
  const rowMeta = $derived(resultRowPresentation(result, { selected }));
  const opening = $derived(pendingPluginActivation?.pluginId === result.plugin_id
    && pendingPluginActivation.code === result.code);

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

<button
  id={resultOptionId(index)}
  class="result-row"
  class:selected
  data-result-index={index}
  data-result-code={result.code}
  data-plugin-id={result.plugin_id}
  role="option"
  aria-selected={selected}
  aria-busy={opening}
  aria-posinset={position}
  aria-setsize={setSize}
  aria-label={rowMeta.ariaLabel}
  aria-describedby={[rowMeta.description ? `${resultOptionId(index)}-description` : "", opening ? `${resultOptionId(index)}-opening` : ""].filter(Boolean).join(" ") || undefined}
  tabindex="-1"
  onmousedown={(event) => event.preventDefault()}
  onmouseenter={() => onselectionchange(index)}
  onfocus={() => onselectionchange(index)}
  onclick={() => onselect(index)}
  oncontextmenu={(event) => oncommandmenu?.(event, result)}
  onkeydown={(event) => { if (isLauncherMenuShortcut(event)) oncommandmenu?.(event, result); }}
  aria-keyshortcuts={opening ? (oncommandmenu ? "Escape Shift+F10" : "Escape") : oncommandmenu ? "Shift+F10" : undefined}
>
  <div class="result-icon">
    {#if src}
      <img src={src} alt="" width="32" height="32" />
    {:else}
      <ResultTypeIcon icon={resultFallbackIcon(result)} />
    {/if}
  </div>

  <div class="result-content">
    <div class="result-title">{@html highlight(result.label, query)}</div>
    {#if rowMeta.description}
      <div id={`${resultOptionId(index)}-description`} class="result-desc">{@html highlight(rowMeta.description, query)}</div>
    {/if}
  </div>

  <div class="result-meta">
    <span class="source-name" title={`${rowMeta.sourceDetail} · ${rowMeta.matchLabel}匹配`}>{rowMeta.sourceLabel}</span>
    {#if opening}
      <span id={`${resultOptionId(index)}-opening`} class="opening-hint" aria-live="polite" aria-atomic="true">正在打开… · Esc 取消</span>
    {:else}
      <kbd class="shortcut-hint" class:visible={selected} aria-hidden="true" title={rowMeta.shortcutHint || undefined}>↵</kbd>
    {/if}
  </div>
</button>

<style>
  .result-row {
    position: relative;
    width: 100%;
    height: 54px;
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    padding: 0 16px;
    color: var(--text-primary);
    background: transparent;
    text-align: left;
  }

  .result-row:hover {
    background: var(--bg-hover);
  }

  .result-row.selected {
    background: color-mix(in srgb, var(--accent) 8%, var(--bg-primary));
  }

  .result-row.selected::before {
    content: "";
    position: absolute;
    left: 0;
    top: 8px;
    bottom: 8px;
    width: 3px;
    border-radius: 0 2px 2px 0;
    background: var(--accent);
  }

  .result-icon {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .result-icon img {
    border-radius: 8px;
  }

  .result-content {
    min-width: 0;
  }

  .result-title {
    overflow: hidden;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 550;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-desc {
    overflow: hidden;
    margin-top: 4px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-title :global(mark),
  .result-desc :global(mark) {
    border-radius: 2px;
    color: var(--accent);
    background: transparent;
    font-weight: 650;
  }

  .result-meta {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 12px;
  }

  .source-name {
    max-width: 120px;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 18px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shortcut-hint {
    width: 24px;
    height: 24px;
    visibility: hidden;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    font-family: var(--font-mono);
    font-size: 14px;
    line-height: 1;
    white-space: nowrap;
  }

  .shortcut-hint.visible { visibility: visible; }

  .opening-hint {
    color: var(--text-secondary);
    font-size: 11px;
    line-height: 18px;
    white-space: nowrap;
  }

  @media (max-width: 480px) {
    .source-name { max-width: 80px; }
    .result-meta { gap: 8px; }
  }

  .result-row:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }

  .result-row:active {
    background: color-mix(in srgb, var(--accent) 16%, var(--bg-hover));
  }
</style>
