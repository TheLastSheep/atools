import { normalizePinnedCommandCodes, savePinnedCommandCodes, type PinnedCommand } from "./pinnedCommands";
import type { SearchResult } from "./types";
import { SYSTEM_ACTIONS, type RecommendedCommand } from "./uiState";

export type LauncherPinSnapshot = Pick<SearchResult, "code" | "plugin_id" | "plugin_name" | "label" | "explain" | "icon">;
export type LocalCommandResolver = (code: string) => PinnedCommand | null;
export const LAUNCHER_PIN_SNAPSHOTS_KEY = "atools:launcher-pin-snapshots:v1";
const MAX_SNAPSHOTS = 128;
const MAX_STORAGE_CHARS = 256 * 1024;

function snapshot(value: unknown): LauncherPinSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const limits = { code: 512, plugin_id: 256, plugin_name: 512, label: 512, explain: 2048 };
  for (const [key, limit] of Object.entries(limits)) {
    if (typeof item[key] !== "string" || (item[key] as string).length > limit) return null;
  }
  if (!(item.code as string).trim() || !(item.plugin_id as string).trim() || !(item.label as string).trim()) return null;
  return {
    code: item.code as string, plugin_id: item.plugin_id as string,
    plugin_name: item.plugin_name as string, label: item.label as string, explain: item.explain as string,
    icon: typeof item.icon === "string" && item.icon.length <= 8192 ? item.icon : null,
  };
}

export function loadLauncherPinSnapshots(): LauncherPinSnapshot[] {
  try {
    const text = localStorage.getItem(LAUNCHER_PIN_SNAPSHOTS_KEY);
    if (!text || text.length > MAX_STORAGE_CHARS) return [];
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value)) return [];
    return value.slice(0, MAX_SNAPSHOTS).flatMap(item => snapshot(item) ?? []);
  } catch { return []; }
}

export type LauncherPinsContext = {
  codes: string[];
  catalog: SearchResult[];
  snapshots: LauncherPinSnapshot[];
  catalogReady: boolean;
  resolveLocal: LocalCommandResolver;
};

/** Snapshots contain display metadata only; they never supply a FeatureAction. */
export function resolveLauncherPin(code: string, context: LauncherPinsContext): PinnedCommand | null {
  const local = context.resolveLocal(code);
  if (local) return local;
  const cached = context.snapshots.find(item => item.code === code);
  const live = context.catalog.find(item => item.code === code);
  if (live && (!cached || cached.plugin_id === live.plugin_id)) return live;
  if (!context.catalogReady && cached) return cached;
  return null;
}

/** Reconcile only against a settled catalog, preserving cold-start snapshots. */
export function reconcileLauncherPins(context: LauncherPinsContext): { codes: string[]; snapshots: LauncherPinSnapshot[] } {
  const codes: string[] = [], snapshots: LauncherPinSnapshot[] = [];
  for (const code of normalizePinnedCommandCodes(context.codes)) {
    const local = context.resolveLocal(code);
    const resolved = resolveLauncherPin(code, context);
    if (!resolved && context.catalogReady) continue;
    codes.push(code);
    if (local || snapshots.length >= MAX_SNAPSHOTS) continue;
    const metadata = snapshot(resolved);
    if (metadata) snapshots.push(metadata);
  }
  return { codes, snapshots };
}

export function persistLauncherPins(value: { codes: string[]; snapshots: LauncherPinSnapshot[] }): void {
  savePinnedCommandCodes(value.codes);
  try {
    const text = JSON.stringify(value.snapshots);
    if (text.length <= MAX_STORAGE_CHARS) localStorage.setItem(LAUNCHER_PIN_SNAPSHOTS_KEY, text);
  } catch { /* Restricted storage must not prevent using the launcher. */ }
}

export function pinnedLauncherCommands(context: LauncherPinsContext): RecommendedCommand[] {
  return context.codes.flatMap(code => {
    const command = resolveLauncherPin(code, context);
    if (!command) return [];
    return [{ code, label: command.label, explain: command.explain,
      plugin_id: "plugin_id" in command ? command.plugin_id : undefined,
      icon: "icon" in command ? command.icon as string | null : null,
      panel: SYSTEM_ACTIONS.find(action => `system:${action.id}` === code)?.id }];
  });
}
