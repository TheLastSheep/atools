import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: unknown) => void>() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { mocks.events.set(name, callback); return () => mocks.events.delete(name); }) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanelMount.svelte", async () => ({ default: (await import("./LauncherTextPluginMountFixture.svelte")).default }));

type ContentResult = SearchResult & { content_search_terms?: string[] };
const json: ContentResult = {
  code: "json-format", plugin_id: "format-plugin", plugin_name: "格式工具", label: "格式化 JSON",
  explain: "整理内容", icon: null, score: 100, match_type: "regex", content_search_terms: ["json", "美化", "pretty-json"],
};
const over: ContentResult = {
  code: "text-count", plugin_id: "text-plugin", plugin_name: "文本工具", label: "统计字符",
  explain: "字数和行数", icon: null, score: 80, match_type: "over", content_search_terms: ["字数", "count"],
};
let contentSearch: (content: string) => Promise<SearchResult[]>;
let activation: (args: Record<string, unknown>) => Promise<unknown>;

beforeEach(() => {
  mocks.invoke.mockReset(); mocks.events.clear();
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.clear();
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: true, autoPaste: "never", showRecentInSearch: false }));
  contentSearch = async () => [json, over];
  activation = async args => ({ plugin_id: "format-plugin", plugin_name: "格式工具", feature_code: args.code,
    main_url: "index.html", plugin_path: "/fixture/format-plugin", expand_height: 500,
    payload: args.content ?? args.payload, entry_type: "regex" });
  mocks.invoke.mockImplementation((command, args = {}) => {
    if (command === "get_setting") return Promise.resolve(localStorage.getItem("atools-settings"));
    if (command === "feature_catalog") return Promise.resolve([json, over]);
    if (command === "search_text_content_features") return contentSearch(args.content);
    if (command === "search_features") return Promise.resolve([json, over]);
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return Promise.resolve([]);
    if (command === "activate_text_content_feature" || command === "activate_feature") return activation(args);
    return Promise.resolve(undefined);
  });
});
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });

async function setup() {
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  return input;
}
async function pin(input: HTMLInputElement, text = '  {"a": 1}  ') {
  await fireEvent.input(input, { target: { value: text } });
  await fireEvent.keyDown(input, { key: "f", ctrlKey: true });
  await screen.findByRole("button", { name: "编辑固定文本" });
}
function paste(input: HTMLInputElement, text: string, files: unknown[] = []) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files, getData: () => text } });
  input.dispatchEvent(event);
  return event;
}
function calls(command: string) { return mocks.invoke.mock.calls.filter(([name]) => name === command); }

it("fixes trimmed Cmd/Ctrl+F text and filters only original plugin candidates, including command aliases", async () => {
  const input = await setup();
  await pin(input);
  await screen.findByRole("option", { name: /格式化 JSON/ });
  expect(input.value).toBe("");
  expect(calls("search_text_content_features").map(([, args]) => args)).toEqual([{ content: '{"a": 1}' }]);
  const searchCalls = calls("search_features").length;
  const appCalls = calls("search_local_apps").length;
  await fireEvent.input(input, { target: { value: "pretty-json" } });
  expect(screen.getAllByRole("option")).toHaveLength(1);
  expect(screen.getByRole("option", { name: /格式化 JSON/ })).toBeTruthy();
  await fireEvent.input(input, { target: { value: "文本工具" } });
  expect(screen.getByRole("option", { name: /统计字符/ })).toBeTruthy();
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
  expect(calls("search_text_content_features")).toHaveLength(1);
  expect(calls("search_features")).toHaveLength(searchCalls);
  expect(calls("search_local_apps")).toHaveLength(appCalls);
});

