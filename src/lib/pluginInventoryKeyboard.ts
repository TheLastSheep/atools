export type PluginInventoryFocusSnapshot = {
  pluginId: string;
  element: HTMLElement;
};

export type PluginInventoryBoundaryDirection = "next" | "previous";

export type PluginInventoryBoundaryHandler = (
  direction: PluginInventoryBoundaryDirection,
  originPluginId: string,
  originButton: HTMLButtonElement,
) => boolean;

function keepPluginInventoryButtonVisible(button: HTMLButtonElement): void {
  button.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "auto" });
}

export function handlePluginInventoryKeydown(
  event: KeyboardEvent,
  list: HTMLElement,
  onBoundary?: PluginInventoryBoundaryHandler,
): void {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  const origin = event.target;
  if (!(origin instanceof HTMLElement) || !origin.matches("button[data-plugin-detail-id]") || !list.contains(origin)) return;

  const buttons = Array.from(list.querySelectorAll<HTMLButtonElement>("button[data-plugin-detail-id]:not(:disabled)"));
  const index = buttons.indexOf(origin as HTMLButtonElement);
  if (index < 0) return;

  let targetIndex: number;
  switch (event.key) {
    case "ArrowDown":
      if (index === buttons.length - 1) {
        event.preventDefault();
        const pluginId = origin.dataset.pluginDetailId;
        if (pluginId) onBoundary?.("next", pluginId, origin as HTMLButtonElement);
        return;
      }
      targetIndex = index + 1;
      break;
    case "ArrowUp":
      if (index === 0) {
        event.preventDefault();
        const pluginId = origin.dataset.pluginDetailId;
        if (pluginId) onBoundary?.("previous", pluginId, origin as HTMLButtonElement);
        return;
      }
      targetIndex = index - 1;
      break;
    case "Home": targetIndex = 0; break;
    case "End": targetIndex = buttons.length - 1; break;
    default: return;
  }
  event.preventDefault();
  const target = buttons[targetIndex];
  if (target === origin) return;
  target.focus({ preventScroll: true });
  keepPluginInventoryButtonVisible(target);
}

export function observeFocusedPluginInventoryButton(list: HTMLElement): () => void {
  if (typeof ResizeObserver === "undefined") return () => {};
  const observed = new Set<Element>([list]);
  for (let parent = list.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    if ([style.overflowX, style.overflowY].some(value => value === "auto" || value === "scroll")) {
      observed.add(parent);
      break;
    }
  }
  const observer = new ResizeObserver(() => {
    const active = document.activeElement;
    if (!(active instanceof HTMLButtonElement) || !active.matches("button[data-plugin-detail-id]") || !list.contains(active)) return;
    keepPluginInventoryButtonVisible(active);
  });
  for (const element of observed) observer.observe(element);
  return () => observer.disconnect();
}

export function restorePluginInventorySearchFocus(
  searchInput: HTMLInputElement | undefined,
  previousFocus: PluginInventoryFocusSnapshot | null,
): boolean {
  if (!searchInput || !previousFocus || previousFocus.element.isConnected) return false;
  const active = document.activeElement;
  if (active !== document.body && active !== previousFocus.element) return false;
  searchInput.focus({ preventScroll: true });
  return true;
}
