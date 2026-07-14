import type { SearchResult } from "./types";

export type PluginRedirectTarget = {
  query: string;
  pluginName: string;
};

export type PluginRedirectSelection =
  | { status: "ready"; result: SearchResult; candidates: SearchResult[] }
  | { status: "ambiguous" | "not_found"; candidates: SearchResult[] };

export function normalizePluginRedirectLabel(label: unknown): PluginRedirectTarget | null {
  if (typeof label === "string") {
    const query = label.trim();
    return query ? { query, pluginName: "" } : null;
  }

  if (Array.isArray(label)) {
    const pluginName = String(label[0] ?? "").trim();
    const query = String(label[1] ?? "").trim();
    return query ? { query, pluginName } : null;
  }

  return null;
}

export function selectPluginRedirectResult(
  target: PluginRedirectTarget,
  results: SearchResult[],
): PluginRedirectSelection {
  const scopedResults = target.pluginName
    ? results.filter((result) => pluginMatches(result, target.pluginName))
    : results;
  const exactMatches = scopedResults.filter((result) => featureMatchesExactly(result, target.query));
  const candidates = exactMatches.length > 0
    ? exactMatches
    : scopedResults.filter((result) => featureMatchesLoosely(result, target.query));

  if (candidates.length === 1) {
    return { status: "ready", result: candidates[0], candidates };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", candidates };
  }
  return { status: "not_found", candidates: [] };
}

function pluginMatches(result: SearchResult, pluginName: string): boolean {
  const target = normalizeComparable(pluginName);
  return normalizeComparable(result.plugin_name) === target
    || normalizeComparable(result.plugin_id) === target;
}

function featureMatchesExactly(result: SearchResult, query: string): boolean {
  const target = normalizeComparable(query);
  return [
    result.code,
    result.label,
  ].some((value) => normalizeComparable(value) === target);
}

function featureMatchesLoosely(result: SearchResult, query: string): boolean {
  const target = normalizeComparable(query);
  return [
    result.code,
    result.label,
    result.explain,
  ].some((value) => normalizeComparable(value).includes(target));
}

function normalizeComparable(value: string): string {
  return value.trim().toLowerCase();
}
