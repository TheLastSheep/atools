import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { browserWindowHandle, mainVm, plain } = fixture;
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
await new Promise((resolve) => setTimeout(resolve, 0));
const parentBrowserCall = mainVm.postedMessages.find((message) => message.method === "createBrowserWindow" && message.args.url === "parent.html");
assert.ok(parentBrowserCall, "parent createBrowserWindow should route through the native bridge");
mainVm.respondToNativeCall(parentBrowserCall, {
  result: {
    id: "browser-window-parent",
    clientCreateId: parentBrowserCall.args.clientCreateId,
    type: "browserWindow",
    windowType: "browserWindow",
    url: "parent.html",
    title: "父窗口",
    modal: true,
  },
});
await new Promise((resolve) => setTimeout(resolve, 0));
mainVm.sendHostMessage({
  __atools_browser_window_ready__: true,
  windowId: "browser-window-parent",
  clientCreateId: parentBrowserCall.args.clientCreateId,
});
const parentBrowserWindowHandle = await parentBrowserPromise.ready;
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


  Object.assign(fixture, {browserWindowHandle, mainVm, plain});
}
