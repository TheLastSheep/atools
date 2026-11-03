import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import type { PluginBrowserWindowActionPorts } from "./pluginBrowserWindowActionPorts";
import { browserWindowActionArgs } from "./pluginBrowserWindowPresentation";
import { applyPluginBrowserWindowLifecycleAction } from "./pluginBrowserWindowLifecycleActions";
import { applyPluginBrowserWindowGeometryAction } from "./pluginBrowserWindowGeometryActions";
import type { HostedBrowserWindowNavigationTokens, HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";
import type { PluginBrowserWindowCreator } from "./pluginBrowserWindowReady";

type Ports = {
  windows: PluginBrowserWindowState[];
  lastMessage: import("./pluginBrowserWindowTypes").PluginBrowserWindowParentMessage | null;
  mainFrame: () => HTMLIFrameElement | null;
  post: (source: unknown, message: unknown) => boolean;
  geometry: ReturnType<typeof import("./pluginBrowserWindowGeometryHost").createPluginBrowserWindowGeometryHost>;
  navigation: HostedBrowserWindowNavigationTokens;
  rpc: HostedBrowserWindowRpcHost;
  hostedIpc: ReturnType<typeof import("./pluginHostedIpcRouter").createPluginHostedIpcRouter>;
  sources: import("./pluginInvokePolicy").PluginFrameSourceRegistry;
  frames: Map<string, HTMLIFrameElement>;
  creators: Map<string, PluginBrowserWindowCreator>;
  clearInsertedCss: (id: string) => void;
  webContents: ReturnType<typeof import("./pluginBrowserWindowWebContentsController").createPluginBrowserWindowWebContentsController>;
  frameCommands: ReturnType<typeof import("./pluginBrowserWindowFrameCommands").createPluginBrowserWindowFrameCommands>;
  nextZOrder: () => number;
  loadUrl: (existing: PluginBrowserWindowState, url: string, reloaded?: boolean, ignoreCache?: boolean) => unknown;
  navigateHistory: (existing: PluginBrowserWindowState, direction: "back" | "forward") => unknown;
  navigateHistoryToIndex: (existing: PluginBrowserWindowState, index: number, label: string) => unknown;
  clearHistory: (id: string) => unknown;
  updateUserAgent: (id: string, value: unknown) => unknown;
  updateFrameRate: (id: string, value: unknown) => unknown;
  updateBackgroundThrottling: (id: string, value: unknown) => unknown;
};

export function createPluginBrowserWindowActionDispatcher(ports: Ports) {
  function dispatchPluginBrowserWindowParentMessage(args: Record<string, unknown>) {
    const windowType = typeof args.windowType === "string" ? args.windowType : "main";
    const windowId = typeof args.browserWindowId === "string" ? args.browserWindowId.trim() : "";
    if (windowType !== "browserWindow" || !windowId) {
      throw new Error("sendToParent requires a hosted browser window child");
    }
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`sendToParent failed: browser window ${windowId} is not active`);
    }
    const channel = typeof args.channel === "string" ? args.channel : String(args.channel ?? "");
    if (!channel) throw new Error("sendToParent requires a non-empty channel");
    const messageArgs = Array.isArray(args.args) ? args.args : [];
    ports.lastMessage = { windowId, channel, args: messageArgs };
    ports.post(ports.mainFrame()?.contentWindow, {
      __atools_browser_window_parent_message__: true,
      windowId,
      channel,
      args: messageArgs,
    });
    return true;
  }

  function closePluginBrowserWindowAction(id: string) {
    ports.webContents.dispatchPluginBrowserWindowEvent(id, "closed", [{ visible: false, focused: false, closed: true }]);
    ports.geometry.remove(id);
    ports.navigation.close(id);
    ports.rpc.close(id);
    ports.hostedIpc.invalidate({ kind: "child", windowId: id }, true);
    ports.sources.unregisterChild(id);
    ports.frames.delete(id);
    ports.creators.delete(id);
    ports.clearInsertedCss(id);
    ports.windows = ports.windows
      .filter((childWindow) => childWindow.id !== id)
      .map((childWindow) => childWindow.parentWindowId === id ? { ...childWindow, parentWindowId: null } : childWindow);
    ports.lastMessage = { windowId: id, channel: "window:close", args: [] };
    return { visible: false, focused: false, closed: true };
  }

  const browserWindowActionPorts: PluginBrowserWindowActionPorts = {
    get windows() { return ports.windows; },
    set windows(value) { ports.windows = value; },
    set lastMessage(value: import("./pluginBrowserWindowTypes").PluginBrowserWindowParentMessage | null) { ports.lastMessage = value; },
    dispatchEvent: ports.webContents.dispatchPluginBrowserWindowEvent,
    nextZOrder: ports.nextZOrder,
    closeWindow: closePluginBrowserWindowAction,
    loadUrl: ports.loadUrl,
    navigateHistory: ports.webContents.navigatePluginBrowserWindowHistory,
    navigateHistoryToIndex: ports.navigateHistoryToIndex,
    clearHistory: ports.webContents.clearPluginBrowserWindowNavigationHistory,
  };

  function handlePluginBrowserWindowAction(args: Record<string, unknown>) {
    const result = applyPluginBrowserWindowAction(args);
    if (!["setBounds", "setSize", "setContentSize", "setMinimumSize", "setMaximumSize", "setPosition", "center"].includes(String(args.action))) return result;
    const publish = () => {
      const current = ports.windows.find(candidate => candidate.id === args.id);
      if (current) ports.geometry.publish(current);
    };
    if (result && typeof (result as Promise<unknown>).then === "function") return Promise.resolve(result).then(value => { publish(); return value; });
    publish();
    return result;
  }

  function applyPluginBrowserWindowAction(args: Record<string, unknown>) {
    const id = typeof args.id === "string" ? args.id.trim() : "";
    const actionName = typeof args.action === "string" ? args.action.trim() : "";
    if (!id) throw new Error("browserWindowAction requires a window id");
    if (!actionName) throw new Error("browserWindowAction requires an action");
    const existing = ports.windows.find((childWindow) => childWindow.id === id);
    if (!existing) throw new Error(`browserWindowAction failed: browser window ${id} is not active`);
    const actionArgs = browserWindowActionArgs(args);
    if (actionName === "webContents.send") {
      return ports.frameCommands.dispatchPluginBrowserWindowIpcMessage(id, actionArgs);
    }
    if (actionName === "webContents.executeJavaScript") {
      return ports.frameCommands.executePluginBrowserWindowJavaScript(id, actionArgs);
    }
    if (actionName === "webContents.sendInputEvent") {
      return ports.frameCommands.dispatchPluginBrowserWindowInputEvent(id, actionArgs);
    }
    if (actionName === "webContents.insertCSS") {
      return ports.frameCommands.insertPluginBrowserWindowCss(id, actionArgs);
    }
    if (actionName === "webContents.removeInsertedCSS") {
      return ports.frameCommands.removePluginBrowserWindowCss(id, actionArgs);
    }
    if (actionName === "webContents.findInPage") {
      return ports.frameCommands.findPluginBrowserWindowInPage(id, actionArgs);
    }
    if (actionName === "webContents.stopFindInPage") {
      return ports.frameCommands.stopPluginBrowserWindowFindInPage(id, actionArgs);
    }
    if (actionName === "webContents.loadURL") {
      return ports.loadUrl(existing, String(actionArgs[0] ?? ""), false);
    }
    if (actionName === "webContents.reload") {
      return ports.loadUrl(existing, existing.url, true);
    }
    if (actionName === "webContents.reloadIgnoringCache") {
      return ports.loadUrl(existing, existing.url, true, true);
    }
    if (actionName === "webContents.stop") {
      return ports.webContents.stopPluginBrowserWindowLoading(id);
    }
    if (actionName === "webContents.focus") {
      return ports.webContents.focusPluginBrowserWindowWebContents(id);
    }
    if (actionName === "webContents.setIgnoreMenuShortcuts") {
      return ports.webContents.setPluginBrowserWindowIgnoreMenuShortcuts(id, actionArgs[0]);
    }
    if (actionName === "webContents.forcefullyCrashRenderer") {
      return ports.webContents.forcefullyCrashPluginBrowserWindowRenderer(id);
    }
    if (actionName === "webContents.goBack") {
      return ports.webContents.navigatePluginBrowserWindowHistory(existing, "back");
    }
    if (actionName === "webContents.goForward") {
      return ports.webContents.navigatePluginBrowserWindowHistory(existing, "forward");
    }
    if (actionName === "webContents.navigationHistory.goBack") {
      return ports.navigateHistoryToIndex(existing, existing.historyIndex - 1, "webContents.navigationHistory.goBack");
    }
    if (actionName === "webContents.navigationHistory.goForward") {
      return ports.navigateHistoryToIndex(existing, existing.historyIndex + 1, "webContents.navigationHistory.goForward");
    }
    if (actionName === "webContents.navigationHistory.goToIndex") {
      const targetIndex = ports.webContents.pluginBrowserWindowHistoryIndex(actionArgs[0], "webContents.navigationHistory.goToIndex");
      return ports.navigateHistoryToIndex(existing, targetIndex, "webContents.navigationHistory.goToIndex");
    }
    if (actionName === "webContents.navigationHistory.goToOffset") {
      const offset = ports.webContents.pluginBrowserWindowHistoryOffset(actionArgs[0], "webContents.navigationHistory.goToOffset");
      return ports.navigateHistoryToIndex(existing, existing.historyIndex + offset, "webContents.navigationHistory.goToOffset");
    }
    if (actionName === "webContents.navigationHistory.clear") {
      return ports.webContents.clearPluginBrowserWindowNavigationHistory(id);
    }
    if (actionName === "webContents.openDevTools") {
      const options = actionArgs[0] && typeof actionArgs[0] === "object" && !Array.isArray(actionArgs[0])
        ? actionArgs[0] as Record<string, unknown>
        : {};
      return ports.webContents.updatePluginBrowserWindowDevTools(id, true, options);
    }
    if (actionName === "webContents.closeDevTools") {
      return ports.webContents.updatePluginBrowserWindowDevTools(id, false);
    }
    if (actionName === "webContents.toggleDevTools") {
      return ports.webContents.updatePluginBrowserWindowDevTools(id, !existing.devToolsOpened);
    }
    if (actionName === "webContents.inspectElement") {
      return ports.webContents.inspectPluginBrowserWindowElement(id, actionArgs);
    }
    if (actionName === "webContents.capturePage") {
      return ports.webContents.capturePluginBrowserWindowPage(id, actionArgs);
    }
    if (actionName === "webContents.print") {
      return ports.webContents.printPluginBrowserWindowPage(id, actionArgs);
    }
    if (actionName === "webContents.printToPDF") {
      return ports.webContents.printPluginBrowserWindowToPdf(id, actionArgs);
    }
    if (actionName === "webContents.savePage") {
      return ports.webContents.savePluginBrowserWindowPage(id, actionArgs);
    }
    if (actionName === "webContents.setUserAgent") {
      return ports.updateUserAgent(id, actionArgs[0]);
    }
    if (actionName === "webContents.setFrameRate") {
      return ports.updateFrameRate(id, actionArgs[0]);
    }
    if (actionName === "webContents.setBackgroundThrottling") {
      return ports.updateBackgroundThrottling(id, actionArgs[0]);
    }
    if ([
      "webContents.centerSelection",
      "webContents.scrollToTop",
      "webContents.scrollToBottom",
      "webContents.adjustSelection",
    ].includes(actionName)) {
      return ports.frameCommands.controlPluginBrowserWindowSelection(id, actionName, actionArgs);
    }
    if ([
      "webContents.insertText",
      "webContents.undo",
      "webContents.redo",
      "webContents.cut",
      "webContents.copy",
      "webContents.paste",
      "webContents.pasteAndMatchStyle",
      "webContents.delete",
      "webContents.selectAll",
      "webContents.unselect",
      "webContents.replace",
      "webContents.replaceMisspelling",
    ].includes(actionName)) {
      return ports.frameCommands.editPluginBrowserWindowText(id, actionName, actionArgs);
    }
    if (actionName === "webContents.setZoomFactor") {
      return ports.webContents.updatePluginBrowserWindowZoomFactor(id, Number(actionArgs[0]));
    }
    if (actionName === "webContents.setZoomLevel") {
      return ports.webContents.updatePluginBrowserWindowZoomLevel(id, Number(actionArgs[0]));
    }
    if (actionName === "webContents.setVisualZoomLevelLimits") {
      return ports.webContents.updatePluginBrowserWindowVisualZoomLimits(id, actionArgs[0], actionArgs[1]);
    }
    if (actionName === "webContents.setAudioMuted") {
      return ports.webContents.updatePluginBrowserWindowAudioMuted(id, actionArgs[0]);
    }
    const lifecycleAction = applyPluginBrowserWindowLifecycleAction(browserWindowActionPorts, id, actionName, actionArgs, existing);
    if (lifecycleAction.handled) return lifecycleAction.value;
    const geometryAction = applyPluginBrowserWindowGeometryAction(browserWindowActionPorts, id, actionName, actionArgs, existing);
    if (geometryAction.handled) return geometryAction.value;
    throw new Error(`Unsupported browserWindowAction: ${actionName}`);
  }


  return { dispatchPluginBrowserWindowParentMessage, closePluginBrowserWindowAction, handlePluginBrowserWindowAction, applyPluginBrowserWindowAction };
}
