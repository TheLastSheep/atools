import type { SearchResult } from "./types";
import type { RemoteSearchStatus } from "./searchFeedback";

export const REMOTE_SEARCH_DEBOUNCE_MS = 16;
export const FEATURE_SEARCH_TIMEOUT_MS = 1200;
export const LOCAL_APP_SEARCH_TIMEOUT_MS = 1800;

export type SearchSelectionIdentity = Pick<SearchResult, "plugin_id" | "code">;

export function searchSelectionIdentity(
  results: SearchResult[],
  selectedIndex: number,
): SearchSelectionIdentity | null {
  const selected = results[selectedIndex];
  return selected ? { plugin_id: selected.plugin_id, code: selected.code } : null;
}

/** Default selection follows final score order; explicit user selection follows its item identity. */
export function resolveSearchSelection(
  next: SearchResult[],
  userSelection: SearchSelectionIdentity | null,
): number {
  if (!userSelection) return 0;
  const index = next.findIndex((item) => item.code === userSelection.code && item.plugin_id === userSelection.plugin_id);
  return index < 0 ? 0 : index;
}

/** A later source must not discard app icons already hydrated by the host. */
export function retainSearchIcons(previous: SearchResult[], next: SearchResult[]): SearchResult[] {
  const icons = new Map(previous.filter((item) => item.icon).map((item) => [JSON.stringify([item.plugin_id, item.code]), item.icon]));
  return next.map((item) => {
    const icon = icons.get(JSON.stringify([item.plugin_id, item.code]));
    return !item.icon && icon ? { ...item, icon } : item;
  });
}

type SearchSource = "features" | "apps";
export type SearchSourceState = "not_requested" | "pending" | "succeeded" | "failed";
type SearchUpdate = {
  results: SearchResult[];
  status: RemoteSearchStatus;
  error: string;
  sourceStates: Record<SearchSource, SearchSourceState>;
  /** Exact rows returned by each source in this run; codes are not source identifiers. */
  sourceResults: Record<SearchSource, SearchResult[]>;
};

type ProgressiveSearchOptions = {
  query: string;
  localResults: SearchResult[];
  includeApps: boolean;
  searchFeatures: (query: string) => Promise<SearchResult[]>;
  searchApps: (query: string) => Promise<SearchResult[]>;
  isCurrent: () => boolean;
  onUpdate: (update: SearchUpdate) => void;
  onApps: (results: SearchResult[]) => void;
};

/** Publish each source as it settles; a slow source never withholds a fast one. */
export async function enrichLauncherSearch(options: ProgressiveSearchOptions): Promise<void> {
  const sources: SearchSource[] = options.includeApps ? ["features", "apps"] : ["features"];
  const remote: Record<SearchSource, SearchResult[]> = { features: [], apps: [] };
  const errors: string[] = [];
  const sourceStates: Record<SearchSource, SearchSourceState> = {
    features: "pending",
    apps: options.includeApps ? "pending" : "not_requested",
  };
  let settled = 0;

  await Promise.all(sources.map(async (source) => {
    const outcome = await settleSearchWithin(
      () => source === "features" ? options.searchFeatures(options.query) : options.searchApps(options.query),
      source === "features" ? FEATURE_SEARCH_TIMEOUT_MS : LOCAL_APP_SEARCH_TIMEOUT_MS,
      source === "features" ? "插件搜索" : "本地应用搜索",
    );
    if (!options.isCurrent()) return;
    settled += 1;
    if (outcome.status === "fulfilled") {
      remote[source] = outcome.value;
      sourceStates[source] = "succeeded";
    } else {
      errors.push(String(outcome.reason));
      sourceStates[source] = "failed";
    }

    const results = [...options.localResults, ...remote.features, ...remote.apps].sort((a, b) => b.score - a.score);
    const finished = settled === sources.length;
    const allFailed = finished && errors.length === sources.length;
    const status: RemoteSearchStatus = !finished && results.length === 0 ? "searching"
      : allFailed ? "error"
      : finished && errors.length > 0 ? "partial" : "ready";
    options.onUpdate({
      results,
      status,
      error: finished ? errors.join("; ") : "",
      sourceStates: { ...sourceStates },
      sourceResults: { features: [...remote.features], apps: [...remote.apps] },
    });
    if (source === "apps" && outcome.status === "fulfilled") options.onApps(outcome.value);
  }));
}

function settleSearchWithin<T>(
  call: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<PromiseSettledResult<T>> {
  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => resolve({
      status: "rejected",
      reason: new Error(`${label}超过 ${timeoutMs}ms 未响应`),
    }), timeoutMs);
    // Attach rejection handling to both calls immediately, including synchronous throws.
    Promise.resolve().then(call).then(
      (value) => { clearTimeout(timeoutId); resolve({ status: "fulfilled", value }); },
      (reason) => { clearTimeout(timeoutId); resolve({ status: "rejected", reason }); },
    );
  });
}
