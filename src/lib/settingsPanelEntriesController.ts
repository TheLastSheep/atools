import { invoke } from "@tauri-apps/api/core";
import {
  createCommandAlias,
  dispatchCommandAliasesUpdated,
  normalizeCommandAliases,
  saveCommandAliases,
  type CommandAliasEntry,
} from "./commandAliases";
import {
  isCancelKey,
  recordingHint,
  shortcutFromKeyboardEvent,
  validateShortcut,
  type HotkeyPlatform,
} from "./hotkeyRecorder";
import type { LocalLaunchEntry } from "./localLaunch";
import {
  dispatchPinnedCommandCodes,
  savePinnedCommandCodes,
  togglePinnedCommandCode,
} from "./pinnedCommands";
import type { AppShortcutSetting } from "./settings";
import {
  createAppShortcut,
  defaultHotkeyForPlatform,
  hotkeyPresetsForPlatform,
  normalizeAppShortcuts,
  type CommandCenterRow,
} from "./settingsPages";
import { callHumanCapability, hasTauriRuntime } from "./settingsPanelTypesAndOptions";
import type { SettingsPanelState } from "./settingsPanelState.svelte";
import { addWakeupBlacklistItem } from "./wakeupBlacklist";
import {
  buildWebQuickOpenUrl,
  createWebQuickOpenEntry,
  DEFAULT_WEB_QUICK_OPEN_ENTRIES,
  dispatchWebQuickOpenEntries,
  saveWebQuickOpenEntries,
  validateWebQuickOpenEntry,
  webQuickOpenOverviewCards,
  type WebQuickOpenEntry,
} from "./webQuickOpen";

