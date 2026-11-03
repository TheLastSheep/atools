import type { PluginBrowserWindowState, PluginBrowserWindowInsertedCss } from "./pluginBrowserWindowTypes";
import type { PluginFrameSourceRegistry } from "./pluginInvokePolicy";
import type { HostedBrowserWindowNavigationTokens, HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";
import { HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS, hostedBrowserWindowUnsupported } from "./hostedBrowserWindowRpc";
import { pluginBridgeJson } from "./pluginDesktopSmokeBridgeSource";
import {
  normalizePluginBrowserWindowZoomFactor, normalizePluginBrowserWindowZoomLevel,
  pluginBrowserWindowZoomFactorFromLevel, pluginBrowserWindowZoomLevelFromFactor,
  pluginBrowserWindowZoomResult,
} from "./pluginBrowserWindowPresentation";

type PluginHostedIpcRouter = ReturnType<typeof import("./pluginHostedIpcRouter").createPluginHostedIpcRouter>;
type PluginBrowserWindowGeometryHost = ReturnType<typeof import("./pluginBrowserWindowGeometryHost").createPluginBrowserWindowGeometryHost>;

type Ports = {
  windows: PluginBrowserWindowState[];
  lastMessage: import("./pluginBrowserWindowTypes").PluginBrowserWindowParentMessage | null;
  navigation: HostedBrowserWindowNavigationTokens;
  rpc: HostedBrowserWindowRpcHost;
  frames: Map<string, HTMLIFrameElement>;
  geometry: PluginBrowserWindowGeometryHost;
  hostedIpc: PluginHostedIpcRouter;
  sources: PluginFrameSourceRegistry;
  insertedCss: Map<string, PluginBrowserWindowInsertedCss>;
  clearInsertedCss: (id: string) => void;
  runNavigation: <T>(id: string, token: number, operation: () => Promise<T>) => Promise<T>;
  pageTitle: (id: string, fallback: string) => Promise<string>;
  tick: () => Promise<unknown>;
};

function pluginBrowserWindowNavigationResult(childWindow: PluginBrowserWindowState, extra: Record<string, unknown> = {}) {
  return {
    url: childWindow.url, title: childWindow.title, historyIndex: childWindow.historyIndex,
    historyLength: childWindow.history.length, loading: childWindow.loading, crashed: childWindow.crashed, ...extra,
  };
}

export function createPluginBrowserWindowWebContentsController(ports: Ports) {
  function stopPluginBrowserWindowLoading(id: string) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.stop failed: browser window ${id} is not active`);
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, loading: false };
      return updatedWindow;
    });
    ports.lastMessage = { windowId: id, channel: "webContents:stop", args: [] };
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, loading: false });
  }

  function focusPluginBrowserWindowWebContents(id: string) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.focus failed: browser window ${id} is not active`);
    const focused = existing.focusable;
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return { ...childWindow, focused: false, webContentsFocused: false };
      updatedWindow = { ...childWindow, visible: true, focused, webContentsFocused: focused };
      return updatedWindow;
    });
    const result = {
      visible: true,
      focused,
      webContentsFocused: focused,
    };
    ports.lastMessage = { windowId: id, channel: "webContents:focus", args: [] };
    dispatchPluginBrowserWindowEvent(id, "focus", [{ visible: true, focused, closed: false }]);
    return updatedWindow ? { ...result, webContentsMediaSourceId: updatedWindow.webContentsMediaSourceId } : result;
  }

  function setPluginBrowserWindowIgnoreMenuShortcuts(id: string, value: unknown) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setIgnoreMenuShortcuts failed: browser window ${id} is not active`);
    const ignoreMenuShortcuts = value === true;
    ports.windows = ports.windows.map((childWindow) =>
      childWindow.id === id ? { ...childWindow, ignoreMenuShortcuts } : childWindow
    );
    ports.lastMessage = { windowId: id, channel: "webContents:setIgnoreMenuShortcuts", args: [ignoreMenuShortcuts] };
    return { ignoreMenuShortcuts };
  }

  function forcefullyCrashPluginBrowserWindowRenderer(id: string) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.forcefullyCrashRenderer failed: browser window ${id} is not active`);
    const details = { reason: "crashed", exitCode: 1 };
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, loading: false, crashed: true };
      return updatedWindow;
    });
    ports.lastMessage = { windowId: id, channel: "webContents:forcefullyCrashRenderer", args: [details] };
    dispatchPluginBrowserWindowWebContentsEvent(id, "render-process-gone", [details]);
    return {
      ...pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, loading: false, crashed: true }),
      reason: details.reason,
      exitCode: details.exitCode,
    };
  }

  async function navigatePluginBrowserWindowHistoryToIndex(
    existing: PluginBrowserWindowState,
    nextIndex: number,
    label: string
  ) {
    if (nextIndex < 0 || nextIndex >= existing.history.length) {
      throw new Error(`${label} failed: history index ${nextIndex} is unavailable`);
    }
    const navigationToken = ports.navigation.begin(existing.id);
    ports.hostedIpc.invalidate({ kind: "child", windowId: existing.id });
    ports.sources.unregisterChild(existing.id);
    const previousEntry = existing.history[nextIndex];
    const geometrySnapshot = ports.geometry.snapshot({ ...existing, documentGeneration: navigationToken });
    if (!geometrySnapshot) throw new Error("BrowserWindow owner changed before navigation geometry initialization");
    const entry = { ...previousEntry, srcdoc: previousEntry.srcdoc.replace(/var _atoolsBrowserWindowGeometry = [^\n]*;/, () => `var _atoolsBrowserWindowGeometry = ${pluginBridgeJson(geometrySnapshot)};`) };
    ports.clearInsertedCss(existing.id);
    ports.rpc.invalidate(existing.id, "reloaded");
    ports.windows = ports.windows.map((childWindow) =>
      childWindow.id === existing.id
        ? {
            ...childWindow,
            ...entry,
            documentGeneration: navigationToken,
            historyIndex: nextIndex,
            visible: true,
            loading: true,
            crashed: false,
          }
        : childWindow
    );
    ports.geometry.publish(ports.windows.find(candidate => candidate.id === existing.id)!);
    ports.lastMessage = { windowId: existing.id, channel: label.replace(/\./g, ":"), args: [entry.url] };
    await ports.runNavigation(existing.id, navigationToken, () => ports.tick());
    await ports.runNavigation(
      existing.id,
      navigationToken,
      () => readyPluginBrowserWindowFrame(existing.id, label),
    );
    const finalTitle = await ports.runNavigation(
      existing.id,
      navigationToken,
      () => ports.pageTitle(existing.id, entry.title),
    );
    ports.navigation.assertCurrent(existing.id, navigationToken);
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== existing.id) return childWindow;
      const history = [...childWindow.history];
      history[nextIndex] = { ...history[nextIndex], title: finalTitle };
      updatedWindow = { ...childWindow, title: finalTitle, history, loading: false, crashed: false };
      return updatedWindow;
    });
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, ...entry, historyIndex: nextIndex, loading: false });
  }

  async function navigatePluginBrowserWindowHistory(
    existing: PluginBrowserWindowState,
    direction: "back" | "forward"
  ) {
    const nextIndex = direction === "back" ? existing.historyIndex - 1 : existing.historyIndex + 1;
    return navigatePluginBrowserWindowHistoryToIndex(
      existing,
      nextIndex,
      `webContents.go${direction === "back" ? "Back" : "Forward"}`
    );
  }

  function pluginBrowserWindowHistoryIndex(value: unknown, label: string): number {
    const index = Number(value);
    if (!Number.isFinite(index)) throw new Error(`${label} requires a finite history index`);
    return Math.trunc(index);
  }

  function pluginBrowserWindowHistoryOffset(value: unknown, label: string): number {
    const offset = Number(value);
    if (!Number.isFinite(offset)) throw new Error(`${label} requires a finite history offset`);
    return Math.trunc(offset);
  }

  function clearPluginBrowserWindowNavigationHistory(id: string) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.navigationHistory.clear failed: browser window ${id} is not active`);
    const currentEntry = existing.history[existing.historyIndex] || {
      url: existing.url,
      title: existing.title,
      srcdoc: existing.srcdoc,
    };
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = {
        ...childWindow,
        ...currentEntry,
        history: [currentEntry],
        historyIndex: 0,
        loading: false,
        crashed: false,
      };
      return updatedWindow;
    });
    ports.lastMessage = { windowId: id, channel: "webContents:navigationHistory:clear", args: [currentEntry.url] };
    return pluginBrowserWindowNavigationResult(updatedWindow || { ...existing, ...currentEntry, history: [currentEntry], historyIndex: 0, loading: false });
  }

  function pluginBrowserWindowDevToolsResult(childWindow: PluginBrowserWindowState) {
    return {
      devToolsOpened: childWindow.devToolsOpened,
      devToolsFocused: childWindow.devToolsOpened && childWindow.devToolsFocused,
      devToolsMode: childWindow.devToolsMode,
      devToolsTitle: childWindow.devToolsTitle,
    };
  }

  function normalizePluginBrowserWindowDevToolsMode(value: unknown, fallback = "") {
    const mode = typeof value === "string" ? value.trim() : "";
    return ["left", "right", "bottom", "undocked", "detach"].includes(mode) ? mode : fallback;
  }

  function updatePluginBrowserWindowDevTools(id: string, opened: boolean, options: Record<string, unknown> = {}) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents DevTools failed: browser window ${id} is not active`);
    const devToolsMode = opened
      ? normalizePluginBrowserWindowDevToolsMode(options.mode, existing.devToolsMode)
      : existing.devToolsMode;
    const devToolsTitle = opened && typeof options.title === "string"
      ? options.title
      : existing.devToolsTitle;
    const devToolsFocused = opened ? options.activate !== false : false;
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = {
        ...childWindow,
        devToolsOpened: opened,
        devToolsFocused,
        devToolsMode,
        devToolsTitle,
      };
      return updatedWindow;
    });
    const result = pluginBrowserWindowDevToolsResult(updatedWindow || {
      ...existing,
      devToolsOpened: opened,
      devToolsFocused,
      devToolsMode,
      devToolsTitle,
    });
    ports.lastMessage = {
      windowId: id,
      channel: opened ? "webContents:openDevTools" : "webContents:closeDevTools",
      args: [result],
    };
    dispatchPluginBrowserWindowWebContentsEvent(id, opened ? "devtools-opened" : "devtools-closed", [result]);
    return result;
  }

  async function inspectPluginBrowserWindowElement(id: string, args: unknown[]) {
    void args;
    if (!ports.windows.some((childWindow) => childWindow.id === id)) {
      throw new Error(`webContents.inspectElement failed: browser window ${id} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.inspectElement");
  }

  async function capturePluginBrowserWindowPage(windowId: string, args: unknown[]) {
    void args;
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.capturePage failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.capturePage");
  }

  function printPluginBrowserWindowPage(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.print failed: browser window ${windowId} is not active`);
    }
    const options = args[0] && typeof args[0] === "object" && !Array.isArray(args[0])
      ? args[0] as Record<string, unknown>
      : {};
    const result = {
      success: false,
      failureReason: "webContents.print is native-only in hosted BrowserWindow",
      options,
    };
    ports.lastMessage = { windowId, channel: "webContents:print", args: [result] };
    return result;
  }

  async function printPluginBrowserWindowToPdf(windowId: string, args: unknown[]) {
    void args;
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.printToPDF failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.printToPDF");
  }

  async function savePluginBrowserWindowPage(windowId: string, args: unknown[]) {
    void args;
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.savePage failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported("webContents.savePage");
  }

  function updatePluginBrowserWindowZoomFactor(id: string, factor: number) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setZoomFactor failed: browser window ${id} is not active`);
    const zoomFactor = normalizePluginBrowserWindowZoomFactor(factor);
    const zoomLevel = pluginBrowserWindowZoomLevelFromFactor(zoomFactor);
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, zoomFactor, zoomLevel };
      return updatedWindow;
    });
    const result = pluginBrowserWindowZoomResult(updatedWindow || { ...existing, zoomFactor, zoomLevel });
    ports.lastMessage = { windowId: id, channel: "webContents:setZoomFactor", args: [result] };
    return result;
  }

  function updatePluginBrowserWindowZoomLevel(id: string, level: number) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setZoomLevel failed: browser window ${id} is not active`);
    const zoomLevel = normalizePluginBrowserWindowZoomLevel(level, "webContents.setZoomLevel");
    const zoomFactor = pluginBrowserWindowZoomFactorFromLevel(zoomLevel);
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, zoomFactor, zoomLevel };
      return updatedWindow;
    });
    const result = pluginBrowserWindowZoomResult(updatedWindow || { ...existing, zoomFactor, zoomLevel });
    ports.lastMessage = { windowId: id, channel: "webContents:setZoomLevel", args: [result] };
    return result;
  }

  function updatePluginBrowserWindowVisualZoomLimits(id: string, minimumValue: unknown, maximumValue: unknown) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setVisualZoomLevelLimits failed: browser window ${id} is not active`);
    const minimumLevel = normalizePluginBrowserWindowZoomLevel(minimumValue, "webContents.setVisualZoomLevelLimits");
    const maximumLevel = normalizePluginBrowserWindowZoomLevel(maximumValue, "webContents.setVisualZoomLevelLimits");
    if (minimumLevel > maximumLevel) {
      throw new Error("webContents.setVisualZoomLevelLimits requires minimumLevel <= maximumLevel");
    }
    ports.windows = ports.windows.map((childWindow) =>
      childWindow.id === id
        ? { ...childWindow, visualZoomMinimumLevel: minimumLevel, visualZoomMaximumLevel: maximumLevel }
        : childWindow
    );
    const result = {
      minimumLevel,
      maximumLevel,
      zoomFactor: existing.zoomFactor,
      zoomLevel: existing.zoomLevel,
    };
    ports.lastMessage = { windowId: id, channel: "webContents:setVisualZoomLevelLimits", args: [result] };
    return result;
  }

  function pluginBrowserWindowAudioResult(childWindow: PluginBrowserWindowState) {
    return {
      audioMuted: childWindow.audioMuted,
      currentlyAudible: childWindow.currentlyAudible,
    };
  }

  function updatePluginBrowserWindowAudioMuted(id: string, mutedValue: unknown) {
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setAudioMuted failed: browser window ${id} is not active`);
    const audioMuted = mutedValue === true;
    const currentlyAudible = audioMuted ? false : existing.currentlyAudible;
    let updatedWindow: PluginBrowserWindowState | undefined;
    ports.windows = ports.windows.map((childWindow) => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, audioMuted, currentlyAudible };
      return updatedWindow;
    });
    const result = pluginBrowserWindowAudioResult(updatedWindow || { ...existing, audioMuted, currentlyAudible });
    ports.lastMessage = { windowId: id, channel: "webContents:setAudioMuted", args: [result] };
    if (existing.currentlyAudible !== currentlyAudible) {
      dispatchPluginBrowserWindowWebContentsEvent(id, "audio-state-changed", [currentlyAudible]);
    }
    return result;
  }

  function dispatchPluginBrowserWindowEvent(windowId: string, event: string, args: unknown[] = []) {
    const childWindow = ports.windows.find(candidate => candidate.id === windowId);
    ports.geometry.deliver(windowId, {
      __atools_browser_window_event__: true,
      geometrySnapshot: childWindow ? ports.geometry.snapshot(childWindow) : undefined,
      clientCreateId: childWindow?.clientCreateId,
      windowId,
      event,
      args,
    });
  }

  function dispatchPluginBrowserWindowWebContentsEvent(windowId: string, event: string, args: unknown[] = []) {
    ports.geometry.deliver(windowId, {
      __atools_browser_window_event__: true,
      windowId,
      target: "webContents",
      event,
      args,
    });
  }

  function browserWindowDelay(ms: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function readyPluginBrowserWindowFrame(windowId: string, errorPrefix: string) {
    const deadline = Date.now() + HOSTED_BROWSER_WINDOW_RPC_TIMEOUT_MS;
    while (true) {
      const frame = ports.frames.get(windowId);
      if (frame?.contentWindow && ports.rpc.isAttached(windowId)) {
        await ports.rpc.waitReady(windowId);
        return frame;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      await browserWindowDelay(Math.min(25, remainingMs));
    }
    throw new Error(`${errorPrefix} failed: browser window ${windowId} frame is not ready`);
  }


  return {
    pluginBrowserWindowNavigationResult,
    stopPluginBrowserWindowLoading, focusPluginBrowserWindowWebContents,
    setPluginBrowserWindowIgnoreMenuShortcuts, forcefullyCrashPluginBrowserWindowRenderer,
    navigatePluginBrowserWindowHistoryToIndex, navigatePluginBrowserWindowHistory,
    pluginBrowserWindowHistoryIndex, pluginBrowserWindowHistoryOffset,
    clearPluginBrowserWindowNavigationHistory,
    updatePluginBrowserWindowDevTools, inspectPluginBrowserWindowElement, capturePluginBrowserWindowPage,
    printPluginBrowserWindowPage, printPluginBrowserWindowToPdf, savePluginBrowserWindowPage,
    updatePluginBrowserWindowZoomFactor, updatePluginBrowserWindowZoomLevel,
    updatePluginBrowserWindowVisualZoomLimits, updatePluginBrowserWindowAudioMuted,
    dispatchPluginBrowserWindowEvent, dispatchPluginBrowserWindowWebContentsEvent,
    browserWindowDelay, readyPluginBrowserWindowFrame,
  };
}
