import { loadCommandAliases, type CommandAliasEntry } from "./commandAliases";
import { loadCommandHistory, type CommandHistoryEntry } from "./commandHistory";
import { loadLocalLaunchEntries, type LocalLaunchEntry } from "./localLaunch";
import { loadPinnedCommandCodes } from "./pinnedCommands";
import { createPluginInventoryBrowseState, type PluginInventoryBrowseState } from "./pluginInventoryBrowseState";
import type { PluginMarketRequest } from "./pluginMarketNavigation";
import type {
  AiProvider,
  AppShortcutSetting,
  AToolsSettings,
  PrimaryColor,
  WindowPositionStrategy,
} from "./settings";
import {
  normalizeAppShortcuts,
  type CommandCenterSourceFilter,
  type CommandCenterStatusFilter,
  type ShortcutTabId,
} from "./settingsPages";
import {
  hasTauriRuntime,
  type AccessibilityPermissionStatus,
  type MenuId,
  type PluginDataSummary,
  type SettingsConfirmRequest,
} from "./settingsPanelTypesAndOptions";
import type {
  AgentScopePolicy,
  AgentToolGrant,
  AiConnectionTestResult,
  AuditLogEntry,
  ClipboardHistoryEntry,
  CrashLogEntry,
  InstalledPlugin,
  McpServerStatus,
  PendingAgentToolRequest,
  PluginProviderDescriptor,
  RuntimeDiagnostics,
  ToolDefinition,
  WebdavBackupPreview,
  WebdavClipboardRestoreResult,
  WebdavPluginDataRestoreResult,
  WebdavRestorePlan,
  WebdavSettingsRestoreResult,
  WebdavSyncSummary,
} from "./types";
import { normalizeWakeupBlacklist } from "./wakeupBlacklist";
import { loadWebQuickOpenEntries, type WebQuickOpenEntry } from "./webQuickOpen";

