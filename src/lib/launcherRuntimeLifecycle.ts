import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appUpdater } from "./appUpdater";
import { loadAToolsSettings } from "./settings";
import {
  COMMAND_HISTORY_UPDATED_EVENT, loadCommandHistory, type CommandHistoryEntry,
} from "./commandHistory";
import {
  COMMAND_ALIASES_UPDATED_EVENT, loadCommandAliases, type CommandAliasEntry,
} from "./commandAliases";
import { LOCAL_LAUNCH_UPDATED_EVENT, loadLocalLaunchEntries, type LocalLaunchEntry } from "./localLaunch";
import { WEB_QUICK_OPEN_UPDATED_EVENT, loadWebQuickOpenEntries, type WebQuickOpenEntry } from "./webQuickOpen";
import { PINNED_COMMANDS_UPDATED_EVENT, loadPinnedCommandCodes } from "./pinnedCommands";
import { DIRECT_PLUGIN_LAUNCH_EVENT, subscribeLauncherDirectPluginLaunch, runTicketedDirectLaunch } from "./launcherDirectPluginLaunch";
import { PLUGIN_OPEN_CANCELLED_EVENT, PLUGIN_OPEN_REQUESTED_EVENT, type PluginOpenRequest } from "./pluginOpen";
import type { FeatureAction } from "./types";
import type { AToolsSettings } from "./settings";

interface RuntimePorts {
  isPasteboardShelfWindow: boolean;
  isPasteboardDialogWindow: boolean;
  isFloatingBallWindow: boolean;
  isSuperPanelWindow: boolean;
  isPluginDetachWindow: boolean;
  isMainWindow: boolean;
  backgroundServices: () => boolean;
  activePlugin: () => FeatureAction | null;
  settings: () => AToolsSettings;
  setSettings: (settings: AToolsSettings) => void;
  applyAppearance: (settings: AToolsSettings) => void;
  onPluginDetach: () => void;
  refreshSuperPanelClipboard: () => Promise<void>;
  initializeDetachedPluginWindow: () => Promise<void>;
  runReleaseSmokeSequence: () => void;
  loadSearchPinyinEngine: () => Promise<boolean>;
  query: () => string;
  onQueryChange: (query: string) => Promise<void>;
  disposeSearch: () => void;
  resetPalette: () => Promise<void>;
  hasTauriRuntime: () => boolean;
  refreshFeatureCatalog: (force?: boolean) => Promise<void>;
  cancelTabTarget: () => void;
  localLaunchEntries: () => LocalLaunchEntry[];
  setLocalLaunchEntries: (entries: LocalLaunchEntry[]) => void;
  webQuickOpenEntries: () => WebQuickOpenEntry[];
  setWebQuickOpenEntries: (entries: WebQuickOpenEntry[]) => void;
  commandHistory: () => CommandHistoryEntry[];
  setCommandHistory: (entries: CommandHistoryEntry[]) => void;
  commandAliases: () => CommandAliasEntry[];
  setCommandAliases: (entries: CommandAliasEntry[]) => void;
  setPinnedCommandCodes: (codes: string[]) => void;
  syncPinnedCommands: () => void;
  activateFeature: (code: string, options: { expectedPluginId?: string; shortcutDispatchId?: string; isCancelled?: () => boolean; onOutcome?: NonNullable<PluginOpenRequest["respond"]> }) => Promise<unknown>;
  clearAutoClearTimer: () => void;
  clearFeatureCatalogRetry: () => void;
  advanceFeatureCatalogRun: () => void;
  startClipboardPolling: () => void;
  stopClipboardPolling: () => void;
  maybeAutoPasteClipboard: () => Promise<void>;
  subscribeDirectLaunch: typeof subscribeLauncherDirectPluginLaunch;
  desktopPluginPanelSmokeEnabled: () => boolean;
  activateDesktopSmokePluginPanel: () => void;
}

