import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { DIRECT_PLUGIN_LAUNCH_EVENT } from "../../src/lib/launcherDirectPluginLaunch";
import { DEFAULT_ATOOLS_SETTINGS, dispatchAToolsSettings, SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import { alphaPlugin, betaPlugin, ordinaryPluginQuery, pluginActivationAction } from "./launcherReturnContextFixture";

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

let searchCalls = 0;
let deferRetry = false;
let releaseRetry: ((results: typeof alphaPlugin[]) => Promise<void>) | undefined;
let ordinaryResults: typeof alphaPlugin[] = [];
let partialScenario = false;
let partialQuery = "partial query";
let partialFeatureReject = false;
let partialFeatureResults: typeof alphaPlugin[] = [];
let partialFeatureDeferred = false;
let releasePartialFeature: ((results: typeof alphaPlugin[]) => void) | undefined;
let partialAppReject = false;
let partialAppResults: typeof alphaPlugin[] = [];
let featureCatalogRows: typeof alphaPlugin[] = [];

beforeEach(() => {
  searchCalls = 0;
  deferRetry = false;
  releaseRetry = undefined;
  ordinaryResults = [alphaPlugin, betaPlugin];
  partialScenario = false;
  partialQuery = "partial query";
  partialFeatureReject = false;
  partialFeatureResults = [];
  partialFeatureDeferred = false;
  releasePartialFeature = undefined;
  partialAppReject = false;
  partialAppResults = [];
  featureCatalogRows = [];
  mocks.events.clear();
  mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: false, autoPaste: "never", showRecentInSearch: false, pluginEscapeToSearch: true }));
  mocks.invoke.mockImplementation((command: string, args?: { query?: string; code?: string }) => {
    if (command === "get_setting") return Promise.resolve(localStorage.getItem(SETTINGS_STORAGE_KEY));
    if (command === "feature_catalog") return Promise.resolve(featureCatalogRows);
    if (command === "list_pending_agent_requests") return Promise.resolve([]);
    if (command === "load_local_app_icons") return Promise.resolve({});
    if (command === "search_local_apps") {
      if (partialScenario && partialAppReject) return Promise.reject(new Error("fixture app search unavailable"));
      if (partialScenario) return Promise.resolve(partialAppResults);
      return Promise.resolve([]);
    }
    if (command === "search_text_content_features") return Promise.resolve([]);
    if (command === "search_file_content_features") return Promise.resolve({ files: [{ path: "/tmp/retry-fixture.pdf", name: "retry-fixture.pdf", isFile: true, isDirectory: false }], results: [] });
    if (command === "search_features") {
      searchCalls += 1;
      if (partialScenario && args?.query === partialQuery) {
        if (partialFeatureDeferred) return new Promise(resolve => { releasePartialFeature = resolve; });
        if (partialFeatureReject) return Promise.reject(new Error("fixture feature search unavailable"));
        return Promise.resolve(partialFeatureResults);
      }
      if (args?.query === ordinaryPluginQuery && searchCalls === 1) return Promise.reject(new Error("fixture search offline"));
      if (deferRetry && args?.query === ordinaryPluginQuery) return new Promise(resolve => {
        releaseRetry = async results => {
          resolve(results);
          await Promise.resolve();
          await Promise.resolve();
          await tick();
        };
      });
      if (args?.query === "new query") return Promise.resolve([alphaPlugin]);
      return Promise.resolve(ordinaryResults);
    }
    if (command === "activate_feature") {
      const selected = [alphaPlugin, betaPlugin].find(item => item.code === args?.code);
      return selected ? Promise.resolve(pluginActivationAction(selected)) : Promise.reject(new Error("unknown fixture plugin"));
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function setup() {
  render(App, { backgroundServices: false });
  await vi.waitFor(() => expect(mocks.events.has(DIRECT_PLUGIN_LAUNCH_EVENT)).toBe(true));
  return screen.getByRole("combobox") as HTMLInputElement;
}

async function enterQuery(input: HTMLInputElement, value: string) {
  await fireEvent.input(input, { target: { value } });
}

function paste(input: HTMLInputElement, files: File[] = [], text = "") {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, getData: () => text } });
  input.dispatchEvent(event);
  return event;
}

