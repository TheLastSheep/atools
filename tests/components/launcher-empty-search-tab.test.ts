import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { searchStatusBarView } from "../../src/lib/searchStatusBar";
import { shouldPassThroughEmptyHomeKey } from "../../src/lib/launcherKeyboard";
import { dispatchPinnedCommandCodes } from "../../src/lib/pinnedCommands";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));

const first: SearchResult = { code: "first", plugin_id: "fixture", plugin_name: "夹具", label: "第一项", explain: "", icon: null, score: 20, match_type: "exact" };
const second: SearchResult = { ...first, code: "second", label: "第二项", score: 10 };
let settings: Record<string, unknown>;
let results: SearchResult[];
let featureCatalog: SearchResult[];
const homeHistory = Array.from({ length: 10 }, (_, index) => ({
  code: `home-${index}`, plugin_id: "fixture", plugin_name: "夹具", label: `首页项 ${index}`,
  explain: "", icon: "", input: `输入 ${index}`, usedAt: `2026-10-20T00:00:${String(59 - index).padStart(2, "0")}Z`, useCount: 1,
}));

beforeEach(() => {
  mocks.invoke.mockReset();
  localStorage.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  settings = { localAppSearch: false, autoPaste: "never", tabKeyFunction: "navigate", showRecentInSearch: false };
  results = [];
  featureCatalog = [];
  mocks.invoke.mockImplementation(async (command: string, args: Record<string, unknown> = {}) => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "feature_catalog") return featureCatalog;
    if (command === "list_pending_agent_requests" || command === "search_local_apps") return [];
    if (command === "search_features") return results;
    if (command === "activate_feature") return { plugin_id: args.expectedPluginId ?? "fixture", plugin_name: "夹具",
      feature_code: args.code, main_url: "index.html", plugin_path: "/fixture", expand_height: 500, payload: args.payload };
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

async function search(query: string) {
  localStorage.setItem("atools:settings-general", JSON.stringify(settings));
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: query } });
  return input;
}

function keyboard(input: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  input.dispatchEvent(event);
  return event;
}

