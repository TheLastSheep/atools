import type { SearchResult } from "./types";
import type { RecommendedCommand } from "./uiState";
import { searchMatchForQuery, sortSearchMatches } from "./searchMatch";

export type CommandHistoryEntry = {
  code: string;
  label: string;
  explain: string;
  plugin_id: string;
  plugin_name: string;
  input: string;
  usedAt: string;
  useCount: number;
};

export type CommandHistoryPayload = {
  code: string;
  input: string;
};

export const COMMAND_HISTORY_STORAGE_KEY = "atools:command-history";
export const COMMAND_HISTORY_UPDATED_EVENT = "atools-command-history-updated";
const MAX_HISTORY_SIZE = 36;
const HISTORY_CODE_PREFIX = "history:";
const REPLAYABLE_CODE_PREFIXES = ["system:", "local:", "web:", "url:"];

export function loadCommandHistory(): CommandHistoryEntry[] {
  try {
    const value = localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY);
    return normalizeCommandHistory(value ? JSON.parse(value) : []);
  } catch {
    return [];
  }
}

export function saveCommandHistory(entries: CommandHistoryEntry[]) {
  try {
    localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(normalizeCommandHistory(entries)));
  } catch {
    // History is a convenience feature; private/restricted storage should not break search.
  }
}

export function dispatchCommandHistoryUpdated(entries: CommandHistoryEntry[]) {
  if (typeof window === "undefined") return;
  const detail = normalizeCommandHistory(entries);
  if (typeof CustomEvent === "function") {
    window.dispatchEvent(new CustomEvent<CommandHistoryEntry[]>(COMMAND_HISTORY_UPDATED_EVENT, { detail }));
    return;
  }
  window.dispatchEvent({ type: COMMAND_HISTORY_UPDATED_EVENT, detail } as unknown as Event);
}

export function clearCommandHistoryStorage(): number {
  const count = loadCommandHistory().length;
  try {
    localStorage.removeItem(COMMAND_HISTORY_STORAGE_KEY);
  } catch {
    // Clearing history should be best-effort in preview/restricted contexts.
  }
  dispatchCommandHistoryUpdated([]);
  return count;
}

export function removeCommandHistoryEntry(history: CommandHistoryEntry[], code: string): CommandHistoryEntry[] {
  const targetCode = code.trim();
  if (!targetCode) return normalizeCommandHistory(history);
  return normalizeCommandHistory(history).filter((entry) => entry.code !== targetCode);
}

export function removeCommandHistoryEntryStorage(code: string): number {
  const current = loadCommandHistory();
  const next = removeCommandHistoryEntry(current, code);
  const removed = current.length - next.length;
  if (removed <= 0) return 0;
  try {
    localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Removing one history item should be best-effort in preview/restricted contexts.
  }
  dispatchCommandHistoryUpdated(next);
  return removed;
}

export function commandHistoryStats(entries: CommandHistoryEntry[]) {
  const normalized = normalizeCommandHistory(entries);
  return {
    count: normalized.length,
    lastUsedAt: normalized[0]?.usedAt ?? "",
    topLabel: normalized[0]?.label ?? "",
  };
}

export function exportCommandHistoryJson(entries: CommandHistoryEntry[]): string {
  const normalized = normalizeCommandHistory(entries);
  return JSON.stringify({
    version: 1,
    exportedAt: new Date().toISOString(),
    count: normalized.length,
    entries: normalized,
  }, null, 2);
}

export function commandHistoryEntryFromResult(
  result: SearchResult,
  input: string,
  now = new Date().toISOString(),
): CommandHistoryEntry | null {
  if (!isReplayableCode(result.code)) return null;
  const label = result.label.trim();
  if (!label) return null;
  return {
    code: result.code.trim(),
    label,
    explain: result.explain.trim(),
    plugin_id: result.plugin_id.trim() || "system",
    plugin_name: result.plugin_name.trim() || "ATools",
    input: input.trim(),
    usedAt: validIsoDate(now) ? now : new Date().toISOString(),
    useCount: 1,
  };
}

export function recordCommandUse(
  history: CommandHistoryEntry[],
  result: SearchResult,
  input: string,
  now = new Date().toISOString(),
): CommandHistoryEntry[] {
  const nextEntry = commandHistoryEntryFromResult(result, input, now);
  if (!nextEntry) return normalizeCommandHistory(history);

  const normalized = normalizeCommandHistory(history);
  const existing = normalized.find((entry) => entry.code === nextEntry.code);
  const updated: CommandHistoryEntry = {
    ...nextEntry,
    useCount: Math.max(1, (existing?.useCount ?? 0) + 1),
  };

  return [updated, ...normalized.filter((entry) => entry.code !== updated.code)].slice(0, MAX_HISTORY_SIZE);
}

