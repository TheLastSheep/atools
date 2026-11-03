import { ownsModalFocus, rememberModalReturn, restoreModalFocus } from "./modalFocusOwner";

type Options = { busy: boolean; deny: () => void };
let returnFocus: HTMLElement | null = null;

export function permissionDialogOpen(): boolean {
  return typeof document !== "undefined" && document.querySelector("[data-permission-dialog]") !== null;
}

/** Modal focus/keyboard ownership is shared across queued request generations. */
export function permissionDialogFocus(node: HTMLElement, initial: Options) {
  let options = initial;
  let destroyed = false;
  if (!returnFocus?.isConnected && document.activeElement instanceof HTMLElement) returnFocus = document.activeElement;
  returnFocus = rememberModalReturn(node, returnFocus);
  const initialFocus = () => {
    if (!destroyed && ownsModalFocus(node)) (node.querySelector<HTMLElement>("[data-permission-deny]:not(:disabled)") ?? node).focus();
  };
  queueMicrotask(initialFocus);

  function focusables() {
    return [...node.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')]
      .filter((element) => !element.hidden && !element.closest('[hidden], [aria-hidden="true"]'));
  }

  function onKeyDown(event: KeyboardEvent) {
    if (!ownsModalFocus(node)) return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      event.preventDefault();
      if (!options.busy) options.deny();
    } else if (event.key === "Tab") {
      const elements = focusables();
      const first = elements[0]; const last = elements.at(-1);
      if (!first) { event.preventDefault(); node.focus(); }
      else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
        event.preventDefault(); first.focus();
      }
    }
  }

  function onFocus(event: FocusEvent) {
    if (ownsModalFocus(node) && event.target instanceof Node && !node.contains(event.target)) initialFocus();
  }

  node.addEventListener("keydown", onKeyDown);
  document.addEventListener("focusin", onFocus);
  return {
    update(next: Options) {
      const wasBusy = options.busy;
      options = next;
      // DOM disabled attributes apply after an action update. Chromium can blur
      // a newly disabled button to body without a focusin event.
      queueMicrotask(() => {
        if (destroyed || !ownsModalFocus(node)) return;
        if (options.busy && (!node.contains(document.activeElement) || (document.activeElement as HTMLButtonElement)?.disabled)) node.focus();
        if (wasBusy && !options.busy && (document.activeElement === node || !node.contains(document.activeElement))) initialFocus();
      });
    },
    destroy() {
      destroyed = true;
      node.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocus);
      queueMicrotask(() => {
        if (!permissionDialogOpen()) { const previous = returnFocus; returnFocus = null; restoreModalFocus(previous); }
      });
    },
  };
}

