import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { appSource, browserWindowAggregateSmokeChecklistLine, capabilitySource, smokeChecklistLineContaining } = fixture;
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

  Object.assign(fixture, {appSource, browserWindowAggregateSmokeChecklistLine, capabilitySource, smokeChecklistLineContaining});
}
