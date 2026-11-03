import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import App from "../../src/App.svelte";
import type { FeatureAction, SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), events: new Map<string, (event: unknown) => void>(), lifecycleGate: null as Promise<void> | null, stops: [] as string[] }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => { if (name === "plugin-code-changed") await mocks.lifecycleGate; mocks.events.set(name, callback); return () => { mocks.stops.push(name); mocks.events.delete(name); }; }) }));
vi.mock("../../src/lib/pinyinSearch", () => ({ loadSearchPinyinEngine: vi.fn(async () => false) }));
vi.mock("../../src/components/PluginPanelMount.svelte", async () => ({ default: (await import("./LauncherTextPluginMountFixture.svelte")).default }));
const target: SearchResult = { code: "convert", plugin_id: "converter", plugin_name: "转换工具", label: "字符转换", explain: "文本工具", icon: null, score: 10, match_type: "exact" };
const winner: SearchResult = { ...target, code: "other", plugin_id: "other-plugin", label: "其他结果", score: 100 };
let settings: Record<string, unknown>, catalog: SearchResult[], found: SearchResult[];
let failActivation = false;
let delayedActivation: ((args: Record<string, unknown>) => Promise<FeatureAction>) | null = null;
let refreshCatalog: (() => Promise<SearchResult[]>) | null = null;
beforeEach(() => {
  mocks.invoke.mockReset(); mocks.events.clear(); localStorage.clear(); failActivation = false; refreshCatalog = null; delayedActivation = null; mocks.lifecycleGate = null; mocks.stops.length = 0;
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  settings = { localAppSearch: false, autoPaste: "never", tabKeyFunction: "target-command", tabTarget: { pluginId: "converter", code: "convert", label: "旧名称" } };
  catalog = [target, winner]; found = [winner];
  mocks.invoke.mockImplementation(async (command, args = {}) => {
    if (command === "get_setting") return JSON.stringify(settings);
    if (command === "feature_catalog") return refreshCatalog ? refreshCatalog() : catalog;
    if (command === "search_features") return found;
    if (command === "search_text_content_features") return [winner];
    if (command === "search_file_content_features") return { files: [{ path: "/fixture/a.pdf", name: "a.pdf", isFile: true, isDirectory: false }], results: [{ ...winner, match_type: "files" }] };
    if (command === "list_pending_agent_requests" || command === "search_local_apps") return [];
    if (command === "activate_feature") {
      if (delayedActivation) return delayedActivation(args);
      if (failActivation) throw Error("FEATURE_OWNER_CHANGED: rejected");
      return { plugin_id: args.expectedPluginId, plugin_name: "转换工具", feature_code: args.code,
        main_url: "index.html", plugin_path: "/fixture/converter", expand_height: 500, payload: args.payload };
    }
  });
});
afterEach(() => { cleanup(); document.querySelectorAll("[data-permission-dialog]").forEach(node => node.remove()); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); });
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
async function setup(text = "  原文 😀 café  ") {
  localStorage.setItem("atools:settings-general", JSON.stringify(settings));
  render(App, { backgroundServices: false });
  const input = screen.getByRole("combobox") as HTMLInputElement;
  await waitFor(() => expect(mocks.events.has("builtin-plugins-loaded")).toBe(true));
  await fireEvent.input(input, { target: { value: text } });
  if (text.trim()) await waitFor(() => expect(calls("search_features").length).toBeGreaterThan(0));
  return input;
}
function seedHomeCards() {
  settings.showRecentInSearch = true;
  localStorage.setItem("atools:command-history", JSON.stringify([target, winner].map((feature, index) => ({
    code: feature.code,
    label: feature.label,
    explain: feature.explain,
    plugin_id: feature.plugin_id,
    plugin_name: feature.plugin_name,
    icon: "",
    input: `fixture ${index}`,
    usedAt: `2026-10-25T00:00:0${index}Z`,
    useCount: 1,
  }))));
}
it("Tab launches the configured identity with exact raw text, independent of highlighted result", async () => {
  const input = await setup();
  await screen.findByRole("option", { name: /其他结果/ });
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  expect(calls("activate_feature")[0][1]).toEqual({ code: "convert", expectedPluginId: "converter", payload: "  原文 😀 café  " });
  expect(await screen.findByTestId("content-entry-payload")).toHaveProperty("textContent", "  原文 😀 café  ");
});
it("zero search results still launch the target, without per-keystroke catalog requests", async () => {
  found = [];
  const input = await setup("unique unmatched text");
  const initial = calls("feature_catalog").length;
  await fireEvent.input(input, { target: { value: "unique unmatched text 2" } });
  expect(calls("feature_catalog")).toHaveLength(initial);
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  expect(calls("activate_feature")[0][1].payload).toBe("unique unmatched text 2");
});
it.each(["missing", "disabled", "collision", "unconfigured"])("%s target gives actionable feedback and preserves text", async state => {
  if (state === "unconfigured") settings.tabTarget = null;
  const input = await setup("preserved");
  if (state === "missing" || state === "disabled") catalog = [winner];
  if (state === "collision") catalog = [target, { ...target, plugin_id: "intruder" }];
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(screen.getByRole("button", { name: "设置 Tab 目标" })).toBeTruthy());
  await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/目标|工具|来源/));
  expect(input.value).toBe("preserved"); expect(calls("activate_feature")).toHaveLength(0);
});
it("rechecks owner at activation and presents a retryable failure without losing query", async () => {
  failActivation = true;
  const input = await setup("preserved");
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("重新选择"));
  expect(input.value).toBe("preserved");
});
it("Shift+Tab and navigate mode retain visual result cycling, Enter still launches selected result", async () => {
  found = [target, winner];
  const input = await setup("typed"); await screen.findByRole("option", { name: /其他结果/ });
  await fireEvent.keyDown(input, { key: "Tab", shiftKey: true });
  expect(calls("activate_feature")).toHaveLength(0);
  await fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  expect(calls("activate_feature")[0][1].code).toBe("convert");
});
it("default navigate Tab keeps query and changes selection without activation", async () => {
  settings.tabKeyFunction = "navigate"; found = [target, winner];
  const input = await setup("typed"); await screen.findByRole("option", { name: /其他结果/ });
  const selected = input.getAttribute("aria-activedescendant");
  await fireEvent.keyDown(input, { key: "Tab" });
  expect(input.getAttribute("aria-activedescendant")).not.toBe(selected);
  expect(input.value).toBe("typed"); expect(calls("activate_feature")).toHaveLength(0);
});
it.each([{ isComposing: true }, { keyCode: 229 }, { ctrlKey: true }, { metaKey: true }, { altKey: true }])("does not capture guarded Tab %j", async extra => {
  const input = await setup();
  await fireEvent.keyDown(input, { key: "Tab", ...extra });
  expect(calls("activate_feature")).toHaveLength(0);
});
it("does not capture prevented keys, other editable areas, menu or permission ownership", async () => {
  const input = await setup();
  const handled = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); handled.preventDefault(); input.dispatchEvent(handled);
  const textarea = document.createElement("textarea"); document.body.append(textarea);
  await fireEvent.keyDown(textarea, { key: "Tab" }); textarea.remove();
  const dialog = document.createElement("div"); dialog.setAttribute("data-permission-dialog", "true"); document.body.append(dialog);
  await fireEvent.keyDown(input, { key: "Tab" }); dialog.remove();
  expect(calls("activate_feature")).toHaveLength(0);
});
it("fixed text keeps its own input contract rather than passing its filter to the Tab target", async () => {
  const input = await setup("fixed original");
  await fireEvent.keyDown(input, { key: "f", ctrlKey: true });
  await screen.findByRole("button", { name: "编辑固定文本" });
  await fireEvent.input(input, { target: { value: "filter" } });
  const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); input.dispatchEvent(event);
  expect(event.defaultPrevented).toBe(false); expect(calls("activate_feature")).toHaveLength(0);
});

