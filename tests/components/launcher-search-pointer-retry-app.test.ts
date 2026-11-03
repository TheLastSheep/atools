import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { DIRECT_PLUGIN_LAUNCH_EVENT } from "../../src/lib/launcherDirectPluginLaunch";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
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

type SearchResults = typeof alphaPlugin[];
type DeferredSearch = { query: string; resolve: (results: SearchResults) => void };
let searchCalls = 0;
let queryACount = 0;
let deferredSearches: DeferredSearch[] = [];

beforeEach(() => {
  searchCalls = 0;
  queryACount = 0;
  deferredSearches = [];
  mocks.events.clear();
  mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: false, autoPaste: "never", showRecentInSearch: false, pluginEscapeToSearch: true }));
  mocks.invoke.mockImplementation((command: string, args?: { query?: string; code?: string }) => {
    if (command === "get_setting") return Promise.resolve(localStorage.getItem(SETTINGS_STORAGE_KEY));
    if (command === "feature_catalog" || command === "list_pending_agent_requests" || command === "search_local_apps") return Promise.resolve([]);
    if (command === "search_text_content_features") return Promise.resolve([]);
    if (command === "search_file_content_features") return Promise.resolve({ files: [{ path: "/tmp/retry-fixture.pdf", name: "retry-fixture.pdf", isFile: true, isDirectory: false }], results: [] });
    if (command === "search_features") {
      searchCalls += 1;
      if (args?.query === ordinaryPluginQuery) {
        queryACount += 1;
        if (queryACount === 1 || queryACount === 3) return Promise.reject(new Error("fixture search offline"));
        if (queryACount === 2 || queryACount === 4) return new Promise<SearchResults>(resolve => {
          deferredSearches.push({ query: args.query ?? "", resolve });
        });
      }
      if (args?.query === "query B") return Promise.resolve([betaPlugin]);
      return Promise.resolve([alphaPlugin]);
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

function searchArguments() {
  return mocks.invoke.mock.calls
    .filter(([command]) => command === "search_features")
    .map(([, args]) => args as { query?: string });
}

async function resolveDeferred(index: number, results: SearchResults) {
  const pending = deferredSearches[index];
  expect(pending).toBeDefined();
  pending.resolve(results);
  await Promise.resolve();
  await Promise.resolve();
  await tick();
}

it("pointer retry uses the current query once, shares Enter's pending gate, and restores search focus", async () => {
  const input = await setup();
  await enterQuery(input, ordinaryPluginQuery);
  const retry = await screen.findByRole("button", { name: "重试搜索" });
  expect(searchCalls).toBe(1);

  // Dispatch twice before Svelte's pending-state render removes the action.
  const firstClick = fireEvent.click(retry);
  const duplicateClick = fireEvent.click(retry);
  await Promise.all([firstClick, duplicateClick]);
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(searchArguments().at(-1)).toEqual(expect.objectContaining({ query: ordinaryPluginQuery }));

  await fireEvent.keyDown(input, { key: "Enter" });
  expect(searchCalls).toBe(2);
  await resolveDeferred(0, [alphaPlugin]);
  await screen.findByRole("option", { name: /Alpha 插件/ });
});

it("allows a fresh A after A→B→A and an obsolete completion cannot release its gate", async () => {
  const input = await setup();
  await enterQuery(input, ordinaryPluginQuery);
  const firstRetry = await screen.findByRole("button", { name: "重试搜索" });
  await fireEvent.click(firstRetry);
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  expect(deferredSearches).toHaveLength(1);

  await enterQuery(input, "query B");
  await screen.findByRole("option", { name: /Beta 插件/ });
  await enterQuery(input, ordinaryPluginQuery);
  const currentRetry = await screen.findByRole("button", { name: "重试搜索" });
  await fireEvent.click(currentRetry);
  await vi.waitFor(() => expect(searchCalls).toBe(5));
  expect(deferredSearches).toHaveLength(2);

  await resolveDeferred(0, [betaPlugin]);
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(searchCalls).toBe(5);
  expect(screen.queryByRole("option", { name: /Beta 插件/ })).toBeNull();

  await resolveDeferred(1, [alphaPlugin]);
  await screen.findByRole("option", { name: /Alpha 插件/ });
  expect(screen.queryByRole("option", { name: /Beta 插件/ })).toBeNull();
  expect(searchArguments().at(-1)).toEqual(expect.objectContaining({ query: ordinaryPluginQuery }));
  expect(document.activeElement).toBe(input);
});

it("keeps composition, modified, dialog, and non-search Enter guarded while retry remains pointer-accessible", async () => {
  const input = await setup();
  await enterQuery(input, ordinaryPluginQuery);
  const retry = await screen.findByRole("button", { name: "重试搜索" });
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

  await fireEvent.click(retry);
  await vi.waitFor(() => expect(searchCalls).toBe(2));
  await waitFor(() => expect(document.activeElement).toBe(input));
});
