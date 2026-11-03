<script lang="ts">
  import HomePanel from "./HomePanel.svelte";
  import LauncherMainPushStatus from "./LauncherMainPushStatus.svelte";
  import ResultsList from "./ResultsList.svelte";
  import SearchStatusBar from "./SearchStatusBar.svelte";
  import type { SearchFeedback } from "../lib/searchFeedback";
  import { launcherTabTargetHint } from "../lib/launcherTabTarget";
  import { resultActionLabel } from "../lib/launcherWindowLayout";
  import { resultVisualPosition } from "../lib/launcherKeyboard";
  import { homeCommandStatus, type HomeCommandSectionId, type HomeCommandSectionView } from "../lib/homeSurface";
  import type { SearchResult } from "../lib/types";
  import type { LauncherActionIdentity } from "../lib/launcherCommandActions";
  import type { RecommendedCommand, ShellPanel } from "../lib/uiState";
  import type { SettingsMenuId } from "../lib/settingsPages";
  import type { AToolsSettings } from "../lib/settings";
  import type { PendingAwareResultSelect } from "../lib/launcherPendingPluginActivation.svelte";

  type PushState = { rows: SearchResult[]; pending: boolean; deferred: number; message: string; promotedId: string | null };
  export type LauncherResultsSurfaceProps = {
    results: SearchResult[];
    selectedIndex: number;
    query: string;
    feedback: SearchFeedback;
    onselect: PendingAwareResultSelect;
    onretry?: () => void | Promise<void>;
    onselectionchange: (index: number) => void;
    oncommandmenu: (event: MouseEvent | KeyboardEvent, result: SearchResult) => void;
    canOpenCommandMenu: (item: LauncherActionIdentity) => boolean;
    ongroupenter: (group: string) => void;
    showQueryResults: boolean;
    showHomeRecent: boolean;
    showTabTargetStatus: boolean;
    recentCommands?: RecommendedCommand[];
    fullRecentCommands?: RecommendedCommand[];
    visibleRecentCommands?: RecommendedCommand[];
    homeSections?: HomeCommandSectionView[];
    onHomeSectionToggle?: (section: HomeCommandSectionId) => void;
    recentSelectedIndex: number;
    recentSelectedLabel: string;
    recentStatus: ReturnType<typeof homeCommandStatus>;
    settings: AToolsSettings;
    tabAction: string;
    tabTargetFeedback: string;
    featureCatalog: SearchResult[];
    pushState: PushState;
    onHomeCommand: (query: string) => void;
    onHomePanelChange: (panel: ShellPanel) => void;
    onRecentSelectionChange: (index: number, returnFocusToSearch?: boolean) => void;
    onRecentActivate: (command: RecommendedCommand) => void;
    onRecentRemove: (command: RecommendedCommand) => void;
    onRecentCommandMenu: (event: MouseEvent | KeyboardEvent, command: RecommendedCommand) => void;
    onTargetSettings: (target: SettingsMenuId) => void;
    onBindResultsList: (instance: ReturnType<typeof ResultsList> | undefined) => void;
  };

  let {
    results, selectedIndex, query, feedback, onselect, onretry, onselectionchange, oncommandmenu, canOpenCommandMenu,
    ongroupenter, showQueryResults, showHomeRecent, showTabTargetStatus, recentCommands = [],
    fullRecentCommands, visibleRecentCommands, homeSections, onHomeSectionToggle,
    recentSelectedIndex, recentSelectedLabel, recentStatus, settings, tabAction,
    tabTargetFeedback, featureCatalog, pushState, onHomeCommand, onHomePanelChange,
    onRecentSelectionChange, onRecentActivate, onRecentRemove, onRecentCommandMenu,
    onTargetSettings, onBindResultsList,
  }: LauncherResultsSurfaceProps = $props();

  let resultsListInstance = $state<ReturnType<typeof ResultsList> | undefined>();
  const visibleHomeCommands = $derived(visibleRecentCommands ?? recentCommands);
  const fullHomeCommands = $derived(fullRecentCommands ?? visibleHomeCommands);
  const selectedResult = $derived(results[selectedIndex] ?? null);
  const selectedRecentCommand = $derived(visibleHomeCommands[recentSelectedIndex] ?? null);
  const selectedResultMenuAvailable = $derived(Boolean(selectedResult && canOpenCommandMenu(selectedResult)));
  const selectedRecentMenuAvailable = $derived(Boolean(selectedRecentCommand && canOpenCommandMenu(selectedRecentCommand)));
  const pendingPluginActivation = $derived(onselect.pendingPluginActivation ?? null);
  $effect(() => onBindResultsList(resultsListInstance));

  function openSelectedResultMenu(event: MouseEvent) {
    const current = results[selectedIndex];
    if (!current || !canOpenCommandMenu(current)) return;
    oncommandmenu(event, current);
  }

  function openSelectedRecentMenu(event: MouseEvent) {
    const current = visibleHomeCommands[recentSelectedIndex];
    if (!current || !canOpenCommandMenu(current)) return;
    onRecentCommandMenu(event, current);
  }
