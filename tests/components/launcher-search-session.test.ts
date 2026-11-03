import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_ATOOLS_SETTINGS } from "../../src/lib/settings";
import { emptyLauncherContentSearchState } from "../../src/lib/launcherContentSearch";
import { emptyLauncherMediaSearchState } from "../../src/lib/launcherMediaSearch";
import { resolveSearchSelection } from "../../src/lib/launcherSearch";
import { createLauncherSearchController } from "../../src/lib/launcherSearchController";
import type { SearchResult } from "../../src/lib/types";

const tauri = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauri.invoke }));

type ControllerPorts = Parameters<typeof createLauncherSearchController>[0];
type SearchState = ControllerPorts["state"];
const result = (code: string): SearchResult => ({
  code, plugin_id: "fixture", plugin_name: "Fixture", label: code,
  explain: "", icon: null, score: 50, match_type: "over",
});

function fixture(initialQuery = "", hasTauriRuntime = true) {
  const state: SearchState = {
    activePlugin: null, query: initialQuery, mediaMatch: emptyLauncherMediaSearchState(),
    textMatch: emptyLauncherContentSearchState(), pastedItems: [], results: [],
    selectedIndex: 0, selectedRecentIndex: 0, searchError: "", remoteSearchStatus: "idle",
    activePanel: "home", appSettings: { ...DEFAULT_ATOOLS_SETTINGS, localAppSearch: false },
    searchRunId: 0, tabTargetFeedback: "", userSearchSelection: null, launcherDisposed: false,
    pluginLifecycleNotice: null, pluginActivationError: "",
  };
  const sync = vi.fn(() => {
    state.selectedIndex = resolveSearchSelection(state.results, state.userSearchSelection);
  });
  const focus = vi.fn(), resetPalette = vi.fn(async () => undefined);
  const pendingPluginActivation = {
    current: null,
    begin: (input: Omit<NonNullable<ControllerPorts["pendingPluginActivation"]["current"]>, "attemptId">) => ({ ...input, attemptId: 1 }),
    isCurrent: () => false,
    clear: vi.fn(),
    cancel: vi.fn(() => false),
  } satisfies ControllerPorts["pendingPluginActivation"];
  const controller = createLauncherSearchController({
    state,
    pendingPluginActivation,
    tabTargetController: { cancel: vi.fn() },
    mediaPaste: { observeQuery: vi.fn() },
    mediaSearch: { filter: vi.fn(), clear: vi.fn() },
    contentSearch: { filter: vi.fn(), clear: vi.fn() },
    localResultsForQuery: query => query.trim() ? [result(`local:${query}`)] : [],
    syncLauncherSearchPresentation: sync,
    hasTauriRuntime: () => hasTauriRuntime,
    focusSearch: focus,
    resetPalette,
    isHomeSearch: () => state.activePlugin === null && state.activePanel === "home",
    clearAutoClearTimer: vi.fn(),
  });
  return { state, controller, sync, focus, resetPalette };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("settles a pending debounce without dispatch when the window becomes hidden", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  tauri.invoke.mockReset();
  const f = fixture();

  const pending = f.controller.onQueryChange("alpha");
  expect(f.state.query).toBe("alpha");
  const syncBeforeHide = f.sync.mock.calls.length;
  await f.controller.setVisible(false);
  await pending;
  await vi.advanceTimersByTimeAsync(100);

  expect(tauri.invoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  expect(f.sync).toHaveBeenCalledTimes(syncBeforeHide);
  expect(f.focus).not.toHaveBeenCalled();
  f.controller.dispose();
});

it("starts hidden when the constructor sees a hidden document and resumes state.query once", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  tauri.invoke.mockReset().mockResolvedValue([]);
  const f = fixture();
  await f.controller.onQueryChange("initially hidden");
  expect(f.state.query).toBe("initially hidden");
  expect(tauri.invoke).not.toHaveBeenCalled();

  const resumed = f.controller.setVisible(true);
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  await resumed;
  expect(f.state.query).toBe("initially hidden");
  expect(tauri.invoke).toHaveBeenCalledTimes(1);
  expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: "initially hidden" });
  f.controller.dispose();
});