it.each(["input", "settings", "target", "unmount", "permission"])("ignores a late catalog after App %s changes", async change => {
  const input = await setup("captured");
  let release!: (rows: SearchResult[]) => void;
  refreshCatalog = () => new Promise(resolve => { release = resolve; });
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(release).toBeTypeOf("function"));
  if (change === "input") await fireEvent.input(input, { target: { value: "changed" } });
  if (change === "settings") await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  if (change === "target") window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { tabTarget: { pluginId: "other-plugin", code: "other", label: "其他工具" } } }));
  if (change === "unmount") cleanup();
  const modal = document.createElement("div");
  if (change === "permission") { modal.dataset.permissionDialog = "true"; document.body.append(modal); }
  release(catalog); await new Promise(resolve => setTimeout(resolve, 15));
  expect(calls("activate_feature")).toHaveLength(0); modal.remove();
});
it("coalesces repeated real App Tab during catalog refresh", async () => {
  const input = await setup("once");
  let release!: (rows: SearchResult[]) => void;
  refreshCatalog = vi.fn(() => new Promise<SearchResult[]>(resolve => { release = resolve; }));
  await fireEvent.keyDown(input, { key: "Tab" });
  await fireEvent.keyDown(input, { key: "Tab", repeat: true });
  expect(refreshCatalog).toHaveBeenCalledTimes(1);
  release(catalog); await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
});
it("media context retains its exact file token and filter on Tab", async () => {
  const input = await setup("");
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { files: [{ path: "/fixture/a.pdf", name: "a.pdf", type: "application/pdf", size: 8 }], getData: () => "" } });
  input.dispatchEvent(event);
  await screen.findByRole("button", { name: "移除固定文件" });
  await fireEvent.input(input, { target: { value: "filter" } });
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }); input.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false); expect(input.value).toBe("filter");
  expect(screen.getByRole("button", { name: "移除固定文件" })).toBeTruthy();
  expect(calls("activate_feature")).toHaveLength(0);
});

