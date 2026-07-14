import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const appSource = await readFile(new URL("src/App.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
const uiRestoreChecklist = await readFile(new URL("docs/ui-ztools-restore-checklist.md", root), "utf8");
const bridgeTestSource = await readFile(new URL("scripts/test-plugin-window-browser-bridge.mjs", root), "utf8");

function smokeChecklistLineContaining(marker) {
  return smokeChecklist.split("\n").find((line) => line.includes(marker)) || "";
}

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");
const hostComponentSource = componentSource.replace(bridgeMatch[0], "");

function bridgeSourceFor(windowType = "main", browserWindowId = "") {
  return bridgeMatch[1]
    .replace(/<\\\/script>/g, "</script>")
    .replace(/^\s*<script>\s*/, "")
    .replace(/\s*<\/script>\s*$/, "")
    .replace(/__PLUGIN_ID__/g, JSON.stringify("window-browser-test-plugin"))
    .replace(/__FEATURE_CODE__/g, JSON.stringify("window-browser-test-feature"))
    .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
    .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
    .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"))
    .replace("var _atoolsWindowType = 'main';", `var _atoolsWindowType = ${JSON.stringify(windowType)};`)
    .replace("var _atoolsBrowserWindowId = '';", `var _atoolsBrowserWindowId = ${JSON.stringify(browserWindowId)};`);
}

function createBridgeVm(windowType = "main", browserWindowId = "") {
  const listeners = new Map();
  const postedMessages = [];

  const windowStub = {
    parent: {
      postMessage(message) {
        postedMessages.push(message);
      },
    },
    top: {},
    addEventListener(type, cb) {
      const list = listeners.get(type) || [];
      list.push(cb);
      listeners.set(type, list);
    },
    dispatchEvent(event) {
      const list = listeners.get(event.type) || [];
      list.forEach((cb) => cb(event));
    },
    matchMedia() {
      return { matches: false };
    },
  };

  const documentStub = {
    readyState: "complete",
    addEventListener(type, cb) {
      const list = listeners.get(`document:${type}`) || [];
      list.push(cb);
      listeners.set(`document:${type}`, list);
    },
  };

  class EventStub {
    constructor(type) {
      this.type = type;
    }
  }

  const context = vm.createContext({
    window: windowStub,
    document: documentStub,
    navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
    Event: EventStub,
    console: {
      error() {},
      warn() {},
      log() {},
    },
    Date,
    Math,
    Number,
    Promise,
    setTimeout(cb) {
      cb();
      return 1;
    },
    clearTimeout() {},
  });

  vm.runInContext(bridgeSourceFor(windowType, browserWindowId), context, {
    filename: `UTOOLS_BRIDGE.${windowType}.vm.js`,
  });

  function respondToNativeCall(call, payload) {
    const handlers = listeners.get("message") || [];
    handlers.forEach((handler) =>
      handler({
        data: {
          __atools_native_response__: true,
          reqId: call.reqId,
          ...payload,
        },
      }),
    );
  }

  return { windowStub, postedMessages, respondToNativeCall };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const mainVm = createBridgeVm("main", "");

assert.equal(typeof mainVm.windowStub.utools.createBrowserWindow, "function", "utools.createBrowserWindow should be exposed");
const windowOptions = {
  show: false,
  title: "测试窗口",
  webPreferences: { preload: "preload.js" },
};
const callbackCalls = [];
const browserPromise = mainVm.windowStub.utools.createBrowserWindow(
  "test.html",
  windowOptions,
  (channel, ...args) => callbackCalls.push([channel, ...args]),
);
const browserCall = mainVm.postedMessages.find((message) => message.method === "createBrowserWindow");
assert.ok(browserCall, "createBrowserWindow should route through the native bridge");
assert.deepEqual(plain(browserCall.args), {
  url: "test.html",
  options: windowOptions,
  hasCallback: true,
});
mainVm.respondToNativeCall(browserCall, {
  result: {
    id: "browser-window-1",
    type: "browserWindow",
    windowType: "browserWindow",
    url: "test.html",
    title: "测试窗口",
  },
});
const browserWindowHandle = await browserPromise;
assert.equal(browserWindowHandle.id, "browser-window-1");
assert.equal(browserWindowHandle.type, "browserWindow");
assert.equal(browserWindowHandle.windowType, "browserWindow");
assert.equal(browserWindowHandle.url, "test.html");
assert.equal(browserWindowHandle.title, "测试窗口");
assert.equal(typeof browserWindowHandle.webContents, "object", "browser-window handle should expose webContents");
assert.equal(typeof browserWindowHandle.webContents.send, "function", "browser-window webContents should expose send()");
assert.equal(typeof browserWindowHandle.webContents.executeJavaScript, "function", "browser-window webContents should expose executeJavaScript()");
assert.equal(typeof browserWindowHandle.webContents.sendInputEvent, "function", "browser-window webContents should expose sendInputEvent()");
assert.equal(typeof browserWindowHandle.webContents.insertCSS, "function", "browser-window webContents should expose insertCSS()");
assert.equal(typeof browserWindowHandle.webContents.removeInsertedCSS, "function", "browser-window webContents should expose removeInsertedCSS()");
assert.equal(typeof browserWindowHandle.webContents.findInPage, "function", "browser-window webContents should expose findInPage()");
assert.equal(typeof browserWindowHandle.webContents.stopFindInPage, "function", "browser-window webContents should expose stopFindInPage()");
assert.equal(typeof browserWindowHandle.webContents.getURL, "function", "browser-window webContents should expose getURL()");
assert.equal(typeof browserWindowHandle.webContents.getTitle, "function", "browser-window webContents should expose getTitle()");
assert.equal(typeof browserWindowHandle.webContents.isLoading, "function", "browser-window webContents should expose isLoading()");
assert.equal(typeof browserWindowHandle.webContents.isLoadingMainFrame, "function", "browser-window webContents should expose isLoadingMainFrame()");
assert.equal(typeof browserWindowHandle.webContents.isWaitingForResponse, "function", "browser-window webContents should expose isWaitingForResponse()");
assert.equal(typeof browserWindowHandle.webContents.canGoBack, "function", "browser-window webContents should expose canGoBack()");
assert.equal(typeof browserWindowHandle.webContents.canGoForward, "function", "browser-window webContents should expose canGoForward()");
assert.ok(browserWindowHandle.webContents.navigationHistory, "browser-window webContents should expose navigationHistory");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.canGoBack, "function", "browser-window webContents.navigationHistory should expose canGoBack()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.canGoForward, "function", "browser-window webContents.navigationHistory should expose canGoForward()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.goBack, "function", "browser-window webContents.navigationHistory should expose goBack()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.goForward, "function", "browser-window webContents.navigationHistory should expose goForward()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.goToIndex, "function", "browser-window webContents.navigationHistory should expose goToIndex()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.canGoToOffset, "function", "browser-window webContents.navigationHistory should expose canGoToOffset()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.goToOffset, "function", "browser-window webContents.navigationHistory should expose goToOffset()");
assert.equal(typeof browserWindowHandle.webContents.navigationHistory.clear, "function", "browser-window webContents.navigationHistory should expose clear()");
assert.equal(typeof browserWindowHandle.webContents.loadURL, "function", "browser-window webContents should expose loadURL()");
assert.equal(typeof browserWindowHandle.webContents.reload, "function", "browser-window webContents should expose reload()");
assert.equal(typeof browserWindowHandle.webContents.goBack, "function", "browser-window webContents should expose goBack()");
assert.equal(typeof browserWindowHandle.webContents.goForward, "function", "browser-window webContents should expose goForward()");
assert.equal(typeof browserWindowHandle.webContents.reloadIgnoringCache, "function", "browser-window webContents should expose reloadIgnoringCache()");
assert.equal(typeof browserWindowHandle.webContents.stop, "function", "browser-window webContents should expose stop()");
assert.equal(typeof browserWindowHandle.webContents.isDestroyed, "function", "browser-window webContents should expose isDestroyed()");
assert.equal(typeof browserWindowHandle.webContents.getType, "function", "browser-window webContents should expose getType()");
assert.equal(typeof browserWindowHandle.webContents.isCrashed, "function", "browser-window webContents should expose isCrashed()");
assert.equal(typeof browserWindowHandle.webContents.forcefullyCrashRenderer, "function", "browser-window webContents should expose forcefullyCrashRenderer()");
assert.equal(typeof browserWindowHandle.webContents.focus, "function", "browser-window webContents should expose focus()");
assert.equal(typeof browserWindowHandle.webContents.isFocused, "function", "browser-window webContents should expose isFocused()");
assert.equal(typeof browserWindowHandle.webContents.getOwnerBrowserWindow, "function", "browser-window webContents should expose getOwnerBrowserWindow()");
assert.equal(typeof browserWindowHandle.webContents.getMediaSourceId, "function", "browser-window webContents should expose getMediaSourceId()");
assert.equal(typeof browserWindowHandle.webContents.isBeingCaptured, "function", "browser-window webContents should expose isBeingCaptured()");
assert.equal(typeof browserWindowHandle.webContents.setIgnoreMenuShortcuts, "function", "browser-window webContents should expose setIgnoreMenuShortcuts()");
assert.equal(typeof browserWindowHandle.webContents.openDevTools, "function", "browser-window webContents should expose openDevTools()");
assert.equal(typeof browserWindowHandle.webContents.closeDevTools, "function", "browser-window webContents should expose closeDevTools()");
assert.equal(typeof browserWindowHandle.webContents.toggleDevTools, "function", "browser-window webContents should expose toggleDevTools()");
assert.equal(typeof browserWindowHandle.webContents.isDevToolsOpened, "function", "browser-window webContents should expose isDevToolsOpened()");
assert.equal(typeof browserWindowHandle.webContents.isDevToolsFocused, "function", "browser-window webContents should expose isDevToolsFocused()");
assert.equal(typeof browserWindowHandle.webContents.inspectElement, "function", "browser-window webContents should expose inspectElement()");
assert.equal(typeof browserWindowHandle.webContents.capturePage, "function", "browser-window webContents should expose capturePage()");
assert.equal(typeof browserWindowHandle.webContents.print, "function", "browser-window webContents should expose print()");
assert.equal(typeof browserWindowHandle.webContents.printToPDF, "function", "browser-window webContents should expose printToPDF()");
assert.equal(typeof browserWindowHandle.webContents.savePage, "function", "browser-window webContents should expose savePage()");
assert.equal(typeof browserWindowHandle.webContents.getUserAgent, "function", "browser-window webContents should expose getUserAgent()");
assert.equal(typeof browserWindowHandle.webContents.setUserAgent, "function", "browser-window webContents should expose setUserAgent()");
assert.equal(typeof browserWindowHandle.webContents.getFrameRate, "function", "browser-window webContents should expose getFrameRate()");
assert.equal(typeof browserWindowHandle.webContents.setFrameRate, "function", "browser-window webContents should expose setFrameRate()");
assert.equal(typeof browserWindowHandle.webContents.getBackgroundThrottling, "function", "browser-window webContents should expose getBackgroundThrottling()");
assert.equal(typeof browserWindowHandle.webContents.setBackgroundThrottling, "function", "browser-window webContents should expose setBackgroundThrottling()");
assert.equal(typeof browserWindowHandle.webContents.getOSProcessId, "function", "browser-window webContents should expose getOSProcessId()");
assert.equal(typeof browserWindowHandle.webContents.getProcessId, "function", "browser-window webContents should expose getProcessId()");
assert.equal(typeof browserWindowHandle.webContents.centerSelection, "function", "browser-window webContents should expose centerSelection()");
assert.equal(typeof browserWindowHandle.webContents.scrollToTop, "function", "browser-window webContents should expose scrollToTop()");
assert.equal(typeof browserWindowHandle.webContents.scrollToBottom, "function", "browser-window webContents should expose scrollToBottom()");
assert.equal(typeof browserWindowHandle.webContents.adjustSelection, "function", "browser-window webContents should expose adjustSelection()");
assert.equal(typeof browserWindowHandle.webContents.insertText, "function", "browser-window webContents should expose insertText()");
assert.equal(typeof browserWindowHandle.webContents.undo, "function", "browser-window webContents should expose undo()");
assert.equal(typeof browserWindowHandle.webContents.redo, "function", "browser-window webContents should expose redo()");
assert.equal(typeof browserWindowHandle.webContents.cut, "function", "browser-window webContents should expose cut()");
assert.equal(typeof browserWindowHandle.webContents.copy, "function", "browser-window webContents should expose copy()");
assert.equal(typeof browserWindowHandle.webContents.paste, "function", "browser-window webContents should expose paste()");
assert.equal(typeof browserWindowHandle.webContents.pasteAndMatchStyle, "function", "browser-window webContents should expose pasteAndMatchStyle()");
assert.equal(typeof browserWindowHandle.webContents.delete, "function", "browser-window webContents should expose delete()");
assert.equal(typeof browserWindowHandle.webContents.selectAll, "function", "browser-window webContents should expose selectAll()");
assert.equal(typeof browserWindowHandle.webContents.unselect, "function", "browser-window webContents should expose unselect()");
assert.equal(typeof browserWindowHandle.webContents.replace, "function", "browser-window webContents should expose replace()");
assert.equal(typeof browserWindowHandle.webContents.replaceMisspelling, "function", "browser-window webContents should expose replaceMisspelling()");
assert.equal(typeof browserWindowHandle.webContents.setZoomFactor, "function", "browser-window webContents should expose setZoomFactor()");
assert.equal(typeof browserWindowHandle.webContents.getZoomFactor, "function", "browser-window webContents should expose getZoomFactor()");
assert.equal(typeof browserWindowHandle.webContents.setZoomLevel, "function", "browser-window webContents should expose setZoomLevel()");
assert.equal(typeof browserWindowHandle.webContents.getZoomLevel, "function", "browser-window webContents should expose getZoomLevel()");
assert.equal(typeof browserWindowHandle.webContents.setVisualZoomLevelLimits, "function", "browser-window webContents should expose setVisualZoomLevelLimits()");
assert.equal(typeof browserWindowHandle.webContents.setAudioMuted, "function", "browser-window webContents should expose setAudioMuted()");
assert.equal(typeof browserWindowHandle.webContents.isAudioMuted, "function", "browser-window webContents should expose isAudioMuted()");
assert.equal(typeof browserWindowHandle.webContents.isCurrentlyAudible, "function", "browser-window webContents should expose isCurrentlyAudible()");
assert.equal(typeof browserWindowHandle.webContents.on, "function", "browser-window webContents should expose on()");
assert.equal(typeof browserWindowHandle.webContents.addListener, "function", "browser-window webContents should expose addListener()");
assert.equal(typeof browserWindowHandle.webContents.once, "function", "browser-window webContents should expose once()");
assert.equal(typeof browserWindowHandle.webContents.off, "function", "browser-window webContents should expose off()");
assert.equal(typeof browserWindowHandle.webContents.removeListener, "function", "browser-window webContents should expose removeListener()");
assert.equal(typeof browserWindowHandle.webContents.removeAllListeners, "function", "browser-window webContents should expose removeAllListeners()");
assert.equal(typeof browserWindowHandle.show, "function", "browser-window handle should expose show()");
assert.equal(typeof browserWindowHandle.hide, "function", "browser-window handle should expose hide()");
assert.equal(typeof browserWindowHandle.focus, "function", "browser-window handle should expose focus()");
assert.equal(typeof browserWindowHandle.close, "function", "browser-window handle should expose close()");
assert.equal(typeof browserWindowHandle.isDestroyed, "function", "browser-window handle should expose isDestroyed()");
assert.equal(typeof browserWindowHandle.isVisible, "function", "browser-window handle should expose isVisible()");
assert.equal(typeof browserWindowHandle.isFocused, "function", "browser-window handle should expose isFocused()");
assert.equal(typeof browserWindowHandle.showInactive, "function", "browser-window handle should expose showInactive()");
assert.equal(typeof browserWindowHandle.blur, "function", "browser-window handle should expose blur()");
assert.equal(typeof browserWindowHandle.getTitle, "function", "browser-window handle should expose getTitle()");
assert.equal(typeof browserWindowHandle.setTitle, "function", "browser-window handle should expose setTitle()");
assert.equal(typeof browserWindowHandle.getURL, "function", "browser-window handle should expose getURL()");
assert.equal(typeof browserWindowHandle.loadURL, "function", "browser-window handle should expose loadURL()");
assert.equal(typeof browserWindowHandle.reload, "function", "browser-window handle should expose reload()");
assert.equal(typeof browserWindowHandle.minimize, "function", "browser-window handle should expose minimize()");
assert.equal(typeof browserWindowHandle.isMinimized, "function", "browser-window handle should expose isMinimized()");
assert.equal(typeof browserWindowHandle.restore, "function", "browser-window handle should expose restore()");
assert.equal(typeof browserWindowHandle.maximize, "function", "browser-window handle should expose maximize()");
assert.equal(typeof browserWindowHandle.unmaximize, "function", "browser-window handle should expose unmaximize()");
assert.equal(typeof browserWindowHandle.isMaximized, "function", "browser-window handle should expose isMaximized()");
assert.equal(typeof browserWindowHandle.isAlwaysOnTop, "function", "browser-window handle should expose isAlwaysOnTop()");
assert.equal(typeof browserWindowHandle.setAlwaysOnTop, "function", "browser-window handle should expose setAlwaysOnTop()");
assert.equal(typeof browserWindowHandle.getBackgroundColor, "function", "browser-window handle should expose getBackgroundColor()");
assert.equal(typeof browserWindowHandle.setBackgroundColor, "function", "browser-window handle should expose setBackgroundColor()");
assert.equal(typeof browserWindowHandle.setAutoHideMenuBar, "function", "browser-window handle should expose setAutoHideMenuBar()");
assert.equal(typeof browserWindowHandle.isMenuBarAutoHide, "function", "browser-window handle should expose isMenuBarAutoHide()");
assert.equal(typeof browserWindowHandle.setMenuBarVisibility, "function", "browser-window handle should expose setMenuBarVisibility()");
assert.equal(typeof browserWindowHandle.isMenuBarVisible, "function", "browser-window handle should expose isMenuBarVisible()");
assert.equal(typeof browserWindowHandle.removeMenu, "function", "browser-window handle should expose removeMenu()");
assert.equal(typeof browserWindowHandle.setMenu, "function", "browser-window handle should expose setMenu()");
assert.equal(typeof browserWindowHandle.setWindowButtonVisibility, "function", "browser-window handle should expose setWindowButtonVisibility()");
assert.equal(typeof browserWindowHandle.setWindowButtonPosition, "function", "browser-window handle should expose setWindowButtonPosition()");
assert.equal(typeof browserWindowHandle.getWindowButtonPosition, "function", "browser-window handle should expose getWindowButtonPosition()");
assert.equal(typeof browserWindowHandle.setVibrancy, "function", "browser-window handle should expose setVibrancy()");
assert.equal(typeof browserWindowHandle.setBackgroundMaterial, "function", "browser-window handle should expose setBackgroundMaterial()");
assert.equal(typeof browserWindowHandle.setSheetOffset, "function", "browser-window handle should expose setSheetOffset()");
assert.equal(typeof browserWindowHandle.isNormal, "function", "browser-window handle should expose isNormal()");
assert.equal(typeof browserWindowHandle.isModal, "function", "browser-window handle should expose isModal()");
assert.equal(typeof browserWindowHandle.setDocumentEdited, "function", "browser-window handle should expose setDocumentEdited()");
assert.equal(typeof browserWindowHandle.isDocumentEdited, "function", "browser-window handle should expose isDocumentEdited()");
assert.equal(typeof browserWindowHandle.setRepresentedFilename, "function", "browser-window handle should expose setRepresentedFilename()");
assert.equal(typeof browserWindowHandle.getRepresentedFilename, "function", "browser-window handle should expose getRepresentedFilename()");
assert.equal(typeof browserWindowHandle.setParentWindow, "function", "browser-window handle should expose setParentWindow()");
assert.equal(typeof browserWindowHandle.getParentWindow, "function", "browser-window handle should expose getParentWindow()");
assert.equal(typeof browserWindowHandle.getChildWindows, "function", "browser-window handle should expose getChildWindows()");
assert.equal(typeof browserWindowHandle.getBounds, "function", "browser-window handle should expose getBounds()");
assert.equal(typeof browserWindowHandle.setBounds, "function", "browser-window handle should expose setBounds()");
assert.equal(typeof browserWindowHandle.getSize, "function", "browser-window handle should expose getSize()");
assert.equal(typeof browserWindowHandle.setSize, "function", "browser-window handle should expose setSize()");
assert.equal(typeof browserWindowHandle.getContentSize, "function", "browser-window handle should expose getContentSize()");
assert.equal(typeof browserWindowHandle.setContentSize, "function", "browser-window handle should expose setContentSize()");
assert.equal(typeof browserWindowHandle.getMinimumSize, "function", "browser-window handle should expose getMinimumSize()");
assert.equal(typeof browserWindowHandle.setMinimumSize, "function", "browser-window handle should expose setMinimumSize()");
assert.equal(typeof browserWindowHandle.getMaximumSize, "function", "browser-window handle should expose getMaximumSize()");
assert.equal(typeof browserWindowHandle.setMaximumSize, "function", "browser-window handle should expose setMaximumSize()");
assert.equal(typeof browserWindowHandle.setAspectRatio, "function", "browser-window handle should expose setAspectRatio()");
assert.equal(typeof browserWindowHandle.getPosition, "function", "browser-window handle should expose getPosition()");
assert.equal(typeof browserWindowHandle.setPosition, "function", "browser-window handle should expose setPosition()");
assert.equal(typeof browserWindowHandle.center, "function", "browser-window handle should expose center()");
assert.equal(typeof browserWindowHandle.isResizable, "function", "browser-window handle should expose isResizable()");
assert.equal(typeof browserWindowHandle.setResizable, "function", "browser-window handle should expose setResizable()");
assert.equal(typeof browserWindowHandle.isMovable, "function", "browser-window handle should expose isMovable()");
assert.equal(typeof browserWindowHandle.setMovable, "function", "browser-window handle should expose setMovable()");
assert.equal(typeof browserWindowHandle.isClosable, "function", "browser-window handle should expose isClosable()");
assert.equal(typeof browserWindowHandle.setClosable, "function", "browser-window handle should expose setClosable()");
assert.equal(typeof browserWindowHandle.isMinimizable, "function", "browser-window handle should expose isMinimizable()");
assert.equal(typeof browserWindowHandle.setMinimizable, "function", "browser-window handle should expose setMinimizable()");
assert.equal(typeof browserWindowHandle.isMaximizable, "function", "browser-window handle should expose isMaximizable()");
assert.equal(typeof browserWindowHandle.setMaximizable, "function", "browser-window handle should expose setMaximizable()");
assert.equal(typeof browserWindowHandle.isFullScreen, "function", "browser-window handle should expose isFullScreen()");
assert.equal(typeof browserWindowHandle.setFullScreen, "function", "browser-window handle should expose setFullScreen()");
assert.equal(typeof browserWindowHandle.isFullScreenable, "function", "browser-window handle should expose isFullScreenable()");
assert.equal(typeof browserWindowHandle.setFullScreenable, "function", "browser-window handle should expose setFullScreenable()");
assert.equal(typeof browserWindowHandle.getOpacity, "function", "browser-window handle should expose getOpacity()");
assert.equal(typeof browserWindowHandle.setOpacity, "function", "browser-window handle should expose setOpacity()");
assert.equal(typeof browserWindowHandle.hasShadow, "function", "browser-window handle should expose hasShadow()");
assert.equal(typeof browserWindowHandle.setHasShadow, "function", "browser-window handle should expose setHasShadow()");
assert.equal(typeof browserWindowHandle.invalidateShadow, "function", "browser-window handle should expose invalidateShadow()");
assert.equal(typeof browserWindowHandle.setSkipTaskbar, "function", "browser-window handle should expose setSkipTaskbar()");
assert.equal(typeof browserWindowHandle.setKiosk, "function", "browser-window handle should expose setKiosk()");
assert.equal(typeof browserWindowHandle.isKiosk, "function", "browser-window handle should expose isKiosk()");
assert.equal(typeof browserWindowHandle.setVisibleOnAllWorkspaces, "function", "browser-window handle should expose setVisibleOnAllWorkspaces()");
assert.equal(typeof browserWindowHandle.isVisibleOnAllWorkspaces, "function", "browser-window handle should expose isVisibleOnAllWorkspaces()");
assert.equal(typeof browserWindowHandle.setContentProtection, "function", "browser-window handle should expose setContentProtection()");
assert.equal(typeof browserWindowHandle.isContentProtected, "function", "browser-window handle should expose isContentProtected()");
assert.equal(typeof browserWindowHandle.setFocusable, "function", "browser-window handle should expose setFocusable()");
assert.equal(typeof browserWindowHandle.isFocusable, "function", "browser-window handle should expose isFocusable()");
assert.equal(typeof browserWindowHandle.flashFrame, "function", "browser-window handle should expose flashFrame()");
assert.equal(typeof browserWindowHandle.setProgressBar, "function", "browser-window handle should expose setProgressBar()");
assert.equal(typeof browserWindowHandle.getMediaSourceId, "function", "browser-window handle should expose getMediaSourceId()");
assert.equal(typeof browserWindowHandle.moveTop, "function", "browser-window handle should expose moveTop()");
assert.equal(typeof browserWindowHandle.moveAbove, "function", "browser-window handle should expose moveAbove()");
assert.equal(typeof browserWindowHandle.on, "function", "browser-window handle should expose on()");
assert.equal(typeof browserWindowHandle.addListener, "function", "browser-window handle should expose addListener()");
assert.equal(typeof browserWindowHandle.once, "function", "browser-window handle should expose once()");
assert.equal(typeof browserWindowHandle.off, "function", "browser-window handle should expose off()");
assert.equal(typeof browserWindowHandle.removeListener, "function", "browser-window handle should expose removeListener()");
assert.equal(typeof browserWindowHandle.removeAllListeners, "function", "browser-window handle should expose removeAllListeners()");
assert.deepEqual(plain(browserWindowHandle), {
  id: "browser-window-1",
  type: "browserWindow",
  windowType: "browserWindow",
  url: "test.html",
  title: "测试窗口",
});

const browserEventCalls = [];
const focusListener = (...args) => browserEventCalls.push(["focus", ...plain(args)]);
const removedFocusListener = (...args) => browserEventCalls.push(["removed-focus", ...plain(args)]);
const hideListener = (...args) => browserEventCalls.push(["hide", ...plain(args)]);
assert.equal(browserWindowHandle.on("focus", focusListener), browserWindowHandle, "on() should return the handle for chaining");
assert.equal(browserWindowHandle.addListener("focus", removedFocusListener), browserWindowHandle, "addListener() should alias on()");
assert.equal(browserWindowHandle.off("focus", removedFocusListener), browserWindowHandle, "off() should return the handle");
assert.equal(browserWindowHandle.on("hide", hideListener), browserWindowHandle, "on() should register additional events");
assert.equal(browserWindowHandle.removeAllListeners("hide"), browserWindowHandle, "removeAllListeners(event) should return the handle");

mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    event: "focus",
    args: [{ focused: true }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    event: "hide",
    args: [{ visible: false }],
  },
});
assert.deepEqual(browserEventCalls, [["focus", { focused: true }]], "browser-window event listeners should receive host events and removed listeners should stay removed");

const webContentsEventCalls = [];
const foundListener = (event, result) => webContentsEventCalls.push(["found", event?.sender === browserWindowHandle.webContents, plain(result)]);
const removedFoundListener = () => webContentsEventCalls.push(["removed-found"]);
const onceFoundListener = (event, result) => webContentsEventCalls.push(["once-found", event?.sender === browserWindowHandle.webContents, plain(result)]);
const devToolsOpenedListener = (event, result) => webContentsEventCalls.push(["devtools-opened", event?.sender === browserWindowHandle.webContents, plain(result)]);
const devToolsClosedListener = (event, result) => webContentsEventCalls.push(["devtools-closed", event?.sender === browserWindowHandle.webContents, plain(result)]);
const audioStateListener = (event, audible) => webContentsEventCalls.push(["audio", event?.sender === browserWindowHandle.webContents, event?.audible, audible]);
assert.equal(browserWindowHandle.webContents.on("found-in-page", foundListener), browserWindowHandle.webContents, "webContents.on() should return webContents for chaining");
assert.equal(browserWindowHandle.webContents.addListener("found-in-page", removedFoundListener), browserWindowHandle.webContents, "webContents.addListener() should alias on()");
assert.equal(browserWindowHandle.webContents.off("found-in-page", removedFoundListener), browserWindowHandle.webContents, "webContents.off() should return webContents");
assert.equal(browserWindowHandle.webContents.once("found-in-page", onceFoundListener), browserWindowHandle.webContents, "webContents.once() should register one-shot events");
assert.equal(browserWindowHandle.webContents.on("devtools-opened", devToolsOpenedListener), browserWindowHandle.webContents, "webContents.on() should register hosted DevTools opened events");
assert.equal(browserWindowHandle.webContents.once("devtools-closed", devToolsClosedListener), browserWindowHandle.webContents, "webContents.once() should register hosted DevTools closed events");
assert.equal(browserWindowHandle.webContents.on("audio-state-changed", audioStateListener), browserWindowHandle.webContents, "webContents.on() should register hosted audio state events");
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "found-in-page",
    args: [{ requestId: 7, matches: 2, activeMatchOrdinal: 1, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "found-in-page",
    args: [{ requestId: 8, matches: 1, activeMatchOrdinal: 1, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "devtools-opened",
    args: [{ devToolsOpened: true, devToolsFocused: false, devToolsMode: "detach", devToolsTitle: "Hosted DevTools" }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "devtools-closed",
    args: [{ devToolsOpened: false, devToolsFocused: false }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "devtools-closed",
    args: [{ devToolsOpened: false, devToolsFocused: false, repeated: true }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "audio-state-changed",
    args: [true],
  },
});
assert.deepEqual(webContentsEventCalls, [
  ["found", true, { requestId: 7, matches: 2, activeMatchOrdinal: 1, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true }],
  ["once-found", true, { requestId: 7, matches: 2, activeMatchOrdinal: 1, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true }],
  ["found", true, { requestId: 8, matches: 1, activeMatchOrdinal: 1, selectionArea: { x: 0, y: 0, width: 0, height: 0 }, finalUpdate: true }],
  ["devtools-opened", true, { devToolsOpened: true, devToolsFocused: false, devToolsMode: "detach", devToolsTitle: "Hosted DevTools" }],
  ["devtools-closed", true, { devToolsOpened: false, devToolsFocused: false }],
  ["audio", true, true, true],
], "browser-window webContents event listeners should receive targeted found-in-page and DevTools events");
assert.equal(browserWindowHandle.webContents.isCurrentlyAudible(), true, "audio-state-changed should update webContents.isCurrentlyAudible()");

const hidePromise = browserWindowHandle.hide();
const hideCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "hide");
assert.ok(hideCall, "browser-window hide() should route through the native bridge");
assert.deepEqual(plain(hideCall.args), {
  id: "browser-window-1",
  action: "hide",
  args: [],
});
mainVm.respondToNativeCall(hideCall, { result: { visible: false, focused: false, closed: false } });
assert.deepEqual(await hidePromise, { visible: false, focused: false, closed: false });

const showPromise = browserWindowHandle.show();
const showCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "show");
assert.ok(showCall, "browser-window show() should route through the native bridge");
mainVm.respondToNativeCall(showCall, { result: { visible: true, focused: true, closed: false } });
assert.deepEqual(await showPromise, { visible: true, focused: true, closed: false });

const focusPromise = browserWindowHandle.focus();
const focusCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "focus");
assert.ok(focusCall, "browser-window focus() should route through the native bridge");
mainVm.respondToNativeCall(focusCall, { result: { visible: true, focused: true, closed: false } });
assert.deepEqual(await focusPromise, { visible: true, focused: true, closed: false });
assert.equal(browserWindowHandle.isDestroyed(), false, "open hosted browser-window handles should not report destroyed");

const isVisiblePromise = browserWindowHandle.isVisible();
const isVisibleCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isVisible");
assert.ok(isVisibleCall, "browser-window isVisible() should route through the native bridge");
assert.deepEqual(plain(isVisibleCall.args), {
  id: "browser-window-1",
  action: "isVisible",
  args: [],
});
mainVm.respondToNativeCall(isVisibleCall, { result: true });
assert.equal(await isVisiblePromise, true);

const isFocusedPromise = browserWindowHandle.isFocused();
const isFocusedCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isFocused");
assert.ok(isFocusedCall, "browser-window isFocused() should route through the native bridge");
mainVm.respondToNativeCall(isFocusedCall, { result: true });
assert.equal(await isFocusedPromise, true);

const showInactivePromise = browserWindowHandle.showInactive();
const showInactiveCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "showInactive");
assert.ok(showInactiveCall, "browser-window showInactive() should route through the native bridge");
mainVm.respondToNativeCall(showInactiveCall, { result: { visible: true, focused: false, closed: false } });
assert.deepEqual(await showInactivePromise, { visible: true, focused: false, closed: false });