it("assumes visible when no document exists", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("document", undefined);
  tauri.invoke.mockReset().mockResolvedValue([]);
  const f = fixture();
  const search = f.controller.onQueryChange("server rendered");
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  await search;
  expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: "server rendered" });
  f.controller.dispose();
});

it("keeps selection for a same-query hide and refresh until results return", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const response = deferred<SearchResult[]>();
  tauri.invoke.mockReset().mockImplementation((command: string) => command === "search_features" ? response.promise : Promise.resolve([]));
  const f = fixture("invoice");
  const selected = result("chosen");
  f.state.results = [result("first"), selected, result("third")];
  f.state.selectedIndex = 1;
  f.state.userSearchSelection = { plugin_id: selected.plugin_id, code: selected.code };

  await f.controller.setVisible(false);
  await f.controller.onQueryChange("invoice");
  expect(f.state.query).toBe("invoice");
  expect(f.state.results.map(item => item.code)).toEqual(["first", "chosen", "third"]);
  expect(f.state.selectedIndex).toBe(1);
  expect(tauri.invoke).not.toHaveBeenCalled();
  expect(f.sync).not.toHaveBeenCalled();

  const resumed = f.controller.setVisible(true);
  await flushMicrotasks();
  expect(f.state.query).toBe("invoice");
  expect(f.state.results.map(item => item.code)).toEqual(["first", "chosen", "third"]);
  expect(f.state.selectedIndex).toBe(1);
  expect(f.state.userSearchSelection).toEqual({ plugin_id: "fixture", code: "chosen" });
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  expect(tauri.invoke).toHaveBeenCalledTimes(1);
  expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: "invoice" });

  response.resolve([result("third"), result("chosen"), result("fresh")]);
  await flushMicrotasks();
  await resumed;
  expect(f.state.results.map(item => item.code)).toContain("fresh");
  expect(f.state.selectedIndex).toBe(f.state.results.findIndex(item => item.code === "chosen"));
  expect(f.state.userSearchSelection).toEqual({ plugin_id: "fixture", code: "chosen" });
  f.controller.dispose();
});

it("updates state.query while hidden and clears the old selection without publishing results", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  tauri.invoke.mockReset().mockResolvedValue([result("refreshed")]);
  const f = fixture("old query");
  f.state.results = [result("old selection")];
  f.state.userSearchSelection = { plugin_id: "fixture", code: "old selection" };
  f.state.selectedIndex = 0;
  await f.controller.setVisible(false);
  const syncAtHide = f.sync.mock.calls.length;

  await f.controller.onQueryChange("new query");
  expect(f.state.query).toBe("new query");
  expect(f.state.userSearchSelection).toBeNull();
  expect(f.state.results.map(item => item.code)).toEqual(["old selection"]);
  expect(f.sync).toHaveBeenCalledTimes(syncAtHide);
  expect(tauri.invoke).not.toHaveBeenCalled();

  const resumed = f.controller.setVisible(true);
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  await resumed;
  expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: "new query" });
  expect(f.state.results.map(item => item.code)).toContain("refreshed");
  expect(f.state.userSearchSelection).toBeNull();
  expect(f.state.selectedIndex).toBe(0);
  f.controller.dispose();
});

it("projects the new local query immediately when visibility returns offline", async () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  tauri.invoke.mockReset();
  const f = fixture("old query", false);
  f.state.results = [result("old-only")];
  f.state.selectedIndex = 0;
  f.state.userSearchSelection = { plugin_id: "fixture", code: "old-only" };
  await f.controller.setVisible(false);
  await f.controller.onQueryChange("new query");

  await f.controller.setVisible(true);

  expect(f.state.query).toBe("new query");
  expect(f.state.results.map(item => item.code)).toEqual(["local:new query"]);
  expect(f.state.results.map(item => item.code)).not.toContain("old-only");
  expect(f.state.userSearchSelection).toBeNull();
  expect(f.state.selectedIndex).toBe(0);
  expect(f.state.remoteSearchStatus).toBe("unavailable");
  expect(tauri.invoke).not.toHaveBeenCalled();
  f.controller.dispose();
});

