import { invoke } from "@tauri-apps/api/core";
import type { AToolsSettings } from "./settings";

export const SETTINGS_KEY = "settings-general";
export const SETTINGS_STORAGE_KEY = "atools:settings-general";

export function hasSettingsRuntime(): boolean {
  const runtime = (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__;
  return typeof runtime?.invoke === "function";
}

/** Existing launcher reads stay tolerant: a failed native read may use the local preview cache. */
export async function readStoredSettings(): Promise<unknown | null> {
  if (hasSettingsRuntime()) {
    try {
      const value = await invoke<string | null>("get_setting", { key: SETTINGS_KEY });
      if (value) return JSON.parse(value) as Partial<AToolsSettings>;
    } catch {
      // Preserve the legacy local fallback for ordinary launcher reads.
    }
  }
  try {
    return readLocalStoredSettings();
  } catch {
    return null;
  }
}

/** The settings editor must not replace an unreadable native record with stale local data. */
export async function readNativeSettingsStrict(): Promise<Record<string, unknown> | null> {
  const value = await invoke<unknown>("get_setting", { key: SETTINGS_KEY });
  if (value === null) return null;
  if (typeof value !== "string") throw new TypeError("Native settings value is not JSON text");

  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Native settings value is not a record");
  }
  return parsed as Record<string, unknown>;
}

export function readLocalStoredSettings(): unknown | null {
  const value = localStorage.getItem(SETTINGS_STORAGE_KEY);
  return value ? JSON.parse(value) as Partial<AToolsSettings> : null;
}

/** Refreshes only the legacy preview cache after an authoritative save succeeds. */
export function writeLocalStoredSettings(serialized: string): boolean {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}
