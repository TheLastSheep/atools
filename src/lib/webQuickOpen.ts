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

export type WebQuickOpenEntry = {
  id: string;
  name: string;
  keyword: string;
  template: string;
  enabled: boolean;
};

export type WebQuickOpenValidationInput = Pick<WebQuickOpenEntry, "name" | "keyword" | "template">;

export type WebQuickOpenOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "private";
};

export type WebQuickOpenOverviewInput = {
  entries: WebQuickOpenEntry[];
  statusLabel: string;
};

export const WEB_QUICK_OPEN_STORAGE_KEY = "atools:web-quick-open";
export const WEB_QUICK_OPEN_UPDATED_EVENT = "atools-web-quick-open-updated";
const WEB_SEARCH_RESULT_LIMIT = 100;
type PreparedWebQuickOpenEntry = {
  entry: WebQuickOpenEntry;
  index: number;
  candidate: PreparedSearchMatchCandidate;
};
const webSearchCache = new WeakMap<WebQuickOpenEntry[], {
  entries: PreparedWebQuickOpenEntry[];
  byKeyword: Map<string, PreparedWebQuickOpenEntry>;
  trigrams: Set<string>;
}>();

export const DEFAULT_WEB_QUICK_OPEN_ENTRIES: WebQuickOpenEntry[] = [
  {
    id: "google",
    name: "Google",
    keyword: "g",
    template: "https://www.google.com/search?q={query}",
    enabled: true,
  },
  {
    id: "github",
    name: "GitHub",
    keyword: "gh",
    template: "https://github.com/search?q={query}",
    enabled: true,
  },
  {
    id: "npm",
    name: "NPM",
    keyword: "npm",
    template: "https://www.npmjs.com/search?q={query}",
    enabled: true,
  },
];

export function loadWebQuickOpenEntries(): WebQuickOpenEntry[] {
  try {
    const value = localStorage.getItem(WEB_QUICK_OPEN_STORAGE_KEY);
    if (!value) return DEFAULT_WEB_QUICK_OPEN_ENTRIES.map((entry) => ({ ...entry }));
    return normalizeWebQuickOpenEntries(JSON.parse(value));
  } catch {
    return DEFAULT_WEB_QUICK_OPEN_ENTRIES.map((entry) => ({ ...entry }));
  }
}

export function saveWebQuickOpenEntries(entries: WebQuickOpenEntry[]) {
  localStorage.setItem(WEB_QUICK_OPEN_STORAGE_KEY, JSON.stringify(normalizeWebQuickOpenEntries(entries)));
}

export function dispatchWebQuickOpenEntries(entries: WebQuickOpenEntry[]) {
  window.dispatchEvent(new CustomEvent<WebQuickOpenEntry[]>(WEB_QUICK_OPEN_UPDATED_EVENT, {
    detail: normalizeWebQuickOpenEntries(entries),
  }));
}