it.each(["partial", "error"] as const)("does not treat hidden query change from %s as a same-query retry offline", async status => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  tauri.invoke.mockReset();
  const f = fixture("old query", false);
  f.state.results = [result("old-only")];
  f.state.remoteSearchStatus = status;
  f.state.searchError = status === "error" ? "previous failure" : "";
  f.state.userSearchSelection = { plugin_id: "fixture", code: "old-only" };
  await f.controller.setVisible(false);
  await f.controller.onQueryChange("new query");
  await f.controller.setVisible(true);

  expect(f.state.query).toBe("new query");
  expect(f.state.results.map(item => item.code)).toEqual(["local:new query"]);
  expect(f.state.results.map(item => item.code)).not.toContain("old-only");
  expect(f.state.remoteSearchStatus).toBe("unavailable");
  expect(f.state.userSearchSelection).toBeNull();
  expect(tauri.invoke).not.toHaveBeenCalled();
  f.controller.dispose();
});

it.each(["partial", "error"] as const)("keeps old results while an explicit same-query %s retry is pending", async status => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const response = deferred<SearchResult[]>();
  tauri.invoke.mockReset().mockImplementation(() => response.promise);
  const f = fixture("same query");
  f.state.results = [result("old-result")];
  f.state.remoteSearchStatus = status;

  const retry = f.controller.onQueryChange("same query");
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: "same query" });
  expect(f.state.results.map(item => item.code)).toEqual(["old-result"]);

  response.resolve([result("fresh-result")]);
  await flushMicrotasks();
  await retry;
  expect(f.state.results.map(item => item.code)).toContain("fresh-result");
  f.controller.dispose();
});

it.each([
  ["clear", ""],
  ["replace", "replacement query"],
] as const)("resumes from the current state.query after an external hidden %s", async (operation, currentQuery) => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  tauri.invoke.mockReset().mockResolvedValue([]);
  const f = fixture("old query");
  f.state.results = [result("old selection")];
  f.state.userSearchSelection = { plugin_id: "fixture", code: "old selection" };
  await f.controller.setVisible(false);
  f.state.query = currentQuery;

  const resumed = f.controller.setVisible(true);
  await vi.advanceTimersByTimeAsync(100);
  await flushMicrotasks();
  await resumed;

  expect(f.state.query).toBe(currentQuery);
  expect(f.state.userSearchSelection).toBeNull();
  if (operation === "clear") {
    expect(tauri.invoke).not.toHaveBeenCalled();
  } else {
    expect(tauri.invoke).toHaveBeenCalledTimes(1);
    expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: currentQuery });
  }
  f.controller.dispose();
});

it("uses the normal selection fallback when the restored results omit the selected identity", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const response = deferred<SearchResult[]>();
  tauri.invoke.mockReset().mockImplementation(() => response.promise);
  const f = fixture();
  f.state.query = "saved query";
  f.state.results = [result("other"), result("selected")];
  f.state.selectedIndex = 1;
  f.state.userSearchSelection = { plugin_id: "fixture", code: "selected" };
  await f.controller.setVisible(false);

  const resumed = f.controller.setVisible(true);
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  response.resolve([result("replacement")]);
  await flushMicrotasks();
  await resumed;

  expect(f.state.results.map(item => item.code)).toContain("replacement");
  expect(f.state.selectedIndex).toBe(0);
  expect(f.state.userSearchSelection).toEqual({ plugin_id: "fixture", code: "selected" });
  f.controller.dispose();
});

