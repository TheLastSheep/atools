import type { CommandAliasEntry } from "./commandAliases";
import type { CommandHistoryEntry } from "./commandHistory";
import type { LocalLaunchEntry } from "./localLaunch";
import type { AToolsSettings } from "./settings";
import type { AuditLogEntry, CrashLogEntry, McpServerStatus, RuntimeDiagnostics } from "./types";
import type { WebQuickOpenEntry } from "./webQuickOpen";

export type DebugDiagnosticRow = {
  label: string;
  value: string;
  detail?: string;
  tone?: "normal" | "warning" | "error";
};

export type DebugOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "error" | "desktop";
};

export type DebugOverviewInput = {
  hasTauriRuntime: boolean;
  runtime: RuntimeDiagnostics | null | undefined;
  mcpStatus: McpServerStatus | null | undefined;
  audits: AuditLogEntry[];
  crashLogs: CrashLogEntry[];
};

export type AuditErrorSummary = {
  id: string;
  toolName: string;
  clientId: string;
  timestamp: string;
  status: string;
  message: string;
  duration: string;
};

export type CrashLogSummary = {
  title: string;
  detail: string;
  raw: string;
};

export type LocalDataDiagnosticsInput = {
  aliases: CommandAliasEntry[];
  history: CommandHistoryEntry[];
  localLaunchEntries: LocalLaunchEntry[];
  webQuickOpenEntries: WebQuickOpenEntry[];
  settings: Partial<AToolsSettings>;
};

export type DiagnosticPluginDataSummary = {
  plugin?: {
    id?: string;
    name?: string;
    version?: string;
  };
  documents: number;
  error?: string;
};

export type DiagnosticBundleInput = LocalDataDiagnosticsInput & {
  generatedAt?: string;
  runtime?: RuntimeDiagnostics | null;
  mcpStatus?: McpServerStatus | null;
  audits?: AuditLogEntry[];
  crashLogs?: CrashLogEntry[];
  clipboardHistoryCount?: number;
  pluginDataSummary?: DiagnosticPluginDataSummary[];
};

export type DiagnosticBundle = {
  kind: "atools_diagnostic_bundle";
  generatedAt: string;
  runtime: {
    connected: boolean;
    runtime: string;
    platform: string;
    arch: string;
    debug: boolean;
    baseDir: string;
    dbPath: string;
    pluginsDir: string;
    pluginCount: number;
    featureCount: number;
    agentToolCount: number;
    enabledAgentToolCount: number;
    activePlugin: string;
    recentEvents: {
      total: number;
      errors: number;
    };
    mcp: {
      enabled: boolean;
      bind: string;
    };
  };
  settings: Record<string, unknown>;
  localData: {
    aliases: { total: number; enabled: number };
    history: { total: number };
    localLaunch: { total: number; enabled: number };
    webQuickOpen: { total: number; enabled: number };
    clipboardHistory: { total: number };
    pluginData: { plugins: number; documents: number; errors: number };
  };
  audits: {
    total: number;
    success: number;
    denied: number;
    error: number;
    pending: number;
    unknown: number;
    recentErrors: AuditErrorSummary[];
  };
  crashes: {
    total: number;
    recent: CrashLogSummary[];
  };
  warnings: string[];
};

