  import type { PluginNativeBrowserWindowSnapshotResult } from "./pluginNativeBrowserWindowTypes";

  export type PluginBrowserWindowType = "main" | "browserWindow";

  export type PluginBrowserWindowInspectedElement = {
    x: number;
    y: number;
    tagName: string;
    id: string;
    className: string;
    text: string;
  };

  export type PluginBrowserWindowState = {
    id: string;
    hostKind?: "overlay" | "native";
    nativeSnapshot?: PluginNativeBrowserWindowSnapshotResult;
    clientCreateId?: string;
    url: string;
    title: string;
    srcdoc: string;
    documentGeneration: number;
    preloadOptions: Record<string, unknown>;
    history: PluginBrowserWindowHistoryEntry[];
    historyIndex: number;
    loading: boolean;
    visible: boolean;
    focused: boolean;
    x: number;
    y: number;
    width: number;
    height: number;
    positioned: boolean;
    alwaysOnTop: boolean;
    backgroundColor: string;
    menuBarAutoHide: boolean;
    menuBarVisible: boolean;
    menuRemoved: boolean;
    windowButtonVisible: boolean;
    windowButtonPosition: PluginBrowserWindowPoint | null;
    vibrancy: string;
    vibrancyOptions: Record<string, unknown>;
    backgroundMaterial: string;
    sheetOffsetY: number;
    sheetOffsetX: number;
    documentEdited: boolean;
    representedFilename: string;
    modal: boolean;
    parentWindowId: string | null;
    minimized: boolean;
    maximized: boolean;
    resizable: boolean;
    movable: boolean;
    closable: boolean;
    minimizable: boolean;
    maximizable: boolean;
    fullScreen: boolean;
    fullScreenable: boolean;
    minimumWidth: number;
    minimumHeight: number;
    maximumWidth: number;
    maximumHeight: number;
    aspectRatio: number;
    aspectRatioExtraSize: PluginBrowserWindowSize;
    opacity: number;
    hasShadow: boolean;
    skipTaskbar: boolean;
    kiosk: boolean;
    visibleOnAllWorkspaces: boolean;
    contentProtected: boolean;
    focusable: boolean;
    flashing: boolean;
    progressBar: number | null;
    progressBarMode: string;
    mediaSourceId: string;
    webContentsMediaSourceId: string;
    webContentsFocused: boolean;
    webContentsBeingCaptured: boolean;
    ignoreMenuShortcuts: boolean;
    zOrder: number;
    devToolsOpened: boolean;
    devToolsFocused: boolean;
    devToolsMode: string;
    devToolsTitle: string;
    inspectedElement: PluginBrowserWindowInspectedElement | null;
    zoomFactor: number;
    zoomLevel: number;
    visualZoomMinimumLevel: number;
    visualZoomMaximumLevel: number;
    audioMuted: boolean;
    currentlyAudible: boolean;
    userAgent: string;
    frameRate: number;
    backgroundThrottling: boolean;
    processId: number;
    osProcessId: number;
    crashed: boolean;
  };

  export type PluginBrowserWindowBounds = {
    x: number;
    y: number;
    width: number;
    height: number;
  };

  export type PluginBrowserWindowSize = {
    width: number;
    height: number;
  };

  export type PluginBrowserWindowPoint = {
    x: number;
    y: number;
  };

  export type PluginBrowserWindowHistoryEntry = {
    url: string;
    title: string;
    srcdoc: string;
  };

  export type PluginBrowserWindowParentMessage = {
    windowId: string;
    channel: string;
    args: unknown[];
  };

  export type PluginBrowserWindowInsertedCss = {
    windowId: string;
    key: string;
    css: string;
    cssOrigin: "author" | "user";
  };

