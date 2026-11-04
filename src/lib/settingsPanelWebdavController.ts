import { invoke } from "@tauri-apps/api/core";
import { validateShortcut, type HotkeyPlatform } from "./hotkeyRecorder";
import {
  applyAToolsAppearance,
  dispatchAToolsSettings,
  normalizeSettings,
  type AToolsSettings,
} from "./settings";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import { createSettingsWebdavViewController } from "./settingsPanelWebdavViewController";
import type {
  ClipboardHistoryEntry,
  WebdavBackupPreview,
  WebdavClipboardRestoreResult,
  WebdavPluginDataRestoreResult,
  WebdavRestorePlan,
  WebdavSettingsRestoreResult,
  WebdavSyncSummary,
} from "./types";

type WebdavPluginDataRestoreMode = "append_missing" | "overwrite_conflicts" | "overwrite_selected_conflicts";

export function createSettingsWebdavController(
  s: SettingsPanelState,
  deps: {
    persistSoon: () => void;
    currentSettings: () => AToolsSettings;
    saveSettingsImmediately: (settings: AToolsSettings) => Promise<void>;
    applySettings: (settings: AToolsSettings) => void;
    confirmSettingsAction: (options: {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      tone?: "default" | "danger";
    }) => Promise<boolean>;
    hotkeyPlatform: () => HotkeyPlatform;
    refreshDataPage: () => Promise<void>;
  },
) {
  const {
    persistSoon,
    currentSettings,
    saveSettingsImmediately,
    applySettings,
    confirmSettingsAction,
    hotkeyPlatform,
    refreshDataPage,
  } = deps;

  const view = createSettingsWebdavViewController(s, { persistSoon });
  const {
    webdavSyncButton,
    webdavPreviewButton,
    webdavRestorePlanButton,
    webdavSettingsRestoreButton,
    webdavClipboardRestoreButton,
    webdavPluginDataRestoreButton,
    webdavPluginDataOverwriteButton,
    webdavPluginDataSelectedOverwriteButton,
    webdavSelectedPluginConflicts,
  } = view;

  async function syncWebdavNow() {
    const button = webdavSyncButton();
    if (button.disabled) {
      s.webdavSyncStatus = button.reason;
      return;
    }

    s.webdavSyncing = true;
    s.webdavSyncStatus = "正在上传 WebDAV 备份...";
    s.webdavLastSync = null;
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const summary = await invoke<WebdavSyncSummary>("sync_webdav_now", { settings });
      s.webdavLastSync = summary;
      s.webdavLastPreview = null;
      s.webdavLastRestorePlan = null;
      s.webdavLastSettingsRestore = null;
      s.webdavLastClipboardRestore = null;
      s.webdavLastPluginDataRestore = null;
      s.webdavSelectedPluginConflictKeys = [];
      s.webdavSyncStatus = `已上传 ${summary.files_uploaded.length} 个文件，远端 manifest 已验证`;
    } catch (error) {
      s.webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.webdavSyncing = false;
    }
  }

  async function previewWebdavBackup() {
    const button = webdavPreviewButton();
    if (button.disabled) {
      s.webdavSyncStatus = button.reason;
      return;
    }

    s.webdavPreviewing = true;
    s.webdavSyncStatus = "正在检查远端 WebDAV 备份...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const preview = await invoke<WebdavBackupPreview>("preview_webdav_backup", { settings });
      s.webdavLastPreview = preview;
      s.webdavLastRestorePlan = null;
      s.webdavLastSettingsRestore = null;
      s.webdavLastClipboardRestore = null;
      s.webdavLastPluginDataRestore = null;
      s.webdavSelectedPluginConflictKeys = [];
      s.webdavSyncStatus = `已检查远端备份，发现 ${preview.files.length} 个文件`;
    } catch (error) {
      s.webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.webdavPreviewing = false;
    }
  }

  async function planWebdavRestore() {
    const button = webdavRestorePlanButton();
    if (button.disabled) {
      s.webdavSyncStatus = button.reason;
      return;
    }

    s.webdavPlanningRestore = true;
    s.webdavSyncStatus = "正在生成 WebDAV 恢复计划...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const plan = await invoke<WebdavRestorePlan>("plan_webdav_restore", { settings });
      s.webdavLastRestorePlan = plan;
      s.webdavLastSettingsRestore = null;
      s.webdavLastClipboardRestore = null;
      s.webdavLastPluginDataRestore = null;
      s.webdavSelectedPluginConflictKeys = [];
      s.webdavSyncStatus = `已生成恢复计划，包含 ${plan.items.length} 个范围`;
    } catch (error) {
      s.webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.webdavPlanningRestore = false;
    }
  }

  function webdavSettingsRestoreConfirmText() {
    const settingsItem = s.webdavLastRestorePlan?.items.find((item) => item.scope === "settings");
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
      s.webdavSyncStatus = button.reason;
      return;
    }
    if (!await confirmSettingsAction({
      title: "恢复 WebDAV 设置",
      message: webdavSettingsRestoreConfirmText(),
      confirmLabel: "恢复设置",
    })) {
      s.webdavSyncStatus = "已取消恢复设置";
      return;
    }

    s.webdavRestoringSettings = true;
    s.webdavSyncStatus = "正在恢复 WebDAV 设置...";
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
      s.webdavLastSettingsRestore = result;
      s.webdavSyncStatus = `已恢复 ${result.applied_keys.length} 个设置项，跳过 ${result.skipped_keys.length} 个脱敏字段`;
    } catch (error) {
      s.webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.webdavRestoringSettings = false;
    }
  }

  function webdavClipboardRestoreConfirmText() {
    const clipboardItem = s.webdavLastRestorePlan?.items.find((item) => item.scope === "clipboard");
    const summary = clipboardItem
      ? `${clipboardItem.local_summary} -> ${clipboardItem.remote_summary}`
      : "远端剪贴板历史";
    return `确定从远端 WebDAV 备份导入剪贴板历史？\n${summary}\n本操作只追加本机缺失的文本历史，不会清空或覆盖现有剪贴板历史。`;
  }

  async function restoreWebdavClipboardHistory() {
    const button = webdavClipboardRestoreButton();
    if (button.disabled) {
      s.webdavSyncStatus = button.reason;
      return;
    }
    if (!await confirmSettingsAction({
      title: "导入剪贴板历史",
      message: webdavClipboardRestoreConfirmText(),
      confirmLabel: "导入剪贴板",
    })) {
      s.webdavSyncStatus = "已取消导入剪贴板历史";
      return;
    }

    s.webdavRestoringClipboard = true;
    s.webdavSyncStatus = "正在导入 WebDAV 剪贴板历史...";
    const settings = currentSettings();
    try {
      await saveSettingsImmediately(settings);
      const result = await invoke<WebdavClipboardRestoreResult>("restore_webdav_clipboard_history", {
        settings,
        confirmed: true,
      });
      s.webdavLastClipboardRestore = result;
      s.clipboardHistory = await invoke<ClipboardHistoryEntry[]>("list_clipboard_history", { query: "", limit: 20 });
      s.webdavSyncStatus = `已导入 ${result.imported_entries} 条剪贴板历史，跳过 ${result.skipped_entries} 条`;
    } catch (error) {
      s.webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.webdavRestoringClipboard = false;
    }
  }

  function webdavPluginDataRestoreConfirmText(mode: WebdavPluginDataRestoreMode) {
    const pluginItem = s.webdavLastRestorePlan?.items.find((item) => item.scope === "plugins");
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
      s.webdavSyncStatus = button.reason;
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
      s.webdavSyncStatus = mode === "append_missing" ? "已取消导入插件数据" : "已取消覆盖插件数据冲突";
      return;
    }

    s.webdavRestoringPluginData = true;
    s.webdavSyncStatus = mode === "append_missing" ? "正在导入 WebDAV 插件数据..." : "正在覆盖 WebDAV 插件数据冲突...";
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
      s.webdavLastPluginDataRestore = result;
      if (s.activeMenu === "data") {
        await refreshDataPage();
      }
      s.webdavSyncStatus = result.overwritten_documents > 0
        ? `已导入 ${result.imported_documents} 条插件数据，覆盖 ${result.overwritten_documents} 条冲突，跳过 ${result.skipped_documents} 条`
        : `已导入 ${result.imported_documents} 条插件数据，跳过 ${result.skipped_documents} 条`;
    } catch (error) {
      s.webdavSyncStatus = error instanceof Error ? error.message : String(error);
    } finally {
      s.webdavRestoringPluginData = false;
    }
  }

  return {
    ...view,
    syncWebdavNow,
    previewWebdavBackup,
    planWebdavRestore,
    webdavSettingsRestoreConfirmText,
    restoreWebdavSettings,
    webdavClipboardRestoreConfirmText,
    restoreWebdavClipboardHistory,
    webdavPluginDataRestoreConfirmText,
    restoreWebdavPluginData,
  };
}
