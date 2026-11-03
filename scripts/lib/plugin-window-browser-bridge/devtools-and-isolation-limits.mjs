import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, mainVm, plain } = fixture;
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


  Object.assign(fixture, {browserWindowHandle, mainVm, plain, isolatedUnsupportedPattern});
}
