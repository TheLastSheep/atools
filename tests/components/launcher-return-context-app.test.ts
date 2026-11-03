import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { DIRECT_PLUGIN_LAUNCH_EVENT } from "../../src/lib/launcherDirectPluginLaunch";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import {
  createLauncherReturnContextSnapshot,
  createLauncherReturnContextStore,
  createLauncherReturnCoordinator,
} from "../../src/lib/launcherReturnContext";
import {
  alphaPlugin,
  betaPlugin,
  gammaPlugin,
  ordinaryPluginQuery,
  pluginActivationAction,
  returnSearchResults,
} from "./launcherReturnContextFixture";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, receive: (event: { payload: unknown }) => void) => {
    mocks.events.set(name, receive);
    return () => mocks.events.delete(name);
  }),
}));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));

let ordinarySearchCount: number;
let dropBetaOnReturn: boolean;
let deferNextExpand: boolean;
let releaseDeferredExpand: (() => void) | undefined;
let delayedActivation: { resolve: (value: ReturnType<typeof pluginActivationAction>) => void } | undefined;
let activationFailure: "reject" | "owner-changed" | undefined;
let delayRestoredSearch: boolean;
let releaseRestoredSearch: ((value: ReturnType<typeof returnSearchResults>) => void) | undefined;

beforeEach(() => {
  ordinarySearchCount = 0;
  dropBetaOnReturn = false;
  deferNextExpand = false;
  releaseDeferredExpand = undefined;
  delayedActivation = undefined;
  activationFailure = undefined;
  delayRestoredSearch = false;
  releaseRestoredSearch = undefined;
  mocks.events.clear();
  mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: false, autoPaste: "never", pluginEscapeToSearch: true }));
  mocks.invoke.mockImplementation((command: string, args?: { query?: string; code?: string }) => {
    if (command === "get_setting") return Promise.resolve(JSON.stringify({ localAppSearch: false, autoPaste: "never", pluginEscapeToSearch: true }));
    if (command === "feature_catalog" || command === "list_pending_agent_requests" || command === "search_local_apps") return Promise.resolve([]);
    if (command === "search_features") {
      if (args?.query === ordinaryPluginQuery) {
        const searchNumber = ++ordinarySearchCount;
        if (delayRestoredSearch && searchNumber > 1) {
          return new Promise(resolve => { releaseRestoredSearch = resolve; });
        }
        return Promise.resolve(returnSearchResults(searchNumber, dropBetaOnReturn));
      }
      if (args?.query === "新插件") return Promise.resolve([gammaPlugin]);
      if (args?.query === "Alpha 插件") return Promise.resolve([alphaPlugin]);
      return Promise.resolve([]);
    }
    if (command === "activate_feature") {
      const result = [alphaPlugin, betaPlugin, gammaPlugin].find(item => item.code === args?.code);
      if (!result) return Promise.reject(new Error(`unknown fixture plugin: ${args?.code}`));
      if (activationFailure === "reject") return Promise.reject(new Error("fixture activation failure"));
      if (activationFailure === "owner-changed") return Promise.resolve({ ...pluginActivationAction(result), plugin_id: "unexpected-owner" });
      if (result.code === "beta-entry" && delayedActivation) {
        return new Promise(resolve => { delayedActivation!.resolve = resolve; });
      }
      return Promise.resolve(pluginActivationAction(result));
    }
    if (command === "expand_window" && deferNextExpand) {
      deferNextExpand = false;
      return new Promise<void>(resolve => { releaseDeferredExpand = resolve; });
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function renderLauncher() {
  render(App, { backgroundServices: false });
  await vi.waitFor(() => expect(mocks.events.has(DIRECT_PLUGIN_LAUNCH_EVENT)).toBe(true));
  return screen.getByRole("combobox");
}

async function openSelectedPlugin(query = ordinaryPluginQuery, index = 0) {
  const input = await renderLauncher();
  await fireEvent.input(input, { target: { value: query } });
  const options = await screen.findAllByRole("option");
  for (let step = 0; step < index; step += 1) await fireEvent.keyDown(input, { key: "ArrowDown" });
  const selected = options.find(option => option.getAttribute("aria-selected") === "true");
  expect(selected).toBeTruthy();
  await fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("banner", { name: "插件导航" }, { timeout: 10_000 });
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')).toBeTruthy(), { timeout: 10_000 });
  return { input, selected };
}

async function returnWithButton() {
  await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
  return screen.findByRole("combobox");
}

it("restores the ordinary query and selected plugin identity after reranking, so keyboard switching continues", async () => {
  const { selected } = await openSelectedPlugin(ordinaryPluginQuery, 1);
  expect(selected?.getAttribute("data-plugin-id")).toBe(betaPlugin.plugin_id);

  const input = await returnWithButton();
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery));
  const beta = await screen.findByRole("option", { name: /Beta 插件/ });
  await waitFor(() => expect(beta.getAttribute("aria-selected")).toBe("true"));
  await waitFor(() => expect(ordinarySearchCount).toBe(2));

  await fireEvent.keyDown(input, { key: "ArrowDown" });
  const alpha = screen.getByRole("option", { name: /Alpha 插件/ });
  expect(alpha.getAttribute("aria-selected")).toBe("true");
  await fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("banner", { name: "插件导航" });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature").at(-1)?.[1])
    .toEqual(expect.objectContaining({ code: alphaPlugin.code, expectedPluginId: alphaPlugin.plugin_id }));
});

it("restores the saved selection on Escape return and falls back to the first result when it disappeared", async () => {
  dropBetaOnReturn = true;
  await openSelectedPlugin(ordinaryPluginQuery, 1);
  await fireEvent.keyDown(window, { key: "Escape" });

  const input = await screen.findByRole("combobox");
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery));
  await waitFor(() => expect(ordinarySearchCount).toBe(2));
  const alpha = await screen.findByRole("option", { name: /Alpha 插件/ });
  await waitFor(() => expect(alpha.getAttribute("aria-selected")).toBe("true"));
  expect(screen.queryByRole("option", { name: /Beta 插件/ })).toBeNull();
});

