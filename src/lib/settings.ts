import { invoke } from "@tauri-apps/api/core";

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

export const SETTINGS_KEY = "settings-general";
export const SETTINGS_STORAGE_KEY = "atools:settings-general";

export type SettingsPersist = (
  next: AToolsSettings,
  previous: AToolsSettings,
) => Promise<void>;

export class SettingsSaveCoordinator {
  private savedSettings: AToolsSettings;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    initialSettings: AToolsSettings,
    private readonly persist: SettingsPersist,
  ) {
    this.savedSettings = initialSettings;
  }

  enqueue(next: AToolsSettings): Promise<void> {
    const operation = this.queue.then(async () => {
      const previous = this.savedSettings;
      await this.persist(next, previous);
      this.savedSettings = next;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  lastSaved(): AToolsSettings {
    return this.savedSettings;
  }

  hydrate(settings: AToolsSettings): void {
    this.savedSettings = settings;
  }
}

export type DebouncedSettingsEnqueue = (
  settings: AToolsSettings,
  revision: number,
) => Promise<void>;

export class SettingsSaveDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: { settings: AToolsSettings; revision: number } | null = null;

  constructor(
    private readonly enqueue: DebouncedSettingsEnqueue,
    private readonly delayMs = 160,
  ) {}

  schedule(settings: AToolsSettings, revision: number): void {
    this.pending = { settings, revision };
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.delayMs);
  }

  discard(): void {
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  flush(): Promise<void> {
    const pending = this.pending;
    this.pending = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!pending) return Promise.resolve();

    try {
      return this.enqueue(pending.settings, pending.revision).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }
}

export const DEFAULT_ATOOLS_SETTINGS: AToolsSettings = {
  hotkey: "Option+Z",
  appShortcuts: [],
  launchAtLogin: false,
  showTrayIcon: false,
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
  const stored = await readStoredSettings();
  const settings = normalizeSettings(stored);
  applyAToolsAppearance(settings);
  return settings;
}

export function loadAToolsSettingsSync(): AToolsSettings {
  try {
    const value = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const settings = normalizeSettings(value ? JSON.parse(value) as Partial<AToolsSettings> : null);
    applyAToolsAppearance(settings);
    return settings;
  } catch {
    return { ...DEFAULT_ATOOLS_SETTINGS };
  }
}

export async function saveAToolsSettings(settings: AToolsSettings): Promise<void> {
  const normalized = normalizeSettings(settings);
  const serialized = JSON.stringify(normalized);

  if (hasTauriRuntime()) {
    await invoke("set_setting", { key: SETTINGS_KEY, value: serialized });
  }

  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serialized);
  } catch {
    // Local fallback can be unavailable in restricted contexts.
  }
}

export function applyAToolsAppearance(settings: AToolsSettings) {
  const root = document.documentElement;
  root.dataset.atoolsTheme = settings.theme;
  const accent = settings.primaryColor === "custom" ? settings.customColor : COLOR_HEX[settings.primaryColor];
  root.style.setProperty("--accent", accent);
  root.style.setProperty("--accent-hover", accent);
  root.style.setProperty("--accent-subtle", colorToRgba(accent, 0.14));
  root.style.setProperty("--atools-window-opacity", String(settings.opacity));
}

export function dispatchAToolsSettings(settings: AToolsSettings) {
  window.dispatchEvent(new CustomEvent<AToolsSettings>("atools-settings-updated", { detail: settings }));
}

