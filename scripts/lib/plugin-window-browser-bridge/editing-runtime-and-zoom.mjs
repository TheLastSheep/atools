import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, isolatedUnsupportedPattern, mainVm, plain } = fixture;
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


  Object.assign(fixture, {browserWindowHandle, isolatedUnsupportedPattern, mainVm, plain});
}
