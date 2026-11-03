import type { PluginNativeBrowserWindowSnapshot, PluginNativeBrowserWindowState } from "./pluginNativeBrowserWindowTypes";
import { browserWindowCapabilityFlag, browserWindowFullScreenableFlag, browserWindowInitialUserAgent, browserWindowTitle, normalizePluginBrowserWindowBackgroundColor } from "./pluginBrowserWindowPresentation";

/** Maps the Rust snapshot directly into the shared API state without the legacy overlay geometry policy. */
export function createPluginNativeBrowserWindowState(options: {
  id: string; clientCreateId: string; url: string; title?: string; srcdoc: string; documentGeneration: number;
  preloadOptions: Record<string, unknown>; snapshot: PluginNativeBrowserWindowSnapshot;
  /** Retained for the caller contract; never exposed as native OS/WebContents identifiers. */
  windowSequence: number; webContentsId: number;
}): PluginNativeBrowserWindowState {
  const { id, clientCreateId, url, srcdoc, documentGeneration, preloadOptions, snapshot } = options;
  const history = [{ url, title: snapshot.title || browserWindowTitle(url, preloadOptions), srcdoc }];
  const visible = snapshot.visible;
  const focusable = typeof preloadOptions.focusable === "boolean" ? preloadOptions.focusable : true;
  const backgroundColor = normalizePluginBrowserWindowBackgroundColor(preloadOptions.backgroundColor, "#ffffff");
  const rawWebPreferences = preloadOptions.webPreferences;
  const webPreferences = rawWebPreferences && typeof rawWebPreferences === "object" && !Array.isArray(rawWebPreferences)
    ? rawWebPreferences as Record<string, unknown> : {};
  const backgroundThrottling = webPreferences.backgroundThrottling !== false;
  const fullScreenable = browserWindowFullScreenableFlag(preloadOptions);
  const hasShadow = preloadOptions.hasShadow !== false && preloadOptions.hasshadow !== false;
  const skipTaskbar = preloadOptions.skipTaskbar === true || preloadOptions.skiptaskbar === true;
  const visibleOnAllWorkspaces = preloadOptions.visibleOnAllWorkspaces === true || preloadOptions.visibleonallworkspaces === true;
  const constructorState = {
    backgroundColor,
    movable: browserWindowCapabilityFlag(preloadOptions, "movable"),
    closable: browserWindowCapabilityFlag(preloadOptions, "closable"),
    minimizable: browserWindowCapabilityFlag(preloadOptions, "minimizable"),
    maximizable: browserWindowCapabilityFlag(preloadOptions, "maximizable"),
    fullScreenable,
    hasShadow,
    skipTaskbar,
    visibleOnAllWorkspaces,
    focusable,
  };
  return {
    id, hostKind: "native", clientCreateId, url, title: history[0].title, srcdoc, documentGeneration, preloadOptions,
    nativeSnapshot: snapshot, history, historyIndex: 0, loading: false,
    visible, focused: snapshot.focused, x: snapshot.bounds.x, y: snapshot.bounds.y,
    width: snapshot.bounds.width, height: snapshot.bounds.height, positioned: true,
    alwaysOnTop: snapshot.alwaysOnTop, backgroundColor,
    menuBarAutoHide: false, menuBarVisible: false, menuRemoved: true, windowButtonVisible: false, windowButtonPosition: null,
    vibrancy: "", vibrancyOptions: {}, backgroundMaterial: "none", sheetOffsetY: 0, sheetOffsetX: 0,
    documentEdited: false, representedFilename: "", modal: false, parentWindowId: null,
    minimized: snapshot.minimized, maximized: snapshot.maximized, resizable: snapshot.resizable,
    movable: constructorState.movable, closable: constructorState.closable,
    minimizable: constructorState.minimizable, maximizable: constructorState.maximizable,
    minimumWidth: snapshot.minimumSize[0], minimumHeight: snapshot.minimumSize[1],
    maximumWidth: snapshot.maximumSize[0], maximumHeight: snapshot.maximumSize[1],
    aspectRatio: 0, aspectRatioExtraSize: { width: 0, height: 0 }, fullScreen: snapshot.fullScreen,
    fullScreenable, opacity: 1, hasShadow, skipTaskbar,
    kiosk: false, visibleOnAllWorkspaces, contentProtected: false, focusable, flashing: false,
    progressBar: null, progressBarMode: "none", mediaSourceId: "",
    webContentsMediaSourceId: "", webContentsFocused: snapshot.focused,
    webContentsBeingCaptured: false, ignoreMenuShortcuts: false, zOrder: options.windowSequence,
    devToolsOpened: false, devToolsFocused: false, devToolsMode: "", devToolsTitle: "", inspectedElement: null,
    zoomFactor: 1, zoomLevel: 0, visualZoomMinimumLevel: 0, visualZoomMaximumLevel: 0,
    audioMuted: false, currentlyAudible: false, userAgent: browserWindowInitialUserAgent(preloadOptions),
    frameRate: 60, backgroundThrottling, processId: 0, osProcessId: 0, crashed: false,
    nativeConstructorState: constructorState,
  };
}
