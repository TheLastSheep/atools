import {
  adapterDisposedError,
  assertRendererCallback,
  invalidRendererArgument,
  invalidRendererResponse,
  unsupported,
} from "./errors";
import { createMainFileDrop } from "./mainFileDrop";
import { createRendererCommandChangeEvents } from "./commandInvalidationEvents";
import { withRendererStartupPreferences } from "./startupPreferenceEvents";
import { createRendererAppCatalog } from "./appCatalog";
import { createRendererAppSearchCatalog } from "./appSearch";
import { createRendererAppLaunchTargets } from "./appLaunchTargets";
import { createRendererAppState } from "./appState";
import { createRendererContextMenu } from "./contextMenu";
import { createRendererClipboardReader } from "./clipboardContext";
import { createRendererFocusEvents } from "./focusEvents";
import { createRendererImageAnalyzer } from "./imageAnalysis";
import {
  createRendererGeneralPreferenceEvents,
  RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS,
  type RendererGeneralPreferenceCallbacks,
} from "./generalPreferenceEvents";
import {
  INACTIVE_EVENTS,
  METHOD_CAPABILITY_STATES,
  METHOD_NOTES,
  type MethodCapabilityCode,
} from "./hostEventCatalog";
import { createRendererNullEventSubscriptions } from "./eventSubscriptions";
import { createRendererPluginCatalog } from "./pluginCatalog";
import { createRendererSettingsSnapshot } from "./settingsSnapshot";
import { createSettingsGenerations } from "./settingsGenerations";
import { RENDERER_SETTINGS_INPUT_CALLBACKS, type RendererSettingsInputCallbacks } from "./settingsInput";
import {
  createRendererSettingsViewClient,
  RENDERER_SETTINGS_VIEW_CALLBACKS,
  type RendererSettingsViewCallbacks,
} from "./settingsViewClient";
import { createStartupReadModel, serializeSearchPreferenceForWrite } from "./startupReadModel";
import { createTauriTransport } from "./tauriTransport";
import { createRendererWindowNotifications } from "./windowNotifications";
import { createRendererWindowDrag } from "./windowDrag";
import { createRendererUpdaterClient } from "./updaterClient";
import { createRendererRecommendationPinWriter } from "./recommendationPins";
import { createRendererLocalShortcutEvents } from "./localShortcuts";
import type {
  AdapterCapabilityState,
  RendererHostCommand,
  RendererHostUnlisten,
  ZToolsRendererHostAdapter,
  ZToolsRendererPlugin,
  ZToolsRendererTransport,
  ZToolsRendererWindow,
} from "./types";

export interface ZToolsRendererAdapterOptions {
  transport?: ZToolsRendererTransport;
  platformProvider?: () => string;
}

