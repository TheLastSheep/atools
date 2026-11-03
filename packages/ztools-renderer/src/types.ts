import type { MainFileDropNotice } from "./mainFileDrop";
import type { ImageAnalysisResult, ImageAnalysisSnapshot } from "./imageAnalysis";
import type { RendererFocusEventsSnapshot } from "./focusEvents";
import type { RendererSettingsSnapshotDiagnostics } from "./settingsSnapshot";
import type { RendererWindowNotificationsSnapshot } from "./windowNotifications";
import type { RendererAppStateSnapshot } from "./appState";
import type { RendererContextMenuSnapshot } from "./contextMenu";
import type { RendererGeneralPreferenceSnapshot } from "./generalPreferenceEvents";
import type { RendererGeneralPreferenceValues } from "./generalPreferenceSchema";
import type { RendererCommandAliasEventsSnapshot } from "./commandAliasEvents";
import type { RendererCommandInvalidationEventsSnapshot } from "./commandInvalidationEvents";
import type { RendererSettingsViewSnapshot, RendererSettingsViewPlugin } from "./settingsViewClient";
import type { RendererEventSubscriptionsSnapshot } from "./eventSubscriptions";
import type { RendererPluginCatalogSnapshot } from "./pluginCatalog";
import type { RendererWindowDragSnapshot, RendererWindowPosition } from "./windowDrag";
import type { RendererLastCopiedContent } from "./clipboardContext";
import type { RendererLocalShortcut, RendererLocalShortcutEventsSnapshot } from "./localShortcuts";

export interface RendererAppCatalogSnapshot {
  cachedApps: number;
  readPending: boolean;
  invalidations: number;
  eventSource: RendererEventSubscriptionsSnapshot;
}

export interface RendererAppLaunchedSnapshot {
  invalidPayloads: number;
  eventSource: RendererEventSubscriptionsSnapshot;
}

export type RendererHostCommand =
  | "set_renderer_main_drop_target"
  | "list_launcher_apps"
  | "list_plugins"
  | "get_ztools_renderer_settings"
  | "set_setting"
  | "save_renderer_recommendation_pins"
  | "call_agent_tool"
  | "launch_renderer_app"
  | "open_renderer_app_shortcuts"
  | "reveal_renderer_target"
  | "mutate_renderer_app_state"
  | "show_renderer_context_menu"
  | "renderer_window_drag"
  | "expand_window"
  | "reset_window"
  | "hide_main_window"
  | "open_renderer_settings"
  | "close_renderer_settings"
  | "notify_renderer_settings_input"
  | "get_renderer_last_copied_content"
  | "get_app_update_status"
  | "renderer_updater_main";

export type RendererHostArguments = Record<string, unknown> | undefined;
export type RendererHostListener = (payload: unknown) => void;
export type RendererHostUnlisten = () => void;

/** The only native seam used by this renderer slice. It is injectable in fixtures. */
export interface ZToolsRendererTransport {
  invoke(command: RendererHostCommand, args?: RendererHostArguments): Promise<unknown>;
  listen(event: string, handler: RendererHostListener): Promise<RendererHostUnlisten>;
}

export type ZToolsRendererApp = { name: string; path: string; icon?: string };

export type ZToolsRendererPlugin = {
  id: string;
  name: string;
  title?: string;
  version: string;
  path: string;
  enabled: boolean;
  logo?: string;
  description?: string;
  main?: string;
  features: Array<Record<string, unknown>>;
  sourceKind: "builtin" | "imported" | "external";
};

export type ZToolsRendererLaunchOptions = {
  path?: unknown;
  type?: unknown;
  subType?: unknown;
  [key: string]: unknown;
};

export type ZToolsRendererLaunchContext = {
  searchQuery: string;
  pastedImage: string | null;
  pastedFiles: Array<{ path: string; name: string; isDirectory: boolean }> | null;
  pastedText: string | null;
};

export interface ZToolsRendererLocalShortcuts {
  getAll(): Promise<RendererLocalShortcut[]>;
}

export type ZToolsRendererUpdaterStatusName =
  | "idle"
  | "not-available"
  | "available"
  | "checking"
  | "downloading"
  | "downloaded"
  | "installing"
  | "install-unknown"
  | "restart-pending"
  | "error"
  | "restarting";