const blurPromise = browserWindowHandle.blur();
const blurCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "blur");
assert.ok(blurCall, "browser-window blur() should route through the native bridge");
mainVm.respondToNativeCall(blurCall, { result: { visible: true, focused: false, closed: false } });
assert.deepEqual(await blurPromise, { visible: true, focused: false, closed: false });
assert.equal(browserWindowHandle.webContents.isFocused(), false, "hosted webContents.isFocused() should mirror blur state");

const webContentsFocusResult = browserWindowHandle.webContents.focus();
assert.equal(webContentsFocusResult, undefined, "webContents.focus() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.isFocused(), true, "webContents.focus() should synchronously focus the hosted page cache");
const webContentsFocusCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.focus");
assert.ok(webContentsFocusCall, "browser-window webContents.focus() should route through the native bridge");
assert.deepEqual(plain(webContentsFocusCall.args), {
  id: "browser-window-1",
  action: "webContents.focus",
  args: [],
});
mainVm.respondToNativeCall(webContentsFocusCall, { result: { visible: true, focused: true, webContentsFocused: true } });

const ignoreMenuShortcutsResult = browserWindowHandle.webContents.setIgnoreMenuShortcuts(true);
assert.equal(ignoreMenuShortcutsResult, undefined, "webContents.setIgnoreMenuShortcuts() should preserve the official void-return shape");
const ignoreMenuShortcutsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setIgnoreMenuShortcuts");
assert.ok(ignoreMenuShortcutsCall, "browser-window webContents.setIgnoreMenuShortcuts() should route through the native bridge");
assert.deepEqual(plain(ignoreMenuShortcutsCall.args), {
  id: "browser-window-1",
  action: "webContents.setIgnoreMenuShortcuts",
  args: [true],
});
mainVm.respondToNativeCall(ignoreMenuShortcutsCall, { result: { ignoreMenuShortcuts: true } });

const getTitlePromise = browserWindowHandle.getTitle();
const getTitleCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getTitle");
assert.ok(getTitleCall, "browser-window getTitle() should route through the native bridge");
mainVm.respondToNativeCall(getTitleCall, { result: "测试窗口" });
assert.equal(await getTitlePromise, "测试窗口");

const setTitlePromise = browserWindowHandle.setTitle("更新标题");
const setTitleCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setTitle");
assert.ok(setTitleCall, "browser-window setTitle() should route through the native bridge");
assert.deepEqual(plain(setTitleCall.args), {
  id: "browser-window-1",
  action: "setTitle",
  args: ["更新标题"],
});
mainVm.respondToNativeCall(setTitleCall, { result: { title: "更新标题" } });
assert.deepEqual(await setTitlePromise, { title: "更新标题" });

const isAlwaysOnTopPromise = browserWindowHandle.isAlwaysOnTop();
const isAlwaysOnTopCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isAlwaysOnTop");
assert.ok(isAlwaysOnTopCall, "browser-window isAlwaysOnTop() should route through the native bridge");
mainVm.respondToNativeCall(isAlwaysOnTopCall, { result: false });
assert.equal(await isAlwaysOnTopPromise, false);

const setAlwaysOnTopPromise = browserWindowHandle.setAlwaysOnTop(true);
const setAlwaysOnTopCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setAlwaysOnTop");
assert.ok(setAlwaysOnTopCall, "browser-window setAlwaysOnTop() should route through the native bridge");
assert.deepEqual(plain(setAlwaysOnTopCall.args), {
  id: "browser-window-1",
  action: "setAlwaysOnTop",
  args: [true],
});
mainVm.respondToNativeCall(setAlwaysOnTopCall, { result: { alwaysOnTop: true } });
assert.deepEqual(await setAlwaysOnTopPromise, { alwaysOnTop: true });

const getUrlPromise = browserWindowHandle.getURL();
const getUrlCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getURL");
assert.ok(getUrlCall, "browser-window getURL() should route through the native bridge");
assert.deepEqual(plain(getUrlCall.args), {
  id: "browser-window-1",
  action: "getURL",
  args: [],
});
mainVm.respondToNativeCall(getUrlCall, { result: "test.html" });
assert.equal(await getUrlPromise, "test.html");
assert.equal(browserWindowHandle.webContents.getURL(), "test.html", "browser-window webContents.getURL() should synchronously return the current hosted URL");
assert.equal(browserWindowHandle.webContents.getTitle(), "测试窗口", "browser-window webContents.getTitle() should synchronously return the current hosted page title");
assert.equal(browserWindowHandle.webContents.isLoading(), false, "new hosted browser-window webContents should not report loading after creation");
assert.equal(browserWindowHandle.webContents.isLoadingMainFrame(), false, "new hosted browser-window webContents main frame should not report loading after creation");
assert.equal(browserWindowHandle.webContents.isWaitingForResponse(), false, "new hosted browser-window WebContents should not be waiting for response");
assert.equal(browserWindowHandle.webContents.canGoBack(), false, "new hosted browser-window webContents should not have back history");
assert.equal(browserWindowHandle.webContents.canGoForward(), false, "new hosted browser-window webContents should not have forward history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoBack(), false, "new hosted browser-window navigationHistory should not have back history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoForward(), false, "new hosted browser-window navigationHistory should not have forward history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoToOffset(1), false, "new hosted browser-window navigationHistory should reject forward offsets without history");
assert.equal(browserWindowHandle.webContents.isDestroyed(), false, "new hosted browser-window webContents should not report destroyed");
assert.equal(browserWindowHandle.webContents.getType(), "window", "hosted browser-window webContents should report window type");
assert.equal(browserWindowHandle.webContents.isCrashed(), false, "new hosted browser-window webContents should not report crashed");
assert.equal(browserWindowHandle.webContents.isFocused(), true, "hosted browser-window webContents should mirror focused window state after focus()");
assert.equal(browserWindowHandle.webContents.getOwnerBrowserWindow(), browserWindowHandle, "hosted webContents.getOwnerBrowserWindow() should return its BrowserWindow handle");
assert.equal(browserWindowHandle.webContents.getMediaSourceId(), "web-contents:1:0", "hosted webContents.getMediaSourceId() should expose a stable WebContents stream id");
assert.equal(browserWindowHandle.webContents.isBeingCaptured(), false, "new hosted browser-window webContents should not report active capture");
assert.equal(browserWindowHandle.webContents.isDevToolsOpened(), false, "new hosted browser-window webContents should not report DevTools open");
assert.equal(browserWindowHandle.webContents.isDevToolsFocused(), false, "new hosted browser-window webContents should not report DevTools focused");
assert.equal(browserWindowHandle.webContents.getZoomFactor(), 1, "new hosted browser-window webContents should default to zoom factor 1");
assert.equal(browserWindowHandle.webContents.getZoomLevel(), 0, "new hosted browser-window webContents should default to zoom level 0");
assert.equal(browserWindowHandle.webContents.isAudioMuted(), false, "new hosted browser-window webContents should not start audio-muted");
assert.equal(browserWindowHandle.webContents.isCurrentlyAudible(), true, "audio-state-changed event should keep the sync audible cache readable");

const loadUrlPromise = browserWindowHandle.loadURL("child-reloaded.html");
const loadUrlCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "loadURL");
assert.ok(loadUrlCall, "browser-window loadURL() should route through the native bridge");
assert.deepEqual(plain(loadUrlCall.args), {
  id: "browser-window-1",
  action: "loadURL",
  args: ["child-reloaded.html"],
});
mainVm.respondToNativeCall(loadUrlCall, { result: { url: "child-reloaded.html", title: "child-reloaded.html", reloaded: false } });
assert.deepEqual(await loadUrlPromise, { url: "child-reloaded.html", title: "child-reloaded.html", reloaded: false });
assert.equal(browserWindowHandle.webContents.getURL(), "child-reloaded.html", "webContents.getURL() should update after loadURL() resolves");
assert.equal(browserWindowHandle.webContents.getTitle(), "child-reloaded.html", "webContents.getTitle() should update after loadURL() resolves");
assert.equal(browserWindowHandle.webContents.canGoBack(), true, "webContents.canGoBack() should become true after loadURL() pushes history");
assert.equal(browserWindowHandle.webContents.canGoForward(), false, "webContents.canGoForward() should stay false at the end of history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoBack(), true, "navigationHistory.canGoBack() should mirror hosted back history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoForward(), false, "navigationHistory.canGoForward() should mirror hosted forward history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoToOffset(-1), true, "navigationHistory.canGoToOffset(-1) should be true when back history exists");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoToOffset(1), false, "navigationHistory.canGoToOffset(1) should be false without forward history");

const reloadPromise = browserWindowHandle.reload();
const reloadCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "reload");
assert.ok(reloadCall, "browser-window reload() should route through the native bridge");
assert.deepEqual(plain(reloadCall.args), {
  id: "browser-window-1",
  action: "reload",
  args: [],
});
mainVm.respondToNativeCall(reloadCall, { result: { url: "child-reloaded.html", title: "child-reloaded.html", reloaded: true } });
assert.deepEqual(await reloadPromise, { url: "child-reloaded.html", title: "child-reloaded.html", reloaded: true });

const webContentsLoadUrlOptions = { userAgent: "AToolsWebContents/240" };
const webContentsLoadUrlPromise = browserWindowHandle.webContents.loadURL("webcontents-loaded.html", webContentsLoadUrlOptions);
const webContentsLoadUrlCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.loadURL");
assert.ok(webContentsLoadUrlCall, "browser-window webContents.loadURL() should route through the native bridge");
assert.deepEqual(plain(webContentsLoadUrlCall.args), {
  id: "browser-window-1",
  action: "webContents.loadURL",
  args: ["webcontents-loaded.html", webContentsLoadUrlOptions],
});
assert.equal(browserWindowHandle.webContents.isLoading(), true, "webContents.loadURL() should synchronously mark hosted WebContents loading");
mainVm.respondToNativeCall(webContentsLoadUrlCall, { result: { url: "webcontents-loaded.html", title: "webcontents-loaded.html", historyIndex: 2, historyLength: 3, loading: false } });
assert.deepEqual(await webContentsLoadUrlPromise, { url: "webcontents-loaded.html", title: "webcontents-loaded.html", historyIndex: 2, historyLength: 3, loading: false });
assert.equal(browserWindowHandle.webContents.getURL(), "webcontents-loaded.html", "webContents.getURL() should update after webContents.loadURL() resolves");
assert.equal(browserWindowHandle.webContents.getTitle(), "webcontents-loaded.html", "webContents.getTitle() should update after webContents.loadURL() resolves");
assert.equal(browserWindowHandle.webContents.isLoading(), false, "webContents.loadURL() should clear loading after the host responds");
assert.equal(browserWindowHandle.webContents.isWaitingForResponse(), false, "webContents.loadURL() should clear waiting-for-response after the host responds");

const webContentsReloadPromise = browserWindowHandle.webContents.reload();
const webContentsReloadCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.reload");
assert.ok(webContentsReloadCall, "browser-window webContents.reload() should route through the native bridge");
assert.deepEqual(plain(webContentsReloadCall.args), {
  id: "browser-window-1",
  action: "webContents.reload",
  args: [],
});
mainVm.respondToNativeCall(webContentsReloadCall, { result: { url: "webcontents-loaded.html", title: "webcontents-loaded.html", reloaded: true, loading: false } });
assert.deepEqual(await webContentsReloadPromise, { url: "webcontents-loaded.html", title: "webcontents-loaded.html", reloaded: true, loading: false });

browserWindowHandle.webContents.loadURL("webcontents-pending.html");
assert.equal(browserWindowHandle.webContents.isLoading(), true, "webContents.loadURL() should leave loading true while the host request is pending");
assert.equal(browserWindowHandle.webContents.isWaitingForResponse(), true, "webContents.loadURL() should leave waiting-for-response true while the host request is pending");
const webContentsStopResult = browserWindowHandle.webContents.stop();
assert.equal(webContentsStopResult, undefined, "browser-window webContents.stop() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.isLoading(), false, "webContents.stop() should synchronously clear hosted loading state");
assert.equal(browserWindowHandle.webContents.isLoadingMainFrame(), false, "webContents.stop() should synchronously clear hosted main-frame loading state");
assert.equal(browserWindowHandle.webContents.isWaitingForResponse(), false, "webContents.stop() should synchronously clear hosted waiting-for-response state");
const webContentsStopCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.stop");
assert.ok(webContentsStopCall, "browser-window webContents.stop() should route through the native bridge");
assert.deepEqual(plain(webContentsStopCall.args), {
  id: "browser-window-1",
  action: "webContents.stop",
  args: [],
});
mainVm.respondToNativeCall(webContentsStopCall, { result: { loading: false } });
await Promise.resolve();

let renderProcessGoneDetails = null;
browserWindowHandle.webContents.on("render-process-gone", (_event, details) => {
  renderProcessGoneDetails = details;
});
const forceCrashResult = browserWindowHandle.webContents.forcefullyCrashRenderer();
assert.equal(forceCrashResult, undefined, "browser-window webContents.forcefullyCrashRenderer() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.isCrashed(), true, "forcefullyCrashRenderer() should synchronously mark hosted WebContents crashed");
const forceCrashCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.forcefullyCrashRenderer");
assert.ok(forceCrashCall, "browser-window webContents.forcefullyCrashRenderer() should route through the native bridge");
assert.deepEqual(plain(forceCrashCall.args), {
  id: "browser-window-1",
  action: "webContents.forcefullyCrashRenderer",
  args: [],
});
mainVm.respondToNativeCall(forceCrashCall, { result: { crashed: true, reason: "crashed", exitCode: 1 } });
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    target: "webContents",
    event: "render-process-gone",
    args: [{ reason: "crashed", exitCode: 1 }],
  },
});
assert.deepEqual(plain(renderProcessGoneDetails), { reason: "crashed", exitCode: 1 }, "forcefullyCrashRenderer() should surface targeted render-process-gone details");
assert.equal(browserWindowHandle.webContents.isCrashed(), true, "render-process-gone should keep hosted crash state readable");

const reloadIgnoringCachePromise = browserWindowHandle.webContents.reloadIgnoringCache();
const reloadIgnoringCacheCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.reloadIgnoringCache");
assert.ok(reloadIgnoringCacheCall, "browser-window webContents.reloadIgnoringCache() should route through the native bridge");
assert.deepEqual(plain(reloadIgnoringCacheCall.args), {
  id: "browser-window-1",
  action: "webContents.reloadIgnoringCache",
  args: [],
});
mainVm.respondToNativeCall(reloadIgnoringCacheCall, { result: { url: "child-reloaded.html", title: "child-reloaded.html", reloaded: true, ignoreCache: true } });
assert.deepEqual(await reloadIgnoringCachePromise, { url: "child-reloaded.html", title: "child-reloaded.html", reloaded: true, ignoreCache: true });

const goBackPromise = browserWindowHandle.webContents.goBack();
const goBackCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.goBack");
assert.ok(goBackCall, "browser-window webContents.goBack() should route through the native bridge");
assert.deepEqual(plain(goBackCall.args), {
  id: "browser-window-1",
  action: "webContents.goBack",
  args: [],
});
mainVm.respondToNativeCall(goBackCall, { result: { url: "test.html", title: "测试窗口", historyIndex: 0, historyLength: 2 } });
assert.deepEqual(await goBackPromise, { url: "test.html", title: "测试窗口", historyIndex: 0, historyLength: 2 });
assert.equal(browserWindowHandle.webContents.getURL(), "test.html", "webContents.getURL() should update after goBack() resolves");
assert.equal(browserWindowHandle.webContents.canGoBack(), false, "webContents.canGoBack() should be false at first history entry");
assert.equal(browserWindowHandle.webContents.canGoForward(), true, "webContents.canGoForward() should be true after goBack()");

const goForwardPromise = browserWindowHandle.webContents.goForward();
const goForwardCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.goForward");
assert.ok(goForwardCall, "browser-window webContents.goForward() should route through the native bridge");
assert.deepEqual(plain(goForwardCall.args), {
  id: "browser-window-1",
  action: "webContents.goForward",
  args: [],
});
mainVm.respondToNativeCall(goForwardCall, { result: { url: "child-reloaded.html", title: "child-reloaded.html", historyIndex: 1, historyLength: 2 } });
assert.deepEqual(await goForwardPromise, { url: "child-reloaded.html", title: "child-reloaded.html", historyIndex: 1, historyLength: 2 });
assert.equal(browserWindowHandle.webContents.getURL(), "child-reloaded.html", "webContents.getURL() should update after goForward() resolves");
assert.equal(browserWindowHandle.webContents.canGoBack(), true, "webContents.canGoBack() should be true after goForward()");
assert.equal(browserWindowHandle.webContents.canGoForward(), false, "webContents.canGoForward() should be false at latest history entry");

const navigationGoToOffsetResult = browserWindowHandle.webContents.navigationHistory.goToOffset(-1);
assert.equal(navigationGoToOffsetResult, undefined, "navigationHistory.goToOffset() should preserve the official void-return shape");
const navigationGoToOffsetCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.navigationHistory.goToOffset");
assert.ok(navigationGoToOffsetCall, "browser-window webContents.navigationHistory.goToOffset() should route through the native bridge");
assert.deepEqual(plain(navigationGoToOffsetCall.args), {
  id: "browser-window-1",
  action: "webContents.navigationHistory.goToOffset",
  args: [-1],
});
mainVm.respondToNativeCall(navigationGoToOffsetCall, { result: { url: "test.html", title: "测试窗口", historyIndex: 0, historyLength: 2, loading: false } });
await Promise.resolve();
assert.equal(browserWindowHandle.webContents.getURL(), "test.html", "navigationHistory.goToOffset() should synchronize hosted URL");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoBack(), false, "navigationHistory.goToOffset() should update back history state");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoForward(), true, "navigationHistory.goToOffset() should update forward history state");

const navigationGoForwardResult = browserWindowHandle.webContents.navigationHistory.goForward();
assert.equal(navigationGoForwardResult, undefined, "navigationHistory.goForward() should preserve the official void-return shape");
const navigationGoForwardCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.navigationHistory.goForward");
assert.ok(navigationGoForwardCall, "browser-window webContents.navigationHistory.goForward() should route through the native bridge");
mainVm.respondToNativeCall(navigationGoForwardCall, { result: { url: "child-reloaded.html", title: "child-reloaded.html", historyIndex: 1, historyLength: 2, loading: false } });
await Promise.resolve();
assert.equal(browserWindowHandle.webContents.getURL(), "child-reloaded.html", "navigationHistory.goForward() should synchronize hosted URL");

const navigationGoToIndexResult = browserWindowHandle.webContents.navigationHistory.goToIndex(0);
assert.equal(navigationGoToIndexResult, undefined, "navigationHistory.goToIndex() should preserve the official void-return shape");
const navigationGoToIndexCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.navigationHistory.goToIndex");
assert.ok(navigationGoToIndexCall, "browser-window webContents.navigationHistory.goToIndex() should route through the native bridge");
assert.deepEqual(plain(navigationGoToIndexCall.args), {
  id: "browser-window-1",
  action: "webContents.navigationHistory.goToIndex",
  args: [0],
});
mainVm.respondToNativeCall(navigationGoToIndexCall, { result: { url: "test.html", title: "测试窗口", historyIndex: 0, historyLength: 2, loading: false } });
await Promise.resolve();

const navigationClearResult = browserWindowHandle.webContents.navigationHistory.clear();
assert.equal(navigationClearResult, undefined, "navigationHistory.clear() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoBack(), false, "navigationHistory.clear() should synchronously clear back history");
assert.equal(browserWindowHandle.webContents.navigationHistory.canGoForward(), false, "navigationHistory.clear() should synchronously clear forward history");
const navigationClearCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.navigationHistory.clear");
assert.ok(navigationClearCall, "browser-window webContents.navigationHistory.clear() should route through the native bridge");
assert.deepEqual(plain(navigationClearCall.args), {
  id: "browser-window-1",
  action: "webContents.navigationHistory.clear",
  args: [],
});
mainVm.respondToNativeCall(navigationClearCall, { result: { url: "test.html", title: "测试窗口", historyIndex: 0, historyLength: 1, loading: false } });
await Promise.resolve();

assert.equal(browserWindowHandle.getBackgroundColor(), "#ffffff", "new hosted browser-window should default to white background color");
const setBackgroundColorResult = browserWindowHandle.setBackgroundColor("rgb(16, 32, 48)");
assert.equal(setBackgroundColorResult, undefined, "browser-window setBackgroundColor() should preserve the official void-return shape");
assert.equal(browserWindowHandle.getBackgroundColor(), "#102030", "browser-window getBackgroundColor() should return normalized #RRGGBB after setBackgroundColor()");
const setBackgroundColorCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setBackgroundColor");
assert.ok(setBackgroundColorCall, "browser-window setBackgroundColor() should route through the native bridge");
assert.deepEqual(plain(setBackgroundColorCall.args), {
  id: "browser-window-1",
  action: "setBackgroundColor",
  args: ["#102030"],
});
mainVm.respondToNativeCall(setBackgroundColorCall, { result: { backgroundColor: "#102030" } });
await Promise.resolve();

assert.equal(browserWindowHandle.isMenuBarAutoHide(), false, "new hosted browser-window should not auto-hide the menu bar");
assert.equal(browserWindowHandle.isMenuBarVisible(), true, "new hosted browser-window should default to a visible hosted menu bar");
const setAutoHideMenuBarResult = browserWindowHandle.setAutoHideMenuBar(true);
assert.equal(setAutoHideMenuBarResult, undefined, "browser-window setAutoHideMenuBar() should preserve the official void-return shape");
assert.equal(browserWindowHandle.isMenuBarAutoHide(), true, "browser-window isMenuBarAutoHide() should synchronously reflect setAutoHideMenuBar()");
const setAutoHideMenuBarCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setAutoHideMenuBar");
assert.ok(setAutoHideMenuBarCall, "browser-window setAutoHideMenuBar() should route through the native bridge");
assert.deepEqual(plain(setAutoHideMenuBarCall.args), {
  id: "browser-window-1",
  action: "setAutoHideMenuBar",
  args: [true],
});
mainVm.respondToNativeCall(setAutoHideMenuBarCall, { result: { menuBarAutoHide: true } });
await Promise.resolve();

const setMenuBarVisibilityResult = browserWindowHandle.setMenuBarVisibility(false);
assert.equal(setMenuBarVisibilityResult, undefined, "browser-window setMenuBarVisibility() should preserve the official void-return shape");
assert.equal(browserWindowHandle.isMenuBarVisible(), false, "browser-window isMenuBarVisible() should synchronously reflect setMenuBarVisibility(false)");
const setMenuBarVisibilityCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setMenuBarVisibility");
assert.ok(setMenuBarVisibilityCall, "browser-window setMenuBarVisibility() should route through the native bridge");
assert.deepEqual(plain(setMenuBarVisibilityCall.args), {
  id: "browser-window-1",
  action: "setMenuBarVisibility",
  args: [false],
});
mainVm.respondToNativeCall(setMenuBarVisibilityCall, { result: { menuBarVisible: false } });
await Promise.resolve();

const removeMenuResult = browserWindowHandle.removeMenu();
assert.equal(removeMenuResult, undefined, "browser-window removeMenu() should preserve the official void-return shape");
assert.equal(browserWindowHandle.isMenuBarVisible(), false, "browser-window removeMenu() should keep the hosted menu bar hidden");
const removeMenuCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "removeMenu");
assert.ok(removeMenuCall, "browser-window removeMenu() should route through the native bridge");
assert.deepEqual(plain(removeMenuCall.args), {
  id: "browser-window-1",
  action: "removeMenu",
  args: [],
});
mainVm.respondToNativeCall(removeMenuCall, { result: { menuBarVisible: false, menuRemoved: true } });
await Promise.resolve();

const hostedMenu = { items: [{ label: "File" }] };
const setMenuResult = browserWindowHandle.setMenu(hostedMenu);
assert.equal(setMenuResult, undefined, "browser-window setMenu() should preserve the official void-return shape");
assert.equal(browserWindowHandle.isMenuBarVisible(), true, "browser-window setMenu(menu) should make the hosted menu bar visible again");
const setMenuCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setMenu");
assert.ok(setMenuCall, "browser-window setMenu() should route through the native bridge");
assert.deepEqual(plain(setMenuCall.args), {
  id: "browser-window-1",
  action: "setMenu",
  args: [hostedMenu],
});
mainVm.respondToNativeCall(setMenuCall, { result: { menuBarVisible: true, menuRemoved: false } });
await Promise.resolve();

const setMenuNullResult = browserWindowHandle.setMenu(null);
assert.equal(setMenuNullResult, undefined, "browser-window setMenu(null) should preserve the official void-return shape");
assert.equal(browserWindowHandle.isMenuBarVisible(), false, "browser-window setMenu(null) should remove and hide the hosted menu bar");
const setMenuNullCall = mainVm.postedMessages.find((message) =>
  message.method === "browserWindowAction"
    && message.args.action === "setMenu"
    && message.args.args
    && message.args.args[0] === null
);
assert.ok(setMenuNullCall, "browser-window setMenu(null) should route through the native bridge");
assert.deepEqual(plain(setMenuNullCall.args), {
  id: "browser-window-1",
  action: "setMenu",
  args: [null],
});
mainVm.respondToNativeCall(setMenuNullCall, { result: { menuBarVisible: false, menuRemoved: true } });
await Promise.resolve();

const setWindowButtonVisibilityResult = browserWindowHandle.setWindowButtonVisibility(false);
assert.equal(setWindowButtonVisibilityResult, undefined, "browser-window setWindowButtonVisibility() should preserve the official void-return shape");
const setWindowButtonVisibilityCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setWindowButtonVisibility");
assert.ok(setWindowButtonVisibilityCall, "browser-window setWindowButtonVisibility() should route through the native bridge");
assert.deepEqual(plain(setWindowButtonVisibilityCall.args), {
  id: "browser-window-1",
  action: "setWindowButtonVisibility",
  args: [false],
});
mainVm.respondToNativeCall(setWindowButtonVisibilityCall, { result: { windowButtonVisible: false } });
await Promise.resolve();

assert.equal(browserWindowHandle.getWindowButtonPosition(), null, "new hosted browser-window should default to system window button position");
const setWindowButtonPositionResult = browserWindowHandle.setWindowButtonPosition({ x: 18, y: 9 });
assert.equal(setWindowButtonPositionResult, undefined, "browser-window setWindowButtonPosition() should preserve the official void-return shape");
assert.deepEqual(plain(browserWindowHandle.getWindowButtonPosition()), { x: 18, y: 9 }, "browser-window getWindowButtonPosition() should synchronously reflect setWindowButtonPosition()");
const setWindowButtonPositionCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setWindowButtonPosition");
assert.ok(setWindowButtonPositionCall, "browser-window setWindowButtonPosition() should route through the native bridge");
assert.deepEqual(plain(setWindowButtonPositionCall.args), {
  id: "browser-window-1",
  action: "setWindowButtonPosition",
  args: [{ x: 18, y: 9 }],
});
mainVm.respondToNativeCall(setWindowButtonPositionCall, { result: { windowButtonPosition: { x: 18, y: 9 } } });
await Promise.resolve();

const resetWindowButtonPositionResult = browserWindowHandle.setWindowButtonPosition(null);
assert.equal(resetWindowButtonPositionResult, undefined, "browser-window setWindowButtonPosition(null) should preserve the official void-return shape");
assert.equal(browserWindowHandle.getWindowButtonPosition(), null, "browser-window setWindowButtonPosition(null) should reset to system window button position");
const resetWindowButtonPositionCall = mainVm.postedMessages.find((message) =>
  message.method === "browserWindowAction"
    && message.args.action === "setWindowButtonPosition"
    && message.args.args
    && message.args.args[0] === null
);
assert.ok(resetWindowButtonPositionCall, "browser-window setWindowButtonPosition(null) should route through the native bridge");
assert.deepEqual(plain(resetWindowButtonPositionCall.args), {
  id: "browser-window-1",
  action: "setWindowButtonPosition",
  args: [null],
});
mainVm.respondToNativeCall(resetWindowButtonPositionCall, { result: { windowButtonPosition: null } });
await Promise.resolve();

const setVibrancyResult = browserWindowHandle.setVibrancy("sidebar", { animationDuration: 120 });
assert.equal(setVibrancyResult, undefined, "browser-window setVibrancy() should preserve the official void-return shape");
const setVibrancyCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setVibrancy");
assert.ok(setVibrancyCall, "browser-window setVibrancy() should route through the native bridge");
assert.deepEqual(plain(setVibrancyCall.args), {
  id: "browser-window-1",
  action: "setVibrancy",
  args: ["sidebar", { animationDuration: 120 }],
});
mainVm.respondToNativeCall(setVibrancyCall, { result: { vibrancy: "sidebar", vibrancyOptions: { animationDuration: 120 } } });
await Promise.resolve();

const clearVibrancyResult = browserWindowHandle.setVibrancy(null);
assert.equal(clearVibrancyResult, undefined, "browser-window setVibrancy(null) should preserve the official void-return shape");
const clearVibrancyCall = mainVm.postedMessages.find((message) =>
  message.method === "browserWindowAction"
    && message.args.action === "setVibrancy"
    && message.args.args
    && message.args.args[0] === null
);
assert.ok(clearVibrancyCall, "browser-window setVibrancy(null) should route through the native bridge");
assert.deepEqual(plain(clearVibrancyCall.args), {
  id: "browser-window-1",
  action: "setVibrancy",
  args: [null, {}],
});
mainVm.respondToNativeCall(clearVibrancyCall, { result: { vibrancy: "", vibrancyOptions: {} } });
await Promise.resolve();

const setBackgroundMaterialResult = browserWindowHandle.setBackgroundMaterial("under-window");
assert.equal(setBackgroundMaterialResult, undefined, "browser-window setBackgroundMaterial() should preserve the official void-return shape");
const setBackgroundMaterialCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setBackgroundMaterial");
assert.ok(setBackgroundMaterialCall, "browser-window setBackgroundMaterial() should route through the native bridge");
assert.deepEqual(plain(setBackgroundMaterialCall.args), {
  id: "browser-window-1",
  action: "setBackgroundMaterial",
  args: ["under-window"],
});
mainVm.respondToNativeCall(setBackgroundMaterialCall, { result: { backgroundMaterial: "under-window" } });
await Promise.resolve();

const setSheetOffsetResult = browserWindowHandle.setSheetOffset(44, 12);
assert.equal(setSheetOffsetResult, undefined, "browser-window setSheetOffset() should preserve the official void-return shape");
const setSheetOffsetCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setSheetOffset");
assert.ok(setSheetOffsetCall, "browser-window setSheetOffset() should route through the native bridge");
assert.deepEqual(plain(setSheetOffsetCall.args), {
  id: "browser-window-1",
  action: "setSheetOffset",
  args: [44, 12],
});
mainVm.respondToNativeCall(setSheetOffsetCall, { result: { sheetOffsetY: 44, sheetOffsetX: 12 } });
await Promise.resolve();

assert.equal(browserWindowHandle.isNormal(), true, "new hosted browser-window should start in normal window state");
assert.equal(browserWindowHandle.isModal(), false, "new hosted browser-window should not start modal unless requested");
assert.equal(browserWindowHandle.isDocumentEdited(), false, "new hosted browser-window should not start document-edited");
assert.equal(browserWindowHandle.getRepresentedFilename(), "", "new hosted browser-window should not start with a represented filename");
assert.equal(browserWindowHandle.getParentWindow(), null, "new hosted browser-window should not start with a parent window");
assert.deepEqual(plain(browserWindowHandle.getChildWindows()), [], "new hosted browser-window should not start with child windows");

