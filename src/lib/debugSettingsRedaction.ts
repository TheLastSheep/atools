import { DEFAULT_ATOOLS_SETTINGS, type AToolsSettings } from "./settings";

export function redactedSettings(settings: Partial<AToolsSettings>): Record<string, unknown> {
  return {
    hotkey: settings.hotkey || "",
    launchAtLogin: settings.launchAtLogin ?? false,
    showTrayIcon: settings.showTrayIcon ?? DEFAULT_ATOOLS_SETTINGS.showTrayIcon,
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