export function createSettingsPanelState(initialSettings: AToolsSettings) {
  const s = $state({
    handledMarketRequest: null as PluginMarketRequest | null,
    activeMenu: "general" as MenuId,
    marketVisited: false,
    activeShortcutTab: "global" as ShortcutTabId,
    settingsConfirmRequest: null as SettingsConfirmRequest | null,
    hydrated: true,
    dirty: false,
    nativeSettingsRuntime: hasTauriRuntime(),
    saveState: "saved" as "idle" | "saving" | "saved" | "error",
    hotkey: initialSettings.hotkey,
    recordingHotkey: false,
    hotkeyRecorderMessage: "",
    showHotkeyQuickActions: false,
    saveErrorMessage: "",
    launchAtLogin: initialSettings.launchAtLogin,
    launchAtLoginRuntimeState: null as boolean | null,
    appShortcuts: [...initialSettings.appShortcuts] as AppShortcutSetting[],
    appShortcutStatus: "已保存",
    showTrayIcon: initialSettings.showTrayIcon,
    accessibilityPermission: null as AccessibilityPermissionStatus | null,
    accessibilityPermissionBusy: false,
    accessibilityPermissionMessage: "",
    wakeupBlacklist: [...initialSettings.wakeupBlacklist] as string[],
    wakeupBlacklistDraft: "",
    wakeupBlacklistStatus: "",
    theme: initialSettings.theme,
    primaryColor: initialSettings.primaryColor as PrimaryColor,
    customColor: initialSettings.customColor,
    opacity: initialSettings.opacity,
    windowMaterial: initialSettings.windowMaterial,
    placeholder: initialSettings.placeholder,
    searchMode: initialSettings.searchMode,
    showRecentInSearch: initialSettings.showRecentInSearch,
    showMatchRecommendation: initialSettings.showMatchRecommendation,
    localAppSearch: initialSettings.localAppSearch,
    localLaunchSearch: initialSettings.localLaunchSearch,
    spaceOpenCommand: initialSettings.spaceOpenCommand,
    recentRows: initialSettings.recentRows,
    pinnedRows: initialSettings.pinnedRows,
    tabKeyFunction: initialSettings.tabKeyFunction,
    tabTarget: initialSettings.tabTarget,
    autoPaste: initialSettings.autoPaste,
    autoClear: initialSettings.autoClear,
    autoBackToSearch: initialSettings.autoBackToSearch,
    pluginEscapeToSearch: initialSettings.pluginEscapeToSearch,
    windowDefaultHeight: initialSettings.windowDefaultHeight,
    windowPositionStrategy: initialSettings.windowPositionStrategy as WindowPositionStrategy,
    clipboardRetentionDays: initialSettings.clipboardRetentionDays,
    superPanelEnabled: initialSettings.superPanelEnabled,
    superPanelStatus: "",
    floatingBallEnabled: initialSettings.floatingBallEnabled,
    floatingBallStatus: "",
    proxyEnabled: initialSettings.proxyEnabled,
    proxyUrl: initialSettings.proxyUrl,
    pluginMarketCustom: initialSettings.pluginMarketCustom,
    pluginMarketUrl: initialSettings.pluginMarketUrl,
    pluginMarketTrustedPublicKeysText: initialSettings.pluginMarketTrustedPublicKeys.join("\n"),
    devToolsMode: initialSettings.devToolsMode,
    devtoolsStatus: "",
    disableGpuAcceleration: initialSettings.disableGpuAcceleration,
    aiProvider: initialSettings.aiProvider as AiProvider,
    aiBaseUrl: initialSettings.aiBaseUrl,
    aiDefaultModel: initialSettings.aiDefaultModel,
    aiApiKey: initialSettings.aiApiKey,
    aiTemperature: initialSettings.aiTemperature,
    aiUseForAgent: initialSettings.aiUseForAgent,
    aiTestingConnection: false,
    aiConnectionStatus: "",
    aiLastConnection: null as AiConnectionTestResult | null,
    webdavEnabled: initialSettings.webdavEnabled,
    webdavUrl: initialSettings.webdavUrl,
    webdavUsername: initialSettings.webdavUsername,
    webdavPassword: initialSettings.webdavPassword,
    webdavRemotePath: initialSettings.webdavRemotePath,
    webdavSyncSettings: initialSettings.webdavSyncSettings,
    webdavSyncPlugins: initialSettings.webdavSyncPlugins,
    webdavSyncClipboard: initialSettings.webdavSyncClipboard,
    webdavSyncing: false,
    webdavPreviewing: false,
    webdavPlanningRestore: false,
    webdavRestoringSettings: false,
    webdavRestoringClipboard: false,
    webdavRestoringPluginData: false,
    webdavSyncStatus: "",
    webdavLastSync: null as WebdavSyncSummary | null,
    webdavLastPreview: null as WebdavBackupPreview | null,
    webdavLastRestorePlan: null as WebdavRestorePlan | null,
    webdavLastSettingsRestore: null as WebdavSettingsRestoreResult | null,
    webdavLastClipboardRestore: null as WebdavClipboardRestoreResult | null,
    webdavLastPluginDataRestore: null as WebdavPluginDataRestoreResult | null,
    webdavSelectedPluginConflictKeys: [] as string[],
    mcpStatus: null as McpServerStatus | null,
    agentTools: [] as ToolDefinition[],
    agentScopePolicies: [] as AgentScopePolicy[],
    pendingAgentRequests: [] as PendingAgentToolRequest[],
    agentToolGrants: [] as AgentToolGrant[],
    mcpRecentAudits: [] as AuditLogEntry[],
    mcpPermissionMode: "conservative",
    mcpLoading: false,
    mcpPolicyBusyKey: "",
    mcpRequestBusyKey: "",
    mcpPageStatus: "",
    mcpInstallHomePath: "",
    dataLoading: false,
    dataStatus: "",
    auditArchiveBusy: false,
    auditPruneBusy: false,
    installedPlugins: [] as InstalledPlugin[],
    pluginDataSummary: [] as PluginDataSummary[],
    selectedPluginId: null as string | null,
    pluginFilterQuery: "",
    pluginInventoryBrowseState: createPluginInventoryBrowseState() as PluginInventoryBrowseState,
    pluginProviders: [] as PluginProviderDescriptor[],
    pluginProvidersLoading: false,
    pluginProvidersStatus: "",
    busyProviderId: "",
    recentAudits: [] as AuditLogEntry[],
    clipboardHistory: [] as ClipboardHistoryEntry[],
    commandHistory: loadCommandHistory() as CommandHistoryEntry[],
    debugLoading: false,
    debugStatus: "",
    debugMcpStatus: null as McpServerStatus | null,
    runtimeDiagnostics: null as RuntimeDiagnostics | null,
    debugAudits: [] as AuditLogEntry[],
    recentAuditErrors: [] as AuditLogEntry[],
    crashLogs: [] as CrashLogEntry[],
    aboutLoading: false,
    aboutPageStatus: "",
    localLaunchEntries: loadLocalLaunchEntries() as LocalLaunchEntry[],
    localLaunchStatus: "已保存",
    webQuickOpenEntries: loadWebQuickOpenEntries() as WebQuickOpenEntry[],
    webQuickOpenStatus: "已保存",
    editingWebQuickOpenId: null as string | null,
    webQuickOpenDraft: null as WebQuickOpenEntry | null,
    webQuickOpenValidation: "",
    commandAliases: loadCommandAliases() as CommandAliasEntry[],
    commandAliasStatus: "已保存",
    commandCenterPinnedCodes: loadPinnedCommandCodes() as string[],
    commandCenterQuery: "",
    commandCenterSourceFilter: "all" as CommandCenterSourceFilter,
    commandCenterStatusFilter: "all" as CommandCenterStatusFilter,
  });
  return s;
}

