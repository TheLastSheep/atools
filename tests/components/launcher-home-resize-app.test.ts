import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { COMMAND_HISTORY_STORAGE_KEY, dispatchCommandHistoryUpdated } from "../../src/lib/commandHistory";
import { dispatchPinnedCommandCodes, PINNED_COMMANDS_STORAGE_KEY } from "../../src/lib/pinnedCommands";
import { DEFAULT_ATOOLS_SETTINGS, dispatchAToolsSettings, SETTINGS_STORAGE_KEY } from "../../src/lib/settings";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, Function>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name: string, callback: Function) => {
  mocks.events.set(name, callback);
  return () => mocks.events.delete(name);
}) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanelMount.svelte", async () => ({
  default: (await import("./LauncherTextPluginMountFixture.svelte")).default,
}));

const pinResults: SearchResult[] = Array.from({ length: 12 }, (_, index) => ({
  code: `pin-${index}`, plugin_id: "pin-plugin", plugin_name: "固定插件", label: `固定项 ${index}`,
  explain: "固定测试项", icon: null, score: 30 - index, match_type: "exact",
}));
const history = Array.from({ length: 19 }, (_, index) => ({
  code: `history-${index}`, plugin_id: "history-plugin", plugin_name: "历史插件", label: `历史项 ${index}`,
  explain: "历史测试项", icon: "", input: `输入 ${index}`,
  usedAt: `2026-10-20T00:00:${String(59 - index).padStart(2, "0")}Z`, useCount: 1,
}));
const historyResults: SearchResult[] = history.map((entry, index) => ({
  ...entry, icon: null, score: 20 - index, match_type: "exact",
}));
const featureCatalog = [...pinResults, ...historyResults];
const settings = { ...DEFAULT_ATOOLS_SETTINGS, showRecentInSearch: true, pinnedRows: 1, recentRows: 2,
  localAppSearch: false, autoPaste: "never" as const };

beforeEach(() => {
  mocks.invoke.mockReset();
  mocks.events.clear();
  localStorage.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify(history));
  localStorage.setItem(PINNED_COMMANDS_STORAGE_KEY, JSON.stringify(pinResults.map(result => result.code)));
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "feature_catalog") return featureCatalog;
    if (command === "list_pending_agent_requests" || command === "search_local_apps" || command === "search_features") return [];
    if (command === "activate_feature") return {
      plugin_id: "history-plugin", plugin_name: "历史插件", feature_code: "history-0", main_url: "index.html",
      plugin_path: "/fixture", expand_height: 500, payload: null,
    };
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

function resizeCalls() {
  return mocks.invoke.mock.calls.filter(([command]) => command === "expand_window");
}

async function mountLauncher() {
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  const home = await screen.findByRole("region", { name: "ATools 首页" });
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  await waitFor(() => expect(home.querySelectorAll(".recent-item-shell")).toHaveLength(27));
  await waitFor(() => expect(resizeCalls().at(-1)?.[1]).toEqual({ height: 478 }));
  mocks.invoke.mockClear();
  return { input, home };
}

describe("home content height synchronization", () => {
  it("resizes once for each visible section expansion and ignores selection-only changes", async () => {
    const { input, home } = await mountLauncher();

    await fireEvent.click(screen.getByRole("button", { name: "固定 展开 (12)" }));
    await waitFor(() => expect(resizeCalls()).toHaveLength(1));
    expect(resizeCalls()[0][1]).toEqual({ height: 564 });
    await waitFor(() => expect(home.querySelectorAll(".pinned-grid .recent-item-shell")).toHaveLength(12));

    await fireEvent.click(screen.getByRole("button", { name: "固定 收起" }));
    await waitFor(() => expect(resizeCalls()).toHaveLength(2));
    expect(resizeCalls()[1][1]).toEqual({ height: 478 });
    await waitFor(() => expect(home.querySelectorAll(".pinned-grid .recent-item-shell")).toHaveLength(9));

    mocks.invoke.mockClear();
    const previous = home.querySelector(".recent-item-shell.selected");
    await fireEvent.keyDown(input, { key: "ArrowDown" });
    await waitFor(() => expect(home.querySelector(".recent-item-shell.selected")).not.toBe(previous));
    expect(resizeCalls()).toHaveLength(0);
  });

  it("tracks row settings, history removal, and pinned command changes", async () => {
    const { home } = await mountLauncher();

    dispatchAToolsSettings({ ...settings, recentRows: 3 });
    await waitFor(() => expect(resizeCalls()).toHaveLength(1));
    expect(resizeCalls()[0][1]).toEqual({ height: 564 });

    dispatchCommandHistoryUpdated(history.slice(0, 16));
    await waitFor(() => expect(home.querySelectorAll(".recent-grid:not(.pinned-grid) .recent-item-shell")).toHaveLength(18));
    await waitFor(() => expect(resizeCalls()).toHaveLength(2));
    expect(resizeCalls()[1][1]).toEqual({ height: 478 });

    dispatchCommandHistoryUpdated(history);
    await waitFor(() => expect(resizeCalls()).toHaveLength(3));
    expect(resizeCalls()[2][1]).toEqual({ height: 564 });

    dispatchAToolsSettings({ ...settings, pinnedRows: 2, recentRows: 3 });
    await waitFor(() => expect(resizeCalls()).toHaveLength(4));
    expect(resizeCalls()[3][1]).toEqual({ height: 650 });
    await waitFor(() => expect(home.querySelectorAll(".pinned-grid .recent-item-shell")).toHaveLength(12));

    dispatchPinnedCommandCodes(pinResults.slice(0, 9).map(result => result.code));
    await waitFor(() => expect(resizeCalls()).toHaveLength(5));
    expect(resizeCalls()[4][1]).toEqual({ height: 564 });
    await waitFor(() => expect(home.querySelectorAll(".pinned-grid .recent-item-shell")).toHaveLength(9));
  });

  it("keeps plugin-owned window height when home history changes in plugin mode", async () => {
    const { home } = await mountLauncher();
    await fireEvent.click(screen.getByRole("button", { name: "历史项 0" }));
    await screen.findByRole("region", { name: "文本插件验收" });
    await waitFor(() => expect(resizeCalls().some(([, args]) => args?.height === 500)).toBe(true));

    mocks.invoke.mockClear();
    dispatchCommandHistoryUpdated([...history, {
      ...history[0], code: "history-new", label: "新增历史项", usedAt: "2026-10-21T00:00:00Z",
    }]);
    dispatchAToolsSettings({ ...settings, recentRows: 3 });
    await waitFor(() => expect(home.isConnected).toBe(false));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resizeCalls()).toHaveLength(0);
  });
});
