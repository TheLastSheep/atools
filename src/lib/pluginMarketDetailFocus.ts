import { rememberModalReturn, restoreModalFocus } from "./modalFocusOwner";

type DetailFocusOptions = { returnTo: HTMLElement | null; close: () => void };

/** Native modality keeps the long catalog inert without rebuilding or scrolling it. */
export function pluginMarketDetailFocus(node: HTMLDialogElement, options: DetailFocusOptions) {
  const returnTo = rememberModalReturn(node, options.returnTo);
  let destroyed = false;
  const focusable = () => [...node.querySelectorAll<HTMLElement>(
    'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
  )].filter(element => !element.closest('[hidden], [aria-hidden="true"]'));
  const close = () => options.close();
  const onCancel = (event: Event) => { event.preventDefault(); close(); };
  const onKeydown = (event: KeyboardEvent) => {
    // Own modal keys before launcher/settings window handlers can interpret them.
    event.stopPropagation();
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const elements = focusable(), first = elements[0], last = elements.at(-1);
    if (!first) { event.preventDefault(); node.focus({ preventScroll: true }); }
    else if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
      event.preventDefault(); last?.focus({ preventScroll: true });
    } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === node)) {
      event.preventDefault(); first.focus({ preventScroll: true });
    }
  };
  node.addEventListener("cancel", onCancel);
  node.addEventListener("keydown", onKeydown);
  queueMicrotask(() => {
    if (destroyed || !node.isConnected) return;
    node.showModal();
    (node.querySelector<HTMLElement>("[data-market-detail-close]") ?? node).focus({ preventScroll: true });
  });
  return { destroy() {
    destroyed = true;
    node.removeEventListener("cancel", onCancel);
    node.removeEventListener("keydown", onKeydown);
    if (node.open) node.close();
    // Navigation may remove the original row; never steal focus onto a detached node.
    restoreModalFocus(returnTo);
  } };
}

