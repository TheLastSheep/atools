import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { flushSync, tick } from "svelte";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Harness from "./LauncherMenuDismissalHarness.svelte";
import App from "../../src/App.svelte";
import { COMMAND_HISTORY_STORAGE_KEY } from "../../src/lib/commandHistory";
import { PINNED_COMMANDS_STORAGE_KEY } from "../../src/lib/pinnedCommands";
import { persistLauncherPins, reconcileLauncherPins } from "../../src/lib/launcherPins";
import type { SearchResult } from "../../src/lib/types";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", async original => ({ ...await original<typeof import("@tauri-apps/api/core")>(), invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

beforeEach(() => { vi.spyOn(document, "hasFocus").mockReturnValue(true); });
afterEach(() => { cleanup(); localStorage.clear(); Reflect.deleteProperty(window, "__TAURI_INTERNALS__"); vi.restoreAllMocks(); });
async function open() {
  screen.getByRole("combobox").focus();
  await fireEvent.contextMenu(screen.getByRole("button", { name: "操作目标" }));
  const menu = await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitemcheckbox")));
  return menu;
}
async function settled() {
  await tick(); await tick();
  await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  await tick(); await tick();
}

it("restores search after the pointer's later mousedown default action blurs the removed menu", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  const blank = screen.getByTestId("blank");
  await fireEvent.pointerDown(blank);
  await tick(); await tick();
  // JSDOM omits the browser's native mousedown focus default. Reproduce that
  // default after the pointerdown microtask checkpoint, as Chromium does.
  await fireEvent.mouseDown(blank);
  (document.activeElement as HTMLElement).blur();
  await fireEvent.mouseUp(blank); await fireEvent.click(blank);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  expect(onrestore).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("保留搜索词");
});

it.each(["pointer", "wheel"])("returns %s cancellation to search and keeps the current query", async kind => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  if (kind === "pointer") await fireEvent.pointerDown(screen.getByTestId("blank"));
  else await fireEvent.wheel(window);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  expect(screen.queryByRole("menu")).toBeNull();
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("保留搜索词");
  expect(onrestore).toHaveBeenCalledTimes(1);
});

it.each(["外部按钮", "外部输入", "其他编辑器", "富文本编辑器"])("respects pointer handoff to %s", async name => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  const control = name === "外部按钮" ? screen.getByRole("button", { name }) : screen.getByLabelText(name);
  const closing = fireEvent.pointerDown(control); control.focus(); await closing; await settled();
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(control);
  expect(onrestore).not.toHaveBeenCalled();
});

it("does not restore before a label's later click transfers focus to its input", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  await fireEvent.pointerDown(screen.getByText("外部输入标签")); await settled();
  expect(onrestore).not.toHaveBeenCalled();
  const control = screen.getByLabelText("外部输入"); control.focus();
  expect(document.activeElement).toBe(control);
});

it("treats a disabled button as cancellation rather than a focus destination", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  await fireEvent.pointerDown(screen.getByRole("button", { name: "禁用按钮" }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  expect(onrestore).toHaveBeenCalledTimes(1);
});

it("closes on real focus departure without taking focus back from another editor", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  const editor = screen.getByLabelText("其他编辑器"); editor.focus(); await settled();
  expect(screen.queryByRole("menu")).toBeNull(); expect(document.activeElement).toBe(editor);
  await fireEvent.wheel(window); expect(onrestore).not.toHaveBeenCalled();
});

it("does not restore if focus has already left even when no focusout reaches the menu", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); const menu = await open();
  // A native host or another component can move focus without a DOM focusout observation.
  const editor = screen.getByLabelText("其他编辑器");
  vi.spyOn(document, "activeElement", "get").mockReturnValue(editor);
  await fireEvent.wheel(menu); await settled();
  expect(screen.queryByRole("menu")).toBeNull(); expect(onrestore).not.toHaveBeenCalled();
});

it("respects an external control taking focus before deferred cancellation finishes", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  const closing = fireEvent.wheel(window);
  const control = screen.getByLabelText("外部输入"); control.focus();
  await closing; await settled();
  expect(document.activeElement).toBe(control); expect(onrestore).not.toHaveBeenCalled();
});

it("does not let an older cancellation take focus from a new menu", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  const closing = fireEvent.pointerDown(screen.getByTestId("blank"));
  const reopening = fireEvent.contextMenu(screen.getByRole("button", { name: "操作目标" }));
  await Promise.all([closing, reopening]); await settled();
  const menu = screen.getByRole("menu");
  expect(document.activeElement).toBe(within(menu).getByRole("menuitemcheckbox"));
  expect(onrestore).not.toHaveBeenCalled();
});

it("does not restore when the window blurs during cancellation", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  const closing = fireEvent.wheel(window); await fireEvent.blur(window); await closing; await settled();
  expect(screen.queryByRole("menu")).toBeNull(); expect(onrestore).not.toHaveBeenCalled();
});

