import { invalidRendererResponse, ZToolsRendererHostError } from "./errors";
import { GENERAL_RENDERER_EVENT_FIELDS } from "./generalPreferenceSchema";
import { projectBuiltinAppShortcuts } from "./builtinAppShortcuts";
import type { ZToolsRendererApp, ZToolsRendererPlugin } from "./types";

const MAX_APPS = 1024;
const MAX_PLUGINS = 1024;
const MAX_FEATURES = 256;
const MAX_STRING = 16_384;

const SAFE_SETTINGS_KEYS = new Set([
  "tabTarget",
  "hotkey",
  "appShortcuts",
  "launchAtLogin",
  "showTrayIcon",
  "wakeupBlacklist",
  "opacity",
  "windowMaterial",
  "localLaunchSearch",
  "autoBackToSearch",
  "pluginEscapeToSearch",
  "windowDefaultHeight",
  "windowPositionStrategy",
  "clipboardRetentionDays",
  "superPanelEnabled",
  "floatingBallEnabled",
  "devToolsMode",
  ...GENERAL_RENDERER_EVENT_FIELDS,
]);

export function asRecord(value: unknown, route: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidResponse(route);
  }
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, route: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > MAX_STRING) {
    throw invalidResponse(route);
  }
  return value;
}

function invalidResponse(route: string): ZToolsRendererHostError {
  return invalidRendererResponse(`Invalid response: ${route}`);
}

export function mapLauncherApps(value: unknown): ZToolsRendererApp[] {
  if (!Array.isArray(value) || value.length > MAX_APPS) {
    throw invalidResponse("list_launcher_apps");
  }
  return value.map((item) => {
    const record = asRecord(item, "list_launcher_apps");
    const app: ZToolsRendererApp = {
      name: boundedString(record.name, "list_launcher_apps"),
      path: boundedString(record.path, "list_launcher_apps"),
    };
    if (typeof record.icon === "string" && record.icon.length <= MAX_STRING) {
      app.icon = record.icon;
    }
    return app;
  });
}

export function mapPluginInventory(value: unknown): ZToolsRendererPlugin[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS) {
    throw invalidResponse("list_plugins");
  }
  return value.map((item) => {
    const record = asRecord(item, "list_plugins");
    const manifest = asRecord(record.manifest, "list_plugins.manifest");
    if (!Array.isArray(manifest.features)) throw invalidResponse("list_plugins.features");
    const features = manifest.features;
    if (features.length > MAX_FEATURES) throw invalidResponse("list_plugins.features");

    const plugin: ZToolsRendererPlugin = {
      id: boundedString(record.id, "list_plugins"),
      name: boundedString(record.name, "list_plugins"),
      version: boundedString(record.version, "list_plugins", true),
      path: boundedString(record.path, "list_plugins"),
      enabled: record.enabled === true,
      features: features.map((feature) => cloneJson(asRecord(feature, "list_plugins.features"))),
      sourceKind: sourceKind(record.source_kind),
    };
    if (typeof manifest.title === "string") plugin.title = manifest.title;
    if (typeof manifest.logo === "string") plugin.logo = manifest.logo;
    if (typeof manifest.description === "string") plugin.description = manifest.description;
    if (typeof manifest.main === "string") plugin.main = manifest.main;
    return plugin;
  });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sourceKind(value: unknown): ZToolsRendererPlugin["sourceKind"] {
  if (value === "builtin" || value === "imported" || value === "external") return value;
  throw invalidResponse("list_plugins.source_kind");
}

export function parseSettingsJson(value: unknown): Record<string, unknown> | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 64 * 1024) {
    throw invalidResponse("get_setting");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw invalidResponse("get_setting");
  }
  const settings = asRecord(parsed, "get_setting");
  if (Object.hasOwn(settings, "autoCheckUpdate") && typeof settings.autoCheckUpdate !== "boolean") throw invalidResponse("get_setting");
  return {
    ...Object.fromEntries(Object.entries(settings).filter(([key]) => SAFE_SETTINGS_KEYS.has(key))),
    builtinAppShortcutsEnabled: projectBuiltinAppShortcuts(settings.builtinAppShortcutsEnabled),
  };
}

export function parseNamespacedValue(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value !== "string" || value.length > 128 * 1024) {
    throw invalidResponse("get_setting");
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw invalidResponse("get_setting");
  }
}
