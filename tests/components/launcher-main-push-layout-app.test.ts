import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { SearchResult } from "../../src/lib/types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: unknown) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/LauncherMainPushHost.svelte", async () => ({ default: (await import("./MainPushLayoutHostFixture.svelte")).default }));
const row = (code: string, label: string): SearchResult => ({ code, label, plugin_id: "fixed", plugin_name: "Fixture", explain: "", icon: null, score: 1, match_type: "exact" });
let release!: (rows: SearchResult[]) => void;
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.events.clear(); localStorage.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  const settings = { localAppSearch: false, autoPaste: "never", showRecentInSearch: true, tabKeyFunction: "navigate" };
  localStorage.setItem("atools:settings-general", JSON.stringify(settings));
  mocks.invoke.mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "search_features") return new Promise<SearchResult[]>(resolve => { release = resolve; });
    if (["feature_catalog", "list_pending_agent_requests", "search_local_apps"].includes(command)) return [];
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
const height = () => Number.parseFloat((document.querySelector(".shell-frame") as HTMLElement).style.getPropertyValue("--shell-target-height"));
const nativeHeight = () => mocks.invoke.mock.calls.filter(([name]) => name === "expand_window").at(-1)?.[1]?.height;
async function publish(rows: SearchResult[]) {
  await fireEvent(window, new CustomEvent("fixture-main-push-layout", { detail: { rows, pending: false, deferred: 0, message: "", promotedId: null } }));
}
async function setup() {
  render(App, { backgroundServices: false }); await screen.findByTestId("main-push-layout-host");
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: "zzzz-fixed-layout" } });
  await waitFor(() => expect(mocks.invoke.mock.calls.some(([name]) => name === "search_features")).toBe(true));
  return input;
}
it("shows first-use home state when available history and pins are empty", async () => {
  render(App, { backgroundServices: false });
  await screen.findByTestId("main-push-layout-host");
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  await waitFor(() => expect(mocks.invoke.mock.calls.some(([name]) => name === "feature_catalog")).toBe(true));
  expect(JSON.parse(localStorage.getItem("atools:command-history") ?? "[]")).toEqual([]);
  expect(JSON.parse(localStorage.getItem("atools:pinned-commands") ?? "[]")).toEqual([]);
  expect(await screen.findByRole("heading", { name: "从搜索开始" })).toBeTruthy();
  await vi.dynamicImportSettled();
  const commandRegion = within(screen.getByRole("region", { name: "固定指令与最近使用" }));
  expect(commandRegion.queryByRole("button", { name: "结果中心" })).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "常用入口" })).getByRole("button", { name: "结果中心" })).toBeTruthy();
});
it("late static search preserves an explicitly selected dynamic row and resizes to the actual combined App layout", async () => {
  const input = await setup();
  await publish([row("main-push:runner:q:0", "Dynamic first"), row("main-push:runner:q:1", "Dynamic chosen")]);
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toContain("Dynamic chosen");
  release([row("static-first", "Static first"), row("static-second", "Static second")]);
  await screen.findByRole("option", { name: /Static second/ });
  expect(screen.getAllByRole("option")).toHaveLength(4);
  expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.textContent).toContain("Dynamic chosen");
  await waitFor(() => expect(nativeHeight()).toBe(height()));
});
it("a dynamic cleanup update after clearing the query retains the actual home height", async () => {
  const input = await setup(); release([]); await publish([row("main-push:runner:q:0", "Dynamic"), row("main-push:runner:q:1", "Dynamic second")]);
  await fireEvent.input(input, { target: { value: "" } }); await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  const homeHeight = height(); expect(homeHeight).toBeGreaterThan(0);
  await publish([]); expect(height()).toBe(homeHeight); await waitFor(() => expect(nativeHeight()).toBe(homeHeight));
});
it("a delayed static completion after actual App unmount cannot resize a destroyed launcher", async () => {
  await setup(); cleanup(); const before = mocks.invoke.mock.calls.filter(([name]) => name === "expand_window").length;
  release([row("late", "Late result")]); await new Promise(resolve => setTimeout(resolve, 5));
  expect(mocks.invoke.mock.calls.filter(([name]) => name === "expand_window")).toHaveLength(before);
});