export function debugOverviewCards(input: DebugOverviewInput): DebugOverviewCard[] {
  const runtimeErrorCount = input.runtime?.recent_events.filter((event) => event.level === "error").length ?? 0;
  const auditCounts = diagnosticAuditCounts(input.audits);
  const auditProblemCount = auditCounts.denied + auditCounts.error;
  const mcpEnabled = input.mcpStatus?.enabled ?? input.runtime?.mcp_enabled ?? false;
  const mcpBind = input.mcpStatus?.bind || input.runtime?.mcp_bind || "";
  const desktopValue = input.hasTauriRuntime ? "" : "桌面端读取";

  return [
    {
      label: "桌面运行时",
      value: !input.hasTauriRuntime
        ? "浏览器预览"
        : input.runtime
          ? `${input.runtime.runtime} / ${input.runtime.platform}-${input.runtime.arch}`
          : "未连接",
      detail: !input.hasTauriRuntime
        ? "浏览器预览无法读取 Tauri 主进程、路径、事件和崩溃日志"
        : input.runtime
          ? `${input.runtime.debug ? "Debug" : "Release"} 构建，${input.runtime.recent_events.length} 条运行事件，${runtimeErrorCount} 条错误事件`
          : "刷新后仍未读取到桌面运行时诊断",
      tone: !input.hasTauriRuntime ? "desktop" : runtimeErrorCount > 0 ? "error" : input.runtime ? "ready" : "warning",
    },
    {
      label: "MCP 服务",
      value: desktopValue || (mcpEnabled ? "运行中" : "未启动"),
      detail: desktopValue
        ? "MCP 监听地址和 token 只在桌面应用中读取"
        : mcpEnabled
          ? `${mcpBind || "本机监听"}；token 已隐藏，客户端配置到 MCP 服务页复制`
          : "Agent 客户端暂时无法通过本机 MCP 调用内置工具",
      tone: desktopValue ? "desktop" : mcpEnabled ? "ready" : "warning",
    },
    {
      label: "审计异常",
      value: desktopValue || `${auditProblemCount} 条`,
      detail: desktopValue
        ? "最近 Agent 审计记录需在桌面应用中读取"
        : auditProblemCount > 0
          ? `${auditCounts.denied} 条拒绝，${auditCounts.error} 条失败；下方展示最近异常`
          : `${auditCounts.total} 条最近审计记录，无拒绝或失败`,
      tone: desktopValue ? "desktop" : auditProblemCount > 0 ? "warning" : "ready",
    },
    {
      label: "崩溃日志",
      value: desktopValue || `${input.crashLogs.length} 条`,
      detail: desktopValue
        ? "崩溃日志需在桌面应用中读取"
        : input.crashLogs.length > 0
          ? "panic 已写入本地 crashes.log，可复制或清空"
          : "暂无崩溃日志；panic 会写入本地 crashes.log",
      tone: desktopValue ? "desktop" : input.crashLogs.length > 0 ? "error" : "ready",
    },
  ];
}

export function localDataDiagnostics(input: LocalDataDiagnosticsInput): DebugDiagnosticRow[] {
  const aliasCount = input.aliases.length;
  const enabledAliases = input.aliases.filter((entry) => entry.enabled).length;
  const historyCount = input.history.length;
  const localCount = input.localLaunchEntries.length;
  const enabledLocal = input.localLaunchEntries.filter((entry) => entry.enabled).length;
  const webCount = input.webQuickOpenEntries.length;
  const enabledWeb = input.webQuickOpenEntries.filter((entry) => entry.enabled).length;

  return [
    {
      label: "自定义别名",
      value: `${aliasCount} 条 / ${enabledAliases} 条启用`,
      detail: aliasCount === 0 ? "未配置；所有指令页可添加短词映射" : enabledAliases === 0 ? "全部停用" : "主搜索可按别名召回",
      tone: aliasCount > 0 && enabledAliases === 0 ? "warning" : "normal",
    },
    {
      label: "最近使用",
      value: `${historyCount} 条 / ${input.history[0]?.label || "无"}`,
      detail: historyCount === 0 ? "执行命令后自动进入主搜索首页" : `最近输入：${input.history[0]?.input || "无"}`,
    },
    {
      label: "本地启动",
      value: `${localCount} 项 / ${enabledLocal} 项启用`,
      detail: localCount === 0 ? "未配置本地文件或应用启动项" : "文件路径操作需桌面端权限确认",
      tone: localCount > 0 && enabledLocal === 0 ? "warning" : "normal",
    },
    {
      label: "网页快开",
      value: `${webCount} 项 / ${enabledWeb} 项启用`,
      detail: webCount === 0 ? "未配置搜索引擎或 URL 模板" : "输入关键词后可快速打开网页",
      tone: webCount > 0 && enabledWeb === 0 ? "warning" : "normal",
    },
    {
      label: "主题",
      value: `${input.settings.theme || "system"} / ${input.settings.primaryColor || "purple"}`,
      detail: "影响主搜索、设置和内置面板外观",
    },
    {
      label: "呼出快捷键",
      value: String(input.settings.hotkey || "未设置"),
      detail: "真实注册状态需在 Tauri 桌面端查看",
      tone: input.settings.hotkey ? "normal" : "warning",
    },
    {
      label: "搜索模式",
      value: searchModeLabel(input.settings.searchMode),
      detail: "聚合模式更接近 uTools / ZTools 首屏体验",
    },
  ];
}

