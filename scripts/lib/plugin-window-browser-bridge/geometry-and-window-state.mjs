import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, confirmGeometry, mainVm, plain } = fixture;
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

const beforeGeometryGetters = mainVm.postedMessages.length;
assert.deepEqual(plain(browserWindowHandle.getBounds()), { x: 0, y: 0, width: 560, height: 220 });
assert.equal(mainVm.postedMessages.length, beforeGeometryGetters, "geometry getters read confirmed snapshots without IPC");

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

confirmGeometry({ bounds: { x: 24, y: 32, width: 420, height: 260 } });
assert.deepEqual(plain(browserWindowHandle.getSize()), [420, 260]);

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

confirmGeometry({ bounds: { x: 24, y: 32, width: 480, height: 280 } });
assert.deepEqual(plain(browserWindowHandle.getContentSize()), [480, 280]);

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

confirmGeometry({ bounds: { x: 24, y: 32, width: 390, height: 240 }, minimumSize: [360, 220] });
assert.deepEqual(plain(browserWindowHandle.getMinimumSize()), [360, 220]);

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

confirmGeometry({ maximumSize: [900, 640] });
assert.deepEqual(plain(browserWindowHandle.getMaximumSize()), [900, 640]);

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

assert.deepEqual(plain(browserWindowHandle.getPosition()), [24, 32]);

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


  Object.assign(fixture, {browserWindowHandle, confirmGeometry, mainVm, plain});
}
