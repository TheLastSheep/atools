import type { PluginBrowserWindowActionPorts, PluginBrowserWindowDispatchResult } from "./pluginBrowserWindowActionPorts";
import type { PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import {
  normalizePluginBrowserWindowBackgroundColor, normalizePluginBrowserWindowPoint,
  pluginBrowserWindowNullableString, pluginBrowserWindowNumber, pluginBrowserWindowPlainOptions,
} from "./pluginBrowserWindowPresentation";

const supportedActions = new Set([
  'close',
  'hide',
  'show',
  'focus',
  'isVisible',
  'isFocused',
  'showInactive',
  'blur',
  'getTitle',
  'setTitle',
  'getURL',
  'loadURL',
  'reload',
  'minimize',
  'isMinimized',
  'restore',
  'maximize',
  'unmaximize',
  'isMaximized',
  'isAlwaysOnTop',
  'setAlwaysOnTop',
  'getBackgroundColor',
  'setBackgroundColor',
  'setAutoHideMenuBar',
  'isMenuBarAutoHide',
  'setMenuBarVisibility',
  'isMenuBarVisible',
  'removeMenu',
  'setMenu',
  'setWindowButtonVisibility',
  'setWindowButtonPosition',
  'getWindowButtonPosition',
  'setVibrancy',
  'setBackgroundMaterial',
  'setSheetOffset',
  'isNormal',
  'isModal',
  'setDocumentEdited',
  'isDocumentEdited',
  'setRepresentedFilename',
  'getRepresentedFilename',
  'setParentWindow',
  'getParentWindow',
  'getChildWindows',
  'show',
  'focus',
]);

export function applyPluginBrowserWindowLifecycleAction(
  ports: PluginBrowserWindowActionPorts,
  id: string,
  actionName: string,
  actionArgs: unknown[],
  existing: PluginBrowserWindowState,
): PluginBrowserWindowDispatchResult {
  if (!supportedActions.has(actionName)) return { handled: false };
  return { handled: true, value: (() => {
    if (actionName === "close") {
      return ports.closeWindow(id);
    }
    if (actionName === "hide") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, visible: false, focused: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:hide", args: [] };
      ports.dispatchEvent(id, "hide", [{ visible: false, focused: false, closed: false }]);
      return { visible: false, focused: false, closed: false };
    }
    if (actionName === "show" || actionName === "focus") {
      const focused = existing.focusable;
      ports.windows = ports.windows.map((childWindow) => ({
        ...childWindow,
        visible: childWindow.id === id ? true : childWindow.visible,
        focused: childWindow.id === id ? focused : false,
      }));
      ports.lastMessage = { windowId: id, channel: `window:${actionName}`, args: [] };
      ports.dispatchEvent(id, actionName, [{ visible: true, focused, closed: false }]);
      return { visible: true, focused, closed: false };
    }
    if (actionName === "isVisible") {
      return existing.visible;
    }
    if (actionName === "isFocused") {
      return existing.focused;
    }
    if (actionName === "showInactive") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, visible: true, focused: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:showInactive", args: [] };
      ports.dispatchEvent(id, "show", [{ visible: true, focused: false, closed: false }]);
      return { visible: true, focused: false, closed: false };
    }
    if (actionName === "blur") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, focused: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:blur", args: [] };
      ports.dispatchEvent(id, "blur", [{ visible: existing.visible, focused: false, closed: false }]);
      return { visible: existing.visible, focused: false, closed: false };
    }
    if (actionName === "getTitle") {
      return existing.title;
    }
    if (actionName === "setTitle") {
      const title = String(actionArgs[0] ?? "").trim().slice(0, 80) || existing.title;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, title } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setTitle", args: [title] };
      return { title };
    }
    if (actionName === "getURL") {
      return existing.url;
    }
    if (actionName === "loadURL") {
      return ports.loadUrl(existing, String(actionArgs[0] ?? ""), false);
    }
    if (actionName === "reload") {
      return ports.loadUrl(existing, existing.url, true);
    }
    if (actionName === "minimize") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimized: true, maximized: false, fullScreen: false, focused: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:minimize", args: [] };
      ports.dispatchEvent(id, "minimize", [{ minimized: true, maximized: false }]);
      return { minimized: true, maximized: false };
    }
    if (actionName === "isMinimized") {
      return existing.minimized;
    }
    if (actionName === "restore") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, minimized: false, maximized: false, fullScreen: false, visible: true } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:restore", args: [] };
      ports.dispatchEvent(id, "restore", [{ minimized: false, maximized: false }]);
      return { minimized: false, maximized: false };
    }
    if (actionName === "maximize") {
      ports.windows = ports.windows.map((childWindow) => ({
        ...childWindow,
        minimized: childWindow.id === id ? false : childWindow.minimized,
        maximized: childWindow.id === id,
        fullScreen: childWindow.id === id ? false : childWindow.fullScreen,
        visible: childWindow.id === id ? true : childWindow.visible,
        focused: childWindow.id === id,
      }));
      ports.lastMessage = { windowId: id, channel: "window:maximize", args: [] };
      ports.dispatchEvent(id, "maximize", [{ minimized: false, maximized: true }]);
      return { minimized: false, maximized: true };
    }
    if (actionName === "unmaximize") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, maximized: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:unmaximize", args: [] };
      ports.dispatchEvent(id, "unmaximize", [{ minimized: existing.minimized, maximized: false }]);
      return { minimized: existing.minimized, maximized: false };
    }
    if (actionName === "isMaximized") {
      return existing.maximized;
    }
    if (actionName === "isAlwaysOnTop") {
      return existing.alwaysOnTop;
    }
    if (actionName === "setAlwaysOnTop") {
      const alwaysOnTop = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, alwaysOnTop } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setAlwaysOnTop", args: [alwaysOnTop] };
      return { alwaysOnTop };
    }
    if (actionName === "getBackgroundColor") {
      return existing.backgroundColor;
    }
    if (actionName === "setBackgroundColor") {
      const backgroundColor = normalizePluginBrowserWindowBackgroundColor(actionArgs[0], existing.backgroundColor);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, backgroundColor } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setBackgroundColor", args: [backgroundColor] };
      return { backgroundColor };
    }
    if (actionName === "setAutoHideMenuBar") {
      const menuBarAutoHide = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuBarAutoHide } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setAutoHideMenuBar", args: [menuBarAutoHide] };
      return { menuBarAutoHide };
    }
    if (actionName === "isMenuBarAutoHide") {
      return existing.menuBarAutoHide;
    }
    if (actionName === "setMenuBarVisibility") {
      const menuBarVisible = actionArgs[0] === true && !existing.menuRemoved;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuBarVisible } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMenuBarVisibility", args: [menuBarVisible] };
      return { menuBarVisible };
    }
    if (actionName === "isMenuBarVisible") {
      return existing.menuBarVisible && !existing.menuRemoved;
    }
    if (actionName === "removeMenu") {
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuRemoved: true, menuBarVisible: false } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:removeMenu", args: [] };
      return { menuRemoved: true, menuBarVisible: false };
    }
    if (actionName === "setMenu") {
      const menuRemoved = actionArgs[0] == null;
      const menuBarVisible = !menuRemoved;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, menuRemoved, menuBarVisible } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setMenu", args: [actionArgs[0] ?? null] };
      return { menuRemoved, menuBarVisible };
    }
    if (actionName === "setWindowButtonVisibility") {
      const windowButtonVisible = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, windowButtonVisible } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setWindowButtonVisibility", args: [windowButtonVisible] };
      return { windowButtonVisible };
    }
    if (actionName === "setWindowButtonPosition") {
      const windowButtonPosition = normalizePluginBrowserWindowPoint(actionArgs[0]);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, windowButtonPosition } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setWindowButtonPosition", args: [windowButtonPosition] };
      return { windowButtonPosition };
    }
    if (actionName === "getWindowButtonPosition") {
      return existing.windowButtonPosition ? { ...existing.windowButtonPosition } : null;
    }
    if (actionName === "setVibrancy") {
      const vibrancy = pluginBrowserWindowNullableString(actionArgs[0]);
      const vibrancyOptions = pluginBrowserWindowPlainOptions(actionArgs[1]);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, vibrancy, vibrancyOptions } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setVibrancy", args: [vibrancy || null, vibrancyOptions] };
      return { vibrancy, vibrancyOptions };
    }
    if (actionName === "setBackgroundMaterial") {
      const backgroundMaterial = pluginBrowserWindowNullableString(actionArgs[0]) || "none";
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, backgroundMaterial } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setBackgroundMaterial", args: [backgroundMaterial] };
      return { backgroundMaterial };
    }
    if (actionName === "setSheetOffset") {
      const sheetOffsetY = pluginBrowserWindowNumber(actionArgs[0], 0);
      const sheetOffsetX = pluginBrowserWindowNumber(actionArgs[1], 0);
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, sheetOffsetY, sheetOffsetX } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setSheetOffset", args: actionArgs.length > 1 ? [sheetOffsetY, sheetOffsetX] : [sheetOffsetY] };
      return { sheetOffsetY, sheetOffsetX };
    }
    if (actionName === "isNormal") {
      return !existing.minimized && !existing.maximized && !existing.fullScreen && !existing.kiosk;
    }
    if (actionName === "isModal") {
      return existing.modal;
    }
    if (actionName === "setDocumentEdited") {
      const documentEdited = actionArgs[0] === true;
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, documentEdited } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setDocumentEdited", args: [documentEdited] };
      return { documentEdited };
    }
    if (actionName === "isDocumentEdited") {
      return existing.documentEdited;
    }
    if (actionName === "setRepresentedFilename") {
      const representedFilename = String(actionArgs[0] ?? "");
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, representedFilename } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setRepresentedFilename", args: [representedFilename] };
      return { representedFilename };
    }
    if (actionName === "getRepresentedFilename") {
      return existing.representedFilename;
    }
    if (actionName === "setParentWindow") {
      const requestedParentWindowId = typeof actionArgs[0] === "string" && actionArgs[0].trim() ? actionArgs[0].trim() : null;
      if (requestedParentWindowId === id) throw new Error("setParentWindow failed: a window cannot parent itself");
      if (requestedParentWindowId && !ports.windows.some((childWindow) => childWindow.id === requestedParentWindowId)) {
        throw new Error(`setParentWindow failed: parent window ${requestedParentWindowId} is not active`);
      }
      ports.windows = ports.windows.map((childWindow) =>
        childWindow.id === id ? { ...childWindow, parentWindowId: requestedParentWindowId } : childWindow
      );
      ports.lastMessage = { windowId: id, channel: "window:setParentWindow", args: [requestedParentWindowId] };
      return { parentWindowId: requestedParentWindowId };
    }
    if (actionName === "getParentWindow") {
      return existing.parentWindowId;
    }
    if (actionName === "getChildWindows") {
      return ports.windows.filter((childWindow) => childWindow.parentWindowId === id).map((childWindow) => childWindow.id);
    }
  })() };
}
