const returnTargets = new WeakMap<HTMLElement, HTMLElement | null>();

export function rememberModalReturn(node: HTMLElement, previous: HTMLElement | null): HTMLElement | null {
  const parent = previous?.closest<HTMLElement>("dialog[open], .confirm-panel, [data-permission-dialog]");
  const target = parent && returnTargets.has(parent) ? returnTargets.get(parent)! : previous;
  returnTargets.set(node, target);
  return target;
}

/** Native top layer, global permission, then confirmation inside ShellFrame's stacking context. */
export function modalFocusOwner(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const selector of ["dialog[open]", "[data-permission-dialog]", ".confirm-panel"]) {
    const nodes = document.querySelectorAll<HTMLElement>(selector);
    if (nodes.length) return nodes[nodes.length - 1];
  }
  return null;
}

export const ownsModalFocus = (node: HTMLElement) => modalFocusOwner() === node;

/** Resume a still-mounted lower layer before returning to its original trigger. */
export function restoreModalFocus(previous: HTMLElement | null) {
  const owner = modalFocusOwner();
  if (owner) {
    const control = owner.querySelector<HTMLElement>(
      "[data-market-detail-close], [data-confirm-cancel], [data-permission-deny]:not(:disabled)",
    );
    (control ?? owner).focus({ preventScroll: true });
  } else if (previous?.isConnected && !previous.closest("[hidden], [aria-hidden=true]")) {
    previous.focus({ preventScroll: true });
  }
}