/** Owns startup listeners, request response fencing, and the matching teardown for one App instance. */
export function createLauncherRuntimeLifecycle(ports: RuntimePorts) {
  function start() {
    let settingsCancelled = false;
    let pinyinCancelled = false;
    const onPluginDetach = () => {
      if (ports.isPluginDetachWindow || !ports.activePlugin()) return;
      ports.onPluginDetach();
    };
    if (ports.isPasteboardShelfWindow || ports.isPasteboardDialogWindow) return () => ports.disposeSearch();
    if (ports.isFloatingBallWindow || ports.isSuperPanelWindow) {
      window.addEventListener("atools-plugin-detach", onPluginDetach);
      void loadSettingsForFloatingWindow();
      if (ports.isSuperPanelWindow) void ports.refreshSuperPanelClipboard();
      return () => {
        settingsCancelled = true; pinyinCancelled = true;
        ports.disposeSearch();
        window.removeEventListener("atools-plugin-detach", onPluginDetach);
      };
    }
    if (ports.isPluginDetachWindow) {
      window.addEventListener("atools-plugin-detach", onPluginDetach);
      void ports.initializeDetachedPluginWindow();
      return () => { ports.disposeSearch(); window.removeEventListener("atools-plugin-detach", onPluginDetach); };
    }

    if (ports.isMainWindow && ports.backgroundServices()) ports.runReleaseSmokeSequence();
    void ports.loadSearchPinyinEngine().then(loaded => {
      if (loaded && !pinyinCancelled && ports.query().trim() && ports.activePlugin() === null) void ports.onQueryChange(ports.query());
    });
    void loadSettingsForMainWindow();
    if (ports.hasTauriRuntime()) void ports.refreshFeatureCatalog();

    const onSettingsUpdated = (event: Event) => {
      const settings = (event as CustomEvent<AToolsSettings>).detail;
      if (!settings) return;
      const previous = ports.settings();
      const next = { ...previous, ...settings };
      if (next.tabKeyFunction !== previous.tabKeyFunction || next.tabTarget?.pluginId !== previous.tabTarget?.pluginId
        || next.tabTarget?.code !== previous.tabTarget?.code) ports.cancelTabTarget();
      ports.setSettings(next); ports.applyAppearance(next); void ports.maybeAutoPasteClipboard();
    };
    window.addEventListener("atools-settings-updated", onSettingsUpdated);
    const onLocalLaunchUpdated = (event: Event) => ports.setLocalLaunchEntries(
      (event as CustomEvent<LocalLaunchEntry[]>).detail ?? loadLocalLaunchEntries());
    window.addEventListener(LOCAL_LAUNCH_UPDATED_EVENT, onLocalLaunchUpdated);
    const onWebQuickOpenUpdated = (event: Event) => ports.setWebQuickOpenEntries(
      (event as CustomEvent<WebQuickOpenEntry[]>).detail ?? loadWebQuickOpenEntries());
    window.addEventListener(WEB_QUICK_OPEN_UPDATED_EVENT, onWebQuickOpenUpdated);
    const onCommandHistoryUpdated = (event: Event) => ports.setCommandHistory(
      (event as CustomEvent<CommandHistoryEntry[]>).detail ?? loadCommandHistory());
    window.addEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
    const onCommandAliasesUpdated = (event: Event) => ports.setCommandAliases(
      (event as CustomEvent<CommandAliasEntry[]>).detail ?? loadCommandAliases());
    window.addEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
    const onPinnedCommandsUpdated = (event: Event) => {
      ports.setPinnedCommandCodes((event as CustomEvent<string[]>).detail ?? loadPinnedCommandCodes());
      ports.syncPinnedCommands();
    };
    window.addEventListener(PINNED_COMMANDS_UPDATED_EVENT, onPinnedCommandsUpdated);
    const pendingPluginOpenResponses = new Set<NonNullable<PluginOpenRequest["respond"]>>();
    const cancelPluginOpenById = new Map<string, () => void>();
    const onPluginOpenCancelled = (event: Event) => {
      const requestId = (event as CustomEvent<{ requestId?: string }>).detail?.requestId;
      if (requestId) cancelPluginOpenById.get(requestId)?.();
    };
    window.addEventListener(PLUGIN_OPEN_CANCELLED_EVENT, onPluginOpenCancelled);
    const onPluginOpenRequested = (event: Event) => {
      const request = (event as CustomEvent<PluginOpenRequest>).detail;
      if (!request?.code) return;
      if (!request.requestId || !request.respond) {
        void ports.activateFeature(request.code, { expectedPluginId: request.pluginId });
        return;
      }
      event.preventDefault();
      const requestId = request.requestId;
      let replied = false;
      const respond: NonNullable<PluginOpenRequest["respond"]> = outcome => {
        if (replied) return;
        replied = true; pendingPluginOpenResponses.delete(respond); cancelPluginOpenById.delete(requestId);
        request.respond?.(outcome);
      };
      pendingPluginOpenResponses.add(respond);
      let activationCancelled = false;
      const cancelActivation = () => {
        if (activationCancelled) return;
        activationCancelled = true; cancelPluginOpenById.delete(requestId); respond({ status: "superseded" });
      };
      cancelPluginOpenById.set(requestId, cancelActivation);
      void ports.activateFeature(request.code, { expectedPluginId: request.pluginId,
        isCancelled: () => activationCancelled, onOutcome: respond }).then(() => {
        cancelPluginOpenById.delete(requestId);
        if (!replied) respond({ status: "failed", reason: "activation-failed" });
      }, () => {
        cancelPluginOpenById.delete(requestId);
        if (!replied) respond({ status: "failed", reason: "activation-failed" });
      });
    };
    window.addEventListener(PLUGIN_OPEN_REQUESTED_EVENT, onPluginOpenRequested);

    if (!ports.hasTauriRuntime()) return cleanup(false);
    if (ports.isMainWindow) void ports.resetPalette();
    let pluginUnlisten: (() => void) | undefined;
    let updateUnlisten: (() => void) | undefined;
    let builtinPluginsUnlisten: (() => void) | undefined;
    let directLaunchUnlisten: (() => void) | undefined;
    let cancelled = false;
    const stopStartupUpdateCheck = ports.backgroundServices() ? appUpdater.scheduleStartupCheck() : () => {};
    try {
      void listen<string>("plugin-event", event => console.log("Plugin event:", event.payload)).then(pluginEvent => {
        if (cancelled) pluginEvent(); else pluginUnlisten = pluginEvent;
      }).catch(error => console.warn("Plugin event listener unavailable:", error));
      if (ports.backgroundServices()) ports.startClipboardPolling();
      void listen("builtin-plugins-loaded", () => { void ports.refreshFeatureCatalog(true); }).then(stop => {
        if (cancelled) stop(); else builtinPluginsUnlisten = stop;
      }).catch(error => console.debug("Builtin plugin refresh listener unavailable:", error));
      directLaunchUnlisten = ports.subscribeDirectLaunch({
        subscribe: receive => listen(DIRECT_PLUGIN_LAUNCH_EVENT, receive),
        activate: async (request, isCancelled) => {
          if (!request.shortcutDispatchId) return ports.activateFeature(request.code, { expectedPluginId: request.pluginId, isCancelled });
          return runTicketedDirectLaunch(request, isCancelled,
            (record, cancelled) => ports.activateFeature(request.code, {
              expectedPluginId: request.pluginId, shortcutDispatchId: request.shortcutDispatchId, isCancelled: cancelled,
              onOutcome: result => record(result.status),
            }),
            async (dispatchId, outcome) => {
              try { await invoke("complete_native_shortcut_action", { dispatchId, outcome }); }
              catch (error) { console.debug("Shortcut completion unavailable:", error); }
            });
        },
        onError: error => console.debug("Direct launch plugin listener unavailable:", error),
      });
      if (ports.backgroundServices()) void appUpdater.startProgressListener().then(stop => {
        if (cancelled) stop(); else updateUnlisten = stop;
      }).catch(error => console.warn("App update progress listener unavailable:", error));
    } catch (error) { console.warn("Tauri 未启动，搜索功能不可用", error); }
    if (ports.desktopPluginPanelSmokeEnabled()) ports.activateDesktopSmokePluginPanel();
    return () => {
      settingsCancelled = true; pinyinCancelled = true;
      removeWindowListeners();
      for (const cancel of cancelPluginOpenById.values()) cancel();
      for (const respond of pendingPluginOpenResponses) respond({ status: "superseded" });
      pendingPluginOpenResponses.clear(); cancelPluginOpenById.clear();
      cleanupStartup(); cancelled = true;
      pluginUnlisten?.(); updateUnlisten?.(); builtinPluginsUnlisten?.(); directLaunchUnlisten?.();
      stopStartupUpdateCheck(); window.removeEventListener("atools-plugin-detach", onPluginDetach);
    };

    function cleanup(isWebPreview: boolean) {
      return () => {
        settingsCancelled = true; pinyinCancelled = true;
        removeWindowListeners();
        for (const cancel of cancelPluginOpenById.values()) cancel();
        for (const respond of pendingPluginOpenResponses) respond({ status: "superseded" });
        pendingPluginOpenResponses.clear(); cancelPluginOpenById.clear(); cleanupStartup();
        if (!isWebPreview) window.removeEventListener("atools-plugin-detach", onPluginDetach);
      };
    }
    function removeWindowListeners() {
      window.removeEventListener("atools-settings-updated", onSettingsUpdated);
      window.removeEventListener(LOCAL_LAUNCH_UPDATED_EVENT, onLocalLaunchUpdated);
      window.removeEventListener(WEB_QUICK_OPEN_UPDATED_EVENT, onWebQuickOpenUpdated);
      window.removeEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
      window.removeEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
      window.removeEventListener(PINNED_COMMANDS_UPDATED_EVENT, onPinnedCommandsUpdated);
      window.removeEventListener(PLUGIN_OPEN_REQUESTED_EVENT, onPluginOpenRequested);
      window.removeEventListener(PLUGIN_OPEN_CANCELLED_EVENT, onPluginOpenCancelled);
    }
    function cleanupStartup() {
      ports.disposeSearch();
      ports.clearAutoClearTimer(); ports.clearFeatureCatalogRetry(); ports.advanceFeatureCatalogRun(); ports.stopClipboardPolling();
    }
    async function loadSettingsForFloatingWindow() {
      try { const settings = await loadAToolsSettings();
        if (!settingsCancelled) { ports.setSettings(settings); ports.applyAppearance(settings); }
      } catch { /* Settings are optional in the web preview. */ }
    }
    async function loadSettingsForMainWindow() {
      try { const settings = await loadAToolsSettings();
        if (!settingsCancelled) { ports.setSettings(settings); ports.applyAppearance(settings); if (ports.isMainWindow) void ports.resetPalette(); }
      } catch { /* Settings are optional in the web preview. */ }
    }
  }
  return { start };
}
