import { describe, expect, it } from "vitest";
import { homeCommandSections } from "../../src/lib/homeSurface";
import { moveHomeGridSelection } from "../../src/lib/homeNavigation";
import type { RecommendedCommand } from "../../src/lib/uiState";

function commands(pinnedCount: number, recentCount: number): RecommendedCommand[] {
  return [
    ...Array.from({ length: pinnedCount }, (_, index) => command(`pinned-${index}`, "pinned")),
    ...Array.from({ length: recentCount }, (_, index) => command(`recent-${index}`, "history")),
  ];
}

function command(code: string, source: "pinned" | "history"): RecommendedCommand {
  return { code, label: code, explain: code, source };
}

describe("moveHomeGridSelection", () => {
  it("moves by rendered rows and preserves the column across the pinned and recent sections", () => {
    const sections = homeCommandSections(commands(3, 18), { pinnedRows: 1, recentRows: 2 });

    expect(moveHomeGridSelection(sections, 0, "down")).toBe(3);
    expect(moveHomeGridSelection(sections, 2, "down")).toBe(5);
    expect(moveHomeGridSelection(sections, 9, "up")).toBe(2);
  });

  it("uses a section's short last row before moving to the following section", () => {
    const sections = homeCommandSections(commands(10, 18), { pinnedRows: 2, recentRows: 2 });

    expect(moveHomeGridSelection(sections, 8, "down")).toBe(9);
    expect(moveHomeGridSelection(sections, 9, "up")).toBe(0);
  });

  it("uses the rendered compact column count for vertical movement", () => {
    const sections = homeCommandSections(commands(3, 18), { pinnedRows: 1, recentRows: 2 });

    expect(moveHomeGridSelection(sections, 4, "down", 4)).toBe(8);
    expect(moveHomeGridSelection(sections, 8, "up", 4)).toBe(4);
    expect(moveHomeGridSelection(sections, 4, "down", 9)).toBe(13);
  });

  it("keeps the same visual column when crossing sections with unequal item counts", () => {
    const sparsePinned = homeCommandSections(commands(2, 9), { pinnedRows: 1, recentRows: 1 });
    const sparseRecent = homeCommandSections(commands(9, 2), { pinnedRows: 1, recentRows: 1 });

    expect(moveHomeGridSelection(sparsePinned, 1, "down", 4)).toBe(3);
    expect(moveHomeGridSelection(sparseRecent, 8, "down", 4)).toBe(9);
    expect(moveHomeGridSelection(sparseRecent, 6, "down", 5)).toBe(10);
  });

  it("clamps short final rows and stops at horizontal and vertical edges", () => {
    const sections = homeCommandSections(commands(3, 11), { pinnedRows: 1, recentRows: 2 });

    expect(moveHomeGridSelection(sections, 3, "up")).toBe(0);
    expect(moveHomeGridSelection(sections, 4, "up")).toBe(1);
    expect(moveHomeGridSelection(sections, 5, "up")).toBe(2);
    expect(moveHomeGridSelection(sections, 5, "down")).toBe(13);
    expect(moveHomeGridSelection(sections, 12, "left")).toBe(12);
    expect(moveHomeGridSelection(sections, 11, "right")).toBe(11);
    expect(moveHomeGridSelection(sections, 12, "right")).toBe(13);
    expect(moveHomeGridSelection(sections, 13, "right")).toBe(13);
  });

  it("handles empty sections and empty content without producing an invalid index", () => {
    const sections = [
      { id: "pinned" as const, label: "固定", commands: [] },
      ...homeCommandSections(commands(0, 4), { pinnedRows: 1, recentRows: 1 }),
    ];

    expect(moveHomeGridSelection(sections, 0, "up")).toBe(0);
    expect(moveHomeGridSelection(sections, 3, "down")).toBe(3);
    expect(moveHomeGridSelection(sections, Number.NaN, "left")).toBe(0);
    expect(moveHomeGridSelection([], 7, "left")).toBe(0);
  });
});
