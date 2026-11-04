import { hasTauriRuntime } from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import type { WebdavPluginDataConflictDocument } from "./types";
import {
  webdavClipboardRestoreButtonState,
  webdavClipboardRestoreRows,
  webdavOverviewCards,
  webdavPluginDataOverwriteButtonState,
  webdavPluginDataRestoreButtonState,
  webdavPluginDataRestoreRows,
  webdavPluginDataSelectedOverwriteButtonState,
  webdavPreviewButtonState,
  webdavPreviewRows,
  webdavRestorePlanButtonState,
  webdavRestorePlanRows,
  webdavSettingsRestoreButtonState,
  webdavSettingsRestoreRows,
  webdavSyncButtonState,
  webdavSyncRows,
} from "./webdavSyncView";

export function createSettingsWebdavViewController(
  s: SettingsPanelState,
  deps: {
    persistSoon: () => void;
  },
) {
  const { persistSoon } = deps;

  function webdavConfigReady() {
    const url = s.webdavUrl.trim();
    if (!url || !s.webdavUsername.trim()) return false;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }

  function webdavStatusText() {
    if (s.webdavSyncing) return "同步中";
    if (s.webdavPreviewing) return "检查中";
    if (s.webdavPlanningRestore) return "计划中";
    if (s.webdavRestoringSettings) return "恢复中";
    if (s.webdavRestoringClipboard) return "导入中";
    if (s.webdavLastClipboardRestore) return "已导入";
    if (s.webdavLastSettingsRestore) return "已恢复";
    if (s.webdavLastRestorePlan?.items.length) return "有计划";
    if (s.webdavLastSync?.remote_manifest_verified) return "已同步";
    if (s.webdavLastPreview?.files.length) return "已检查";
    if (!s.webdavEnabled) return "未启用";
    if (!webdavConfigReady()) return "配置不完整";
    return "配置已保存";
  }

  function clearWebdavSyncResult() {
    s.webdavLastSync = null;
    s.webdavLastPreview = null;
    s.webdavLastRestorePlan = null;
    s.webdavLastSettingsRestore = null;
    s.webdavLastClipboardRestore = null;
    s.webdavLastPluginDataRestore = null;
    s.webdavSelectedPluginConflictKeys = [];
    s.webdavSyncStatus = "";
  }

  function updateWebdavEnabled(value: boolean, input?: HTMLInputElement) {
    clearWebdavSyncResult();
    const nextValue = value && webdavConfigReady();
    s.webdavEnabled = nextValue;
    if (input) input.checked = nextValue;
    persistSoon();
  }

  function persistWebdavConfigChange() {
    clearWebdavSyncResult();
    if (!webdavConfigReady()) {
      s.webdavEnabled = false;
    }
    persistSoon();
  }

  function persistWebdavScopeChange() {
    clearWebdavSyncResult();
    persistSoon();
  }

  function webdavScopeLabels() {
    return [
      s.webdavSyncSettings ? "设置" : "",
      s.webdavSyncPlugins ? "插件数据" : "",
      s.webdavSyncClipboard ? "剪贴板历史" : "",
    ].filter(Boolean);
  }

  function webdavSyncButton() {
    return webdavSyncButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
    });
  }

  function webdavPreviewButton() {
    return webdavPreviewButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
    });
  }

  function webdavRestorePlanButton() {
    return webdavRestorePlanButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
      planning: s.webdavPlanningRestore,
    });
  }

  function webdavSettingsRestoreButton() {
    return webdavSettingsRestoreButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
      planning: s.webdavPlanningRestore,
      restoring: s.webdavRestoringSettings,
      plan: s.webdavLastRestorePlan,
    });
  }

  function webdavClipboardRestoreButton() {
    return webdavClipboardRestoreButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
      planning: s.webdavPlanningRestore,
      restoring: s.webdavRestoringClipboard,
      plan: s.webdavLastRestorePlan,
    });
  }

  function webdavPluginDataRestoreButton() {
    return webdavPluginDataRestoreButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
      planning: s.webdavPlanningRestore,
      restoring: s.webdavRestoringPluginData,
      plan: s.webdavLastRestorePlan,
    });
  }

  function webdavPluginDataOverwriteButton() {
    return webdavPluginDataOverwriteButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
      planning: s.webdavPlanningRestore,
      restoring: s.webdavRestoringPluginData,
      plan: s.webdavLastRestorePlan,
    });
  }

  function webdavPluginConflicts(): WebdavPluginDataConflictDocument[] {
    return s.webdavLastRestorePlan?.items.find((item) => item.scope === "plugins")?.plugin_conflicts ?? [];
  }

  function webdavPluginConflictKey(conflict: WebdavPluginDataConflictDocument) {
    return `${conflict.plugin_id}\u0000${conflict.doc_id}`;
  }

  function webdavSelectedPluginConflicts() {
    const selected = new Set(s.webdavSelectedPluginConflictKeys);
    return webdavPluginConflicts()
      .filter((conflict) => selected.has(webdavPluginConflictKey(conflict)))
      .map((conflict) => ({
        plugin_id: conflict.plugin_id,
        doc_id: conflict.doc_id,
      }));
  }

  function webdavPluginDataSelectedOverwriteButton() {
    return webdavPluginDataSelectedOverwriteButtonState({
      hasTauriRuntime: hasTauriRuntime(),
      enabled: s.webdavEnabled,
      configReady: webdavConfigReady(),
      syncing: s.webdavSyncing,
      previewing: s.webdavPreviewing,
      planning: s.webdavPlanningRestore,
      restoring: s.webdavRestoringPluginData,
      plan: s.webdavLastRestorePlan,
      selectedConflicts: webdavSelectedPluginConflicts().length,
    });
  }

  function toggleWebdavPluginConflict(conflict: WebdavPluginDataConflictDocument, checked: boolean) {
    const key = webdavPluginConflictKey(conflict);
    const selected = new Set(s.webdavSelectedPluginConflictKeys);
    if (checked) {
      selected.add(key);
    } else {
      selected.delete(key);
    }
    s.webdavSelectedPluginConflictKeys = Array.from(selected);
  }

  function selectAllWebdavPluginConflicts() {
    s.webdavSelectedPluginConflictKeys = webdavPluginConflicts().map(webdavPluginConflictKey);
  }

  function clearSelectedWebdavPluginConflicts() {
    s.webdavSelectedPluginConflictKeys = [];
  }

  function webdavStatusRows() {
    return webdavSyncRows({
      configReady: webdavConfigReady(),
      remotePath: s.webdavRemotePath,
      scopes: webdavScopeLabels(),
      summary: s.webdavLastSync,
    });
  }

  function webdavOverview() {
    return webdavOverviewCards({
      enabled: s.webdavEnabled && webdavConfigReady(),
      configReady: webdavConfigReady(),
      hasTauriRuntime: hasTauriRuntime(),
      remotePath: s.webdavRemotePath,
      scopes: webdavScopeLabels(),
      statusLabel: webdavStatusText(),
      hasPassword: Boolean(s.webdavPassword.trim()),
      lastSync: s.webdavLastSync,
      lastPreview: s.webdavLastPreview,
      lastRestorePlan: s.webdavLastRestorePlan,
    });
  }

  function webdavRemotePreviewRows() {
    return webdavPreviewRows(s.webdavLastPreview);
  }

  function webdavRemoteRestorePlanRows() {
    return webdavRestorePlanRows(s.webdavLastRestorePlan);
  }

  function webdavRemoteSettingsRestoreRows() {
    return webdavSettingsRestoreRows(s.webdavLastSettingsRestore);
  }

  function webdavRemoteClipboardRestoreRows() {
    return webdavClipboardRestoreRows(s.webdavLastClipboardRestore);
  }

  function webdavRemotePluginDataRestoreRows() {
    return webdavPluginDataRestoreRows(s.webdavLastPluginDataRestore);
  }

  return {
    webdavConfigReady,
    webdavStatusText,
    clearWebdavSyncResult,
    updateWebdavEnabled,
    persistWebdavConfigChange,
    persistWebdavScopeChange,
    webdavScopeLabels,
    webdavSyncButton,
    webdavPreviewButton,
    webdavRestorePlanButton,
    webdavSettingsRestoreButton,
    webdavClipboardRestoreButton,
    webdavPluginDataRestoreButton,
    webdavPluginDataOverwriteButton,
    webdavPluginConflicts,
    webdavPluginConflictKey,
    webdavSelectedPluginConflicts,
    webdavPluginDataSelectedOverwriteButton,
    toggleWebdavPluginConflict,
    selectAllWebdavPluginConflicts,
    clearSelectedWebdavPluginConflicts,
    webdavStatusRows,
    webdavOverview,
    webdavRemotePreviewRows,
    webdavRemoteRestorePlanRows,
    webdavRemoteSettingsRestoreRows,
    webdavRemoteClipboardRestoreRows,
    webdavRemotePluginDataRestoreRows,
  };
}
