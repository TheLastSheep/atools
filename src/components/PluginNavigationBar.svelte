<script lang="ts">
  import { tick } from "svelte";
  import type { PluginHostAction } from "../lib/pluginHostView";
  import { pluginNavigationIntent } from "../lib/pluginNavigationKeys";
  import { createPluginA11yId } from "../lib/pluginFeatureA11yIds";
  import PluginActionsMenu from "./PluginActionsMenu.svelte";

  type RuntimeInfoControl = {
    controlsId: string;
    expanded: boolean;
    attention: "none" | "warning" | "error";
    onToggle: () => void;
  };

  type Props = {
    title: string;
    feature?: string;
    source?: string;
    identity?: string;
    actions?: readonly PluginHostAction[];
    inputVisible?: boolean;
    value?: string;
    placeholder?: string;
    inputRef?: HTMLInputElement | null;
    controlsId?: string;
    activeDescendantId?: string;
    oninput?: (text: string) => void;
    onreturn: () => void;
    onescape?: () => void;
    /** Return true only when an output list handled the navigation. */
    onmove?: (delta: -1 | 1) => boolean;
    onactivate?: () => boolean;
    onboundary?: (edge: "first" | "last") => boolean;
    onaction?: (id: PluginHostAction["id"]) => void;
    runtimeInfo?: RuntimeInfoControl;
  };

  let {
    title, feature = "", source = "", identity, actions = [],
    inputVisible = false, value = "", placeholder = "输入关键词", controlsId, activeDescendantId,
    inputRef = $bindable<HTMLInputElement | null>(),
    oninput = () => {}, onreturn, onescape = () => {},
    onmove = () => false, onactivate = () => false, onboundary = () => false, onaction = () => {}, runtimeInfo,
  }: Props = $props();

  const actionMenuIdentity = $derived(identity ?? `${source}\u0000${feature}\u0000${title}`);
  const keyHintId = createPluginA11yId("navigation-key-hint");
  let draftValue = $state("");
  let composing = $state(false);
  let currentInputElement: HTMLInputElement | null = null;
  let duplicateCompositionInput: string | null = null;

  $effect(() => { draftValue = value; });
  $effect(() => {
    if (!inputVisible) {
      composing = false;
      duplicateCompositionInput = null;
    }
  });

  function handleInput(event: Event) {
    const text = (event.target as HTMLInputElement).value;
    draftValue = text;
    if (composing || (event as InputEvent).isComposing) return;
    const duplicate = duplicateCompositionInput === text;
    duplicateCompositionInput = null;
    if (!duplicate) oninput(text);
  }

  function beginComposition() {
    composing = true;
    duplicateCompositionInput = null;
  }

  function finishComposition(event: CompositionEvent) {
    composing = false;
    draftValue = (event.target as HTMLInputElement).value;
    duplicateCompositionInput = draftValue;
    oninput(draftValue);
  }

  function trackInputElement(node: HTMLInputElement) {
    currentInputElement = node;
    return {
      destroy() {
        if (currentInputElement === node) currentInputElement = null;
      },
    };
  }

  async function clearInput() {
    if (composing || !draftValue) return;
    const input = currentInputElement;
    draftValue = "";
    duplicateCompositionInput = null;
    oninput("");
    await tick();
    if (input?.isConnected && input === currentInputElement) input.focus();
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!composing && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented
      && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
      && (event.key === "Home" || event.key === "End") && onboundary(event.key === "Home" ? "first" : "last")) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    const intent = pluginNavigationIntent(event, draftValue, composing);
    if (!intent) return;
    let handled = true;
    switch (intent) {
      case "return": onreturn(); break;
      case "clear":
        draftValue = "";
        duplicateCompositionInput = null;
        oninput("");
        break;
      case "escape": onescape(); break;
      case "previous": handled = onmove(-1); break;
      case "next": handled = onmove(1); break;
      case "activate": handled = onactivate(); break;
    }
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
</script>