export function normalizeWebQuickOpenEntries(value: unknown): WebQuickOpenEntry[] {
  if (!Array.isArray(value)) return DEFAULT_WEB_QUICK_OPEN_ENTRIES.map((entry) => ({ ...entry }));
  const seen = new Set<string>();
  return value
    .map((item) => normalizeWebQuickOpenEntry(item))
    .filter((entry): entry is WebQuickOpenEntry => {
      if (!entry) return false;
      const key = entry.keyword.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function createWebQuickOpenEntry(): WebQuickOpenEntry {
  return {
    id: `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "新建快开",
    keyword: "web",
    template: "https://www.google.com/search?q={query}",
    enabled: true,
  };
}

export function webQuickOpenOverviewCards(input: WebQuickOpenOverviewInput): WebQuickOpenOverviewCard[] {
  const entries = normalizeWebQuickOpenEntries(input.entries);
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const disabledCount = entries.length - enabledEntries.length;
  const searchEntries = entries.filter((entry) => entry.template.includes("{query}"));
  const enabledSearchEntries = searchEntries.filter((entry) => entry.enabled);
  const directEntries = entries.filter((entry) => !entry.template.includes("{query}"));
  const sampleSearch = enabledSearchEntries[0] ?? searchEntries[0];
  const sampleDirect = directEntries.find((entry) => entry.enabled) ?? directEntries[0];

  return [
    {
      label: "快开入口",
      value: `${enabledEntries.length}/${entries.length} 启用`,
      detail: disabledCount > 0
        ? `${disabledCount} 个停用；主搜索只匹配已启用的网页快开`
        : "主搜索会按关键字、名称和 URL 模板召回网页快开",
      tone: enabledEntries.length > 0 ? "ready" : "warning",
    },
    {
      label: "搜索模板",
      value: `${searchEntries.length} 个`,
      detail: sampleSearch
        ? `示例：输入 ${sampleSearch.keyword} rust 打开搜索结果`
        : "需要在 URL 模板中加入 {query} 才能按关键词搜索",
      tone: enabledSearchEntries.length > 0 ? "ready" : "warning",
    },
    {
      label: "固定网址",
      value: `${directEntries.length} 个`,
      detail: sampleDirect
        ? `输入 ${sampleDirect.keyword} 可直接打开固定地址`
        : "未配置固定网址；可在编辑器中切换为固定网址模式",
      tone: "normal",
    },
    {
      label: "保存状态",
      value: input.statusLabel.trim() || "已保存",
      detail: "名称、关键字和 URL 模板只保存在本机；变化会立即同步到主搜索和所有指令页",
      tone: "private",
    },
  ];
}

export function buildWebQuickOpenUrl(entry: WebQuickOpenEntry, queryText: string): string {
  const encoded = encodeURIComponent(queryText.trim());
  if (entry.template.includes("{query}")) {
    return entry.template.replaceAll("{query}", encoded);
  }
  const separator = entry.template.includes("?") ? "&" : "?";
  return `${entry.template}${separator}q=${encoded}`;
}

export function webQuickOpenResultsForQuery(value: string, entries: WebQuickOpenEntry[]): SearchResult[] {
  const rawQuery = value.trim();
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const prepared = preparedWebQuickOpenEntries(entries);
  const separatorIndex = rawQuery.indexOf(" ");
  const prefix = separatorIndex > 0 ? rawQuery.slice(0, separatorIndex).toLowerCase() : "";
  const exactPrefix = prefix ? prepared.byKeyword.get(prefix) : null;
  if (exactPrefix) {
    const queryText = rawQuery.slice(exactPrefix.entry.keyword.length).trim();
    return [toSearchResult(exactPrefix.entry, queryText, exactPrefix.index, "prefix", 92 - exactPrefix.index)];
  }

  const results: SearchResult[] = [];
  if (canSkipPreparedSearch(normalized, prepared.trigrams)) return results;
  for (const { entry, index, candidate } of prepared.entries) {
    if (
      results.length === WEB_SEARCH_RESULT_LIMIT
      && MAX_SEARCH_MATCH_SCORE - index <= results[results.length - 1].score
    ) break;
    const match = searchMatchForPreparedQuery(normalized, candidate);
    if (!match) continue;
    insertBoundedSearchResult(
      results,
      toSearchResult(entry, "", index, match.type, match.score - index),
      WEB_SEARCH_RESULT_LIMIT,
    );
  }
  return results;
}

function preparedWebQuickOpenEntries(entries: WebQuickOpenEntry[]) {
  const cached = webSearchCache.get(entries);
  if (cached) return cached;
  const preparedEntries = normalizeWebQuickOpenEntries(entries)
    .filter((entry) => entry.enabled)
    .map((entry, index) => ({
      entry,
      index,
      candidate: prepareSearchMatchCandidate({
        text: entry.name,
        extraText: `${entry.keyword} ${entry.template}`,
        aliases: [entry.keyword],
      }),
    }));
  const prepared = {
    entries: preparedEntries,
    byKeyword: new Map(preparedEntries.map((entry) => [entry.entry.keyword.toLowerCase(), entry])),
    trigrams: buildPreparedSearchTrigramSet(preparedEntries.map((entry) => entry.candidate)),
  };
  webSearchCache.set(entries, prepared);
  return prepared;
}

export function webQuickOpenEntryByCode(code: string, entries: WebQuickOpenEntry[]): WebQuickOpenEntry | null {
  if (!code.startsWith("web:")) return null;
  const id = code.slice("web:".length);
  return normalizeWebQuickOpenEntries(entries).find((entry) => entry.id === id) ?? null;
}

export function validateWebQuickOpenEntry(entry: WebQuickOpenValidationInput): string {
  if (!entry.name.trim()) return "名称不能为空";
  if (!entry.keyword.trim()) return "关键字不能为空";
  if (/\s/.test(entry.keyword)) return "关键字不能包含空格";
  if (!entry.template.trim()) return "URL 模板不能为空";
  try {
    const url = new URL(entry.template.replaceAll("{query}", "preview"));
    if (!["http:", "https:"].includes(url.protocol)) return "URL 只支持 http 或 https";
  } catch {
    return "请输入有效的 URL 模板";
  }
  return "";
}

function normalizeWebQuickOpenEntry(value: unknown): WebQuickOpenEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<WebQuickOpenEntry>;
  const keyword = stringValue(raw.keyword).replace(/\s+/g, "");
  const template = stringValue(raw.template);
  if (!keyword || !template) return null;
  return {
    id: stringValue(raw.id) || `web-${keyword}`,
    name: stringValue(raw.name) || keyword,
    keyword,
    template,
    enabled: raw.enabled !== false,
  };
}

function toSearchResult(entry: WebQuickOpenEntry, queryText: string, index: number, matchType?: string, score?: number): SearchResult {
  return {
    code: `web:${entry.id}`,
    plugin_id: "web-quick-open",
    plugin_name: "网页快开",
    label: queryText ? `${entry.name} 搜索 ${queryText}` : entry.name,
    icon: null,
    explain: queryText ? buildWebQuickOpenUrl(entry, queryText) : `输入 ${entry.keyword} 关键词快速打开`,
    score: score ?? 92 - index,
    match_type: matchType ?? (queryText ? "prefix" : "contains"),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
