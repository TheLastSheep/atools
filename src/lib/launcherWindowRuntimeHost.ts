import type { DesktopSmokeDeepReadFilesActivation } from "./desktopSmokeDeepReadFilesActivationPort";
import { createLauncherDesktopSmokeHost } from "./launcherDesktopSmokeHost";
import { createLauncherPluginWindowController } from "./launcherPluginWindowController";
import { createLauncherRuntimeLifecycle } from "./launcherRuntimeLifecycle";
import { subscribeLauncherDirectPluginLaunch } from "./launcherDirectPluginLaunch";
import { loadSearchPinyinEngine } from "./pinyinSearch";
import { applyAToolsAppearance } from "./settings";
import type { LauncherControllerState } from "./launcherControllerHost";
import type { createLauncherPluginSessionController } from "./launcherPluginSessionController";
import type { createLauncherInteractionRuntime } from "./launcherInteractionRuntime";
import type { createLauncherContentIntakeController } from "./launcherContentIntakeController";
import type { createLauncherAuxiliaryWindowController } from "./launcherAuxiliaryWindowController";
import type { createPluginCodeLifecycle } from "./pluginCodeLifecycle";
import type { createLauncherTabTargetController } from "./launcherTabTargetController";
import type { createLauncherPluginDetachBridge } from "./launcherPluginDetachContract";

type PluginSession = ReturnType<typeof createLauncherPluginSessionController>;
type Interaction = ReturnType<typeof createLauncherInteractionRuntime>;
type Intake = ReturnType<typeof createLauncherContentIntakeController>;
type Auxiliary = ReturnType<typeof createLauncherAuxiliaryWindowController>;
type Lifecycle = ReturnType<typeof createPluginCodeLifecycle>;
type TabTarget = ReturnType<typeof createLauncherTabTargetController>;
type PluginDetach = ReturnType<typeof createLauncherPluginDetachBridge>;
interface Ports {
  state: LauncherControllerState;
  routes: {
    isPasteboardShelfWindow: boolean;
    isPasteboardDialogWindow: boolean;
    isFloatingBallWindow: boolean;
    isSuperPanelWindow: boolean;
    isPluginDetachWindow: boolean;
    isMainWindow: boolean;
  };
  backgroundServices: () => boolean;
  pluginCodeLifecycle: Lifecycle;
  pluginSession: PluginSession;
  interactionRuntime: Interaction;
  intakeController: Intake;
  auxiliaryWindowController: Auxiliary;
  tabTargetController: Pick<TabTarget, "cancel">;
  hasTauriRuntime: () => boolean;
  waitForTauriRuntime: () => Promise<boolean>;
  sleep: (ms: number) => Promise<unknown>;
  resizePalette: (height: number) => Promise<void>;
  returnPluginToSearch: () => Promise<void>;
  openSettingsMenu: (menu: "general") => Promise<void>;
  resizeCurrentPalette: () => Promise<void>;
  onReturnToSearch: () => Promise<void>;
  pluginDetach: PluginDetach;
  onDesktopSmokeFilesActivationReady?: (activate: DesktopSmokeDeepReadFilesActivation) => void;
}

