import { createLauncherAuxiliaryWindowController } from "./launcherAuxiliaryWindowController";
import { createLauncherContentIntakeController } from "./launcherContentIntakeController";
import { createLauncherExternalActionsController } from "./launcherExternalActionsController";
import { createLauncherInteractionRuntime } from "./launcherInteractionRuntime";
import { createLauncherPluginSessionController } from "./launcherPluginSessionController";
import type { createLauncherContentSearch } from "./launcherContentSearch";
import type { createLauncherMediaSearch } from "./launcherMediaSearch";
import type { createLauncherMediaPaste } from "./launcherMediaPaste";
import type { createLauncherTabTargetController } from "./launcherTabTargetController";
import { createPluginCodeLifecycle } from "./pluginCodeLifecycle";
import { createLauncherReturnContextStore, createLauncherReturnCoordinator } from "./launcherReturnContext";
import { createLauncherPendingPluginActivationStore } from "./launcherPendingPluginActivation.svelte";
import type { createLauncherPluginDetachBridge } from "./launcherPluginDetachContract";
import { resolveSearchSelection } from "./launcherSearch";
import type { LauncherInteractionState } from "./launcherInteractionRuntime";
import type { LauncherSystemDestination } from "./launcherSystemSearchActions";
import type { SearchResult } from "./types";

type IntakeState = Parameters<typeof createLauncherContentIntakeController>[0]["state"];
type SessionState = Parameters<typeof createLauncherPluginSessionController>[0]["state"];
export type LauncherControllerState = LauncherInteractionState & IntakeState & SessionState & {
  desktopSmokePluginActions: import("./types").FeatureAction[];
  desktopSmokePluginIndex: number;
  featureCatalogRunId: number;
};
type InteractionPorts = Parameters<typeof createLauncherInteractionRuntime>[0];
type ContentSearch = ReturnType<typeof createLauncherContentSearch>;
type MediaSearch = ReturnType<typeof createLauncherMediaSearch>;
type MediaPaste = ReturnType<typeof createLauncherMediaPaste>;
type TabTarget = ReturnType<typeof createLauncherTabTargetController>;
type LifecycleOptions = Parameters<typeof createPluginCodeLifecycle>[0];

interface Ports {
  state: LauncherControllerState;
  tabTargetController: Pick<TabTarget, "cancel">;
  mediaSearch: MediaSearch;
  contentSearch: ContentSearch;
  mediaPaste: MediaPaste;
  pluginLifecycle: LifecycleOptions;
  hasTauriRuntime: () => boolean;
  readClipboardText: () => Promise<string>;
  refreshPermissionPrompt: () => Promise<void>;
  clipboardText: () => string;
  setClipboardText: (value: string) => void;
  setClipboardStatus: (value: string) => void;
  focusSearch: () => void;
  resetPalette: () => Promise<void>;
  returnPluginToSearch: () => Promise<void>;
  onQueryChange: (query: string) => Promise<void>;
  cancelActivation: () => void;
  getLauncherResults: () => SearchResult[];
  closePromoted: () => Promise<unknown> | unknown;
  onReturnRefreshError: (error: unknown) => void;
  activateSystemDestination: (destination: LauncherSystemDestination) => Promise<void>;
  getMainPushHost: InteractionPorts["getMainPushHost"];
  searchSelection: InteractionPorts["searchSelection"];
  clearSearchContexts: () => void;
  advanceSearchRun: () => void;
  defaultWindowHeight: () => number;
  expandPalette: InteractionPorts["expandPalette"];
  tabTargetControllerForSearch: InteractionPorts["tabTargetController"];
  mediaPasteForSearch: InteractionPorts["mediaPaste"];
  cancelTabTarget: () => void;
  openHideMainWindow: () => Promise<void>;
  pluginDetach: Pick<ReturnType<typeof createLauncherPluginDetachBridge>, "isPluginDetachWindow" | "openPluginDetachAction">;
  syncLauncherSearchPresentation: () => void;
  getResults: () => SearchResult[];
  cancelMediaIntake: () => void;
}

