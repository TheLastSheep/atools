import { invoke } from "@tauri-apps/api/core";
import { enrichLauncherSearch, retainSearchIcons, REMOTE_SEARCH_DEBOUNCE_MS, type SearchSelectionIdentity, type SearchSourceState } from "./launcherSearch";
import { includeLocalAppSearch } from "./searchBehavior";
import type { AToolsSettings } from "./settings";
import type { LauncherContentSearchState } from "./launcherContentSearch";
import type { LauncherMediaSearchState } from "./launcherMediaSearch";
import type { PastedItem } from "./pasteIntake";
import type { SearchResult } from "./types";
import type { LauncherPendingPluginActivationStore } from "./launcherPendingPluginActivation.svelte";

type SearchState = {
  activePlugin: unknown | null;
  query: string;
  mediaMatch: LauncherMediaSearchState;
  textMatch: LauncherContentSearchState;
  pastedItems: PastedItem[];
  results: SearchResult[];
  selectedIndex: number;
  selectedRecentIndex: number;
  searchError: string;
  remoteSearchStatus: import("./searchFeedback").RemoteSearchStatus;
  activePanel: string;
  appSettings: AToolsSettings;
  searchRunId: number;
  tabTargetFeedback: string;
  userSearchSelection: SearchSelectionIdentity | null;
  launcherDisposed: boolean;
  pluginLifecycleNotice: import("./pluginCodeLifecycle").PluginCodeChange | null;
  pluginActivationError: string;
};

type SearchPorts = {
  state: SearchState;
  pendingPluginActivation: LauncherPendingPluginActivationStore;
  tabTargetController: { cancel: () => void };
  mediaPaste: Pick<ReturnType<typeof import("./launcherMediaPaste").createLauncherMediaPaste>, "observeQuery">;
  mediaSearch: Pick<ReturnType<typeof import("./launcherMediaSearch").createLauncherMediaSearch>, "filter" | "clear">;
  contentSearch: Pick<ReturnType<typeof import("./launcherContentSearch").createLauncherContentSearch>, "filter" | "clear">;
  localResultsForQuery: (query: string) => SearchResult[];
  syncLauncherSearchPresentation: () => void;
  hasTauriRuntime: () => boolean;
  focusSearch: () => void;
  resetPalette: () => Promise<void>;
  isHomeSearch: () => boolean;
  clearAutoClearTimer: () => void;
};