export function auditErrorSummaries(entries: AuditLogEntry[], limit = 5): AuditErrorSummary[] {
  const safeLimit = Math.max(0, limit);
  return entries
    .filter((entry) => entry.error || entry.status !== "success")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, safeLimit)
    .map((entry) => ({
      id: entry.id,
      toolName: entry.tool_name || "unknown_tool",
      clientId: entry.client_id || "unknown",
      timestamp: entry.timestamp,
      status: entry.status || "unknown",
      message: entry.error || entry.status || "unknown",
      duration: durationLabel(entry.duration_ms),
    }));
}

export function crashLogSummaries(entries: CrashLogEntry[], limit = 5): CrashLogSummary[] {
  return entries.slice(0, Math.max(0, limit)).map((entry) => ({
    title: entry.timestamp || "未知时间",
    detail: `${entry.message || "panic"}${entry.location ? ` · ${entry.location}` : ""}`,
    raw: entry.raw || entry.message || "",
  }));
}

export function buildDiagnosticBundle(input: DiagnosticBundleInput): DiagnosticBundle {
  const audits = input.audits ?? [];
  const crashLogs = input.crashLogs ?? [];
  const pluginDataSummary = input.pluginDataSummary ?? [];
  const runtimeErrors = input.runtime?.recent_events.filter((event) => event.level === "error").length ?? 0;
  const auditCounts = diagnosticAuditCounts(audits);
  const pluginDataDocuments = pluginDataSummary.reduce((sum, item) => sum + safeCount(item.documents), 0);
  const pluginDataErrors = pluginDataSummary.filter((item) => Boolean(item.error)).length;
  const warnings = diagnosticWarnings({
    input,
    runtimeErrors,
    auditCounts,
    crashCount: crashLogs.length,
  });

  return {
    kind: "atools_diagnostic_bundle",
    generatedAt: input.generatedAt || new Date().toISOString(),
    runtime: {
      connected: Boolean(input.runtime),
      runtime: input.runtime?.runtime || "browser-preview",
      platform: input.runtime?.platform || "unknown",
      arch: input.runtime?.arch || "unknown",
      debug: input.runtime?.debug ?? false,
      baseDir: input.runtime?.base_dir || "",
      dbPath: input.runtime?.db_path || "",
      pluginsDir: input.runtime?.plugins_dir || "",
      pluginCount: input.runtime?.plugin_count ?? 0,
      featureCount: input.runtime?.feature_count ?? 0,
      agentToolCount: input.runtime?.agent_tool_count ?? 0,
      enabledAgentToolCount: input.runtime?.enabled_agent_tool_count ?? 0,
      activePlugin: input.runtime?.active_plugin || "",
      recentEvents: {
        total: input.runtime?.recent_events.length ?? 0,
        errors: runtimeErrors,
      },
      mcp: {
        enabled: input.mcpStatus?.enabled ?? input.runtime?.mcp_enabled ?? false,
        bind: input.mcpStatus?.bind || input.runtime?.mcp_bind || "",
      },
    },
    settings: redactedSettings(input.settings),
    localData: {
      aliases: {
        total: input.aliases.length,
        enabled: input.aliases.filter((entry) => entry.enabled).length,
      },
      history: {
        total: input.history.length,
      },
      localLaunch: {
        total: input.localLaunchEntries.length,
        enabled: input.localLaunchEntries.filter((entry) => entry.enabled).length,
      },
      webQuickOpen: {
        total: input.webQuickOpenEntries.length,
        enabled: input.webQuickOpenEntries.filter((entry) => entry.enabled).length,
      },
      clipboardHistory: {
        total: safeCount(input.clipboardHistoryCount),
      },
      pluginData: {
        plugins: pluginDataSummary.length,
        documents: pluginDataDocuments,
        errors: pluginDataErrors,
      },
    },
    audits: {
      ...auditCounts,
      recentErrors: auditErrorSummaries(audits, 5),
    },
    crashes: {
      total: crashLogs.length,
      recent: crashLogSummaries(crashLogs, 3),
    },
    warnings,
  };
}

