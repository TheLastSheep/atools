import type { PluginBrowserWindowState, PluginBrowserWindowParentMessage, PluginBrowserWindowInsertedCss } from "./pluginBrowserWindowTypes";
import type { FeatureAction } from "./types";
import type { PluginRuntimePreloadOptions } from "./pluginRuntimePreload";
import type { HostedBrowserWindowNavigationTokens, HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import { createPluginBrowserWindowCreateController } from "./pluginBrowserWindowCreateController";
import { pluginResourceFilePath, preparePluginHtmlResources } from "./pluginResourceHtml";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { preparePluginBrowserWindowPreload } from "./pluginBrowserWindowPreload";
import { previewBrowserWindowHtml } from "./pluginPanelPreview";
import { createPluginBrowserWindowWebContentsController } from "./pluginBrowserWindowWebContentsController";
import { createPluginBrowserWindowFrameCommands } from "./pluginBrowserWindowFrameCommands";
import { createPluginBrowserWindowNavigationLoader } from "./pluginBrowserWindowNavigationLoader";
import { createPluginBrowserWindowActionDispatcher } from "./pluginBrowserWindowActionDispatcher";
import type { createPluginBrowserWindowGeometryHost } from "./pluginBrowserWindowGeometryHost";
import type { createPluginHostedIpcRouter, PluginHostedDocumentLease } from "./pluginHostedIpcRouter";
import type { PluginFrameReplyTarget } from "./pluginFrameDocumentIdentity";
import { createPluginNativeBrowserWindowController } from "./pluginNativeBrowserWindowController";
import { isTauri } from "@tauri-apps/api/core";
import type { PluginBrowserWindowHostKind } from "./pluginPanelBridgeCompiler";

export type PluginPanelBrowserWindowRuntimePorts = {
  windows: PluginBrowserWindowState[];
  lastMessage: PluginBrowserWindowParentMessage | null;
  navigation: HostedBrowserWindowNavigationTokens;
  rpc: HostedBrowserWindowRpcHost;
  frames: Map<string, HTMLIFrameElement>;
  geometry: ReturnType<typeof createPluginBrowserWindowGeometryHost>;
  hostedIpc: ReturnType<typeof createPluginHostedIpcRouter>;
  sources: PluginFrameSourceRegistry;
  insertedCss: Map<string, PluginBrowserWindowInsertedCss>;
  cssSequence: number;
  findSequence: number;
  creators: Map<string, PluginBrowserWindowCreator>;
  mainFrame: () => HTMLIFrameElement | null;
  post: (source: unknown, message: unknown, identity?: import("./pluginInvokePolicy").PluginFrameIdentity) => boolean;
  hostGeneration: number;
  nextZOrder: () => number;
  clearInsertedCss: (id: string) => void;
  readyFrame: (id: string, label: string) => Promise<HTMLIFrameElement>;
  injectBridge: (html: string, type: "main" | "browserWindow", id: string, preload: string, geometry: unknown,
    windowHostKind?: PluginBrowserWindowHostKind, entryMode?: "activate" | "preload", nativeBackgroundThrottling?: boolean) => string;
  mountNativeFrame: (node: HTMLIFrameElement, id: string, replyTarget: PluginFrameReplyTarget) => { destroy?: () => void; update?: (id: string) => void };
  tick: () => Promise<unknown>;
  updateUserAgent: (id: string, value: unknown) => unknown;
  updateFrameRate: (id: string, value: unknown) => unknown;
  updateBackgroundThrottling: (id: string, value: unknown) => unknown;
  action: () => FeatureAction;
  invoke: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
  previewPluginPath: string;
  previewPayload: () => Record<string, unknown>;
  hasPluginPage: () => boolean;
  resources: () => { prepare?: () => Promise<{ sessionId: string; pluginRoot: string; instanceId: string }>; resolveModuleSrc: (path: string) => string | Promise<string> } | undefined;
  activePluginRuntime: () => { prepareAdditional: (options: PluginRuntimePreloadOptions) => Promise<string> } | undefined;
  creatingCount: number;
  windowSequence: number;
};

/** Connects the browser-window capability's domain controllers to one panel-owned state. */
export function createPluginPanelBrowserWindowRuntime(ports: PluginPanelBrowserWindowRuntimePorts) {
  async function runNavigation<T>(windowId: string, navigationToken: number, operation: () => Promise<T>): Promise<T> {
    ports.navigation.assertCurrent(windowId, navigationToken);
    try {
      const result = await operation();
      ports.navigation.assertCurrent(windowId, navigationToken);
      return result;
    } catch (error) {
      ports.navigation.assertCurrent(windowId, navigationToken);
      throw error;
    }
  }
  async function pageTitle(windowId: string, fallback: string) {
    const description = await ports.rpc.call(windowId, "describe", {});
    const title = description && typeof description === "object"
      ? String((description as Record<string, unknown>).title ?? "").trim()
      : "";
    return title || fallback;
  }
  async function loadHtml(url: string): Promise<string> {
    const action = ports.action();
    if (!action.plugin_path || action.plugin_path === ports.previewPluginPath) {
      return previewBrowserWindowHtml(url, ports.previewPayload());
    }
    const mainFile = action.main_url || "index.html";
    const resources = ports.resources();
    const path = pluginResourceFilePath(action.plugin_path, mainFile, url);
    if (!path) throw new Error(`createBrowserWindow requires a local plugin HTML file: ${url}`);
    let html = await readTextFile(path);
    html = await preparePluginHtmlResources(html, {
      pluginDir: action.plugin_path,
      mainFile: path,
      resourceResolution: "legacy",
      readTextFile,
      convertFileSrc,
      resolveModuleSrc: resources?.resolveModuleSrc,
      warn: (message, error) => console.warn(`[PluginPanel] ${message}`, error),
    });
    return html;
  }
  function preparePreload(options: Record<string, unknown>, isCurrent: () => boolean) {
    const action = ports.action();
    const runtime = ports.activePluginRuntime();
    return preparePluginBrowserWindowPreload({
      pluginDir: action.plugin_path,
      options,
      prepare: runtime?.prepareAdditional ?? (() => Promise.reject(new Error("BrowserWindow preload runtime is unavailable"))),
      readTextFile: modulePath => invoke<string>("read_plugin_preload_module", { pluginId: action.plugin_id, modulePath }),
      isCurrent,
    });
  }
  const webContents = createPluginBrowserWindowWebContentsController({
    get windows() { return ports.windows; }, set windows(value) { ports.windows = value; },
    get lastMessage() { return ports.lastMessage; }, set lastMessage(value) { ports.lastMessage = value; },
    navigation: ports.navigation, rpc: ports.rpc, frames: ports.frames, geometry: ports.geometry,
    hostedIpc: ports.hostedIpc, sources: ports.sources, insertedCss: ports.insertedCss,
    clearInsertedCss: ports.clearInsertedCss, runNavigation, pageTitle, tick: ports.tick,
  });
  const frameCommands = createPluginBrowserWindowFrameCommands({
    get windows() { return ports.windows; },
    get lastMessage() { return ports.lastMessage; }, set lastMessage(value) { ports.lastMessage = value; },
    frames: ports.frames, rpc: ports.rpc, insertedCss: ports.insertedCss,
    get cssSequence() { return ports.cssSequence; }, set cssSequence(value) { ports.cssSequence = value; },
    get findSequence() { return ports.findSequence; }, set findSequence(value) { ports.findSequence = value; },
    post: ports.post, readyFrame: webContents.readyPluginBrowserWindowFrame,
    dispatchWebContentsEvent: webContents.dispatchPluginBrowserWindowWebContentsEvent,
  });
  const navigationLoader = createPluginBrowserWindowNavigationLoader({
    get windows() { return ports.windows; }, set windows(value) { ports.windows = value; },
    get lastMessage() { return ports.lastMessage; }, set lastMessage(value) { ports.lastMessage = value; },
    navigation: ports.navigation, hostedIpc: ports.hostedIpc, sources: ports.sources,
    geometry: ports.geometry, rpc: ports.rpc, creators: ports.creators, insertedCss: ports.insertedCss,
    clearInsertedCss: frameCommands.clearPluginBrowserWindowInsertedCss,
    navigationResult: webContents.pluginBrowserWindowNavigationResult,
    runNavigation, pageTitle, readyFrame: webContents.readyPluginBrowserWindowFrame,
    loadHtml, preparePreload, injectBridge: ports.injectBridge,
    tick: ports.tick, get hostGeneration() { return ports.hostGeneration; },
  });
  const actionDispatcher = createPluginBrowserWindowActionDispatcher({
    get windows() { return ports.windows; }, set windows(value) { ports.windows = value; },
    get lastMessage() { return ports.lastMessage; }, set lastMessage(value) { ports.lastMessage = value; },
    mainFrame: ports.mainFrame, post: ports.post, geometry: ports.geometry, navigation: ports.navigation,
    rpc: ports.rpc, hostedIpc: ports.hostedIpc, sources: ports.sources, frames: ports.frames,
    creators: ports.creators, clearInsertedCss: ports.clearInsertedCss,
    webContents, frameCommands, nextZOrder: ports.nextZOrder,
    loadUrl: navigationLoader.loadPluginBrowserWindowUrl,
    navigateHistory: webContents.navigatePluginBrowserWindowHistory,
    navigateHistoryToIndex: webContents.navigatePluginBrowserWindowHistoryToIndex,
    clearHistory: webContents.clearPluginBrowserWindowNavigationHistory, updateUserAgent: ports.updateUserAgent,
    updateFrameRate: ports.updateFrameRate, updateBackgroundThrottling: ports.updateBackgroundThrottling,
  });
  const createController = createPluginBrowserWindowCreateController({
    hasPluginPage: () => ports.hasPluginPage(),
    get windows() { return ports.windows; }, set windows(value) { ports.windows = value; },
    get creatingCount() { return ports.creatingCount; }, set creatingCount(value) { ports.creatingCount = value; },
    get hostGeneration() { return ports.hostGeneration; }, set hostGeneration(value) { ports.hostGeneration = value; },
    get windowSequence() { return ports.windowSequence; }, set windowSequence(value) { ports.windowSequence = value; },
    navigation: ports.navigation, sources: ports.sources, hostedIpc: ports.hostedIpc,
    geometry: ports.geometry, creators: ports.creators, loadHtml, preparePreload,
    injectBridge: ports.injectBridge, runNavigation,
  });
  const nativeController = createPluginNativeBrowserWindowController({
    pluginId: () => ports.action().plugin_id,
    pluginPath: () => ports.action().plugin_path,
    previewPluginPath: ports.previewPluginPath,
    mainUrl: () => ports.action().main_url || "index.html",
    resources: ports.resources,
    runtime: ports.activePluginRuntime,
    preparePreload,
    injectBridge: ports.injectBridge,
    mountFrame: ports.mountNativeFrame,
    invoke: ports.invoke,
    get windows() { return ports.windows; }, setWindows(value) { ports.windows = value; },
    get windowSequence() { return ports.windowSequence; }, setWindowSequence(value) { ports.windowSequence = value; },
    get creatingCount() { return ports.creatingCount; }, setCreatingCount(value) { ports.creatingCount = value; },
    get hostGeneration() { return ports.hostGeneration; },
    sources: ports.sources, hostedIpc: ports.hostedIpc, navigation: ports.navigation, rpc: ports.rpc,
    frames: ports.frames, geometry: ports.geometry, creators: ports.creators, insertedCss: ports.insertedCss,
    clearInsertedCss: ports.clearInsertedCss,
    dispatchWindowEvent: (id, name, args) => webContents.dispatchPluginBrowserWindowEvent(id, name, args),
    pageTitle,
    tick: ports.tick,
    isTauri,
  });
  function handlePluginBrowserWindowAction(args: Record<string, unknown>, creator?: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) {
    if (nativeController.handlesAction(args)) return nativeController.action(args, creator, lease);
    return actionDispatcher.handlePluginBrowserWindowAction(args);
  }
  function createPluginBrowserWindow(args: Record<string, unknown>, creator: PluginBrowserWindowCreator, lease?: PluginHostedDocumentLease) {
    return nativeController.nativeEnabled()
      ? lease ? nativeController.create(args, creator, lease) : Promise.reject(new Error("ERR_ATOOLS_NATIVE_BROWSER_WINDOW_DOCUMENT_LEASE_REQUIRED"))
      : createController.createPluginBrowserWindow(args, creator);
  }
  function shouldUseNativeBrowserWindow(method: string, args: Record<string, unknown>, identity: import("./pluginInvokePolicy").PluginFrameIdentity) {
    return method === "createBrowserWindow" ? nativeController.nativeEnabled()
      : method === "browserWindowAction" && nativeController.handlesAction(
        identity.kind === "child" && !(typeof args.id === "string" && args.id.trim()) ? { ...args, id: identity.windowId } : args,
      );
  }
  function clearRuntime(terminateNative: boolean) {
    ports.hostedIpc.clearChildren();
    ports.hostGeneration += 1;
    ports.navigation.closeAll();
    ports.rpc.closeAll();
    for (const childWindow of [...ports.windows]) {
      if (childWindow.hostKind === "native") continue;
      try { actionDispatcher.handlePluginBrowserWindowAction({ id: childWindow.id, action: "close", args: [] }); }
      catch (error) { console.warn("[PluginPanel] BrowserWindow cleanup failed:", error); }
    }
    const nativeCleanup = terminateNative ? nativeController.destroy() : nativeController.invalidate();
    ports.windows = [];
    ports.creators.clear();
    ports.geometry.clear();
    ports.frames.clear();
    ports.insertedCss.clear();
    return terminateNative ? nativeCleanup : undefined;
  }
  const invalidate = () => { clearRuntime(false); };
  const destroy = () => clearRuntime(true);
  function closeWindow(id: string) {
    if (ports.windows.some(window => window.id === id && window.hostKind === "native")) {
      nativeController.close(id);
      return;
    }
    try {
      actionDispatcher.handlePluginBrowserWindowAction({ id, action: "close" });
    } catch (error) {
      console.warn("[PluginPanel] browser window close failed:", error);
    }
  }
  function closePluginBrowserWindowAction(id: string) {
    if (ports.windows.some(window => window.id === id && window.hostKind === "native")) return nativeController.close(id);
    return actionDispatcher.closePluginBrowserWindowAction(id);
  }
  return {
    webContents, frameCommands, navigationLoader, actionDispatcher,
    loadPluginBrowserWindowUrl: navigationLoader.loadPluginBrowserWindowUrl,
    pluginBrowserWindowHistoryForLoad: navigationLoader.pluginBrowserWindowHistoryForLoad,
    dispatchPluginBrowserWindowParentMessage: actionDispatcher.dispatchPluginBrowserWindowParentMessage,
    closePluginBrowserWindowAction,
    handlePluginBrowserWindowAction,
    applyPluginBrowserWindowAction: actionDispatcher.applyPluginBrowserWindowAction,
    createPluginBrowserWindow,
    shouldUseNativeBrowserWindow,
    invalidatePluginBrowserWindows: invalidate,
    destroyPluginBrowserWindows: destroy,
    closePluginBrowserWindow: closeWindow,
  };
}