it("pastes complete plain text into an empty search and keeps the original out of title and ARIA", async () => {
  const input = await setup();
  const text = '  private \n {"a": 1}  ';
  expect(paste(input, text).defaultPrevented).toBe(true);
  await screen.findByRole("button", { name: "编辑固定文本" });
  await screen.findByRole("option", { name: /格式化 JSON/ });
  expect(calls("search_text_content_features")[0][1]).toEqual({ content: text });
  expect(input.value).toBe("");
  expect(document.querySelector(`[title=${JSON.stringify(text)}]`)).toBeNull();
  for (const node of document.querySelectorAll("[aria-label], [title]")) {
    expect(node.getAttribute("aria-label") ?? "").not.toContain(text);
    expect(node.getAttribute("title") ?? "").not.toContain(text);
  }
  expect(JSON.stringify(Object.fromEntries(Object.keys(localStorage).map(key => [key, localStorage.getItem(key)])))).not.toContain("private");
});

it("leaves pasting into existing or selected query text to native insertion", async () => {
  const input = await setup();
  await fireEvent.input(input, { target: { value: "existing" } });
  input.setSelectionRange(0, input.value.length);
  expect(paste(input, "replacement").defaultPrevented).toBe(false);
  expect(calls("search_text_content_features")).toHaveLength(0);
});

it("clears filter, then fixed text, then hides on successive Escape presses", async () => {
  const input = await setup(); await pin(input);
  await screen.findByRole("option", { name: /格式化 JSON/ });
  await fireEvent.input(input, { target: { value: "json" } });
  await fireEvent.keyDown(input, { key: "Escape" });
  expect(input.value).toBe(""); expect(screen.getByRole("button", { name: "编辑固定文本" })).toBeTruthy();
  await fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
  expect(calls("hide_main_window")).toHaveLength(0);
  await fireEvent.keyDown(input, { key: "Escape" });
  expect(calls("hide_main_window")).toHaveLength(1);
});

it.each(["Backspace", "Delete"])("restores and selects the original text with %s in an empty filter", async key => {
  const input = await setup(); await pin(input);
  await fireEvent.keyDown(input, { key });
  await waitFor(() => expect(input.value).toBe('{"a": 1}'));
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
});

it("edits a fixed token without an extra select-all request and offers explicit removal", async () => {
  const input = await setup(); await pin(input);
  await fireEvent.click(screen.getByRole("button", { name: "编辑固定文本" }));
  await waitFor(() => expect(input.value).toBe('{"a": 1}'));
  expect(input.selectionStart).toBe(input.selectionEnd);
  await fireEvent.keyDown(input, { key: "F", metaKey: true });
  await screen.findByRole("button", { name: "移除固定文本" });
  await fireEvent.click(screen.getByRole("button", { name: "移除固定文本" }));
  expect(input.value).toBe("");
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
});

it("activates with raw fixed content and owner through the existing plugin lifecycle, without body history", async () => {
  const input = await setup(); const text = '  {"secret": "fixed body"}\n';
  paste(input, text);
  await fireEvent.click(await screen.findByRole("option", { name: /格式化 JSON/ }));
  await screen.findByRole("region", { name: "文本插件验收" });
  expect(calls("activate_text_content_feature").map(([, args]) => args)).toEqual([{ code: json.code, content: text, expectedPluginId: json.plugin_id }]);
  expect(calls("activate_feature")).toHaveLength(0);
  expect(screen.getByTestId("content-entry-type").textContent).toBe("regex");
  expect(screen.getByTestId("content-entry-payload").textContent).toBe(text);
  expect(localStorage.getItem("atools:command-history") ?? "").not.toContain("fixed body");
  await fireEvent.click(screen.getByRole("button", { name: "关闭文本插件" }));
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("");
});

it("passes ordinary regex matches their raw query with the same content activation path", async () => {
  const input = await setup(); const text = ' {"raw": true} ';
  await fireEvent.input(input, { target: { value: text } });
  await waitFor(() => expect(document.querySelector('[data-result-code="json-format"]')).not.toBeNull());
  await fireEvent.click(document.querySelector('[data-result-code="json-format"]')!);
  await waitFor(() => expect(calls("activate_text_content_feature")).toHaveLength(1));
  await screen.findByRole("region", { name: "文本插件验收" });
  expect(calls("activate_text_content_feature")[0][1]).toEqual({ code: json.code, content: text, expectedPluginId: json.plugin_id });
});

