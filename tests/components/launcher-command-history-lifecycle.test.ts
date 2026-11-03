import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import { COMMAND_HISTORY_STORAGE_KEY, type CommandHistoryEntry } from "../../src/lib/commandHistory";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: unknown) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));

const originalFeature: SearchResult = {
  code: "convert", plugin_id: "converter", plugin_name: "转换插件", label: "字符转换",
  explain: "转换文本", icon: "old-icon", score: 100, match_type: "exact",
};
const renamedFeature: SearchResult = {
  ...originalFeature, plugin_name: "转换插件新版", label: "文本转换", explain: "转换文本格式", icon: "new-icon",
};
const staleSearchResult: SearchResult = {
  code: "stale-search-result", plugin_id: "converter", plugin_name: "转换插件", label: "旧搜索回包",
  explain: "必须被丢弃", icon: null, score: 100, match_type: "exact",
};
const pastedFile = { path: "/fixture/sample.txt", name: "sample.txt", isFile: true, isDirectory: false };
const legacyPasteQuery = "粘贴了 1 个文件";
const fileFeature: SearchResult = {
  ...originalFeature, code: "convert-file", label: "处理粘贴文件", match_type: "files",
  content_search_terms: [legacyPasteQuery],
};
let catalog: SearchResult[];
let searchFeatures: (query: string) => Promise<SearchResult[]>;
let activationResult: unknown;

function historyEntry(feature = originalFeature): CommandHistoryEntry {
  return {
    code: feature.code, plugin_id: feature.plugin_id, plugin_name: feature.plugin_name,
    label: feature.label, explain: feature.explain, icon: feature.icon ?? "", input: "原始输入",
    usedAt: "2026-10-14T12:30:00.000Z", useCount: 4,
  };
}

beforeEach(() => {
  catalog = [originalFeature];
  searchFeatures = async () => [originalFeature];
  activationResult = new Promise(() => {});
  mocks.events.clear();
  mocks.invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  mocks.invoke.mockImplementation(async (command, args) => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
    if (command === "feature_catalog") return catalog;
    if (command === "search_features") return searchFeatures(args?.query ?? "");
    if (command === "read_launcher_clipboard_media") return { kind: "files", files: [pastedFile] };
    if (command === "search_file_content_features") return { files: [pastedFile], results: [fileFeature] };
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return [];
    if (command === "activate_feature") return activationResult;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
  localStorage.clear();
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
});

it("hides unavailable history without deleting it, restores it after re-enable, and refreshes trusted metadata", async () => {
  const original = historyEntry();
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify([original]));
  catalog = [];
  const disabled = render(App, { backgroundServices: false });
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("feature_catalog"));
  await waitFor(() => expect(screen.queryByRole("button", { name: "字符转换" })).toBeNull());
  expect(JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) || "[]")).toEqual([original]);
  disabled.unmount();

  catalog = [renamedFeature];
  render(App, { backgroundServices: false });
  expect(await screen.findByRole("button", { name: "文本转换" })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) || "[]")).toEqual([{
    ...original, label: "文本转换", explain: "转换文本格式", plugin_name: "转换插件新版", icon: "new-icon",
  }]);
});

it("invalidates a pending identical-query search when fixed native-confirmed files take over", async () => {
  let resolveSearch!: (results: SearchResult[]) => void;
  searchFeatures = (query) => query === legacyPasteQuery
    ? new Promise(resolve => { resolveSearch = resolve; })
    : Promise.resolve([originalFeature]);
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await fireEvent.input(input, { target: { value: legacyPasteQuery } });
  await waitFor(() => expect(resolveSearch).toBeTypeOf("function"));

  // Finder can expose a File without an absolute path; only the native reply confirms it.
  const file = new File(["sample"], "sample.txt", { type: "text/plain" });
  await fireEvent.paste(input, { clipboardData: { files: [file], getData: () => "" } });
  expect(await screen.findByRole("option", { name: /处理粘贴文件/ })).toBeTruthy();
  expect(screen.getByRole("button", { name: "移除固定文件" })).toBeTruthy();
  expect(input.value).toBe("");
  expect(mocks.invoke).toHaveBeenCalledWith("read_launcher_clipboard_media", undefined);
  expect(mocks.invoke).toHaveBeenCalledWith("search_file_content_features", { paths: [pastedFile.path] });
  expect(screen.getByRole("option", { name: /打开粘贴文件 sample.txt/ })).toBeTruthy();
  expect(screen.getByRole("option", { name: /在 Finder 中显示 sample.txt/ })).toBeTruthy();

  // Returning to the same query must still reject the pre-paste ordinary search generation.
  await fireEvent.input(input, { target: { value: legacyPasteQuery } });
  const ordinarySearchCalls = mocks.invoke.mock.calls.filter(([command]) => command === "search_features").length;
  resolveSearch([staleSearchResult]);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(screen.queryByText("旧搜索回包")).toBeNull();
  expect(screen.getByRole("option", { name: /处理粘贴文件/ })).toBeTruthy();
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "search_features")).toHaveLength(ordinarySearchCalls);

  await fireEvent.input(input, { target: { value: "" } });
  await fireEvent.click(screen.getByRole("option", { name: /打开粘贴文件 sample.txt/ }));
  expect(mocks.invoke).toHaveBeenCalledWith("call_agent_tool", {
    name: "open_or_reveal_path", arguments: { path: pastedFile.path, reveal: false }, clientId: "atools-ui", confirmed: false,
  });
  await fireEvent.click(screen.getByRole("option", { name: /在 Finder 中显示 sample.txt/ }));
  expect(mocks.invoke).toHaveBeenCalledWith("call_agent_tool", {
    name: "open_or_reveal_path", arguments: { path: pastedFile.path, reveal: true }, clientId: "atools-ui", confirmed: false,
  });
  expect(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) ?? "").not.toContain("sample.txt");
});

it("replays and removes only the visible owner when two plugins share a history code", async () => {
  const ownerA = historyEntry({ ...originalFeature, plugin_id: "owner-a", plugin_name: "旧来源", label: "旧功能" });
  const ownerB = historyEntry({ ...originalFeature, plugin_id: "owner-b", plugin_name: "新来源", label: "新功能" });
  ownerA.usedAt = "2026-10-15T12:00:00.000Z";
  ownerB.usedAt = "2026-10-15T11:00:00.000Z";
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify([ownerA, ownerB]));
  catalog = [{ ...originalFeature, plugin_id: "owner-b", plugin_name: "新来源", label: "新功能" }];
  activationResult = { plugin_id: "owner-a", feature_code: "convert", expand_height: 400 };

  render(App, { backgroundServices: false });
  const recent = await screen.findByRole("button", { name: "新功能" });
  expect(screen.queryByRole("button", { name: "旧功能" })).toBeNull();
  await fireEvent.click(recent);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("activate_feature", {
    code: "convert", payload: null, expectedPluginId: "owner-b",
  }));
  expect((await screen.findByRole("alert")).textContent).toContain("此功能的来源已变化");
  expect(document.querySelector("[data-plugin-feature-code]")).toBeNull();
  expect(JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) || "[]")).toEqual([ownerA, ownerB]);

  await fireEvent.contextMenu(recent);
  const menu = await screen.findByRole("menu");
  await fireEvent.click(within(menu).getByRole("menuitem", { name: "从最近使用移除" }));
  await waitFor(() => expect(JSON.parse(localStorage.getItem(COMMAND_HISTORY_STORAGE_KEY) || "[]")).toEqual([ownerA]));
});
