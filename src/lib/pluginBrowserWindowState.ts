import type { PluginBrowserWindowParentMessage, PluginBrowserWindowState } from "./pluginBrowserWindowTypes";
import { normalizePluginBrowserWindowFrameRate, pluginBrowserWindowRuntimeResult } from "./pluginBrowserWindowPresentation";

type BrowserWindowStateAccess = {
  getWindows: () => PluginBrowserWindowState[];
  setWindows: (windows: PluginBrowserWindowState[]) => void;
  setLastMessage: (message: PluginBrowserWindowParentMessage) => void;
};

function nativeWebContentsUnsupported(action: string): never {
  const error = new Error(`${action} is unavailable for native BrowserWindow hosts`) as Error & { code: string };
  error.code = "ERR_ATOOLS_NATIVE_WINDOW_UNSUPPORTED";
  throw error;
}

export function createPluginBrowserWindowState(access: BrowserWindowStateAccess) {
  function updatePluginBrowserWindowUserAgent(id: string, value: unknown) {
    const windows = access.getWindows();
    const existing = windows.find(childWindow => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setUserAgent failed: browser window ${id} is not active`);
    const userAgent = String(value ?? "");
    let updatedWindow: PluginBrowserWindowState | undefined;
    access.setWindows(windows.map(childWindow => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, userAgent };
      return updatedWindow;
    }));
    const result = pluginBrowserWindowRuntimeResult(updatedWindow || { ...existing, userAgent });
    access.setLastMessage({ windowId: id, channel: "webContents:setUserAgent", args: [userAgent] });
    return result;
  }

  function updatePluginBrowserWindowFrameRate(id: string, value: unknown) {
    const windows = access.getWindows();
    const existing = windows.find(childWindow => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setFrameRate failed: browser window ${id} is not active`);
    const frameRate = normalizePluginBrowserWindowFrameRate(value);
    let updatedWindow: PluginBrowserWindowState | undefined;
    access.setWindows(windows.map(childWindow => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, frameRate };
      return updatedWindow;
    }));
    const result = pluginBrowserWindowRuntimeResult(updatedWindow || { ...existing, frameRate });
    access.setLastMessage({ windowId: id, channel: "webContents:setFrameRate", args: [frameRate] });
    return result;
  }

  function updatePluginBrowserWindowBackgroundThrottling(id: string, value: unknown) {
    const windows = access.getWindows();
    const existing = windows.find(childWindow => childWindow.id === id);
    if (!existing) throw new Error(`webContents.setBackgroundThrottling failed: browser window ${id} is not active`);
    if (existing.hostKind === "native") nativeWebContentsUnsupported("webContents.setBackgroundThrottling");
    const backgroundThrottling = value !== false;
    let updatedWindow: PluginBrowserWindowState | undefined;
    access.setWindows(windows.map(childWindow => {
      if (childWindow.id !== id) return childWindow;
      updatedWindow = { ...childWindow, backgroundThrottling };
      return updatedWindow;
    }));
    const result = pluginBrowserWindowRuntimeResult(updatedWindow || { ...existing, backgroundThrottling });
    access.setLastMessage({ windowId: id, channel: "webContents:setBackgroundThrottling", args: [backgroundThrottling] });
    return result;
  }

  function nextPluginBrowserWindowZOrder(): number {
    return Math.max(0, ...access.getWindows().map(childWindow => childWindow.zOrder)) + 1;
  }

  return {
    updatePluginBrowserWindowUserAgent,
    updatePluginBrowserWindowFrameRate,
    updatePluginBrowserWindowBackgroundThrottling,
    nextPluginBrowserWindowZOrder,
  };
}
