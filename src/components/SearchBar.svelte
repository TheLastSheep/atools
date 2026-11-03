<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import LauncherMediaToken from "./LauncherMediaToken.svelte";
  import LauncherMatchToken from "./LauncherMatchToken.svelte";
  import AToolsMark from "./AToolsMark.svelte";

  type Props = {
    query: string;
    onchange: (value: string) => void;
    placeholder?: string;
    prominent?: boolean;
    showBadge?: boolean;
    initialFocus?: boolean;
    focusToken?: number;
    selectAllToken?: number;
    matchSummary?: string | null;
    mediaContext?: {kind:"files"|"img";summary:string}|null;
    onmediaremove?:()=>void;
    onmatchedit?: () => void;
    onmatchremove?: () => void;
    onbadgeclick?: () => void;
    onpaste?: (event: ClipboardEvent) => boolean | void;
    resultsId?: string;
    expanded?: boolean;
    activeDescendant?: string;
  };

  let {
    query,
    onchange,
    placeholder = "搜索应用和指令 / 粘贴文件或图片",
    prominent = false,
    showBadge = false,
    initialFocus = false,
    focusToken = 0,
    selectAllToken = 0,
    matchSummary = null,
    mediaContext = null,
    onmediaremove = () => {},
    onmatchedit = () => {},
    onmatchremove = () => {},
    onbadgeclick = () => {},
    onpaste = () => false,
    resultsId = undefined,
    expanded = false,
    activeDescendant = undefined,
  }: Props = $props();
  let inputEl: HTMLInputElement | undefined = $state();
  let draftQuery = $state("");
  let composing = $state(false);
  let lastSubmittedQuery = "";
  let isFocused = $state(false);
  let windowBlurred = $state(false);
  let focusRevision = $state(0);
  let visibilityRevision = $state(0);
  let consumedSelectAllToken = 0;
  let observedFocusToken = 0;
  let initialFocusConsumed = false;
  let nextFocusRequestId = 0;
  let pendingFocusRequest: { id: number; input: HTMLInputElement; selectAll: boolean } | null = null;

  function cancelFocusRequest(id: number) {
    if (pendingFocusRequest?.id === id) pendingFocusRequest = null;
  }

  onDestroy(() => { pendingFocusRequest = null; });

  function canClaimFocus(input: HTMLInputElement): boolean {
    const document = input.ownerDocument;
    const active = document.activeElement;
    return input.isConnected && !windowBlurred && document.visibilityState !== "hidden"
      && (!active || active === input || active === document.body || active === document.documentElement || !active.isConnected);
  }

  $effect(() => {
    if (!composing) {
      draftQuery = query;
      lastSubmittedQuery = query;
    }
  });

  $effect(() => {
    const requestedFocusToken = focusToken;
    const requestedSelectAllToken = selectAllToken;
    focusRevision;
    visibilityRevision;
    const input = inputEl;
    const shouldFocusInitially = initialFocus && !initialFocusConsumed && Boolean(input);
    const hasFocusRequest = requestedFocusToken !== observedFocusToken;
    const shouldSelectAll = requestedSelectAllToken !== consumedSelectAllToken;
    consumedSelectAllToken = requestedSelectAllToken;
    if (hasFocusRequest || shouldSelectAll || shouldFocusInitially) {
      observedFocusToken = requestedFocusToken;
      if (shouldFocusInitially) initialFocusConsumed = true;
      pendingFocusRequest = input
        ? { id: ++nextFocusRequestId, input, selectAll: shouldSelectAll }
        : null;
    }

    const request = pendingFocusRequest;
    if (!request) return;
    if (!input || request.input !== input || !input.isConnected) {
      cancelFocusRequest(request.id);
      return;
    }

    const document = input.ownerDocument;
    const active = document.activeElement;
    const activeIsNeutral = active === document.body || active === document.documentElement;
    if (active && active !== input && !activeIsNeutral && active.isConnected) {
      cancelFocusRequest(request.id);
      return;
    }

    let cancelled = false;
    let stopListening = () => {};
    const handoff = (event: FocusEvent) => {
      const target = event.target;
      if (target !== input && target !== document.body && target !== document.documentElement) {
        cancelled = true;
        cancelFocusRequest(request.id);
        stopListening();
      }
    };
    document.addEventListener("focusin", handoff);
    stopListening = () => document.removeEventListener("focusin", handoff);
    if (!canClaimFocus(input)) {
      return () => { stopListening(); };
    }
    const revision = focusRevision;
    void tick().then(() => {
      stopListening();
      if (!cancelled && pendingFocusRequest?.id === request.id && revision === focusRevision
        && input === inputEl && canClaimFocus(input)) {
        input.focus({ preventScroll: true });
        if (request.selectAll) input.select();
        cancelFocusRequest(request.id);
      }
    });
    return () => { cancelled = true; stopListening(); };
  });

  function submitQuery(value: string) {
    draftQuery = value;
    if (value === lastSubmittedQuery) return;
    lastSubmittedQuery = value;
    onchange(value);
  }

  function handleInput(event: Event) {
    if (composing || (event as InputEvent).isComposing) return;
    submitQuery((event.target as HTMLInputElement).value);
  }

  function finishComposition(event: CompositionEvent) {
    composing = false;
    submitQuery((event.target as HTMLInputElement).value);
  }

  function handlePaste(event: ClipboardEvent) {
    if (composing || (event as ClipboardEvent & { isComposing?: boolean }).isComposing) return;
    if (onpaste(event)) {
      event.preventDefault();
    }
  }