it("ignores an activation whose search changed before commit and saves the current query on the next open", async () => {
  delayedActivation = { resolve: () => {} };
  const input = await renderLauncher();
  await fireEvent.input(input, { target: { value: ordinaryPluginQuery } });
  await screen.findAllByRole("option");
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(delayedActivation?.resolve).toBeTypeOf("function"));

  await fireEvent.input(input, { target: { value: "新插件" } });
  await screen.findByRole("option", { name: /Gamma 插件/ });
  delayedActivation.resolve(pluginActivationAction(betaPlugin));
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.getByRole("combobox")).toBe(input);
  expect((input as HTMLInputElement).value).toBe("新插件");
  expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  delayedActivation = undefined;
  await fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("banner", { name: "插件导航" });
  const restored = await returnWithButton();
  await waitFor(() => expect((restored as HTMLInputElement).value).toBe("新插件"));
  expect(screen.getByRole("option", { name: /Gamma 插件/ })).toBeTruthy();
});

it("keeps the normal activation failure feedback and stays in search without saving a return context", async () => {
  activationFailure = "reject";
  const input = await renderLauncher();
  await fireEvent.input(input, { target: { value: ordinaryPluginQuery } });
  await screen.findAllByRole("option");
  await fireEvent.keyDown(input, { key: "Enter" });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("插件未能打开，请检查插件状态后重试");
  expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
  expect(screen.getByRole("combobox")).toBe(input);
});

it("keeps the owner-change feedback when activation returns a different plugin", async () => {
  activationFailure = "owner-changed";
  const input = await renderLauncher();
  await fireEvent.input(input, { target: { value: ordinaryPluginQuery } });
  await screen.findAllByRole("option");
  await fireEvent.keyDown(input, { key: "Enter" });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("此功能的来源已变化，请刷新后重新打开。");
  expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
  expect(screen.getByRole("combobox")).toBe(input);
});

it("clears the prior ordinary search when a native direct-launch event opens another plugin", async () => {
  await openSelectedPlugin(ordinaryPluginQuery, 0);
  mocks.events.get(DIRECT_PLUGIN_LAUNCH_EVENT)?.({ payload: { code: betaPlugin.code, pluginId: betaPlugin.plugin_id } });
  await waitFor(() => expect(screen.getByRole("banner").textContent).toContain("Beta 插件"));
  await waitFor(() => expect(document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')?.srcdoc).toContain("Beta 插件"));

  const input = await returnWithButton();
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(""));
  expect(screen.queryByRole("option")).toBeNull();
});

it("preserves the original query and selection across a plugin frame redirect", async () => {
  await openSelectedPlugin(ordinaryPluginQuery, 1);
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  expect(frame?.contentWindow).toBeTruthy();
  const webContentsId = Number(frame?.srcdoc.match(/webContentsId:\s*(\d+)/)?.[1]);
  expect(webContentsId).toBeGreaterThan(0);
  const documentNonce = "a".repeat(32);
  await fireEvent(window, new MessageEvent("message", {
    source: frame?.contentWindow,
    data: { __atools_hosted_ipc_document__: true, webContentsId, documentNonce, phase: "open" },
  }));
  await fireEvent(window, new MessageEvent("message", {
    source: frame?.contentWindow,
    data: { __atools_native_call__: true, reqId: 78, method: "redirect", hostedDocumentNonce: documentNonce, args: { label: "Alpha 插件" } },
  }));
  await screen.findByText("Alpha 插件");
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')).toBeTruthy());

  const input = await returnWithButton();
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery));
  const beta = await screen.findByRole("option", { name: /Beta 插件/ });
  await waitFor(() => expect(beta.getAttribute("aria-selected")).toBe("true"));
});

