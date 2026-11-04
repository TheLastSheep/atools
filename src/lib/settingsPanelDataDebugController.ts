import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { loadCommandAliases } from "./commandAliases";
import {
  clearCommandHistoryStorage,
  exportCommandHistoryJson,
  loadCommandHistory,
  removeCommandHistoryEntryStorage,
  type CommandHistoryEntry,
} from "./commandHistory";
import { buildDiagnosticBundle, diagnosticBundleText } from "./debugDiagnostics";
import { loadLocalLaunchEntries } from "./localLaunch";
import { DEFAULT_ATOOLS_SETTINGS, type AToolsSettings } from "./settings";
import {
  AUDIT_KEEP_LATEST,
  AUDIT_RETENTION_DAYS,
  copyText,
  hasTauriRuntime,
  type PluginDocument,
} from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import type {
  AuditArchiveResult,
  AuditLogEntry,
  ClipboardHistoryEntry,
  CrashLogEntry,
  InstalledPlugin,
  McpServerStatus,
  RuntimeDiagnostics,
} from "./types";
import { loadWebQuickOpenEntries } from "./webQuickOpen";

export function createSettingsDataDebugController(
  s: SettingsPanelState,
  deps: {
    currentSettings: () => AToolsSettings;
    applySettings: (settings: AToolsSettings) => void;
    persistSoon: () => void;
    confirmSettingsAction: (options: {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      tone?: "default" | "danger";
    }) => Promise<boolean>;
  },
) {
  const { currentSettings, applySettings, persistSoon, confirmSettingsAction } = deps;

  async function refreshDataPage() {
    s.dataLoading = true;
    s.dataStatus = "";
    s.commandHistory = loadCommandHistory();
    if (!hasTauriRuntime()) {
      s.installedPlugins = [];
      s.recentAudits = [];
      s.clipboardHistory = [];
      s.pluginDataSummary = [];
      s.dataStatus = "Tauri 运行时未连接，剪贴板、审计和插件数据需在桌面应用中查看";
      s.dataLoading = false;
      return;
    }
    try {
      const [plugins, audits, clipboardItems] = await Promise.all([
        invoke<InstalledPlugin[]>("list_plugins"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 20 }),
        invoke<ClipboardHistoryEntry[]>("list_clipboard_history", { query: "", limit: 20 }),
      ]);
      s.installedPlugins = plugins;
      s.recentAudits = audits;
      s.clipboardHistory = clipboardItems;
      s.pluginDataSummary = await Promise.all(plugins.map(async (plugin) => {
        try {
          const docs = await invoke<PluginDocument[]>("get_plugin_data", { pluginId: plugin.id });
          return { plugin, documents: docs.length };
        } catch (error) {
          return { plugin, documents: 0, error: String(error) };
        }
      }));
    } catch (error) {
      s.dataStatus = String(error);
    } finally {
      s.dataLoading = false;
    }
  }

  async function exportSettings() {
    await copyText(JSON.stringify(currentSettings(), null, 2));
    s.dataStatus = "已复制设置 JSON";
  }

  async function exportCommandHistory() {
    await copyText(exportCommandHistoryJson(s.commandHistory));
    s.dataStatus = `已复制 ${s.commandHistory.length} 条最近使用历史`;
  }

  async function clearCommandHistory() {
    if (!await confirmSettingsAction({
      title: "清空最近使用历史",
      message: "确定要清空最近使用历史吗？这不会删除插件、设置或审计记录。",
      confirmLabel: "清空",
    })) return;
    const count = clearCommandHistoryStorage();
    s.commandHistory = [];
    s.dataStatus = `已清空 ${count} 条最近使用历史`;
  }

  function removeCommandHistoryItem(entry: CommandHistoryEntry) {
    const count = removeCommandHistoryEntryStorage(entry.code, entry.plugin_id);
    s.commandHistory = loadCommandHistory();
    s.dataStatus = count > 0 ? "已移除 1 条最近使用历史" : "未找到对应历史记录";
  }

  async function exportClipboardHistory() {
    try {
      const json = await invoke<string>("export_clipboard_history_json", { limit: 1000 });
      await copyText(json);
      s.dataStatus = `已复制 ${s.clipboardHistory.length} 条剪贴板历史`;
    } catch (error) {
      s.dataStatus = String(error);
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
      s.clipboardHistory = [];
      s.dataStatus = `已清空 ${count} 条剪贴板历史`;
    } catch (error) {
      s.dataStatus = String(error);
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
    s.dataStatus = "已恢复默认设置";
  }

  function auditArchiveDefaultPath() {
    const date = new Date().toISOString().slice(0, 10);
    return `atools-audit-archive-${date}.jsonl`;
  }

  async function exportAudits() {
    try {
      const jsonl = await invoke<string>("export_audit_entries_jsonl", { limit: 1000 });
      await copyText(jsonl);
      s.dataStatus = `已复制 ${jsonl.split("\n").filter(Boolean).length} 条审计记录`;
    } catch (error) {
      s.dataStatus = String(error);
    }
  }

  async function archiveAudits() {
    if (!hasTauriRuntime()) {
      s.dataStatus = "需在桌面应用中归档审计记录";
      return;
    }
    const targetPath = await saveDialog({
      title: "归档审计记录",
      defaultPath: auditArchiveDefaultPath(),
      filters: [{ name: "JSON Lines", extensions: ["jsonl"] }],
    });
    if (!targetPath) {
      s.dataStatus = "已取消审计归档";
      return;
    }

    s.auditArchiveBusy = true;
    try {
      const result = await invoke<AuditArchiveResult>("archive_audit_entries_jsonl", {
        path: targetPath,
        limit: 1000,
        confirmed: true,
      });
      s.dataStatus = result.count > 0
        ? `已归档 ${result.count} 条审计记录到 ${result.path}`
        : `已创建空审计归档：${result.path}`;
    } catch (error) {
      s.dataStatus = String(error);
    } finally {
      s.auditArchiveBusy = false;
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
      s.dataStatus = `已清空 ${count} 条审计记录`;
      await refreshDataPage();
    } catch (error) {
      s.dataStatus = String(error);
    }
  }

  async function pruneAuditEntries() {
    if (!await confirmSettingsAction({
      title: "按保留策略清理审计",
      message: `将删除早于 ${AUDIT_RETENTION_DAYS} 天的审计记录，并且只保留最新 ${AUDIT_KEEP_LATEST} 条。此操作不可恢复。`,
      confirmLabel: "清理",
    })) return;
    s.auditPruneBusy = true;
    try {
      const count = await invoke<number>("prune_audit_entries", {
        retentionDays: AUDIT_RETENTION_DAYS,
        keepLatest: AUDIT_KEEP_LATEST,
      });
      s.dataStatus = count > 0 ? `已按保留策略清理 ${count} 条审计记录` : "审计记录已符合保留策略";
      await refreshDataPage();
    } catch (error) {
      s.dataStatus = String(error);
    } finally {
      s.auditPruneBusy = false;
    }
  }

  async function exportPluginData() {
    try {
      const payload = await Promise.all(s.installedPlugins.map(async (plugin) => ({
        plugin: { id: plugin.id, name: plugin.name, version: plugin.version },
        documents: await invoke<PluginDocument[]>("get_plugin_data", { pluginId: plugin.id }),
      })));
      await copyText(JSON.stringify(payload, null, 2));
      s.dataStatus = `已复制 ${payload.length} 个插件的数据`;
    } catch (error) {
      s.dataStatus = String(error);
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
      for (const plugin of s.installedPlugins) {
        const docs = await invoke<PluginDocument[]>("get_plugin_data", { pluginId: plugin.id });
        for (const doc of docs) {
          await invoke("remove_plugin_data", { pluginId: plugin.id, docId: doc._id });
          count += 1;
        }
      }
      s.dataStatus = `已清空 ${count} 条插件数据`;
      await refreshDataPage();
    } catch (error) {
      s.dataStatus = String(error);
    }
  }

  async function refreshDebugPage() {
    s.debugLoading = true;
    s.debugStatus = "";
    s.commandHistory = loadCommandHistory();
    s.localLaunchEntries = loadLocalLaunchEntries();
    s.webQuickOpenEntries = loadWebQuickOpenEntries();
    s.commandAliases = loadCommandAliases();
    if (!hasTauriRuntime()) {
      s.debugMcpStatus = null;
      s.runtimeDiagnostics = null;
      s.debugAudits = [];
      s.recentAuditErrors = [];
      s.crashLogs = [];
      s.debugStatus = "浏览器预览模式，无法读取 Tauri MCP 状态和审计记录";
      s.debugLoading = false;
      return;
    }
    try {
      const [status, audits, runtime, crashes] = await Promise.all([
        invoke<McpServerStatus | null>("get_mcp_status"),
        invoke<AuditLogEntry[]>("list_audit_entries", { limit: 30 }),
        invoke<RuntimeDiagnostics>("get_runtime_diagnostics"),
        invoke<CrashLogEntry[]>("list_crash_logs", { limit: 20 }),
      ]);
      s.debugMcpStatus = status;
      s.runtimeDiagnostics = runtime;
      s.debugAudits = audits;
      s.recentAuditErrors = audits.filter((audit) => audit.error || audit.status !== "success").slice(0, 5);
      s.crashLogs = crashes;
    } catch (error) {
      s.debugStatus = String(error);
    } finally {
      s.debugLoading = false;
    }
  }

  function currentDiagnosticBundle() {
    return buildDiagnosticBundle({
      aliases: s.commandAliases,
      history: s.commandHistory,
      localLaunchEntries: s.localLaunchEntries,
      webQuickOpenEntries: s.webQuickOpenEntries,
      settings: currentSettings(),
      runtime: s.runtimeDiagnostics,
      mcpStatus: s.debugMcpStatus,
      audits: s.debugAudits,
      crashLogs: s.crashLogs,
      clipboardHistoryCount: s.clipboardHistory.length,
      pluginDataSummary: s.pluginDataSummary,
    });
  }

  async function copyDebugInfo() {
    await copyText(diagnosticBundleText(currentDiagnosticBundle()));
    s.debugStatus = "已复制脱敏诊断包";
  }

  async function copyCrashLog() {
    if (!hasTauriRuntime()) return;
    const log = await invoke<string>("export_crash_log");
    await copyText(log || "");
    s.debugStatus = log ? "已复制崩溃日志" : "暂无崩溃日志";
  }

  async function clearCrashLog() {
    if (!hasTauriRuntime()) return;
    if (!await confirmSettingsAction({
      title: "清空崩溃日志",
      message: "确定清空崩溃日志？此操作只清空本地 crashes.log。",
      confirmLabel: "清空",
    })) return;
    const count = await invoke<number>("clear_crash_log");
    s.crashLogs = [];
    s.debugStatus = `已清空 ${count} 条崩溃日志`;
  }

  return {
    refreshDataPage,
    exportSettings,
    exportCommandHistory,
    clearCommandHistory,
    removeCommandHistoryItem,
    exportClipboardHistory,
    clearClipboardHistory,
    resetSettings,
    auditArchiveDefaultPath,
    exportAudits,
    archiveAudits,
    clearAudits,
    pruneAuditEntries,
    exportPluginData,
    clearPluginData,
    refreshDebugPage,
    currentDiagnosticBundle,
    copyDebugInfo,
    copyCrashLog,
    clearCrashLog,
  };
}
