import { accentForegroundForAccent } from "./accentContrast";
import type { LauncherTabTarget } from "./launcherTabTarget";
import { hasSettingsRuntime, readLocalStoredSettings, readStoredSettings, writeLocalStoredSettings } from "./settingsStorage";
import { currentSettingsReadContext, currentSettingsReadSnapshot, refreshSettingsReadSnapshot } from "./settingsReadSession";
import {
  generalSettingsSnapshotFromRaw,
  cloneGeneralSettingsChanges,
  readGeneralSettingsSnapshot,
  saveGeneralSettings,
} from "./generalSettingsStore";
import { applySettingsTransaction, createSettingsWriter } from "./settingsNativeTransaction";
export { SETTINGS_KEY, SETTINGS_STORAGE_KEY } from "./settingsStorage";
export type PrimaryColor = "blue" | "purple" | "green" | "orange" | "red" | "pink" | "custom";
export type AiProvider = "disabled" | "openai" | "compatible" | "local";
export type DevToolsMode = "detach" | "right" | "bottom" | "undocked";
export type WindowPositionStrategy = "remember" | "cursor" | "primary" | "lastActive";

export type AppShortcutSetting = {
  id: string;
  shortcut: string;
  targetCode: string;
  enabled: boolean;
};

export type AToolsSettings = {
  hotkey: string;
  appShortcuts: AppShortcutSetting[];
  launchAtLogin: boolean;
  showTrayIcon: boolean;
  wakeupBlacklist: string[];
  theme: string;
  primaryColor: PrimaryColor;
  customColor: string;
  opacity: number;
  windowMaterial: string;
  placeholder: string;
  searchMode: string;
  showRecentInSearch: boolean;
  showMatchRecommendation: boolean;
  localAppSearch: boolean;
  localLaunchSearch: boolean;
  spaceOpenCommand: boolean;
  recentRows: number;
  pinnedRows: number;
  tabKeyFunction: string;
  tabTarget: LauncherTabTarget | null;
  autoPaste: string;
  autoClear: string;
  autoBackToSearch: string;
  pluginEscapeToSearch: boolean;
  windowDefaultHeight: number;
  windowPositionStrategy: WindowPositionStrategy;
  clipboardRetentionDays: number;
  superPanelEnabled: boolean;
  floatingBallEnabled: boolean;
  proxyEnabled: boolean;
  proxyUrl: string;
  pluginMarketCustom: boolean;
  pluginMarketUrl: string;
  pluginMarketTrustedPublicKeys: string[];
  devToolsMode: DevToolsMode;
  disableGpuAcceleration: boolean;
  aiProvider: AiProvider;
  aiBaseUrl: string;
  aiDefaultModel: string;
  aiApiKey: string;
  aiTemperature: number;
  aiUseForAgent: boolean;
  webdavEnabled: boolean;
  webdavUrl: string;
  webdavUsername: string;
  webdavPassword: string;
  webdavRemotePath: string;
  webdavSyncSettings: boolean;
  webdavSyncPlugins: boolean;
  webdavSyncClipboard: boolean;
};
export { SettingsSaveCoordinator, SettingsSaveDebouncer, type SettingsPersist, type DebouncedSettingsEnqueue } from "./settingsSaveCoordinator";
export const DEFAULT_ATOOLS_SETTINGS: AToolsSettings = {
  hotkey: "Option+Z",
  appShortcuts: [],
  launchAtLogin: false,
  showTrayIcon: true,
  wakeupBlacklist: [],
  theme: "system",
  primaryColor: "purple",
  customColor: "#db2777",
  opacity: 1,
  windowMaterial: "none",
  placeholder: "搜索应用和指令 / 粘贴文件或图片",
  searchMode: "aggregate",
  showRecentInSearch: true,
  showMatchRecommendation: true,
  localAppSearch: true,
  localLaunchSearch: true,
  spaceOpenCommand: false,
  recentRows: 2,
  pinnedRows: 1,
  tabKeyFunction: "navigate",
  tabTarget: null,
  autoPaste: "3s",
  autoClear: "immediately",
  autoBackToSearch: "never",
  pluginEscapeToSearch: true,
  windowDefaultHeight: 541,
  windowPositionStrategy: "remember",
  clipboardRetentionDays: 180,
  superPanelEnabled: false,
  floatingBallEnabled: false,
  proxyEnabled: false,
  proxyUrl: "",
  pluginMarketCustom: false,
  pluginMarketUrl: "",
  pluginMarketTrustedPublicKeys: [],
  devToolsMode: "detach",
  disableGpuAcceleration: false,
  aiProvider: "disabled",
  aiBaseUrl: "",
  aiDefaultModel: "",
  aiApiKey: "",
  aiTemperature: 0.2,
  aiUseForAgent: false,
  webdavEnabled: false,
  webdavUrl: "",
  webdavUsername: "",
  webdavPassword: "",
  webdavRemotePath: "/ATools",
  webdavSyncSettings: true,
  webdavSyncPlugins: true,
  webdavSyncClipboard: false,
};
const COLOR_HEX: Record<PrimaryColor, string> = {
  blue: "#0284c7",
  purple: "#7c3aed",
  green: "#059669",
  orange: "#ea580c",
  red: "#dc2626",
  pink: "#db2777",
  custom: DEFAULT_ATOOLS_SETTINGS.customColor,
};

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512
    && value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}
