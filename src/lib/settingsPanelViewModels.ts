import { appUpdater, type AppUpdaterState } from "./appUpdater";
import { commandHistoryStats, type CommandHistoryEntry } from "./commandHistory";
import {
  auditErrorSummaries,
  crashLogSummaries,
  debugOverviewCards,
  localDataDiagnostics,
  runtimeDiagnosticRows,
  type AuditErrorSummary,
  type CrashLogSummary,
  type DebugDiagnosticRow,
} from "./debugDiagnostics";
import { validateShortcut, shortcutStatusMessage, type HotkeyPlatform } from "./hotkeyRecorder";
import { mcpConnectionView, mcpHttpUrl as mcpHttpUrlForStatus } from "./mcpClientConfig";
import type { AToolsSettings } from "./settings";
import {
  aboutOverviewCards,
  aboutProductFacts,
  aiOverviewCards,
  appShortcutRows,
  auditRetentionPolicyRows,
  builtInAppShortcutsForPlatform,
  commandCenterOverview,
  commandCenterRows,
  dataOverviewCards,
  generalOverviewCards,
  generalUnsupportedCapabilities,
  httpServiceOverviewCards,
  httpServiceStatus,
  shortcutPageOverview,
} from "./settingsPages";
import {
  AUDIT_KEEP_LATEST,
  AUDIT_RETENTION_DAYS,
  hasTauriRuntime,
} from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import { SYSTEM_ACTIONS } from "./uiState";

