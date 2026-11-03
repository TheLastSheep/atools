import { FEATURE_SEARCH_TIMEOUT_MS } from "./launcherSearch";
import { normalizeSearchText, prepareSearchMatchCandidate, searchMatchForPreparedQuery, type PreparedSearchMatchCandidate } from "./searchMatch";
import { isTextContentResult, launcherTextSummary, launcherTextWithinBudget, LAUNCHER_TEXT_LIMIT_MESSAGE } from "./launcherMatchContext";
import type { SearchFeedback, RemoteSearchStatus } from "./searchFeedback";
import type { SearchResult } from "./types";

export type LauncherContentSearchState = {
  content: string | null;
  summary: string;
  filter: string;
  results: SearchResult[];
  status: RemoteSearchStatus;
  error: string;
  generation: number;
};

type PreparedResult = { result: SearchResult; candidate: PreparedSearchMatchCandidate };
type Options = {
  search: (content: string) => Promise<SearchResult[]>;
  available: () => boolean;
  isActive: () => boolean;
  onUpdate: (state: LauncherContentSearchState) => void;
};

export const emptyLauncherContentSearchState = (): LauncherContentSearchState => ({
  content: null, summary: "", filter: "", results: [], status: "idle", error: "", generation: 0,
});

/** One content query per fixed text/catalog generation; subsequent filtering is entirely local. */
export function createLauncherContentSearch(options: Options) {
  let state = emptyLauncherContentSearchState();
  let prepared: PreparedResult[] = [];
  let disposed = false;
  let stopWaiting: (() => void) | undefined;
  const publish = (patch: Partial<LauncherContentSearchState>) => {
    state = { ...state, ...patch };
    if (!disposed) options.onUpdate(state);
  };
  const current = (generation: number) => !disposed && state.generation === generation && options.isActive();

  function accepts(content: string): boolean {
    if (launcherTextWithinBudget(content)) return true;
    publish({ error: LAUNCHER_TEXT_LIMIT_MESSAGE });
    return false;
  }

  function filterResults(value: string): SearchResult[] {
    const query = normalizeSearchText(value);
    if (!query) return prepared.map(entry => entry.result);
    return prepared.flatMap(({ result, candidate }, index) => {
      const match = searchMatchForPreparedQuery(query, candidate);
      return match ? [{ result, score: match.score, index }] : [];
    }).sort((a, b) => b.score - a.score || a.index - b.index).map(entry => entry.result);
  }

  function filter(value: string) {
    if (state.content === null) return;
    publish({ filter: value, results: filterResults(value) });
  }

  function clear(): string | null {
    const content = state.content;
    stopWaiting?.(); stopWaiting = undefined;
    prepared = [];
    publish({ ...emptyLauncherContentSearchState(), generation: state.generation + 1 });
    return content;
  }

  async function load(content: string, filter: string) {
    stopWaiting?.(); stopWaiting = undefined;
    const generation = state.generation + 1;
    prepared = [];
    publish({ content, summary: launcherTextSummary(content), filter, results: [], status: "searching", error: "", generation });
    if (!options.available()) {
      publish({ status: "unavailable", error: "请在桌面应用中匹配处理此文本的插件。" });
      return;
    }
    try {
      const results = await new Promise<SearchResult[]>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("timeout")), FEATURE_SEARCH_TIMEOUT_MS);
        stopWaiting = () => { clearTimeout(timeout); resolve([]); };
        Promise.resolve().then(() => options.search(content)).then(resolve, reject).finally(() => clearTimeout(timeout));
      });
      if (!current(generation)) return;
      stopWaiting = undefined;
      const identities = new Set<string>();
      prepared = (Array.isArray(results) ? results : []).filter(result => {
        if (!isTextContentResult(result) || !result.plugin_id || !result.code) return false;
        const identity = JSON.stringify([result.plugin_id, result.code]);
        if (identities.has(identity)) return false;
        identities.add(identity); return true;
      }).map(result => ({ result, candidate: prepareSearchMatchCandidate({
        text: result.label, extraText: `${result.plugin_name} ${result.explain}`,
        aliases: result.content_search_terms?.filter(term => typeof term === "string") ?? [],
      }) }));
      publish({ results: filterResults(state.filter), status: "ready", error: "" });
    } catch {
      if (current(generation)) {
        stopWaiting = undefined;
        publish({ results: [], status: "error", error: "文本匹配暂不可用，请重新固定文本后重试。" });
      }
    }
  }

  return {
    accepts,
    pin(content: string, trim = true): boolean {
      const original = trim ? content.trim() : content;
      if (!original.trim() || !accepts(original)) return false;
      void load(original, ""); return true;
    },
    filter,
    clear,
    refresh() { if (state.content !== null) void load(state.content, state.filter); },
    generation: () => state.generation,
    isCurrent: (generation: number) => current(generation),
    dispose() { disposed = true; clear(); },
  };
}

/** Fixed-text feedback never echoes the body or suggests unrelated app/system searches. */
export function launcherContentSearchFeedback(state: LauncherContentSearchState): SearchFeedback {
  if (state.status === "searching") return { mode: "loading", title: "正在匹配文本处理命令", hint: "只显示可处理固定文本的插件", showSpinner: true };
  if (state.status === "error" || state.status === "unavailable") return { mode: "error", title: "文本匹配暂不可用", hint: state.error, showSpinner: false };
  if (state.results.length) return { mode: "none", title: "", hint: "", showSpinner: false };
  return { mode: "empty", title: state.filter.trim() ? "没有符合筛选条件的文本命令" : "没有插件可以处理此文本", hint: state.filter.trim() ? "试试插件名称或命令别名，或清除筛选条件" : "可编辑固定文本，或启用支持此内容的插件", showSpinner: false };
}