export function normalizeLauncherTabTarget(value: unknown): LauncherTabTarget | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LauncherTabTarget>;
  if (!validIdentity(raw.pluginId) || !validIdentity(raw.code)) return null;
  return { pluginId: raw.pluginId, code: raw.code,
    label: typeof raw.label === "string" ? raw.label.slice(0, 256) : raw.code };
}

export function normalizeSettings(value: Partial<AToolsSettings> | null | undefined): AToolsSettings {
  const raw = value ?? {};
  const aiProvider = aiProviderValue(raw.aiProvider);
  const webdavUrl = webdavUrlValue(raw.webdavUrl);
  const webdavUsername = trimmedStringValue(raw.webdavUsername, "");
  const webdavConfigured = Boolean(webdavUrl && webdavUsername);
  const webdavEnabled = webdavConfigured && raw.webdavEnabled === true;
  const proxyUrl = proxyUrlValue(raw.proxyUrl);
  const proxyEnabled = Boolean(proxyUrl) && raw.proxyEnabled === true;
  const pluginMarketUrl = pluginMarketUrlValue(raw.pluginMarketUrl);
  const pluginMarketCustom = Boolean(pluginMarketUrl) && raw.pluginMarketCustom === true;
  return {
    ...DEFAULT_ATOOLS_SETTINGS,
    ...raw,
    showTrayIcon: raw.showTrayIcon !== false,
    tabTarget: normalizeLauncherTabTarget(raw.tabTarget),
    hotkey: stringValue(raw.hotkey, DEFAULT_ATOOLS_SETTINGS.hotkey),
    appShortcuts: normalizeAppShortcutSettings(raw.appShortcuts),
    wakeupBlacklist: Array.isArray(raw.wakeupBlacklist)
      ? raw.wakeupBlacklist.filter((item): item is string => typeof item === "string")
      : [],
    primaryColor: primaryColorValue(raw.primaryColor),
    customColor: stringValue(raw.customColor, DEFAULT_ATOOLS_SETTINGS.customColor),
    opacity: numberValue(raw.opacity, DEFAULT_ATOOLS_SETTINGS.opacity, 0.3, 1),
    windowMaterial: DEFAULT_ATOOLS_SETTINGS.windowMaterial,
    recentRows: numberValue(raw.recentRows, DEFAULT_ATOOLS_SETTINGS.recentRows, 1, 4),
    pinnedRows: numberValue(raw.pinnedRows, DEFAULT_ATOOLS_SETTINGS.pinnedRows, 1, 4),
    windowDefaultHeight: numberValue(raw.windowDefaultHeight, DEFAULT_ATOOLS_SETTINGS.windowDefaultHeight, 200, 1200),
    windowPositionStrategy: windowPositionStrategyValue(raw.windowPositionStrategy),
    pluginEscapeToSearch: raw.pluginEscapeToSearch !== false,
    clipboardRetentionDays: numberValue(raw.clipboardRetentionDays, DEFAULT_ATOOLS_SETTINGS.clipboardRetentionDays, 1, 3650),
    superPanelEnabled: raw.superPanelEnabled === true,
    floatingBallEnabled: raw.floatingBallEnabled === true,
    proxyEnabled,
    proxyUrl,
    pluginMarketCustom,
    pluginMarketUrl,
    pluginMarketTrustedPublicKeys: pluginMarketTrustedPublicKeysValue(raw.pluginMarketTrustedPublicKeys),
    devToolsMode: devToolsModeValue(raw.devToolsMode),
    disableGpuAcceleration: false,
    aiProvider,
    aiBaseUrl: trimmedStringValue(raw.aiBaseUrl, ""),
    aiDefaultModel: trimmedStringValue(raw.aiDefaultModel, ""),
    aiApiKey: trimmedStringValue(raw.aiApiKey, ""),
    aiTemperature: numberValueOrFallback(raw.aiTemperature, DEFAULT_ATOOLS_SETTINGS.aiTemperature, 0, 2),
    aiUseForAgent: aiProvider !== "disabled" && raw.aiUseForAgent === true,
    webdavEnabled,
    webdavUrl,
    webdavUsername,
    webdavPassword: trimmedStringValue(raw.webdavPassword, ""),
    webdavRemotePath: webdavConfigured
      ? webdavRemotePathValue(raw.webdavRemotePath)
      : DEFAULT_ATOOLS_SETTINGS.webdavRemotePath,
    webdavSyncSettings: webdavConfigured
      ? raw.webdavSyncSettings !== false
      : DEFAULT_ATOOLS_SETTINGS.webdavSyncSettings,
    webdavSyncPlugins: webdavConfigured
      ? raw.webdavSyncPlugins !== false
      : DEFAULT_ATOOLS_SETTINGS.webdavSyncPlugins,
    webdavSyncClipboard: webdavConfigured
      ? raw.webdavSyncClipboard === true
      : DEFAULT_ATOOLS_SETTINGS.webdavSyncClipboard,
  };
}

