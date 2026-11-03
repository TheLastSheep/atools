<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import { isLauncherMenuShortcut, toggleLauncherPin, type LauncherActionTarget } from "../lib/launcherCommandActions";
  import type { SearchResult } from "../lib/types";
  import { isMainSearchKeyboardTarget } from "../lib/keyboardTarget";

  type Props = {
    enabled: boolean;
    generation: string;
    pinnedCodes: string[];
    resolve: (item: LauncherActionTarget) => SearchResult | null;
    onremove: (item: LauncherActionTarget) => void;
    onreturnfocus: () => void;
  };
  let { enabled, generation, pinnedCodes, resolve, onremove, onreturnfocus }: Props = $props();
  let target = $state<{ item: LauncherActionTarget; code: string; pluginId: string; generation: string; x: number; y: number } | null>(null);
  let menu: HTMLDivElement | undefined = $state();
  let position = $state({ x: 8, y: 8 });
  let focused = $state(0);
  let focusRevision = 0;
  let restoreFrame: number | undefined;
  function invalidateFocus() {
    focusRevision += 1;
    if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame);
    restoreFrame = undefined;
  }
  onDestroy(invalidateFocus);
  const command = $derived(target ? resolve(target.item) : null);
  const pinned = $derived(Boolean(target && pinnedCodes.includes(target.code)));
  const canRemove = $derived(target?.item.source === "history" || target?.item.code.startsWith("history:"));

  function close(restore = true, defer = false) {
    if (!target) return;
    const previousMenu = menu;
    const document = previousMenu?.ownerDocument;
    const ownedFocus = Boolean(previousMenu?.contains(document?.activeElement ?? null));
    invalidateFocus();
    const revision = focusRevision;
    target = null;
    if (!restore || !ownedFocus || !document) return;
    if (!defer) {
      if (enabled) onreturnfocus();
      return;
    }
    // A tick can precede mousedown's focus default; return only after that
    // browser action and its microtasks have finished.
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined;
      if (revision !== focusRevision || target || !enabled || !document.hasFocus()
        || document.visibilityState === "hidden") return;
      const active = document.activeElement;
      if (!active || active === document.body || active === document.documentElement || previousMenu?.contains(active)) {
        onreturnfocus();
      }
    });
  }

  export function open(event: MouseEvent | KeyboardEvent, item: LauncherActionTarget): boolean {
    const resolved = resolve(item);
    if (!enabled || !resolved) return false;
    invalidateFocus();
    event.preventDefault(); event.stopPropagation();
    const element = event.target instanceof Element ? event.target.closest("button, [role=option]") : null;
    const anchor = element?.getBoundingClientRect();
    const pointer = "clientX" in event && (event.clientX !== 0 || event.clientY !== 0);
    target = { item: { ...item }, code: resolved.code, pluginId: resolved.plugin_id, generation,
      x: pointer ? event.clientX : anchor?.left ?? 16,
      y: pointer ? event.clientY : anchor?.bottom ?? 60 };
    focused = 0;
    return true;
  }

  export function shortcut(event: KeyboardEvent, item?: LauncherActionTarget): boolean {
    if (!item || !enabled || !isMainSearchKeyboardTarget(event.target) || !isLauncherMenuShortcut(event)) return false;
    return open(event, item);
  }

  $effect(() => {
    if (target && (!enabled || target.generation !== generation || !command
      || command.code !== target.code || command.plugin_id !== target.pluginId)) close(enabled);
  });

  $effect(() => {
    const current = target;
    if (!current) return;
    let cancelled = false;
    void tick().then(() => {
      if (cancelled || target !== current || !menu || menu.ownerDocument.visibilityState === "hidden") return;
      const bounds = menu.getBoundingClientRect();
      position = { x: Math.max(8, Math.min(current.x, innerWidth - bounds.width - 8)),
        y: Math.max(8, Math.min(current.y, innerHeight - bounds.height - 8)) };
      menu.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    });
    return () => { cancelled = true; };
  });

  function onKeyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) {
      if (event.key === "Enter" || event.key === " ") event.preventDefault();
      return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const buttons = [...menu!.querySelectorAll<HTMLButtonElement>("button")];
      focused = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (focused + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[focused]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault(); close();
    }
  }

  function pin() {
    if (!target || !command) return;
    toggleLauncherPin(pinnedCodes, target.code);
    close();
  }

  function remove() {
    const item = target?.item;
    close();
    if (item) onremove(item);
  }

  function outside(event: PointerEvent) {
    if (!target || !(event.target instanceof Node) || menu?.contains(event.target)) return;
    const element = event.target instanceof Element ? event.target : event.target.parentElement;
    const candidate = element?.closest("button, input, select, textarea, a[href], area[href], summary, iframe, object, embed, audio[controls], video[controls], [tabindex], [contenteditable=''], [contenteditable='true'], [contenteditable='plaintext-only']");
    const labelControl = element?.closest("label")?.control;
    const destination = candidate ?? labelControl;
    const handoff = destination && !destination.matches(":disabled, input[type='hidden']")
      && !destination.closest("[inert], [hidden]");
    close(!handoff, true);
  }

  function loseFocus(event: FocusEvent) {
    if (!(event.relatedTarget instanceof Node) || !menu?.contains(event.relatedTarget)) close(false);
  }

  function windowBlur() {
    invalidateFocus();
    close(false);
  }
</script>

<svelte:window onpointerdown={outside} onblur={windowBlur} onresize={() => close()} onwheel={() => close(true, true)} />

{#if target && command}
  <div class="launcher-action-menu" role="menu" aria-label={`${command.label} 的操作`} tabindex="-1"
    bind:this={menu} onkeydown={onKeyDown} onfocusout={loseFocus} style:left={`${position.x}px`} style:top={`${position.y}px`}>
    <p>{command.label}</p>
    <button role="menuitemcheckbox" aria-checked={pinned} tabindex={focused === 0 ? 0 : -1} onclick={pin}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="m16 3 5 5-4 1-3 5v3l-2 2-3-6-6-3 2-2h3l5-3zM9 15l-6 6" /></svg>
      <span>{pinned ? "从首页取消固定" : "固定到首页"}</span>
    </button>
    {#if canRemove}
      <button role="menuitem" tabindex={focused === 1 ? 0 : -1} onclick={remove}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7" /></svg>
        <span>从最近使用移除</span>
      </button>
    {/if}
  </div>
{/if}

<style>
  .launcher-action-menu { position: fixed; z-index: 60; min-width: 192px; max-width: calc(100vw - 16px); padding: 4px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-elevated); box-shadow: 0 8px 24px #0003; }
  p { margin: 0; padding: 6px 8px 8px; max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--text-tertiary); }
  button { width: 100%; min-height: 32px; padding: 6px 8px; display: flex; align-items: center; gap: 8px; border-radius: 4px; color: var(--text-primary); background: transparent; text-align: left; font-size: 12px; }
  button:hover, button:focus-visible { outline: none; background: var(--accent-subtle); color: var(--accent); }
  button:active { background: var(--bg-hover); }
  svg { width: 16px; height: 16px; flex-shrink: 0; }
</style>
