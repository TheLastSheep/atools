import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import PluginFeatureList from "../../src/components/PluginFeatureList.svelte";
import PluginNavigationBar from "../../src/components/PluginNavigationBar.svelte";
import { emptyPluginFeatureList, featureListMessage, moveFeatureList, selectFeatureListCommand } from "../../src/lib/pluginFeatureExportsState";
import { pluginFeatureIcon } from "../../src/lib/pluginFeatureIcons";
import { createPluginFeatureListId, pluginFeatureOptionId } from "../../src/lib/pluginFeatureA11yIds";
import { createPluginFeatureActiveDescendantController } from "../../src/lib/pluginFeatureActiveDescendant.svelte.js";

let originalClientHeight: PropertyDescriptor | undefined;
afterEach(() => {
  cleanup(); vi.unstubAllGlobals();
  if (originalClientHeight) Object.defineProperty(HTMLDivElement.prototype, "clientHeight", originalClientHeight);
  else delete (HTMLDivElement.prototype as { clientHeight?: number }).clientHeight;
  originalClientHeight = undefined;
});
function list(count = 3) {
  return featureListMessage(emptyPluginFeatureList(7), { __atools_feature_exports__: true, epoch: 7, entry: 1, revision: 1, mode: "list", selectable: true,
    rows: Array.from({ length: count }, (_, index) => ({ index, title: `Fixed ${index}`, description: "fixed description", icon: "logo.png" })) })!;
}
describe("bounded native-host feature list adapter", () => {
  it("wraps arrows, jumps boundaries, allows empty list and prevents busy/outdated selection", () => {
    let model = list(); model = moveFeatureList(model, "previous"); expect(model.selected).toBe(2);
    model = moveFeatureList(model, "next"); expect(model.selected).toBe(0);
    expect(moveFeatureList(model, "last").selected).toBe(2); expect(moveFeatureList(model, "first").selected).toBe(0);
    expect(selectFeatureListCommand(model)).toMatchObject({ epoch: 7, entry: 1, revision: 1, index: 0 });
    expect(selectFeatureListCommand({ ...model, busy: true })).toBeNull(); expect(selectFeatureListCommand(list(0))).toBeNull();
    expect(featureListMessage(model, { __atools_feature_exports__: true, epoch: 6, entry: 3, revision: 1, mode: "list", rows: [] })).toBe(model);
    expect(featureListMessage(model, { __atools_feature_exports__: true, epoch: 7, entry: 1, revision: 0, mode: "list", rows: [] })).toBe(model);
  });
  it("keeps the active descendant unset when the measured viewport is actually zero-height", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", { configurable: true, get: () => 0 });
    const state = list();
    const active = createPluginFeatureActiveDescendantController();
    const listboxId = createPluginFeatureListId();
    render(PluginFeatureList, { state, listboxId, onselect: vi.fn(), onhover: vi.fn(), onpointermove: vi.fn(),
      onactiveoption: active.report, resolveIcon: async () => "" });
    await waitFor(() => expect(active.activeDescendantIdFor(state, listboxId)).toBeUndefined());
  });
  it("renders text, retains at most 24 virtual rows and sends row index without inventing item data", async () => {
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    originalClientHeight = Object.getOwnPropertyDescriptor(HTMLDivElement.prototype, "clientHeight");
    Object.defineProperty(HTMLDivElement.prototype, "clientHeight", { configurable: true, get: () => 128 });
    const model = list(2000); model.rows[0].title = "<img src=x onerror=alert(1)>";
    const onselect = vi.fn(), onhover = vi.fn(), onpointermove = vi.fn();
    const active = createPluginFeatureActiveDescendantController();
    const onactiveoption = vi.fn(active.report);
    const resolveIcon = vi.fn(async () => "");
    const listboxId = createPluginFeatureListId();
    const view = render(PluginFeatureList, { state: model, listboxId, onselect, onhover, onpointermove, onactiveoption, resolveIcon });
    expect(view.container.querySelector("[role=\"listbox\"]")?.id).toBe(listboxId);
    await waitFor(() => expect(active.activeDescendantIdFor(model, listboxId)).toBe(pluginFeatureOptionId(listboxId, 0)));
    expect(view.container.querySelector(`#${pluginFeatureOptionId(listboxId, 0)}`)?.getAttribute("aria-selected")).toBe("true");
    expect(view.container.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(24);
    expect(view.container.querySelector("img")).toBeNull(); expect(screen.getByText(model.rows[0].title)).toBeTruthy();
    await fireEvent.click(screen.getByRole("option", { name: /onerror/ })); expect(onselect).toHaveBeenCalledWith(0);
    const viewport = view.container.querySelector('[role="listbox"]') as HTMLDivElement;
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 64 });
    await fireEvent.scroll(viewport);
    await waitFor(() => expect(active.activeDescendantIdFor(model, listboxId)).toBeUndefined());
    expect(view.container.querySelector(`#${pluginFeatureOptionId(listboxId, 0)}`)).toBeTruthy();
    Object.defineProperty(viewport, "scrollTop", { configurable: true, writable: true, value: 0 });
    await fireEvent.scroll(viewport);
    await waitFor(() => expect(active.activeDescendantIdFor(model, listboxId)).toBe(pluginFeatureOptionId(listboxId, 0)));
    await view.rerender({ state: { ...model, selected: 1999, keyboard: true } });
    await waitFor(() => {
      expect(active.activeDescendantIdFor({ ...model, selected: 1999, keyboard: true }, listboxId)).toBe(pluginFeatureOptionId(listboxId, 1999));
      expect(view.container.querySelector(`#${pluginFeatureOptionId(listboxId, 1999)}`)?.getAttribute("aria-selected")).toBe("true");
    });
    expect(view.container.querySelector('[aria-posinset="2000"]')).toBeTruthy();
    expect(view.container.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(24);
    await view.rerender({ state: { ...model, mode: "none", selected: 1999, keyboard: false } });
    await waitFor(() => expect(active.activeDescendantIdFor({ ...model, mode: "none", selected: 1999, keyboard: false }, listboxId)).toBeUndefined());
    expect(view.container.querySelector('[role="listbox"]')).toBeNull();
  });
  it("uses combobox relations only while a current output list is attached", async () => {
    const props = { title: "Fixed", inputVisible: true, value: "query", controlsId: "listbox-a",
      activeDescendantId: "listbox-a-option-0", onreturn: vi.fn() };
    const view = render(PluginNavigationBar, props);
    const combo = screen.getByRole("combobox", { name: "插件搜索" });
    expect(combo.getAttribute("aria-controls")).toBe("listbox-a");
    expect(combo.getAttribute("aria-expanded")).toBe("true");
    expect(combo.getAttribute("aria-autocomplete")).toBe("list");
    expect(combo.getAttribute("aria-activedescendant")).toBe("listbox-a-option-0");
    await view.rerender({ ...props, controlsId: undefined, activeDescendantId: undefined });
    const textbox = screen.getByRole("textbox", { name: "插件搜索" });
    expect(textbox.hasAttribute("aria-controls")).toBe(false);
    expect(textbox.hasAttribute("aria-activedescendant")).toBe(false);
  });
  it("allocates unique listbox, option and hint identifiers per component instance", () => {
    const first = createPluginFeatureListId(), second = createPluginFeatureListId();
    expect(first).not.toBe(second);
    expect(pluginFeatureOptionId(first, 0)).not.toBe(pluginFeatureOptionId(second, 0));
    const props = { title: "Fixed", inputVisible: true, onreturn: vi.fn() };
    const firstNav = render(PluginNavigationBar, props);
    const firstHint = firstNav.container.querySelector("input")?.getAttribute("aria-describedby");
    const secondNav = render(PluginNavigationBar, props);
    const hints = [firstHint, secondNav.container.querySelector("input")?.getAttribute("aria-describedby")];
    expect(hints[0]).toBeTruthy(); expect(hints[1]).toBeTruthy(); expect(hints[0]).not.toBe(hints[1]);
    expect(hints.every(id => id && document.getElementById(id))).toBe(true);
  });
  it("input-local Home/End selection respects IME/modifiers, preserves search text", async () => {
    const onboundary = vi.fn(() => true); render(PluginNavigationBar, { title: "Fixed", inputVisible: true, value: "query", onreturn: vi.fn(), onboundary });
    const input = screen.getByRole("textbox") as HTMLInputElement;
    for (const key of ["Home", "End"]) { const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }); input.dispatchEvent(event); expect(event.defaultPrevented).toBe(true); }
    expect(onboundary.mock.calls).toEqual([["first"], ["last"]]); expect(input.value).toBe("query");
    for (const options of [{ isComposing: true }, { ctrlKey: true }, { keyCode: 229 }]) input.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, ...options }));
    expect(onboundary).toHaveBeenCalledTimes(2);
  });
  it("bounds parent messages and surfaces recoverable errors instead of accepting arbitrary rows", () => {
    const base = list();
    const message = { __atools_feature_exports__: true, epoch: 7, entry: 1, revision: 2, mode: "list", rows: [{ index: 0, title: {}, description: "", icon: "" }] };
    expect(featureListMessage(base, message)?.error).toContain("格式");
    expect(featureListMessage(base, { ...message, rows: new Array(2001) })?.error).toContain("数量");
    expect(featureListMessage(base, { ...message, rows: [], error: "fixed failure" })?.error).toBe("fixed failure");
  });
  it("icons use the existing package resolver and deny script/remote/file URLs", async () => {
    const resolve = vi.fn(async () => "atools-plugin://localhost/fixture/logo.png");
    for (const value of ["javascript:alert(1)", "https://fixture.invalid/x", "file:///etc/passwd", "//fixture.invalid/x", "data:image/svg+xml,<svg/>"])
      expect(await pluginFeatureIcon(value, resolve)).toBe("");
    expect(resolve).not.toHaveBeenCalled(); expect(await pluginFeatureIcon("logo.png", resolve)).toContain("atools-plugin:");
    expect(await pluginFeatureIcon("data:image/png;base64,YQ==", resolve)).toContain("data:image/png");
    expect(await pluginFeatureIcon("../outside.png", async () => { throw Error("lease refused"); })).toBe("");
  });
  it("mirrored parent row schema rejects oversized/sparse outer arrays without stringifying opaque item fields", () => {
    const base = list(), stringify = vi.spyOn(JSON, "stringify").mockImplementation(() => { throw Error("STRINGIFY_MUST_NOT_RUN"); });
    try {
      const envelope = { __atools_feature_exports__: true, epoch: 7, entry: 1, revision: 2, mode: "list" };
      expect(featureListMessage(base, { ...envelope, rows: new Array(300000) })?.error).toContain("数量");
      expect(featureListMessage(base, { ...envelope, rows: new Array(2) })?.error).toContain("格式");
      const row = { index: 0, title: "fixed", description: "", icon: "", custom: new Array(300000) };
      expect(featureListMessage(base, { ...envelope, rows: [row] })?.rows).toEqual([{ index: 0, title: "fixed", description: "", icon: "" }]);
      expect(stringify).not.toHaveBeenCalled();
    } finally { stringify.mockRestore(); }
  });
});