export function normalizeCommandHistory(value: unknown): CommandHistoryEntry[] {
  if (!Array.isArray(value)) return [];
  const byCode = new Map<string, CommandHistoryEntry>();
  for (const item of value) {
    const entry = normalizeCommandHistoryEntry(item);
    if (!entry) continue;
    const existing = byCode.get(entry.code);
    if (!existing || entry.usedAt.localeCompare(existing.usedAt) >= 0) {
      byCode.set(entry.code, entry);
    }
  }
  return [...byCode.values()]
    .sort((a, b) => b.usedAt.localeCompare(a.usedAt))
    .slice(0, MAX_HISTORY_SIZE);
}

export function homeCommandsFor(
  history: CommandHistoryEntry[],
  recommended: RecommendedCommand[],
  limit: number,
  pinned: RecommendedCommand[] = [],
): RecommendedCommand[] {
  const max = Math.max(1, limit);
  const commands: RecommendedCommand[] = [];
  const seenCodes = new Set<string>();
  const seenLabels = new Set<string>();

  for (const command of pinned) {
    const labelKey = normalizedLabelKey(command.label);
    if (seenCodes.has(command.code) || seenLabels.has(labelKey)) continue;
    seenCodes.add(command.code);
    seenLabels.add(labelKey);
    commands.push({ ...command, source: "pinned" });
    if (commands.length >= max) return commands;
  }

  for (const entry of normalizeCommandHistory(history)) {
    const labelKey = normalizedLabelKey(entry.label);
    if (seenCodes.has(entry.code) || seenLabels.has(labelKey)) continue;
    seenCodes.add(entry.code);
    seenLabels.add(labelKey);
    commands.push({
      code: entry.code,
      label: entry.label,
      explain: entry.explain || entry.input,
      input: entry.input,
      source: "history",
    });
    if (commands.length >= max) return commands;
  }

  for (const command of recommended) {
    const labelKey = normalizedLabelKey(command.label);
    if (seenCodes.has(command.code) || seenLabels.has(labelKey)) continue;
    seenCodes.add(command.code);
    seenLabels.add(labelKey);
    commands.push({ ...command, source: command.source ?? "recommended" });
    if (commands.length >= max) return commands;
  }

  return commands;
}

export function commandHistoryResultsForQuery(value: string, history: CommandHistoryEntry[]): SearchResult[] {
  const query = value.trim().toLowerCase();
  if (!query) return [];
  return sortSearchMatches(normalizeCommandHistory(history)
    .map((entry, index) => ({
      entry,
      index,
      match: searchMatchForQuery(query, {
        text: entry.label,
        extraText: `${entry.explain} ${entry.input} ${entry.plugin_name}`,
      }),
    })))
    .map(({ entry, index, match }) => historyResultForEntry(entry, match.type, match.score - index));
}

export function commandHistoryPayloadFromCode(code: string): CommandHistoryPayload | null {
  if (!code.startsWith(HISTORY_CODE_PREFIX)) return null;
  try {
    const payload = JSON.parse(decodeURIComponent(code.slice(HISTORY_CODE_PREFIX.length))) as CommandHistoryPayload;
    if (!payload || typeof payload.code !== "string" || typeof payload.input !== "string") return null;
    if (!isReplayableCode(payload.code)) return null;
    return {
      code: payload.code,
      input: payload.input,
    };
  } catch {
    return null;
  }
}

function historyResultForEntry(entry: CommandHistoryEntry, matchType: string, score: number): SearchResult {
  const payload: CommandHistoryPayload = {
    code: entry.code,
    input: entry.input,
  };
  return {
    code: `${HISTORY_CODE_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`,
    plugin_id: "command-history",
    plugin_name: "最近使用",
    label: entry.label,
    icon: null,
    explain: `最近使用 · ${entry.explain || entry.input}`,
    score,
    match_type: matchType,
  };
}

function normalizeCommandHistoryEntry(value: unknown): CommandHistoryEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CommandHistoryEntry>;
  const code = stringValue(raw.code);
  const label = stringValue(raw.label);
  if (!isReplayableCode(code) || !label) return null;
  const usedAt = stringValue(raw.usedAt);
  return {
    code,
    label,
    explain: stringValue(raw.explain),
    plugin_id: stringValue(raw.plugin_id) || "system",
    plugin_name: stringValue(raw.plugin_name) || "ATools",
    input: stringValue(raw.input),
    usedAt: validIsoDate(usedAt) ? usedAt : new Date(0).toISOString(),
    useCount: positiveInteger(raw.useCount),
  };
}

function isReplayableCode(code: string): boolean {
  return REPLAYABLE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix));
}

function validIsoDate(value: string): boolean {
  return Boolean(value) && Number.isFinite(Date.parse(value));
}

function positiveInteger(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 1) return 1;
  return Math.floor(number);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedLabelKey(label: string): string {
  return label.trim().toLowerCase();
}
