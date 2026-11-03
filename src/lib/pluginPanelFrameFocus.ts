import { focusPluginFrameWhenUnclaimed } from "./pluginFrameFocus";

export type PluginPanelFrameFocusPorts = {
  visible: () => boolean;
  isCurrentMainFrame: (frame: HTMLIFrameElement) => boolean;
  hasPermissionOrModal: () => boolean;
  hasSubInputRequest: () => boolean;
  hasActiveSubInput: () => boolean;
  hasActiveChild: () => boolean;
};

/** Applies the panel's existing focus handoff guards to its current main frame. */
export function focusPluginPanelMainFrame(
  node: HTMLIFrameElement | null,
  ports: PluginPanelFrameFocusPorts,
  retryHandoffFrom?: HTMLElement,
) {
  if (!ports.visible()) return false;
  return focusPluginFrameWhenUnclaimed(node, {
    isCurrentMainFrame: ports.isCurrentMainFrame,
    hasPermissionOrModal: ports.hasPermissionOrModal,
    hasSubInputRequest: ports.hasSubInputRequest,
    hasActiveSubInput: ports.hasActiveSubInput,
    hasActiveChild: ports.hasActiveChild,
    retryHandoffFrom,
  });
}


/** Creates a stable focus callback while each port reads the current panel state. */
export function createPluginPanelMainFrameFocus(ports: PluginPanelFrameFocusPorts) {
  return (node: HTMLIFrameElement | null, retryHandoffFrom?: HTMLElement) =>
    focusPluginPanelMainFrame(node, ports, retryHandoffFrom);
}