it("retries the same failed query once, then opens and returns with selection and focus", async () => {
  deferRetry = true;
  const input = await setup();
  await enterQuery(input, ordinaryPluginQuery);
  await screen.findByText("重试搜索", { exact: true });
  expect(searchCalls).toBe(1);
  expect(document.activeElement).toBe(input);

  const emptyErrorTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(emptyErrorTab);
  expect(emptyErrorTab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(input);

  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  await fireEvent.keyDown(input, { key: "Enter" });
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(searchCalls).toBe(2);

  deferRetry = false;
  releaseRetry?.([alphaPlugin, betaPlugin]);
  const beta = await screen.findByRole("option", { name: /Beta 插件/ });
  expect(screen.getByRole("option", { name: /Alpha 插件/ }).getAttribute("aria-selected")).toBe("true");
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(beta.getAttribute("aria-selected")).toBe("true");
  await fireEvent.keyDown(input, { key: "Enter" });
  await screen.findByRole("banner", { name: "插件导航" }, { timeout: 10_000 });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature").at(-1)?.[1])
    .toEqual(expect.objectContaining({ code: betaPlugin.code, expectedPluginId: betaPlugin.plugin_id }));
  // The saved snapshot can render Beta before the post-resize refresh reaches IPC.
  // Change the fixture's authoritative response so this test observes that refresh.
  ordinaryResults = [betaPlugin];
  await fireEvent.keyDown(window, { key: "Escape" });
  const restored = await screen.findByRole("combobox");
  await waitFor(() => expect((restored as HTMLInputElement).value).toBe(ordinaryPluginQuery));
  await vi.waitFor(() => expect(searchCalls).toBe(3));
  await waitFor(() => expect(screen.queryByRole("option", { name: /Alpha 插件/ })).toBeNull());
  const refreshedBeta = await screen.findByRole("option", { name: /Beta 插件/ });
  expect((restored as HTMLInputElement).value).toBe(ordinaryPluginQuery);
  await waitFor(() => expect(refreshedBeta.getAttribute("aria-selected")).toBe("true"));
  expect(document.activeElement).toBe(restored);
  expect(searchCalls).toBe(3);
});

it("does not retry an ordinary successful empty search or add a misleading Enter footer action", async () => {
  ordinaryResults = [];
  const input = await setup();
  await enterQuery(input, "nothing matched");
  await screen.findByText(/没有找到匹配/);
  expect(screen.queryByText("重试搜索", { exact: true })).toBeNull();
  expect(screen.queryByText("执行首项", { exact: true })).toBeNull();
  expect(searchCalls).toBe(1);
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(searchCalls).toBe(1);
});

it("does not retry after a newer query supersedes the pending retry", async () => {
  deferRetry = true;
  const input = await setup();
  await enterQuery(input, ordinaryPluginQuery);
  await screen.findByText("重试搜索", { exact: true });
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  deferRetry = false;
  await enterQuery(input, "new query");
  await screen.findByRole("option", { name: /Alpha 插件/ });
  await vi.waitFor(() => expect(releaseRetry).toBeTypeOf("function"));
  await releaseRetry?.([betaPlugin]);
  await tick();
  const currentAlpha = screen.getByRole("option", { name: /Alpha 插件/ });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.queryByRole("option", { name: /Beta 插件/ })).toBeNull();
  await waitFor(() => expect(input.value).toBe("new query"));
  expect(currentAlpha.getAttribute("aria-selected")).toBe("true");
  expect(document.activeElement).toBe(input);
  expect(searchCalls).toBe(3);
});

it("does not treat composition or modifier Enter as a retry action", async () => {
  const input = await setup();
  await enterQuery(input, ordinaryPluginQuery);
  await screen.findByText("重试搜索", { exact: true });
  for (const event of [
    { key: "Enter", isComposing: true },
    { key: "Enter", keyCode: 229 },
    { key: "Enter", shiftKey: true },
    { key: "Enter", ctrlKey: true },
    { key: "Enter", altKey: true },
    { key: "Enter", metaKey: true },
  ]) await fireEvent.keyDown(input, event);
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  document.body.append(dialog);
  await fireEvent.keyDown(input, { key: "Enter" });
  dialog.remove();
  input.blur();
  await fireEvent.keyDown(window, { key: "Enter" });
  expect(searchCalls).toBe(1);
});

