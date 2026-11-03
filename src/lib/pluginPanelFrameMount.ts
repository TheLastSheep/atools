import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginFrameIdentity, PluginFrameReplyTarget, PluginFrameSourceRegistry } from "./pluginFrameDocumentIdentity";
import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import { createPluginPanelDocumentHost } from "./pluginPanelDocumentHost";
import { postPluginBrowserWindowReadiness } from "./pluginBrowserWindowReady";
import { finalizePluginNativeBrowserWindowRenderer } from "./pluginNativeBrowserWindowCallbacks";

export type PluginPanelFrameMountPorts = {
  activePage: () => ReturnType<typeof createPluginPanelDocumentHost> | undefined;
  hasMainReservation: () => boolean;
  registerFrame: (scope: { kind: "main" } | { kind: "child"; windowId: string }, source: Window | null, primary?: boolean, loaded?: boolean, replyTarget?: PluginFrameReplyTarget) => void;
  invalidateFrame: (scope: { kind: "main" } | { kind: "child"; windowId: string }, close?: boolean, source?: Window | null) => void;
  unregisterMain: (source: Window | null) => void;
  registerChild: (windowId: string, source: Window | null, replyTarget?: PluginFrameReplyTarget) => void;
  unregisterChild: (windowId: string, source?: Window | null) => void;
  currentIdentity: (source: unknown) => PluginFrameIdentity | null;
  bind: (scope: { kind: "child"; windowId: string }, source: Window | null, identity: PluginFrameIdentity, ready?: boolean, replyTarget?: PluginFrameReplyTarget) => void;
  confirmReady: (scope: { kind: "child"; windowId: string }, source: Window | null, nonce?: string) => Promise<PluginHostedDocumentLease>;
  readinessFailureIsCurrent: (scope: { kind: "child"; windowId: string }, source: Window | null, nonce?: string) => boolean;
  sources: PluginFrameSourceRegistry;
  rpc: {
    attach: (windowId: string, source: PluginFrameReplyTarget) => number;
    waitReady: (windowId: string) => Promise<void>;
    readyDocumentNonce: (windowId: string, generation: number) => string | undefined;
    isAttached: (windowId: string) => boolean;
    isCurrentGeneration: (windowId: string, generation: number) => boolean;
    close: (windowId: string) => void;
  };
  frames: Map<string, HTMLIFrameElement>;
  windows: () => PluginBrowserWindowState[];
  geometry: { synchronizeSelf: (window: PluginBrowserWindowState, source: Window | null) => boolean };
  creators: Map<string, PluginBrowserWindowCreator>;
  postReadiness: typeof postPluginBrowserWindowReadiness;
  post: (source: unknown, message: unknown) => boolean;
  focusMainFrame: (node: HTMLIFrameElement) => boolean;
  reportReady: () => void;
};

export type PluginPanelMainFrameMountPorts = Pick<PluginPanelFrameMountPorts,
  "activePage" | "hasMainReservation" | "registerFrame" | "invalidateFrame" | "unregisterMain" | "focusMainFrame" | "reportReady">;

export function createPluginPanelMainFrameMount(ports: PluginPanelMainFrameMountPorts) {
  return function pluginMainFrame(node: HTMLIFrameElement) {
    if (ports.activePage()) return ports.activePage()!.mount(node);
    const registerSource = (loaded = false) => {
      // The iframe can outlive the bridge slot while a previous load is shutting down.
      if (ports.hasMainReservation()) ports.registerFrame({ kind: "main" }, node.contentWindow, true, loaded);
    };
    const reportReady = () => {
      registerSource(true);
      ports.focusMainFrame(node);
      ports.reportReady();
    };
    registerSource();
    ports.focusMainFrame(node);
    node.addEventListener("load", reportReady);
    return {
      destroy() {
        node.removeEventListener("load", reportReady);
        ports.invalidateFrame({ kind: "main" }, false, node.contentWindow);
        ports.unregisterMain(node.contentWindow);
      },
    };
  };
}

