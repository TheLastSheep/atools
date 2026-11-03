import { expect, it, vi } from "vitest";
import {
  createLauncherReturnContextSnapshot,
  createLauncherReturnContextStore,
  createLauncherReturnCoordinator,
  type LauncherReturnContext,
} from "../../src/lib/launcherReturnContext";
import { alphaPlugin, ordinaryPluginQuery, returnSearchResults } from "./launcherReturnContextFixture";

function returnHarness() {
  let query = "";
  let activePlugin: string | null = "plugin";
  let activePanel = "plugin";
  let searchRunId = 7;
  let activation = 1;
  const sequence: string[] = [];
  const store = createLauncherReturnContextStore();
  const snapshot = createLauncherReturnContextSnapshot({
    query: ordinaryPluginQuery,
    selection: { plugin_id: alphaPlugin.plugin_id, code: alphaPlugin.code },
    results: returnSearchResults(1),
    remoteSearchStatus: "ready",
    searchError: "",
  });
  if (!snapshot || !store.capture(snapshot)) throw new Error("fixture snapshot failed");
  const refresh = vi.fn(async () => { sequence.push("refresh"); });
  const ports = {
    getActivePlugin: () => activePlugin,
    getActivePanel: () => activePanel,
    getQuery: () => query,
    getSearchRunId: () => searchRunId,
    closePromoted: async () => { sequence.push("close"); },
    advanceSearchRun: () => { sequence.push("advance"); return ++searchRunId; },
    cancelActivation: () => { activation++; },
    captureActivation: () => activation,
    isActivationCurrent: (value: number) => value === activation,
    enterHome: () => { activePlugin = null; activePanel = "home"; sequence.push("home"); },
    clearSearch: () => { query = ""; },
    restoreSnapshot: (value: LauncherReturnContext) => { query = value.query; sequence.push("restore"); },
    refresh,
    restoreSelection: () => {},
    focusSearch: () => { sequence.push("focus"); },
    resize: async () => { sequence.push("resize"); },
    onRefreshError: () => {},
  };
  const coordinator = createLauncherReturnCoordinator(store, ports);
  return {
    coordinator, ports, sequence, refresh,
    state: {
      query: () => query,
      setQuery: (value: string) => { query = value; },
      setActivePlugin: (value: string | null) => { activePlugin = value; },
      setActivePanel: (value: string) => { activePanel = value; },
      advanceSearchRun: () => { searchRunId++; },
      advanceActivation: () => { activation++; },
    },
  };
}

it("retries focus after resize so a transition-time missed focus can claim the restored input", async () => {
  let canClaimInput = false;
  let inputFocused = false;
  const harness = returnHarness();
  harness.ports.focusSearch = () => {
    harness.sequence.push("focus");
    if (canClaimInput) inputFocused = true;
  };
  harness.ports.resize = async () => {
    harness.sequence.push("resize");
    canClaimInput = true;
  };

  await harness.coordinator.returnToSearch();

  expect(harness.sequence).toEqual(["close", "advance", "home", "restore", "focus", "resize", "focus", "refresh"]);
  expect(inputFocused).toBe(true);
  expect(harness.state.query()).toBe(ordinaryPluginQuery);
  harness.coordinator.dispose();
});

it("does not issue the post-resize focus request after a newer activation supersedes the return", async () => {
  let releaseResize: (() => void) | undefined;
  let focusCount = 0;
  const harness = returnHarness();
  harness.ports.focusSearch = () => { focusCount++; };
  harness.ports.resize = () => new Promise<void>(resolve => { releaseResize = resolve; });

  const pending = harness.coordinator.returnToSearch();
  await vi.waitFor(() => expect(releaseResize).toBeTypeOf("function"));
  harness.coordinator.invalidate();
  harness.state.setActivePlugin("new-plugin");
  harness.state.setActivePanel("plugin");
  harness.state.advanceSearchRun();
  releaseResize?.();
  await pending;

  expect(focusCount).toBe(1);
  expect(harness.refresh).not.toHaveBeenCalled();
  harness.coordinator.dispose();
});


it("does not refresh or restore an old selection when a new intent arrives during post-resize focus", async () => {
  let focusCount = 0;
  let releasePostResizeFocus: (() => void) | undefined;
  const harness = returnHarness();
  const restoreSelection = vi.fn();
  harness.ports.restoreSelection = restoreSelection;
  harness.ports.focusSearch = () => {
    focusCount++;
    if (focusCount === 2) return new Promise<void>(resolve => { releasePostResizeFocus = resolve; });
  };

  const pendingReturn = harness.coordinator.returnToSearch();
  await vi.waitFor(() => expect(releasePostResizeFocus).toBeTypeOf("function"));
  harness.state.setQuery("new query");
  harness.state.advanceSearchRun();
  harness.state.advanceActivation();
  releasePostResizeFocus?.();
  await pendingReturn;

  expect(focusCount).toBe(2);
  expect(harness.refresh).not.toHaveBeenCalled();
  expect(restoreSelection).not.toHaveBeenCalled();
  harness.coordinator.dispose();
});
