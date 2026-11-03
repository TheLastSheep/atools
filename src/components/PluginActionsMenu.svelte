<script lang="ts">
  import { onDestroy, tick } from "svelte";
  import type { PluginHostAction } from "../lib/pluginHostView";

  type Props = {
    identity: string;
    actions: readonly PluginHostAction[];
    onaction: (id: PluginHostAction["id"]) => void;
  };

  let { identity, actions, onaction }: Props = $props();
  let trigger = $state<HTMLButtonElement | null>(null);
  let menu = $state<HTMLDivElement | null>(null);
  let open = $state(false);
  let position = $state({ left: 8, top: 8 });
  let previousIdentity: string | null = null;
  let alive = true;
  const menuActions = $derived(actions.filter(action => action.id !== "back"));

  onDestroy(() => { alive = false; });

  function portal(node: HTMLElement) {
    node.ownerDocument.body.appendChild(node);
    return { destroy: () => node.remove() };
  }

  function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max));
  }

  function placeMenu() {
    const anchor = trigger?.getBoundingClientRect();
    const popup = menu?.getBoundingClientRect();
    if (!anchor || !popup) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const left = clamp(anchor.right - popup.width, 8, Math.max(8, viewportWidth - popup.width - 8));
    const below = viewportHeight - anchor.bottom - 8;
    const above = anchor.top - 8;
    const desiredTop = below >= popup.height || below >= above
      ? anchor.bottom + 4
      : anchor.top - popup.height - 4;
    const top = clamp(desiredTop, 8, Math.max(8, viewportHeight - popup.height - 8));
    position = { left, top };
  }

  function focusItem(edge: "first" | "last" = "first") {
    const enabled = menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
    if (!enabled?.length) {
      menu?.focus({ preventScroll: true });
      return;
    }
    enabled[edge === "first" ? 0 : enabled.length - 1]?.focus({ preventScroll: true });
  }

  async function showMenu(edge: "first" | "last" = "first") {
    if (!menuActions.length) return;
    open = true;
    placeMenu();
    await tick();
    if (!open) return;
    placeMenu();
    focusItem(edge);
  }

  function close(restoreTrigger = false) {
    if (!open) return;
    open = false;
    if (restoreTrigger && trigger?.isConnected) trigger.focus({ preventScroll: true });
  }

  function toggleMenu() {
    if (open) close();
    else void showMenu();
  }

  function moveFocus(edge: "first" | "last" | -1 | 1) {
    const enabled = [...(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])];
    if (!enabled.length) return;
    if (edge === "first" || edge === "last") {
      enabled[edge === "first" ? 0 : enabled.length - 1]?.focus({ preventScroll: true });
      return;
    }
    const currentIndex = enabled.indexOf(menu?.ownerDocument.activeElement as HTMLButtonElement);
    const nextIndex = currentIndex < 0
      ? (edge === 1 ? 0 : enabled.length - 1)
      : (currentIndex + edge + enabled.length) % enabled.length;
    enabled[nextIndex]?.focus({ preventScroll: true });
  }

  function handleTriggerKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      void showMenu(event.key === "ArrowDown" ? "first" : "last");
    }
  }

  function handleMenuKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.isComposing || event.keyCode === 229
      || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Tab") {
      event.stopPropagation();
      close(true);
    } else if (event.shiftKey) {
      return;
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      event.stopPropagation();
      moveFocus(event.key === "Home" ? "first" : "last");
    } else if (event.key === "Enter" || event.key === " ") {
      // Keep the browser's native button activation while shielding launcher shortcuts.
      event.stopPropagation();
    }
  }

  async function select(action: PluginHostAction) {
    if (!action.available) return;
    const selectedIdentity = identity;
    const invokeAction = onaction;
    close(true);
    await tick();
    if (alive && identity === selectedIdentity) invokeAction(action.id);
  }

  $effect(() => {
    if (previousIdentity === null) {
      previousIdentity = identity;
      return;
    }
    if (identity === previousIdentity) return;
    previousIdentity = identity;
    close(false);
  });

  $effect(() => {
    if (menuActions.length === 0 && open) close(false);
  });

  $effect(() => {
    if (!open) return;
    const ownerDocument = trigger?.ownerDocument ?? document;
    const openIdentity = identity;
    const dismissOutsidePointer = (event: PointerEvent) => {
      if (identity !== openIdentity
        || !(event.target instanceof Node)
        || (!trigger?.contains(event.target) && !menu?.contains(event.target))) close(false);
    };
    const dismissOutsideFocus = (event: FocusEvent) => {
      if (event.target instanceof Node
        && !trigger?.contains(event.target)
        && !menu?.contains(event.target)) close(false);
    };
    const dismissOnWindowBlur = () => close(false);
    ownerDocument.addEventListener("pointerdown", dismissOutsidePointer, true);
    ownerDocument.addEventListener("focusin", dismissOutsideFocus, true);
    window.addEventListener("blur", dismissOnWindowBlur);
    window.addEventListener("resize", placeMenu);
    window.addEventListener("scroll", placeMenu, true);
    return () => {
      ownerDocument.removeEventListener("pointerdown", dismissOutsidePointer, true);
      ownerDocument.removeEventListener("focusin", dismissOutsideFocus, true);
      window.removeEventListener("blur", dismissOnWindowBlur);
      window.removeEventListener("resize", placeMenu);
      window.removeEventListener("scroll", placeMenu, true);
    };
  });
