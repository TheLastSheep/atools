import type { SearchResult } from "./types";
import {
  buildPreparedSearchTrigramSet,
  canSkipPreparedSearch,
  insertBoundedSearchResult,
  MAX_SEARCH_MATCH_SCORE,
  normalizeSearchText,
  prepareSearchMatchCandidate,
  searchMatchForPreparedQuery,
  type PreparedSearchMatchCandidate,
} from "./searchMatch";

export type CommandAliasEntry = {
  id: string;
  alias: string;
  targetCode: string;
  enabled: boolean;
};

export type CommandAliasTarget = {
  code: string;
  label: string;
  explain: string;
  plugin_id: string;
  plugin_name: string;
};

export type CommandAliasPayload = {
  alias: string;
  targetCode: string;
};

export const COMMAND_ALIASES_STORAGE_KEY = "atools:command-aliases";
export const COMMAND_ALIASES_UPDATED_EVENT = "atools-command-aliases-updated";

const ALIAS_CODE_PREFIX = "alias:";
const SUPPORTED_TARGET_PREFIXES = ["system:", "local:", "web:", "url:"];
const ALIAS_SEARCH_RESULT_LIMIT = 100;
const normalizedAliasCache = new WeakMap<CommandAliasEntry[], {
  entries: CommandAliasEntry[];
  byAlias: Map<string, CommandAliasEntry>;
}>();
const preparedAliasCandidateCache = new WeakMap<CommandAliasEntry, {
  target: CommandAliasTarget;
  candidate: PreparedSearchMatchCandidate;
}>();
const aliasTrigramCache = new WeakMap<CommandAliasEntry[], {
  resolveTarget: (code: string) => CommandAliasTarget | null;
  trigrams: Set<string>;
}>();

export function loadCommandAliases(): CommandAliasEntry[] {
  try {
    const value = localStorage.getItem(COMMAND_ALIASES_STORAGE_KEY);
    return normalizeCommandAliases(value ? JSON.parse(value) : []);
  } catch {
    return [];
  }
}

export function saveCommandAliases(entries: CommandAliasEntry[]) {
  try {
    localStorage.setItem(COMMAND_ALIASES_STORAGE_KEY, JSON.stringify(normalizeCommandAliases(entries)));
  } catch {
    // Alias configuration is optional in restricted preview contexts.
  }
}

export function dispatchCommandAliasesUpdated(entries: CommandAliasEntry[]) {
  if (typeof window === "undefined") return;
  const detail = normalizeCommandAliases(entries);
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent<CommandAliasEntry[]>(COMMAND_ALIASES_UPDATED_EVENT, { detail }));
    return;
  }
  window.dispatchEvent({ type: COMMAND_ALIASES_UPDATED_EVENT, detail } as unknown as Event);
}

