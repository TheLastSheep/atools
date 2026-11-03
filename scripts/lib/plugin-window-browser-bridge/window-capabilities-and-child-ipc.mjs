import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserEventCalls, browserWindowHandle, callbackCalls, createBridgeVm, mainVm, parentIpcCalls, plain } = fixture;
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
assert.deepEqual(parentIpcCalls, [["hello", 123]], "child sendToParent messages should reach the parent plugin ipcRenderer broker");
assert.deepEqual(callbackCalls, [["ready"]], "sendToParent messages must not call the createBrowserWindow readiness callback");

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
assert.equal(closeCall, undefined, "close() after a real closed event should not send a duplicate native close");
assert.equal(await closePromise, undefined);
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


  Object.assign(fixture, {browserEventCalls, browserWindowHandle, callbackCalls, createBridgeVm, mainVm, parentIpcCalls, plain});
}