export async function applyNativeSettings(
  settings: AToolsSettings,
  previous?: AToolsSettings,
): Promise<void> {
  if (!hasTauriRuntime()) return;
  const invocations = [
    {
      method: "update_global_hotkey",
      args: previous
        ? { shortcut: settings.hotkey, previousShortcut: previous.hotkey }
        : { shortcut: settings.hotkey },
    },
    { method: "set_tray_icon_visible", args: { visible: settings.showTrayIcon } },
    { method: "set_launch_at_login", args: { enabled: settings.launchAtLogin } },
    { method: "set_super_panel_visible", args: { visible: settings.superPanelEnabled } },
    { method: "set_floating_ball_visible", args: { visible: settings.floatingBallEnabled } },
  ];
  const results = await Promise.allSettled(
    invocations.map((invocation) => invoke(invocation.method, invocation.args)),
  );
  const failures = results
    .map((result, index) => {
      if (result.status === "rejected") {
        return { method: invocations[index].method, reason: formatInvokeError(result.reason) };
      }
      return null;
    })
    .filter((value): value is { method: string; reason: string } => value !== null);

  if (failures.length > 0) {
    const failedText = failures.map((failure) => `${failure.method}: ${failure.reason}`).join("; ");
    const failedCount = failures.length;
    const successCount = results.length - failedCount;
    let rollbackText = "";
    if (previous && successCount > 0) {
      const previousInvocations = [
        {
          method: "update_global_hotkey",
          args: { shortcut: previous.hotkey, previousShortcut: settings.hotkey },
        },
        { method: "set_tray_icon_visible", args: { visible: previous.showTrayIcon } },
        { method: "set_launch_at_login", args: { enabled: previous.launchAtLogin } },
        { method: "set_super_panel_visible", args: { visible: previous.superPanelEnabled } },
        { method: "set_floating_ball_visible", args: { visible: previous.floatingBallEnabled } },
      ].filter((_, index) => results[index].status === "fulfilled");
      const rollbackResults = await Promise.allSettled(
        previousInvocations.map((invocation) => invoke(invocation.method, invocation.args)),
      );
      const rollbackFailures = rollbackResults
        .map((result, index) => result.status === "rejected"
          ? { method: previousInvocations[index].method, reason: formatInvokeError(result.reason) }
          : null)
        .filter((value): value is { method: string; reason: string } => value !== null);
      const rollbackSuccessCount = rollbackResults.length - rollbackFailures.length;
      rollbackText = `；回滚成功 ${rollbackSuccessCount}/${rollbackResults.length} 项`;
      if (rollbackFailures.length > 0) {
        rollbackText += `，回滚失败 ${rollbackFailures.length} 项: ${rollbackFailures
          .map((failure) => `${failure.method}: ${failure.reason}`)
          .join("; ")}`;
      }
    }
    throw new Error(`系统设置保存失败，成功 ${successCount}/${results.length} 项，失败 ${failedCount} 项: ${failedText}${rollbackText}`);
  }
}

export async function applyAndSaveAToolsSettings(
  next: AToolsSettings,
  previous: AToolsSettings,
): Promise<void> {
  await applyNativeSettings(next, previous);
  try {
    await saveAToolsSettings(next);
  } catch (error) {
    const persistenceReason = formatInvokeError(error);
    try {
      await applyNativeSettings(previous, next);
    } catch (rollbackError) {
      throw new Error(
        `设置持久化失败: ${persistenceReason}；原生设置回滚失败: ${formatInvokeError(rollbackError)}`,
      );
    }
    throw new Error(`设置持久化失败: ${persistenceReason}；原生设置已回滚到上次保存值`);
  }
}

function formatInvokeError(reason: unknown) {
  if (reason instanceof Error) return reason.message || "Unknown error";
  if (typeof reason === "string") return reason;
  if (reason == null) return "Unknown error";
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

async function readStoredSettings(): Promise<Partial<AToolsSettings> | null> {
  if (hasTauriRuntime()) {
    try {
      const value = await invoke<string | null>("get_setting", { key: SETTINGS_KEY });
      if (value) return JSON.parse(value) as Partial<AToolsSettings>;
    } catch {
      // Fall through to local preview storage.
    }
  }

  try {
    const value = localStorage.getItem(SETTINGS_STORAGE_KEY);
    return value ? JSON.parse(value) as Partial<AToolsSettings> : null;
  } catch {
    return null;
  }
}

function hasTauriRuntime() {
  const runtime = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof runtime?.invoke === "function";
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
