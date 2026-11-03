<script lang="ts">
  import { tick } from "svelte";
  import PluginContextMenuLevel from "./PluginContextMenuLevel.svelte";
  import type { PluginContextMenuController } from "../lib/pluginContextMenuController.svelte.js";

  let { controller }: { controller: PluginContextMenuController } = $props();
  let root = $state<HTMLDivElement | null>(null);
  let openPath = $state<number[]>([]);
  let lastMenu = $state<unknown>(null);
  $effect(() => {
    const menu = controller.menu;
    if (menu && menu !== lastMenu) {
      lastMenu = menu;
      openPath = [];
      void tick().then(() => {
        const firstEnabled = root?.querySelector<HTMLButtonElement>('button[data-menu-enabled="true"]');
        (firstEnabled ?? root)?.focus();
      });
    } else if (!menu) lastMenu = null;
  });

  function pathOf(button: HTMLButtonElement) {
    const raw = button.dataset.menuPath || "";
    return raw.split("/").map(Number).filter(Number.isSafeInteger);
  }
  async function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); controller.close(true); return; }
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button[data-menu-path]");
    const level = button?.closest<HTMLElement>("[data-menu-level]");
    if (!button || !level || !root) return;
    const depth = Number(level.dataset.menuLevel || 0);
    const candidates = [...level.querySelectorAll<HTMLButtonElement>(":scope > .menu-entry > button[data-menu-enabled='true']")];
    const index = candidates.indexOf(button);
    if (index < 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? candidates.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : candidates.length - 1)) % candidates.length;
      candidates[next]?.focus();
      return;
    }
    if (event.key === "ArrowRight" && button.dataset.hasSubmenu === "true") {
      event.preventDefault();
      openPath = pathOf(button);
      await tick();
      root.querySelector<HTMLButtonElement>(`[data-menu-level="${depth + 1}"] button[data-menu-enabled="true"]`)?.focus();
      return;
    }
    if (event.key === "ArrowLeft" && depth > 0) {
      event.preventDefault();
      const path = pathOf(button);
      openPath = path.slice(0, depth);
      await tick();
      root.querySelector<HTMLButtonElement>(`button[data-menu-path="${path.slice(0, depth).join("/")}"]`)?.focus();
    }
  }
  function outsideClick(event: MouseEvent) {
    if (event.target instanceof Node && root?.querySelector(".plugin-context-menu")?.contains(event.target)) return;
    controller.close();
  }
  function closeWhenFocusLeaves(event: FocusEvent) {
    if (event.relatedTarget instanceof Node && root?.contains(event.relatedTarget)) return;
    controller.close();
  }
</script>

{#if controller.menu}
  <div bind:this={root} class="plugin-context-menu-backdrop" role="presentation" tabindex="-1"
    onclick={outsideClick} onkeydown={keydown} onfocusout={closeWhenFocusLeaves}>
    <div class="plugin-context-menu" style={`left:${controller.menu.left}px;top:${controller.menu.top}px;--menu-top:${controller.menu.top}px;`}>
      <PluginContextMenuLevel items={controller.menu.items} {openPath}
        onopen={path => { openPath = path; }} onselect={id => controller.select(id)} />
    </div>
  </div>
{/if}

<style>
  .plugin-context-menu-backdrop { position: fixed; inset: 0; z-index: 1200; background: transparent; }
  .plugin-context-menu { position: fixed; box-sizing: border-box; width: min(260px, calc(100vw - 24px)); max-height: min(420px, calc(100vh - var(--menu-top) - 12px)); overflow: auto; padding: 5px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--bg-elevated); color: var(--text-primary); box-shadow: 0 10px 28px rgb(0 0 0 / 22%); }
</style>