export function diagnosticBundleText(bundle: DiagnosticBundle): string {
  return JSON.stringify(bundle, null, 2);
}

export function runtimeDiagnosticRows(runtime: RuntimeDiagnostics | null | undefined): DebugDiagnosticRow[] {
  if (!runtime) {
    return [
      {
        label: "桌面运行时",
        value: "浏览器预览",
        detail: "需要 Tauri 桌面端才能读取主进程状态",
        tone: "warning",
      },
    ];
  }

  const hasErrorEvent = runtime.recent_events.some((event) => event.level === "error");
  const latestEvents = runtime.recent_events.slice(-3);
  return [
    {
      label: "桌面运行时",
      value: `${runtime.runtime} / ${runtime.platform}-${runtime.arch}`,
      detail: runtime.debug ? "Debug 构建" : "Release 构建",
    },
    {
      label: "数据目录",
      value: runtime.base_dir,
      detail: "本地优先数据根目录",
    },
    {
      label: "数据库",
      value: runtime.db_path,
      detail: "SQLite 主数据库路径",
    },
    {
      label: "插件目录",
      value: runtime.plugins_dir,
      detail: "本地插件安装目录",
    },
    {
      label: "插件/指令",
      value: `${runtime.plugin_count} 插件 / ${runtime.feature_count} 指令`,
      detail: runtime.plugin_count === 0 ? "尚未导入插件" : "已进入 Rust 索引",
    },
    {
      label: "Agent 工具",
      value: `${runtime.agent_tool_count} 工具 / ${runtime.enabled_agent_tool_count} 启用`,
      detail: "通过 MCP 暴露前仍受权限策略控制",
      tone: runtime.enabled_agent_tool_count === 0 ? "warning" : "normal",
    },
    {
      label: "MCP 服务",
      value: `${runtime.mcp_enabled ? "运行中" : "未启动"} / ${runtime.mcp_bind || "无"}`,
      detail: "Token 已隐藏；设置页 MCP 服务可查看和复制客户端配置",
      tone: runtime.mcp_enabled ? "normal" : "warning",
    },
    {
      label: "当前插件",
      value: runtime.active_plugin || "无",
      detail: runtime.active_plugin ? "当前主窗口激活插件" : "当前在内置页面或主搜索",
    },
    {
      label: "最近主进程事件",
      value: `${runtime.recent_events.length} 条`,
      detail: latestEvents.length === 0
        ? "暂无事件"
        : latestEvents.map((event) => `${event.level}: ${event.message}`).join("；"),
      tone: hasErrorEvent ? "error" : "normal",
    },
  ];
}

function durationLabel(durationMs: number) {
  return Number.isFinite(durationMs) ? `${Math.max(0, Math.round(durationMs))}ms` : "未知";
}

function searchModeLabel(value: unknown) {
  if (value === "list") return "列表模式";
  if (value === "aggregate") return "聚合模式";
  return "未知";
}

