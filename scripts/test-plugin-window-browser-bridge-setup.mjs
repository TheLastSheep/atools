import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { loadProductionPluginBridgeTemplate, readLauncherOwnerSource } from "./lib/plugin-panel-source-test-adapter.mjs";

export async function runInitialHandshake(fixture) {

const root = new URL("../", import.meta.url);
// Keep the legacy fixture key for its assertion consumers; read the extracted smoke-action owner.
const appSource = await readLauncherOwnerSource(root, "src/lib/pluginHostSmokeAction.ts");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
const uiRestoreChecklist = await readFile(new URL("docs/ui-ztools-restore-checklist.md", root), "utf8");
const bridgeTestSource = await readFile(new URL("scripts/lib/plugin-window-browser-bridge/events-and-parent-ipc.mjs", root), "utf8");

function smokeChecklistLineContaining(marker) {
  return smokeChecklist.split("\n").find((line) => line.includes(marker)) || "";
}

const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);
const bridgeMatch = [null, bridgeTemplate];
assert.ok(bridgeMatch[1], "production bridge module graph should expose the injected utools bridge");

function bridgeSourceFor(windowType = "main", browserWindowId = "") {
  return bridgeTemplate
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
      if (event.type === "message" && !("source" in event)) event = { ...event, source: windowStub.parent };
      if (event.data?.__atools_browser_window_event__ && !event.data.geometrySnapshot) event = { ...event, data: { ...event.data, geometrySnapshot: browserWindowGeometry } };
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
    CustomEvent: EventStub,
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

  function sendHostMessage(data) {
    const handlers = listeners.get("message") || [];
    if (data?.__atools_browser_window_event__ && !data.geometrySnapshot) data = { ...data, geometrySnapshot: browserWindowGeometry };
    handlers.forEach((handler) => handler({ source: windowStub.parent, data }));
  }

  return { windowStub, postedMessages, respondToNativeCall, sendHostMessage };
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
  () => callbackCalls.push(["ready"]),
);
assert.equal(typeof browserPromise.isDestroyed, "function", "createBrowserWindow should synchronously return a live handle facade");
assert.equal(browserPromise.isDestroyed(), false, "pending handle should synchronously report its known live lifecycle state");
assert.equal(typeof browserPromise.setAlwaysOnTop, "function", "pending handle should already expose real window methods");
assert.equal(typeof browserPromise.setFullScreen, "function", "pending handle should already expose full-screen methods");
assert.equal(typeof browserPromise.setSkipTaskbar, "function", "pending handle should already expose taskbar methods");
assert.equal(browserPromise.then, undefined, "BrowserWindow facade must stay non-thenable; await the explicit ready promise instead");
await Promise.resolve();
const dispatchedBrowserCall = mainVm.postedMessages.find((message) => message.method === "createBrowserWindow");
assert.ok(dispatchedBrowserCall, "createBrowserWindow should route through the native bridge");
assert.deepEqual(plain(dispatchedBrowserCall.args), {
  url: "test.html",
  options: windowOptions,
  hasCallback: true,
  clientCreateId: dispatchedBrowserCall.args.clientCreateId,
});
const requestedCreateId = dispatchedBrowserCall.args.clientCreateId;
assert.match(requestedCreateId, /^atools-browser-window-create-/);
const browserWindowGeometry = { windowId: "browser-window-1", clientCreateId: requestedCreateId, ownerKey: "fixture-owner",
  instanceNonce: "fixture-instance", documentGeneration: 1, documentNonce: "fixture-document", revision: 1,
  bounds: { x: 0, y: 0, width: 560, height: 220 }, minimumSize: [100, 80], maximumSize: [1000, 800] };
function confirmGeometry(patch) {
  Object.assign(browserWindowGeometry, patch, { revision: browserWindowGeometry.revision + 1 });
  mainVm.sendHostMessage({ __atools_browser_window_geometry__: true, windowId: browserWindowGeometry.windowId,
    clientCreateId: requestedCreateId, geometrySnapshot: browserWindowGeometry });
}
mainVm.respondToNativeCall(dispatchedBrowserCall, {
  result: {
    id: "browser-window-1",
    clientCreateId: requestedCreateId,
    geometrySnapshot: browserWindowGeometry,
    type: "browserWindow",
    windowType: "browserWindow",
    url: "test.html",
    title: "测试窗口",
  },
});
const browserWindowHandle = browserPromise;
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(browserWindowHandle.isDestroyed(), false, "native creation response should bind the existing pending handle");
assert.deepEqual(callbackCalls, [], "create callback must wait for the child load and RPC-ready notification");
mainVm.sendHostMessage({
  __atools_browser_window_ready__: true,
  windowId: "browser-window-1",
  clientCreateId: requestedCreateId,
});
assert.equal(await browserWindowHandle.ready, browserWindowHandle, "ready should resolve to the same facade after the real child handshake");
assert.deepEqual(callbackCalls, [["ready"]], "create callback should run once on actual child readiness");
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


  Object.assign(fixture, {root, appSource, capabilitySource, smokeChecklist, uiRestoreChecklist, bridgeTestSource, smokeChecklistLineContaining, bridgeMatch, createBridgeVm, plain, mainVm, callbackCalls, confirmGeometry, browserWindowHandle});
}
