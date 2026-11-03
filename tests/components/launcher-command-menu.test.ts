import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { LAUNCHER_PIN_SNAPSHOTS_KEY, persistLauncherPins, reconcileLauncherPins } from "../../src/lib/launcherPins";
import { PINNED_COMMANDS_STORAGE_KEY } from "../../src/lib/pinnedCommands";
import { COMMAND_HISTORY_STORAGE_KEY } from "../../src/lib/commandHistory";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: unknown) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));
const feature: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换插件", label: "字符转换", explain: "转换文本", icon: null, score: 100, match_type: "exact" };
let catalog: SearchResult[] | Promise<SearchResult[]>;
let activationResult: unknown;
beforeEach(() => {
  catalog = [feature]; activationResult = new Promise(() => {}); mocks.events.clear(); mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  mocks.invoke.mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
    if (command === "feature_catalog") return catalog;
    if (command === "search_features") return [feature];
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return [];
    if (command === "activate_feature") return activationResult; // Assert dispatch, never execute a plugin.
    return undefined;
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
async function search() {
  const input = screen.getByRole("combobox");
  await fireEvent.input(input, { target: { value: "字符转换" } });
  await waitFor(() => expect(screen.getAllByRole("option").some(row =>
    row.getAttribute("data-plugin-id") === "converter" && row.getAttribute("data-result-code") === "convert",
  )).toBe(true));
  return input;
}
function pinCodes() { return JSON.parse(localStorage.getItem(PINNED_COMMANDS_STORAGE_KEY) || "[]"); }

it("pins an actual search result without activation, restores it before cold catalog completion and unpins from Home", async () => {
  let view = render(App, { backgroundServices: false });
  await search();
  await fireEvent.contextMenu(screen.getByRole("option"), { clientX: 720, clientY: 540 });
  await fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "固定到首页" }));
  expect(pinCodes()).toEqual(["convert"]);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("字符转换");
  await fireEvent.click(screen.getByRole("button", { name: "清除搜索内容" }));
  expect(within(await screen.findByLabelText("固定指令")).getByRole("button", { name: "字符转换" })).toBeTruthy();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "feature_catalog")).toHaveLength(1);
  view.unmount(); catalog = new Promise(() => {}); mocks.invoke.mockClear();
  view = render(App, { backgroundServices: false });
  const pinned = within(await screen.findByLabelText("固定指令")).getByRole("button", { name: "字符转换" });
  await fireEvent.click(pinned);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", { code: "convert", payload: null, expectedPluginId: "converter" }));
  await fireEvent.contextMenu(pinned);
  await fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "从首页取消固定" }));
  await waitFor(() => expect(screen.queryByLabelText("固定指令")).toBeNull());
  expect(pinCodes()).toEqual([]);
  expect(localStorage.getItem(LAUNCHER_PIN_SNAPSHOTS_KEY)).toBe("[]");
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
});

it("keeps a cold pin's owner through activation and rejects a different returned owner before mount/history", async () => {
  const prepared = reconcileLauncherPins({ codes: [feature.code], catalog: [feature], snapshots: [], catalogReady: true, resolveLocal: () => null });
  persistLauncherPins(prepared);
  catalog = new Promise(() => {});
  activationResult = { plugin_id: "different-owner", feature_code: "convert", expand_height: 420 };
  render(App, { backgroundServices: false });

  await fireEvent.click(await screen.findByRole("button", { name: "字符转换" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "convert", payload: null, expectedPluginId: "converter",
  }));
  expect((await screen.findByRole("alert")).textContent).toContain("此功能的来源已变化");
  expect(document.querySelector("[data-plugin-feature-code]")).toBeNull();
  expect(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY)).toBeNull();
});