it("rejects oversized UTF-8 text visibly and does not truncate or execute it", async () => {
  const input = await setup();
  expect(paste(input, "界".repeat(87382)).defaultPrevented).toBe(true);
  expect((await screen.findByRole("alert")).textContent).toContain("256 KiB");
  expect(calls("search_text_content_features")).toHaveLength(0);
  expect(input.value).toBe("");
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
});

it("invalidates pending content results on removal, panel changes and pasted files", async () => {
  let resolve!: (value: SearchResult[]) => void;
  contentSearch = () => new Promise(done => { resolve = done; });
  const input = await setup(); await pin(input);
  await fireEvent.click(screen.getByRole("button", { name: "移除固定文本" }));
  resolve([json]); await Promise.resolve();
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
  await pin(input);
  const stale = resolve;
  paste(input, "", [new File([new Uint8Array([137,80,78,71])], "photo.png", { type: "image/png" })]);
  await screen.findByRole("option", { name: /保存图片后再处理/ });
  stale([json]); await Promise.resolve();
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
});

it("refreshes catalog candidates once and never revives an earlier content response", async () => {
  const pending: Array<(value: SearchResult[]) => void> = [];
  contentSearch = () => new Promise(resolve => pending.push(resolve));
  const input = await setup(); await pin(input);
  mocks.events.get("builtin-plugins-loaded")?.({ payload: null });
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[0]([json]); await Promise.resolve();
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
  pending[1]([over]);
  await screen.findByRole("option", { name: /统计字符/ });
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
});

it("does not pin IME composition, modified find shortcuts or another editor's input", async () => {
  const input = await setup(); await fireEvent.input(input, { target: { value: "draft" } });
  await fireEvent.keyDown(input, { key: "f", ctrlKey: true, shiftKey: true });
  await fireEvent.keyDown(input, { key: "f", ctrlKey: true, altKey: true });
  await fireEvent.compositionStart(input);
  await fireEvent.keyDown(input, { key: "f", ctrlKey: true, isComposing: true });
  expect(calls("search_text_content_features")).toHaveLength(0);
  await fireEvent.compositionEnd(input, { data: "draft" });
  const other = document.createElement("textarea"); document.body.append(other); other.value = "other";
  await fireEvent.keyDown(other, { key: "f", ctrlKey: true }); other.remove();
  expect(calls("search_text_content_features")).toHaveLength(0);
});

it("ignores ordinary search results that finish after text was fixed", async () => {
  let resolve!: (value: SearchResult[]) => void;
  const original = mocks.invoke.getMockImplementation()!;
  mocks.invoke.mockImplementation((command, args) => command === "search_features"
    ? new Promise<SearchResult[]>(done => { resolve = done; }) : original(command, args));
  const input = await setup();
  await fireEvent.input(input, { target: { value: "ordinary" } });
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  await fireEvent.keyDown(input, { key: "f", ctrlKey: true });
  await screen.findByRole("option", { name: /统计字符/ });
  resolve([{ ...json, code: "stale-ordinary", label: "过时的应用结果", match_type: "exact" }]);
  await Promise.resolve();
  expect(screen.queryByRole("option", { name: /过时的应用结果/ })).toBeNull();
});

it("applies the latest local filter when initial content candidates arrive", async () => {
  let resolve!: (value: SearchResult[]) => void;
  contentSearch = () => new Promise(done => { resolve = done; });
  const input = await setup(); await pin(input);
  await fireEvent.input(input, { target: { value: "count" } });
  resolve([json, over]);
  await screen.findByRole("option", { name: /统计字符/ });
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
  expect(calls("search_text_content_features")).toHaveLength(1);
});

it("replaces fixed content on a new empty-input paste and rejects the previous response", async () => {
  const pending: Array<(value: SearchResult[]) => void> = [];
  contentSearch = () => new Promise(resolve => pending.push(resolve));
  const input = await setup(); await pin(input, "old text");
  paste(input, "  second text \n");
  await waitFor(() => expect(pending).toHaveLength(2));
  pending[0]([json]); await Promise.resolve();
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
  pending[1]([over]); await screen.findByRole("option", { name: /统计字符/ });
  expect(calls("search_text_content_features")[1][1]).toEqual({ content: "  second text \n" });
});