it("a result action menu owns Tab without firing the fixed target", async () => {
  const input = await setup("preserved");
  const row = await screen.findByRole("option", { name: /其他结果/ });
  await fireEvent.contextMenu(row, { clientX: 100, clientY: 100 });
  const menu = await screen.findByRole("menu");
  const action = menu.querySelector("button")!;
  await fireEvent.keyDown(action, { key: "Tab" });
  expect(calls("activate_feature")).toHaveLength(0); expect(input.value).toBe("preserved");
});

function descriptor(args: Record<string, unknown>): FeatureAction {
  return { plugin_id: String(args.expectedPluginId), plugin_name: "转换工具", feature_code: String(args.code),
    main_url: "index.html", plugin_path: "/fixture/converter", expand_height: 500, payload: args.payload };
}
it.each(["input", "target", "settings", "permission", "unmount", "mode", "query-aba", "target-aba", "scope-aba"])("does not commit an activation descriptor arriving after %s changes", async change => {
  const input = await setup("captured");
  let release!: () => void;
  delayedActivation = args => new Promise(resolve => { release = () => resolve(descriptor(args)); });
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  const expandedBefore = calls("expand_window").filter(([, args]) => args.height === 500).length;
  const modal = document.createElement("div");
  if (change === "input") await fireEvent.input(input, { target: { value: "changed" } });
  if (change === "target") window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { tabTarget: { pluginId: "other-plugin", code: "other", label: "其他工具" } } }));
  if (change === "settings") await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  if (change === "permission") { modal.dataset.permissionDialog = "true"; document.body.append(modal); }
  if (change === "unmount") cleanup();
  if (change === "mode") window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { tabKeyFunction: "navigate" } }));
  if (change === "query-aba") { await fireEvent.input(input, { target: { value: "changed" } }); await fireEvent.input(input, { target: { value: "captured" } }); }
  if (change === "target-aba") {
    window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { tabTarget: { pluginId: "other-plugin", code: "other", label: "其他工具" } } }));
    window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: settings }));
  }
  if (change === "scope-aba") {
    await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
    await fireEvent.click(await screen.findByRole("button", { name: "回到主搜索" }));
    await fireEvent.input(screen.getByRole("combobox"), { target: { value: "captured" } });
  }
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole("region", { name: "文本插件验收" })).toBeNull();
  expect(calls("expand_window").filter(([, args]) => args.height === 500)).toHaveLength(expandedBefore);
  if (change === "input") expect(input.value).toBe("changed");
  if (change === "unmount") expect(mocks.events.has("plugin-code-changed")).toBe(false);
  modal.remove();
});
it.each(["input", "target", "settings", "unmount"])("does not start native activation after lifecycle subscription resolves past %s changes", async change => {
  let release!: () => void;
  mocks.lifecycleGate = new Promise(resolve => { release = resolve; });
  const input = await setup("captured");
  await fireEvent.keyDown(input, { key: "Tab" });
  await new Promise(resolve => setTimeout(resolve, 10));
  expect(calls("activate_feature")).toHaveLength(0);
  if (change === "input") await fireEvent.input(input, { target: { value: "changed" } });
  if (change === "target") window.dispatchEvent(new CustomEvent("atools-settings-updated", { detail: { tabTarget: { pluginId: "other-plugin", code: "other", label: "其他工具" } } }));
  if (change === "settings") await fireEvent.click(screen.getByRole("button", { name: "打开设置" }));
  if (change === "unmount") cleanup();
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(calls("activate_feature")).toHaveLength(0);
  expect(screen.queryByRole("region", { name: "文本插件验收" })).toBeNull();
  if (change === "unmount") { expect(mocks.events.has("plugin-code-changed")).toBe(false); expect(mocks.stops.filter(name => name === "plugin-code-changed")).toHaveLength(1); }
});
it("native activation stays single while repeated Tab waits for the descriptor", async () => {
  const input = await setup("once");
  let release!: () => void;
  delayedActivation = args => new Promise(resolve => { release = () => resolve(descriptor(args)); });
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  await fireEvent.keyDown(input, { key: "Tab", repeat: true });
  await fireEvent.keyDown(input, { key: "Tab", repeat: true });
  expect(calls("activate_feature")).toHaveLength(1);
  release(); await screen.findByRole("region", { name: "文本插件验收" });
  expect(calls("activate_feature")).toHaveLength(1);
});

