import type { SearchResult } from "./types";
import { searchMatchForQuery, sortSearchMatches } from "./searchMatch";

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
  const query = value.trim();
  if (!query) return [];
  return sortSearchMatches(normalizeCommandAliases(aliases)
    .filter((entry) => entry.enabled)
    .map((entry, index) => {
      const target = resolveTarget(entry.targetCode);
      return {
        entry,
        target,
        index,
        match: target ? searchMatchForQuery(query, {
          text: target.label,
          extraText: target.explain,
          aliases: [entry.alias],
        }) : null,
      };
    }))
    .map(({ entry, target, index, match }) => aliasResult(entry, target!, match.type, match.score - index));
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