export type SettingsPanelState = ReturnType<typeof createSettingsPanelState>;

export function buildCurrentSettings(s: SettingsPanelState, webdavConfigReady: () => boolean): AToolsSettings {
  return {
    hotkey: s.hotkey,
    appShortcuts: normalizeAppShortcuts(s.appShortcuts),
    launchAtLogin: s.launchAtLogin,
    showTrayIcon: s.showTrayIcon,
    wakeupBlacklist: normalizeWakeupBlacklist(s.wakeupBlacklist),
    theme: s.theme,
    primaryColor: s.primaryColor,
    customColor: s.customColor,
    opacity: s.opacity,
    windowMaterial: "none",
    placeholder: s.placeholder,
    searchMode: s.searchMode,
    showRecentInSearch: s.showRecentInSearch,
    showMatchRecommendation: s.showMatchRecommendation,
    localAppSearch: s.localAppSearch,
    localLaunchSearch: s.localLaunchSearch,
    spaceOpenCommand: s.spaceOpenCommand,
    recentRows: s.recentRows,
    pinnedRows: s.pinnedRows,
    tabKeyFunction: s.tabKeyFunction,
    tabTarget: s.tabTarget,
    autoPaste: s.autoPaste,
    autoClear: s.autoClear,
    autoBackToSearch: s.autoBackToSearch,
    pluginEscapeToSearch: s.pluginEscapeToSearch,
    windowDefaultHeight: s.windowDefaultHeight,
    windowPositionStrategy: s.windowPositionStrategy,
    clipboardRetentionDays: s.clipboardRetentionDays,
    superPanelEnabled: s.superPanelEnabled,
    floatingBallEnabled: s.floatingBallEnabled,
    proxyEnabled: s.proxyEnabled && Boolean(s.proxyUrl.trim()),
    proxyUrl: s.proxyUrl,
    pluginMarketCustom: s.pluginMarketCustom && Boolean(s.pluginMarketUrl.trim()),
    pluginMarketUrl: s.pluginMarketUrl,
    pluginMarketTrustedPublicKeys: s.pluginMarketTrustedPublicKeysText
      .split(/\s+/)
      .map((key) => key.trim())
      .filter(Boolean),
    devToolsMode: s.devToolsMode,
    disableGpuAcceleration: false,
    aiProvider: s.aiProvider,
    aiBaseUrl: s.aiBaseUrl,
    aiDefaultModel: s.aiDefaultModel,
    aiApiKey: s.aiApiKey,
    aiTemperature: s.aiTemperature,
    aiUseForAgent: s.aiProvider !== "disabled" && s.aiUseForAgent,
    webdavEnabled: webdavConfigReady() && s.webdavEnabled,
    webdavUrl: s.webdavUrl,
    webdavUsername: s.webdavUsername,
    webdavPassword: s.webdavPassword,
    webdavRemotePath: s.webdavRemotePath,
    webdavSyncSettings: s.webdavSyncSettings,
    webdavSyncPlugins: s.webdavSyncPlugins,
    webdavSyncClipboard: s.webdavSyncClipboard,
  };
}