it("clears fixed text when opening settings and prevents its pending response from returning", async () => {
  let resolve!: (value: SearchResult[]) => void;
  contentSearch = () => new Promise(done => { resolve = done; });
  const input = await setup(); await pin(input);
  await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  expect(screen.queryByRole("button", { name: "编辑固定文本" })).toBeNull();
  resolve([json]); await Promise.resolve();
  expect(screen.queryByRole("option", { name: /格式化 JSON/ })).toBeNull();
});

it("does not commit an activation after fixed text was removed while the host was pending", async () => {
  let resolve!: (value: unknown) => void;
  activation = () => new Promise(done => { resolve = done; });
  const input = await setup(); await pin(input);
  await fireEvent.click(await screen.findByRole("option", { name: /格式化 JSON/ }));
  await waitFor(() => expect(resolve).toBeTypeOf("function"));
  await fireEvent.click(screen.getByRole("button", { name: "移除固定文本" }));
  resolve({ plugin_id: json.plugin_id, plugin_name: json.plugin_name, feature_code: json.code,
    main_url: "index.html", plugin_path: "/fixture", expand_height: 500, payload: "old text", entry_type: "regex" });
  await Promise.resolve(); await Promise.resolve();
  expect(screen.queryByRole("region", { name: "文本插件验收" })).toBeNull();
  expect(calls("expand_window").some(([, args]) => args.height === 500)).toBe(false);
});

it("keeps owner validation on the content activation path", async () => {
  activation = async args => ({ plugin_id: "changed-owner", plugin_name: "不同插件", feature_code: args.code,
    main_url: "index.html", plugin_path: "/fixture", expand_height: 500, payload: args.content, entry_type: "regex" });
  const input = await setup(); await pin(input);
  await fireEvent.click(await screen.findByRole("option", { name: /格式化 JSON/ }));
  expect((await screen.findByRole("alert")).textContent).toContain("来源已变化");
  expect(screen.queryByRole("region", { name: "文本插件验收" })).toBeNull();
  expect(screen.getByRole("button", { name: "编辑固定文本" })).toBeTruthy();
});

it("reports content failures without putting the body or untrusted backend error into the UI", async () => {
  contentSearch = async content => { throw new Error(`failure ${content}`); };
  const input = await setup(); await pin(input, "private backend body");
  expect((await screen.findByRole("alert")).textContent).toContain("文本匹配暂不可用");
  expect(screen.getByRole("alert").textContent).not.toContain("private backend body");
});

it("keeps the fixed candidates restricted to text match kinds even for unexpected backend rows", async () => {
  contentSearch = async () => [json, { ...over, code: "non-content", label: "普通命令", match_type: "exact" }];
  const input = await setup(); await pin(input);
  await screen.findByRole("option", { name: /格式化 JSON/ });
  expect(screen.queryByRole("option", { name: /普通命令/ })).toBeNull();
});


it("keeps over-type activation separate from payload while retaining the full fixed text", async () => {
  activation = async args => ({ plugin_id: over.plugin_id, plugin_name: over.plugin_name, feature_code: args.code,
    main_url: "index.html", plugin_path: "/fixture", expand_height: 500, payload: args.content, entry_type: "over" });
  const input = await setup(); const body = "  full text\nsecond line  "; paste(input, body);
  await fireEvent.click(await screen.findByRole("option", { name: /统计字符/ }));
  await screen.findByRole("region", { name: "文本插件验收" });
  expect(calls("activate_text_content_feature")[0][1]).toEqual({ code: over.code, content: body, expectedPluginId: over.plugin_id });
  expect(screen.getByTestId("content-entry-type").textContent).toBe("over");
  expect(screen.getByTestId("content-entry-payload").textContent).toBe(body);
});
