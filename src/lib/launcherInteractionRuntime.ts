import { createLauncherResultActionsController } from "./launcherResultActionsController";
import { createLauncherHomeController } from "./launcherHomeController";
import { createLauncherNavigationController } from "./launcherNavigationController";
import { createLauncherSearchController } from "./launcherSearchController";
import type { createLauncherPluginSessionController } from "./launcherPluginSessionController";
import type { createLauncherContentSearch } from "./launcherContentSearch";
import type { createLauncherMediaSearch } from "./launcherMediaSearch";
import type { SearchResult } from "./types";
import type { LocalLaunchEntry } from "./localLaunch";
import { searchSelectionIdentity } from "./launcherSearch";
import { captureLauncherReturnContextIfCurrent, createLauncherReturnContextSnapshot, type createLauncherReturnContextStore } from "./launcherReturnContext";
import { isTextContentResult } from "./launcherMatchContext";
import { pinnedLauncherCommands, reconcileLauncherPins, persistLauncherPins } from "./launcherPins";
import { normalizePluginMarketRequest } from "./pluginMarketNavigation";
import type { LauncherPendingPluginActivationStore } from "./launcherPendingPluginActivation.svelte";

type MainPushHost = {
  owns: (code: string) => boolean;
  select: (code: string) => Promise<void>;
  requestEscape: () => Promise<unknown> | undefined;
  closePromoted: () => Promise<void>;
};

type ResultState = Parameters<typeof createLauncherResultActionsController>[0]["state"];
type HomeState = Parameters<typeof createLauncherHomeController>[0]["state"];
type NavigationState = Parameters<typeof createLauncherNavigationController>[0]["state"];
type SearchState = Parameters<typeof createLauncherSearchController>[0]["state"];
export type LauncherInteractionState = ResultState & HomeState & NavigationState & SearchState & {
  mediaMatch: ReturnType<typeof import("./launcherMediaSearch").emptyLauncherMediaSearchState>;
  textMatch: ReturnType<typeof import("./launcherContentSearch").emptyLauncherContentSearchState>;
  searchRunId: number;
  remoteSearchStatus: import("./searchFeedback").RemoteSearchStatus;
  searchError: string;
};

type Ports = {
  state: LauncherInteractionState;
  pluginSession: ReturnType<typeof createLauncherPluginSessionController>;
  pendingPluginActivation: LauncherPendingPluginActivationStore;
  contentSearch: ReturnType<typeof createLauncherContentSearch>;
  mediaSearch: ReturnType<typeof createLauncherMediaSearch>;
  returnContext: ReturnType<typeof createLauncherReturnContextStore>;
  focusSearch: () => void;
  resetPalette: () => Promise<void>;
  hasTauriRuntime: () => boolean;
  returnPluginToSearch: () => Promise<void>;
  onQueryChange: (query: string) => Promise<void>;
  cancelTabTarget: () => void;
  copyText: (text: string) => Promise<void>;
  openHideMainWindow: () => Promise<void>;
  expectedLauncherPluginId: (target: Parameters<ReturnType<typeof createLauncherPluginSessionController>["expectedLauncherPluginId"]>[0]) => string | undefined;
  scheduleAutoClearSearch: () => void;
  activateTextQuickAction: (item: SearchResult) => Promise<void>;
  activatePastedResult: (item: SearchResult) => Promise<void>;
  openLocalLaunchEntry: (entry: LocalLaunchEntry) => Promise<void>;
  openLocalAppPath: (path: string) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  syncLauncherSearchPresentation: () => void;
  getMainPushHost: () => MainPushHost | null;
  getResults: () => SearchResult[];
  searchSelection: typeof searchSelectionIdentity;
  cancelMediaIntake: () => void;
  clearSearchContexts: () => void;
  advanceSearchRun: () => void;
  defaultWindowHeight: () => number;
  expandPalette: (height: number) => Promise<void>;
  tabTargetController: Parameters<typeof createLauncherSearchController>[0]["tabTargetController"];
  mediaPaste: Parameters<typeof createLauncherSearchController>[0]["mediaPaste"];
  clearAutoClearTimer: () => void;
};

