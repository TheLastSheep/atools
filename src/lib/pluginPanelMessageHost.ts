import type { FeatureAction, PluginItem, PluginOutput } from "./types";
import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginFrameIdentity, PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import type { PluginDocumentIdentity } from "./pluginFrameDocumentIdentity";
import type { PluginFeatureIntent, PluginFeatureList as PluginFeatureListState } from "./pluginFeatureExportsState";
import type { PluginSubInputState } from "./pluginSubInputState";
import type { createPluginHostedIpcRouter } from "./pluginHostedIpcRouter";
import type { PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import type { createPluginPanelDocumentHost } from "./pluginPanelDocumentHost";
import type { createHostClipboardController } from "./hostClipboardController";
import type { createPluginDisplayController } from "./pluginDisplayController";
import type { createPluginDataController } from "./pluginDataController";
import type { createPluginDialogsController } from "./pluginDialogsController";
import type { createPluginPathsController } from "./pluginPathsController";
import { createPluginNativeBridgeRouter } from "./pluginPanelNativeBridgeRouter";
import { createPluginPanelMessageHandlers } from "./pluginPanelMessageHandlers";
import { createAuthenticatedPluginMessageHandler } from "./authenticatedPluginMessageHandler";
import { createPluginPanelMessageRouter } from "./pluginPanelMessageRouter";
import { dispatchPluginInvokeMessage, postPluginFrameMessageIfCurrent, isPluginBridgeRequestId, identifyPluginMessageEvent } from "./pluginInvokePolicy";
import { pluginMainPushPresentationDenied } from "./pluginMainPushPresentation";
import { featureListMessage } from "./pluginFeatureExportsState";
import { dispatchHostClipboardPermission } from "./hostClipboardController";
import { dispatchPluginDisplayPermission } from "./pluginDisplayController";
import { dispatchPluginDataPermission } from "./pluginDataController";
import { dispatchPluginDialogsPermission } from "./pluginDialogsController";
import { dispatchPluginPathsPermission } from "./pluginPathsController";
import { createPluginClipboardChangeHub } from "./pluginClipboardChangeHub";
import { createPluginBroadcastChannelHost } from "./pluginBroadcastChannelHost";
import { createPluginContextMenuController } from "./pluginContextMenuController.svelte";
import { registerPluginNativeBrowserWindowMessages } from "./pluginNativeBrowserWindowCallbacks";

type Ports = {
  action: () => FeatureAction;
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  sources: PluginFrameSourceRegistry;
  hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>;
  browserWindows: () => PluginBrowserWindowState[];
  creatorFor: (id: string) => PluginBrowserWindowCreator | undefined;
  ensurePermission: (permission: string | null | undefined, source: Window | null) => Promise<void>;
  onclose: (isKill?: boolean) => void | Promise<void>;
  onredirect?: (label: unknown, payload: unknown) => boolean | Promise<boolean>;
  onsettingsredirect?: (menu: "shortcuts" | "ai", detail?: Record<string, unknown>) => boolean | Promise<boolean>;
  writePluginImage: (image: unknown) => Promise<void>;
  pathFromBridgeValue: (value: unknown) => string;
  pathsFromBridgeValue: (value: unknown) => string[];
  runAppleScript: (script: string, label: string) => Promise<string>;
  appleScriptString: (value: string) => string;
  normalizeCopiedFileEntries: (entries: unknown) => unknown[];
  runCommand: (program: string, args: string[], label: string) => Promise<string>;
  writeText: (value: string) => Promise<void>;
  hidePanelForPaste: (onclose: () => void) => Promise<void>;
  pluginFileClipboardAppleScript: (paths: string[]) => string;
  pickScreenColorWithEyeDropper: () => Promise<{ hex: string; rgb: string }>;
  dispatchParentMessage: (args: Record<string, unknown>) => unknown;
  browserWindowAction: (args: Record<string, unknown>, creator?: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) => unknown;
  createBrowserWindow: (args: Record<string, unknown>, creator: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) => Promise<unknown>;
  shouldUseNativeBrowserWindow?: (method: string, args: Record<string, unknown>, identity: PluginFrameIdentity) => boolean;
  shellOpen: (path: string) => Promise<void>;
  iframeSrc: () => string;
  previewPayload: () => Record<string, unknown>;
  webPreviewPluginPath: string;
  iframeWindow: () => Window | null;
  pluginResourceUrl: () => (path: string) => string;
  post: (source: unknown, message: unknown, identity?: PluginFrameIdentity) => boolean;
  closePanel: (isKill?: boolean) => void | Promise<void>;
  setUiHostProbeResult: (result: { pluginId: string; featureCode: string; passed: number; total: number; failedIds: string[] }) => void;
  handlePermissionRequest: (event: MessageEvent, data: Record<string, unknown>, identity: PluginFrameIdentity) => void;
  handleDesktopSmokeProbe: (data: Record<string, unknown>) => void;
  handleContextMenu: (data: Record<string, unknown>) => void;
  requestEscape: () => Promise<void>;
  featureList: () => PluginFeatureListState;
  setFeatureList: (value: PluginFeatureListState) => void;
  featureListIntent: (value: PluginFeatureIntent) => unknown;
  subInputState: () => PluginSubInputState;
  setSubInputState: (value: PluginSubInputState) => void;
  applySubInputMessage: typeof import("./pluginSubInputState").applyPluginSubInputMessage;
  notifySubInputChange: (value: unknown) => void;
  dynamicFeatures: () => Array<{ code: string; label: string; explain: string }>;
  setDynamicFeatures: (value: Array<{ code: string; label: string; explain: string }>) => void;
  registeredTools: () => string[];
  setRegisteredTools: (value: string[]) => void;
  dispatchDetach: () => void;
  requestedHeight: () => number;
  setRequestedHeight: (value: number) => void;
  pluginItems: () => PluginItem[];
  setPluginItems: (value: PluginItem[]) => void;
  normalizeOutputItems: (value: unknown) => PluginItem[];
  selectedIndex: () => number;
  setSelectedIndex: (value: number) => void;
  activePage: () => ReturnType<typeof createPluginPanelDocumentHost> | undefined;
  isDocumentIdentity: (identity: PluginFrameIdentity) => identity is PluginDocumentIdentity;
  clearPermissionRequests: () => void;
  invalidateBrowserWindows: () => void;
  onOutput?: (output: PluginOutput) => void;
  emptyFeatureList: (epoch?: number) => PluginFeatureListState;
  workerBlocking: () => boolean;
  closingActionIsCurrent: () => boolean;
  receiveMainPush: (event: MessageEvent, identity: PluginFrameIdentity) => boolean;
  mainPushMode: () => "query" | "select" | "visible";
  activeClipboard: () => ReturnType<typeof createHostClipboardController> | undefined;
  activeDisplay: () => ReturnType<typeof createPluginDisplayController> | undefined;
  activeData: () => ReturnType<typeof createPluginDataController> | undefined;
  activeDialogs: () => ReturnType<typeof createPluginDialogsController> | undefined;
  activePaths: () => ReturnType<typeof createPluginPathsController> | undefined;
  listenClipboardEvents?: (event: string, receive: (event: { payload: unknown }) => void) => Promise<() => void>;
};

/** Composes the panel's native bridge, authenticated frame handler and ordered ingress router. */
export function createPluginPanelMessageHost(ports: Ports) {
  const contextMenu = createPluginContextMenuController(ports.sources);
  const clipboardChanges = createPluginClipboardChangeHub({
    sources: ports.sources, hostedIpc: ports.hostedIpc, controller: ports.activeClipboard,
    pluginId: () => ports.action().plugin_id, listen: ports.listenClipboardEvents,
  });
  const broadcastChannels = createPluginBroadcastChannelHost({
    sources: ports.sources, pluginId: () => ports.action().plugin_id,
    post: (source, message, identity) => postPluginFrameMessageIfCurrent({ source, identity, sources: ports.sources, message }),
    captureDocumentLease: (sender, nonce) => ports.hostedIpc.captureDocumentLease(sender, nonce),
  });
  const nativeBridge = createPluginNativeBridgeRouter({
    invoke: ports.invoke, sources: ports.sources, hostedIpc: ports.hostedIpc,
    getBrowserWindows: ports.browserWindows, creatorFor: ports.creatorFor,
    ensurePermission: ports.ensurePermission, onclose: ports.onclose,
    onredirect: ports.onredirect, onsettingsredirect: ports.onsettingsredirect,
    writePluginImage: ports.writePluginImage, pathFromBridgeValue: ports.pathFromBridgeValue,
    pathsFromBridgeValue: ports.pathsFromBridgeValue, runAppleScript: ports.runAppleScript,
    appleScriptString: ports.appleScriptString, normalizeCopiedFileEntries: ports.normalizeCopiedFileEntries,
    runCommand: ports.runCommand, writeText: ports.writeText, hidePanelForPaste: ports.hidePanelForPaste,
    pluginFileClipboardAppleScript: ports.pluginFileClipboardAppleScript, pickScreenColorWithEyeDropper: ports.pickScreenColorWithEyeDropper,
    dispatchPluginBrowserWindowParentMessage: ports.dispatchParentMessage,
    handlePluginBrowserWindowAction: ports.browserWindowAction, createPluginBrowserWindow: ports.createBrowserWindow,
    shouldUseNativeBrowserWindow: ports.shouldUseNativeBrowserWindow,
    shellOpen: ports.shellOpen,
    showContextMenu: (items, source, identity, onselect) => contextMenu.open(items, source, identity, onselect),
  });
  const panelHandlers = createPluginPanelMessageHandlers({
    action: ports.action, iframeSrc: ports.iframeSrc, previewPayload: ports.previewPayload, webPreviewPluginPath: ports.webPreviewPluginPath,
    iframeWindow: ports.iframeWindow, pluginResourceUrl: ports.pluginResourceUrl,
    post: ports.post, invoke: ports.invoke, closePanel: ports.closePanel,
    setUiHostProbeResult: ports.setUiHostProbeResult,
  });
  const authenticated = createAuthenticatedPluginMessageHandler({
    action: ports.action, sources: ports.sources, invoke: ports.invoke,
    handlePermissionRequest: ports.handlePermissionRequest,
    handleResourceResolve: panelHandlers.handleRuntimeResourceResolveCall,
    handleNativeCall: nativeBridge.handleNativeBridgeCall,
    dispatchInvoke: dispatchPluginInvokeMessage, postIfCurrent: postPluginFrameMessageIfCurrent,
    isBridgeRequestId: isPluginBridgeRequestId, ensurePermission: ports.ensurePermission,
    pathsActive: () => Boolean(ports.activePaths()), dataActive: () => Boolean(ports.activeData()),
    handleDesktopSmokeProbe: ports.handleDesktopSmokeProbe,
    handleUiProbeResult: panelHandlers.handleUiHostProbeResult,
    handleRealEntryProbeResult: panelHandlers.handleRealEntryFixtureProbeResult,
    handleContextMenu: ports.handleContextMenu, requestEscape: ports.requestEscape,
    handleMainWindowLifecycle: panelHandlers.handleMainWindowLifecycle,
    runFind: panelHandlers.runPluginFindInPage, stopFind: panelHandlers.stopPluginFindInPage,
    closePanel: ports.closePanel,
    get featureList() { return ports.featureList(); }, set featureList(value) { ports.setFeatureList(value); },
    setFeatureList: ports.setFeatureList,
    featureListMessage, featureListIntent: ports.featureListIntent,
    get subInputState() { return ports.subInputState(); }, set subInputState(value) { ports.setSubInputState(value); },
    setSubInputState: ports.setSubInputState,
    applySubInputMessage: ports.applySubInputMessage, notifySubInputChange: ports.notifySubInputChange,
    get dynamicFeatures() { return ports.dynamicFeatures(); }, setDynamicFeatures: ports.setDynamicFeatures,
    get registeredTools() { return ports.registeredTools(); }, setRegisteredTools: ports.setRegisteredTools,
    dispatchDetach: ports.dispatchDetach, get requestedHeight() { return ports.requestedHeight(); }, setRequestedHeight: ports.setRequestedHeight,
    get pluginItems() { return ports.pluginItems(); }, setPluginItems: ports.setPluginItems,
    normalizeOutputItems: ports.normalizeOutputItems, get selectedIndex() { return ports.selectedIndex(); }, setSelectedIndex: ports.setSelectedIndex,
    activePage: ports.activePage, isDocumentIdentity: ports.isDocumentIdentity,
    clearPermissionRequests: ports.clearPermissionRequests, invalidateBrowserWindows: ports.invalidateBrowserWindows,
    hostedIpc: ports.hostedIpc, onOutput: ports.onOutput, emptyFeatureList: ports.emptyFeatureList,
  });
  const router = createPluginPanelMessageRouter({
    isBlocked: () => ports.workerBlocking() || ports.closingActionIsCurrent(),
    handlePageMessage: event => ports.activePage()?.handleMessage(event) ?? false,
    identify: event => identifyPluginMessageEvent(ports.sources, event),
    receiveMainPush: ports.receiveMainPush,
    presentationDenied: data => pluginMainPushPresentationDenied(ports.mainPushMode(), data),
    rejectPresentationDenied: (event, data) => {
      if (data.__atools_native_call__ === true || data.__ipc_call__ === true) ports.post(event.source as Window, {
        __atools_native_response__: data.__atools_native_call__ === true, __ipc_response__: data.__ipc_call__ === true,
        reqId: data.reqId, error: "ERR_MAIN_PUSH_QUERY_PRESENTATION_DENIED",
      }, ports.sources.currentIdentityForHost(event.source) ?? undefined);
    },
    isActiveChild: id => ports.browserWindows().some(child => child.id === id),
    unregisterChild: (id, source) => ports.sources.unregisterChild(id, source),
    bindLifecycle: (event, identity, data) => {
      try {
        ports.hostedIpc.bind(identity, event.source, identity, identity.kind === "main");
        let confirmedClose = false;
        if (data.phase === "close") {
          try {
            ports.hostedIpc.captureDocumentLease({ source: event.source, identity }, data.documentNonce).assertCurrent();
            confirmedClose = true;
          } catch { /* A stale close must not clear the current document's channels. */ }
        }
        const handled = ports.hostedIpc.handleLifecycle({ source: event.source, identity }, data);
        if (handled && (data.phase !== "close" || confirmedClose)) {
          clipboardChanges.invalidateSource(event.source);
          if (data.phase === "close") broadcastChannels.invalidateSource(event.source);
          else if (data.phase === "open") broadcastChannels.prune();
        }
        return handled;
      } catch { return true; }
    },
    dispatchPermissions: (event, data, identity) =>
      clipboardChanges.dispatch(event.source, identity, data)
      || dispatchHostClipboardPermission({ controller: ports.activeClipboard(), message: data, source: event.source, identity, sources: ports.sources })
      || dispatchPluginDisplayPermission({ controller: ports.activeDisplay(), message: data, source: event.source, identity, sources: ports.sources })
      || dispatchPluginDataPermission({ controller: ports.activeData(), message: data, source: event.source, identity, sources: ports.sources })
      || dispatchPluginDialogsPermission({ controller: ports.activeDialogs(), message: data, source: event.source, identity, sources: ports.sources })
      || dispatchPluginPathsPermission({ controller: ports.activePaths(), message: data, source: event.source, identity, sources: ports.sources }),
    dispatchAuthenticated: (event, data, identity) => {
      if (!broadcastChannels.dispatch(event.source, identity, data, event.origin)) authenticated(event, data, identity);
    },
  });
  const unregisterNativeMessages = registerPluginNativeBrowserWindowMessages(event => router.handle(event));
  return { nativeBridge, panelHandlers, authenticated, contextMenu, handleMessage: (event: MessageEvent) => router.handle(event),
    close() { unregisterNativeMessages(); contextMenu.close(); clipboardChanges.close(); broadcastChannels.close(); } };
}
