<script lang="ts">
  import { onMount } from "svelte";
  import { invoke } from "@tauri-apps/api/core";
  import { listen } from "@tauri-apps/api/event";
  import { writeText } from "@tauri-apps/plugin-clipboard-manager";
  import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
  import SettingsConfirmDialog from "./SettingsConfirmDialog.svelte";
  import {
    applyAToolsAppearance,
    applyAndSaveAToolsSettings,
    DEFAULT_ATOOLS_SETTINGS,
    dispatchAToolsSettings,
    loadAToolsSettings,
    loadAToolsSettingsSync,
    normalizeSettings,
    SettingsSaveCoordinator,
    SettingsSaveDebouncer,
    type AppShortcutSetting,
    type AToolsSettings,
    type AiProvider,
    type PrimaryColor,
  } from "../lib/settings";
  import { registerSettingsSaveFlushOnDestroy } from "../lib/settingsLifecycle";
  import type {
    AgentScopePolicy,
    AgentToolGrant,
    AiConnectionTestResult,
    AuditArchiveResult,
    AuditLogEntry,
    ClipboardHistoryEntry,
    CrashLogEntry,
    InstalledPlugin,
    McpServerStatus,
    PendingAgentToolRequest,
    PluginMarketCatalog,
    PluginMarketCatalogPlugin,
    RuntimeDiagnostics,
    ToolDefinition,
    WebdavBackupPreview,
    WebdavClipboardRestoreResult,
    WebdavPluginDataConflictDocument,
    WebdavPluginDataRestoreResult,
    WebdavRestorePlan,
    WebdavSettingsRestoreResult,
    WebdavSyncSummary,
  } from "../lib/types";
  import {
    createLocalLaunchEntry,
    DEFAULT_LOCAL_LAUNCH_ENTRIES,
    dispatchLocalLaunchEntries,
    loadLocalLaunchEntries,
    localLaunchOverviewCards,
    resolveLocalLaunchPath,
    saveLocalLaunchEntries,
    type LocalLaunchEntry,
    type LocalLaunchKind,
  } from "../lib/localLaunch";
  import {
    buildWebQuickOpenUrl,
    createWebQuickOpenEntry,
    DEFAULT_WEB_QUICK_OPEN_ENTRIES,
    dispatchWebQuickOpenEntries,
    loadWebQuickOpenEntries,
    saveWebQuickOpenEntries,
    validateWebQuickOpenEntry,
    webQuickOpenOverviewCards,
    type WebQuickOpenEntry,
  } from "../lib/webQuickOpen";
  import {
    isCancelKey,
    recordingHint,
    shortcutStatusMessage,
    shortcutFromKeyboardEvent,
    validateShortcut,
    type HotkeyPlatform,
  } from "../lib/hotkeyRecorder";
  import {
    clearCommandHistoryStorage,
    commandHistoryStats,
    COMMAND_HISTORY_UPDATED_EVENT,
    exportCommandHistoryJson,
    loadCommandHistory,
    removeCommandHistoryEntryStorage,
    type CommandHistoryEntry,
  } from "../lib/commandHistory";
  import {
    COMMAND_ALIASES_UPDATED_EVENT,
    createCommandAlias,
    dispatchCommandAliasesUpdated,
    loadCommandAliases,
    normalizeCommandAliases,
    saveCommandAliases,
    type CommandAliasEntry,
  } from "../lib/commandAliases";
  import {
    dispatchPinnedCommandCodes,
    loadPinnedCommandCodes,
    savePinnedCommandCodes,
    togglePinnedCommandCode,
  } from "../lib/pinnedCommands";
  import { addWakeupBlacklistItem, normalizeWakeupBlacklist } from "../lib/wakeupBlacklist";
  import {
    auditErrorSummaries,
    buildDiagnosticBundle,
    crashLogSummaries,
    debugOverviewCards,
    diagnosticBundleText,
    localDataDiagnostics,
    runtimeDiagnosticRows,
    type AuditErrorSummary,
    type CrashLogSummary,
    type DebugDiagnosticRow,
  } from "../lib/debugDiagnostics";
  import { auditDataOverview } from "../lib/auditView";
  import { pluginInventory as buildPluginInventory, pluginInventoryOverviewCards } from "../lib/pluginInventory";
  import {
    PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT,
    clearPluginRuntimePermissionGrants,
    pluginRuntimePermissionGrantList,
  } from "../lib/pluginRuntimePermissions";
  import {
    pluginMarketOverviewCards,
    pluginMarketStatus as buildPluginMarketStatus,
  } from "../lib/pluginMarketStatus";
  import {
    mcpClientConfig as buildMcpClientConfig,
    mcpClientConfigText,
    mcpConnectionView,
    mcpClientInstallPlan,
    mcpClientInstallResultText,
    mcpClientSuggestedTargetPath,
    mcpClientTemplateText,
    mcpClientTemplates,
    mcpHttpUrl as mcpHttpUrlForStatus,
    type McpClientConfigInstallResult,
    type McpClientTemplate,
  } from "../lib/mcpClientConfig";
  import { SYSTEM_ACTIONS } from "../lib/uiState";
  import {
    aiConnectionButtonState,
    aiConnectionRows,
  } from "../lib/aiConnectionView";
  import {
    webdavClipboardRestoreButtonState,
    webdavClipboardRestoreRows,
    webdavOverviewCards,
    webdavPreviewButtonState,
    webdavPreviewRows,
    webdavPluginDataOverwriteButtonState,
    webdavPluginDataSelectedOverwriteButtonState,
    webdavPluginDataRestoreButtonState,
    webdavPluginDataRestoreRows,
    webdavRestorePlanButtonState,
    webdavRestorePlanRows,
    webdavSettingsRestoreButtonState,
    webdavSettingsRestoreRows,
    webdavSyncButtonState,
    webdavSyncRows,
  } from "../lib/webdavSyncView";
  import {
    aboutOverviewCards,
    aboutProductFacts,
    aiOverviewCards,
    appShortcutRows,
    auditRetentionPolicyRows,
    builtInAppShortcutsForPlatform,
    commandCenterOverview,
    commandCenterRows,
    createAppShortcut,
    dataOverviewCards,
    defaultHotkeyForPlatform,
    generalOverviewCards,
    generalUnsupportedCapabilities,
    hotkeyPresetsForPlatform,
    httpServiceOverviewCards,
    httpServiceStatus,
    mcpAuditRows,
    mcpGovernanceOverview,
    mcpGrantRows,
    mcpPendingRequestRows,
    mcpScopePolicyRows,
    normalizeAppShortcuts,
    permissionModeLabel,
    shortcutPageOverview,
    shortcutTabs,
    settingsMenuItems,
    type CommandCenterRow,
    type CommandCenterSourceFilter,
    type CommandCenterStatusFilter,
    type ShortcutTabId,
    type SettingsIconName,
    type SettingsMenuId,
  } from "../lib/settingsPages";

  type MenuId = SettingsMenuId;
  type IconName = SettingsIconName;
  type MarketCatalogDetailPlugin = PluginMarketCatalogPlugin & {
    checksum?: string | null;
    rating?: string | null;
    rating_count?: number | null;
    downloads?: number | null;
    updated_at?: string | null;
    publisher?: string | null;
    publisher_url?: string | null;
    signature?: string | null;
    public_key?: string | null;
  };
  type PluginMarketProgressEvent = {
    plugin_id?: string | null;
    operation: string;
    operation_id?: string | null;
    stage: string;
    downloaded_bytes: number;
    total_bytes?: number | null;
    percent?: number | null;
    attempt: number;
    max_attempts: number;
    message: string;
  };

  type PluginMarketActionState = {
    plugin: PluginMarketCatalogPlugin;
    operation: "install" | "update";
    actionLabel: string;
  };

  type Props = {
    initialMenu?: MenuId;
  };

  let { initialMenu = "general" }: Props = $props();

  type Option<T extends string | number> = {
    label: string;
    value: T;
  };

  type SettingsConfirmRequest = {
    title: string;
    message: string;
    confirmLabel: string;
    cancelLabel: string;
    tone: "default" | "danger";
    resolve: (confirmed: boolean) => void;
  };

  type PluginDocument = {
    _id: string;
    [key: string]: unknown;
  };

  type PluginDataSummary = {
    plugin: InstalledPlugin;
    documents: number;
    error?: string;
  };

  type DevtoolsOpenResult = {
    window_label: string;
    mode: string;
    detail: string;
  };

  const menuItems = settingsMenuItems();
  const AUDIT_RETENTION_DAYS = 90;
  const AUDIT_KEEP_LATEST = 1000;
  const PLUGIN_MARKET_PROGRESS_EVENT = "plugin-market-progress";

  const themeOptions: Option<string>[] = [
    { label: "跟随系统", value: "system" },
    { label: "明亮", value: "light" },
    { label: "暗黑", value: "dark" },
  ];

  const aiProviderOptions: Option<AiProvider>[] = [
    { label: "关闭", value: "disabled" },
    { label: "OpenAI", value: "openai" },
    { label: "兼容 API", value: "compatible" },
    { label: "本地模型", value: "local" },
  ];

  const autoPasteOptions: Option<string>[] = [
    { label: "关闭", value: "off" },
    { label: "1秒内", value: "1s" },
    { label: "3秒内", value: "3s" },
    { label: "5秒内", value: "5s" },
    { label: "10秒内", value: "10s" },
  ];

  const autoClearOptions: Option<string>[] = [
    { label: "立即", value: "immediately" },
    { label: "1分钟", value: "1m" },
    { label: "2分钟", value: "2m" },
    { label: "3分钟", value: "3m" },
    { label: "5分钟", value: "5m" },
    { label: "10分钟", value: "10m" },
    { label: "从不", value: "never" },
  ];

  const autoBackToSearchOptions: Option<string>[] = [
    { label: "立即", value: "immediately" },
    { label: "30秒", value: "30s" },
    { label: "1分钟", value: "1m" },
    { label: "3分钟", value: "3m" },
    { label: "5分钟", value: "5m" },
    { label: "10分钟", value: "10m" },
    { label: "从不", value: "never" },
  ];

  const rowOptions: Option<number>[] = [
    { label: "1行", value: 1 },
    { label: "2行", value: 2 },
    { label: "3行", value: 3 },
    { label: "4行", value: 4 },
  ];

  const searchModeOptions: Option<string>[] = [
    { label: "聚合模式", value: "aggregate" },
    { label: "列表模式", value: "list" },
  ];

  const tabKeyOptions: Option<string>[] = [
    { label: "切换选中", value: "navigate" },
    { label: "目标指令", value: "target-command" },
  ];

  const devToolsModeOptions: Option<string>[] = [
    { label: "独立窗口", value: "detach" },
    { label: "靠右", value: "right" },
    { label: "靠下", value: "bottom" },
    { label: "独立窗口（可停靠）", value: "undocked" },
  ];

  const windowMaterialOptions: Option<string>[] = [
    { label: "无", value: "none" },
    { label: "Mica（云母）", value: "mica" },
    { label: "Acrylic（亚克力）", value: "acrylic" },
  ];

  const themeColors: Array<{ label: string; value: PrimaryColor; hex: string }> = [
    { label: "天空蓝", value: "blue", hex: "#0284c7" },
    { label: "罗兰紫", value: "purple", hex: "#7c3aed" },
    { label: "翡翠绿", value: "green", hex: "#059669" },
    { label: "活力橙", value: "orange", hex: "#ea580c" },
    { label: "宝石红", value: "red", hex: "#dc2626" },
    { label: "桃粉", value: "pink", hex: "#db2777" },
  ];

  const placeholderPages: Partial<Record<MenuId, Array<{ title: string; desc: string; meta: string }>>> = {
    shortcuts: [
      { title: "全局快捷键", desc: "为常用指令配置跨应用呼出快捷键", meta: "Option+Z" },
      { title: "应用快捷键", desc: "仅在主搜索界面生效的快捷键映射", meta: "Cmd+F / Cmd+Q" },
      { title: "别名映射", desc: "把短词映射到插件指令或本地应用", meta: "alias" },
    ],
    ai: [
      { title: "模型提供商", desc: "配置 OpenAI、兼容 API 或本地模型", meta: "provider" },
      { title: "默认模型", desc: "为 Agent 和 AI 插件指定默认模型", meta: "model" },
    ],
    mcp: [
      { title: "本地 MCP Server", desc: "绑定 127.0.0.1，通过 token 授权访问", meta: "127.0.0.1" },
      { title: "工具暴露", desc: "选择哪些插件工具可以被 MCP 客户端调用", meta: "tools" },
      { title: "调用审计", desc: "记录客户端、工具名、输入输出和确认结果", meta: "audit" },
    ],
    web: [
      { title: "搜索引擎", desc: "管理 Baidu、Bing、Google 和自定义快开", meta: "engine" },
      { title: "URL 模板", desc: "用 {query} 拼接网页搜索或站内搜索", meta: "template" },
    ],
    data: [
      { title: "插件数据", desc: "查看、导出或清空插件本地数据", meta: "db" },
      { title: "剪贴板历史", desc: "配置历史保留天数并支持本地检索", meta: "180天" },
    ],
    commands: [
      { title: "全部指令", desc: "查看插件命令、系统命令和文件匹配命令", meta: "commands" },
      { title: "固定到搜索框", desc: "把高频命令固定到主搜索面板", meta: "pin" },
    ],
    local: [
      { title: "本地启动项", desc: "把文件、文件夹和应用固定为可搜索指令", meta: "local" },
      { title: "路径校验", desc: "检查不存在或已移动的本地启动项", meta: "scan" },
    ],
    sync: [
      { title: "WebDAV 配置", desc: "同步插件、设置和命令数据", meta: "webdav" },
      { title: "同步策略", desc: "选择覆盖、本地优先或远端优先", meta: "strategy" },
    ],
    debug: [
      { title: "调试日志", desc: "查看主进程、插件和 MCP 服务日志", meta: "logs" },
      { title: "开发者工具", desc: "控制插件 DevTools 默认打开位置", meta: "detach" },
    ],
  };

  const iconMarkup: Record<IconName, string> = {
    settings: '<path d="M12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.04-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.03 4.2l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.2.56.78.96 1.56.96H21a2 2 0 1 1 0 4h-.09A1.7 1.7 0 0 0 19.4 15Z"/>',
    keyboard: '<path d="M4 6h16a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2Z"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    plugin: '<path d="M8 3v4M16 3v4M6 7h12v4a6 6 0 0 1-12 0V7Z"/><path d="M12 17v4M8 21h8"/>',
    store: '<path d="M5 10h14l-1 10H6L5 10Z"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/><path d="M5 10 3 6h18l-2 4"/>',
    brain: '<path d="M8.5 14.5A3.5 3.5 0 0 1 5 11V9.5A3.5 3.5 0 0 1 8.5 6 3.5 3.5 0 0 1 12 2.5 3.5 3.5 0 0 1 15.5 6 3.5 3.5 0 0 1 19 9.5V11a3.5 3.5 0 0 1-3.5 3.5"/><path d="M12 2.5V21M8.5 14.5A3.5 3.5 0 0 0 12 18a3.5 3.5 0 0 0 3.5-3.5"/>',
    mcp: '<path d="M12 3v6M12 15v6M5.2 7.5l5.2 3M13.6 13l5.2 3M18.8 7.5l-5.2 3M10.4 13l-5.2 3"/><path d="M12 9.3 16 12l-4 2.7L8 12l4-2.7Z"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.5-4.5"/>',
    database: '<ellipse cx="12" cy="5" rx="7" ry="3"/><path d="M5 5v7c0 1.66 3.13 3 7 3s7-1.34 7-3V5"/><path d="M5 12v7c0 1.66 3.13 3 7 3s7-1.34 7-3v-7"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/>',
    cloud: '<path d="M17.5 18H8a5 5 0 1 1 1.2-9.85A6 6 0 0 1 20 12.5 3.5 3.5 0 0 1 17.5 18Z"/>',
    terminal: '<path d="m4 7 5 5-5 5M11 17h9"/><path d="M3 4h18v16H3z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  };

  const initialSettings = loadAToolsSettingsSync();
  const settingsSaveCoordinator = new SettingsSaveCoordinator(initialSettings, applyAndSaveAToolsSettings);
  const settingsSaveDebouncer = new SettingsSaveDebouncer(enqueueSettingsSave);
  registerSettingsSaveFlushOnDestroy(settingsSaveDebouncer);
  let lastSavedSettings: AToolsSettings = initialSettings;

  let activeMenu = $state<MenuId>("general");
  let activeShortcutTab = $state<ShortcutTabId>("global");
  let settingsConfirmRequest = $state<SettingsConfirmRequest | null>(null);
  let hydrated = $state(true);
  let saveState = $state<"idle" | "saving" | "saved" | "error">("saved");
  let saveRevision = 0;
  let dirty = false;
  let hotkey = $state(initialSettings.hotkey);
  let recordingHotkey = $state(false);
  let hotkeyRecorderMessage = $state("");
  let showHotkeyQuickActions = $state(false);
  let saveErrorMessage = $state("");
  let launchAtLogin = $state(initialSettings.launchAtLogin);
  let appShortcuts = $state<AppShortcutSetting[]>([...initialSettings.appShortcuts]);
  let appShortcutStatus = $state("已保存");
  let showTrayIcon = $state(initialSettings.showTrayIcon);
  let wakeupBlacklist = $state<string[]>([...initialSettings.wakeupBlacklist]);
  let wakeupBlacklistDraft = $state("");
  let wakeupBlacklistStatus = $state("");
  let theme = $state(initialSettings.theme);
  let primaryColor = $state<PrimaryColor>(initialSettings.primaryColor);
  let customColor = $state(initialSettings.customColor);
  let opacity = $state(initialSettings.opacity);
  let windowMaterial = $state(initialSettings.windowMaterial);
  let placeholder = $state(initialSettings.placeholder);
  let searchMode = $state(initialSettings.searchMode);
  let showRecentInSearch = $state(initialSettings.showRecentInSearch);
  let showMatchRecommendation = $state(initialSettings.showMatchRecommendation);
  let localAppSearch = $state(initialSettings.localAppSearch);
  let localLaunchSearch = $state(initialSettings.localLaunchSearch);
  let spaceOpenCommand = $state(initialSettings.spaceOpenCommand);
  let recentRows = $state(initialSettings.recentRows);
  let pinnedRows = $state(initialSettings.pinnedRows);
  let tabKeyFunction = $state(initialSettings.tabKeyFunction);
  let autoPaste = $state(initialSettings.autoPaste);
  let autoClear = $state(initialSettings.autoClear);
  let autoBackToSearch = $state(initialSettings.autoBackToSearch);
  let windowDefaultHeight = $state(initialSettings.windowDefaultHeight);
  let clipboardRetentionDays = $state(initialSettings.clipboardRetentionDays);
  let superPanelEnabled = $state(initialSettings.superPanelEnabled);
  let superPanelStatus = $state("");
  let floatingBallEnabled = $state(initialSettings.floatingBallEnabled);
  let floatingBallStatus = $state("");
  let proxyEnabled = $state(initialSettings.proxyEnabled);
  let proxyUrl = $state(initialSettings.proxyUrl);
  let pluginMarketCustom = $state(initialSettings.pluginMarketCustom);
  let pluginMarketUrl = $state(initialSettings.pluginMarketUrl);
  let pluginMarketTrustedPublicKeysText = $state(initialSettings.pluginMarketTrustedPublicKeys.join("\n"));
  let devToolsMode = $state(initialSettings.devToolsMode);
  let devtoolsStatus = $state("");
  let disableGpuAcceleration = $state(initialSettings.disableGpuAcceleration);
  let aiProvider = $state<AiProvider>(initialSettings.aiProvider);
  let aiBaseUrl = $state(initialSettings.aiBaseUrl);
  let aiDefaultModel = $state(initialSettings.aiDefaultModel);
  let aiApiKey = $state(initialSettings.aiApiKey);
  let aiTemperature = $state(initialSettings.aiTemperature);
  let aiUseForAgent = $state(initialSettings.aiUseForAgent);
  let aiTestingConnection = $state(false);
  let aiConnectionStatus = $state("");
  let aiLastConnection = $state<AiConnectionTestResult | null>(null);
  let webdavEnabled = $state(initialSettings.webdavEnabled);
  let webdavUrl = $state(initialSettings.webdavUrl);
  let webdavUsername = $state(initialSettings.webdavUsername);
  let webdavPassword = $state(initialSettings.webdavPassword);
  let webdavRemotePath = $state(initialSettings.webdavRemotePath);
  let webdavSyncSettings = $state(initialSettings.webdavSyncSettings);
  let webdavSyncPlugins = $state(initialSettings.webdavSyncPlugins);
  let webdavSyncClipboard = $state(initialSettings.webdavSyncClipboard);
  let webdavSyncing = $state(false);
  let webdavPreviewing = $state(false);
  let webdavPlanningRestore = $state(false);
  let webdavRestoringSettings = $state(false);
  let webdavRestoringClipboard = $state(false);
  let webdavRestoringPluginData = $state(false);
  let webdavSyncStatus = $state("");
  let webdavLastSync = $state<WebdavSyncSummary | null>(null);
  let webdavLastPreview = $state<WebdavBackupPreview | null>(null);
  let webdavLastRestorePlan = $state<WebdavRestorePlan | null>(null);
  let webdavLastSettingsRestore = $state<WebdavSettingsRestoreResult | null>(null);
  let webdavLastClipboardRestore = $state<WebdavClipboardRestoreResult | null>(null);
  let webdavLastPluginDataRestore = $state<WebdavPluginDataRestoreResult | null>(null);
  let webdavSelectedPluginConflictKeys = $state<string[]>([]);
  let mcpStatus = $state<McpServerStatus | null>(null);
  let agentTools = $state<ToolDefinition[]>([]);
  let agentScopePolicies = $state<AgentScopePolicy[]>([]);
  let pendingAgentRequests = $state<PendingAgentToolRequest[]>([]);
  let agentToolGrants = $state<AgentToolGrant[]>([]);
  let mcpRecentAudits = $state<AuditLogEntry[]>([]);
  let mcpPermissionMode = $state("conservative");
  let mcpLoading = $state(false);
  let mcpPolicyBusyKey = $state("");
  let mcpRequestBusyKey = $state("");
  let mcpPageStatus = $state("");
  let mcpInstallHomePath = $state("");
  let dataLoading = $state(false);
  let dataStatus = $state("");
  let auditArchiveBusy = $state(false);
  let auditPruneBusy = $state(false);
  let installedPlugins = $state<InstalledPlugin[]>([]);
  let pluginDataSummary = $state<PluginDataSummary[]>([]);
  let pluginsLoading = $state(false);
  let pluginsStatus = $state("");
  let busyPluginId = $state("");
  let selectedPluginId = $state<string | null>(null);
  let pluginPermissionPanelOpen = $state(false);
  let pluginRuntimePermissionGrantVersion = $state(0);
  let pluginFilterQuery = $state("");
  let pluginFilterStatus = $state<"all" | "enabled" | "disabled">("all");
  let pluginFilterSource = $state<"all" | "builtin" | "imported">("all");
  let pluginMarketLoading = $state(false);
  let pluginMarketStatusText = $state("");
  let pluginMarketCatalog = $state<PluginMarketCatalog | null>(null);
  let installingMarketPluginId = $state("");
  let selectedMarketPluginId = $state<string | null>(null);
  let pluginMarketProgress = $state<PluginMarketProgressEvent | null>(null);
  let pluginMarketOperationId = $state("");
  let pluginMarketRetryAction = $state<PluginMarketActionState | null>(null);
  let recentAudits = $state<AuditLogEntry[]>([]);
  let dataAuditOverview = $derived(auditDataOverview(recentAudits));
  let clipboardHistory = $state<ClipboardHistoryEntry[]>([]);
  let commandHistory = $state<CommandHistoryEntry[]>(loadCommandHistory());
  let debugLoading = $state(false);
  let debugStatus = $state("");
  let debugMcpStatus = $state<McpServerStatus | null>(null);
  let runtimeDiagnostics = $state<RuntimeDiagnostics | null>(null);
  let debugAudits = $state<AuditLogEntry[]>([]);
  let recentAuditErrors = $state<AuditLogEntry[]>([]);
  let crashLogs = $state<CrashLogEntry[]>([]);
  let aboutLoading = $state(false);
  let aboutPageStatus = $state("");
  let localLaunchEntries = $state<LocalLaunchEntry[]>(loadLocalLaunchEntries());
  let localLaunchStatus = $state("已保存");
  let webQuickOpenEntries = $state<WebQuickOpenEntry[]>(loadWebQuickOpenEntries());
  let webQuickOpenStatus = $state("已保存");
  let editingWebQuickOpenId = $state<string | null>(null);
  let webQuickOpenDraft = $state<WebQuickOpenEntry | null>(null);
  let webQuickOpenValidation = $state("");
  let commandAliases = $state<CommandAliasEntry[]>(loadCommandAliases());
  let commandAliasStatus = $state("已保存");
  let commandCenterPinnedCodes = $state<string[]>(loadPinnedCommandCodes());
  let commandCenterQuery = $state("");
  let commandCenterSourceFilter = $state<CommandCenterSourceFilter>("all");
  let commandCenterStatusFilter = $state<CommandCenterStatusFilter>("all");

  $effect(() => {
    activeMenu = initialMenu;
  });

  onMount(() => {
    let cancelled = false;
    let unlistenPluginMarketProgress: (() => void) | undefined;
    const loadTimeout = setTimeout(() => {
      if (hydrated) return;
      cancelled = true;
      hydrated = true;
      saveState = "saved";
      persistSoon();
    }, 800);

    loadAToolsSettings().then((settings) => {
      if (cancelled || dirty) return;
      clearTimeout(loadTimeout);
      applySettings(settings);
      settingsSaveCoordinator.hydrate(settings);
      lastSavedSettings = settingsSaveCoordinator.lastSaved();
      dispatchAToolsSettings(settings);
      hydrated = true;
      saveState = "saved";
    }).catch(() => {
      clearTimeout(loadTimeout);
      hydrated = true;
      saveState = "error";
    });
    loadMcpInstallHomePath();
    const onCommandHistoryUpdated = (event: Event) => {
      commandHistory = (event as CustomEvent<CommandHistoryEntry[]>).detail ?? loadCommandHistory();
    };
    window.addEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
    const onCommandAliasesUpdated = (event: Event) => {
      commandAliases = (event as CustomEvent<CommandAliasEntry[]>).detail ?? loadCommandAliases();
    };
    window.addEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
    const onPluginRuntimePermissionGrantsUpdated = () => {
      pluginRuntimePermissionGrantVersion += 1;
    };
    window.addEventListener(PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, onPluginRuntimePermissionGrantsUpdated);
    if (hasTauriRuntime()) {
      listen<PluginMarketProgressEvent>(PLUGIN_MARKET_PROGRESS_EVENT, (event) => handlePluginMarketProgress(event.payload))
        .then((stop) => {
          if (cancelled) {
            stop();
          } else {
            unlistenPluginMarketProgress = stop;
          }
        })
        .catch(() => {});
    }

    return () => {
      cancelled = true;
      clearTimeout(loadTimeout);
      window.removeEventListener(COMMAND_HISTORY_UPDATED_EVENT, onCommandHistoryUpdated);
      window.removeEventListener(COMMAND_ALIASES_UPDATED_EVENT, onCommandAliasesUpdated);
      window.removeEventListener(PLUGIN_RUNTIME_PERMISSION_GRANTS_UPDATED_EVENT, onPluginRuntimePermissionGrantsUpdated);
      unlistenPluginMarketProgress?.();
    };
  });

  $effect(() => {
    if (activeMenu === "mcp") {
      refreshMcpPage();
    } else if (activeMenu === "plugins") {
      refreshPluginsPage();
    } else if (activeMenu === "market") {
      refreshPluginMarketPage();
    } else if (activeMenu === "data") {
      refreshDataPage();
    } else if (activeMenu === "debug") {
      refreshDebugPage();
    } else if (activeMenu === "http") {
      refreshMcpPage();
    } else if (activeMenu === "about") {
      refreshAboutPage();
    }
  });

  function confirmSettingsAction(options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    tone?: "default" | "danger";
  }) {
    if (settingsConfirmRequest) {
      settingsConfirmRequest.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      settingsConfirmRequest = {
        title: options.title,
        message: options.message,
        confirmLabel: options.confirmLabel ?? "确认",
        cancelLabel: options.cancelLabel ?? "取消",
        tone: options.tone ?? "danger",
        resolve,
      };
    });
  }

  function resolveSettingsConfirm(confirmed: boolean) {
    const request = settingsConfirmRequest;
    if (!request) return;
    settingsConfirmRequest = null;
    request.resolve(confirmed);
  }

  function iconFor(name: IconName) {
    return iconMarkup[name];
  }

  function removeWakeupItem(index: number) {
    wakeupBlacklist = wakeupBlacklist.filter((_, i) => i !== index);
    persistSoon();
  }

  function addWakeupItem() {
    const next = addWakeupBlacklistItem(wakeupBlacklist, wakeupBlacklistDraft);
    wakeupBlacklistDraft = "";
    if (next.length === wakeupBlacklist.length) return;
    wakeupBlacklist = next;
    persistSoon();
  }

  function currentSettings(): AToolsSettings {
    return {
      hotkey,
      appShortcuts: normalizeAppShortcuts(appShortcuts),
      launchAtLogin,
      showTrayIcon,
      wakeupBlacklist: normalizeWakeupBlacklist(wakeupBlacklist),
      theme,
      primaryColor,
      customColor,
      opacity,
      windowMaterial: "none",
      placeholder,
      searchMode,
      showRecentInSearch,
      showMatchRecommendation,
      localAppSearch,
      localLaunchSearch,
      spaceOpenCommand,
      recentRows,
      pinnedRows,
      tabKeyFunction,
      autoPaste,
      autoClear,
      autoBackToSearch,
      windowDefaultHeight,
      clipboardRetentionDays,
      superPanelEnabled,
      floatingBallEnabled,
      proxyEnabled: proxyEnabled && Boolean(proxyUrl.trim()),
      proxyUrl,
      pluginMarketCustom: pluginMarketCustom && Boolean(pluginMarketUrl.trim()),
      pluginMarketUrl,
      pluginMarketTrustedPublicKeys: pluginMarketTrustedPublicKeysText
        .split(/\s+/)
        .map((key) => key.trim())
        .filter(Boolean),
      devToolsMode,
      disableGpuAcceleration: false,
      aiProvider,
      aiBaseUrl,
      aiDefaultModel,
      aiApiKey,
      aiTemperature,
      aiUseForAgent: aiProvider !== "disabled" && aiUseForAgent,
      webdavEnabled: webdavConfigReady() && webdavEnabled,
      webdavUrl,
      webdavUsername,
      webdavPassword,
      webdavRemotePath,
      webdavSyncSettings,
      webdavSyncPlugins,
      webdavSyncClipboard,
    };
  }

  function applySettings(settings: AToolsSettings) {
    hotkey = settings.hotkey;
    appShortcuts = [...settings.appShortcuts];
    appShortcutStatus = "已保存";
    launchAtLogin = settings.launchAtLogin;
    showTrayIcon = settings.showTrayIcon;
    wakeupBlacklist = normalizeWakeupBlacklist(settings.wakeupBlacklist);
    wakeupBlacklistDraft = "";
    theme = settings.theme;
    primaryColor = settings.primaryColor;
    customColor = settings.customColor;
    opacity = settings.opacity;
    windowMaterial = "none";
    placeholder = settings.placeholder;
    searchMode = settings.searchMode;
    showRecentInSearch = settings.showRecentInSearch;
    showMatchRecommendation = settings.showMatchRecommendation;
    localAppSearch = settings.localAppSearch;
    localLaunchSearch = settings.localLaunchSearch;
    spaceOpenCommand = settings.spaceOpenCommand;
    recentRows = settings.recentRows;
    pinnedRows = settings.pinnedRows;
    tabKeyFunction = settings.tabKeyFunction;
    autoPaste = settings.autoPaste;
    autoClear = settings.autoClear;
    autoBackToSearch = settings.autoBackToSearch;
    windowDefaultHeight = settings.windowDefaultHeight;
    clipboardRetentionDays = settings.clipboardRetentionDays;
    superPanelEnabled = settings.superPanelEnabled;
    superPanelStatus = "";
    floatingBallEnabled = settings.floatingBallEnabled;
    floatingBallStatus = "";
    proxyEnabled = settings.proxyEnabled;
    proxyUrl = settings.proxyUrl;
    pluginMarketCustom = settings.pluginMarketCustom;
    pluginMarketUrl = settings.pluginMarketUrl;
    pluginMarketTrustedPublicKeysText = settings.pluginMarketTrustedPublicKeys.join("\n");
    devToolsMode = settings.devToolsMode;
    disableGpuAcceleration = false;
    aiProvider = settings.aiProvider;
    aiBaseUrl = settings.aiBaseUrl;
    aiDefaultModel = settings.aiDefaultModel;
    aiApiKey = settings.aiApiKey;
    aiTemperature = settings.aiTemperature;
    aiUseForAgent = settings.aiUseForAgent;
    clearAiConnectionResult();
    webdavEnabled = settings.webdavEnabled;
    webdavUrl = settings.webdavUrl;
    webdavUsername = settings.webdavUsername;
    webdavPassword = settings.webdavPassword;
    webdavRemotePath = settings.webdavRemotePath;
    webdavSyncSettings = settings.webdavSyncSettings;
    webdavSyncPlugins = settings.webdavSyncPlugins;
    webdavSyncClipboard = settings.webdavSyncClipboard;
  }

  function restoreLastSavedSettings() {
    applySettings(lastSavedSettings);
    applyAToolsAppearance(lastSavedSettings);
    dispatchAToolsSettings(lastSavedSettings);
  }

  async function enqueueSettingsSave(settings: AToolsSettings, revision: number) {
    try {
      await settingsSaveCoordinator.enqueue(settings);
      lastSavedSettings = settingsSaveCoordinator.lastSaved();
      if (revision === saveRevision) {
        saveState = "saved";
        saveErrorMessage = "";
      }
    } catch (error) {
      lastSavedSettings = settingsSaveCoordinator.lastSaved();
      if (revision === saveRevision) {
        restoreLastSavedSettings();
        saveState = "error";
        saveErrorMessage = error instanceof Error ? error.message : String(error);
      }
      throw error;
    }
  }

  async function saveSettingsImmediately(settings: AToolsSettings) {
    settingsSaveDebouncer.discard();
    const revision = ++saveRevision;
    saveState = "saving";
    saveErrorMessage = "";
    await enqueueSettingsSave(settings, revision);
  }

  function scheduleSave(settings: AToolsSettings) {
    const revision = ++saveRevision;
    const validation = validateShortcut(settings.hotkey, hotkeyPlatform());
    if (!validation.valid) {
      saveState = "error";
      saveErrorMessage = validation.message;
      settingsSaveDebouncer.discard();
      return;
    }

    saveState = "saving";
    saveErrorMessage = "";
    settingsSaveDebouncer.schedule(settings, revision);
  }

  function persistSoon() {
    dirty = true;
    const settings = currentSettings();
    applyAToolsAppearance(settings);
    dispatchAToolsSettings(settings);
    scheduleSave(settings);
  }

  function updateAiProvider(value: AiProvider) {
    aiProvider = value;
    if (aiProvider === "disabled") {
      aiUseForAgent = false;
    }
    clearAiConnectionResult();
    persistSoon();
  }

  function aiProviderLabel() {
    return aiProviderOptions.find((option) => option.value === aiProvider)?.label ?? "关闭";
  }

  function aiBaseUrlPlaceholder() {
    if (aiProvider === "openai") return "https://api.openai.com/v1";
    if (aiProvider === "local") return "http://127.0.0.1:11434/v1";
    return "https://api.example.com/v1";
  }

  function aiConfigReady() {
    if (aiProvider === "disabled") return false;
    if (!aiDefaultModel.trim()) return false;
    if (aiProvider === "local") return Boolean(aiBaseUrl.trim());
    return Boolean(aiBaseUrl.trim() && aiApiKey.trim());
  }

  function clearAiConnectionResult() {
    aiLastConnection = null;
    aiConnectionStatus = "";
  }

  function persistAiConfigChange() {
    clearAiConnectionResult();
    persistSoon();
  }

  function aiConnectionButton() {
    return aiConnectionButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      provider: aiProvider,
      configReady: aiConfigReady(),
      testing: aiTestingConnection,
    });
  }

  function aiConnectionResultRows() {
    return aiConnectionRows(aiLastConnection);
  }

  function webdavConfigReady() {
    const url = webdavUrl.trim();
    if (!url || !webdavUsername.trim()) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function webdavStatusText() {
    if (webdavSyncing) return "同步中";
    if (webdavPreviewing) return "检查中";
    if (webdavPlanningRestore) return "计划中";
    if (webdavRestoringSettings) return "恢复中";
    if (webdavRestoringClipboard) return "导入中";
    if (webdavLastClipboardRestore) return "已导入";
    if (webdavLastSettingsRestore) return "已恢复";
    if (webdavLastRestorePlan?.items.length) return "有计划";
    if (webdavLastSync?.remote_manifest_verified) return "已同步";
    if (webdavLastPreview?.files.length) return "已检查";
    if (!webdavEnabled) return "未启用";
    if (!webdavConfigReady()) return "配置不完整";
    return "配置已保存";
  }

  function updateWebdavEnabled(value: boolean, input?: HTMLInputElement) {
    clearWebdavSyncResult();
    const nextValue = value && webdavConfigReady();
    webdavEnabled = nextValue;
    if (input) input.checked = nextValue;
    persistSoon();
  }

  function persistWebdavConfigChange() {
    clearWebdavSyncResult();
    if (!webdavConfigReady()) {
      webdavEnabled = false;
    }
    persistSoon();
  }

  function persistWebdavScopeChange() {
    clearWebdavSyncResult();
    persistSoon();
  }

  function clearWebdavSyncResult() {
    webdavLastSync = null;
    webdavLastPreview = null;
    webdavLastRestorePlan = null;
    webdavLastSettingsRestore = null;
    webdavLastClipboardRestore = null;
    webdavLastPluginDataRestore = null;
    webdavSelectedPluginConflictKeys = [];
    webdavSyncStatus = "";
  }

  function webdavScopeLabels() {
    return [
      webdavSyncSettings ? "设置" : "",
      webdavSyncPlugins ? "插件数据" : "",
      webdavSyncClipboard ? "剪贴板历史" : "",
    ].filter(Boolean);
  }

  function webdavSyncButton() {
    return webdavSyncButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
    });
  }

  function webdavPreviewButton() {
    return webdavPreviewButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
    });
  }

  function webdavRestorePlanButton() {
    return webdavRestorePlanButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
      planning: webdavPlanningRestore,
    });
  }

  function webdavSettingsRestoreButton() {
    return webdavSettingsRestoreButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
      planning: webdavPlanningRestore,
      restoring: webdavRestoringSettings,
      plan: webdavLastRestorePlan,
    });
  }

  function webdavClipboardRestoreButton() {
    return webdavClipboardRestoreButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
      planning: webdavPlanningRestore,
      restoring: webdavRestoringClipboard,
      plan: webdavLastRestorePlan,
    });
  }

  function webdavPluginDataRestoreButton() {
    return webdavPluginDataRestoreButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
      planning: webdavPlanningRestore,
      restoring: webdavRestoringPluginData,
      plan: webdavLastRestorePlan,
    });
  }

  function webdavPluginDataOverwriteButton() {
    return webdavPluginDataOverwriteButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
      planning: webdavPlanningRestore,
      restoring: webdavRestoringPluginData,
      plan: webdavLastRestorePlan,
    });
  }

  function webdavPluginDataSelectedOverwriteButton() {
    return webdavPluginDataSelectedOverwriteButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: webdavSyncing,
      previewing: webdavPreviewing,
      planning: webdavPlanningRestore,
      restoring: webdavRestoringPluginData,
      plan: webdavLastRestorePlan,
      selectedConflicts: webdavSelectedPluginConflicts().length,
    });
  }

  function webdavPluginConflicts(): WebdavPluginDataConflictDocument[] {
    return webdavLastRestorePlan?.items.find((item) => item.scope === "plugins")?.plugin_conflicts ?? [];
  }

  function webdavPluginConflictKey(conflict: WebdavPluginDataConflictDocument) {
    return `${conflict.plugin_id}\u0000${conflict.doc_id}`;
  }

  function webdavSelectedPluginConflicts() {
    const selected = new Set(webdavSelectedPluginConflictKeys);
    return webdavPluginConflicts()
      .filter((conflict) => selected.has(webdavPluginConflictKey(conflict)))
      .map((conflict) => ({
        plugin_id: conflict.plugin_id,
        doc_id: conflict.doc_id,
      }));
  }

  function toggleWebdavPluginConflict(conflict: WebdavPluginDataConflictDocument, checked: boolean) {
    const key = webdavPluginConflictKey(conflict);
    const selected = new Set(webdavSelectedPluginConflictKeys);
    if (checked) {
      selected.add(key);
    } else {
      selected.delete(key);
    }
    webdavSelectedPluginConflictKeys = Array.from(selected);
  }

  function selectAllWebdavPluginConflicts() {
    webdavSelectedPluginConflictKeys = webdavPluginConflicts().map(webdavPluginConflictKey);
  }

  function clearSelectedWebdavPluginConflicts() {
    webdavSelectedPluginConflictKeys = [];
  }

  function webdavStatusRows() {
    return webdavSyncRows({
      configReady: webdavConfigReady(),
      remotePath: webdavRemotePath,
      scopes: webdavScopeLabels(),
      summary: webdavLastSync,
    });
  }

  function webdavOverview() {
    return webdavOverviewCards({
      enabled: webdavEnabled && webdavConfigReady(),
      configReady: webdavConfigReady(),
      hasTauriRuntime: hasTauriRuntime(),
      remotePath: webdavRemotePath,
      scopes: webdavScopeLabels(),
      statusLabel: webdavStatusText(),
      hasPassword: Boolean(webdavPassword.trim()),
      lastSync: webdavLastSync,
      lastPreview: webdavLastPreview,
      lastRestorePlan: webdavLastRestorePlan,
    });
  }

  function webdavRemotePreviewRows() {
    return webdavPreviewRows(webdavLastPreview);
  }

  function webdavRemoteRestorePlanRows() {
    return webdavRestorePlanRows(webdavLastRestorePlan);
  }

  function webdavRemoteSettingsRestoreRows() {
    return webdavSettingsRestoreRows(webdavLastSettingsRestore);
  }

  function webdavRemoteClipboardRestoreRows() {
    return webdavClipboardRestoreRows(webdavLastClipboardRestore);
  }

  function webdavRemotePluginDataRestoreRows() {
    return webdavPluginDataRestoreRows(webdavLastPluginDataRestore);
  }

  async function testAiConnection() {
    const button = aiConnectionButton();
    if (button.disabled) {
      aiConnectionStatus = button.reason;
      return;
    }

    aiTestingConnection = true;
    aiConnectionStatus = "正在读取模型列表...";
    aiLastConnection = null;
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const result = await invoke<AiConnectionTestResult>("test_ai_connection", { settings });
      aiLastConnection = result;
      aiConnectionStatus = result.model_found
        ? `连接正常，已找到 ${result.model}`
        : `连接正常，但 ${result.model} 未出现在模型列表`;
    } catch (error) {
      aiLastConnection = null;
      aiConnectionStatus = error instanceof Error ? error.message : String(error);
    } finally {
      aiTestingConnection = false;
    }
  }

  async function syncWebdavNow() {
    const button = webdavSyncButton();
    if (button.disabled) {
      webdavSyncStatus = button.reason;
      return;
    }

    webdavSyncing = true;
    webdavSyncStatus = "正在上传 WebDAV 备份...";
    webdavLastSync = null;
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const summary = await invoke<WebdavSyncSummary>("sync_webdav_now", { settings });
      webdavLastSync = summary;
      webdavLastPreview = null;
      webdavLastRestorePlan = null;
      webdavLastSettingsRestore = null;
      webdavLastClipboardRestore = null;
      webdavLastPluginDataRestore = null;
      webdavSelectedPluginConflictKeys = [];
      webdavSyncStatus = `已上传 ${summary.files_uploaded.length} 个文件，远端 manifest 已验证`;
    } catch (error) {
      webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      webdavSyncing = false;
    }
  }

  async function previewWebdavBackup() {
    const button = webdavPreviewButton();
    if (button.disabled) {
      webdavSyncStatus = button.reason;
      return;
    }

    webdavPreviewing = true;
    webdavSyncStatus = "正在检查远端 WebDAV 备份...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const preview = await invoke<WebdavBackupPreview>("preview_webdav_backup", { settings });
      webdavLastPreview = preview;
      webdavLastRestorePlan = null;
      webdavLastSettingsRestore = null;
      webdavLastClipboardRestore = null;
      webdavLastPluginDataRestore = null;
      webdavSelectedPluginConflictKeys = [];
      webdavSyncStatus = `已检查远端备份，发现 ${preview.files.length} 个文件`;
    } catch (error) {
      webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      webdavPreviewing = false;
    }
  }

  async function planWebdavRestore() {
    const button = webdavRestorePlanButton();
    if (button.disabled) {
      webdavSyncStatus = button.reason;
      return;
    }

    webdavPlanningRestore = true;
    webdavSyncStatus = "正在生成 WebDAV 恢复计划...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const plan = await invoke<WebdavRestorePlan>("plan_webdav_restore", { settings });
      webdavLastRestorePlan = plan;
      webdavLastSettingsRestore = null;
      webdavLastClipboardRestore = null;
      webdavLastPluginDataRestore = null;
      webdavSelectedPluginConflictKeys = [];
      webdavSyncStatus = `已生成恢复计划，包含 ${plan.items.length} 个范围`;
    } catch (error) {
      webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      webdavPlanningRestore = false;
    }
  }

  function webdavSettingsRestoreConfirmText() {
    const settingsItem = webdavLastRestorePlan?.items.find((item) => item.scope === "settings");
    const changed = settingsItem?.changed_keys.length
      ? settingsItem.changed_keys.join("、")
      : "远端设置";
    const skipped = settingsItem?.skipped_keys.length
      ? `\n将跳过脱敏字段：${settingsItem.skipped_keys.join("、")}`
      : "";
    return `确定从远端 WebDAV 备份恢复设置？\n将恢复：${changed}${skipped}\n插件数据和剪贴板历史不会写入本机。`;
  }

  async function restoreWebdavSettings() {
    const button = webdavSettingsRestoreButton();
    if (button.disabled) {
      webdavSyncStatus = button.reason;
      return;
    }
    if (!await confirmSettingsAction({
      title: "恢复 WebDAV 设置",
      message: webdavSettingsRestoreConfirmText(),
      confirmLabel: "恢复设置",
    })) {
      webdavSyncStatus = "已取消恢复设置";
      return;
    }

    webdavRestoringSettings = true;
    webdavSyncStatus = "正在恢复 WebDAV 设置...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const result = await invoke<WebdavSettingsRestoreResult>("restore_webdav_settings", {
        settings,
        confirmed: true,
      });
      const restoredSettings = normalizeSettings(result.merged_settings as Partial<AToolsSettings>);
      const hotkeyValidation = validateShortcut(restoredSettings.hotkey, hotkeyPlatform());
      if (!hotkeyValidation.valid) {
        throw new Error(`远端快捷键不可用：${hotkeyValidation.message}`);
      }
      applySettings(restoredSettings);
      applyAToolsAppearance(restoredSettings);
      dispatchAToolsSettings(restoredSettings);
      await saveSettingsImmediately(restoredSettings);
      webdavLastSettingsRestore = result;
      webdavSyncStatus = `已恢复 ${result.applied_keys.length} 个设置项，跳过 ${result.skipped_keys.length} 个脱敏字段`;
    } catch (error) {
      webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      webdavRestoringSettings = false;
    }
  }

  function webdavClipboardRestoreConfirmText() {
    const clipboardItem = webdavLastRestorePlan?.items.find((item) => item.scope === "clipboard");
    const summary = clipboardItem
      ? `${clipboardItem.local_summary} -> ${clipboardItem.remote_summary}`
      : "远端剪贴板历史";
    return `确定从远端 WebDAV 备份导入剪贴板历史？\n${summary}\n本操作只追加本机缺失的文本历史，不会清空或覆盖现有剪贴板历史。`;
  }

  async function restoreWebdavClipboardHistory() {
    const button = webdavClipboardRestoreButton();
    if (button.disabled) {
      webdavSyncStatus = button.reason;
      return;
    }
    if (!await confirmSettingsAction({
      title: "导入剪贴板历史",
      message: webdavClipboardRestoreConfirmText(),
      confirmLabel: "导入剪贴板",
    })) {
      webdavSyncStatus = "已取消导入剪贴板历史";
      return;
    }

    webdavRestoringClipboard = true;
    webdavSyncStatus = "正在导入 WebDAV 剪贴板历史...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const result = await invoke<WebdavClipboardRestoreResult>("restore_webdav_clipboard_history", {
        settings,
        confirmed: true,
      });
      webdavLastClipboardRestore = result;
      clipboardHistory = await invoke<ClipboardHistoryEntry[]>("list_clipboard_history", { query: "", limit: 20 });
      webdavSyncStatus = `已导入 ${result.imported_entries} 条剪贴板历史，跳过 ${result.skipped_entries} 条`;
    } catch (error) {
      webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      webdavRestoringClipboard = false;
    }
  }

  type WebdavPluginDataRestoreMode = "append_missing" | "overwrite_conflicts" | "overwrite_selected_conflicts";

  function webdavPluginDataRestoreConfirmText(mode: WebdavPluginDataRestoreMode) {
    const pluginItem = webdavLastRestorePlan?.items.find((item) => item.scope === "plugins");
    const summary = pluginItem
      ? `${pluginItem.local_summary} -> ${pluginItem.remote_summary}`
      : "远端插件数据";
    if (mode === "overwrite_conflicts") {
      return `确定从远端 WebDAV 备份覆盖插件数据冲突？\n${summary}\n本操作会导入缺失文档，并用远端文档覆盖本机同 ID 冲突文档；本机不存在的插件仍会跳过。`;
    }
    if (mode === "overwrite_selected_conflicts") {
      const selectedCount = webdavSelectedPluginConflicts().length;
      return `确定从远端 WebDAV 备份覆盖已选插件数据冲突？\n${summary}\n本操作会导入缺失文档，并只用远端文档覆盖已勾选的 ${selectedCount} 条同 ID 冲突文档；未勾选冲突和本机不存在的插件会跳过。`;
    }
    return `确定从远端 WebDAV 备份导入插件数据？\n${summary}\n本操作只追加本机已安装插件缺失的文档；同 ID 冲突文档会跳过，不会覆盖本机插件数据。`;
  }

  async function restoreWebdavPluginData(mode: WebdavPluginDataRestoreMode = "append_missing") {
    const button = mode === "overwrite_selected_conflicts"
      ? webdavPluginDataSelectedOverwriteButton()
      : mode === "overwrite_conflicts"
        ? webdavPluginDataOverwriteButton()
        : webdavPluginDataRestoreButton();
    if (button.disabled) {
      webdavSyncStatus = button.reason;
      return;
    }
    if (!await confirmSettingsAction({
      title: mode === "append_missing" ? "导入插件数据" : "覆盖插件数据冲突",
      message: webdavPluginDataRestoreConfirmText(mode),
      confirmLabel: mode === "overwrite_selected_conflicts"
        ? "覆盖选中冲突"
        : mode === "overwrite_conflicts"
          ? "覆盖冲突数据"
          : "导入插件数据",
    })) {
      webdavSyncStatus = mode === "append_missing" ? "已取消导入插件数据" : "已取消覆盖插件数据冲突";
      return;
    }

    webdavRestoringPluginData = true;
    webdavSyncStatus = mode === "append_missing" ? "正在导入 WebDAV 插件数据..." : "正在覆盖 WebDAV 插件数据冲突...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const request = mode === "overwrite_selected_conflicts"
        ? {
            settings,
            confirmed: true,
            mode: "overwrite_selected_conflicts",
            selectedConflictDocuments: webdavSelectedPluginConflicts(),
          }
        : mode === "overwrite_conflicts"
          ? { settings, confirmed: true, mode: "overwrite_conflicts" }
          : { settings, confirmed: true, mode: "append_missing" };
      const result = await invoke<WebdavPluginDataRestoreResult>("restore_webdav_plugin_data", request);
      webdavLastPluginDataRestore = result;
      if (activeMenu === "data") {
        await refreshDataPage();
      }
      webdavSyncStatus = result.overwritten_documents > 0
        ? `已导入 ${result.imported_documents} 条插件数据，覆盖 ${result.overwritten_documents} 条冲突，跳过 ${result.skipped_documents} 条`
        : `已导入 ${result.imported_documents} 条插件数据，跳过 ${result.skipped_documents} 条`;
    } catch (error) {
      webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      webdavRestoringPluginData = false;
    }
  }

  function hotkeyPlatform(): HotkeyPlatform {
    const platform = navigator.platform.toLowerCase();
    if (platform.includes("mac")) return "mac";
    if (platform.includes("win")) return "windows";
    return "linux";
  }

  function hotkeyPresets() {
    return hotkeyPresetsForPlatform(hotkeyPlatform());
  }

  function defaultHotkey() {
    return defaultHotkeyForPlatform(hotkeyPlatform());
  }

  function startHotkeyRecording() {
    showHotkeyQuickActions = false;
    recordingHotkey = true;
    hotkeyRecorderMessage = recordingHint(hotkeyPlatform());
  }

  function toggleHotkeyQuickActions() {
    recordingHotkey = false;
    showHotkeyQuickActions = !showHotkeyQuickActions;
  }

  function applyHotkeyPreset(shortcut: string) {
    const validation = validateShortcut(shortcut, hotkeyPlatform());
    if (!validation.valid) {
      hotkeyRecorderMessage = validation.message;
      showHotkeyQuickActions = false;
      return;
    }
    hotkey = shortcut;
    recordingHotkey = false;
    showHotkeyQuickActions = false;
    hotkeyRecorderMessage = `已选择 ${shortcut}`;
    persistSoon();
  }

  function recordHotkeyFromWindow(event: KeyboardEvent) {
    if (!recordingHotkey) return;
    event.preventDefault();
    event.stopPropagation();

    if (isCancelKey(event)) {
      recordingHotkey = false;
      hotkeyRecorderMessage = "已取消快捷键录制";
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event, hotkeyPlatform());
    if (!shortcut) {
      hotkeyRecorderMessage = "请同时按下修饰键和主键";
      return;
    }
    const validation = validateShortcut(shortcut, hotkeyPlatform());
    if (!validation.valid) {
      hotkeyRecorderMessage = validation.message;
      return;
    }

    hotkey = shortcut;
    recordingHotkey = false;
    hotkeyRecorderMessage = `已录制 ${shortcut}`;
    persistSoon();
  }

  function onSettingsWindowKeydown(event: KeyboardEvent) {
    if (webQuickOpenDraft && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      closeWebQuickOpenEditor();
      return;
    }
    recordHotkeyFromWindow(event);
  }

  async function addCurrentWindowToWakeupBlacklist() {
    wakeupBlacklistStatus = "";
    if (!hasTauriRuntime()) {
      wakeupBlacklistStatus = "浏览器预览模式无法读取当前窗口";
      return;
    }
    try {
      const appName = await invoke<string | null>("read_frontmost_app_name");
      const value = appName?.trim();
      if (!value) {
        wakeupBlacklistStatus = "当前没有可添加的前台应用";
        return;
      }
      const next = addWakeupBlacklistItem(wakeupBlacklist, value);
      if (next.length === wakeupBlacklist.length) {
        wakeupBlacklistStatus = `${value} 已在黑名单中`;
        return;
      }
      wakeupBlacklist = next;
      wakeupBlacklistStatus = `已添加 ${value}`;
      persistSoon();
    } catch (error) {
      wakeupBlacklistStatus = String(error);
    }
  }

  function hotkeyStatusText() {
    return recordingHotkey || hotkeyRecorderMessage ? hotkeyRecorderMessage : shortcutSaveText();
  }

  async function refreshMcpPage() {
    mcpLoading = true;
    mcpPageStatus = "";
    if (!hasTauriRuntime()) {
      mcpStatus = null;
      agentTools = [];
      agentScopePolicies = [];
      pendingAgentRequests = [];
      agentToolGrants = [];
      mcpRecentAudits = [];
      mcpPermissionMode = "conservative";
      mcpPageStatus = "Tauri 运行时未连接，MCP 状态需在桌面应用中查看";
      mcpLoading = false;
      return;
    }
    try {
      const [status, tools, mode, policies, pendingRequests, grants, audits] = await Promise.all([
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<ToolDefinition[]>("list_agent_tools"),
        invoke<string>("get_permission_mode"),
        invoke<AgentScopePolicy[]>("list_agent_scope_policies"),
        invoke<PendingAgentToolRequest[]>("list_pending_agent_requests"),
        invoke<AgentToolGrant[]>("list_agent_tool_grants"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 8 }),
      ]);
      mcpStatus = status;
      agentTools = tools;
      mcpPermissionMode = mode;
      agentScopePolicies = policies;
      pendingAgentRequests = pendingRequests;
      agentToolGrants = grants;
      mcpRecentAudits = audits;
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpLoading = false;
    }
  }

  async function toggleAgentTool(tool: ToolDefinition, enabled: boolean) {
    mcpPageStatus = `正在${enabled ? "启用" : "停用"} ${tool.name}`;
    try {
      await invoke("set_agent_tool_enabled", { name: tool.name, enabled });
      await refreshMcpPage();
      mcpPageStatus = `${tool.name} 已${enabled ? "启用" : "停用"}`;
    } catch (error) {
      mcpPageStatus = String(error);
    }
  }

  async function updateMcpPermissionMode(mode: string) {
    mcpPermissionMode = mode;
    if (!hasTauriRuntime()) {
      mcpPageStatus = "权限模式需在桌面应用中保存";
      return;
    }
    mcpPolicyBusyKey = "permission-mode";
    mcpPageStatus = `正在切换权限模式为 ${permissionModeLabel(mode)}`;
    try {
      await invoke("set_permission_mode", { mode });
      await refreshMcpPage();
      mcpPageStatus = `权限模式已切换为 ${permissionModeLabel(mode)}`;
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpPolicyBusyKey = "";
    }
  }

  async function updateMcpScopePolicy(scope: string, decision: string) {
    if (!hasTauriRuntime()) {
      mcpPageStatus = "Scope 策略需在桌面应用中保存";
      return;
    }
    mcpPolicyBusyKey = `scope:${scope}`;
    const label = mcpScopePolicyRows(agentScopePolicies).find((row) => row.scope === scope)?.label ?? scope;
    try {
      agentScopePolicies = await invoke<AgentScopePolicy[]>("set_agent_scope_policy", { scope, decision });
      mcpPageStatus = `${label} 已设置为${decision === "deny" ? "阻断" : "确认"}`;
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpPolicyBusyKey = "";
    }
  }

  async function approveMcpRequestOnce(request: PendingAgentToolRequest) {
    if (!hasTauriRuntime()) {
      mcpPageStatus = "待确认请求需在桌面应用中处理";
      return;
    }
    mcpRequestBusyKey = `pending:${request.id}`;
    try {
      await invoke("call_agent_tool", {
        name: request.tool_name,
        arguments: request.arguments,
        clientId: request.client_id,
        confirmed: true,
      });
      mcpPageStatus = `${request.tool_name} 已允许一次`;
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      await invoke("dismiss_pending_agent_request", { requestId: request.id }).catch(() => {});
      await refreshMcpPage();
      mcpRequestBusyKey = "";
    }
  }

  async function approveAndRememberMcpRequest(request: PendingAgentToolRequest) {
    if (!hasTauriRuntime()) {
      mcpPageStatus = "待确认请求需在桌面应用中处理";
      return;
    }
    mcpRequestBusyKey = `pending:${request.id}`;
    try {
      await invoke("grant_agent_tool", {
        clientId: request.client_id,
        toolName: request.tool_name,
      });
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      mcpPageStatus = `${request.client_id} 已持久授权 ${request.tool_name}`;
      await refreshMcpPage();
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpRequestBusyKey = "";
    }
  }

  async function dismissMcpRequest(request: PendingAgentToolRequest) {
    if (!hasTauriRuntime()) {
      mcpPageStatus = "待确认请求需在桌面应用中处理";
      return;
    }
    mcpRequestBusyKey = `pending:${request.id}`;
    try {
      await invoke("dismiss_pending_agent_request", { requestId: request.id });
      mcpPageStatus = `${request.tool_name} 请求已拒绝`;
      await refreshMcpPage();
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpRequestBusyKey = "";
    }
  }

  async function revokeMcpGrant(grant: AgentToolGrant) {
    if (!hasTauriRuntime()) {
      mcpPageStatus = "持久授权需在桌面应用中处理";
      return;
    }
    mcpRequestBusyKey = `grant:${grant.client_id}:${grant.tool_name}`;
    try {
      await invoke("revoke_agent_tool", {
        clientId: grant.client_id,
        toolName: grant.tool_name,
      });
      mcpPageStatus = `${grant.client_id} 的 ${grant.tool_name} 授权已撤销`;
      await refreshMcpPage();
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpRequestBusyKey = "";
    }
  }

  async function copyMcpConfig() {
    const config = buildMcpClientConfig({ status: mcpStatus });
    await copyText(mcpClientConfigText(config));
    mcpPageStatus = "已复制 MCP 客户端配置";
  }

  async function copyMcpTemplate(template: McpClientTemplate) {
    await copyText(mcpClientTemplateText(template));
    mcpPageStatus = `已复制 ${template.label} 配置`;
  }

  async function installMcpTemplate(template: McpClientTemplate) {
    if (!hasTauriRuntime()) {
      mcpPageStatus = "需在桌面应用中选择并合并配置文件";
      return;
    }
    const homePath = mcpInstallHomePath || await safeHomePath();
    mcpInstallHomePath = homePath;
    const defaultPath = mcpClientSuggestedTargetPath(template, { homePath });
    const targetPath = await saveDialog({
      title: "选择或新建 MCP 配置 JSON",
      defaultPath,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!targetPath) {
      mcpPageStatus = "已取消合并";
      return;
    }

    mcpRequestBusyKey = `mcp:install:${template.id}`;
    try {
      const result = await invoke<McpClientConfigInstallResult>("install_mcp_client_config", {
        targetPath,
        config: template.config,
        serverName: "atools",
        confirmed: true,
      });
      mcpPageStatus = mcpClientInstallResultText(template, result);
    } catch (error) {
      mcpPageStatus = String(error);
    } finally {
      mcpRequestBusyKey = "";
    }
  }

  async function copyHttpMcpUrl() {
    const connection = mcpConnection();
    if (!connection.tokenAvailable) {
      mcpPageStatus = "HTTP MCP 未就绪，无法复制地址";
      return;
    }
    await copyText(connection.httpUrl);
    mcpPageStatus = "已复制 MCP 地址";
  }

  async function copyHttpMcpConfig() {
    const config = buildMcpClientConfig({ status: mcpStatus ?? debugMcpStatus });
    await copyText(mcpClientConfigText(config));
    mcpPageStatus = "已复制 MCP 配置";
  }

  async function refreshAboutPage() {
    aboutLoading = true;
    aboutPageStatus = "";
    commandHistory = loadCommandHistory();
    localLaunchEntries = loadLocalLaunchEntries();
    webQuickOpenEntries = loadWebQuickOpenEntries();
    commandAliases = loadCommandAliases();
    if (!hasTauriRuntime()) {
      mcpStatus = null;
      debugMcpStatus = null;
      agentTools = [];
      runtimeDiagnostics = null;
      debugAudits = [];
      recentAuditErrors = [];
      crashLogs = [];
      aboutPageStatus = "浏览器预览模式，桌面路径和运行事件需在 macOS 应用中查看";
      aboutLoading = false;
      return;
    }
    try {
      const [status, tools, runtime, audits, crashes] = await Promise.all([
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<ToolDefinition[]>("list_agent_tools"),
        invoke<RuntimeDiagnostics>("get_runtime_diagnostics"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 30 }),
        invoke<CrashLogEntry[]>("list_crash_logs", { limit: 20 }),
      ]);
      mcpStatus = status;
      debugMcpStatus = status;
      agentTools = tools;
      runtimeDiagnostics = runtime;
      debugAudits = audits;
      recentAuditErrors = audits.filter((audit) => audit.error || audit.status !== "success").slice(0, 5);
      crashLogs = crashes;
      aboutPageStatus = "运行信息已刷新";
    } catch (error) {
      aboutPageStatus = String(error);
    } finally {
      aboutLoading = false;
    }
  }

  async function copyAboutRuntimeInfo() {
    await copyText(aboutRuntimeInfoText());
    aboutPageStatus = "已复制运行信息";
  }

  async function copyAboutDiagnosticBundle() {
    await copyText(diagnosticBundleText(currentDiagnosticBundle()));
    aboutPageStatus = "已复制脱敏诊断包";
  }

  function mcpTemplates() {
    return mcpClientTemplates({ status: mcpStatus });
  }

  function mcpInstallPlan(template: McpClientTemplate) {
    return mcpClientInstallPlan(template, { homePath: mcpInstallHomePath });
  }

  async function loadMcpInstallHomePath() {
    if (!hasTauriRuntime()) return;
    mcpInstallHomePath = await safeHomePath();
  }

  function mcpConnection() {
    return mcpConnectionView(mcpStatus);
  }

  function mcpGovernance() {
    return mcpGovernanceOverview({
      tools: agentTools,
      scopePolicies: agentScopePolicies,
      pendingRequestCount: pendingAgentRequests.length,
      permissionMode: mcpPermissionMode,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function mcpScopeRows() {
    return mcpScopePolicyRows(agentScopePolicies);
  }

  function mcpPendingRows() {
    return mcpPendingRequestRows(pendingAgentRequests);
  }

  function mcpGrantListRows() {
    return mcpGrantRows(agentToolGrants);
  }

  function mcpAuditListRows() {
    return mcpAuditRows(mcpRecentAudits);
  }

  function mcpHttpUrl() {
    return mcpConnection().httpUrl;
  }

  function pluginMarketPageStatus() {
    return buildPluginMarketStatus({
      installedPluginCount: installedPlugins.length,
      hasTauriRuntime: hasTauriRuntime(),
      customMarketEnabled: pluginMarketCustom,
      customMarketUrl: pluginMarketUrl,
      remoteCatalogLoaded: Boolean(pluginMarketCatalog),
      remotePluginCount: pluginMarketCatalog?.plugins.length ?? 0,
      remoteRatedPluginCount: pluginMarketCatalog?.plugins.filter((plugin) => plugin.rating || plugin.rating_count).length ?? 0,
      remoteSignedPluginCount: pluginMarketCatalog?.plugins.filter((plugin) => plugin.signature && plugin.public_key).length ?? 0,
      remoteTrustedPluginCount: pluginMarketCatalog?.plugins.filter((plugin) =>
        plugin.signature && plugin.public_key && pluginMarketPublicKeyTrusted(plugin)
      ).length ?? 0,
    });
  }

  function pluginMarketOverview(status: ReturnType<typeof pluginMarketPageStatus>) {
    return pluginMarketOverviewCards(status);
  }

  function marketCatalogInstalledPlugin(plugin: PluginMarketCatalogPlugin) {
    return installedPlugins.find((installed) => installed.id === plugin.id) ?? null;
  }

  function marketCatalogActionLabel(plugin: PluginMarketCatalogPlugin) {
    const installed = marketCatalogInstalledPlugin(plugin);
    if (!installed) return "安装";
    return installed.version === plugin.version ? "重装" : "更新";
  }

  function marketCatalogBusyLabel(plugin: PluginMarketCatalogPlugin) {
    const label = marketCatalogActionLabel(plugin);
    return `${label}中`;
  }

  function marketCatalogChecksumLabel(plugin: MarketCatalogDetailPlugin) {
    return plugin.checksum ? "SHA-256 已校验" : "未提供校验";
  }

  function pluginMarketPublicKeyTrusted(plugin: MarketCatalogDetailPlugin) {
    const publicKey = plugin.public_key?.trim();
    if (!publicKey) return false;
    return pluginMarketTrustedPublicKeysText
      .split(/\s+/)
      .map((key) => key.trim())
      .filter(Boolean)
      .includes(publicKey);
  }

  function handlePluginMarketProgress(event: PluginMarketProgressEvent) {
    if (pluginMarketOperationId && event.operation_id && event.operation_id !== pluginMarketOperationId) return;
    pluginMarketProgress = event;
    if (event.stage === "retrying") {
      pluginMarketStatusText = `${event.message}（第 ${event.attempt + 1}/${event.max_attempts} 次）`;
    } else if (event.stage === "cancelled") {
      pluginMarketStatusText = "插件市场任务已取消";
    }
  }

  function formatPluginMarketBytes(bytes: number) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    if (bytes < 1024) return `${Math.round(bytes)} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function marketProgressLabel() {
    if (!pluginMarketProgress) return "等待开始";
    const percent = typeof pluginMarketProgress.percent === "number"
      ? `${Math.round(pluginMarketProgress.percent)}%`
      : null;
    const attempt = pluginMarketProgress.max_attempts > 1
      ? `第 ${pluginMarketProgress.attempt}/${pluginMarketProgress.max_attempts} 次`
      : "";
    const total = pluginMarketProgress.total_bytes
      ? ` / ${formatPluginMarketBytes(pluginMarketProgress.total_bytes)}`
      : "";
    const downloaded = formatPluginMarketBytes(pluginMarketProgress.downloaded_bytes);
    const progress = percent
      ? `${pluginMarketProgress.message} · ${percent} · ${downloaded}${total}`
      : `${pluginMarketProgress.message} · ${downloaded}${total}`;
    return attempt ? `${progress} · ${attempt}` : progress;
  }

  function nextPluginMarketOperationId(plugin: PluginMarketCatalogPlugin) {
    return `plugin-market-${plugin.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function selectedMarketCatalogPlugin() {
    if (!pluginMarketCatalog) return null;
    return pluginMarketCatalog.plugins.find((plugin) => plugin.id === selectedMarketPluginId) ?? pluginMarketCatalog.plugins[0] ?? null;
  }

  function openMarketCatalogDetails(plugin: PluginMarketCatalogPlugin) {
    selectedMarketPluginId = plugin.id;
  }

  function pluginInventoryPage() {
    return buildPluginInventory(installedPlugins, {
      selectedPluginId,
      query: pluginFilterQuery,
      status: pluginFilterStatus,
      source: pluginFilterSource,
    });
  }

  function pluginInventoryOverview(inventory: ReturnType<typeof pluginInventoryPage>) {
    return pluginInventoryOverviewCards({
      inventory,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  async function refreshPluginsPage() {
    pluginsStatus = "";
    if (!hasTauriRuntime()) {
      installedPlugins = [];
      pluginsStatus = "Tauri 运行时未连接，已安装插件需在桌面应用中查看";
      return;
    }
    pluginsLoading = true;
    try {
      installedPlugins = await invoke<InstalledPlugin[]>("list_plugins");
      const ids = new Set(installedPlugins.map((plugin) => plugin.id));
      if (selectedPluginId && !ids.has(selectedPluginId)) {
        selectedPluginId = null;
        pluginPermissionPanelOpen = false;
      }
      pluginsStatus = `已读取 ${installedPlugins.length} 个插件`;
    } catch (error) {
      pluginsStatus = hasTauriRuntime() ? String(error) : "Tauri 运行时未连接，已安装插件需在桌面应用中查看";
    } finally {
      pluginsLoading = false;
    }
  }

  async function installPluginFromDirectory() {
    pluginsStatus = "";
    if (!hasTauriRuntime()) {
      pluginsStatus = "浏览器预览模式无法安装插件";
      return;
    }
    pluginsLoading = true;
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "选择包含 plugin.json 的插件目录",
      });
      const selectedPath = selectedPluginInstallPath(selected);
      if (!selectedPath) {
        pluginsStatus = "已取消安装插件";
        return;
      }
      pluginsStatus = "正在安装插件";
      const plugin = await invoke("install_plugin", { path: selectedPath }) as InstalledPlugin;
      selectedPluginId = plugin.id;
      pluginPermissionPanelOpen = false;
      await refreshPluginsPage();
      pluginsStatus = `已安装 ${plugin.name || plugin.id}`;
    } catch (error) {
      pluginsStatus = String(error);
    } finally {
      pluginsLoading = false;
    }
  }

  function selectedPluginInstallPath(value: string | string[] | null): string {
    if (Array.isArray(value)) return value[0] ?? "";
    return value ?? "";
  }

  function selectInstalledPlugin(pluginId: string) {
    selectedPluginId = pluginId;
    pluginPermissionPanelOpen = false;
  }

  async function updateInstalledPluginFromDirectory(plugin: { id: string; title: string; sourceLabel: string }) {
    if (plugin.sourceLabel !== "导入") {
      pluginsStatus = "内置插件随应用更新，不能从设置页替换";
      return;
    }
    if (!hasTauriRuntime()) {
      pluginsStatus = "浏览器预览模式无法更新插件";
      return;
    }
    busyPluginId = plugin.id;
    pluginsStatus = "正在选择插件更新目录";
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: `选择 ${plugin.title} 的更新目录`,
      });
      const selectedPath = selectedPluginInstallPath(selected);
      if (!selectedPath) {
        pluginsStatus = "已取消更新插件";
        return;
      }
      pluginsStatus = "正在更新插件";
      const updated = await invoke("update_plugin_from_path", { pluginId: plugin.id, path: selectedPath }) as InstalledPlugin;
      selectedPluginId = updated.id;
      pluginPermissionPanelOpen = false;
      await refreshPluginsPage();
      pluginsStatus = `已更新 ${updated.name || updated.id}`;
    } catch (error) {
      pluginsStatus = String(error);
    } finally {
      busyPluginId = "";
    }
  }

  async function toggleInstalledPlugin(pluginId: string, enabled: boolean) {
    busyPluginId = pluginId;
    pluginsStatus = `正在${enabled ? "启用" : "停用"}插件`;
    try {
      await invoke("toggle_plugin", { pluginId, enabled });
      await refreshPluginsPage();
      pluginsStatus = `插件已${enabled ? "启用" : "停用"}`;
    } catch (error) {
      pluginsStatus = String(error);
    } finally {
      busyPluginId = "";
    }
  }

  async function authorizeInstalledPlugin(plugin: { id: string; title?: string; name?: string }) {
    const title = plugin.title || plugin.name || plugin.id;
    if (!hasTauriRuntime()) {
      pluginsStatus = "浏览器预览模式无法授权启用插件";
      return;
    }
    const inventory = pluginInventoryPage();
    const permissionRows = inventory.selectedPlugin?.id === plugin.id
      ? inventory.selectedPlugin.permissionRows
      : [];
    const permissionSummary = permissionRows.length
      ? permissionRows.map((row) => `${row.label}: ${row.value}`).join("；")
      : "请先查看插件权限/能力审计";
    if (!(await confirmSettingsAction({
      title: "授权启用插件",
      message: `${title} 将启用并进入主搜索。确认 manifest 权限：${permissionSummary}。启用后插件声明的 Agent tools 会同步到 Agent/MCP 白名单，但默认仍需单独启用。确认继续？`,
      confirmLabel: "授权启用",
      tone: "danger",
    }))) {
      pluginsStatus = `已取消授权启用 ${title}`;
      return;
    }
    busyPluginId = plugin.id;
    pluginsStatus = "正在授权启用插件";
    try {
      const authorized = await invoke<InstalledPlugin>("authorize_plugin_permissions", { pluginId: plugin.id });
      selectedPluginId = authorized.id;
      await refreshPluginsPage();
      pluginsStatus = `已授权启用 ${authorized.name || authorized.id}`;
    } catch (error) {
      pluginsStatus = String(error);
    } finally {
      busyPluginId = "";
    }
  }

  function selectedPluginRuntimePermissionGrants(pluginId: string | null | undefined, version = pluginRuntimePermissionGrantVersion) {
    void version;
    return pluginRuntimePermissionGrantList(pluginId || "");
  }

  function clearSelectedPluginRuntimePermissionGrants(pluginId: string | null | undefined) {
    if (!pluginId) return;
    const cleared = clearPluginRuntimePermissionGrants(pluginId);
    pluginRuntimePermissionGrantVersion += 1;
    pluginsStatus = cleared ? "已清除插件运行时授权" : "该插件暂无持久运行时授权";
  }

  async function openInstalledPluginDirectory(plugin: { id: string; title: string; path: string }) {
    if (!hasTauriRuntime()) {
      pluginsStatus = `浏览器预览模式无法定位：${plugin.path}`;
      return;
    }
    busyPluginId = plugin.id;
    pluginsStatus = "正在定位插件目录";
    try {
      await invoke("shell_show_item_in_folder", { path: plugin.path });
      pluginsStatus = `已定位 ${plugin.title}`;
    } catch (error) {
      pluginsStatus = String(error);
    } finally {
      busyPluginId = "";
    }
  }

  async function uninstallInstalledPlugin(plugin: { id: string; title: string; sourceLabel: string }) {
    if (plugin.sourceLabel !== "导入") {
      pluginsStatus = "内置插件不可卸载，可停用以隐藏指令";
      return;
    }
    if (!await confirmSettingsAction({
      title: "卸载插件",
      message: `确定卸载 ${plugin.title}？此操作会移除插件本体、指令索引和插件数据。`,
      confirmLabel: "卸载",
    })) {
      pluginsStatus = "已取消卸载插件";
      return;
    }
    busyPluginId = plugin.id;
    pluginsStatus = "正在卸载插件";
    try {
      await invoke("uninstall_plugin", { pluginId: plugin.id });
      selectedPluginId = null;
      pluginPermissionPanelOpen = false;
      await refreshPluginsPage();
      pluginsStatus = "插件已卸载";
    } catch (error) {
      pluginsStatus = String(error);
    } finally {
      busyPluginId = "";
    }
  }

  async function refreshPluginMarketPage() {
    pluginMarketStatusText = "";
    pluginMarketCatalog = null;
    selectedMarketPluginId = null;
    pluginMarketProgress = null;
    if (!hasTauriRuntime()) {
      installedPlugins = [];
      pluginMarketStatusText = "Tauri 运行时未连接，插件数量需在桌面应用中查看";
      return;
    }
    pluginMarketLoading = true;
    try {
      installedPlugins = await invoke<InstalledPlugin[]>("list_plugins");
      if (pluginMarketCustom && pluginMarketUrl.trim()) {
        const catalog = await invoke<PluginMarketCatalog>("fetch_plugin_market_catalog", { url: pluginMarketUrl.trim() });
        pluginMarketCatalog = catalog;
        selectedMarketPluginId = catalog.plugins[0]?.id ?? null;
        pluginMarketStatusText = `已读取 ${installedPlugins.length} 个已安装插件；远程目录 ${pluginMarketCatalog.plugins.length} 个插件`;
      } else {
        pluginMarketStatusText = `已读取 ${installedPlugins.length} 个已安装插件`;
      }
    } catch (error) {
      pluginMarketStatusText = String(error);
    } finally {
      pluginMarketLoading = false;
    }
  }

  async function openPluginMarketUrl() {
    pluginMarketStatusText = "";
    const trimmedUrl = pluginMarketUrl.trim();
    if (!trimmedUrl) {
      pluginMarketStatusText = "请先填写插件市场地址";
      return;
    }
    try {
      const url = new URL(trimmedUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        pluginMarketStatusText = "插件市场地址仅支持 http/https";
        return;
      }
    } catch {
      pluginMarketStatusText = "插件市场地址格式无效";
      return;
    }
    if (!hasTauriRuntime()) {
      pluginMarketStatusText = `浏览器预览模式无法打开：${trimmedUrl}`;
      return;
    }
    try {
      await invoke("shell_open", { url: pluginMarketUrl.trim() });
      pluginMarketStatusText = "已打开插件市场地址";
    } catch (error) {
      pluginMarketStatusText = String(error);
    }
  }

  async function cancelPluginMarketOperation() {
    if (!pluginMarketOperationId || !installingMarketPluginId) return;
    pluginMarketStatusText = "正在取消插件市场任务";
    try {
      await invoke("cancel_plugin_market_operation", { operationId: pluginMarketOperationId });
    } catch (error) {
      pluginMarketStatusText = String(error);
    }
  }

  async function retryLastPluginMarketAction() {
    if (!pluginMarketRetryAction || installingMarketPluginId) return;
    const action = pluginMarketRetryAction;
    await installPluginFromMarketCatalog(action.plugin, { skipConfirm: true });
  }

  async function installPluginFromMarketCatalog(plugin: PluginMarketCatalogPlugin, options: { skipConfirm?: boolean } = {}) {
    pluginMarketStatusText = "";
    if (!hasTauriRuntime()) {
      pluginMarketStatusText = `浏览器预览模式无法安装：${plugin.name}`;
      return;
    }
    if (!plugin.signature || !plugin.public_key || !pluginMarketPublicKeyTrusted(plugin)) {
      pluginMarketStatusText = `${plugin.name} 的 Ed25519 公钥尚未在本机 pin，已拒绝安装`;
      return;
    }
    const installedPlugin = marketCatalogInstalledPlugin(plugin);
    const actionLabel = marketCatalogActionLabel(plugin);
    if (!options.skipConfirm && !(await confirmSettingsAction({
      title: `${actionLabel}插件`,
      message: `${plugin.name} v${plugin.version} 将从 ${plugin.download_url} ${actionLabel}。远程插件会下载 ZIP 并写入本地插件目录；${plugin.checksum ? "目录 SHA-256 会在解包前校验。" : "目录未提供 SHA-256，将以 Ed25519 签名校验完整性。"}目录 Ed25519 签名会使用本机已 pin 的公钥校验。确认继续？`,
      confirmLabel: actionLabel,
      tone: "danger",
    }))) {
      pluginMarketStatusText = `已取消${actionLabel} ${plugin.name}`;
      return;
    }
    installingMarketPluginId = plugin.id;
    const operationId = nextPluginMarketOperationId(plugin);
    pluginMarketOperationId = operationId;
    pluginMarketRetryAction = null;
    pluginMarketProgress = {
      plugin_id: plugin.id,
      operation: installedPlugin ? "update" : "install",
      operation_id: operationId,
      stage: "requesting",
      downloaded_bytes: 0,
      total_bytes: null,
      percent: null,
      attempt: 1,
      max_attempts: 3,
      message: "正在连接插件市场",
    };
    pluginMarketStatusText = `正在下载并${actionLabel} ${plugin.name}`;
    try {
      const updated = installedPlugin
        ? await invoke("update_plugin_from_market", { pluginId: plugin.id, downloadUrl: plugin.download_url, checksum: plugin.checksum ?? null, signature: plugin.signature ?? null, publicKey: plugin.public_key ?? null, operationId }) as InstalledPlugin
        : await invoke("install_plugin_from_market", { pluginId: plugin.id, downloadUrl: plugin.download_url, checksum: plugin.checksum ?? null, signature: plugin.signature ?? null, publicKey: plugin.public_key ?? null, operationId }) as InstalledPlugin;
      selectedPluginId = updated.id;
      pluginPermissionPanelOpen = false;
      installedPlugins = await invoke<InstalledPlugin[]>("list_plugins");
      pluginMarketStatusText = `已${actionLabel} ${updated.name || updated.id}`;
    } catch (error) {
      const message = String(error);
      pluginMarketRetryAction = {
        plugin,
        operation: installedPlugin ? "update" : "install",
        actionLabel,
      };
      pluginMarketStatusText = message.includes("cancelled") || message.includes("已取消")
        ? `已取消${actionLabel} ${plugin.name}`
        : message;
    } finally {
      installingMarketPluginId = "";
      pluginMarketOperationId = "";
    }
  }

  async function setFloatingBallVisible() {
    floatingBallStatus = "";
    if (!hasTauriRuntime()) {
      floatingBallStatus = "浏览器预览模式不会创建悬浮球窗口";
      return;
    }
    try {
      await invoke("set_floating_ball_visible", { visible: floatingBallEnabled });
      floatingBallStatus = floatingBallEnabled ? "悬浮球已显示" : "悬浮球已隐藏";
    } catch (error) {
      floatingBallStatus = String(error);
    }
  }

  function persistFloatingBallChange() {
    void setFloatingBallVisible();
    persistSoon();
  }

  async function setSuperPanelVisible() {
    superPanelStatus = "";
    if (!hasTauriRuntime()) {
      superPanelStatus = "浏览器预览模式不会创建超级面板窗口";
      return;
    }
    try {
      await invoke("set_super_panel_visible", { visible: superPanelEnabled });
      superPanelStatus = superPanelEnabled ? "超级面板已显示" : "超级面板已隐藏";
    } catch (error) {
      superPanelStatus = String(error);
    }
  }

  function persistSuperPanelChange() {
    void setSuperPanelVisible();
    persistSoon();
  }

  async function openDevtoolsForWindow(windowLabel = "main") {
    devtoolsStatus = "";
    if (!hasTauriRuntime()) {
      devtoolsStatus = "浏览器预览模式无法打开 Tauri DevTools";
      return;
    }
    try {
      const result = await invoke<DevtoolsOpenResult>("open_devtools_for_window", {
        settings: currentSettings(),
        windowLabel,
      });
      devtoolsStatus = result.detail;
    } catch (error) {
      devtoolsStatus = String(error);
    }
  }

  async function refreshDataPage() {
    dataLoading = true;
    dataStatus = "";
    commandHistory = loadCommandHistory();
    if (!hasTauriRuntime()) {
      installedPlugins = [];
      recentAudits = [];
      clipboardHistory = [];
      pluginDataSummary = [];
      dataStatus = "Tauri 运行时未连接，剪贴板、审计和插件数据需在桌面应用中查看";
      dataLoading = false;
      return;
    }
    try {
      const [plugins, audits, clipboardItems] = await Promise.all([
        invoke<InstalledPlugin[]>("list_plugins"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 20 }),
        invoke<ClipboardHistoryEntry[]>("list_clipboard_history", { query: "", limit: 20 }),
      ]);
      installedPlugins = plugins;
      recentAudits = audits;
      clipboardHistory = clipboardItems;
      pluginDataSummary = await Promise.all(plugins.map(async (plugin) => {
        try {
          const docs = await invoke<PluginDocument[]>("get_plugin_data", { pluginId: plugin.id });
          return { plugin, documents: docs.length };
        } catch (error) {
          return { plugin, documents: 0, error: String(error) };
        }
      }));
    } catch (error) {
      dataStatus = String(error);
    } finally {
      dataLoading = false;
    }
  }

  async function exportSettings() {
    await copyText(JSON.stringify(currentSettings(), null, 2));
    dataStatus = "已复制设置 JSON";
  }

  async function exportCommandHistory() {
    await copyText(exportCommandHistoryJson(commandHistory));
    dataStatus = `已复制 ${commandHistory.length} 条最近使用历史`;
  }

  async function clearCommandHistory() {
    if (!await confirmSettingsAction({
      title: "清空最近使用历史",
      message: "确定要清空最近使用历史吗？这不会删除插件、设置或审计记录。",
      confirmLabel: "清空",
    })) return;
    const count = clearCommandHistoryStorage();
    commandHistory = [];
    dataStatus = `已清空 ${count} 条最近使用历史`;
  }

  function removeCommandHistoryItem(code: string) {
    const count = removeCommandHistoryEntryStorage(code);
    commandHistory = loadCommandHistory();
    dataStatus = count > 0 ? "已移除 1 条最近使用历史" : "未找到对应历史记录";
  }

  async function exportClipboardHistory() {
    try {
      const json = await invoke<string>("export_clipboard_history_json", { limit: 1000 });
      await copyText(json);
      dataStatus = `已复制 ${clipboardHistory.length} 条剪贴板历史`;
    } catch (error) {
      dataStatus = String(error);
    }
  }

  async function clearClipboardHistory() {
    if (!await confirmSettingsAction({
      title: "清空剪贴板历史",
      message: "确定要清空剪贴板历史吗？这不会影响当前系统剪贴板内容。",
      confirmLabel: "清空",
    })) return;
    try {
      const count = await invoke<number>("clear_clipboard_history");
      clipboardHistory = [];
      dataStatus = `已清空 ${count} 条剪贴板历史`;
    } catch (error) {
      dataStatus = String(error);
    }
  }

  async function resetSettings() {
    if (!await confirmSettingsAction({
      title: "恢复默认设置",
      message: "确定要恢复默认设置吗？这会覆盖当前设置。",
      confirmLabel: "恢复默认",
    })) return;
    applySettings(DEFAULT_ATOOLS_SETTINGS);
    persistSoon();
    dataStatus = "已恢复默认设置";
  }

  function auditArchiveDefaultPath() {
    const date = new Date().toISOString().slice(0, 10);
    return `atools-audit-archive-${date}.jsonl`;
  }

  async function exportAudits() {
    try {
      const jsonl = await invoke<string>("export_audit_entries_jsonl", { limit: 1000 });
      await copyText(jsonl);
      dataStatus = `已复制 ${jsonl.split("\n").filter(Boolean).length} 条审计记录`;
    } catch (error) {
      dataStatus = String(error);
    }
  }

  async function archiveAudits() {
    if (!hasTauriRuntime()) {
      dataStatus = "需在桌面应用中归档审计记录";
      return;
    }
    const targetPath = await saveDialog({
      title: "归档审计记录",
      defaultPath: auditArchiveDefaultPath(),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (!targetPath) {
      dataStatus = "已取消审计归档";
      return;
    }

    auditArchiveBusy = true;
    try {
      const result = await invoke<AuditArchiveResult>("archive_audit_entries_jsonl", {
        path: targetPath,
        limit: 1000,
        confirmed: true,
      });
      dataStatus = result.count > 0
        ? `已归档 ${result.count} 条审计记录到 ${result.path}`
        : `已创建空审计归档：${result.path}`;
    } catch (error) {
      dataStatus = String(error);
    } finally {
      auditArchiveBusy = false;
    }
  }

  async function clearAudits() {
    if (!await confirmSettingsAction({
      title: "清空审计记录",
      message: "确定要清空全部审计记录吗？此操作不可恢复。",
      confirmLabel: "清空",
    })) return;
    try {
      const count = await invoke<number>("clear_audit_entries");
      dataStatus = `已清空 ${count} 条审计记录`;
      await refreshDataPage();
    } catch (error) {
      dataStatus = String(error);
    }
  }

  async function pruneAuditEntries() {
    if (!await confirmSettingsAction({
      title: "按保留策略清理审计",
      message: `将删除早于 ${AUDIT_RETENTION_DAYS} 天的审计记录，并且只保留最新 ${AUDIT_KEEP_LATEST} 条。此操作不可恢复。`,
      confirmLabel: "清理",
    })) return;
    auditPruneBusy = true;
    try {
      const count = await invoke<number>("prune_audit_entries", {
        retentionDays: AUDIT_RETENTION_DAYS,
        keepLatest: AUDIT_KEEP_LATEST,
      });
      dataStatus = count > 0 ? `已按保留策略清理 ${count} 条审计记录` : "审计记录已符合保留策略";
      await refreshDataPage();
    } catch (error) {
      dataStatus = String(error);
    } finally {
      auditPruneBusy = false;
    }
  }

  async function exportPluginData() {
    try {
      const payload = await Promise.all(installedPlugins.map(async (plugin) => ({
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
        documents: await invoke<PluginDocument[]>("get_plugin_data", { pluginId: plugin.id }),
      })));
      await copyText(JSON.stringify(payload, null, 2));
      dataStatus = `已复制 ${payload.length} 个插件的数据`;
    } catch (error) {
      dataStatus = String(error);
    }
  }

  async function clearPluginData() {
    if (!await confirmSettingsAction({
      title: "清空插件数据",
      message: "确定要清空全部插件数据吗？插件本体不会删除，但插件保存的数据会被移除。",
      confirmLabel: "清空",
    })) return;
    try {
      let count = 0;
      for (const plugin of installedPlugins) {
        const docs = await invoke<PluginDocument[]>("get_plugin_data", { pluginId: plugin.id });
        for (const doc of docs) {
          await invoke("remove_plugin_data", { pluginId: plugin.id, docId: doc._id });
          count += 1;
        }
      }
      dataStatus = `已清空 ${count} 条插件数据`;
      await refreshDataPage();
    } catch (error) {
      dataStatus = String(error);
    }
  }

  function webQuickOpenOverview() {
    return webQuickOpenOverviewCards({
      entries: webQuickOpenEntries,
      statusLabel: webQuickOpenStatus,
    });
  }

  function addWebQuickOpenEntry() {
    const existingKeywords = new Set(webQuickOpenEntries.map((entry) => entry.keyword));
    const next = createWebQuickOpenEntry();
    let suffix = 1;
    while (existingKeywords.has(next.keyword)) {
      suffix += 1;
      next.keyword = `web${suffix}`;
    }
    persistWebQuickOpenEntries([...webQuickOpenEntries, next], "已添加网页快开");
    openWebQuickOpenEditor(next);
  }

  function updateWebQuickOpenEntry(id: string, patch: Partial<WebQuickOpenEntry>) {
    persistWebQuickOpenEntries(
      webQuickOpenEntries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存网页快开",
    );
  }

  async function removeWebQuickOpenEntry(entry: WebQuickOpenEntry) {
    if (!await confirmSettingsAction({
      title: "删除网页快开",
      message: `确定要删除“${entry.name}”吗？删除后主搜索将不再匹配这个网页快开。`,
      confirmLabel: "删除",
    })) return;
    persistWebQuickOpenEntries(
      webQuickOpenEntries.filter((item) => item.id !== entry.id),
      "已删除网页快开",
    );
    if (editingWebQuickOpenId === entry.id) {
      closeWebQuickOpenEditor();
    }
  }

  function resetWebQuickOpenEntries() {
    persistWebQuickOpenEntries(DEFAULT_WEB_QUICK_OPEN_ENTRIES.map((entry) => ({ ...entry })), "已恢复默认网页快开");
    closeWebQuickOpenEditor();
  }

  function persistWebQuickOpenEntries(entries: WebQuickOpenEntry[], status: string) {
    webQuickOpenEntries = entries;
    saveWebQuickOpenEntries(entries);
    dispatchWebQuickOpenEntries(entries);
    webQuickOpenStatus = status;
  }

  function openWebQuickOpenEditor(entry: WebQuickOpenEntry) {
    editingWebQuickOpenId = entry.id;
    webQuickOpenDraft = { ...entry };
    webQuickOpenValidation = "";
  }

  function closeWebQuickOpenEditor() {
    editingWebQuickOpenId = null;
    webQuickOpenDraft = null;
    webQuickOpenValidation = "";
  }

  function updateWebQuickOpenDraft(patch: Partial<WebQuickOpenEntry>) {
    if (!webQuickOpenDraft) return;
    webQuickOpenDraft = { ...webQuickOpenDraft, ...patch };
    webQuickOpenValidation = "";
  }

  function saveWebQuickOpenEditor() {
    if (!webQuickOpenDraft) return;
    const validation = validateWebQuickOpenDraft(webQuickOpenDraft);
    if (validation) {
      webQuickOpenValidation = validation;
      return;
    }
    persistWebQuickOpenEntries(
      webQuickOpenEntries.map((entry) => entry.id === webQuickOpenDraft?.id ? { ...webQuickOpenDraft } : entry),
      `已保存 ${webQuickOpenDraft.name}`,
    );
    closeWebQuickOpenEditor();
  }

  function webQuickOpenTemplateMode(entry: WebQuickOpenEntry): "search" | "direct" {
    return entry.template.includes("{query}") ? "search" : "direct";
  }

  function applyWebQuickOpenMode(mode: "search" | "direct") {
    if (!webQuickOpenDraft) return;
    if (mode === "search") {
      const template = webQuickOpenDraft.template.trim() || "https://www.google.com/search";
      updateWebQuickOpenDraft({
        template: template.includes("{query}") ? template : `${template}${template.includes("?") ? "&" : "?"}q={query}`,
      });
      return;
    }
    updateWebQuickOpenDraft({
      template: webQuickOpenDraft.template.includes("{query}") ? "https://example.com" : webQuickOpenDraft.template,
    });
  }

  function validateWebQuickOpenDraft(entry: WebQuickOpenEntry) {
    return validateWebQuickOpenEntry(entry);
  }

  function webQuickOpenPreviewUrl(entry: WebQuickOpenEntry) {
    return buildWebQuickOpenUrl(entry, webQuickOpenTemplateMode(entry) === "search" ? "rust" : "");
  }

  async function previewWebQuickOpenEntry(entry: WebQuickOpenEntry) {
    const url = webQuickOpenPreviewUrl(entry);
    if (hasTauriRuntime()) {
      await invoke("shell_open", { url });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    webQuickOpenStatus = `已预览 ${entry.name}`;
  }

  function addCommandAlias(targetCodeOverride?: string) {
    const targets = aliasTargetOptions();
    const targetCode = targetCodeOverride ?? targets[0]?.code ?? "system:settings";
    const existingAliases = new Set(commandAliases.map((entry) => entry.alias));
    const next = createCommandAlias(targetCode);
    let suffix = 1;
    while (existingAliases.has(next.alias)) {
      suffix += 1;
      next.alias = `alias${suffix}`;
    }
    persistCommandAliases([...commandAliases, next], "已添加别名");
  }

  function updateCommandAlias(id: string, patch: Partial<CommandAliasEntry>) {
    persistCommandAliases(
      commandAliases.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存别名",
    );
  }

  function removeCommandAlias(id: string) {
    persistCommandAliases(
      commandAliases.filter((entry) => entry.id !== id),
      "已删除别名",
    );
  }

  function resetCommandAliases() {
    persistCommandAliases([], "已清空别名");
  }

  function persistCommandAliases(entries: CommandAliasEntry[], status: string) {
    const normalized = normalizeCommandAliases(entries);
    commandAliases = normalized;
    saveCommandAliases(normalized);
    dispatchCommandAliasesUpdated(normalized);
    commandAliasStatus = status;
  }

  function toggleCommandCenterPinned(row: CommandCenterRow) {
    const next = togglePinnedCommandCode(commandCenterPinnedCodes, row.code);
    commandCenterPinnedCodes = next;
    savePinnedCommandCodes(next);
    dispatchPinnedCommandCodes(next);
    commandAliasStatus = row.pinned ? `已取消固定 ${row.label}` : `已固定 ${row.label}`;
  }

  function commandCenterTargetToggleLabel(row: CommandCenterRow) {
    if (row.source === "system") return "不可停用";
    return row.enabled ? "停用" : "启用";
  }

  function canToggleCommandCenterTarget(row: CommandCenterRow) {
    return row.source === "local" || row.source === "web";
  }

  function toggleCommandCenterTarget(row: CommandCenterRow) {
    if (row.source === "local") {
      const id = row.code.startsWith("local:") ? row.code.slice("local:".length) : "";
      if (!id) return;
      updateLocalLaunchEntry(id, { enabled: !row.enabled });
      commandAliasStatus = `${row.label} 已${row.enabled ? "停用" : "启用"}`;
      return;
    }
    if (row.source === "web") {
      const id = row.code.startsWith("web:") ? row.code.slice("web:".length) : "";
      if (!id) return;
      updateWebQuickOpenEntry(id, { enabled: !row.enabled });
      commandAliasStatus = `${row.label} 已${row.enabled ? "停用" : "启用"}`;
    }
  }

  function addAppShortcut(targetCodeOverride?: string) {
    const targets = aliasTargetOptions();
    const targetCode = targetCodeOverride ?? targets[0]?.code ?? "system:settings";
    const existingShortcuts = [
      ...shortcutBuiltIns().map((row) => row.shortcut),
      ...appShortcuts.map((entry) => entry.shortcut),
    ];
    const next = createAppShortcut(targetCode, existingShortcuts, hotkeyPlatform());
    persistAppShortcuts([...appShortcuts, next], "已添加应用快捷键");
  }

  function updateAppShortcut(id: string, patch: Partial<AppShortcutSetting>) {
    persistAppShortcuts(
      appShortcuts.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存应用快捷键",
    );
  }

  function removeAppShortcut(id: string) {
    persistAppShortcuts(
      appShortcuts.filter((entry) => entry.id !== id),
      "已删除应用快捷键",
    );
  }

  function persistAppShortcuts(entries: AppShortcutSetting[], status: string) {
    appShortcuts = normalizeAppShortcuts(entries);
    appShortcutStatus = status;
    persistSoon();
  }

  function localLaunchOverview() {
    return localLaunchOverviewCards({
      entries: localLaunchEntries,
      statusLabel: localLaunchStatus,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function addLocalLaunchEntry() {
    const existingKeywords = new Set(localLaunchEntries.map((entry) => entry.keyword));
    const next = createLocalLaunchEntry();
    let suffix = 1;
    while (existingKeywords.has(next.keyword)) {
      suffix += 1;
      next.keyword = `local${suffix}`;
    }
    persistLocalLaunchEntries([...localLaunchEntries, next], "已添加本地启动项");
  }

  async function addLocalLaunchEntryFromPicker(kind: LocalLaunchKind) {
    localLaunchStatus = "";
    if (!hasTauriRuntime()) {
      localLaunchStatus = "浏览器预览模式无法选择本地路径";
      return;
    }
    try {
      const selected = await openDialog({
        directory: kind !== "file",
        multiple: false,
        title: kind === "folder" ? "选择文件夹" : kind === "app" ? "选择应用" : "选择文件",
      });
      const path = selectedLocalLaunchPath(selected);
      if (!path) {
        localLaunchStatus = "已取消选择";
        return;
      }
      const entry = createLocalLaunchEntryFromPath(path, kind);
      persistLocalLaunchEntries([...localLaunchEntries, entry], `已添加 ${entry.name}`);
    } catch (error) {
      localLaunchStatus = String(error);
    }
  }

  function updateLocalLaunchEntry(id: string, patch: Partial<LocalLaunchEntry>) {
    persistLocalLaunchEntries(
      localLaunchEntries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存本地启动项",
    );
  }

  async function removeLocalLaunchEntry(entry: LocalLaunchEntry) {
    if (!await confirmSettingsAction({
      title: "删除本地启动项",
      message: `确定要删除“${entry.name}”吗？删除后主搜索将不再匹配这个路径。`,
      confirmLabel: "删除",
    })) return;
    persistLocalLaunchEntries(
      localLaunchEntries.filter((item) => item.id !== entry.id),
      "已删除本地启动项",
    );
  }

  function resetLocalLaunchEntries() {
    persistLocalLaunchEntries(DEFAULT_LOCAL_LAUNCH_ENTRIES.map((entry) => ({ ...entry })), "已恢复默认本地启动项");
  }

  function persistLocalLaunchEntries(entries: LocalLaunchEntry[], status: string) {
    localLaunchEntries = entries;
    saveLocalLaunchEntries(entries);
    dispatchLocalLaunchEntries(entries);
    localLaunchStatus = status;
  }

  async function openLocalLaunchPath(entry: LocalLaunchEntry) {
    const resolvedPath = await localLaunchResolvedPath(entry);
    if (!hasTauriRuntime()) {
      localLaunchStatus = `浏览器预览模式无法打开：${resolvedPath}`;
      return;
    }
    try {
      await invoke("shell_open", { url: resolvedPath });
      localLaunchStatus = `已打开 ${entry.name}`;
    } catch (error) {
      localLaunchStatus = String(error);
    }
  }

  async function revealLocalLaunchPath(entry: LocalLaunchEntry) {
    const resolvedPath = await localLaunchResolvedPath(entry);
    if (!hasTauriRuntime()) {
      localLaunchStatus = `浏览器预览模式无法定位：${resolvedPath}`;
      return;
    }
    try {
      await invoke("shell_show_item_in_folder", { path: resolvedPath });
      localLaunchStatus = `已定位 ${entry.name}`;
    } catch (error) {
      localLaunchStatus = String(error);
    }
  }

  function onLocalLaunchDragOver(event: DragEvent) {
    event.preventDefault();
  }

  async function onLocalLaunchDrop(event: DragEvent) {
    event.preventDefault();
    const files = Array.from(event.dataTransfer?.files ?? []);
    const entries = files
      .map((file) => {
        const path = droppedLocalLaunchPath(file);
        if (!path || !looksLikeLocalPath(path)) return null;
        return createLocalLaunchEntryFromPath(path, inferLocalLaunchKindFromPath(path, "file"));
      })
      .filter((entry): entry is LocalLaunchEntry => entry !== null);

    if (entries.length === 0) {
      localLaunchStatus = "拖拽添加需要桌面端提供本地路径";
      return;
    }
    persistLocalLaunchEntries([...localLaunchEntries, ...entries], `已拖拽添加 ${entries.length} 个启动项`);
  }

  function selectedLocalLaunchPath(value: string | string[] | null): string {
    if (Array.isArray(value)) return value[0] ?? "";
    return value ?? "";
  }

  function createLocalLaunchEntryFromPath(path: string, kind: LocalLaunchKind): LocalLaunchEntry {
    const name = inferLocalLaunchName(path);
    const keyword = uniqueLocalLaunchKeyword(inferLocalLaunchKeyword(name));
    return {
      id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      keyword,
      path,
      kind: inferLocalLaunchKindFromPath(path, kind),
      enabled: true,
    };
  }

  function inferLocalLaunchName(path: string) {
    const trimmed = path.trim().replace(/\/+$/, "");
    const name = trimmed.split("/").filter(Boolean).at(-1) ?? "本地启动项";
    return name.replace(/\.app$/i, "") || "本地启动项";
  }

  function inferLocalLaunchKeyword(name: string) {
    const ascii = name
      .toLowerCase()
      .replace(/\.app$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    return ascii || "local";
  }

  function uniqueLocalLaunchKeyword(keyword: string) {
    const existingKeywords = new Set(localLaunchEntries.map((entry) => entry.keyword.toLowerCase()));
    let candidate = keyword;
    let suffix = 1;
    while (existingKeywords.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${keyword}${suffix}`;
    }
    return candidate;
  }

  function inferLocalLaunchKindFromPath(path: string, fallback: LocalLaunchKind): LocalLaunchKind {
    if (/\.app\/?$/i.test(path)) return "app";
    return fallback;
  }

  function droppedLocalLaunchPath(file: File) {
    const nativeFile = file as File & { path?: string };
    return nativeFile.path || file.webkitRelativePath || file.name;
  }

  function looksLikeLocalPath(path: string) {
    return path.startsWith("/") || path.startsWith("~/");
  }

  async function localLaunchResolvedPath(entry: LocalLaunchEntry) {
    const homePath = hasTauriRuntime() ? await safeHomePath() : "";
    return resolveLocalLaunchPath(entry.path, homePath);
  }

  async function safeHomePath() {
    try {
      return await invoke<string>("system_get_path", { name: "home" });
    } catch {
      return "";
    }
  }

  async function refreshDebugPage() {
    debugLoading = true;
    debugStatus = "";
    commandHistory = loadCommandHistory();
    localLaunchEntries = loadLocalLaunchEntries();
    webQuickOpenEntries = loadWebQuickOpenEntries();
    commandAliases = loadCommandAliases();
    if (!hasTauriRuntime()) {
      debugMcpStatus = null;
      runtimeDiagnostics = null;
      debugAudits = [];
      recentAuditErrors = [];
      crashLogs = [];
      debugStatus = "浏览器预览模式，无法读取 Tauri MCP 状态和审计记录";
      debugLoading = false;
      return;
    }
    try {
      const [status, audits, runtime, crashes] = await Promise.all([
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 30 }),
        invoke<RuntimeDiagnostics>("get_runtime_diagnostics"),
        invoke<CrashLogEntry[]>("list_crash_logs", { limit: 20 }),
      ]);
      debugMcpStatus = status;
      runtimeDiagnostics = runtime;
      debugAudits = audits;
      recentAuditErrors = audits.filter((audit) => audit.error || audit.status !== "success").slice(0, 5);
      crashLogs = crashes;
    } catch (error) {
      debugStatus = String(error);
    } finally {
      debugLoading = false;
    }
  }

  function currentDiagnosticBundle() {
    return buildDiagnosticBundle({
      aliases: commandAliases,
      history: commandHistory,
      localLaunchEntries,
      webQuickOpenEntries,
      settings: currentSettings(),
      runtime: runtimeDiagnostics,
      mcpStatus: debugMcpStatus,
      audits: debugAudits,
      crashLogs,
      clipboardHistoryCount: clipboardHistory.length,
      pluginDataSummary,
    });
  }

  async function copyDebugInfo() {
    await copyText(diagnosticBundleText(currentDiagnosticBundle()));
    debugStatus = "已复制脱敏诊断包";
  }

  async function copyCrashLog() {
    if (!hasTauriRuntime()) return;
    const log = await invoke<string>("export_crash_log");
    await copyText(log || "");
    debugStatus = log ? "已复制崩溃日志" : "暂无崩溃日志";
  }

  async function clearCrashLog() {
    if (!hasTauriRuntime()) return;
    if (!await confirmSettingsAction({
      title: "清空崩溃日志",
      message: "确定清空崩溃日志？此操作只清空本地 crashes.log。",
      confirmLabel: "清空",
    })) return;
    const count = await invoke<number>("clear_crash_log");
    crashLogs = [];
    debugStatus = `已清空 ${count} 条崩溃日志`;
  }

  async function copyText(text: string) {
    try {
      await writeText(text);
    } catch {
      await navigator.clipboard.writeText(text);
    }
  }

  function shortcutSaveText() {
    return shortcutStatusMessage(hotkey, hotkeyPlatform(), saveState, saveErrorMessage);
  }

  function shortcutHasProblem() {
    return saveState === "error" || !validateShortcut(hotkey, hotkeyPlatform()).valid;
  }

  function environmentRows() {
    return [
      { label: "运行时", value: hasTauriRuntime() ? "Tauri WebView" : "浏览器预览" },
      { label: "构建模式", value: import.meta.env.MODE },
      { label: "前端地址", value: location.href },
      { label: "平台", value: navigator.platform || "未知" },
      { label: "User Agent", value: navigator.userAgent },
      { label: "时间", value: new Date().toISOString() },
    ];
  }

  function localDebugRows(): DebugDiagnosticRow[] {
    return localDataDiagnostics({
      aliases: commandAliases,
      history: commandHistory,
      localLaunchEntries,
      webQuickOpenEntries,
      settings: currentSettings(),
    });
  }

  function runtimeDebugRows(): DebugDiagnosticRow[] {
    return runtimeDiagnosticRows(runtimeDiagnostics);
  }

  function auditErrorRows(): AuditErrorSummary[] {
    return auditErrorSummaries(recentAuditErrors);
  }

  function crashLogRows(): CrashLogSummary[] {
    return crashLogSummaries(crashLogs);
  }

  function debugOverview() {
    return debugOverviewCards({
      hasTauriRuntime: hasTauriRuntime(),
      runtime: runtimeDiagnostics,
      mcpStatus: debugMcpStatus,
      audits: debugAudits,
      crashLogs,
    });
  }

  function hasTauriRuntime() {
    const runtime = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
    return typeof runtime?.invoke === "function";
  }

  function commandHistoryDetail() {
    const stats = commandHistoryStats(commandHistory);
    if (stats.count === 0) return "暂无记录；执行命令后会出现在主搜索首页";
    const lastUsed = stats.lastUsedAt ? new Date(stats.lastUsedAt).toLocaleString() : "未知时间";
    return `${stats.count} 条；最近使用 ${stats.topLabel || "未知"} · ${lastUsed}`;
  }

  function commandHistoryRowDetail(entry: CommandHistoryEntry) {
    const lastUsed = entry.usedAt ? new Date(entry.usedAt).toLocaleString() : "未知时间";
    const input = entry.input ? `输入：${entry.input}` : "无输入";
    return `${entry.plugin_name} · ${input} · ${entry.useCount} 次 · ${lastUsed}`;
  }

  function aiOverview() {
    return aiOverviewCards({
      providerLabel: aiProviderLabel(),
      providerEnabled: aiProvider !== "disabled",
      configReady: aiConfigReady(),
      defaultModel: aiDefaultModel,
      useForAgent: aiUseForAgent && aiProvider !== "disabled",
      hasApiKey: Boolean(aiApiKey.trim()),
      lastConnectionOk: aiLastConnection ? aiLastConnection.status === "ok" : (aiConnectionStatus && !aiTestingConnection ? false : null),
      lastConnectionLabel: aiConnectionStatus,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function dataOverview() {
    const historyStats = commandHistoryStats(commandHistory);
    const pluginDataDocuments = pluginDataSummary.reduce((total, item) => total + Math.max(0, item.documents), 0);
    return dataOverviewCards({
      settingsStatusLabel: saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存",
      commandHistoryCount: historyStats.count,
      commandHistoryTopLabel: historyStats.topLabel,
      clipboardHistoryCount: clipboardHistory.length,
      auditCount: recentAudits.length,
      pluginCount: installedPlugins.length,
      pluginDataDocuments,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function dataAuditRetentionRows() {
    return auditRetentionPolicyRows({
      retentionDays: AUDIT_RETENTION_DAYS,
      keepLatest: AUDIT_KEEP_LATEST,
      auditCount: recentAudits.length,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function generalOverview() {
    return generalOverviewCards({
      hotkey,
      saveLabel: saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存",
      launchAtLogin,
      showTrayIcon,
      localAppSearch,
      localLaunchSearch,
      unsupportedCount: generalUnsupportedCapabilities().length,
    });
  }

  function aliasTargetOptions() {
    return [
      ...SYSTEM_ACTIONS.map((action) => ({
        code: `system:${action.id}`,
        label: `系统 · ${action.label}`,
        explain: action.description,
        source: "system" as const,
        enabled: true,
      })),
      ...localLaunchEntries.map((entry) => ({
        code: `local:${entry.id}`,
        label: `本地启动 · ${entry.name}`,
        explain: entry.path,
        source: "local" as const,
        enabled: entry.enabled,
      })),
      ...webQuickOpenEntries.map((entry) => ({
        code: `web:${entry.id}`,
        label: `网页快开 · ${entry.name}`,
        explain: entry.keyword,
        source: "web" as const,
        enabled: entry.enabled,
      })),
    ];
  }

  function aliasTargetSummary(code: string) {
    const target = aliasTargetOptions().find((item) => item.code === code);
    return target ? `${target.label} · ${target.explain}` : "目标不存在，请重新选择";
  }

  function httpStatusPage() {
    return httpServiceStatus({
      mcpEnabled: mcpStatus?.enabled ?? debugMcpStatus?.enabled ?? false,
      mcpUrl: mcpHttpUrlForStatus(mcpStatus ?? debugMcpStatus) ?? "",
    });
  }

  function httpOverview() {
    const connection = mcpConnection();
    return httpServiceOverviewCards({
      mcpEnabled: connection.statusTone === "ready",
      mcpUrl: connection.httpUrl,
      tokenAvailable: connection.tokenAvailable,
    });
  }

  function aboutPage() {
    return aboutProductFacts({
      version: "3.0.0",
      runtime: hasTauriRuntime() ? "Tauri WebView" : "浏览器预览",
      platform: navigator.platform || "未知",
      mcpEnabled: mcpStatus?.enabled ?? debugMcpStatus?.enabled ?? false,
    });
  }

  function aboutOverview() {
    const runtime = runtimeDiagnostics;
    const tools = runtime
      ? {
          total: runtime.agent_tool_count,
          enabled: runtime.enabled_agent_tool_count,
        }
      : {
          total: agentTools.length,
          enabled: agentTools.filter((tool) => tool.enabled).length,
        };
    return aboutOverviewCards({
      version: "3.0.0",
      runtime: hasTauriRuntime() ? "Tauri WebView" : "浏览器预览",
      platform: navigator.platform || "未知",
      mcpEnabled: mcpStatus?.enabled ?? debugMcpStatus?.enabled ?? false,
      agentToolCount: tools.total,
      enabledAgentToolCount: tools.enabled,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function aboutRuntimeRows() {
    const runtime = runtimeDiagnostics;
    const mcp = mcpStatus ?? debugMcpStatus;
    return [
      {
        label: "本地数据路径",
        value: runtime?.base_dir || "需在桌面应用中查看",
      },
      {
        label: "数据库路径",
        value: runtime?.db_path || "需在桌面应用中查看",
      },
      {
        label: "插件目录",
        value: runtime?.plugins_dir || "需在桌面应用中查看",
      },
      {
        label: "本地 Agent 能力",
        value: runtime
          ? `${runtime.agent_tool_count} 个工具 / ${runtime.enabled_agent_tool_count} 个启用`
          : `${agentTools.length} 个工具 / ${agentTools.filter((tool) => tool.enabled).length} 个启用`,
      },
      {
        label: "MCP 监听",
        value: mcp?.enabled ? mcp.bind : runtime?.mcp_bind || "未启动",
      },
      {
        label: "运行事件",
        value: runtime ? `${runtime.recent_events.length} 条` : "需在桌面应用中查看",
      },
    ];
  }

  function aboutRuntimeInfoText() {
    const about = aboutPage();
    const runtime = runtimeDiagnostics;
    const mcp = mcpStatus ?? debugMcpStatus;
    return JSON.stringify({
      type: "atools_about_runtime_info",
      generatedAt: new Date().toISOString(),
      product: {
        title: about.title,
        version: about.version,
        direction: "轻量、本地优先、Agent 友好",
      },
      runtime: runtime
        ? {
            runtime: runtime.runtime,
            platform: runtime.platform,
            arch: runtime.arch,
            debug: runtime.debug,
            baseDir: runtime.base_dir,
            dbPath: runtime.db_path,
            pluginsDir: runtime.plugins_dir,
            pluginCount: runtime.plugin_count,
            featureCount: runtime.feature_count,
            agentToolCount: runtime.agent_tool_count,
            enabledAgentToolCount: runtime.enabled_agent_tool_count,
            activePlugin: runtime.active_plugin || "",
            recentEventCount: runtime.recent_events.length,
          }
        : {
            runtime: hasTauriRuntime() ? "Tauri WebView" : "browser-preview",
            platform: navigator.platform || "unknown",
            arch: "unknown",
            debug: import.meta.env.DEV,
          },
      mcp: {
        enabled: mcp?.enabled ?? false,
        bind: mcp?.bind || runtime?.mcp_bind || "",
        token: mcp?.token ? "<hidden>" : "",
      },
      localData: aboutRuntimeRows().map((row) => ({ label: row.label, value: row.value })),
    }, null, 2);
  }

  function shortcutBuiltIns() {
    return builtInAppShortcutsForPlatform(hotkeyPlatform(), {
      spaceOpenCommand,
      tabKeyFunction,
    });
  }

  function customAppShortcutRows() {
    return appShortcutRows({
      entries: appShortcuts,
      targets: aliasTargetOptions(),
      builtIns: shortcutBuiltIns(),
      platform: hotkeyPlatform(),
    });
  }

  function shortcutOverview() {
    return shortcutPageOverview({
      hotkey,
      saveLabel: shortcutSaveText(),
      aliasCount: commandAliases.length,
      targetCount: aliasTargetOptions().length,
      customGlobalCount: 0,
      customAppCount: appShortcuts.length,
      builtinAppCount: shortcutBuiltIns().length,
    });
  }

  function commandCenterSummary() {
    return commandCenterOverview(aliasTargetOptions(), commandAliases);
  }

  function commandCenterPinnedCount() {
    const targetCodes = new Set(aliasTargetOptions().map((target) => target.code));
    return commandCenterPinnedCodes.filter((code) => targetCodes.has(code)).length;
  }

  function commandCenterFilteredRows() {
    return commandCenterRows({
      targets: aliasTargetOptions(),
      aliases: commandAliases,
      source: commandCenterSourceFilter,
      status: commandCenterStatusFilter,
      query: commandCenterQuery,
      pinnedCodes: commandCenterPinnedCodes,
    });
  }

  function commandCenterSourceDetail(group: ReturnType<typeof commandCenterSummary>["groups"][number]) {
    return `${group.enabledCount}/${group.count} 启用 · ${group.aliasCount} 个别名`;
  }
</script>

<svelte:window onkeydown={onSettingsWindowKeydown} />

<section class="settings-panel">
  <aside class="settings-sidebar" aria-label="设置菜单">
    {#each menuItems as item}
      <button class="menu-item" class:active={activeMenu === item.id} onclick={() => activeMenu = item.id}>
        <svg class="menu-icon" viewBox="0 0 24 24" aria-hidden="true">
          {@html iconFor(item.icon)}
        </svg>
        <span>{item.label}</span>
      </button>
    {/each}
    <span class="save-status" aria-live="polite">
      {saveState === "idle" ? "加载中" : saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存"}
    </span>
  </aside>

  <main class="settings-content">
    {#if activeMenu === "general"}
      {@const generalSummary = generalOverview()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>通用设置概览</h3>
            <span class="state-pill">{saveState === "saving" ? "保存中" : saveState === "error" ? "保存失败" : "已保存"}</span>
          </div>
          <div class="inline-status">
            本页设置保存在本机；热键、开机启动和托盘显示会在桌面端同步到系统能力。
          </div>
          <div class="general-overview-grid" aria-label="通用设置概览：呼出快捷键、系统入口、搜索来源、暂缓能力">
            {#each generalSummary as card}
              <div
                class="general-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>
        <fieldset class="settings-fieldset" oninput={persistSoon} onchange={persistSoon}>
        <section class="setting-group">
          <h3>基础设置</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>呼出快捷键</span>
              <small>设置全局快捷键来呼出应用</small>
            </div>
            <div class="setting-control">
              <input
                class="hotkey-input"
                class:recording={recordingHotkey}
                bind:value={hotkey}
                readonly
                aria-label="呼出快捷键"
                title={hotkeyStatusText()}
                onclick={startHotkeyRecording}
              />
              <div class="quick-actions-wrapper">
                <button
                  class="icon-button"
                  class:active={showHotkeyQuickActions}
                  aria-label="快捷设置"
                  title="快捷设置"
                  onclick={toggleHotkeyQuickActions}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">{@html iconFor("settings")}</svg>
                </button>
                {#if showHotkeyQuickActions}
                  <div class="quick-actions-dropdown">
                    {#each hotkeyPresets() as preset}
                      <button
                        class="quick-actions-item"
                        class:active={hotkey === preset.value}
                        onclick={() => applyHotkeyPreset(preset.value)}
                      >
                        <span>{preset.label}</span>
                        <small>{preset.value} · {preset.description}</small>
                      </button>
                    {/each}
                    <button class="quick-actions-item reset" onclick={() => applyHotkeyPreset(defaultHotkey())}>
                      <span>重置</span>
                      <small>恢复为默认快捷键 {defaultHotkey()}</small>
                    </button>
                  </div>
                {/if}
              </div>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>开机自动启动</span>
              <small>登录系统时自动启动应用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={launchAtLogin} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>显示托盘图标</span>
              <small>在系统托盘中显示应用图标</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={showTrayIcon} />
              <span></span>
            </label>
          </div>

          <div class="setting-item blocked-row">
            <div class="blocked-main">
              <div class="blocked-head">
                <div class="setting-label">
                  <span>唤醒黑名单</span>
                  <small>前台应用命中黑名单时，全局快捷键不会唤醒主窗口</small>
                </div>
                <button
                  class="plain-button"
                  onclick={addCurrentWindowToWakeupBlacklist}
                  disabled={!hasTauriRuntime()}
                  title={hasTauriRuntime() ? "读取当前前台应用并加入黑名单" : "需在桌面应用中使用"}
                >
                  添加当前窗口
                </button>
              </div>
              <div class="inline-form">
                <input
                  class="text-input"
                  value={wakeupBlacklistDraft}
                  placeholder="应用名，例如 Terminal"
                  aria-label="唤醒黑名单应用名"
                  oninput={(event) => wakeupBlacklistDraft = (event.target as HTMLInputElement).value}
                  onkeydown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addWakeupItem();
                    }
                  }}
                />
                <button class="plain-button" onclick={addWakeupItem} disabled={!wakeupBlacklistDraft.trim()}>添加</button>
              </div>
              {#if wakeupBlacklistStatus}
                <div class="inline-status compact-status">{wakeupBlacklistStatus}</div>
              {/if}
              {#if wakeupBlacklist.length > 0}
                <div class="tag-list">
                  {#each wakeupBlacklist as app, i}
                    <span class="tag">
                      {app}
                      <button aria-label={`移除 ${app}`} onclick={() => removeWakeupItem(i)}>×</button>
                    </span>
                  {/each}
                </div>
              {/if}
            </div>
          </div>
        </section>

        <section class="setting-group">
          <h3>外观</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>主题设置</span>
              <small>选择应用的主题外观</small>
            </div>
            <select class="select-control" bind:value={theme}>
              {#each themeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>主题色</span>
              <small>自定义应用的主色调</small>
            </div>
            <div class="color-control">
              {#each themeColors as color}
                <button
                  class="color-dot"
                  class:active={primaryColor === color.value}
                  style={`--dot-color: ${color.hex}`}
                  aria-label={color.label}
                  title={color.label}
                  onclick={() => { primaryColor = color.value; persistSoon(); }}
                ></button>
              {/each}
              <button
                class="color-dot custom"
                class:active={primaryColor === "custom"}
                style={`--dot-color: ${customColor}`}
                aria-label="自定义"
                title="自定义"
                onclick={() => { primaryColor = "custom"; persistSoon(); }}
              ></button>
              {#if primaryColor === "custom"}
                <input
                  class="color-picker-input"
                  type="color"
                  bind:value={customColor}
                  aria-label="自定义主题色"
                  oninput={persistSoon}
                />
              {/if}
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>窗口不透明度</span>
              <small>调整窗口的透明度</small>
            </div>
            <div class="range-control">
              <input type="range" min="0.3" max="1" step="0.01" bind:value={opacity} aria-label="窗口不透明度" />
              <output>{Math.round(opacity * 100)}%</output>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>窗口材质</span>
              <small>系统材质尚未接入原生窗口，暂不启用</small>
            </div>
            <select class="select-control" bind:value={windowMaterial} disabled>
              {#each windowMaterialOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>
        </section>

        <section class="setting-group">
          <h3>搜索</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>搜索框提示文字</span>
              <small>自定义搜索框的占位提示文字</small>
            </div>
            <input class="text-input wide" bind:value={placeholder} aria-label="搜索框提示文字" />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>搜索框模式</span>
              <small>选择搜索框的显示模式</small>
            </div>
            <select class="select-control" bind:value={searchMode}>
              {#each searchModeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>搜索框显示最近使用</span>
              <small>开启后搜索框将显示最近使用的应用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={showRecentInSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>匹配推荐</span>
              <small>推荐分组尚未接入搜索结果，暂不启用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={showMatchRecommendation} disabled />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>最近使用显示行数</span>
              <small>设置最近使用列表显示的行数（每行9个）</small>
            </div>
            <select class="select-control compact" bind:value={recentRows}>
              {#each rowOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>固定栏显示行数</span>
              <small>设置主搜索首页固定指令最多显示的行数（每行9个）</small>
            </div>
            <select class="select-control compact" bind:value={pinnedRows}>
              {#each rowOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>本地应用搜索</span>
              <small>开启后桌面应用会搜索 /Applications 和用户 Applications 下的应用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={localAppSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>本地启动搜索</span>
              <small>关闭后主搜索不再匹配自定义本地启动项</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={localLaunchSearch} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>空格打开指令</span>
              <small>搜索框为空时按空格键打开选中的指令</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={spaceOpenCommand} />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>Tab 功能</span>
              <small>设置 Tab 键用于切换选中项，或直接进入指定指令</small>
            </div>
            <select class="select-control" bind:value={tabKeyFunction}>
              {#each tabKeyOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>
        </section>

        <section class="setting-group">
          <h3>行为</h3>

          <div class="setting-item">
            <div class="setting-label">
              <span>自动粘贴搜索框</span>
              <small>呼出后在设定时间内自动填入最近复制的文本</small>
            </div>
            <select class="select-control" bind:value={autoPaste} aria-label="自动粘贴搜索框">
              {#each autoPasteOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>自动清空搜索框</span>
              <small>执行链接、本地启动、复制等内置动作后清空输入</small>
            </div>
            <select class="select-control" bind:value={autoClear}>
              {#each autoClearOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>自动返回到搜索</span>
              <small>进入设置、Agent 等内置面板后按设定时间返回主搜索</small>
            </div>
            <select class="select-control" bind:value={autoBackToSearch}>
              {#each autoBackToSearchOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>插件默认高度</span>
              <small>设置进入插件时的默认高度（像素）</small>
            </div>
            <input class="number-input" type="number" min="200" bind:value={windowDefaultHeight} aria-label="插件默认高度" />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>剪贴板历史保存天数</span>
              <small>Agent 搜索剪贴板时会按此天数保留本地历史</small>
            </div>
            <input class="number-input" type="number" min="1" max="3650" bind:value={clipboardRetentionDays} aria-label="剪贴板历史保存天数" />
          </div>
        </section>

        <section class="setting-group">
          <h3>超级面板</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>启用超级面板</span>
              <small>{superPanelStatus || (superPanelEnabled ? "超级面板会常驻屏幕上方，显示剪贴板文本和主搜索入口" : "关闭后不创建超级面板窗口")}</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={superPanelEnabled} onchange={persistSuperPanelChange} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>悬浮球</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>显示悬浮球</span>
              <small>{floatingBallStatus || (floatingBallEnabled ? "悬浮球窗口会常驻屏幕边缘，点击可打开主搜索" : "关闭后不创建悬浮球窗口")}</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={floatingBallEnabled} onchange={persistFloatingBallChange} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>网络</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>网络代理</span>
              <small>{proxyEnabled ? "代理将用于 WebDAV 同步和 AI 模型连接测试" : "填写代理地址后可用于 WebDAV 同步和 AI 模型连接测试"}</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                bind:checked={proxyEnabled}
                disabled={!proxyUrl.trim()}
                onchange={persistSoon}
                title={proxyUrl.trim() ? "启用网络代理" : "先填写代理地址"}
              />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>代理地址</span>
              <small>支持 http/https 代理，例如 http://127.0.0.1:7890</small>
            </div>
            <input
              class="input-control"
              bind:value={proxyUrl}
              oninput={() => {
                if (!proxyUrl.trim()) proxyEnabled = false;
                persistSoon();
              }}
              placeholder="http://127.0.0.1:7890"
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>自定义插件市场</span>
              <small>{pluginMarketCustom ? "插件市场页将使用该地址作为外部市场入口" : "填写地址后可在插件市场页作为外部入口"}</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                bind:checked={pluginMarketCustom}
                disabled={!pluginMarketUrl.trim()}
                onchange={persistSoon}
                title={pluginMarketUrl.trim() ? "启用自定义插件市场地址" : "先填写插件市场地址"}
              />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>插件市场地址</span>
              <small>支持 http/https 目录地址；远程 ZIP 必须同时通过 SHA-256、Ed25519 签名和本地公钥 pin 校验</small>
            </div>
            <input
              class="input-control"
              bind:value={pluginMarketUrl}
              oninput={() => {
                if (!pluginMarketUrl.trim()) pluginMarketCustom = false;
                persistSoon();
              }}
              placeholder="https://market.example.com/catalog.json"
            />
          </div>
          <div class="setting-item setting-item-stacked">
            <div class="setting-label">
              <span>受信任 Ed25519 公钥</span>
              <small>每行一个 32 字节公钥的 Base64；市场目录提供的公钥不会自动成为信任锚</small>
            </div>
            <textarea
              class="input-control"
              rows="3"
              bind:value={pluginMarketTrustedPublicKeysText}
              oninput={persistSoon}
              placeholder="Base64 Ed25519 public key"
              spellcheck="false"
            ></textarea>
          </div>
        </section>

        <section class="setting-group">
          <h3>开发者</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>开发者工具位置</span>
              <small>插件 DevTools 会按该偏好打开；原生停靠能力取决于当前 WebView</small>
            </div>
            <select class="select-control" bind:value={devToolsMode} onchange={persistSoon}>
              {#each devToolsModeOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>DevTools 测试</span>
              <small>{devtoolsStatus || "在桌面端按当前偏好打开主窗口 DevTools"}</small>
            </div>
            <button class="plain-button" onclick={() => openDevtoolsForWindow("main")} disabled={!hasTauriRuntime()}>
              打开主窗口 DevTools
            </button>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>关闭 GPU 加速</span>
              <small>启动参数尚未接入，暂不启用</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={disableGpuAcceleration} disabled />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>首版暂缓能力</h3>
          <div class="compact-list">
            {#each generalUnsupportedCapabilities() as capability}
              <div class="data-row compact muted-row">
                <div class="setting-label">
                  <span>{capability.label}</span>
                  <small>{capability.description}</small>
                </div>
                <span class="meta-pill">{capability.status}</span>
              </div>
            {/each}
          </div>
        </section>
        </fieldset>
      </div>
    {:else if activeMenu === "shortcuts"}
      {@const shortcutSummary = shortcutOverview()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>快捷键</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={() => addAppShortcut()}>添加快捷键</button>
              <button class="plain-button" onclick={() => addCommandAlias()}>添加映射</button>
            </div>
          </div>
          <div class="inline-status">
            对齐 ZTools 的快捷键页结构：全局快捷键、应用快捷键和指令别名分开管理；自定义应用快捷键已本地保存。
          </div>
          <div class="shortcut-tab-bar" role="tablist" aria-label="快捷键分类">
            {#each shortcutTabs() as tab}
              <button
                class="shortcut-tab"
                class:active={activeShortcutTab === tab.id}
                role="tab"
                aria-selected={activeShortcutTab === tab.id}
                onclick={() => activeShortcutTab = tab.id}
              >
                <span>{tab.label}</span>
                <small>{tab.description}</small>
              </button>
            {/each}
          </div>
          <div class="shortcut-summary-grid">
            {#each shortcutSummary.cards as card}
              <div class="shortcut-summary-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        {#if activeShortcutTab === "global"}
          <section class="setting-group">
            <h3>全局快捷键</h3>
            <div class="setting-item">
              <div class="setting-label">
                <span>呼出快捷键</span>
                <small>全局快捷键会立即保存并重新注册</small>
              </div>
              <div class="setting-control">
                <input
                  class="hotkey-input"
                  class:recording={recordingHotkey}
                  bind:value={hotkey}
                  readonly
                  aria-label="呼出快捷键"
                  title={hotkeyStatusText()}
                  onclick={startHotkeyRecording}
                />
                <span class="meta-pill" class:active={recordingHotkey} class:error={shortcutHasProblem()}>{hotkeyStatusText()}</span>
              </div>
            </div>
            <div class="setting-item">
              <div class="setting-label">
                <span>冲突/保存状态</span>
                <small>热键注册失败会显示为保存失败，不再静默成功</small>
              </div>
              <span class="state-pill" class:error={shortcutHasProblem()}>{shortcutSaveText()}</span>
            </div>
            <div class="empty-box">{shortcutSummary.emptyStates.global}</div>
          </section>
        {:else if activeShortcutTab === "app"}
          <section class="setting-group">
            <div class="section-heading">
              <h3>应用快捷键</h3>
              <div class="row-actions">
                <button class="plain-button" onclick={() => addAppShortcut()}>添加</button>
                <span class="meta-pill">{shortcutBuiltIns().length} 内置 / {appShortcuts.length} 自定义</span>
              </div>
            </div>
            {#if appShortcuts.length === 0}
              <div class="empty-box">{shortcutSummary.emptyStates.app}</div>
            {:else}
              <div class="inline-status">{appShortcutStatus}</div>
              <div class="shortcut-card-list custom-shortcut-list">
                {#each customAppShortcutRows() as row}
                  <div class="shortcut-card-row app-shortcut-row">
                    <label class="toggle">
                      <input
                        type="checkbox"
                        checked={row.enabled}
                        onchange={(event) => updateAppShortcut(row.id, { enabled: (event.target as HTMLInputElement).checked })}
                      />
                      <span></span>
                    </label>
                    <input
                      class="text-input shortcut-edit-input"
                      value={row.shortcut}
                      aria-label="应用快捷键"
                      oninput={(event) => updateAppShortcut(row.id, { shortcut: (event.target as HTMLInputElement).value })}
                    />
                    <div class="setting-label">
                      <select
                        class="select-control"
                        value={row.targetCode}
                        aria-label="快捷键目标"
                        onchange={(event) => updateAppShortcut(row.id, { targetCode: (event.target as HTMLSelectElement).value })}
                      >
                        {#each aliasTargetOptions() as target}
                          <option value={target.code}>{target.label}</option>
                        {/each}
                      </select>
                      <small>{row.targetDetail}{row.conflictLabel === "无冲突" ? "" : ` · ${row.conflictLabel}`}</small>
                    </div>
                    <div class="row-actions">
                      <span
                        class="meta-pill"
                        class:error={["无效", "重复", "冲突", "目标缺失"].includes(row.statusLabel)}
                        class:pending={!row.enabled}
                      >{row.statusLabel}</span>
                      <button class="plain-button danger" onclick={() => removeAppShortcut(row.id)}>删除</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
            <div class="setting-item">
              <div class="setting-label">
                <span>空格打开指令</span>
                <small>和主搜索键盘行为联动</small>
              </div>
              <label class="toggle">
                <input type="checkbox" bind:checked={spaceOpenCommand} onchange={persistSoon} />
                <span></span>
              </label>
            </div>
            <div class="setting-item">
              <div class="setting-label">
                <span>Tab 功能</span>
                <small>设置 Tab 键用于切换选中项，或直接进入指定指令</small>
              </div>
              <select class="select-control" bind:value={tabKeyFunction} onchange={persistSoon}>
                {#each tabKeyOptions as option}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>
            <div class="shortcut-card-list">
              {#each shortcutBuiltIns() as row}
                <div class="shortcut-card-row">
                  <div class="shortcut-key-display">{row.shortcut}</div>
                  <div class="setting-label">
                    <span>{row.target}</span>
                    <small>{row.scope}{row.configurable ? " · 可在本页配置行为" : " · 随主程序生效"}</small>
                  </div>
                  <span class="meta-pill">{row.configurable ? "可配置" : "内置"}</span>
                </div>
              {/each}
            </div>
          </section>
        {:else if activeShortcutTab === "alias"}
          <section class="setting-group">
            <div class="section-heading">
              <h3>指令别名</h3>
              <div class="row-actions">
                <button class="plain-button" onclick={() => addCommandAlias()}>添加映射</button>
                <button class="plain-button danger" onclick={resetCommandAliases} disabled={commandAliases.length === 0}>清空别名</button>
              </div>
            </div>
            <div class="inline-status">{commandAliasStatus} · 可绑定 {aliasTargetOptions().length} 个系统命令、本地启动或网页快开目标</div>
            {#if commandAliases.length === 0}
              <div class="empty-box">{shortcutSummary.emptyStates.alias}</div>
            {:else}
              <div class="shortcut-card-list">
                {#each commandAliases as entry}
                  <div class="shortcut-card-row alias-shortcut-row">
                    <div class="shortcut-key-display">{entry.alias}</div>
                    <div class="setting-label">
                      <span>{entry.enabled ? "已启用" : "已停用"}</span>
                      <small>{aliasTargetSummary(entry.targetCode)}</small>
                    </div>
                    <div class="row-actions">
                      <label class="toggle">
                        <input
                          type="checkbox"
                          checked={entry.enabled}
                          onchange={(event) => updateCommandAlias(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                        />
                        <span></span>
                      </label>
                      <button class="plain-button danger" onclick={() => removeCommandAlias(entry.id)}>删除</button>
                    </div>
                  </div>
                {/each}
              </div>
            {/if}
          </section>
        {/if}
      </div>
    {:else if activeMenu === "plugins"}
      {@const inventory = pluginInventoryPage()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>插件库存概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={refreshPluginsPage} disabled={pluginsLoading}>刷新</button>
              <button class="plain-button" onclick={installPluginFromDirectory} disabled={pluginsLoading}>安装插件</button>
            </div>
          </div>
          <div class="inline-status">
            本地目录安装、启用状态、卸载和本地清单只保存在本机；远程 ZIP 安装/更新从插件市场目录触发，目录 SHA-256 会校验，签名信任仍未接入。
          </div>
          {#if pluginsStatus}
            <div class="inline-status">{pluginsStatus}</div>
          {/if}
          <div class="plugin-inventory-overview-grid" aria-label="插件库存概览：插件库存、启用状态、Feature 指令、安装入口">
            {#each pluginInventoryOverview(inventory) as card}
              <div
                class="plugin-inventory-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:desktop={card.tone === "desktop"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>插件筛选</h3>
            <span class="meta-pill">{inventory.filteredSummary.total} 个匹配</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>筛选插件</span>
              <small>按名称、feature、描述、路径或来源快速定位</small>
            </div>
            <input
              class="text-input wide"
              bind:value={pluginFilterQuery}
              aria-label="筛选已安装插件"
              placeholder="搜索插件、feature、路径"
            />
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>显示范围</span>
              <small>按启用状态和插件来源缩小列表</small>
            </div>
            <div class="row-actions">
              <select class="select-control compact" bind:value={pluginFilterStatus} aria-label="插件启用状态筛选">
                <option value="all">全部状态</option>
                <option value="enabled">只看启用</option>
                <option value="disabled">只看停用</option>
              </select>
              <select class="select-control compact" bind:value={pluginFilterSource} aria-label="插件来源筛选">
                <option value="all">全部来源</option>
                <option value="builtin">内置</option>
                <option value="imported">导入</option>
              </select>
            </div>
          </div>
          {#if pluginsLoading && inventory.rows.length === 0}
            <div class="empty-box">正在读取插件</div>
          {:else if inventory.rows.length === 0}
            <div class="empty-box">{inventory.emptyText}</div>
          {:else}
            <div class="compact-list">
              {#each inventory.rows as plugin}
                <div class="data-row plugin-inventory-row">
                  <div class="setting-label">
                    <span>{plugin.name}</span>
                    <small>{plugin.versionLabel} · {plugin.sourceLabel} · {plugin.featureCount} features · 更新 {plugin.updatedAt}</small>
                    <small>{plugin.description}</small>
                    <code class="mono-value">{plugin.featurePreview}{plugin.hasMoreFeatures ? " / ..." : ""}</code>
                    <code class="mono-value">{plugin.path}</code>
                  </div>
                  <div class="row-actions">
                    <button
                      class="plain-button"
                      class:enabled={inventory.selectedPlugin?.id === plugin.id}
                      onclick={() => selectInstalledPlugin(plugin.id)}
                    >
                      详情
                    </button>
                    <button
                      class="plain-button"
                      class:enabled={plugin.enabled}
                      disabled={!hasTauriRuntime() || busyPluginId === plugin.id}
                      onclick={() => plugin.enabled ? toggleInstalledPlugin(plugin.id, false) : authorizeInstalledPlugin(plugin)}
                    >
                      {plugin.enabled ? "已启用" : "已停用"}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>插件详情</h3>
          {#if inventory.selectedPlugin === null}
            <div class="empty-box">选择一个插件查看详情</div>
          {:else}
            <div class="debug-grid">
              <div class="debug-row">
                <span>名称</span>
                <code>{inventory.selectedPlugin.title}</code>
              </div>
              <div class="debug-row">
                <span>状态</span>
                <code>{inventory.selectedPlugin.statusLabel}</code>
              </div>
              <div class="debug-row">
                <span>版本/来源</span>
                <code>{inventory.selectedPlugin.versionLabel} · {inventory.selectedPlugin.sourceLabel}</code>
              </div>
              <div class="debug-row">
                <span>更新时间</span>
                <code>{inventory.selectedPlugin.updatedAt}</code>
              </div>
              <div class="debug-row">
                <span>描述</span>
                <code>{inventory.selectedPlugin.description}</code>
              </div>
              <div class="debug-row">
                <span>路径</span>
                <code>{inventory.selectedPlugin.path}</code>
              </div>
            </div>

            <div class="compact-list detail-list">
              {#each inventory.selectedPlugin.features as feature}
                <div class="data-row compact">
                  <div class="setting-label">
                    <span>{feature.label}</span>
                    <small>{feature.code} · {feature.explain}</small>
                  </div>
                </div>
              {/each}
              {#if inventory.selectedPlugin.features.length === 0}
                <div class="empty-box">该插件暂无 feature</div>
              {/if}
            </div>

            {#if pluginPermissionPanelOpen}
              {@const runtimePermissionGrants = selectedPluginRuntimePermissionGrants(inventory.selectedPlugin.id, pluginRuntimePermissionGrantVersion)}
              <div class="compact-list detail-list" aria-label="插件权限/能力审计">
                <div class="data-row compact">
                  <div class="setting-label">
                    <span>插件权限/能力审计</span>
                    <small>展示 manifest 声明和用户确认过的运行时授权；Agent 工具授权仍在 Agent/MCP 白名单中管理</small>
                  </div>
                </div>
                {#each inventory.selectedPlugin.permissionRows as row}
                  <div class="data-row compact">
                    <div class="setting-label">
                      <span>{row.label}</span>
                      <small>{row.detail}</small>
                    </div>
                    <code>{row.value}</code>
                  </div>
                {/each}
                <div class="data-row compact">
                  <div class="setting-label">
                    <span>持久运行时授权</span>
                    <small>{runtimePermissionGrants.length > 0 ? runtimePermissionGrants.join(" / ") : "暂无持久授权；运行时弹窗选择始终允许后会显示在这里"}</small>
                  </div>
                  <button
                    class="plain-button danger"
                    disabled={runtimePermissionGrants.length === 0}
                    onclick={() => clearSelectedPluginRuntimePermissionGrants(inventory.selectedPlugin?.id)}
                  >
                    清除授权
                  </button>
                </div>
              </div>
            {/if}

            <div class="compact-list detail-list">
              {#each inventory.selectedPlugin.actions as action}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{action.label}</span>
                    <small>{action.reason}</small>
                  </div>
                  <button
                    class="plain-button"
                    class:danger={action.label === "卸载插件"}
                    disabled={!action.available || !inventory.selectedPlugin || busyPluginId === inventory.selectedPlugin.id}
                    onclick={() => {
                      if (!inventory.selectedPlugin) return;
                      if (action.label === "打开目录") {
                        openInstalledPluginDirectory(inventory.selectedPlugin);
                      } else if (action.label === "授权启用") {
                        authorizeInstalledPlugin(inventory.selectedPlugin);
                      } else if (action.label === "更新插件") {
                        updateInstalledPluginFromDirectory(inventory.selectedPlugin);
                      } else if (action.label === "卸载插件") {
                        uninstallInstalledPlugin(inventory.selectedPlugin);
                      } else if (action.label === "插件权限") {
                        pluginPermissionPanelOpen = true;
                        pluginsStatus = "已展开插件权限/能力审计";
                      }
                    }}
                  >
                    {action.available ? (action.label === "卸载插件" ? "卸载" : action.label === "打开目录" ? "定位" : action.label === "授权启用" ? "授权启用" : action.label === "更新插件" ? "更新" : action.label === "插件权限" ? "查看" : "执行") : "未接入"}
                  </button>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "market"}
      {@const marketStatus = pluginMarketPageStatus()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>插件市场概览</h3>
            <span class="state-pill" class:enabled={marketStatus.remoteCatalogLoaded} class:error={!marketStatus.remoteCatalogLoaded}>{marketStatus.label}</span>
          </div>
          <div class="inline-status">
            {marketStatus.summary}
          </div>
          <div class="inline-status">
            {marketStatus.remoteCatalogLoaded ? "自定义市场目录已接入展示、远程详情、评分展示、ZIP 安装/更新、下载进度、取消/重试、SHA-256 校验、Ed25519 签名校验和安装确认。" : "网络插件市场下载安装更新需先配置并读取自定义目录；本地导入、已安装插件和我的数据仍可在桌面端使用。"}
          </div>
          {#if marketStatus.customMarketConfigured}
            <div class="inline-status">
              自定义市场地址：{marketStatus.customMarketUrl}
            </div>
          {/if}
          {#if pluginMarketStatusText}
            <div class="inline-status">
              {pluginMarketStatusText}
            </div>
          {/if}
          {#if pluginMarketProgress}
            <div class="inline-status" aria-label="下载进度">
              下载进度：{marketProgressLabel()}
            </div>
          {/if}
          {#if installingMarketPluginId}
            <div class="row-actions">
              <button class="plain-button" onclick={cancelPluginMarketOperation} disabled={!pluginMarketOperationId}>取消下载</button>
            </div>
          {:else if pluginMarketRetryAction}
            <div class="row-actions">
              <button class="plain-button" onclick={retryLastPluginMarketAction}>重试</button>
            </div>
          {/if}
          <div class="plugin-market-overview-grid" aria-label="插件市场概览：市场状态、市场地址、本地入口、已安装插件、远程能力">
            {#each pluginMarketOverview(marketStatus) as card}
              <div
                class="plugin-market-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:desktop={card.tone === "desktop"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>本地替代入口</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={refreshPluginMarketPage} disabled={pluginMarketLoading}>刷新插件</button>
              <button class="plain-button" onclick={openPluginMarketUrl} disabled={!hasTauriRuntime() || !pluginMarketUrl.trim()}>
                打开市场地址
              </button>
            </div>
          </div>
          <div class="compact-list">
            {#each marketStatus.localCapabilities as capability}
              <div class="data-row">
                <div class="setting-label">
                  <span>{capability.label}</span>
                  <small>{capability.description}</small>
                </div>
                <span class="meta-pill" class:enabled={capability.available}>
                  {capability.available ? "可用" : "桌面端"}
                </span>
              </div>
            {/each}
          </div>
        </section>

        {#if pluginMarketCatalog}
          <section class="setting-group">
            <div class="section-heading">
              <h3>远程目录</h3>
              <span class="state-pill enabled">{pluginMarketCatalog.plugins.length} 个插件</span>
            </div>
            <div class="inline-status">
              来源：{pluginMarketCatalog.source_url}{pluginMarketCatalog.updated_at ? ` · 更新 ${pluginMarketCatalog.updated_at}` : ""}
            </div>
            <div class="plugin-market-catalog-list">
              {#each pluginMarketCatalog.plugins as plugin}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{plugin.name}</span>
                    <small>{plugin.description || plugin.download_url}</small>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill">v{plugin.version}</span>
                    <span class="meta-pill">{plugin.rating ? `评分 ${plugin.rating}` : "暂无评分"}</span>
                    {#if plugin.rating_count}
                      <span class="meta-pill">{plugin.rating_count} 条评分</span>
                    {/if}
                    {#if plugin.downloads}
                      <span class="meta-pill">{plugin.downloads} 次下载</span>
                    {/if}
                    {#if plugin.author}
                      <span class="meta-pill">{plugin.author}</span>
                    {/if}
                    {#if plugin.publisher}
                      <span class="meta-pill">{plugin.publisher}</span>
                    {/if}
                    {#if plugin.checksum}
                      <span class="meta-pill">{marketCatalogChecksumLabel(plugin)}</span>
                    {/if}
                    {#if plugin.signature && plugin.public_key}
                      <span class="meta-pill" class:enabled={pluginMarketPublicKeyTrusted(plugin)}>
                        {pluginMarketPublicKeyTrusted(plugin) ? "公钥已 pin" : "签名未信任"}
                      </span>
                    {/if}
                    {#if installingMarketPluginId === plugin.id && pluginMarketProgress}
                      <span class="meta-pill">{marketProgressLabel()}</span>
                    {/if}
                    <button class="plain-button" onclick={() => openMarketCatalogDetails(plugin)}>详情</button>
                    <button
                      class="plain-button"
                      onclick={() => installPluginFromMarketCatalog(plugin)}
                      disabled={pluginMarketLoading || Boolean(installingMarketPluginId) || !plugin.signature || !plugin.public_key || !pluginMarketPublicKeyTrusted(plugin)}
                      title={pluginMarketPublicKeyTrusted(plugin) ? `${marketCatalogActionLabel(plugin)} ${plugin.name}` : "先在通用设置 pin 该插件的 Ed25519 公钥"}
                    >
                      {installingMarketPluginId === plugin.id ? marketCatalogBusyLabel(plugin) : marketCatalogActionLabel(plugin)}
                    </button>
                  </div>
                </div>
              {/each}
            </div>
            {#if pluginMarketCatalog.plugins.length}
              {@const selectedMarketPlugin = selectedMarketCatalogPlugin()}
              {#if selectedMarketPlugin}
                <div class="compact-list detail-list" aria-label="远程详情">
                  <div class="data-row">
                    <div class="setting-label">
                      <span>远程详情</span>
                      <small>{selectedMarketPlugin.name} · {selectedMarketPlugin.id}</small>
                    </div>
                    <span class="meta-pill">v{selectedMarketPlugin.version}</span>
                  </div>
                  <div class="data-row compact">
                    <div class="setting-label">
                      <span>作者</span>
                      <small>{selectedMarketPlugin.author ?? "未提供"}</small>
                    </div>
                    <span class="meta-pill">{selectedMarketPlugin.updated_at ?? pluginMarketCatalog.updated_at ?? "未提供更新时间"}</span>
                  </div>
                  <div class="data-row compact">
                    <div class="setting-label">
                      <span>发布者</span>
                      <small>{selectedMarketPlugin.publisher ?? "目录未提供发布者"}</small>
                    </div>
                    <span class="meta-pill" class:enabled={pluginMarketPublicKeyTrusted(selectedMarketPlugin)}>
                      {pluginMarketPublicKeyTrusted(selectedMarketPlugin) ? "公钥已 pin" : selectedMarketPlugin.signature && selectedMarketPlugin.public_key ? "签名未信任" : "未提供签名"}
                    </span>
                  </div>
                  <div class="data-row compact">
                    <div class="setting-label">
                      <span>市场评分</span>
                      <small>{selectedMarketPlugin.rating ? `评分 ${selectedMarketPlugin.rating}` : "目录未提供评分"}</small>
                    </div>
                    <span class="meta-pill">{selectedMarketPlugin.rating_count ? `${selectedMarketPlugin.rating_count} 条评分` : "暂无评分数"}</span>
                  </div>
                  <div class="data-row compact">
                    <div class="setting-label">
                      <span>下载次数</span>
                      <small>{selectedMarketPlugin.downloads ? `${selectedMarketPlugin.downloads} 次下载` : "目录未提供下载次数"}</small>
                    </div>
                    <span class="meta-pill">{marketCatalogChecksumLabel(selectedMarketPlugin)}</span>
                  </div>
                  <div class="data-row compact">
                    <div class="setting-label">
                      <span>下载地址</span>
                      <small>{selectedMarketPlugin.download_url}</small>
                    </div>
                  </div>
                  {#if selectedMarketPlugin.homepage}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>主页</span>
                        <small>{selectedMarketPlugin.homepage}</small>
                      </div>
                    </div>
                  {/if}
                  {#if selectedMarketPlugin.checksum}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>SHA-256</span>
                        <small>{selectedMarketPlugin.checksum}</small>
                      </div>
                    </div>
                  {/if}
                  {#if selectedMarketPlugin.signature && selectedMarketPlugin.public_key}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>Ed25519 签名</span>
                        <small>{selectedMarketPlugin.signature}</small>
                      </div>
                    </div>
                  {/if}
                  {#if selectedMarketPlugin.publisher_url}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>发布者主页</span>
                        <small>{selectedMarketPlugin.publisher_url}</small>
                      </div>
                    </div>
                  {/if}
                </div>
              {/if}
            {/if}
          </section>
        {/if}

        <section class="setting-group">
          <h3>远程能力</h3>
          <div class="compact-list">
            {#each marketStatus.remoteCapabilities as capability}
              <div class="data-row" class:muted-row={!capability.available}>
                <div class="setting-label">
                  <span>{capability.label}</span>
                  <small>{capability.description}</small>
                </div>
                <span class="meta-pill" class:enabled={capability.available}>{capability.available ? "可用" : "未接入"}</span>
              </div>
            {/each}
          </div>
        </section>
      </div>
    {:else if activeMenu === "ai"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>AI 模型概览</h3>
            <div class="row-actions">
              <span
                class="state-pill"
                class:enabled={aiConfigReady()}
                class:error={aiProvider !== "disabled" && !aiConfigReady()}
              >
                {aiProvider === "disabled" ? "未启用" : aiConfigReady() ? `${aiProviderLabel()} 配置已保存` : "配置不完整"}
              </span>
              <button
                class="plain-button"
                onclick={testAiConnection}
                disabled={aiConnectionButton().disabled}
                title={aiConnectionButton().reason}
              >
                {aiConnectionButton().label}
              </button>
            </div>
          </div>
          <div class="inline-status">
            连接测试只读取 /models，不会发送聊天内容；API Key 仅本地保存，不写入审计或 MCP 配置。
          </div>
          {#if aiConnectionStatus}
            <div class="inline-status">{aiConnectionStatus}</div>
          {/if}

          <div class="ai-overview-grid" aria-label="AI 模型概览：模型提供商、默认模型、Agent 默认、连接状态">
            {#each aiOverview() as card}
              <div
                class="ai-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:disabled={card.tone === "disabled"}
                class:desktop={card.tone === "desktop"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>模型配置</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>模型提供商</span>
              <small>选择 OpenAI、兼容 API 或本地模型服务</small>
            </div>
            <select
              class="select-control"
              value={aiProvider}
              aria-label="AI 模型提供商"
              onchange={(event) => updateAiProvider((event.currentTarget as HTMLSelectElement).value as AiProvider)}
            >
              {#each aiProviderOptions as option}
                <option value={option.value}>{option.label}</option>
              {/each}
            </select>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>API Base URL</span>
              <small>{aiProvider === "local" ? "本地模型服务地址，需兼容 OpenAI /v1 接口" : "远端接口地址，仅本地保存"}</small>
            </div>
            <input
              class="text-input wide"
              bind:value={aiBaseUrl}
              placeholder={aiBaseUrlPlaceholder()}
              aria-label="AI API Base URL"
              disabled={aiProvider === "disabled"}
              oninput={persistAiConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>默认模型</span>
              <small>例如 gpt-4.1-mini、qwen-max 或本地模型名</small>
            </div>
            <input
              class="text-input wide"
              bind:value={aiDefaultModel}
              placeholder="模型名"
              aria-label="AI 默认模型"
              disabled={aiProvider === "disabled"}
              oninput={persistAiConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>API Key</span>
              <small>{aiProvider === "local" ? "本地服务通常可留空" : "仅本机保存；不会导出到 MCP 客户端配置"}</small>
            </div>
            <input
              class="text-input wide"
              type="password"
              bind:value={aiApiKey}
              placeholder={aiProvider === "local" ? "可选" : "sk-..."}
              aria-label="AI API Key"
              disabled={aiProvider === "disabled"}
              oninput={persistAiConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>温度</span>
              <small>控制生成随机性，范围 0 到 2</small>
            </div>
            <div class="range-control">
              <input
                type="range"
                min="0"
                max="2"
                step="0.1"
                bind:value={aiTemperature}
                aria-label="AI 温度"
                disabled={aiProvider === "disabled"}
                oninput={persistSoon}
              />
              <output>{Number(aiTemperature).toFixed(1)}</output>
            </div>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>用于 Agent 默认模型</span>
              <small>开启后 ask_ai_model 工具会读取这组本地配置</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                bind:checked={aiUseForAgent}
                disabled={aiProvider === "disabled"}
                onchange={persistSoon}
              />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <h3>配置预览</h3>
          <div class="debug-grid">
            <div class="debug-row">
              <span>提供商</span>
              <code>{aiProviderLabel()}</code>
            </div>
            <div class="debug-row">
              <span>模型</span>
              <code>{aiDefaultModel || "未设置"}</code>
            </div>
            <div class="debug-row">
              <span>Base URL</span>
              <code>{aiBaseUrl || "未设置"}</code>
            </div>
            <div class="debug-row">
              <span>密钥</span>
              <code>{aiApiKey ? "已填写，本地保存" : "未填写"}</code>
            </div>
            <div class="debug-row">
              <span>Agent 默认</span>
              <code>{aiUseForAgent && aiProvider !== "disabled" ? "启用" : "未启用"}</code>
            </div>
          </div>
        </section>

        {#if aiConnectionResultRows().length}
          <section class="setting-group">
            <h3>连接测试</h3>
            <div class="debug-grid">
              {#each aiConnectionResultRows() as row}
                <div class="debug-row">
                  <span>{row.label}</span>
                  <code>{row.value}</code>
                </div>
              {/each}
            </div>
          </section>
        {/if}
      </div>
    {:else if activeMenu === "mcp"}
      {@const governance = mcpGovernance()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>MCP 治理概览</h3>
            <div class="row-actions">
              <span class="state-pill" class:enabled={mcpPermissionMode !== "developer"}>{permissionModeLabel(mcpPermissionMode)}</span>
              <button class="plain-button" onclick={refreshMcpPage} disabled={mcpLoading}>刷新</button>
            </div>
          </div>
          <div class="mcp-governance-grid" aria-label="MCP 治理概览">
            {#each governance.cards as card}
              <div
                class="mcp-governance-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:danger={card.tone === "danger"}
                class:desktop={card.tone === "desktop"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
          <div class="inline-status">{governance.auditChain}</div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>权限策略</h3>
            <span class="meta-pill">{agentScopePolicies.length ? `${agentScopePolicies.length} 个 Scope` : "桌面端读取"}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>权限模式</span>
              <small>控制 Agent 工具调用的默认确认强度；高风险 Scope 仍可单独阻断</small>
            </div>
            <select
              class="select-control"
              value={mcpPermissionMode}
              disabled={!hasTauriRuntime() || mcpPolicyBusyKey === "permission-mode"}
              aria-label="MCP 权限模式"
              onchange={(event) => updateMcpPermissionMode((event.target as HTMLSelectElement).value)}
            >
              <option value="conservative">保守确认</option>
              <option value="per_tool">按工具授权</option>
              <option value="developer">开发者宽松</option>
            </select>
          </div>

          {#if mcpScopeRows().length === 0}
            <div class="empty-box">权限 Scope 需在桌面应用中读取；浏览器预览不会加载真实本地策略。</div>
          {:else}
            <div class="mcp-scope-policy-list">
              {#each mcpScopeRows() as policy}
                <div class="mcp-scope-policy-row" class:blocked={policy.blocked}>
                  <div class="setting-label">
                    <span>{policy.label}</span>
                    <small>{policy.description}</small>
                    <code>{policy.scope}</code>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill" class:danger={policy.high_risk}>{policy.riskLabel}</span>
                    <select
                      class="select-control compact"
                      value={policy.decision}
                      disabled={!hasTauriRuntime() || mcpPolicyBusyKey === `scope:${policy.scope}`}
                      aria-label={`${policy.label} 权限策略`}
                      onchange={(event) => updateMcpScopePolicy(policy.scope, (event.target as HTMLSelectElement).value)}
                    >
                      <option value="confirm">确认</option>
                      <option value="deny">阻断</option>
                    </select>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>待确认请求</h3>
            <button class="plain-button" onclick={refreshMcpPage} disabled={mcpLoading}>刷新</button>
          </div>
          {#if !hasTauriRuntime()}
            <div class="empty-box">待确认请求需在桌面应用中读取；浏览器预览不会加载真实 Agent 调用。</div>
          {:else if mcpPendingRows().length === 0}
            <div class="empty-box">暂无待确认请求；保守确认模式下 Agent 调用高风险工具会出现在这里。</div>
          {:else}
            <div class="mcp-request-list">
              {#each mcpPendingRows() as row}
                {@const request = pendingAgentRequests.find((item) => item.id === row.id)}
                <div class="mcp-request-row">
                  <div class="setting-label">
                    <span>{row.toolName}</span>
                    <small>{row.clientId} · {row.scopeLabel}</small>
                    <code>{row.argumentPreview}</code>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill pending">待确认</span>
                    <button
                      class="plain-button"
                      disabled={!request || mcpRequestBusyKey === `pending:${row.id}`}
                      onclick={() => request && approveMcpRequestOnce(request)}
                    >允许一次</button>
                    <button
                      class="plain-button"
                      disabled={!request || mcpRequestBusyKey === `pending:${row.id}`}
                      onclick={() => request && approveAndRememberMcpRequest(request)}
                    >允许并记住</button>
                    <button
                      class="plain-button danger"
                      disabled={!request || mcpRequestBusyKey === `pending:${row.id}`}
                      onclick={() => request && dismissMcpRequest(request)}
                    >拒绝</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>持久授权</h3>
            <span class="meta-pill">{hasTauriRuntime() ? `${agentToolGrants.length} 条` : "桌面端读取"}</span>
          </div>
          {#if !hasTauriRuntime()}
            <div class="empty-box">持久授权需在桌面应用中读取；浏览器预览不会加载真实客户端授权。</div>
          {:else if mcpGrantListRows().length === 0}
            <div class="empty-box">暂无持久授权；点击待确认请求的“允许并记住”后会出现在这里。</div>
          {:else}
            <div class="mcp-request-list">
              {#each mcpGrantListRows() as row}
                {@const grant = agentToolGrants.find((item) => item.client_id === row.clientId && item.tool_name === row.toolName)}
                <div class="mcp-request-row">
                  <div class="setting-label">
                    <span>{row.toolName}</span>
                    <small>{row.clientId} · 更新于 {row.updatedAt}</small>
                    <code>{row.summary}</code>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill active">已授权</span>
                    <button
                      class="plain-button danger"
                      disabled={!grant || mcpRequestBusyKey === `grant:${row.clientId}:${row.toolName}`}
                      onclick={() => grant && revokeMcpGrant(grant)}
                    >撤销</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>最近调用审计</h3>
            <div class="row-actions">
              <span class="meta-pill">{hasTauriRuntime() ? `${mcpRecentAudits.length} 条` : "桌面端读取"}</span>
              <button class="plain-button" onclick={() => activeMenu = "data"}>打开我的数据</button>
            </div>
          </div>
          {#if !hasTauriRuntime()}
            <div class="empty-box">最近调用审计需在桌面应用中读取；浏览器预览不会加载真实 Agent 调用记录。</div>
          {:else if mcpAuditListRows().length === 0}
            <div class="empty-box">暂无调用审计；Agent 或 MCP 调用工具后会在这里显示最近记录。</div>
          {:else}
            <div class="mcp-request-list">
              {#each mcpAuditListRows() as row}
                <div class="mcp-request-row">
                  <div class="setting-label">
                    <span>{row.toolName}</span>
                    <small>{row.clientId} · {row.timestamp}</small>
                    <code>{row.preview}</code>
                  </div>
                  <div class="row-actions">
                    <span
                      class="meta-pill"
                      class:active={row.tone === "success"}
                      class:denied={row.tone === "denied"}
                      class:error={row.tone === "error"}
                      class:pending={row.tone === "pending"}
                    >
                      {row.statusLabel}
                    </span>
                    <span class="meta-pill">{row.durationLabel}</span>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>MCP 服务</h3>
            <button class="plain-button" onclick={refreshMcpPage} disabled={mcpLoading}>刷新</button>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>服务状态</span>
              <small>本地 HTTP MCP Server，只绑定本机地址</small>
            </div>
            <span class="state-pill" class:enabled={mcpConnection().statusTone === "ready"}>{mcpConnection().statusLabel}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>地址</span>
              <small>客户端通过 Bearer Token 访问</small>
            </div>
            <code class="mono-value">{mcpHttpUrl()}</code>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>Token</span>
              <small>{mcpConnection().securityHint}</small>
            </div>
            <code class="mono-value token-value">{mcpConnection().tokenLabel}</code>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>推荐连接</span>
              <small>HTTP ready 时优先 HTTP，否则使用 stdio proxy</small>
            </div>
            <span class="meta-pill">{mcpConnection().recommendedTransport === "http" ? "HTTP MCP" : "stdio proxy"}</span>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>复制配置提示</span>
              <small>复制 HTTP MCP 客户端配置；未启动时复制 stdio fallback 示例</small>
            </div>
            <button class="plain-button" onclick={copyMcpConfig}>复制配置</button>
          </div>
          {#if mcpPageStatus}
            <div class="inline-status">{mcpPageStatus}</div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>客户端模板</h3>
          <div class="tool-list compact-list">
            {#each mcpTemplates() as template}
              {@const installPlan = mcpInstallPlan(template)}
              <div class="tool-row">
                <div class="setting-label">
                  <span>{template.label}</span>
                  <small>{template.description}</small>
                  <div class="mcp-install-plan">
                    <span>{installPlan.targetLabel}</span>
                    <code>{installPlan.targetPath}</code>
                    <code>建议：{installPlan.suggestedTargetPath}</code>
                    <ol>
                      {#each installPlan.steps as step}
                        <li>{step}</li>
                      {/each}
                    </ol>
                    <small>{installPlan.writeReason}</small>
                  </div>
                </div>
                <div class="row-actions">
                  <span class="meta-pill">{template.transport}</span>
                  <span class="meta-pill active">{installPlan.writeStateLabel}</span>
                  <button
                    class="plain-button"
                    onclick={() => installMcpTemplate(template)}
                    disabled={!hasTauriRuntime() || !installPlan.writeAvailable || mcpRequestBusyKey === `mcp:install:${template.id}`}
                  >{mcpRequestBusyKey === `mcp:install:${template.id}` ? "合并中" : installPlan.writeActionLabel}</button>
                  <button class="plain-button" onclick={() => copyMcpTemplate(template)}>复制</button>
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>工具开关</h3>
          {#if agentTools.length === 0}
            <div class="empty-box">暂无可暴露工具</div>
          {:else}
            <div class="tool-list compact-list">
              {#each agentTools as tool}
                <div class="tool-row">
                  <div class="setting-label">
                    <span>{tool.name}</span>
                    <small>{tool.description || "无描述"} · {tool.scopes.join(", ")}</small>
                  </div>
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={tool.enabled}
                      onchange={(event) => toggleAgentTool(tool, (event.target as HTMLInputElement).checked)}
                    />
                    <span></span>
                  </label>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "web"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>网页快开概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={addWebQuickOpenEntry}>添加</button>
              <button class="plain-button" onclick={resetWebQuickOpenEntries}>恢复默认</button>
            </div>
          </div>
          <div class="inline-status">{webQuickOpenStatus} · 在主搜索输入 “g rust” 可快速打开网页搜索</div>
          <div class="inline-status">
            名称、关键字和 URL 模板只保存在本机；预览只打开目标 URL，不会上传搜索词或本地配置。
          </div>
          <div class="web-quick-overview-grid" aria-label="网页快开概览：快开入口、搜索模板、固定网址、保存状态">
            {#each webQuickOpenOverview() as card}
              <div
                class="web-quick-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>快开配置</h3>
          <div class="web-quick-card-grid">
            {#each webQuickOpenEntries as entry}
              <article class="web-quick-card" class:disabled={!entry.enabled}>
                <div class="web-quick-card-head">
                  <label class="toggle compact-toggle">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      aria-label={`${entry.name} 启用状态`}
                      onchange={(event) => updateWebQuickOpenEntry(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                    />
                    <span></span>
                  </label>

                  <div class="web-quick-card-title">
                    <strong>{entry.name}</strong>
                    <small>{webQuickOpenTemplateMode(entry) === "search" ? "搜索模板" : "固定网址"}</small>
                  </div>

                  <span class="web-quick-keyword-chip">{entry.keyword}</span>
                </div>

                <code class="web-quick-preview-url">{webQuickOpenPreviewUrl(entry)}</code>

                <div class="web-quick-card-actions">
                  <button class="plain-button" onclick={() => openWebQuickOpenEditor(entry)}>编辑</button>
                  <button class="plain-button" onclick={() => previewWebQuickOpenEntry(entry)}>预览</button>
                  <button class="plain-button danger" onclick={() => removeWebQuickOpenEntry(entry)}>删除</button>
                </div>
              </article>
            {/each}
          </div>

          {#if webQuickOpenDraft}
            <div class="web-quick-editor-layer">
              <div class="web-quick-editor-panel" role="dialog" aria-modal="true" aria-labelledby="web-quick-editor-title">
                <div class="web-quick-editor-head">
                  <div>
                    <h4 id="web-quick-editor-title">编辑网页快开</h4>
                    <small>调整关键字、打开类型和 URL 模板</small>
                  </div>
                  <button class="plain-button" onclick={closeWebQuickOpenEditor}>关闭</button>
                </div>

                <div class="web-quick-mode-switch" role="group" aria-label="网页快开类型">
                  <button
                    class:active={webQuickOpenTemplateMode(webQuickOpenDraft) === "search"}
                    onclick={() => applyWebQuickOpenMode("search")}
                  >
                    搜索模板
                  </button>
                  <button
                    class:active={webQuickOpenTemplateMode(webQuickOpenDraft) === "direct"}
                    onclick={() => applyWebQuickOpenMode("direct")}
                  >
                    固定网址
                  </button>
                </div>

                <div class="web-quick-editor-fields">
                  <label>
                    <span>名称</span>
                    <input
                      class="text-input"
                      value={webQuickOpenDraft.name}
                      aria-label="编辑快开名称"
                      oninput={(event) => updateWebQuickOpenDraft({ name: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    <span>关键字</span>
                    <input
                      class="text-input keyword-input"
                      value={webQuickOpenDraft.keyword}
                      aria-label="编辑快开关键字"
                      oninput={(event) => updateWebQuickOpenDraft({ keyword: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                  <label>
                    <span>URL 模板</span>
                    <input
                      class="text-input web-template-input"
                      value={webQuickOpenDraft.template}
                      aria-label="编辑 URL 模板"
                      oninput={(event) => updateWebQuickOpenDraft({ template: (event.target as HTMLInputElement).value })}
                    />
                  </label>
                </div>

                <div class="web-quick-preview-box">
                  <span>URL 预览</span>
                  <code>{webQuickOpenPreviewUrl(webQuickOpenDraft)}</code>
                </div>

                {#if webQuickOpenValidation}
                  <div class="inline-status error-status">{webQuickOpenValidation}</div>
                {/if}

                <div class="web-quick-editor-actions">
                  <button class="plain-button" onclick={closeWebQuickOpenEditor}>取消</button>
                  <button class="plain-button primary" onclick={saveWebQuickOpenEditor}>保存</button>
                </div>
              </div>
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>使用方式</h3>
          <div class="shortcut-list">
            <div class="shortcut-row">
              <span>关键字 + 空格</span>
              <small>例如输入 “g tauri” 会打开 Google 搜索 tauri</small>
            </div>
            <div class="shortcut-row">
              <span>{`{query}`}</span>
              <small>URL 模板中用 {`{query}`} 作为搜索词占位，系统会自动 URL encode</small>
            </div>
          </div>
        </section>
      </div>
    {:else if activeMenu === "local"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>本地启动概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={() => addLocalLaunchEntryFromPicker("file")} disabled={!hasTauriRuntime()}>添加文件</button>
              <button class="plain-button" onclick={() => addLocalLaunchEntryFromPicker("folder")} disabled={!hasTauriRuntime()}>添加文件夹</button>
              <button class="plain-button" onclick={() => addLocalLaunchEntryFromPicker("app")} disabled={!hasTauriRuntime()}>添加应用</button>
              <button class="plain-button" onclick={addLocalLaunchEntry}>手动添加</button>
              <button class="plain-button" onclick={resetLocalLaunchEntries}>恢复默认</button>
            </div>
          </div>
          <div class="inline-status">{localLaunchStatus} · 在主搜索输入关键字可打开文件、文件夹或应用</div>
          <div class="inline-status">
            名称、关键字、类型和本地路径只保存在本机；打开或定位路径只在桌面端执行。
          </div>
          <div class="local-launch-overview-grid" aria-label="本地启动概览：启动入口、类型分布、桌面能力、保存状态">
            {#each localLaunchOverview() as card}
              <div
                class="local-launch-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:desktop={card.tone === "desktop"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>启动项配置</h3>
          <div
            class="local-launch-dropzone"
            role="group"
            aria-label="拖拽添加本地启动项"
            ondragover={onLocalLaunchDragOver}
            ondrop={onLocalLaunchDrop}
          >
            <span>拖拽文件或文件夹到这里添加</span>
            <small>桌面端会读取真实路径；浏览器预览仅保留手动编辑和搜索预览</small>
          </div>

          <div class="local-launch-list">
            {#each localLaunchEntries as entry}
              <div class="local-launch-row">
                <label class="toggle">
                  <input
                    type="checkbox"
                    checked={entry.enabled}
                    onchange={(event) => updateLocalLaunchEntry(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                  />
                  <span></span>
                </label>

                <div class="local-launch-fields">
                  <input
                    class="text-input local-name-input"
                    value={entry.name}
                    aria-label="启动项名称"
                    oninput={(event) => updateLocalLaunchEntry(entry.id, { name: (event.target as HTMLInputElement).value })}
                  />
                  <input
                    class="text-input keyword-input"
                    value={entry.keyword}
                    aria-label="启动关键字"
                    oninput={(event) => updateLocalLaunchEntry(entry.id, { keyword: (event.target as HTMLInputElement).value })}
                  />
                  <select
                    class="select-control local-kind-select"
                    value={entry.kind}
                    aria-label="启动项类型"
                    onchange={(event) => updateLocalLaunchEntry(entry.id, { kind: (event.target as HTMLSelectElement).value as LocalLaunchKind })}
                  >
                    <option value="folder">文件夹</option>
                    <option value="file">文件</option>
                    <option value="app">应用</option>
                  </select>
                  <input
                    class="text-input local-path-input"
                    value={entry.path}
                    aria-label="本地路径"
                    oninput={(event) => updateLocalLaunchEntry(entry.id, { path: (event.target as HTMLInputElement).value })}
                  />
                </div>

                <div class="local-launch-actions">
                  <button class="plain-button" onclick={() => openLocalLaunchPath(entry)}>打开</button>
                  <button class="plain-button" onclick={() => revealLocalLaunchPath(entry)}>定位</button>
                  <button class="plain-button danger" onclick={() => removeLocalLaunchEntry(entry)}>删除</button>
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>使用方式</h3>
          <div class="shortcut-list">
            <div class="shortcut-row">
              <span>关键字</span>
              <small>例如输入 “desktop” 会在主搜索中出现 “打开 桌面”</small>
            </div>
            <div class="shortcut-row">
              <span>路径</span>
              <small>支持 `~/Desktop` 这类路径；Tauri 桌面端会在打开时展开为用户目录</small>
            </div>
          </div>
        </section>
      </div>
    {:else if activeMenu === "commands"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>所有指令</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={() => addCommandAlias()}>添加别名</button>
              <button class="plain-button danger" onclick={resetCommandAliases} disabled={commandAliases.length === 0}>清空别名</button>
            </div>
          </div>
          <div class="inline-status">{commandAliasStatus} · 在主搜索输入别名会直接映射到目标指令</div>

          <div class="command-center-summary-grid">
            <div class="command-summary-card">
              <span>可绑定指令</span>
              <strong>{commandCenterSummary().totalTargets}</strong>
              <small>{commandCenterSummary().enabledTargets} 个启用</small>
            </div>
            <div class="command-summary-card">
              <span>指令别名</span>
              <strong>{commandCenterSummary().aliasCount}</strong>
              <small>{commandCenterSummary().enabledAliasCount} 个启用</small>
            </div>
            <div class="command-summary-card">
              <span>固定指令</span>
              <strong>{commandCenterPinnedCount()}</strong>
              <small>显示在主搜索首页</small>
            </div>
            <div class="command-summary-card">
              <span>来源分组</span>
              <strong>{commandCenterSummary().groups.filter((group) => group.count > 0).length}</strong>
              <small>系统 / 本地 / 网页</small>
            </div>
          </div>

          <div class="command-center-shell">
            <aside class="command-source-list" aria-label="指令来源">
              <button
                class:active={commandCenterSourceFilter === "all"}
                onclick={() => commandCenterSourceFilter = "all"}
              >
                <span>全部来源</span>
                <small>{commandCenterSummary().enabledTargets}/{commandCenterSummary().totalTargets} 启用</small>
              </button>
              {#each commandCenterSummary().groups.filter((group) => group.count > 0) as group}
                <button
                  class:active={commandCenterSourceFilter === group.id}
                  onclick={() => commandCenterSourceFilter = group.id}
                >
                  <span>{group.label}</span>
                  <small>{commandCenterSourceDetail(group)}</small>
                </button>
              {/each}
            </aside>

            <div class="command-center-main">
              <div class="command-filter-bar">
                <input
                  class="text-input command-search-input"
                  value={commandCenterQuery}
                  placeholder="搜索名称、路径、code 或别名"
                  aria-label="搜索所有指令"
                  oninput={(event) => commandCenterQuery = (event.target as HTMLInputElement).value}
                />
                <select
                  class="select-control compact"
                  value={commandCenterStatusFilter}
                  aria-label="指令状态"
                  onchange={(event) => commandCenterStatusFilter = (event.target as HTMLSelectElement).value as CommandCenterStatusFilter}
                >
                  <option value="all">全部状态</option>
                  <option value="enabled">仅启用</option>
                  <option value="disabled">仅停用</option>
                </select>
              </div>

              <div class="command-target-list">
                {#if commandCenterFilteredRows().length === 0}
                  <div class="empty-box">没有匹配的指令；可以切换来源、状态或清空搜索。</div>
                {:else}
                  {#each commandCenterFilteredRows() as row}
                    <div class="command-target-row" class:disabled={!row.enabled}>
                      <div class="command-target-icon">{row.sourceLabel.slice(0, 1)}</div>
                      <div class="command-target-body">
                        <div class="command-target-title">
                          <strong>{row.label}</strong>
                          <span class="meta-pill" class:active={row.enabled}>{row.statusLabel}</span>
                          {#if row.pinned}
                            <span class="meta-pill active">{row.pinStatusLabel}</span>
                          {/if}
                        </div>
                        <small>{row.explain || row.code}</small>
                        <div class="command-target-meta">
                          <code>{row.code}</code>
                          <span>{row.aliasLabel}</span>
                          <span>{row.aliasHint}</span>
                        </div>
                        {#if row.aliasPreview.length > 0}
                          <div class="command-alias-preview" aria-label={`${row.label} 已配置别名`}>
                            {#each row.aliasPreview as alias}
                              <span>{alias}</span>
                            {/each}
                          </div>
                        {/if}
                      </div>
                      <div class="row-actions">
                        <button class="plain-button" onclick={() => toggleCommandCenterPinned(row)}>{row.pinLabel}</button>
                        <button
                          class="plain-button"
                          title={canToggleCommandCenterTarget(row) ? `${commandCenterTargetToggleLabel(row)} ${row.label}` : "系统指令不可停用"}
                          disabled={!canToggleCommandCenterTarget(row)}
                          onclick={() => toggleCommandCenterTarget(row)}
                        >{commandCenterTargetToggleLabel(row)}</button>
                        <button class="plain-button" onclick={() => addCommandAlias(row.code)}>{row.aliasActionLabel}</button>
                      </div>
                    </div>
                  {/each}
                {/if}
              </div>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>指令别名</h3>
            <span class="meta-pill">{commandAliases.length} 个</span>
          </div>

          {#if commandAliases.length === 0}
            <div class="empty-box">暂无自定义别名，可以先添加一个短词映射到系统命令、本地启动或网页快开。</div>
          {:else}
            <div class="alias-list">
              {#each commandAliases as entry}
                <div class="alias-row">
                  <label class="toggle">
                    <input
                      type="checkbox"
                      checked={entry.enabled}
                      onchange={(event) => updateCommandAlias(entry.id, { enabled: (event.target as HTMLInputElement).checked })}
                    />
                    <span></span>
                  </label>

                  <div class="alias-fields">
                    <input
                      class="text-input alias-input"
                      value={entry.alias}
                      aria-label="别名"
                      oninput={(event) => updateCommandAlias(entry.id, { alias: (event.target as HTMLInputElement).value })}
                    />
                    <select
                      class="select-control alias-target-select"
                      value={entry.targetCode}
                      aria-label="别名目标"
                      onchange={(event) => updateCommandAlias(entry.id, { targetCode: (event.target as HTMLSelectElement).value })}
                    >
                      {#each aliasTargetOptions() as target}
                        <option value={target.code}>{target.label}</option>
                      {/each}
                    </select>
                    <small>{aliasTargetSummary(entry.targetCode)}</small>
                  </div>

                  <button class="plain-button danger" onclick={() => removeCommandAlias(entry.id)}>删除</button>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "data"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>我的数据</h3>
            <button class="plain-button" onclick={refreshDataPage} disabled={dataLoading}>刷新</button>
          </div>
          {#if dataStatus}
            <div class="inline-status">{dataStatus}</div>
          {/if}
          <div class="data-overview-grid" aria-label="数据概览">
            {#each dataOverview() as card}
              <div class="data-overview-card" class:desktop={card.tone === "desktop"} class:private={card.tone === "private"}>
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
          <div class="inline-status">
            本地隐私边界：设置、最近使用、剪贴板历史、审计记录和插件数据默认保存在本机；Agent 只能通过授权工具读取，并写入本地审计。
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>设置数据</span>
              <small>导出当前设置，或恢复默认设置</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportSettings}>导出</button>
              <button class="plain-button danger" onclick={resetSettings}>恢复默认</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>最近使用历史</span>
              <small>{commandHistoryDetail()}</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportCommandHistory}>导出</button>
              <button class="plain-button danger" onclick={clearCommandHistory} disabled={commandHistory.length === 0}>清空</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>剪贴板历史</span>
              <small>最近 {clipboardHistory.length} 条；仅本地保存，供 Agent 搜索剪贴板历史</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportClipboardHistory} disabled={!hasTauriRuntime() || clipboardHistory.length === 0}>导出</button>
              <button class="plain-button danger" onclick={clearClipboardHistory} disabled={!hasTauriRuntime() || clipboardHistory.length === 0}>清空</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>审计数据</span>
              <small>最近 {recentAudits.length} 条；可复制或归档最多 1000 条 JSONL；保留策略为 {AUDIT_RETENTION_DAYS} 天 / 最新 {AUDIT_KEEP_LATEST} 条</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportAudits} disabled={!hasTauriRuntime()}>导出</button>
              <button class="plain-button" onclick={archiveAudits} disabled={!hasTauriRuntime() || auditArchiveBusy}>归档到文件</button>
              <button class="plain-button" onclick={pruneAuditEntries} disabled={!hasTauriRuntime() || auditPruneBusy}>清理旧记录</button>
              <button class="plain-button danger" onclick={clearAudits} disabled={!hasTauriRuntime()}>清空</button>
            </div>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>插件数据</span>
              <small>{installedPlugins.length} 个插件；按插件读取本地数据文档</small>
            </div>
            <div class="row-actions">
              <button class="plain-button" onclick={exportPluginData} disabled={installedPlugins.length === 0}>导出</button>
              <button class="plain-button danger" onclick={clearPluginData} disabled={installedPlugins.length === 0}>清空</button>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>审计保留策略</h3>
            <button class="plain-button" onclick={pruneAuditEntries} disabled={!hasTauriRuntime() || auditPruneBusy}>按策略清理</button>
          </div>
          <div class="compact-list">
            {#each dataAuditRetentionRows() as row}
              <div class="data-row compact">
                <div class="setting-label">
                  <span>{row.label}</span>
                  <small>{row.detail}</small>
                </div>
                <span
                  class="meta-pill"
                  class:active={row.tone === "private"}
                  class:pending={row.tone === "warning"}
                >
                  {row.value}
                </span>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>审计数据概览</h3>
            <span class="meta-pill">{dataAuditOverview.totalLabel}</span>
          </div>
          {#if recentAudits.length === 0}
            <div class="empty-box">暂无审计记录；Agent 或 MCP 调用工具后会在本地留下可回放记录</div>
          {:else}
            <div class="overview-columns">
              <div class="overview-block">
                <h4>状态分布</h4>
                <div class="compact-list">
                  {#each dataAuditOverview.statusRows as row}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>按权限和执行结果归类</small>
                      </div>
                      <span
                        class="meta-pill"
                        class:active={row.tone === "success"}
                        class:denied={row.tone === "denied"}
                        class:error={row.tone === "error"}
                        class:pending={row.tone === "pending"}
                      >
                        {row.value}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>
              <div class="overview-block">
                <h4>高频工具</h4>
                <div class="compact-list">
                  {#each dataAuditOverview.toolRows as row}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>最近审计记录中的调用次数</small>
                      </div>
                      <span class="meta-pill">{row.value}</span>
                    </div>
                  {/each}
                </div>
              </div>
              <div class="overview-block">
                <h4>客户端</h4>
                <div class="compact-list">
                  {#each dataAuditOverview.clientRows as row}
                    <div class="data-row compact">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>最近审计记录中的来源客户端</small>
                      </div>
                      <span class="meta-pill">{row.value}</span>
                    </div>
                  {/each}
                </div>
              </div>
            </div>
            <div class="overview-block">
              <h4>最近记录</h4>
              <div class="compact-list">
                {#each dataAuditOverview.recentRows as row}
                  <div class="data-row">
                    <div class="setting-label">
                      <span>{row.label}</span>
                      <small>{row.detail}</small>
                    </div>
                    <div class="overview-row-meta">
                      <span
                        class="meta-pill"
                        class:active={row.tone === "success"}
                        class:denied={row.tone === "denied"}
                        class:error={row.tone === "error"}
                        class:pending={row.tone === "pending"}
                      >
                        {row.value}
                      </span>
                      {#if row.meta}
                        <code class="mono-value">{row.meta}</code>
                      {/if}
                    </div>
                  </div>
                {/each}
              </div>
            </div>
            <div class="overview-block">
              <h4>异常记录</h4>
              {#if dataAuditOverview.errorRows.length === 0}
                <div class="empty-box">暂无拒绝或失败记录</div>
              {:else}
                <div class="compact-list">
                  {#each dataAuditOverview.errorRows as row}
                    <div class="data-row">
                      <div class="setting-label">
                        <span>{row.label}</span>
                        <small>{row.meta}</small>
                      </div>
                      <div class="audit-error-meta">
                        <span class="meta-pill" class:denied={row.tone === "denied"} class:error={row.tone === "error"}>{row.value}</span>
                        <code class="mono-value">{row.detail}</code>
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>剪贴板历史明细</h3>
          {#if clipboardHistory.length === 0}
            <div class="empty-box">暂无剪贴板历史；Agent 调用 search_clipboard 后会记录当前文本剪贴板</div>
          {:else}
            <div class="compact-list">
              {#each clipboardHistory.slice(0, 12) as entry}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{entry.text}</span>
                    <small>{entry.last_copied_at} · {entry.used_count} 次 · {entry.id}</small>
                  </div>
                  <span class="meta-pill">text</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>插件数据概览</h3>
          {#if pluginDataSummary.length === 0}
            <div class="empty-box">暂无插件数据</div>
          {:else}
            <div class="compact-list">
              {#each pluginDataSummary as item}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{item.plugin.name}</span>
                    <small>{item.plugin.id}{item.error ? ` · ${item.error}` : ""}</small>
                  </div>
                  <span class="meta-pill">{item.documents} 条</span>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>最近使用明细</h3>
          {#if commandHistory.length === 0}
            <div class="empty-box">暂无最近使用历史</div>
          {:else}
            <div class="compact-list">
              {#each commandHistory.slice(0, 12) as entry}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{entry.label}</span>
                    <small>{commandHistoryRowDetail(entry)}</small>
                  </div>
                  <div class="row-actions">
                    <span class="meta-pill">{entry.code}</span>
                    <button class="plain-button danger" onclick={() => removeCommandHistoryItem(entry.code)}>删除</button>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "sync"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>WebDAV 概览</h3>
            <span
              class="state-pill"
              class:enabled={webdavEnabled && webdavConfigReady()}
              class:error={webdavEnabled && !webdavConfigReady()}
            >
              {webdavStatusText()}
            </span>
          </div>
          <div class="inline-status">
            密码或 Token 仅本机保存；检查远端备份只读取 manifest 和文件摘要，不会覆盖本机设置、插件数据或剪贴板历史。
          </div>
          <div class="webdav-overview-grid" aria-label="WebDAV 概览：连接配置、远端目录、同步范围、最近结果">
            {#each webdavOverview() as card}
              <div
                class="webdav-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:desktop={card.tone === "desktop"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>连接配置</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>启用 WebDAV 配置</span>
              <small>配置完整后可作为后续设置、插件数据和剪贴板历史同步入口</small>
            </div>
            <label class="toggle">
              <input
                type="checkbox"
                checked={webdavEnabled && webdavConfigReady()}
                disabled={!webdavConfigReady()}
                aria-label="启用 WebDAV 配置"
                title={webdavConfigReady() ? "启用 WebDAV 配置" : "填写服务器地址和用户名后可启用"}
                onchange={(event) => updateWebdavEnabled(
                  (event.currentTarget as HTMLInputElement).checked,
                  event.currentTarget as HTMLInputElement,
                )}
              />
              <span></span>
            </label>
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>服务器地址</span>
              <small>仅支持 http 或 https WebDAV 地址</small>
            </div>
            <input
              class="text-input wide"
              bind:value={webdavUrl}
              placeholder="https://dav.example.com/remote.php/dav/files/user/"
              aria-label="WebDAV 服务器地址"
              oninput={persistWebdavConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>用户名</span>
              <small>账号只保存在本机设置中</small>
            </div>
            <input
              class="text-input wide"
              bind:value={webdavUsername}
              placeholder="username"
              aria-label="WebDAV 用户名"
              oninput={persistWebdavConfigChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>密码 / Token</span>
              <small>建议使用应用专用密码或 token</small>
            </div>
            <input
              class="text-input wide"
              type="password"
              bind:value={webdavPassword}
              placeholder="app password"
              aria-label="WebDAV 密码或 Token"
              oninput={persistWebdavScopeChange}
            />
          </div>

          <div class="setting-item">
            <div class="setting-label">
              <span>远端目录</span>
              <small>ATools 数据会统一放到该远端目录下</small>
            </div>
            <input
              class="text-input wide"
              bind:value={webdavRemotePath}
              placeholder="/ATools"
              aria-label="WebDAV 远端目录"
              oninput={persistWebdavScopeChange}
            />
          </div>
        </section>

        <section class="setting-group">
          <h3>同步范围</h3>
          <div class="setting-item">
            <div class="setting-label">
              <span>同步设置</span>
              <small>通用设置、网页快开、本地启动和命令别名</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={webdavSyncSettings} onchange={persistWebdavScopeChange} />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>同步插件数据</span>
              <small>插件本地数据可能较大；恢复时只追加缺失文档，冲突文档会跳过</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={webdavSyncPlugins} onchange={persistWebdavScopeChange} />
              <span></span>
            </label>
          </div>
          <div class="setting-item">
            <div class="setting-label">
              <span>同步剪贴板历史</span>
              <small>默认关闭；开启前应确认隐私风险</small>
            </div>
            <label class="toggle">
              <input type="checkbox" bind:checked={webdavSyncClipboard} onchange={persistWebdavScopeChange} />
              <span></span>
            </label>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>同步状态</h3>
            <div class="row-actions">
              <button
                class="plain-button"
                onclick={previewWebdavBackup}
                disabled={webdavPreviewButton().disabled}
                title={webdavPreviewButton().reason}
              >
                {webdavPreviewButton().label}
              </button>
              <button
                class="plain-button"
                onclick={planWebdavRestore}
                disabled={webdavRestorePlanButton().disabled}
                title={webdavRestorePlanButton().reason}
              >
                {webdavRestorePlanButton().label}
              </button>
              <button
                class="plain-button"
                onclick={restoreWebdavSettings}
                disabled={webdavSettingsRestoreButton().disabled}
                title={webdavSettingsRestoreButton().reason}
              >
                {webdavSettingsRestoreButton().label}
              </button>
              <button
                class="plain-button"
                onclick={restoreWebdavClipboardHistory}
                disabled={webdavClipboardRestoreButton().disabled}
                title={webdavClipboardRestoreButton().reason}
              >
                {webdavClipboardRestoreButton().label}
              </button>
              <button
                class="plain-button"
                onclick={() => restoreWebdavPluginData()}
                disabled={webdavPluginDataRestoreButton().disabled}
                title={webdavPluginDataRestoreButton().reason}
              >
                {webdavPluginDataRestoreButton().label}
              </button>
              <button
                class="plain-button danger"
                onclick={() => restoreWebdavPluginData("overwrite_conflicts")}
                disabled={webdavPluginDataOverwriteButton().disabled}
                title={webdavPluginDataOverwriteButton().reason}
              >
                {webdavPluginDataOverwriteButton().label}
              </button>
              <button
                class="plain-button danger"
                onclick={() => restoreWebdavPluginData("overwrite_selected_conflicts")}
                disabled={webdavPluginDataSelectedOverwriteButton().disabled}
                title={webdavPluginDataSelectedOverwriteButton().reason}
              >
                {webdavPluginDataSelectedOverwriteButton().label}
              </button>
              <button
                class="plain-button"
                onclick={syncWebdavNow}
                disabled={webdavSyncButton().disabled}
                title={webdavSyncButton().reason}
              >
                {webdavSyncButton().label}
              </button>
            </div>
          </div>
          {#if webdavSyncStatus}
            <div class="inline-status">{webdavSyncStatus}</div>
          {:else}
            <div class="inline-status">
              检查远端备份只读取 manifest 和文件摘要，不会覆盖本机设置、插件数据或剪贴板历史。
            </div>
          {/if}
          <div class="debug-grid">
            {#each webdavStatusRows() as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
          {#if webdavLastPreview}
            <div class="remote-preview">
              <h4>远端备份预览</h4>
              <div class="debug-grid">
                {#each webdavRemotePreviewRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                当前只检查远端备份内容，不会覆盖本机设置、插件数据或剪贴板历史。
              </div>
            </div>
          {/if}
          {#if webdavLastRestorePlan}
            <div class="remote-preview">
              <h4>恢复计划预览</h4>
              <div class="debug-grid">
                {#each webdavRemoteRestorePlanRows() as row}
                  <div class="debug-row" class:warning={row.value.includes("高风险")}>
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                设置项可点击“恢复设置”后确认写入；剪贴板历史可追加导入；插件数据可追加导入，冲突文档会跳过，也可勾选后只覆盖选中冲突。
              </div>
              {#if webdavPluginConflicts().length}
                <div class="webdav-conflict-list">
                  <div class="section-heading compact-heading">
                    <h4>插件数据冲突选择</h4>
                    <div class="row-actions">
                      <button class="plain-button" onclick={selectAllWebdavPluginConflicts}>全选冲突</button>
                      <button class="plain-button" onclick={clearSelectedWebdavPluginConflicts}>清空选择</button>
                    </div>
                  </div>
                  <div class="compact-list">
                    {#each webdavPluginConflicts() as conflict}
                      <label class="webdav-conflict-row">
                        <input
                          type="checkbox"
                          checked={webdavSelectedPluginConflictKeys.includes(webdavPluginConflictKey(conflict))}
                          onchange={(event) => toggleWebdavPluginConflict(conflict, (event.target as HTMLInputElement).checked)}
                        />
                        <span>{conflict.plugin_name || conflict.plugin_id}</span>
                        <code>{conflict.doc_id}</code>
                        <small>{conflict.local_summary} -> {conflict.remote_summary}</small>
                      </label>
                    {/each}
                  </div>
                  <div class="inline-status">
                    已选择 {webdavSelectedPluginConflicts().length} / {webdavPluginConflicts().length} 条冲突；点击“覆盖选中冲突”后只覆盖这些文档。
                  </div>
                </div>
              {/if}
            </div>
          {/if}
          {#if webdavLastSettingsRestore}
            <div class="remote-preview">
              <h4>设置恢复结果</h4>
              <div class="debug-grid">
                {#each webdavRemoteSettingsRestoreRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                已通过现有设置保存链路应用到本机；远端脱敏字段保持本机原值。
              </div>
            </div>
          {/if}
          {#if webdavLastClipboardRestore}
            <div class="remote-preview">
              <h4>剪贴板导入结果</h4>
              <div class="debug-grid">
                {#each webdavRemoteClipboardRestoreRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                只追加导入本机缺失的文本历史；不会清空、覆盖或上传当前系统剪贴板。
              </div>
            </div>
          {/if}
          {#if webdavLastPluginDataRestore}
            <div class="remote-preview">
              <h4>插件数据导入结果</h4>
              <div class="debug-grid">
                {#each webdavRemotePluginDataRestoreRows() as row}
                  <div class="debug-row">
                    <span>{row.label}</span>
                    <code>{row.value}</code>
                  </div>
                {/each}
              </div>
              <div class="inline-status">
                追加导入会跳过冲突文档；点击“覆盖冲突数据”并确认后，同 ID 冲突文档会被远端覆盖。
              </div>
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "debug"}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>诊断概览</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={refreshDebugPage} disabled={debugLoading}>刷新</button>
              <button class="plain-button" onclick={copyDebugInfo}>复制信息</button>
            </div>
          </div>
          {#if debugStatus}
            <div class="inline-status">{debugStatus}</div>
          {/if}
          <div class="inline-status">
            脱敏诊断包不会包含 MCP token、AI API Key 或 WebDAV 密码；路径、审计和崩溃信息仅保存在本机。
          </div>
          <div class="debug-overview-grid" aria-label="诊断概览：桌面运行时、MCP 服务、审计异常、崩溃日志">
            {#each debugOverview() as card}
              <div
                class="debug-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
                class:error={card.tone === "error"}
                class:desktop={card.tone === "desktop"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>环境信息</h3>
          <div class="debug-grid">
            {#each environmentRows() as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>桌面运行状态</h3>
          <div class="debug-grid">
            {#each runtimeDebugRows() as row}
              <div class="debug-row diagnostic-row" class:warning={row.tone === "warning"} class:error={row.tone === "error"}>
                <span>{row.label}</span>
                <div class="debug-value">
                  <code>{row.value}</code>
                  {#if row.detail}
                    <small>{row.detail}</small>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>本地配置状态</h3>
          <div class="debug-grid">
            {#each localDebugRows() as row}
              <div class="debug-row diagnostic-row" class:warning={row.tone === "warning"} class:error={row.tone === "error"}>
                <span>{row.label}</span>
                <div class="debug-value">
                  <code>{row.value}</code>
                  {#if row.detail}
                    <small>{row.detail}</small>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>MCP 状态</h3>
          <div class="debug-grid">
            <div class="debug-row">
              <span>状态</span>
              <code>{debugMcpStatus?.enabled ? "运行中" : "未启动"}</code>
            </div>
            <div class="debug-row">
              <span>地址</span>
              <code>{debugMcpStatus ? `http://${debugMcpStatus.bind}/mcp` : "无"}</code>
            </div>
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>崩溃日志</h3>
            <div class="row-actions">
              <button class="plain-button" onclick={copyCrashLog} disabled={!hasTauriRuntime() || crashLogs.length === 0}>复制日志</button>
              <button class="plain-button danger" onclick={clearCrashLog} disabled={!hasTauriRuntime() || crashLogs.length === 0}>清空</button>
            </div>
          </div>
          {#if crashLogRows().length === 0}
            <div class="empty-box">暂无崩溃日志；panic 会写入本地 crashes.log</div>
          {:else}
            <div class="compact-list">
              {#each crashLogRows() as crash}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{crash.title}</span>
                    <small>{crash.detail}</small>
                  </div>
                  <code class="mono-value">{crash.raw}</code>
                </div>
              {/each}
            </div>
          {/if}
        </section>

        <section class="setting-group">
          <h3>最近审计错误</h3>
          {#if auditErrorRows().length === 0}
            <div class="empty-box">暂无审计错误</div>
          {:else}
            <div class="compact-list">
              {#each auditErrorRows() as audit}
                <div class="data-row">
                  <div class="setting-label">
                    <span>{audit.toolName}</span>
                    <small>{audit.clientId} · {audit.timestamp} · {audit.duration}</small>
                  </div>
                  <div class="audit-error-meta">
                    <span class="meta-pill error">{audit.status}</span>
                    <code class="mono-value">{audit.message}</code>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "http"}
      {@const httpStatus = httpStatusPage()}
      {@const httpSummary = httpOverview()}
      <div class="content-panel">
        <section class="setting-group">
          <div class="section-heading">
            <h3>HTTP 服务概览</h3>
            <span class="state-pill error">{httpStatus.label}</span>
          </div>
          <div class="inline-status">{httpStatus.summary}</div>
          <div class="inline-status">传统 HTTP API 不在当前版本启用；自动化入口统一收敛到本机 MCP 服务。</div>
          <div class="http-overview-grid" aria-label="HTTP 服务概览：HTTP API、替代入口、认证审计、客户端配置">
            {#each httpSummary as card}
              <div
                class="http-overview-card"
                class:ready={card.tone === "ready"}
                class:warning={card.tone === "warning"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>MCP 连接入口</h3>
            <span class="state-pill" class:enabled={mcpConnection().statusTone === "ready"}>{mcpConnection().statusLabel}</span>
          </div>
          <div class="inline-status">{mcpConnection().securityHint}</div>
          <div class="debug-grid">
            {#each httpStatus.rows as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
          <div class="compact-list">
            <div class="data-row">
              <div class="setting-label">
                <span>MCP 地址</span>
                <small>本地 HTTP MCP + Bearer token；工具调用会进入权限确认和审计链路</small>
              </div>
              <div class="row-actions">
                <code class="mono-value">{mcpConnection().httpUrl}</code>
                <button class="plain-button" onclick={copyHttpMcpUrl} disabled={!mcpConnection().tokenAvailable}>复制 MCP 地址</button>
              </div>
            </div>
            <div class="data-row">
              <div class="setting-label">
                <span>客户端配置</span>
                <small>HTTP MCP 未就绪时会复制 stdio proxy fallback；权限和审计仍在桌面端处理</small>
              </div>
              <div class="row-actions">
                <button class="plain-button" onclick={copyHttpMcpConfig}>复制 MCP 配置</button>
                <button class="plain-button" onclick={() => activeMenu = "mcp"}>查看 MCP 服务</button>
              </div>
            </div>
            <div class="data-row muted-row">
              <div class="setting-label">
                <span>传统 HTTP API</span>
                <small>例如 show/hide/toggle 主窗口的 REST API，首版暂不启用</small>
              </div>
              <span class="meta-pill">未接入</span>
            </div>
          </div>
          {#if mcpPageStatus}
            <div class="inline-status">{mcpPageStatus}</div>
          {/if}
        </section>
      </div>
    {:else if activeMenu === "about"}
      {@const about = aboutPage()}
      {@const aboutSummary = aboutOverview()}
      <div class="content-panel about-panel">
        <section class="setting-group">
          <div class="section-heading">
            <div class="about-title-row">
              <div class="about-logo compact" aria-hidden="true">A</div>
              <div>
                <h3>关于概览</h3>
                <small>{about.title} · v{about.version}</small>
              </div>
            </div>
            <span class="state-pill" class:enabled={!aboutLoading}>{aboutLoading ? "刷新中" : "已就绪"}</span>
          </div>
          <div class="inline-status">
            诊断包只包含本机运行状态和脱敏配置；MCP token、AI API Key 和 WebDAV 密码不会写入复制内容。
          </div>
          <div class="about-overview-grid" aria-label="关于概览：版本、桌面运行时、本地 MCP、诊断包">
            {#each aboutSummary as card}
              <div
                class="about-overview-card"
                class:ready={card.tone === "ready"}
                class:desktop={card.tone === "desktop"}
                class:private={card.tone === "private"}
              >
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>产品方向</h3>
          <div class="about-card-grid">
            {#each about.cards as card}
              <div class="about-card">
                <span>{card.label}</span>
                <strong>{card.value}</strong>
                <small>{card.detail}</small>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <div class="section-heading">
            <h3>运行信息</h3>
            <span class="state-pill" class:enabled={!aboutLoading}>{aboutLoading ? "刷新中" : "已就绪"}</span>
          </div>
          <div class="debug-grid">
            {#each about.rows as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>本地环境</h3>
          <div class="debug-grid">
            {#each aboutRuntimeRows() as row}
              <div class="debug-row">
                <span>{row.label}</span>
                <code>{row.value}</code>
              </div>
            {/each}
          </div>
        </section>

        <section class="setting-group">
          <h3>诊断入口</h3>
          <div class="compact-list">
            <div class="data-row">
              <div class="setting-label">
                <span>复制运行信息</span>
                <small>版本、平台、本地数据路径、Agent 工具数量和 MCP 监听地址；token 会隐藏</small>
              </div>
              <button class="plain-button" onclick={copyAboutRuntimeInfo}>复制运行信息</button>
            </div>
            <div class="data-row">
              <div class="setting-label">
                <span>复制脱敏诊断</span>
                <small>复制 atools_diagnostic_bundle；不包含 MCP token、AI API Key 或 WebDAV 密码</small>
              </div>
              <button class="plain-button" onclick={copyAboutDiagnosticBundle}>复制脱敏诊断</button>
            </div>
            <div class="data-row">
              <div class="setting-label">
                <span>排障页面</span>
                <small>进入调试日志查看运行事件，或进入 MCP 服务复制客户端配置</small>
              </div>
              <div class="row-actions">
                <button class="plain-button" onclick={() => activeMenu = "debug"}>打开调试日志</button>
                <button class="plain-button" onclick={() => activeMenu = "mcp"}>打开 MCP 服务</button>
              </div>
            </div>
          </div>
          {#if aboutPageStatus}
            <div class="inline-status">{aboutPageStatus}</div>
          {/if}
        </section>
      </div>
    {:else}
      <div class="content-panel placeholder-panel">
        <section class="setting-group">
          <h3>{menuItems.find((item) => item.id === activeMenu)?.label}</h3>
          {#each placeholderPages[activeMenu as MenuId] ?? [] as row}
            <div class="setting-item">
              <div class="setting-label">
                <span>{row.title}</span>
                <small>{row.desc}</small>
              </div>
              <span class="meta-pill">{row.meta}</span>
            </div>
          {/each}
        </section>
      </div>
    {/if}
  </main>
  {#if settingsConfirmRequest}
    <SettingsConfirmDialog
      title={settingsConfirmRequest.title}
      message={settingsConfirmRequest.message}
      confirmLabel={settingsConfirmRequest.confirmLabel}
      cancelLabel={settingsConfirmRequest.cancelLabel}
      tone={settingsConfirmRequest.tone}
      onconfirm={() => resolveSettingsConfirm(true)}
      oncancel={() => resolveSettingsConfirm(false)}
    />
  {/if}
</section>

<style>
  .settings-panel {
    position: relative;
    height: 100%;
    min-height: 0;
    display: flex;
    overflow: hidden;
    color: #333333;
    background: rgba(244, 244, 244, 0.72);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 12%, white);
    --settings-divider: rgba(0, 0, 0, 0.1);
    --settings-control: rgba(0, 0, 0, 0.035);
    --settings-control-border: rgba(0, 0, 0, 0.1);
    --settings-text-secondary: #616161;
  }

  .settings-sidebar {
    width: clamp(300px, 25vw, 400px);
    flex-shrink: 0;
    overflow-y: auto;
    padding: 46px 28px 28px 16px;
    border-right: 1px solid var(--settings-divider);
  }

  .menu-item {
    width: 100%;
    min-height: 80px;
    display: flex;
    align-items: center;
    gap: 20px;
    margin-bottom: 8px;
    padding: 18px 24px;
    border-radius: 14px;
    color: #333333;
    background: transparent;
    font-size: 24px;
    text-align: left;
    transition: background 0.16s ease, box-shadow 0.16s ease, color 0.16s ease;
  }

  .menu-item:hover {
    background: var(--settings-hover);
  }

  .menu-item.active {
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--settings-primary) 10%, transparent);
    font-weight: 600;
  }

  .menu-icon {
    width: 32px;
    height: 32px;
    flex: 0 0 32px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .save-status {
    display: block;
    margin: 12px 24px 0;
    color: var(--settings-text-secondary);
    font-size: 13px;
    line-height: 1.4;
  }

  .settings-content {
    min-width: 0;
    flex: 1;
    overflow: hidden;
  }

  .content-panel {
    height: 100%;
    overflow-x: hidden;
    overflow-y: auto;
    padding: 60px 50px 56px 40px;
    background: rgba(244, 244, 244, 0.72);
  }

  .settings-sidebar,
  .content-panel {
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: rgba(0, 0, 0, 0.2) transparent;
  }

  .settings-sidebar::-webkit-scrollbar,
  .content-panel::-webkit-scrollbar {
    width: 10px;
    height: 10px;
  }

  .settings-sidebar::-webkit-scrollbar-track,
  .content-panel::-webkit-scrollbar-track {
    background: transparent;
  }

  .settings-sidebar::-webkit-scrollbar-thumb,
  .content-panel::-webkit-scrollbar-thumb {
    border: 3px solid transparent;
    border-radius: 999px;
    background-color: rgba(0, 0, 0, 0.2);
    background-clip: content-box;
  }

  .settings-sidebar::-webkit-scrollbar-thumb:hover,
  .content-panel::-webkit-scrollbar-thumb:hover {
    background-color: rgba(0, 0, 0, 0.32);
  }

  .setting-group {
    margin-bottom: 44px;
  }

  .settings-fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  .settings-fieldset:disabled {
    opacity: 0.72;
  }

  .setting-group:last-child {
    margin-bottom: 0;
  }

  .setting-group h3 {
    margin: 0 0 22px;
    color: var(--settings-primary);
    font-size: 26px;
    font-weight: 700;
    line-height: 1.4;
  }

  .setting-item {
    min-height: 116px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 24px;
    padding: 28px 0;
    border-bottom: 1px solid var(--settings-divider);
  }

  .setting-group .setting-item:last-child {
    border-bottom: 0;
  }

  .setting-label {
    min-width: 0;
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .setting-label span {
    color: #333333;
    font-size: 24px;
    font-weight: 600;
    line-height: 1.25;
    white-space: nowrap;
  }

  .setting-label small {
    max-width: 100%;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 20px;
    font-weight: 400;
    line-height: 1.32;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .setting-control {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .hotkey-input,
  .select-control,
  .text-input,
  .number-input {
    height: 66px;
    border: 2px solid var(--settings-control-border);
    border-radius: 9px;
    color: #333333;
    background: var(--settings-control);
    font: inherit;
    font-size: 22px;
    outline: none;
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .hotkey-input {
    width: 300px;
    text-align: center;
    font-size: 24px;
    font-weight: 600;
  }

  .hotkey-input[readonly] {
    cursor: pointer;
  }

  .hotkey-input.recording {
    color: var(--settings-primary);
    border-color: color-mix(in srgb, var(--settings-primary) 70%, var(--settings-control-border));
    background: var(--settings-primary-soft);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--settings-primary) 12%, transparent);
  }

  .text-input {
    width: 380px;
    padding: 0 18px;
  }

  .text-input.wide {
    width: 440px;
  }

  .number-input {
    width: 150px;
    padding: 0 18px;
  }

  .select-control {
    min-width: 300px;
    padding: 0 58px 0 24px;
    appearance: none;
    background:
      linear-gradient(45deg, transparent 50%, #616161 50%) calc(100% - 29px) 29px / 9px 9px no-repeat,
      linear-gradient(135deg, #616161 50%, transparent 50%) calc(100% - 22px) 29px / 9px 9px no-repeat,
      var(--settings-control);
  }

  .select-control.compact {
    min-width: 120px;
  }

  .hotkey-input:focus,
  .select-control:focus,
  .text-input:focus,
  .number-input:focus {
    border-color: color-mix(in srgb, var(--settings-primary) 62%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 10%, white);
  }

  .icon-button,
  .plain-button {
    min-height: 54px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 2px solid var(--settings-control-border);
    border-radius: 9px;
    color: #333333;
    background: var(--settings-control);
    font-size: 19px;
    font-weight: 600;
    transition: border-color 0.16s ease, color 0.16s ease, background 0.16s ease;
  }

  .icon-button {
    width: 56px;
  }

  .icon-button svg {
    width: 26px;
    height: 26px;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .plain-button {
    padding: 0 22px;
  }

  .icon-button:hover:not(:disabled),
  .icon-button.active,
  .plain-button:hover:not(:disabled) {
    color: var(--settings-primary);
    border-color: color-mix(in srgb, var(--settings-primary) 55%, var(--settings-control-border));
    background: var(--settings-hover);
  }

  .plain-button.danger:hover:not(:disabled) {
    color: #dc2626;
    border-color: rgba(220, 38, 38, 0.42);
    background: rgba(220, 38, 38, 0.1);
  }

  .plain-button.primary {
    color: #ffffff;
    border-color: var(--settings-primary);
    background: var(--settings-primary);
  }

  .plain-button.primary:hover:not(:disabled) {
    color: #ffffff;
    border-color: color-mix(in srgb, var(--settings-primary) 86%, #000000);
    background: color-mix(in srgb, var(--settings-primary) 92%, #000000);
  }

  button:disabled,
  input:disabled,
  select:disabled {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .toggle {
    position: relative;
    width: 86px;
    height: 48px;
    flex: 0 0 86px;
    display: inline-block;
  }

  .toggle input {
    position: absolute;
    inset: 0;
    z-index: 2;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }

  .toggle span {
    position: absolute;
    inset: 0;
    pointer-events: none;
    border: 2px solid rgba(0, 0, 0, 0.12);
    border-radius: 999px;
    background: rgba(0, 0, 0, 0.03);
    transition: border-color 0.16s ease, background 0.16s ease;
  }

  .toggle span::before {
    content: "";
    position: absolute;
    top: 5px;
    left: 5px;
    width: 34px;
    height: 34px;
    border-radius: 50%;
    background: #333333;
    transition: transform 0.18s ease, background 0.18s ease;
  }

  .toggle input:checked + span {
    border-color: color-mix(in srgb, var(--settings-primary) 60%, white);
    background: color-mix(in srgb, var(--settings-primary) 28%, white);
  }

  .toggle input:checked + span::before {
    transform: translateX(38px);
    background: var(--settings-primary);
  }

  .blocked-row {
    align-items: stretch;
  }

  .blocked-main {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .blocked-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .inline-form {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .inline-form .text-input {
    flex: 1;
    min-width: 0;
  }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 10px 12px;
    border: 2px solid var(--settings-control-border);
    border-radius: 6px;
    background: var(--settings-control);
  }

  .tag {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid var(--settings-control-border);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.42);
    font-size: 12px;
  }

  .tag button {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    color: var(--settings-text-secondary);
    line-height: 1;
  }

  .tag button:hover {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.12);
  }

  .color-control {
    min-width: 260px;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .color-dot {
    position: relative;
    width: 23px;
    height: 23px;
    border: 2px solid transparent;
    border-radius: 50%;
    background: var(--dot-color);
    box-shadow:
      0 0 0 1px rgba(0, 0, 0, 0.1),
      0 1px 3px rgba(0, 0, 0, 0.15);
    transition: transform 0.16s ease, border-color 0.16s ease;
  }

  .color-dot:hover,
  .color-dot.active {
    transform: scale(1.1);
  }

  .color-dot.active {
    border-color: #333333;
  }

  .color-dot.active::after {
    content: "";
    position: absolute;
    top: 50%;
    left: 50%;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #ffffff;
    transform: translate(-50%, -50%);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
  }

  .color-picker-input {
    width: 36px;
    height: 28px;
    padding: 0;
    border: 2px solid var(--settings-control-border);
    border-radius: 6px;
    background: var(--settings-control);
  }

  .quick-actions-wrapper {
    position: relative;
    flex: 0 0 auto;
  }

  .quick-actions-dropdown {
    position: absolute;
    top: calc(100% + 8px);
    right: 0;
    z-index: 20;
    width: 268px;
    padding: 6px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: color-mix(in srgb, var(--bg-primary) 96%, white);
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.16);
  }

  .quick-actions-item {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 9px 10px;
    border-radius: 6px;
    color: #333333;
    text-align: left;
  }

  .quick-actions-item:hover,
  .quick-actions-item.active {
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
  }

  .quick-actions-item span {
    font-size: 13px;
    font-weight: 700;
    line-height: 1.25;
  }

  .quick-actions-item small {
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 11px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .quick-actions-item.reset {
    margin-top: 4px;
    border-top: 1px solid var(--settings-divider);
    border-radius: 0 0 6px 6px;
  }

  .range-control {
    width: 260px;
    display: grid;
    grid-template-columns: 1fr 44px;
    align-items: center;
    gap: 12px;
  }

  .range-control input {
    accent-color: var(--settings-primary);
  }

  .range-control output {
    color: var(--settings-text-secondary);
    font-size: 12px;
    text-align: right;
  }

  .section-heading {
    min-height: 34px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    margin-bottom: 4px;
  }

  .row-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .shortcut-tab-bar {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
    margin: 12px 0;
  }

  .shortcut-tab {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    color: #333333;
    background: var(--settings-control);
    text-align: left;
  }

  .shortcut-tab:hover,
  .shortcut-tab.active {
    color: var(--settings-primary);
    border-color: color-mix(in srgb, var(--settings-primary) 45%, var(--settings-control-border));
    background: var(--settings-primary-soft);
  }

  .shortcut-tab span {
    overflow: hidden;
    font-size: 13px;
    font-weight: 800;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shortcut-tab small {
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 11px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shortcut-summary-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .shortcut-summary-card {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .shortcut-summary-card span,
  .shortcut-summary-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .shortcut-summary-card strong {
    display: block;
    margin: 4px 0;
    overflow: hidden;
    color: #333333;
    font-size: 16px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .general-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0 0;
  }

  .general-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .general-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .general-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .general-overview-card span,
  .general-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .general-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .http-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .http-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .http-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .http-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .http-overview-card span,
  .http-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .http-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .shortcut-card-list {
    border-top: 1px solid var(--settings-divider);
  }

  .shortcut-card-row {
    min-height: 58px;
    display: grid;
    grid-template-columns: 132px minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--settings-divider);
  }

  .custom-shortcut-list {
    margin-bottom: 12px;
  }

  .app-shortcut-row {
    grid-template-columns: 48px 132px minmax(0, 1fr) auto;
  }

  .shortcut-edit-input {
    width: 100%;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 700;
  }

  .shortcut-key-display {
    min-width: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 7px 10px;
    border: 1px solid var(--settings-control-border);
    border-radius: 6px;
    color: #333333;
    background: rgba(255, 255, 255, 0.4);
    font-size: 12px;
    font-weight: 800;
    line-height: 1.2;
    text-align: center;
  }

  .alias-shortcut-row {
    grid-template-columns: 96px minmax(0, 1fr) auto;
  }

  .state-pill,
  .inline-status,
  .empty-box {
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.4;
  }

  .state-pill {
    max-width: 260px;
    padding: 5px 10px;
    border: 1px solid var(--settings-control-border);
    border-radius: 999px;
    background: var(--settings-control);
    text-align: center;
  }

  .state-pill.enabled {
    color: var(--settings-primary);
    border-color: color-mix(in srgb, var(--settings-primary) 48%, var(--settings-control-border));
    background: var(--settings-primary-soft);
  }

  .state-pill.error {
    color: #dc2626;
    border-color: rgba(220, 38, 38, 0.36);
    background: rgba(220, 38, 38, 0.1);
  }

  .inline-status,
  .empty-box {
    margin: 10px 0;
    padding: 10px 12px;
    border: 1px solid var(--settings-control-border);
    border-radius: 6px;
    background: var(--settings-control);
  }

  .inline-status.compact-status {
    margin: 0;
    padding: 7px 10px;
  }

  .inline-status.error-status {
    color: #dc2626;
    border-color: rgba(220, 38, 38, 0.36);
    background: rgba(220, 38, 38, 0.09);
  }

  .mono-value,
  .debug-row code {
    max-width: 360px;
    overflow: hidden;
    color: #333333;
    font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
    font-size: 12px;
    line-height: 1.4;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .debug-value {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .debug-value code {
    max-width: none;
  }

  .debug-value small {
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .diagnostic-row.warning .debug-value code {
    color: #b45309;
  }

  .diagnostic-row.error .debug-value code {
    color: #dc2626;
  }

  .token-value {
    max-width: 300px;
  }

  .mcp-install-plan {
    display: grid;
    gap: 4px;
    margin-top: 8px;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
  }

  .mcp-install-plan span {
    color: #333333;
    font-weight: 700;
  }

  .mcp-install-plan code {
    display: block;
    overflow-wrap: anywhere;
    color: var(--settings-text-secondary);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .mcp-install-plan ol {
    margin: 0;
    padding-left: 18px;
  }

  .mcp-install-plan li + li {
    margin-top: 2px;
  }

  .mcp-install-plan small {
    max-width: none;
    overflow: visible;
    color: var(--settings-text-secondary);
    font-size: 12px;
    text-overflow: clip;
    white-space: normal;
  }

  .local-launch-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .local-launch-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .local-launch-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .local-launch-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .local-launch-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .local-launch-overview-card.private {
    border-color: color-mix(in srgb, var(--settings-primary) 34%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
  }

  .local-launch-overview-card span,
  .local-launch-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .local-launch-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .plugin-inventory-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .plugin-inventory-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .plugin-inventory-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .plugin-inventory-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .plugin-inventory-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .plugin-inventory-overview-card span,
  .plugin-inventory-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .plugin-inventory-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .plugin-market-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .plugin-market-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .plugin-market-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .plugin-market-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .plugin-market-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .plugin-market-overview-card span,
  .plugin-market-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .plugin-market-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .shortcut-list,
  .compact-list,
  .plugin-market-catalog-list,
  .alias-list,
  .local-launch-list,
  .debug-grid {
    border-top: 1px solid var(--settings-divider);
  }

  .remote-preview {
    margin-top: 14px;
  }

  .remote-preview h4 {
    margin: 0 0 8px;
    color: var(--settings-text-primary);
    font-size: 15px;
    font-weight: 650;
  }

  .compact-heading {
    align-items: center;
    margin-top: 14px;
  }

  .compact-heading h4 {
    margin: 0;
  }

  .webdav-conflict-list {
    margin-top: 12px;
  }

  .webdav-conflict-row {
    min-height: 52px;
    display: grid;
    grid-template-columns: 22px minmax(120px, 1fr) minmax(120px, 1fr) minmax(160px, 1.2fr);
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--settings-divider);
    color: var(--settings-text-primary);
    font-size: 15px;
  }

  .webdav-conflict-row input {
    width: 18px;
    height: 18px;
  }

  .webdav-conflict-row code,
  .webdav-conflict-row small {
    overflow-wrap: anywhere;
  }

  .webdav-conflict-row small {
    color: var(--settings-text-muted);
    font-size: 13px;
  }

  .shortcut-row,
  .tool-row,
  .data-row,
  .alias-row,
  .local-launch-row,
  .debug-row {
    min-height: 48px;
    display: grid;
    align-items: center;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--settings-divider);
  }

  .shortcut-row,
  .debug-row {
    grid-template-columns: 132px minmax(0, 1fr);
  }

  .tool-row,
  .data-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }

  .data-row.compact {
    min-height: 42px;
    gap: 10px;
    padding: 8px 0;
  }

  .alias-row {
    grid-template-columns: 48px minmax(0, 1fr) auto;
  }

  .local-launch-row {
    grid-template-columns: 48px minmax(0, 1fr);
    align-items: start;
  }

  .alias-fields {
    min-width: 0;
    display: grid;
    grid-template-columns: 108px minmax(180px, 1fr);
    align-items: center;
    gap: 8px;
  }

  .alias-fields small {
    grid-column: 1 / -1;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .local-launch-fields {
    min-width: 0;
    display: grid;
    grid-template-columns: minmax(120px, 1fr) minmax(96px, 128px) minmax(118px, 150px);
    align-items: center;
    gap: 8px;
  }

  .local-path-input {
    grid-column: 1 / -1;
  }

  .local-launch-dropzone {
    min-height: 78px;
    display: grid;
    place-items: center;
    gap: 5px;
    margin: 12px 0 10px;
    padding: 12px;
    border: 2px dashed color-mix(in srgb, var(--settings-primary) 30%, var(--settings-control-border));
    border-radius: 10px;
    color: var(--settings-text-secondary);
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
    text-align: center;
  }

  .local-launch-dropzone span {
    color: #333333;
    font-size: 16px;
    font-weight: 750;
    line-height: 1.3;
  }

  .local-launch-dropzone small {
    overflow-wrap: anywhere;
    font-size: 12px;
    line-height: 1.35;
  }

  .local-launch-actions {
    min-width: 0;
    grid-column: 2;
    display: flex;
    justify-content: flex-start;
    gap: 6px;
    flex-wrap: wrap;
  }

  .local-launch-actions .plain-button {
    min-width: 72px;
    min-height: 42px;
    padding: 0 12px;
    font-size: 14px;
  }

  .compact-toggle {
    width: 64px;
    height: 36px;
    flex-basis: 64px;
  }

  .compact-toggle span::before {
    top: 4px;
    left: 4px;
    width: 24px;
    height: 24px;
  }

  .compact-toggle input:checked + span::before {
    transform: translateX(28px);
  }

  .web-quick-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .web-quick-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .web-quick-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .web-quick-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .web-quick-overview-card.private {
    border-color: color-mix(in srgb, var(--settings-primary) 34%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
  }

  .web-quick-overview-card span,
  .web-quick-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .web-quick-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .web-quick-card-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    gap: 12px;
    margin-top: 12px;
  }

  .web-quick-card {
    min-width: 0;
    display: grid;
    gap: 12px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .web-quick-card.disabled {
    opacity: 0.58;
  }

  .web-quick-card-head {
    min-width: 0;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: 10px;
  }

  .web-quick-card-title {
    min-width: 0;
    display: grid;
    gap: 2px;
  }

  .web-quick-card-title strong,
  .web-quick-card-title small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .web-quick-card-title strong {
    color: #333333;
    font-size: 18px;
    font-weight: 800;
    line-height: 1.25;
  }

  .web-quick-card-title small {
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.3;
  }

  .web-quick-keyword-chip {
    max-width: 86px;
    overflow: hidden;
    padding: 5px 9px;
    border: 1px solid color-mix(in srgb, var(--settings-primary) 32%, var(--settings-control-border));
    border-radius: 999px;
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
    font-family: var(--font-mono);
    font-size: 13px;
    font-weight: 850;
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .web-quick-preview-url {
    min-width: 0;
    width: 100%;
    display: block;
    box-sizing: border-box;
    overflow: hidden;
    padding: 9px 10px;
    border: 1px solid var(--settings-control-border);
    border-radius: 7px;
    color: var(--settings-text-secondary);
    background: rgba(255, 255, 255, 0.44);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.35;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
  }

  .web-quick-card-actions,
  .web-quick-editor-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    flex-wrap: wrap;
  }

  .web-quick-card-actions .plain-button,
  .web-quick-editor-actions .plain-button {
    min-height: 42px;
    padding: 0 14px;
    font-size: 14px;
  }

  .web-quick-editor-layer {
    margin-top: 14px;
    padding: 12px;
    border: 1px solid color-mix(in srgb, var(--settings-primary) 28%, var(--settings-control-border));
    border-radius: 10px;
    background: color-mix(in srgb, var(--settings-primary) 6%, var(--settings-control));
  }

  .web-quick-editor-panel {
    display: grid;
    gap: 14px;
    padding: 16px;
    border: 1px solid var(--settings-control-border);
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.68);
    box-shadow: 0 12px 30px rgba(30, 30, 30, 0.08);
  }

  .web-quick-editor-head {
    min-width: 0;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
  }

  .web-quick-editor-head h4 {
    margin: 0 0 4px;
    color: #333333;
    font-size: 20px;
    font-weight: 850;
    line-height: 1.25;
  }

  .web-quick-editor-head small {
    color: var(--settings-text-secondary);
    font-size: 13px;
    line-height: 1.35;
  }

  .web-quick-mode-switch {
    display: inline-flex;
    width: fit-content;
    max-width: 100%;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--settings-control-border);
    border-radius: 9px;
    background: var(--settings-control);
  }

  .web-quick-mode-switch button {
    min-height: 38px;
    padding: 0 14px;
    border: 0;
    border-radius: 7px;
    color: var(--settings-text-secondary);
    background: transparent;
    font-size: 14px;
    font-weight: 800;
  }

  .web-quick-mode-switch button.active {
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
  }

  .web-quick-editor-fields {
    display: grid;
    grid-template-columns: minmax(120px, 0.8fr) minmax(84px, 0.45fr);
    gap: 10px;
  }

  .web-quick-editor-fields label {
    min-width: 0;
    display: grid;
    gap: 6px;
  }

  .web-quick-editor-fields label:last-child {
    grid-column: 1 / -1;
  }

  .web-quick-editor-fields span,
  .web-quick-preview-box span {
    color: #333333;
    font-size: 13px;
    font-weight: 800;
    line-height: 1.3;
  }

  .web-quick-editor-fields .text-input {
    width: 100%;
  }

  .web-quick-preview-box {
    min-width: 0;
    display: grid;
    gap: 6px;
  }

  .web-quick-preview-box code {
    min-width: 0;
    width: 100%;
    display: block;
    box-sizing: border-box;
    overflow: hidden;
    padding: 10px 12px;
    border: 1px solid var(--settings-control-border);
    border-radius: 7px;
    color: var(--settings-text-secondary);
    background: var(--settings-control);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.4;
    overflow-wrap: anywhere;
    word-break: break-word;
    white-space: normal;
  }

  .alias-fields .text-input,
  .alias-fields .select-control,
  .local-launch-fields .text-input,
  .local-launch-fields .select-control {
    width: 100%;
    min-width: 0;
  }

  .keyword-input {
    text-align: center;
    font-weight: 700;
  }

  .shortcut-row span,
  .debug-row span {
    color: #333333;
    font-size: 13px;
    font-weight: 700;
  }

  .shortcut-row small {
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
  }

  .meta-pill {
    min-width: 88px;
    display: inline-flex;
    justify-content: center;
    padding: 5px 10px;
    border: 1px solid var(--settings-control-border);
    border-radius: 999px;
    color: var(--settings-text-secondary);
    background: rgba(255, 255, 255, 0.4);
    font-size: 12px;
    font-weight: 600;
  }

  .about-panel {
    padding-top: 20px;
  }

  .about-title-row {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .about-title-row h3 {
    margin: 0;
  }

  .about-title-row small {
    display: block;
    margin-top: 3px;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
  }

  .about-logo {
    width: 68px;
    height: 68px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    color: #fff;
    background: #111;
    font-size: 34px;
    font-weight: 900;
    line-height: 1;
  }

  .about-logo.compact {
    width: 42px;
    height: 42px;
    flex: 0 0 42px;
    font-size: 22px;
  }

  .about-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0 0;
  }

  .about-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .about-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .about-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .about-overview-card.private {
    border-color: color-mix(in srgb, var(--settings-primary) 34%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
  }

  .about-overview-card span,
  .about-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .about-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .about-card-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .about-card {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .about-card span,
  .about-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
  }

  .about-card strong {
    display: block;
    margin: 4px 0;
    overflow: hidden;
    color: #333333;
    font-size: 15px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .data-overview-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .data-overview-card {
    min-width: 0;
    min-height: 124px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .data-overview-card.private {
    border-color: color-mix(in srgb, var(--settings-primary) 34%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
  }

  .data-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .data-overview-card span,
  .data-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .data-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: #333333;
    font-size: 22px;
    font-weight: 800;
    line-height: 1.15;
  }

  .ai-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .ai-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .ai-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .ai-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .ai-overview-card.disabled,
  .ai-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .ai-overview-card.private {
    border-color: color-mix(in srgb, var(--settings-primary) 34%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
  }

  .ai-overview-card span,
  .ai-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .ai-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: #333333;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .webdav-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .webdav-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .webdav-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .webdav-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .webdav-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .webdav-overview-card.private {
    border-color: color-mix(in srgb, var(--settings-primary) 34%, var(--settings-control-border));
    background: color-mix(in srgb, var(--settings-primary) 7%, var(--settings-control));
  }

  .webdav-overview-card span,
  .webdav-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .webdav-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: #333333;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .debug-overview-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .debug-overview-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .debug-overview-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .debug-overview-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .debug-overview-card.error {
    border-color: color-mix(in srgb, #ef4444 38%, var(--settings-control-border));
    background: color-mix(in srgb, #ef4444 7%, var(--settings-control));
  }

  .debug-overview-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .debug-overview-card span,
  .debug-overview-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .debug-overview-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: currentColor;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .mcp-governance-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 12px 0;
  }

  .mcp-governance-card {
    min-width: 0;
    min-height: 118px;
    padding: 14px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .mcp-governance-card.ready {
    border-color: color-mix(in srgb, #16a34a 35%, var(--settings-control-border));
    background: color-mix(in srgb, #16a34a 6%, var(--settings-control));
  }

  .mcp-governance-card.warning {
    border-color: color-mix(in srgb, #f59e0b 38%, var(--settings-control-border));
    background: color-mix(in srgb, #f59e0b 7%, var(--settings-control));
  }

  .mcp-governance-card.danger {
    border-color: color-mix(in srgb, #ef4444 38%, var(--settings-control-border));
    background: color-mix(in srgb, #ef4444 7%, var(--settings-control));
  }

  .mcp-governance-card.desktop {
    background: color-mix(in srgb, var(--settings-control) 78%, #e5e7eb);
  }

  .mcp-governance-card span,
  .mcp-governance-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.38;
    text-overflow: ellipsis;
  }

  .mcp-governance-card strong {
    display: block;
    margin: 6px 0;
    overflow-wrap: anywhere;
    color: #333333;
    font-size: 21px;
    font-weight: 800;
    line-height: 1.15;
  }

  .mcp-scope-policy-list {
    display: grid;
    gap: 0;
    border-top: 1px solid var(--settings-divider);
  }

  .mcp-scope-policy-row {
    min-width: 0;
    min-height: 104px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    align-items: center;
    padding: 22px 0;
    border-bottom: 1px solid var(--settings-divider);
  }

  .mcp-scope-policy-row.blocked {
    margin-inline: -14px;
    padding-inline: 14px;
    border-radius: 8px;
    background: rgba(220, 38, 38, 0.06);
  }

  .mcp-scope-policy-row code {
    overflow-wrap: anywhere;
    color: var(--settings-text-tertiary);
    font-family: var(--font-mono);
    font-size: 12px;
  }

  .mcp-scope-policy-row .setting-label span {
    font-size: 20px;
  }

  .mcp-scope-policy-row .setting-label small {
    white-space: normal;
  }

  .mcp-request-list {
    display: grid;
    gap: 0;
    border-top: 1px solid var(--settings-divider);
  }

  .mcp-request-row {
    min-width: 0;
    min-height: 104px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 18px;
    align-items: center;
    padding: 22px 0;
    border-bottom: 1px solid var(--settings-divider);
  }

  .mcp-request-row code {
    max-width: 100%;
    overflow-wrap: anywhere;
    color: var(--settings-text-tertiary);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.45;
  }

  .mcp-request-row .setting-label span {
    font-size: 20px;
  }

  .mcp-request-row .setting-label small {
    white-space: normal;
  }

  .meta-pill.active {
    color: var(--settings-primary);
    border-color: color-mix(in srgb, var(--settings-primary) 48%, var(--settings-control-border));
    background: var(--settings-primary-soft);
  }

  .meta-pill.error {
    min-width: 58px;
    color: #dc2626;
    border-color: rgba(220, 38, 38, 0.34);
    background: rgba(220, 38, 38, 0.08);
  }

  .meta-pill.denied {
    min-width: 58px;
    color: #b91c1c;
    border-color: rgba(185, 28, 28, 0.32);
    background: rgba(185, 28, 28, 0.08);
  }

  .meta-pill.danger {
    min-width: 58px;
    color: #b91c1c;
    border-color: rgba(185, 28, 28, 0.32);
    background: rgba(185, 28, 28, 0.08);
  }

  .meta-pill.pending {
    min-width: 58px;
    color: #b45309;
    border-color: rgba(180, 83, 9, 0.32);
    background: rgba(180, 83, 9, 0.08);
  }

  .overview-columns {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 18px;
  }

  .overview-block {
    min-width: 0;
    margin-top: 16px;
  }

  .overview-block h4 {
    margin: 0 0 8px;
    color: var(--settings-primary);
    font-size: 13px;
    font-weight: 800;
  }

  .overview-row-meta {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
  }

  .command-center-summary-grid {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin-top: 14px;
  }

  .command-summary-card {
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--settings-control-border);
    border-radius: 8px;
    background: var(--settings-control);
  }

  .command-summary-card span,
  .command-summary-card small {
    display: block;
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-summary-card strong {
    display: block;
    margin: 4px 0;
    color: #333333;
    font-size: 20px;
    line-height: 1.1;
  }

  .command-center-shell {
    min-height: 340px;
    display: grid;
    grid-template-columns: 220px minmax(0, 1fr);
    gap: 16px;
    margin-top: 14px;
  }

  .command-source-list {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding-right: 12px;
    border-right: 1px solid var(--settings-divider);
  }

  .command-source-list button {
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    padding: 10px 12px;
    border: 1px solid transparent;
    border-radius: 8px;
    color: #333333;
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .command-source-list button:hover {
    background: var(--settings-primary-soft);
  }

  .command-source-list button.active {
    border-color: color-mix(in srgb, var(--settings-primary) 28%, transparent);
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
  }

  .command-source-list span {
    overflow: hidden;
    max-width: 100%;
    font-size: 14px;
    font-weight: 800;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-source-list small {
    overflow: hidden;
    max-width: 100%;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-center-main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .command-filter-bar {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) auto;
    align-items: center;
    gap: 10px;
  }

  .command-search-input {
    width: 100%;
  }

  .command-target-list {
    border-top: 1px solid var(--settings-divider);
  }

  .command-target-row {
    min-height: 68px;
    display: grid;
    grid-template-columns: 42px minmax(0, 1fr) minmax(186px, auto);
    align-items: center;
    gap: 12px;
    padding: 10px 0;
    border-bottom: 1px solid var(--settings-divider);
  }

  .command-target-row.disabled {
    opacity: 0.68;
  }

  .command-target-row > .row-actions {
    min-width: 0;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 6px;
  }

  .command-target-row .plain-button {
    min-height: 36px;
    padding: 0 10px;
    border-width: 1px;
    border-radius: 7px;
    font-size: 13px;
    white-space: nowrap;
  }

  .command-target-icon {
    width: 36px;
    height: 36px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid color-mix(in srgb, var(--settings-primary) 28%, var(--settings-control-border));
    border-radius: 8px;
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
    font-size: 14px;
    font-weight: 900;
  }

  .command-target-body {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .command-target-title,
  .command-target-meta {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .command-target-title strong {
    overflow: hidden;
    color: #333333;
    font-size: 14px;
    line-height: 1.25;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-target-body small,
  .command-target-meta span {
    overflow: hidden;
    color: var(--settings-text-secondary);
    font-size: 12px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-target-meta code {
    overflow: hidden;
    max-width: 220px;
    padding: 2px 6px;
    border: 1px solid var(--settings-control-border);
    border-radius: 6px;
    color: var(--settings-text-secondary);
    background: rgba(255, 255, 255, 0.5);
    font-size: 11px;
    line-height: 1.3;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .command-alias-preview {
    min-width: 0;
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }

  .command-alias-preview span {
    max-width: 120px;
    overflow: hidden;
    padding: 2px 7px;
    border: 1px solid color-mix(in srgb, var(--settings-primary) 24%, transparent);
    border-radius: 7px;
    color: var(--settings-primary);
    background: var(--settings-primary-soft);
    font-size: 11px;
    font-weight: 800;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .audit-error-meta {
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  @media (max-width: 1280px) {
    .local-launch-row {
      grid-template-columns: 42px minmax(0, 1fr);
    }

    .local-launch-actions {
      grid-column: 2;
      justify-content: flex-start;
    }
  }

  @media (max-width: 860px) {
    .local-launch-fields {
      grid-template-columns: 1fr;
    }

    .local-path-input {
      grid-column: 1 / -1;
    }

    .local-launch-actions {
      grid-column: 2;
    }
  }

  @media (max-width: 720px) {
    .settings-sidebar {
      width: 184px;
      padding: 12px 8px 14px;
    }

    .menu-item {
      min-height: 48px;
      gap: 10px;
      margin-bottom: 6px;
      padding-inline: 10px;
      font-size: 13px;
    }

    .menu-icon {
      width: 18px;
      height: 18px;
      flex-basis: 18px;
    }

    .content-panel {
      padding: 20px 20px 24px 18px;
    }

    .setting-group {
      margin-bottom: 28px;
    }

    .setting-group h3 {
      margin-bottom: 14px;
      font-size: 15px;
    }

    .setting-item {
      min-height: 76px;
      gap: 14px;
      padding: 16px 0;
    }

    .setting-label {
      gap: 5px;
    }

    .setting-label span {
      font-size: 14px;
    }

    .setting-label small {
      font-size: 12px;
    }

    .settings-sidebar::-webkit-scrollbar,
    .content-panel::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }

    .hotkey-input,
    .select-control,
    .text-input,
    .number-input {
      height: 40px;
      max-width: 100%;
      border-radius: 7px;
      font-size: 14px;
    }

    .hotkey-input {
      width: 178px;
    }

    .text-input {
      width: 220px;
    }

    .text-input.wide {
      width: 236px;
    }

    .select-control {
      min-width: 150px;
      padding: 0 38px 0 14px;
    }

    .select-control.compact,
    .number-input {
      min-width: 104px;
      width: 104px;
    }

    .range-control {
      width: 214px;
    }

    .icon-button,
    .plain-button {
      min-height: 36px;
      border-radius: 7px;
      font-size: 13px;
    }

    .icon-button {
      width: 38px;
    }

    .plain-button {
      padding: 0 12px;
    }

    .toggle {
      width: 52px;
      height: 30px;
      flex: 0 0 52px;
    }

    .toggle span::before {
      top: 3px;
      left: 3px;
      width: 22px;
      height: 22px;
    }

    .toggle input:checked + span::before {
      transform: translateX(22px);
    }

    .shortcut-tab-bar,
    .general-overview-grid,
    .http-overview-grid,
    .about-overview-grid,
    .shortcut-summary-grid,
    .web-quick-overview-grid,
    .local-launch-overview-grid,
    .plugin-inventory-overview-grid,
    .plugin-market-overview-grid,
    .ai-overview-grid,
    .webdav-overview-grid,
    .debug-overview-grid,
    .data-overview-grid,
    .mcp-governance-grid {
      grid-template-columns: 1fr;
    }

    .shortcut-card-row,
    .alias-shortcut-row {
      grid-template-columns: minmax(92px, 120px) minmax(0, 1fr);
      align-items: start;
    }

    .shortcut-card-row > .meta-pill,
    .alias-shortcut-row > .row-actions {
      grid-column: 2;
      justify-self: start;
    }

    .mcp-scope-policy-row,
    .mcp-request-row {
      grid-template-columns: 1fr;
      gap: 10px;
      align-items: stretch;
    }

    .mcp-scope-policy-row > .row-actions,
    .mcp-request-row > .row-actions {
      justify-content: flex-start;
    }

    .alias-row {
      grid-template-columns: 42px minmax(0, 1fr);
    }

    .data-row {
      grid-template-columns: minmax(0, 1fr);
      align-items: stretch;
    }

    .overview-columns {
      grid-template-columns: 1fr;
      gap: 6px;
    }

    .command-center-summary-grid,
    .command-center-shell {
      grid-template-columns: 1fr;
    }

    .command-source-list {
      padding-right: 0;
      padding-bottom: 10px;
      border-right: 0;
      border-bottom: 1px solid var(--settings-divider);
    }

    .command-filter-bar {
      grid-template-columns: 1fr;
    }

    .command-target-row {
      grid-template-columns: 42px minmax(0, 1fr);
      align-items: start;
    }

    .command-target-row > .row-actions {
      grid-column: 2;
      justify-self: start;
    }

    .overview-row-meta {
      justify-content: flex-start;
      flex-wrap: wrap;
    }

    .alias-row .plain-button {
      grid-column: 2;
      justify-self: end;
    }

    .alias-fields {
      grid-template-columns: minmax(92px, 1fr);
    }

    .web-template-input {
      grid-column: 1 / -1;
    }

    .audit-error-meta {
      grid-column: 1 / -1;
      justify-self: end;
    }
  }

  @media (prefers-color-scheme: dark) {
    .settings-panel {
      color: #f3f4f6;
      background: rgba(48, 49, 51, 0.92);
      --settings-primary: var(--accent);
      --settings-primary-soft: var(--accent-subtle);
      --settings-hover: color-mix(in srgb, var(--accent) 18%, rgba(255, 255, 255, 0.06));
      --settings-divider: rgba(255, 255, 255, 0.1);
      --settings-control: rgba(255, 255, 255, 0.04);
      --settings-control-border: rgba(255, 255, 255, 0.1);
      --settings-text-secondary: #bfc0c3;
    }

    .content-panel {
      background: rgba(48, 49, 51, 0.92);
    }

    .menu-item,
    .setting-label span,
    .shortcut-row span,
    .shortcut-tab,
    .shortcut-summary-card strong,
    .shortcut-key-display,
    .debug-row span,
    .mono-value,
    .debug-row code,
    .hotkey-input,
    .select-control,
    .text-input,
    .number-input,
    .icon-button,
    .plain-button {
      color: #f3f4f6;
    }

    .debug-value small {
      color: var(--settings-text-secondary);
    }

    .diagnostic-row.warning .debug-value code {
      color: #f59e0b;
    }

    .diagnostic-row.error .debug-value code {
      color: #f87171;
    }

    .select-control {
      background:
        linear-gradient(45deg, transparent 50%, #bfc0c3 50%) calc(100% - 29px) 29px / 9px 9px no-repeat,
        linear-gradient(135deg, #bfc0c3 50%, transparent 50%) calc(100% - 22px) 29px / 9px 9px no-repeat,
        var(--settings-control);
    }

    .toggle span::before {
      background: #d8dbe2;
    }

    .color-dot.active {
      border-color: #f3f4f6;
    }
  }

  :global(:root[data-atools-theme="light"]) .settings-panel {
    color: #333333;
    background: rgba(244, 244, 244, 0.72);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 12%, white);
    --settings-divider: rgba(0, 0, 0, 0.1);
    --settings-control: rgba(0, 0, 0, 0.035);
    --settings-control-border: rgba(0, 0, 0, 0.1);
    --settings-text-secondary: #616161;
  }

  :global(:root[data-atools-theme="light"]) .content-panel {
    background: rgba(244, 244, 244, 0.72);
  }

  :global(:root[data-atools-theme="light"]) .menu-item,
  :global(:root[data-atools-theme="light"]) .setting-label span,
  :global(:root[data-atools-theme="light"]) .shortcut-row span,
  :global(:root[data-atools-theme="light"]) .shortcut-tab,
  :global(:root[data-atools-theme="light"]) .shortcut-summary-card strong,
  :global(:root[data-atools-theme="light"]) .shortcut-key-display,
  :global(:root[data-atools-theme="light"]) .debug-row span,
  :global(:root[data-atools-theme="light"]) .mono-value,
  :global(:root[data-atools-theme="light"]) .debug-row code,
  :global(:root[data-atools-theme="light"]) .hotkey-input,
  :global(:root[data-atools-theme="light"]) .select-control,
  :global(:root[data-atools-theme="light"]) .text-input,
  :global(:root[data-atools-theme="light"]) .number-input,
  :global(:root[data-atools-theme="light"]) .icon-button,
  :global(:root[data-atools-theme="light"]) .plain-button {
    color: #333333;
  }

  :global(:root[data-atools-theme="light"]) .debug-value small {
    color: var(--settings-text-secondary);
  }

  :global(:root[data-atools-theme="light"]) .diagnostic-row.warning .debug-value code {
    color: #b45309;
  }

  :global(:root[data-atools-theme="light"]) .diagnostic-row.error .debug-value code {
    color: #dc2626;
  }

  :global(:root[data-atools-theme="light"]) .select-control {
    background:
      linear-gradient(45deg, transparent 50%, #616161 50%) calc(100% - 29px) 29px / 9px 9px no-repeat,
      linear-gradient(135deg, #616161 50%, transparent 50%) calc(100% - 22px) 29px / 9px 9px no-repeat,
      var(--settings-control);
  }

  :global(:root[data-atools-theme="light"]) .toggle span::before {
    background: #333333;
  }

  :global(:root[data-atools-theme="light"]) .hotkey-input.recording {
    color: var(--settings-primary);
  }

  :global(:root[data-atools-theme="dark"]) .settings-panel {
    color: #f3f4f6;
    background: rgba(48, 49, 51, 0.92);
    --settings-primary: var(--accent);
    --settings-primary-soft: var(--accent-subtle);
    --settings-hover: color-mix(in srgb, var(--accent) 18%, rgba(255, 255, 255, 0.06));
    --settings-divider: rgba(255, 255, 255, 0.1);
    --settings-control: rgba(255, 255, 255, 0.04);
    --settings-control-border: rgba(255, 255, 255, 0.1);
    --settings-text-secondary: #bfc0c3;
  }

  :global(:root[data-atools-theme="dark"]) .content-panel {
    background: rgba(48, 49, 51, 0.92);
  }

  :global(:root[data-atools-theme="dark"]) .settings-sidebar,
  :global(:root[data-atools-theme="dark"]) .content-panel {
    scrollbar-color: rgba(255, 255, 255, 0.24) transparent;
  }

  :global(:root[data-atools-theme="dark"]) .settings-sidebar::-webkit-scrollbar-thumb,
  :global(:root[data-atools-theme="dark"]) .content-panel::-webkit-scrollbar-thumb {
    background-color: rgba(255, 255, 255, 0.24);
  }

  :global(:root[data-atools-theme="dark"]) .settings-sidebar::-webkit-scrollbar-thumb:hover,
  :global(:root[data-atools-theme="dark"]) .content-panel::-webkit-scrollbar-thumb:hover {
    background-color: rgba(255, 255, 255, 0.38);
  }

  :global(:root[data-atools-theme="dark"]) .menu-item,
  :global(:root[data-atools-theme="dark"]) .setting-label span,
  :global(:root[data-atools-theme="dark"]) .shortcut-row span,
  :global(:root[data-atools-theme="dark"]) .shortcut-tab,
  :global(:root[data-atools-theme="dark"]) .shortcut-summary-card strong,
  :global(:root[data-atools-theme="dark"]) .shortcut-key-display,
  :global(:root[data-atools-theme="dark"]) .debug-row span,
  :global(:root[data-atools-theme="dark"]) .mono-value,
  :global(:root[data-atools-theme="dark"]) .debug-row code,
  :global(:root[data-atools-theme="dark"]) .hotkey-input,
  :global(:root[data-atools-theme="dark"]) .select-control,
  :global(:root[data-atools-theme="dark"]) .text-input,
  :global(:root[data-atools-theme="dark"]) .number-input,
  :global(:root[data-atools-theme="dark"]) .icon-button,
  :global(:root[data-atools-theme="dark"]) .plain-button {
    color: #f3f4f6;
  }

  :global(:root[data-atools-theme="dark"]) .debug-value small {
    color: var(--settings-text-secondary);
  }

  :global(:root[data-atools-theme="dark"]) .diagnostic-row.warning .debug-value code {
    color: #f59e0b;
  }

  :global(:root[data-atools-theme="dark"]) .diagnostic-row.error .debug-value code {
    color: #f87171;
  }

  :global(:root[data-atools-theme="dark"]) .select-control {
    background:
      linear-gradient(45deg, transparent 50%, #bfc0c3 50%) calc(100% - 29px) 29px / 9px 9px no-repeat,
      linear-gradient(135deg, #bfc0c3 50%, transparent 50%) calc(100% - 22px) 29px / 9px 9px no-repeat,
      var(--settings-control);
  }

  :global(:root[data-atools-theme="dark"]) .toggle span::before {
    background: #d8dbe2;
  }

  :global(:root[data-atools-theme="dark"]) .color-dot.active {
    border-color: #f3f4f6;
  }

  :global(:root[data-atools-theme="dark"]) .hotkey-input.recording {
    color: var(--settings-primary);
  }
</style>
