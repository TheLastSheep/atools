<script lang="ts">
  import ZMark from "./ZMark.svelte";

  type Props = {
    query: string;
    onchange: (value: string) => void;
    placeholder?: string;
    prominent?: boolean;
    showBadge?: boolean;
    focusToken?: number;
    onbadgeclick?: () => void;
    onpaste?: (event: ClipboardEvent) => boolean | void;
  };

  let {
    query,
    onchange,
    placeholder = "搜索应用和指令 / 粘贴文件或图片",
    prominent = false,
    showBadge = false,
    focusToken = 0,
    onbadgeclick = () => {},
    onpaste = () => false,
  }: Props = $props();
  let inputEl: HTMLInputElement;
  let isFocused = $state(false);

  $effect(() => {
    if (inputEl) {
      focusToken;
      setTimeout(() => inputEl?.focus(), 50);
    }
  });

  function handlePaste(event: ClipboardEvent) {
    if (onpaste(event)) {
      event.preventDefault();
    }
  }
</script>

<div class="search-container" class:focused={isFocused} class:prominent>
  <div class="search-icon" aria-hidden="true">
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.5-4.5" />
    </svg>
  </div>

  <input
    bind:this={inputEl}
    type="text"
    bind:value={query}
    oninput={(e) => onchange((e.target as HTMLInputElement).value)}
    onpaste={handlePaste}
    onfocus={() => isFocused = true}
    onblur={() => isFocused = false}
    {placeholder}
    class="search-input"
    data-atools-search-input="true"
    spellcheck="false"
    autocomplete="off"
  />

  {#if query}
    <button class="clear-btn" aria-label="清除搜索内容" onclick={() => { onchange(""); inputEl?.focus(); }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M18 6L6 18M6 6l12 12"/>
      </svg>
    </button>
  {/if}

  {#if showBadge}
    <button class="app-badge" aria-label="打开设置" title="设置" onclick={onbadgeclick}>
      <ZMark size="badge" label="打开设置" />
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
</style>
