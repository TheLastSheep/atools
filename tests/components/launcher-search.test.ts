import { afterEach, describe, expect, it, vi } from "vitest";
import { enrichLauncherSearch, retainSearchIcons, resolveSearchSelection, searchSelectionIdentity, FEATURE_SEARCH_TIMEOUT_MS, LOCAL_APP_SEARCH_TIMEOUT_MS } from "../../src/lib/launcherSearch";
import type { SearchResult } from "../../src/lib/types";

const row = (code: string, score = 1, plugin_id = "test"): SearchResult => ({
  code, score, plugin_id, plugin_name: plugin_id, label: code, explain: "", icon: null, match_type: "exact",
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
afterEach(() => vi.useRealTimers());

function setup() {
  const features = deferred<SearchResult[]>();
  const apps = deferred<SearchResult[]>();
  let current = true;
  const onUpdate = vi.fn();
  const onApps = vi.fn();
  const options = {
    query: "test", localResults: [row("local", 5)], includeApps: true,
    searchFeatures: vi.fn(() => features.promise), searchApps: vi.fn(() => apps.promise),
    isCurrent: () => current, onUpdate, onApps,
  };
  return { features, apps, onUpdate, onApps, options, invalidate: () => { current = false; } };
}

describe("progressive launcher search", () => {
  it("reports which source succeeded or failed without inferring from error text", async () => {
    const f = setup();
    const done = enrichLauncherSearch(f.options);
    f.apps.resolve([row("app", 10)]);
    await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledTimes(1));
    expect(f.onUpdate.mock.calls[0][0].sourceStates).toEqual({ features: "pending", apps: "succeeded" });
    expect(f.onUpdate.mock.calls[0][0].sourceResults).toEqual({ features: [], apps: [row("app", 10)] });
    f.features.reject(new Error("source fixture"));
    await done;
    expect(f.onUpdate.mock.lastCall?.[0].sourceStates).toEqual({ features: "failed", apps: "succeeded" });
    expect(f.onUpdate.mock.lastCall?.[0].sourceResults).toEqual({ features: [], apps: [row("app", 10)] });
  });

  it("publishes fast apps while feature search is still pending, then merges by score", async () => {
    const f = setup();
    const done = enrichLauncherSearch(f.options);
    f.apps.resolve([row("app", 10)]);
    await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledTimes(1));
    expect(f.onUpdate.mock.calls[0][0].results.map((r: SearchResult) => r.code)).toEqual(["app", "local"]);
    expect(f.onUpdate.mock.calls[0][0].status).toBe("ready");
    f.features.resolve([row("feature", 8)]);
    await done;
    expect(f.onUpdate.mock.lastCall?.[0].results.map((r: SearchResult) => r.code)).toEqual(["app", "feature", "local"]);
    expect(f.onApps).toHaveBeenCalledWith([row("app", 10)]);
  });

  it("publishes features without waiting for slow app enrichment", async () => {
    const f = setup();
    const done = enrichLauncherSearch(f.options);
    f.features.resolve([row("feature")]);
    await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledTimes(1));
    f.apps.resolve([]);
    await done;
    expect(f.onUpdate.mock.calls[0][0].results).toHaveLength(2);
  });

  it("discards stale replies and icon hydration after navigation or a new query", async () => {
    const f = setup();
    const done = enrichLauncherSearch(f.options);
    f.invalidate();
    f.apps.resolve([row("old app")]);
    f.features.resolve([row("old feature")]);
    await done;
    expect(f.onUpdate).not.toHaveBeenCalled();
    expect(f.onApps).not.toHaveBeenCalled();
  });

  it("handles an immediately rejected background source and retains useful results", async () => {
    const f = setup();
    const done = enrichLauncherSearch(f.options);
    f.apps.reject(new Error("app search unavailable"));
    f.features.resolve([row("feature")]);
    await done;
    expect(f.onUpdate.mock.lastCall?.[0]).toMatchObject({ status: "partial", error: "Error: app search unavailable" });
    expect(f.onUpdate.mock.lastCall?.[0].results).toHaveLength(2);
  });

  it("starts both deadlines concurrently and preserves offline results on timeout", async () => {
    vi.useFakeTimers();
    const f = setup();
    const done = enrichLauncherSearch(f.options);
    await vi.advanceTimersByTimeAsync(FEATURE_SEARCH_TIMEOUT_MS);
    expect(f.onUpdate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LOCAL_APP_SEARCH_TIMEOUT_MS - FEATURE_SEARCH_TIMEOUT_MS);
    await done;
    expect(f.onUpdate.mock.lastCall?.[0]).toMatchObject({ status: "error", results: [row("local", 5)] });
    expect(f.onUpdate.mock.lastCall?.[0].error).toContain("本地应用搜索超过 1800ms");
    f.apps.resolve([row("too late")]);
    f.features.resolve([row("too late")]);
    await vi.runAllTimersAsync();
    expect(f.onUpdate).toHaveBeenCalledTimes(2);
  });

  it("does not announce an empty search while another source is pending", async () => {
    const f = setup();
    f.options.localResults = [];
    const done = enrichLauncherSearch(f.options);
    f.apps.resolve([]);
    await vi.waitFor(() => expect(f.onUpdate).toHaveBeenCalledTimes(1));
    expect(f.onUpdate.mock.lastCall?.[0].status).toBe("searching");
    f.features.reject(new Error("feature unavailable"));
    await done;
    expect(f.onUpdate.mock.lastCall?.[0]).toMatchObject({ status: "partial", error: "Error: feature unavailable" });
  });

  it("does not call disabled app search and catches synchronous native errors", async () => {
    const f = setup();
    await enrichLauncherSearch({ ...f.options, includeApps: false, searchFeatures: () => { throw new Error("native unavailable"); } });
    expect(f.options.searchApps).not.toHaveBeenCalled();
    expect(f.onUpdate.mock.lastCall?.[0]).toMatchObject({ status: "error", results: [row("local", 5)] });
    expect(f.onUpdate.mock.lastCall?.[0].sourceStates).toEqual({ features: "failed", apps: "not_requested" });
    expect(f.onUpdate.mock.lastCall?.[0].sourceResults.apps).toEqual([]);
  });
});

describe("selection across asynchronous enrichment", () => {
  it("defaults to the highest-ranked final result when only the automatic selection existed", () => {
    expect(resolveSearchSelection([row("new"), row("one"), row("two")], null)).toBe(0);
  });
  it("retains explicit selection by plugin and code when higher-ranked results arrive", () => {
    const intent = searchSelectionIdentity([row("one"), row("two", 1, "b")], 1);
    expect(resolveSearchSelection([row("new"), row("two", 1, "b"), row("two", 1, "a")], intent)).toBe(1);
  });
  it("returns to the first result if an explicit selection disappears", () => {
    expect(resolveSearchSelection([row("new")], searchSelectionIdentity([row("old")], 0))).toBe(0);
    expect(searchSelectionIdentity([], 5)).toBeNull();
  });
});

it("preserves hydrated icons without mixing plugins or replacing newer icons", () => {
  const previous = [{ ...row("app"), icon: "hydrated" }];
  const next = retainSearchIcons(previous, [row("app"), row("app", 1, "other"), { ...row("app"), icon: "fresh" }]);
  expect(next.map((item) => item.icon)).toEqual(["hydrated", null, "fresh"]);
});
