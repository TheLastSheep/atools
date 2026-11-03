import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, mainVm, plain } = fixture;
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

  Object.assign(fixture, {browserWindowHandle, mainVm, plain});
}
