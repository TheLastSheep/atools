import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { FeatureAction, SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  events: new Map<string, (event: unknown) => void>(),
  featureRequests: [] as Array<{ query: string; resolve: (results: SearchResult[]) => void }>,
  settings: {} as Record<string, unknown>,
}));

vi.mock("@tauri-apps/api/core", async original => ({
  ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name, callback) => {
    mocks.events.set(name, callback);
    return () => mocks.events.delete(name);
  }),
}));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanel.svelte", async () => ({
  default: (await import("./LauncherTextPluginFixture.svelte")).default,
}));

const settings = { localAppSearch: false, autoPaste: "never", autoClear: "never", showRecentInSearch: false };
const remotePlugin: SearchResult = {
  code: "visibility-plugin", plugin_id: "visibility-plugin", plugin_name: "可见性测试插件",
  label: "可见性测试插件入口", explain: "用于确认插件页不触发搜索", icon: null, score: 1200, match_type: "exact",
};
const lateWinner: SearchResult = {
  code: "late-visibility-result", plugin_id: "late-plugin", plugin_name: "异步结果",
  label: "隐藏期间返回的高分结果", explain: "不可写回", icon: null, score: 2000, match_type: "exact",
};
const pluginAction: FeatureAction = {
  plugin_id: remotePlugin.plugin_id, plugin_name: remotePlugin.plugin_name, feature_code: remotePlugin.code,
  main_url: "index.html", plugin_path: "/fixture/visibility-plugin", expand_height: 400, payload: { value: "fixture" },
};

let originalVisibilityDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.events.clear();
  mocks.featureRequests.length = 0;
  mocks.settings = { ...settings };
  originalVisibilityDescriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  window.history.replaceState(null, "", "/");
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.clear();
  localStorage.setItem("atools-settings", JSON.stringify(mocks.settings));
  mocks.invoke.mockImplementation((command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_setting") return Promise.resolve(JSON.stringify(mocks.settings));
    if (command === "feature_catalog") return Promise.resolve([]);
    if (command === "search_features") {
      return new Promise<SearchResult[]>(resolve => mocks.featureRequests.push({ query: String(args.query ?? ""), resolve }));
    }
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return Promise.resolve([]);
    if (command === "activate_feature") return Promise.resolve(pluginAction);
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  for (const request of mocks.featureRequests) request.resolve([]);
  mocks.events.clear();
  localStorage.clear();
  if (originalVisibilityDescriptor) Object.defineProperty(document, "visibilityState", originalVisibilityDescriptor);
  else Reflect.deleteProperty(document, "visibilityState");
  originalVisibilityDescriptor = undefined;
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function setup() {
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  return input;
}

async function enterQuery(input: HTMLInputElement, query: string) {
  await fireEvent.input(input, { target: { value: query } });
  await waitFor(() => expect(mocks.featureRequests.length).toBeGreaterThan(0));
}

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  document.dispatchEvent(new Event("visibilitychange"));
}

function calls(command: string) {
  return mocks.invoke.mock.calls.filter(([name]) => name === command);
}

function selectedIdentity() {
  const selected = screen.getAllByRole("option").find(row => row.getAttribute("aria-selected") === "true");
  return selected ? [selected.getAttribute("data-plugin-id"), selected.getAttribute("data-result-code")] : null;
}

it("does not start a debounced native search while hidden and refreshes the retained home query once when visible", async () => {
  const input = await setup();
  await fireEvent.input(input, { target: { value: "visibility-debounce-query" } });

  setVisibility("hidden");
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(calls("search_features")).toHaveLength(0);

  setVisibility("visible");
  await waitFor(() => expect(mocks.featureRequests).toHaveLength(1));
  expect(mocks.featureRequests[0].query).toBe("visibility-debounce-query");
  mocks.featureRequests[0].resolve([]);
});

it("does not revive an auto-cleared query when hidden and returning to the launcher", async () => {
  const input = await setup();
  mocks.settings = { ...settings, autoClear: "1s" };
  localStorage.setItem("atools-settings", JSON.stringify(mocks.settings));
  window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: mocks.settings }));

  await fireEvent.input(input, { target: { value: "https://example.com" } });
  await waitFor(() => expect(mocks.featureRequests).toHaveLength(1));
  await fireEvent.click(await screen.findByRole("option", { name: /打开链接/ }));
  await waitFor(() => expect(calls("call_agent_tool")).toHaveLength(1));

  setVisibility("hidden");
  await waitFor(() => expect(input.value).toBe(""), { timeout: 2500 });
  const requestsAfterClear = calls("search_features").length;
  setVisibility("visible");
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(calls("search_features")).toHaveLength(requestsAfterClear);
});

it("fences an in-flight hidden result without resizing, then refreshes once and preserves the user's selected command", async () => {
  const input = await setup();
  await enterQuery(input, ">");
  await screen.findAllByRole("option");
  expect(mocks.featureRequests).toHaveLength(1);

  await fireEvent.keyDown(input, { key: "ArrowDown" });
  const identity = selectedIdentity();
  expect(identity).toBeTruthy();
  const resizeCount = calls("expand_window").length;

  setVisibility("hidden");
  mocks.featureRequests[0].resolve([lateWinner]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(screen.queryByRole("option", { name: lateWinner.label })).toBeNull();
  expect(calls("expand_window")).toHaveLength(resizeCount);

  setVisibility("visible");
  await waitFor(() => expect(mocks.featureRequests).toHaveLength(2));
  expect(input.value).toBe(">");
  mocks.featureRequests[1].resolve([lateWinner]);
  await screen.findByRole("option", { name: new RegExp(lateWinner.label) });
  await waitFor(() => expect(selectedIdentity()).toEqual(identity));
});

it("does not refresh an empty query or a settings panel when the window returns", async () => {
  await setup();
  setVisibility("hidden");
  setVisibility("visible");
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(calls("search_features")).toHaveLength(0);

  const input = screen.getByRole("combobox") as HTMLInputElement;
  await enterQuery(input, ">");
  mocks.featureRequests[0].resolve([]);
  await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  await waitFor(() => expect(calls("expand_window").some(([, args]) => args?.height === 600)).toBe(true));
  const requestCount = calls("search_features").length;

  setVisibility("hidden");
  setVisibility("visible");
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(calls("search_features")).toHaveLength(requestCount);
});

it("does not refresh from an active plugin page when the window returns", async () => {
  const input = await setup();
  await enterQuery(input, ">");
  mocks.featureRequests[0].resolve([remotePlugin]);
  await fireEvent.click(await screen.findByRole("option", { name: new RegExp(remotePlugin.label) }));
  await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  const requestCount = calls("search_features").length;
  setVisibility("hidden");
  setVisibility("visible");
  await new Promise(resolve => setTimeout(resolve, 40));
  expect(calls("search_features")).toHaveLength(requestCount);
});

it("fences a pending ordinary search after the launcher is unmounted", async () => {
  const input = await setup();
  await enterQuery(input, ">");
  const resizeCount = calls("expand_window").length;
  const pending = mocks.featureRequests[mocks.featureRequests.length - 1];
  cleanup();
  pending.resolve([lateWinner]);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(calls("expand_window")).toHaveLength(resizeCount);
});