</script>

{#if showQueryResults}
  <div class="search-surface">
    <ResultsList bind:this={resultsListInstance} {results} {selectedIndex} {query} {feedback} {pendingPluginActivation}
      {onselect} {onretry} onselectionchange={onselectionchange} oncommandmenu={oncommandmenu} ongroupenter={ongroupenter} />
    <LauncherMainPushStatus pending={pushState.pending} deferred={pushState.deferred} message={pushState.message} />
    <SearchStatusBar mode="results" count={results.length} selectedIndex={resultVisualPosition(results, selectedIndex)}
      selectedLabel={selectedResult?.label ?? ""} selectedAction={resultActionLabel(selectedResult)}
      actionMenuAvailable={selectedResultMenuAvailable} onactionmenu={selectedResultMenuAvailable ? openSelectedResultMenu : undefined}
      {tabAction} tabTargetHint={launcherTabTargetHint(settings.tabTarget, featureCatalog)}
      retryOnEnter={feedback.retryOnEnter === true} {tabTargetFeedback} ontargetsettings={() => onTargetSettings("general")} />
  </div>
{:else if showHomeRecent}
  <div class="search-surface">
    <HomePanel commands={fullHomeCommands} sections={homeSections} onsectiontoggle={onHomeSectionToggle}
      oncommand={onHomeCommand} onpanelchange={onHomePanelChange}
      pinnedRows={settings.pinnedRows} recentRows={settings.recentRows} selectedIndex={recentSelectedIndex}
      onselectionchange={onRecentSelectionChange} onactivate={onRecentActivate} onremove={onRecentRemove}
      oncommandmenu={onRecentCommandMenu} ontargetsettings={onTargetSettings} />
    <SearchStatusBar mode="home" count={visibleHomeCommands.length} selectedIndex={recentSelectedIndex}
      selectedLabel={selectedRecentCommand?.label ?? recentSelectedLabel} titleOverride={recentStatus.title} detailOverride={recentStatus.detail}
      spaceOpenCommand={settings.spaceOpenCommand}
      actionMenuAvailable={selectedRecentMenuAvailable} onactionmenu={selectedRecentMenuAvailable ? openSelectedRecentMenu : undefined}
      {tabAction}
      tabTargetHint={launcherTabTargetHint(settings.tabTarget, featureCatalog)} {tabTargetFeedback}
      ontargetsettings={() => onTargetSettings("general")} />
  </div>
{:else if showTabTargetStatus}
  <SearchStatusBar mode="results" count={0} selectedIndex={0} selectedLabel="" tabAction="target"
    tabTargetHint={launcherTabTargetHint(settings.tabTarget, featureCatalog)} {tabTargetFeedback}
    ontargetsettings={() => onTargetSettings("general")} />
{/if}

<style>
  .search-surface { min-height: 0; height: 100%; display: flex; flex-direction: column; background: var(--bg-primary); }
  .search-surface :global(.results-list), .search-surface :global(.home-panel) { flex: 1 1 auto; }
</style>