/** Composes this App instance's content, action, session, and search controllers. */
export function createLauncherControllerHost(ports: Ports) {
  let setSearchControllerVisible: (visible: boolean) => Promise<void> = async () => {};
  const pluginCodeLifecycle = createPluginCodeLifecycle(ports.pluginLifecycle);
  const launcherReturnContext = createLauncherReturnContextStore();
  const pendingPluginActivation = createLauncherPendingPluginActivationStore();
  const launcherReturnCoordinator = createLauncherReturnCoordinator(launcherReturnContext, {
    getActivePlugin: () => ports.state.activePlugin,
    getActivePanel: () => ports.state.activePanel,
    getQuery: () => ports.state.query,
    getSearchRunId: () => ports.state.searchRunId,
    closePromoted: ports.closePromoted,
    advanceSearchRun: () => { ports.state.searchRunId += 1; ports.clearSearchContexts(); return ports.state.searchRunId; },
    cancelActivation: () => { ports.cancelActivation(); ports.state.pluginLifecycleNotice = null; },
    captureActivation: () => pluginCodeLifecycle.captureActivation(),
    isActivationCurrent: activation => pluginCodeLifecycle.isCurrent(activation),
    enterHome: () => { ports.state.activePlugin = null; ports.state.activePanel = "home"; ports.state.pastedItems = []; },
    clearSearch: () => { ports.state.query = ""; ports.state.results = []; ports.state.selectedIndex = 0; ports.state.remoteSearchStatus = "idle"; ports.state.searchError = ""; },
    restoreSnapshot: context => {
      ports.state.query = context.query;
      ports.state.results = context.results ? [...context.results] : [];
      ports.state.remoteSearchStatus = context.remoteSearchStatus;
      ports.state.searchError = context.searchError;
      ports.state.userSearchSelection = context.selection;
      ports.state.selectedIndex = resolveSearchSelection(ports.getLauncherResults(), context.selection);
    },
    refresh: ports.onQueryChange,
    restoreSelection: selection => {
      ports.state.userSearchSelection = selection;
      ports.state.selectedIndex = resolveSearchSelection(ports.getLauncherResults(), selection);
    },
    focusSearch: ports.focusSearch,
    resize: ports.resetPalette,
    onRefreshError: ports.onReturnRefreshError,
  });
  const intakeController = createLauncherContentIntakeController({
    state: ports.state,
    tabTargetController: ports.tabTargetController,
    mediaSearch: ports.mediaSearch,
    contentSearch: ports.contentSearch,
    mediaPaste: ports.mediaPaste,
    onQueryChange: ports.onQueryChange,
    setSearchVisible: visible => setSearchControllerVisible(visible),
    focusSearch: ports.focusSearch,
    resetPalette: ports.resetPalette,
    hasTauriRuntime: ports.hasTauriRuntime,
    readClipboard: ports.readClipboardText,
  });
  const externalActions = createLauncherExternalActionsController({
    hasTauriRuntime: ports.hasTauriRuntime,
    pastedItems: () => ports.state.pastedItems,
    refreshPermissionPrompt: ports.refreshPermissionPrompt,
    scheduleAutoClearSearch: intakeController.scheduleAutoClearSearch,
    focusSearch: ports.focusSearch,
  });
  const auxiliaryWindows = createLauncherAuxiliaryWindowController({
    hasTauriRuntime: ports.hasTauriRuntime,
    readClipboardText: ports.readClipboardText,
    copyText: externalActions.copyText,
    clipboardText: ports.clipboardText,
    setClipboardText: ports.setClipboardText,
    setStatus: ports.setClipboardStatus,
  });
  const pluginSession = createLauncherPluginSessionController({
    state: ports.state,
    pluginCodeLifecycle,
    contentSearch: ports.contentSearch,
    mediaSearch: ports.mediaSearch,
    returnCoordinator: launcherReturnCoordinator,
    returnContext: launcherReturnContext,
    isDetachWindow: ports.pluginDetach.isPluginDetachWindow,
    openPluginDetachAction: ports.pluginDetach.openPluginDetachAction,
    pendingPluginActivation,
    getMainPushHostInstance: ports.getMainPushHost,
    activateSystemDestination: ports.activateSystemDestination,
    openUrl: externalActions.openUrl,
    openLocalLaunchEntry: externalActions.openLocalLaunchEntry,
    openLocalAppPath: externalActions.openLocalAppPath,
    activatePastedResult: externalActions.activatePastedResult,
    activateTextQuickAction: externalActions.activateTextQuickAction,
  });
  const interactionRuntime = createLauncherInteractionRuntime({
    state: ports.state,
    pluginSession,
    pendingPluginActivation,
    contentSearch: ports.contentSearch,
    mediaSearch: ports.mediaSearch,
    returnContext: launcherReturnContext,
    focusSearch: ports.focusSearch,
    resetPalette: ports.resetPalette,
    hasTauriRuntime: ports.hasTauriRuntime,
    returnPluginToSearch: ports.returnPluginToSearch,
    onQueryChange: ports.onQueryChange,
    cancelTabTarget: ports.cancelTabTarget,
    copyText: externalActions.copyText,
    openHideMainWindow: ports.openHideMainWindow,
    expectedLauncherPluginId: pluginSession.expectedLauncherPluginId,
    scheduleAutoClearSearch: intakeController.scheduleAutoClearSearch,
    activateTextQuickAction: externalActions.activateTextQuickAction,
    activatePastedResult: externalActions.activatePastedResult,
    openLocalLaunchEntry: externalActions.openLocalLaunchEntry,
    openLocalAppPath: externalActions.openLocalAppPath,
    openUrl: externalActions.openUrl,
    syncLauncherSearchPresentation: ports.syncLauncherSearchPresentation,
    getMainPushHost: ports.getMainPushHost,
    getResults: ports.getResults,
    searchSelection: ports.searchSelection,
    cancelMediaIntake: ports.cancelMediaIntake,
    clearSearchContexts: ports.clearSearchContexts,
    advanceSearchRun: ports.advanceSearchRun,
    defaultWindowHeight: ports.defaultWindowHeight,
    expandPalette: ports.expandPalette,
    tabTargetController: ports.tabTargetControllerForSearch,
    mediaPaste: ports.mediaPasteForSearch,
    clearAutoClearTimer: intakeController.clearAutoClearTimer,
  });
  setSearchControllerVisible = interactionRuntime.searchController.setVisible;
  return { externalActions, auxiliaryWindows, intakeController, pluginSession, interactionRuntime, pluginCodeLifecycle, launcherReturnContext, launcherReturnCoordinator };
}
