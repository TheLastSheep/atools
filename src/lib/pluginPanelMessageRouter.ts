import type { PluginFrameIdentity } from "./pluginInvokePolicy";

/**
 * Owns the ordered trust-boundary phases for messages arriving from plugin frames.
 * Mutable host state and capability behavior remain supplied by the panel.
 */
export type PluginPanelMessageRouterContext = {
  isBlocked: () => boolean;
  handlePageMessage: (event: MessageEvent) => boolean;
  identify: (event: MessageEvent) => PluginFrameIdentity | null;
  receiveMainPush: (event: MessageEvent, identity: PluginFrameIdentity) => boolean;
  presentationDenied: (data: Record<string, unknown>) => boolean;
  rejectPresentationDenied: (event: MessageEvent, data: Record<string, unknown>) => void;
  isActiveChild: (windowId: string) => boolean;
  unregisterChild: (windowId: string, source: MessageEventSource | null) => void;
  bindLifecycle: (event: MessageEvent, identity: PluginFrameIdentity, data: Record<string, unknown>) => boolean;
  dispatchPermissions: (event: MessageEvent, data: Record<string, unknown>, identity: PluginFrameIdentity) => boolean;
  dispatchAuthenticated: (event: MessageEvent, data: Record<string, unknown>, identity: PluginFrameIdentity) => void;
};

export function createPluginPanelMessageRouter(context: PluginPanelMessageRouterContext) {
  function handle(event: MessageEvent) {
    if (context.isBlocked()) return;
    if (context.handlePageMessage(event)) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    const identity = context.identify(event);
    if (!identity) return;
    if (context.receiveMainPush(event, identity)) return;
    if (context.presentationDenied(data)) {
      context.rejectPresentationDenied(event, data);
      return;
    }
    if (identity.kind === "child" && !context.isActiveChild(identity.windowId)) {
      context.unregisterChild(identity.windowId, event.source);
      return;
    }
    try {
      if (context.bindLifecycle(event, identity, data)) return;
    } catch {
      return;
    }
    if (context.dispatchPermissions(event, data, identity)) return;
    context.dispatchAuthenticated(event, data, identity);
  }

  return { handle };
}
