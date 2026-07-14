import type { SearchResult } from "./types";
import {
  buildPreparedSearchTrigramIndex,
  canSkipPreparedSearch,
  insertBoundedSearchResult,
  MAX_SEARCH_MATCH_SCORE,
  normalizeSearchText,
  prepareSearchMatchCandidate,
  preparedSearchCandidateIndexes,
  searchMatchForPreparedQuery,
  type PreparedSearchMatchCandidate,
} from "./searchMatch";

export type LocalLaunchKind = "file" | "folder" | "app";

export type LocalLaunchEntry = {
  id: string;
  name: string;
  keyword: string;
  path: string;
  kind: LocalLaunchKind;
  enabled: boolean;
};

export type LocalLaunchOverviewCard = {
  label: string;
  value: string;
  detail: string;
  tone: "normal" | "ready" | "warning" | "desktop" | "private";
};

export type LocalLaunchOverviewInput = {
  entries: LocalLaunchEntry[];
  statusLabel: string;
  hasTauriRuntime: boolean;
};

export const LOCAL_LAUNCH_STORAGE_KEY = "atools:local-launch";
export const LOCAL_LAUNCH_UPDATED_EVENT = "atools-local-launch-updated";
const LOCAL_SEARCH_RESULT_LIMIT = 100;
type PreparedLocalSearch = {
  entries: Array<{
    entry: LocalLaunchEntry;
    index: number;
    candidate: PreparedSearchMatchCandidate;
  }>;
  trigrams: Set<string>;
  trigramIndex: Map<string, number[]>;
};
const localSearchCache = new WeakMap<LocalLaunchEntry[], PreparedLocalSearch>();

export const DEFAULT_LOCAL_LAUNCH_ENTRIES: LocalLaunchEntry[] = [
  {
    id: "desktop",
    name: "桌面",
    keyword: "desktop",
    path: "~/Desktop",
    kind: "folder",
    enabled: true,
  },
  {
    id: "downloads",
    name: "下载",
    keyword: "downloads",
    path: "~/Downloads",
    kind: "folder",
    enabled: true,
  },
];

export function loadLocalLaunchEntries(): LocalLaunchEntry[] {
  try {
    const value = localStorage.getItem(LOCAL_LAUNCH_STORAGE_KEY);
    if (!value) return cloneDefaults();
    return normalizeLocalLaunchEntries(JSON.parse(value));
  } catch {
    return cloneDefaults();
  }
}

export function saveLocalLaunchEntries(entries: LocalLaunchEntry[]) {
  localStorage.setItem(LOCAL_LAUNCH_STORAGE_KEY, JSON.stringify(normalizeLocalLaunchEntries(entries)));
}

export function dispatchLocalLaunchEntries(entries: LocalLaunchEntry[]) {
  window.dispatchEvent(new CustomEvent<LocalLaunchEntry[]>(LOCAL_LAUNCH_UPDATED_EVENT, {
    detail: normalizeLocalLaunchEntries(entries),
  }));
}