export function createSettingsEntriesController(
  s: SettingsPanelState,
  deps: {
    persistSoon: () => void;
    confirmSettingsAction: (options: {
      title: string;
      message: string;
      confirmLabel?: string;
      cancelLabel?: string;
      tone?: "default" | "danger";
    }) => Promise<boolean>;
    shortcutSaveText: () => string;
    aliasTargetOptions: () => Array<{
      code: string;
      label: string;
      explain: string;
      source: "system" | "local" | "web";
      enabled: boolean;
    }>;
    shortcutBuiltIns: () => Array<{ shortcut: string }>;
    updateLocalLaunchEntry: (id: string, patch: Partial<LocalLaunchEntry>) => void;
  },
) {
  const {
    persistSoon,
    confirmSettingsAction,
    shortcutSaveText,
    aliasTargetOptions,
    shortcutBuiltIns,
    updateLocalLaunchEntry,
  } = deps;

  function removeWakeupItem(index: number) {
    s.wakeupBlacklist = s.wakeupBlacklist.filter((_, i) => i !== index);
    persistSoon();
  }

  function addWakeupItem() {
    const next = addWakeupBlacklistItem(s.wakeupBlacklist, s.wakeupBlacklistDraft);
    s.wakeupBlacklistDraft = "";
    if (next.length === s.wakeupBlacklist.length) return;
    s.wakeupBlacklist = next;
    persistSoon();
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
    s.showHotkeyQuickActions = false;
    s.recordingHotkey = true;
    s.hotkeyRecorderMessage = recordingHint(hotkeyPlatform());
  }

  function toggleHotkeyQuickActions() {
    s.recordingHotkey = false;
    s.showHotkeyQuickActions = !s.showHotkeyQuickActions;
  }

  function applyHotkeyPreset(shortcut: string) {
    const validation = validateShortcut(shortcut, hotkeyPlatform());
    if (!validation.valid) {
      s.hotkeyRecorderMessage = validation.message;
      s.showHotkeyQuickActions = false;
      return;
    }
    s.hotkey = shortcut;
    s.recordingHotkey = false;
    s.showHotkeyQuickActions = false;
    s.hotkeyRecorderMessage = `已选择 ${shortcut}`;
    persistSoon();
  }

  function recordHotkeyFromWindow(event: KeyboardEvent) {
    if (!s.recordingHotkey) return;
    event.preventDefault();
    event.stopPropagation();

    if (isCancelKey(event)) {
      s.recordingHotkey = false;
      s.hotkeyRecorderMessage = "已取消快捷键录制";
      return;
    }

    const shortcut = shortcutFromKeyboardEvent(event, hotkeyPlatform());
    if (!shortcut) {
      s.hotkeyRecorderMessage = "请同时按下修饰键和主键";
      return;
    }
    const validation = validateShortcut(shortcut, hotkeyPlatform());
    if (!validation.valid) {
      s.hotkeyRecorderMessage = validation.message;
      return;
    }

    s.hotkey = shortcut;
    s.recordingHotkey = false;
    s.hotkeyRecorderMessage = `已录制 ${shortcut}`;
    persistSoon();
  }

  function onSettingsWindowKeydown(event: KeyboardEvent) {
    if (s.webQuickOpenDraft && event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      event.stopPropagation();
      closeWebQuickOpenEditor();
      return;
    }
    recordHotkeyFromWindow(event);
  }

  async function addCurrentWindowToWakeupBlacklist() {
    s.wakeupBlacklistStatus = "";
    if (!hasTauriRuntime()) {
      s.wakeupBlacklistStatus = "浏览器预览模式无法读取当前窗口";
      return;
    }
    try {
      const appName = await invoke<string | null>("read_frontmost_app_name");
      const value = appName?.trim();
      if (!value) {
        s.wakeupBlacklistStatus = "当前没有可添加的前台应用";
        return;
      }
      const next = addWakeupBlacklistItem(s.wakeupBlacklist, value);
      if (next.length === s.wakeupBlacklist.length) {
        s.wakeupBlacklistStatus = `${value} 已在黑名单中`;
        return;
      }
      s.wakeupBlacklist = next;
      s.wakeupBlacklistStatus = `已添加 ${value}`;
      persistSoon();
    } catch (error) {
      s.wakeupBlacklistStatus = String(error);
    }
  }

  function hotkeyStatusText() {
    return s.recordingHotkey || s.hotkeyRecorderMessage ? s.hotkeyRecorderMessage : shortcutSaveText();
  }

  function webQuickOpenOverview() {
    return webQuickOpenOverviewCards({
      entries: s.webQuickOpenEntries,
      statusLabel: s.webQuickOpenStatus,
    });
  }

  function persistWebQuickOpenEntries(entries: WebQuickOpenEntry[], status: string) {
    s.webQuickOpenEntries = entries;
    saveWebQuickOpenEntries(entries);
    dispatchWebQuickOpenEntries(entries);
    s.webQuickOpenStatus = status;
  }

  function openWebQuickOpenEditor(entry: WebQuickOpenEntry) {
    s.editingWebQuickOpenId = entry.id;
    s.webQuickOpenDraft = { ...entry };
    s.webQuickOpenValidation = "";
  }

  function closeWebQuickOpenEditor() {
    s.editingWebQuickOpenId = null;
    s.webQuickOpenDraft = null;
    s.webQuickOpenValidation = "";
  }

  function addWebQuickOpenEntry() {
    const existingKeywords = new Set(s.webQuickOpenEntries.map((entry) => entry.keyword));
    const next = createWebQuickOpenEntry();
    let suffix = 1;
    while (existingKeywords.has(next.keyword)) {
      suffix += 1;
      next.keyword = `web${suffix}`;
    }
    persistWebQuickOpenEntries([...s.webQuickOpenEntries, next], "已添加网页快开");
    openWebQuickOpenEditor(next);
  }

  function updateWebQuickOpenEntry(id: string, patch: Partial<WebQuickOpenEntry>) {
    persistWebQuickOpenEntries(
      s.webQuickOpenEntries.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
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
      s.webQuickOpenEntries.filter((item) => item.id !== entry.id),
      "已删除网页快开",
    );
    if (s.editingWebQuickOpenId === entry.id) {
      closeWebQuickOpenEditor();
    }
  }

  function resetWebQuickOpenEntries() {
    persistWebQuickOpenEntries(DEFAULT_WEB_QUICK_OPEN_ENTRIES.map((entry) => ({ ...entry })), "已恢复默认网页快开");
    closeWebQuickOpenEditor();
  }

  function updateWebQuickOpenDraft(patch: Partial<WebQuickOpenEntry>) {
    if (!s.webQuickOpenDraft) return;
    s.webQuickOpenDraft = { ...s.webQuickOpenDraft, ...patch };
    s.webQuickOpenValidation = "";
  }

  function validateWebQuickOpenDraft(entry: WebQuickOpenEntry) {
    return validateWebQuickOpenEntry(entry);
  }

  function saveWebQuickOpenEditor() {
    if (!s.webQuickOpenDraft) return;
    const validation = validateWebQuickOpenDraft(s.webQuickOpenDraft);
    if (validation) {
      s.webQuickOpenValidation = validation;
      return;
    }
    const draft = s.webQuickOpenDraft;
    persistWebQuickOpenEntries(
      s.webQuickOpenEntries.map((entry) => entry.id === draft.id ? { ...draft } : entry),
      `已保存 ${draft.name}`,
    );
    closeWebQuickOpenEditor();
  }

  function webQuickOpenTemplateMode(entry: WebQuickOpenEntry): "search" | "direct" {
    return entry.template.includes("{query}") ? "search" : "direct";
  }

  function applyWebQuickOpenMode(mode: "search" | "direct") {
    if (!s.webQuickOpenDraft) return;
    if (mode === "search") {
      const template = s.webQuickOpenDraft.template.trim() || "https://www.google.com/search";
      updateWebQuickOpenDraft({
        template: template.includes("{query}") ? template : `${template}${template.includes("?") ? "&" : "?"}q={query}`,
      });
      return;
    }
    updateWebQuickOpenDraft({
      template: s.webQuickOpenDraft.template.includes("{query}") ? "https://example.com" : s.webQuickOpenDraft.template,
    });
  }

  function webQuickOpenPreviewUrl(entry: WebQuickOpenEntry) {
    return buildWebQuickOpenUrl(entry, webQuickOpenTemplateMode(entry) === "search" ? "rust" : "");
  }

  async function previewWebQuickOpenEntry(entry: WebQuickOpenEntry) {
    const url = webQuickOpenPreviewUrl(entry);
    if (hasTauriRuntime()) {
      await callHumanCapability("open_url", { url });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    s.webQuickOpenStatus = `已预览 ${entry.name}`;
  }

  function persistCommandAliases(entries: CommandAliasEntry[], status: string) {
    const normalized = normalizeCommandAliases(entries);
    s.commandAliases = normalized;
    saveCommandAliases(normalized);
    dispatchCommandAliasesUpdated(normalized);
    s.commandAliasStatus = status;
  }

  function addCommandAlias(targetCodeOverride?: string) {
    const targets = aliasTargetOptions();
    const targetCode = targetCodeOverride ?? targets[0]?.code ?? "system:settings";
    const existingAliases = new Set(s.commandAliases.map((entry) => entry.alias));
    const next = createCommandAlias(targetCode);
    let suffix = 1;
    while (existingAliases.has(next.alias)) {
      suffix += 1;
      next.alias = `alias${suffix}`;
    }
    persistCommandAliases([...s.commandAliases, next], "已添加别名");
  }

  function updateCommandAlias(id: string, patch: Partial<CommandAliasEntry>) {
    persistCommandAliases(
      s.commandAliases.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存别名",
    );
  }

  function removeCommandAlias(id: string) {
    persistCommandAliases(
      s.commandAliases.filter((entry) => entry.id !== id),
      "已删除别名",
    );
  }

  function resetCommandAliases() {
    persistCommandAliases([], "已清空别名");
  }

  function toggleCommandCenterPinned(row: CommandCenterRow) {
    const next = togglePinnedCommandCode(s.commandCenterPinnedCodes, row.code);
    s.commandCenterPinnedCodes = next;
    savePinnedCommandCodes(next);
    dispatchPinnedCommandCodes(next);
    s.commandAliasStatus = row.pinned ? `已取消固定 ${row.label}` : `已固定 ${row.label}`;
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
      s.commandAliasStatus = `${row.label} 已${row.enabled ? "停用" : "启用"}`;
      return;
    }
    if (row.source === "web") {
      const id = row.code.startsWith("web:") ? row.code.slice("web:".length) : "";
      if (!id) return;
      updateWebQuickOpenEntry(id, { enabled: !row.enabled });
      s.commandAliasStatus = `${row.label} 已${row.enabled ? "停用" : "启用"}`;
    }
  }

  function persistAppShortcuts(entries: AppShortcutSetting[], status: string) {
    s.appShortcuts = normalizeAppShortcuts(entries);
    s.appShortcutStatus = status;
    persistSoon();
  }

  function addAppShortcut(targetCodeOverride?: string) {
    const targets = aliasTargetOptions();
    const targetCode = targetCodeOverride ?? targets[0]?.code ?? "system:settings";
    const existingShortcuts = [
      ...shortcutBuiltIns().map((row) => row.shortcut),
      ...s.appShortcuts.map((entry) => entry.shortcut),
    ];
    const next = createAppShortcut(targetCode, existingShortcuts, hotkeyPlatform());
    persistAppShortcuts([...s.appShortcuts, next], "已添加应用快捷键");
  }

  function updateAppShortcut(id: string, patch: Partial<AppShortcutSetting>) {
    persistAppShortcuts(
      s.appShortcuts.map((entry) => entry.id === id ? { ...entry, ...patch } : entry),
      "已保存应用快捷键",
    );
  }

  function removeAppShortcut(id: string) {
    persistAppShortcuts(
      s.appShortcuts.filter((entry) => entry.id !== id),
      "已删除应用快捷键",
    );
  }

  return {
    removeWakeupItem,
    addWakeupItem,
    hotkeyPlatform,
    hotkeyPresets,
    defaultHotkey,
    startHotkeyRecording,
    toggleHotkeyQuickActions,
    applyHotkeyPreset,
    recordHotkeyFromWindow,
    onSettingsWindowKeydown,
    addCurrentWindowToWakeupBlacklist,
    hotkeyStatusText,
    webQuickOpenOverview,
    persistWebQuickOpenEntries,
    openWebQuickOpenEditor,
    closeWebQuickOpenEditor,
    addWebQuickOpenEntry,
    updateWebQuickOpenEntry,
    removeWebQuickOpenEntry,
    resetWebQuickOpenEntries,
    updateWebQuickOpenDraft,
    validateWebQuickOpenDraft,
    saveWebQuickOpenEditor,
    webQuickOpenTemplateMode,
    applyWebQuickOpenMode,
    webQuickOpenPreviewUrl,
    previewWebQuickOpenEntry,
    persistCommandAliases,
    addCommandAlias,
    updateCommandAlias,
    removeCommandAlias,
    resetCommandAliases,
    toggleCommandCenterPinned,
    commandCenterTargetToggleLabel,
    canToggleCommandCenterTarget,
    toggleCommandCenterTarget,
    persistAppShortcuts,
    addAppShortcut,
    updateAppShortcut,
    removeAppShortcut,
  };
}
