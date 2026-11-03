import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import LauncherResultsSurface, { type LauncherResultsSurfaceProps } from "../../src/components/LauncherResultsSurface.svelte";
import SearchStatusBar from "../../src/components/SearchStatusBar.svelte";
import { homeCommandStatus } from "../../src/lib/homeSurface";
import { DEFAULT_ATOOLS_SETTINGS } from "../../src/lib/settings";
import type { SearchResult } from "../../src/lib/types";
import type { RecommendedCommand } from "../../src/lib/uiState";

afterEach(() => cleanup());

function result(code: string, label: string): SearchResult {
  return { code, plugin_id: "plugin-" + code, plugin_name: label, label, icon: null, explain: "", score: 1, match_type: "exact" };
}

function surfaceProps(overrides: Partial<LauncherResultsSurfaceProps> = {}): LauncherResultsSurfaceProps {
  const recentCommands: RecommendedCommand[] = [];
  return {
    results: [], selectedIndex: 0, query: "", feedback: { mode: "none", title: "", hint: "", showSpinner: false },
    onselect: () => {}, onselectionchange: () => {}, oncommandmenu: () => {}, canOpenCommandMenu: () => false,
    ongroupenter: () => {}, showQueryResults: false, showHomeRecent: false, showTabTargetStatus: false,
    recentCommands, recentSelectedIndex: 0, recentSelectedLabel: "", recentStatus: homeCommandStatus(recentCommands, 0, { pinnedRows: 1, recentRows: 2 }),
    settings: { ...DEFAULT_ATOOLS_SETTINGS }, tabAction: "select", tabTargetFeedback: "", featureCatalog: [],
    pushState: { rows: [], pending: false, deferred: 0, message: "", promotedId: null },
    onHomeCommand: () => {}, onHomePanelChange: () => {}, onRecentSelectionChange: () => {},
    onRecentActivate: () => {}, onRecentRemove: () => {}, onRecentCommandMenu: () => {},
    onTargetSettings: () => {}, onBindResultsList: () => {},
    ...overrides,
  };
}

describe("launcher footer action menu button", () => {
  it("dispatches the current selected search result identity without activating it", async () => {
    const first = result("open:first", "第一项");
    const second = result("open:second", "当前选中项");
    const menu = vi.fn();
    const activate = vi.fn();
    const props = surfaceProps({ results: [first, second], selectedIndex: 0, showQueryResults: true,
      canOpenCommandMenu: item => item.code.startsWith("open:"), oncommandmenu: menu, onselect: activate });
    const view = render(LauncherResultsSurface, props);
    await view.rerender({ ...props, selectedIndex: 1 });

    const button = screen.getByRole("button", { name: "更多操作：当前选中项" });
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
    expect(button.hasAttribute("aria-expanded")).toBe(false);
    const dispatched = button.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    expect(dispatched).toBe(false);
    await fireEvent.click(button);

    expect(menu).toHaveBeenCalledOnce();
    expect(menu.mock.calls[0][1]).toBe(second);
    expect(activate).not.toHaveBeenCalled();
  });

  it.each([2, -1])("does not render a menu button for stale selected result index %s", index => {
    render(LauncherResultsSurface, surfaceProps({ results: [result("open:one", "一")], selectedIndex: index,
      showQueryResults: true, canOpenCommandMenu: () => true }));
    expect(screen.queryByRole("button", { name: /更多操作：/ })).toBeNull();
  });

  it("does not offer a menu for empty or non-actionable search results", async () => {
    const props = surfaceProps({ showQueryResults: true, canOpenCommandMenu: () => false });
    const view = render(LauncherResultsSurface, props);
    expect(screen.queryByRole("button", { name: /更多操作：/ })).toBeNull();
    await view.rerender({ ...props, results: [result("closed:item", "无可用菜单")], selectedIndex: 0 });
    expect(screen.queryByRole("button", { name: /更多操作：/ })).toBeNull();
  });

  it("removes the button when the selected item loses menu capability", async () => {
    const selected = result("open:item", "当前选中项");
    let available = true;
    const props = surfaceProps({ results: [selected], selectedIndex: 0, showQueryResults: true,
      canOpenCommandMenu: () => available });
    const view = render(LauncherResultsSurface, props);
    expect(screen.getByRole("button", { name: "更多操作：当前选中项" })).toBeTruthy();

    available = false;
    await view.rerender({ ...props, canOpenCommandMenu: () => available });
    expect(screen.queryByRole("button", { name: "更多操作：当前选中项" })).toBeNull();
  });

  it("dispatches the selected Home recent item, not its activation", async () => {
    const recentCommands: RecommendedCommand[] = [
      { code: "open:first", label: "最近一项", explain: "" },
      { code: "open:second", label: "选中的最近项", explain: "" },
    ];
    const menu = vi.fn();
    const activate = vi.fn();
    render(LauncherResultsSurface, surfaceProps({ recentCommands, recentSelectedIndex: 1,
      recentSelectedLabel: "选中的最近项", recentStatus: homeCommandStatus(recentCommands, 1, { pinnedRows: 1, recentRows: 2 }),
      showHomeRecent: true, canOpenCommandMenu: item => item.code.startsWith("open:"),
      onRecentCommandMenu: menu, onRecentActivate: activate }));

    await fireEvent.click(screen.getByRole("button", { name: "更多操作：选中的最近项" }));
    expect(menu).toHaveBeenCalledOnce();
    expect(menu.mock.calls[0][1]).toBe(recentCommands[1]);
    expect(activate).not.toHaveBeenCalled();
  });

  it("does not render a clickable control when the status bar has no action handler", () => {
    render(SearchStatusBar, { mode: "results", count: 1, selectedIndex: 0, selectedLabel: "可操作项",
      tabAction: "select", actionMenuAvailable: true });
    expect(screen.queryByRole("button", { name: "更多操作：可操作项" })).toBeNull();
    expect(document.querySelector(".action-menu-hint")?.textContent).toContain("⇧F10");
  });
});
