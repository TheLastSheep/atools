<script lang="ts">
  import HomeCommandTile from "./HomeCommandTile.svelte";
  import HomeCommandHint from "./HomeCommandHint.svelte";
  import HomeSectionHeader from "./HomeSectionHeader.svelte";
  import {
    homeCommandSections,
    type HomeCommandSectionView,
    type HomeCommandSectionId,
  } from "../lib/homeSurface";
  import { homeGridArrowDirection, homeGridColumnCount, moveHomeGridSelection } from "../lib/homeNavigation";
  import { isEditableKeyboardTarget } from "../lib/keyboardTarget";
  import { boundedHomeCommandHintText } from "../lib/homeCommandHintText";
  import { matchesHomeCommandHintIdentity, snapshotHomeCommandHintIdentity, type HomeCommandHintIdentity } from "../lib/homeCommandHintState";
  import type { RecommendedCommand, ShellPanel } from "../lib/uiState";
  import type { SettingsMenuId } from "../lib/settingsPages";
  import { isLauncherMenuShortcut } from "../lib/launcherCommandActions";
  import HomeEmptyState from "./HomeEmptyState.svelte";

  type Props = {
    commands: RecommendedCommand[];
    sections?: HomeCommandSectionView[];
    oncommand: (query: string) => void;
    onpanelchange: (panel: ShellPanel) => void;
    ontargetsettings?: (target: SettingsMenuId) => void;
    pinnedRows?: number;
    recentRows?: number;
    onsectiontoggle?: (section: HomeCommandSectionId) => void;
    selectedIndex?: number;
    onselectionchange?: (index: number, returnFocusToSearch?: boolean) => void;
    onactivate?: (command: RecommendedCommand) => void;
    onremove?: (command: RecommendedCommand) => void;
    oncommandmenu?: (event: MouseEvent | KeyboardEvent, command: RecommendedCommand) => void;
  };

  let {
    commands,
    sections = undefined,
    oncommand,
    onpanelchange,
    ontargetsettings,
    pinnedRows = 1,
    recentRows = 2,
    onsectiontoggle,
    selectedIndex = 0,
    onselectionchange = () => {},
    onactivate = undefined,
    onremove = undefined,
    oncommandmenu = undefined,
  }: Props = $props();

  let homePanelElement: HTMLElement | null = $state(null);
  let commandScrollElement: HTMLElement | null = $state(null);
  let focusedSectionHeader: { button: HTMLButtonElement; sectionId: HomeCommandSectionId } | null = $state(null);
  let revealExpandedSectionId: HomeCommandSectionId | null = $state(null);
  let activeHint = $state<{ owner: HomeCommandHintIdentity; index: number; explain: string; anchor: HTMLButtonElement; trigger: "pointer" | "focus" } | null>(null);
  const commandHintId = "atools-home-command-hint";
  const fallbackCommandSections = $derived(homeCommandSections(commands, { pinnedRows, recentRows }));
  const commandSections = $derived(sections ?? fallbackCommandSections);
  const visibleCommands = $derived(commandSections.flatMap((section) => section.commands));
  const capabilityRail = import("./HomeCapabilityRail.svelte");

  function keepHomeTargetVisible(panel: HTMLElement, target: HTMLElement) {
    const viewport = panel.getBoundingClientRect();
    const itemBounds = target.getBoundingClientRect();
    const viewportTop = viewport.top + panel.clientTop;
    const viewportBottom = viewportTop + panel.clientHeight;

    if (itemBounds.top < viewportTop) panel.scrollTop = Math.max(0, panel.scrollTop - (viewportTop - itemBounds.top));
    else if (itemBounds.bottom > viewportBottom) panel.scrollTop += itemBounds.bottom - viewportBottom;
  }

  function keepExpandedSectionVisible(panel: HTMLElement, header: HTMLButtonElement, firstRow: HTMLElement) {
    const viewport = panel.getBoundingClientRect();
    const viewportTop = viewport.top + panel.clientTop;
    const viewportBottom = viewportTop + panel.clientHeight;
    const headerBounds = header.getBoundingClientRect();
    const firstRowBounds = firstRow.getBoundingClientRect();
    const targetTop = Math.min(headerBounds.top, firstRowBounds.top);
    const targetBottom = Math.max(headerBounds.bottom, firstRowBounds.bottom);

    if (targetBottom - targetTop > panel.clientHeight) {
      keepHomeTargetVisible(panel, header);
      return;
    }
    if (targetTop < viewportTop) panel.scrollTop = Math.max(0, panel.scrollTop + targetTop - viewportTop);
    else if (targetBottom > viewportBottom) panel.scrollTop += targetBottom - viewportBottom;
  }

  $effect(() => {
    const panel = commandScrollElement;
    const index = selectedIndex;
    const sections = commandSections;
    const commandCount = sections.reduce((count, section) => count + section.commands.length, 0);
    const focusedHeader = focusedSectionHeader;
    const revealSectionId = revealExpandedSectionId;
    if (!panel) return;
    const focusedButton = focusedHeader?.button;
    if (focusedHeader && focusedButton?.isConnected && panel.contains(focusedButton)) {
      const section = sections.find(candidate => candidate.id === focusedHeader.sectionId);
      const shouldRevealFirstRow = section?.expanded && revealSectionId === section.id;
      const firstRow = shouldRevealFirstRow
        ? panel.querySelector<HTMLElement>(`#atools-home-${section.id}-commands [data-home-command-index]`)
        : null;
      if (shouldRevealFirstRow && firstRow) keepExpandedSectionVisible(panel, focusedButton, firstRow);
      else keepHomeTargetVisible(panel, focusedButton);
      return;
    }
    if (index < 0 || index >= commandCount) return;

    const item = panel.querySelector<HTMLElement>(`[data-home-command-index="${index}"]`);
    if (!item) return;
    keepHomeTargetVisible(panel, item);
  });

  $effect(() => {
    const current = activeHint;
    if (!current) return;
    const row = current.anchor.closest<HTMLElement>("[data-home-command-index]");
    const anchorIndex = Number(row?.dataset.homeCommandIndex);
    const owner = Number.isInteger(anchorIndex) && anchorIndex === current.index
      && row?.querySelector<HTMLButtonElement>(".recent-item") === current.anchor
      ? visibleCommands[anchorIndex]
      : undefined;
    const explain = owner ? boundedHomeCommandHintText(owner.explain) : "";
    if (!owner || !matchesHomeCommandHintIdentity(current.owner, owner) || !explain) activeHint = null;
    else if (explain !== current.explain) activeHint = { ...current, explain };
  });

  function isActiveCommandHint(command: RecommendedCommand, index: number) {
    const current = activeHint;
    if (!current || current.index !== index || !matchesHomeCommandHintIdentity(current.owner, command)) return false;
    const row = current.anchor.closest<HTMLElement>("[data-home-command-index]");
    return current.anchor.isConnected
      && Number(row?.dataset.homeCommandIndex) === index
      && row?.querySelector<HTMLButtonElement>(".recent-item") === current.anchor;
  }

  function showCommandHint(command: RecommendedCommand, index: number, anchor: HTMLButtonElement, trigger: "pointer" | "focus") {
    const explain = boundedHomeCommandHintText(command.explain);
    if (!explain) {
      activeHint = null;
      return;
    }
    activeHint = { owner: snapshotHomeCommandHintIdentity(command), index, explain, anchor, trigger };
  }

  function clearCommandHint() {
    activeHint = null;
  }

  function toggleSection(section: HomeCommandSectionView) {
    if (!onsectiontoggle) return;
    revealExpandedSectionId = section.expanded ? null : section.id;
    onsectiontoggle(section.id);
  }

  function openPluginMarket() {
    ontargetsettings?.("market");
  }

  function leaveCommandHint(anchor: HTMLButtonElement) {
    const current = activeHint;
    if (current?.anchor !== anchor || current.trigger !== "pointer") return;
    if (anchor.ownerDocument.activeElement === anchor) activeHint = { ...current, trigger: "focus" };
    else clearCommandHint();
  }

  function commandMenu(event: MouseEvent | KeyboardEvent, command: RecommendedCommand) {
    if (!oncommandmenu) return;
    clearCommandHint();
    oncommandmenu(event, command);
  }

  function activateCommand(cmd: typeof visibleCommands[number], index: number) {
    clearCommandHint();
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
    clearCommandHint();
    onselectionchange(index);
    onremove?.(cmd);
  }

  function globalCommandIndex(command: RecommendedCommand) {
    return visibleCommands.indexOf(command);
  }

  function commandKeydown(event: KeyboardEvent, index: number, command: RecommendedCommand) {
    if (isLauncherMenuShortcut(event)) {
      commandMenu(event, command);
      return;
    }
    if (isEditableKeyboardTarget(event.target)) return;
    const direction = homeGridArrowDirection(event);
    if (!direction) return;
    event.preventDefault();
    const nextIndex = moveHomeGridSelection(commandSections, index, direction, homeGridColumnCount(homePanelElement));
    if (nextIndex === index) return;
    homePanelElement?.querySelector<HTMLButtonElement>(`[data-home-command-index="${nextIndex}"] .recent-item`)?.focus();
  }

  function selectFocusedCommand(index: number) {
    if (index !== selectedIndex) onselectionchange(index, false);
  }

  function hoverCommand(index: number) {
    // Hover selection normally returns keyboard input to search; an open menu owns it instead.
    if (homePanelElement?.ownerDocument.activeElement?.closest('[role="menu"]')) return;
    onselectionchange(index);
  }

  function pointerEnterCommand(command: RecommendedCommand, index: number, anchor: HTMLButtonElement) {
    const commandSnapshot = command;
    const indexSnapshot = index;
    hoverCommand(indexSnapshot);
    showCommandHint(commandSnapshot, indexSnapshot, anchor, "pointer");
  }

  function focusCommand(command: RecommendedCommand, index: number, anchor: HTMLButtonElement) {
    const commandSnapshot = command;
    const indexSnapshot = index;
    selectFocusedCommand(indexSnapshot);
    showCommandHint(commandSnapshot, indexSnapshot, anchor, "focus");
  }