it("focuses the restored input before remote search settles and ignores its stale response after a new query", async () => {
  await openSelectedPlugin(ordinaryPluginQuery, 0);
  delayRestoredSearch = true;
  const input = await returnWithButton();
  await vi.waitFor(() => expect(releaseRestoredSearch).toBeTypeOf("function"));
  await waitFor(() => expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery));
  await waitFor(() => expect(document.activeElement).toBe(input));

  await fireEvent.input(input, { target: { value: "新插件" } });
  const gamma = await screen.findByRole("option", { name: /Gamma 插件/ });
  await waitFor(() => expect(gamma.getAttribute("aria-selected")).toBe("true"));
  releaseRestoredSearch?.([betaPlugin, alphaPlugin]);

  await waitFor(() => expect((input as HTMLInputElement).value).toBe("新插件"));
  expect(gamma.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(input);
});

it("re-requests launcher focus after resize when the transition moved focus off the restored input", async () => {
  await openSelectedPlugin(ordinaryPluginQuery, 0);
  deferNextExpand = true;
  await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
  await vi.waitFor(() => expect(releaseDeferredExpand).toBeTypeOf("function"));

  const input = screen.getByRole("combobox");
  (input as HTMLInputElement).blur();
  expect(document.activeElement).not.toBe(input);
  releaseDeferredExpand?.();
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery);
});

it("does not let a pending old return replace or steal focus from a newly opened plugin", async () => {
  await openSelectedPlugin(ordinaryPluginQuery, 0);
  deferNextExpand = true;
  await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
  await vi.waitFor(() => expect(releaseDeferredExpand).toBeTypeOf("function"));

  const input = await screen.findByRole("combobox");
  await fireEvent.input(input, { target: { value: "新插件" } });
  await screen.findByRole("option", { name: /Gamma 插件/ });
  await fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("banner", { name: "插件导航" }, { timeout: 10_000 });
  await waitFor(() => expect(document.querySelector('iframe[title="Plugin"]')).toBeTruthy(), { timeout: 10_000 });
  const newPluginTitle = screen.getByText("Gamma 插件");
  releaseDeferredExpand?.();

  await waitFor(() => expect(screen.getByText("Gamma 插件")).toBe(newPluginTitle));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(document.activeElement).not.toBe(input);
});

it("keeps a newer query when it changes while the return resize is pending", async () => {
  await openSelectedPlugin(ordinaryPluginQuery, 0);
  deferNextExpand = true;
  await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
  await vi.waitFor(() => expect(releaseDeferredExpand).toBeTypeOf("function"));

  const input = await screen.findByRole("combobox");
  await fireEvent.input(input, { target: { value: "新插件" } });
  const gamma = await screen.findByRole("option", { name: /Gamma 插件/ });
  releaseDeferredExpand?.();

  await waitFor(() => expect((input as HTMLInputElement).value).toBe("新插件"));
  expect(screen.getByRole("option", { name: /Gamma 插件/ })).toBe(gamma);
  expect(document.activeElement).toBe(input);
  expect(ordinarySearchCount).toBe(1);
});

it.each(["button", "Escape"] as const)(
  "keeps the cached query and Beta selection visible while %s return waits for expansion",
  async entry => {
    await openSelectedPlugin(ordinaryPluginQuery, 1);
    deferNextExpand = true;
    if (entry === "button") await fireEvent.click(screen.getByRole("button", { name: "返回搜索" }));
    else await fireEvent.keyDown(window, { key: "Escape" });
    await vi.waitFor(() => expect(releaseDeferredExpand).toBeTypeOf("function"));

    const input = screen.getByRole("combobox");
    const beta = screen.getByRole("option", { name: /Beta 插件/ });
    expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery);
    expect(beta.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(input);
    expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
    expect(screen.queryByText("最近使用")).toBeNull();
    expect(ordinarySearchCount).toBe(1);

    releaseDeferredExpand?.();
    await vi.waitFor(() => expect(ordinarySearchCount).toBe(2));
    await waitFor(() => expect(screen.getByRole("option", { name: /Beta 插件/ }).getAttribute("aria-selected")).toBe("true"));
    expect(ordinarySearchCount).toBe(2);
  },
);