export function applySettingsToState(
  s: SettingsPanelState,
  settings: AToolsSettings,
  clearAiConnectionResult: () => void,
) {
  s.hotkey = settings.hotkey;
  s.appShortcuts = [...settings.appShortcuts];
  s.appShortcutStatus = "已保存";
  s.launchAtLogin = settings.launchAtLogin;
  s.showTrayIcon = settings.showTrayIcon;
  s.wakeupBlacklist = normalizeWakeupBlacklist(settings.wakeupBlacklist);
  s.wakeupBlacklistDraft = "";
  s.theme = settings.theme;
  s.primaryColor = settings.primaryColor;
  s.customColor = settings.customColor;
  s.opacity = settings.opacity;
  s.windowMaterial = "none";
  s.placeholder = settings.placeholder;
  s.searchMode = settings.searchMode;
  s.showRecentInSearch = settings.showRecentInSearch;
  s.showMatchRecommendation = settings.showMatchRecommendation;
  s.localAppSearch = settings.localAppSearch;
  s.localLaunchSearch = settings.localLaunchSearch;
  s.spaceOpenCommand = settings.spaceOpenCommand;
  s.recentRows = settings.recentRows;
  s.pinnedRows = settings.pinnedRows;
  s.tabKeyFunction = settings.tabKeyFunction;
  s.tabTarget = settings.tabTarget;
  s.autoPaste = settings.autoPaste;
  s.autoClear = settings.autoClear;
  s.autoBackToSearch = settings.autoBackToSearch;
  s.pluginEscapeToSearch = settings.pluginEscapeToSearch;
  s.windowDefaultHeight = settings.windowDefaultHeight;
  s.windowPositionStrategy = settings.windowPositionStrategy;
  s.clipboardRetentionDays = settings.clipboardRetentionDays;
  s.superPanelEnabled = settings.superPanelEnabled;
  s.superPanelStatus = "";
  s.floatingBallEnabled = settings.floatingBallEnabled;
  s.floatingBallStatus = "";
  s.proxyEnabled = settings.proxyEnabled;
  s.proxyUrl = settings.proxyUrl;
  s.pluginMarketCustom = settings.pluginMarketCustom;
  s.pluginMarketUrl = settings.pluginMarketUrl;
  s.pluginMarketTrustedPublicKeysText = settings.pluginMarketTrustedPublicKeys.join("\n");
  s.devToolsMode = settings.devToolsMode;
  s.disableGpuAcceleration = false;
  s.aiProvider = settings.aiProvider;
  s.aiBaseUrl = settings.aiBaseUrl;
  s.aiDefaultModel = settings.aiDefaultModel;
  s.aiApiKey = settings.aiApiKey;
  s.aiTemperature = settings.aiTemperature;
  s.aiUseForAgent = settings.aiUseForAgent;
  clearAiConnectionResult();
  s.webdavEnabled = settings.webdavEnabled;
  s.webdavUrl = settings.webdavUrl;
  s.webdavUsername = settings.webdavUsername;
  s.webdavPassword = settings.webdavPassword;
  s.webdavRemotePath = settings.webdavRemotePath;
  s.webdavSyncSettings = settings.webdavSyncSettings;
  s.webdavSyncPlugins = settings.webdavSyncPlugins;
  s.webdavSyncClipboard = settings.webdavSyncClipboard;
}
