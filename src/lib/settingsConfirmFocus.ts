import { ownsModalFocus, rememberModalReturn, restoreModalFocus } from "./modalFocusOwner";

type ConfirmFocusOptions = { cancel: () => void };

/** Own keyboard focus only while an application confirmation is mounted. */
export function settingsConfirmFocus(node: HTMLElement, initial: ConfirmFocusOptions) {
  let options = initial, destroyed = false;
  const returnTo = rememberModalReturn(node, document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const controls = () => [...node.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const focusCancel = () => {
    if (!destroyed && ownsModalFocus(node)) (node.querySelector<HTMLElement>("[data-confirm-cancel]") ?? node).focus({ preventScroll: true });
  };
  function keydown(event: KeyboardEvent) {
    if (!ownsModalFocus(node)) return;
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); options.cancel(); return; }
    if (event.key !== "Tab") return;
    const first = controls()[0], last = controls().at(-1);
    if (!first) { event.preventDefault(); node.focus({ preventScroll: true }); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault(); last?.focus({ preventScroll: true });
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
      event.preventDefault(); first.focus({ preventScroll: true });
    }
  }
  function focusin(event: FocusEvent) {
    if (ownsModalFocus(node) && event.target instanceof Node && !node.contains(event.target)) focusCancel();
  }
  node.addEventListener("keydown", keydown);
  document.addEventListener("focusin", focusin);
  queueMicrotask(focusCancel);
  return {
    update(next: ConfirmFocusOptions) { options = next; },
    destroy() {
      destroyed = true;
      node.removeEventListener("keydown", keydown);
      document.removeEventListener("focusin", focusin);
      queueMicrotask(() => {
        restoreModalFocus(returnTo);
      });
    },
  };
}