const setDocumentEditedResult = browserWindowHandle.setDocumentEdited(true);
assert.equal(setDocumentEditedResult, undefined, "browser-window setDocumentEdited() should preserve the official void-return shape");
assert.equal(browserWindowHandle.isDocumentEdited(), true, "browser-window isDocumentEdited() should synchronously reflect setDocumentEdited()");
const setDocumentEditedCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setDocumentEdited");
assert.ok(setDocumentEditedCall, "browser-window setDocumentEdited() should route through the native bridge");
assert.deepEqual(plain(setDocumentEditedCall.args), {
  id: "browser-window-1",
  action: "setDocumentEdited",
  args: [true],
});
mainVm.respondToNativeCall(setDocumentEditedCall, { result: { documentEdited: true } });
await Promise.resolve();

const setRepresentedFilenameResult = browserWindowHandle.setRepresentedFilename("/tmp/atools-browser-window-document.md");
assert.equal(setRepresentedFilenameResult, undefined, "browser-window setRepresentedFilename() should preserve the official void-return shape");
assert.equal(browserWindowHandle.getRepresentedFilename(), "/tmp/atools-browser-window-document.md", "browser-window getRepresentedFilename() should synchronously reflect setRepresentedFilename()");
const setRepresentedFilenameCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setRepresentedFilename");
assert.ok(setRepresentedFilenameCall, "browser-window setRepresentedFilename() should route through the native bridge");
assert.deepEqual(plain(setRepresentedFilenameCall.args), {
  id: "browser-window-1",
  action: "setRepresentedFilename",
  args: ["/tmp/atools-browser-window-document.md"],
});
mainVm.respondToNativeCall(setRepresentedFilenameCall, { result: { representedFilename: "/tmp/atools-browser-window-document.md" } });
await Promise.resolve();

const parentBrowserPromise = mainVm.windowStub.utools.createBrowserWindow(
  "parent.html",
  { title: "父窗口", show: false, modal: true },
);
const parentBrowserCall = mainVm.postedMessages.find((message) => message.method === "createBrowserWindow" && message.args.url === "parent.html");
assert.ok(parentBrowserCall, "parent createBrowserWindow should route through the native bridge");
mainVm.respondToNativeCall(parentBrowserCall, {
  result: {
    id: "browser-window-parent",
    type: "browserWindow",
    windowType: "browserWindow",
    url: "parent.html",
    title: "父窗口",
    modal: true,
  },
});
const parentBrowserWindowHandle = await parentBrowserPromise;
assert.equal(parentBrowserWindowHandle.isModal(), true, "hosted browser-window should expose modal state from creation");
assert.deepEqual(plain(parentBrowserWindowHandle.getChildWindows()), [], "new hosted parent window should start without child windows");

const setParentWindowResult = browserWindowHandle.setParentWindow(parentBrowserWindowHandle);
assert.equal(setParentWindowResult, undefined, "browser-window setParentWindow() should preserve the official void-return shape");
assert.equal(browserWindowHandle.getParentWindow(), parentBrowserWindowHandle, "browser-window getParentWindow() should synchronously return the hosted parent handle");
assert.deepEqual(plain(parentBrowserWindowHandle.getChildWindows().map((win) => win.id)), ["browser-window-1"], "parent getChildWindows() should synchronously include hosted child handles");
const setParentWindowCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setParentWindow");
assert.ok(setParentWindowCall, "browser-window setParentWindow() should route through the native bridge");
assert.deepEqual(plain(setParentWindowCall.args), {
  id: "browser-window-1",
  action: "setParentWindow",
  args: ["browser-window-parent"],
});
mainVm.respondToNativeCall(setParentWindowCall, { result: { parentWindowId: "browser-window-parent" } });
await Promise.resolve();

const resetParentWindowResult = browserWindowHandle.setParentWindow(null);
assert.equal(resetParentWindowResult, undefined, "browser-window setParentWindow(null) should preserve the official void-return shape");
assert.equal(browserWindowHandle.getParentWindow(), null, "browser-window setParentWindow(null) should clear the hosted parent handle");
assert.deepEqual(plain(parentBrowserWindowHandle.getChildWindows()), [], "parent getChildWindows() should update after clearing hosted parent");
const resetParentWindowCall = mainVm.postedMessages.find((message) =>
  message.method === "browserWindowAction"
    && message.args.action === "setParentWindow"
    && message.args.args
    && message.args.args[0] === null
);
assert.ok(resetParentWindowCall, "browser-window setParentWindow(null) should route through the native bridge");
assert.deepEqual(plain(resetParentWindowCall.args), {
  id: "browser-window-1",
  action: "setParentWindow",
  args: [null],
});
mainVm.respondToNativeCall(resetParentWindowCall, { result: { parentWindowId: null } });
await Promise.resolve();

const openDevToolsOptions = { mode: "detach", activate: false, title: "Hosted DevTools" };
const openDevToolsPromise = browserWindowHandle.webContents.openDevTools(openDevToolsOptions);
const openDevToolsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.openDevTools");
assert.ok(openDevToolsCall, "browser-window webContents.openDevTools() should route through the native bridge");
assert.deepEqual(plain(openDevToolsCall.args), {
  id: "browser-window-1",
  action: "webContents.openDevTools",
  args: [openDevToolsOptions],
});
mainVm.respondToNativeCall(openDevToolsCall, { result: { devToolsOpened: true, devToolsFocused: false, devToolsMode: "detach", devToolsTitle: "Hosted DevTools" } });
assert.deepEqual(await openDevToolsPromise, { devToolsOpened: true, devToolsFocused: false, devToolsMode: "detach", devToolsTitle: "Hosted DevTools" });
assert.equal(browserWindowHandle.webContents.isDevToolsOpened(), true, "webContents.isDevToolsOpened() should update after openDevTools() resolves");
assert.equal(browserWindowHandle.webContents.isDevToolsFocused(), false, "webContents.isDevToolsFocused() should honor activate:false after openDevTools()");

const toggleDevToolsPromise = browserWindowHandle.webContents.toggleDevTools();
const toggleDevToolsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.toggleDevTools");
assert.ok(toggleDevToolsCall, "browser-window webContents.toggleDevTools() should route through the native bridge");
assert.deepEqual(plain(toggleDevToolsCall.args), {
  id: "browser-window-1",
  action: "webContents.toggleDevTools",
  args: [],
});
mainVm.respondToNativeCall(toggleDevToolsCall, { result: { devToolsOpened: false, devToolsFocused: false } });
assert.deepEqual(await toggleDevToolsPromise, { devToolsOpened: false, devToolsFocused: false });
assert.equal(browserWindowHandle.webContents.isDevToolsOpened(), false, "webContents.isDevToolsOpened() should update after toggleDevTools() closes DevTools");
assert.equal(browserWindowHandle.webContents.isDevToolsFocused(), false, "webContents.isDevToolsFocused() should be false after toggleDevTools() closes DevTools");

const focusedDevToolsPromise = browserWindowHandle.webContents.openDevTools({ mode: "bottom" });
const focusedDevToolsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.openDevTools" && message !== openDevToolsCall);
assert.ok(focusedDevToolsCall, "browser-window webContents.openDevTools() should support a second hosted DevTools open");
mainVm.respondToNativeCall(focusedDevToolsCall, { result: { devToolsOpened: true, devToolsFocused: true, devToolsMode: "bottom", devToolsTitle: "" } });
assert.deepEqual(await focusedDevToolsPromise, { devToolsOpened: true, devToolsFocused: true, devToolsMode: "bottom", devToolsTitle: "" });
assert.equal(browserWindowHandle.webContents.isDevToolsOpened(), true, "webContents.isDevToolsOpened() should be true after focused openDevTools()");
assert.equal(browserWindowHandle.webContents.isDevToolsFocused(), true, "webContents.isDevToolsFocused() should default to focused when activate is not false");

const closeDevToolsPromise = browserWindowHandle.webContents.closeDevTools();
const closeDevToolsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.closeDevTools");
assert.ok(closeDevToolsCall, "browser-window webContents.closeDevTools() should route through the native bridge");
assert.deepEqual(plain(closeDevToolsCall.args), {
  id: "browser-window-1",
  action: "webContents.closeDevTools",
  args: [],
});
mainVm.respondToNativeCall(closeDevToolsCall, { result: { devToolsOpened: false, devToolsFocused: false } });
assert.deepEqual(await closeDevToolsPromise, { devToolsOpened: false, devToolsFocused: false });
assert.equal(browserWindowHandle.webContents.isDevToolsOpened(), false, "webContents.isDevToolsOpened() should update after closeDevTools()");
assert.equal(browserWindowHandle.webContents.isDevToolsFocused(), false, "webContents.isDevToolsFocused() should update after closeDevTools()");

const isolatedUnsupportedPattern = /ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED/;
const inspectCallCount = mainVm.postedMessages.filter((message) => message.method === "browserWindowAction" && message.args.action === "webContents.inspectElement").length;
assert.throws(
  () => browserWindowHandle.webContents.inspectElement(12, 8),
  isolatedUnsupportedPattern,
  "browser-window webContents.inspectElement() should fail explicitly without touching isolated child DOM",
);
assert.equal(
  mainVm.postedMessages.filter((message) => message.method === "browserWindowAction" && message.args.action === "webContents.inspectElement").length,
  inspectCallCount,
  "inspectElement should fail locally instead of sending an impossible DOM request",
);

const capturePageRect = { x: 1, y: 2, width: 320, height: 180 };
const capturePageOptions = { stayHidden: true, stayAwake: false };
const capturePagePromise = browserWindowHandle.webContents.capturePage(capturePageRect, capturePageOptions);
const capturePageCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.capturePage");
assert.ok(capturePageCall, "browser-window webContents.capturePage() should route through the native bridge");
assert.deepEqual(plain(capturePageCall.args), {
  id: "browser-window-1",
  action: "webContents.capturePage",
  args: [capturePageRect, capturePageOptions],
});
mainVm.respondToNativeCall(capturePageCall, {
  error: "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED: webContents.capturePage is unavailable for an isolated hosted BrowserWindow",
});
await assert.rejects(capturePagePromise, isolatedUnsupportedPattern);

const printCallbacks = [];
const printResult = browserWindowHandle.webContents.print({ silent: true, printBackground: true }, (success, failureReason) => {
  printCallbacks.push([success, failureReason]);
});
assert.equal(printResult, undefined, "browser-window webContents.print() should preserve the official void-return shape");
const printCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.print");
assert.ok(printCall, "browser-window webContents.print() should route through the native bridge");
assert.deepEqual(plain(printCall.args), {
  id: "browser-window-1",
  action: "webContents.print",
  args: [{ silent: true, printBackground: true }],
});
mainVm.respondToNativeCall(printCall, { result: { success: false, failureReason: "webContents.print is native-only in hosted BrowserWindow" } });
await Promise.resolve();
assert.deepEqual(printCallbacks, [[false, "webContents.print is native-only in hosted BrowserWindow"]], "webContents.print() should invoke the callback with success and failure reason");

const pdfPromise = browserWindowHandle.webContents.printToPDF({ landscape: true, printBackground: true });
const pdfCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.printToPDF");
assert.ok(pdfCall, "browser-window webContents.printToPDF() should route through the native bridge");
assert.deepEqual(plain(pdfCall.args), {
  id: "browser-window-1",
  action: "webContents.printToPDF",
  args: [{ landscape: true, printBackground: true }],
});
mainVm.respondToNativeCall(pdfCall, { error: "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED: webContents.printToPDF is unavailable for an isolated hosted BrowserWindow" });
await assert.rejects(pdfPromise, isolatedUnsupportedPattern);

const savePagePromise = browserWindowHandle.webContents.savePage("/tmp/atools-browser-window.html", "HTMLComplete");
const savePageCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.savePage");
assert.ok(savePageCall, "browser-window webContents.savePage() should route through the native bridge");
assert.deepEqual(plain(savePageCall.args), {
  id: "browser-window-1",
  action: "webContents.savePage",
  args: ["/tmp/atools-browser-window.html", "HTMLComplete"],
});
mainVm.respondToNativeCall(savePageCall, { error: "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED: webContents.savePage is unavailable for an isolated hosted BrowserWindow" });
await assert.rejects(savePagePromise, isolatedUnsupportedPattern);

assert.equal(browserWindowHandle.webContents.getUserAgent(), "Mozilla/5.0 (Macintosh)", "webContents.getUserAgent() should default to the hosted frame user agent");
assert.equal(browserWindowHandle.webContents.getFrameRate(), 60, "webContents.getFrameRate() should default to 60 in hosted BrowserWindow compatibility");
assert.equal(browserWindowHandle.webContents.getBackgroundThrottling(), true, "webContents.getBackgroundThrottling() should default to true");
assert.equal(Number.isInteger(browserWindowHandle.webContents.getProcessId()) && browserWindowHandle.webContents.getProcessId() > 0, true, "webContents.getProcessId() should return a positive hosted process id");
assert.equal(Number.isInteger(browserWindowHandle.webContents.getOSProcessId()) && browserWindowHandle.webContents.getOSProcessId() > 0, true, "webContents.getOSProcessId() should return a positive hosted OS process id");

const setUserAgentResult = browserWindowHandle.webContents.setUserAgent("AToolsHosted/239");
assert.equal(setUserAgentResult, undefined, "browser-window webContents.setUserAgent() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.getUserAgent(), "AToolsHosted/239", "webContents.getUserAgent() should update synchronously after setUserAgent()");
const setUserAgentCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setUserAgent");
assert.ok(setUserAgentCall, "browser-window webContents.setUserAgent() should route through the native bridge");
assert.deepEqual(plain(setUserAgentCall.args), {
  id: "browser-window-1",
  action: "webContents.setUserAgent",
  args: ["AToolsHosted/239"],
});
mainVm.respondToNativeCall(setUserAgentCall, { result: { userAgent: "AToolsHosted/239" } });
await Promise.resolve();

const setFrameRateResult = browserWindowHandle.webContents.setFrameRate(24);
assert.equal(setFrameRateResult, undefined, "browser-window webContents.setFrameRate() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.getFrameRate(), 24, "webContents.getFrameRate() should update synchronously after setFrameRate()");
const setFrameRateCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setFrameRate");
assert.ok(setFrameRateCall, "browser-window webContents.setFrameRate() should route through the native bridge");
assert.deepEqual(plain(setFrameRateCall.args), {
  id: "browser-window-1",
  action: "webContents.setFrameRate",
  args: [24],
});
mainVm.respondToNativeCall(setFrameRateCall, { result: { frameRate: 24 } });
await Promise.resolve();

const setBackgroundThrottlingResult = browserWindowHandle.webContents.setBackgroundThrottling(false);
assert.equal(setBackgroundThrottlingResult, undefined, "browser-window webContents.setBackgroundThrottling() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.getBackgroundThrottling(), false, "webContents.getBackgroundThrottling() should update synchronously after setBackgroundThrottling(false)");
const setBackgroundThrottlingCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setBackgroundThrottling");
assert.ok(setBackgroundThrottlingCall, "browser-window webContents.setBackgroundThrottling() should route through the native bridge");
assert.deepEqual(plain(setBackgroundThrottlingCall.args), {
  id: "browser-window-1",
  action: "webContents.setBackgroundThrottling",
  args: [false],
});
mainVm.respondToNativeCall(setBackgroundThrottlingCall, { result: { backgroundThrottling: false } });
await Promise.resolve();

const insertTextPromise = browserWindowHandle.webContents.insertText("typed text");
const insertTextCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.insertText");
assert.ok(insertTextCall, "browser-window webContents.insertText() should route through the native bridge");
assert.deepEqual(plain(insertTextCall.args), {
  id: "browser-window-1",
  action: "webContents.insertText",
  args: ["typed text"],
});
mainVm.respondToNativeCall(insertTextCall, { error: "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED: webContents.insertText is unavailable for an isolated hosted BrowserWindow" });
await assert.rejects(insertTextPromise, isolatedUnsupportedPattern);

const editCommandExpectations = [
  ["undo", [], "webContents.undo"],
  ["redo", [], "webContents.redo"],
  ["cut", [], "webContents.cut"],
  ["copy", [], "webContents.copy"],
  ["paste", [], "webContents.paste"],
  ["pasteAndMatchStyle", [], "webContents.pasteAndMatchStyle"],
  ["delete", [], "webContents.delete"],
  ["selectAll", [], "webContents.selectAll"],
  ["unselect", [], "webContents.unselect"],
  ["replace", ["replacement text"], "webContents.replace"],
  ["replaceMisspelling", ["corrected text"], "webContents.replaceMisspelling"],
];
for (const [method, methodArgs, action] of editCommandExpectations) {
  const previousCalls = mainVm.postedMessages.filter((message) => message.method === "browserWindowAction" && message.args.action === action).length;
  assert.throws(() => browserWindowHandle.webContents[method](...methodArgs), isolatedUnsupportedPattern);
  assert.equal(
    mainVm.postedMessages.filter((message) => message.method === "browserWindowAction" && message.args.action === action).length,
    previousCalls,
    `browser-window webContents.${method}() should fail locally without child DOM access`,
  );
}

const selectionScrollCommandExpectations = [
  ["centerSelection", [], "webContents.centerSelection"],
  ["scrollToTop", [], "webContents.scrollToTop"],
  ["scrollToBottom", [], "webContents.scrollToBottom"],
  ["adjustSelection", [{ start: -1, end: 2 }], "webContents.adjustSelection"],
];
for (const [method, methodArgs, action] of selectionScrollCommandExpectations) {
  const previousCalls = mainVm.postedMessages.filter((message) => message.method === "browserWindowAction" && message.args.action === action).length;
  assert.throws(() => browserWindowHandle.webContents[method](...methodArgs), isolatedUnsupportedPattern);
  assert.equal(
    mainVm.postedMessages.filter((message) => message.method === "browserWindowAction" && message.args.action === action).length,
    previousCalls,
    `browser-window webContents.${method}() should fail locally without child DOM access`,
  );
}

const setZoomFactorResult = browserWindowHandle.webContents.setZoomFactor(1.5);
assert.equal(setZoomFactorResult, undefined, "browser-window webContents.setZoomFactor() should preserve the official void-return shape");
const setZoomFactorCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setZoomFactor");
assert.ok(setZoomFactorCall, "browser-window webContents.setZoomFactor() should route through the native bridge");
assert.deepEqual(plain(setZoomFactorCall.args), {
  id: "browser-window-1",
  action: "webContents.setZoomFactor",
  args: [1.5],
});
mainVm.respondToNativeCall(setZoomFactorCall, { result: { zoomFactor: 1.5, zoomLevel: 2.224 } });
await Promise.resolve();
assert.equal(browserWindowHandle.webContents.getZoomFactor(), 1.5, "webContents.getZoomFactor() should update after setZoomFactor() response");
assert.equal(browserWindowHandle.webContents.getZoomLevel(), 2.224, "webContents.getZoomLevel() should update after setZoomFactor() response");

const setZoomLevelResult = browserWindowHandle.webContents.setZoomLevel(-1);
assert.equal(setZoomLevelResult, undefined, "browser-window webContents.setZoomLevel() should preserve the official void-return shape");
const setZoomLevelCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setZoomLevel");
assert.ok(setZoomLevelCall, "browser-window webContents.setZoomLevel() should route through the native bridge");
assert.deepEqual(plain(setZoomLevelCall.args), {
  id: "browser-window-1",
  action: "webContents.setZoomLevel",
  args: [-1],
});
mainVm.respondToNativeCall(setZoomLevelCall, { result: { zoomFactor: 0.8333333333333334, zoomLevel: -1 } });
await Promise.resolve();
assert.equal(browserWindowHandle.webContents.getZoomLevel(), -1, "webContents.getZoomLevel() should update after setZoomLevel() response");
assert.equal(browserWindowHandle.webContents.getZoomFactor(), 0.8333333333333334, "webContents.getZoomFactor() should update from Electron 1.2^level mapping");

const visualZoomLimitsPromise = browserWindowHandle.webContents.setVisualZoomLevelLimits(0.5, 3);
const visualZoomLimitsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setVisualZoomLevelLimits");
assert.ok(visualZoomLimitsCall, "browser-window webContents.setVisualZoomLevelLimits() should route through the native bridge");
assert.deepEqual(plain(visualZoomLimitsCall.args), {
  id: "browser-window-1",
  action: "webContents.setVisualZoomLevelLimits",
  args: [0.5, 3],
});
mainVm.respondToNativeCall(visualZoomLimitsCall, { result: { minimumLevel: 0.5, maximumLevel: 3 } });
assert.equal(await visualZoomLimitsPromise, undefined, "browser-window webContents.setVisualZoomLevelLimits() should resolve with the official void-return shape");

const setAudioMutedResult = browserWindowHandle.webContents.setAudioMuted(true);
assert.equal(setAudioMutedResult, undefined, "browser-window webContents.setAudioMuted() should preserve the official void-return shape");
assert.equal(browserWindowHandle.webContents.isAudioMuted(), true, "webContents.isAudioMuted() should update synchronously after setAudioMuted(true)");
assert.equal(browserWindowHandle.webContents.isCurrentlyAudible(), false, "muting hosted webContents should clear the sync audible cache");
const setAudioMutedCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setAudioMuted");
assert.ok(setAudioMutedCall, "browser-window webContents.setAudioMuted() should route through the native bridge");
assert.deepEqual(plain(setAudioMutedCall.args), {
  id: "browser-window-1",
  action: "webContents.setAudioMuted",
  args: [true],
});
mainVm.respondToNativeCall(setAudioMutedCall, { result: { audioMuted: true, currentlyAudible: false } });
await Promise.resolve();
assert.equal(browserWindowHandle.webContents.isAudioMuted(), true, "webContents.isAudioMuted() should stay true after setAudioMuted() response");
assert.equal(browserWindowHandle.webContents.isCurrentlyAudible(), false, "webContents.isCurrentlyAudible() should sync from setAudioMuted() response");

const setAudioUnmutedResult = browserWindowHandle.webContents.setAudioMuted(false);
assert.equal(setAudioUnmutedResult, undefined, "browser-window webContents.setAudioMuted(false) should preserve the official void-return shape");
const setAudioUnmutedCall = mainVm.postedMessages
  .filter((message) => message.method === "browserWindowAction" && message.args.action === "webContents.setAudioMuted")
  .at(-1);
assert.ok(setAudioUnmutedCall, "browser-window webContents.setAudioMuted(false) should route through the native bridge");
assert.deepEqual(plain(setAudioUnmutedCall.args), {
  id: "browser-window-1",
  action: "webContents.setAudioMuted",
  args: [false],
});
mainVm.respondToNativeCall(setAudioUnmutedCall, { result: { audioMuted: false, currentlyAudible: false } });
await Promise.resolve();
assert.equal(browserWindowHandle.webContents.isAudioMuted(), false, "webContents.isAudioMuted() should update after unmute response");

const minimizePromise = browserWindowHandle.minimize();
const minimizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "minimize");
assert.ok(minimizeCall, "browser-window minimize() should route through the native bridge");
assert.deepEqual(plain(minimizeCall.args), {
  id: "browser-window-1",
  action: "minimize",
  args: [],
});
mainVm.respondToNativeCall(minimizeCall, { result: { minimized: true, maximized: false } });
assert.deepEqual(await minimizePromise, { minimized: true, maximized: false });

const isMinimizedPromise = browserWindowHandle.isMinimized();
const isMinimizedCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isMinimized");
assert.ok(isMinimizedCall, "browser-window isMinimized() should route through the native bridge");
mainVm.respondToNativeCall(isMinimizedCall, { result: true });
assert.equal(await isMinimizedPromise, true);

const restorePromise = browserWindowHandle.restore();
const restoreCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "restore");
assert.ok(restoreCall, "browser-window restore() should route through the native bridge");
assert.deepEqual(plain(restoreCall.args), {
  id: "browser-window-1",
  action: "restore",
  args: [],
});
mainVm.respondToNativeCall(restoreCall, { result: { minimized: false, maximized: false } });
assert.deepEqual(await restorePromise, { minimized: false, maximized: false });

const maximizePromise = browserWindowHandle.maximize();
const maximizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "maximize");
assert.ok(maximizeCall, "browser-window maximize() should route through the native bridge");
mainVm.respondToNativeCall(maximizeCall, { result: { minimized: false, maximized: true } });
assert.deepEqual(await maximizePromise, { minimized: false, maximized: true });

const isMaximizedPromise = browserWindowHandle.isMaximized();
const isMaximizedCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isMaximized");
assert.ok(isMaximizedCall, "browser-window isMaximized() should route through the native bridge");
mainVm.respondToNativeCall(isMaximizedCall, { result: true });
assert.equal(await isMaximizedPromise, true);

const unmaximizePromise = browserWindowHandle.unmaximize();
const unmaximizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "unmaximize");
assert.ok(unmaximizeCall, "browser-window unmaximize() should route through the native bridge");
mainVm.respondToNativeCall(unmaximizeCall, { result: { minimized: false, maximized: false } });
assert.deepEqual(await unmaximizePromise, { minimized: false, maximized: false });

const getBoundsPromise = browserWindowHandle.getBounds();
const getBoundsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getBounds");
assert.ok(getBoundsCall, "browser-window getBounds() should route through the native bridge");
assert.deepEqual(plain(getBoundsCall.args), {
  id: "browser-window-1",
  action: "getBounds",
  args: [],
});
mainVm.respondToNativeCall(getBoundsCall, { result: { x: 0, y: 0, width: 560, height: 220 } });
assert.deepEqual(await getBoundsPromise, { x: 0, y: 0, width: 560, height: 220 });

const setBoundsValue = { x: 24, y: 32, width: 420, height: 260 };
const setBoundsPromise = browserWindowHandle.setBounds(setBoundsValue);
const setBoundsCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setBounds");
assert.ok(setBoundsCall, "browser-window setBounds() should route through the native bridge");
assert.deepEqual(plain(setBoundsCall.args), {
  id: "browser-window-1",
  action: "setBounds",
  args: [setBoundsValue],
});
mainVm.respondToNativeCall(setBoundsCall, { result: setBoundsValue });
assert.deepEqual(await setBoundsPromise, setBoundsValue);

const getSizePromise = browserWindowHandle.getSize();
const getSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getSize");
assert.ok(getSizeCall, "browser-window getSize() should route through the native bridge");
mainVm.respondToNativeCall(getSizeCall, { result: [420, 260] });
assert.deepEqual(await getSizePromise, [420, 260]);

const setSizePromise = browserWindowHandle.setSize(480, 280);
const setSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setSize");
assert.ok(setSizeCall, "browser-window setSize() should route through the native bridge");
assert.deepEqual(plain(setSizeCall.args), {
  id: "browser-window-1",
  action: "setSize",
  args: [480, 280],
});
mainVm.respondToNativeCall(setSizeCall, { result: [480, 280] });
assert.deepEqual(await setSizePromise, [480, 280]);

const getContentSizePromise = browserWindowHandle.getContentSize();
const getContentSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getContentSize");
assert.ok(getContentSizeCall, "browser-window getContentSize() should route through the native bridge");
mainVm.respondToNativeCall(getContentSizeCall, { result: [480, 280] });
assert.deepEqual(await getContentSizePromise, [480, 280]);

const setContentSizePromise = browserWindowHandle.setContentSize(390, 240, true);
const setContentSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setContentSize");
assert.ok(setContentSizeCall, "browser-window setContentSize() should route through the native bridge");
assert.deepEqual(plain(setContentSizeCall.args), {
  id: "browser-window-1",
  action: "setContentSize",
  args: [390, 240, true],
});
mainVm.respondToNativeCall(setContentSizeCall, { result: [390, 240] });
assert.deepEqual(await setContentSizePromise, [390, 240]);

const setMinimumSizePromise = browserWindowHandle.setMinimumSize(360, 220);
const setMinimumSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setMinimumSize");
assert.ok(setMinimumSizeCall, "browser-window setMinimumSize() should route through the native bridge");
assert.deepEqual(plain(setMinimumSizeCall.args), {
  id: "browser-window-1",
  action: "setMinimumSize",
  args: [360, 220],
});
mainVm.respondToNativeCall(setMinimumSizeCall, { result: [360, 220] });
assert.deepEqual(await setMinimumSizePromise, [360, 220]);

const getMinimumSizePromise = browserWindowHandle.getMinimumSize();
const getMinimumSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getMinimumSize");
assert.ok(getMinimumSizeCall, "browser-window getMinimumSize() should route through the native bridge");
mainVm.respondToNativeCall(getMinimumSizeCall, { result: [360, 220] });
assert.deepEqual(await getMinimumSizePromise, [360, 220]);

const setMaximumSizePromise = browserWindowHandle.setMaximumSize(900, 640);
const setMaximumSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setMaximumSize");
assert.ok(setMaximumSizeCall, "browser-window setMaximumSize() should route through the native bridge");
assert.deepEqual(plain(setMaximumSizeCall.args), {
  id: "browser-window-1",
  action: "setMaximumSize",
  args: [900, 640],
});
mainVm.respondToNativeCall(setMaximumSizeCall, { result: [900, 640] });
assert.deepEqual(await setMaximumSizePromise, [900, 640]);

const getMaximumSizePromise = browserWindowHandle.getMaximumSize();
const getMaximumSizeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getMaximumSize");
assert.ok(getMaximumSizeCall, "browser-window getMaximumSize() should route through the native bridge");
mainVm.respondToNativeCall(getMaximumSizeCall, { result: [900, 640] });
assert.deepEqual(await getMaximumSizePromise, [900, 640]);

const setAspectRatioPromise = browserWindowHandle.setAspectRatio(16 / 9, { width: 40, height: 30 });
const setAspectRatioCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setAspectRatio");
assert.ok(setAspectRatioCall, "browser-window setAspectRatio() should route through the native bridge");
assert.deepEqual(plain(setAspectRatioCall.args), {
  id: "browser-window-1",
  action: "setAspectRatio",
  args: [16 / 9, { width: 40, height: 30 }],
});
mainVm.respondToNativeCall(setAspectRatioCall, { result: { aspectRatio: 16 / 9, aspectRatioExtraSize: { width: 40, height: 30 } } });
assert.deepEqual(await setAspectRatioPromise, { aspectRatio: 16 / 9, aspectRatioExtraSize: { width: 40, height: 30 } });

const getPositionPromise = browserWindowHandle.getPosition();
const getPositionCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getPosition");
assert.ok(getPositionCall, "browser-window getPosition() should route through the native bridge");
mainVm.respondToNativeCall(getPositionCall, { result: [24, 32] });
assert.deepEqual(await getPositionPromise, [24, 32]);

const setPositionPromise = browserWindowHandle.setPosition(48, 64);
const setPositionCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setPosition");
assert.ok(setPositionCall, "browser-window setPosition() should route through the native bridge");
assert.deepEqual(plain(setPositionCall.args), {
  id: "browser-window-1",
  action: "setPosition",
  args: [48, 64],
});
mainVm.respondToNativeCall(setPositionCall, { result: [48, 64] });
assert.deepEqual(await setPositionPromise, [48, 64]);

const centerPromise = browserWindowHandle.center();
const centerCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "center");
assert.ok(centerCall, "browser-window center() should route through the native bridge");
assert.deepEqual(plain(centerCall.args), {
  id: "browser-window-1",
  action: "center",
  args: [],
});
mainVm.respondToNativeCall(centerCall, { result: { x: 0, y: 0, width: 480, height: 280, centered: true } });
assert.deepEqual(await centerPromise, { x: 0, y: 0, width: 480, height: 280, centered: true });

const webContentsSendPromise = browserWindowHandle.webContents.send("ping", { value: 42 }, "payload");
const webContentsSendCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.send");
assert.ok(webContentsSendCall, "browser-window webContents.send() should route through the native bridge");
assert.deepEqual(plain(webContentsSendCall.args), {
  id: "browser-window-1",
  action: "webContents.send",
  args: ["ping", { value: 42 }, "payload"],
});
mainVm.respondToNativeCall(webContentsSendCall, { result: true });
assert.equal(await webContentsSendPromise, true);