/** Owns per-window plugin mounting, desktop smoke gating, startup listeners, and teardown. */
export function createLauncherWindowRuntimeHost(ports: Ports) {
  const smoke = createLauncherDesktopSmokeHost({
    state: ports.state,
    hasTauriRuntime: ports.hasTauriRuntime,
    waitForTauriRuntime: ports.waitForTauriRuntime,
    sleep: ports.sleep,
    activateFeature: (code, payload, options) => ports.pluginSession.activateFeature(code, payload, options),
    resizePalette: ports.resizePalette,
    returnPluginToSearch: ports.returnPluginToSearch,
    openSettingsMenu: ports.openSettingsMenu,
    onPanelChange: async panel => { await ports.interactionRuntime.navigationController.onPanelChange(panel); },
    onDesktopSmokeFilesActivationReady: ports.onDesktopSmokeFilesActivationReady,
  });
  const pluginWindow = createLauncherPluginWindowController({
    isDetachWindow: ports.routes.isPluginDetachWindow,
    hasTauriRuntime: ports.hasTauriRuntime,
    activePlugin: () => ports.state.activePlugin,
    setActivePlugin: value => { ports.state.activePlugin = value; },
    setActivationError: value => { ports.state.pluginActivationError = value; },
    clearActivationError: () => { ports.state.pluginActivationError = ""; },
    lifecycle: ports.pluginCodeLifecycle,
    onReturnToSearch: ports.onReturnToSearch,
    openPluginDetachAction: ports.pluginDetach.openPluginDetachAction,
    claimPluginDetachAction: ports.pluginDetach.claimPluginDetachAction,
    resizePalette: ports.resizePalette,
    activateFeature: (code, payload, options) => ports.pluginSession.activateFeature(code, payload, options),
    onEscape: () => ports.interactionRuntime.navigationController.onEscape(),
    onSettingsRedirect: ports.interactionRuntime.navigationController.handlePluginSettingsRedirect,
    onReady: ports.pluginSession.handlePluginReady,
    onLoadError: error => ports.pluginSession.cancelPluginActivationWaiter(error),
    desktopSmokeEnabled: smoke.enabled,
    smokeActions: () => ports.state.desktopSmokePluginActions,
    smokeIndex: () => ports.state.desktopSmokePluginIndex,
    smokeExternalPlan: smoke.desktopSmokeActionExternalPlan,
    onSmokeRender: smoke.handleDesktopSmokePluginPanelRender,
  });
  const lifecycle = createLauncherRuntimeLifecycle({
    ...ports.routes,
    backgroundServices: ports.backgroundServices,
    activePlugin: () => ports.state.activePlugin,
    settings: () => ports.state.appSettings,
    setSettings: value => { ports.state.appSettings = value; },
    applyAppearance: applyAToolsAppearance,
    onPluginDetach: () => { void pluginWindow.onPluginDetachAction(); },
    refreshSuperPanelClipboard: ports.auxiliaryWindowController.refreshSuperPanelClipboard,
    initializeDetachedPluginWindow: pluginWindow.initializeDetachedPluginWindow,
    runReleaseSmokeSequence: () => { smoke.runReleaseSmokeSequence(); },
    loadSearchPinyinEngine,
    query: () => ports.state.query,
    onQueryChange: query => ports.interactionRuntime.searchController.onQueryChange(query),
    disposeSearch: () => ports.interactionRuntime.searchController.dispose(),
    resetPalette: ports.resizeCurrentPalette,
    hasTauriRuntime: ports.hasTauriRuntime,
    refreshFeatureCatalog: async force => { await ports.interactionRuntime.homeController.refreshFeatureCatalog(force); },
    cancelTabTarget: () => ports.tabTargetController.cancel(),
    localLaunchEntries: () => ports.state.localLaunchEntries,
    setLocalLaunchEntries: value => { ports.state.localLaunchEntries = value; },
    webQuickOpenEntries: () => ports.state.webQuickOpenEntries,
    setWebQuickOpenEntries: value => { ports.state.webQuickOpenEntries = value; },
    commandHistory: () => ports.state.commandHistory,
    setCommandHistory: value => { ports.state.commandHistory = value; },
    commandAliases: () => ports.state.commandAliases,
    setCommandAliases: value => { ports.state.commandAliases = value; },
    setPinnedCommandCodes: value => { ports.state.pinnedCommandCodes = value; },
    syncPinnedCommands: () => ports.interactionRuntime.resultActions.syncPinnedCommands(),
    activateFeature: (code, options) => ports.pluginSession.activateFeature(code, null, options),
    clearAutoClearTimer: () => ports.intakeController.clearAutoClearTimer(),
    clearFeatureCatalogRetry: () => ports.interactionRuntime.homeController.clearFeatureCatalogRetry(),
    advanceFeatureCatalogRun: () => { ports.state.featureCatalogRunId += 1; },
    startClipboardPolling: () => ports.intakeController.startClipboardPolling(),
    stopClipboardPolling: () => ports.intakeController.stopClipboardPolling(),
    maybeAutoPasteClipboard: () => ports.intakeController.maybeAutoPasteClipboard(),
    subscribeDirectLaunch: subscribeLauncherDirectPluginLaunch,
    desktopPluginPanelSmokeEnabled: smoke.enabled,
    activateDesktopSmokePluginPanel: () => { void smoke.activateDesktopSmokePluginPanel(); },
  });
  return { smoke, pluginWindow, lifecycle };
}