it("ignores source and icon responses that arrive after hiding", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const searchResponse = deferred<SearchResult[]>();
  const iconResponse = deferred<Record<string, string>>();
  tauri.invoke.mockReset().mockImplementation((command: string) => {
    if (command === "search_features") return searchResponse.promise;
    if (command === "load_local_app_icons") return iconResponse.promise;
    return Promise.resolve([]);
  });
  const f = fixture();
  const search = f.controller.onQueryChange("alpha");
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  expect(tauri.invoke).toHaveBeenCalledWith("search_features", { query: "alpha" });
  const appResult = { ...result("local-app:editor"), explain: "/Apps/Editor.app" };
  const iconRun = f.state.searchRunId;
  const icons = f.controller.hydrateLocalAppResultIcons(iconRun, "alpha", [appResult]);
  expect(tauri.invoke).toHaveBeenCalledWith("load_local_app_icons", { paths: ["/Apps/Editor.app"] });

  const syncAtHide = f.sync.mock.calls.length;
  const rowsAtHide = [...f.state.results];
  const statusAtHide = f.state.remoteSearchStatus;
  await f.controller.setVisible(false);
  const callsAtHide = tauri.invoke.mock.calls.length;
  await f.controller.hydrateLocalAppResultIcons(f.state.searchRunId, "alpha", [appResult]);
  expect(tauri.invoke).toHaveBeenCalledTimes(callsAtHide);
  searchResponse.resolve([result("too-late")]);
  iconResponse.resolve({ "/Apps/Editor.app": "icon:late" });
  await flushMicrotasks();
  await Promise.all([search, icons]);

  expect(f.state.results).toEqual(rowsAtHide);
  expect(f.state.remoteSearchStatus).toBe(statusAtHide);
  expect(f.sync).toHaveBeenCalledTimes(syncAtHide);
  f.controller.dispose();
});

it("does not refresh non-home, plugin, text, media, intake, or empty-query states", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  for (const context of ["settings", "plugin", "text", "media", "intake", "empty"] as const) {
    tauri.invoke.mockReset();
    const f = fixture();
    f.state.query = context === "empty" ? "" : "saved query";
    if (context === "settings") f.state.activePanel = "settings";
    if (context === "plugin") f.state.activePlugin = { id: "fixture" };
    if (context === "text") f.state.textMatch.content = "fixed text";
    if (context === "media") f.state.mediaMatch.content = { kind: "img", dataUrl: "data:image/png;base64," };
    if (context === "intake") f.state.mediaMatch.intakeKind = "files";
    await f.controller.setVisible(false);
    await f.controller.setVisible(true);
    await vi.advanceTimersByTimeAsync(100);
    await flushMicrotasks();
    expect(tauri.invoke, context).not.toHaveBeenCalled();
    f.controller.dispose();
  }
});

it("makes dispose and same-value visibility changes idempotent and prevents later work", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  tauri.invoke.mockReset();
  const f = fixture();
  await f.controller.setVisible(true);
  expect(f.state.searchRunId).toBe(0);
  await f.controller.setVisible(false);
  const hiddenRun = f.state.searchRunId;
  await f.controller.setVisible(false);
  expect(f.state.searchRunId).toBe(hiddenRun);
  await f.controller.onQueryChange("remember only");
  f.controller.dispose();
  const disposedRun = f.state.searchRunId;
  await f.controller.setVisible(true);
  await f.controller.onQueryChange("ignored");
  await f.controller.hydrateLocalAppResultIcons(disposedRun, "ignored", [{ ...result("local-app:x"), explain: "/Apps/X.app" }]);
  expect(f.state.query).toBe("remember only");
  expect(f.state.searchRunId).toBe(disposedRun);
  expect(tauri.invoke).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("lets the newest visible query win over an older in-flight request", async () => {
  vi.useFakeTimers();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const oldResponse = deferred<SearchResult[]>(), latestResponse = deferred<SearchResult[]>();
  tauri.invoke.mockReset().mockImplementation((command: string, args: { query?: string }) => {
    if (command !== "search_features") return Promise.resolve([]);
    return args.query === "old" ? oldResponse.promise : latestResponse.promise;
  });
  const f = fixture();
  const oldSearch = f.controller.onQueryChange("old");
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  const latestSearch = f.controller.onQueryChange("latest");
  await vi.advanceTimersByTimeAsync(16);
  await flushMicrotasks();
  latestResponse.resolve([result("latest-result")]);
  await flushMicrotasks();
  oldResponse.resolve([result("old-result")]);
  await Promise.all([oldSearch, latestSearch]);
  expect(f.state.query).toBe("latest");
  expect(f.state.results.map(item => item.code)).toContain("latest-result");
  expect(f.state.results.map(item => item.code)).not.toContain("old-result");
  f.controller.dispose();
});