export function createZtoolsRendererHostAdapter(
  options: ZToolsRendererAdapterOptions,
): ZToolsRendererHostAdapter {
  const transport = options.transport ?? createTauriTransport();
  let disposed = false;
  const imageAnalyzer = createRendererImageAnalyzer();
  const focusEvents = createRendererFocusEvents(transport);
  let appLaunchedInvalidPayloads = 0;
  const appLaunchedEvents = createRendererNullEventSubscriptions(
    transport,
    "atools://renderer-app-launched",
    () => { appLaunchedInvalidPayloads += 1; },
  );
  const generalPreferenceEvents = createRendererGeneralPreferenceEvents(transport);
  const settingsGenerations = createSettingsGenerations();
  let invalidateLocalShortcuts: () => void = () => undefined;
  const localShortcutEvents = createRendererLocalShortcutEvents(
    transport,
    () => invalidateLocalShortcuts(),
    ensureActive,
  );
  const settingsSnapshot = createRendererSettingsSnapshot(
    async () => {
      const localListenerReady = await localShortcutEvents.ready();
      if (!localListenerReady) {
        throw invalidRendererResponse("Local shortcuts listener is unavailable before startup settings reads.");
      }
      const listenerReady = await generalPreferenceEvents.ready();
      if (!listenerReady) {
        throw invalidRendererResponse("General settings listener is unavailable for startup reads.");
      }
      return invoke("get_ztools_renderer_settings");
    },
    settingsGenerations,
  );
  const nativeCalls: Partial<Record<RendererHostCommand, number>> = {};
  const unsupportedMethods = new Set<string>();
  const unavailableMethods = new Set<string>();
  const inactiveEvents = new Set<string>();
  const waiters = new Set<(error: Error) => void>();
  let outstandingNativeCalls = 0;
  const mainFileDrop = createMainFileDrop(transport, (command, args) => transport.invoke(command, args));
  const windowNotifications = createRendererWindowNotifications(invoke, () => disposed, mainFileDrop.pauseForHide);
  const windowDrag = createRendererWindowDrag((request) => invoke("renderer_window_drag", { request }));
  const settingsView = createRendererSettingsViewClient({ invoke, transport, onLifecycleChanged: mainFileDrop.settingsBlocked });
  const updater = createRendererUpdaterClient(transport, (args) => invoke("renderer_updater_main", args));
  const clipboardReader = createRendererClipboardReader(
    (args) => invoke("get_renderer_last_copied_content", args),
    ensureActive,
  );
  const generalPreferenceApi = Object.fromEntries(RENDERER_GENERAL_PREFERENCE_NOTIFICATIONS.map(([, name]) => [
    name,
    (callback: unknown) => generalPreferenceEvents.subscribe(name, callback as RendererGeneralPreferenceCallbacks[typeof name]),
  ]));

  function ensureActive(): void {
    if (disposed) throw adapterDisposedError();
  }

  function settleBeforeDispose<T>(start: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const finish = (complete: () => void) => {
        waiters.delete(cancel);
        complete();
      };
      const cancel = (error: Error) => finish(() => reject(error));
      waiters.add(cancel);
      try {
        start().then(
          (value) => finish(() => resolve(value)),
          (error) => finish(() => reject(error)),
        );
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }

  function invoke(command: RendererHostCommand, args?: Record<string, unknown>): Promise<unknown> {
    try {
      ensureActive();
    } catch (error) {
      return Promise.reject(error);
    }
    nativeCalls[command] = (nativeCalls[command] ?? 0) + 1;
    outstandingNativeCalls += 1;
    const raw = Promise.resolve().then(() => {
      ensureActive();
      return transport.invoke(command, args);
    });
    const counted = raw.then(
      (value) => {
        outstandingNativeCalls = Math.max(0, outstandingNativeCalls - 1);
        return value;
      },
      (error) => {
        outstandingNativeCalls = Math.max(0, outstandingNativeCalls - 1);
        throw error;
      },
    );
    return settleBeforeDispose(() => counted);
  }

  function rejectUnsupported<T = never>(method: string): Promise<T> {
    unsupportedMethods.add(method);
    return Promise.reject(unsupported(method));
  }

  const readModel = withRendererStartupPreferences(createStartupReadModel(
    (key) => settingsSnapshot.read(key),
    (method) => rejectUnsupported(method),
    settingsGenerations,
  ), generalPreferenceEvents);
  invalidateLocalShortcuts = readModel.invalidateLocalShortcuts;
  const recommendationPins = createRendererRecommendationPinWriter({
    readBaseline: () => readModel.getRecommendationPinState(),
    saveNative: (expected, value) => invoke("save_renderer_recommendation_pins", { expected, value }),
    accept: readModel.acceptWrittenRecommendationPins,
    isDisposed: () => disposed,
  });
  const commandChanges = createRendererCommandChangeEvents(
    transport,
    readModel.invalidateCommandAliases,
    readModel.invalidateDisabledCommands,
    ensureActive,
  );
  const { aliases: commandAliasEvents, disabledCommands: disabledCommandsEvents, api: commandChangeEventApi } = commandChanges;
  const appState = createRendererAppState({
    transport,
    mutate: (request) => invoke("mutate_renderer_app_state", { request }),
    launch: (target) => invoke("launch_renderer_app", { target }),
    applyValues: readModel.acceptAppState,
  });
  const contextMenu = createRendererContextMenu({
    transport,
    show: (items) => invoke("show_renderer_context_menu", { items }),
  });
  const appCatalog = createRendererAppSearchCatalog({
    catalog: createRendererAppCatalog({ transport, loadApps: () => invoke("list_launcher_apps") }),
    readSettings: () => readModel.dbGet("settings-general"),
    preferences: generalPreferenceEvents,
  });
  const appLaunchTargets = createRendererAppLaunchTargets({
    resolveApp: appCatalog.resolve,
    getLocalShortcuts: readModel.getLocalShortcuts,
    launch: async (target) => {
      if (appLaunchedEvents.snapshot().subscribers > 0) {
        const ready = await settleBeforeDispose(appLaunchedEvents.ready);
        ensureActive();
        if (!ready) throw invalidRendererResponse("The app-launched listener is not ready for a launch.");
      }
      return appState.launchApp(target);
    },
    openAppShortcuts: (app) => invoke("open_renderer_app_shortcuts", { app }), revealApp: (path) => invoke("call_agent_tool", {
      name: "open_or_reveal_path",
      arguments: { path, reveal: true },
      clientId: "atools-ui",
      confirmed: true,
    }),
    revealLocal: (target) => invoke("reveal_renderer_target", { target }),
    rejectUnsupported,
    ensureActive,
  });
  const pluginCatalog = createRendererPluginCatalog({
    transport,
    loadPlugins: () => invoke("list_plugins"),
    settleBeforeDispose,
  });
  function inactiveEvent(method: string, callback: unknown): RendererHostUnlisten {
    ensureActive();
    if (typeof callback !== "function") {
      throw invalidRendererArgument(`Expected a callback for ${method}`);
    }
    inactiveEvents.add(method);
    return () => undefined;
  }
  async function getAllPlugins(): Promise<ZToolsRendererPlugin[]> {
    return pluginCatalog.getAllPlugins();
  }
  function platform(): string {
    if (options.platformProvider) return options.platformProvider();
    const nav = typeof navigator === "undefined" ? undefined : navigator;
    const platformText = `${nav?.platform ?? ""} ${nav?.userAgent ?? ""}`.toLowerCase();
    if (/mac|darwin/.test(platformText)) return "darwin";
    if (/win|windows/.test(platformText)) return "win32";
    if (/linux|x11/.test(platformText)) return "linux";
    return "unknown";
  }

  const methodCatalog: Record<string, readonly [MethodCapabilityCode, unknown]> = {
    onNativeMainFileDrop: [1, mainFileDrop.bind],
    getApps: [0, appCatalog.getApps],
    getAllPlugins: [0, getAllPlugins],
    getDisabledPlugins: [0, pluginCatalog.getDisabledPlugins],
    dbGet: [1, readModel.dbGet],
    dbPut: [1, async (key: string, value: unknown): Promise<void> => {
      ensureActive();
      if (key === "pinned-commands" && Array.isArray(value) && value.length === 0) {
        return appState.clearPins();
      }
      if (key === "recommendation-pinned") return recommendationPins.save(value);
      if (key !== "search-preference") return rejectUnsupported(`dbPut(${key})`);
      const write = serializeSearchPreferenceForWrite(value);
      await invoke("set_setting", {
        key: "ztools-renderer:search-preference",
        value: write.serialized,
      });
      if (!disposed) readModel.acceptWrittenSearchPreference(write.value);
    }],
    getPlatform: [0, platform],
    isWindows: [0, (): boolean => platform() === "win32"],
    getSystemSettings: [2, (): Promise<never[]> => rejectUnsupported("getSystemSettings()")],
    getLastCopiedContent: [1, clipboardReader],
    getSuperPanelPinned: [3, readModel.getSuperPanelPinned],
    getUsageStats: [3, readModel.getUsageStats],
    analyzeImage: [4, (imagePath: string) => {
      try {
        ensureActive();
      } catch (error) {
        return Promise.reject(error);
      }
      return imageAnalyzer.analyze(imagePath);
    }],
    localShortcuts: [3, { getAll: readModel.getLocalShortcuts }],
    updateLaunchContext: [4, readModel.updateLaunchContext],
    getWindowMaterial: [2, undefined],
    updater: [1, {
      getDownloadStatus: updater.getDownloadStatus,
      checkUpdate: updater.checkUpdate,
      showUpdateWindow: updater.showUpdateWindow,
    }],
    launch: [1, appLaunchTargets.launch],
    revealInFinder: [1, appLaunchTargets.revealInFinder],
    showContextMenu: [1, contextMenu.showContextMenu],
    pinApp: [1, appState.pinApp],
    unpinApp: [1, appState.unpinApp],
    removeFromHistory: [1, appState.removeFromHistory],
    updatePinnedOrder: [1, appState.updatePinnedOrder],
    resizeWindow: [0, windowNotifications.resizeWindow],
    resetWindow: [0, (): Promise<unknown> => invoke("reset_window")],
    hideWindow: [0, windowNotifications.hideWindow],
    getWindowPosition: [1, windowDrag.getWindowPosition],
    setWindowPosition: [1, windowDrag.setWindowPosition],
    setWindowSizeLock: [1, windowDrag.setWindowSizeLock],
    openSettings: [1, (): void => settingsView.open()],
    hidePlugin: [1, (): void => settingsView.close("main-hide")],
    notifySubInputChange: [1, settingsView.notifySubInputChange],
  };
  const methodApi: Record<string, unknown> = {};
  const methodCapabilities: Record<string, AdapterCapabilityState> = {};
  for (const [name, [state, implementation]] of Object.entries(methodCatalog)) {
    if (typeof implementation === "object" && implementation !== null) {
      methodApi[name] = implementation;
      for (const nestedName of Object.keys(implementation)) {
        methodCapabilities[`${name}.${nestedName}`] = METHOD_CAPABILITY_STATES[state];
      }
    } else {
      methodCapabilities[name] = METHOD_CAPABILITY_STATES[state];
      if (implementation !== undefined) methodApi[name] = implementation;
    }
  }
  const focusEventApi = {
    onFocusSearch: (callback: () => unknown): RendererHostUnlisten => {
      ensureActive();
      assertRendererCallback(callback);
      return focusEvents.subscribe(() => { mainFileDrop.onFocus(); return callback(); });
    },
  };
  const appLaunchedApi = {
    onAppLaunched: (callback: unknown): RendererHostUnlisten => {
      ensureActive();
      assertRendererCallback(callback);
      return appLaunchedEvents.subscribe(() => (callback as () => unknown)());
    },
  };
  const settingsViewApi = Object.fromEntries(RENDERER_SETTINGS_VIEW_CALLBACKS.map((name) => [
    name,
    (callback: unknown) => settingsView.subscribe(name, callback as RendererSettingsViewCallbacks[typeof name]),
  ]));
  const settingsInputEventApi = Object.fromEntries(RENDERER_SETTINGS_INPUT_CALLBACKS.map((name) => [
    name,
    (callback: unknown) => settingsView.subscribeInput(name, callback as RendererSettingsInputCallbacks[typeof name]),
  ]));
  const appEventApi = {
    onAppsChanged: appCatalog.onAppsChanged,
    onPluginsChanged: pluginCatalog.onPluginsChanged,
    onHistoryChanged: appState.onHistoryChanged,
    onPinnedChanged: appState.onPinnedChanged,
    onLocalShortcutsChanged: localShortcutEvents.subscribe,
    onContextMenuCommand: contextMenu.subscribe,
  };
  const activeEventNames = [
    "onUpdateAvailable", "onUpdateDownloadStart", "onUpdateDownloadFailed",
    ...Object.keys(focusEventApi),
    ...Object.keys(appLaunchedApi),
    ...Object.keys(settingsViewApi),
    ...Object.keys(settingsInputEventApi),
    ...Object.keys(generalPreferenceApi),
    ...Object.keys(appEventApi),
    ...Object.keys(commandChangeEventApi),
  ];
  const api = {
    onUpdateAvailable: (cb: unknown) => updater.subscribe("onUpdateAvailable", cb),
    onUpdateDownloadStart: (cb: unknown) => updater.subscribe("onUpdateDownloadStart", cb),
    onUpdateDownloadFailed: (cb: unknown) => updater.subscribe("onUpdateDownloadFailed", cb),
    ...focusEventApi,
    ...appLaunchedApi,
    ...methodApi,
    ...settingsViewApi,
    ...settingsInputEventApi,
    ...generalPreferenceApi,
    ...appEventApi,
    ...commandChangeEventApi,
  };
  const apiProxy = new Proxy(api, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      if (typeof property === "symbol") return Reflect.get(target, property, receiver);
      if (property === "getWindowMaterial") {
        unavailableMethods.add("getWindowMaterial");
        return undefined;
      }
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      return unsupportedNamespace(String(property), unsupportedMethods);
    },
  });
  const adapter: ZToolsRendererHostAdapter = {
    api: apiProxy as unknown as ZToolsRendererHostAdapter["api"],
    capabilities() {
      return {
        methods: { ...methodCapabilities },
        methodNotes: { ...METHOD_NOTES },
        events: Object.fromEntries([
          ...INACTIVE_EVENTS.map((event) => [event, "inactive"] as const),
          ...activeEventNames.map((event) => [event, "limited"] as const),
        ]),
      };
    },
    snapshot() {
      return {
        disposed,
        outstandingNativeCalls,
        nativeCalls: { ...nativeCalls },
        unsupportedMethods: [...unsupportedMethods].sort(),
        unavailableMethods: [...unavailableMethods].sort(),
        inactiveEvents: [...inactiveEvents].sort(),
        ...readModel.snapshot(),
        imageAnalysis: imageAnalyzer.snapshot(),
        focusEvents: focusEvents.snapshot(),
        settingsSnapshot: settingsSnapshot.snapshot(),
        windowNotifications: windowNotifications.snapshot(),
        windowDrag: windowDrag.snapshot(),
        appState: appState.snapshot(),
        appCatalog: appCatalog.snapshot(),
        pluginCatalog: pluginCatalog.snapshot(),
        appLaunched: { invalidPayloads: appLaunchedInvalidPayloads, eventSource: appLaunchedEvents.snapshot() },
        contextMenu: contextMenu.snapshot(),
        settingsView: settingsView.snapshot(),
        generalPreferenceEvents: generalPreferenceEvents.snapshot(),
        commandAliasEvents: commandAliasEvents.snapshot(),
        disabledCommandsEvents: disabledCommandsEvents.snapshot(),
        localShortcutEvents: localShortcutEvents.snapshot(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      updater.dispose();
      recommendationPins.dispose();
      const error = adapterDisposedError();
      mainFileDrop.dispose();
      windowDrag.dispose();
      for (const cancel of [...waiters]) cancel(error);
      readModel.dispose();
      imageAnalyzer.dispose();
      focusEvents.dispose();
      appLaunchedEvents.dispose();
      localShortcutEvents.dispose();
      settingsSnapshot.dispose();
      appCatalog.dispose();
      pluginCatalog.dispose();
      appState.dispose();
      contextMenu.dispose();
      settingsView.dispose();
      generalPreferenceEvents.dispose();
      commandChanges.dispose();
    },
  };
  for (const event of INACTIVE_EVENTS) {
    if (event in api) continue;
    (api as Record<string, unknown>)[event] = (callback: unknown): RendererHostUnlisten =>
      inactiveEvent(event, callback);
  }
  return adapter;
}

function unsupportedNamespace(
  root: string,
  unsupportedMethods: Set<string>,
  path = root,
): unknown {
  const callable = function () {
    unsupportedMethods.add(path);
    throw unsupported(path);
  };
  return new Proxy(callable, {
    get(target, property, receiver) {
      if (property === "then") return undefined;
      if (property === "name") return path;
      if (typeof property === "symbol") return Reflect.get(target, property, receiver);
      return unsupportedNamespace(root, unsupportedMethods, `${path}.${String(property)}`);
    },
  });
}

export function bootstrapZtoolsRendererHostAdapter(
  target?: ZToolsRendererWindow,
): ZToolsRendererHostAdapter {
  const host = target ?? (typeof window === "undefined" ? undefined : window as unknown as ZToolsRendererWindow);
  if (!host) throw new Error("No browser window is available for the ZTools renderer adapter");
  if (host.__ATOOLS_ZTOOLS_HOST_ADAPTER__) return host.__ATOOLS_ZTOOLS_HOST_ADAPTER__;
  const adapter = createZtoolsRendererHostAdapter({
    transport: host.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__,
  });
  host.ztools = adapter.api;
  host.__ATOOLS_ZTOOLS_HOST_ADAPTER__ = adapter;
  const onPageHide = () => adapter.dispose();
  const dispose = adapter.dispose.bind(adapter);
  adapter.dispose = () => {
    host.removeEventListener?.("pagehide", onPageHide);
    dispose();
  };
  host.addEventListener?.("pagehide", onPageHide, { once: true });
  return adapter;
}

if (typeof window !== "undefined" && document.getElementById("app")) {
  bootstrapZtoolsRendererHostAdapter(window as unknown as ZToolsRendererWindow);
}