export function createLauncherInteractionRuntime(ports: Ports) {
  const { state } = ports;
  const resultActions = createLauncherResultActionsController({
    state,
    pendingPluginActivation: ports.pendingPluginActivation,
    activateFeature: async (code, payload, options) => { await ports.pluginSession.activateFeature(code, payload, options); },
    expectedLauncherPluginId: ports.pluginSession.expectedLauncherPluginId,
    activateTextQuickAction: ports.activateTextQuickAction,
    activatePastedResult: ports.activatePastedResult,
    scheduleAutoClearSearch: ports.scheduleAutoClearSearch,
    focusSearch: ports.focusSearch,
    hasTauriRuntime: ports.hasTauriRuntime,
    openLocalLaunchEntry: ports.openLocalLaunchEntry,
    openLocalAppPath: ports.openLocalAppPath,
    openUrl: ports.openUrl,
    platform: () => navigator.platform,
    getResults: ports.getResults,
    ownsMainPush: code => Boolean(ports.getMainPushHost()?.owns(code)),
    selectMainPush: async code => { const host = ports.getMainPushHost(); if (host?.owns(code)) await host.select(code); },
    getContentContext: item => {
      if (state.mediaMatch.content !== null) {
        const media = state.mediaMatch.content, generation = ports.mediaSearch.generation(), runId = state.searchRunId;
        return { kind: "media", value: media, isCancelled: () => runId !== state.searchRunId || !ports.mediaSearch.isCurrent(generation) };
      }
      const content = state.textMatch.content ?? (isTextContentResult(item) ? state.query : null);
      if (content !== null) {
        const generation = ports.contentSearch.generation(), runId = state.searchRunId;
        return { kind: "text", value: content, accepts: ports.contentSearch.accepts(content),
          isCancelled: () => runId !== state.searchRunId || !ports.contentSearch.isCurrent(generation) };
      }
      return { kind: "none" };
    },
    captureReturnContext: index => {
      const searchRunAtSelection = state.searchRunId;
      const context = state.activePlugin === null && state.activePanel === "home" && state.query.trim()
        && state.textMatch.content === null && state.mediaMatch.content === null && state.mediaMatch.intakeKind === null
        ? createLauncherReturnContextSnapshot({ query: state.query,
          selection: ports.searchSelection(ports.getResults(), index),
          results: state.results, remoteSearchStatus: state.remoteSearchStatus, searchError: state.searchError }) : null;
      return { searchRunAtSelection, context };
    },
    captureReturnContextIfCurrent: ({ searchRunAtSelection, context }, item) => {
      captureLauncherReturnContextIfCurrent(ports.returnContext, state,
        { searchRunAtSelection, context }, item);
    },
    pinnedLauncherCommands, reconcileLauncherPins, persistLauncherPins,
  });

  const homeController = createLauncherHomeController({
    state,
    contentSearch: ports.contentSearch,
    mediaSearch: ports.mediaSearch,
    syncPinnedCommands: resultActions.syncPinnedCommands,
    aliasTargetForCode: resultActions.aliasTargetForCode,
  });

  const navigationController = createLauncherNavigationController({
    state,
    pendingPluginActivation: ports.pendingPluginActivation,
    clearReturnContext: () => ports.returnContext.clear(),
    closePromoted: async () => { await ports.getMainPushHost()?.closePromoted(); },
    returnPluginToSearch: ports.returnPluginToSearch,
    refreshFeatureCatalog: async value => { await homeController.refreshFeatureCatalog(value); },
    hasTauriRuntime: ports.hasTauriRuntime,
    resetPalette: ports.resetPalette,
    focusSearch: ports.focusSearch,
    cancelTabTarget: ports.cancelTabTarget,
    onQueryChange: ports.onQueryChange,
    activateFeature: async (code, payload, options) => { await ports.pluginSession.activateFeature(code, payload, options); },
    expectedPluginId: ports.expectedLauncherPluginId,
    rememberCommandResult: resultActions.rememberCommandResult,
    activateHistoryPayload: resultActions.activateHistoryPayload,
    launcherPinsContext: resultActions.launcherPinsContext,
    copyText: ports.copyText,
    openHideMainWindow: ports.openHideMainWindow,
    hasContentContext: () => state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null || state.textMatch.content !== null,
    clearContentContext: () => { if (state.mediaMatch.content !== null || state.mediaMatch.intakeKind !== null) ports.mediaSearch.clear(); else ports.contentSearch.clear(); },
    cancelMediaIntake: ports.cancelMediaIntake,
    advanceSearchRun: ports.advanceSearchRun,
    clearSearchContexts: ports.clearSearchContexts,
    defaultWindowHeight: ports.defaultWindowHeight,
    expandPalette: ports.expandPalette,
    normalizePluginMarketRequest,
  });

  const searchController = createLauncherSearchController({
    state,
    tabTargetController: ports.tabTargetController,
    mediaPaste: ports.mediaPaste,
    mediaSearch: ports.mediaSearch,
    contentSearch: ports.contentSearch,
    localResultsForQuery: query => homeController.localResultsForQuery(query),
    syncLauncherSearchPresentation: ports.syncLauncherSearchPresentation,
    hasTauriRuntime: ports.hasTauriRuntime,
    focusSearch: ports.focusSearch,
    resetPalette: ports.resetPalette,
    isHomeSearch: () => state.activePlugin === null && state.activePanel === "home",
    clearAutoClearTimer: ports.clearAutoClearTimer,
    pendingPluginActivation: ports.pendingPluginActivation,
  });

  return { resultActions, homeController, navigationController, searchController };
}