<header class="plugin-navigation" class:has-input={inputVisible} aria-label="插件导航">
  <button type="button" class="back-btn" aria-label="返回搜索" title="返回搜索" onclick={onreturn}>
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7" />
    </svg>
    <span>返回</span>
  </button>

  <div class="plugin-identity">
    <span class="plugin-title" title={title}>{title}</span>
    {#if feature}<span class="feature-tag" title={feature}>{feature}</span>{/if}
  </div>

  {#if inputVisible}
    <input
      bind:this={inputRef}
      use:trackInputElement
      type="text"
      class="sub-input"
      aria-label="插件搜索"
      role={controlsId ? "combobox" : undefined}
      aria-autocomplete={controlsId ? "list" : undefined}
      aria-controls={controlsId}
      aria-expanded={controlsId ? "true" : undefined}
      aria-activedescendant={controlsId ? activeDescendantId : undefined}
      aria-describedby={!composing ? keyHintId : undefined}
      placeholder={placeholder || "输入关键词"}
      value={draftValue}
      data-atools-composing={composing ? "true" : undefined}
      oninput={handleInput}
      oncompositionstart={beginComposition}
      oncompositionend={finishComposition}
      onkeydown={handleKeydown}
    />
    {#if draftValue.length > 0 && !composing}
      <button
        type="button"
        class="sub-input-clear"
        aria-label="清除插件搜索"
        title="清除插件搜索"
        onpointerdown={(event) => event.preventDefault()}
        onclick={clearInput}
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="m18 6-12 12M6 6l12 12" />
        </svg>
      </button>
    {/if}
    {#if !composing}
      <span id={keyHintId} class="navigation-key-hint">
        <span class="navigation-key-hint-visual" aria-hidden="true">
          <kbd>{draftValue.length === 0 ? "⌫" : "Esc"}</kbd>
          <span>{draftValue.length === 0 ? "返回" : "清空"}</span>
        </span>
        <span class="sr-only">{draftValue.length === 0 ? "按 Backspace 返回搜索" : "按 Escape 清空插件搜索"}</span>
      </span>
    {/if}
  {:else}
    <div class="navigation-spacer"></div>
  {/if}

  {#if source}<span class="plugin-source" title={source}>{source}</span>{/if}
  {#if actions.some(action => action.id !== "back")}
    <PluginActionsMenu identity={actionMenuIdentity} {actions} {onaction} />
  {/if}
  {#if runtimeInfo}
    <button
      type="button"
      class="runtime-info-action"
      class:has-warning={runtimeInfo.attention === "warning"}
      class:has-error={runtimeInfo.attention === "error"}
      aria-label={runtimeInfo.attention === "error" ? "运行信息，有错误" : runtimeInfo.attention === "warning" ? "运行信息，有警告" : "运行信息"}
      aria-controls={runtimeInfo.controlsId}
      aria-expanded={runtimeInfo.expanded}
      title={runtimeInfo.attention === "error" ? "运行信息，有错误" : runtimeInfo.attention === "warning" ? "运行信息，有警告" : "运行信息"}
      onclick={runtimeInfo.onToggle}
    >
      <span class="runtime-info-symbol" aria-hidden="true">ⓘ</span>
      <span class="runtime-info-label">运行信息</span>
      {#if runtimeInfo.attention !== "none"}<span class="runtime-info-attention" aria-hidden="true">{runtimeInfo.attention === "error" ? "!" : "•"}</span>{/if}
    </button>
  {/if}
</header>

<style>
  .plugin-navigation {
    display: flex;
    align-items: center;
    gap: 8px;
    box-sizing: border-box;
    min-height: 56px;
    padding: 8px 12px;
    flex-shrink: 0;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    color: var(--text-primary);
    -webkit-app-region: drag;
  }

  button, input { -webkit-app-region: no-drag; }

  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 36px;
    flex-shrink: 0;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    font: 600 12px var(--font-sans);
    white-space: nowrap;
    cursor: pointer;
  }

  button:not(:disabled):hover { background: var(--bg-hover); color: var(--text-primary); }
  button:not(:disabled):active { background: var(--bg-tertiary); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button:disabled { opacity: 0.48; cursor: not-allowed; }

  .back-btn { color: var(--text-primary); }

  .plugin-identity {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    max-width: 42%;
  }

  .has-input .plugin-identity { max-width: 28%; }

  .plugin-title, .feature-tag, .plugin-source {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .plugin-title { min-width: 0; font-size: 13px; font-weight: 700; }

  .feature-tag {
    max-width: 112px;
    padding: 2px 4px;
    flex-shrink: 2;
    border-radius: 4px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font: 10px var(--font-mono);
  }

  .sub-input {
    width: 0;
    min-width: 80px;
    height: 36px;
    box-sizing: border-box;
    flex: 1 1 150px;
    padding: 0 8px;
    border: 1px solid var(--border-strong);
    border-radius: 6px;
    outline: none;
    background: var(--bg-primary);
    color: var(--text-primary);
    font: 13px var(--font-sans);
  }

  .sub-input-clear {
    width: 28px;
    height: 28px;
    flex: 0 0 28px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    margin-left: -4px;
    transition: background-color 0.15s ease, color 0.15s ease, border-color 0.15s ease;
  }

  .sub-input-clear:hover { background: var(--bg-elevated); color: var(--text-primary); }
  .sub-input-clear:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (prefers-reduced-motion: reduce) {
    .sub-input-clear { transition: none; }
  }

  .sub-input::placeholder { color: var(--text-secondary); }
  .sub-input:hover { border-color: var(--text-secondary); }
  .sub-input:focus { border-color: var(--accent); outline: 2px solid var(--accent-subtle); outline-offset: 1px; background: var(--bg-elevated); }
  .navigation-key-hint {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: 0 1 84px;
    min-width: 0;
    color: var(--text-secondary);
    font: 10px var(--font-sans);
    white-space: nowrap;
  }

  .navigation-key-hint-visual { display: inline-flex; align-items: center; gap: inherit; min-width: 0; }

  .navigation-key-hint kbd {
    flex: 0 0 auto;
    padding: 2px 4px;
    border: 1px solid var(--border);
    border-radius: 4px;
    color: var(--text-primary);
    background: var(--bg-tertiary);
    font: 10px var(--font-mono);
  }

  .navigation-key-hint-visual > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
  .navigation-spacer { flex: 1; }

  .plugin-source { max-width: 96px; color: var(--text-secondary); font: 10px var(--font-mono); }
  .has-input .plugin-source { display: none; }
  .runtime-info-action { gap: 5px; border-color: var(--border); color: var(--text-secondary); }
  .runtime-info-action[aria-expanded="true"] { background: var(--bg-tertiary); color: var(--text-primary); }
  .runtime-info-symbol { display: none; font-size: 15px; line-height: 1; }
  .runtime-info-attention { color: var(--warning, #b45309); font: 800 14px var(--font-sans); }
  .runtime-info-action.has-error .runtime-info-attention { color: var(--danger); }

  @media (max-width: 520px) {
    .plugin-navigation { flex-wrap: nowrap; gap: 4px; padding-inline: 8px; height: 56px; }
    .back-btn span, .plugin-source { display: none; }
    .back-btn { width: 36px; padding: 0; }
    .feature-tag { max-width: 64px; }
    .has-input .plugin-identity { max-width: 24%; }
    .sub-input { flex-basis: 150px; }
    .sub-input-clear { margin-left: 0; }
    .navigation-key-hint { flex-basis: 62px; gap: 2px; font-size: 9px; }
    .navigation-key-hint kbd { padding-inline: 3px; font-size: 9px; }
    .runtime-info-action { width: auto; min-width: 36px; padding: 0 6px; }
    .runtime-info-symbol { display: inline; }
    .runtime-info-label { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
  }

  @media (max-width: 400px) {
    .has-input .plugin-identity { max-width: 18%; flex: 0 1 56px; }
    .feature-tag { display: none; }
    .navigation-key-hint { width: 0; flex: 0 0 0; gap: 0; }
    .navigation-key-hint-visual { display: none; }
    .sub-input { flex-basis: 116px; }
  }
</style>
