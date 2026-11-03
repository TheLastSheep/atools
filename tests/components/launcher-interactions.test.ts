import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ResultsList from "../../src/components/ResultsList.svelte";
import LauncherSearchHarness from "./LauncherSearchHarness.svelte";
import {
  ignoreLauncherKeyboardEvent,
  isLauncherNavigationTarget,
  moveResultSelection,
  resultNavigationOrder,
  resultVisualPosition,
} from "../../src/lib/launcherKeyboard";
import type { SearchResult } from "../../src/lib/types";

const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

function result(code: string, pluginId: string, label = code): SearchResult {
  return {
    code,
    plugin_id: pluginId,
    plugin_name: pluginId,
    label,
    icon: null,
    explain: "",
    score: 100,
    match_type: "exact",
  };
}

const interleaved = [result("a1", "a"), result("b1", "b"), result("a2", "a")];

describe("launcher result navigation", () => {
  it("moves in the displayed group order, preserving the underlying activation indexes", () => {
    expect(resultNavigationOrder(interleaved)).toEqual([0, 2, 1]);
    expect(moveResultSelection(interleaved, 0, 1)).toBe(2);
    expect(moveResultSelection(interleaved, 2, 1)).toBe(1);
    expect(moveResultSelection(interleaved, 1, -1)).toBe(2);
    expect(resultVisualPosition(interleaved, 2)).toBe(1);
    expect(moveResultSelection(interleaved, 1, 1)).toBe(1);
    expect(moveResultSelection(interleaved, 0, -1)).toBe(0);
    expect(moveResultSelection(interleaved, 1, 1, true)).toBe(0);
    expect(moveResultSelection(interleaved, 0, -1, true)).toBe(1);
    expect(moveResultSelection([], 4, 1)).toBe(0);
  });

  it("leaves IME candidate confirmation and previously handled keys to their controls", () => {
    expect(ignoreLauncherKeyboardEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }))).toBe(true);
    const webkitEvent = new KeyboardEvent("keydown", { key: "Enter" });
    Object.defineProperty(webkitEvent, "keyCode", { value: 229 });
    expect(ignoreLauncherKeyboardEvent(webkitEvent)).toBe(true);
    const handled = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
    handled.preventDefault();
    expect(ignoreLauncherKeyboardEvent(handled)).toBe(true);
    expect(ignoreLauncherKeyboardEvent(new KeyboardEvent("keydown", { key: "Enter" }))).toBe(false);
  });

  it("preserves native keyboard behavior on home actions and ordinary editable controls", () => {
    expect(isLauncherNavigationTarget(document.createElement("button"))).toBe(false);
    expect(isLauncherNavigationTarget(document.createElement("textarea"))).toBe(false);
    const input = document.createElement("input");
    input.dataset.atoolsSearchInput = "true";
    expect(isLauncherNavigationTarget(input)).toBe(true);
    const row = document.createElement("button");
    row.setAttribute("role", "option");
    row.dataset.resultIndex = "0";
    expect(isLauncherNavigationTarget(row)).toBe(true);
  });
});

describe("launcher search input", () => {
  it("submits the finished Chinese composition once, then handles ordinary input and clearing", async () => {
    const onchange = vi.fn();
    render(LauncherSearchHarness, { onchange });
    const input = screen.getByRole("combobox") as HTMLInputElement;

    await fireEvent.compositionStart(input);
    await fireEvent.input(input, { target: { value: "fan" }, isComposing: true });
    expect(input.value).toBe("fan");
    expect(input.dataset.atoolsComposing).toBe("true");
    expect(onchange).not.toHaveBeenCalled();

    await fireEvent.input(input, { target: { value: "翻译" }, isComposing: true });
    await fireEvent.compositionEnd(input, { data: "翻译" });
    await fireEvent.input(input, { target: { value: "翻译" }, isComposing: false });
    expect(onchange.mock.calls).toEqual([["翻译"]]);
    expect(input.getAttribute("aria-activedescendant")).toBe("launcher-result-0");
    expect(input.getAttribute("aria-expanded")).toBe("true");

    await fireEvent.input(input, { target: { value: "翻译 text" } });
    expect(onchange).toHaveBeenLastCalledWith("翻译 text");
    await fireEvent.click(screen.getByRole("button", { name: "清除搜索内容" }));
    expect(input.value).toBe("");
    expect(onchange).toHaveBeenLastCalledWith("");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("launcher result rows", () => {
  it("exposes the selected option and uses the original result index for hover and activation", async () => {
    const onselect = vi.fn();
    const onselectionchange = vi.fn();
    render(ResultsList, { results: interleaved, query: "", selectedIndex: 2, onselect, onselectionchange });
    const rows = screen.getAllByRole("option");
    expect(rows.map((row) => row.getAttribute("data-result-index"))).toEqual(["0", "2", "1"]);
    expect(rows[1].getAttribute("aria-selected")).toBe("true");
    expect(rows[1].getAttribute("aria-posinset")).toBe("2");
    expect(rows[1].getAttribute("aria-setsize")).toBe("3");
    expect(rows[1].id).toBe("launcher-result-2");
    await fireEvent.mouseEnter(rows[2]);
    expect(onselectionchange).toHaveBeenLastCalledWith(1);
    await fireEvent.click(rows[1]);
    expect(onselect).toHaveBeenLastCalledWith(2);
  });

  it("scrolls the newly selected row into view immediately after a selection update", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const view = render(ResultsList, { results: interleaved, query: "", selectedIndex: 0, onselect: vi.fn() });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalled());
    scrollIntoView.mockClear();
    await view.rerender({ selectedIndex: 2 });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest", behavior: "auto" }));
    expect(scrollIntoView.mock.instances.at(-1)).toBe(screen.getAllByRole("option")[1]);
  });

  it("highlights matching text while treating command labels as plain text", () => {
    const view = render(ResultsList, {
      results: [result("unsafe", "a", '<script>alert("find")</script>')],
      query: "find",
      selectedIndex: 0,
      onselect: vi.fn(),
    });
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("mark")?.textContent).toBe("find");
    expect(screen.getByRole("option").textContent).toContain('<script>alert("find")</script>');
  });
});