const webContentsExecutePromise = browserWindowHandle.webContents.executeJavaScript("window.__answer = 40 + 2; window.__answer", true);
const webContentsExecuteCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.executeJavaScript");
assert.ok(webContentsExecuteCall, "browser-window webContents.executeJavaScript() should route through the native bridge");
assert.deepEqual(plain(webContentsExecuteCall.args), {
  id: "browser-window-1",
  action: "webContents.executeJavaScript",
  args: ["window.__answer = 40 + 2; window.__answer", true],
});
mainVm.respondToNativeCall(webContentsExecuteCall, { result: 42 });
assert.equal(await webContentsExecutePromise, 42);

const webContentsExecuteZeroPromise = browserWindowHandle.webContents.executeJavaScript(0);
const webContentsExecuteZeroCall = mainVm.postedMessages
  .filter((message) => message.method === "browserWindowAction" && message.args.action === "webContents.executeJavaScript")
  .at(-1);
assert.ok(webContentsExecuteZeroCall, "browser-window webContents.executeJavaScript() should preserve numeric code through String(code)");
assert.deepEqual(plain(webContentsExecuteZeroCall.args), {
  id: "browser-window-1",
  action: "webContents.executeJavaScript",
  args: ["0", false],
});
mainVm.respondToNativeCall(webContentsExecuteZeroCall, { result: 0 });
assert.equal(await webContentsExecuteZeroPromise, 0);

const inputEvent = { type: "keyDown", keyCode: "Enter", modifiers: ["shift"] };
const webContentsInputPromise = browserWindowHandle.webContents.sendInputEvent(inputEvent);
const webContentsInputCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.sendInputEvent");
assert.ok(webContentsInputCall, "browser-window webContents.sendInputEvent() should route through the native bridge");
assert.deepEqual(plain(webContentsInputCall.args), {
  id: "browser-window-1",
  action: "webContents.sendInputEvent",
  args: [inputEvent],
});
mainVm.respondToNativeCall(webContentsInputCall, { result: undefined });
assert.equal(await webContentsInputPromise, undefined);

const webContentsInsertCssPromise = browserWindowHandle.webContents.insertCSS("body { --atools-insert-css: inserted; }", { cssOrigin: "user" });
const webContentsInsertCssCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.insertCSS");
assert.ok(webContentsInsertCssCall, "browser-window webContents.insertCSS() should route through the native bridge");
assert.deepEqual(plain(webContentsInsertCssCall.args), {
  id: "browser-window-1",
  action: "webContents.insertCSS",
  args: ["body { --atools-insert-css: inserted; }", { cssOrigin: "user" }],
});
mainVm.respondToNativeCall(webContentsInsertCssCall, { result: "browser-window-1:css:1" });
assert.equal(await webContentsInsertCssPromise, "browser-window-1:css:1");

const webContentsRemoveCssPromise = browserWindowHandle.webContents.removeInsertedCSS("browser-window-1:css:1");
const webContentsRemoveCssCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.removeInsertedCSS");
assert.ok(webContentsRemoveCssCall, "browser-window webContents.removeInsertedCSS() should route through the native bridge");
assert.deepEqual(plain(webContentsRemoveCssCall.args), {
  id: "browser-window-1",
  action: "webContents.removeInsertedCSS",
  args: ["browser-window-1:css:1"],
});
mainVm.respondToNativeCall(webContentsRemoveCssCall, { result: undefined });
assert.equal(await webContentsRemoveCssPromise, undefined);

const findRequestId = browserWindowHandle.webContents.findInPage("needle", { forward: false, matchCase: true });
assert.equal(findRequestId, 1, "browser-window webContents.findInPage() should synchronously return a request id");
const webContentsFindCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.findInPage");
assert.ok(webContentsFindCall, "browser-window webContents.findInPage() should route through the native bridge");
assert.deepEqual(plain(webContentsFindCall.args), {
  id: "browser-window-1",
  action: "webContents.findInPage",
  args: ["needle", { forward: false, matchCase: true }, 1],
});
mainVm.respondToNativeCall(webContentsFindCall, { result: 1 });

const stopFindResult = browserWindowHandle.webContents.stopFindInPage("clearSelection");
assert.equal(stopFindResult, undefined, "browser-window webContents.stopFindInPage() should preserve the official void-return shape");
const webContentsStopFindCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "webContents.stopFindInPage");
assert.ok(webContentsStopFindCall, "browser-window webContents.stopFindInPage() should route through the native bridge");
assert.deepEqual(plain(webContentsStopFindCall.args), {
  id: "browser-window-1",
  action: "webContents.stopFindInPage",
  args: ["clearSelection"],
});
mainVm.respondToNativeCall(webContentsStopFindCall, { result: undefined });

const capabilityChecks = [
  ["Resizable", "resizable"],
  ["Movable", "movable"],
  ["Closable", "closable"],
  ["Minimizable", "minimizable"],
  ["Maximizable", "maximizable"],
];
for (const [suffix, property] of capabilityChecks) {
  const setMethod = `set${suffix}`;
  const isMethod = `is${suffix}`;
  const setPromise = browserWindowHandle[setMethod](false);
  const setCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === setMethod);
  assert.ok(setCall, `browser-window ${setMethod}() should route through the native bridge`);
  assert.deepEqual(plain(setCall.args), {
    id: "browser-window-1",
    action: setMethod,
    args: [false],
  });
  mainVm.respondToNativeCall(setCall, { result: { [property]: false } });
  assert.deepEqual(await setPromise, { [property]: false });

  const isPromise = browserWindowHandle[isMethod]();
  const isCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === isMethod);
  assert.ok(isCall, `browser-window ${isMethod}() should route through the native bridge`);
  assert.deepEqual(plain(isCall.args), {
    id: "browser-window-1",
    action: isMethod,
    args: [],
  });
  mainVm.respondToNativeCall(isCall, { result: false });
  assert.equal(await isPromise, false);
}

const setFullScreenPromise = browserWindowHandle.setFullScreen(true);
const setFullScreenCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setFullScreen");
assert.ok(setFullScreenCall, "browser-window setFullScreen() should route through the native bridge");
assert.deepEqual(plain(setFullScreenCall.args), {
  id: "browser-window-1",
  action: "setFullScreen",
  args: [true],
});
mainVm.respondToNativeCall(setFullScreenCall, { result: { fullScreen: true } });
assert.deepEqual(await setFullScreenPromise, { fullScreen: true });

const isFullScreenPromise = browserWindowHandle.isFullScreen();
const isFullScreenCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isFullScreen");
assert.ok(isFullScreenCall, "browser-window isFullScreen() should route through the native bridge");
mainVm.respondToNativeCall(isFullScreenCall, { result: true });
assert.equal(await isFullScreenPromise, true);

const setFullScreenablePromise = browserWindowHandle.setFullScreenable(false);
const setFullScreenableCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setFullScreenable");
assert.ok(setFullScreenableCall, "browser-window setFullScreenable() should route through the native bridge");
assert.deepEqual(plain(setFullScreenableCall.args), {
  id: "browser-window-1",
  action: "setFullScreenable",
  args: [false],
});
mainVm.respondToNativeCall(setFullScreenableCall, { result: { fullScreenable: false } });
assert.deepEqual(await setFullScreenablePromise, { fullScreenable: false });

const isFullScreenablePromise = browserWindowHandle.isFullScreenable();
const isFullScreenableCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isFullScreenable");
assert.ok(isFullScreenableCall, "browser-window isFullScreenable() should route through the native bridge");
mainVm.respondToNativeCall(isFullScreenableCall, { result: false });
assert.equal(await isFullScreenablePromise, false);

const setOpacityPromise = browserWindowHandle.setOpacity(0.72);
const setOpacityCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setOpacity");
assert.ok(setOpacityCall, "browser-window setOpacity() should route through the native bridge");
assert.deepEqual(plain(setOpacityCall.args), {
  id: "browser-window-1",
  action: "setOpacity",
  args: [0.72],
});
mainVm.respondToNativeCall(setOpacityCall, { result: { opacity: 0.72 } });
assert.deepEqual(await setOpacityPromise, { opacity: 0.72 });

const getOpacityPromise = browserWindowHandle.getOpacity();
const getOpacityCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getOpacity");
assert.ok(getOpacityCall, "browser-window getOpacity() should route through the native bridge");
mainVm.respondToNativeCall(getOpacityCall, { result: 0.72 });
assert.equal(await getOpacityPromise, 0.72);

const setHasShadowPromise = browserWindowHandle.setHasShadow(false);
const setHasShadowCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setHasShadow");
assert.ok(setHasShadowCall, "browser-window setHasShadow() should route through the native bridge");
assert.deepEqual(plain(setHasShadowCall.args), {
  id: "browser-window-1",
  action: "setHasShadow",
  args: [false],
});
mainVm.respondToNativeCall(setHasShadowCall, { result: { hasShadow: false } });
assert.deepEqual(await setHasShadowPromise, { hasShadow: false });

const hasShadowPromise = browserWindowHandle.hasShadow();
const hasShadowCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "hasShadow");
assert.ok(hasShadowCall, "browser-window hasShadow() should route through the native bridge");
mainVm.respondToNativeCall(hasShadowCall, { result: false });
assert.equal(await hasShadowPromise, false);

const invalidateShadowPromise = browserWindowHandle.invalidateShadow();
const invalidateShadowCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "invalidateShadow");
assert.ok(invalidateShadowCall, "browser-window invalidateShadow() should route through the native bridge");
mainVm.respondToNativeCall(invalidateShadowCall, { result: { hasShadow: false } });
assert.deepEqual(await invalidateShadowPromise, { hasShadow: false });

const setSkipTaskbarPromise = browserWindowHandle.setSkipTaskbar(true);
const setSkipTaskbarCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setSkipTaskbar");
assert.ok(setSkipTaskbarCall, "browser-window setSkipTaskbar() should route through the native bridge");
assert.deepEqual(plain(setSkipTaskbarCall.args), {
  id: "browser-window-1",
  action: "setSkipTaskbar",
  args: [true],
});
mainVm.respondToNativeCall(setSkipTaskbarCall, { result: { skipTaskbar: true } });
assert.deepEqual(await setSkipTaskbarPromise, { skipTaskbar: true });

const setKioskPromise = browserWindowHandle.setKiosk(true);
const setKioskCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setKiosk");
assert.ok(setKioskCall, "browser-window setKiosk() should route through the native bridge");
assert.deepEqual(plain(setKioskCall.args), {
  id: "browser-window-1",
  action: "setKiosk",
  args: [true],
});
mainVm.respondToNativeCall(setKioskCall, { result: { kiosk: true } });
assert.deepEqual(await setKioskPromise, { kiosk: true });

const isKioskPromise = browserWindowHandle.isKiosk();
const isKioskCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isKiosk");
assert.ok(isKioskCall, "browser-window isKiosk() should route through the native bridge");
mainVm.respondToNativeCall(isKioskCall, { result: true });
assert.equal(await isKioskPromise, true);

const setVisibleOnAllWorkspacesPromise = browserWindowHandle.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
const setVisibleOnAllWorkspacesCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setVisibleOnAllWorkspaces");
assert.ok(setVisibleOnAllWorkspacesCall, "browser-window setVisibleOnAllWorkspaces() should route through the native bridge");
assert.deepEqual(plain(setVisibleOnAllWorkspacesCall.args), {
  id: "browser-window-1",
  action: "setVisibleOnAllWorkspaces",
  args: [true, { visibleOnFullScreen: true }],
});
mainVm.respondToNativeCall(setVisibleOnAllWorkspacesCall, { result: { visibleOnAllWorkspaces: true } });
assert.deepEqual(await setVisibleOnAllWorkspacesPromise, { visibleOnAllWorkspaces: true });

const isVisibleOnAllWorkspacesPromise = browserWindowHandle.isVisibleOnAllWorkspaces();
const isVisibleOnAllWorkspacesCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isVisibleOnAllWorkspaces");
assert.ok(isVisibleOnAllWorkspacesCall, "browser-window isVisibleOnAllWorkspaces() should route through the native bridge");
mainVm.respondToNativeCall(isVisibleOnAllWorkspacesCall, { result: true });
assert.equal(await isVisibleOnAllWorkspacesPromise, true);

const setContentProtectionPromise = browserWindowHandle.setContentProtection(true);
const setContentProtectionCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setContentProtection");
assert.ok(setContentProtectionCall, "browser-window setContentProtection() should route through the native bridge");
assert.deepEqual(plain(setContentProtectionCall.args), {
  id: "browser-window-1",
  action: "setContentProtection",
  args: [true],
});
mainVm.respondToNativeCall(setContentProtectionCall, { result: { contentProtected: true } });
assert.deepEqual(await setContentProtectionPromise, { contentProtected: true });

const isContentProtectedPromise = browserWindowHandle.isContentProtected();
const isContentProtectedCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isContentProtected");
assert.ok(isContentProtectedCall, "browser-window isContentProtected() should route through the native bridge");
mainVm.respondToNativeCall(isContentProtectedCall, { result: true });
assert.equal(await isContentProtectedPromise, true);

const setFocusablePromise = browserWindowHandle.setFocusable(false);
const setFocusableCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setFocusable");
assert.ok(setFocusableCall, "browser-window setFocusable() should route through the native bridge");
assert.deepEqual(plain(setFocusableCall.args), {
  id: "browser-window-1",
  action: "setFocusable",
  args: [false],
});
mainVm.respondToNativeCall(setFocusableCall, { result: { focusable: false } });
assert.deepEqual(await setFocusablePromise, { focusable: false });

const isFocusablePromise = browserWindowHandle.isFocusable();
const isFocusableCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "isFocusable");
assert.ok(isFocusableCall, "browser-window isFocusable() should route through the native bridge");
mainVm.respondToNativeCall(isFocusableCall, { result: false });
assert.equal(await isFocusablePromise, false);

const flashFramePromise = browserWindowHandle.flashFrame(true);
const flashFrameCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "flashFrame");
assert.ok(flashFrameCall, "browser-window flashFrame() should route through the native bridge");
assert.deepEqual(plain(flashFrameCall.args), {
  id: "browser-window-1",
  action: "flashFrame",
  args: [true],
});
mainVm.respondToNativeCall(flashFrameCall, { result: { flashing: true } });
assert.deepEqual(await flashFramePromise, { flashing: true });

const setProgressBarPromise = browserWindowHandle.setProgressBar(0.42, { mode: "normal" });
const setProgressBarCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "setProgressBar");
assert.ok(setProgressBarCall, "browser-window setProgressBar() should route through the native bridge");
assert.deepEqual(plain(setProgressBarCall.args), {
  id: "browser-window-1",
  action: "setProgressBar",
  args: [0.42, { mode: "normal" }],
});
mainVm.respondToNativeCall(setProgressBarCall, { result: { progressBar: 0.42, progressBarMode: "normal" } });
assert.deepEqual(await setProgressBarPromise, { progressBar: 0.42, progressBarMode: "normal" });

const getMediaSourceIdPromise = browserWindowHandle.getMediaSourceId();
const getMediaSourceIdCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "getMediaSourceId");
assert.ok(getMediaSourceIdCall, "browser-window getMediaSourceId() should route through the native bridge");
mainVm.respondToNativeCall(getMediaSourceIdCall, { result: "window:1:0" });
assert.equal(await getMediaSourceIdPromise, "window:1:0");

const moveTopPromise = browserWindowHandle.moveTop();
const moveTopCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "moveTop");
assert.ok(moveTopCall, "browser-window moveTop() should route through the native bridge");
assert.deepEqual(plain(moveTopCall.args), {
  id: "browser-window-1",
  action: "moveTop",
  args: [],
});
mainVm.respondToNativeCall(moveTopCall, { result: { zOrder: 4 } });
assert.deepEqual(await moveTopPromise, { zOrder: 4 });

const moveAbovePromise = browserWindowHandle.moveAbove("window:2:0");
const moveAboveCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "moveAbove");
assert.ok(moveAboveCall, "browser-window moveAbove() should route through the native bridge");
assert.deepEqual(plain(moveAboveCall.args), {
  id: "browser-window-1",
  action: "moveAbove",
  args: ["window:2:0"],
});
mainVm.respondToNativeCall(moveAboveCall, { result: { zOrder: 5, mediaSourceId: "window:2:0" } });
assert.deepEqual(await moveAbovePromise, { zOrder: 5, mediaSourceId: "window:2:0" });

mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_parent_message__: true,
    windowId: "browser-window-1",
    channel: "pong",
    args: ["hello", 123],
  },
});
assert.deepEqual(callbackCalls, [["pong", "hello", 123]], "createBrowserWindow callback should receive child sendToParent messages");

browserWindowHandle.once("closed", (...args) => browserEventCalls.push(["closed", browserWindowHandle.isDestroyed(), ...plain(args)]));
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    event: "closed",
    args: [{ closed: true }],
  },
});
mainVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_event__: true,
    windowId: "browser-window-1",
    event: "closed",
    args: [{ closed: true, duplicate: true }],
  },
});
assert.deepEqual(browserEventCalls, [
  ["focus", { focused: true }],
  ["closed", true, { closed: true }],
], "once() listeners should fire once and host closed events should mark the handle destroyed");
assert.equal(browserWindowHandle.isDestroyed(), true, "host closed events should mark browser-window handles destroyed");
assert.equal(browserWindowHandle.webContents.isDestroyed(), true, "host closed events should mark browser-window webContents destroyed");

const closePromise = browserWindowHandle.close();
const closeCall = mainVm.postedMessages.find((message) => message.method === "browserWindowAction" && message.args.action === "close");
assert.ok(closeCall, "browser-window close() should route through the native bridge");
mainVm.respondToNativeCall(closeCall, { result: { visible: false, focused: false, closed: true } });
assert.deepEqual(await closePromise, { visible: false, focused: false, closed: true });
assert.equal(browserWindowHandle.isDestroyed(), true, "closed hosted browser-window handles should report destroyed");
assert.equal(browserWindowHandle.webContents.isDestroyed(), true, "closed hosted browser-window webContents should report destroyed");

const childVm = createBridgeVm("browserWindow", "browser-window-1");
assert.equal(childVm.windowStub.utools.getWindowType(), "browserWindow", "hosted child windows should report browserWindow");
assert.equal(typeof childVm.windowStub.utools.sendToParent, "function", "utools.sendToParent should be exposed");
assert.equal(typeof childVm.windowStub.require, "function", "hosted child bridge should expose a minimal require()");
const electronShim = childVm.windowStub.require("electron");
assert.equal(typeof electronShim.ipcRenderer.on, "function", "hosted child bridge should expose ipcRenderer.on()");
assert.equal(typeof electronShim.ipcRenderer.once, "function", "hosted child bridge should expose ipcRenderer.once()");
assert.equal(typeof electronShim.ipcRenderer.off, "function", "hosted child bridge should expose ipcRenderer.off()");
const childIpcCalls = [];
const removedChildListener = (_event, payload) => childIpcCalls.push(["removed", plain(payload)]);
electronShim.ipcRenderer.on("ping", (_event, payload, text) => childIpcCalls.push(["on", plain(payload), text]));
electronShim.ipcRenderer.once("ping", (_event, payload, text) => childIpcCalls.push(["once", plain(payload), text]));
electronShim.ipcRenderer.on("ping", removedChildListener);
electronShim.ipcRenderer.off("ping", removedChildListener);
childVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_ipc__: true,
    windowId: "browser-window-1",
    channel: "ping",
    args: [{ value: 42 }, "payload"],
  },
});
childVm.windowStub.dispatchEvent({
  type: "message",
  data: {
    __atools_browser_window_ipc__: true,
    windowId: "browser-window-1",
    channel: "ping",
    args: [{ value: 7 }, "again"],
  },
});
assert.deepEqual(childIpcCalls, [
  ["on", { value: 42 }, "payload"],
  ["once", { value: 42 }, "payload"],
  ["on", { value: 7 }, "again"],
], "hosted child ipcRenderer listeners should receive webContents.send payloads");
const sendPromise = childVm.windowStub.utools.sendToParent("pong", "hello", 123);
const sendCall = childVm.postedMessages.find((message) => message.method === "sendToParent");
assert.ok(sendCall, "sendToParent should route through the native bridge");
assert.deepEqual(plain(sendCall.args), {
  channel: "pong",
  args: ["hello", 123],
  windowType: "browserWindow",
  browserWindowId: "browser-window-1",
});
childVm.respondToNativeCall(sendCall, { result: true });
assert.equal(await sendPromise, true, "sendToParent should resolve after the host forwards the parent message");