export function normalizeCommandAliases(value: unknown): CommandAliasEntry[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value
    .map((item) => normalizeCommandAlias(item))
    .filter((entry): entry is CommandAliasEntry => {
      if (!entry) return false;
      const key = entry.alias.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function createCommandAlias(targetCode = "system:settings"): CommandAliasEntry {
  return {
    id: `alias-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    alias: "alias",
    targetCode,
    enabled: true,
  };
}

export function commandAliasResultsForQuery(
  value: string,
  aliases: CommandAliasEntry[],
  resolveTarget: (code: string) => CommandAliasTarget | null,
): SearchResult[] {
  const query = normalizeSearchText(value);
  if (!query) return [];
  const results: SearchResult[] = [];
  const normalized = normalizedAliasesForSearch(aliases);
  const exactAlias = normalized.byAlias.get(query);
  if (exactAlias) {
    const target = resolveTarget(exactAlias.targetCode);
    if (target) return [aliasResult(exactAlias, target, "exact", 114)];
  }
  const trigrams = aliasTrigramsForSearch(aliases, normalized.entries, resolveTarget);
  if (canSkipPreparedSearch(query, trigrams)) return results;
  for (let index = 0; index < normalized.entries.length; index += 1) {
    const entry = normalized.entries[index];
    if (!entry.enabled) continue;
    if (
      results.length === ALIAS_SEARCH_RESULT_LIMIT
      && MAX_SEARCH_MATCH_SCORE + 2 - index <= results[results.length - 1].score
    ) break;
    const target = resolveTarget(entry.targetCode);
    if (!target) continue;
    const candidate = preparedAliasCandidate(entry, target);
    const match = searchMatchForPreparedQuery(query, candidate);
    if (!match) continue;
    insertBoundedSearchResult(
      results,
      aliasResult(entry, target, match.type, match.score - index),
      ALIAS_SEARCH_RESULT_LIMIT,
    );
  }
  return results;
}

function aliasTrigramsForSearch(
  aliases: CommandAliasEntry[],
  normalizedAliases: CommandAliasEntry[],
  resolveTarget: (code: string) => CommandAliasTarget | null,
) {
  const cached = aliasTrigramCache.get(aliases);
  if (cached?.resolveTarget === resolveTarget) return cached.trigrams;
  const candidates = normalizedAliases
    .filter((entry) => entry.enabled)
    .flatMap((entry) => {
      const target = resolveTarget(entry.targetCode);
      return target ? [preparedAliasCandidate(entry, target)] : [];
    });
  const trigrams = buildPreparedSearchTrigramSet(candidates);
  aliasTrigramCache.set(aliases, { resolveTarget, trigrams });
  return trigrams;
}

function normalizedAliasesForSearch(aliases: CommandAliasEntry[]) {
  const cached = normalizedAliasCache.get(aliases);
  if (cached) return cached;
  const entries = normalizeCommandAliases(aliases);
  const normalized = {
    entries,
    byAlias: new Map(entries.filter((entry) => entry.enabled).map((entry) => [entry.alias, entry])),
  };
  normalizedAliasCache.set(aliases, normalized);
  return normalized;
}

function preparedAliasCandidate(entry: CommandAliasEntry, target: CommandAliasTarget) {
  const cached = preparedAliasCandidateCache.get(entry);
  if (cached?.target === target) return cached.candidate;
  const candidate = prepareSearchMatchCandidate({
    text: target.label,
    extraText: target.explain,
    aliases: [entry.alias],
  });
  preparedAliasCandidateCache.set(entry, { target, candidate });
  return candidate;
}

export function commandAliasPayloadFromCode(code: string): CommandAliasPayload | null {
  if (!code.startsWith(ALIAS_CODE_PREFIX)) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(code.slice(ALIAS_CODE_PREFIX.length))) as CommandAliasPayload;
    if (!payload || typeof payload.alias !== "string" || typeof payload.targetCode !== "string") return null;
    if (!isSupportedTarget(payload.targetCode)) return null;
    return {
      alias: payload.alias.trim(),
      targetCode: payload.targetCode.trim(),
    };
  } catch {
    return null;
  }
}

function normalizeCommandAlias(value: unknown): CommandAliasEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CommandAliasEntry>;
  const alias = normalizeAlias(raw.alias);
  const targetCode = stringValue(raw.targetCode);
  if (!alias || !isSupportedTarget(targetCode)) return null;
  return {
    id: stringValue(raw.id) || `alias-${alias}`,
    alias,
    targetCode,
    enabled: raw.enabled !== false,
  };
}

function aliasResult(
  entry: CommandAliasEntry,
  target: CommandAliasTarget,
  matchType: string,
  score: number,
): SearchResult {
  const payload: CommandAliasPayload = {
    alias: entry.alias,
    targetCode: entry.targetCode,
  };
  return {
    code: `${ALIAS_CODE_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`,
    plugin_id: "command-alias",
    plugin_name: "别名",
    label: target.label,
    icon: null,
    explain: `别名 ${entry.alias} -> ${target.plugin_name} · ${target.explain}`,
    score: score + 2,
    match_type: matchType === "exact" ? "alias" : matchType,
  };
}

function normalizeAlias(value: unknown): string {
  return typeof value === "string"
    ? value.trim().toLowerCase().replace(/\s+/g, "")
    : "";
}

function isSupportedTarget(code: string): boolean {
  return SUPPORTED_TARGET_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