it("closes a system-blurred menu without bringing the window's search focus back", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  await fireEvent.blur(window); await settled();
  expect(screen.queryByRole("menu")).toBeNull(); expect(onrestore).not.toHaveBeenCalled();
});

it("does not restore while the document reports lost focus", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); await open();
  vi.mocked(document.hasFocus).mockReturnValue(false);
  await fireEvent.wheel(window); await settled(); expect(onrestore).not.toHaveBeenCalled();
});

it("does not run a pending restoration after the menu component is destroyed", async () => {
  const onrestore = vi.fn(); const view = render(Harness, { onrestore }); await open();
  const closing = fireEvent.wheel(window); view.unmount(); await closing; await settled();
  expect(onrestore).not.toHaveBeenCalled();
});

it("cancels its one pending frame when destroyed rather than leaving restoration work behind", async () => {
  const onrestore = vi.fn(); const view = render(Harness, { onrestore }); await open();
  const request = vi.spyOn(window, "requestAnimationFrame"), cancel = vi.spyOn(window, "cancelAnimationFrame");
  await fireEvent.pointerDown(screen.getByTestId("blank"));
  expect(request).toHaveBeenCalledTimes(1);
  const frame = request.mock.results[0].value;
  view.unmount();
  expect(cancel).toHaveBeenCalledWith(frame);
  await settled(); expect(onrestore).not.toHaveBeenCalled();
});

it("does not restore a pending cancellation after the launcher is disabled", async () => {
  const onrestore = vi.fn(); const view = render(Harness, { onrestore }); await open();
  const closing = fireEvent.wheel(window); await view.rerender({ enabled: false, onrestore });
  await closing; await settled(); expect(onrestore).not.toHaveBeenCalled();
});

it.each(["Escape", "Tab"])("%s leaves the menu for search without losing the query", async key => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); const menu = await open();
  await fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key });
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  expect(screen.queryByRole("menu")).toBeNull(); expect(onrestore).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("combobox") as HTMLInputElement).value).toBe("保留搜索词");
});

it.each(["menuitemcheckbox", "menuitem"])("executing %s returns focus to search", async role => {
  const onrestore = vi.fn(), onremove = vi.fn(); render(Harness, { onrestore, onremove }); const menu = await open();
  const action = within(menu).getByRole(role); action.focus(); await fireEvent.click(action);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  expect(onrestore).toHaveBeenCalledTimes(1); expect(onremove).toHaveBeenCalledTimes(role === "menuitem" ? 1 : 0);
});

it.each([{ isComposing: true }, { keyCode: 229 }])("does not run menu actions during IME composition: %j", async composing => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); const menu = await open();
  const action = within(menu).getByRole("menuitemcheckbox");
  await fireEvent.keyDown(action, { key: "ArrowDown", ...composing });
  await fireEvent.keyDown(action, { key: "Escape", ...composing });
  await fireEvent.keyDown(action, { key: "Tab", ...composing });
  for (const key of ["Enter", " "]) {
    const activation = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...composing });
    action.dispatchEvent(activation); expect(activation.defaultPrevented).toBe(true);
  }
  expect(screen.getByRole("menu")).toBe(menu); expect(document.activeElement).toBe(action);
  expect(onrestore).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
});

it.each(["tile", "remove"])("home %s hover preserves the open menu's keyboard ownership through Enter and Escape", async hoverTarget => {
  const alpha: SearchResult = { code: "alpha", plugin_id: "converter", plugin_name: "转换插件", label: "甲指令",
    explain: "", icon: null, score: 1, match_type: "exact" };
  const beta = { ...alpha, code: "beta", label: "乙指令" };
  Object.assign(window, { __TAURI_INTERNALS__: { metadata: { currentWindow: { label: "main" } } } });
  localStorage.setItem("atools-settings", JSON.stringify({ localAppSearch: false, autoPaste: "never" }));
  localStorage.setItem(COMMAND_HISTORY_STORAGE_KEY, JSON.stringify([alpha, beta].map((item, index) => ({
    ...item, icon: "", input: item.label, usedAt: new Date(Date.now() - index * 1000).toISOString(), useCount: 1,
  }))));
  persistLauncherPins(reconcileLauncherPins({ codes: [alpha.code], catalog: [alpha], snapshots: [], catalogReady: true, resolveLocal: () => null }));
  mocks.invoke.mockReset().mockImplementation(async command => {
    if (command === "get_setting") return JSON.stringify({ localAppSearch: false, autoPaste: "never" });
    if (command === "feature_catalog") return [alpha, beta];
    if (command === "search_local_apps" || command === "list_pending_agent_requests") return [];
    return undefined;
  });
  render(App, { backgroundServices: false });
  const first = await screen.findByRole("button", { name: alpha.label });
  const other = () => screen.getByRole("button", { name: hoverTarget === "tile" ? beta.label : `移除 ${beta.label}` });
  await fireEvent.contextMenu(first);
  let menu = await screen.findByRole("menu");
  const pin = within(menu).getByRole("menuitemcheckbox");
  await waitFor(() => expect(document.activeElement).toBe(pin));
  await fireEvent.mouseEnter(other()); await settled();
  expect(document.activeElement).toBe(pin); expect(screen.getByRole("menu")).toBe(menu);
  await fireEvent.keyDown(pin, { key: "Enter" });
  // fireEvent does not synthesize the browser's native button activation for Enter.
  await fireEvent.click(pin);
  expect(JSON.parse(localStorage.getItem(PINNED_COMMANDS_STORAGE_KEY) || "[]")).toEqual([]);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature")).toBe(false);
  await fireEvent.contextMenu(screen.getByRole("button", { name: alpha.label })); menu = await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitemcheckbox")));
  await fireEvent.mouseEnter(other()); await fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("combobox")));
  await fireEvent.contextMenu(screen.getByRole("button", { name: alpha.label })); menu = await screen.findByRole("menu");
  await waitFor(() => expect(document.activeElement).toBe(within(menu).getByRole("menuitemcheckbox")));
  const closing = fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  const settings = screen.getByRole("button", { name: "打开设置" }); settings.focus();
  await closing; await settled(); expect(document.activeElement).toBe(settings);
  expect(mocks.invoke.mock.calls.some(([command]) => command === "activate_feature" || command === "hide_main_window")).toBe(false);
});