assert.match(componentSource, /type PluginBrowserWindowState = \{/, "host should keep browser-window state");
assert.match(componentSource, /pluginBrowserWindows = \$state<PluginBrowserWindowState\[\]>\(\[\]\)/, "host should track child browser windows");
assert.match(componentSource, /function createPluginBrowserWindow\(/, "host should create browser windows instead of returning unsupported");
assert.match(componentSource, /function handlePluginBrowserWindowAction\(/, "host should handle BrowserWindow object actions");
assert.match(componentSource, /function dispatchPluginBrowserWindowParentMessage\(/, "host should forward child sendToParent messages");
assert.match(componentSource, /function dispatchPluginBrowserWindowIpcMessage\(/, "host should forward parent webContents.send messages to child browser windows");
assert.match(componentSource, /function executePluginBrowserWindowJavaScript\(/, "host should execute JavaScript in hosted child browser windows");
assert.match(componentSource, /function dispatchPluginBrowserWindowInputEvent\(/, "host should forward sendInputEvent payloads to child browser windows");
assert.match(componentSource, /function insertPluginBrowserWindowCss\(/, "host should insert CSS into hosted child browser windows");
assert.match(componentSource, /function removePluginBrowserWindowCss\(/, "host should remove inserted CSS from hosted child browser windows");
assert.match(componentSource, /function findPluginBrowserWindowInPage\(/, "host should find text in hosted child browser windows");
assert.match(componentSource, /function stopPluginBrowserWindowFindInPage\(/, "host should stop hosted child browser-window find requests");
assert.match(componentSource, /function pluginBrowserWindowNavigationResult\(/, "host should return hosted browser-window navigation state");
assert.match(componentSource, /function navigatePluginBrowserWindowHistory\(/, "host should navigate hosted browser-window history");
assert.match(componentSource, /function pluginBrowserWindowDevToolsResult\(/, "host should return hosted browser-window DevTools state");
assert.match(componentSource, /function updatePluginBrowserWindowDevTools\(/, "host should update hosted browser-window DevTools state");
assert.match(componentSource, /function inspectPluginBrowserWindowElement\(/, "host should inspect hosted browser-window elements");
assert.match(componentSource, /function editPluginBrowserWindowText\(/, "host should edit focused hosted browser-window text controls");
assert.match(componentSource, /function controlPluginBrowserWindowSelection\(/, "host should control hosted browser-window selection and scrolling");
assert.match(componentSource, /function dispatchPluginBrowserWindowEvent\(/, "host should forward browser-window lifecycle events to parent plugin iframes");
assert.match(componentSource, /__atools_browser_window_event__/, "bridge should deliver browser-window events to created handles");
assert.match(componentSource, /__atools_browser_window_ipc__/, "bridge should deliver webContents.send payloads to hosted child windows");
assert.match(componentSource, /webContents\.executeJavaScript/, "bridge should route webContents.executeJavaScript actions");
assert.match(componentSource, /webContents\.sendInputEvent/, "bridge should route webContents.sendInputEvent actions");
assert.match(componentSource, /webContents\.insertCSS/, "bridge should route webContents.insertCSS actions");
assert.match(componentSource, /webContents\.removeInsertedCSS/, "bridge should route webContents.removeInsertedCSS actions");
assert.match(componentSource, /webContents\.findInPage/, "bridge should route webContents.findInPage actions");
assert.match(componentSource, /webContents\.stopFindInPage/, "bridge should route webContents.stopFindInPage actions");
assert.match(componentSource, /webContents\.loadURL/, "bridge should route webContents.loadURL actions");
assert.match(componentSource, /webContents\.reload/, "bridge should route webContents.reload actions");
assert.match(componentSource, /webContents\.reloadIgnoringCache/, "bridge should route webContents.reloadIgnoringCache actions");
assert.match(componentSource, /isWaitingForResponse: function/, "bridge should expose webContents.isWaitingForResponse");
assert.match(componentSource, /navigationHistory: navigationHistory/, "bridge should expose webContents.navigationHistory");
assert.match(componentSource, /webContents\.navigationHistory\.goToOffset/, "host should route webContents.navigationHistory.goToOffset actions");
assert.match(componentSource, /webContents\.navigationHistory\.clear/, "host should route webContents.navigationHistory.clear actions");
assert.match(componentSource, /webContents\.goBack/, "bridge should route webContents.goBack actions");
assert.match(componentSource, /webContents\.goForward/, "bridge should route webContents.goForward actions");
assert.match(componentSource, /webContents\.stop/, "bridge should route webContents.stop actions");
assert.match(componentSource, /isCrashed: function/, "bridge should expose webContents.isCrashed");
assert.match(componentSource, /forcefullyCrashRenderer: function/, "bridge should expose webContents.forcefullyCrashRenderer");
assert.match(componentSource, /webContents\.forcefullyCrashRenderer/, "host should route webContents.forcefullyCrashRenderer actions");
assert.match(componentSource, /render-process-gone/, "bridge should surface hosted render-process-gone events");
assert.match(componentSource, /focus: function\(\) \{ return webContentsFocus\(\); \}/, "bridge should expose webContents.focus");
assert.match(componentSource, /isFocused: function\(\) \{ return webContentsFocused; \}/, "bridge should expose webContents.isFocused");
assert.match(componentSource, /getOwnerBrowserWindow: function/, "bridge should expose webContents.getOwnerBrowserWindow");
assert.match(componentSource, /getMediaSourceId: function\(\) \{ return webContentsMediaSourceId; \}/, "bridge should expose webContents.getMediaSourceId");
assert.match(componentSource, /isBeingCaptured: function\(\) \{ return webContentsBeingCaptured; \}/, "bridge should expose webContents.isBeingCaptured");
assert.match(componentSource, /setIgnoreMenuShortcuts: function/, "bridge should expose webContents.setIgnoreMenuShortcuts");
assert.match(componentSource, /webContents\.setIgnoreMenuShortcuts/, "host should route webContents.setIgnoreMenuShortcuts actions");
assert.match(componentSource, /webContents\.openDevTools/, "bridge should route webContents.openDevTools actions");
assert.match(componentSource, /webContents\.closeDevTools/, "bridge should route webContents.closeDevTools actions");
assert.match(componentSource, /webContents\.toggleDevTools/, "bridge should route webContents.toggleDevTools actions");
assert.match(componentSource, /webContents\.inspectElement/, "bridge should route webContents.inspectElement actions");
assert.match(componentSource, /function capturePluginBrowserWindowPage\(/, "host should capture hosted browser-window pages");
assert.match(componentSource, /function printPluginBrowserWindowPage\(/, "host should route hosted browser-window print requests");
assert.match(componentSource, /function savePluginBrowserWindowPage\(/, "host should save hosted browser-window pages");
assert.match(componentSource, /function updatePluginBrowserWindowUserAgent\(/, "host should update hosted browser-window user agent state");
assert.match(componentSource, /function updatePluginBrowserWindowFrameRate\(/, "host should update hosted browser-window frame rate state");
assert.match(componentSource, /function updatePluginBrowserWindowBackgroundThrottling\(/, "host should update hosted browser-window background throttling state");
assert.match(componentSource, /webContents\.capturePage/, "bridge should route webContents.capturePage actions");
assert.match(componentSource, /webContents\.print/, "bridge should route webContents.print actions");
assert.match(componentSource, /webContents\.printToPDF/, "bridge should route webContents.printToPDF actions");
assert.match(componentSource, /webContents\.savePage/, "bridge should route webContents.savePage actions");
assert.match(componentSource, /webContents\.setUserAgent/, "bridge should route webContents.setUserAgent actions");
assert.match(componentSource, /webContents\.setFrameRate/, "bridge should route webContents.setFrameRate actions");
assert.match(componentSource, /webContents\.setBackgroundThrottling/, "bridge should route webContents.setBackgroundThrottling actions");
assert.match(componentSource, /webContents\.centerSelection/, "bridge should route webContents.centerSelection actions");
assert.match(componentSource, /webContents\.scrollToTop/, "bridge should route webContents.scrollToTop actions");
assert.match(componentSource, /webContents\.scrollToBottom/, "bridge should route webContents.scrollToBottom actions");
assert.match(componentSource, /webContents\.adjustSelection/, "bridge should route webContents.adjustSelection actions");
assert.match(componentSource, /webContents\.insertText/, "bridge should route webContents.insertText actions");
assert.match(componentSource, /webContents\.selectAll/, "bridge should route webContents.selectAll actions");
assert.match(componentSource, /webContents\.replaceMisspelling/, "bridge should route webContents.replaceMisspelling actions");
assert.match(componentSource, /webContents\.setAudioMuted/, "bridge should route webContents.setAudioMuted actions");
assert.match(componentSource, /target: "webContents"/, "host should tag webContents events separately from BrowserWindow events");
assert.match(componentSource, /dispatchPluginBrowserWindowEvent\(id, "resize"/, "setBounds/setSize should dispatch hosted browser-window resize events");
assert.match(componentSource, /dispatchPluginBrowserWindowEvent\(id, "move"/, "setBounds/setPosition/center should dispatch hosted browser-window move events");
assert.match(componentSource, /function loadPluginBrowserWindowUrl\(/, "host should load and reload hosted browser-window urls");
assert.match(componentSource, /case "browserWindowAction":/, "native bridge should route BrowserWindow object actions");
assert.match(componentSource, /x: number;/, "host should track child browser-window x position");
assert.match(componentSource, /y: number;/, "host should track child browser-window y position");
assert.match(componentSource, /width: number;/, "host should track child browser-window width");
assert.match(componentSource, /height: number;/, "host should track child browser-window height");
assert.match(componentSource, /minimumWidth: number;/, "host should track hosted child browser-window minimum width");
assert.match(componentSource, /minimumHeight: number;/, "host should track hosted child browser-window minimum height");
assert.match(componentSource, /maximumWidth: number;/, "host should track hosted child browser-window maximum width");
assert.match(componentSource, /maximumHeight: number;/, "host should track hosted child browser-window maximum height");
assert.match(componentSource, /aspectRatio: number;/, "host should track hosted child browser-window aspect ratio");
assert.match(componentSource, /aspectRatioExtraSize: PluginBrowserWindowSize;/, "host should track hosted child browser-window aspect ratio extra size");
assert.match(componentSource, /positioned: boolean;/, "host should distinguish explicit position from centered layout");
assert.match(componentSource, /alwaysOnTop: boolean;/, "host should track hosted child browser-window always-on-top state");
assert.match(componentSource, /backgroundColor: string;/, "host should track hosted child browser-window background color state");
assert.match(componentSource, /const background = ` background: \$\{childWindow\.backgroundColor\};`;/, "host should render child browser-window background color into shell style");
assert.match(componentSource, /menuBarAutoHide: boolean;/, "host should track hosted child browser-window menu bar auto-hide state");
assert.match(componentSource, /menuBarVisible: boolean;/, "host should track hosted child browser-window menu bar visibility state");
assert.match(componentSource, /menuRemoved: boolean;/, "host should track hosted child browser-window removed menu state");
assert.match(componentSource, /minimized: boolean;/, "host should track hosted child browser-window minimized state");
assert.match(componentSource, /maximized: boolean;/, "host should track hosted child browser-window maximized state");
assert.match(componentSource, /resizable: boolean;/, "host should track hosted child browser-window resizable capability");
assert.match(componentSource, /movable: boolean;/, "host should track hosted child browser-window movable capability");
assert.match(componentSource, /closable: boolean;/, "host should track hosted child browser-window closable capability");
assert.match(componentSource, /minimizable: boolean;/, "host should track hosted child browser-window minimizable capability");
assert.match(componentSource, /maximizable: boolean;/, "host should track hosted child browser-window maximizable capability");
assert.match(componentSource, /fullScreen: boolean;/, "host should track hosted child browser-window full-screen state");
assert.match(componentSource, /fullScreenable: boolean;/, "host should track hosted child browser-window full-screenable capability");
assert.match(componentSource, /opacity: number;/, "host should track hosted child browser-window opacity");
assert.match(componentSource, /hasShadow: boolean;/, "host should track hosted child browser-window shadow state");
assert.match(componentSource, /skipTaskbar: boolean;/, "host should track hosted child browser-window taskbar visibility state");
assert.match(componentSource, /kiosk: boolean;/, "host should track hosted child browser-window kiosk state");
assert.match(componentSource, /visibleOnAllWorkspaces: boolean;/, "host should track hosted child browser-window workspace visibility state");
assert.match(componentSource, /contentProtected: boolean;/, "host should track hosted child browser-window content protection state");
assert.match(componentSource, /focusable: boolean;/, "host should track hosted child browser-window focusable state");
assert.match(componentSource, /flashing: boolean;/, "host should track hosted child browser-window attention state");
assert.match(componentSource, /progressBar: number \| null;/, "host should track hosted child browser-window progress value");
assert.match(componentSource, /progressBarMode: string;/, "host should track hosted child browser-window progress mode");
assert.match(componentSource, /windowButtonVisible: boolean;/, "host should track hosted child browser-window traffic-light visibility state");
assert.match(componentSource, /windowButtonPosition: PluginBrowserWindowPoint \| null;/, "host should track hosted child browser-window traffic-light position state");
assert.match(componentSource, /vibrancy: string;/, "host should track hosted child browser-window vibrancy state");
assert.match(componentSource, /vibrancyOptions: Record<string, unknown>;/, "host should track hosted child browser-window vibrancy options");
assert.match(componentSource, /backgroundMaterial: string;/, "host should track hosted child browser-window background material state");
assert.match(componentSource, /sheetOffsetY: number;/, "host should track hosted child browser-window sheet vertical offset");
assert.match(componentSource, /sheetOffsetX: number;/, "host should track hosted child browser-window sheet horizontal offset");
assert.match(componentSource, /documentEdited: boolean;/, "host should track hosted child browser-window document edited state");
assert.match(componentSource, /representedFilename: string;/, "host should track hosted child browser-window represented filename");
assert.match(componentSource, /modal: boolean;/, "host should track hosted child browser-window modal state");
assert.match(componentSource, /parentWindowId: string \| null;/, "host should track hosted child browser-window parent relationship");
assert.match(componentSource, /mediaSourceId: string;/, "host should track hosted child browser-window media source id");
assert.match(componentSource, /zOrder: number;/, "host should track hosted child browser-window z-order");
assert.match(componentSource, /devToolsOpened: boolean;/, "host should track hosted child browser-window DevTools open state");
assert.match(componentSource, /devToolsFocused: boolean;/, "host should track hosted child browser-window DevTools focus state");
assert.match(componentSource, /inspectedElement: PluginBrowserWindowInspectedElement \| null;/, "host should track the last inspected hosted child browser-window element");
assert.match(componentSource, /audioMuted: boolean;/, "host should track hosted child browser-window muted audio state");
assert.match(componentSource, /currentlyAudible: boolean;/, "host should track hosted child browser-window audible state");
assert.match(componentSource, /function normalizePluginBrowserWindowBounds\(/, "host should normalize browser-window bounds");
assert.match(componentSource, /function normalizePluginBrowserWindowSize\(/, "host should normalize browser-window sizes");
assert.match(componentSource, /function constrainPluginBrowserWindowSize\(/, "host should constrain browser-window sizes");
assert.match(componentSource, /function pluginBrowserWindowStyle\(/, "host should render browser-window bounds into CSS");
assert.match(componentSource, /function pluginBrowserWindowLayer\(/, "host should render browser-window z-order into CSS");
assert.match(componentSource, /class:hidden=\{!childWindow\.visible\}/, "host should hide child browser windows without destroying them");
assert.match(componentSource, /class:focused=\{childWindow\.focused\}/, "host should surface focused child browser windows");
assert.match(componentSource, /class:positioned=\{childWindow\.positioned\}/, "host should render explicit child browser-window positions");
assert.match(componentSource, /class:alwaysOnTop=\{childWindow\.alwaysOnTop\}/, "host should render always-on-top child browser windows");
assert.match(componentSource, /class:minimized=\{childWindow\.minimized\}/, "host should render minimized child browser windows");
assert.match(componentSource, /class:maximized=\{childWindow\.maximized\}/, "host should render maximized child browser windows");
assert.match(componentSource, /class:fullScreen=\{childWindow\.fullScreen\}/, "host should render full-screen child browser windows");
assert.match(componentSource, /class:kiosk=\{childWindow\.kiosk\}/, "host should render kiosk child browser windows");
assert.match(componentSource, /\.plugin-browser-window\.maximized,\s+\.plugin-browser-window\.kiosk,\s+\.plugin-browser-window\.fullScreen \{\s+position: absolute;\s+inset: 0;/, "hosted kiosk browser windows should fill the hosted layer");
assert.match(componentSource, /class:flashing=\{childWindow\.flashing\}/, "host should render attention-flashing child browser windows");
assert.match(componentSource, /class:noShadow=\{!childWindow\.hasShadow\}/, "host should render shadowless child browser windows");
assert.match(componentSource, /class:windowButtonsHidden=\{!childWindow\.windowButtonVisible\}/, "host should render hidden traffic-light state");
assert.match(componentSource, /plugin-browser-window-progress/, "host should render hosted child browser-window progress state");
assert.match(componentSource, /function pluginBridgeJson\(/, "bridge JSON injection should escape script-close sequences");
assert.match(componentSource, /PLUGIN_SCRIPT_CLOSE_RE/, "bridge JSON injection should not write raw </script> into inline payload data");
assert.match(componentSource, /class="plugin-browser-window"/, "host should render a visible child browser-window shell");
assert.doesNotMatch(componentSource, /createBrowserWindow unsupported/, "createBrowserWindow should no longer be a fixed unsupported path");
assert.doesNotMatch(componentSource, /sendToParent unsupported/, "sendToParent should no longer be a fixed unsupported path");
assert.match(appSource, /pluginHostSmoke\s*===\s*"browserWindow"/, "Web preview smoke should expose a browser-window scenario");
assert.match(appSource, /browserWindowSrcdoc/, "browser-window smoke should provide child iframe HTML");
assert.match(appSource, /browser-window-send/, "browser-window smoke should include a child sendToParent control");
assert.match(appSource, /__atoolsBrowserWindowSmoke/, "browser-window smoke should retain the created handle");
assert.match(
  appSource,
  /function expectHostedBrowserWindowUnsupported\(marker, invoke\)/,
  "browser-window preview smoke should keep a reusable isolation-error continuation helper",
);
for (const marker of [
  "inspect-element",
  "capture-page",
  "print-to-pdf",
  "save-page",
  "insert-text",
  "edit-select-all",
  "edit-copy",
  "edit-cut",
  "edit-paste",
  "selection-center",
  "selection-adjust",
  "selection-scroll-bottom",
  "selection-scroll-top",
]) {
  assert.match(
    appSource,
    new RegExp(`['\"]${marker}['\"]`),
    `browser-window preview smoke should explicitly continue after ${marker} isolation errors`,
  );
}
assert.match(appSource, /ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED/, "preview smoke should require the stable isolation error code");
assert.match(appSource, /data-browser-window-isolated-unsupported-complete/, "preview smoke should aggregate unsupported API continuations");
assert.match(appSource, /data-browser-window-smoke-complete/, "preview smoke should expose a final completion marker after unsupported branches continue");
assert.match(appSource, /win\.hide\(\)[\s\S]*win\.show\(\)[\s\S]*win\.focus\(\)/, "browser-window smoke should exercise hosted handle visibility/focus methods");
assert.match(appSource, /win\.setBounds\(/, "browser-window smoke should exercise hosted handle bounds updates");
assert.match(appSource, /win\.getBounds\(/, "browser-window smoke should verify hosted handle bounds");
assert.match(appSource, /win\.webContents\.send\(/, "browser-window smoke should exercise hosted webContents.send");
assert.match(appSource, /data-browser-window-webcontents-send/, "browser-window smoke should record hosted webContents.send accepted state");
assert.match(appSource, /ipcRenderer\.on\(/, "browser-window smoke child should receive hosted webContents.send messages through ipcRenderer.on");
assert.match(appSource, /ipcRenderer\.once\(/, "browser-window smoke child should receive hosted webContents.send messages through ipcRenderer.once");
assert.match(appSource, /data-child-ipc-ping/, "browser-window smoke child should record hosted ipcRenderer.on payloads");
assert.match(appSource, /data-child-ipc-once/, "browser-window smoke child should record hosted ipcRenderer.once payloads");
assert.match(appSource, /data-parent-message-channel/, "browser-window smoke should record child sendToParent callback channel on the parent iframe");
assert.match(appSource, /browser-window-ipc/, "browser-window smoke should route child sendToParent callback through browser-window-ipc channel");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.send\(channel, \.\.\.args\)` 会投递到对应 hosted child iframe；子窗口通过 `require\("electron"\)\.ipcRenderer\.on\(channel, listener\)` \/ `once\(\)` 接收 payload，并可继续用 `sendToParent\(\)` 回调父插件 iframe。$/m,
  "macOS smoke checklist should mark BrowserWindow webContents.send IPC row complete",
);
assert.match(appSource, /win\.webContents\.executeJavaScript\(/, "browser-window smoke should exercise hosted webContents.executeJavaScript");
const browserWindowExecuteJavaScriptReplaceTarget = `return win.webContents.executeJavaScript('document.body.setAttribute(\\"data-execute-js\\", String(21 * 2)); 21 * 2', true); }).then(function(result){ document.body.setAttribute('data-browser-window-execute-js', String(result === 42)); return win.webContents.executeJavaScript('document.getElementById(\\"browser-window-edit-target\\").focus(); true', true); }`;
assert.equal(
  appSource.split(browserWindowExecuteJavaScriptReplaceTarget).length - 1,
  2,
  "browser-window executeJavaScript smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-execute-js/, "browser-window smoke should record hosted webContents.executeJavaScript result");
assert.match(appSource, /data-execute-js/, "browser-window smoke child should record hosted webContents.executeJavaScript side effects");
assert.match(appSource, /data-browser-window-execute-js-error/, "browser-window smoke should record hosted webContents.executeJavaScript method-scoped errors");
assert.match(appSource, /execute-js-smoke/, "browser-window smoke should exercise a thrown child executeJavaScript error");
assert.match(appSource, /message\.indexOf\('webContents\.executeJavaScript'\) >= 0/, "browser-window smoke should require executeJavaScript method context in thrown errors");
assert.match(appSource, /message\.indexOf\('execute-js-smoke'\) >= 0/, "browser-window smoke should require the original thrown script error text");
assert.match(componentSource, /webContents\.executeJavaScript failed:/, "host should throw method-scoped executeJavaScript errors");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.executeJavaScript\(code\[, userGesture\]\)` 会在对应 hosted child iframe 中执行脚本，返回脚本结果或明确 method-scoped 错误，不返回静默成功。$/m,
  "macOS smoke checklist should mark BrowserWindow executeJavaScript row complete",
);
assert.match(appSource, /win\.webContents\.sendInputEvent\(/, "browser-window smoke should exercise hosted webContents.sendInputEvent");
const browserWindowSendInputEventReplaceTarget = "return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); }).then(function(inputResult){ document.body.setAttribute('data-browser-window-send-input-event', String(inputResult === undefined)); var findRequestId = win.webContents.findInPage('发送', { matchCase: false }); window.__atoolsBrowserWindowFindRequestId = findRequestId; document.body.setAttribute('data-browser-window-find-in-page', String(findRequestId > 0)); return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }";
assert.equal(
  appSource.split(browserWindowSendInputEventReplaceTarget).length - 1,
  2,
  "browser-window sendInputEvent smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(bridgeMatch[1], /new window\.KeyboardEvent\(/, "opaque child RPC should dispatch hosted keyboard input events in the child realm");
assert.match(bridgeMatch[1], /new window\.MouseEvent\(/, "opaque child RPC should dispatch hosted mouse input events in the child realm");
assert.match(bridgeMatch[1], /new window\.WheelEvent\(/, "opaque child RPC should dispatch hosted wheel input events in the child realm");
assert.match(componentSource, /pluginBrowserWindowRpc\.call\(windowId, "sendInputEvent"/, "host should route input through the isolated child RPC");
assert.match(appSource, /data-browser-window-send-input-event-dom/, "browser-window smoke should record keyboard/mouse/wheel DOM input state");
assert.match(appSource, /data-send-input-event-mouse/, "browser-window smoke child should record hosted mouse input events");
assert.match(appSource, /data-send-input-event-wheel/, "browser-window smoke child should record hosted wheel input events");
assert.match(appSource, /data-send-input-event-after-webcontents-reload/, "browser-window smoke child should record input after webContents loadURL/reload");
assert.match(appSource, /data-browser-window-send-input-event-after-webcontents-reload/, "browser-window smoke should verify post-load/reload input does not hit the initial empty document");
const browserWindowPostReloadInputReplaceTarget = "return win.webContents.reload(); }).then(function(webContentsReloadResult){ var stopResult = win.webContents.stop(); document.body.setAttribute('data-browser-window-webcontents-lifecycle', String(webContentsReloadResult && webContentsReloadResult.reloaded === true && stopResult === undefined && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame() && !win.webContents.isWaitingForResponse() && !win.webContents.isDestroyed() && win.webContents.getType() === 'window')); win.webContents.on('render-process-gone'";
assert.equal(
  appSource.split(browserWindowPostReloadInputReplaceTarget).length - 1,
  2,
  "browser-window post-reload input smoke replacement should match both the inserted lifecycle smoke and the replace target",
);
const browserWindowPostReloadClosureReplaceTarget = "}); var crashResult = win.webContents.forcefullyCrashRenderer(); document.body.setAttribute('data-browser-window-webcontents-crash', String(crashResult === undefined && win.webContents.isCrashed())); return win.webContents.reload(); }).then(function(webContentsCrashReloadResult){";
assert.equal(
  appSource.split(browserWindowPostReloadClosureReplaceTarget).length - 1,
  2,
  "browser-window post-reload input smoke closure replacement should match both the inserted lifecycle smoke and the replace target",
);
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.sendInputEvent\(inputEvent\)` 会在对应 hosted child iframe 中派发兼容 DOM 键盘、鼠标或滚轮事件；`loadURL\(\)` \/ `reload\(\)` 后续 WebContents 动作不应打到初始空文档。$/m,
  "macOS smoke checklist should mark BrowserWindow sendInputEvent row complete",
);
assert.match(appSource, /win\.webContents\.insertCSS\(/, "browser-window smoke should exercise hosted webContents.insertCSS");
assert.match(appSource, /win\.webContents\.removeInsertedCSS\(/, "browser-window smoke should exercise hosted webContents.removeInsertedCSS");
const browserWindowInsertCssReplaceTarget = `return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }).then(function(cssKey){ window.__atoolsBrowserWindowCssKey = cssKey; return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\\"--atools-insert-css\\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css', String(cssValue === 'inserted')); return win.webContents.removeInsertedCSS(window.__atoolsBrowserWindowCssKey); }).then(function(removeCssResult){ document.body.setAttribute('data-browser-window-remove-inserted-css', String(removeCssResult === undefined)); return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\\"--atools-insert-css\\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css-removed', String(cssValue === '')); return win.setContentSize(390, 240, true); }`;
assert.equal(
  appSource.split(browserWindowInsertCssReplaceTarget).length - 1,
  2,
  "browser-window insertCSS/removeInsertedCSS smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-css-key/, "browser-window smoke should verify returned hosted insertCSS key shape");
assert.match(
  appSource,
  /\/\^plugin-browser-window-\[0-9\]\+:css:\[0-9\]\+\$\/\.test\(String\(cssKey\)\)/,
  "browser-window smoke should validate the returned hosted insertCSS key shape",
);
assert.match(appSource, /data-browser-window-css-no-residual-style/, "browser-window smoke should verify removeInsertedCSS leaves no keyed style nodes");
assert.match(appSource, /style\[data-atools-browser-window-css-key\]/, "browser-window smoke should inspect keyed inserted stylesheet nodes");
assert.match(appSource, /cssState && cssState\.residual === 0/, "browser-window smoke should require zero residual keyed style nodes after removeInsertedCSS");
assert.match(bridgeMatch[1], /style\.setAttribute\('data-atools-browser-window-css-key', cssKey\)/, "opaque child RPC should tag inserted BrowserWindow CSS with a keyed stylesheet attribute");
assert.match(bridgeMatch[1], /style\.setAttribute\('data-atools-browser-window-css-origin'/, "opaque child RPC should tag inserted BrowserWindow CSS with normalized origin");
assert.match(componentSource, /pluginBrowserWindowInsertedCss\.set\(key, \{ windowId, key, css, cssOrigin \}\)/, "host should keep a keyed BrowserWindow CSS registry");
assert.match(bridgeMatch[1], /document\.querySelectorAll\('style\[data-atools-browser-window-css-key\]'\)/, "opaque child RPC should remove BrowserWindow CSS by keyed stylesheet selector");
assert.match(componentSource, /pluginBrowserWindowInsertedCss\.delete\(key\)/, "host should delete keyed BrowserWindow CSS registry entries after removal");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.insertCSS\(css\[, options\]\)` 会向对应 hosted child iframe 注入 keyed stylesheet 并返回 key；`webContents\.removeInsertedCSS\(key\)` 会移除同一 key 的 stylesheet，移除后 child iframe 不残留 injected style。$/m,
  "macOS smoke checklist should mark BrowserWindow insertCSS/removeInsertedCSS row complete",
);
assert.match(appSource, /win\.webContents\.findInPage\(/, "browser-window smoke should exercise hosted webContents.findInPage");
assert.match(appSource, /win\.webContents\.stopFindInPage\(/, "browser-window smoke should exercise hosted webContents.stopFindInPage");
assert.match(appSource, /win\.webContents\.on\(['"]found-in-page/, "browser-window smoke should exercise hosted webContents found-in-page events");
const browserWindowFindInPageListenerReplaceTarget = "win.webContents.on('found-in-page', function(_event, result){ document.body.setAttribute('data-browser-window-found-in-page', String(result && result.matches >= 1 && result.finalUpdate === true)); document.body.setAttribute('data-browser-window-found-request', String(result && result.requestId === window.__atoolsBrowserWindowFindRequestId)); win.webContents.stopFindInPage('clearSelection'); document.body.setAttribute('data-browser-window-stop-find-in-page', 'true'); }); win.webContents.on('devtools-opened'";
assert.equal(
  appSource.split(browserWindowFindInPageListenerReplaceTarget).length - 1,
  2,
  "browser-window findInPage smoke listener replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-find-in-page/, "browser-window smoke should record synchronous findInPage request id");
assert.match(appSource, /result && result\.matches >= 1 && result\.finalUpdate === true/, "browser-window smoke should verify final found-in-page match result");
assert.match(appSource, /result && result\.requestId === window\.__atoolsBrowserWindowFindRequestId/, "browser-window smoke should verify found-in-page event is targeted to the request id");
assert.match(appSource, /var stopFindResult = win\.webContents\.stopFindInPage\('clearSelection'\)/, "browser-window smoke should capture stopFindInPage return shape");
assert.match(appSource, /data-browser-window-stop-find-in-page', String\(stopFindResult === undefined\)/, "browser-window smoke should verify stopFindInPage void-return shape");
assert.match(componentSource, /dispatchPluginBrowserWindowWebContentsEvent\(windowId, "found-in-page", \[result\]\)/, "host should dispatch targeted BrowserWindow found-in-page events");
assert.match(bridgeMatch[1], /activeMatchOrdinal: matches <= 0 \? 0 : \(forward \? 1 : matches\)/, "opaque child RPC should compute BrowserWindow found-in-page active match ordinal");
assert.match(bridgeMatch[1], /finalUpdate: true/, "opaque child RPC should mark BrowserWindow found-in-page result as final");
assert.match(componentSource, /lastBrowserWindowMessage = \{ windowId, channel: "webContents:stopFindInPage", args: \[action\] \}/, "host should route BrowserWindow stopFindInPage to the targeted child window");
assert.match(componentSource, /pluginBrowserWindowRpc\.call\(windowId, "stopFindInPage", \{ action \}\)/, "host should clear selection only through the isolated child RPC");
assert.doesNotMatch(componentSource, /frame\.contentWindow[^\n;]*getSelection/, "host must not read an isolated child selection directly");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.findInPage\(text\[, options\]\)` 会同步返回 request id，并通过 `webContents\.on\("found-in-page", listener\)` 向父插件派发 targeted 查找结果；`webContents\.stopFindInPage\(action\)` 会路由到同一 hosted child iframe 且保持 void-return shape。$/m,
  "macOS smoke checklist should mark BrowserWindow findInPage/stopFindInPage row complete",
);
assert.match(appSource, /win\.webContents\.getURL\(\)/, "browser-window smoke should exercise hosted webContents.getURL");
assert.match(appSource, /win\.webContents\.loadURL\(/, "browser-window smoke should exercise hosted webContents.loadURL");
assert.match(appSource, /win\.webContents\.reload\(\)/, "browser-window smoke should exercise hosted webContents.reload");
assert.match(appSource, /win\.webContents\.stop\(\)/, "browser-window smoke should exercise hosted webContents.stop");
assert.match(appSource, /win\.webContents\.isDestroyed\(\)/, "browser-window smoke should verify hosted webContents destroyed state");
assert.match(appSource, /win\.webContents\.isWaitingForResponse\(\)/, "browser-window smoke should verify hosted webContents waiting-for-response state");
assert.match(appSource, /data-browser-window-webcontents-waiting-response/, "browser-window smoke should record hosted WebContents waiting-for-response state");
assert.match(appSource, /win\.webContents\.getType\(\)/, "browser-window smoke should verify hosted webContents type");
assert.match(appSource, /win\.webContents\.isCrashed\(\)/, "browser-window smoke should verify hosted webContents crash state");
assert.match(appSource, /win\.webContents\.forcefullyCrashRenderer\(\)/, "browser-window smoke should exercise hosted webContents.forcefullyCrashRenderer");
assert.match(appSource, /data-browser-window-render-process-gone/, "browser-window smoke should verify hosted render-process-gone event");
assert.match(appSource, /win\.webContents\.focus\(\)/, "browser-window smoke should exercise hosted webContents.focus");
assert.match(appSource, /win\.webContents\.isFocused\(\)/, "browser-window smoke should verify hosted webContents focus state");
assert.match(appSource, /win\.webContents\.getOwnerBrowserWindow\(\)/, "browser-window smoke should verify hosted webContents owner window");
assert.match(appSource, /win\.webContents\.getMediaSourceId\(\)/, "browser-window smoke should verify hosted webContents media source id");
assert.match(appSource, /win\.webContents\.isBeingCaptured\(\)/, "browser-window smoke should verify hosted webContents capture state");
assert.match(appSource, /win\.webContents\.setIgnoreMenuShortcuts\(/, "browser-window smoke should exercise hosted webContents menu shortcut state");
assert.match(appSource, /data-browser-window-webcontents-focus-state/, "browser-window smoke should record hosted webContents focus state");
assert.match(appSource, /data-browser-window-webcontents-owner-media/, "browser-window smoke should record hosted webContents owner/media state");
assert.match(appSource, /win\.webContents\.reloadIgnoringCache\(\)/, "browser-window smoke should exercise hosted webContents.reloadIgnoringCache");
assert.match(appSource, /win\.webContents\.goBack\(\)/, "browser-window smoke should exercise hosted webContents.goBack");
assert.match(appSource, /win\.webContents\.goForward\(\)/, "browser-window smoke should exercise hosted webContents.goForward");
const browserWindowNavigationStateReplaceTarget = "return win.loadURL('child-reloaded.html'); }).then(function(){ return win.getURL(); }).then(function(url){ document.body.setAttribute('data-browser-window-url', url); document.body.setAttribute('data-browser-window-webcontents-url', win.webContents.getURL()); document.body.setAttribute('data-browser-window-webcontents-title', win.webContents.getTitle()); document.body.setAttribute('data-browser-window-webcontents-loading', String(!win.webContents.isLoading() && !win.webContents.isLoadingMainFrame())); document.body.setAttribute('data-browser-window-can-go-back', String(win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.reloadIgnoringCache(); }).then(function(reloadIgnoringCacheResult){ document.body.setAttribute('data-browser-window-reload-ignoring-cache', String(reloadIgnoringCacheResult && reloadIgnoringCacheResult.ignoreCache === true)); return win.webContents.goBack(); }).then(function(backResult){ document.body.setAttribute('data-browser-window-go-back', String(backResult && backResult.url === 'child.html' && !win.webContents.canGoBack() && win.webContents.canGoForward())); return win.webContents.goForward(); }).then(function(forwardResult){ document.body.setAttribute('data-browser-window-go-forward', String(forwardResult && forwardResult.url === 'child-reloaded.html' && win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }";
assert.equal(
  appSource.split(browserWindowNavigationStateReplaceTarget).length - 1,
  2,
  "browser-window navigation smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-navigation-sync-state/, "browser-window smoke should record hosted navigation sync state");
assert.match(appSource, /navigationInitialOk/, "browser-window smoke should verify initial hosted navigation getters");
assert.match(appSource, /reloadNavigationOk/, "browser-window smoke should verify reloadIgnoringCache keeps hosted navigation state synchronized");
assert.match(appSource, /backNavigationOk/, "browser-window smoke should verify goBack synchronizes hosted history state");
assert.match(appSource, /forwardNavigationOk/, "browser-window smoke should verify goForward synchronizes hosted history state");
assert.match(componentSource, /function syncWebContentsNavigationState\(result, options\)/, "bridge should synchronize hosted WebContents navigation state into the handle cache");
assert.match(componentSource, /webContentsUrl = nextUrl;/, "bridge should update cached hosted WebContents URL");
assert.match(componentSource, /webContentsTitle = nextTitle;/, "bridge should update cached hosted WebContents title");
assert.match(componentSource, /webContentsLoading = record\.loading === true;/, "bridge should update cached hosted WebContents loading state");
assert.match(componentSource, /if \(Number\.isInteger\(record\.historyIndex\)\) webContentsHistoryIndex = record\.historyIndex;/, "bridge should synchronize hosted WebContents history index");
assert.match(componentSource, /return navigatePluginBrowserWindowHistory\(existing, "back"\);/, "host should route webContents.goBack through hosted history");
assert.match(componentSource, /return navigatePluginBrowserWindowHistory\(existing, "forward"\);/, "host should route webContents.goForward through hosted history");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.getURL\(\)` \/ `getTitle\(\)` \/ `isLoading\(\)` \/ `isLoadingMainFrame\(\)` \/ `canGoBack\(\)` \/ `canGoForward\(\)` 会读取 hosted child iframe 导航状态；`webContents\.reloadIgnoringCache\(\)` \/ `goBack\(\)` \/ `goForward\(\)` 会路由到同一 hosted history，back\/forward 后 sync 状态同步更新。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents navigation state row complete",
);
assert.match(appSource, /win\.webContents\.loadURL\(/, "browser-window smoke should exercise hosted webContents.loadURL");
assert.match(appSource, /win\.webContents\.reload\(\)/, "browser-window smoke should exercise hosted webContents.reload");
assert.match(appSource, /win\.webContents\.stop\(\)/, "browser-window smoke should exercise hosted webContents.stop");
assert.match(appSource, /win\.webContents\.isDestroyed\(\)/, "browser-window smoke should verify hosted webContents destroyed state");
assert.match(appSource, /win\.webContents\.getType\(\)/, "browser-window smoke should verify hosted webContents type");
const browserWindowWebContentsLifecycleReplaceTarget = "win.webContents.setZoomFactor(1.5); document.body.setAttribute('data-browser-window-zoom-factor'";
assert.equal(
  appSource.split(browserWindowWebContentsLifecycleReplaceTarget).length - 1,
  3,
  "browser-window WebContents lifecycle smoke replacement should match the srcdoc base string, replace target, and replacement output",
);
assert.match(appSource, /data-browser-window-webcontents-load-url/, "browser-window smoke should record hosted webContents.loadURL state");
assert.match(appSource, /data-browser-window-webcontents-lifecycle/, "browser-window smoke should record hosted webContents lifecycle state");
assert.match(appSource, /webContentsLoadResult && webContentsLoadResult\.url === 'child-webcontents\.html'/, "browser-window smoke should verify hosted webContents.loadURL result and URL cache");
assert.match(appSource, /webContentsReloadResult && webContentsReloadResult\.reloaded === true/, "browser-window smoke should verify hosted webContents.reload result");
assert.match(appSource, /stopResult === undefined && !win\.webContents\.isLoading\(\) && !win\.webContents\.isLoadingMainFrame\(\)/, "browser-window smoke should verify webContents.stop clears hosted loading state");
assert.match(appSource, /!win\.webContents\.isDestroyed\(\) && win\.webContents\.getType\(\) === 'window'/, "browser-window smoke should verify hosted WebContents type and live destroyed state");
assert.match(componentSource, /loadURL: function\(url, options\) \{ return webContentsNavigationAction\('webContents\.loadURL', String\(url \|\| ''\), options \|\| \{\}\); \}/, "bridge should route webContents.loadURL through hosted navigation state");
assert.match(componentSource, /reload: function\(\) \{ return webContentsNavigationAction\('webContents\.reload'\); \}/, "bridge should route webContents.reload through hosted navigation state");
assert.match(componentSource, /function webContentsStop\(\) \{\n      webContentsLoading = false;/, "bridge should synchronously clear hosted loading state on stop");
assert.match(componentSource, /isDestroyed: function\(\) \{ return destroyed; \}/, "bridge should expose hosted WebContents destroyed state");
assert.match(componentSource, /getType: function\(\) \{ return 'window'; \}/, "bridge should expose hosted WebContents type");
assert.match(componentSource, /return loadPluginBrowserWindowUrl\(existing, String\(actionArgs\[0\] \?\? ""\), false\);/, "host should route webContents.loadURL to hosted child iframe navigation");
assert.match(componentSource, /return loadPluginBrowserWindowUrl\(existing, existing\.url, true\);/, "host should route webContents.reload to hosted child iframe navigation");
assert.match(componentSource, /return stopPluginBrowserWindowLoading\(id\);/, "host should route webContents.stop to hosted loading state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.loadURL\(url\[, options\]\)` \/ `reload\(\)` \/ `stop\(\)` \/ `isDestroyed\(\)` \/ `getType\(\)` 会路由到 hosted child iframe navigation\/lifecycle state；`loadURL\(\)` \/ `reload\(\)` 更新 hosted URL\/title\/history\/loading state，`stop\(\)` 保持 void-return shape 并同步清理 hosted loading\/loading-main-frame，`isDestroyed\(\)` 随 hosted close\/closed event 更新，`getType\(\)` 在当前宿主内返回 `"window"`。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents lifecycle row complete",
);
assert.match(appSource, /data-browser-window-render-process-gone/, "browser-window smoke should record targeted render-process-gone event state");
assert.match(appSource, /data-browser-window-webcontents-crash/, "browser-window smoke should record hosted crash state");
assert.match(appSource, /data-browser-window-webcontents-crash-reload/, "browser-window smoke should record hosted crash reload recovery state");
assert.match(appSource, /details && details\.reason === 'crashed' && details\.exitCode === 1/, "browser-window smoke should verify render-process-gone crash details");
assert.match(appSource, /crashResult === undefined && win\.webContents\.isCrashed\(\)/, "browser-window smoke should verify forcefullyCrashRenderer keeps void-return and sync crash state");
assert.match(appSource, /webContentsCrashReloadResult && webContentsCrashReloadResult\.reloaded === true && !win\.webContents\.isCrashed\(\)/, "browser-window smoke should verify reload clears hosted crash state");
assert.match(componentSource, /function syncWebContentsCrashEvent\(name\) \{\n      if \(String\(name \|\| ''\) === 'render-process-gone'\) webContentsCrashed = true;/, "bridge should update hosted crash cache from targeted render-process-gone events");
assert.match(componentSource, /function webContentsForcefullyCrashRenderer\(\) \{\n      webContentsCrashed = true;/, "bridge should synchronously mark hosted WebContents crashed before the host responds");
assert.match(componentSource, /forcefullyCrashRenderer: function\(\) \{ return webContentsForcefullyCrashRenderer\(\); \}/, "bridge should expose forcefullyCrashRenderer on hosted WebContents");
assert.match(componentSource, /function forcefullyCrashPluginBrowserWindowRenderer\(id: string\)/, "host should implement hosted WebContents crash lifecycle");
assert.match(componentSource, /const details = \{ reason: "crashed", exitCode: 1 \};/, "host should use explicit hosted crash details");
assert.match(componentSource, /updatedWindow = \{ \.\.\.childWindow, loading: false, crashed: true \};/, "host should mark hosted child iframe crashed and stop loading");
assert.match(componentSource, /dispatchPluginBrowserWindowWebContentsEvent\(id, "render-process-gone", \[details\]\)/, "host should dispatch targeted render-process-gone for forcefullyCrashRenderer");
assert.match(
  componentSource,
  /url: nextUrl,\n\s+title,\n\s+srcdoc,\n\s+documentGeneration: navigationToken,\n\s+visible: true,\n\s+loading: true,\n\s+crashed: false,\n\s+\.\.\.nextHistory,/,
  "host loadURL should use its reserved navigation token as the document generation and clear hosted crash state",
);
assert.match(componentSource, /updatedWindow = \{ \.\.\.childWindow, title: finalTitle, loading: false, crashed: false \};/, "host reload should clear hosted crash state after the child iframe is ready");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.isCrashed\(\)` \/ `forcefullyCrashRenderer\(\)` 会路由到 hosted child iframe crash lifecycle state；`forcefullyCrashRenderer\(\)` 保持 void-return shape，同步标记 hosted crashed state，并向父插件派发 targeted `render-process-gone` 事件，随后 `reload\(\)` \/ `loadURL\(\)` \/ history navigation 会清理 hosted crashed state。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents crash lifecycle row complete",
);
assert.match(appSource, /var focusResult = win\.webContents\.focus\(\);/, "browser-window smoke should exercise hosted webContents.focus");
assert.match(appSource, /var ignoreMenuShortcutsResult = win\.webContents\.setIgnoreMenuShortcuts\(true\);/, "browser-window smoke should exercise hosted webContents.setIgnoreMenuShortcuts");
assert.match(appSource, /focusResult === undefined && win\.webContents\.isFocused\(\)/, "browser-window smoke should verify focus keeps void-return shape and sync getter state");
assert.match(appSource, /win\.webContents\.getOwnerBrowserWindow\(\) === win && \/\^web-contents:\[0-9\]\+:0\$\/\.test\(win\.webContents\.getMediaSourceId\(\)\) && win\.webContents\.isBeingCaptured\(\) === false && ignoreMenuShortcutsResult === undefined/, "browser-window smoke should verify owner handle, hosted media source id, capture state, and shortcut void-return");
assert.match(componentSource, /var webContentsMediaSourceId = typeof record\.webContentsMediaSourceId === 'string' && record\.webContentsMediaSourceId/, "bridge should initialize hosted WebContents media source id from host state");
assert.match(componentSource, /var webContentsFocused = record\.webContentsFocused === true \|\| record\.focused === true;/, "bridge should initialize hosted WebContents focus cache");
assert.match(componentSource, /function webContentsFocus\(\) \{\n      webContentsFocused = true;/, "bridge should synchronously update hosted WebContents focus cache");
assert.match(componentSource, /function webContentsSetIgnoreMenuShortcuts\(ignore\) \{\n      var nextIgnore = ignore === true;\n      webContentsIgnoreMenuShortcuts = nextIgnore;/, "bridge should synchronously update hosted WebContents shortcut cache");
assert.match(componentSource, /focus: function\(\) \{ return webContentsFocus\(\); \}/, "bridge should expose hosted webContents.focus");
assert.match(componentSource, /isFocused: function\(\) \{ return webContentsFocused; \}/, "bridge should expose hosted webContents.isFocused");
assert.match(componentSource, /getOwnerBrowserWindow: function\(\) \{ return handle; \}/, "bridge should return the hosted BrowserWindow handle as webContents owner");
assert.match(componentSource, /getMediaSourceId: function\(\) \{ return webContentsMediaSourceId; \}/, "bridge should expose hosted WebContents media source id");
assert.match(componentSource, /isBeingCaptured: function\(\) \{ return webContentsBeingCaptured; \}/, "bridge should expose hosted WebContents capture state");
assert.match(componentSource, /setIgnoreMenuShortcuts: function\(ignore\) \{ return webContentsSetIgnoreMenuShortcuts\(ignore\); \}/, "bridge should expose hosted webContents.setIgnoreMenuShortcuts");
assert.match(componentSource, /function focusPluginBrowserWindowWebContents\(id: string\)/, "host should implement hosted WebContents focus action");
assert.match(componentSource, /updatedWindow = \{ \.\.\.childWindow, visible: true, focused, webContentsFocused: focused \};/, "host focus should update hosted child iframe focus state");
assert.match(componentSource, /dispatchPluginBrowserWindowEvent\(id, "focus", \[\{ visible: true, focused, closed: false \}\]\);/, "host focus should dispatch hosted focus event state");
assert.match(componentSource, /function setPluginBrowserWindowIgnoreMenuShortcuts\(id: string, value: unknown\)/, "host should implement hosted WebContents shortcut action");
assert.match(componentSource, /const ignoreMenuShortcuts = value === true;/, "host should normalize hosted ignore-menu-shortcuts state");
assert.match(componentSource, /lastBrowserWindowMessage = \{ windowId: id, channel: "webContents:setIgnoreMenuShortcuts", args: \[ignoreMenuShortcuts\] \};/, "host should record hosted ignore-menu-shortcuts action");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.focus\(\)` \/ `isFocused\(\)` \/ `getOwnerBrowserWindow\(\)` \/ `getMediaSourceId\(\)` \/ `isBeingCaptured\(\)` \/ `setIgnoreMenuShortcuts\(ignore\)` 会路由到 hosted child iframe focus\/owner\/media\/shortcut state；`focus\(\)` \/ `setIgnoreMenuShortcuts\(\)` 保持 void-return shape，sync getter 立即可读，owner 返回当前 hosted BrowserWindow handle，media source id 为 hosted compatibility id。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents focus/owner/media/shortcut row complete",
);
assert.match(appSource, /win\.webContents\.navigationHistory\.goToOffset\(/, "browser-window smoke should exercise hosted webContents.navigationHistory.goToOffset");
assert.match(appSource, /win\.webContents\.navigationHistory\.goForward\(\)/, "browser-window smoke should exercise hosted webContents.navigationHistory.goForward");
assert.match(appSource, /win\.webContents\.navigationHistory\.clear\(\)/, "browser-window smoke should exercise hosted webContents.navigationHistory.clear");
assert.match(appSource, /data-browser-window-navigation-history/, "browser-window smoke should record hosted webContents navigationHistory state");
assert.match(appSource, /navigationOffsetResult === undefined && navigationForwardResult === undefined && navigationClearResult === undefined/, "browser-window smoke should verify navigationHistory actions keep void-return shape");
assert.match(appSource, /navigationOffsetOk && navigationForwardOk && !win\.webContents\.navigationHistory\.canGoBack\(\) && !win\.webContents\.navigationHistory\.canGoForward\(\)/, "browser-window smoke should verify navigationHistory can-go state and clear collapse");
assert.match(componentSource, /var navigationHistory = \{\n      canGoBack: function\(\) \{ return webContentsHistoryIndex > 0; \},\n      canGoForward: function\(\) \{ return webContentsHistoryIndex >= 0 && webContentsHistoryIndex < webContentsHistory\.length - 1; \},/, "bridge should expose synchronous navigationHistory can-go getters");
assert.match(componentSource, /goBack: function\(\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goBack'\); \},/, "bridge should route navigationHistory.goBack through hosted history action");
assert.match(componentSource, /goForward: function\(\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goForward'\); \},/, "bridge should route navigationHistory.goForward through hosted history action");
assert.match(componentSource, /goToIndex: function\(index\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goToIndex', navigationHistoryIndex\(index\)\); \},/, "bridge should normalize and route navigationHistory.goToIndex");
assert.match(componentSource, /canGoToOffset: function\(offset\) \{ return navigationHistoryCanGoToOffset\(offset\); \},/, "bridge should expose synchronous navigationHistory.canGoToOffset");
assert.match(componentSource, /goToOffset: function\(offset\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goToOffset', navigationHistoryOffset\(offset\)\); \},/, "bridge should normalize and route navigationHistory.goToOffset");
assert.match(componentSource, /clear: function\(\) \{ return navigationHistoryClear\(\); \},/, "bridge should expose navigationHistory.clear");
assert.match(componentSource, /function navigationHistoryClear\(\) \{\n      if \(webContentsUrl\) \{\n        webContentsHistory = \[webContentsUrl\];\n        webContentsHistoryIndex = 0;/, "bridge should synchronously collapse hosted history during navigationHistory.clear");
assert.match(componentSource, /function navigatePluginBrowserWindowHistoryToIndex\(\n    existing: PluginBrowserWindowState,\n    nextIndex: number,\n    label: string\n  \)/, "host should implement navigationHistory index routing");
assert.match(componentSource, /updatedWindow = \{ \.\.\.childWindow, title: finalTitle, history, loading: false, crashed: false \};/, "host should finish navigationHistory navigation with synced title, history, loading, and crash state");
assert.match(componentSource, /function clearPluginBrowserWindowNavigationHistory\(id: string\)/, "host should implement navigationHistory.clear routing");
assert.match(componentSource, /history: \[currentEntry\],\n        historyIndex: 0,\n        loading: false,\n        crashed: false,/, "host navigationHistory.clear should collapse hosted history to current entry");
assert.match(componentSource, /if \(actionName === "webContents\.navigationHistory\.goBack"\)/, "host should route navigationHistory.goBack actions");
assert.match(componentSource, /if \(actionName === "webContents\.navigationHistory\.goForward"\)/, "host should route navigationHistory.goForward actions");
assert.match(componentSource, /if \(actionName === "webContents\.navigationHistory\.goToIndex"\)/, "host should route navigationHistory.goToIndex actions");
assert.match(componentSource, /if \(actionName === "webContents\.navigationHistory\.goToOffset"\)/, "host should route navigationHistory.goToOffset actions");
assert.match(componentSource, /if \(actionName === "webContents\.navigationHistory\.clear"\)/, "host should route navigationHistory.clear actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.navigationHistory\.canGoBack\(\)` \/ `canGoForward\(\)` \/ `goBack\(\)` \/ `goForward\(\)` \/ `goToIndex\(index\)` \/ `canGoToOffset\(offset\)` \/ `goToOffset\(offset\)` \/ `clear\(\)` 会路由到 hosted child iframe navigation history state；动作方法保持 void-return shape，sync getter 立即可读，`clear\(\)` 会把 hosted history 折叠到当前 entry。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents navigationHistory row complete",
);
assert.match(appSource, /var webContentsWaitingResponsePromise = win\.webContents\.loadURL\('child-webcontents\.html', \{ userAgent: 'AToolsWebContentsSmoke\/240' \}\);/, "browser-window smoke should start a hosted loadURL waiting-response probe");
assert.match(appSource, /window\.__atoolsBrowserWindowWaitingDuringLoad = win\.webContents\.isWaitingForResponse\(\);/, "browser-window smoke should read waiting-response while hosted loadURL is pending");
assert.match(appSource, /data-browser-window-webcontents-waiting-response', String\(window\.__atoolsBrowserWindowWaitingDuringLoad === true && win\.webContents\.isWaitingForResponse\(\) === false\)/, "browser-window smoke should record pending true and completed false waiting-response state");
assert.match(appSource, /!win\.webContents\.isWaitingForResponse\(\) && !win\.webContents\.isDestroyed\(\) && win\.webContents\.getType\(\) === 'window'/, "browser-window lifecycle smoke should verify stop clears waiting-response state");
assert.match(componentSource, /function webContentsNavigationAction\(action\) \{\n      webContentsLoading = true;/, "bridge should synchronously mark hosted WebContents waiting while navigation is pending");
assert.match(componentSource, /webContentsLoading = false;\n        return syncWebContentsNavigationState\(result, \{ push: action === 'loadURL' \|\| action === 'webContents\.loadURL' \}\);/, "bridge should clear hosted waiting before applying completed navigation state");
assert.match(componentSource, /webContentsLoading = false;\n        throw err;/, "bridge should clear hosted waiting when navigation rejects");
assert.match(componentSource, /webContentsLoading = record\.loading === true;/, "bridge should sync hosted waiting from host navigation result");
assert.match(componentSource, /isWaitingForResponse: function\(\) \{ return webContentsLoading; \}/, "bridge should expose isWaitingForResponse from hosted loading cache");
assert.match(componentSource, /function webContentsStop\(\) \{\n      webContentsLoading = false;/, "bridge should synchronously clear hosted waiting on stop");
assert.match(componentSource, /return stopPluginBrowserWindowLoading\(id\);/, "host should route webContents.stop to hosted loading cleanup");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.isWaitingForResponse\(\)` 会读取 hosted child iframe waiting-response state；`loadURL\(\)` pending 期间可同步读到 true，hosted response 完成、`stop\(\)` 或 lifecycle 清理后应回到 false。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents waiting-response row complete",
);
assert.match(appSource, /return win\.webContents\.insertText\('hosted edit'\);/, "browser-window smoke should insert hosted text into the focused child editable target");
assert.match(appSource, /data-browser-window-insert-text', String\(insertTextResult === undefined\)/, "browser-window smoke should verify insertText resolves with undefined");
assert.match(appSource, /var selectAllResult = win\.webContents\.selectAll\(\); var copyResult = win\.webContents\.copy\(\); var cutResult = win\.webContents\.cut\(\); var pasteResult = win\.webContents\.paste\(\);/, "browser-window smoke should exercise hosted selection and edit clipboard commands");
assert.match(appSource, /data-browser-window-edit-commands', String\(selectAllResult === undefined && copyResult === undefined && cutResult === undefined && pasteResult === undefined\)/, "browser-window smoke should verify hosted editing commands preserve void-return shape");
assert.match(appSource, /data-browser-window-edit-value', String\(editValue === 'hosted edit'\)/, "browser-window smoke should verify hosted edit clipboard restores the child editable value");
assert.match(componentSource, /insertText: function\(text\) \{ return webContentsInsertText\(text\); \}/, "bridge should expose webContents.insertText");
assert.match(componentSource, /undo: function\(\) \{ return webContentsEditAction\('webContents\.undo'\); \}/, "bridge should expose webContents.undo");
assert.match(componentSource, /redo: function\(\) \{ return webContentsEditAction\('webContents\.redo'\); \}/, "bridge should expose webContents.redo");
assert.match(componentSource, /cut: function\(\) \{ return webContentsEditAction\('webContents\.cut'\); \}/, "bridge should expose webContents.cut");
assert.match(componentSource, /copy: function\(\) \{ return webContentsEditAction\('webContents\.copy'\); \}/, "bridge should expose webContents.copy");
assert.match(componentSource, /paste: function\(\) \{ return webContentsEditAction\('webContents\.paste'\); \}/, "bridge should expose webContents.paste");
assert.match(componentSource, /pasteAndMatchStyle: function\(\) \{ return webContentsEditAction\('webContents\.pasteAndMatchStyle'\); \}/, "bridge should expose webContents.pasteAndMatchStyle");
assert.match(componentSource, /delete: function\(\) \{ return webContentsEditAction\('webContents\.delete'\); \}/, "bridge should expose webContents.delete");
assert.match(componentSource, /selectAll: function\(\) \{ return webContentsEditAction\('webContents\.selectAll'\); \}/, "bridge should expose webContents.selectAll");
assert.match(componentSource, /unselect: function\(\) \{ return webContentsEditAction\('webContents\.unselect'\); \}/, "bridge should expose webContents.unselect");
assert.match(componentSource, /replace: function\(text\) \{ return webContentsEditAction\('webContents\.replace', String\(text == null \? '' : text\)\); \}/, "bridge should expose webContents.replace");
assert.match(componentSource, /replaceMisspelling: function\(text\) \{ return webContentsEditAction\('webContents\.replaceMisspelling', String\(text == null \? '' : text\)\); \}/, "bridge should expose webContents.replaceMisspelling");
assert.match(componentSource, /async function editPluginBrowserWindowText\(windowId: string, actionName: string, args: unknown\[\]\)/, "host should preserve the public editing action route");
assert.match(componentSource, /async function editPluginBrowserWindowText[\s\S]*?throw hostedBrowserWindowUnsupported\(actionName\);/, "isolated hosted BrowserWindow editing must reject explicitly instead of touching child DOM");
assert.doesNotMatch(componentSource, /function editPluginBrowserWindowTextCommand\(|pluginBrowserWindowEditClipboard/, "host must not retain direct child editing or clipboard machinery");
assert.match(appSource, /var centerSelectionResult = win\.webContents\.centerSelection\(\); var adjustSelectionResult = win\.webContents\.adjustSelection\(\{ start: 1, end: -1 \}\); var scrollBottomResult = win\.webContents\.scrollToBottom\(\); var scrollTopResult = win\.webContents\.scrollToTop\(\);/, "browser-window smoke should exercise hosted selection and scroll commands together");
assert.match(appSource, /data-browser-window-selection-scroll-commands', String\(centerSelectionResult === undefined && adjustSelectionResult === undefined && scrollBottomResult === undefined && scrollTopResult === undefined\)/, "browser-window smoke should verify selection and scroll commands preserve void-return shape");
assert.match(appSource, /data-browser-window-adjust-selection', String\(selectionScrollState && selectionScrollState\.start === 1 && selectionScrollState\.end === 10\)/, "browser-window smoke should verify adjustSelection updates focused input selection deterministically");
assert.match(appSource, /data-browser-window-scroll-top', String\(selectionScrollState && selectionScrollState\.scrollTop === 0\)/, "browser-window smoke should verify scrollToTop resets the hosted child document scroll position");
assert.match(componentSource, /centerSelection: function\(\) \{ return webContentsEditAction\('webContents\.centerSelection'\); \}/, "bridge should expose webContents.centerSelection");
assert.match(componentSource, /scrollToTop: function\(\) \{ return webContentsEditAction\('webContents\.scrollToTop'\); \}/, "bridge should expose webContents.scrollToTop");
assert.match(componentSource, /scrollToBottom: function\(\) \{ return webContentsEditAction\('webContents\.scrollToBottom'\); \}/, "bridge should expose webContents.scrollToBottom");
assert.match(componentSource, /adjustSelection: function\(options\) {\n        var selectionOptions = options && typeof options === 'object' && !Array\.isArray\(options\) \? options : {};\n        return webContentsEditAction\('webContents\.adjustSelection', {\n          start: Number\(selectionOptions\.start \|\| 0\),\n          end: Number\(selectionOptions\.end \|\| 0\),\n        }\);/, "bridge should normalize and expose webContents.adjustSelection");
assert.match(componentSource, /async function controlPluginBrowserWindowSelection\(windowId: string, actionName: string, args: unknown\[\]\)/, "host should route BrowserWindow WebContents selection and scroll actions");
assert.match(componentSource, /async function controlPluginBrowserWindowSelection[\s\S]*?throw hostedBrowserWindowUnsupported\(actionName\);/, "isolated hosted BrowserWindow selection commands must reject explicitly");
assert.doesNotMatch(componentSource, /function scrollPluginBrowserWindowDocument\(|function centerPluginBrowserWindowSelection\(|function adjustPluginBrowserWindowSelectionRange\(/, "host must not retain direct child selection or scrolling machinery");
assert.match(appSource, /win\.webContents\.setZoomFactor\(1\.5\); document\.body\.setAttribute\('data-browser-window-zoom-factor', String\(win\.webContents\.getZoomFactor\(\) === 1\.5 && Math\.abs\(win\.webContents\.getZoomLevel\(\) - 2\.224\) < 0\.01\)\);/, "browser-window smoke should verify setZoomFactor updates sync factor and level getters");
assert.match(appSource, /win\.webContents\.setZoomLevel\(-1\); document\.body\.setAttribute\('data-browser-window-zoom-level', String\(win\.webContents\.getZoomLevel\(\) === -1 && Math\.abs\(win\.webContents\.getZoomFactor\(\) - 0\.8333333333333334\) < 0\.001\)\);/, "browser-window smoke should verify setZoomLevel updates sync level and factor getters");
assert.match(appSource, /return win\.webContents\.setVisualZoomLevelLimits\(0\.5, 3\); }\)\.then\(function\(visualZoomLimits\)\{ document\.body\.setAttribute\('data-browser-window-visual-zoom-limits', String\(visualZoomLimits === undefined\)\);/, "browser-window smoke should verify setVisualZoomLevelLimits resolves with undefined");
assert.match(componentSource, /function zoomLevelFromFactor\(factor\) {\n      return Math\.log\(factor\) \/ Math\.log\(1\.2\);/, "bridge should derive hosted zoom level from zoom factor");
assert.match(componentSource, /function zoomFactorFromLevel\(level\) {\n      return Math\.pow\(1\.2, level\);/, "bridge should derive hosted zoom factor from zoom level");
assert.match(componentSource, /function normalizeZoomFactor\(value\) {\n      var factor = Number\(value\);\n      if \(!Number\.isFinite\(factor\) \|\| factor <= 0\) {\n        throw new Error\('webContents\.setZoomFactor requires a factor greater than 0'\);/, "bridge should validate positive finite zoom factors");
assert.match(componentSource, /function normalizeZoomLevel\(value\) {\n      var level = Number\(value\);\n      if \(!Number\.isFinite\(level\)\) {\n        throw new Error\('webContents\.setZoomLevel requires a finite level'\);/, "bridge should validate finite zoom levels");
assert.match(componentSource, /function webContentsSetZoomFactor\(factorValue\) {\n      var factor = normalizeZoomFactor\(factorValue\);\n      webContentsZoomFactor = factor;\n      webContentsZoomLevel = zoomLevelFromFactor\(factor\);/, "bridge should synchronously update zoom factor and level before host response");
assert.match(componentSource, /function webContentsSetZoomLevel\(levelValue\) {\n      var level = normalizeZoomLevel\(levelValue\);\n      webContentsZoomLevel = level;\n      webContentsZoomFactor = zoomFactorFromLevel\(level\);/, "bridge should synchronously update zoom level and factor before host response");
assert.match(componentSource, /setZoomFactor: function\(factor\) \{ return webContentsSetZoomFactor\(factor\); \}/, "bridge should expose webContents.setZoomFactor");
assert.match(componentSource, /getZoomFactor: function\(\) \{ return webContentsZoomFactor; \}/, "bridge should expose webContents.getZoomFactor");
assert.match(componentSource, /setZoomLevel: function\(level\) \{ return webContentsSetZoomLevel\(level\); \}/, "bridge should expose webContents.setZoomLevel");
assert.match(componentSource, /getZoomLevel: function\(\) \{ return webContentsZoomLevel; \}/, "bridge should expose webContents.getZoomLevel");
assert.match(componentSource, /setVisualZoomLevelLimits: function\(minimumLevel, maximumLevel\) {\n        return _browserWindowAction\(id, 'webContents\.setVisualZoomLevelLimits', Number\(minimumLevel\), Number\(maximumLevel\)\)\.then\(function\(result\) {\n          syncWebContentsZoomState\(result\);\n          return undefined;\n        }\);/, "bridge should expose visual zoom limits with undefined resolution");
assert.match(componentSource, /function pluginBrowserWindowZoomResult\(childWindow: PluginBrowserWindowState\) {\n    return {\n      zoomFactor: childWindow\.zoomFactor,\n      zoomLevel: childWindow\.zoomLevel,\n      minimumLevel: childWindow\.visualZoomMinimumLevel,\n      maximumLevel: childWindow\.visualZoomMaximumLevel,/, "host should return complete hosted zoom state payloads");
assert.match(componentSource, /function updatePluginBrowserWindowZoomFactor\(id: string, factor: number\)/, "host should implement setZoomFactor state routing");
assert.match(componentSource, /function updatePluginBrowserWindowZoomLevel\(id: string, level: number\)/, "host should implement setZoomLevel state routing");
assert.match(componentSource, /function updatePluginBrowserWindowVisualZoomLimits\(id: string, minimumValue: unknown, maximumValue: unknown\)/, "host should implement visual zoom limits state routing");
assert.match(componentSource, /return `transform: scale\(\$\{factor\}\); transform-origin: 0 0; width: \$\{100 \/ factor\}%; height: \$\{100 \/ factor\}%;`;/, "host should render child iframe zoom through CSS scale");
assert.match(componentSource, /if \(actionName === "webContents\.setZoomFactor"\) {\n      return updatePluginBrowserWindowZoomFactor\(id, Number\(actionArgs\[0\]\)\);/, "host should route webContents.setZoomFactor actions");
assert.match(componentSource, /if \(actionName === "webContents\.setZoomLevel"\) {\n      return updatePluginBrowserWindowZoomLevel\(id, Number\(actionArgs\[0\]\)\);/, "host should route webContents.setZoomLevel actions");
assert.match(componentSource, /if \(actionName === "webContents\.setVisualZoomLevelLimits"\) {\n      return updatePluginBrowserWindowVisualZoomLimits\(id, actionArgs\[0\], actionArgs\[1\]\);/, "host should route webContents.setVisualZoomLevelLimits actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.setZoomFactor\(factor\)` \/ `getZoomFactor\(\)` \/ `setZoomLevel\(level\)` \/ `getZoomLevel\(\)` \/ `setVisualZoomLevelLimits\(minimumLevel, maximumLevel\)` 会更新 hosted zoom state；`setZoomFactor\(\)` \/ `setZoomLevel\(\)` 保持 void-return shape，sync getter 立即可读，child iframe 通过 CSS scale 呈现当前 factor。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents zoom row complete",
);
assert.match(appSource, /data-browser-window-audio-initial', String\(!win\.webContents\.isAudioMuted\(\) && !win\.webContents\.isCurrentlyAudible\(\)\)/, "browser-window smoke should verify hosted audio initial state");
assert.match(appSource, /var audioMuteResult = win\.webContents\.setAudioMuted\(true\); document\.body\.setAttribute\('data-browser-window-audio-muted', String\(audioMuteResult === undefined && win\.webContents\.isAudioMuted\(\) && !win\.webContents\.isCurrentlyAudible\(\)\)\);/, "browser-window smoke should verify muting is void-return and updates sync audio getters");
assert.match(appSource, /var audioUnmuteResult = win\.webContents\.setAudioMuted\(false\); document\.body\.setAttribute\('data-browser-window-audio-unmuted', String\(audioUnmuteResult === undefined && !win\.webContents\.isAudioMuted\(\) && !win\.webContents\.isCurrentlyAudible\(\)\)\);/, "browser-window smoke should verify unmuting is void-return and updates sync audio getters");
assert.match(bridgeTestSource, /const audioStateListener = \(event, audible\) => webContentsEventCalls\.push\(\["audio", event\?\.sender === browserWindowHandle\.webContents, event\?\.audible, audible\]\);/, "VM coverage should observe event.audible and boolean listener argument for audio-state-changed");
assert.match(bridgeTestSource, /event: "audio-state-changed",\n    args: \[true\],/, "VM coverage should dispatch targeted audio-state-changed events with boolean payloads");
assert.match(bridgeTestSource, /\["audio", true, true, true\],/, "VM coverage should verify targeted audio-state-changed event sender, event.audible, and listener argument");
assert.match(componentSource, /if \(event\.type === 'audio-state-changed'\) {\n        var audioArg = Array\.isArray\(args\) && args\.length > 0 \? args\[0\] : null;\n        var audible = typeof audioArg === 'boolean'\n          \? audioArg\n          : audioArg && typeof audioArg === 'object' && typeof audioArg\.audible === 'boolean'\n            \? audioArg\.audible\n            : webContentsCurrentlyAudible;\n        event\.audible = audible;\n      }/, "bridge should expose event.audible on targeted audio-state-changed events");
assert.match(componentSource, /function syncWebContentsAudioState\(result\) {\n      var record = result && typeof result === 'object' \? result : {};\n      if \(typeof record\.audioMuted === 'boolean'\) webContentsAudioMuted = record\.audioMuted;\n      if \(typeof record\.currentlyAudible === 'boolean'\) webContentsCurrentlyAudible = record\.currentlyAudible;\n      if \(typeof record\.audible === 'boolean'\) webContentsCurrentlyAudible = record\.audible;\n      if \(webContentsAudioMuted\) webContentsCurrentlyAudible = false;/, "bridge should sync hosted audio muted and audible state from host results");
assert.match(componentSource, /function syncWebContentsAudioEvent\(name, args\) {\n      if \(String\(name \|\| ''\) !== 'audio-state-changed'\) return;\n      var firstArg = Array\.isArray\(args\) && args\.length > 0 \? args\[0\] : null;\n      var audible = typeof firstArg === 'boolean'\n        \? firstArg\n        : firstArg && typeof firstArg === 'object' && typeof firstArg\.audible === 'boolean'\n          \? firstArg\.audible\n          : null;\n      if \(typeof audible === 'boolean'\) webContentsCurrentlyAudible = audible && !webContentsAudioMuted;/, "bridge should sync isCurrentlyAudible from targeted audio-state-changed events");
assert.match(componentSource, /function webContentsSetAudioMuted\(mutedValue\) {\n      var muted = mutedValue === true;\n      webContentsAudioMuted = muted;\n      if \(muted\) webContentsCurrentlyAudible = false;\n      _browserWindowAction\(id, 'webContents\.setAudioMuted', muted\)\.then\(syncWebContentsAudioState\)\.catch\(function\(err\) {/, "bridge should synchronously update audio muted state before host response");
assert.match(componentSource, /setAudioMuted: function\(muted\) \{ return webContentsSetAudioMuted\(muted\); \}/, "bridge should expose webContents.setAudioMuted");
assert.match(componentSource, /isAudioMuted: function\(\) \{ return webContentsAudioMuted; \}/, "bridge should expose webContents.isAudioMuted");
assert.match(componentSource, /isCurrentlyAudible: function\(\) \{ return webContentsCurrentlyAudible; \}/, "bridge should expose webContents.isCurrentlyAudible");
assert.match(componentSource, /function pluginBrowserWindowAudioResult\(childWindow: PluginBrowserWindowState\) {\n    return {\n      audioMuted: childWindow\.audioMuted,\n      currentlyAudible: childWindow\.currentlyAudible,/, "host should return hosted audio state payloads");
assert.match(componentSource, /function updatePluginBrowserWindowAudioMuted\(id: string, mutedValue: unknown\)/, "host should implement setAudioMuted state routing");
assert.match(componentSource, /if \(existing\.currentlyAudible !== currentlyAudible\) {\n      dispatchPluginBrowserWindowWebContentsEvent\(id, "audio-state-changed", \[currentlyAudible\]\);/, "host should dispatch targeted audio-state-changed events when audible state changes");
assert.match(componentSource, /if \(actionName === "webContents\.setAudioMuted"\) {\n      return updatePluginBrowserWindowAudioMuted\(id, actionArgs\[0\]\);/, "host should route webContents.setAudioMuted actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.setAudioMuted\(muted\)` \/ `isAudioMuted\(\)` \/ `isCurrentlyAudible\(\)` 会更新 hosted audio state；`setAudioMuted\(\)` 保持 void-return shape，sync getter 立即可读，targeted `audio-state-changed` 事件会同步 `event\.audible` 和 boolean listener argument。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents audio row complete",
);
assert.match(appSource, /win\.on\('resize', function\(state\)\{ document\.body\.setAttribute\('data-browser-window-event-resize', String\(state && state\.width === 420 && state\.height === 260\)\); \}\);/, "browser-window smoke should verify hosted resize event payloads from geometry actions");
assert.match(appSource, /win\.once\('move', function\(state\)\{ document\.body\.setAttribute\('data-browser-window-event-move-once', String\(state && state\.x === 24 && state\.y === 32\)\); \}\);/, "browser-window smoke should verify hosted one-shot move event payloads from geometry actions");
assert.match(appSource, /return win\.setBounds\(\{ x: 24, y: 32, width: 420, height: 260 \}\); \}\)\.then\(function\(\)\{ return win\.getBounds\(\); \}\)\.then\(function\(bounds\)\{ document\.body\.setAttribute\('data-browser-window-bounds', JSON\.stringify\(bounds\)\);/, "browser-window smoke should exercise setBounds() before asserting geometry event state");
assert.match(componentSource, /if \(actionName === "setBounds"\) \{[\s\S]*?dispatchPluginBrowserWindowEvent\(id, "resize", \[\{ width: bounds\.width, height: bounds\.height, bounds \}\]\);[\s\S]*?dispatchPluginBrowserWindowEvent\(id, "move", \[\{ x: bounds\.x, y: bounds\.y, bounds \}\]\);[\s\S]*?return bounds;/, "host should dispatch resize and move events after setBounds()");
assert.match(componentSource, /if \(actionName === "setSize"\) \{[\s\S]*?dispatchPluginBrowserWindowEvent\(id, "resize", \[\{ width: size\.width, height: size\.height \}\]\);[\s\S]*?return \[size\.width, size\.height\];/, "host should dispatch resize events after setSize()");
assert.match(componentSource, /if \(actionName === "setPosition"\) \{[\s\S]*?dispatchPluginBrowserWindowEvent\(id, "move", \[\{ x: position\.x, y: position\.y \}\]\);[\s\S]*?return \[position\.x, position\.y\];/, "host should dispatch move events after setPosition()");
assert.match(componentSource, /if \(actionName === "center"\) \{[\s\S]*?dispatchPluginBrowserWindowEvent\(id, "move", \[\{ x: 0, y: 0, centered: true \}\]\);[\s\S]*?return \{ \.\.\.bounds, centered: true \};/, "host should dispatch centered move events after center()");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setBounds\(\)` \/ `setSize\(\)` \/ `setPosition\(\)` \/ `center\(\)` 会派发宿主内 `resize` \/ `move` 几何事件，插件可通过 `on\(\)` \/ `once\(\)` 监听。$/m,
  "macOS smoke checklist should mark BrowserWindow geometry events row complete",
);
assert.match(appSource, /win\.webContents\.openDevTools\(/, "browser-window smoke should exercise hosted webContents.openDevTools");
assert.match(appSource, /win\.webContents\.toggleDevTools\(\)/, "browser-window smoke should exercise hosted webContents.toggleDevTools");
assert.match(appSource, /win\.webContents\.closeDevTools\(\)/, "browser-window smoke should exercise hosted webContents.closeDevTools");
assert.match(appSource, /win\.webContents\.isDevToolsOpened\(\)/, "browser-window smoke should verify hosted DevTools open state");
assert.match(appSource, /win\.webContents\.isDevToolsFocused\(\)/, "browser-window smoke should verify hosted DevTools focus state");
const browserWindowDevToolsStateReplaceTarget = "return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }).then(function(openDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-open', String(openDevToolsResult && openDevToolsResult.devToolsOpened === true && win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.toggleDevTools(); }).then(function(toggleDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-toggle', String(toggleDevToolsResult && toggleDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.openDevTools({ mode: 'bottom' }); }).then(function(focusedDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-reopen', String(focusedDevToolsResult && focusedDevToolsResult.devToolsOpened === true && focusedDevToolsResult.devToolsFocused === true && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); return win.webContents.closeDevTools(); }).then(function(closeDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-close', String(closeDevToolsResult && closeDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }";
assert.equal(
  appSource.split(browserWindowDevToolsStateReplaceTarget).length - 1,
  2,
  "browser-window DevTools smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-devtools-state/, "browser-window smoke should record aggregate hosted DevTools state");
assert.match(appSource, /devToolsEventOpenedOk/, "browser-window smoke should verify targeted devtools-opened event payload");
assert.match(appSource, /devToolsEventClosedOk/, "browser-window smoke should verify targeted devtools-closed event payload");
assert.match(
  appSource,
  /window\.__atoolsBrowserWindowDevToolsEventOpenedOk = window\.__atoolsBrowserWindowDevToolsEventOpenedOk \|\| devToolsEventOpenedOk/,
  "browser-window smoke should preserve the first valid devtools-opened event across the later focused reopen",
);
assert.match(appSource, /devToolsOpenOk/, "browser-window smoke should verify openDevTools return state and sync getters");
assert.match(appSource, /devToolsToggleOk/, "browser-window smoke should verify toggleDevTools close state and sync getters");
assert.match(appSource, /devToolsReopenOk/, "browser-window smoke should verify focused openDevTools state and sync getters");
assert.match(appSource, /devToolsCloseOk/, "browser-window smoke should verify closeDevTools state and sync getters");
assert.match(componentSource, /function pluginBrowserWindowDevToolsResult\(/, "host should return hosted browser-window DevTools result payloads");
assert.match(componentSource, /function updatePluginBrowserWindowDevTools\(/, "host should update hosted browser-window DevTools state and dispatch events");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.openDevTools\(options\)` \/ `closeDevTools\(\)` \/ `toggleDevTools\(\)` 会更新 hosted DevTools state，并通过 `webContents\.on\("devtools-opened" \| "devtools-closed", listener\)` 向父插件派发 targeted 事件；`isDevToolsOpened\(\)` \/ `isDevToolsFocused\(\)` 会同步读取 hosted state。$/m,
  "macOS smoke checklist should mark BrowserWindow DevTools state/events row complete",
);
assert.match(appSource, /win\.webContents\.inspectElement\(/, "browser-window smoke should exercise hosted webContents.inspectElement");
const browserWindowInspectElementReplaceTarget = "var inspectElementResult = win.webContents.inspectElement(12, 8); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);";
assert.equal(
  appSource.split(browserWindowInspectElementReplaceTarget).length - 1,
  2,
  "browser-window inspectElement smoke replacement should match both the current replacement output and the replace target",
);
assert.match(appSource, /data-browser-window-inspect-element-state/, "browser-window smoke should record inspectElement void-return and DevTools sync state");
assert.match(appSource, /data-browser-window-inspect-element-summary/, "browser-window smoke should record inspected element summary from the targeted DevTools event");
assert.match(appSource, /inspectElementStateOk/, "browser-window smoke should verify inspectElement keeps the official void-return shape and sync DevTools state");
assert.match(appSource, /inspectElementSummaryOk/, "browser-window smoke should verify inspectElement records a compact element summary");
assert.match(
  appSource,
  /if \(inspectElementSummary\) document\.body\.setAttribute\('data-browser-window-inspect-element-summary', String\(window\.__atoolsBrowserWindowInspectElementSummaryOk\)\)/,
  "browser-window smoke should only write the inspectElement summary marker from DevTools events that carry inspectedElement",
);
assert.match(componentSource, /async function inspectPluginBrowserWindowElement\(id: string, args: unknown\[\]\)/, "host should preserve the inspectElement API route");
assert.match(componentSource, /throw hostedBrowserWindowUnsupported\("webContents\.inspectElement"\)/, "inspectElement must reject explicitly under opaque isolation");
assert.doesNotMatch(hostComponentSource, /function pluginBrowserWindowInspectedElement\(|frame\.contentDocument|elementFromPoint\(x, y\)/, "host must not inspect isolated child DOM");
assert.match(appSource, /win\.webContents\.capturePage\(/, "browser-window smoke should exercise hosted webContents.capturePage");
assert.match(appSource, /win\.webContents\.print\(/, "browser-window smoke should exercise hosted webContents.print");
assert.match(appSource, /win\.webContents\.printToPDF\(/, "browser-window smoke should exercise hosted webContents.printToPDF");
assert.match(appSource, /win\.webContents\.savePage\(/, "browser-window smoke should exercise hosted webContents.savePage");
const browserWindowCapturePrintSaveReplaceTarget = "}).then(function(capturedImage){ document.body.setAttribute('data-browser-window-capture-page', String(capturedImage && capturedImage.toDataURL().indexOf('data:image/') === 0 && capturedImage.getSize().width === 120 && !capturedImage.isEmpty())); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ document.body.setAttribute('data-browser-window-print', String(success === false && typeof failureReason === 'string' && failureReason.length > 0)); resolve(); }); }); }).then(function(){ return win.webContents.printToPDF({ printBackground: true }); }).then(function(pdfBytes){ document.body.setAttribute('data-browser-window-print-to-pdf', String(pdfBytes && pdfBytes.byteLength > 4 && pdfBytes[0] === 37)); return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }).then(function(savePageResult){ document.body.setAttribute('data-browser-window-save-page', String(savePageResult === undefined));";
assert.equal(
  appSource.split(browserWindowCapturePrintSaveReplaceTarget).length - 1,
  2,
  "browser-window capture/print/save smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-capture-print-save-state/, "browser-window smoke should record aggregate capture\/print\/save state");
assert.match(appSource, /capturePageSize/, "browser-window smoke should inspect hosted capturePage NativeImage-compatible size");
assert.match(appSource, /capturePageSize\.height === 80/, "browser-window smoke should verify hosted capturePage preserves requested height");
assert.match(appSource, /capturePageOk/, "browser-window smoke should verify hosted capturePage data URL, size, and non-empty state");
assert.match(appSource, /printCallbackOk/, "browser-window smoke should verify hosted print callback result");
assert.match(appSource, /failureReason\.indexOf\('native-only'\) >= 0/, "browser-window smoke should verify hosted print returns an explicit native-only failure");
assert.match(appSource, /printToPdfOk/, "browser-window smoke should verify hosted printToPDF result");
assert.match(appSource, /pdfBytes\[0\] === 37 && pdfBytes\[1\] === 80 && pdfBytes\[2\] === 68 && pdfBytes\[3\] === 70/, "browser-window smoke should verify hosted printToPDF returns PDF bytes");
assert.match(appSource, /savePageOk/, "browser-window smoke should verify hosted savePage keeps the official void result");
assert.match(componentSource, /async function capturePluginBrowserWindowPage\(windowId: string, args: unknown\[\]\)/, "host should preserve the capturePage API route");
assert.match(componentSource, /throw hostedBrowserWindowUnsupported\("webContents\.capturePage"\)/, "capturePage must reject explicitly under opaque isolation");
assert.match(componentSource, /function printPluginBrowserWindowPage\(windowId: string, args: unknown\[\]\)/, "host should route webContents.print to an explicit hosted result");
assert.match(componentSource, /failureReason: "webContents\.print is native-only in hosted BrowserWindow"/, "host should not fake a successful print result");
assert.match(componentSource, /async function printPluginBrowserWindowToPdf\(windowId: string, args: unknown\[\]\)/, "host should preserve the printToPDF API route");
assert.match(componentSource, /throw hostedBrowserWindowUnsupported\("webContents\.printToPDF"\)/, "printToPDF must reject explicitly under opaque isolation");
assert.match(componentSource, /async function savePluginBrowserWindowPage\(windowId: string, args: unknown\[\]\)/, "host should preserve the savePage API route");
assert.match(componentSource, /throw hostedBrowserWindowUnsupported\("webContents\.savePage"\)/, "savePage must reject explicitly under opaque isolation");
assert.doesNotMatch(hostComponentSource, /browserWindowSnapshotSvg|browserWindowMinimalPdfBytes|browserWindowSerializedPage|frame\.contentDocument/, "host must not recreate capture, PDF, or save output by reading isolated child DOM");
for (const [marker, required] of [
  ["`webContents.inspectElement(x, y)`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "opaque"]],
  ["`webContents.capturePage([rect, opts])`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "print()", "native-only"]],
  ["`webContents.insertText(text)`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "12"]],
  ["`webContents.centerSelection()`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "4"]],
]) {
  const line = smokeChecklistLineContaining(marker);
  assert.match(line, /^- \[x\] /, `macOS smoke checklist should keep the ${marker} explicit-boundary row checked`);
  for (const token of required) {
    assert.ok(line.includes(token), `${marker} checklist row should describe ${token}`);
  }
}
for (const token of [
  "Batch 384 Current Delta",
  "allow-scripts allow-popups",
  "MessageChannel",
  "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED",
  "20",
]) {
  assert.ok(uiRestoreChecklist.includes(token), `UI restore checklist should record Batch 384 security token ${token}`);
}
assert.match(appSource, /win\.webContents\.setUserAgent\(/, "browser-window smoke should exercise hosted webContents.setUserAgent");
assert.match(appSource, /win\.webContents\.getUserAgent\(\)/, "browser-window smoke should verify hosted webContents user agent");
assert.match(appSource, /win\.webContents\.setFrameRate\(/, "browser-window smoke should exercise hosted webContents.setFrameRate");
assert.match(appSource, /win\.webContents\.getFrameRate\(\)/, "browser-window smoke should verify hosted webContents frame rate");
assert.match(appSource, /win\.webContents\.setBackgroundThrottling\(/, "browser-window smoke should exercise hosted webContents.setBackgroundThrottling");
assert.match(appSource, /win\.webContents\.getBackgroundThrottling\(\)/, "browser-window smoke should verify hosted webContents background throttling");
assert.match(appSource, /win\.webContents\.getProcessId\(\)/, "browser-window smoke should verify hosted webContents process id");
assert.match(appSource, /win\.webContents\.getOSProcessId\(\)/, "browser-window smoke should verify hosted webContents OS process id");
const browserWindowRuntimeStateReplaceTarget = "var processOk = Number.isInteger(win.webContents.getProcessId()) && win.webContents.getProcessId() > 0 && Number.isInteger(win.webContents.getOSProcessId()) && win.webContents.getOSProcessId() > 0; var setUserAgentResult = win.webContents.setUserAgent('AToolsBrowserWindowSmoke/239'); var setFrameRateResult = win.webContents.setFrameRate(24); var setBackgroundThrottlingResult = win.webContents.setBackgroundThrottling(false); document.body.setAttribute('data-browser-window-runtime-state', String(processOk && setUserAgentResult === undefined && win.webContents.getUserAgent() === 'AToolsBrowserWindowSmoke/239' && setFrameRateResult === undefined && win.webContents.getFrameRate() === 24 && setBackgroundThrottlingResult === undefined && win.webContents.getBackgroundThrottling() === false)); win.webContents.setZoomFactor(1.5);";
assert.equal(
  appSource.split(browserWindowRuntimeStateReplaceTarget).length - 1,
  2,
  "browser-window runtime smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-runtime-defaults/, "browser-window smoke should record hosted runtime default state");
assert.match(appSource, /data-browser-window-runtime-process/, "browser-window smoke should record hosted runtime process identity state");
assert.match(appSource, /data-browser-window-runtime-setters/, "browser-window smoke should record hosted runtime setter state");
assert.match(appSource, /typeof initialUserAgent === 'string' && initialUserAgent\.length > 0/, "browser-window smoke should verify hosted user-agent default is readable");
assert.match(appSource, /initialFrameRate === 60/, "browser-window smoke should verify hosted frame-rate default");
assert.match(appSource, /initialBackgroundThrottling === true/, "browser-window smoke should verify hosted background throttling default");
assert.match(appSource, /processId !== osProcessId/, "browser-window smoke should verify hosted process id differs from hosted OS process id");
assert.match(appSource, /runtimeSetterOk/, "browser-window smoke should verify hosted runtime setter void-return and sync getter state");
assert.match(componentSource, /var webContentsProcessId = hostedPositiveInteger\(record\.processId, hostedNumericId\(id, 1\)\)/, "bridge should initialize hosted process id from compatibility state");
assert.match(componentSource, /var webContentsOSProcessId = hostedPositiveInteger\(record\.osProcessId, 100000 \+ webContentsProcessId\)/, "bridge should initialize hosted OS process id separately from process id");
assert.match(componentSource, /function browserWindowOSProcessId\(windowSeq: number\): number \{\n    return 100000 \+ browserWindowProcessId\(windowSeq\);/, "host should derive a hosted OS process id distinct from process id");
assert.match(componentSource, /const frameRate = 60;\n    const backgroundThrottling = true;/, "host should initialize BrowserWindow runtime defaults");
assert.match(componentSource, /function pluginBrowserWindowRuntimeResult\(childWindow: PluginBrowserWindowState\)/, "host should return a complete hosted runtime state payload");
assert.match(componentSource, /processId: childWindow\.processId,\n      osProcessId: childWindow\.osProcessId,/, "host runtime payload should include both process identity values");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.getUserAgent\(\)` \/ `setUserAgent\(userAgent\)`、`getFrameRate\(\)` \/ `setFrameRate\(fps\)`、`getBackgroundThrottling\(\)` \/ `setBackgroundThrottling\(allowed\)`、`getProcessId\(\)` \/ `getOSProcessId\(\)` 会路由到 hosted runtime state；setter 保持 void-return shape，sync getter 立即可读，process id 为 hosted compatibility 正整数，不等同真实 Electron renderer 或 OS process id。$/m,
  "macOS smoke checklist should mark BrowserWindow runtime state row complete",
);
assert.match(appSource, /id=\\"browser-window-edit-target\\"/, "browser-window smoke child should include an editable target");
assert.match(appSource, /win\.webContents\.insertText\(/, "browser-window smoke should exercise hosted webContents.insertText");
assert.match(appSource, /win\.webContents\.selectAll\(\)/, "browser-window smoke should exercise hosted webContents.selectAll");
assert.match(appSource, /win\.webContents\.paste\(\)/, "browser-window smoke should exercise hosted webContents.paste");
assert.match(appSource, /win\.webContents\.centerSelection\(\)/, "browser-window smoke should exercise hosted webContents.centerSelection");
assert.match(appSource, /win\.webContents\.scrollToBottom\(\)/, "browser-window smoke should exercise hosted webContents.scrollToBottom");
assert.match(appSource, /win\.webContents\.scrollToTop\(\)/, "browser-window smoke should exercise hosted webContents.scrollToTop");
assert.match(appSource, /win\.webContents\.adjustSelection\(/, "browser-window smoke should exercise hosted webContents.adjustSelection");
assert.match(appSource, /win\.webContents\.setZoomFactor\(/, "browser-window smoke should exercise hosted webContents.setZoomFactor");
assert.match(appSource, /win\.webContents\.getZoomFactor\(\)/, "browser-window smoke should verify hosted webContents zoom factor");
assert.match(appSource, /win\.webContents\.setZoomLevel\(/, "browser-window smoke should exercise hosted webContents.setZoomLevel");
assert.match(appSource, /win\.webContents\.getZoomLevel\(\)/, "browser-window smoke should verify hosted webContents zoom level");
assert.match(appSource, /win\.webContents\.setVisualZoomLevelLimits\(/, "browser-window smoke should exercise hosted webContents.setVisualZoomLevelLimits");
assert.match(appSource, /win\.webContents\.setAudioMuted\(/, "browser-window smoke should exercise hosted webContents.setAudioMuted");
assert.match(appSource, /win\.webContents\.isAudioMuted\(\)/, "browser-window smoke should verify hosted webContents muted state");
assert.match(appSource, /win\.webContents\.isCurrentlyAudible\(\)/, "browser-window smoke should verify hosted webContents audible state");
assert.match(appSource, /ipcRenderer\.on\(/, "browser-window smoke child should receive hosted webContents.send messages");
assert.match(appSource, /data-send-input-event/, "browser-window smoke child should receive hosted input events");
assert.match(appSource, /win\.showInactive\(/, "browser-window smoke should exercise hosted showInactive state");
assert.match(appSource, /win\.setTitle\(/, "browser-window smoke should exercise hosted title updates");
assert.match(appSource, /win\.setBackgroundColor\(/, "browser-window smoke should exercise hosted background color updates");
assert.match(appSource, /win\.getBackgroundColor\(\)/, "browser-window smoke should verify hosted background color state");
assert.match(appSource, /data-browser-window-background-color/, "browser-window smoke should record hosted background color state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setBackgroundColor\(color\)` \/ `getBackgroundColor\(\)` 会路由到宿主内 background-color state；setter 保持 void-return shape，getter 返回同步规范化后的 `#RRGGBB`，hosted 子窗口 shell 会应用同一背景色。$/m,
  "macOS smoke checklist should mark BrowserWindow background-color row complete",
);
assert.match(appSource, /win\.setAutoHideMenuBar\(/, "browser-window smoke should exercise hosted menu bar auto-hide updates");
assert.match(appSource, /win\.isMenuBarAutoHide\(\)/, "browser-window smoke should verify hosted menu bar auto-hide state");
assert.match(appSource, /win\.setMenuBarVisibility\(/, "browser-window smoke should exercise hosted menu bar visibility updates");
assert.match(appSource, /win\.isMenuBarVisible\(\)/, "browser-window smoke should verify hosted menu bar visibility state");
assert.match(appSource, /win\.removeMenu\(\)/, "browser-window smoke should exercise hosted removeMenu");
assert.match(appSource, /win\.setMenu\(/, "browser-window smoke should exercise hosted setMenu");
assert.match(appSource, /data-browser-window-menu-bar-state/, "browser-window smoke should record hosted menu bar state");
assert.match(appSource, /var autoHideMenuBarResult = win\.setAutoHideMenuBar\(true\); var hideMenuBarResult = win\.setMenuBarVisibility\(false\); var removeMenuResult = win\.removeMenu\(\); var setMenuResult = win\.setMenu\(\{ items: \[\{ label: 'File' \}\] \}\); document\.body\.setAttribute\('data-browser-window-menu-bar-state', String\(autoHideMenuBarResult === undefined && win\.isMenuBarAutoHide\(\) === true && hideMenuBarResult === undefined && removeMenuResult === undefined && setMenuResult === undefined && win\.isMenuBarVisible\(\) === true\)\);/, "browser-window smoke should verify menu-bar void-return setters and sync getter state");
assert.match(componentSource, /function syncBrowserWindowMenuBarState\(result\) \{\n      var record = result && typeof result === 'object' \? result : \{\};\n      if \(typeof record\.menuBarAutoHide === 'boolean'\) browserWindowMenuBarAutoHide = record\.menuBarAutoHide;\n      if \(typeof record\.menuRemoved === 'boolean'\) browserWindowMenuRemoved = record\.menuRemoved;\n      if \(typeof record\.menuBarVisible === 'boolean'\) browserWindowMenuBarVisible = record\.menuBarVisible && !browserWindowMenuRemoved;\n      if \(browserWindowMenuRemoved\) browserWindowMenuBarVisible = false;/, "bridge should sync hosted menu-bar auto-hide, removed, and visibility state");
assert.match(componentSource, /function browserWindowRemoveMenu\(\) \{\n      browserWindowMenuRemoved = true;\n      browserWindowMenuBarVisible = false;\n      _browserWindowAction\(id, 'removeMenu'\)\.then\(syncBrowserWindowMenuBarState\)/, "bridge should synchronously hide hosted menu bars when removeMenu() is called");
assert.match(componentSource, /function browserWindowSetMenu\(menu\) \{\n      browserWindowMenuRemoved = menu == null;\n      browserWindowMenuBarVisible = !browserWindowMenuRemoved;\n      _browserWindowAction\(id, 'setMenu', menu == null \? null : menu\)\.then\(syncBrowserWindowMenuBarState\)/, "bridge should restore hosted menu visibility for non-null setMenu() and remove it for null");
assert.match(componentSource, /if \(actionName === "setAutoHideMenuBar"\) \{[\s\S]*?return \{ menuBarAutoHide \};[\s\S]*?if \(actionName === "setMenuBarVisibility"\) \{[\s\S]*?return \{ menuBarVisible \};[\s\S]*?if \(actionName === "removeMenu"\) \{[\s\S]*?return \{ menuRemoved: true, menuBarVisible: false \};[\s\S]*?if \(actionName === "setMenu"\) \{[\s\S]*?return \{ menuRemoved, menuBarVisible \};/, "host should route BrowserWindow menu-bar state actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setAutoHideMenuBar\(\)` \/ `isMenuBarAutoHide\(\)` \/ `setMenuBarVisibility\(\)` \/ `isMenuBarVisible\(\)` \/ `removeMenu\(\)` \/ `setMenu\(\)` 会更新 hosted menu-bar state；setter\/remove\/setMenu 保持 void-return shape，sync getter 立即可读，`removeMenu\(\)` 会隐藏并标记 removed，`setMenu\(menu\)` 会恢复非 null 菜单可见状态。$/m,
  "macOS smoke checklist should mark BrowserWindow menu-bar state row complete",
);
assert.match(appSource, /win\.setWindowButtonVisibility\(/, "browser-window smoke should exercise hosted window button visibility state");
assert.match(appSource, /win\.setWindowButtonPosition\(/, "browser-window smoke should exercise hosted window button position state");
assert.match(appSource, /win\.getWindowButtonPosition\(\)/, "browser-window smoke should verify hosted window button position state");
assert.match(appSource, /win\.setVibrancy\(/, "browser-window smoke should exercise hosted vibrancy state");
assert.match(appSource, /win\.setBackgroundMaterial\(/, "browser-window smoke should exercise hosted background material state");
assert.match(appSource, /win\.setSheetOffset\(/, "browser-window smoke should exercise hosted sheet offset state");
assert.match(appSource, /data-browser-window-titlebar-material-state/, "browser-window smoke should record hosted titlebar/material state");
assert.match(appSource, /var windowButtonVisibilityResult = win\.setWindowButtonVisibility\(false\); var windowButtonPositionResult = win\.setWindowButtonPosition\(\{ x: 18, y: 9 \}\); var windowButtonPosition = win\.getWindowButtonPosition\(\); var windowButtonResetResult = win\.setWindowButtonPosition\(null\); var vibrancyResult = win\.setVibrancy\('sidebar', \{ animationDuration: 120 \}\); var clearVibrancyResult = win\.setVibrancy\(null\); var backgroundMaterialResult = win\.setBackgroundMaterial\('under-window'\); var sheetOffsetResult = win\.setSheetOffset\(44, 12\); document\.body\.setAttribute\('data-browser-window-titlebar-material-state', String\(windowButtonVisibilityResult === undefined && windowButtonPositionResult === undefined && windowButtonPosition && windowButtonPosition\.x === 18 && windowButtonPosition\.y === 9 && windowButtonResetResult === undefined && win\.getWindowButtonPosition\(\) === null && vibrancyResult === undefined && clearVibrancyResult === undefined && backgroundMaterialResult === undefined && sheetOffsetResult === undefined\)\);/, "browser-window smoke should verify titlebar/material void-return setters and sync window button position state");
assert.match(componentSource, /function syncBrowserWindowTitlebarMaterialState\(result\) \{\n      var record = result && typeof result === 'object' \? result : \{\};\n      if \(typeof record\.windowButtonVisible === 'boolean'\) browserWindowButtonVisible = record\.windowButtonVisible;\n      if \(Object\.prototype\.hasOwnProperty\.call\(record, 'windowButtonPosition'\)\) browserWindowButtonPosition = hostedWindowButtonPosition\(record\.windowButtonPosition\);[\s\S]*?if \(typeof record\.sheetOffsetX === 'number'\) browserWindowSheetOffsetX = record\.sheetOffsetX;/, "bridge should sync hosted titlebar/material state payloads");
assert.match(componentSource, /function browserWindowSetWindowButtonPosition\(position\) \{\n      browserWindowButtonPosition = hostedWindowButtonPosition\(position\);\n      _browserWindowAction\(id, 'setWindowButtonPosition', hostedWindowButtonPositionCopy\(browserWindowButtonPosition\)\)\.then\(syncBrowserWindowTitlebarMaterialState\)/, "bridge should sync window button position immediately and send null reset state");
assert.match(componentSource, /getWindowButtonPosition: function\(\) \{ return hostedWindowButtonPositionCopy\(browserWindowButtonPosition\); \}/, "bridge should expose synchronous window button position getter");
assert.match(componentSource, /if \(actionName === "setWindowButtonVisibility"\) \{[\s\S]*?return \{ windowButtonVisible \};[\s\S]*?if \(actionName === "setWindowButtonPosition"\) \{[\s\S]*?return \{ windowButtonPosition \};[\s\S]*?if \(actionName === "getWindowButtonPosition"\) \{[\s\S]*?return existing\.windowButtonPosition \? \{ \.\.\.existing\.windowButtonPosition \} : null;[\s\S]*?if \(actionName === "setVibrancy"\) \{[\s\S]*?return \{ vibrancy, vibrancyOptions \};[\s\S]*?if \(actionName === "setBackgroundMaterial"\) \{[\s\S]*?return \{ backgroundMaterial \};[\s\S]*?if \(actionName === "setSheetOffset"\) \{[\s\S]*?return \{ sheetOffsetY, sheetOffsetX \};/, "host should route BrowserWindow titlebar/material state actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setWindowButtonVisibility\(\)` \/ `setWindowButtonPosition\(\)` \/ `getWindowButtonPosition\(\)` \/ `setVibrancy\(\)` \/ `setBackgroundMaterial\(\)` \/ `setSheetOffset\(\)` 会更新 hosted macOS titlebar\/material state；setter 保持 void-return shape，`getWindowButtonPosition\(\)` sync getter 立即可读，`setWindowButtonPosition\(null\)` 会重置为系统默认 `null`。$/m,
  "macOS smoke checklist should mark BrowserWindow titlebar/material state row complete",
);
assert.match(appSource, /win\.isNormal\(\)/, "browser-window smoke should verify hosted normal window state");
assert.match(appSource, /win\.isModal\(\)/, "browser-window smoke should verify hosted modal window state");
assert.match(appSource, /win\.setDocumentEdited\(/, "browser-window smoke should exercise hosted document edited state");
assert.match(appSource, /win\.isDocumentEdited\(\)/, "browser-window smoke should verify hosted document edited state");
assert.match(appSource, /win\.setRepresentedFilename\(/, "browser-window smoke should exercise hosted represented filename state");
assert.match(appSource, /win\.getRepresentedFilename\(\)/, "browser-window smoke should verify hosted represented filename state");
assert.match(appSource, /win\.setParentWindow\(/, "browser-window smoke should exercise hosted parent window state");
assert.match(appSource, /win\.getParentWindow\(\)/, "browser-window smoke should verify hosted parent window state");
assert.match(appSource, /win\.getChildWindows\(\)/, "browser-window smoke should verify hosted child window state");
assert.match(appSource, /data-browser-window-document-parent-state/, "browser-window smoke should record hosted document and parent state");
assert.match(appSource, /var parentSetResult = win\.setParentWindow\(sourceWin\); var parentOk = parentSetResult === undefined && win\.getParentWindow\(\) === sourceWin && sourceWin\.getChildWindows\(\)\.some\(function\(childWin\)\{ return childWin === win; \}\); var parentResetResult = win\.setParentWindow\(null\); document\.body\.setAttribute\('data-browser-window-parent-child-state', String\(parentOk && parentResetResult === undefined && win\.getParentWindow\(\) === null && sourceWin\.getChildWindows\(\)\.length === 0\)\);/, "browser-window smoke should verify hosted parent-child handle relationship and null reset");
assert.match(appSource, /var documentEditedInitial = !win\.isDocumentEdited\(\); var representedFilenameInitial = win\.getRepresentedFilename\(\) === ''; var normalModalInitial = win\.isNormal\(\) === true && win\.isModal\(\) === false; var documentEditedResult = win\.setDocumentEdited\(true\); var representedFilenameResult = win\.setRepresentedFilename\('\/tmp\/atools-browser-window-document\.md'\); document\.body\.setAttribute\('data-browser-window-document-parent-state', String\(document\.body\.getAttribute\('data-browser-window-parent-child-state'\) === 'true' && documentEditedInitial && representedFilenameInitial && normalModalInitial && documentEditedResult === undefined && win\.isDocumentEdited\(\) === true && representedFilenameResult === undefined && win\.getRepresentedFilename\(\) === '\/tmp\/atools-browser-window-document\.md' && win\.getParentWindow\(\) === null && Array\.isArray\(win\.getChildWindows\(\)\) && win\.getChildWindows\(\)\.length === 0\)\);/, "browser-window smoke should verify document state void-return setters, sync getters, normal/modal, and cleared parent state");
assert.match(componentSource, /function syncBrowserWindowDocumentParentState\(result\) \{\n      var record = result && typeof result === 'object' \? result : \{\};\n      if \(typeof record\.documentEdited === 'boolean'\) browserWindowDocumentEdited = record\.documentEdited;\n      if \(typeof record\.representedFilename === 'string'\) browserWindowRepresentedFilename = record\.representedFilename;\n      if \(typeof record\.modal === 'boolean'\) browserWindowModal = record\.modal;\n      if \(Object\.prototype\.hasOwnProperty\.call\(record, 'parentWindowId'\)\) \{\n        browserWindowParentId = typeof record\.parentWindowId === 'string' && record\.parentWindowId \? record\.parentWindowId : null;/, "bridge should sync hosted document, modal, and parent-window state payloads");
assert.match(componentSource, /function browserWindowSetParentWindow\(parentWindow\) \{\n      browserWindowParentId = hostedBrowserWindowParentId\(parentWindow\);\n      _browserWindowAction\(id, 'setParentWindow', browserWindowParentId\)\.then\(syncBrowserWindowDocumentParentState\)/, "bridge should synchronously set or clear hosted parent window ids");
assert.match(componentSource, /function browserWindowGetChildWindows\(\) \{\n      var children = \[\];\n      Object\.keys\(_browserWindowHandles\)\.forEach\(function\(key\) \{[\s\S]*?childHandle\.__atoolsParentWindowId\(\) === id[\s\S]*?children\.push\(childHandle\);/, "bridge should derive child window handles from hosted parent ids");
assert.match(componentSource, /if \(actionName === "isNormal"\) \{[\s\S]*?return !existing\.minimized && !existing\.maximized && !existing\.fullScreen && !existing\.kiosk;[\s\S]*?if \(actionName === "isModal"\) \{[\s\S]*?return existing\.modal;[\s\S]*?if \(actionName === "setDocumentEdited"\) \{[\s\S]*?return \{ documentEdited \};[\s\S]*?if \(actionName === "setRepresentedFilename"\) \{[\s\S]*?return \{ representedFilename \};[\s\S]*?if \(actionName === "setParentWindow"\) \{[\s\S]*?return \{ parentWindowId: requestedParentWindowId \};[\s\S]*?if \(actionName === "getParentWindow"\) \{[\s\S]*?return existing\.parentWindowId;[\s\S]*?if \(actionName === "getChildWindows"\) \{[\s\S]*?return pluginBrowserWindows\.filter\(\(childWindow\) => childWindow\.parentWindowId === id\)\.map\(\(childWindow\) => childWindow\.id\);/, "host should route BrowserWindow document and parent-child state actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `isNormal\(\)` \/ `isModal\(\)` \/ `setDocumentEdited\(\)` \/ `isDocumentEdited\(\)` \/ `setRepresentedFilename\(\)` \/ `getRepresentedFilename\(\)` \/ `setParentWindow\(\)` \/ `getParentWindow\(\)` \/ `getChildWindows\(\)` 会更新 hosted document\/parent state；document\/representedFilename setter 保持 void-return shape，sync getter 立即可读，`setParentWindow\(null\)` 会清理 hosted parent\/child 关系。$/m,
  "macOS smoke checklist should mark BrowserWindow document/parent state row complete",
);
assert.match(appSource, /win\.loadURL\(/, "browser-window smoke should exercise hosted URL navigation");
assert.match(appSource, /win\.getURL\(/, "browser-window smoke should verify hosted URL state");
assert.match(appSource, /win\.reload\(/, "browser-window smoke should exercise hosted reload");
assert.match(appSource, /win\.minimize\(/, "browser-window smoke should exercise hosted minimize");
assert.match(appSource, /win\.isMinimized\(/, "browser-window smoke should verify hosted minimized state");
assert.match(appSource, /win\.restore\(/, "browser-window smoke should exercise hosted restore");
assert.match(appSource, /win\.maximize\(/, "browser-window smoke should exercise hosted maximize");
assert.match(appSource, /win\.isMaximized\(/, "browser-window smoke should verify hosted maximized state");
assert.match(appSource, /win\.unmaximize\(/, "browser-window smoke should exercise hosted unmaximize");
assert.match(appSource, /win\.on\(['"]focus/, "browser-window smoke should exercise hosted event listeners");
assert.match(appSource, /win\.once\(['"]restore/, "browser-window smoke should exercise hosted one-shot event listeners");
assert.match(appSource, /win\.on\(['"]resize/, "browser-window smoke should exercise hosted resize events");
assert.match(appSource, /win\.once\(['"]move/, "browser-window smoke should exercise hosted move events");
assert.match(appSource, /win\.setContentSize\(/, "browser-window smoke should exercise hosted content-size updates");
assert.match(appSource, /win\.getContentSize\(/, "browser-window smoke should verify hosted content-size state");
assert.match(appSource, /win\.setMinimumSize\(/, "browser-window smoke should exercise hosted minimum-size constraints");
assert.match(appSource, /win\.getMinimumSize\(/, "browser-window smoke should verify hosted minimum-size constraints");
assert.match(appSource, /win\.setMaximumSize\(/, "browser-window smoke should exercise hosted maximum-size constraints");
assert.match(appSource, /win\.getMaximumSize\(/, "browser-window smoke should verify hosted maximum-size constraints");
assert.match(appSource, /win\.setAspectRatio\(/, "browser-window smoke should exercise hosted aspect-ratio state");
const browserWindowSizingRestoreReplaceTarget = "return win.setAspectRatio(16 / 9, { width: 40, height: 30 }); }).then(function(){ return win.setContentSize(420, 260); }).then(function(){ return win.setResizable(false); }";
assert.equal(
  appSource.split(browserWindowSizingRestoreReplaceTarget).length - 1,
  2,
  "browser-window sizing smoke replacement should match both the srcdoc base string and the content-size restore replace target",
);
assert.match(appSource, /data-browser-window-content-size['"]/, "browser-window smoke should record hosted content-size readback");
assert.match(appSource, /data-browser-window-minimum-size/, "browser-window smoke should record hosted minimum-size readback");
assert.match(appSource, /data-browser-window-maximum-size/, "browser-window smoke should record hosted maximum-size readback");
assert.match(appSource, /data-browser-window-aspect-ratio-state/, "browser-window smoke should record hosted aspect-ratio state");
assert.match(appSource, /data-browser-window-content-size-restored/, "browser-window smoke should record restored hosted content-size state");
assert.match(componentSource, /function normalizePluginBrowserWindowSize\(/, "host should normalize browser-window sizes");
assert.match(componentSource, /function constrainPluginBrowserWindowSize\(/, "host should constrain browser-window sizes");
assert.match(componentSource, /normalizePluginBrowserWindowBounds\(actionArgs\[0\], pluginBrowserWindowBounds\(existing\), existing\)/, "setBounds should share hosted size constraint normalization");
const browserWindowSizeConstraintPath = "browserWindowSizeFromArgs(actionArgs, pluginBrowserWindowBounds(existing), existing)";
assert.equal(
  componentSource.split(browserWindowSizeConstraintPath).length - 1,
  2,
  "setSize and setContentSize should both share hosted size constraint normalization",
);
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `getContentSize\(\)` \/ `setContentSize\(\)`、`getMinimumSize\(\)` \/ `setMinimumSize\(\)`、`getMaximumSize\(\)` \/ `setMaximumSize\(\)`、`setAspectRatio\(\)` 会路由到宿主内 content-size\/min-max\/aspect-ratio state；`setBounds\(\)` \/ `setSize\(\)` \/ `setContentSize\(\)` 共享 hosted size constraint 路径。$/m,
  "macOS smoke checklist should mark BrowserWindow content-size/min-max/aspect-ratio row complete",
);
const browserWindowCapabilityReplaceTarget = "return win.setResizable(false); }).then(function(){ return win.isResizable(); }).then(function(resizable){ document.body.setAttribute('data-browser-window-resizable', String(resizable)); return win.setResizable(true); }).then(function(){ return win.setFullScreen(true); }";
assert.equal(
  appSource.split(browserWindowCapabilityReplaceTarget).length - 1,
  2,
  "browser-window capability smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.setResizable\(/, "browser-window smoke should exercise hosted resizable capability updates");
assert.match(appSource, /win\.isResizable\(/, "browser-window smoke should verify hosted resizable capability state");
assert.match(appSource, /win\.setMovable\(/, "browser-window smoke should exercise hosted movable capability updates");
assert.match(appSource, /win\.isMovable\(/, "browser-window smoke should verify hosted movable capability state");
assert.match(appSource, /win\.setClosable\(/, "browser-window smoke should exercise hosted closable capability updates");
assert.match(appSource, /win\.isClosable\(/, "browser-window smoke should verify hosted closable capability state");
assert.match(appSource, /win\.setMinimizable\(/, "browser-window smoke should exercise hosted minimizable capability updates");
assert.match(appSource, /win\.isMinimizable\(/, "browser-window smoke should verify hosted minimizable capability state");
assert.match(appSource, /win\.setMaximizable\(/, "browser-window smoke should exercise hosted maximizable capability updates");
assert.match(appSource, /win\.isMaximizable\(/, "browser-window smoke should verify hosted maximizable capability state");
assert.match(appSource, /data-browser-window-resizable/, "browser-window smoke should record hosted resizable readback");
assert.match(appSource, /data-browser-window-movable/, "browser-window smoke should record hosted movable readback");
assert.match(appSource, /data-browser-window-closable/, "browser-window smoke should record hosted closable readback");
assert.match(appSource, /data-browser-window-minimizable/, "browser-window smoke should record hosted minimizable readback");
assert.match(appSource, /data-browser-window-maximizable/, "browser-window smoke should record hosted maximizable readback");
assert.match(componentSource, /disabled=\{!childWindow\.closable\}/, "browser-window close button should be disabled when hosted closable is false");
assert.match(componentSource, /title=\{childWindow\.closable \? "关闭" : "关闭已禁用"\}/, "browser-window close button should expose disabled close state");
const browserWindowFullScreenEventReplaceTarget = "win.once('restore', function(state){ document.body.setAttribute('data-browser-window-event-restore-once', String(state && !state.minimized && !state.maximized)); }); win.on('resize'";
assert.equal(
  appSource.split(browserWindowFullScreenEventReplaceTarget).length - 1,
  2,
  "browser-window full-screen event smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.on\(['"]enter-full-screen/, "browser-window smoke should listen for hosted enter-full-screen events");
assert.match(appSource, /win\.on\(['"]leave-full-screen/, "browser-window smoke should listen for hosted leave-full-screen events");
assert.match(appSource, /data-browser-window-event-enter-full-screen/, "browser-window smoke should record hosted enter-full-screen events");
assert.match(appSource, /data-browser-window-event-leave-full-screen/, "browser-window smoke should record hosted leave-full-screen events");
const browserWindowFullScreenReplaceTarget = "return win.setFullScreen(true); }).then(function(){ return win.isFullScreen(); }).then(function(fullScreen){ document.body.setAttribute('data-browser-window-fullscreen', String(fullScreen)); return win.setFullScreen(false); }";
assert.equal(
  appSource.split(browserWindowFullScreenReplaceTarget).length - 1,
  3,
  "browser-window full-screen smoke replacement should match the srcdoc base string, replace target, and restored replacement tail",
);
assert.match(appSource, /win\.setFullScreen\(/, "browser-window smoke should exercise hosted full-screen state");
assert.match(appSource, /win\.isFullScreen\(/, "browser-window smoke should verify hosted full-screen state");
assert.match(appSource, /win\.setFullScreenable\(/, "browser-window smoke should exercise hosted full-screenable capability updates");
assert.match(appSource, /win\.isFullScreenable\(/, "browser-window smoke should verify hosted full-screenable capability state");
assert.match(appSource, /data-browser-window-fullscreen-blocked/, "browser-window smoke should verify full-screenable false blocks hosted full-screen");
assert.match(appSource, /data-browser-window-fullscreenable-restored/, "browser-window smoke should record restored hosted full-screenable state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `isFullScreen\(\)` \/ `setFullScreen\(\)`、`isFullScreenable\(\)` \/ `setFullScreenable\(\)` 会路由到宿主内 full-screen state；`setFullScreen\(true\)` \/ `setFullScreen\(false\)` 会切换宿主内 full-screen class\/state 并派发 `enter-full-screen` \/ `leave-full-screen`，`fullScreenable:false` 不进入宿主 full-screen。$/m,
  "macOS smoke checklist should mark BrowserWindow full-screen state row complete",
);
const browserWindowOpacityReplaceTarget = "return win.setOpacity(0.72); }).then(function(){ return win.getOpacity(); }).then(function(opacity){ document.body.setAttribute('data-browser-window-opacity', String(opacity === 0.72)); return win.setOpacity(1); }).then(function(){ return win.setHasShadow(false); }";
assert.equal(
  appSource.split(browserWindowOpacityReplaceTarget).length - 1,
  2,
  "browser-window opacity smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.setOpacity\(/, "browser-window smoke should exercise hosted opacity state");
assert.match(appSource, /win\.getOpacity\(/, "browser-window smoke should verify hosted opacity state");
assert.match(appSource, /data-browser-window-opacity-restored/, "browser-window smoke should record restored hosted opacity state");
const browserWindowShadowReplaceTarget = "return win.setHasShadow(false); }).then(function(){ return win.hasShadow(); }).then(function(hasShadow){ document.body.setAttribute('data-browser-window-shadow-disabled', String(!hasShadow)); return win.setHasShadow(true); }).then(function(){ return win.invalidateShadow(); }).then(function(){ return win.setSkipTaskbar(true); }";
assert.equal(
  appSource.split(browserWindowShadowReplaceTarget).length - 1,
  2,
  "browser-window shadow smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.setHasShadow\(/, "browser-window smoke should exercise hosted shadow state");
assert.match(appSource, /win\.hasShadow\(/, "browser-window smoke should verify hosted shadow state");
assert.match(appSource, /win\.invalidateShadow\(/, "browser-window smoke should exercise hosted invalidateShadow state");
assert.match(appSource, /data-browser-window-shadow-restored/, "browser-window smoke should record restored hosted shadow state");
assert.match(componentSource, /const appearance = childWindow\.opacity < 1 \? ` opacity: \$\{childWindow\.opacity\};` : "";/, "host should only render inline opacity for non-1 child browser windows");
assert.match(componentSource, /class:noShadow=\{!childWindow\.hasShadow\}/, "host should render noShadow only while hosted shadow is disabled");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `getOpacity\(\)` \/ `setOpacity\(\)`、`hasShadow\(\)` \/ `setHasShadow\(\)` \/ `invalidateShadow\(\)` 会路由到宿主内 appearance state；非 1 opacity 写入宿主内子窗口 inline style，`hasShadow:false` 添加 `noShadow` class，恢复后最终窗口不残留 opacity\/noShadow。$/m,
  "macOS smoke checklist should mark BrowserWindow appearance state row complete",
);
assert.match(appSource, /win\.setSkipTaskbar\(/, "browser-window smoke should exercise hosted skip-taskbar state");
assert.match(appSource, /win\.setKiosk\(/, "browser-window smoke should exercise hosted kiosk state");
assert.match(appSource, /win\.isKiosk\(/, "browser-window smoke should verify hosted kiosk state");
assert.match(appSource, /data-browser-window-kiosk['"]/, "browser-window smoke should record hosted kiosk readback");
assert.match(appSource, /data-browser-window-kiosk-restored/, "browser-window smoke should record restored hosted kiosk state");
assert.match(appSource, /win\.setVisibleOnAllWorkspaces\(/, "browser-window smoke should exercise hosted workspace visibility state");
assert.match(appSource, /win\.isVisibleOnAllWorkspaces\(/, "browser-window smoke should verify hosted workspace visibility state");
assert.match(appSource, /data-browser-window-workspaces/, "browser-window smoke should record hosted workspace visibility state");
assert.match(appSource, /win\.setContentProtection\(/, "browser-window smoke should exercise hosted content protection state");
assert.match(appSource, /win\.isContentProtected\(/, "browser-window smoke should verify hosted content protection state");
assert.match(appSource, /data-browser-window-content-protected/, "browser-window smoke should record hosted content-protection state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setSkipTaskbar\(\)`、`setKiosk\(\)` \/ `isKiosk\(\)`、`setVisibleOnAllWorkspaces\(\)` \/ `isVisibleOnAllWorkspaces\(\)`、`setContentProtection\(\)` \/ `isContentProtected\(\)` 会路由到宿主内 system-state；`kiosk:true` 会填满 hosted layer，恢复后最终窗口不残留 `kiosk` class。$/m,
  "macOS smoke checklist should mark BrowserWindow system-state row complete",
);
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `isResizable\(\)` \/ `setResizable\(\)`、`isMovable\(\)` \/ `setMovable\(\)`、`isClosable\(\)` \/ `setClosable\(\)`、`isMinimizable\(\)` \/ `setMinimizable\(\)`、`isMaximizable\(\)` \/ `setMaximizable\(\)` 会路由到宿主内 capability state；`closable:false` 会禁用宿主内子窗口关闭按钮。$/m,
  "macOS smoke checklist should mark BrowserWindow capability state row complete",
);
assert.match(appSource, /win\.setFocusable\(/, "browser-window smoke should exercise hosted focusable state");
assert.match(appSource, /win\.isFocusable\(/, "browser-window smoke should verify hosted focusable state");
const browserWindowFocusAttentionReplaceTarget = "return win.setFocusable(true); }).then(function(){ return win.flashFrame(true); }).then(function(){ return win.flashFrame(false); }).then(function(){ return win.setProgressBar(0.42, { mode: 'normal' }); }).then(function(){ return win.setProgressBar(-1); }).then(function(){ return win.getMediaSourceId(); }";
assert.equal(
  appSource.split(browserWindowFocusAttentionReplaceTarget).length - 1,
  2,
  "browser-window focus/attention/progress smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-focusable/, "browser-window smoke should record hosted focusable readback");
assert.match(appSource, /data-browser-window-focusable-restored/, "browser-window smoke should record restored hosted focusable state");
assert.match(appSource, /win\.flashFrame\(/, "browser-window smoke should exercise hosted attention state");
assert.match(appSource, /win\.setProgressBar\(/, "browser-window smoke should exercise hosted progress state");
assert.match(appSource, /data-browser-window-attention-progress-state/, "browser-window smoke should record hosted attention/progress state and cleanup");
assert.match(componentSource, /\.plugin-browser-window\.flashing \{/, "host should style flashing child browser windows");
assert.match(componentSource, /\{#if childWindow\.progressBar !== null \|\| childWindow\.progressBarMode === "indeterminate"\}/, "host should render progress strip while hosted progress state is active");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setFocusable\(\)` \/ `isFocusable\(\)`、`flashFrame\(\)`、`setProgressBar\(\)` 会路由到宿主内 focus\/attention\/progress state；`flashFrame\(true\)` 添加 hosted `flashing` class，`setProgressBar\(\)` 显示 hosted 标题栏进度条，恢复后最终窗口不残留 `flashing` class 或 progress strip。$/m,
  "macOS smoke checklist should mark BrowserWindow focus/attention/progress row complete",
);
const browserWindowMoveTopReplaceTarget = "return win.moveTop(); }).then(function(){ return window.utools.createBrowserWindow('child.html', { title: '置顶参照', show: false }); }";
assert.equal(
  appSource.split(browserWindowMoveTopReplaceTarget).length - 1,
  2,
  "browser-window z-order smoke replacement should match both the srcdoc base string and the moveTop replace target",
);
const browserWindowMoveAboveReplaceTarget = "return win.moveAbove(sourceId).then(function(){ return sourceWin.close(); });";
assert.equal(
  appSource.split(browserWindowMoveAboveReplaceTarget).length - 1,
  2,
  "browser-window z-order smoke replacement should match both the srcdoc base string and the moveAbove replace target",
);
assert.match(appSource, /win\.getMediaSourceId\(/, "browser-window smoke should verify hosted media source id");
assert.match(appSource, /win\.moveTop\(/, "browser-window smoke should exercise hosted z-order moveTop");
assert.match(appSource, /win\.moveAbove\(/, "browser-window smoke should exercise hosted z-order moveAbove");
assert.match(appSource, /data-browser-window-media-source-id/, "browser-window smoke should record hosted media source id");
assert.match(appSource, /data-browser-window-source-id/, "browser-window smoke should record temporary hosted source id");
assert.match(appSource, /data-browser-window-z-order-state/, "browser-window smoke should record hosted z-order moveTop/moveAbove state");
assert.match(componentSource, /return ` z-index: \$\{base \+ childWindow\.zOrder\};`;/, "host should render hosted z-order into child browser-window z-index");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `getMediaSourceId\(\)`、`moveTop\(\)`、`moveAbove\(mediaSourceId\)` 会路由到宿主内 z-order\/media-source state；`moveTop\(\)` \/ `moveAbove\(\)` 更新 hosted z-index，临时参照子窗口关闭后最终只保留主子窗口。$/m,
  "macOS smoke checklist should mark BrowserWindow z-order/media-source row complete",
);
assert.match(appSource, /win\.setAlwaysOnTop\(/, "browser-window smoke should exercise hosted always-on-top state");
assert.match(appSource, /win\.isAlwaysOnTop\(/, "browser-window smoke should verify hosted always-on-top state");
const browserWindowAggregateSmokeChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会自动验证 hosted child sandbox",
);
assert.ok(
  browserWindowAggregateSmokeChecklistLine,
  "macOS smoke checklist should include BrowserWindow aggregate Web preview row",
);
assert.match(
  browserWindowAggregateSmokeChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow aggregate Web preview row complete",
);
[
  "`allow-scripts allow-popups`",
  "`MessageChannel`",
  "`describe`",
  "`webContents.send()`",
  "`webContents.executeJavaScript()`",
  "`webContents.sendInputEvent()`",
  "`webContents.insertCSS()`",
  "`webContents.removeInsertedCSS()`",
  "`webContents.findInPage()`",
  "`webContents.stopFindInPage()`",
  "`webContents.inspectElement()`",
  "`capturePage()`",
  "`printToPDF()`",
  "`savePage()`",
  "12 个 edit API",
  "4 个 selection/scroll API",
  "20",
  "`ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`",
  "`print()`",
  "callback",
].forEach((token) => {
  assert.ok(
    browserWindowAggregateSmokeChecklistLine.includes(token),
    `BrowserWindow aggregate Web preview row should mention ${token}`,
  );
});
[
  "data-browser-window-visible",
  "data-browser-window-url",
  "data-browser-window-event-focus",
  "data-browser-window-event-maximize",
  "data-browser-window-event-restore-once",
  "data-browser-window-event-resize",
  "data-browser-window-event-move-once",
  "data-browser-window-content-size-restored",
  "data-browser-window-fullscreenable-restored",
  "data-browser-window-opacity-restored",
  "data-browser-window-shadow-restored",
  "data-browser-window-kiosk-restored",
  "data-browser-window-focusable-restored",
  "data-browser-window-attention-progress-state",
  "data-browser-window-webcontents-send",
  "data-child-ipc-ping",
  "data-parent-message-channel",
  "data-browser-window-execute-js",
  "data-browser-window-send-input-event-dom",
  "data-browser-window-insert-css-removed",
  "data-browser-window-found-in-page",
  "data-browser-window-stop-find-in-page",
  "data-browser-window-navigation-sync-state",
  "data-browser-window-devtools-state",
  "data-browser-window-runtime-state",
  "data-browser-window-audio-muted",
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-zoom-factor",
  "data-browser-window-z-order-state",
  "data-browser-window-always-on-top",
  "data-browser-window-isolated-unsupported-complete",
  "data-browser-window-smoke-complete",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window aggregate smoke should record ${marker}`);
});
const browserWindowWebContentsLifecycleAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.loadURL()` / `reload()` / `stop()` / `isDestroyed()` / `getType()`",
);
assert.ok(
  browserWindowWebContentsLifecycleAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow WebContents lifecycle aggregate row",
);
assert.match(
  browserWindowWebContentsLifecycleAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow WebContents lifecycle aggregate row complete",
);
[
  "`webContents.loadURL()`",
  "`reload()`",
  "`stop()`",
  "`isDestroyed()`",
  "`getType()`",
  'data-browser-window-webcontents-load-url="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
  'data-browser-window-isolated-unsupported-complete="true"',
  "20 个隔离拒绝",
  "audio",
  "zoom",
  "DevTools",
  "IPC",
  "find-in-page",
  "CSS insert/remove",
  "always-on-top",
].forEach((token) => {
  assert.ok(
    browserWindowWebContentsLifecycleAggregateChecklistLine.includes(token),
    `BrowserWindow WebContents lifecycle aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-webcontents-load-url",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-capture-print-save-state",
  "data-browser-window-selection-scroll-commands",
  "data-browser-window-edit-commands",
  "data-browser-window-inspect-element-state",
  "data-browser-window-audio-muted",
  "data-browser-window-zoom-factor",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window WebContents lifecycle aggregate smoke should record ${marker}`);
});
const browserWindowWebContentsCrashAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.isCrashed()` / `forcefullyCrashRenderer()` / targeted `render-process-gone`",
);
assert.ok(
  browserWindowWebContentsCrashAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow WebContents crash aggregate row",
);
assert.match(
  browserWindowWebContentsCrashAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow WebContents crash aggregate row complete",
);
[
  "`webContents.isCrashed()`",
  "`forcefullyCrashRenderer()`",
  "targeted `render-process-gone`",
  'data-browser-window-render-process-gone="true"',
  'data-browser-window-webcontents-crash="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowWebContentsCrashAggregateChecklistLine.includes(token),
    `BrowserWindow WebContents crash aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-render-process-gone",
  "data-browser-window-webcontents-crash",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-capture-print-save-state",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window WebContents crash aggregate smoke should record ${marker}`);
});
const browserWindowWebContentsFocusAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()`",
);
assert.ok(
  browserWindowWebContentsFocusAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow WebContents focus/owner/media aggregate row",
);
assert.match(
  browserWindowWebContentsFocusAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow WebContents focus/owner/media aggregate row complete",
);
[
  "`webContents.focus()`",
  "`isFocused()`",
  "`getOwnerBrowserWindow()`",
  "`getMediaSourceId()`",
  "`isBeingCaptured()`",
  "`setIgnoreMenuShortcuts()`",
  'data-browser-window-webcontents-focus-state="true"',
  'data-browser-window-webcontents-owner-media="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowWebContentsFocusAggregateChecklistLine.includes(token),
    `BrowserWindow WebContents focus/owner/media aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-render-process-gone",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window WebContents focus/owner/media aggregate smoke should record ${marker}`);
});
const browserWindowNavigationHistoryAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.navigationHistory.goToOffset(-1)` / `goForward()` / `clear()`",
);
assert.ok(
  browserWindowNavigationHistoryAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow navigationHistory aggregate row",
);
assert.match(
  browserWindowNavigationHistoryAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow navigationHistory aggregate row complete",
);
[
  "`webContents.navigationHistory.goToOffset(-1)`",
  "`goForward()`",
  "`clear()`",
  'data-browser-window-navigation-history="true"',
  'data-browser-window-webcontents-focus-state="true"',
  'data-browser-window-webcontents-owner-media="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowNavigationHistoryAggregateChecklistLine.includes(token),
    `BrowserWindow navigationHistory aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-navigation-history",
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-render-process-gone",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window navigationHistory aggregate smoke should record ${marker}`);
});
const browserWindowWaitingBackgroundAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 `webContents.isWaitingForResponse()` 和 BrowserWindow `setBackgroundColor()` / `getBackgroundColor()`",
);
assert.ok(
  browserWindowWaitingBackgroundAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow waiting-response/background-color aggregate row",
);
assert.match(
  browserWindowWaitingBackgroundAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow waiting-response/background-color aggregate row complete",
);
[
  "`webContents.isWaitingForResponse()`",
  "`setBackgroundColor()`",
  "`getBackgroundColor()`",
  'data-browser-window-webcontents-waiting-response="true"',
  'data-browser-window-background-color="true"',
  'data-browser-window-navigation-history="true"',
  'data-browser-window-webcontents-focus-state="true"',
  'data-browser-window-webcontents-owner-media="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowWaitingBackgroundAggregateChecklistLine.includes(token),
    `BrowserWindow waiting-response/background-color aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-webcontents-waiting-response",
  "data-browser-window-background-color",
  "data-browser-window-navigation-history",
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-render-process-gone",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window waiting-response/background-color aggregate smoke should record ${marker}`);
});
const browserWindowMenuBarAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 BrowserWindow `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()`",
);
assert.ok(
  browserWindowMenuBarAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow menu-bar aggregate row",
);
assert.match(
  browserWindowMenuBarAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow menu-bar aggregate row complete",
);
[
  "`setAutoHideMenuBar()`",
  "`isMenuBarAutoHide()`",
  "`setMenuBarVisibility()`",
  "`isMenuBarVisible()`",
  "`removeMenu()`",
  "`setMenu()`",
  'data-browser-window-menu-bar-state="true"',
  'data-browser-window-background-color="true"',
  'data-browser-window-webcontents-waiting-response="true"',
  'data-browser-window-navigation-history="true"',
  'data-browser-window-webcontents-focus-state="true"',
  'data-browser-window-webcontents-owner-media="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowMenuBarAggregateChecklistLine.includes(token),
    `BrowserWindow menu-bar aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-menu-bar-state",
  "data-browser-window-background-color",
  "data-browser-window-webcontents-waiting-response",
  "data-browser-window-navigation-history",
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-render-process-gone",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window menu-bar aggregate smoke should record ${marker}`);
});
const browserWindowTitlebarMaterialAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 BrowserWindow `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()`",
);
assert.ok(
  browserWindowTitlebarMaterialAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow titlebar/material aggregate row",
);
assert.match(
  browserWindowTitlebarMaterialAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow titlebar/material aggregate row complete",
);
[
  "`setWindowButtonVisibility()`",
  "`setWindowButtonPosition()`",
  "`getWindowButtonPosition()`",
  "`setVibrancy()`",
  "`setBackgroundMaterial()`",
  "`setSheetOffset()`",
  'data-browser-window-titlebar-material-state="true"',
  'data-browser-window-menu-bar-state="true"',
  'data-browser-window-background-color="true"',
  'data-browser-window-webcontents-waiting-response="true"',
  'data-browser-window-navigation-history="true"',
  'data-browser-window-webcontents-focus-state="true"',
  'data-browser-window-webcontents-owner-media="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowTitlebarMaterialAggregateChecklistLine.includes(token),
    `BrowserWindow titlebar/material aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-titlebar-material-state",
  "data-browser-window-menu-bar-state",
  "data-browser-window-background-color",
  "data-browser-window-webcontents-waiting-response",
  "data-browser-window-navigation-history",
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-render-process-gone",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window titlebar/material aggregate smoke should record ${marker}`);
});
const browserWindowDocumentParentAggregateChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会额外自动验证 BrowserWindow `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()`",
);
assert.ok(
  browserWindowDocumentParentAggregateChecklistLine,
  "macOS smoke checklist should include BrowserWindow document/parent aggregate row",
);
assert.match(
  browserWindowDocumentParentAggregateChecklistLine,
  /^- \[x\] /,
  "macOS smoke checklist should mark BrowserWindow document/parent aggregate row complete",
);
[
  "`isNormal()`",
  "`isModal()`",
  "`setDocumentEdited()`",
  "`isDocumentEdited()`",
  "`setRepresentedFilename()`",
  "`getRepresentedFilename()`",
  "`setParentWindow()`",
  "`getParentWindow()`",
  "`getChildWindows()`",
  'data-browser-window-document-parent-state="true"',
  'data-browser-window-parent-child-state="true"',
  'data-browser-window-titlebar-material-state="true"',
  'data-browser-window-menu-bar-state="true"',
  'data-browser-window-background-color="true"',
  'data-browser-window-webcontents-waiting-response="true"',
  'data-browser-window-navigation-history="true"',
  'data-browser-window-webcontents-focus-state="true"',
  'data-browser-window-webcontents-owner-media="true"',
  'data-browser-window-webcontents-crash-reload="true"',
  'data-browser-window-webcontents-lifecycle="true"',
  'data-browser-window-runtime-state="true"',
].forEach((token) => {
  assert.ok(
    browserWindowDocumentParentAggregateChecklistLine.includes(token),
    `BrowserWindow document/parent aggregate row should mention ${token}`,
  );
});
[
  "data-browser-window-document-parent-state",
  "data-browser-window-parent-child-state",
  "data-browser-window-titlebar-material-state",
  "data-browser-window-menu-bar-state",
  "data-browser-window-background-color",
  "data-browser-window-webcontents-waiting-response",
  "data-browser-window-navigation-history",
  "data-browser-window-webcontents-focus-state",
  "data-browser-window-webcontents-owner-media",
  "data-browser-window-webcontents-crash-reload",
  "data-browser-window-webcontents-lifecycle",
  "data-browser-window-runtime-state",
  "data-browser-window-webcontents-load-url",
  "data-browser-window-render-process-gone",
  "data-browser-window-devtools-state",
  "data-browser-window-webcontents-send",
  "data-browser-window-found-in-page",
  "data-browser-window-insert-css-removed",
  "data-browser-window-always-on-top",
].forEach((marker) => {
  assert.ok(appSource.includes(marker), `browser-window document/parent aggregate smoke should record ${marker}`);
});
assert.match(capabilitySource, /"createBrowserWindow"/, "shared capability inventory should include createBrowserWindow");
assert.match(capabilitySource, /"sendToParent"/, "shared capability inventory should include sendToParent");
