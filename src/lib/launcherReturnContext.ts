import type { RemoteSearchStatus } from "./searchFeedback";
import type { SearchSelectionIdentity } from "./launcherSearch";
import type { SearchResult } from "./types";

export const MAX_LAUNCHER_RETURN_SNAPSHOT_RESULTS = 1200;

export type LauncherReturnContext = {
  query: string;
  selection: SearchSelectionIdentity;
  results: SearchResult[] | null;
  remoteSearchStatus: RemoteSearchStatus;
  searchError: string;
};

export type LauncherReturnSnapshotInput = {
  query: string;
  selection: SearchSelectionIdentity | null;
  results: SearchResult[];
  remoteSearchStatus: RemoteSearchStatus;
  searchError: string;
};

export type LauncherReturnActionCapture = {
  searchRunAtSelection: number;
  context: LauncherReturnContext | null;
};

function copyResult(result: SearchResult): SearchResult {
  return {
    ...result,
    ...(result.content_search_terms ? { content_search_terms: [...result.content_search_terms] } : {}),
  };
}

function copyContext(context: LauncherReturnContext): LauncherReturnContext {
  return {
    ...context,
    selection: { ...context.selection },
    results: context.results?.map(copyResult) ?? null,
  };
}

/** Captures one bounded, ephemeral search view for an ordinary plugin return. */
export function createLauncherReturnContextSnapshot(
  input: LauncherReturnSnapshotInput,
): LauncherReturnContext | null {
  if (!input.query.trim() || !input.selection?.plugin_id || !input.selection.code) return null;
  return {
    query: input.query,
    selection: { ...input.selection },
    results: input.results.length <= MAX_LAUNCHER_RETURN_SNAPSHOT_RESULTS
      ? input.results.map(copyResult)
      : null,
    remoteSearchStatus: input.remoteSearchStatus,
    searchError: input.searchError.slice(0, 1024),
  };
}

/** Keeps one ephemeral ordinary-search snapshot while a plugin is open. */
export function createLauncherReturnContextStore() {
  let context: LauncherReturnContext | null = null;

  return {
    capture(next: LauncherReturnContext): boolean {
      if (!next.query.trim() || !next.selection.plugin_id || !next.selection.code) return false;
      context = copyContext({
        ...next,
        results: next.results && next.results.length > MAX_LAUNCHER_RETURN_SNAPSHOT_RESULTS
          ? null
          : next.results,
      });
      return true;
    },
    consume(): LauncherReturnContext | null {
      const current = context;
      context = null;
      return current;
    },
    clear(): void {
      context = null;
    },
  };
}

/** Captures the selected result only while its one-step activation commit is current. */
export function captureLauncherReturnContextIfCurrent(
  store: ReturnType<typeof createLauncherReturnContextStore>,
  state: {
    searchRunId: number;
    query: string;
    activePanel: string;
    activePlugin: { feature_code: string; plugin_id: string } | null;
  },
  capture: LauncherReturnActionCapture,
  item: Pick<SearchResult, "code" | "plugin_id">,
): boolean {
  if (!capture.context || state.searchRunId !== capture.searchRunAtSelection + 1 || state.query !== capture.context.query
    || state.activePanel !== "home" || state.activePlugin?.feature_code !== item.code
    || state.activePlugin.plugin_id !== item.plugin_id) return false;
  return store.capture(capture.context);
}

export type LauncherReturnCoordinatorPorts<Plugin, Activation> = {
  getActivePlugin: () => Plugin | null;
  getActivePanel: () => string;
  getQuery: () => string;
  getSearchRunId: () => number;
  closePromoted: () => Promise<unknown> | unknown;
  advanceSearchRun: () => number;
  cancelActivation: () => void;
  captureActivation: () => Activation;
  isActivationCurrent: (activation: Activation) => boolean;
  enterHome: () => void;
  clearSearch: () => void;
  restoreSnapshot: (context: LauncherReturnContext) => void;
  refresh: (query: string) => Promise<unknown>;
  restoreSelection: (selection: SearchSelectionIdentity) => void;
  focusSearch: () => void | Promise<void>;
  resize: () => Promise<unknown>;
  onRefreshError: (error: unknown) => void;
};

/** Owns return ordering, stale-work fences, snapshot consumption, and resize timing. */
export function createLauncherReturnCoordinator<Plugin, Activation>(
  store: ReturnType<typeof createLauncherReturnContextStore>,
  ports: LauncherReturnCoordinatorPorts<Plugin, Activation>,
) {
  let requestId = 0;

  const isCurrent = (
    id: number,
    activation: Activation,
    query: string,
    searchRunId: number,
  ) => id === requestId
    && ports.getActivePlugin() === null
    && ports.getActivePanel() === "home"
    && ports.isActivationCurrent(activation)
    && ports.getSearchRunId() === searchRunId
    && ports.getQuery() === query;

  function invalidate() {
    requestId++;
  }

  function dispose() {
    invalidate();
    store.clear();
  }

  async function returnToSearch(codeChanged = false): Promise<void> {
    const id = ++requestId;
    const returningPlugin = ports.getActivePlugin();
    const context = codeChanged ? null : store.consume();
    if (codeChanged) store.clear();
    const beforeCloseRunId = ports.getSearchRunId();
    await ports.closePromoted();
    if (id !== requestId || ports.getActivePlugin() !== returningPlugin
      || ports.getSearchRunId() !== beforeCloseRunId) return;

    const returnRunId = ports.advanceSearchRun();
    if (!codeChanged) ports.cancelActivation();
    const activation = ports.captureActivation();
    ports.enterHome();

    if (!context) {
      ports.clearSearch();
      await ports.resize();
      if (isCurrent(id, activation, "", returnRunId)) await ports.focusSearch();
      return;
    }

    ports.restoreSnapshot(context);
    await ports.focusSearch();
    if (!isCurrent(id, activation, context.query, returnRunId)) return;

    await ports.resize();
    if (!isCurrent(id, activation, context.query, returnRunId)) return;

    // The first focus request can run while the panel transition still owns focus.
    // Re-request only after resize, under the same return identity fence.
    await ports.focusSearch();
    if (!isCurrent(id, activation, context.query, returnRunId)) return;

    const refresh = ports.refresh(context.query);
    ports.restoreSelection(context.selection);
    void refresh.catch(ports.onRefreshError);
  }

  return { invalidate, dispose, returnToSearch };
}