it("opens the selected command by Shift+F10, Escape owns the menu and preserves the query and launcher focus", async () => {
  render(App, { backgroundServices: false }); const input = await search(); input.focus();
  await fireEvent.keyDown(input, { key: "F10", shiftKey: true });
  expect(screen.getByText("更多操作 · 右键")).toBeTruthy();
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitemcheckbox")));
  await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect((input as HTMLInputElement).value).toBe("字符转换");
  await waitFor(() => expect(document.activeElement).toBe(input));
  expect(mocks.invoke.mock.calls.some(([command]) => command === "hide_main_window")).toBe(false);
});

it("removes only the source history entry through keyboard menu navigation", async () => {
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify([{ ...feature, icon: "", input: "字符转换", usedAt: new Date().toISOString(), useCount: 1 }]));
  render(App, { backgroundServices: false });
  await search(); await fireEvent.click(screen.getByRole("button", { name: "清除搜索内容" }));
  const recent = await screen.findByRole("button", { name: "字符转换" });
  await fireEvent.keyDown(recent, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu");
  const pin = within(menu).getByRole("menuitemcheckbox");
  await fireEvent.keyDown(pin, { key: "ArrowDown" });
  const remove = within(menu).getByRole("menuitem", { name: "从最近使用移除" });
  expect(document.activeElement).toBe(remove);
  await fireEvent.click(remove);
  expect(JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) || "[]")).toEqual([]);
  expect(pinCodes()).toEqual([]);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes stale menu generations and invalidates removed plugin snapshots after an authoritative catalog update", async () => {
  persistLauncherPins(reconcileLauncherPins({ codes: ["convert"], catalog: [feature], snapshots: [], catalogReady: true, resolveLocal: () => null }));
  render(App, { backgroundServices: false }); const input = await search();
  await fireEvent.contextMenu(screen.getByRole("option"));
  await screen.findByRole("menu");
  await fireEvent.input(input, { target: { value: "另一个查询" } });
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  await fireEvent.contextMenu(await screen.findByRole("option")); await screen.findByRole("menu");
  catalog = []; mocks.events.get("builtin-plugins-loaded")?.({});
  await waitFor(() => expect(pinCodes()).toEqual([]));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(JSON.parse(localStorage.getItem(LAUNCHER_PIN_SNAPSHOTS_KEY) || "[]")).toEqual([]);
});

it("ignores an older cold-start catalog response after a newer authoritative removal", async () => {
  persistLauncherPins(reconcileLauncherPins({ codes: ["convert"], catalog: [feature], snapshots: [], catalogReady: true, resolveLocal: () => null }));
  let complete!: (value: SearchResult[]) => void;
  catalog = new Promise(resolve => { complete = resolve; });
  render(App, { backgroundServices: false });
  expect(await screen.findByLabelText("固定指令")).toBeTruthy();
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  catalog = []; mocks.events.get("builtin-plugins-loaded")?.({});
  await waitFor(() => expect(pinCodes()).toEqual([]));
  complete([feature]);
  await waitFor(() => expect(screen.queryByLabelText("固定指令")).toBeNull());
  expect(pinCodes()).toEqual([]);
});

it("does not let a destroyed App's pending catalog restore pins removed in a new App", async () => {
  persistLauncherPins(reconcileLauncherPins({ codes: ["convert"], catalog: [feature], snapshots: [], catalogReady: true, resolveLocal: () => null }));
  let complete!: (value: SearchResult[]) => void;
  catalog = new Promise(resolve => { complete = resolve; });
  const old = render(App, { backgroundServices: false });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("feature_catalog")); old.unmount();
  catalog = [feature]; render(App, { backgroundServices: false });
  await fireEvent.contextMenu(within(await screen.findByLabelText("固定指令")).getByRole("button", { name: "字符转换" }));
  await fireEvent.click(await screen.findByRole("menuitemcheckbox", { name: "从首页取消固定" }));
  complete([feature]); await Promise.resolve(); await Promise.resolve();
  expect(pinCodes()).toEqual([]);
  expect(JSON.parse(localStorage.getItem(LAUNCHER_PIN_SNAPSHOTS_KEY) || "[]")).toEqual([]);
});
