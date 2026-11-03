import { groupedResultPresentation } from "./resultPresentation";
import { isEditableKeyboardTarget, isMainSearchKeyboardTarget } from "./keyboardTarget";
import type { SearchResult } from "./types";

type LauncherKeyboardEvent = Pick<KeyboardEvent, "defaultPrevented" | "isComposing" | "keyCode" | "target">;
type EmptyHomePassThroughContext = {
  isHomeSearch: boolean;
  emptyQuery: boolean;
  hasSelectableRows: boolean;
  hasTextOrMediaContext: boolean;
  modalOpen: boolean;
};

export function ignoreLauncherKeyboardEvent(event: LauncherKeyboardEvent): boolean {
  const target = event.target as { dataset?: { atoolsComposing?: string } } | null;
  return event.defaultPrevented
    || event.isComposing
    || event.keyCode === 229
    || target?.dataset?.atoolsComposing === "true";
}

export function isLauncherNavigationTarget(target: EventTarget | null): boolean {
  if (isEditableKeyboardTarget(target)) return isMainSearchKeyboardTarget(target);
  const element = target as { closest?: (selector: string) => Element | null } | null;
  if (typeof element?.closest !== "function") return true;
  if (element.closest('[role="option"][data-result-index]')) return true;
  return !element.closest('button, a[href], summary, [role="button"]');
}

export function shouldPassThroughEmptyHomeKey(
  event: LauncherKeyboardEvent & Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">,
  context: EmptyHomePassThroughContext,
): boolean {
  return ["ArrowUp", "ArrowDown", "Enter"].includes(event.key)
    && !ignoreLauncherKeyboardEvent(event)
    && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && isMainSearchKeyboardTarget(event.target)
    && context.isHomeSearch && context.emptyQuery && !context.hasSelectableRows
    && !context.hasTextOrMediaContext && !context.modalOpen;
}

export function resultNavigationOrder(results: SearchResult[]): number[] {
  return groupedResultPresentation(results).flatMap((group) => group.items.map((item) => item.index));
}

export function resultVisualPosition(results: SearchResult[], selectedIndex: number): number {
  return Math.max(0, resultNavigationOrder(results).indexOf(selectedIndex));
}

export function moveResultSelection(
  results: SearchResult[],
  selectedIndex: number,
  delta: number,
  wrap = false,
): number {
  const order = resultNavigationOrder(results);
  if (order.length === 0) return 0;
  const position = Math.max(0, order.indexOf(selectedIndex));
  const nextPosition = wrap
    ? ((position + delta) % order.length + order.length) % order.length
    : Math.max(0, Math.min(order.length - 1, position + delta));
  return order[nextPosition];
}

export function resultOptionId(index: number): string {
  return `launcher-result-${index}`;
}
