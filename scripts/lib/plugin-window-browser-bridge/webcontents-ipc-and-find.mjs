import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, mainVm, plain } = fixture;
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


  Object.assign(fixture, {browserWindowHandle, mainVm, plain});
}
