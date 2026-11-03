import { RESULT_ROW_HEIGHT, type ResultListIndex } from "./resultListViewport";

/** Move by one measured page in visual order, including source headings/gaps. */
export function pageResultSelection(
  layout: ResultListIndex,
  selectedIndex: number,
  direction: -1 | 1,
  viewportHeight: number,
): number | null {
  const { rows } = layout;
  if (rows.length === 0) return null;
  const current = layout.byResultIndex.get(selectedIndex) ?? rows[0];
  const pageHeight = Math.max(RESULT_ROW_HEIGHT, Number.isFinite(viewportHeight) ? viewportHeight : 0);
  const targetTop = current.top + direction * pageHeight;
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (rows[middle].top < targetTop) low = middle + 1;
    else high = middle;
  }
  const after = Math.min(rows.length - 1, low);
  const before = Math.max(0, low - 1);
  const beforeDistance = Math.abs(rows[before].top - targetTop);
  const afterDistance = Math.abs(rows[after].top - targetTop);
  const closest = beforeDistance === afterDistance ? (direction > 0 ? after : before)
    : beforeDistance < afterDistance ? before : after;
  // A short viewport or a large heading must still advance at least one row.
  const next = direction > 0
    ? Math.min(rows.length - 1, Math.max(current.visualIndex + 1, closest))
    : Math.max(0, Math.min(current.visualIndex - 1, closest));
  return rows[next].index;
}