describe("empty launcher search Tab behavior", () => {
  it("omits the select hint at zero rows but keeps the configured target hint", () => {
    const select = searchStatusBarView({ mode: "results", count: 0, selectedIndex: 0, selectedLabel: "", tabAction: "select" });
    const homeEmpty = searchStatusBarView({ mode: "home", count: 0, selectedIndex: 0, selectedLabel: "", tabAction: "select" });
    const homeWithRows = searchStatusBarView({ mode: "home", count: 1, selectedIndex: 0, selectedLabel: "最近项", tabAction: "select" });
    const target = searchStatusBarView({ mode: "results", count: 0, selectedIndex: 0, selectedLabel: "", tabAction: "target", tabTargetHint: "选择目标" });
    const homeTarget = searchStatusBarView({ mode: "home", count: 0, selectedIndex: 0, selectedLabel: "", tabAction: "target", tabTargetHint: "选择目标" });
    expect(select.hints.some(hint => hint.key === "Tab")).toBe(false);
    expect(homeEmpty.hints.some(hint => hint.key === "Tab")).toBe(false);
    expect(homeWithRows.hints).toContainEqual({ key: "Tab", label: "切换" });
    expect(target.hints).toContainEqual({ key: "Tab", label: "选择目标" });
    expect(homeTarget.hints).toContainEqual({ key: "Tab", label: "选择目标" });
    expect(homeEmpty.hints).not.toContainEqual({ key: "↑↓←→", label: "移动" });
    expect(homeEmpty.hints).not.toContainEqual({ key: "Enter", label: "打开" });
    expect(homeTarget.hints.some(hint => hint.key === "Esc")).toBe(true);
  });

  it("passes only unmodified main-search navigation keys through on an empty home", () => {
    const input = document.createElement("input");
    input.dataset.atoolsSearchInput = "true";
    const context = { isHomeSearch: true, emptyQuery: true, hasSelectableRows: false, hasTextOrMediaContext: false, modalOpen: false };
    for (const key of ["ArrowUp", "ArrowDown", "Enter"]) {
      expect(shouldPassThroughEmptyHomeKey(keyboard(input, key), context)).toBe(true);
    }
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "ArrowDown", { shiftKey: true }), context)).toBe(false);
    for (const modifier of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Enter", modifier), context)).toBe(false);
    }
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Enter", { isComposing: true }), context)).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(document.createElement("input"), "Enter"), context)).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Tab"), context)).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Escape"), context)).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Enter"), { ...context, emptyQuery: false })).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Enter"), { ...context, hasSelectableRows: true })).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Enter"), { ...context, hasTextOrMediaContext: true })).toBe(false);
    expect(shouldPassThroughEmptyHomeKey(keyboard(input, "Enter"), { ...context, modalOpen: true })).toBe(false);
  });

  it("does not consume navigation keys on the empty home surface", async () => {
    settings.showRecentInSearch = false;
    const input = await search("");
    expect(screen.queryByRole("region", { name: "ATools 首页" })).toBeNull();
    expect(keyboard(input, "ArrowUp").defaultPrevented).toBe(false);
    expect(keyboard(input, "ArrowDown").defaultPrevented).toBe(false);
    expect(keyboard(input, "Enter").defaultPrevented).toBe(false);
    expect(keyboard(input, "Escape").defaultPrevented).toBe(true);
  });

  it("uses trimmed-query semantics for whitespace-only home input", async () => {
    settings.showRecentInSearch = false;
    const input = await search("   ");
    expect(input.value).toBe("   ");
    expect(screen.queryByRole("region", { name: "ATools 首页" })).toBeNull();
    expect(keyboard(input, "ArrowDown").defaultPrevented).toBe(false);
    expect(keyboard(input, "Enter").defaultPrevented).toBe(false);
  });

  it("keeps navigation active when the home surface has selectable recent or recommended rows", async () => {
    settings.showRecentInSearch = true;
    featureCatalog = homeHistory.map((entry, index) => ({ ...first, code: entry.code, plugin_id: entry.plugin_id,
      plugin_name: entry.plugin_name, label: entry.label, score: 20 - index }));
    localStorage.setItem("atools:command-history", JSON.stringify(homeHistory));
    const input = await search("");
    const home = await screen.findByRole("region", { name: "ATools 首页" });
    await waitFor(() => expect(home.querySelectorAll("button.recent-item").length).toBeGreaterThanOrEqual(10));
    const priorSelection = home.querySelector('[data-home-command-index].selected');
    expect(keyboard(input, "ArrowDown").defaultPrevented).toBe(true);
    await waitFor(() => expect(home.querySelector('[data-home-command-index="9"]')?.classList.contains("selected")).toBe(true));
    expect(home.querySelector('[data-home-command-index="9"]')).not.toBe(priorSelection);
    expect(keyboard(input, "Enter").defaultPrevented).toBe(true);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", expect.objectContaining({ code: "home-9", expectedPluginId: "fixture" })));
  });

  it("does not query menu or modal state for ordinary keys, nonempty queries, or populated rows", async () => {
    settings.showRecentInSearch = true;
    featureCatalog = homeHistory.map((entry, index) => ({ ...first, code: entry.code, plugin_id: entry.plugin_id,
      plugin_name: entry.plugin_name, label: entry.label, score: 20 - index }));
    localStorage.setItem("atools:command-history", JSON.stringify(homeHistory));
    const input = await search("typed query");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("search_features", { query: "typed query" }));
    const selector = '[role="menu"], [role="dialog"][aria-modal="true"]';
    const originalQuerySelector = document.querySelector.bind(document);
    const menuModalQuery = vi.spyOn(document, "querySelector").mockImplementation(query => originalQuerySelector(query));
    try {
      keyboard(input, "x");
      keyboard(input, "ArrowDown");
      expect(menuModalQuery.mock.calls.filter(([query]) => query === selector)).toHaveLength(0);
      await fireEvent.input(input, { target: { value: "" } });
      const home = await screen.findByRole("region", { name: "ATools 首页" });
      await waitFor(() => expect(home.querySelectorAll("button.recent-item").length).toBeGreaterThan(0));
      keyboard(input, "ArrowDown");
      expect(menuModalQuery.mock.calls.filter(([query]) => query === selector)).toHaveLength(0);
    } finally {
      menuModalQuery.mockRestore();
    }
  });

  it("keeps the selected home command through section expansion and collapse", async () => {
    Object.assign(settings, { showRecentInSearch: true, pinnedRows: 1, recentRows: 1 });
    const pinResults = Array.from({ length: 10 }, (_, index) => ({ ...first,
      code: `pin-${index}`, label: `固定项 ${index}`, score: 20 - index }));
    featureCatalog = [...pinResults, ...homeHistory.map((entry, index) => ({ ...first,
      code: entry.code, plugin_id: entry.plugin_id, plugin_name: entry.plugin_name,
      label: entry.label, score: 10 - index }))];
    localStorage.setItem("atools:command-history", JSON.stringify(homeHistory));
    localStorage.setItem("atools:pinned-commands", JSON.stringify(pinResults.map(entry => entry.code)));

    await search("");
    const home = await screen.findByRole("region", { name: "ATools 首页" });
    await waitFor(() => expect(home.querySelectorAll(".recent-item")).toHaveLength(18));
    const selectedRecent = screen.getByRole("button", { name: "首页项 0" });
    selectedRecent.focus();
    await waitFor(() => expect(selectedRecent.closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("9"));

    const expandPinned = screen.getByRole("button", { name: "固定 展开 (10)" });
    expandPinned.focus();
    await fireEvent.click(expandPinned);
    const collapsePinned = await screen.findByRole("button", { name: "固定 收起" });
    await waitFor(() => expect(screen.getByRole("button", { name: "首页项 0" })
      .closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("10"));
    expect(document.activeElement).toBe(collapsePinned);

    const expandRecent = screen.getByRole("button", { name: "最近使用 展开 (12)" });
    expandRecent.focus();
    await fireEvent.click(expandRecent);
    const collapseRecent = await screen.findByRole("button", { name: "最近使用 收起" });
    const lastRecent = screen.getByRole("button", { name: "首页项 9" });
    lastRecent.focus();
    await waitFor(() => expect(lastRecent.closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("19"));

    collapseRecent.focus();
    await fireEvent.click(collapseRecent);
    await waitFor(() => expect(screen.getByRole("button", { name: "首页项 8" })
      .closest<HTMLElement>("[data-home-command-index]")?.classList.contains("selected")).toBe(true));
    expect(document.activeElement).toBe(collapseRecent);
    expect(mocks.invoke).not.toHaveBeenCalledWith("activate_feature", expect.anything());
  });

  it("preserves selected command identity after pin and row-setting mutations", async () => {
    Object.assign(settings, { showRecentInSearch: true, pinnedRows: 1, recentRows: 1 });
    const pinResults = Array.from({ length: 10 }, (_, index) => ({ ...first,
      code: `pin-${index}`, label: `固定项 ${index}`, score: 20 - index }));
    featureCatalog = [...pinResults, ...homeHistory.map((entry, index) => ({ ...first,
      code: entry.code, plugin_id: entry.plugin_id, plugin_name: entry.plugin_name,
      label: entry.label, score: 10 - index }))];
    const allPins = pinResults.map(entry => entry.code);
    localStorage.setItem("atools:command-history", JSON.stringify(homeHistory));
    localStorage.setItem("atools:pinned-commands", JSON.stringify(allPins));

    await search("");
    const home = await screen.findByRole("region", { name: "ATools 首页" });
    const selected = screen.getByRole("button", { name: "首页项 2" });
    selected.focus();
    await waitFor(() => expect(selected.closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("11"));

    dispatchPinnedCommandCodes(allPins.slice(0, 8));
    await waitFor(() => expect(screen.getByRole("button", { name: "首页项 2" })
      .closest<HTMLElement>("[data-home-command-index]")?.classList.contains("selected")).toBe(true));
    expect(screen.getByRole("button", { name: "首页项 2" })
      .closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("10");

    dispatchPinnedCommandCodes(allPins);
    await waitFor(() => expect(screen.getByRole("button", { name: "首页项 2" })
      .closest<HTMLElement>("[data-home-command-index]")?.classList.contains("selected")).toBe(true));
    expect(screen.getByRole("button", { name: "首页项 2" })
      .closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("11");
    window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { pinnedRows: 2 } }));

    await waitFor(() => expect(screen.getByRole("button", { name: "首页项 2" })
      .closest<HTMLElement>("[data-home-command-index]")?.classList.contains("selected")).toBe(true));
    expect(screen.getByRole("button", { name: "首页项 2" })
      .closest<HTMLElement>("[data-home-command-index]")?.dataset.homeCommandIndex).toBe("12");
    expect(home.querySelector('[data-home-command-index="12"]')?.classList.contains("selected")).toBe(true);
    expect(mocks.invoke).not.toHaveBeenCalledWith("activate_feature", expect.anything());
  });

  it.each(["menu", "dialog"])("does not pass empty-home navigation through while a %s is active", async kind => {
    settings.showRecentInSearch = false;
    const input = await search("");
    const overlay = document.createElement("div");
    if (kind === "menu") overlay.setAttribute("role", "menu");
    else { overlay.setAttribute("role", "dialog"); overlay.setAttribute("aria-modal", "true"); }
    document.body.append(overlay);
    const originalQuerySelector = document.querySelector.bind(document);
    const menuModalQuery = vi.spyOn(document, "querySelector").mockImplementation(query => originalQuerySelector(query));
    try {
      expect(keyboard(input, "ArrowDown").defaultPrevented).toBe(true);
      expect(menuModalQuery.mock.calls.filter(([query]) => query === '[role="menu"], [role="dialog"][aria-modal="true"]')).toHaveLength(1);
    } finally {
      menuModalQuery.mockRestore();
      overlay.remove();
    }
  });

  it("does not intercept Tab with no selectable result and preserves Escape clearing", async () => {
    const input = await search("no matching command");
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("search_features", { query: "no matching command" }));
    const status = screen.getByLabelText("搜索状态和快捷键");
    await waitFor(() => expect(status.textContent).toContain("0 项匹配"));
    const clear = screen.getByRole("button", { name: "清除搜索内容" });
    const settingsButton = screen.getByRole("button", { name: "打开设置" });
    const tab = keyboard(input, "Tab");
    const shiftTab = keyboard(input, "Tab", { shiftKey: true });
    const down = keyboard(input, "ArrowDown");
    const enter = keyboard(input, "Enter");
    expect(tab.defaultPrevented).toBe(false);
    expect(shiftTab.defaultPrevented).toBe(false);
    expect(down.defaultPrevented).toBe(true);
    expect(enter.defaultPrevented).toBe(true);
    expect(Boolean(input.compareDocumentPosition(clear) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(Boolean(clear.compareDocumentPosition(settingsButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(screen.getByLabelText("搜索状态和快捷键").textContent).not.toContain("切换");

    const escape = keyboard(input, "Escape");
    expect(escape.defaultPrevented).toBe(true);
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("keeps result cycling in navigate mode when selectable rows exist", async () => {
    results = [first, second];
    const input = await search("matches");
    await screen.findByRole("option", { name: /第二项/ });
    const priorSelection = input.getAttribute("aria-activedescendant");
    const tab = keyboard(input, "Tab");
    expect(tab.defaultPrevented).toBe(true);
    await waitFor(() => expect(input.getAttribute("aria-activedescendant")).not.toBe(priorSelection));
  });
});
