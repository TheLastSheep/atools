import type { HomeCommandSection } from "./homeSurface";

export type HomeGridDirection = "left" | "right" | "up" | "down";

/** Return only unmodified, non-composing arrow keys for a focused Home command. */
export function homeGridArrowDirection(
  event: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey" | "isComposing" | "keyCode" | "defaultPrevented">,
): HomeGridDirection | null {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229
    || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return null;
  switch (event.key) {
    case "ArrowLeft": return "left";
    case "ArrowRight": return "right";
    case "ArrowUp": return "up";
    case "ArrowDown": return "down";
    default: return null;
  }
}

const HOME_GRID_COLUMNS = 9;

type HomeGridRow = { indices: number[] };

/** Move through the exact rows rendered by HomePanel, keeping section boundaries. */
/** Prefer the selected rendered command, then the first usable command as a safe Tab entry. */
export function homeGridCommandTarget(root: ParentNode, preferredIndex: number): HTMLButtonElement | null {
  if (Number.isSafeInteger(preferredIndex) && preferredIndex >= 0) {
    const preferred = root.querySelector<HTMLButtonElement>(`[data-home-command-index="${preferredIndex}"] .recent-item:not([disabled])`);
    if (preferred) return preferred;
  }
  return root.querySelector<HTMLButtonElement>('[data-home-command-index] .recent-item:not([disabled])');
}

export function moveHomeGridSelection(
  sections: HomeCommandSection[],
  selectedIndex: number,
  direction: HomeGridDirection,
  columnCount = HOME_GRID_COLUMNS,
): number {
  const total = sections.reduce((count, section) => count + section.commands.length, 0);
  if (total === 0) return 0;

  const finiteIndex = Number.isFinite(selectedIndex) ? Math.trunc(selectedIndex) : 0;
  const currentIndex = Math.max(0, Math.min(total - 1, finiteIndex));
  const columns = Number.isFinite(columnCount)
    ? Math.max(1, Math.trunc(columnCount))
    : HOME_GRID_COLUMNS;
  const rows = homeGridRows(sections, columns);
  const rowIndex = rows.findIndex((row) => row.indices.includes(currentIndex));
  if (rowIndex < 0) return currentIndex;

  const row = rows[rowIndex].indices;
  const column = row.indexOf(currentIndex);
  if (direction === "left" || direction === "right") {
    const nextColumn = column + (direction === "left" ? -1 : 1);
    return row[nextColumn] ?? currentIndex;
  }

  const adjacentRowIndex = rowIndex + (direction === "up" ? -1 : 1);
  const adjacentRow = rows[adjacentRowIndex]?.indices;
  if (!adjacentRow) return currentIndex;
  return adjacentRow[Math.min(column, adjacentRow.length - 1)];
}

/** Read the shared expanded CSS track count used by both HomePanel sections. */
export function homeGridColumnCount(root: ParentNode | null): number {
  const grid = root?.querySelector<HTMLElement>(".recent-grid:not(.pinned-grid)")
    ?? root?.querySelector<HTMLElement>(".recent-grid");
  if (!grid || grid.clientWidth <= 0 || typeof getComputedStyle !== "function") return HOME_GRID_COLUMNS;

  const template = getComputedStyle(grid).gridTemplateColumns.trim();
  if (!template || template === "none" || template.includes("repeat(")) return HOME_GRID_COLUMNS;
  const trackCount = template.split(/\s+/).filter(Boolean).length;
  return trackCount > 0 ? trackCount : HOME_GRID_COLUMNS;
}

function homeGridRows(sections: HomeCommandSection[], columns: number): HomeGridRow[] {
  const rows: HomeGridRow[] = [];
  let globalIndex = 0;
  for (const section of sections) {
    for (let start = 0; start < section.commands.length; start += columns) {
      const rowLength = Math.min(columns, section.commands.length - start);
      rows.push({ indices: Array.from({ length: rowLength }, (_, column) => globalIndex + start + column) });
    }
    globalIndex += section.commands.length;
  }
  return rows;
}
