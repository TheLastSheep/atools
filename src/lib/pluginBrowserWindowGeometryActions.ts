import type { PluginBrowserWindowActionPorts, PluginBrowserWindowDispatchResult } from "./pluginBrowserWindowActionPorts";
import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import {
  PLUGIN_BROWSER_WINDOW_MAX_HEIGHT, PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
  PLUGIN_BROWSER_WINDOW_MIN_HEIGHT, PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
  browserWindowOpacity, browserWindowPositionFromArgs, browserWindowProgressState, browserWindowSizeFromArgs,
  constrainPluginBrowserWindowSize, normalizePluginBrowserWindowBounds,
  pluginBrowserWindowAspectRatioExtraSize, pluginBrowserWindowBounds,
} from "./pluginBrowserWindowPresentation";

const supportedActions = new Set([
  'getBounds',
  'setBounds',
  'getSize',
  'setSize',
  'getContentSize',
  'setContentSize',
  'setMinimumSize',
  'getMinimumSize',
  'setMaximumSize',
  'getMaximumSize',
  'setAspectRatio',
  'getPosition',
  'setPosition',
  'center',
  'isResizable',
  'setResizable',
  'isMovable',
  'setMovable',
  'isClosable',
  'setClosable',
  'isMinimizable',
  'setMinimizable',
  'isMaximizable',
  'setMaximizable',
  'isFullScreen',
  'setFullScreen',
  'isFullScreenable',
  'setFullScreenable',
  'getOpacity',
  'setOpacity',
  'hasShadow',
  'setHasShadow',
  'invalidateShadow',
  'setSkipTaskbar',
  'isKiosk',
  'setKiosk',
  'isVisibleOnAllWorkspaces',
  'setVisibleOnAllWorkspaces',
  'isContentProtected',
  'setContentProtection',
  'isFocusable',
  'setFocusable',
  'flashFrame',
  'setProgressBar',
  'getMediaSourceId',
  'moveTop',
  'moveAbove',
]);

