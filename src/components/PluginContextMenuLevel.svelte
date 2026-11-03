<script lang="ts">
  import PluginContextMenuLevel from "./PluginContextMenuLevel.svelte";
  import type { PluginContextMenuItem } from "../lib/pluginContextMenuSchema";

  type Props = {
    items: PluginContextMenuItem[];
    path?: number[];
    openPath: number[];
    onopen: (path: number[]) => void;
    onselect: (id: string) => void;
  };
  let { items, path = [], openPath, onopen, onselect }: Props = $props();
  const isPrefixPath = (prefix: number[], value: number[]) => prefix.length <= value.length
    && prefix.every((entry, index) => value[index] === entry);
  const isOpen = (itemPath: number[]) => isPrefixPath(itemPath, openPath);
  const enterSubmenu = (next: number[]) => {
    if (!isPrefixPath(next, openPath)) onopen(next);
  };
</script>

<div class="menu-level" role="menu" data-menu-level={path.length}>
  {#each items as item, index (item.id || `separator-${path.join("-")}-${index}`)}
    {@const itemPath = [...path, index]}
    {#if item.type === "separator"}
      <div class="menu-separator" role="separator"></div>
    {:else}
      <div class="menu-entry">
        <button type="button" role={item.type === "checkbox" ? "menuitemcheckbox" : "menuitem"}
          class="menu-item" class:checked={item.checked === true} disabled={item.enabled === false}
          aria-disabled={item.enabled === false ? "true" : undefined}
          aria-checked={item.type === "checkbox" ? item.checked : undefined}
          aria-haspopup={item.submenu !== undefined}
          aria-expanded={item.submenu ? isOpen(itemPath) : undefined}
          data-menu-index={index} data-menu-path={itemPath.join("/")}
          data-menu-enabled={item.enabled === false ? "false" : "true"}
          data-has-submenu={item.submenu ? "true" : "false"}
          onpointerenter={() => item.submenu && enterSubmenu(itemPath)}
          onclick={(event) => {
            event.stopPropagation();
            if (item.submenu) onopen(isOpen(itemPath) ? itemPath.slice(0, -1) : itemPath);
            else if (item.id) onselect(item.id);
          }}>
          <span class="checkmark" aria-hidden="true">{item.type === "checkbox" && item.checked ? "✓" : ""}</span>
          <span class="item-label">{item.label}</span>
          {#if item.submenu}<span class="submenu-chevron" aria-hidden="true">›</span>{/if}
        </button>
        {#if item.submenu && isOpen(itemPath)}
          <div class="submenu">
            <PluginContextMenuLevel items={item.submenu} path={itemPath} {openPath} onopen={onopen} onselect={onselect} />
          </div>
        {/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  .menu-level { display: grid; gap: 2px; min-width: 208px; }
  .menu-entry { min-width: 0; }
  .menu-item { width: 100%; min-height: 30px; display: grid; grid-template-columns: 16px minmax(0, 1fr) 12px; align-items: center; gap: 6px; padding: 4px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--text-primary); font: 12px var(--font-sans); text-align: left; cursor: default; }
  .menu-item:hover:not(:disabled), .menu-item:focus-visible { background: var(--bg-hover); outline: none; }
  .menu-item:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
  .menu-item:disabled { color: var(--text-tertiary); opacity: .58; }
  .checkmark { color: var(--accent); text-align: center; font-weight: 700; }
  .item-label { min-width: 0; overflow-wrap: anywhere; }
  .submenu-chevron { color: var(--text-tertiary); text-align: right; font-size: 16px; line-height: 1; }
  .submenu { margin: 2px 0 2px 20px; padding-left: 6px; border-left: 1px solid var(--border); }
  .menu-separator { height: 1px; margin: 3px 6px; background: var(--border); }
</style>
