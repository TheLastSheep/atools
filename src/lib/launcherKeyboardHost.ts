import { createLauncherKeyboardController } from "./launcherKeyboardController";
import { createLauncherSearchRetryController, type SearchRetryEnterContext } from "./launcherSearchRetryController";
import type { HomeCommandSection } from "./homeSurface";
import { searchFeedbackFor } from "./searchFeedback";
import { launcherContentSearchFeedback } from "./launcherContentSearch";
import { launcherMediaSearchFeedback } from "./launcherMediaSearch";
import { searchSelectionIdentity } from "./launcherSearch";
import { homeGridColumnCount, homeGridCommandTarget } from "./homeNavigation";
import type { LauncherControllerState } from "./launcherControllerHost";
import type { SearchResult } from "./types";
import type { RecommendedCommand } from "./uiState";

type MainPushHost = { owns: (code: string) => boolean; requestEscape: () => Promise<unknown> | undefined };
type PluginPanel = { requestEscape?: () => void | Promise<void> };

interface Ports {
  state: LauncherControllerState;
  homeNavigationSections: () => HomeCommandSection[];
  routes: { isPasteboardShelfWindow: boolean; isPasteboardDialogWindow: boolean };
  results: () => SearchResult[];
  mainPushPromoted: () => boolean;
  removeLauncherMedia: () => void;
  pinLauncherText: (content: string) => void;
  restoreLauncherText: (selectAll?: boolean) => void;
  menuShortcut: (event: KeyboardEvent, item: SearchResult | RecommendedCommand | undefined) => boolean;
  mainPushHost: () => MainPushHost | null;
  pluginPanel: () => PluginPanel | null;
  pageResults: (direction: -1 | 1) => boolean;
  focusSearch: () => void;
  activateRecentCommand: () => void;
  onSelect: (index: number) => void;
  onQueryChange: (query: string) => void | Promise<void>;
  launchTabTarget: () => void;
  activateAppShortcut: (event: KeyboardEvent) => boolean;
  onEscape: () => void;
}

/** Binds the per-window keyboard policy to the live launcher state and controllers. */
export function createLauncherKeyboardHost(ports: Ports) {
  function hasModal() {
    return document.querySelector('[role="menu"], [role="dialog"][aria-modal="true"]') !== null;
  }
  function focusSearchRetryAction() {
    const action = document.querySelector<HTMLButtonElement>("button[data-launcher-search-retry]");
    if (!action?.isConnected || action.disabled || action.closest("[hidden], [aria-hidden='true']")) return false;
    action.focus();
    return document.activeElement === action;
  }
  function getState() {
    const state = ports.state;
    const isHomeSearch = state.activePlugin === null && state.activePanel === "home";
    const hasContent = state.textMatch.content !== null || state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null;
    const showHomeRecent = isHomeSearch && !hasContent && !state.query.trim() && state.appSettings.showRecentInSearch;
    const showQueryResults = isHomeSearch && (Boolean(state.query.trim()) || hasContent);
    return {
      isHomeSearch,
      ...ports.routes,
      mediaMatch: state.mediaMatch,
      textMatch: state.textMatch,
      query: state.query,
      activePlugin: state.activePlugin,
      activePanel: state.activePanel,
      appSettings: state.appSettings,
      launcherResults: ports.results(),
      selectedIndex: state.selectedIndex,
      selectedRecentIndex: state.selectedRecentIndex,
      showHomeRecent,
      showQueryResults,
      trimmedQuery: state.query.trim(),
      visibleRecentCommands: state.visibleRecentCommands,
      homeNavigationSections: ports.homeNavigationSections(),
      homeGridColumns: homeGridColumnCount(typeof document === "undefined" ? null : document),
      searchFeedback: state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null
        ? launcherMediaSearchFeedback(state.mediaMatch)
        : state.textMatch.content !== null
          ? launcherContentSearchFeedback(state.textMatch)
          : searchFeedbackFor({
            query: state.query,
            resultCount: ports.results().length,
            remoteStatus: state.remoteSearchStatus,
            error: state.searchError,
          }),
      settingsHeaderMenuOpen: (state.activePanel === "settings" || state.activePanel === "plugins")
        && state.activePlugin === null && document.getElementById("settings-more-menu") !== null,
      settingsConfirmDialogOpen: (state.activePanel === "settings" || state.activePanel === "plugins")
        && state.activePlugin === null && document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
      mainPushPromoted: ports.mainPushPromoted(),
    };
  }
  const searchRetry = createLauncherSearchRetryController({
    current: () => {
      const state = getState();
      return {
        query: state.query,
        resultCount: state.launcherResults.length,
        feedback: state.searchFeedback,
        isHomeSearch: state.isHomeSearch,
        hasTextOrMediaContext: state.textMatch.content !== null || state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null,
        modalOpen: state.settingsHeaderMenuOpen || state.settingsConfirmDialogOpen || hasModal(),
      };
    },
    searchGeneration: () => ports.state.searchRunId,
    retry: ports.onQueryChange,
    focusSearch: ports.focusSearch,
    onError: error => console.warn("Search retry failed:", error),
  });
  const controller = createLauncherKeyboardController({
    getState,
    setSelectedIndex: index => { ports.state.selectedIndex = index; },
    setSelectedRecentIndex: index => { ports.state.selectedRecentIndex = index; },
    setUserSearchSelection: (items, index) => { ports.state.userSearchSelection = searchSelectionIdentity(items, index); },
    removeLauncherMedia: ports.removeLauncherMedia,
    pinLauncherText: ports.pinLauncherText,
    restoreLauncherText: ports.restoreLauncherText,
    menuShortcut: ports.menuShortcut,
    mainPushOwns: code => Boolean(ports.mainPushHost()?.owns(code)),
    requestMainPushEscape: () => { void ports.mainPushHost()?.requestEscape(); },
    requestPluginEscape: () => {
      const panel = ports.pluginPanel();
      if (typeof panel?.requestEscape !== "function") return false;
      void panel.requestEscape();
      return true;
    },
    onEscape: ports.onEscape,
    activateAppShortcut: ports.activateAppShortcut,
    hasModal,
    pageResultSelection: ports.pageResults,
    focusSearch: ports.focusSearch,
    activateRecentCommand: ports.activateRecentCommand,
    onSelect: ports.onSelect,
    focusSearchRetryAction,
    retryFromEnter: (context: SearchRetryEnterContext) => searchRetry.retryFromEnter(context),
    launchTabTarget: ports.launchTabTarget,
    focusHomeTarget: index => {
      const target = homeGridCommandTarget(document, index);
      if (!target) return false;
      target.focus();
      return true;
    },
    activateSpaceCommand: ports.activateRecentCommand,
  });
  return {
    onKeyDown: (event: KeyboardEvent) => controller.onKeyDown(event),
    retryFromPointer: searchRetry.retryFromPointer,
  };
}
