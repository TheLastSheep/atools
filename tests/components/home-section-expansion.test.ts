import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { tick } from "svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePanel from "../../src/components/HomePanel.svelte";
import {
  homeCommandSections,
  homeCommandStatusForSections,
  selectedHomeCommandIndexAfterSectionChange,
  type HomeCommandSectionId,
} from "../../src/lib/homeSurface";
import type { RecommendedCommand } from "../../src/lib/uiState";

afterEach(cleanup);

function commands(pinnedCount: number, recentCount: number): RecommendedCommand[] {
  return [
    ...Array.from({ length: pinnedCount }, (_, index) => ({
      code: `pinned-${index}`, plugin_id: "pin-plugin", label: `固定 ${index}`, explain: "固定", source: "pinned" as const,
    })),
    ...Array.from({ length: recentCount }, (_, index) => ({
      code: `recent-${index}`, plugin_id: "recent-plugin", label: `最近 ${index}`, explain: "最近使用", source: "history" as const,
    })),
  ];
}

function rect(top: number, bottom: number): DOMRect {
  return { top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

describe("home section expansion", () => {
  it("keeps each section collapsed to its configured rows and exposes the full count", () => {
    const sections = homeCommandSections(commands(12, 45), { pinnedRows: 1, recentRows: 2 });

    expect(sections.map(section => [section.id, section.commands.length, section.total, section.canExpand, section.expanded])).toEqual([
      ["pinned", 9, 12, true, false],
      ["recent", 18, 45, true, false],
    ]);
  });

  it("omits empty recent sections for pinned-only candidates but retains the empty-home fallback", () => {
    expect(homeCommandSections(commands(3, 0), { pinnedRows: 1, recentRows: 2 }).map(section => section.id))
      .toEqual(["pinned"]);
    expect(homeCommandSections(commands(0, 0), { pinnedRows: 1, recentRows: 2 }).map(section => section.id))
      .toEqual(["recent"]);
  });

  it("shows all controlled candidates when expanded without a second 36-item cap", () => {
    const candidates = commands(45, 45);
    const options = { pinnedRows: 1, recentRows: 2 };
    const pinnedExpanded = homeCommandSections(candidates, { ...options, expandedSections: ["pinned"] });
    const recentExpanded = homeCommandSections(candidates, { ...options, expandedSections: ["recent"] });

    expect(pinnedExpanded[0].commands).toHaveLength(45);
    expect(pinnedExpanded[0].total).toBe(45);
    expect(recentExpanded[1].commands).toHaveLength(45);
    expect(recentExpanded[1].total).toBe(45);
    expect(homeCommandStatusForSections(recentExpanded, 40)).toMatchObject({ title: "最近使用", detail: "32 / 45 · 最近 31" });
  });

  it("preserves the selected recent command when the fixed section expands", () => {
    const candidates = commands(12, 12);
    const before = homeCommandSections(candidates, { pinnedRows: 1, recentRows: 2 });
    const after = homeCommandSections(candidates, { pinnedRows: 1, recentRows: 2, expandedSections: ["pinned"] });

    expect(selectedHomeCommandIndexAfterSectionChange(before, after, 11)).toBe(14);
  });

  it("moves a hidden selection to the last visible command in the same section", () => {
    const candidates = commands(0, 45);
    const before = homeCommandSections(candidates, { pinnedRows: 1, recentRows: 1, expandedSections: ["recent"] });
    const after = homeCommandSections(candidates, { pinnedRows: 1, recentRows: 1 });

    expect(selectedHomeCommandIndexAfterSectionChange(before, after, 40)).toBe(8);
  });

  it("keeps disclosure controls keyboard-focusable and exposes only the visible commands", async () => {
    const onsectiontoggle = vi.fn<(id: HomeCommandSectionId) => void>();
    const candidates = commands(0, 45);
    const sections = homeCommandSections(candidates, { pinnedRows: 1, recentRows: 1 });
    const view = render(HomePanel, {
      commands: candidates,
      sections,
      onsectiontoggle,
      oncommand: vi.fn(),
      onpanelchange: vi.fn(),
    });

    const disclosure = screen.getByRole("button", { name: "最近使用 展开 (45)" });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(disclosure.getAttribute("aria-controls")).toBe("atools-home-recent-commands");
    expect(document.getElementById("atools-home-recent-commands")?.querySelectorAll(".recent-item")).toHaveLength(9);

    disclosure.focus();
    await fireEvent.click(disclosure);
    expect(onsectiontoggle).toHaveBeenCalledWith("recent");
    expect(document.activeElement).toBe(disclosure);

    const expandedSections = homeCommandSections(candidates, {
      pinnedRows: 1, recentRows: 1, expandedSections: ["recent"],
    });
    await view.rerender({ commands: candidates, sections: expandedSections, onsectiontoggle,
      oncommand: vi.fn(), onpanelchange: vi.fn() });
    const collapse = screen.getByRole("button", { name: "最近使用 收起" });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("atools-home-recent-commands")?.querySelectorAll(".recent-item")).toHaveLength(45);
    expect(document.activeElement).toBe(collapse);
  });

  it("keeps controls attached to their section when fixed commands appear or disappear", async () => {
    const pinnedAndRecent = commands(10, 10);
    const options = { pinnedRows: 1, recentRows: 1 };
    const props = {
      commands: pinnedAndRecent,
      sections: homeCommandSections(pinnedAndRecent, options),
      onsectiontoggle: vi.fn(),
      oncommand: vi.fn(),
      onpanelchange: vi.fn(),
    };
    const view = render(HomePanel, props);
    expect(screen.getByRole("button", { name: "最近使用 展开 (10)" }).getAttribute("aria-controls"))
      .toBe("atools-home-recent-commands");

    const onlyRecent = pinnedAndRecent.filter(command => command.source !== "pinned");
    await view.rerender({ ...props, commands: onlyRecent, sections: homeCommandSections(onlyRecent, options) });
    const withoutPinned = screen.getByRole("button", { name: "最近使用 展开 (10)" });
    expect(withoutPinned.getAttribute("aria-controls")).toBe("atools-home-recent-commands");

    await view.rerender({ ...props, sections: homeCommandSections(pinnedAndRecent, options) });
    expect(screen.getByRole("button", { name: "最近使用 展开 (10)" }).getAttribute("aria-controls"))
      .toBe("atools-home-recent-commands");
  });

  it("keeps a focused disclosure in view during section expansion and scrolls selections after focus leaves", async () => {
    const candidates = commands(45, 45);
    const options = { pinnedRows: 1, recentRows: 2 };
    const onsectiontoggle = vi.fn();
    const props = { commands: candidates, sections: homeCommandSections(candidates, options), selectedIndex: 9,
      onsectiontoggle, oncommand: vi.fn(), onpanelchange: vi.fn() };
    const view = render(HomePanel, props);
    const scrollRegion = screen.getByRole("region", { name: "固定指令与最近使用" });
    Object.defineProperty(scrollRegion, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scrollRegion, "clientTop", { configurable: true, value: 0 });
    scrollRegion.getBoundingClientRect = () => rect(100, 200);
    const header = screen.getByRole("button", { name: "固定 展开 (45)" });
    header.getBoundingClientRect = () => rect(115, 135);
    const selectedRow = scrollRegion.querySelector<HTMLElement>('[data-home-command-index="9"]');
    expect(selectedRow).toBeTruthy();
    if (!selectedRow) return;
    selectedRow.getBoundingClientRect = () => rect(220, 260);
    scrollRegion.scrollTop = 20;
    header.focus();
    await fireEvent.click(header);
    expect(onsectiontoggle).toHaveBeenCalledWith("pinned");

    const expandedSections = homeCommandSections(candidates, { ...options, expandedSections: ["pinned"] });
    await view.rerender({ ...props, sections: expandedSections, selectedIndex: 45 });
    expect(document.activeElement).toBe(header);
    expect(scrollRegion.scrollTop).toBe(20);

    const nextSelected = scrollRegion.querySelector<HTMLElement>('[data-home-command-index="46"]');
    expect(nextSelected).toBeTruthy();
    if (!nextSelected) return;
    nextSelected.getBoundingClientRect = () => rect(220, 260);
    const search = document.createElement("input");
    document.body.append(search);
    search.focus();
    await view.rerender({ ...props, sections: expandedSections, selectedIndex: 46 });
    expect(scrollRegion.scrollTop).toBeGreaterThan(20);
    search.remove();
  });

  it("reveals the first expanded row with a focused header when both fit in the scrollport", async () => {
    const candidates = commands(0, 45);
    const options = { pinnedRows: 1, recentRows: 1 };
    const onsectiontoggle = vi.fn();
    const props = { commands: candidates, sections: homeCommandSections(candidates, options), selectedIndex: 0,
      onsectiontoggle, oncommand: vi.fn(), onpanelchange: vi.fn() };
    const view = render(HomePanel, props);
    const scrollRegion = screen.getByRole("region", { name: "固定指令与最近使用" });
    Object.defineProperty(scrollRegion, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scrollRegion, "clientTop", { configurable: true, value: 0 });
    scrollRegion.getBoundingClientRect = () => rect(100, 200);
    const header = screen.getByRole("button", { name: "最近使用 展开 (45)" });
    const firstRow = scrollRegion.querySelector<HTMLElement>('[data-home-command-index="0"]');
    expect(firstRow).toBeTruthy();
    if (!firstRow) return;

    const initialScrollTop = 20;
    const scrollDelta = () => scrollRegion.scrollTop - initialScrollTop;
    header.getBoundingClientRect = () => rect(180 - scrollDelta(), 200 - scrollDelta());
    firstRow.getBoundingClientRect = () => rect(200 - scrollDelta(), 258 - scrollDelta());
    scrollRegion.scrollTop = initialScrollTop;
    header.focus();
    await fireEvent.click(header);
    expect(onsectiontoggle).toHaveBeenCalledWith("recent");

    const expandedSections = homeCommandSections(candidates, { ...options, expandedSections: ["recent"] });
    await view.rerender({ ...props, sections: expandedSections });

    const headerBounds = header.getBoundingClientRect();
    const firstRowBounds = firstRow.getBoundingClientRect();
    expect(headerBounds.top).toBeGreaterThanOrEqual(100);
    expect(headerBounds.bottom).toBeLessThanOrEqual(200);
    expect(firstRowBounds.top).toBeGreaterThanOrEqual(100);
    expect(firstRowBounds.bottom).toBeLessThanOrEqual(200);
    expect(document.activeElement).toBe(header);
  });

  it("does not move an already-expanded section when its header only receives focus before collapse", async () => {
    const candidates = commands(0, 45);
    const options = { pinnedRows: 1, recentRows: 1, expandedSections: ["recent"] as const };
    const onsectiontoggle = vi.fn();
    const props = { commands: candidates, sections: homeCommandSections(candidates, options), selectedIndex: 0,
      onsectiontoggle, oncommand: vi.fn(), onpanelchange: vi.fn() };
    const view = render(HomePanel, props);
    const scrollRegion = screen.getByRole("region", { name: "固定指令与最近使用" });
    Object.defineProperty(scrollRegion, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(scrollRegion, "clientTop", { configurable: true, value: 0 });
    scrollRegion.getBoundingClientRect = () => rect(100, 200);
    const header = screen.getByRole("button", { name: "最近使用 收起" });
    const firstRow = scrollRegion.querySelector<HTMLElement>('[data-home-command-index="0"]');
    expect(firstRow).toBeTruthy();
    if (!firstRow) return;

    const initialScrollTop = 20;
    const scrollDelta = () => scrollRegion.scrollTop - initialScrollTop;
    header.getBoundingClientRect = () => rect(180 - scrollDelta(), 200 - scrollDelta());
    firstRow.getBoundingClientRect = () => rect(200 - scrollDelta(), 258 - scrollDelta());
    scrollRegion.scrollTop = initialScrollTop;

    header.focus();
    await tick();

    expect(scrollRegion.scrollTop).toBe(initialScrollTop);
    expect(header.getBoundingClientRect()).toMatchObject({ top: 180, bottom: 200 });
    expect(firstRow.getBoundingClientRect()).toMatchObject({ top: 200, bottom: 258 });

    await fireEvent.click(header);
    expect(onsectiontoggle).toHaveBeenCalledTimes(1);
    expect(onsectiontoggle).toHaveBeenCalledWith("recent");
    const collapsedSections = homeCommandSections(candidates, { pinnedRows: 1, recentRows: 1 });
    await view.rerender({ ...props, sections: collapsedSections });
    expect(screen.getByRole("button", { name: "最近使用 展开 (45)" }).getAttribute("aria-expanded"))
      .toBe("false");
  });

  it("renders a plain heading instead of an inert disclosure without a toggle callback", () => {
    const candidates = commands(0, 45);
    render(HomePanel, { commands: candidates, recentRows: 1, oncommand: vi.fn(), onpanelchange: vi.fn() });

    expect(screen.getByRole("heading", { name: "最近使用" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "最近使用 展开 (45)" })).toBeNull();
  });
});