it("retains current selection during partial retry and drops stale retries after the query changes", async () => {
  partialScenario = true;
  partialFeatureReject = true;
  const localApp = { ...alphaPlugin, code: "local-app:/Applications/Terminal.app", plugin_id: "local-apps",
    plugin_name: "本地应用", label: "Terminal", score: 100 };
  const secondLocalApp = { ...localApp, code: "local-app:/Applications/Preview.app", label: "Preview", score: 75 };
  partialAppResults = [localApp, secondLocalApp];
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  const retry = await screen.findByRole("button", { name: "重试搜索" });
  const terminal = await screen.findByRole("option", { name: /Terminal/ });
  expect(terminal.getAttribute("aria-selected")).toBe("true");
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  const preview = screen.getByRole("option", { name: /Preview/ });
  expect(preview.getAttribute("aria-selected")).toBe("true");

  partialFeatureReject = false;
  partialFeatureResults = [betaPlugin];
  partialAppReject = true;
  partialFeatureDeferred = true;
  await fireEvent.click(retry);
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  expect(screen.getByRole("status").textContent).toContain("正在补充插件结果");
  await waitFor(() => expect(screen.getByRole("option", { name: /Preview/ }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("option", { name: /Terminal/ })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();

  partialFeatureDeferred = false;
  releasePartialFeature?.([betaPlugin]);
  await screen.findByRole("option", { name: /Beta 插件/ });
  await waitFor(() => expect(screen.getByRole("option", { name: /Preview/ }).getAttribute("aria-selected")).toBe("true"));
  expect(screen.getByRole("button", { name: "重试搜索" })).toBeTruthy();

  partialFeatureDeferred = true;
  await fireEvent.click(screen.getByRole("button", { name: "重试搜索" }));
  await vi.waitFor(() => expect(searchCalls).toBe(3));
  await enterQuery(input, "new query");
  await screen.findByRole("option", { name: /Alpha 插件/ });
  await waitFor(() => expect(input.value).toBe("new query"));
  releasePartialFeature?.([betaPlugin]);
  await tick();
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: /Alpha 插件/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /Beta 插件/ })).toBeNull();
  expect(searchCalls).toBe(4);
});

it("replaces results from a successful source while keeping rows from the source that failed again", async () => {
  partialScenario = true;
  partialFeatureResults = [alphaPlugin];
  partialAppReject = true;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  await screen.findByRole("option", { name: /Alpha 插件/ });
  await screen.findByRole("button", { name: "重试搜索" });

  partialFeatureResults = [betaPlugin];
  await fireEvent.click(screen.getByRole("button", { name: "重试搜索" }));
  await screen.findByRole("option", { name: /Beta 插件/ });
  await waitFor(() => expect(screen.queryByRole("option", { name: /Alpha 插件/ })).toBeNull());
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "重试搜索" })).toBeTruthy();
  expect(input.value).toBe(partialQuery);
});

it("keeps a failed feature by explicit source provenance even when its code resembles a local app", async () => {
  partialScenario = true;
  const customFeature = { ...alphaPlugin, code: "local-app:custom", plugin_id: "custom-feature-plugin",
    plugin_name: "第三方插件", label: "Custom feature", score: 90 };
  partialFeatureResults = [customFeature];
  partialAppReject = true;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  await screen.findByRole("option", { name: /Custom feature/ });
  await screen.findByRole("button", { name: "重试搜索" });

  partialFeatureReject = true;
  partialAppReject = false;
  partialAppResults = [];
  await fireEvent.click(screen.getByRole("button", { name: "重试搜索" }));
  const retainedFeature = await screen.findByRole("option", { name: /Custom feature/ });
  await screen.findByRole("button", { name: "重试搜索" });
  expect(retainedFeature.getAttribute("data-result-code")).toBe("local-app:custom");
  expect(retainedFeature.getAttribute("data-plugin-id")).toBe("custom-feature-plugin");
  expect(input.value).toBe(partialQuery);
});

it("moves positive Tab from search to the current partial-results retry action without activating a row", async () => {
  partialScenario = true;
  partialFeatureResults = [alphaPlugin];
  partialAppReject = true;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true, tabKeyFunction: "navigate" }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  const retry = await screen.findByRole("button", { name: "重试搜索" });
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(retry);

  await fireEvent.click(retry);
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(0);
  await screen.findByRole("button", { name: "重试搜索" });
  expect(document.activeElement).toBe(input);
});