export function applyPluginBrowserWindowGeometryAction(
  ports: PluginBrowserWindowActionPorts,
  id: string,
  actionName: string,
  actionArgs: unknown[],
  existing: PluginBrowserWindowState,
): PluginBrowserWindowDispatchResult {
  if (!supportedActions.has(actionName)) return { handled: false };
  return { handled: true, value: (() => {
    if (actionName === "getBounds") {
      return pluginBrowserWindowBounds(existing);
    }
    if (actionName === "setBounds") {
      const bounds = normalizePluginBrowserWindowBounds(actionArgs[0], pluginBrowserWindowBounds(existing), existing);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...bounds, positioned: true } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setBounds", args: [bounds] };
      ports.dispatchEvent(id, "resize", [{ width: bounds.width, height: bounds.height, bounds }]);
      ports.dispatchEvent(id, "move", [{ x: bounds.x, y: bounds.y, bounds }]);
      return bounds;
    }
    if (actionName === "getSize") {
      return [existing.width, existing.height];
    }
    if (actionName === "setSize") {
      const size = browserWindowSizeFromArgs(actionArgs, pluginBrowserWindowBounds(existing), existing);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...size } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setSize", args: [size] };
      ports.dispatchEvent(id, "resize", [{ width: size.width, height: size.height }]);
      return [size.width, size.height];
    }
    if (actionName === "getContentSize") {
      return [existing.width, existing.height];
    }
    if (actionName === "setContentSize") {
      const size = browserWindowSizeFromArgs(actionArgs, pluginBrowserWindowBounds(existing), existing);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...size } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setContentSize", args: [size, actionArgs[2] === true] };
      ports.dispatchEvent(id, "resize", [{ width: size.width, height: size.height, contentSize: true }]);
      return [size.width, size.height];
    }
    if (actionName === "setMinimumSize") {
      const requested = browserWindowSizeFromArgs(actionArgs, { width: existing.minimumWidth, height: existing.minimumHeight }, {
        minimumWidth: PLUGIN_BROWSER_WINDOW_MIN_WIDTH,
        minimumHeight: PLUGIN_BROWSER_WINDOW_MIN_HEIGHT,
        maximumWidth: PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
        maximumHeight: PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
      });
      const minimumWidth = requested.width;
      const minimumHeight = requested.height;
      const maximumWidth = Math.max(existing.maximumWidth, minimumWidth);
      const maximumHeight = Math.max(existing.maximumHeight, minimumHeight);
      const size = constrainPluginBrowserWindowSize(pluginBrowserWindowBounds(existing), {
        minimumWidth,
        minimumHeight,
        maximumWidth,
        maximumHeight,
      });
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimumWidth, minimumHeight, maximumWidth, maximumHeight, ...size } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMinimumSize", args: [[minimumWidth, minimumHeight]] };
      if (size.width !== existing.width || size.height !== existing.height) {
        ports.dispatchEvent(id, "resize", [{ width: size.width, height: size.height, constrained: true }]);
      }
      return [minimumWidth, minimumHeight];
    }
    if (actionName === "getMinimumSize") {
      return [existing.minimumWidth, existing.minimumHeight];
    }
    if (actionName === "setMaximumSize") {
      const requested = browserWindowSizeFromArgs(actionArgs, { width: existing.maximumWidth, height: existing.maximumHeight }, {
        minimumWidth: existing.minimumWidth,
        minimumHeight: existing.minimumHeight,
        maximumWidth: PLUGIN_BROWSER_WINDOW_MAX_WIDTH,
        maximumHeight: PLUGIN_BROWSER_WINDOW_MAX_HEIGHT,
      });
      const maximumWidth = requested.width;
      const maximumHeight = requested.height;
      const size = constrainPluginBrowserWindowSize(pluginBrowserWindowBounds(existing), {
        minimumWidth: existing.minimumWidth,
        minimumHeight: existing.minimumHeight,
        maximumWidth,
        maximumHeight,
      });
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, maximumWidth, maximumHeight, ...size } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMaximumSize", args: [[maximumWidth, maximumHeight]] };
      if (size.width !== existing.width || size.height !== existing.height) {
        ports.dispatchEvent(id, "resize", [{ width: size.width, height: size.height, constrained: true }]);
      }
      return [maximumWidth, maximumHeight];
    }
    if (actionName === "getMaximumSize") {
      return [existing.maximumWidth, existing.maximumHeight];
    }
    if (actionName === "setAspectRatio") {
      const ratioValue = typeof actionArgs[0] === "number" ? actionArgs[0] : Number(actionArgs[0]);
      const aspectRatio = Number.isFinite(ratioValue) && ratioValue > 0 ? ratioValue : 0;
      const aspectRatioExtraSize = pluginBrowserWindowAspectRatioExtraSize(actionArgs[1]);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, aspectRatio, aspectRatioExtraSize } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setAspectRatio", args: [aspectRatio, aspectRatioExtraSize] };
      return { aspectRatio, aspectRatioExtraSize };
    }
    if (actionName === "getPosition") {
      return [existing.x, existing.y];
    }
    if (actionName === "setPosition") {
      const position = browserWindowPositionFromArgs(actionArgs, pluginBrowserWindowBounds(existing));
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...position, positioned: true } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setPosition", args: [position] };
      ports.dispatchEvent(id, "move", [{ x: position.x, y: position.y }]);
      return [position.x, position.y];
    }
    if (actionName === "center") {
      const bounds = { ...pluginBrowserWindowBounds(existing), x: 0, y: 0 };
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, x: 0, y: 0, positioned: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:center", args: [] };
      ports.dispatchEvent(id, "move", [{ x: 0, y: 0, centered: true }]);
      return { ...bounds, centered: true };
    }
    if (actionName === "isResizable") {
      return existing.resizable;
    }
    if (actionName === "setResizable") {
      const resizable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, resizable } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setResizable", args: [resizable] };
      return { resizable };
    }
    if (actionName === "isMovable") {
      return existing.movable;
    }
    if (actionName === "setMovable") {
      const movable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, movable } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMovable", args: [movable] };
      return { movable };
    }
    if (actionName === "isClosable") {
      return existing.closable;
    }
    if (actionName === "setClosable") {
      const closable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, closable } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setClosable", args: [closable] };
      return { closable };
    }
    if (actionName === "isMinimizable") {
      return existing.minimizable;
    }
    if (actionName === "setMinimizable") {
      const minimizable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimizable } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMinimizable", args: [minimizable] };
      return { minimizable };
    }
    if (actionName === "isMaximizable") {
      return existing.maximizable;
    }
    if (actionName === "setMaximizable") {
      const maximizable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, maximizable } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMaximizable", args: [maximizable] };
      return { maximizable };
    }
    if (actionName === "isFullScreen") {
      return existing.fullScreen;
    }
    if (actionName === "setFullScreen") {
      const requestedFullScreen = actionArgs[0] === true;
      const fullScreen = requestedFullScreen && existing.fullScreenable;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id
          ? { ...childWindow, fullScreen, minimized: false, maximized: false, visible: true, focused: fullScreen || childWindow.focused }
          : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setFullScreen", args: [fullScreen] };
      ports.dispatchEvent(id, fullScreen ? "enter-full-screen" : "leave-full-screen", [{ fullScreen }]);
      return { fullScreen };
    }
    if (actionName === "isFullScreenable") {
      return existing.fullScreenable;
    }
    if (actionName === "setFullScreenable") {
      const fullScreenable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, fullScreenable, fullScreen: fullScreenable ? childWindow.fullScreen : false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setFullScreenable", args: [fullScreenable] };
      return { fullScreenable };
    }
    if (actionName === "getOpacity") {
      return existing.opacity;
    }
    if (actionName === "setOpacity") {
      const opacity = browserWindowOpacity(actionArgs[0]);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, opacity } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setOpacity", args: [opacity] };
      return { opacity };
    }
    if (actionName === "hasShadow") {
      return existing.hasShadow;
    }
    if (actionName === "setHasShadow") {
      const hasShadow = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, hasShadow } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setHasShadow", args: [hasShadow] };
      return { hasShadow };
    }
    if (actionName === "invalidateShadow") {
      ports.lastMessage = { windowId: id, channel: "window:invalidateShadow", args: [] };
      return { hasShadow: existing.hasShadow };
    }
    if (actionName === "setSkipTaskbar") {
      const skipTaskbar = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, skipTaskbar } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setSkipTaskbar", args: [skipTaskbar] };
      return { skipTaskbar };
    }
    if (actionName === "isKiosk") {
      return existing.kiosk;
    }
    if (actionName === "setKiosk") {
      const kiosk = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, kiosk, minimized: false, maximized: false, visible: true, focused: kiosk || childWindow.focused } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setKiosk", args: [kiosk] };
      return { kiosk };
    }
    if (actionName === "isVisibleOnAllWorkspaces") {
      return existing.visibleOnAllWorkspaces;
    }
    if (actionName === "setVisibleOnAllWorkspaces") {
      const visibleOnAllWorkspaces = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, visibleOnAllWorkspaces } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setVisibleOnAllWorkspaces", args: [visibleOnAllWorkspaces, actionArgs[1] || {}] };
      return { visibleOnAllWorkspaces };
    }
    if (actionName === "isContentProtected") {
      return existing.contentProtected;
    }
    if (actionName === "setContentProtection") {
      const contentProtected = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, contentProtected } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setContentProtection", args: [contentProtected] };
      return { contentProtected };
    }
    if (actionName === "isFocusable") {
      return existing.focusable;
    }
    if (actionName === "setFocusable") {
      const focusable = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, focusable } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setFocusable", args: [focusable] };
      return { focusable };
    }
    if (actionName === "flashFrame") {
      const flashing = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, flashing } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:flashFrame", args: [flashing] };
      return { flashing };
    }
    if (actionName === "setProgressBar") {
      const progressState = browserWindowProgressState(actionArgs[0], actionArgs[1]);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, ...progressState } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setProgressBar", args: [progressState.progressBar, progressState.progressBarMode] };
      return progressState;
    }
    if (actionName === "getMediaSourceId") {
      return existing.mediaSourceId;
    }
    if (actionName === "moveTop") {
      const zOrder = ports.nextZOrder();
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, zOrder } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:moveTop", args: [zOrder] };
      return { zOrder };
    }
    if (actionName === "moveAbove") {
      const mediaSourceId = String(actionArgs[0] ?? "").trim();
      const sourceWindow = ports.windows.find((childWindow) => childWindow.mediaSourceId === mediaSourceId);
      if (!sourceWindow) throw new Error(`moveAbove failed: mediaSourceId ${mediaSourceId || "(empty)"} is not active`);
      const zOrder = Math.max(sourceWindow.zOrder + 1, ports.nextZOrder());
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, zOrder } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:moveAbove", args: [mediaSourceId, zOrder] };
      return { zOrder, mediaSourceId };
    }
  })() };
}