export interface ZToolsRendererUpdaterStatus {
  status: ZToolsRendererUpdaterStatusName;
  checked: boolean;
  hasUpdate: boolean;
  hasDownloaded: boolean;
  version?: string;
  changelog?: string;
}

export interface ZToolsRendererUpdater {
  getDownloadStatus(): Promise<ZToolsRendererUpdaterStatus>;
  checkUpdate(): Promise<unknown>;
  showUpdateWindow(): Promise<{ success: boolean }>;
}

export interface ZToolsRendererApi {
  onAutoCheckUpdateChanged(callback: (enabled: boolean) => unknown): RendererHostUnlisten;
  onNativeMainFileDrop(element: HTMLElement, callback: (notice: MainFileDropNotice) => void): { setActive(active: boolean): void; dispose(): void };
  onFocusSearch(callback: () => unknown): RendererHostUnlisten;
  getApps(): Promise<ZToolsRendererApp[]>;
  getAllPlugins(): Promise<ZToolsRendererPlugin[]>;
  getDisabledPlugins(): Promise<string[]>;
  dbGet(key: string): Promise<unknown>;
  dbPut(key: string, value: unknown): Promise<void>;
  getPlatform(): string;
  isWindows(): boolean;
  getSystemSettings(): Promise<never[]>;
  getLastCopiedContent(timeLimit?: number): Promise<RendererLastCopiedContent | null>;
  getSuperPanelPinned(): Promise<Array<{ path: string; name?: string; featureCode?: string }>>;
  getUsageStats(): Promise<Array<{ path: string; featureCode?: string; useCount: number }>>;
  analyzeImage(imagePath: string): Promise<ImageAnalysisResult>;
  localShortcuts: ZToolsRendererLocalShortcuts;
  updateLaunchContext(context: ZToolsRendererLaunchContext): void;
  getWindowMaterial?: undefined;
  updater: ZToolsRendererUpdater;
  launch(options: ZToolsRendererLaunchOptions): Promise<unknown>;
  revealInFinder(path: string): Promise<unknown>;
  showContextMenu(items: unknown): Promise<void>;
  pinApp(command: unknown): Promise<void>;
  unpinApp(path: unknown, featureCode?: unknown, name?: unknown): Promise<void>;
  removeFromHistory(path: unknown, featureCode?: unknown, name?: unknown): Promise<void>;
  updatePinnedOrder(commands: unknown): Promise<void>;
  resizeWindow(height: number): void;
  resetWindow(): Promise<unknown>;
  hideWindow(): void;
  getWindowPosition(): Promise<RendererWindowPosition>;
  setWindowPosition(x: number, y: number): void;
  setWindowSizeLock(locked: boolean): void;
  openSettings(): void;
  hidePlugin(): void;
  notifySubInputChange(text: string): void;
  onShowPluginPlaceholder(callback: () => unknown): RendererHostUnlisten;
  onPluginOpened(callback: (plugin: RendererSettingsViewPlugin) => unknown): RendererHostUnlisten;
  onPluginLoaded(callback: (plugin: { name: string; path: string }) => unknown): RendererHostUnlisten;
  onPluginClosed(callback: () => unknown): RendererHostUnlisten;
  onBackToSearch(callback: () => unknown): RendererHostUnlisten;
  onUpdateSubInputVisible(callback: (visible: boolean) => unknown): RendererHostUnlisten;
  onUpdateSubInputPlaceholder(callback: (payload: { placeholder: string }) => unknown): RendererHostUnlisten;
  onSetSubInputValue(callback: (value: string) => unknown): RendererHostUnlisten;
  onFocusSubInput(callback: () => unknown): RendererHostUnlisten;
  onSelectSubInput(callback: () => unknown): RendererHostUnlisten;
  onUpdatePlaceholder(callback: (value: string) => unknown): RendererHostUnlisten;
  onUpdateAutoPaste(callback: (value: RendererGeneralPreferenceValues["autoPaste"]) => unknown): RendererHostUnlisten;
  onUpdateAutoClear(callback: (value: string) => unknown): RendererHostUnlisten;
  onUpdatePrimaryColor(callback: (value: { primaryColor: string; customColor?: string }) => unknown): RendererHostUnlisten;
  onUpdateShowRecentInSearch(callback: (value: boolean) => unknown): RendererHostUnlisten;
  onUpdateRecentRows(callback: (value: number) => unknown): RendererHostUnlisten;
  onUpdatePinnedRows(callback: (value: number) => unknown): RendererHostUnlisten;
  onUpdateSearchMode(callback: (value: "aggregate" | "list") => unknown): RendererHostUnlisten;
  onUpdateMatchRecommendation(callback: (value: boolean) => unknown): RendererHostUnlisten;
  onUpdateTabKeyFunction(callback: (value: "navigate" | "target-command") => unknown): RendererHostUnlisten;
  onUpdateTabTarget(callback: (value: string) => unknown): RendererHostUnlisten;
  onUpdateSpaceOpenCommand(callback: (value: boolean) => unknown): RendererHostUnlisten;
  onUpdateLocalAppSearch(callback: (value: boolean) => unknown): RendererHostUnlisten;
  onUpdateBuiltinAppShortcutsEnabled(callback: (value: Readonly<RendererGeneralPreferenceValues["builtinAppShortcutsEnabled"]>) => unknown): RendererHostUnlisten;
  onAppsChanged(callback: () => void): RendererHostUnlisten;
  onPluginsChanged(callback: () => unknown): RendererHostUnlisten;
  onAppLaunched(callback: () => unknown): RendererHostUnlisten;
  onHistoryChanged(callback: () => void): RendererHostUnlisten;
  onLocalShortcutsChanged(callback: () => void): RendererHostUnlisten;
  onPinnedChanged(callback: () => void): RendererHostUnlisten;
  onSuperPanelPinnedChanged(callback: () => void): RendererHostUnlisten;
  onDisabledCommandsChanged(callback: () => void): RendererHostUnlisten;
  onCommandAliasesChanged(callback: () => void): RendererHostUnlisten;
  onContextMenuCommand(callback: (command: string) => void): RendererHostUnlisten;
  onAiStatusChanged(callback: (status: string) => void): RendererHostUnlisten;
  [key: string]: unknown;
}

