import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePanel from "../../src/components/HomePanel.svelte";
import type { RecommendedCommand } from "../../src/lib/uiState";
import { homeGridColumnCount, homeGridCommandTarget } from "../../src/lib/homeNavigation";

vi.mock("../../src/lib/launcherCommandActions", () => ({ isLauncherMenuShortcut: () => false }));
afterEach(cleanup);

function commands(): RecommendedCommand[] {
  return [0, 1, 2, 3].map(index => ({
    code: `history-${index}`,
    label: `最近 ${index}`,
    explain: "最近使用",
    source: "history" as const,
  }));
}

function props(selectedIndex: number, onselectionchange = vi.fn(), onactivate = vi.fn()) {
  return {
    commands: commands(),
    oncommand: vi.fn(),
    onpanelchange: vi.fn(),
    onselectionchange,
    onactivate,
    selectedIndex,
  };
}

function commandButtons(): HTMLButtonElement[] {
  const panel = screen.getByRole("region", { name: "ATools 首页" });
  return Array.from(panel.querySelectorAll<HTMLButtonElement>("button.recent-item"));
}

describe("HomePanel roving keyboard focus", () => {
  it("keeps one command tab stop and moves focus/selection through the rendered grid", async () => {
    const onselectionchange = vi.fn();
    const view = render(HomePanel, props(0, onselectionchange));
    const buttons = commandButtons();
    expect(buttons).toHaveLength(4);
    expect(buttons.filter(button => button.tabIndex === 0)).toEqual([buttons[0]]);

    buttons[0].focus();
    fireEvent.keyDown(buttons[0], { key: "ArrowRight" });
    expect(document.activeElement).toBe(buttons[1]);
    expect(onselectionchange).toHaveBeenCalledWith(1, false);

    await view.rerender(props(1, onselectionchange));
    expect(commandButtons().filter(button => button.tabIndex === 0)).toEqual([commandButtons()[1]]);
    fireEvent.keyDown(commandButtons()[1], { key: "ArrowLeft" });
    expect(document.activeElement).toBe(commandButtons()[0]);
    expect(onselectionchange).toHaveBeenLastCalledWith(0, false);
  });

  it("uses the visible recent-grid tracks when moving vertically from a focused tile", () => {
    const compactCommands: RecommendedCommand[] = Array.from({ length: 8 }, (_, index) => ({
      code: `history-${index}`,
      label: `最近 ${index}`,
      explain: "最近使用",
      source: "history",
    }));
    render(HomePanel, { ...props(0), commands: compactCommands });
    const panel = screen.getByRole("region", { name: "ATools 首页" });
    const grid = panel.querySelector<HTMLElement>(".recent-grid:not(.pinned-grid)");
    expect(grid).toBeTruthy();
    if (!grid) return;

    grid.style.gridTemplateColumns = "100px 100px 0px 0px";
    Object.defineProperty(grid, "clientWidth", { configurable: true, value: 400 });
    expect(homeGridColumnCount(panel)).toBe(4);
    const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>("button.recent-item"));
    buttons[1].focus();
    fireEvent.keyDown(buttons[1], { key: "ArrowDown" });
    expect(document.activeElement).toBe(buttons[5]);
  });

  it("keeps recent remove actions out of the Tab sequence and syncs focus", () => {
    const onselectionchange = vi.fn();
    const onremove = vi.fn();
    render(HomePanel, { ...props(0, onselectionchange), onremove });
    const panel = screen.getByRole("region", { name: "ATools 首页" });
    const grid = panel.querySelector<HTMLElement>(".recent-grid");
    expect(grid).toBeTruthy();
    if (!grid) return;

    const cards = Array.from(grid.querySelectorAll<HTMLButtonElement>("button.recent-item"));
    const removeButtons = Array.from(grid.querySelectorAll<HTMLButtonElement>("button.recent-remove"));
    expect(cards.filter(button => button.tabIndex === 0)).toEqual([cards[0]]);
    expect(removeButtons).toHaveLength(4);
    expect(removeButtons.every(button => button.tabIndex === -1)).toBe(true);

    removeButtons[2].focus();
    expect(onselectionchange).toHaveBeenLastCalledWith(2, false);
    fireEvent.click(removeButtons[2]);
    expect(onremove).toHaveBeenCalledWith(commands()[2]);
    expect(onselectionchange).toHaveBeenLastCalledWith(2);
  });

  it("leaves modifiers, IME input, editable descendants, and Tab to the browser", () => {
    const onselectionchange = vi.fn();
    const onactivate = vi.fn();
    render(HomePanel, props(0, onselectionchange, onactivate));
    const [first] = commandButtons();
    first.focus();

    const shifted = new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(shifted);
    expect(shifted.defaultPrevented).toBe(false);
    const composing = new KeyboardEvent("keydown", { key: "ArrowDown", isComposing: true, bubbles: true, cancelable: true });
    first.dispatchEvent(composing);
    expect(composing.defaultPrevented).toBe(false);

    const editable = first.querySelector<HTMLElement>(".recent-label");
    expect(editable).toBeTruthy();
    if (!editable) return;
    Object.defineProperty(editable, "isContentEditable", { configurable: true, value: true });
    const editArrow = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    editable.dispatchEvent(editArrow);
    expect(editArrow.defaultPrevented).toBe(false);

    fireEvent.keyDown(first, { key: "Tab" });
    expect(onactivate).not.toHaveBeenCalled();
    expect(onselectionchange).not.toHaveBeenCalled();
  });

  it("uses the requested rendered card for Tab entry and falls back only when it is absent", () => {
    render(HomePanel, props(2));
    const buttons = commandButtons();
    expect(homeGridCommandTarget(screen.getByRole("region", { name: "ATools 首页" }), 2)).toBe(buttons[2]);
    expect(homeGridCommandTarget(screen.getByRole("region", { name: "ATools 首页" }), 99)).toBe(buttons[0]);
    expect(homeGridCommandTarget(document.createElement("section"), 0)).toBeNull();
  });

  it("preserves mouse hover selection callback behavior", () => {
    const onselectionchange = vi.fn();
    render(HomePanel, props(0, onselectionchange));
    fireEvent.mouseEnter(commandButtons()[2]);
    expect(onselectionchange).toHaveBeenCalledWith(2);
  });
});
