import assert from "node:assert/strict";
import { readPanelHostSource, readPanelHostSources } from "../plugin-panel-source-test-adapter.mjs";

export async function run(fixture) {
  let { root, appSource } = fixture;
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /type PluginBrowserWindowState = \{/, "host should keep browser-window state");
assert.match(await readPanelHostSource(root, "src/lib/pluginPanelBrowserWindowState.svelte.ts"), /let windows = \$state<PluginBrowserWindowState\[\]>\(\[\]\);/, "host should track child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowCreateController.ts"), /function createPluginBrowserWindow\(/, "host should create browser windows instead of returning unsupported");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /function handlePluginBrowserWindowAction\(/, "host should handle BrowserWindow object actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /function dispatchPluginBrowserWindowParentMessage\(/, "host should forward child sendToParent messages");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function dispatchPluginBrowserWindowIpcMessage\(/, "host should forward parent webContents.send messages to child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function executePluginBrowserWindowJavaScript\(/, "host should execute JavaScript in hosted child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function dispatchPluginBrowserWindowInputEvent\(/, "host should forward sendInputEvent payloads to child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function insertPluginBrowserWindowCss\(/, "host should insert CSS into hosted child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function removePluginBrowserWindowCss\(/, "host should remove inserted CSS from hosted child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function findPluginBrowserWindowInPage\(/, "host should find text in hosted child browser windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function stopPluginBrowserWindowFindInPage\(/, "host should stop hosted child browser-window find requests");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function pluginBrowserWindowNavigationResult\(/, "host should return hosted browser-window navigation state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function navigatePluginBrowserWindowHistory\(/, "host should navigate hosted browser-window history");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function pluginBrowserWindowDevToolsResult\(/, "host should return hosted browser-window DevTools state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function updatePluginBrowserWindowDevTools\(/, "host should update hosted browser-window DevTools state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function inspectPluginBrowserWindowElement\(/, "host should inspect hosted browser-window elements");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function editPluginBrowserWindowText\(/, "host should edit focused hosted browser-window text controls");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowFrameCommands.ts"), /function controlPluginBrowserWindowSelection\(/, "host should control hosted browser-window selection and scrolling");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function dispatchPluginBrowserWindowEvent\(/, "host should forward browser-window lifecycle events to parent plugin iframes");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts"), /__atools_browser_window_event__/, "bridge should deliver browser-window events to created handles");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts"), /__atools_browser_window_ipc__/, "bridge should deliver webContents.send payloads to hosted child windows");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.executeJavaScript/, "bridge should route webContents.executeJavaScript actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.sendInputEvent/, "bridge should route webContents.sendInputEvent actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.insertCSS/, "bridge should route webContents.insertCSS actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.removeInsertedCSS/, "bridge should route webContents.removeInsertedCSS actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.findInPage/, "bridge should route webContents.findInPage actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.stopFindInPage/, "bridge should route webContents.stopFindInPage actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.loadURL/, "bridge should route webContents.loadURL actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.reload/, "bridge should route webContents.reload actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.reloadIgnoringCache/, "bridge should route webContents.reloadIgnoringCache actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isWaitingForResponse: function/, "bridge should expose webContents.isWaitingForResponse");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /navigationHistory: navigationHistory/, "bridge should expose webContents.navigationHistory");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /webContents\.navigationHistory\.goToOffset/, "host should route webContents.navigationHistory.goToOffset actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /webContents\.navigationHistory\.clear/, "host should route webContents.navigationHistory.clear actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.goBack/, "bridge should route webContents.goBack actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.goForward/, "bridge should route webContents.goForward actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.stop/, "bridge should route webContents.stop actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isCrashed: function/, "bridge should expose webContents.isCrashed");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /forcefullyCrashRenderer: function/, "bridge should expose webContents.forcefullyCrashRenderer");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /webContents\.forcefullyCrashRenderer/, "host should route webContents.forcefullyCrashRenderer actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /render-process-gone/, "bridge should surface hosted render-process-gone events");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /focus: function\(\) \{ return webContentsFocus\(\); \}/, "bridge should expose webContents.focus");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isFocused: function\(\) \{ return webContentsFocused; \}/, "bridge should expose webContents.isFocused");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getOwnerBrowserWindow: function/, "bridge should expose webContents.getOwnerBrowserWindow");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /getMediaSourceId: function\(\) \{ return webContentsMediaSourceId; \}/, "bridge should expose webContents.getMediaSourceId");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /isBeingCaptured: function\(\) \{ return webContentsBeingCaptured; \}/, "bridge should expose webContents.isBeingCaptured");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /setIgnoreMenuShortcuts: function/, "bridge should expose webContents.setIgnoreMenuShortcuts");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowActionDispatcher.ts"), /webContents\.setIgnoreMenuShortcuts/, "host should route webContents.setIgnoreMenuShortcuts actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.openDevTools/, "bridge should route webContents.openDevTools actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.closeDevTools/, "bridge should route webContents.closeDevTools actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.toggleDevTools/, "bridge should route webContents.toggleDevTools actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContents\.inspectElement/, "bridge should route webContents.inspectElement actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function capturePluginBrowserWindowPage\(/, "host should capture hosted browser-window pages");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function printPluginBrowserWindowPage\(/, "host should route hosted browser-window print requests");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /function savePluginBrowserWindowPage\(/, "host should save hosted browser-window pages");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowState.ts"), /function updatePluginBrowserWindowUserAgent\(/, "host should update hosted browser-window user agent state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowState.ts"), /function updatePluginBrowserWindowFrameRate\(/, "host should update hosted browser-window frame rate state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowState.ts"), /function updatePluginBrowserWindowBackgroundThrottling\(/, "host should update hosted browser-window background throttling state");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.capturePage/, "bridge should route webContents.capturePage actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.print/, "bridge should route webContents.print actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.printToPDF/, "bridge should route webContents.printToPDF actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.savePage/, "bridge should route webContents.savePage actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContents\.setUserAgent/, "bridge should route webContents.setUserAgent actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContents\.setFrameRate/, "bridge should route webContents.setFrameRate actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContents\.setBackgroundThrottling/, "bridge should route webContents.setBackgroundThrottling actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.centerSelection/, "bridge should route webContents.centerSelection actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.scrollToTop/, "bridge should route webContents.scrollToTop actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.scrollToBottom/, "bridge should route webContents.scrollToBottom actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.adjustSelection/, "bridge should route webContents.adjustSelection actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContents\.insertText/, "bridge should route webContents.insertText actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.selectAll/, "bridge should route webContents.selectAll actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts"), /webContents\.replaceMisspelling/, "bridge should route webContents.replaceMisspelling actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts"), /webContents\.setAudioMuted/, "bridge should route webContents.setAudioMuted actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowWebContentsController.ts"), /target: "webContents"/, "host should tag webContents events separately from BrowserWindow events");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /ports\.dispatchEvent\(id, "resize"/, "setBounds/setSize should dispatch hosted browser-window resize events");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowGeometryActions.ts"), /ports\.dispatchEvent\(id, "move"/, "setBounds/setPosition/center should dispatch hosted browser-window move events");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowNavigationLoader.ts"), /function loadPluginBrowserWindowUrl\(/, "host should load and reload hosted browser-window urls");
assert.match(await readPanelHostSource(root, "src/lib/pluginPanelNativeBridgeRouter.ts"), /case "browserWindowAction":/, "native bridge should route BrowserWindow object actions");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /x: number;/, "host should track child browser-window x position");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /y: number;/, "host should track child browser-window y position");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /width: number;/, "host should track child browser-window width");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /height: number;/, "host should track child browser-window height");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /minimumWidth: number;/, "host should track hosted child browser-window minimum width");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /minimumHeight: number;/, "host should track hosted child browser-window minimum height");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /maximumWidth: number;/, "host should track hosted child browser-window maximum width");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /maximumHeight: number;/, "host should track hosted child browser-window maximum height");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /aspectRatio: number;/, "host should track hosted child browser-window aspect ratio");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /aspectRatioExtraSize: PluginBrowserWindowSize;/, "host should track hosted child browser-window aspect ratio extra size");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /positioned: boolean;/, "host should distinguish explicit position from centered layout");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /alwaysOnTop: boolean;/, "host should track hosted child browser-window always-on-top state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /backgroundColor: string;/, "host should track hosted child browser-window background color state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /const background = ` background: \$\{childWindow\.backgroundColor\};`;/, "host should render child browser-window background color into shell style");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /menuBarAutoHide: boolean;/, "host should track hosted child browser-window menu bar auto-hide state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /menuBarVisible: boolean;/, "host should track hosted child browser-window menu bar visibility state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /menuRemoved: boolean;/, "host should track hosted child browser-window removed menu state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /minimized: boolean;/, "host should track hosted child browser-window minimized state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /maximized: boolean;/, "host should track hosted child browser-window maximized state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /resizable: boolean;/, "host should track hosted child browser-window resizable capability");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /movable: boolean;/, "host should track hosted child browser-window movable capability");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /closable: boolean;/, "host should track hosted child browser-window closable capability");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /minimizable: boolean;/, "host should track hosted child browser-window minimizable capability");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /maximizable: boolean;/, "host should track hosted child browser-window maximizable capability");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /fullScreen: boolean;/, "host should track hosted child browser-window full-screen state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /fullScreenable: boolean;/, "host should track hosted child browser-window full-screenable capability");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /opacity: number;/, "host should track hosted child browser-window opacity");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /hasShadow: boolean;/, "host should track hosted child browser-window shadow state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /skipTaskbar: boolean;/, "host should track hosted child browser-window taskbar visibility state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /kiosk: boolean;/, "host should track hosted child browser-window kiosk state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /visibleOnAllWorkspaces: boolean;/, "host should track hosted child browser-window workspace visibility state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /contentProtected: boolean;/, "host should track hosted child browser-window content protection state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /focusable: boolean;/, "host should track hosted child browser-window focusable state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /flashing: boolean;/, "host should track hosted child browser-window attention state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /progressBar: number \| null;/, "host should track hosted child browser-window progress value");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /progressBarMode: string;/, "host should track hosted child browser-window progress mode");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /windowButtonVisible: boolean;/, "host should track hosted child browser-window traffic-light visibility state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /windowButtonPosition: PluginBrowserWindowPoint \| null;/, "host should track hosted child browser-window traffic-light position state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /vibrancy: string;/, "host should track hosted child browser-window vibrancy state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /vibrancyOptions: Record<string, unknown>;/, "host should track hosted child browser-window vibrancy options");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /backgroundMaterial: string;/, "host should track hosted child browser-window background material state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /sheetOffsetY: number;/, "host should track hosted child browser-window sheet vertical offset");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /sheetOffsetX: number;/, "host should track hosted child browser-window sheet horizontal offset");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /documentEdited: boolean;/, "host should track hosted child browser-window document edited state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /representedFilename: string;/, "host should track hosted child browser-window represented filename");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /modal: boolean;/, "host should track hosted child browser-window modal state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /parentWindowId: string \| null;/, "host should track hosted child browser-window parent relationship");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /mediaSourceId: string;/, "host should track hosted child browser-window media source id");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /zOrder: number;/, "host should track hosted child browser-window z-order");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /devToolsOpened: boolean;/, "host should track hosted child browser-window DevTools open state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /devToolsFocused: boolean;/, "host should track hosted child browser-window DevTools focus state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /inspectedElement: PluginBrowserWindowInspectedElement \| null;/, "host should track the last inspected hosted child browser-window element");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /audioMuted: boolean;/, "host should track hosted child browser-window muted audio state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowTypes.ts"), /currentlyAudible: boolean;/, "host should track hosted child browser-window audible state");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function normalizePluginBrowserWindowBounds\(/, "host should normalize browser-window bounds");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function normalizePluginBrowserWindowSize\(/, "host should normalize browser-window sizes");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function constrainPluginBrowserWindowSize\(/, "host should constrain browser-window sizes");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function pluginBrowserWindowStyle\(/, "host should render browser-window bounds into CSS");
assert.match(await readPanelHostSource(root, "src/lib/pluginBrowserWindowPresentation.ts"), /function pluginBrowserWindowLayer\(/, "host should render browser-window z-order into CSS");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:hidden=\{!childWindow\.visible\}/, "host should hide child browser windows without destroying them");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:focused=\{childWindow\.focused\}/, "host should surface focused child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:positioned=\{childWindow\.positioned\}/, "host should render explicit child browser-window positions");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:alwaysOnTop=\{childWindow\.alwaysOnTop\}/, "host should render always-on-top child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:minimized=\{childWindow\.minimized\}/, "host should render minimized child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:maximized=\{childWindow\.maximized\}/, "host should render maximized child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:fullScreen=\{childWindow\.fullScreen\}/, "host should render full-screen child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:kiosk=\{childWindow\.kiosk\}/, "host should render kiosk child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginPanel.css"), /\.plugin-browser-window\.maximized,\s+\.plugin-browser-window\.kiosk,\s+\.plugin-panel \.plugin-browser-window\.fullScreen \{\s+position: absolute;\s+inset: 0;/, "hosted kiosk browser windows should fill the hosted layer");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:flashing=\{childWindow\.flashing\}/, "host should render attention-flashing child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:noShadow=\{!childWindow\.hasShadow\}/, "host should render shadowless child browser windows");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class:windowButtonsHidden=\{!childWindow\.windowButtonVisible\}/, "host should render hidden traffic-light state");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /plugin-browser-window-progress/, "host should render hosted child browser-window progress state");
assert.match(await readPanelHostSource(root, "src/lib/pluginDesktopSmokeBridgeSource.ts"), /function pluginBridgeJson\(/, "bridge JSON injection should escape script-close sequences");
assert.match(await readPanelHostSource(root, "src/lib/pluginDesktopSmokeBridgeSource.ts"), /PLUGIN_SCRIPT_CLOSE_RE/, "bridge JSON injection should not write raw </script> into inline payload data");
assert.match(await readPanelHostSource(root, "src/components/PluginBrowserWindowLayer.svelte"), /class="plugin-browser-window"/, "host should render a visible child browser-window shell");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts"]), /createBrowserWindow unsupported/, "createBrowserWindow should no longer be a fixed unsupported path");
assert.doesNotMatch(await readPanelHostSources(root, ["src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts"]), /sendToParent unsupported/, "sendToParent should no longer be a fixed unsupported path");
assert.match(appSource, /pluginHostSmoke\s*===\s*"browserWindow"/, "Web preview smoke should expose a browser-window scenario");
assert.match(appSource, /browserWindowSrcdoc/, "browser-window smoke should provide child iframe HTML");
assert.match(appSource, /browser-window-send/, "browser-window smoke should include a child sendToParent control");
assert.match(appSource, /__atoolsBrowserWindowSmoke/, "browser-window smoke should retain the created handle");
assert.match(
  appSource,
  /function expectHostedBrowserWindowUnsupported\(marker, invoke\)/,
  "browser-window preview smoke should keep a reusable isolation-error continuation helper",
);
for (const marker of [
  "inspect-element",
  "capture-page",
  "print-to-pdf",
  "save-page",
  "insert-text",
  "edit-select-all",
  "edit-copy",
  "edit-cut",
  "edit-paste",
  "selection-center",
  "selection-adjust",
  "selection-scroll-bottom",
  "selection-scroll-top",
]) {
  assert.match(
    appSource,
    new RegExp(`['\"]${marker}['\"]`),
    `browser-window preview smoke should explicitly continue after ${marker} isolation errors`,
  );
}

  Object.assign(fixture, {appSource});
}