it("does not resize or refresh after a newer query arrives during the awaited focus tick", async () => {
  let releaseFocus: (() => void) | undefined;
  let query = "";
  let activePlugin: string | null = "beta";
  let activePanel = "plugin";
  let searchRunId = 4;
  let activation = 1;
  const store = createLauncherReturnContextStore();
  const context = createLauncherReturnContextSnapshot({
    query: ordinaryPluginQuery,
    selection: { plugin_id: betaPlugin.plugin_id, code: betaPlugin.code },
    results: returnSearchResults(1),
    remoteSearchStatus: "ready",
    searchError: "",
  });
  expect(context).not.toBeNull();
  expect(store.capture(context!)).toBe(true);
  const resize = vi.fn(async () => {});
  const refresh = vi.fn(async () => {});
  const coordinator = createLauncherReturnCoordinator(store, {
    getActivePlugin: () => activePlugin,
    getActivePanel: () => activePanel,
    getQuery: () => query,
    getSearchRunId: () => searchRunId,
    closePromoted: async () => {},
    advanceSearchRun: () => ++searchRunId,
    cancelActivation: () => { activation++; },
    captureActivation: () => activation,
    isActivationCurrent: value => value === activation,
    enterHome: () => { activePlugin = null; activePanel = "home"; },
    clearSearch: () => { query = ""; },
    restoreSnapshot: snapshot => { query = snapshot.query; },
    refresh,
    restoreSelection: () => {},
    focusSearch: () => new Promise<void>(resolve => { releaseFocus = resolve; }),
    resize,
    onRefreshError: () => {},
  });

  const pendingReturn = coordinator.returnToSearch();
  await vi.waitFor(() => expect(releaseFocus).toBeTypeOf("function"));
  query = "新插件";
  searchRunId++;
  releaseFocus?.();
  await pendingReturn;

  expect(resize).not.toHaveBeenCalled();
  expect(refresh).not.toHaveBeenCalled();
  coordinator.dispose();
});

it("keeps query and selection when the cached result list exceeds its snapshot budget", async () => {
  const results = [
    ...returnSearchResults(1),
    ...Array.from({ length: 1199 }, (_, index) => ({
      ...alphaPlugin,
      code: `extra-${index}`,
      plugin_id: "extra-plugin",
      label: `额外插件 ${index}`,
    })),
  ];
  const snapshot = createLauncherReturnContextSnapshot({
    query: ordinaryPluginQuery,
    selection: { plugin_id: betaPlugin.plugin_id, code: betaPlugin.code },
    results,
    remoteSearchStatus: "ready",
    searchError: "",
  });
  expect(snapshot?.results).toBeNull();
  const store = createLauncherReturnContextStore();
  expect(store.capture(snapshot!)).toBe(true);
  let query = "";
  let selection = { plugin_id: "", code: "" };
  let runId = 0;
  let activePlugin: string | null = "beta";
  let activePanel = "plugin";
  let activation = 0;
  let resized = false;
  const refresh = vi.fn(async () => {});
  const coordinator = createLauncherReturnCoordinator(store, {
    getActivePlugin: () => activePlugin,
    getActivePanel: () => activePanel,
    getQuery: () => query,
    getSearchRunId: () => runId,
    closePromoted: async () => {},
    advanceSearchRun: () => ++runId,
    cancelActivation: () => { activation++; },
    captureActivation: () => activation,
    isActivationCurrent: value => value === activation,
    enterHome: () => { activePlugin = null; activePanel = "home"; },
    clearSearch: () => { query = ""; },
    restoreSnapshot: context => { query = context.query; selection = { ...context.selection }; },
    refresh: queryToRefresh => { expect(queryToRefresh).toBe(ordinaryPluginQuery); return refresh(); },
    restoreSelection: value => { selection = { ...value }; },
    focusSearch: () => {},
    resize: async () => { resized = true; },
    onRefreshError: () => {},
  });

  await coordinator.returnToSearch();

  expect(resized).toBe(true);
  expect(query).toBe(ordinaryPluginQuery);
  expect(selection).toEqual({ plugin_id: betaPlugin.plugin_id, code: betaPlugin.code });
  expect(refresh).toHaveBeenCalledTimes(1);
  coordinator.dispose();
});
