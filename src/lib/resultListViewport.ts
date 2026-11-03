import { groupedResultPresentation } from "./resultPresentation";
import type { SearchResult } from "./types";

export const RESULT_ROW_HEIGHT = 54;
export const RESULT_GROUP_HEADER_HEIGHT = 24;
export const RESULT_GROUP_GAP = 4;
export const RESULT_VIEWPORT_OVERSCAN = 3;

export type ResultViewportRow = {
  result: SearchResult;
  index: number;
  visualIndex: number;
  groupIndex: number;
  top: number;
};

export type ResultViewportGroup = {
  key: string;
  label: string;
  count: number;
  top: number;
  height: number;
  rows: ResultViewportRow[];
};

export type ResultListIndex = {
  groups: ResultViewportGroup[];
  rows: ResultViewportRow[];
  byResultIndex: Map<number, ResultViewportRow>;
  height: number;
};

export function createResultListIndex(results: SearchResult[]): ResultListIndex {
  const groups: ResultViewportGroup[] = [];
  const rows: ResultViewportRow[] = [];
  const byResultIndex = new Map<number, ResultViewportRow>();
  let top = 0;
  for (const group of groupedResultPresentation(results)) {
    const groupIndex = groups.length;
    const groupRows = group.items.map((item, rowIndex) => {
      const row = {
        ...item,
        visualIndex: rows.length,
        groupIndex,
        top: top + RESULT_GROUP_HEADER_HEIGHT + rowIndex * RESULT_ROW_HEIGHT,
      };
      rows.push(row);
      byResultIndex.set(item.index, row);
      return row;
    });
    const height = RESULT_GROUP_HEADER_HEIGHT + groupRows.length * RESULT_ROW_HEIGHT;
    groups.push({ key: group.key, label: group.label, count: groupRows.length, top, height, rows: groupRows });
    top += height + RESULT_GROUP_GAP;
  }
  return { groups, rows, byResultIndex, height: Math.max(0, top - RESULT_GROUP_GAP) };
}

export function visibleResultGroups(
  index: ResultListIndex,
  scrollTop: number,
  viewportHeight: number,
  selectedIndex: number,
  overscan = RESULT_VIEWPORT_OVERSCAN,
): ResultViewportGroup[] {
  const buffer = Math.max(0, overscan) * RESULT_ROW_HEIGHT;
  const start = Math.max(0, scrollTop - buffer);
  const end = Math.max(0, scrollTop) + Math.max(0, viewportHeight) + buffer;
  const included = new Map<number, ResultViewportRow[]>();
  const add = (row: ResultViewportRow) => {
    const groupRows = included.get(row.groupIndex) ?? [];
    groupRows.push(row);
    included.set(row.groupIndex, groupRows);
  };
  let rowIndex = firstVisibleRow(index.rows, start);
  while (rowIndex < index.rows.length && index.rows[rowIndex].top < end) {
    add(index.rows[rowIndex]);
    rowIndex += 1;
  }
  // The combobox's active descendant must remain a real DOM option even when
  // the user scrolls away from the keyboard selection.
  const selected = index.byResultIndex.get(selectedIndex);
  if (selected && !included.get(selected.groupIndex)?.some((row) => row.index === selected.index)) add(selected);
  return [...included.entries()]
    .sort(([a], [b]) => a - b)
    .map(([groupIndex, rows]) => ({
      ...index.groups[groupIndex],
      rows: rows.sort((a, b) => a.visualIndex - b.visualIndex),
    }));
}

export function selectedResultScrollTop(
  index: ResultListIndex,
  selectedIndex: number,
  scrollTop: number,
  viewportHeight: number,
): number {
  const row = index.byResultIndex.get(selectedIndex);
  if (!row) return Math.max(0, scrollTop);
  const height = Math.max(RESULT_ROW_HEIGHT, viewportHeight);
  const group = index.groups[row.groupIndex];
  // Returning to the first item also restores its source heading, including
  // when a late search response replaces a provisional selection below it.
  if (group.rows[0] === row && group.top < scrollTop
    && height >= RESULT_GROUP_HEADER_HEIGHT + RESULT_ROW_HEIGHT) return group.top;
  if (row.top < scrollTop) return row.top;
  if (row.top + RESULT_ROW_HEIGHT > scrollTop + height) {
    return Math.max(0, row.top + RESULT_ROW_HEIGHT - height);
  }
  return Math.max(0, scrollTop);
}

function firstVisibleRow(rows: ResultViewportRow[], top: number): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top + RESULT_ROW_HEIGHT <= top) low = middle + 1;
    else high = middle;
  }
  return low;
}
