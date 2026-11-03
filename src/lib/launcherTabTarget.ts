import type { SearchResult } from "./types";

/** Display snapshots never participate in target resolution. */
export type LauncherTabTarget = { pluginId: string; code: string; label: string };
export type LauncherTabResolution =
  | { status: "ready"; feature: SearchResult }
  | { status: "unconfigured" | "unavailable" | "ambiguous"; message: string };

export function tabTargetFromFeature(feature: SearchResult): LauncherTabTarget {
  return { pluginId: feature.plugin_id, code: feature.code, label: feature.label };
}
export function resolveLauncherTabTarget(target: LauncherTabTarget | null, catalog: SearchResult[]): LauncherTabResolution {
  if (!target) return { status: "unconfigured", message: "尚未设置 Tab 目标，请选择一个工具。" };
  const candidates = catalog.filter(feature => feature.code === target.code);
  const exact = candidates.filter(feature => feature.plugin_id === target.pluginId);
  if (exact.length === 0) return { status: "unavailable", message: "Tab 目标已禁用、移除或来源已变化，请重新选择工具。" };
  // The native activation store addresses a code globally. Refuse any ambiguous
  // catalog rather than letting presentation ordering decide which owner runs.
  if (candidates.length !== 1) return { status: "ambiguous", message: "Tab 目标指令存在多个来源，请重新选择没有冲突的工具。" };
  return { status: "ready", feature: exact[0] };
}
export function launcherTabIntent(target: LauncherTabTarget | null, catalog: SearchResult[], rawQuery: string) {
  const resolved = resolveLauncherTabTarget(target, catalog);
  return resolved.status === "ready"
    ? { ...resolved, code: resolved.feature.code, expectedPluginId: resolved.feature.plugin_id, payload: rawQuery }
    : resolved;
}
export function launcherTabTargetHint(target: LauncherTabTarget | null, catalog: SearchResult[]): string {
  const resolved = resolveLauncherTabTarget(target, catalog);
  if (resolved.status === "ready") return `交给 ${resolved.feature.label}`;
  return target ? "目标不可用 · 重新设置" : "设置目标";
}