export function normalizeLocalLaunchEntries(value: unknown): LocalLaunchEntry[] {
  if (!Array.isArray(value)) return cloneDefaults();
  const seen = new Set<string>();
  return value
    .map((item) => normalizeLocalLaunchEntry(item))
    .filter((entry): entry is LocalLaunchEntry => {
      if (!entry) return false;
      const key = entry.keyword.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function createLocalLaunchEntry(): LocalLaunchEntry {
  return {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name: "新建启动项",
    keyword: "local",
    path: "~/Desktop",
    kind: "folder",
    enabled: true,
  };
}

export function localLaunchOverviewCards(input: LocalLaunchOverviewInput): LocalLaunchOverviewCard[] {
  const entries = normalizeLocalLaunchEntries(input.entries);
  const enabledEntries = entries.filter((entry) => entry.enabled);
  const disabledCount = entries.length - enabledEntries.length;
  const folderCount = entries.filter((entry) => entry.kind === "folder").length;
  const appCount = entries.filter((entry) => entry.kind === "app").length;
  const fileCount = entries.filter((entry) => entry.kind === "file").length;
  const sampleEntry = enabledEntries[0] ?? entries[0];

  return [
    {
      label: "启动入口",
      value: `${enabledEntries.length}/${entries.length} 启用`,
      detail: disabledCount > 0
        ? `${disabledCount} 个停用；主搜索只匹配已启用的本地启动项`
        : "主搜索会按名称、关键字和路径召回本地启动项",
      tone: enabledEntries.length > 0 ? "ready" : "warning",
    },
    {
      label: "类型分布",
      value: `${folderCount} 文件夹 / ${appCount} 应用 / ${fileCount} 文件`,
      detail: sampleEntry
        ? `示例：输入 ${sampleEntry.keyword} 打开 ${sampleEntry.name}`
        : "可添加文件、文件夹或应用入口",
      tone: entries.length > 0 ? "normal" : "warning",
    },
    {
      label: "桌面能力",
      value: input.hasTauriRuntime ? "可选择路径" : "浏览器预览",
      detail: input.hasTauriRuntime
        ? "支持文件选择器、拖拽添加、打开和定位本地路径"
        : "浏览器预览无法选择、打开或定位真实本地路径",
      tone: input.hasTauriRuntime ? "ready" : "desktop",
    },
    {
      label: "保存状态",
      value: input.statusLabel.trim() || "已保存",
      detail: "名称、关键字、类型和本地路径只保存在本机；变化会立即同步到主搜索和所有指令页",
      tone: "private",
    },
  ];
}

export function localLaunchResultsForQuery(value: string, entries: LocalLaunchEntry[]): SearchResult[] {
  const normalized = normalizeSearchText(value);
  if (!normalized) return [];
  const results: SearchResult[] = [];
  const prepared = preparedLocalSearchEntries(entries);
  if (canSkipPreparedSearch(normalized, prepared.trigrams)) return results;
  const candidateIndexes = preparedSearchCandidateIndexes(normalized, prepared.trigramIndex);
  const positions: Iterable<number> = candidateIndexes ?? prepared.entries.keys();
  for (const position of positions) {
    const { entry, index, candidate } = prepared.entries[position];
    if (
      results.length === LOCAL_SEARCH_RESULT_LIMIT
      && MAX_SEARCH_MATCH_SCORE - index <= results[results.length - 1].score
    ) break;
    const match = searchMatchForPreparedQuery(normalized, candidate);
    if (!match) continue;
    insertBoundedSearchResult(
      results,
      toSearchResult(entry, match.type, match.score - index),
      LOCAL_SEARCH_RESULT_LIMIT,
    );
  }
  return results;
}

function preparedLocalSearchEntries(entries: LocalLaunchEntry[]) {
  const cached = localSearchCache.get(entries);
  if (cached) return cached;
  const preparedEntries = normalizeLocalLaunchEntries(entries)
    .filter((entry) => entry.enabled)
    .map((entry, index) => ({
      entry,
      index,
      candidate: prepareSearchMatchCandidate({
        text: entry.name,
        extraText: `${entry.keyword} ${entry.path}`,
        aliases: [entry.keyword],
      }),
    }));
  const trigramIndex = buildPreparedSearchTrigramIndex(preparedEntries.map((entry) => entry.candidate));
  const prepared = {
    entries: preparedEntries,
    trigrams: new Set(trigramIndex.keys()),
    trigramIndex,
  };
  localSearchCache.set(entries, prepared);
  return prepared;
}

export function localLaunchEntryByCode(code: string, entries: LocalLaunchEntry[]): LocalLaunchEntry | null {
  if (!code.startsWith("local:")) return null;
  const id = code.slice("local:".length);
  return normalizeLocalLaunchEntries(entries).find((entry) => entry.id === id) ?? null;
}

export function resolveLocalLaunchPath(path: string, homePath = ""): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("~/")) return trimmed;
  const home = homePath.trim().replace(/\/+$/, "");
  return home ? `${home}/${trimmed.slice(2)}` : trimmed;
}

function normalizeLocalLaunchEntry(value: unknown): LocalLaunchEntry | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<LocalLaunchEntry>;
  const keyword = stringValue(raw.keyword).replace(/\s+/g, "");
  const path = stringValue(raw.path);
  if (!keyword || !path) return null;
  return {
    id: stringValue(raw.id) || `local-${keyword}`,
    name: stringValue(raw.name) || keyword,
    keyword,
    path,
    kind: kindValue(raw.kind),
    enabled: raw.enabled !== false,
  };
}

function toSearchResult(entry: LocalLaunchEntry, matchType: string, score: number): SearchResult {
  return {
    code: `local:${entry.id}`,
    plugin_id: "local-launch",
    plugin_name: "本地启动",
    label: `打开 ${entry.name}`,
    icon: null,
    explain: `${kindLabel(entry.kind)} · ${entry.path}`,
    score,
    match_type: matchType,
  };
}

function kindValue(value: unknown): LocalLaunchKind {
  return value === "file" || value === "app" || value === "folder" ? value : "file";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function kindLabel(kind: LocalLaunchKind): string {
  if (kind === "folder") return "文件夹";
  if (kind === "app") return "应用";
  return "文件";
}

function cloneDefaults() {
  return DEFAULT_LOCAL_LAUNCH_ENTRIES.map((entry) => ({ ...entry }));
}