export async function loadAToolsSettings(): Promise<AToolsSettings> {
  const active = currentSettingsReadSnapshot();
  if (active) {
    applyAToolsAppearance(active);
    return active;
  }

  const stored = await readStoredSettings();
  const settings = currentSettingsReadSnapshot() ?? normalizeSettings(stored as Partial<AToolsSettings> | null);
  applyAToolsAppearance(settings);
  return settings;
}

export function loadAToolsSettingsSync(): AToolsSettings {
  const active = currentSettingsReadSnapshot();
  if (active) {
    applyAToolsAppearance(active);
    return active;
  }

  try {
    const value = readLocalStoredSettings();
    const settings = normalizeSettings(value as Partial<AToolsSettings> | null);
    applyAToolsAppearance(settings);
    return settings;
  } catch {
    return { ...DEFAULT_ATOOLS_SETTINGS };
  }
}

export async function saveAToolsSettings(settings: AToolsSettings): Promise<void> {
  const normalized = normalizeSettings(cloneGeneralSettingsChanges(settings) as Partial<AToolsSettings>);
  const lease = currentSettingsReadContext();
  const snapshot = lease?.snapshot ?? await readGeneralSettingsSnapshot();
  const receipt = await saveGeneralSettings(snapshot, normalized, { applyNative: false });
  if (lease) {
    const committed = generalSettingsSnapshotFromRaw(receipt.raw);
    const normalizedCommitted = normalizeSettings(committed.value as Partial<AToolsSettings>);
    if (refreshSettingsReadSnapshot(lease.request, normalizedCommitted, committed)) {
      if (hasSettingsRuntime()) writeLocalStoredSettings(receipt.raw);
    }
  } else if (hasSettingsRuntime() && !currentSettingsReadContext()) {
    writeLocalStoredSettings(receipt.raw);
  }
}