it("lets Shift+Tab reach retry in both modes while positive target Tab still launches its configured command", async () => {
  partialScenario = true;
  partialFeatureResults = [alphaPlugin];
  partialAppReject = true;
  featureCatalogRows = [alphaPlugin];
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true, tabKeyFunction: "target-command",
    tabTarget: { pluginId: alphaPlugin.plugin_id, code: alphaPlugin.code, label: alphaPlugin.label } }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  let retry = await screen.findByRole("button", { name: "重试搜索" });

  const reverseTargetMode = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(reverseTargetMode);
  expect(reverseTargetMode.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(retry);
  await fireEvent.click(retry);
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  retry = await screen.findByRole("button", { name: "重试搜索" });

  dispatchAToolsSettings({ ...DEFAULT_ATOOLS_SETTINGS, localAppSearch: true, showRecentInSearch: false,
    tabKeyFunction: "navigate" });
  await tick();
  input.focus();
  const reverseNavigateMode = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
  input.dispatchEvent(reverseNavigateMode);
  expect(reverseNavigateMode.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(retry);

  input.focus();
  const forwardNavigateMode = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(forwardNavigateMode);
  expect(forwardNavigateMode.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(retry);

  input.focus();
  dispatchAToolsSettings({ ...DEFAULT_ATOOLS_SETTINGS, localAppSearch: true, showRecentInSearch: false,
    tabKeyFunction: "target-command", tabTarget: { pluginId: alphaPlugin.plugin_id, code: alphaPlugin.code, label: alphaPlugin.label } });
  await tick();
  const forwardTargetMode = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(forwardTargetMode);
  expect(forwardTargetMode.defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(1));
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")[0][1])
    .toEqual(expect.objectContaining({ code: alphaPlugin.code, expectedPluginId: alphaPlugin.plugin_id }));
  expect(searchCalls).toBe(2);
});

it("returns focus from a retry action to search when its query becomes stale", async () => {
  partialScenario = true;
  partialFeatureResults = [alphaPlugin];
  partialAppReject = true;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  const retry = await screen.findByRole("button", { name: "重试搜索" });
  retry.focus();
  expect(document.activeElement).toBe(retry);
  partialAppReject = false;
  await enterQuery(input, "new query");
  await screen.findByRole("option", { name: /Alpha 插件/ });
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "activate_feature")).toHaveLength(0);
});

it("leaves Tab alone while the partial search is loading or keyboard input is guarded", async () => {
  partialScenario = true;
  const localResult = { ...alphaPlugin, code: "local-app:/Applications/QA.app", plugin_id: "local-apps", label: "QA app" };
  partialAppResults = [localResult];
  partialFeatureDeferred = true;
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: true, autoPaste: "never",
    showRecentInSearch: false, pluginEscapeToSearch: true }));
  const input = await setup();
  await enterQuery(input, partialQuery);
  await vi.waitFor(() => expect(releasePartialFeature).toBeTypeOf("function"));
  const pendingFeature = releasePartialFeature;
  await screen.findByRole("option", { name: /QA app/ });
  expect(screen.queryByRole("button", { name: "重试搜索" })).toBeNull();
  const loadingTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(loadingTab);
  expect(loadingTab.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);

  for (const extra of [{ isComposing: true }, { keyCode: 229 }, { altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
    const guarded = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...extra });
    input.dispatchEvent(guarded);
    expect(guarded.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
  }
  partialFeatureDeferred = false;
  pendingFeature?.([alphaPlugin]);
  await screen.findByRole("option", { name: /Alpha 插件/ });
});

it("keeps text and media search Enter on their own search paths", async () => {
  const textInput = await setup();
  paste(textInput, [], "fixed text body");
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "search_text_content_features")).toBe(true));
  await fireEvent.keyDown(textInput, { key: "Enter" });
  expect(searchCalls).toBe(0);

  cleanup();
  mocks.events.clear();
  const mediaInput = await setup();
  const file = new File(["fixture"], "retry-fixture.pdf", { type: "application/pdf" }) as File & { path?: string };
  Object.defineProperty(file, "path", { value: "/tmp/retry-fixture.pdf" });
  paste(mediaInput, [file]);
  await vi.waitFor(() => expect(mocks.invoke.mock.calls.some(([command]) => command === "search_file_content_features")).toBe(true));
  await fireEvent.keyDown(mediaInput, { key: "Enter" });
  expect(searchCalls).toBe(0);
});