it("keeps another editor's focus when the search component mounts with autofocus pending", async () => {
  render(Harness); const editor = screen.getByLabelText("其他编辑器"); editor.focus();
  await settled(); expect(document.activeElement).toBe(editor);
});

it("keeps an external editor that takes focus after the menu has issued its asynchronous search callback", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); const menu = await open();
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  expect(onrestore).toHaveBeenCalledTimes(1);
  const editor = screen.getByLabelText("其他编辑器"); editor.focus();
  await closing; await settled(); expect(document.activeElement).toBe(editor);
});

it("keeps a freshly opened menu after the prior menu already issued its search callback", async () => {
  const onrestore = vi.fn(); render(Harness, { onrestore }); const menu = await open();
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  expect(onrestore).toHaveBeenCalledTimes(1);
  const reopening = fireEvent.contextMenu(screen.getByRole("button", { name: "操作目标" }));
  await Promise.all([closing, reopening]); await settled();
  const fresh = screen.getByRole("menu");
  expect(document.activeElement).toBe(within(fresh).getByRole("menuitemcheckbox"));
});

it("preserves the actual App settings button when it takes focus before initial search autofocus settles", async () => {
  mocks.invoke.mockReset().mockResolvedValue(undefined);
  render(App, { backgroundServices: false });
  const settings = screen.getByRole("button", { name: "打开设置" }); settings.focus();
  await settled(); expect(document.activeElement).toBe(settings);
});

it("does not revive a pending request after another editor takes and then releases focus", async () => {
  render(Harness); const menu = await open();
  const input = screen.getByRole("combobox"); const focus = vi.spyOn(input, "focus");
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  flushSync();
  const editor = screen.getByLabelText("其他编辑器"); editor.focus(); editor.blur();
  await closing; await settled(); expect(focus).not.toHaveBeenCalled();
});

it("does not apply an already-issued callback after destruction disconnects its search input", async () => {
  const view = render(Harness); const menu = await open();
  const input = screen.getByRole("combobox"); const focus = vi.spyOn(input, "focus");
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  flushSync(); view.unmount(); await closing; await settled();
  expect(input.isConnected).toBe(false); expect(focus).not.toHaveBeenCalled();
});

it("does not apply an already-issued callback after a system window blur", async () => {
  render(Harness); const menu = await open();
  const input = screen.getByRole("combobox"); const focus = vi.spyOn(input, "focus");
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  await fireEvent.blur(window); await closing; await settled(); expect(focus).not.toHaveBeenCalled();
});

it("does not revive an old callback when a blurred window regains focus before the callback settles", async () => {
  render(Harness); const menu = await open();
  const input = screen.getByRole("combobox"); const focus = vi.spyOn(input, "focus");
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  flushSync(); await fireEvent.blur(window);
  await closing; await settled(); expect(focus).not.toHaveBeenCalled();
});

it("does not apply an already-issued callback to a hidden document", async () => {
  render(Harness); const menu = await open();
  const input = screen.getByRole("combobox"); const focus = vi.spyOn(input, "focus");
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  await closing; await settled(); expect(focus).not.toHaveBeenCalled();
});

it("releases each temporary focus handoff listener after settling and destruction", async () => {
  const add = vi.spyOn(document, "addEventListener"), remove = vi.spyOn(document, "removeEventListener");
  const view = render(Harness); await settled(); const menu = await open();
  const closing = fireEvent.keyDown(within(menu).getByRole("menuitemcheckbox"), { key: "Escape" });
  flushSync(); view.unmount(); await closing; await settled();
  const listeners = add.mock.calls.filter(([type]) => type === "focusin").map(([, listener]) => listener);
  expect(listeners.length).toBeGreaterThanOrEqual(1);
  for (const listener of listeners) expect(remove.mock.calls.some(([type, removed]) => type === "focusin" && removed === listener)).toBe(true);
});
