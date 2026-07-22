<script lang="ts">
  import { convertFileSrc } from "@tauri-apps/api/core";
  import ResultTypeIcon from "./ResultTypeIcon.svelte";
  import {
    homeCommandFallbackIcon,
    homeCommandSections,
  } from "../lib/homeSurface";
  import { hasTauriAssetRuntime, resultIconSrc } from "../lib/resultIcons";
  import type { RecommendedCommand, ShellPanel } from "../lib/uiState";

  type Props = {
    commands: RecommendedCommand[];
    oncommand: (query: string) => void;
    onpanelchange: (panel: ShellPanel) => void;
    pinnedRows?: number;
    recentRows?: number;
    selectedIndex?: number;
    onselectionchange?: (index: number) => void;
    onactivate?: (command: RecommendedCommand) => void;
    onremove?: (command: RecommendedCommand) => void;
  };

  let {
    commands,
    oncommand,
    onpanelchange,
    pinnedRows = 1,
    recentRows = 2,
    selectedIndex = 0,
    onselectionchange = () => {},
    onactivate = undefined,
    onremove = undefined,
  }: Props = $props();

  const commandSections = $derived(homeCommandSections(commands, { pinnedRows, recentRows }));
  const visibleCommands = $derived(commandSections.flatMap((section) => section.commands));
  const swatches = ["#d9c7ff", "#d99a00", "#7f8bd9", "#111111", "#6d7fe2", "#8b5cf6", "#2bbd9f", "#33c24d", "#ff941f", "#8b5cf6"];

  function activateCommand(cmd: typeof visibleCommands[number], index: number) {
    onselectionchange(index);
    if (onactivate) {
      onactivate(cmd);
      return;
    }
    if (cmd.panel) {
      onpanelchange(cmd.panel);
      return;
    }
    oncommand(cmd.label);
  }

  function removeCommand(event: MouseEvent, cmd: typeof visibleCommands[number], index: number) {
    event.preventDefault();
    event.stopPropagation();
    onselectionchange(index);
    onremove?.(cmd);
  }

  function globalCommandIndex(command: RecommendedCommand) {
    return visibleCommands.indexOf(command);
  }

  function iconSrc(icon: string | null | undefined) {
    return resultIconSrc(icon, hasTauriAssetRuntime(), convertFileSrc);
  }
</script>

<section class="home-panel" aria-label="最近使用">
  {#each commandSections as section}
    <h2>{section.label}</h2>

    <div
      class="recent-grid"
      class:pinned-grid={section.id === "pinned"}
      aria-label={section.id === "pinned" ? "固定指令" : "最近使用"}
    >
      {#each section.commands as cmd}
        {@const commandIndex = globalCommandIndex(cmd)}
        {@const source = iconSrc(cmd.icon)}
        <div
          class="recent-item-shell"
          class:pinned-item={cmd.source === "pinned"}
          class:selected={commandIndex === selectedIndex}
        >
          <button
            class="recent-item"
            onmousedown={(event) => event.preventDefault()}
            onmouseenter={() => onselectionchange(commandIndex)}
            onclick={() => activateCommand(cmd, commandIndex)}
          >
            <span class:has-image={Boolean(source)} class="recent-icon" style={`--tile-color: ${swatches[commandIndex % swatches.length]}`}>
              {#if source}
                <img src={source} alt="" />
              {:else}
                <ResultTypeIcon icon={homeCommandFallbackIcon(cmd)} />
              {/if}
            </span>
            <span class="recent-label">{cmd.label}</span>
          </button>
          {#if cmd.source === "history" && onremove}
            <button
              class="recent-remove"
              aria-label={`移除 ${cmd.label}`}
              title="从最近使用移除"
              onmouseenter={() => onselectionchange(commandIndex)}
              onclick={(event) => removeCommand(event, cmd, commandIndex)}
            >×</button>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
</section>

<style>
  .home-panel {
    height: 100%;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 12px 10px;
    background: var(--bg-primary);
    animation: fadeIn 0.12s ease;
  }

  h2 {
    margin: 0 0 4px;
    color: var(--text-primary);
    font-size: 12px;
    font-weight: 750;
    letter-spacing: 0.01em;
  }

  .recent-grid + h2 {
    margin-top: 6px;
  }

  .recent-grid {
    display: grid;
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 4px;
  }

  .recent-grid.pinned-grid {
    padding-bottom: 2px;
  }

  .recent-item-shell {
    position: relative;
    min-width: 0;
    height: 58px;
    border-radius: 8px;
  }

  .recent-item {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 4px;
    padding: 4px 2px 3px;
    border-radius: 8px;
    color: var(--text-primary);
    background: transparent;
    text-align: center;
  }

  .recent-item-shell:hover .recent-item,
  .recent-item-shell.selected .recent-item {
    background: var(--accent-subtle);
  }

  .recent-item-shell.selected .recent-item {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent);
  }

  .recent-item-shell.pinned-item .recent-item {
    background: color-mix(in srgb, var(--accent-subtle) 46%, transparent);
  }

  .recent-item-shell.pinned-item:hover .recent-item,
  .recent-item-shell.pinned-item.selected .recent-item {
    background: var(--accent-subtle);
  }

  .recent-remove {
    position: absolute;
    top: 3px;
    right: 4px;
    width: 18px;
    height: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 20%, transparent);
    border-radius: 50%;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--bg-primary) 90%, transparent);
    font-size: 13px;
    font-weight: 700;
    line-height: 1;
    opacity: 0;
    transform: scale(0.92);
    transition: opacity 0.12s ease, transform 0.12s ease, color 0.12s ease, background 0.12s ease;
  }

  .recent-item-shell:hover .recent-remove,
  .recent-item-shell:focus-within .recent-remove {
    opacity: 1;
    transform: scale(1);
  }

  .recent-remove:hover {
    color: #dc2626;
    background: rgba(220, 38, 38, 0.1);
  }

  .recent-icon {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 7px;
    color: #ffffff;
    background: var(--tile-color);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
    font-size: 15px;
    font-weight: 800;
    line-height: 1;
  }

  .recent-icon.has-image {
    overflow: hidden;
    background: color-mix(in srgb, var(--bg-secondary) 88%, var(--bg-primary));
  }

  .recent-icon img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  .recent-icon :global(.result-type-icon) {
    width: 30px;
    height: 30px;
    border: 0;
    color: #ffffff;
    background: transparent;
  }

  .recent-icon :global(.result-type-icon svg) {
    width: 17px;
    height: 17px;
  }

  .recent-label {
    max-width: 100%;
    overflow: hidden;
    color: var(--text-primary);
    font-size: 11.5px;
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
