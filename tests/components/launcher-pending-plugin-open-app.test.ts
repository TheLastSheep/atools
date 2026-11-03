import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import {
  alphaPlugin, betaPlugin, gammaPlugin, ordinaryPluginQuery, pluginActivationAction,
  returnSearchResults,
} from "./launcherReturnContextFixture";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pending: new Map<string, Array<{ resolve: (value: unknown) => void; reject: (reason: Error) => void }>>(),
  holdNextExpand: false,
  expandResolvers: [] as Array<() => void>,
}));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));

let searchCount = 0;

beforeAll(async () => {
  await import("../../src/components/PluginPanel.svelte");
});

beforeEach(() => {
  searchCount = 0;
  mocks.pending.clear();
  mocks.holdNextExpand = false;
  mocks.expandResolvers.length = 0;
  mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ localAppSearch: false, autoPaste: "never", pluginEscapeToSearch: true }));
  mocks.invoke.mockImplementation((command: string, args?: { query?: string; code?: string }) => {
    if (command === "get_setting") return Promise.resolve(JSON.stringify({ localAppSearch: false, autoPaste: "never", pluginEscapeToSearch: true }));
    if (["feature_catalog", "list_pending_agent_requests", "search_local_apps"].includes(command)) return Promise.resolve([]);
    if (command === "search_features") {
      if (args?.query === ordinaryPluginQuery) return Promise.resolve(returnSearchResults(++searchCount));
      if (args?.query === "新插件") return Promise.resolve([gammaPlugin]);
      return Promise.resolve([]);
    }
    if (command === "activate_feature") {
      return new Promise((resolve, reject) => {
        const requests = mocks.pending.get(args?.code ?? "") ?? [];
        requests.push({ resolve, reject });
        mocks.pending.set(args?.code ?? "", requests);
      });
    }
    if (command === "expand_window" && mocks.holdNextExpand) {
      mocks.holdNextExpand = false;
      return new Promise<void>(resolve => mocks.expandResolvers.push(resolve));
    }
    return Promise.resolve(undefined);
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function openSearch(query = ordinaryPluginQuery) {
  render(App, { backgroundServices: false });
  const input = await screen.findByRole("combobox");
  await fireEvent.input(input, { target: { value: query } });
  await screen.findAllByRole("option");
  return input;
}

function pendingOpenCount(code: string) {
  return mocks.pending.get(code)?.length ?? 0;
}

function resolveOpen(code: string, occurrence = 0) {
  mocks.pending.get(code)?.[occurrence]?.resolve(pluginActivationAction([alphaPlugin, betaPlugin, gammaPlugin].find(item => item.code === code)!));
}

function rejectOpen(code: string, occurrence = 0) {
  mocks.pending.get(code)?.[occurrence]?.reject(new Error("newest activation failed"));
}

it("shows accessible opening status and coalesces repeated Enter for the same owner and code", async () => {
  const input = await openSearch();
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "Enter" });
  const row = screen.getByRole("option", { name: /Beta 插件/ });
  expect(row.getAttribute("aria-busy")).toBe("true");
  const openingId = row.getAttribute("aria-describedby")?.split(" ").find(id => id.endsWith("-opening"));
  expect(document.getElementById(openingId ?? "")?.textContent).toContain("正在打开… · Esc 取消");
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(mocks.invoke.mock.calls.filter(([command, args]) => command === "activate_feature" && args?.code === betaPlugin.code)).toHaveLength(1);
  resolveOpen(betaPlugin.code);
  await screen.findByRole("banner", { name: "插件导航" });
});

it("uses the first Escape to cancel pending open without clearing query or focus; the next Escape keeps normal search behavior", async () => {
  const input = await openSearch();
  await fireEvent.keyDown(input, { key: "Enter" });
  expect(document.querySelector('.opening-hint[aria-live="polite"]')?.textContent).toContain("正在打开… · Esc 取消");
  await fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("combobox")).toBe(input);
  expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery);
  expect(document.activeElement).toBe(input);
  expect(document.querySelector('.opening-hint[aria-live="polite"]')).toBeNull();
  resolveOpen(alphaPlugin.code);
  await Promise.resolve();
  expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();

  await fireEvent.keyDown(window, { key: "Escape" });
  expect((input as HTMLInputElement).value).toBe("");
});

