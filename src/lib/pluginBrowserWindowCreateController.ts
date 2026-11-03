import type { PluginBrowserWindowState, PluginBrowserWindowType } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";
import type { PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import { runPluginFrameOperation } from "./pluginInvokePolicy";
import { isPluginBrowserWindowCreateCurrent } from "./pluginBrowserWindowReady";
type PluginHostedIpcRouter = ReturnType<typeof import("./pluginHostedIpcRouter").createPluginHostedIpcRouter>;
import type { HostedBrowserWindowNavigationTokens } from "./hostedBrowserWindowRpc";
type PluginBrowserWindowGeometryHost = ReturnType<typeof import("./pluginBrowserWindowGeometryHost").createPluginBrowserWindowGeometryHost>;
import {
  browserWindowOptions, browserWindowCapabilityFlag, browserWindowFullScreenFlag, browserWindowFullScreenableFlag,
  browserWindowInitialUserAgent, browserWindowOSProcessId,
  browserWindowProcessId, browserWindowTitle, browserWindowOpacity,
  normalizePluginBrowserWindowBackgroundColor, normalizePluginBrowserWindowPoint,
  initialPluginBrowserWindowBounds, initialPluginBrowserWindowSizeConstraints,
  pluginBrowserWindowNullableString, pluginBrowserWindowPlainOptions,
  pluginBrowserWindowNumber,
} from "./pluginBrowserWindowPresentation";

export type PluginBrowserWindowCreatePorts = {
  hasPluginPage: () => boolean;
  windows: PluginBrowserWindowState[];
  creatingCount: number;
  hostGeneration: number;
  windowSequence: number;
  navigation: HostedBrowserWindowNavigationTokens;
  sources: PluginFrameSourceRegistry;
  hostedIpc: PluginHostedIpcRouter;
  geometry: PluginBrowserWindowGeometryHost;
  creators: Map<string, PluginBrowserWindowCreator>;
  loadHtml: (url: string) => Promise<string>;
  preparePreload: (options: Record<string, unknown>, isCurrent: () => boolean) => Promise<string>;
  injectBridge: (html: string, type: PluginBrowserWindowType, id: string, preload: string, geometry: unknown) => string;
  runNavigation: <T>(id: string, token: number, operation: () => Promise<T>) => Promise<T>;
};

export function createPluginBrowserWindowCreateController(ports: PluginBrowserWindowCreatePorts) {
  async function createPluginBrowserWindow(args: Record<string, unknown>, creator: PluginBrowserWindowCreator) {
    if (ports.hasPluginPage()) throw new Error("当前文档模式尚未支持插件子窗口");
    const url = typeof args.url === "string" ? args.url.trim() : "";
    if (!url) throw new Error("createBrowserWindow requires a non-empty url");
    const options = browserWindowOptions(args.options);
    if (ports.windows.length + ports.creatingCount >= 32) {
      throw new Error("ERR_ATOOLS_BROWSER_WINDOW_HOST_LIMIT: 32 active or creating windows per plugin panel");
    }
    ports.creatingCount += 1;
    const hostGeneration = ports.hostGeneration;
    const clientCreateId = typeof args.clientCreateId === "string" && /^atools-browser-window-create-[a-z0-9-]{1,80}$/i.test(args.clientCreateId)
      ? args.clientCreateId
      : `atools-browser-window-create-host-${ports.windowSequence + 1}`;
    try {
      return await createPluginBrowserWindowAdmitted(url, options, clientCreateId, creator, hostGeneration);
    } finally {
      ports.creatingCount = Math.max(0, ports.creatingCount - 1);
    }
  }

  async function createPluginBrowserWindowAdmitted(
    url: string,
    options: Record<string, unknown>,
    clientCreateId: string,
    creator: PluginBrowserWindowCreator,
    hostGeneration: number,
  ) {
    const windowSeq = ++ports.windowSequence;
    const id = `plugin-browser-window-${windowSeq}`;
    const navigationToken = ports.navigation.begin(id);
    const mediaSourceId = `window:${windowSeq}:0`;
    const webContentsMediaSourceId = `web-contents:${windowSeq}:0`;
    const title = browserWindowTitle(url, options);
    const html = await runPluginFrameOperation({
      source: creator.source,
      identity: creator.identity,
      sources: ports.sources,
      operation: () => ports.runNavigation(
        id,
        navigationToken,
        () => ports.loadHtml(url),
      ),
    });
    if (!isPluginBrowserWindowCreateCurrent({
      capturedGeneration: hostGeneration,
      currentGeneration: ports.hostGeneration,
      creator,
      sources: ports.sources,
    })) throw new Error("BrowserWindow creator frame changed before child creation");
    const preloadScript = await ports.preparePreload(options, () => ports.navigation.isCurrent(id, navigationToken)
      && isPluginBrowserWindowCreateCurrent({ capturedGeneration: hostGeneration, currentGeneration: ports.hostGeneration, creator, sources: ports.sources }));
    const webContentsId = ports.hostedIpc.reserve({ kind: "child", windowId: id });
    const visible = options.show !== false;
    const sizeConstraints = initialPluginBrowserWindowSizeConstraints(options);
    const bounds = initialPluginBrowserWindowBounds(options, sizeConstraints);
    ports.creators.set(id, creator);
    const geometrySnapshot = ports.geometry.snapshot({ id, clientCreateId, documentGeneration: navigationToken, ...bounds, ...sizeConstraints });
    if (!geometrySnapshot) { ports.creators.delete(id); throw new Error("BrowserWindow creator changed before geometry initialization"); }
    const srcdoc = ports.injectBridge(html, "browserWindow", id, preloadScript, geometrySnapshot);
    const history = [{ url, title, srcdoc }];
    const alwaysOnTop = options.alwaysOnTop === true;
    const backgroundColor = normalizePluginBrowserWindowBackgroundColor(options.backgroundColor ?? options.backgroundcolor);
    const menuBarAutoHide = options.autoHideMenuBar === true || options.autohidemenubar === true;
    const menuRemoved = options.menu === null;
    const menuBarVisible = !menuRemoved && options.menuBarVisible !== false && options.menubarvisible !== false;
    const windowButtonVisible = options.windowButtonVisible !== false && options.windowbuttonvisible !== false && options.windowButtonVisibility !== false && options.windowbuttonvisibility !== false;
    const windowButtonPosition = normalizePluginBrowserWindowPoint(options.windowButtonPosition ?? options.windowbuttonposition ?? options.trafficLightPosition ?? options.trafficlightposition);
    const vibrancy = pluginBrowserWindowNullableString(options.vibrancy);
    const vibrancyOptions = pluginBrowserWindowPlainOptions(options.vibrancyOptions ?? options.vibrancyoptions);
    const backgroundMaterial = pluginBrowserWindowNullableString(options.backgroundMaterial ?? options.backgroundmaterial) || "none";
    const sheetOffsetY = pluginBrowserWindowNumber(options.sheetOffsetY ?? options.sheetoffsety, 0);
    const sheetOffsetX = pluginBrowserWindowNumber(options.sheetOffsetX ?? options.sheetoffsetx, 0);
    const documentEdited = options.documentEdited === true || options.documentedited === true;
    const representedFilename = String(options.representedFilename ?? options.representedfilename ?? "");
    const modal = options.modal === true;
    const parentWindowId = typeof options.parentWindowId === "string" && options.parentWindowId.trim()
      ? options.parentWindowId.trim()
      : null;
    const resizable = browserWindowCapabilityFlag(options, "resizable");
    const movable = browserWindowCapabilityFlag(options, "movable");
    const closable = browserWindowCapabilityFlag(options, "closable");
    const minimizable = browserWindowCapabilityFlag(options, "minimizable");
    const maximizable = browserWindowCapabilityFlag(options, "maximizable");
    const fullScreenable = browserWindowFullScreenableFlag(options);
    const fullScreen = fullScreenable && browserWindowFullScreenFlag(options);
    const opacity = browserWindowOpacity(options.opacity);
    const hasShadow = options.hasShadow !== false && options.hasshadow !== false;
    const skipTaskbar = options.skipTaskbar === true || options.skiptaskbar === true;
    const kiosk = options.kiosk === true;
    const visibleOnAllWorkspaces = options.visibleOnAllWorkspaces === true || options.visibleonallworkspaces === true;
    const contentProtected = options.contentProtection === true || options.contentProtected === true || options.contentprotected === true;
    const focusable = options.focusable !== false;
    const userAgent = browserWindowInitialUserAgent(options);
    const frameRate = 60;
    const backgroundThrottling = true;
    const processId = browserWindowProcessId(windowSeq);
    const osProcessId = browserWindowOSProcessId(windowSeq);
    ports.creators.set(id, creator);
    ports.windows = [
      ...ports.windows.map((childWindow) => ({ ...childWindow, focused: false })),
      {
        id,
        clientCreateId,
        url,
        title,
        srcdoc,
        documentGeneration: navigationToken,
        preloadOptions: options,
        history,
        historyIndex: 0,
        loading: false,
        visible,
        focused: visible && focusable,
        alwaysOnTop,
        backgroundColor,
        menuBarAutoHide,
        menuBarVisible,
        menuRemoved,
        windowButtonVisible,
        windowButtonPosition,
        vibrancy,
        vibrancyOptions,
        backgroundMaterial,
        sheetOffsetY,
        sheetOffsetX,
        documentEdited,
        representedFilename,
        modal,
        parentWindowId,
        minimized: false,
        maximized: false,
        resizable,
        movable,
        closable,
        minimizable,
        maximizable,
        ...sizeConstraints,
        aspectRatio: 0,
        aspectRatioExtraSize: { width: 0, height: 0 },
        fullScreen,
        fullScreenable,
        opacity,
        hasShadow,
        skipTaskbar,
        kiosk,
        visibleOnAllWorkspaces,
        contentProtected,
        focusable,
        flashing: false,
        progressBar: null,
        progressBarMode: "none",
        mediaSourceId,
        webContentsMediaSourceId,
        webContentsFocused: visible && focusable,
        webContentsBeingCaptured: false,
        ignoreMenuShortcuts: false,
        zOrder: windowSeq,
        devToolsOpened: false,
        devToolsFocused: false,
        devToolsMode: "",
        devToolsTitle: "",
        inspectedElement: null,
        zoomFactor: 1,
        zoomLevel: 0,
        visualZoomMinimumLevel: 0,
        visualZoomMaximumLevel: 0,
        audioMuted: false,
        currentlyAudible: false,
        userAgent,
        frameRate,
        backgroundThrottling,
        processId,
        osProcessId,
        crashed: false,
        ...bounds,
      },
    ];
    return {
      id,
      webContentsId,
      clientCreateId,
      geometrySnapshot,
      type: "browserWindow",
      windowType: "browserWindow",
      url,
      title,
      userAgent,
      frameRate,
      backgroundThrottling,
      backgroundColor,
      menuBarAutoHide,
      menuBarVisible,
      menuRemoved,
      windowButtonVisible,
      windowButtonPosition,
      vibrancy,
      vibrancyOptions,
      backgroundMaterial,
      sheetOffsetY,
      sheetOffsetX,
      documentEdited,
      representedFilename,
      modal,
      parentWindowId,
      processId,
      osProcessId,
      webContentsMediaSourceId,
      focused: visible && focusable,
      webContentsFocused: visible && focusable,
      webContentsBeingCaptured: false,
      ignoreMenuShortcuts: false,
      crashed: false,
    };
  }


  return { createPluginBrowserWindow };
}
