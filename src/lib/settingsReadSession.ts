import type { AToolsSettings } from "./settings";
import type { GeneralSettingsSnapshot } from "./generalSettingsStore";

export type SettingsReadRequest = symbol;
export type SettingsReadLease = { request: SettingsReadRequest; raw: string | null; settings: AToolsSettings; close(): void };

let latestRequest: SettingsReadRequest | null = null;
let active: { request: SettingsReadRequest; snapshot: GeneralSettingsSnapshot; settings: AToolsSettings } | null = null;

export function beginSettingsReadRequest(): SettingsReadRequest {
  latestRequest = Symbol("settings-read-request");
  return latestRequest;
}

/** Publish only the most recently requested read; late native replies cannot replace a newer edit. */
export function openSettingsReadLease(
  request: SettingsReadRequest,
  settings: AToolsSettings,
  snapshot: GeneralSettingsSnapshot,
): SettingsReadLease | null {
  if (request !== latestRequest) return null;
  active = { request, snapshot, settings: cloneSettings(settings) };
  return {
    request,
    raw: snapshot.raw,
    settings: cloneSettings(active.settings),
    close() {
      if (active?.request === request) active = null;
    },
  };
}

export function currentSettingsReadSnapshot(): AToolsSettings | null {
  return active ? cloneSettings(active.settings) : null;
}

export function currentSettingsReadContext(): {
  request: SettingsReadRequest;
  snapshot: GeneralSettingsSnapshot;
  settings: AToolsSettings;
} | null {
  return active
    ? { request: active.request, snapshot: active.snapshot, settings: cloneSettings(active.settings) }
    : null;
}

/** Refresh a cache only when the commit still belongs to the lease that supplied its CAS raw. */
export function refreshSettingsReadSnapshot(
  request: SettingsReadRequest,
  settings: AToolsSettings,
  snapshot: GeneralSettingsSnapshot,
): boolean {
  if (active?.request !== request) return false;
  active = { request, settings: cloneSettings(settings), snapshot };
  return true;
}

function cloneSettings(settings: AToolsSettings): AToolsSettings {
  return {
    ...settings,
    appShortcuts: settings.appShortcuts.map(shortcut => ({ ...shortcut })),
    wakeupBlacklist: [...settings.wakeupBlacklist],
    tabTarget: settings.tabTarget ? { ...settings.tabTarget } : null,
    pluginMarketTrustedPublicKeys: [...settings.pluginMarketTrustedPublicKeys],
  };
}