</script>

{#if menuActions.length > 0}
  <button
    bind:this={trigger}
    type="button"
    class="plugin-actions-trigger"
    aria-label="更多插件操作"
    aria-haspopup="menu"
    aria-expanded={open}
    title="更多插件操作"
    onclick={toggleMenu}
    onkeydown={handleTriggerKeydown}
  >
    <svg aria-hidden="true" focusable="false" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="5" cy="12" r="1.7" />
      <circle cx="12" cy="12" r="1.7" />
      <circle cx="19" cy="12" r="1.7" />
    </svg>
  </button>
  {#if open}
    <div
      bind:this={menu}
      use:portal
      class="plugin-actions-menu"
      role="menu"
      aria-label="插件操作"
      tabindex="-1"
      style={`left:${position.left}px;top:${position.top}px;`}
      onkeydown={handleMenuKeydown}
    >
      {#each menuActions as action (action.id)}
        <button
          type="button"
          role="menuitem"
          tabindex="-1"
          class="plugin-actions-menu-item"
          disabled={!action.available}
          title={action.available ? action.label : `${action.label}未接入`}
          onclick={() => void select(action)}
        >
          <span>{action.label}</span>
        </button>
      {/each}
    </div>
  {/if}
{/if}

<style>
  .plugin-actions-trigger {
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 1px solid transparent;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .plugin-actions-trigger:hover,
  .plugin-actions-trigger[aria-expanded="true"] {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .plugin-actions-trigger:active { background: var(--bg-tertiary); }
  .plugin-actions-trigger:focus-visible,
  .plugin-actions-menu-item:focus-visible,
  .plugin-actions-menu:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  .plugin-actions-menu {
    position: fixed;
    z-index: 1200;
    box-sizing: border-box;
    width: min(224px, calc(100vw - 16px));
    max-height: min(320px, calc(100dvh - 16px));
    overflow: auto;
    padding: 4px;
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    background: var(--bg-elevated);
    color: var(--text-primary);
    box-shadow: 0 10px 28px rgb(0 0 0 / 22%);
  }

  .plugin-actions-menu-item {
    width: 100%;
    min-height: 36px;
    display: flex;
    align-items: center;
    padding: 0 10px;
    border: 0;
    border-radius: 5px;
    background: transparent;
    color: var(--text-primary);
    font: 500 12px var(--font-sans);
    text-align: left;
    white-space: nowrap;
    cursor: pointer;
    -webkit-app-region: no-drag;
  }

  .plugin-actions-menu-item:not(:disabled):hover,
  .plugin-actions-menu-item:not(:disabled):focus-visible { background: var(--bg-hover); }
  .plugin-actions-menu-item:active:not(:disabled) { background: var(--bg-tertiary); }
  .plugin-actions-menu-item:disabled { color: var(--text-secondary); opacity: 0.55; cursor: not-allowed; }

  @media (prefers-reduced-motion: reduce) {
    .plugin-actions-trigger,
    .plugin-actions-menu-item { transition: none; }
  }
</style>