export function createPluginPanelFrameMounts(ports: PluginPanelFrameMountPorts) {
  const pluginMainFrame = createPluginPanelMainFrameMount(ports);

  function pluginBrowserWindowFrame(node: HTMLIFrameElement, windowId: string, replyTarget?: PluginFrameReplyTarget) {
    let currentWindowId = windowId;
    let initialReadySent = false;
    const markReady = () => {
      ports.registerFrame({ kind: "child", windowId: currentWindowId }, node.contentWindow, undefined, undefined, replyTarget);
      if (!node.contentWindow) return;
      const rpcGeneration = ports.rpc.attach(currentWindowId, replyTarget ?? node.contentWindow);
      const readyWindowId = currentWindowId;
      let readyNonce: string | undefined;
      void ports.rpc.waitReady(readyWindowId).then(async () => {
        if (ports.frames.get(readyWindowId) !== node) return;
        readyNonce = ports.rpc.readyDocumentNonce(readyWindowId, rpcGeneration);
        const readyLease = await ports.confirmReady({ kind: "child", windowId: readyWindowId }, node.contentWindow, readyNonce);
        readyLease.assertCurrent();
        if (initialReadySent || ports.frames.get(readyWindowId) !== node) return;
        const childWindow = ports.windows().find(candidate => candidate.id === readyWindowId);
        if (!childWindow || !ports.geometry.synchronizeSelf(childWindow, node.contentWindow)) throw new Error("BrowserWindow current document geometry synchronization failed");
        if (childWindow.hostKind === "native") await finalizePluginNativeBrowserWindowRenderer(node.contentWindow, readyWindowId, readyLease);
        readyLease.assertCurrent();
        if (ports.frames.get(readyWindowId) !== node) return;
        const sent = ports.postReadiness({
          creator: ports.creators.get(readyWindowId),
          sources: ports.sources,
          message: { __atools_browser_window_ready__: true, windowId: readyWindowId, clientCreateId: childWindow.clientCreateId },
          post: ports.post,
        });
        if (sent) initialReadySent = true;
      }).catch(error => {
        if (initialReadySent || ports.frames.get(readyWindowId) !== node) return;
        if (ports.rpc.isAttached(readyWindowId) && !ports.rpc.isCurrentGeneration(readyWindowId, rpcGeneration)) return;
        if (!ports.readinessFailureIsCurrent({ kind: "child", windowId: readyWindowId }, node.contentWindow, readyNonce)) return;
        ports.invalidateFrame({ kind: "child", windowId: readyWindowId });
        const childWindow = ports.windows().find(candidate => candidate.id === readyWindowId);
        const sent = ports.postReadiness({
          creator: ports.creators.get(readyWindowId),
          sources: ports.sources,
          message: {
            __atools_browser_window_failed__: true,
            windowId: readyWindowId,
            clientCreateId: childWindow?.clientCreateId,
            error: error instanceof Error ? error.message : String(error),
          },
          post: ports.post,
        });
        if (sent) initialReadySent = true;
      });
    };
    ports.frames.set(currentWindowId, node);
    ports.registerChild(currentWindowId, node.contentWindow, replyTarget);
    const initialIdentity = ports.currentIdentity(node.contentWindow);
    if (initialIdentity) ports.bind({ kind: "child", windowId: currentWindowId }, node.contentWindow, initialIdentity, false, replyTarget);
    node.addEventListener("load", markReady);
    return {
      update(nextWindowId: string) {
        if (nextWindowId === currentWindowId) return;
        ports.invalidateFrame({ kind: "child", windowId: currentWindowId }, false, node.contentWindow);
        ports.unregisterChild(currentWindowId, node.contentWindow);
        ports.rpc.close(currentWindowId);
        ports.frames.delete(currentWindowId);
        currentWindowId = nextWindowId;
        ports.frames.set(currentWindowId, node);
        ports.registerChild(currentWindowId, node.contentWindow, replyTarget);
        const identity = ports.currentIdentity(node.contentWindow);
        if (identity) ports.bind({ kind: "child", windowId: currentWindowId }, node.contentWindow, identity, false, replyTarget);
      },
      destroy() {
        node.removeEventListener("load", markReady);
        ports.invalidateFrame({ kind: "child", windowId: currentWindowId }, false, node.contentWindow);
        ports.unregisterChild(currentWindowId, node.contentWindow);
        ports.rpc.close(currentWindowId);
        ports.frames.delete(currentWindowId);
      },
    };
  }

  return { pluginMainFrame, pluginBrowserWindowFrame };
}
