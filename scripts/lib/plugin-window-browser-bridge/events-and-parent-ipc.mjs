import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, mainVm, plain } = fixture;
const browserEventCalls = [];
const focusListener = (...args) => browserEventCalls.push(["focus", ...plain(args)]);
const removedFocusListener = (...args) => browserEventCalls.push(["removed-focus", ...plain(args)]);
const hideListener = (...args) => browserEventCalls.push(["hide", ...plain(args)]);
assert.equal(browserWindowHandle.on("focus", focusListener), browserWindowHandle, "on() should return the handle for chaining");
assert.equal(browserWindowHandle.addListener("focus", removedFocusListener), browserWindowHandle, "addListener() should alias on()");
assert.equal(browserWindowHandle.off("focus", removedFocusListener), browserWindowHandle, "off() should return the handle");
assert.equal(browserWindowHandle.on("hide", hideListener), browserWindowHandle, "on() should register additional events");
assert.equal(browserWindowHandle.removeAllListeners("hide"), browserWindowHandle, "removeAllListeners(event) should return the handle");

const parentIpcCalls = [];
mainVm.windowStub.require("electron").ipcRenderer.on("pong", (_event, ...args) => parentIpcCalls.push(args));
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


  Object.assign(fixture, {browserWindowHandle, mainVm, plain, browserEventCalls, parentIpcCalls});
}
