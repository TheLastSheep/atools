import { createPluginPanelFrameMounts } from "./pluginPanelFrameMount";
import { postPluginBrowserWindowReadiness } from "./pluginBrowserWindowReady";

/** Binds authenticated frame mounting to the one panel-owned identity/RPC state. */
type BrowserWindowPanelState = ReturnType<typeof import("./pluginPanelBrowserWindowState.svelte.js").createPluginPanelBrowserWindowState>;
type PluginPanelDocumentHost = ReturnType<typeof import("./pluginPanelDocumentHost").createPluginPanelDocumentHost>;

export function createPluginPanelFrameMountHost(options: {
  state: BrowserWindowPanelState;
  activePage: () => PluginPanelDocumentHost | undefined;
  focusMainFrame: (node: HTMLIFrameElement) => boolean;
  reportReady: () => void;
}) {
  const { state } = options;
  return createPluginPanelFrameMounts({
    activePage: options.activePage,
    hasMainReservation: () => state.hostedIpc.hasReservation({ kind: "main" }),
    registerFrame: (role, source, ready, loaded, replyTarget) => state.hostedIpc.registerFrame(role, source, ready, loaded, replyTarget),
    invalidateFrame: (role, close, source) => state.hostedIpc.invalidate(role, close, source),
    unregisterMain: source => state.sources.unregisterMain(source),
    registerChild: (id, source, replyTarget) => state.sources.registerChild(id, source, replyTarget),
    unregisterChild: (id, source) => state.sources.unregisterChild(id, source),
    currentIdentity: source => state.sources.currentIdentityForHost(source),
    bind: (role, source, identity, ready, replyTarget) => state.hostedIpc.bind(role, source, identity, ready, replyTarget),
    confirmReady: (role, source, nonce) => state.hostedIpc.confirmReady(role, source, nonce),
    readinessFailureIsCurrent: (role, source, nonce) => state.hostedIpc.readinessFailureIsCurrent(role, source, nonce),
    sources: state.sources, rpc: state.rpc, frames: state.frames,
    windows: () => state.windows, geometry: state.geometry, creators: state.creators,
    postReadiness: postPluginBrowserWindowReadiness, post: state.post,
    focusMainFrame: options.focusMainFrame, reportReady: options.reportReady,
  });
}