it.each(["", "   "])("shows actionable Tab feedback with Home disabled and empty query %j", async text => {
  settings.showRecentInSearch = false; settings.tabTarget = null;
  const input = await setup(text);
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("尚未设置"));
  expect(screen.getByRole("button", { name: "设置 Tab 目标" })).toBeTruthy();
  expect(input.value).toBe(text);
});

it.each(["text", "files"])("invalidates empty-query pending Tab across paste/remove %s context ABA", async kind => {
  const input = await setup("");
  let release!: () => void;
  delayedActivation = args => new Promise(resolve => { release = () => resolve(descriptor(args)); });
  await fireEvent.keyDown(input, { key: "Tab" });
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: {
    files: kind === "files" ? [{ path: "/fixture/a.pdf", name: "a.pdf", type: "application/pdf", size: 8 }] : [],
    getData: () => kind === "text" ? "pasted content" : "",
  } });
  input.dispatchEvent(paste);
  await fireEvent.click(await screen.findByRole("button", { name: kind === "text" ? "移除固定文本" : "移除固定文件" }));
  expect(input.value).toBe("");
  release(); await new Promise(resolve => setTimeout(resolve, 30));
  expect(screen.queryByRole("region", { name: "文本插件验收" })).toBeNull();
});

function homeCommandButtons(): HTMLButtonElement[] {
  const panel = screen.queryByRole("region", { name: "ATools 首页" });
  return panel ? Array.from(panel.querySelectorAll<HTMLButtonElement>("button.recent-item")) : [];
}

