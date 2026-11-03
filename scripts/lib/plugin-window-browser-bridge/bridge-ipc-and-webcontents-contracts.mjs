import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { root, appSource, bridgeMatch, smokeChecklist } = fixture;
assert.match(appSource, /ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED/, "preview smoke should require the stable isolation error code");
assert.match(appSource, /data-browser-window-isolated-unsupported-complete/, "preview smoke should aggregate unsupported API continuations");
assert.match(appSource, /data-browser-window-smoke-complete/, "preview smoke should expose a final completion marker after unsupported branches continue");
assert.match(appSource, /win\.hide\(\)[\s\S]*win\.show\(\)[\s\S]*win\.focus\(\)/, "browser-window smoke should exercise hosted handle visibility/focus methods");
assert.match(appSource, /win\.setBounds\(/, "browser-window smoke should exercise hosted handle bounds updates");
assert.match(appSource, /win\.getBounds\(/, "browser-window smoke should verify hosted handle bounds");
assert.match(appSource, /win\.webContents\.send\(/, "browser-window smoke should exercise hosted webContents.send");
assert.match(appSource, /data-browser-window-webcontents-send/, "browser-window smoke should record hosted webContents.send accepted state");
assert.match(appSource, /ipcRenderer\.on\(/, "browser-window smoke child should receive hosted webContents.send messages through ipcRenderer.on");
assert.match(appSource, /ipcRenderer\.once\(/, "browser-window smoke child should receive hosted webContents.send messages through ipcRenderer.once");
assert.match(appSource, /data-child-ipc-ping/, "browser-window smoke child should record hosted ipcRenderer.on payloads");
assert.match(appSource, /data-child-ipc-once/, "browser-window smoke child should record hosted ipcRenderer.once payloads");
assert.match(appSource, /data-parent-message-channel/, "browser-window smoke should record child sendToParent callback channel on the parent iframe");
assert.match(appSource, /browser-window-ipc/, "browser-window smoke should route child sendToParent callback through browser-window-ipc channel");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.send\(channel, \.\.\.args\)` 会投递到对应 hosted child iframe；子窗口通过 `require\("electron"\)\.ipcRenderer\.on\(channel, listener\)` \/ `once\(\)` 接收 payload，并可继续用 `sendToParent\(\)` 回调父插件 iframe。$/m,
  "macOS smoke checklist should mark BrowserWindow webContents.send IPC row complete",
);
assert.match(appSource, /win\.webContents\.executeJavaScript\(/, "browser-window smoke should exercise hosted webContents.executeJavaScript");
const browserWindowExecuteJavaScriptReplaceTarget = `return win.webContents.executeJavaScript('document.body.setAttribute(\\"data-execute-js\\", String(21 * 2)); 21 * 2', true); }).then(function(result){ document.body.setAttribute('data-browser-window-execute-js', String(result === 42)); return win.webContents.executeJavaScript('document.getElementById(\\"browser-window-edit-target\\").focus(); true', true); }`;
assert.equal(
  appSource.split(browserWindowExecuteJavaScriptReplaceTarget).length - 1,
  2,
  "browser-window executeJavaScript smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-execute-js/, "browser-window smoke should record hosted webContents.executeJavaScript result");
assert.match(appSource, /data-execute-js/, "browser-window smoke child should record hosted webContents.executeJavaScript side effects");
assert.match(appSource, /data-browser-window-execute-js-error/, "browser-window smoke should record hosted webContents.executeJavaScript method-scoped errors");
assert.match(appSource, /execute-js-smoke/, "browser-window smoke should exercise a thrown child executeJavaScript error");
assert.match(appSource, /message\.indexOf\('webContents\.executeJavaScript'\) >= 0/, "browser-window smoke should require executeJavaScript method context in thrown errors");
assert.match(appSource, /message\.indexOf\('execute-js-smoke'\) >= 0/, "browser-window smoke should require the original thrown script error text");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /webContents\.executeJavaScript failed:/, "host should throw method-scoped executeJavaScript errors");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.executeJavaScript\(code\[, userGesture\]\)` 会在对应 hosted child iframe 中执行脚本，返回脚本结果或明确 method-scoped 错误，不返回静默成功。$/m,
  "macOS smoke checklist should mark BrowserWindow executeJavaScript row complete",
);
assert.match(appSource, /win\.webContents\.sendInputEvent\(/, "browser-window smoke should exercise hosted webContents.sendInputEvent");
const browserWindowSendInputEventReplaceTarget = "return win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter', modifiers: ['shift'] }); }).then(function(inputResult){ document.body.setAttribute('data-browser-window-send-input-event', String(inputResult === undefined)); var findRequestId = win.webContents.findInPage('发送', { matchCase: false }); window.__atoolsBrowserWindowFindRequestId = findRequestId; document.body.setAttribute('data-browser-window-find-in-page', String(findRequestId > 0)); return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }";
assert.equal(
  appSource.split(browserWindowSendInputEventReplaceTarget).length - 1,
  2,
  "browser-window sendInputEvent smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(bridgeMatch[1], /new window\.KeyboardEvent\(/, "opaque child RPC should dispatch hosted keyboard input events in the child realm");
assert.match(bridgeMatch[1], /new window\.MouseEvent\(/, "opaque child RPC should dispatch hosted mouse input events in the child realm");
assert.match(bridgeMatch[1], /new window\.WheelEvent\(/, "opaque child RPC should dispatch hosted wheel input events in the child realm");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /ports\.rpc\.call\(windowId, "sendInputEvent"/, "host should route input through the isolated child RPC");
assert.match(appSource, /data-browser-window-send-input-event-dom/, "browser-window smoke should record keyboard/mouse/wheel DOM input state");
assert.match(appSource, /data-send-input-event-mouse/, "browser-window smoke child should record hosted mouse input events");
assert.match(appSource, /data-send-input-event-wheel/, "browser-window smoke child should record hosted wheel input events");
assert.match(appSource, /data-send-input-event-after-webcontents-reload/, "browser-window smoke child should record input after webContents loadURL/reload");
assert.match(appSource, /data-browser-window-send-input-event-after-webcontents-reload/, "browser-window smoke should verify post-load/reload input does not hit the initial empty document");
const browserWindowPostReloadInputReplaceTarget = "return win.webContents.reload(); }).then(function(webContentsReloadResult){ var stopResult = win.webContents.stop(); document.body.setAttribute('data-browser-window-webcontents-lifecycle', String(webContentsReloadResult && webContentsReloadResult.reloaded === true && stopResult === undefined && !win.webContents.isLoading() && !win.webContents.isLoadingMainFrame() && !win.webContents.isWaitingForResponse() && !win.webContents.isDestroyed() && win.webContents.getType() === 'window')); win.webContents.on('render-process-gone'";
assert.equal(
  appSource.split(browserWindowPostReloadInputReplaceTarget).length - 1,
  2,
  "browser-window post-reload input smoke replacement should match both the inserted lifecycle smoke and the replace target",
);
const browserWindowPostReloadClosureReplaceTarget = "}); var crashResult = win.webContents.forcefullyCrashRenderer(); document.body.setAttribute('data-browser-window-webcontents-crash', String(crashResult === undefined && win.webContents.isCrashed())); return win.webContents.reload(); }).then(function(webContentsCrashReloadResult){";
assert.equal(
  appSource.split(browserWindowPostReloadClosureReplaceTarget).length - 1,
  2,
  "browser-window post-reload input smoke closure replacement should match both the inserted lifecycle smoke and the replace target",
);
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.sendInputEvent\(inputEvent\)` 会在对应 hosted child iframe 中派发兼容 DOM 键盘、鼠标或滚轮事件；`loadURL\(\)` \/ `reload\(\)` 后续 WebContents 动作不应打到初始空文档。$/m,
  "macOS smoke checklist should mark BrowserWindow sendInputEvent row complete",
);
assert.match(appSource, /win\.webContents\.insertCSS\(/, "browser-window smoke should exercise hosted webContents.insertCSS");
assert.match(appSource, /win\.webContents\.removeInsertedCSS\(/, "browser-window smoke should exercise hosted webContents.removeInsertedCSS");
const browserWindowInsertCssReplaceTarget = `return win.webContents.insertCSS('body { --atools-insert-css: inserted; }', { cssOrigin: 'user' }); }).then(function(cssKey){ window.__atoolsBrowserWindowCssKey = cssKey; return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\\"--atools-insert-css\\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css', String(cssValue === 'inserted')); return win.webContents.removeInsertedCSS(window.__atoolsBrowserWindowCssKey); }).then(function(removeCssResult){ document.body.setAttribute('data-browser-window-remove-inserted-css', String(removeCssResult === undefined)); return win.webContents.executeJavaScript('getComputedStyle(document.body).getPropertyValue(\\"--atools-insert-css\\").trim()', true); }).then(function(cssValue){ document.body.setAttribute('data-browser-window-insert-css-removed', String(cssValue === '')); return win.setContentSize(390, 240, true); }`;
assert.equal(
  appSource.split(browserWindowInsertCssReplaceTarget).length - 1,
  2,
  "browser-window insertCSS/removeInsertedCSS smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-css-key/, "browser-window smoke should verify returned hosted insertCSS key shape");
assert.match(
  appSource,
  /\/\^plugin-browser-window-\[0-9\]\+:css:\[0-9\]\+\$\/\.test\(String\(cssKey\)\)/,
  "browser-window smoke should validate the returned hosted insertCSS key shape",
);
assert.match(appSource, /data-browser-window-css-no-residual-style/, "browser-window smoke should verify removeInsertedCSS leaves no keyed style nodes");
assert.match(appSource, /style\[data-atools-browser-window-css-key\]/, "browser-window smoke should inspect keyed inserted stylesheet nodes");
assert.match(appSource, /cssState && cssState\.residual === 0/, "browser-window smoke should require zero residual keyed style nodes after removeInsertedCSS");
assert.match(bridgeMatch[1], /style\.setAttribute\('data-atools-browser-window-css-key', cssKey\)/, "opaque child RPC should tag inserted BrowserWindow CSS with a keyed stylesheet attribute");
assert.match(bridgeMatch[1], /style\.setAttribute\('data-atools-browser-window-css-origin'/, "opaque child RPC should tag inserted BrowserWindow CSS with normalized origin");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /ports\.insertedCss\.set\(key, \{ windowId, key, css, cssOrigin \}\)/, "host should keep a keyed BrowserWindow CSS registry");
assert.match(bridgeMatch[1], /document\.querySelectorAll\('style\[data-atools-browser-window-css-key\]'\)/, "opaque child RPC should remove BrowserWindow CSS by keyed stylesheet selector");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /ports\.insertedCss\.delete\(key\)/, "host should delete keyed BrowserWindow CSS registry entries after removal");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.insertCSS\(css\[, options\]\)` 会向对应 hosted child iframe 注入 keyed stylesheet 并返回 key；`webContents\.removeInsertedCSS\(key\)` 会移除同一 key 的 stylesheet，移除后 child iframe 不残留 injected style。$/m,
  "macOS smoke checklist should mark BrowserWindow insertCSS/removeInsertedCSS row complete",
);
assert.match(appSource, /win\.webContents\.findInPage\(/, "browser-window smoke should exercise hosted webContents.findInPage");
assert.match(appSource, /win\.webContents\.stopFindInPage\(/, "browser-window smoke should exercise hosted webContents.stopFindInPage");
assert.match(appSource, /win\.webContents\.on\(['"]found-in-page/, "browser-window smoke should exercise hosted webContents found-in-page events");
const browserWindowFindInPageListenerReplaceTarget = "win.webContents.on('found-in-page', function(_event, result){ document.body.setAttribute('data-browser-window-found-in-page', String(result && result.matches >= 1 && result.finalUpdate === true)); document.body.setAttribute('data-browser-window-found-request', String(result && result.requestId === window.__atoolsBrowserWindowFindRequestId)); win.webContents.stopFindInPage('clearSelection'); document.body.setAttribute('data-browser-window-stop-find-in-page', 'true'); }); win.webContents.on('devtools-opened'";
assert.equal(
  appSource.split(browserWindowFindInPageListenerReplaceTarget).length - 1,
  2,
  "browser-window findInPage smoke listener replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-find-in-page/, "browser-window smoke should record synchronous findInPage request id");
assert.match(appSource, /result && result\.matches >= 1 && result\.finalUpdate === true/, "browser-window smoke should verify final found-in-page match result");
assert.match(appSource, /result && result\.requestId === window\.__atoolsBrowserWindowFindRequestId/, "browser-window smoke should verify found-in-page event is targeted to the request id");
assert.match(appSource, /var stopFindResult = win\.webContents\.stopFindInPage\('clearSelection'\)/, "browser-window smoke should capture stopFindInPage return shape");
assert.match(appSource, /data-browser-window-stop-find-in-page', String\(stopFindResult === undefined\)/, "browser-window smoke should verify stopFindInPage void-return shape");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /ports\.dispatchWebContentsEvent\(windowId, "found-in-page", \[result\]\)/, "host should dispatch targeted BrowserWindow found-in-page events");
assert.match(bridgeMatch[1], /activeMatchOrdinal: matches <= 0 \? 0 : \(forward \? 1 : matches\)/, "opaque child RPC should compute BrowserWindow found-in-page active match ordinal");
assert.match(bridgeMatch[1], /finalUpdate: true/, "opaque child RPC should mark BrowserWindow found-in-page result as final");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /ports\.lastMessage = \{ windowId, channel: "webContents:stopFindInPage", args: \[action\] \}/, "host should route BrowserWindow stopFindInPage to the targeted child window");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /ports\.rpc\.call\(windowId, "stopFindInPage", \{ action \}\)/, "host should clear selection only through the isolated child RPC");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginBrowserWindowFrameCommands.ts", "src/lib/pluginBrowserWindowWebContentsController.ts", "src/lib/pluginPanelDocumentSourceHost.ts"]), /frame\.contentWindow[^\n;]*getSelection/, "host must not read an isolated child selection directly");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.findInPage\(text\[, options\]\)` 会同步返回 request id，并通过 `webContents\.on\("found-in-page", listener\)` 向父插件派发 targeted 查找结果；`webContents\.stopFindInPage\(action\)` 会路由到同一 hosted child iframe 且保持 void-return shape。$/m,
  "macOS smoke checklist should mark BrowserWindow findInPage/stopFindInPage row complete",
);
assert.match(appSource, /win\.webContents\.getURL\(\)/, "browser-window smoke should exercise hosted webContents.getURL");
assert.match(appSource, /win\.webContents\.loadURL\(/, "browser-window smoke should exercise hosted webContents.loadURL");
assert.match(appSource, /win\.webContents\.reload\(\)/, "browser-window smoke should exercise hosted webContents.reload");
assert.match(appSource, /win\.webContents\.stop\(\)/, "browser-window smoke should exercise hosted webContents.stop");
assert.match(appSource, /win\.webContents\.isDestroyed\(\)/, "browser-window smoke should verify hosted webContents destroyed state");
assert.match(appSource, /win\.webContents\.isWaitingForResponse\(\)/, "browser-window smoke should verify hosted webContents waiting-for-response state");
assert.match(appSource, /data-browser-window-webcontents-waiting-response/, "browser-window smoke should record hosted WebContents waiting-for-response state");
assert.match(appSource, /win\.webContents\.getType\(\)/, "browser-window smoke should verify hosted webContents type");
assert.match(appSource, /win\.webContents\.isCrashed\(\)/, "browser-window smoke should verify hosted webContents crash state");
assert.match(appSource, /win\.webContents\.forcefullyCrashRenderer\(\)/, "browser-window smoke should exercise hosted webContents.forcefullyCrashRenderer");
assert.match(appSource, /data-browser-window-render-process-gone/, "browser-window smoke should verify hosted render-process-gone event");
assert.match(appSource, /win\.webContents\.focus\(\)/, "browser-window smoke should exercise hosted webContents.focus");
assert.match(appSource, /win\.webContents\.isFocused\(\)/, "browser-window smoke should verify hosted webContents focus state");
assert.match(appSource, /win\.webContents\.getOwnerBrowserWindow\(\)/, "browser-window smoke should verify hosted webContents owner window");
assert.match(appSource, /win\.webContents\.getMediaSourceId\(\)/, "browser-window smoke should verify hosted webContents media source id");
assert.match(appSource, /win\.webContents\.isBeingCaptured\(\)/, "browser-window smoke should verify hosted webContents capture state");
assert.match(appSource, /win\.webContents\.setIgnoreMenuShortcuts\(/, "browser-window smoke should exercise hosted webContents menu shortcut state");
assert.match(appSource, /data-browser-window-webcontents-focus-state/, "browser-window smoke should record hosted webContents focus state");
assert.match(appSource, /data-browser-window-webcontents-owner-media/, "browser-window smoke should record hosted webContents owner/media state");
assert.match(appSource, /win\.webContents\.reloadIgnoringCache\(\)/, "browser-window smoke should exercise hosted webContents.reloadIgnoringCache");
assert.match(appSource, /win\.webContents\.goBack\(\)/, "browser-window smoke should exercise hosted webContents.goBack");
assert.match(appSource, /win\.webContents\.goForward\(\)/, "browser-window smoke should exercise hosted webContents.goForward");
const browserWindowNavigationStateReplaceTarget = "return win.loadURL('child-reloaded.html'); }).then(function(){ return win.getURL(); }).then(function(url){ document.body.setAttribute('data-browser-window-url', url); document.body.setAttribute('data-browser-window-webcontents-url', win.webContents.getURL()); document.body.setAttribute('data-browser-window-webcontents-title', win.webContents.getTitle()); document.body.setAttribute('data-browser-window-webcontents-loading', String(!win.webContents.isLoading() && !win.webContents.isLoadingMainFrame())); document.body.setAttribute('data-browser-window-can-go-back', String(win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.reloadIgnoringCache(); }).then(function(reloadIgnoringCacheResult){ document.body.setAttribute('data-browser-window-reload-ignoring-cache', String(reloadIgnoringCacheResult && reloadIgnoringCacheResult.ignoreCache === true)); return win.webContents.goBack(); }).then(function(backResult){ document.body.setAttribute('data-browser-window-go-back', String(backResult && backResult.url === 'child.html' && !win.webContents.canGoBack() && win.webContents.canGoForward())); return win.webContents.goForward(); }).then(function(forwardResult){ document.body.setAttribute('data-browser-window-go-forward', String(forwardResult && forwardResult.url === 'child-reloaded.html' && win.webContents.canGoBack() && !win.webContents.canGoForward())); return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }";
assert.equal(
  appSource.split(browserWindowNavigationStateReplaceTarget).length - 1,
  2,
  "browser-window navigation smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-navigation-sync-state/, "browser-window smoke should record hosted navigation sync state");
assert.match(appSource, /navigationInitialOk/, "browser-window smoke should verify initial hosted navigation getters");
assert.match(appSource, /reloadNavigationOk/, "browser-window smoke should verify reloadIgnoringCache keeps hosted navigation state synchronized");
assert.match(appSource, /backNavigationOk/, "browser-window smoke should verify goBack synchronizes hosted history state");
assert.match(appSource, /forwardNavigationOk/, "browser-window smoke should verify goForward synchronizes hosted history state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts"), /function syncWebContentsNavigationState\(result, options\)/, "bridge should synchronize hosted WebContents navigation state into the handle cache");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /webContentsUrl = nextUrl;/, "bridge should update cached hosted WebContents URL");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /webContentsTitle = nextTitle;/, "bridge should update cached hosted WebContents title");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /webContentsLoading = record\.loading === true;/, "bridge should update cached hosted WebContents loading state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /if \(Number\.isInteger\(record\.historyIndex\)\) webContentsHistoryIndex = record\.historyIndex;/, "bridge should synchronize hosted WebContents history index");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /return ports\.navigateHistoryToIndex\(existing, existing\.historyIndex - 1, "webContents\.navigationHistory\.goBack"\);/, "host should route webContents.goBack through hosted history");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /return ports\.navigateHistoryToIndex\(existing, existing\.historyIndex \+ 1, "webContents\.navigationHistory\.goForward"\);/, "host should route webContents.goForward through hosted history");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.getURL\(\)` \/ `getTitle\(\)` \/ `isLoading\(\)` \/ `isLoadingMainFrame\(\)` \/ `canGoBack\(\)` \/ `canGoForward\(\)` 会读取 hosted child iframe 导航状态；`webContents\.reloadIgnoringCache\(\)` \/ `goBack\(\)` \/ `goForward\(\)` 会路由到同一 hosted history，back\/forward 后 sync 状态同步更新。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents navigation state row complete",
);
assert.match(appSource, /win\.webContents\.loadURL\(/, "browser-window smoke should exercise hosted webContents.loadURL");
assert.match(appSource, /win\.webContents\.reload\(\)/, "browser-window smoke should exercise hosted webContents.reload");
assert.match(appSource, /win\.webContents\.stop\(\)/, "browser-window smoke should exercise hosted webContents.stop");
assert.match(appSource, /win\.webContents\.isDestroyed\(\)/, "browser-window smoke should verify hosted webContents destroyed state");
assert.match(appSource, /win\.webContents\.getType\(\)/, "browser-window smoke should verify hosted webContents type");
const browserWindowWebContentsLifecycleReplaceTarget = "win.webContents.setZoomFactor(1.5); document.body.setAttribute('data-browser-window-zoom-factor'";
assert.equal(
  appSource.split(browserWindowWebContentsLifecycleReplaceTarget).length - 1,
  3,
  "browser-window WebContents lifecycle smoke replacement should match the srcdoc base string, replace target, and replacement output",
);
assert.match(appSource, /data-browser-window-webcontents-load-url/, "browser-window smoke should record hosted webContents.loadURL state");
assert.match(appSource, /data-browser-window-webcontents-lifecycle/, "browser-window smoke should record hosted webContents lifecycle state");
assert.match(appSource, /webContentsLoadResult && webContentsLoadResult\.url === 'child-webcontents\.html'/, "browser-window smoke should verify hosted webContents.loadURL result and URL cache");
assert.match(appSource, /webContentsReloadResult && webContentsReloadResult\.reloaded === true/, "browser-window smoke should verify hosted webContents.reload result");
assert.match(appSource, /stopResult === undefined && !win\.webContents\.isLoading\(\) && !win\.webContents\.isLoadingMainFrame\(\)/, "browser-window smoke should verify webContents.stop clears hosted loading state");
assert.match(appSource, /!win\.webContents\.isDestroyed\(\) && win\.webContents\.getType\(\) === 'window'/, "browser-window smoke should verify hosted WebContents type and live destroyed state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /loadURL: function\(url, options\) \{ return webContentsNavigationAction\('webContents\.loadURL', String\(url \|\| ''\), options \|\| \{\}\); \}/, "bridge should route webContents.loadURL through hosted navigation state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /reload: function\(\) \{ return webContentsNavigationAction\('webContents\.reload'\); \}/, "bridge should route webContents.reload through hosted navigation state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsStop\(\) \{\n      webContentsLoading = false;/, "bridge should synchronously clear hosted loading state on stop");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isDestroyed: function\(\) \{ return destroyed; \}/, "bridge should expose hosted WebContents destroyed state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getType: function\(\) \{ return 'window'; \}/, "bridge should expose hosted WebContents type");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /return ports\.loadUrl\(existing, String\(actionArgs\[0\] \?\? ""\), false\);/, "host should route webContents.loadURL to hosted child iframe navigation");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /return ports\.loadUrl\(existing, existing\.url, true\);/, "host should route webContents.reload to hosted child iframe navigation");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /return ports\.webContents\.stopPluginBrowserWindowLoading\(id\);/, "host should route webContents.stop to hosted loading state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.loadURL\(url\[, options\]\)` \/ `reload\(\)` \/ `stop\(\)` \/ `isDestroyed\(\)` \/ `getType\(\)` 会路由到 hosted child iframe navigation\/lifecycle state；`loadURL\(\)` \/ `reload\(\)` 更新 hosted URL\/title\/history\/loading state，`stop\(\)` 保持 void-return shape 并同步清理 hosted loading\/loading-main-frame，`isDestroyed\(\)` 随 hosted close\/closed event 更新，`getType\(\)` 在当前宿主内返回 `"window"`。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents lifecycle row complete",
);
assert.match(appSource, /data-browser-window-render-process-gone/, "browser-window smoke should record targeted render-process-gone event state");
assert.match(appSource, /data-browser-window-webcontents-crash/, "browser-window smoke should record hosted crash state");
assert.match(appSource, /data-browser-window-webcontents-crash-reload/, "browser-window smoke should record hosted crash reload recovery state");
assert.match(appSource, /details && details\.reason === 'crashed' && details\.exitCode === 1/, "browser-window smoke should verify render-process-gone crash details");
assert.match(appSource, /crashResult === undefined && win\.webContents\.isCrashed\(\)/, "browser-window smoke should verify forcefullyCrashRenderer keeps void-return and sync crash state");
assert.match(appSource, /webContentsCrashReloadResult && webContentsCrashReloadResult\.reloaded === true && !win\.webContents\.isCrashed\(\)/, "browser-window smoke should verify reload clears hosted crash state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function syncWebContentsCrashEvent\(name\) \{\n      if \(String\(name \|\| ''\) === 'render-process-gone'\) webContentsCrashed = true;/, "bridge should update hosted crash cache from targeted render-process-gone events");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsForcefullyCrashRenderer\(\) \{\n      webContentsCrashed = true;/, "bridge should synchronously mark hosted WebContents crashed before the host responds");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /forcefullyCrashRenderer: function\(\) \{ return webContentsForcefullyCrashRenderer\(\); \}/, "bridge should expose forcefullyCrashRenderer on hosted WebContents");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function forcefullyCrashPluginBrowserWindowRenderer\(id: string\)/, "host should implement hosted WebContents crash lifecycle");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /const details = \{ reason: "crashed", exitCode: 1 \};/, "host should use explicit hosted crash details");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /updatedWindow = \{ \.\.\.childWindow, loading: false, crashed: true \};/, "host should mark hosted child iframe crashed and stop loading");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /dispatchPluginBrowserWindowWebContentsEvent\(id, "render-process-gone", \[details\]\)/, "host should dispatch targeted render-process-gone for forcefullyCrashRenderer");
assert.match(
  await readPanelHostSource(root, "src/lib/pluginBrowserWindowNavigationLoader.ts"),
  /url: nextUrl,\n\s+title,\n\s+srcdoc,\n\s+documentGeneration: navigationToken,\n\s+visible: true,\n\s+loading: true,\n\s+crashed: false,\n\s+\.\.\.nextHistory,/,
  "host loadURL should use its reserved navigation token as the document generation and clear hosted crash state",
);
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowNavigationLoader.ts"), /updatedWindow = \{ \.\.\.childWindow, title: finalTitle, loading: false, crashed: false \};/, "host reload should clear hosted crash state after the child iframe is ready");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.isCrashed\(\)` \/ `forcefullyCrashRenderer\(\)` 会路由到 hosted child iframe crash lifecycle state；`forcefullyCrashRenderer\(\)` 保持 void-return shape，同步标记 hosted crashed state，并向父插件派发 targeted `render-process-gone` 事件，随后 `reload\(\)` \/ `loadURL\(\)` \/ history navigation 会清理 hosted crashed state。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents crash lifecycle row complete",
);
assert.match(appSource, /var focusResult = win\.webContents\.focus\(\);/, "browser-window smoke should exercise hosted webContents.focus");
assert.match(appSource, /var ignoreMenuShortcutsResult = win\.webContents\.setIgnoreMenuShortcuts\(true\);/, "browser-window smoke should exercise hosted webContents.setIgnoreMenuShortcuts");
assert.match(appSource, /focusResult === undefined && win\.webContents\.isFocused\(\)/, "browser-window smoke should verify focus keeps void-return shape and sync getter state");
assert.match(appSource, /win\.webContents\.getOwnerBrowserWindow\(\) === win && \/\^web-contents:\[0-9\]\+:0\$\/\.test\(win\.webContents\.getMediaSourceId\(\)\) && win\.webContents\.isBeingCaptured\(\) === false && ignoreMenuShortcutsResult === undefined/, "browser-window smoke should verify owner handle, hosted media source id, capture state, and shortcut void-return");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts"), /var webContentsMediaSourceId = typeof record\.webContentsMediaSourceId === 'string' && record\.webContentsMediaSourceId/, "bridge should initialize hosted WebContents media source id from host state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts"), /var webContentsFocused = record\.webContentsFocused === true \|\| record\.focused === true;/, "bridge should initialize hosted WebContents focus cache");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsFocus\(\) \{\n      webContentsFocused = true;/, "bridge should synchronously update hosted WebContents focus cache");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsSetIgnoreMenuShortcuts\(ignore\) \{\n      var nextIgnore = ignore === true;\n      webContentsIgnoreMenuShortcuts = nextIgnore;/, "bridge should synchronously update hosted WebContents shortcut cache");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /focus: function\(\) \{ return webContentsFocus\(\); \}/, "bridge should expose hosted webContents.focus");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isFocused: function\(\) \{ return webContentsFocused; \}/, "bridge should expose hosted webContents.isFocused");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getOwnerBrowserWindow: function\(\) \{ return handle; \}/, "bridge should return the hosted BrowserWindow handle as webContents owner");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getMediaSourceId: function\(\) \{ return webContentsMediaSourceId; \}/, "bridge should expose hosted WebContents media source id");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isBeingCaptured: function\(\) \{ return webContentsBeingCaptured; \}/, "bridge should expose hosted WebContents capture state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /setIgnoreMenuShortcuts: function\(ignore\) \{ return webContentsSetIgnoreMenuShortcuts\(ignore\); \}/, "bridge should expose hosted webContents.setIgnoreMenuShortcuts");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function focusPluginBrowserWindowWebContents\(id: string\)/, "host should implement hosted WebContents focus action");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /updatedWindow = \{ \.\.\.childWindow, visible: true, focused, webContentsFocused: focused \};/, "host focus should update hosted child iframe focus state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /dispatchPluginBrowserWindowEvent\(id, "focus", \[\{ visible: true, focused, closed: false \}\]\);/, "host focus should dispatch hosted focus event state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function setPluginBrowserWindowIgnoreMenuShortcuts\(id: string, value: unknown\)/, "host should implement hosted WebContents shortcut action");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /const ignoreMenuShortcuts = value === true;/, "host should normalize hosted ignore-menu-shortcuts state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /ports\.lastMessage = \{ windowId: id, channel: \"webContents:setIgnoreMenuShortcuts\", args: \[ignoreMenuShortcuts\] \}/, "host should record hosted ignore-menu-shortcuts action");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.focus\(\)` \/ `isFocused\(\)` \/ `getOwnerBrowserWindow\(\)` \/ `getMediaSourceId\(\)` \/ `isBeingCaptured\(\)` \/ `setIgnoreMenuShortcuts\(ignore\)` 会路由到 hosted child iframe focus\/owner\/media\/shortcut state；`focus\(\)` \/ `setIgnoreMenuShortcuts\(\)` 保持 void-return shape，sync getter 立即可读，owner 返回当前 hosted BrowserWindow handle，media source id 为 hosted compatibility id。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents focus/owner/media/shortcut row complete",
);
assert.match(appSource, /win\.webContents\.navigationHistory\.goToOffset\(/, "browser-window smoke should exercise hosted webContents.navigationHistory.goToOffset");
assert.match(appSource, /win\.webContents\.navigationHistory\.goForward\(\)/, "browser-window smoke should exercise hosted webContents.navigationHistory.goForward");
assert.match(appSource, /win\.webContents\.navigationHistory\.clear\(\)/, "browser-window smoke should exercise hosted webContents.navigationHistory.clear");
assert.match(appSource, /data-browser-window-navigation-history/, "browser-window smoke should record hosted webContents navigationHistory state");
assert.match(appSource, /navigationOffsetResult === undefined && navigationForwardResult === undefined && navigationClearResult === undefined/, "browser-window smoke should verify navigationHistory actions keep void-return shape");
assert.match(appSource, /navigationOffsetOk && navigationForwardOk && !win\.webContents\.navigationHistory\.canGoBack\(\) && !win\.webContents\.navigationHistory\.canGoForward\(\)/, "browser-window smoke should verify navigationHistory can-go state and clear collapse");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /var navigationHistory = \{\n      canGoBack: function\(\) \{ return webContentsHistoryIndex > 0; \},\n      canGoForward: function\(\) \{ return webContentsHistoryIndex >= 0 && webContentsHistoryIndex < webContentsHistory\.length - 1; \},/, "bridge should expose synchronous navigationHistory can-go getters");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /goBack: function\(\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goBack'\); \},/, "bridge should route navigationHistory.goBack through hosted history action");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /goForward: function\(\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goForward'\); \},/, "bridge should route navigationHistory.goForward through hosted history action");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /goToIndex: function\(index\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goToIndex', navigationHistoryIndex\(index\)\); \},/, "bridge should normalize and route navigationHistory.goToIndex");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /canGoToOffset: function\(offset\) \{ return navigationHistoryCanGoToOffset\(offset\); \},/, "bridge should expose synchronous navigationHistory.canGoToOffset");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /goToOffset: function\(offset\) \{ return navigationHistoryAction\('webContents\.navigationHistory\.goToOffset', navigationHistoryOffset\(offset\)\); \},/, "bridge should normalize and route navigationHistory.goToOffset");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /clear: function\(\) \{ return navigationHistoryClear\(\); \},/, "bridge should expose navigationHistory.clear");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function navigationHistoryClear\(\) \{\n      if \(webContentsUrl\) \{\n        webContentsHistory = \[webContentsUrl\];\n        webContentsHistoryIndex = 0;/, "bridge should synchronously collapse hosted history during navigationHistory.clear");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function navigatePluginBrowserWindowHistoryToIndex\(\n    existing: PluginBrowserWindowState,\n    nextIndex: number,\n    label: string\n  \)/, "host should implement navigationHistory index routing");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /updatedWindow = \{ \.\.\.childWindow, title: finalTitle, history, loading: false, crashed: false \};/, "host should finish navigationHistory navigation with synced title, history, loading, and crash state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function clearPluginBrowserWindowNavigationHistory\(id: string\)/, "host should implement navigationHistory.clear routing");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /history: \[currentEntry\],\n        historyIndex: 0,\n        loading: false,\n        crashed: false,/, "host navigationHistory.clear should collapse hosted history to current entry");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.navigationHistory\.goBack"\)/, "host should route navigationHistory.goBack actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.navigationHistory\.goForward"\)/, "host should route navigationHistory.goForward actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.navigationHistory\.goToIndex"\)/, "host should route navigationHistory.goToIndex actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.navigationHistory\.goToOffset"\)/, "host should route navigationHistory.goToOffset actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.navigationHistory\.clear"\)/, "host should route navigationHistory.clear actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.navigationHistory\.canGoBack\(\)` \/ `canGoForward\(\)` \/ `goBack\(\)` \/ `goForward\(\)` \/ `goToIndex\(index\)` \/ `canGoToOffset\(offset\)` \/ `goToOffset\(offset\)` \/ `clear\(\)` 会路由到 hosted child iframe navigation history state；动作方法保持 void-return shape，sync getter 立即可读，`clear\(\)` 会把 hosted history 折叠到当前 entry。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents navigationHistory row complete",
);
assert.match(appSource, /var webContentsWaitingResponsePromise = win\.webContents\.loadURL\('child-webcontents\.html', \{ userAgent: 'AToolsWebContentsSmoke\/240' \}\);/, "browser-window smoke should start a hosted loadURL waiting-response probe");
assert.match(appSource, /window\.__atoolsBrowserWindowWaitingDuringLoad = win\.webContents\.isWaitingForResponse\(\);/, "browser-window smoke should read waiting-response while hosted loadURL is pending");
assert.match(appSource, /data-browser-window-webcontents-waiting-response', String\(window\.__atoolsBrowserWindowWaitingDuringLoad === true && win\.webContents\.isWaitingForResponse\(\) === false\)/, "browser-window smoke should record pending true and completed false waiting-response state");
assert.match(appSource, /!win\.webContents\.isWaitingForResponse\(\) && !win\.webContents\.isDestroyed\(\) && win\.webContents\.getType\(\) === 'window'/, "browser-window lifecycle smoke should verify stop clears waiting-response state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function navigationHistoryAction\(action\) \{/, "bridge should synchronously mark hosted WebContents waiting while navigation is pending");

  Object.assign(fixture, {appSource, bridgeMatch, smokeChecklist});
}