function diagnosticAuditCounts(entries: AuditLogEntry[]) {
  const counts = {
    total: entries.length,
    success: 0,
    denied: 0,
    error: 0,
    pending: 0,
    unknown: 0,
  };
  for (const entry of entries) {
    counts[diagnosticAuditTone(entry)] += 1;
  }
  return counts;
}

function diagnosticAuditTone(entry: AuditLogEntry): "success" | "denied" | "error" | "pending" | "unknown" {
  const status = String(entry.status || "").toLowerCase();
  if (entry.error || ["error", "failed", "failure"].includes(status)) return "error";
  if (["denied", "rejected", "refused"].includes(status)) return "denied";
  if (["pending", "waiting"].includes(status)) return "pending";
  if (["success", "ok", "completed", "confirmed", "allowed"].includes(status)) return "success";
  return "unknown";
}

function diagnosticWarnings(input: {
  input: DiagnosticBundleInput;
  runtimeErrors: number;
  auditCounts: ReturnType<typeof diagnosticAuditCounts>;
  crashCount: number;
}): string[] {
  const warnings: string[] = [];
  const runtime = input.input.runtime;
  if (!runtime) {
    warnings.push("Tauri 运行时未连接");
  }
  if (runtime && !(input.input.mcpStatus?.enabled ?? runtime.mcp_enabled)) {
    warnings.push("MCP 服务未启动");
  }
  if (!input.input.settings.hotkey) {
    warnings.push("未设置呼出快捷键");
  }
  if (input.runtimeErrors > 0) {
    warnings.push("主进程最近有错误事件");
  }
  const auditProblems = input.auditCounts.denied + input.auditCounts.error;
  if (auditProblems > 0) {
    warnings.push(`最近审计有 ${auditProblems} 条拒绝/失败`);
  }
  if (input.crashCount > 0) {
    warnings.push(`存在 ${input.crashCount} 条崩溃日志`);
  }
  return warnings;
}

function redactedSettings(settings: Partial<AToolsSettings>): Record<string, unknown> {
  return {
    hotkey: settings.hotkey || "",
    launchAtLogin: settings.launchAtLogin ?? false,
    showTrayIcon: settings.showTrayIcon ?? false,
    theme: settings.theme || "system",
    primaryColor: settings.primaryColor || "purple",
    opacity: settings.opacity ?? 1,
    searchMode: settings.searchMode || "aggregate",
    showRecentInSearch: settings.showRecentInSearch ?? true,
    localAppSearch: settings.localAppSearch ?? true,
    localLaunchSearch: settings.localLaunchSearch ?? true,
    autoPaste: settings.autoPaste || "off",
    autoClear: settings.autoClear || "off",
    autoBackToSearch: settings.autoBackToSearch || "never",
    clipboardRetentionDays: settings.clipboardRetentionDays ?? 180,
    aiProvider: settings.aiProvider || "disabled",
    aiBaseUrl: settings.aiBaseUrl || "",
    aiDefaultModel: settings.aiDefaultModel || "",
    aiApiKey: redactSecret(settings.aiApiKey),
    aiUseForAgent: settings.aiUseForAgent ?? false,
    proxyEnabled: settings.proxyEnabled ?? false,
    proxyUrl: redactSecret(settings.proxyUrl),
    webdavEnabled: settings.webdavEnabled ?? false,
    webdavUrl: settings.webdavUrl || "",
    webdavUsername: settings.webdavUsername || "",
    webdavPassword: redactSecret(settings.webdavPassword),
    webdavRemotePath: settings.webdavRemotePath || "",
    webdavSyncSettings: settings.webdavSyncSettings ?? true,
    webdavSyncPlugins: settings.webdavSyncPlugins ?? false,
    webdavSyncClipboard: settings.webdavSyncClipboard ?? false,
  };
}

function redactSecret(value: unknown): string {
  return typeof value === "string" && value.trim() ? "<redacted>" : "";
}

function safeCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}
