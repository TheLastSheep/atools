import type { PluginBrowserWindowState, PluginBrowserWindowInsertedCss, PluginBrowserWindowParentMessage } from "./pluginBrowserWindowTypes";
import { hostedBrowserWindowUnsupported, type HostedBrowserWindowRpcHost } from "./hostedBrowserWindowRpc";

type Ports = {
  windows: PluginBrowserWindowState[];
  lastMessage: PluginBrowserWindowParentMessage | null;
  frames: Map<string, HTMLIFrameElement>;
  rpc: HostedBrowserWindowRpcHost;
  insertedCss: Map<string, PluginBrowserWindowInsertedCss>;
  cssSequence: number;
  findSequence: number;
  post: (source: unknown, message: unknown) => boolean;
  readyFrame: (id: string, label: string) => Promise<HTMLIFrameElement>;
  dispatchWebContentsEvent: (id: string, event: string, args?: unknown[]) => void;
};

export function createPluginBrowserWindowFrameCommands(ports: Ports) {
  function postPluginBrowserWindowIpcMessage(windowId: string, channel: string, args: unknown[], attempt = 0) {
    const frame = ports.frames.get(windowId);
    const ready = frame?.contentWindow && ports.rpc.isReady(windowId);
    if (!ready) {
      if (attempt < 40) {
        setTimeout(() => postPluginBrowserWindowIpcMessage(windowId, channel, args, attempt + 1), 25);
      }
      return;
    }
    const targetWindow = frame.contentWindow;
    if (!targetWindow) return;
    ports.post(targetWindow, {
      __atools_browser_window_ipc__: true,
      windowId,
      channel,
      args,
    });
  }

  function dispatchPluginBrowserWindowIpcMessage(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.send failed: browser window ${windowId} is not active`);
    }
    const channel = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!channel) throw new Error("webContents.send requires a non-empty channel");
    const messageArgs = args.slice(1);
    ports.lastMessage = { windowId, channel: `webContents:${channel}`, args: messageArgs };
    postPluginBrowserWindowIpcMessage(windowId, channel, messageArgs);
    return true;
  }

  async function executePluginBrowserWindowJavaScript(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.executeJavaScript failed: browser window ${windowId} is not active`);
    }
    const code = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    const userGesture = args[1] === true;
    ports.lastMessage = { windowId, channel: "webContents:executeJavaScript", args: [code, userGesture] };
    try {
      await ports.readyFrame(windowId, "webContents.executeJavaScript");
      return await ports.rpc.call(windowId, "executeJavaScript", { code, userGesture });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`webContents.executeJavaScript failed: ${message}`);
    }
  }

  function browserWindowInputString(value: unknown, fallback = "") {
    if (typeof value === "string") return value;
    if (value == null) return fallback;
    return String(value);
  }

  async function dispatchPluginBrowserWindowInputEvent(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.sendInputEvent failed: browser window ${windowId} is not active`);
    }
    const inputEvent = args[0];
    if (!inputEvent || typeof inputEvent !== "object" || Array.isArray(inputEvent)) {
      throw new Error("webContents.sendInputEvent requires an input event object");
    }
    const eventRecord = inputEvent as Record<string, unknown>;
    const eventType = browserWindowInputString(eventRecord.type).trim().toLowerCase();
    if (!eventType) throw new Error("webContents.sendInputEvent requires an input event type");

    ports.lastMessage = { windowId, channel: "webContents:sendInputEvent", args: [eventRecord] };
    await ports.readyFrame(windowId, "webContents.sendInputEvent");
    await ports.rpc.call(windowId, "sendInputEvent", { inputEvent: eventRecord });
    return undefined;
  }

  function clearPluginBrowserWindowInsertedCss(windowId: string) {
    for (const [key, record] of ports.insertedCss.entries()) {
      if (record.windowId === windowId) ports.insertedCss.delete(key);
    }
  }

  function browserWindowCssOrigin(value: unknown): "author" | "user" {
    return value === "user" ? "user" : "author";
  }

  async function insertPluginBrowserWindowCss(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.insertCSS failed: browser window ${windowId} is not active`);
    }
    const css = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!css) throw new Error("webContents.insertCSS requires CSS text");
    const options = args[1] && typeof args[1] === "object" && !Array.isArray(args[1])
      ? args[1] as Record<string, unknown>
      : {};
    const cssOrigin = browserWindowCssOrigin(options.cssOrigin);
    ports.lastMessage = { windowId, channel: "webContents:insertCSS", args: [css, { cssOrigin }] };
    const key = `${windowId}:css:${++ports.cssSequence}`;
    await ports.readyFrame(windowId, "webContents.insertCSS");
    await ports.rpc.call(windowId, "insertCSS", { key, css, cssOrigin });
    ports.insertedCss.set(key, { windowId, key, css, cssOrigin });
    return key;
  }

  async function removePluginBrowserWindowCss(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.removeInsertedCSS failed: browser window ${windowId} is not active`);
    }
    const key = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!key) throw new Error("webContents.removeInsertedCSS requires a CSS key");
    const record = ports.insertedCss.get(key);
    if (!record || record.windowId !== windowId) {
      throw new Error(`webContents.removeInsertedCSS failed: unknown CSS key ${key}`);
    }
    ports.lastMessage = { windowId, channel: "webContents:removeInsertedCSS", args: [key] };
    await ports.readyFrame(windowId, "webContents.removeInsertedCSS");
    await ports.rpc.call(windowId, "removeInsertedCSS", { key });
    ports.insertedCss.delete(key);
    return undefined;
  }

  function browserWindowFindRequestId(value: unknown) {
    const numericValue = Number(value);
    if (Number.isInteger(numericValue) && numericValue > 0) return numericValue;
    return ++ports.findSequence;
  }

  function browserWindowFindOptions(value: unknown) {
    const options = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    return {
      forward: options.forward !== false,
      findNext: options.findNext === true,
      matchCase: options.matchCase === true,
    };
  }

  async function findPluginBrowserWindowInPage(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.findInPage failed: browser window ${windowId} is not active`);
    }
    const text = typeof args[0] === "string" ? args[0] : String(args[0] ?? "");
    if (!text) throw new Error("webContents.findInPage requires non-empty text");
    const options = browserWindowFindOptions(args[1]);
    const requestId = browserWindowFindRequestId(args[2]);
    ports.lastMessage = { windowId, channel: "webContents:findInPage", args: [text, options, requestId] };

    await ports.readyFrame(windowId, "webContents.findInPage");
    const result = await ports.rpc.call(windowId, "findInPage", {
      text,
      ...options,
      requestId,
    });
    ports.dispatchWebContentsEvent(windowId, "found-in-page", [result]);
    return requestId;
  }

  function browserWindowStopFindAction(value: unknown) {
    const action = typeof value === "string" ? value.trim() : "";
    if (action === "keepSelection" || action === "activateSelection") return action;
    return "clearSelection";
  }

  async function stopPluginBrowserWindowFindInPage(windowId: string, args: unknown[]) {
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`webContents.stopFindInPage failed: browser window ${windowId} is not active`);
    }
    const action = browserWindowStopFindAction(args[0]);
    ports.lastMessage = { windowId, channel: "webContents:stopFindInPage", args: [action] };
    await ports.readyFrame(windowId, "webContents.stopFindInPage");
    await ports.rpc.call(windowId, "stopFindInPage", { action });
    return undefined;
  }

  async function controlPluginBrowserWindowSelection(windowId: string, actionName: string, args: unknown[]) {
    void args;
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`${actionName} failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported(actionName);
  }

  async function editPluginBrowserWindowText(windowId: string, actionName: string, args: unknown[]) {
    void args;
    if (!ports.windows.some((childWindow) => childWindow.id === windowId)) {
      throw new Error(`${actionName} failed: browser window ${windowId} is not active`);
    }
    throw hostedBrowserWindowUnsupported(actionName);
  }


  return {
    postPluginBrowserWindowIpcMessage, dispatchPluginBrowserWindowIpcMessage,
    executePluginBrowserWindowJavaScript, dispatchPluginBrowserWindowInputEvent,
    clearPluginBrowserWindowInsertedCss, insertPluginBrowserWindowCss, removePluginBrowserWindowCss,
    findPluginBrowserWindowInPage, stopPluginBrowserWindowFindInPage,
    controlPluginBrowserWindowSelection, editPluginBrowserWindowText,
  };
}