it("ignores stale success after a query change and preserves a newer activation failure", async () => {
  const input = await openSearch();
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(pendingOpenCount(betaPlugin.code)).toBe(1));

  await fireEvent.input(input, { target: { value: "新插件" } });
  const gamma = await screen.findByRole("option", { name: /Gamma 插件/ });
  expect(gamma).toBeTruthy();
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(pendingOpenCount(gammaPlugin.code)).toBe(1));
  rejectOpen(gammaPlugin.code);
  await screen.findByRole("alert");
  resolveOpen(betaPlugin.code);
  await Promise.resolve();

  expect((input as HTMLInputElement).value).toBe("新插件");
  expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("插件未能打开");
});

it("keeps a second A attempt current when the first A settles after A→B→A", async () => {
  const input = await openSearch();
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(pendingOpenCount(alphaPlugin.code)).toBe(1));

  await fireEvent.input(input, { target: { value: "新插件" } });
  await screen.findByRole("option", { name: /Gamma 插件/ });
  await fireEvent.input(input, { target: { value: ordinaryPluginQuery } });
  await screen.findAllByRole("option");
  await fireEvent.keyDown(input, { key: "ArrowDown" });
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(pendingOpenCount(alphaPlugin.code)).toBe(2));

  rejectOpen(alphaPlugin.code, 0);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect((input as HTMLInputElement).value).toBe(ordinaryPluginQuery);
  expect(screen.queryByRole("banner", { name: "插件导航" })).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(document.querySelector('.opening-hint[aria-live="polite"]')?.textContent).toContain("正在打开…");

  resolveOpen(alphaPlugin.code, 1);
  await screen.findByRole("banner", { name: "插件导航" });
});

it("clears pending at plugin commit so Escape returns normally while expansion is delayed", async () => {
  const input = await openSearch();
  mocks.holdNextExpand = true;
  await fireEvent.keyDown(input, { key: "Enter" });
  await vi.waitFor(() => expect(pendingOpenCount(alphaPlugin.code)).toBe(1));
  resolveOpen(alphaPlugin.code);
  await screen.findByRole("banner", { name: "插件导航" });
  await vi.waitFor(() => expect(mocks.expandResolvers).toHaveLength(1));
  expect(document.querySelector('.opening-hint[aria-live="polite"]')).toBeNull();

  await fireEvent.keyDown(window, { key: "Escape" });
  const returnedInput = await screen.findByRole("combobox");
  await vi.waitFor(() => expect(document.activeElement).toBe(returnedInput));
  expect((returnedInput as HTMLInputElement).value).toBe(ordinaryPluginQuery);
  await vi.waitFor(() => expect(searchCount).toBe(2));
  const restoredAlpha = await screen.findByRole("option", { name: /Alpha 插件/ });
  await vi.waitFor(() => expect(restoredAlpha.getAttribute("aria-selected")).toBe("true"));

  await fireEvent.keyDown(returnedInput, { key: "ArrowUp" });
  const selectedBeta = screen.getByRole("option", { name: /Beta 插件/ });
  await vi.waitFor(() => expect(selectedBeta.getAttribute("aria-selected")).toBe("true"));
  await fireEvent.keyDown(returnedInput, { key: "Enter" });
  await vi.waitFor(() => expect(pendingOpenCount(betaPlugin.code)).toBe(1));
  expect(document.querySelector('.opening-hint[aria-live="polite"]')?.textContent).toContain("正在打开…");
  mocks.expandResolvers[0]();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(document.querySelector('.opening-hint[aria-live="polite"]')?.textContent).toContain("正在打开…");

  resolveOpen(betaPlugin.code);
  await screen.findByRole("banner", { name: "插件导航" });
});