</script>

<section bind:this={homePanelElement} class="home-panel" aria-label="ATools 首页">
  <div bind:this={commandScrollElement} class="home-command-scroll" role="region" aria-label="固定指令与最近使用">
    {#if visibleCommands.length === 0}
      <HomeEmptyState onmarket={ontargetsettings ? openPluginMarket : undefined}
        onmanage={() => onpanelchange("plugins")} />
    {:else}
      {#each commandSections as section (section.id)}
        <HomeSectionHeader
          {section}
          onToggle={onsectiontoggle ? () => toggleSection(section) : undefined}
          onFocus={button => { focusedSectionHeader = { button, sectionId: section.id }; }}
          onBlur={button => {
            if (focusedSectionHeader?.button !== button) return;
            focusedSectionHeader = null;
            revealExpandedSectionId = null;
          }}
        />

        <div
          class="recent-grid"
          class:pinned-grid={section.id === "pinned"}
          id={`atools-home-${section.id}-commands`}
          aria-label={section.id === "pinned" ? "固定指令" : "最近使用"}
        >
          {#each section.commands as cmd}
            {@const commandIndex = globalCommandIndex(cmd)}
            <HomeCommandTile
              command={cmd}
              {commandIndex}
              selected={commandIndex === selectedIndex}
              pinned={cmd.source === "pinned"}
              hintId={commandHintId}
              hintActive={isActiveCommandHint(cmd, commandIndex)}
              events={{
                activate: () => activateCommand(cmd, commandIndex),
                keydown: (event) => commandKeydown(event, commandIndex, cmd),
                focus: (command, index, button) => focusCommand(command, index, button),
                blur: (button) => { if (activeHint?.anchor === button) clearCommandHint(); },
                pointerEnter: (command, index, button) => pointerEnterCommand(command, index, button),
                pointerLeave: (button) => leaveCommandHint(button),
                removePointerEnter: (index) => hoverCommand(index),
                removeFocus: (index) => selectFocusedCommand(index),
                contextMenu: oncommandmenu ? (event) => commandMenu(event, cmd) : undefined,
                remove: cmd.source === "history" && onremove
                  ? (event) => removeCommand(event, cmd, commandIndex)
                  : undefined,
              }}
            />
          {/each}
        </div>
      {/each}
    {/if}
  </div>
  <div class="home-navigation">
    {#await capabilityRail then module}
      {@const HomeCapabilityRail = module.default}
      <HomeCapabilityRail {oncommand} {onpanelchange} />
    {/await}
  </div>
  {#if activeHint}
    <HomeCommandHint id={commandHintId} explain={activeHint.explain} anchor={activeHint.anchor} onclose={clearCommandHint} />
  {/if}
</section>

<style>
  .home-panel {
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    padding: 10px 12px 12px;
    background: var(--bg-primary);
    animation: fadeIn 0.12s ease;
  }

  .home-command-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .home-navigation { flex: 0 0 auto; margin-top: auto; padding-top: 12px; }

  .recent-grid {
    display: grid;
    grid-template-columns: repeat(9, minmax(0, 1fr));
    gap: 0;
  }

  @media (max-width: 640px) {
    .recent-grid {
      grid-template-columns: repeat(auto-fill, minmax(min(100%, 64px), 1fr));
    }
  }
</style>
