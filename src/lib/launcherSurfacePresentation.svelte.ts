import { homeCommandsFor, type CommandHistoryEntry } from "./commandHistory";
import {
  homeCommandSections,
  homeCommandStatusForSections,
  selectedHomeCommandIndexAfterSectionChange,
  type HomeCommandSectionId,
  type HomeCommandSectionView,
} from "./homeSurface";
import { LAUNCHER_LAYOUT, homeWindowHeightFor, resultsWindowHeightFor, getShellHeight, type LauncherLayoutState } from "./launcherWindowLayout";
import { launcherMediaSearchFeedback, type LauncherMediaSearchState } from "./launcherMediaSearch";
import { launcherContentSearchFeedback, type LauncherContentSearchState } from "./launcherContentSearch";
import { searchFeedbackFor, type RemoteSearchStatus } from "./searchFeedback";
import { resolveSearchSelection, type SearchSelectionIdentity } from "./launcherSearch";
import type { AToolsSettings } from "./settings";
import type { MainPushState } from "./launcherMainPush";
import type { FeatureAction, SearchResult } from "./types";
import type { RecommendedCommand, ShellPanel } from "./uiState";

interface PresentationState {
  query: string;
  activePlugin: FeatureAction | null;
  activePanel: ShellPanel;
  pluginLifecycleNotice: unknown;
  isHomeSearch: boolean;
  textMatch: LauncherContentSearchState;
  mediaMatch: LauncherMediaSearchState;
  appSettings: AToolsSettings;
  selectedRecentIndex: number;
  setSelectedRecentIndex: (index: number) => void;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  userSearchSelection: SearchSelectionIdentity | null;
  launcherDisposed: boolean;
  mainPushPromoted: boolean;
  remoteSearchStatus: RemoteSearchStatus;
  searchError: string;
  launcherResults: SearchResult[];
  mainPushState: MainPushState;
  defaultWindowHeight: number;
}

interface Ports {
  state: () => PresentationState;
  availableCommandHistory: () => CommandHistoryEntry[];
  recommendedCommandsForHome: () => RecommendedCommand[];
  pinnedCommandOptions: () => RecommendedCommand[];
  resizePalette: (height: number) => Promise<void>;
  isDisposed: () => boolean;
}

type HomeSelectionSnapshot = {
  sections: HomeCommandSectionView[];
  visibleCommands: RecommendedCommand[];
  selectedIndex: number;
};