it("plain Tab from the empty main search focuses the selected Home card without activation", async () => {
  settings.tabKeyFunction = "navigate";
  seedHomeCards();
  const input = await setup("");
  await waitFor(() => expect(homeCommandButtons().length).toBeGreaterThan(1));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(true);
  const buttons = homeCommandButtons();
  expect(document.activeElement).toBe(buttons.find(button => button.tabIndex === 0));
  expect(calls("activate_feature")).toHaveLength(0);

  await fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
  expect(document.activeElement).toBe(buttons[1]);
  await waitFor(() => expect(buttons[1].tabIndex).toBe(0));
  const leave = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  buttons[1].dispatchEvent(leave);
  expect(leave.defaultPrevented).toBe(false);
  expect(calls("activate_feature")).toHaveLength(0);
});

it("target-command preference keeps its configured launch path before Home entry", async () => {
  const input = await setup("");
  await waitFor(() => expect(calls("feature_catalog").length).toBeGreaterThan(0));
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(tab);
  await waitFor(() => expect(calls("activate_feature")).toHaveLength(1));
  expect(tab.defaultPrevented).toBe(true);
  expect(calls("activate_feature")[0][1]).toEqual({ code: "convert", expectedPluginId: "converter", payload: "" });
  await waitFor(() => expect(homeCommandButtons()).toHaveLength(0));
  expect((await screen.findByTestId("content-entry-payload")).textContent).toBe("");
});

it("does not enter Home from another focus target or a text/media search context", async () => {
  settings.tabKeyFunction = "navigate";
  const input = await setup("");
  const outside = screen.getByRole("button", { name: "打开设置" });
  outside.focus();
  const outsideTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  outside.dispatchEvent(outsideTab);
  expect(outsideTab.defaultPrevented).toBe(false);
  expect(document.activeElement).toBe(outside);

  await fireEvent.input(input, { target: { value: "search context" } });
  await screen.findByRole("option", { name: /其他结果/ });
  expect(homeCommandButtons()).toHaveLength(0);
  input.focus();
  const textTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(textTab);
  expect(document.activeElement).toBe(input);
  expect(calls("activate_feature")).toHaveLength(0);

  await fireEvent.input(input, { target: { value: "" } });
  const textPaste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(textPaste, "clipboardData", { value: { files: [], getData: () => "fixed text context" } });
  input.dispatchEvent(textPaste);
  await screen.findByRole("button", { name: "编辑固定文本" });
  expect(homeCommandButtons()).toHaveLength(0);
  input.focus();
  const fixedTextTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(fixedTextTab);
  expect(document.activeElement).toBe(input);
  expect(calls("activate_feature")).toHaveLength(0);
});

it("does not enter Home when a fixed file context is active", async () => {
  settings.tabKeyFunction = "navigate";
  const input = await setup("");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: {
    files: [{ path: "/fixture/a.pdf", name: "a.pdf", type: "application/pdf", size: 8 }],
    getData: () => "",
  } });
  input.dispatchEvent(paste);
  await screen.findByRole("button", { name: "移除固定文件" });
  expect(homeCommandButtons()).toHaveLength(0);
  input.focus();
  const mediaTab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  input.dispatchEvent(mediaTab);
  expect(document.activeElement).toBe(input);
  expect(calls("activate_feature")).toHaveLength(0);
});

it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }])(
  "does not capture modified or composing Home-entry Tab %j", async extra => {
    settings.tabKeyFunction = "navigate";
    seedHomeCards();
    const input = await setup("");
    await waitFor(() => expect(homeCommandButtons().length).toBeGreaterThan(0));
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true, ...extra });
    input.dispatchEvent(tab);
    expect(document.activeElement).not.toBe(homeCommandButtons()[0]);
    expect(calls("activate_feature")).toHaveLength(0);
  },
);