export function createSettingsPanelViewModels(
  s: SettingsPanelState,
  deps: {
    currentSettings: () => AToolsSettings;
    hotkeyPlatform: () => HotkeyPlatform;
    aiProviderLabel: () => string;
    aiConfigReady: () => boolean;
  },
) {
  const { currentSettings, hotkeyPlatform, aiProviderLabel, aiConfigReady } = deps;

  function shortcutSaveText() {
    return shortcutStatusMessage(s.hotkey, hotkeyPlatform(), s.saveState, s.saveErrorMessage);
  }

  function shortcutHasProblem() {
    return s.saveState === "error" || !validateShortcut(s.hotkey, hotkeyPlatform()).valid;
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
      aliases: s.commandAliases,
      history: s.commandHistory,
      localLaunchEntries: s.localLaunchEntries,
      webQuickOpenEntries: s.webQuickOpenEntries,
      settings: currentSettings(),
    });
  }

  function runtimeDebugRows(): DebugDiagnosticRow[] {
    return runtimeDiagnosticRows(s.runtimeDiagnostics);
  }

  function auditErrorRows(): AuditErrorSummary[] {
    return auditErrorSummaries(s.recentAuditErrors);
  }

  function crashLogRows(): CrashLogSummary[] {
    return crashLogSummaries(s.crashLogs);
  }

  function debugOverview() {
    return debugOverviewCards({
      hasTauriRuntime: hasTauriRuntime(),
      runtime: s.runtimeDiagnostics,
      mcpStatus: s.debugMcpStatus,
      audits: s.debugAudits,
      crashLogs: s.crashLogs,
    });
  }

  function appUpdaterStatusText(state: AppUpdaterState) {
    if (!hasTauriRuntime()) return "桌面应用中可用";
    if (state.phase === "checking") return "正在检查更新";
    if (state.phase === "up-to-date") return "已是最新版本";
    if (state.phase === "available") return `发现 v${state.update?.version ?? "新版本"}`;
    if (state.phase === "downloading") return "正在下载更新";
    if (state.phase === "installing") return "正在安装更新";
    if (state.phase === "restarting") return "正在重启应用";
    if (state.phase === "error") return state.errorMessage || "更新操作失败";
    return "尚未检查更新";
  }

  function appUpdaterCheckedAtText(state: AppUpdaterState) {
    if (!state.checkedAt) return "尚无记录";
    const checkedAt = new Date(state.checkedAt);
    return Number.isNaN(checkedAt.getTime()) ? "时间未知" : checkedAt.toLocaleString();
  }

  function appUpdaterBusy(state: AppUpdaterState) {
    return ["checking", "downloading", "installing", "restarting"].includes(state.phase);
  }

  function checkForAppUpdate() {
    void appUpdater.check("manual").catch(() => undefined);
  }

  function installAppUpdate() {
    void appUpdater.installAndRestart().catch(() => undefined);
  }

  function commandHistoryDetail() {
    const stats = commandHistoryStats(s.commandHistory);
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
      providerEnabled: s.aiProvider !== "disabled",
      configReady: aiConfigReady(),
      defaultModel: s.aiDefaultModel,
      useForAgent: s.aiUseForAgent && s.aiProvider !== "disabled",
      hasApiKey: Boolean(s.aiApiKey.trim()),
      lastConnectionOk: s.aiLastConnection ? s.aiLastConnection.status === "ok" : (s.aiConnectionStatus && !s.aiTestingConnection ? false : null),
      lastConnectionLabel: s.aiConnectionStatus,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function dataOverview() {
    const historyStats = commandHistoryStats(s.commandHistory);
    const pluginDataDocuments = s.pluginDataSummary.reduce((total, item) => total + Math.max(0, item.documents), 0);
    return dataOverviewCards({
      settingsStatusLabel: s.saveState === "saving" ? "保存中" : s.saveState === "error" ? "保存失败" : "已保存",
      commandHistoryCount: historyStats.count,
      commandHistoryTopLabel: historyStats.topLabel,
      clipboardHistoryCount: s.clipboardHistory.length,
      auditCount: s.recentAudits.length,
      pluginCount: s.installedPlugins.length,
      pluginDataDocuments,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function dataAuditRetentionRows() {
    return auditRetentionPolicyRows({
      retentionDays: AUDIT_RETENTION_DAYS,
      keepLatest: AUDIT_KEEP_LATEST,
      auditCount: s.recentAudits.length,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function generalOverview() {
    return generalOverviewCards({
      hotkey: s.hotkey,
      saveLabel: s.saveState === "saving" ? "保存中" : s.saveState === "error" ? "保存失败" : "已保存",
      launchAtLogin: s.nativeSettingsRuntime ? s.launchAtLoginRuntimeState : s.launchAtLogin,
      showTrayIcon: s.showTrayIcon,
      localAppSearch: s.localAppSearch,
      localLaunchSearch: s.localLaunchSearch,
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
      ...s.localLaunchEntries.map((entry) => ({
        code: `local:${entry.id}`,
        label: `本地启动 · ${entry.name}`,
        explain: entry.path,
        source: "local" as const,
        enabled: entry.enabled,
      })),
      ...s.webQuickOpenEntries.map((entry) => ({
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
      mcpEnabled: s.mcpStatus?.enabled ?? s.debugMcpStatus?.enabled ?? false,
      mcpUrl: mcpHttpUrlForStatus(s.mcpStatus ?? s.debugMcpStatus) ?? "",
    });
  }

  function httpOverview() {
    const connection = mcpConnectionView(s.mcpStatus);
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
      mcpEnabled: s.mcpStatus?.enabled ?? s.debugMcpStatus?.enabled ?? false,
    });
  }

  function aboutOverview() {
    const runtime = s.runtimeDiagnostics;
    const tools = runtime
      ? {
          total: runtime.agent_tool_count,
          enabled: runtime.enabled_agent_tool_count,
        }
      : {
          total: s.agentTools.length,
          enabled: s.agentTools.filter((tool) => tool.enabled).length,
        };
    return aboutOverviewCards({
      version: "3.0.0",
      runtime: hasTauriRuntime() ? "Tauri WebView" : "浏览器预览",
      platform: navigator.platform || "未知",
      mcpEnabled: s.mcpStatus?.enabled ?? s.debugMcpStatus?.enabled ?? false,
      agentToolCount: tools.total,
      enabledAgentToolCount: tools.enabled,
      hasTauriRuntime: hasTauriRuntime(),
    });
  }

  function aboutRuntimeRows() {
    const runtime = s.runtimeDiagnostics;
    const mcp = s.mcpStatus ?? s.debugMcpStatus;
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
          : `${s.agentTools.length} 个工具 / ${s.agentTools.filter((tool) => tool.enabled).length} 个启用`,
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
    const runtime = s.runtimeDiagnostics;
    const mcp = s.mcpStatus ?? s.debugMcpStatus;
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
      spaceOpenCommand: s.spaceOpenCommand,
      tabKeyFunction: s.tabKeyFunction,
    });
  }

  function customAppShortcutRows() {
    return appShortcutRows({
      entries: s.appShortcuts,
      targets: aliasTargetOptions(),
      builtIns: shortcutBuiltIns(),
      platform: hotkeyPlatform(),
    });
  }

  function shortcutOverview() {
    return shortcutPageOverview({
      hotkey: s.hotkey,
      saveLabel: shortcutSaveText(),
      aliasCount: s.commandAliases.length,
      targetCount: aliasTargetOptions().length,
      customGlobalCount: 0,
      customAppCount: s.appShortcuts.length,
      builtinAppCount: shortcutBuiltIns().length,
    });
  }

  function commandCenterSummary() {
    return commandCenterOverview(aliasTargetOptions(), s.commandAliases);
  }

  function commandCenterPinnedCount() {
    const targetCodes = new Set(aliasTargetOptions().map((target) => target.code));
    return s.commandCenterPinnedCodes.filter((code) => targetCodes.has(code)).length;
  }

  function commandCenterFilteredRows() {
    return commandCenterRows({
      targets: aliasTargetOptions(),
      aliases: s.commandAliases,
      source: s.commandCenterSourceFilter,
      status: s.commandCenterStatusFilter,
      query: s.commandCenterQuery,
      pinnedCodes: s.commandCenterPinnedCodes,
    });
  }

  function commandCenterSourceDetail(group: ReturnType<typeof commandCenterSummary>["groups"][number]) {
    return `${group.enabledCount}/${group.count} 启用 · ${group.aliasCount} 个别名`;
  }

  return {
    shortcutSaveText,
    shortcutHasProblem,
    environmentRows,
    localDebugRows,
    runtimeDebugRows,
    auditErrorRows,
    crashLogRows,
    debugOverview,
    appUpdaterStatusText,
    appUpdaterCheckedAtText,
    appUpdaterBusy,
    checkForAppUpdate,
    installAppUpdate,
    commandHistoryDetail,
    commandHistoryRowDetail,
    aiOverview,
    dataOverview,
    dataAuditRetentionRows,
    generalOverview,
    aliasTargetOptions,
    aliasTargetSummary,
    httpStatusPage,
    httpOverview,
    aboutPage,
    aboutOverview,
    aboutRuntimeRows,
    aboutRuntimeInfoText,
    shortcutBuiltIns,
    customAppShortcutRows,
    shortcutOverview,
    commandCenterSummary,
    commandCenterPinnedCount,
    commandCenterFilteredRows,
    commandCenterSourceDetail,
  };
}