export type AdapterCapabilityState =
  | "available"
  | "inactive"
  | "unsupported"
  | "limited"
  | "available_with_defaults"
  | "local_only"
  | "unavailable";

export interface ZToolsRendererHostAdapter {
  readonly api: ZToolsRendererApi;
  capabilities(): {
    methods: Record<string, AdapterCapabilityState>;
    events: Record<string, AdapterCapabilityState>;
    methodNotes?: Record<string, string>;
  };
  snapshot(): {
    disposed: boolean;
    outstandingNativeCalls: number;
    nativeCalls: Partial<Record<RendererHostCommand, number>>;
    unsupportedMethods: string[];
    unavailableMethods: string[];
    inactiveEvents: string[];
    readModelDefaults: string[];
    launchContextSet: boolean;
    imageAnalysis: ImageAnalysisSnapshot;
    focusEvents: RendererFocusEventsSnapshot;
    settingsSnapshot: RendererSettingsSnapshotDiagnostics;
    windowNotifications: RendererWindowNotificationsSnapshot;
    windowDrag: RendererWindowDragSnapshot;
    appState: RendererAppStateSnapshot;
    appCatalog: RendererAppCatalogSnapshot;
    pluginCatalog: RendererPluginCatalogSnapshot;
    appLaunched: RendererAppLaunchedSnapshot;
    contextMenu: RendererContextMenuSnapshot;
    settingsView: RendererSettingsViewSnapshot;
    generalPreferenceEvents: RendererGeneralPreferenceSnapshot;
    commandAliasEvents: RendererCommandAliasEventsSnapshot;
    disabledCommandsEvents: RendererCommandInvalidationEventsSnapshot;
    localShortcutEvents: RendererLocalShortcutEventsSnapshot;
  };
  dispose(): void;
}

export interface ZToolsRendererWindow {
  addEventListener?(type: "pagehide", listener: () => void, options?: { once: boolean }): void;
  removeEventListener?(type: "pagehide", listener: () => void): void;
  navigator?: { platform?: string; userAgent?: string };
  document?: { getElementById(id: string): unknown };
  ztools?: unknown;
  __ATOOLS_ZTOOLS_RENDERER_TRANSPORT__?: ZToolsRendererTransport;
  __ATOOLS_ZTOOLS_HOST_ADAPTER__?: ZToolsRendererHostAdapter;
}