export function createLauncherSearchController(ports: SearchPorts) {
  const { state } = ports;
  let disposed = false;
  let visible = typeof document === "undefined" || document.visibilityState !== "hidden";
  // This snapshot only decides whether a selection still belongs to the query
  // that was visible before hiding. Resumed searches always read state.query.
  let selectionQueryAtHide = state.query;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let settleDebounce: (() => void) | null = null;
  let sourceSnapshotQuery: string | null = null;
  let sourceSnapshots: Record<"features" | "apps", SearchResult[]> = { features: [], apps: [] };

  function isRunActive(runId: number, searchQuery: string): boolean {
    return !disposed && !state.launcherDisposed && visible
      && runId === state.searchRunId && state.query === searchQuery;
  }

  function isCurrent(runId: number, searchQuery: string): boolean {
    return isRunActive(runId, searchQuery) && ports.isHomeSearch()
      && state.activePlugin === null && state.activePanel === "home"
      && state.textMatch.content === null
      && state.mediaMatch.content === null && state.mediaMatch.intakeKind === null;
  }

  function canRestoreOrdinarySearch(): boolean {
    return ports.isHomeSearch() && state.activePlugin === null && state.activePanel === "home"
      && state.textMatch.content === null
      && state.mediaMatch.content === null && state.mediaMatch.intakeKind === null;
  }

  function clearDebounce() {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = null;
    const settle = settleDebounce;
    settleDebounce = null;
    settle?.();
  }

  function waitForDebounce(): Promise<void> {
    return new Promise((resolve) => {
      settleDebounce = resolve;
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        settleDebounce = null;
        resolve();
      }, REMOTE_SEARCH_DEBOUNCE_MS);
    });
  }

  async function onQueryChange(newQuery: string) {
    if (disposed || state.launcherDisposed) return;
    if (!visible) {
      if (newQuery !== state.query) state.userSearchSelection = null;
      state.query = newQuery;
      return;
    }
    await search(newQuery);
  }

  async function search(
    newQuery: string,
    options: { preserveDisplayedResults?: boolean; preserveSelection?: boolean; visibilityRefresh?: boolean } = {},
  ) {
    if (disposed || state.launcherDisposed || !visible) return;
    if (sourceSnapshotQuery !== newQuery) {
      sourceSnapshotQuery = newQuery;
      sourceSnapshots = { features: [], apps: [] };
    }
    const previousQuery = state.query;
    const preserveResultsForRetry = !options.visibilityRefresh && newQuery === previousQuery
      && state.results.length > 0
      && (state.remoteSearchStatus === "partial" || state.remoteSearchStatus === "error");
    const previousResults = preserveResultsForRetry ? state.results : [];
    const runId = ++state.searchRunId;
    clearDebounce();
    if (!options.visibilityRefresh) {
      ports.pendingPluginActivation.cancel();
      state.pluginLifecycleNotice = null;
      state.pluginActivationError = "";
      ports.clearAutoClearTimer();
    }
    state.tabTargetFeedback = "";
    if (!options.visibilityRefresh) ports.mediaPaste.observeQuery(newQuery);
    if (newQuery !== state.query && !options.preserveSelection) {
      ports.tabTargetController.cancel();
      state.userSearchSelection = null;
    }
    state.query = newQuery;
    if (disposed || state.launcherDisposed || !visible) return;
    if (state.mediaMatch.content !== null) { ports.mediaSearch.filter(newQuery); return; }
    if (state.mediaMatch.error) ports.mediaSearch.clear();
    if (state.textMatch.content !== null) { ports.contentSearch.filter(newQuery); return; }
    if (state.textMatch.error) ports.contentSearch.clear();
    if (!newQuery.startsWith("粘贴了 ")) {
      state.pastedItems = [];
    }
    if (state.activePlugin) return;
    if (!newQuery.trim()) {
      state.results = [];
      state.selectedIndex = 0;
      state.selectedRecentIndex = 0;
      state.remoteSearchStatus = "idle";
      state.searchError = "";
      if (state.activePanel === "home") {
        await ports.resetPalette();
      }
      if (isRunActive(runId, newQuery)) ports.focusSearch();
      return;
    }

    if (state.activePlugin === null) state.activePanel = "home";
    const localResults = ports.localResultsForQuery(newQuery);
    if (!preserveResultsForRetry && !options.preserveDisplayedResults) {
      state.results = localResults;
      if (!options.preserveSelection) state.selectedIndex = 0;
    }
    state.searchError = "";
    ports.syncLauncherSearchPresentation();

    if (!ports.hasTauriRuntime()) {
      state.remoteSearchStatus = "unavailable";
      if (!options.visibilityRefresh) ports.focusSearch();
      return;
    }

    state.remoteSearchStatus = "searching";
    await waitForDebounce();
    if (!isCurrent(runId, newQuery)) return;
    let finalUpdate: {
      results: SearchResult[];
      status: import("./searchFeedback").RemoteSearchStatus;
      error: string;
      sourceStates: Record<"features" | "apps", SearchSourceState>;
      sourceResults: Record<"features" | "apps", SearchResult[]>;
    } | undefined;
    let retryAppResults: SearchResult[] | undefined;
    await enrichLauncherSearch({
      query: newQuery,
      localResults,
      includeApps: includeLocalAppSearch(state.appSettings),
      searchFeatures: (value) => invoke<SearchResult[]>("search_features", { query: value }),
      searchApps: (value) => invoke<SearchResult[]>("search_local_apps", { query: value, limit: 20 }),
      isCurrent: () => isCurrent(runId, newQuery),
      onUpdate: (update) => {
        if (!isCurrent(runId, newQuery)) return;
        for (const source of ["features", "apps"] as const) {
          if (update.sourceStates[source] === "not_requested") sourceSnapshots[source] = [];
          else if (update.sourceStates[source] === "succeeded") sourceSnapshots[source] = update.sourceResults[source];
        }
        if (preserveResultsForRetry) {
          finalUpdate = update;
          state.remoteSearchStatus = "searching";
          state.searchError = "";
          ports.syncLauncherSearchPresentation();
          return;
        }
        const nextResults = retainSearchIcons(state.results, update.results);
        state.results = nextResults;
        state.remoteSearchStatus = update.status;
        state.searchError = update.error;
        ports.syncLauncherSearchPresentation();
      },
      onApps: (items) => {
        if (!isCurrent(runId, newQuery)) return;
        if (preserveResultsForRetry) retryAppResults = items;
        else void hydrateLocalAppResultIcons(runId, newQuery, items);
      },
    });
    if (preserveResultsForRetry && finalUpdate
      && isCurrent(runId, newQuery)) {
      const refreshedResults = finalUpdate.status === "partial" || finalUpdate.status === "error"
        ? mergeFailedSourceResults(finalUpdate.results, sourceSnapshots, finalUpdate.sourceStates)
        : finalUpdate.results;
      state.results = retainSearchIcons(previousResults, refreshedResults);
      state.remoteSearchStatus = finalUpdate.status;
      state.searchError = finalUpdate.error;
      ports.syncLauncherSearchPresentation();
      if (retryAppResults) void hydrateLocalAppResultIcons(runId, newQuery, retryAppResults);
    }
  }

  function mergeFailedSourceResults(
    current: SearchResult[],
    snapshots: Record<"features" | "apps", SearchResult[]>,
    sourceStates: Record<"features" | "apps", SearchSourceState>,
  ): SearchResult[] {
    const byIdentity = new Map<string, SearchResult>();
    for (const result of current) byIdentity.set(JSON.stringify([result.plugin_id ?? "", result.code]), result);
    for (const source of ["features", "apps"] as const) {
      if (sourceStates[source] !== "failed") continue;
      for (const result of snapshots[source]) {
        const identity = JSON.stringify([result.plugin_id ?? "", result.code]);
        if (!byIdentity.has(identity)) byIdentity.set(identity, result);
      }
    }
    return [...byIdentity.values()].sort((left, right) => right.score - left.score);
  }

  async function hydrateLocalAppResultIcons(
    runId: number,
    searchQuery: string,
    localAppResults: SearchResult[],
  ) {
    if (!isCurrent(runId, searchQuery)) return;
    const paths = [...new Set(localAppResults.map((result) => result.explain).filter(Boolean))];
    if (paths.length === 0) return;
    try {
      const icons = await invoke<Record<string, string>>("load_local_app_icons", { paths });
      if (!isCurrent(runId, searchQuery)) return;
      state.results = state.results.map((result) => {
        const icon = result.code.startsWith("local-app:") ? icons[result.explain] : undefined;
        return icon ? { ...result, icon } : result;
      });
    } catch (error) {
      if (isCurrent(runId, searchQuery)) console.debug("Local app icons unavailable:", error);
    }
  }

  async function setVisible(nextVisible: boolean): Promise<void> {
    if (disposed || state.launcherDisposed || visible === nextVisible) return;
    if (!nextVisible) {
      selectionQueryAtHide = state.query;
      visible = false;
      state.searchRunId += 1;
      clearDebounce();
      return;
    }
    visible = true;
    const query = state.query;
    const preserveSelection = query === selectionQueryAtHide;
    if (!preserveSelection) state.userSearchSelection = null;
    selectionQueryAtHide = query;
    if (!canRestoreOrdinarySearch() || !query.trim()) return;
    await search(query, { preserveDisplayedResults: preserveSelection, preserveSelection, visibilityRefresh: true });
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    visible = false;
    state.searchRunId += 1;
    clearDebounce();
  }

  return { onQueryChange, hydrateLocalAppResultIcons, setVisible, dispose };
}
