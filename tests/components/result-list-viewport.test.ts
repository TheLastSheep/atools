import { describe, expect, it } from "vitest";
import {
  createResultListIndex,
  selectedResultScrollTop,
  visibleResultGroups,
} from "../../src/lib/resultListViewport";
import type { SearchResult } from "../../src/lib/types";

function result(index: number, pluginId = `plugin-${index % 2}`): SearchResult {
  return {
    code: `command-${index}`,
    plugin_id: pluginId,
    plugin_name: pluginId,
    label: `Command ${index}`,
    icon: null,
    explain: "",
    score: 100 - index,
    match_type: "exact",
  };
}

describe("result list viewport geometry", () => {
  it("indexes grouped rows using their real visual order and exact header, row and gap heights", () => {
    const index = createResultListIndex([result(0), result(1), result(2)]);
    expect(index.rows.map((row) => [row.index, row.visualIndex, row.top])).toEqual([
      [0, 0, 24],
      [2, 1, 78],
      [1, 2, 160],
    ]);
    expect(index.groups.map((group) => [group.top, group.height, group.count])).toEqual([
      [0, 132, 2],
      [136, 78, 1],
    ]);
    expect(index.height).toBe(214);
    expect(createResultListIndex([]).height).toBe(0);
  });

  it("bounds visible DOM across a large multi-group list and preserves the selected option once", () => {
    const index = createResultListIndex(Array.from({ length: 1200 }, (_, i) => result(i, `plugin-${i % 12}`)));
    expect(index.height).toBe(65_132);
    const topRows = visibleResultGroups(index, 0, 420, 1199).flatMap((group) => group.rows);
    expect(topRows.length).toBeLessThanOrEqual(16);
    expect(topRows.filter((row) => row.index === 1199)).toHaveLength(1);
    expect(topRows.at(-1)?.index).toBe(1199);
    const middleRows = visibleResultGroups(index, 20_000, 420, 1199).flatMap((group) => group.rows);
    expect(middleRows.length).toBeLessThanOrEqual(16);
    expect(middleRows.some((row) => row.top >= 20_000 && row.top < 20_420)).toBe(true);
    expect(middleRows.filter((row) => row.index === 1199)).toHaveLength(1);
    const selectedVisible = visibleResultGroups(index, 0, 420, 0).flatMap((group) => group.rows);
    expect(selectedVisible.filter((row) => row.index === 0)).toHaveLength(1);
  });

  it("includes rows at viewport edges and scrolls only when selection leaves the viewport", () => {
    const index = createResultListIndex([result(0), result(1), result(2)]);
    expect(visibleResultGroups(index, 78, 54, -1, 0).flatMap((group) => group.rows.map((row) => row.index))).toEqual([2]);
    expect(visibleResultGroups(index, 132, 28, -1, 0).flatMap((group) => group.rows)).toEqual([]);
    expect(selectedResultScrollTop(index, 0, 0, 112)).toBe(0);
    expect(selectedResultScrollTop(index, 1, 0, 112)).toBe(102);
    expect(selectedResultScrollTop(index, 2, 100, 112)).toBe(78);
    expect(selectedResultScrollTop(index, 1, 102, 112)).toBe(102);
    expect(selectedResultScrollTop(index, -1, 10, 112)).toBe(10);
  });

  it("restores the source heading when a late result becomes the first selection", () => {
    const index = createResultListIndex([result(0), result(1), result(2)]);
    expect(selectedResultScrollTop(index, 0, 24, 420)).toBe(0);
    expect(selectedResultScrollTop(index, 0, 19, 420)).toBe(0);
    expect(selectedResultScrollTop(index, 0, 180, 112)).toBe(0);
    // A viewport only one row tall must still expose the whole selected row.
    expect(selectedResultScrollTop(index, 0, 180, 54)).toBe(24);
  });
});