</script>

<svelte:window onblur={() => { windowBlurred = true; focusRevision += 1; }} onfocus={() => { windowBlurred = false; focusRevision += 1; }} />
<svelte:document onvisibilitychange={() => visibilityRevision += 1} />

<div class="search-container" class:focused={isFocused} class:prominent>
  <div class="search-icon" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.5-4.5" />
    </svg>
  </div>

  {#if mediaContext !== null}
    <LauncherMediaToken kind={mediaContext.kind} summary={mediaContext.summary} onremove={onmediaremove}/>
  {/if}

  {#if matchSummary !== null}
    <LauncherMatchToken summary={matchSummary} onedit={onmatchedit} onremove={onmatchremove} />
  {/if}

  <input
    bind:this={inputEl}
    type="text"
    bind:value={draftQuery}
    oninput={handleInput}
    oncompositionstart={() => composing = true}
    oncompositionend={finishComposition}
    onpaste={handlePaste}
    onfocus={() => isFocused = true}
    onblur={() => isFocused = false}
    {placeholder}
    class="search-input"
    data-atools-search-input="true"
    data-atools-composing={composing ? "true" : undefined}
    role={resultsId ? "combobox" : undefined}
    aria-label={mediaContext !== null ? "筛选内容处理命令" : matchSummary !== null ? "筛选文本处理命令" : "搜索应用和指令"}
    aria-autocomplete={resultsId ? "list" : undefined}
    aria-controls={resultsId}
    aria-expanded={resultsId ? expanded : undefined}
    aria-activedescendant={expanded ? activeDescendant : undefined}
    spellcheck="false"
    autocomplete="off"
  />

  {#if draftQuery}
    <button class="clear-btn" aria-label="清除搜索内容" onclick={() => { composing = false; submitQuery(""); inputEl?.focus(); }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
  {/if}

  {#if showBadge}
    <button class="app-badge" aria-label="打开设置" title="设置" onclick={onbadgeclick}>
      <AToolsMark size="badge" label="打开设置" />
    </button>
  {/if}
</div>

<style>
  .search-container {
    min-height: 64px;
    display: flex;
    align-items: center;
    padding: 10px 14px;
    gap: 12px;
    background: var(--bg-primary);
    -webkit-app-region: drag;
    transition: background 0.15s ease;
  }
  .search-container.prominent {
    min-height: 58px;
    align-items: center;
    padding: 5px 12px;
    gap: 8px;
  }
  .search-container.focused {
    background: var(--bg-primary);
  }
  .search-icon {
    width: 34px;
    height: 34px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-tertiary);
    -webkit-app-region: no-drag;
    transition: color 0.15s ease;
  }
  .prominent .search-icon {
    display: none;
  }
  .focused .search-icon {
    color: var(--accent);
  }
  .search-input {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    font-size: 18px;
    font-weight: 500;
    color: var(--text-primary);
    letter-spacing: 0;
    -webkit-app-region: no-drag;
    caret-color: var(--accent);
  }
  .prominent .search-input {
    height: 48px;
    font-size: 25px;
    font-weight: 300;
    line-height: 1.3;
  }
  .search-input::placeholder {
    color: var(--text-tertiary);
    font-weight: 300;
  }
  .prominent .search-input::placeholder {
    color: color-mix(in srgb, var(--text-secondary) 56%, transparent);
  }
  .search-input::selection {
    background: var(--accent-subtle);
  }
  .clear-btn {
    background: var(--bg-tertiary);
    border: 1px solid var(--border);
    color: var(--text-secondary);
    width: 28px;
    height: 28px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    -webkit-app-region: no-drag;
    transition: all 0.15s ease;
  }
  .prominent .clear-btn {
    width: 28px;
    height: 28px;
    margin-top: 0;
    border-radius: 8px;
  }
  .clear-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .app-badge {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-top: 0;
    border: 0;
    border-radius: 50%;
    background: transparent;
    -webkit-app-region: no-drag;
    cursor: pointer;
    transition: transform 0.16s ease;
  }

  .app-badge:hover {
    transform: scale(1.04);
  }

  .app-badge:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
</style>
