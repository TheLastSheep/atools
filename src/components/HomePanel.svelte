<script lang="ts">
  import HomeQuickActionIcon from "./HomeQuickActionIcon.svelte";
  import ResultTypeIcon from "./ResultTypeIcon.svelte";
  import {
    homeCommandFallbackIcon,
    homeCommandSections,
    homeQuickActions,
    homeSearchOverviewCards,
    type HomeQuickAction,
  } from "../lib/homeSurface";
  import type { RecommendedCommand, ShellPanel } from "../lib/uiState";
  import type { SettingsMenuId } from "../lib/settingsPages";

  type Props = {
    commands: RecommendedCommand[];
    oncommand: (query: string) => void;
    onpanelchange: (panel: ShellPanel) => void;
    onsettingsmenu?: (menu: SettingsMenuId) => void;
    pinnedRows?: number;
    recentRows?: number;
    localAppSearch?: boolean;
    localLaunchSearch?: boolean;
    commandAliasCount?: number;
    localLaunchCount?: number;
    webQuickOpenCount?: number;
    selectedIndex?: number;
    onselectionchange?: (index: number) => void;
    onactivate?: (command: RecommendedCommand) => void;
    onremove?: (command: RecommendedCommand) => void;
  };

  let {
    commands,
    oncommand,
    onpanelchange,
    onsettingsmenu = undefined,
    pinnedRows = 2,
    recentRows = 2,
    localAppSearch = true,
    localLaunchSearch = true,
    commandAliasCount = 0,
    localLaunchCount = 0,
    webQuickOpenCount = 0,
    selectedIndex = 0,
    onselectionchange = () => {},
    onactivate = undefined,
    onremove = undefined,
  }: Props = $props();

  const commandSections = $derived(homeCommandSections(commands, { pinnedRows, recentRows, showPinnedEmpty: true }));
  const overviewCards = $derived(homeSearchOverviewCards(commands, {
    pinnedRows,
    recentRows,
    localAppSearch,
    localLaunchSearch,
    commandAliasCount,
    localLaunchCount,
    webQuickOpenCount,
  }));
  const visibleCommands = $derived(commandSections.flatMap((section) => section.commands));
  const quickActions = homeQuickActions();
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

  function activateQuickAction(action: HomeQuickAction) {
    if (action.panel) {
      onpanelchange(action.panel);
      return;
    }
    oncommand(action.label);
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

  function openPinnedCommandsSettings() {
    if (onsettingsmenu) {
      onsettingsmenu("commands");
      return;
    }
    onpanelchange("settings");
  }
</script>

<section class="home-panel" aria-label="最近使用">
  <div class="home-overview" aria-label="搜索概览">
    {#each overviewCards as card}
      <div class="overview-card" class:primary={card.tone === "primary"} class:muted={card.tone === "muted"}>
        <span class="overview-label">{card.label}</span>
        <strong>{card.value}</strong>
        <span class="overview-detail">{card.detail}</span>
      </div>
    {/each}
  </div>

  <div class="quick-actions" aria-label="常用入口">
    {#each quickActions as action}
      <button
        class:primary={action.tone === "primary"}
        class="quick-action"
        aria-label={action.ariaLabel}
        onmousedown={(event) => event.preventDefault()}
        onclick={() => activateQuickAction(action)}
      >
        <span class="quick-action-icon">
          <HomeQuickActionIcon icon={action.icon} />
        </span>
        <span class="quick-action-copy">
          <span class="quick-action-label">{action.label}</span>
        </span>
      </button>
    {/each}
  </div>

  {#each commandSections as section}
    <h2>{section.label}</h2>

    <div
      class="recent-grid"
      class:pinned-grid={section.id === "pinned"}
      aria-label={section.id === "pinned" ? "固定指令" : "最近使用"}
    >
      {#if section.empty}
        <button
          class="pinned-empty"
          aria-label="管理固定指令"
          onmousedown={(event) => event.preventDefault()}
          onclick={openPinnedCommandsSettings}
        >
          <span class="pinned-empty-mark">+</span>
          <span>{section.emptyActionLabel}</span>
        </button>
      {:else}
        {#each section.commands as cmd}
        {@const commandIndex = globalCommandIndex(cmd)}
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
            <span class="recent-icon" style={`--tile-color: ${swatches[commandIndex % swatches.length]}`}>
              <ResultTypeIcon icon={homeCommandFallbackIcon(cmd)} />
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
      {/if}
    </div>
  {/each}
</section>

<style>
  .home-panel {
    min-height: 0;
    padding: 11px 14px 18px;
    background: var(--bg-primary);
    animation: fadeIn 0.12s ease;
  }

  .home-overview {
    height: 54px;
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 7px;
    margin-bottom: 12px;
  }

  .overview-card {
    min-width: 0;
    display: grid;
    grid-template-rows: auto auto auto;
    align-content: center;
    gap: 2px;
    padding: 6px 9px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 16%, transparent);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-secondary) 68%, var(--bg-primary));
  }

  .overview-card.primary {
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    background: color-mix(in srgb, var(--accent-subtle) 54%, var(--bg-primary));
  }

  .overview-card.muted {
    background: color-mix(in srgb, var(--bg-secondary) 42%, transparent);
  }

  .overview-label {
    overflow: hidden;
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 800;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overview-card strong {
    overflow: hidden;
    color: var(--text-primary);
    font-size: 14px;
    font-weight: 850;
    line-height: 1.1;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overview-detail {
    min-width: 0;
    overflow: hidden;
    color: var(--text-secondary);
    font-size: 10px;
    font-weight: 650;
    line-height: 1.15;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-actions {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 7px;
    margin-bottom: 12px;
  }

  .quick-action {
    min-width: 0;
    height: 44px;
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    align-items: center;
    gap: 8px;
    padding: 6px 9px;
    border: 1px solid color-mix(in srgb, var(--text-tertiary) 19%, transparent);
    border-radius: 8px;
    color: var(--text-primary);
    background: color-mix(in srgb, var(--bg-secondary) 74%, var(--bg-primary));
    text-align: left;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.12s ease;
  }

  .quick-action:hover,
  .quick-action:focus-visible {
    border-color: color-mix(in srgb, var(--accent) 32%, transparent);
    background: var(--accent-subtle);
  }

  .quick-action:active {
    transform: translateY(1px);
  }

  .quick-action.primary {
    border-color: color-mix(in srgb, var(--accent) 34%, transparent);
    background: color-mix(in srgb, var(--accent-subtle) 78%, var(--bg-primary));
  }

  .quick-action-icon {
    width: 30px;
    height: 30px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .quick-action.primary .quick-action-icon :global(.home-quick-action-icon) {
    background: var(--accent);
  }

  .quick-action-copy {
    min-width: 0;
    display: block;
  }

  .quick-action-label {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-action-label {
    color: var(--text-primary);
    font-size: 12.5px;
    font-weight: 700;
    line-height: 1.2;
  }

  h2 {
    margin: 0 0 8px;
    color: var(--text-primary);
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: 0;
  }

  .recent-grid + h2 {
    margin-top: 12px;
  }

  .recent-grid {
    display: grid;
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 8px 4px;
  }

  .recent-grid.pinned-grid {
    padding-bottom: 2px;
  }

  .pinned-empty {
    height: 42px;
    grid-column: 1 / span 3;
    display: inline-flex;
    align-items: center;
    justify-content: flex-start;
    gap: 7px;
    padding: 0 11px;
    border: 1px dashed color-mix(in srgb, var(--accent) 34%, var(--text-tertiary));
    border-radius: 8px;
    color: var(--text-secondary);
    background: color-mix(in srgb, var(--accent-subtle) 28%, transparent);
    font-size: 12px;
    font-weight: 800;
    text-align: left;
  }

  .pinned-empty:hover,
  .pinned-empty:focus-visible {
    color: var(--accent);
    background: var(--accent-subtle);
  }

  .pinned-empty-mark {
    width: 20px;
    height: 20px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 6px;
    color: #ffffff;
    background: var(--accent);
    font-size: 15px;
    line-height: 1;
  }

  .recent-item-shell {
    position: relative;
    min-width: 0;
    height: 78px;
    border-radius: 8px;
  }

  .recent-item {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    gap: 7px;
    padding: 7px 2px 6px;
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
    width: 38px;
    height: 38px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 8px;
    color: #ffffff;
    background: var(--tile-color);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.3);
    font-size: 15px;
    font-weight: 800;
    line-height: 1;
  }

  .recent-icon :global(.result-type-icon) {
    width: 34px;
    height: 34px;
    border: 0;
    color: #ffffff;
    background: transparent;
  }

  .recent-icon :global(.result-type-icon svg) {
    width: 20px;
    height: 20px;
  }

  .recent-label {
    max-width: 100%;
    overflow: hidden;
    color: var(--text-primary);
    font-size: 12.5px;
    font-weight: 600;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
