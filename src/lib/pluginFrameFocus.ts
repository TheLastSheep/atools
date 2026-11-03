export type PluginFrameFocusOptions = {
  /** Confirms this element is still the current main plugin document. */
  isCurrentMainFrame: (node: HTMLIFrameElement) => boolean;
  /** Includes runtime permission prompts and host modal dialogs. */
  hasPermissionOrModal: () => boolean;
  /** True while a sub-input focus request is pending. */
  hasSubInputRequest: () => boolean;
  /** True while the host navigation sub-input is visible/active. */
  hasActiveSubInput: () => boolean;
  /** True while a hosted child window currently owns focus. */
  hasActiveChild: () => boolean;
  /** A retry trigger may hand focus to the main frame only while it still owns focus. */
  retryHandoffFrom?: HTMLElement | null;
};

/** Focus a newly mounted plugin frame only when no higher-priority host UI owns focus. */
export function focusPluginFrameWhenUnclaimed(
  node: HTMLIFrameElement | null | undefined,
  options: PluginFrameFocusOptions,
): boolean {
  try {
    if (!node || !node.isConnected || !options.isCurrentMainFrame(node)) return false;
    if (options.hasPermissionOrModal() || options.hasSubInputRequest()
      || options.hasActiveSubInput() || options.hasActiveChild()) return false;

    const document = node.ownerDocument;
    if (!document || typeof document.hasFocus !== "function" || !document.hasFocus()) return false;

    const active = document.activeElement;
    const retryHandoff = options.retryHandoffFrom;
    const mayHandOffRetryFocus = !!retryHandoff && retryHandoff.isConnected && active === retryHandoff;
    if (active !== null && active !== node && active !== document.body && active !== document.documentElement
      && !mayHandOffRetryFocus) {
      return false;
    }

    node.focus({ preventScroll: true });
    return document.activeElement === node;
  } catch {
    return false;
  }
}
