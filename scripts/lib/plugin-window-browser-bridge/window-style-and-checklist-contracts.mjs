import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { root, appSource, smokeChecklist, smokeChecklistLineContaining } = fixture;
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function browserWindowGetChildWindows\(\) \{\n      var children = \[\];\n      Object\.keys\(_browserWindowHandles\)\.forEach\(function\(key\) \{[\s\S]*?childHandle\.__atoolsParentWindowId\(\) === id[\s\S]*?children\.push\(childHandle\);/, "bridge should derive child window handles from hosted parent ids");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowLifecycleActions.ts"), /if \(actionName === "isNormal"\) \{\s+return !existing\.minimized && !existing\.maximized && !existing\.fullScreen && !existing\.kiosk;[\s\S]*?if \(actionName === "getChildWindows"\) \{\s+return ports\.windows\.filter\(\(childWindow\) => childWindow\.parentWindowId === id\)\.map\(\(childWindow\) => childWindow\.id\);/, "host should route BrowserWindow document and parent-child state actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `isNormal\(\)` \/ `isModal\(\)` \/ `setDocumentEdited\(\)` \/ `isDocumentEdited\(\)` \/ `setRepresentedFilename\(\)` \/ `getRepresentedFilename\(\)` \/ `setParentWindow\(\)` \/ `getParentWindow\(\)` \/ `getChildWindows\(\)` 会更新 hosted document\/parent state；document\/representedFilename setter 保持 void-return shape，sync getter 立即可读，`setParentWindow\(null\)` 会清理 hosted parent\/child 关系。$/m,
  "macOS smoke checklist should mark BrowserWindow document/parent state row complete",
);
assert.match(appSource, /win\.loadURL\(/, "browser-window smoke should exercise hosted URL navigation");
assert.match(appSource, /win\.getURL\(/, "browser-window smoke should verify hosted URL state");
assert.match(appSource, /win\.reload\(/, "browser-window smoke should exercise hosted reload");
assert.match(appSource, /win\.minimize\(/, "browser-window smoke should exercise hosted minimize");
assert.match(appSource, /win\.isMinimized\(/, "browser-window smoke should verify hosted minimized state");
assert.match(appSource, /win\.restore\(/, "browser-window smoke should exercise hosted restore");
assert.match(appSource, /win\.maximize\(/, "browser-window smoke should exercise hosted maximize");
assert.match(appSource, /win\.isMaximized\(/, "browser-window smoke should verify hosted maximized state");
assert.match(appSource, /win\.unmaximize\(/, "browser-window smoke should exercise hosted unmaximize");
assert.match(appSource, /win\.on\(['"]focus/, "browser-window smoke should exercise hosted event listeners");
assert.match(appSource, /win\.once\(['"]restore/, "browser-window smoke should exercise hosted one-shot event listeners");
assert.match(appSource, /win\.on\(['"]resize/, "browser-window smoke should exercise hosted resize events");
assert.match(appSource, /win\.once\(['"]move/, "browser-window smoke should exercise hosted move events");
assert.match(appSource, /win\.setContentSize\(/, "browser-window smoke should exercise hosted content-size updates");
assert.match(appSource, /win\.getContentSize\(/, "browser-window smoke should verify hosted content-size state");
assert.match(appSource, /win\.setMinimumSize\(/, "browser-window smoke should exercise hosted minimum-size constraints");
assert.match(appSource, /win\.getMinimumSize\(/, "browser-window smoke should verify hosted minimum-size constraints");
assert.match(appSource, /win\.setMaximumSize\(/, "browser-window smoke should exercise hosted maximum-size constraints");
assert.match(appSource, /win\.getMaximumSize\(/, "browser-window smoke should verify hosted maximum-size constraints");
assert.match(appSource, /win\.setAspectRatio\(/, "browser-window smoke should exercise hosted aspect-ratio state");
const browserWindowSizingRestoreReplaceTarget = "return win.setAspectRatio(16 / 9, { width: 40, height: 30 }); }).then(function(){ return win.setContentSize(420, 260); }).then(function(){ return win.setResizable(false); }";
assert.equal(
  appSource.split(browserWindowSizingRestoreReplaceTarget).length - 1,
  2,
  "browser-window sizing smoke replacement should match both the srcdoc base string and the content-size restore replace target",
);
assert.match(appSource, /data-browser-window-content-size['"]/, "browser-window smoke should record hosted content-size readback");
assert.match(appSource, /data-browser-window-minimum-size/, "browser-window smoke should record hosted minimum-size readback");
assert.match(appSource, /data-browser-window-maximum-size/, "browser-window smoke should record hosted maximum-size readback");
assert.match(appSource, /data-browser-window-aspect-ratio-state/, "browser-window smoke should record hosted aspect-ratio state");
assert.match(appSource, /data-browser-window-content-size-restored/, "browser-window smoke should record restored hosted content-size state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function normalizePluginBrowserWindowSize\(/, "host should normalize browser-window sizes");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function constrainPluginBrowserWindowSize\(/, "host should constrain browser-window sizes");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /normalizePluginBrowserWindowBounds\(actionArgs\[0\], pluginBrowserWindowBounds\(existing\), existing\)/, "setBounds should share hosted size constraint normalization");
const browserWindowSizeConstraintPath = "browserWindowSizeFromArgs(actionArgs, pluginBrowserWindowBounds(existing), existing)";
const geometryActionsSource = await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts");
assert.equal(
  geometryActionsSource.split(browserWindowSizeConstraintPath).length - 1,
  2,
  "setSize and setContentSize should both share hosted size constraint normalization",
);
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `getContentSize\(\)` \/ `setContentSize\(\)`、`getMinimumSize\(\)` \/ `setMinimumSize\(\)`、`getMaximumSize\(\)` \/ `setMaximumSize\(\)`、`setAspectRatio\(\)` 会路由到宿主内 content-size\/min-max\/aspect-ratio state；`setBounds\(\)` \/ `setSize\(\)` \/ `setContentSize\(\)` 共享 hosted size constraint 路径。$/m,
  "macOS smoke checklist should mark BrowserWindow content-size/min-max/aspect-ratio row complete",
);
const browserWindowCapabilityReplaceTarget = "return win.setResizable(false); }).then(function(){ return win.isResizable(); }).then(function(resizable){ document.body.setAttribute('data-browser-window-resizable', String(resizable)); return win.setResizable(true); }).then(function(){ return win.setFullScreen(true); }";
assert.equal(
  appSource.split(browserWindowCapabilityReplaceTarget).length - 1,
  2,
  "browser-window capability smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.setResizable\(/, "browser-window smoke should exercise hosted resizable capability updates");
assert.match(appSource, /win\.isResizable\(/, "browser-window smoke should verify hosted resizable capability state");
assert.match(appSource, /win\.setMovable\(/, "browser-window smoke should exercise hosted movable capability updates");
assert.match(appSource, /win\.isMovable\(/, "browser-window smoke should verify hosted movable capability state");
assert.match(appSource, /win\.setClosable\(/, "browser-window smoke should exercise hosted closable capability updates");
assert.match(appSource, /win\.isClosable\(/, "browser-window smoke should verify hosted closable capability state");
assert.match(appSource, /win\.setMinimizable\(/, "browser-window smoke should exercise hosted minimizable capability updates");
assert.match(appSource, /win\.isMinimizable\(/, "browser-window smoke should verify hosted minimizable capability state");
assert.match(appSource, /win\.setMaximizable\(/, "browser-window smoke should exercise hosted maximizable capability updates");
assert.match(appSource, /win\.isMaximizable\(/, "browser-window smoke should verify hosted maximizable capability state");
assert.match(appSource, /data-browser-window-resizable/, "browser-window smoke should record hosted resizable readback");
assert.match(appSource, /data-browser-window-movable/, "browser-window smoke should record hosted movable readback");
assert.match(appSource, /data-browser-window-closable/, "browser-window smoke should record hosted closable readback");
assert.match(appSource, /data-browser-window-minimizable/, "browser-window smoke should record hosted minimizable readback");
assert.match(appSource, /data-browser-window-maximizable/, "browser-window smoke should record hosted maximizable readback");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /disabled=\{!childWindow\.closable\}/, "browser-window close button should be disabled when hosted closable is false");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /title=\{childWindow\.closable \? "关闭" : "关闭已禁用"\}/, "browser-window close button should expose disabled close state");
const browserWindowFullScreenEventReplaceTarget = "win.once('restore', function(state){ document.body.setAttribute('data-browser-window-event-restore-once', String(state && !state.minimized && !state.maximized)); }); win.on('resize'";
assert.equal(
  appSource.split(browserWindowFullScreenEventReplaceTarget).length - 1,
  2,
  "browser-window full-screen event smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.on\(['"]enter-full-screen/, "browser-window smoke should listen for hosted enter-full-screen events");
assert.match(appSource, /win\.on\(['"]leave-full-screen/, "browser-window smoke should listen for hosted leave-full-screen events");
assert.match(appSource, /data-browser-window-event-enter-full-screen/, "browser-window smoke should record hosted enter-full-screen events");
assert.match(appSource, /data-browser-window-event-leave-full-screen/, "browser-window smoke should record hosted leave-full-screen events");
const browserWindowFullScreenReplaceTarget = "return win.setFullScreen(true); }).then(function(){ return win.isFullScreen(); }).then(function(fullScreen){ document.body.setAttribute('data-browser-window-fullscreen', String(fullScreen)); return win.setFullScreen(false); }";
assert.equal(
  appSource.split(browserWindowFullScreenReplaceTarget).length - 1,
  3,
  "browser-window full-screen smoke replacement should match the srcdoc base string, replace target, and restored replacement tail",
);
assert.match(appSource, /win\.setFullScreen\(/, "browser-window smoke should exercise hosted full-screen state");
assert.match(appSource, /win\.isFullScreen\(/, "browser-window smoke should verify hosted full-screen state");
assert.match(appSource, /win\.setFullScreenable\(/, "browser-window smoke should exercise hosted full-screenable capability updates");
assert.match(appSource, /win\.isFullScreenable\(/, "browser-window smoke should verify hosted full-screenable capability state");
assert.match(appSource, /data-browser-window-fullscreen-blocked/, "browser-window smoke should verify full-screenable false blocks hosted full-screen");
assert.match(appSource, /data-browser-window-fullscreenable-restored/, "browser-window smoke should record restored hosted full-screenable state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `isFullScreen\(\)` \/ `setFullScreen\(\)`、`isFullScreenable\(\)` \/ `setFullScreenable\(\)` 会路由到宿主内 full-screen state；`setFullScreen\(true\)` \/ `setFullScreen\(false\)` 会切换宿主内 full-screen class\/state 并派发 `enter-full-screen` \/ `leave-full-screen`，`fullScreenable:false` 不进入宿主 full-screen。$/m,
  "macOS smoke checklist should mark BrowserWindow full-screen state row complete",
);
const browserWindowOpacityReplaceTarget = "return win.setOpacity(0.72); }).then(function(){ return win.getOpacity(); }).then(function(opacity){ document.body.setAttribute('data-browser-window-opacity', String(opacity === 0.72)); return win.setOpacity(1); }).then(function(){ return win.setHasShadow(false); }";
assert.equal(
  appSource.split(browserWindowOpacityReplaceTarget).length - 1,
  2,
  "browser-window opacity smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.setOpacity\(/, "browser-window smoke should exercise hosted opacity state");
assert.match(appSource, /win\.getOpacity\(/, "browser-window smoke should verify hosted opacity state");
assert.match(appSource, /data-browser-window-opacity-restored/, "browser-window smoke should record restored hosted opacity state");
const browserWindowShadowReplaceTarget = "return win.setHasShadow(false); }).then(function(){ return win.hasShadow(); }).then(function(hasShadow){ document.body.setAttribute('data-browser-window-shadow-disabled', String(!hasShadow)); return win.setHasShadow(true); }).then(function(){ return win.invalidateShadow(); }).then(function(){ return win.setSkipTaskbar(true); }";
assert.equal(
  appSource.split(browserWindowShadowReplaceTarget).length - 1,
  2,
  "browser-window shadow smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /win\.setHasShadow\(/, "browser-window smoke should exercise hosted shadow state");
assert.match(appSource, /win\.hasShadow\(/, "browser-window smoke should verify hosted shadow state");
assert.match(appSource, /win\.invalidateShadow\(/, "browser-window smoke should exercise hosted invalidateShadow state");
assert.match(appSource, /data-browser-window-shadow-restored/, "browser-window smoke should record restored hosted shadow state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /const appearance = childWindow\.opacity < 1 \? ` opacity: \$\{childWindow\.opacity\};` : "";/, "host should only render inline opacity for non-1 child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:noShadow=\{!childWindow\.hasShadow\}/, "host should render noShadow only while hosted shadow is disabled");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `getOpacity\(\)` \/ `setOpacity\(\)`、`hasShadow\(\)` \/ `setHasShadow\(\)` \/ `invalidateShadow\(\)` 会路由到宿主内 appearance state；非 1 opacity 写入宿主内子窗口 inline style，`hasShadow:false` 添加 `noShadow` class，恢复后最终窗口不残留 opacity\/noShadow。$/m,
  "macOS smoke checklist should mark BrowserWindow appearance state row complete",
);
assert.match(appSource, /win\.setSkipTaskbar\(/, "browser-window smoke should exercise hosted skip-taskbar state");
assert.match(appSource, /win\.setKiosk\(/, "browser-window smoke should exercise hosted kiosk state");
assert.match(appSource, /win\.isKiosk\(/, "browser-window smoke should verify hosted kiosk state");
assert.match(appSource, /data-browser-window-kiosk['"]/, "browser-window smoke should record hosted kiosk readback");
assert.match(appSource, /data-browser-window-kiosk-restored/, "browser-window smoke should record restored hosted kiosk state");
assert.match(appSource, /win\.setVisibleOnAllWorkspaces\(/, "browser-window smoke should exercise hosted workspace visibility state");
assert.match(appSource, /win\.isVisibleOnAllWorkspaces\(/, "browser-window smoke should verify hosted workspace visibility state");
assert.match(appSource, /data-browser-window-workspaces/, "browser-window smoke should record hosted workspace visibility state");
assert.match(appSource, /win\.setContentProtection\(/, "browser-window smoke should exercise hosted content protection state");
assert.match(appSource, /win\.isContentProtected\(/, "browser-window smoke should verify hosted content protection state");
assert.match(appSource, /data-browser-window-content-protected/, "browser-window smoke should record hosted content-protection state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setSkipTaskbar\(\)`、`setKiosk\(\)` \/ `isKiosk\(\)`、`setVisibleOnAllWorkspaces\(\)` \/ `isVisibleOnAllWorkspaces\(\)`、`setContentProtection\(\)` \/ `isContentProtected\(\)` 会路由到宿主内 system-state；`kiosk:true` 会填满 hosted layer，恢复后最终窗口不残留 `kiosk` class。$/m,
  "macOS smoke checklist should mark BrowserWindow system-state row complete",
);
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `isResizable\(\)` \/ `setResizable\(\)`、`isMovable\(\)` \/ `setMovable\(\)`、`isClosable\(\)` \/ `setClosable\(\)`、`isMinimizable\(\)` \/ `setMinimizable\(\)`、`isMaximizable\(\)` \/ `setMaximizable\(\)` 会路由到宿主内 capability state；`closable:false` 会禁用宿主内子窗口关闭按钮。$/m,
  "macOS smoke checklist should mark BrowserWindow capability state row complete",
);
assert.match(appSource, /win\.setFocusable\(/, "browser-window smoke should exercise hosted focusable state");
assert.match(appSource, /win\.isFocusable\(/, "browser-window smoke should verify hosted focusable state");
const browserWindowFocusAttentionReplaceTarget = "return win.setFocusable(true); }).then(function(){ return win.flashFrame(true); }).then(function(){ return win.flashFrame(false); }).then(function(){ return win.setProgressBar(0.42, { mode: 'normal' }); }).then(function(){ return win.setProgressBar(-1); }).then(function(){ return win.getMediaSourceId(); }";
assert.equal(
  appSource.split(browserWindowFocusAttentionReplaceTarget).length - 1,
  2,
  "browser-window focus/attention/progress smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-focusable/, "browser-window smoke should record hosted focusable readback");
assert.match(appSource, /data-browser-window-focusable-restored/, "browser-window smoke should record restored hosted focusable state");
assert.match(appSource, /win\.flashFrame\(/, "browser-window smoke should exercise hosted attention state");
assert.match(appSource, /win\.setProgressBar\(/, "browser-window smoke should exercise hosted progress state");
assert.match(appSource, /data-browser-window-attention-progress-state/, "browser-window smoke should record hosted attention/progress state and cleanup");
assert.match(await readPanelHostSource(root, "src/components/PluginPanel.css"), /\.plugin-browser-window\.flashing \{/, "host should style flashing child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /\{#if childWindow\.progressBar !== null \|\| childWindow\.progressBarMode === "indeterminate"\}/, "host should render progress strip while hosted progress state is active");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setFocusable\(\)` \/ `isFocusable\(\)`、`flashFrame\(\)`、`setProgressBar\(\)` 会路由到宿主内 focus\/attention\/progress state；`flashFrame\(true\)` 添加 hosted `flashing` class，`setProgressBar\(\)` 显示 hosted 标题栏进度条，恢复后最终窗口不残留 `flashing` class 或 progress strip。$/m,
  "macOS smoke checklist should mark BrowserWindow focus/attention/progress row complete",
);
const browserWindowMoveTopReplaceTarget = "return win.moveTop(); }).then(function(){ return window.utools.createBrowserWindow('child.html', { title: '置顶参照', show: false }); }";
assert.equal(
  appSource.split(browserWindowMoveTopReplaceTarget).length - 1,
  1,
  "browser-window z-order smoke should retain the moveTop replacement with immediate-handle create semantics",
);
const browserWindowMoveAboveReplaceTarget = "return win.moveAbove(sourceId).then(function(){ return sourceWin.close(); });";
assert.equal(
  appSource.split(browserWindowMoveAboveReplaceTarget).length - 1,
  2,
  "browser-window z-order smoke replacement should match both the srcdoc base string and the moveAbove replace target",
);
assert.match(appSource, /win\.getMediaSourceId\(/, "browser-window smoke should verify hosted media source id");
assert.match(appSource, /win\.moveTop\(/, "browser-window smoke should exercise hosted z-order moveTop");
assert.match(appSource, /win\.moveAbove\(/, "browser-window smoke should exercise hosted z-order moveAbove");
assert.match(appSource, /data-browser-window-media-source-id/, "browser-window smoke should record hosted media source id");
assert.match(appSource, /data-browser-window-source-id/, "browser-window smoke should record temporary hosted source id");
assert.match(appSource, /data-browser-window-z-order-state/, "browser-window smoke should record hosted z-order moveTop/moveAbove state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /return ` z-index: \$\{base \+ childWindow\.zOrder\};`;/, "host should render hosted z-order into child browser-window z-index");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `getMediaSourceId\(\)`、`moveTop\(\)`、`moveAbove\(mediaSourceId\)` 会路由到宿主内 z-order\/media-source state；`moveTop\(\)` \/ `moveAbove\(\)` 更新 hosted z-index，临时参照子窗口关闭后最终只保留主子窗口。$/m,
  "macOS smoke checklist should mark BrowserWindow z-order/media-source row complete",
);
assert.match(appSource, /win\.setAlwaysOnTop\(/, "browser-window smoke should exercise hosted always-on-top state");
assert.match(appSource, /win\.isAlwaysOnTop\(/, "browser-window smoke should verify hosted always-on-top state");
const browserWindowAggregateSmokeChecklistLine = smokeChecklistLineContaining(
  "Web 预览 `?parity=1&pluginHostSmoke=browserWindow` 会自动验证 hosted child sandbox",
);
assert.ok(
  browserWindowAggregateSmokeChecklistLine,
  "macOS smoke checklist should include BrowserWindow aggregate Web preview row",
);

  Object.assign(fixture, {appSource, smokeChecklist, smokeChecklistLineContaining, browserWindowAggregateSmokeChecklistLine});
}