export function applyAToolsAppearance(settings: AToolsSettings) {
  const root = document.documentElement;
  root.dataset.atoolsTheme = settings.theme;
  const accent = settings.primaryColor === "custom" ? settings.customColor : COLOR_HEX[settings.primaryColor];
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-foreground", accentForegroundForAccent(accent));
  root.style.setProperty("--accent-hover", accent);
  root.style.setProperty("--accent-subtle", colorToRgba(accent, 0.14));
  root.style.setProperty("--atools-window-opacity", String(settings.opacity));
}

export function dispatchAToolsSettings(settings: AToolsSettings) {
  window.dispatchEvent(new CustomEvent<AToolsSettings>("atools-settings-updated", { detail: settings }));
}

export async function applyAndSaveAToolsSettings(
  next: AToolsSettings,
  previous: AToolsSettings,
): Promise<void> {
  await applySettingsTransaction(next, previous, saveAToolsSettings, normalizeSettings);
}

/** Creates one serialized editor writer bound to the current settings read lease. */
export function createAToolsSettingsWriter() {
  return createSettingsWriter(normalizeSettings);
}

function stringValue(value: unknown, fallback: string) {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function normalizeAppShortcutSettings(value: unknown): AppShortcutSetting[] {
  if (!Array.isArray(value)) return [];
  const normalized: AppShortcutSetting[] = [];
  let generatedIdCount = 0;
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const raw = item as Partial<AppShortcutSetting>;
    const shortcut = typeof raw.shortcut === "string" ? raw.shortcut.trim() : "";
    const targetCode = typeof raw.targetCode === "string" ? raw.targetCode.trim() : "";
    if (!shortcut || !targetCode) continue;
    const rawId = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!rawId) generatedIdCount += 1;
    normalized.push({
      id: rawId || `app-shortcut-${generatedIdCount}`,
      shortcut,
      targetCode,
      enabled: raw.enabled !== false,
    });
  }
  return normalized;
}

function numberValue(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function numberValueOrFallback(value: unknown, fallback: number, min: number, max: number) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return fallback;
  return number;
}

function primaryColorValue(value: unknown): PrimaryColor {
  return ["blue", "purple", "green", "orange", "red", "pink", "custom"].includes(String(value))
    ? value as PrimaryColor
    : DEFAULT_ATOOLS_SETTINGS.primaryColor;
}

function windowPositionStrategyValue(value: unknown): WindowPositionStrategy {
  return ["remember", "cursor", "primary", "lastActive"].includes(String(value))
    ? value as WindowPositionStrategy
    : DEFAULT_ATOOLS_SETTINGS.windowPositionStrategy;
}

function devToolsModeValue(value: unknown): DevToolsMode {
  return ["detach", "right", "bottom", "undocked"].includes(String(value))
    ? value as DevToolsMode
    : DEFAULT_ATOOLS_SETTINGS.devToolsMode;
}

function aiProviderValue(value: unknown): AiProvider {
  return ["disabled", "openai", "compatible", "local"].includes(String(value))
    ? value as AiProvider
    : DEFAULT_ATOOLS_SETTINGS.aiProvider;
}

function webdavUrlValue(value: unknown) {
  const trimmed = trimmedStringValue(value, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : "";
  } catch {
    return "";
  }
}

function proxyUrlValue(value: unknown) {
  const trimmed = trimmedStringValue(value, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : "";
  } catch {
    return "";
  }
}

function pluginMarketUrlValue(value: unknown) {
  const trimmed = trimmedStringValue(value, "");
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:" ? trimmed : "";
  } catch {
    return "";
  }
}

function pluginMarketTrustedPublicKeysValue(value: unknown) {
  if (!Array.isArray(value)) return [];
  const keys = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^[A-Za-z0-9+/]{43}=$/.test(item));
  return [...new Set(keys)];
}

function webdavRemotePathValue(value: unknown) {
  const trimmed = trimmedStringValue(value, "");
  if (!trimmed) return DEFAULT_ATOOLS_SETTINGS.webdavRemotePath;
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function trimmedStringValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value.trim() : fallback;
}

function colorToRgba(hex: string, alpha: number) {
  const normalized = hex.replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return `rgba(124, 58, 237, ${alpha})`;
  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}