/** Owns the per-window derived data shared by the home grid, result surface, and shell sizing. */
export function createLauncherSurfacePresentation(ports: Ports) {
  const current = ports.state;
  let lastLayoutHeight = 0;
  let lastKnownShellHeight: number = LAUNCHER_LAYOUT.fallbackWindowHeight;
  let expandedHomeSections = $state<HomeCommandSectionId[]>([]);
  let homeSelectionSnapshot: HomeSelectionSnapshot | null = null;
  let fullRecentCommands = $derived.by(() => {
    const history = ports.availableCommandHistory();
    const availablePins = ports.pinnedCommandOptions();
    const recommendations = history.length > 0 || availablePins.length > 0 ? ports.recommendedCommandsForHome() : [];
    const candidateLimit = Math.max(1, availablePins.length + history.length + recommendations.length);
    return homeCommandsFor(
      history,
      recommendations,
      candidateLimit,
      availablePins,
    );
  });
  let homeSections = $derived.by(() => {
    const state = current();
    return homeCommandSections(fullRecentCommands, {
      pinnedRows: state.appSettings.pinnedRows,
      recentRows: state.appSettings.recentRows,
      expandedSections: expandedHomeSections,
    });
  });
  let visibleRecentCommands = $derived(homeSections.flatMap(section => section.commands));
  let trimmedQuery = $derived(current().query.trim());
  let showHomeRecent = $derived.by(() => {
    const state = current();
    return state.isHomeSearch && state.textMatch.content === null && state.mediaMatch.content === null
      && state.mediaMatch.intakeKind === null && trimmedQuery.length === 0 && state.appSettings.showRecentInSearch;
  });
  let showQueryResults = $derived.by(() => {
    const state = current();
    return state.isHomeSearch && (trimmedQuery.length > 0 || state.textMatch.content !== null
      || state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null);
  });
  let showTabTargetStatus = $derived.by(() => {
    const state = current();
    return state.isHomeSearch && state.appSettings.tabKeyFunction === "target-command"
      && !showQueryResults && !showHomeRecent;
  });
  let hasContent = $derived.by(() => {
    const state = current();
    return state.activePlugin !== null || state.activePanel !== "home"
      || showQueryResults || showHomeRecent || showTabTargetStatus;
  });
  let homeRecentWindowHeight = $derived(homeWindowHeightFor(visibleRecentCommands));
  let queryResultsWindowHeight = $derived.by(() => {
    const state = current();
    return resultsWindowHeightFor(state.launcherResults)
      + (state.mainPushState.pending || state.mainPushState.deferred || state.mainPushState.message ? 36 : 0);
  });
  let searchFeedback = $derived.by(() => {
    const state = current();
    if (state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null) return launcherMediaSearchFeedback(state.mediaMatch);
    if (state.textMatch.content !== null) return launcherContentSearchFeedback(state.textMatch);
    return searchFeedbackFor({ query: state.query, resultCount: state.launcherResults.length,
      remoteStatus: state.remoteSearchStatus, error: state.searchError });
  });
  let selectedRecentStatus = $derived.by(() => {
    const state = current();
    return homeCommandStatusForSections(homeSections, state.selectedRecentIndex);
  });
  let searchStatusTabAction = $derived(current().appSettings.tabKeyFunction === "target-command" ? "target" : "select");
  const currentShellHeight = () => {
    if (ports.isDisposed()) return lastKnownShellHeight;
    const state = current();
    lastKnownShellHeight = getShellHeight({ activePlugin: state.activePlugin, activePanel: state.activePanel,
      pluginLifecycleNotice: state.pluginLifecycleNotice, showQueryResults, showHomeRecent, showTabTargetStatus,
      queryResultsWindowHeight, homeRecentWindowHeight, defaultWindowHeight: state.defaultWindowHeight,
    } satisfies LauncherLayoutState);
    return lastKnownShellHeight;
  };

  function resizeIfChanged(height: number) {
    if (ports.isDisposed() || height === lastLayoutHeight) return;
    lastLayoutHeight = height;
    void ports.resizePalette(height);
  }

  async function resetPalette() {
    if (ports.isDisposed()) return;
    const height = currentShellHeight();
    lastLayoutHeight = height;
    await ports.resizePalette(height);
  }
  function syncSearchPresentation() {
    if (ports.isDisposed()) return;
    const state = current();
    if (state.launcherDisposed) return;
    state.setSelectedIndex(resolveSearchSelection(state.launcherResults, state.userSearchSelection));
    if (!state.isHomeSearch || state.mainPushPromoted) return;
    resizeIfChanged(currentShellHeight());
  }

  function toggleHomeSection(sectionId: HomeCommandSectionId) {
    if (ports.isDisposed()) return;
    const state = current();
    if (state.launcherDisposed) return;
    const nextExpanded = expandedHomeSections.includes(sectionId)
      ? expandedHomeSections.filter(section => section !== sectionId)
      : [...expandedHomeSections, sectionId];
    const nextSections = homeCommandSections(fullRecentCommands, {
      pinnedRows: state.appSettings.pinnedRows,
      recentRows: state.appSettings.recentRows,
      expandedSections: nextExpanded,
    });
    const nextIndex = selectedHomeCommandIndexAfterSectionChange(homeSections, nextSections, state.selectedRecentIndex);
    const nextVisibleCommands = nextSections.flatMap(section => section.commands);
    expandedHomeSections = nextExpanded;
    state.setSelectedRecentIndex(nextIndex);
    homeSelectionSnapshot = homeSelectionSnapshotFor(nextSections, nextVisibleCommands, nextIndex);
  }

  $effect(() => {
    const state = current();
    const sections = homeSections;
    const visibleCommands = visibleRecentCommands;
    const previous = homeSelectionSnapshot;
    let selectedIndex = state.selectedRecentIndex;

    if (previous && selectedIndex === previous.selectedIndex
      && !sameHomeCommandIdentities(previous.visibleCommands, visibleCommands)) {
      selectedIndex = selectedHomeCommandIndexAfterSectionChange(previous.sections, sections, previous.selectedIndex);
    }
    selectedIndex = clampHomeSelectionIndex(selectedIndex, visibleCommands.length);
    if (selectedIndex !== state.selectedRecentIndex) state.setSelectedRecentIndex(selectedIndex);
    homeSelectionSnapshot = homeSelectionSnapshotFor(sections, visibleCommands, selectedIndex);
  });

  $effect(() => {
    const state = current();
    if (ports.isDisposed() || !showHomeRecent || !state.isHomeSearch || state.activePlugin !== null
      || state.activePanel !== "home" || state.mainPushPromoted) return;
    resizeIfChanged(currentShellHeight());
  });

  return {
    get fullRecentCommands() { return fullRecentCommands; },
    get visibleRecentCommands() { return visibleRecentCommands; },
    get homeSections() { return homeSections; },
    get expandedHomeSections() { return expandedHomeSections; },
    get trimmedQuery() { return trimmedQuery; },
    get showHomeRecent() { return showHomeRecent; },
    get showQueryResults() { return showQueryResults; },
    get showTabTargetStatus() { return showTabTargetStatus; },
    get hasContent() { return hasContent; },
    get homeRecentWindowHeight() { return homeRecentWindowHeight; },
    get queryResultsWindowHeight() { return queryResultsWindowHeight; },
    get searchFeedback() { return searchFeedback; },
    get selectedRecentStatus() { return selectedRecentStatus; },
    get selectedRecentLabel() { return selectedRecentStatus.selectedLabel; },
    get searchStatusTabAction() { return searchStatusTabAction; },
    currentShellHeight,
    resetPalette,
    syncSearchPresentation,
    toggleHomeSection,
  };
}

function homeSelectionSnapshotFor(
  sections: HomeCommandSectionView[], visibleCommands: RecommendedCommand[], selectedIndex: number,
): HomeSelectionSnapshot {
  return { sections, visibleCommands, selectedIndex };
}

function sameHomeCommandIdentities(previous: RecommendedCommand[], current: RecommendedCommand[]): boolean {
  return previous.length === current.length && previous.every((command, index) => {
    const candidate = current[index];
    return candidate.code === command.code && candidate.plugin_id === command.plugin_id && candidate.panel === command.panel;
  });
}

function clampHomeSelectionIndex(index: number, commandCount: number): number {
  if (commandCount === 0) return 0;
  return Math.max(0, Math.min(commandCount - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
}
