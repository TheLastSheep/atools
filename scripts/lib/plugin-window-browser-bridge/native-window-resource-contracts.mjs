import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { root, appSource, bridgeTestSource, smokeChecklist, smokeChecklistLineContaining, uiRestoreChecklist } = fixture;
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContentsLoading = false;\n        return syncWebContentsNavigationState\(result, \{ push: action === 'loadURL' \|\| action === 'webContents\.loadURL' \}\);/, "bridge should clear hosted waiting before applying completed navigation state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContentsLoading = false;\n        throw err;/, "bridge should clear hosted waiting when navigation rejects");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /webContentsLoading = record\.loading === true;/, "bridge should sync hosted waiting from host navigation result");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isWaitingForResponse: function\(\) \{ return webContentsLoading; \}/, "bridge should expose isWaitingForResponse from hosted loading cache");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsStop\(\) \{\n      webContentsLoading = false;/, "bridge should synchronously clear hosted waiting on stop");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /return ports\.webContents\.stopPluginBrowserWindowLoading\(id\);/, "host should route webContents.stop to hosted loading cleanup");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.isWaitingForResponse\(\)` 会读取 hosted child iframe waiting-response state；`loadURL\(\)` pending 期间可同步读到 true，hosted response 完成、`stop\(\)` 或 lifecycle 清理后应回到 false。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents waiting-response row complete",
);
assert.match(appSource, /return win\.webContents\.insertText\('hosted edit'\);/, "browser-window smoke should insert hosted text into the focused child editable target");
assert.match(appSource, /data-browser-window-insert-text', String\(insertTextResult === undefined\)/, "browser-window smoke should verify insertText resolves with undefined");
assert.match(appSource, /var selectAllResult = win\.webContents\.selectAll\(\); var copyResult = win\.webContents\.copy\(\); var cutResult = win\.webContents\.cut\(\); var pasteResult = win\.webContents\.paste\(\);/, "browser-window smoke should exercise hosted selection and edit clipboard commands");
assert.match(appSource, /data-browser-window-edit-commands', String\(selectAllResult === undefined && copyResult === undefined && cutResult === undefined && pasteResult === undefined\)/, "browser-window smoke should verify hosted editing commands preserve void-return shape");
assert.match(appSource, /data-browser-window-edit-value', String\(editValue === 'hosted edit'\)/, "browser-window smoke should verify hosted edit clipboard restores the child editable value");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /insertText: function\(text\) \{ return webContentsInsertText\(text\); \}/, "bridge should expose webContents.insertText");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /undo: function\(\) \{ return webContentsEditAction\('webContents\.undo'\); \}/, "bridge should expose webContents.undo");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /redo: function\(\) \{ return webContentsEditAction\('webContents\.redo'\); \}/, "bridge should expose webContents.redo");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /cut: function\(\) \{ return webContentsEditAction\('webContents\.cut'\); \}/, "bridge should expose webContents.cut");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /copy: function\(\) \{ return webContentsEditAction\('webContents\.copy'\); \}/, "bridge should expose webContents.copy");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /paste: function\(\) \{ return webContentsEditAction\('webContents\.paste'\); \}/, "bridge should expose webContents.paste");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /pasteAndMatchStyle: function\(\) \{ return webContentsEditAction\('webContents\.pasteAndMatchStyle'\); \}/, "bridge should expose webContents.pasteAndMatchStyle");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /delete: function\(\) \{ return webContentsEditAction\('webContents\.delete'\); \}/, "bridge should expose webContents.delete");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /selectAll: function\(\) \{ return webContentsEditAction\('webContents\.selectAll'\); \}/, "bridge should expose webContents.selectAll");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /unselect: function\(\) \{ return webContentsEditAction\('webContents\.unselect'\); \}/, "bridge should expose webContents.unselect");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /replace: function\(text\) \{ return webContentsEditAction\('webContents\.replace', String\(text == null \? '' : text\)\); \}/, "bridge should expose webContents.replace");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /replaceMisspelling: function\(text\) \{ return webContentsEditAction\('webContents\.replaceMisspelling', String\(text == null \? '' : text\)\); \}/, "bridge should expose webContents.replaceMisspelling");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /async function editPluginBrowserWindowText\(windowId: string, actionName: string, args: unknown\[\]\)/, "host should preserve the public editing action route");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /async function editPluginBrowserWindowText[\s\S]*?throw hostedBrowserWindowUnsupported\(actionName\);/, "isolated hosted BrowserWindow editing must reject explicitly instead of touching child DOM");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginBrowserWindowFrameCommands.ts", "src/lib/pluginBrowserWindowWebContentsController.ts", "src/lib/pluginBrowserWindowActionDispatcher.ts"]), /function editPluginBrowserWindowTextCommand\(|pluginBrowserWindowEditClipboard/, "host must not retain direct child editing or clipboard machinery");
assert.match(appSource, /var centerSelectionResult = win\.webContents\.centerSelection\(\); var adjustSelectionResult = win\.webContents\.adjustSelection\(\{ start: 1, end: -1 \}\); var scrollBottomResult = win\.webContents\.scrollToBottom\(\); var scrollTopResult = win\.webContents\.scrollToTop\(\);/, "browser-window smoke should exercise hosted selection and scroll commands together");
assert.match(appSource, /data-browser-window-selection-scroll-commands', String\(centerSelectionResult === undefined && adjustSelectionResult === undefined && scrollBottomResult === undefined && scrollTopResult === undefined\)/, "browser-window smoke should verify selection and scroll commands preserve void-return shape");
assert.match(appSource, /data-browser-window-adjust-selection', String\(selectionScrollState && selectionScrollState\.start === 1 && selectionScrollState\.end === 10\)/, "browser-window smoke should verify adjustSelection updates focused input selection deterministically");
assert.match(appSource, /data-browser-window-scroll-top', String\(selectionScrollState && selectionScrollState\.scrollTop === 0\)/, "browser-window smoke should verify scrollToTop resets the hosted child document scroll position");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /centerSelection: function\(\) \{ return webContentsEditAction\('webContents\.centerSelection'\); \}/, "bridge should expose webContents.centerSelection");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /scrollToTop: function\(\) \{ return webContentsEditAction\('webContents\.scrollToTop'\); \}/, "bridge should expose webContents.scrollToTop");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /scrollToBottom: function\(\) \{ return webContentsEditAction\('webContents\.scrollToBottom'\); \}/, "bridge should expose webContents.scrollToBottom");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /adjustSelection: function\(options\) {\n        var selectionOptions = options && typeof options === 'object' && !Array\.isArray\(options\) \? options : {};\n        return webContentsEditAction\('webContents\.adjustSelection', {\n          start: Number\(selectionOptions\.start \|\| 0\),\n          end: Number\(selectionOptions\.end \|\| 0\),\n        }\);/, "bridge should normalize and expose webContents.adjustSelection");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /async function controlPluginBrowserWindowSelection\(windowId: string, actionName: string, args: unknown\[\]\)/, "host should route BrowserWindow WebContents selection and scroll actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /async function controlPluginBrowserWindowSelection[\s\S]*?throw hostedBrowserWindowUnsupported\(actionName\);/, "isolated hosted BrowserWindow selection commands must reject explicitly");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginBrowserWindowFrameCommands.ts", "src/lib/pluginBrowserWindowWebContentsController.ts"]), /function scrollPluginBrowserWindowDocument\(|function centerPluginBrowserWindowSelection\(|function adjustPluginBrowserWindowSelectionRange\(/, "host must not retain direct child selection or scrolling machinery");
assert.match(appSource, /win\.webContents\.setZoomFactor\(1\.5\); document\.body\.setAttribute\('data-browser-window-zoom-factor', String\(win\.webContents\.getZoomFactor\(\) === 1\.5 && Math\.abs\(win\.webContents\.getZoomLevel\(\) - 2\.224\) < 0\.01\)\);/, "browser-window smoke should verify setZoomFactor updates sync factor and level getters");
assert.match(appSource, /win\.webContents\.setZoomLevel\(-1\); document\.body\.setAttribute\('data-browser-window-zoom-level', String\(win\.webContents\.getZoomLevel\(\) === -1 && Math\.abs\(win\.webContents\.getZoomFactor\(\) - 0\.8333333333333334\) < 0\.001\)\);/, "browser-window smoke should verify setZoomLevel updates sync level and factor getters");
assert.match(appSource, /return win\.webContents\.setVisualZoomLevelLimits\(0\.5, 3\); }\)\.then\(function\(visualZoomLimits\)\{ document\.body\.setAttribute\('data-browser-window-visual-zoom-limits', String\(visualZoomLimits === undefined\)\);/, "browser-window smoke should verify setVisualZoomLevelLimits resolves with undefined");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function zoomLevelFromFactor\(factor\) {\n      return Math\.log\(factor\) \/ Math\.log\(1\.2\);/, "bridge should derive hosted zoom level from zoom factor");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function zoomFactorFromLevel\(level\) {\n      return Math\.pow\(1\.2, level\);/, "bridge should derive hosted zoom factor from zoom level");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function normalizeZoomFactor\(value\) {\n      var factor = Number\(value\);\n      if \(!Number\.isFinite\(factor\) \|\| factor <= 0\) {\n        throw new Error\('webContents\.setZoomFactor requires a factor greater than 0'\);/, "bridge should validate positive finite zoom factors");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function normalizeZoomLevel\(value\) {\n      var level = Number\(value\);\n      if \(!Number\.isFinite\(level\)\) {\n        throw new Error\('webContents\.setZoomLevel requires a finite level'\);/, "bridge should validate finite zoom levels");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsSetZoomFactor\(factorValue\) {\n      var factor = normalizeZoomFactor\(factorValue\);\n      webContentsZoomFactor = factor;\n      webContentsZoomLevel = zoomLevelFromFactor\(factor\);/, "bridge should synchronously update zoom factor and level before host response");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsSetZoomLevel\(levelValue\) {\n      var level = normalizeZoomLevel\(levelValue\);\n      webContentsZoomLevel = level;\n      webContentsZoomFactor = zoomFactorFromLevel\(level\);/, "bridge should synchronously update zoom level and factor before host response");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /setZoomFactor: function\(factor\) \{ return webContentsSetZoomFactor\(factor\); \}/, "bridge should expose webContents.setZoomFactor");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getZoomFactor: function\(\) \{ return webContentsZoomFactor; \}/, "bridge should expose webContents.getZoomFactor");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /setZoomLevel: function\(level\) \{ return webContentsSetZoomLevel\(level\); \}/, "bridge should expose webContents.setZoomLevel");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getZoomLevel: function\(\) \{ return webContentsZoomLevel; \}/, "bridge should expose webContents.getZoomLevel");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /setVisualZoomLevelLimits: function\(minimumLevel, maximumLevel\) {\n        return _browserWindowAction\(id, 'webContents\.setVisualZoomLevelLimits', Number\(minimumLevel\), Number\(maximumLevel\)\)\.then\(function\(result\) {\n          syncWebContentsZoomState\(result\);\n          return undefined;\n        }\);/, "bridge should expose visual zoom limits with undefined resolution");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /export function pluginBrowserWindowZoomResult\(childWindow: PluginBrowserWindowState\) \{/, "host should return complete hosted zoom state payloads");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function updatePluginBrowserWindowZoomFactor\(id: string, factor: number\)/, "host should implement setZoomFactor state routing");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function updatePluginBrowserWindowZoomLevel\(id: string, level: number\)/, "host should implement setZoomLevel state routing");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function updatePluginBrowserWindowVisualZoomLimits\(id: string, minimumValue: unknown, maximumValue: unknown\)/, "host should implement visual zoom limits state routing");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /return `transform: scale\(\$\{factor\}\); transform-origin: 0 0; width: \$\{100 \/ factor\}%; height: \$\{100 \/ factor\}%;`;/, "host should render child iframe zoom through CSS scale");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.setZoomFactor"\) \{\s+return ports\.webContents\.updatePluginBrowserWindowZoomFactor\(id, Number\(actionArgs\[0\]\)\);/, "host should route webContents.setZoomFactor actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.setZoomLevel"\) \{\s+return ports\.webContents\.updatePluginBrowserWindowZoomLevel\(id, Number\(actionArgs\[0\]\)\);/, "host should route webContents.setZoomLevel actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.setVisualZoomLevelLimits"\) \{\s+return ports\.webContents\.updatePluginBrowserWindowVisualZoomLimits\(id, actionArgs\[0\], actionArgs\[1\]\);/, "host should route webContents.setVisualZoomLevelLimits actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.setZoomFactor\(factor\)` \/ `getZoomFactor\(\)` \/ `setZoomLevel\(level\)` \/ `getZoomLevel\(\)` \/ `setVisualZoomLevelLimits\(minimumLevel, maximumLevel\)` 会更新 hosted zoom state；`setZoomFactor\(\)` \/ `setZoomLevel\(\)` 保持 void-return shape，sync getter 立即可读，child iframe 通过 CSS scale 呈现当前 factor。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents zoom row complete",
);
assert.match(appSource, /data-browser-window-audio-initial', String\(!win\.webContents\.isAudioMuted\(\) && !win\.webContents\.isCurrentlyAudible\(\)\)/, "browser-window smoke should verify hosted audio initial state");
assert.match(appSource, /var audioMuteResult = win\.webContents\.setAudioMuted\(true\); document\.body\.setAttribute\('data-browser-window-audio-muted', String\(audioMuteResult === undefined && win\.webContents\.isAudioMuted\(\) && !win\.webContents\.isCurrentlyAudible\(\)\)\);/, "browser-window smoke should verify muting is void-return and updates sync audio getters");
assert.match(appSource, /var audioUnmuteResult = win\.webContents\.setAudioMuted\(false\); document\.body\.setAttribute\('data-browser-window-audio-unmuted', String\(audioUnmuteResult === undefined && !win\.webContents\.isAudioMuted\(\) && !win\.webContents\.isCurrentlyAudible\(\)\)\);/, "browser-window smoke should verify unmuting is void-return and updates sync audio getters");
assert.match(bridgeTestSource, /const audioStateListener = \(event, audible\) => webContentsEventCalls\.push\(\["audio", event\?\.sender === browserWindowHandle\.webContents, event\?\.audible, audible\]\);/, "VM coverage should observe event.audible and boolean listener argument for audio-state-changed");
assert.match(bridgeTestSource, /event: "audio-state-changed",\n    args: \[true\],/, "VM coverage should dispatch targeted audio-state-changed events with boolean payloads");
assert.match(bridgeTestSource, /\["audio", true, true, true\],/, "VM coverage should verify targeted audio-state-changed event sender, event.audible, and listener argument");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts"), /if \(event\.type === 'audio-state-changed'\) {\n        var audioArg = Array\.isArray\(args\) && args\.length > 0 \? args\[0\] : null;\n        var audible = typeof audioArg === 'boolean'\n          \? audioArg\n          : audioArg && typeof audioArg === 'object' && typeof audioArg\.audible === 'boolean'\n            \? audioArg\.audible\n            : webContentsCurrentlyAudible;\n        event\.audible = audible;\n      }/, "bridge should expose event.audible on targeted audio-state-changed events");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function syncWebContentsAudioState\(result\) {\n      var record = result && typeof result === 'object' \? result : {};\n      if \(typeof record\.audioMuted === 'boolean'\) webContentsAudioMuted = record\.audioMuted;\n      if \(typeof record\.currentlyAudible === 'boolean'\) webContentsCurrentlyAudible = record\.currentlyAudible;\n      if \(typeof record\.audible === 'boolean'\) webContentsCurrentlyAudible = record\.audible;\n      if \(webContentsAudioMuted\) webContentsCurrentlyAudible = false;/, "bridge should sync hosted audio muted and audible state from host results");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function syncWebContentsAudioEvent\(name, args\) {\n      if \(String\(name \|\| ''\) !== 'audio-state-changed'\) return;\n      var firstArg = Array\.isArray\(args\) && args\.length > 0 \? args\[0\] : null;\n      var audible = typeof firstArg === 'boolean'\n        \? firstArg\n        : firstArg && typeof firstArg === 'object' && typeof firstArg\.audible === 'boolean'\n          \? firstArg\.audible\n          : null;\n      if \(typeof audible === 'boolean'\) webContentsCurrentlyAudible = audible && !webContentsAudioMuted;/, "bridge should sync isCurrentlyAudible from targeted audio-state-changed events");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /function webContentsSetAudioMuted\(mutedValue\) {\n      var muted = mutedValue === true;\n      webContentsAudioMuted = muted;\n      if \(muted\) webContentsCurrentlyAudible = false;\n      _browserWindowAction\(id, 'webContents\.setAudioMuted', muted\)\.then\(syncWebContentsAudioState\)\.catch\(function\(err\) {/, "bridge should synchronously update audio muted state before host response");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /setAudioMuted: function\(muted\) \{ return webContentsSetAudioMuted\(muted\); \}/, "bridge should expose webContents.setAudioMuted");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isAudioMuted: function\(\) \{ return webContentsAudioMuted; \}/, "bridge should expose webContents.isAudioMuted");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isCurrentlyAudible: function\(\) \{ return webContentsCurrentlyAudible; \}/, "bridge should expose webContents.isCurrentlyAudible");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function pluginBrowserWindowAudioResult\(childWindow: PluginBrowserWindowState\) {\n    return {\n      audioMuted: childWindow\.audioMuted,\n      currentlyAudible: childWindow\.currentlyAudible,/, "host should return hosted audio state payloads");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function updatePluginBrowserWindowAudioMuted\(id: string, mutedValue: unknown\)/, "host should implement setAudioMuted state routing");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /if \(existing\.currentlyAudible !== currentlyAudible\) {\n      dispatchPluginBrowserWindowWebContentsEvent\(id, "audio-state-changed", \[currentlyAudible\]\);/, "host should dispatch targeted audio-state-changed events when audible state changes");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /if \(actionName === "webContents\.setAudioMuted"\) \{\s+return ports\.webContents\.updatePluginBrowserWindowAudioMuted\(id, actionArgs\[0\]\);/, "host should route webContents.setAudioMuted actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.setAudioMuted\(muted\)` \/ `isAudioMuted\(\)` \/ `isCurrentlyAudible\(\)` 会更新 hosted audio state；`setAudioMuted\(\)` 保持 void-return shape，sync getter 立即可读，targeted `audio-state-changed` 事件会同步 `event\.audible` 和 boolean listener argument。$/m,
  "macOS smoke checklist should mark BrowserWindow WebContents audio row complete",
);
assert.match(appSource, /win\.on\('resize', function\(state\)\{ document\.body\.setAttribute\('data-browser-window-event-resize', String\(state && state\.width === 420 && state\.height === 260\)\); \}\);/, "browser-window smoke should verify hosted resize event payloads from geometry actions");
assert.match(appSource, /win\.once\('move', function\(state\)\{ document\.body\.setAttribute\('data-browser-window-event-move-once', String\(state && state\.x === 24 && state\.y === 32\)\); \}\);/, "browser-window smoke should verify hosted one-shot move event payloads from geometry actions");
assert.match(appSource, /return win\.setBounds\(\{ x: 24, y: 32, width: 420, height: 260 \}\); \}\)\.then\(function\(\)\{ return win\.getBounds\(\); \}\)\.then\(function\(bounds\)\{ document\.body\.setAttribute\('data-browser-window-bounds', JSON\.stringify\(bounds\)\);/, "browser-window smoke should exercise setBounds() before asserting geometry event state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /if \(actionName === "setBounds"\) \{[\s\S]*?ports\.dispatchEvent\(id, "resize", \[\{ width: bounds\.width, height: bounds\.height, bounds \}\]\);[\s\S]*?ports\.dispatchEvent\(id, "move", \[\{ x: bounds\.x, y: bounds\.y, bounds \}\]\);[\s\S]*?return bounds;/, "host should dispatch resize and move events after setBounds()");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /if \(actionName === "setSize"\) \{[\s\S]*?ports\.dispatchEvent\(id, "resize", \[\{ width: size\.width, height: size\.height \}\]\);[\s\S]*?return \[size\.width, size\.height\];/, "host should dispatch resize events after setSize()");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /if \(actionName === "setPosition"\) \{[\s\S]*?ports\.dispatchEvent\(id, "move", \[\{ x: position\.x, y: position\.y \}\]\);[\s\S]*?return \[position\.x, position\.y\];/, "host should dispatch move events after setPosition()");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /if \(actionName === "center"\) \{[\s\S]*?ports\.dispatchEvent\(id, "move", \[\{ x: 0, y: 0, centered: true \}\]\);[\s\S]*?return \{ \.\.\.bounds, centered: true \};/, "host should dispatch centered move events after center()");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setBounds\(\)` \/ `setSize\(\)` \/ `setPosition\(\)` \/ `center\(\)` 会派发宿主内 `resize` \/ `move` 几何事件，插件可通过 `on\(\)` \/ `once\(\)` 监听。$/m,
  "macOS smoke checklist should mark BrowserWindow geometry events row complete",
);
assert.match(appSource, /win\.webContents\.openDevTools\(/, "browser-window smoke should exercise hosted webContents.openDevTools");
assert.match(appSource, /win\.webContents\.toggleDevTools\(\)/, "browser-window smoke should exercise hosted webContents.toggleDevTools");
assert.match(appSource, /win\.webContents\.closeDevTools\(\)/, "browser-window smoke should exercise hosted webContents.closeDevTools");
assert.match(appSource, /win\.webContents\.isDevToolsOpened\(\)/, "browser-window smoke should verify hosted DevTools open state");
assert.match(appSource, /win\.webContents\.isDevToolsFocused\(\)/, "browser-window smoke should verify hosted DevTools focus state");
const browserWindowDevToolsStateReplaceTarget = "return win.webContents.openDevTools({ mode: 'detach', activate: false, title: 'Hosted DevTools' }); }).then(function(openDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-open', String(openDevToolsResult && openDevToolsResult.devToolsOpened === true && win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.toggleDevTools(); }).then(function(toggleDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-toggle', String(toggleDevToolsResult && toggleDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.openDevTools({ mode: 'bottom' }); }).then(function(focusedDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-reopen', String(focusedDevToolsResult && focusedDevToolsResult.devToolsOpened === true && focusedDevToolsResult.devToolsFocused === true && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); return win.webContents.closeDevTools(); }).then(function(closeDevToolsResult){ document.body.setAttribute('data-browser-window-devtools-close', String(closeDevToolsResult && closeDevToolsResult.devToolsOpened === false && !win.webContents.isDevToolsOpened() && !win.webContents.isDevToolsFocused())); return win.webContents.capturePage({ x: 0, y: 0, width: 120, height: 80 }, { stayHidden: true }); }";
assert.equal(
  appSource.split(browserWindowDevToolsStateReplaceTarget).length - 1,
  2,
  "browser-window DevTools smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-devtools-state/, "browser-window smoke should record aggregate hosted DevTools state");
assert.match(appSource, /devToolsEventOpenedOk/, "browser-window smoke should verify targeted devtools-opened event payload");
assert.match(appSource, /devToolsEventClosedOk/, "browser-window smoke should verify targeted devtools-closed event payload");
assert.match(
  appSource,
  /window\.__atoolsBrowserWindowDevToolsEventOpenedOk = window\.__atoolsBrowserWindowDevToolsEventOpenedOk \|\| devToolsEventOpenedOk/,
  "browser-window smoke should preserve the first valid devtools-opened event across the later focused reopen",
);
assert.match(appSource, /devToolsOpenOk/, "browser-window smoke should verify openDevTools return state and sync getters");
assert.match(appSource, /devToolsToggleOk/, "browser-window smoke should verify toggleDevTools close state and sync getters");
assert.match(appSource, /devToolsReopenOk/, "browser-window smoke should verify focused openDevTools state and sync getters");
assert.match(appSource, /devToolsCloseOk/, "browser-window smoke should verify closeDevTools state and sync getters");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function pluginBrowserWindowDevToolsResult\(/, "host should return hosted browser-window DevTools result payloads");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function updatePluginBrowserWindowDevTools\(/, "host should update hosted browser-window DevTools state and dispatch events");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.openDevTools\(options\)` \/ `closeDevTools\(\)` \/ `toggleDevTools\(\)` 会更新 hosted DevTools state，并通过 `webContents\.on\("devtools-opened" \| "devtools-closed", listener\)` 向父插件派发 targeted 事件；`isDevToolsOpened\(\)` \/ `isDevToolsFocused\(\)` 会同步读取 hosted state。$/m,
  "macOS smoke checklist should mark BrowserWindow DevTools state/events row complete",
);
assert.match(appSource, /win\.webContents\.inspectElement\(/, "browser-window smoke should exercise hosted webContents.inspectElement");
const browserWindowInspectElementReplaceTarget = "var inspectElementResult = win.webContents.inspectElement(12, 8); document.body.setAttribute('data-browser-window-inspect-element', String(inspectElementResult === undefined && win.webContents.isDevToolsOpened() && win.webContents.isDevToolsFocused())); document.body.setAttribute('data-browser-window-audio-initial', String(!win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioMuteResult = win.webContents.setAudioMuted(true); document.body.setAttribute('data-browser-window-audio-muted', String(audioMuteResult === undefined && win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); var audioUnmuteResult = win.webContents.setAudioMuted(false); document.body.setAttribute('data-browser-window-audio-unmuted', String(audioUnmuteResult === undefined && !win.webContents.isAudioMuted() && !win.webContents.isCurrentlyAudible())); win.webContents.setZoomFactor(1.5);";
assert.equal(
  appSource.split(browserWindowInspectElementReplaceTarget).length - 1,
  2,
  "browser-window inspectElement smoke replacement should match both the current replacement output and the replace target",
);
assert.match(appSource, /data-browser-window-inspect-element-state/, "browser-window smoke should record inspectElement void-return and DevTools sync state");
assert.match(appSource, /data-browser-window-inspect-element-summary/, "browser-window smoke should record inspected element summary from the targeted DevTools event");
assert.match(appSource, /inspectElementStateOk/, "browser-window smoke should verify inspectElement keeps the official void-return shape and sync DevTools state");
assert.match(appSource, /inspectElementSummaryOk/, "browser-window smoke should verify inspectElement records a compact element summary");
assert.match(
  appSource,
  /if \(inspectElementSummary\) document\.body\.setAttribute\('data-browser-window-inspect-element-summary', String\(window\.__atoolsBrowserWindowInspectElementSummaryOk\)\)/,
  "browser-window smoke should only write the inspectElement summary marker from DevTools events that carry inspectedElement",
);
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /async function inspectPluginBrowserWindowElement\(id: string, args: unknown\[\]\)/, "host should preserve the inspectElement API route");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /throw hostedBrowserWindowUnsupported\("webContents\.inspectElement"\)/, "inspectElement must reject explicitly under opaque isolation");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginBrowserWindowWebContentsController.ts", "src/lib/pluginBrowserWindowFrameCommands.ts", "src/lib/pluginPanelDocumentSourceHost.ts"]), /function pluginBrowserWindowInspectedElement\(|frame\.contentDocument|elementFromPoint\(x, y\)/, "host must not inspect isolated child DOM");
assert.match(appSource, /win\.webContents\.capturePage\(/, "browser-window smoke should exercise hosted webContents.capturePage");
assert.match(appSource, /win\.webContents\.print\(/, "browser-window smoke should exercise hosted webContents.print");
assert.match(appSource, /win\.webContents\.printToPDF\(/, "browser-window smoke should exercise hosted webContents.printToPDF");
assert.match(appSource, /win\.webContents\.savePage\(/, "browser-window smoke should exercise hosted webContents.savePage");
const browserWindowCapturePrintSaveReplaceTarget = "}).then(function(capturedImage){ document.body.setAttribute('data-browser-window-capture-page', String(capturedImage && capturedImage.toDataURL().indexOf('data:image/') === 0 && capturedImage.getSize().width === 120 && !capturedImage.isEmpty())); return new Promise(function(resolve){ win.webContents.print({ silent: true }, function(success, failureReason){ document.body.setAttribute('data-browser-window-print', String(success === false && typeof failureReason === 'string' && failureReason.length > 0)); resolve(); }); }); }).then(function(){ return win.webContents.printToPDF({ printBackground: true }); }).then(function(pdfBytes){ document.body.setAttribute('data-browser-window-print-to-pdf', String(pdfBytes && pdfBytes.byteLength > 4 && pdfBytes[0] === 37)); return win.webContents.savePage('/tmp/atools-hosted-browser-window-smoke.html', 'HTMLOnly'); }).then(function(savePageResult){ document.body.setAttribute('data-browser-window-save-page', String(savePageResult === undefined));";
assert.equal(
  appSource.split(browserWindowCapturePrintSaveReplaceTarget).length - 1,
  2,
  "browser-window capture/print/save smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-capture-print-save-state/, "browser-window smoke should record aggregate capture\/print\/save state");
assert.match(appSource, /capturePageSize/, "browser-window smoke should inspect hosted capturePage NativeImage-compatible size");
assert.match(appSource, /capturePageSize\.height === 80/, "browser-window smoke should verify hosted capturePage preserves requested height");
assert.match(appSource, /capturePageOk/, "browser-window smoke should verify hosted capturePage data URL, size, and non-empty state");
assert.match(appSource, /printCallbackOk/, "browser-window smoke should verify hosted print callback result");
assert.match(appSource, /failureReason\.indexOf\('native-only'\) >= 0/, "browser-window smoke should verify hosted print returns an explicit native-only failure");
assert.match(appSource, /printToPdfOk/, "browser-window smoke should verify hosted printToPDF result");
assert.match(appSource, /pdfBytes\[0\] === 37 && pdfBytes\[1\] === 80 && pdfBytes\[2\] === 68 && pdfBytes\[3\] === 70/, "browser-window smoke should verify hosted printToPDF returns PDF bytes");
assert.match(appSource, /savePageOk/, "browser-window smoke should verify hosted savePage keeps the official void result");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /async function capturePluginBrowserWindowPage\(windowId: string, args: unknown\[\]\)/, "host should preserve the capturePage API route");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /throw hostedBrowserWindowUnsupported\("webContents\.capturePage"\)/, "capturePage must reject explicitly under opaque isolation");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function printPluginBrowserWindowPage\(windowId: string, args: unknown\[\]\)/, "host should route webContents.print to an explicit hosted result");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /failureReason: "webContents\.print is native-only in hosted BrowserWindow"/, "host should not fake a successful print result");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /async function printPluginBrowserWindowToPdf\(windowId: string, args: unknown\[\]\)/, "host should preserve the printToPDF API route");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /throw hostedBrowserWindowUnsupported\("webContents\.printToPDF"\)/, "printToPDF must reject explicitly under opaque isolation");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /async function savePluginBrowserWindowPage\(windowId: string, args: unknown\[\]\)/, "host should preserve the savePage API route");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /throw hostedBrowserWindowUnsupported\("webContents\.savePage"\)/, "savePage must reject explicitly under opaque isolation");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginBrowserWindowWebContentsController.ts", "src/lib/pluginBrowserWindowFrameCommands.ts", "src/lib/pluginPanelDocumentSourceHost.ts"]), /browserWindowSnapshotSvg|browserWindowMinimalPdfBytes|browserWindowSerializedPage|frame\.contentDocument/, "host must not recreate capture, PDF, or save output by reading isolated child DOM");
for (const [marker, required] of [
  ["`webContents.inspectElement(x, y)`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "opaque"]],
  ["`webContents.capturePage([rect, opts])`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "print()", "native-only"]],
  ["`webContents.insertText(text)`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "12"]],
  ["`webContents.centerSelection()`", ["ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED", "4"]],
]) {
  const line = smokeChecklistLineContaining(marker);
  assert.match(line, /^- \[x\] /, `macOS smoke checklist should keep the ${marker} explicit-boundary row checked`);
  for (const token of required) {
    assert.ok(line.includes(token), `${marker} checklist row should describe ${token}`);
  }
}
for (const token of [
  "Batch 384 Current Delta",
  "allow-scripts allow-popups",
  "MessageChannel",
  "ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED",
  "20",
]) {
  assert.ok(uiRestoreChecklist.includes(token), `UI restore checklist should record Batch 384 security token ${token}`);
}
assert.match(appSource, /win\.webContents\.setUserAgent\(/, "browser-window smoke should exercise hosted webContents.setUserAgent");
assert.match(appSource, /win\.webContents\.getUserAgent\(\)/, "browser-window smoke should verify hosted webContents user agent");
assert.match(appSource, /win\.webContents\.setFrameRate\(/, "browser-window smoke should exercise hosted webContents.setFrameRate");
assert.match(appSource, /win\.webContents\.getFrameRate\(\)/, "browser-window smoke should verify hosted webContents frame rate");
assert.match(appSource, /win\.webContents\.setBackgroundThrottling\(/, "browser-window smoke should exercise hosted webContents.setBackgroundThrottling");
assert.match(appSource, /win\.webContents\.getBackgroundThrottling\(\)/, "browser-window smoke should verify hosted webContents background throttling");
assert.match(appSource, /win\.webContents\.getProcessId\(\)/, "browser-window smoke should verify hosted webContents process id");
assert.match(appSource, /win\.webContents\.getOSProcessId\(\)/, "browser-window smoke should verify hosted webContents OS process id");
const browserWindowRuntimeStateReplaceTarget = "var processOk = Number.isInteger(win.webContents.getProcessId()) && win.webContents.getProcessId() > 0 && Number.isInteger(win.webContents.getOSProcessId()) && win.webContents.getOSProcessId() > 0; var setUserAgentResult = win.webContents.setUserAgent('AToolsBrowserWindowSmoke/239'); var setFrameRateResult = win.webContents.setFrameRate(24); var setBackgroundThrottlingResult = win.webContents.setBackgroundThrottling(false); document.body.setAttribute('data-browser-window-runtime-state', String(processOk && setUserAgentResult === undefined && win.webContents.getUserAgent() === 'AToolsBrowserWindowSmoke/239' && setFrameRateResult === undefined && win.webContents.getFrameRate() === 24 && setBackgroundThrottlingResult === undefined && win.webContents.getBackgroundThrottling() === false)); win.webContents.setZoomFactor(1.5);";
assert.equal(
  appSource.split(browserWindowRuntimeStateReplaceTarget).length - 1,
  2,
  "browser-window runtime smoke replacement should match both the srcdoc base string and the replace target",
);
assert.match(appSource, /data-browser-window-runtime-defaults/, "browser-window smoke should record hosted runtime default state");
assert.match(appSource, /data-browser-window-runtime-process/, "browser-window smoke should record hosted runtime process identity state");
assert.match(appSource, /data-browser-window-runtime-setters/, "browser-window smoke should record hosted runtime setter state");
assert.match(appSource, /typeof initialUserAgent === 'string' && initialUserAgent\.length > 0/, "browser-window smoke should verify hosted user-agent default is readable");
assert.match(appSource, /initialFrameRate === 60/, "browser-window smoke should verify hosted frame-rate default");
assert.match(appSource, /initialBackgroundThrottling === true/, "browser-window smoke should verify hosted background throttling default");
assert.match(appSource, /processId !== osProcessId/, "browser-window smoke should verify hosted process id differs from hosted OS process id");
assert.match(appSource, /runtimeSetterOk/, "browser-window smoke should verify hosted runtime setter void-return and sync getter state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts"), /var webContentsProcessId = hostedPositiveInteger\(record\.processId, hostedNumericId\(id, 1\)\)/, "bridge should initialize hosted process id from compatibility state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts"), /var webContentsOSProcessId = hostedPositiveInteger\(record\.osProcessId, 100000 \+ webContentsProcessId\)/, "bridge should initialize hosted OS process id separately from process id");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /export function browserWindowOSProcessId\(windowSeq: number\): number \{\s+return 100000 \+ browserWindowProcessId\(windowSeq\);\s+\}/, "host should derive a hosted OS process id distinct from process id");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowCreateController.ts"), /const frameRate = 60;\n    const backgroundThrottling = true;/, "host should initialize BrowserWindow runtime defaults");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function pluginBrowserWindowRuntimeResult\(childWindow: PluginBrowserWindowState\)/, "host should return a complete hosted runtime state payload");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /processId: childWindow\.processId,\s+osProcessId: childWindow\.osProcessId,/, "host runtime payload should include both process identity values");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `webContents\.getUserAgent\(\)` \/ `setUserAgent\(userAgent\)`、`getFrameRate\(\)` \/ `setFrameRate\(fps\)`、`getBackgroundThrottling\(\)` \/ `setBackgroundThrottling\(allowed\)`、`getProcessId\(\)` \/ `getOSProcessId\(\)` 会路由到 hosted runtime state；setter 保持 void-return shape，sync getter 立即可读，process id 为 hosted compatibility 正整数，不等同真实 Electron renderer 或 OS process id。$/m,
  "macOS smoke checklist should mark BrowserWindow runtime state row complete",
);
assert.match(appSource, /id=\\"browser-window-edit-target\\"/, "browser-window smoke child should include an editable target");
assert.match(appSource, /win\.webContents\.insertText\(/, "browser-window smoke should exercise hosted webContents.insertText");
assert.match(appSource, /win\.webContents\.selectAll\(\)/, "browser-window smoke should exercise hosted webContents.selectAll");
assert.match(appSource, /win\.webContents\.paste\(\)/, "browser-window smoke should exercise hosted webContents.paste");
assert.match(appSource, /win\.webContents\.centerSelection\(\)/, "browser-window smoke should exercise hosted webContents.centerSelection");
assert.match(appSource, /win\.webContents\.scrollToBottom\(\)/, "browser-window smoke should exercise hosted webContents.scrollToBottom");
assert.match(appSource, /win\.webContents\.scrollToTop\(\)/, "browser-window smoke should exercise hosted webContents.scrollToTop");
assert.match(appSource, /win\.webContents\.adjustSelection\(/, "browser-window smoke should exercise hosted webContents.adjustSelection");
assert.match(appSource, /win\.webContents\.setZoomFactor\(/, "browser-window smoke should exercise hosted webContents.setZoomFactor");
assert.match(appSource, /win\.webContents\.getZoomFactor\(\)/, "browser-window smoke should verify hosted webContents zoom factor");
assert.match(appSource, /win\.webContents\.setZoomLevel\(/, "browser-window smoke should exercise hosted webContents.setZoomLevel");
assert.match(appSource, /win\.webContents\.getZoomLevel\(\)/, "browser-window smoke should verify hosted webContents zoom level");
assert.match(appSource, /win\.webContents\.setVisualZoomLevelLimits\(/, "browser-window smoke should exercise hosted webContents.setVisualZoomLevelLimits");
assert.match(appSource, /win\.webContents\.setAudioMuted\(/, "browser-window smoke should exercise hosted webContents.setAudioMuted");
assert.match(appSource, /win\.webContents\.isAudioMuted\(\)/, "browser-window smoke should verify hosted webContents muted state");
assert.match(appSource, /win\.webContents\.isCurrentlyAudible\(\)/, "browser-window smoke should verify hosted webContents audible state");
assert.match(appSource, /ipcRenderer\.on\(/, "browser-window smoke child should receive hosted webContents.send messages");
assert.match(appSource, /data-send-input-event/, "browser-window smoke child should receive hosted input events");
assert.match(appSource, /win\.showInactive\(/, "browser-window smoke should exercise hosted showInactive state");
assert.match(appSource, /win\.setTitle\(/, "browser-window smoke should exercise hosted title updates");
assert.match(appSource, /win\.setBackgroundColor\(/, "browser-window smoke should exercise hosted background color updates");
assert.match(appSource, /win\.getBackgroundColor\(\)/, "browser-window smoke should verify hosted background color state");
assert.match(appSource, /data-browser-window-background-color/, "browser-window smoke should record hosted background color state");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setBackgroundColor\(color\)` \/ `getBackgroundColor\(\)` 会路由到宿主内 background-color state；setter 保持 void-return shape，getter 返回同步规范化后的 `#RRGGBB`，hosted 子窗口 shell 会应用同一背景色。$/m,
  "macOS smoke checklist should mark BrowserWindow background-color row complete",
);
assert.match(appSource, /win\.setAutoHideMenuBar\(/, "browser-window smoke should exercise hosted menu bar auto-hide updates");
assert.match(appSource, /win\.isMenuBarAutoHide\(\)/, "browser-window smoke should verify hosted menu bar auto-hide state");
assert.match(appSource, /win\.setMenuBarVisibility\(/, "browser-window smoke should exercise hosted menu bar visibility updates");
assert.match(appSource, /win\.isMenuBarVisible\(\)/, "browser-window smoke should verify hosted menu bar visibility state");
assert.match(appSource, /win\.removeMenu\(\)/, "browser-window smoke should exercise hosted removeMenu");
assert.match(appSource, /win\.setMenu\(/, "browser-window smoke should exercise hosted setMenu");
assert.match(appSource, /data-browser-window-menu-bar-state/, "browser-window smoke should record hosted menu bar state");
assert.match(appSource, /var autoHideMenuBarResult = win\.setAutoHideMenuBar\(true\); var hideMenuBarResult = win\.setMenuBarVisibility\(false\); var removeMenuResult = win\.removeMenu\(\); var setMenuResult = win\.setMenu\(\{ items: \[\{ label: 'File' \}\] \}\); document\.body\.setAttribute\('data-browser-window-menu-bar-state', String\(autoHideMenuBarResult === undefined && win\.isMenuBarAutoHide\(\) === true && hideMenuBarResult === undefined && removeMenuResult === undefined && setMenuResult === undefined && win\.isMenuBarVisible\(\) === true\)\);/, "browser-window smoke should verify menu-bar void-return setters and sync getter state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function syncBrowserWindowMenuBarState\(result\) \{\n      var record = result && typeof result === 'object' \? result : \{\};\n      if \(typeof record\.menuBarAutoHide === 'boolean'\) browserWindowMenuBarAutoHide = record\.menuBarAutoHide;\n      if \(typeof record\.menuRemoved === 'boolean'\) browserWindowMenuRemoved = record\.menuRemoved;\n      if \(typeof record\.menuBarVisible === 'boolean'\) browserWindowMenuBarVisible = record\.menuBarVisible && !browserWindowMenuRemoved;\n      if \(browserWindowMenuRemoved\) browserWindowMenuBarVisible = false;/, "bridge should sync hosted menu-bar auto-hide, removed, and visibility state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function browserWindowRemoveMenu\(\) \{\n      browserWindowMenuRemoved = true;\n      browserWindowMenuBarVisible = false;\n      _browserWindowAction\(id, 'removeMenu'\)\.then\(syncBrowserWindowMenuBarState\)/, "bridge should synchronously hide hosted menu bars when removeMenu() is called");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function browserWindowSetMenu\(menu\) \{\n      browserWindowMenuRemoved = menu == null;\n      browserWindowMenuBarVisible = !browserWindowMenuRemoved;\n      _browserWindowAction\(id, 'setMenu', menu == null \? null : menu\)\.then\(syncBrowserWindowMenuBarState\)/, "bridge should restore hosted menu visibility for non-null setMenu() and remove it for null");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowLifecycleActions.ts"), /if \(actionName === "setAutoHideMenuBar"\) \{[\s\S]*?return \{ menuBarAutoHide \};[\s\S]*?if \(actionName === "setMenuBarVisibility"\) \{[\s\S]*?return \{ menuBarVisible \};[\s\S]*?if \(actionName === "removeMenu"\) \{[\s\S]*?return \{ menuRemoved: true, menuBarVisible: false \};[\s\S]*?if \(actionName === "setMenu"\) \{[\s\S]*?return \{ menuRemoved, menuBarVisible \};/, "host should route BrowserWindow menu-bar state actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setAutoHideMenuBar\(\)` \/ `isMenuBarAutoHide\(\)` \/ `setMenuBarVisibility\(\)` \/ `isMenuBarVisible\(\)` \/ `removeMenu\(\)` \/ `setMenu\(\)` 会更新 hosted menu-bar state；setter\/remove\/setMenu 保持 void-return shape，sync getter 立即可读，`removeMenu\(\)` 会隐藏并标记 removed，`setMenu\(menu\)` 会恢复非 null 菜单可见状态。$/m,
  "macOS smoke checklist should mark BrowserWindow menu-bar state row complete",
);
assert.match(appSource, /win\.setWindowButtonVisibility\(/, "browser-window smoke should exercise hosted window button visibility state");
assert.match(appSource, /win\.setWindowButtonPosition\(/, "browser-window smoke should exercise hosted window button position state");
assert.match(appSource, /win\.getWindowButtonPosition\(\)/, "browser-window smoke should verify hosted window button position state");
assert.match(appSource, /win\.setVibrancy\(/, "browser-window smoke should exercise hosted vibrancy state");
assert.match(appSource, /win\.setBackgroundMaterial\(/, "browser-window smoke should exercise hosted background material state");
assert.match(appSource, /win\.setSheetOffset\(/, "browser-window smoke should exercise hosted sheet offset state");
assert.match(appSource, /data-browser-window-titlebar-material-state/, "browser-window smoke should record hosted titlebar/material state");
assert.match(appSource, /var windowButtonVisibilityResult = win\.setWindowButtonVisibility\(false\); var windowButtonPositionResult = win\.setWindowButtonPosition\(\{ x: 18, y: 9 \}\); var windowButtonPosition = win\.getWindowButtonPosition\(\); var windowButtonResetResult = win\.setWindowButtonPosition\(null\); var vibrancyResult = win\.setVibrancy\('sidebar', \{ animationDuration: 120 \}\); var clearVibrancyResult = win\.setVibrancy\(null\); var backgroundMaterialResult = win\.setBackgroundMaterial\('under-window'\); var sheetOffsetResult = win\.setSheetOffset\(44, 12\); document\.body\.setAttribute\('data-browser-window-titlebar-material-state', String\(windowButtonVisibilityResult === undefined && windowButtonPositionResult === undefined && windowButtonPosition && windowButtonPosition\.x === 18 && windowButtonPosition\.y === 9 && windowButtonResetResult === undefined && win\.getWindowButtonPosition\(\) === null && vibrancyResult === undefined && clearVibrancyResult === undefined && backgroundMaterialResult === undefined && sheetOffsetResult === undefined\)\);/, "browser-window smoke should verify titlebar/material void-return setters and sync window button position state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function syncBrowserWindowTitlebarMaterialState\(result\) \{\n      var record = result && typeof result === 'object' \? result : \{\};\n      if \(typeof record\.windowButtonVisible === 'boolean'\) browserWindowButtonVisible = record\.windowButtonVisible;\n      if \(Object\.prototype\.hasOwnProperty\.call\(record, 'windowButtonPosition'\)\) browserWindowButtonPosition = hostedWindowButtonPosition\(record\.windowButtonPosition\);[\s\S]*?if \(typeof record\.sheetOffsetX === 'number'\) browserWindowSheetOffsetX = record\.sheetOffsetX;/, "bridge should sync hosted titlebar/material state payloads");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function browserWindowSetWindowButtonPosition\(position\) \{\n      browserWindowButtonPosition = hostedWindowButtonPosition\(position\);\n      _browserWindowAction\(id, 'setWindowButtonPosition', hostedWindowButtonPositionCopy\(browserWindowButtonPosition\)\)\.then\(syncBrowserWindowTitlebarMaterialState\)/, "bridge should sync window button position immediately and send null reset state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getWindowButtonPosition: function\(\) \{ return hostedWindowButtonPositionCopy\(browserWindowButtonPosition\); \}/, "bridge should expose synchronous window button position getter");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowLifecycleActions.ts"), /if \(actionName === "setWindowButtonVisibility"\) \{[\s\S]*?return \{ windowButtonVisible \};[\s\S]*?if \(actionName === "setWindowButtonPosition"\) \{[\s\S]*?return \{ windowButtonPosition \};[\s\S]*?if \(actionName === "getWindowButtonPosition"\) \{[\s\S]*?return existing\.windowButtonPosition \? \{ \.\.\.existing\.windowButtonPosition \} : null;[\s\S]*?if \(actionName === "setVibrancy"\) \{[\s\S]*?return \{ vibrancy, vibrancyOptions \};[\s\S]*?if \(actionName === "setBackgroundMaterial"\) \{[\s\S]*?return \{ backgroundMaterial \};[\s\S]*?if \(actionName === "setSheetOffset"\) \{[\s\S]*?return \{ sheetOffsetY, sheetOffsetX \};/, "host should route BrowserWindow titlebar/material state actions");
assert.match(
  smokeChecklist,
  /^- \[x\] BrowserWindow handle 的 `setWindowButtonVisibility\(\)` \/ `setWindowButtonPosition\(\)` \/ `getWindowButtonPosition\(\)` \/ `setVibrancy\(\)` \/ `setBackgroundMaterial\(\)` \/ `setSheetOffset\(\)` 会更新 hosted macOS titlebar\/material state；setter 保持 void-return shape，`getWindowButtonPosition\(\)` sync getter 立即可读，`setWindowButtonPosition\(null\)` 会重置为系统默认 `null`。$/m,
  "macOS smoke checklist should mark BrowserWindow titlebar/material state row complete",
);
assert.match(appSource, /win\.isNormal\(\)/, "browser-window smoke should verify hosted normal window state");
assert.match(appSource, /win\.isModal\(\)/, "browser-window smoke should verify hosted modal window state");
assert.match(appSource, /win\.setDocumentEdited\(/, "browser-window smoke should exercise hosted document edited state");
assert.match(appSource, /win\.isDocumentEdited\(\)/, "browser-window smoke should verify hosted document edited state");
assert.match(appSource, /win\.setRepresentedFilename\(/, "browser-window smoke should exercise hosted represented filename state");
assert.match(appSource, /win\.getRepresentedFilename\(\)/, "browser-window smoke should verify hosted represented filename state");
assert.match(appSource, /win\.setParentWindow\(/, "browser-window smoke should exercise hosted parent window state");
assert.match(appSource, /win\.getParentWindow\(\)/, "browser-window smoke should verify hosted parent window state");
assert.match(appSource, /win\.getChildWindows\(\)/, "browser-window smoke should verify hosted child window state");
assert.match(appSource, /data-browser-window-document-parent-state/, "browser-window smoke should record hosted document and parent state");
assert.match(appSource, /var parentSetResult = win\.setParentWindow\(sourceWin\); var parentOk = parentSetResult === undefined && win\.getParentWindow\(\) === sourceWin && sourceWin\.getChildWindows\(\)\.some\(function\(childWin\)\{ return childWin === win; \}\); var parentResetResult = win\.setParentWindow\(null\); document\.body\.setAttribute\('data-browser-window-parent-child-state', String\(parentOk && parentResetResult === undefined && win\.getParentWindow\(\) === null && sourceWin\.getChildWindows\(\)\.length === 0\)\);/, "browser-window smoke should verify hosted parent-child handle relationship and null reset");
assert.match(appSource, /var documentEditedInitial = !win\.isDocumentEdited\(\); var representedFilenameInitial = win\.getRepresentedFilename\(\) === ''; var normalModalInitial = win\.isNormal\(\) === true && win\.isModal\(\) === false; var documentEditedResult = win\.setDocumentEdited\(true\); var representedFilenameResult = win\.setRepresentedFilename\('\/tmp\/atools-browser-window-document\.md'\); document\.body\.setAttribute\('data-browser-window-document-parent-state', String\(document\.body\.getAttribute\('data-browser-window-parent-child-state'\) === 'true' && documentEditedInitial && representedFilenameInitial && normalModalInitial && documentEditedResult === undefined && win\.isDocumentEdited\(\) === true && representedFilenameResult === undefined && win\.getRepresentedFilename\(\) === '\/tmp\/atools-browser-window-document\.md' && win\.getParentWindow\(\) === null && Array\.isArray\(win\.getChildWindows\(\)\) && win\.getChildWindows\(\)\.length === 0\)\);/, "browser-window smoke should verify document state void-return setters, sync getters, normal/modal, and cleared parent state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function syncBrowserWindowDocumentParentState\(result\) \{\n      var record = result && typeof result === 'object' \? result : \{\};\n      if \(typeof record\.documentEdited === 'boolean'\) browserWindowDocumentEdited = record\.documentEdited;\n      if \(typeof record\.representedFilename === 'string'\) browserWindowRepresentedFilename = record\.representedFilename;\n      if \(typeof record\.modal === 'boolean'\) browserWindowModal = record\.modal;\n      if \(Object\.prototype\.hasOwnProperty\.call\(record, 'parentWindowId'\)\) \{\n        browserWindowParentId = typeof record\.parentWindowId === 'string' && record\.parentWindowId \? record\.parentWindowId : null;/, "bridge should sync hosted document, modal, and parent-window state payloads");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts"), /function browserWindowSetParentWindow\(parentWindow\) \{\n      browserWindowParentId = hostedBrowserWindowParentId\(parentWindow\);\n      _browserWindowAction\(id, 'setParentWindow', browserWindowParentId\)\.then\(syncBrowserWindowDocumentParentState\)/, "bridge should synchronously set or clear hosted parent window ids");

  Object.assign(fixture, {appSource, bridgeTestSource, smokeChecklist, smokeChecklistLineContaining, uiRestoreChecklist});
}
