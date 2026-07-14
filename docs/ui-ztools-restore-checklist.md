# ZTools UI Restore Checklist

## Batch 384 Current Delta

- Main and hosted BrowserWindow iframes now share the opaque sandbox `allow-scripts allow-popups`; neither surface grants `allow-same-origin`.
- Main-plugin invoke is deny-by-default, binds the active `WindowProxy` source and generation, rebuilds allowed arguments, and forces the active plugin ID before invoking Tauri.
- Hosted children are no longer inspected or edited through host DOM access. Each child receives a dedicated `MessageChannel` with a fixed RPC allowlist: `describe`, `executeJavaScript`, `sendInputEvent`, `insertCSS`, `removeInsertedCSS`, `findInPage`, and `stopFindInPage`.
- `inspectElement`, `capturePage`, `printToPDF`, `savePage`, 12 edit APIs, and 4 selection/scroll APIs—20 APIs total—now fail explicitly with `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED`; `print()` reports an explicit native-only callback failure.
- The final queue-gated `pnpm smoke:tauri-desktop` run at `2026-07-10T13:20:34Z` passed BrowserWindow isolation at 1/1/1 expected/reported/passed samples and 9/9 checks, with all nine contract booleans true, including opaque origin, unavailable self/parent Tauri paths, blocked parent document, IPC, and cleanup.
- Plugin database replacement is now atomic without `REPLACE` on `plugins` or `plugin_data`; attachment/data retention, atomic metadata/features, and pre-disable of an existing marketplace plugin are implemented and verified.
- Current first priorities are the fixed install directory's remove-before-copy/non-transactional filesystem failure mode, source/destination symlink and ZIP quota hardening, recoverable uninstall/concurrency, and the plugin-market unsigned/untrusted trust-anchor fail-open path.

> Historical BrowserWindow batches that described same-origin DOM inspection, capture/export, editing, or selection control as successful are retained as chronology but are superseded by the Batch 384 security boundary above.

## Current Checklist

- [x] Empty/home state: import entry visible, no marketing hero, compact command-center feel, and pinned/recent command sections.
- [x] Search results: dense rows, keyboard selection visible, source metadata readable, selected-row `Enter` action chip, and split `↑` / `↓` status hints.
- [x] Settings navigation: menu includes ZTools parity entries `HTTP 服务` and `关于`.
- [x] Settings general: hotkey quick presets, custom theme color, current-window wakeup blacklist entry.
- [x] Settings shortcuts: three-tab structure, built-in app shortcuts, and command alias empty/list states.
- [x] Settings all commands: source groups, summary cards, target filters, alias entry points, command pinning, and local/web enable toggles.
- [x] Settings unsupported states: GPU switch clearly marked unavailable instead of exposed as a fake toggle.
- [x] Settings general: super panel can be saved, creates a real transparent always-on-top desktop window, reads clipboard text, and opens the main search window.
- [x] Settings general: floating ball can be saved, creates a real transparent always-on-top desktop window, and clicking it opens the main search window.
- [x] Settings general: network proxy accepts http/https proxy URLs and is used by WebDAV sync/restore clients and AI model connection tests.
- [x] Settings general: DevTools position preference is saved and can open the main Tauri window DevTools through a desktop command.
- [x] Settings general/market: custom plugin market address accepts http/https URLs, is shown on the plugin market page, and can be opened through the desktop shell-open command while signature verification stays deferred.
- [x] Settings market: custom plugin market address can fetch and display a remote JSON catalog, and catalog rows can install or update http/https ZIP plugins through a safe desktop download/staging flow while signature verification remains deferred.
- [x] Settings HTTP/About: no blank placeholders; HTTP points to MCP, About shows local-first product facts, runtime paths, and diagnostic actions.
- [x] Import panel: candidates, warnings/errors, selected count, report all visible.
- [x] Plugin host: titlebar, runtime strip, subInput, iframe, output layer do not overlap.
- [x] Plugin host: output rows expose a right-click `复制结果` menu, reuse the same copy helper as click/Enter, and `Esc` closes the menu without leaving plugin mode.
- [x] Plugin host: iframe `contextmenu` events are observed without cancelling plugin handlers, reported to the host, and surfaced as a `右键菜单` runtime chip.
- [x] Plugin host: entry HTML resource preparation handles `main_url` subdirectories, relative scripts/stylesheets, stylesheet `url(...)` / `@import`, `srcset`, link icon/modulepreload, and common image/media URLs instead of relying on broken `srcdoc` relative resolution.
- [x] Plugin host: runtime resource bridge resolves dynamically inserted common image/media/script/link resource attributes through the parent host instead of leaving all post-load relative URLs broken in `srcdoc`.
- [x] Plugin host: runtime CSS resource bridge resolves dynamically inserted `<style>` text and inline `style` attribute `url(...)` / string `@import` resources through the parent host.
- [x] Plugin host: runtime CSSOM bridge patches `CSSStyleSheet.insertRule()` so dynamically inserted stylesheet rules can resolve local CSS resources after insertion.
- [x] Plugin host: runtime pre-insertion bridge defers local dynamic `<script src>` and `<link href>` DOM insertion until the parent host resolves the resource URL.
- [x] Desktop smoke: validates one real indexed plugin activation entry, plugin path, main entry, preload check, and ZTools-height cap.
- [x] Desktop smoke: validates plugin data bridge roundtrip, bulk docs, attachment readback, and temporary data cleanup.
- [x] Desktop smoke: validates safe native bridge surfaces for system path lookup and shell-open target classification without opening external resources.
- [x] Desktop smoke: validates copyFile/copyImage missing-path bridge calls return explicit errors instead of silent success.
- [x] Desktop smoke: validates shellShowItemInFolder missing-path bridge calls return an explicit method-scoped error instead of silent success.
- [x] Desktop smoke: validates getCopyedFiles returns a real file path list, an empty list, or an explicit method-scoped error instead of silent success.
- [x] Plugin host: `getCopyedFiles` / `getCopiedFiles` normalize plugin-facing clipboard file results to the official `CopiedFile[]` object shape instead of leaking raw path strings.
- [x] Desktop smoke: validates screenCapture returns an explicit no-side-effect smoke guard instead of launching interactive screenshot UI.
- [x] Desktop smoke: validates plugin dialog bridge guard env reaches the plugin host so automated smoke does not launch interactive open/save panels.
- [x] Plugin host: `setFeature` / `removeFeature` / `getFeatures` maintain an in-memory dynamic feature registry instead of silently pretending success.
- [x] Plugin host: `redirectHotKeySetting(cmdLabel[, autocopy])` and `redirectAiModelsSetting()` expose the official dynamic feature settings redirect surface, leave plugin mode, and open the matching local settings page instead of missing APIs or fake success.
- [x] Plugin host: `removeSubInput` clears the host SubInput state and blurs the rendered input instead of leaving stale plugin input visible.
- [x] Plugin host: `subInputFocus` / `subInputBlur` notify the host and focus or blur the rendered SubInput instead of silently resolving.
- [x] Plugin host: `subInputSelect` notifies the host and selects the rendered SubInput text instead of leaving selection behavior missing.
- [x] Plugin host: `simulateKeyboardTap` routes through the native bridge and returns an explicit method-scoped unsupported error instead of silent success.
- [x] Plugin host: `registerTool` registrations are tracked by the host and surfaced in the runtime strip instead of disappearing into an invisible success.
- [x] Plugin host: `setExpendHeight` / `setExpandHeight` requests are clamped, tracked by the host, and surfaced in the runtime strip instead of silently disappearing.
- [x] Plugin host: `hideMainWindow` / `showMainWindow` route through explicit host lifecycle messages and native main-window commands instead of a close-only null result.
- [x] Plugin host: `getWindowType` / `findInPage` / `stopFindInPage` cover the non-destructive official window inspection and in-plugin page search surface instead of exposing missing methods.
- [x] Plugin host: `getNativeId` / `getAppName` / `getAppVersion` / `isDev` / `isLinux` cover low-risk system identity and platform compatibility calls instead of leaving common environment probes undefined.
- [x] Plugin host: `getUser` / `fetchUserServerTemporaryToken` expose the official user API surface with local-only null user state and explicit native-only token errors instead of missing APIs or fake token data.
- [x] Plugin host: `startDrag(filePath)` exposes the official window drag API surface and returns an explicit native-only unsupported error in the current WebView host instead of a missing API or fake success.
- [x] Plugin host: `isDarkColors()` exposes the official window theme probe using the web-native dark color-scheme media query with a safe boolean fallback instead of throwing when media query support is unavailable.
- [x] Plugin host: `redirect(label[, payload])` exposes the official window redirect API, routes through host feature search, activates a unique target with payload, and returns explicit invalid/ambiguous/not-found/unsupported errors instead of fake success.
- [x] Plugin host: `createBrowserWindow(url[, options][, callback])` creates an opaque hosted child iframe with sandbox `allow-scripts allow-popups`. Parent/child IPC remains available through `webContents.send()` / `ipcRenderer` / `sendToParent()`, while child execution, input, CSS, and find operations use a dedicated per-child `MessageChannel` restricted to `describe`, `executeJavaScript`, `sendInputEvent`, `insertCSS`, `removeInsertedCSS`, `findInPage`, and `stopFindInPage`; the host never regains same-origin DOM access.
- [x] Plugin host: BrowserWindow hosted `webContents.loadURL(url[, options])`, `reload()`, `stop()`, `isDestroyed()`, and `getType()` now expose the low-risk Electron navigation/lifecycle surface on the child iframe handle, update hosted URL/history/loading state, preserve `stop()` void-return semantics, and report hosted type `"window"` instead of missing methods.
- [x] Plugin host: BrowserWindow hosted `webContents.isCrashed()` and `forcefullyCrashRenderer()` now expose the low-risk Electron crash lifecycle surface with hosted crash state, targeted `render-process-gone` event details, and reload-based recovery instead of missing APIs or crashing the real WebView.
- [x] Plugin host: BrowserWindow hosted `webContents.focus()`, `isFocused()`, `getOwnerBrowserWindow()`, `getMediaSourceId()`, `isBeingCaptured()`, and `setIgnoreMenuShortcuts(ignore)` now expose the low-risk Electron focus/owner/media/shortcut state surface with hosted synchronous cache updates and host action routing instead of missing APIs.
- [x] Plugin host: BrowserWindow hosted `webContents.navigationHistory` now exposes `canGoBack()`, `canGoForward()`, `goBack()`, `goForward()`, `goToIndex(index)`, `canGoToOffset(offset)`, `goToOffset(offset)`, and `clear()` on the hosted child iframe history stack instead of leaving the current Electron navigationHistory surface missing.
- [x] Plugin host: BrowserWindow hosted `webContents.isWaitingForResponse()` and BrowserWindow `setBackgroundColor()` / `getBackgroundColor()` now expose low-risk waiting-response and background-color state on the hosted child iframe shell, including synchronous `#RRGGBB` color cache updates instead of missing methods.
- [x] Plugin host: BrowserWindow hosted `webContents.insertText(text)` plus `undo` / `redo` / `cut` / `copy` / `paste` / `pasteAndMatchStyle` / `delete` / `selectAll` / `unselect` / `replace` / `replaceMisspelling` retain compatibility methods, but all 12 now reject with `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED` under the opaque child boundary instead of editing child DOM or maintaining a fake local clipboard.
- [x] Plugin host: BrowserWindow hosted `webContents.centerSelection()`, `scrollToTop()`, `scrollToBottom()`, and `adjustSelection({ start, end })` retain compatibility methods, but all 4 now reject with `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED` instead of reading selection or scrolling the opaque child document from the host.
- [x] Plugin host: BrowserWindow hosted `webContents.setZoomFactor()`, `getZoomFactor()`, `setZoomLevel()`, `getZoomLevel()`, and `setVisualZoomLevelLimits()` now expose hosted zoom state, synchronous factor/level getter updates, visual zoom limit routing, and child iframe CSS scale rendering.
- [x] Plugin host: BrowserWindow hosted `webContents.setAudioMuted()`, `isAudioMuted()`, and `isCurrentlyAudible()` now expose hosted muted/audible state, synchronous getter updates, and targeted `audio-state-changed` events with both `event.audible` and the boolean listener argument.
- [x] Plugin host: BrowserWindow hosted `setBounds()` / `setSize()` / `setPosition()` / `center()` now dispatch hosted `resize` / `move` geometry events, including `on()` and one-shot `once()` listener compatibility.
- [x] Plugin host: BrowserWindow hosted `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` now expose the low-risk Electron menu-bar state surface on the hosted child iframe handle, including void-return setter shape and synchronous menu visibility cache updates instead of missing methods.
- [x] Plugin host: BrowserWindow hosted `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` now expose the current macOS titlebar/material state surface on the hosted child iframe handle, including `setWindowButtonPosition(null)` reset semantics instead of missing methods or deprecated traffic-light APIs.
- [x] Plugin host: BrowserWindow hosted `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` now expose the current window document and parent/child relationship state surface on the hosted child iframe handle instead of missing methods.
- [x] Plugin host: `getFileIcon(filePath)`, `shellTrashItem(path)`, `shellBeep()`, `isMacOS()`, and `isWindows()` cover the official system/shell compatibility surface with a stable icon data URL fallback, macOS Finder move-to-Trash routing, native beep routing, and platform booleans instead of missing APIs or fake trash success.
- [x] Plugin host: `screenCapture(callback)` follows the official callback bridge shape, `desktopCaptureSources(options)` returns a primary screen compatibility source list, and `screenColorPick(callback)` uses the WebView EyeDropper path when available while returning an explicit unavailable error instead of a missing API, fake success, or fixed unsupported.
- [x] Plugin host: `hideMainWindowPasteText(text)`, `hideMainWindowPasteImage(image)`, and `hideMainWindowPasteFile(file)` write text/image/file clipboard payloads, hide the main window, and trigger macOS paste; `hideMainWindowTypeString(text)` hides the main window and types through macOS System Events instead of missing APIs, fake success, or explicit unsupported errors.
- [x] Plugin host: display read APIs and DIP/screen coordinate conversion helpers cover the official no-side-effect screen information surface instead of leaving common layout probes undefined.
- [x] Plugin host: `readCurrentBrowserUrl()`, `getCurrentBrowserUrl()`, and `readCurrentFolderPath()` expose the current browser/Finder context API surface through the iframe native bridge, with `getCurrentBrowserUrl` included in the shared runtime capability inventory.
- [x] Plugin host: `onDbPull` registers database pull callbacks and dispatches host DB-pull payloads to plugin code instead of dropping the official event.
- [x] Plugin host: `onMainPush(callback, onSelect)`, `onPluginDetach(callback)`, and `onPluginOut(isKill)` expose the official event API surface instead of leaving lifecycle/main-push callbacks missing or argumentless.
- [x] Plugin host: host back, iframe close, Web preview close, and destroy fallback dispatch `atools-plugin-out` to registered `onPluginOut` callbacks with `isKill:false` for normal exit and `isKill:true` for destroy fallback instead of dropping plugin cleanup hooks.
- [x] Plugin host: the titlebar `分离` action is enabled and dispatches `atools-plugin-detach` to registered `onPluginDetach` callbacks once per active plugin owner instead of remaining a dead disabled control.
- [x] Plugin host: `db.allDocs(idStartsWith)` and `db.allDocs(ids)` now follow the official prefix and ID-list filtering semantics instead of ignoring arguments and returning every plugin document.
- [x] Plugin host: `db.getAttachmentType` and `db.replicateStateFromCloud` cover the remaining local DB attachment metadata and cloud-state compatibility surface instead of exposing missing methods.
- [x] Plugin host: `dbStorage.setItem` / `getItem` / `removeItem` provide a synchronous plugin-scoped key/value bridge instead of leaving common storage calls undefined.
- [x] Plugin host: runtime bridge chip is backed by a shared uTools/ZTools capability inventory and shows DB, events, clipboard, input, dialog, window, system, user, and context groups.
- [x] Plugin host: missing runtime API permissions trigger an in-host per-API prompt; approving grants the exact permission for the current session and denying rejects the original bridge call before native commands run.
- [x] Plugin host: runtime per-API permission prompts can persist exact grants through `始终允许`, reload persistent grants per plugin, and expose those grants in Settings plugin audit with a clear action.
- [x] Plugin host: runtime script/link resource preflight covers `appendChild`, `insertBefore`, `append`, `prepend`, `before`, `after`, and `replaceWith` so common dynamic local script/stylesheet insertion waits for host URL conversion before entering the DOM.
- [x] Plugin host: static plugin HTML resource preparation honors local `<base href>` so script/style/img/icon/srcset/CSS URLs resolve from the declared base directory instead of only `main_url`.
- [x] Plugin host: runtime resource bridge honors the current local `<base href>` marker so post-load dynamic img/srcset/CSS/script/link resources resolve from the declared base directory instead of falling back to `main_url`.
- [x] Plugin host: runtime resource bridge prefers a live local `<base href>` over the static marker when plugins change base href after load.
- [x] Desktop smoke: validates plugin context bridge browser/Finder reads return a real value, an explicit empty result, or an explicit platform/osascript error.
- [x] Desktop smoke: auto-opens one real indexed Tauri PluginPanel and requires `plugin_panel_render_smoke` to report filesystem `srcdoc` loading, empty iframe `src`, no load error, and nonzero HTML bytes.
- [x] Desktop smoke: when `ATOOLS_ZTOOLS_ACTIVATION_PLAN` is set, queues renderable external activation-plan PluginPanel actions, records aggregate expected/reported/rendered sample counts, and requires current external plan render samples to load through real Tauri filesystem `srcdoc`.
- [x] Desktop smoke: injects a smoke-only iframe bridge probe into real Tauri PluginPanel `srcdoc`, waits for per-sample `utools/ztools` bridge results, and requires all indexed/external render samples to pass object alias, window type, app identity, dbStorage, and platform flag checks.
- [x] Desktop smoke: extends the real Tauri PluginPanel iframe probe to execute no-side-effect native/system bridge methods per render sample, requiring `getPath("home")`, `desktopCaptureSources({ types:["screen"] })`, browser context, and Finder context calls to return valid values or explicit method-scoped error semantics.
- [x] Desktop smoke: scopes Tauri shell execution for `osascript -e <script>` so context/shell bridges no longer fail at Tauri capability lookup, and sizes iframe bridge-probe waits by `srcdoc` bytes so large external plugin entries are not marked failed by an undersized fixed timeout.
- [x] Settings plugins: imported plugins can be uninstalled through an in-page destructive confirmation; builtin plugins remain non-uninstallable and can only be disabled.
- [x] Settings plugins: plugin detail `打开目录` is a real action that locates the plugin path through the native `shell_show_item_in_folder` bridge.
- [x] Settings plugins: top-level `安装插件` opens a desktop directory picker for a folder containing `plugin.json`, calls native `install_plugin`, refreshes the installed inventory, and reports desktop-only status in Web preview.
- [x] Settings plugins: plugin detail `插件权限` opens a read-only manifest capability audit covering main/preload, feature command matches, Agent tools, and local data boundaries.
- [x] Settings plugins: imported plugin detail `更新插件` opens a desktop directory picker, calls native `update_plugin_from_path`, validates the selected directory is the same plugin ID, preserves enable state, and rejects updating from the installed plugin directory.
- [x] Desktop smoke: validates filtered audit JSONL export only returns the current filtered Agent/MCP audit scope and cleans temporary audit rows.
- [x] Agent/MCP audit history supports paged total/offset queries, status/tool/client timestamp indexes, loaded/total display, and a load-more Agent panel action.
- [x] Agent/MCP audit filters can be saved as local named views, reapplied, deleted, and remain visible even when the current audit result set is empty.
- [x] Settings data page exposes an audit retention policy and calls the native audit prune command to remove records older than 90 days while retaining the latest 1000 entries.
- [x] Agent/MCP whitelist syncs enabled plugin manifest `tools` as `plugin_<plugin>_<tool>` entries, keeps them disabled by default, exposes them only after user enablement, and prunes them when the plugin is disabled or uninstalled.
- [x] Agent/MCP plugin manifest tools can execute synchronous plugin runtime handlers registered through `utools.registerTool`, with explicit errors for missing handlers instead of falling through to the builtin-only executor path.
- [x] Agent/MCP plugin manifest tools can now await async/Promise handlers, including handlers that await plugin IPC APIs such as `utools.dbStorage`, with timeout/rejection errors surfaced through the Agent tool result.
- [x] Agent/MCP plugin manifest tools lazy-load the plugin preload when the runtime context is missing, reject preload paths outside the plugin directory, and can execute registered handlers before the plugin UI has been opened.
- [x] Real ZTools plugin compatibility regression has a read-only report script that scans external plugin manifests, validates main/preload/logo/platform/cmd-type coverage, records duplicate feature codes, and writes a JSON baseline for follow-up runtime checks.
- [x] Real ZTools plugin runtime sample candidates are now reportable from external plugin manifests, entry HTML resources, preload risk signals, and a ranked JSON sample list for follow-up desktop activation smoke.
- [x] Real ZTools plugin activation smoke plans can now be generated from the ranked external sample pool, including install source, expected plugin ID, feature trigger, assertions, and cleanup steps for follow-up desktop automation.
- [x] Desktop smoke can consume a real ZTools external activation plan through `ATOOLS_ZTOOLS_ACTIVATION_PLAN`, import samples into a smoke install root, verify feature activation lookup and main/preload assertions, skip feature-code collisions, and clean up imported plugin files/DB rows.
- [x] Desktop smoke external ZTools activation plan now validates the `FeatureAction` payload that drives `PluginPanel`, including plugin path, main URL, optional preload path, and capped expand height.
- [x] Desktop smoke external ZTools activation plan now validates the real `PluginPanel` filesystem load spec for imported plugins, including canonical plugin directory match, relative main file inside the plugin directory, optional preload inside the plugin directory, and no Web preview `iframeSrc/srcdoc` payload.
- [x] Real ZTools external activation plans can now be converted into a UI host smoke report with desktop `FeatureAction` fixtures, Web preview `externalPlan` URLs, iframe-ready probes, bridge probes, and screenshot viewport expectations.
- [x] PluginPanel can now receive externalPlan iframe probe results and surface a host runtime chip showing recovered bridge/lifecycle probe status.
- [x] Real ZTools UI host smoke report now records per-sample real entry HTML readiness, absolute entry path, byte size, SHA-256, entry directory, and resource signals without copying third-party HTML into Web preview fixtures.
- [x] Real ZTools UI host smoke report now resolves and verifies per-sample local entry script and stylesheet dependencies, recording ready/missing counts, byte sizes, paths, and SHA-256 hashes.
- [x] Real ZTools UI host smoke report can now emit browser-loadable real entry HTML fixtures with local scripts/stylesheets inlined and a DOM-readable bridge/lifecycle probe; the first generated fixture has been rendered through a local HTTP Browser check.
- [x] Real ZTools UI host smoke report now emits a browser matrix harness for all generated real entry fixtures, copies runtime support chunks/JSON, widens fixture bridge/preload stubs, and Browser verifies 10/10 fixture pages ready with 0 script errors.
- [x] PluginPanel Web preview can now load generated real entry fixtures through iframe `src`, consume their real-entry fixture probe and bridge API probe messages, and show `宿主探针 15/15`; the first real fixture has been verified through the actual PluginPanel shell.
- [x] Real ZTools UI host smoke report now emits a PluginPanel matrix harness that embeds all 10 app `PluginPanel` preview URLs and Browser verifies 10/10 PluginPanel iframes ready with `passed=6/6`.
- [x] Real ZTools PluginPanel matrix validation now uses a CORS/OPTIONS fixture server, copies CSS `@import`/`url()` font assets, injects sandbox-safe storage stubs, and Browser verifies 10/10 PluginPanel iframes ready with console 0 warn/error.
- [x] Real ZTools generated real-entry fixtures now replay 9 in-browser bridge API probes per fixture, record 90 bridge API probe checks in the smoke report, and Browser verifies standalone matrix rows with `bridgeApi=9/9` plus PluginPanel matrix rows with `passed=15/15`.
- [x] Desktop smoke: validates MCP `resources/templates/list` discovery returns an empty protocol list instead of a method-not-found error.
- [x] Desktop smoke: validates MCP built-in resource discovery and `resources/read` return the `atools://agent/tools` tool catalog resource.
- [x] Desktop smoke: validates MCP built-in prompt discovery and `prompts/get` return the `atools_agent_tool_guide` catalog entry and task-tailored prompt message.
- [x] Desktop smoke: validates MCP JSON-RPC batch requests return only request responses while omitting initialized notification responses.
- [x] Desktop smoke: validates id-less MCP JSON-RPC notifications return no response and do not silently execute `tools/call`.
- [x] MCP client templates can safely merge into a user-selected JSON config file, backing up existing files and replacing only `mcpServers.atools`.
- [x] MCP client install plans suggest known default config paths for Claude Desktop and Cursor, and desktop smoke tolerates transient cold-start MCP HTTP `WouldBlock` reads.
- [x] Agent tool `ask_ai_model` successful-call audit entries preserve the prompt and assistant output while excluding the configured AI API Key from persisted audit JSON.
- [x] Agent tool `compress_images` supports explicit `format: "webp"` output with lossless WebP encoding, `.webp` output paths, and MCP schema exposure.
- [x] Agent tool `find_local_files` supports `ignore_dirs`, `max_depth`, permission-denied skip accounting, and `ignore_patterns` wildcard filters for filenames and relative paths such as `*.tmp` and `generated/**`.
- [x] Agent tool `get_current_context` attempts the shared command-layer current browser URL bridge and returns either a real URL or an explicit unavailable/error reason.
- [x] Agent tool `get_current_context` reuses the shared command-layer Finder folder bridge, including the desktop fallback when Finder has no open windows.
- [x] Desktop smoke: validates denied high-risk scope policy overrides developer mode and records a denied audit for `open_or_reveal_path`.
- [x] Desktop smoke: validates Agent tool enable/disable toggles persist to the database and are restored after smoke.

## Current Completion

- Built-in program UX parity: **96%**
- Settings shell and navigation: **89%**
- Settings page functional parity: **99%**
- Home/search experience: **89%**
- Plugin install/import/market: **99%**
- Plugin iframe host parity: **99%**
- Plugin runtime parity: **99%**
- Agent/MCP local foundation: **99%**
- macOS smoke checklist closure: **283/290 (97.6%)**

## Latest Batch

### Batch 384: Plugin Iframe And Hosted BrowserWindow Isolation

Completed:

- Removed same-origin capability from both main and hosted child iframe sandboxes; both now use only `allow-scripts allow-popups`.
- Made main iframe invokes deny-by-default with source/generation validation, rebuilt arguments, and forced active plugin identity.
- Replaced hosted-child DOM access with a dedicated `MessageChannel` and seven-method RPC allowlist.
- Converted 20 DOM-dependent inspect/capture/export/edit/selection APIs to the stable `ERR_HOSTED_BROWSERWINDOW_ISOLATED_UNSUPPORTED` boundary; kept `print()` as an explicit native-only callback failure.
- Added a first-sample-only real desktop isolation probe covering opaque origin, unavailable raw Tauri paths, blocked parent document, sendToParent, executeJavaScript, IPC roundtrip, and verified host cleanup.
- Removed database `REPLACE` writes for `plugins` and `plugin_data`; metadata/features now update atomically while plugin data and attachments remain retained, and marketplace update pre-disable behavior is verified.

Verification:

- `pnpm test:desktop-browser-window-isolation-probe`
- `pnpm test:plugin-invoke-policy`
- `pnpm test:hosted-browser-window-isolation`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop` — final queue-gated run passed at `2026-07-10T13:20:34Z`, BrowserWindow expected/reported/passed 1/1/1 samples, 9/9 checks, all nine booleans true.

Completion:

- Security semantics changed without changing checklist completion: **283/290 (97.6%)**.

Remaining boundary:

- The fixed install directory still uses remove-before-copy/non-transactional filesystem mutation, so failed copy can leave missing or partial bytes; symlink/ZIP quotas, recoverable uninstall, install/update/uninstall concurrency, and plugin-market unsigned/untrusted trust anchors remain open. Signing, notarization, updater, and the seven existing manual smoke rows also remain open.

### Batch 383: Transactional Native Settings And Safe Desktop System Smoke

Completed:

- Made global-hotkey changes transactional: the native layer registers the requested shortcut before unregistering the exact previous shortcut, compensates on failure, and receives `previousShortcut` explicitly across IPC for both forward and rollback calls.
- Made Settings saves transactional and ordered: native operations compensate partial failures, database persistence precedes the local cache, persistence failure rolls native state back, and one coordinator serializes rapid revisions against the last successful snapshot.
- Added a flushable settings debouncer so closing Settings during the 160 ms debounce window persists the latest pending snapshot exactly once through the same coordinator instead of dropping it.
- Hardened the production macOS LaunchAgent command with symlink rejection, same-directory atomic replacement, ordered `launchctl` operations, and compensation for bootstrap, bootout, and file failures.
- Extended desktop system smoke with observed main-window centering and transactional hotkey replacement/restore, while removing all writes to the real `~/Library/LaunchAgents` path and retaining only temporary-directory plist coverage.
- Made every declared required boolean in permission, data/debug, system-settings, plugin-runtime, and plugin-render smoke sections require the literal value `true`.
- Marked only the two automated system assertions as complete: main-window centering and new-hotkey/old-hotkey registration state. Real keystroke replay, tray visibility, real user LaunchAgent mutation, and Gatekeeper remain manual/release boundaries.

Verification:

- `pnpm test:settings-native-save`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm test:tauri-desktop-smoke-launch-agent-safety`
- `pnpm check`
- `cargo fmt --all -- --check`
- `cargo test --workspace`
- `pnpm smoke:tauri-desktop`

Completion:

- Reconciled the stale summary against the checklist's actual pre-batch count, then advanced macOS smoke checklist closure: **281/290 (96.9%) -> 283/290 (97.6%)**.

Remaining boundary:

- Seven rows remain open: actual `Option+Z` keypress/window toggling, tray icon visible/hidden observation, real user LaunchAgent create/delete, the aggregated third-party timestamp/plugin side-effect replay row, and Gatekeeper/signing-notarization validation.

### Batch 382: Desktop Plugin Runtime Smoke Binding

Completed:

- Added `pnpm test:desktop-plugin-runtime-smoke-binding` to bind the desktop plugin runtime smoke row to concrete evidence.
- Verified plain Web preview plugin-host bootstrap returns `null` unless `pluginHostSmoke` is present, so `?parity=1` does not synthesize/search real plugins.
- Verified desktop smoke `status:"ok"` requires both `plugin_runtime_smoke.ok()` and `plugin_panel_render_smoke.ok()`.
- Verified parser fixtures reject missing real plugin activation/render fields such as `plugin_runtime_smoke.feature_activated`, `plugin_runtime_smoke.plugin_path_exists`, `plugin_panel_render_smoke.fs_load`, and `plugin_panel_render_smoke.iframe_srcdoc_loaded`.
- Marked the macOS smoke row for automated real desktop PluginPanel FS render coverage complete.

Verification:

- `pnpm test:desktop-plugin-runtime-smoke-binding`

Completion:

- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **276/290 (95.2%) -> 277/290 (95.5%)**

Remaining boundary:

- This closes the automated desktop smoke binding for at least one indexed plugin runtime and FS PluginPanel render, not exhaustive third-party plugin visual replay, side-effecting native bridge replay, signing, notarization, auto-update, tray/global hotkey manual checks, or first-launch release checks.

### Batch 381: Plugin Back To Search

Completed:

- Added `pnpm test:plugin-back-to-search` to lock the PluginPanel back button and App close wiring.
- Added an App-level `returnPluginToSearch()` reset path that clears plugin state, query/results, pasted intake state, remote search status, and returns the shell to the `home` search panel.
- Wired PluginPanel `onclose` and plugin-mode `Esc` to the shared back-to-search path.
- Marked the macOS smoke row for returning from plugin mode to search complete.

Verification:

- `pnpm test:plugin-back-to-search`

Completion:

- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **275/290 (94.8%) -> 276/290 (95.2%)**

Remaining boundary:

- This closes host-level plugin back-to-search state reset, not live desktop click replay, signing, notarization, auto-update, tray/global hotkey, or first-launch release checks.

### Batch 380: Builtin Color Plugin Output Binding

Completed:

- Added `pnpm test:builtin-color-plugin` to execute the builtin color preload in a VM-backed uTools stub.
- Verified color plugin manifest search triggers include `颜色`, `color`, `颜色转换`, and the HEX regex command.
- Verified plugin-enter HEX payload produces HEX/RGB/HSL output rows.
- Verified subInput RGB text produces HEX/RGB/HSL conversion rows, invalid text produces an unrecognized-color row, and empty subInput clears plugin output.

Verification:

- `pnpm test:builtin-color-plugin`

Completion:

- Built-in program UX parity: **96% -> 96%**
- macOS smoke checklist closure: **274/290 (94.5%) -> 275/290 (94.8%)**

Remaining boundary:

- This closes the builtin color plugin preload output behavior, not live search UI activation, plugin back-to-search behavior, signing, notarization, or auto-update items.

### Batch 379: Builtin JSON Plugin Output Binding

Completed:

- Added `pnpm test:builtin-json-plugin` to execute the builtin JSON preload in a VM-backed uTools stub.
- Verified JSON plugin manifest search triggers include `json`, `json格式化`, and `格式化json`.
- Verified plugin-enter payload and subInput text produce formatted and minified JSON output rows.
- Verified invalid JSON produces a `JSON 格式错误` output row with an error description, while empty subInput clears plugin output.

Verification:

- `pnpm test:builtin-json-plugin`

Completion:

- Built-in program UX parity: **96% -> 96%**
- macOS smoke checklist closure: **273/290 (94.1%) -> 274/290 (94.5%)**

Remaining boundary:

- This closes the builtin JSON plugin preload output behavior, not live search UI activation, color plugin output, plugin back-to-search behavior, signing, notarization, or auto-update items.

### Batch 378: ZTools Imported Feature Search Binding

Completed:

- Bound the imported ZTools feature search row into `cargo test -p atools --test ztools_import_tests imported_ztools_plugin_feature_can_be_searched`.
- Added backend assertions that a feature from an imported ZTools plugin is indexed into `db.all_features()`.
- Verified `atools_core::matcher::search_all()` can find that imported feature by command text with the imported plugin id and an exact match score.

Verification:

- `cargo test -p atools --test ztools_import_tests imported_ztools_plugin_feature_can_be_searched`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **272/290 (93.8%) -> 273/290 (94.1%)**

Remaining boundary:

- This closes the backend imported-feature search index/matcher binding, not live search UI activation, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 377: ZTools Imported Plugin Inventory Binding

Completed:

- Bound the imported ZTools plugin inventory row into `cargo test -p atools --test ztools_import_tests import_ztools_plugin_copies_directory_and_indexes_feature`.
- Added backend assertions that importing a valid ZTools plugin makes it visible through `db.list_plugins()`.
- Verified the imported inventory entry preserves plugin id/name, version, enabled state, and installed plugin path.

Verification:

- `cargo test -p atools --test ztools_import_tests import_ztools_plugin_copies_directory_and_indexes_feature`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **271/290 (93.4%) -> 272/290 (93.8%)**

Remaining boundary:

- This closes the backend imported-plugin inventory visibility binding, not live Settings panel refresh after import, plugin feature searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 376: ZTools Import Directory Picker Binding

Completed:

- Bound the local ZTools plugin directory selection row into `pnpm test:ztools-import-view`.
- Added source assertions that the import panel uses Tauri's directory picker with `{ directory: true, multiple: false }`.
- Added source assertions that canceling the picker returns before scanning, while a selected directory is passed as `root` to `scan_ztools_plugins`.
- Added source assertions that scan results preselect only candidates without errors and clear any stale import report after a fresh scan.

Verification:

- `pnpm test:ztools-import-view`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **270/290 (93.1%) -> 271/290 (93.4%)**

Remaining boundary:

- This closes the source-level local directory picker and scan binding, not live interactive dialog selection, imported plugin inventory/searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 375: ZTools Import Panel Shell Route Binding

Completed:

- Bound the ZTools import panel open row into `pnpm test:ztools-import-view`.
- Verified the home quick action `home:import-ztools` points to panel `import`.
- Verified `HomePanel` routes quick-action panel clicks through `onpanelchange`, `App.svelte` passes that panel into the active shell panel, and `SystemPanel` renders `ZToolsImportPanel` for `panel === "import"`.

Verification:

- `pnpm test:ztools-import-view`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **269/290 (92.8%) -> 270/290 (93.1%)**

Remaining boundary:

- This closes the source-level import panel shell route binding, not a live desktop click smoke, real folder selection, imported plugin inventory/searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 374: ZTools Import Report Checklist Binding

Completed:

- Bound the ZTools import report row into `pnpm test:ztools-import-view`.
- Verified report summary counts for imported/skipped/failed/total rows.
- Verified imported, skipped, and failed report rows preserve kind, title, detail, and path; failed rows display the explicit failure reason.
- Verified the import panel renders `导入报告`, imported/skipped/failed summary text, report row kind classes, row detail, and row path.

Verification:

- `pnpm test:ztools-import-view`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **268/290 (92.4%) -> 269/290 (92.8%)**

Remaining boundary:

- This closes the import report rendering binding, not opening the import panel from the live shell, real folder selection, imported plugin inventory/searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 373: ZTools Import Checkbox Selection Checklist Binding

Completed:

- Bound the ZTools import checkbox selection row into `pnpm test:ztools-import-view`.
- Verified blocked candidates remain unselected even if their path is present in the selected set.
- Verified selecting all importable candidates includes only selectable rows, clearing selection drops selected count to zero, and the panel source keeps disabled blocked checkboxes plus `全选可导入` / `清空选择` controls.

Verification:

- `pnpm test:ztools-import-view`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **267/290 (92.1%) -> 268/290 (92.4%)**

Remaining boundary:

- This closes the candidate checkbox selection binding, not real folder selection, import report result rendering, imported plugin inventory/searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 372: ZTools Import Candidate Summary Checklist Binding

Completed:

- Bound the ZTools import candidate summary/details row into `pnpm test:ztools-import-view`.
- Verified candidate summary counts for total/selectable/selected/warning/error and feature totals.
- Verified candidate rows expose title/subtitle, ready/warning/blocked status labels, selectable/selected state, warning/error messages, missing flags, status pills, summary chips, and selected-count import text.

Verification:

- `pnpm test:ztools-import-view`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **266/290 (91.7%) -> 267/290 (92.1%)**

Remaining boundary:

- This closes the candidate summary/details binding, not real folder selection, checkbox bulk selection behavior, import report result rendering, imported plugin inventory/searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 371: ZTools Import Empty State Checklist Binding

Completed:

- Bound the ZTools import unscanned empty-state row into `pnpm test:ztools-import-view`.
- Verified an empty import view reports zero candidates, zero selectable/selected/warning/blocked rows, zero features, no candidate rows, and the expected empty text.
- Verified the import panel only renders candidate summary/list/actions when `candidates.length > 0`, and only renders the import report when `reportView` exists.

Verification:

- `pnpm test:ztools-import-view`

Completion:

- Plugin install/import/market: **99% -> 99%**
- macOS smoke checklist closure: **265/290 (91.4%) -> 266/290 (91.7%)**

Remaining boundary:

- This closes the unscanned import-panel empty state binding, not real folder selection, candidate statistics/details, selectable checkbox behavior, import report result rendering, imported plugin inventory/searchability, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 370: Default Settings Restoration Checklist Binding

Completed:

- Bound the post-test default settings restoration row into `pnpm test:settings-normalization`.
- Verified the normalized defaults are theme `system`, primary color `purple`, home recent enabled, and recent rows `2`.
- Verified the settings reset action applies `DEFAULT_ATOOLS_SETTINGS` and persists the reset state.

Verification:

- `pnpm test:settings-normalization`

Completion:

- Settings shell and navigation: **88% -> 89%**
- macOS smoke checklist closure: **264/290 (91.0%) -> 265/290 (91.4%)**

Remaining boundary:

- This closes the default settings restoration checklist binding, not the real desktop window centering, global hotkey changeover, tray visibility, LaunchAgent behavior, plugin import flow, JSON/color plugin flows, signing, notarization, or auto-update items.

### Batch 369: Plugin Host Layout Exclusivity Checklist Binding

Completed:

- Bound the plugin host layout exclusivity row into `pnpm test:plugin-host-smoke-browser` and `pnpm test:plugin-iframe-context-menu`.
- Extended the output-layer Browser smoke to require one output layer, no iframe body, no header/runtime/SubInput/body overlap, and the output layer contained inside the plugin body.
- Extended the iframe-context Browser smoke to require iframe mode with no output rows, no output layer, no header/runtime/body overlap, and no horizontal overflow before and after iframe `contextmenu` reporting.

Verification:

- `pnpm test:plugin-host-smoke-browser`
- `pnpm test:plugin-iframe-context-menu`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **263/290 (90.7%) -> 264/290 (91.0%)**

Remaining boundary:

- This closes the PluginPanel output/iframe layout exclusivity checklist binding, not JSON/color plugin flows, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 368: Plugin Iframe Context Menu Checklist Binding

Completed:

- Bound the plugin iframe context-menu row into `pnpm test:plugin-iframe-context-menu`.
- Extended the iframe context-menu test from VM/source coverage to a real Browser smoke at `?parity=1&pluginHostSmoke=iframeContext`.
- Verified the smoke renders iframe mode with no output rows, right-clicking inside the iframe reaches the host, and the runtime strip surfaces `右键菜单 / iframe button` with the existing non-cancelling bridge path.

Verification:

- `pnpm test:plugin-iframe-context-menu`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **262/290 (90.3%) -> 263/290 (90.7%)**

Remaining boundary:

- This closes the iframe context-menu event-reporting checklist binding, not output/iframe layout row, JSON/color plugin flows, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 367: Plugin Output Context Menu Feedback Binding

Completed:

- Bound the plugin output context-menu row into `pnpm test:plugin-host-smoke-browser` and `pnpm test:plugin-output-context-menu`.
- Added Browser smoke coverage for right-clicking the selected timestamp output row, opening the `复制结果` menu, closing only that menu with `Esc`, keeping plugin mode active, clicking the menu command, and recording the copied value through the clipboard write path.
- Updated `PluginPanel` so successful output copying updates the local output layer to the existing `已复制` feedback row and keeps that feedback row selected.

Verification:

- `pnpm test:plugin-host-smoke-browser`
- `pnpm test:plugin-output-context-menu`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **261/290 (90.0%) -> 262/290 (90.3%)**

Remaining boundary:

- This closes the output-row context menu and copy feedback checklist binding, not iframe context-menu behavior, output/iframe layout row, JSON/color plugin flows, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 366: Plugin Timestamp Output Selection Checklist Binding

Completed:

- Bound the timestamp/date plugin output-selection row into `pnpm test:plugin-host-smoke-browser`.
- Added a checklist-line guard that requires the row to stay checked while continuing to name `输入时间戳/日期`, selectable plugin output rows, and `Enter 复制`.
- Kept the Web preview coverage for the timestamp fixture output rows, ArrowDown selection movement, selected-row `Enter 复制` hint, and runtime detail `方向键选择，Enter 复制`.

Verification:

- `pnpm test:plugin-host-smoke-browser`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **260/290 (89.7%) -> 261/290 (90.0%)**

Remaining boundary:

- This closes the timestamp/date output-selection checklist binding, not the output context menu row, iframe context-menu behavior, output/iframe layout row, JSON/color plugin flows, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 365: Plugin Copied Files Object Shape Checklist Binding

Completed:

- Bound the plugin-facing `getCopyedFiles` / `getCopiedFiles` object-shape row into `pnpm test:plugin-copied-files-shape`.
- Added checklist-line guards that require the row to stay checked and continue naming `CopiedFile[]`, `path`, `name`, `isFile`, and the official typo field `isDiractory`.
- Kept the existing VM coverage for path-list native results, object results with extra fields, corrected alias routing through the typo bridge method, injected bridge normalization, host path-output normalization, and shared capability inventory.

Verification:

- `pnpm test:plugin-copied-files-shape`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **259/290 (89.3%) -> 260/290 (89.7%)**

Remaining boundary:

- This closes the plugin-facing copied-files object-shape checklist binding, not plugin output interactions, iframe context-menu behavior, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 364: Plugin onPluginOut Lifecycle Checklist Binding

Completed:

- Bound the plugin host exit lifecycle row into `pnpm test:plugin-events-bridge`.
- Updated the event bridge test guard to match the current postMessage lifecycle implementation while still requiring `postPluginLifecycleEvent("plugin-out", { isKill })`, injected `atools-plugin-out`, host back, iframe `__ipc_close__`, Web preview close, and destroy fallback coverage.
- Added checklist-line guards that require the row to stay checked and continue naming `atools-plugin-out`, `isKill:false`, `isKill:true`, and `onPluginOut(callback)`.

Verification:

- `pnpm test:plugin-events-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **258/290 (89.0%) -> 259/290 (89.3%)**

Remaining boundary:

- This closes the plugin out lifecycle checklist binding, not copied-file object shape, plugin output interactions, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 363: BrowserWindow Document/Parent Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted BrowserWindow `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-document-parent-state="true"` and `data-browser-window-parent-child-state="true"` markers.
- Added App marker guards that keep the document/parent aggregate row tied to the existing titlebar/material, menu-bar, background-color, waiting-response, navigationHistory, focus/owner/media, crash-reload, lifecycle, runtime, load URL, render-process-gone, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **257/290 (88.6%) -> 258/290 (89.0%)**

Remaining boundary:

- This closes the hosted BrowserWindow document/parent aggregate row, not plugin out lifecycle, copied-file shape, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 362: BrowserWindow Titlebar/Material Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted BrowserWindow `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-titlebar-material-state="true"` marker.
- Added App marker guards that keep the titlebar/material aggregate row tied to the existing menu-bar, background-color, waiting-response, navigationHistory, focus/owner/media, crash-reload, lifecycle, runtime, load URL, render-process-gone, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **256/290 (88.3%) -> 257/290 (88.6%)**

Remaining boundary:

- This closes the hosted BrowserWindow titlebar/material aggregate row, not the following document aggregate row, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 361: BrowserWindow Menu-Bar Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted BrowserWindow `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-menu-bar-state="true"` marker.
- Added App marker guards that keep the menu-bar aggregate row tied to the existing background-color, waiting-response, navigationHistory, focus/owner/media, crash-reload, lifecycle, runtime, load URL, render-process-gone, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **255/290 (87.9%) -> 256/290 (88.3%)**

Remaining boundary:

- This closes the hosted BrowserWindow menu-bar aggregate row, not the following titlebar/document aggregate rows, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 360: BrowserWindow Waiting/Background Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted `webContents.isWaitingForResponse()` plus BrowserWindow `setBackgroundColor()` / `getBackgroundColor()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-webcontents-waiting-response="true"` and `data-browser-window-background-color="true"` markers.
- Added App marker guards that keep the waiting/background aggregate row tied to the existing navigationHistory, focus/owner/media, crash-reload, lifecycle, runtime, load URL, render-process-gone, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **254/290 (87.6%) -> 255/290 (87.9%)**

Remaining boundary:

- This closes the hosted WebContents waiting-response and BrowserWindow background-color aggregate row, not the following menu-bar/titlebar/document aggregate rows, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 359: BrowserWindow NavigationHistory Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted `webContents.navigationHistory.goToOffset(-1)` / `goForward()` / `clear()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-navigation-history="true"` marker.
- Added App marker guards that keep the navigationHistory aggregate row tied to the existing focus/owner/media, crash-reload, lifecycle, runtime, load URL, render-process-gone, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **253/290 (87.2%) -> 254/290 (87.6%)**

Remaining boundary:

- This closes the hosted WebContents navigationHistory aggregate row, not the following waiting-response/background-color, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 358: BrowserWindow WebContents Focus Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-webcontents-focus-state="true"` and `data-browser-window-webcontents-owner-media="true"` markers.
- Added App marker guards that keep the focus/owner/media aggregate row tied to the existing crash-reload, lifecycle, runtime, load URL, render-process-gone, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **252/290 (86.9%) -> 253/290 (87.2%)**

Remaining boundary:

- This closes the hosted WebContents focus/owner/media/shortcut aggregate row, not the following navigationHistory, waiting-response/background-color, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 357: BrowserWindow WebContents Crash Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted `webContents.isCrashed()` / `forcefullyCrashRenderer()` / targeted `render-process-gone` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-render-process-gone="true"`, `data-browser-window-webcontents-crash="true"`, and `data-browser-window-webcontents-crash-reload="true"` markers.
- Added App marker guards that keep the crash aggregate row tied to the existing lifecycle, runtime, load URL, capture/export, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **251/290 (86.6%) -> 252/290 (86.9%)**

Remaining boundary:

- This closes the hosted WebContents crash lifecycle aggregate row, not the following focus/owner/media, navigationHistory, waiting-response/background-color, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 356: BrowserWindow WebContents Lifecycle Aggregate Smoke Binding

Completed:

- Bound the incremental Web preview row for hosted `webContents.loadURL()` / `reload()` / `stop()` / `isDestroyed()` / `getType()` into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the row to stay checked and continue naming the `data-browser-window-webcontents-load-url="true"` and `data-browser-window-webcontents-lifecycle="true"` markers.
- Added App marker guards that keep the lifecycle aggregate row tied to the existing runtime, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top smoke evidence.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **250/290 (86.2%) -> 251/290 (86.6%)**

Remaining boundary:

- This closes the hosted WebContents load/reload/stop/isDestroyed/getType aggregate row, not the following crash lifecycle, focus/owner/media, navigationHistory, waiting-response/background-color, native detached BrowserWindow, side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update items.

### Batch 355: BrowserWindow Aggregate Web Preview Smoke Binding

Completed:

- Bound the aggregate `?parity=1&pluginHostSmoke=browserWindow` Web preview checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added checklist-line guards that require the aggregate row to stay checked and continue naming the key BrowserWindow/WebContents API clusters covered by the hosted smoke path.
- Added direct App smoke marker guards for the existing aggregate BrowserWindow flow: visibility, navigation, events, sizing, fullscreen, appearance cleanup, system state, attention/progress cleanup, IPC, executeJavaScript, input, CSS insert/remove, find-in-page, navigation/history, DevTools, inspect, capture/print/save, runtime state, edit/selection, audio, focus/owner/media, zoom, z-order, and always-on-top markers.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **249/290 (85.9%) -> 250/290 (86.2%)**

Remaining boundary:

- This closes the existing hosted Web preview aggregate BrowserWindow smoke row, not the remaining incremental WebContents lifecycle/crash/navigation-history rows, true native detached BrowserWindow behavior, complete side-effecting native bridge replay, full sandbox isolation, signing, notarization, or auto-update.

### Batch 354: BrowserWindow Document/Parent Smoke Binding

Completed:

- Bound the BrowserWindow hosted `isNormal()` / `isModal()` / `setDocumentEdited()` / `isDocumentEdited()` / `setRepresentedFilename()` / `getRepresentedFilename()` / `setParentWindow()` / `getParentWindow()` / `getChildWindows()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke `data-browser-window-document-parent-state` and `data-browser-window-parent-child-state` markers, including parent handle set/reset and child handle derivation.
- Verified bridge and host coverage for normal/modal state, document-edited and represented-filename synchronous getters, parent/child handle relationships, and `setParentWindow(null)` clearing the hosted relationship.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **248/290 (85.5%) -> 249/290 (85.9%)**

Remaining boundary:

- This closes hosted document/parent state compatibility smoke, not native macOS document proxy icons, dirty-dot integration, sheet/modal sessions, NSWindow parent/child lifetime, system-level window hierarchy destruction, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 353: BrowserWindow Titlebar/Material Smoke Binding

Completed:

- Bound the BrowserWindow hosted `setWindowButtonVisibility()` / `setWindowButtonPosition()` / `getWindowButtonPosition()` / `setVibrancy()` / `setBackgroundMaterial()` / `setSheetOffset()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke `data-browser-window-titlebar-material-state` marker and its combined void-return plus sync `getWindowButtonPosition()` assertion.
- Verified bridge and host coverage for window button visibility, position copy/reset, vibrancy/options, background material, sheet offset, and `setWindowButtonPosition(null)` restoring the hosted default `null` position.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **247/290 (85.2%) -> 248/290 (85.5%)**

Remaining boundary:

- This closes hosted titlebar/material state compatibility smoke, not native macOS traffic lights, NSVisualEffectView vibrancy, WindowServer material compositing, real sheet attachment points, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 352: BrowserWindow Menu-Bar State Smoke Binding

Completed:

- Bound the BrowserWindow hosted `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `removeMenu()` / `setMenu()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke `data-browser-window-menu-bar-state` marker and its combined void-return plus sync getter assertion.
- Verified bridge and host coverage for hosted menu-bar auto-hide, visibility, removed state, `removeMenu()` hiding/removal, non-null `setMenu(menu)` visibility restoration, and `setMenu(null)` removal.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **246/290 (84.8%) -> 247/290 (85.2%)**

Remaining boundary:

- This closes hosted menu-bar state compatibility smoke, not native app menu rendering, Electron `Menu` object semantics, platform menu accelerators, Alt-key menu behavior, OS menu events, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 351: BrowserWindow Geometry Events Smoke Binding

Completed:

- Bound the BrowserWindow hosted `setBounds()` / `setSize()` / `setPosition()` / `center()` geometry-events checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke `resize` / one-shot `move` listeners, the `setBounds()` geometry path, and the hosted `data-browser-window-bounds` readback.
- Verified host routing keeps `setBounds()` dispatching both `resize` and `move`, `setSize()` dispatching `resize`, and `setPosition()` / `center()` dispatching `move` through the BrowserWindow event channel.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **245/290 (84.5%) -> 246/290 (84.8%)**

Remaining boundary:

- This closes hosted geometry event compatibility smoke, not OS-native window-manager resize/move events, native detached BrowserWindow geometry, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 350: BrowserWindow WebContents Audio Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.setAudioMuted()` / `isAudioMuted()` / `isCurrentlyAudible()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke markers `data-browser-window-audio-initial`, `data-browser-window-audio-muted`, and `data-browser-window-audio-unmuted`.
- Verified VM and host coverage for void-return mute/unmute, synchronous muted/audible getters, targeted `audio-state-changed`, `event.audible`, boolean listener arguments, and host WebContents event dispatch.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **244/290 (84.1%) -> 245/290 (84.5%)**

Remaining boundary:

- This closes hosted audio state compatibility smoke, not Chromium's full media audibility pipeline, native media session integration, actual audio playback state detection, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 349: BrowserWindow WebContents Zoom Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.setZoomFactor()` / `getZoomFactor()` / `setZoomLevel()` / `getZoomLevel()` / `setVisualZoomLevelLimits()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke markers `data-browser-window-zoom-factor`, `data-browser-window-zoom-level`, and `data-browser-window-visual-zoom-limits`.
- Verified bridge and host coverage for factor/level conversion, synchronous getter cache updates, visual zoom limit payloads, host state routing, and iframe CSS scale rendering.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **243/290 (83.8%) -> 244/290 (84.1%)**

Remaining boundary:

- This closes hosted zoom compatibility smoke, not Chromium native page zoom, pinch zoom, per-frame zoom semantics, native accessibility zoom integration, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 348: BrowserWindow WebContents Selection Scroll Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.centerSelection()` / `scrollToTop()` / `scrollToBottom()` / `adjustSelection({ start, end })` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke markers `data-browser-window-selection-scroll-commands`, `data-browser-window-adjust-selection`, and `data-browser-window-scroll-top`.
- Verified the VM coverage already checks method exposure, void-return shape, native bridge action names, and the `adjustSelection({ start, end })` payload.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **242/290 (83.4%) -> 243/290 (83.8%)**

Remaining boundary:

- This closes hosted selection and scroll compatibility smoke, not Chromium's complete native selection pipeline, cross-frame selection routing, native scroll integration, IME-aware selection behavior, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 347: BrowserWindow WebContents Editing Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.insertText(text)` and editing command checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App smoke markers `data-browser-window-insert-text`, `data-browser-window-edit-commands`, and `data-browser-window-edit-value`.
- Verified the VM coverage already checks `insertText()` Promise resolution, void-return shape for `undo()` / `redo()` / `cut()` / `copy()` / `paste()` / `pasteAndMatchStyle()` / `delete()` / `selectAll()` / `unselect()` / `replace()` / `replaceMisspelling()`, and host routing through the local edit clipboard path.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **241/290 (83.1%) -> 242/290 (83.4%)**

Remaining boundary:

- This closes hosted editing compatibility smoke, not Chromium's complete editing stack, system clipboard integration, IME, spellchecker, native undo/redo history, cross-frame editing semantics, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 346: BrowserWindow WebContents Waiting Response Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.isWaitingForResponse()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the existing App waiting-response probe, including pending `loadURL()` true state, completed false state, lifecycle stop cleanup, bridge loading cache, and host stop routing.
- Verified the VM coverage already checks default false, pending true, host response false, and `stop()` false waiting-response behavior.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **240/290 (82.8%) -> 241/290 (83.1%)**

Remaining boundary:

- This closes hosted waiting-response compatibility smoke, not Chromium first-response tracking, cross-frame navigation wait state, full network lifecycle fidelity, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 345: BrowserWindow WebContents NavigationHistory Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.navigationHistory.canGoBack()` / `canGoForward()` / `goBack()` / `goForward()` / `goToIndex()` / `canGoToOffset()` / `goToOffset()` / `clear()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for navigationHistory void-return action smoke, synchronous can-go state, clear collapse, bridge method exposure, host index/offset routing, and hosted history collapse.
- Verified the existing App smoke records `data-browser-window-navigation-history` after `goToOffset(-1)`, `goForward()`, and `clear()` while preserving the VM coverage for `goToIndex()` and `canGoToOffset()`.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **239/290 (82.4%) -> 240/290 (82.8%)**

Remaining boundary:

- This closes hosted navigationHistory compatibility smoke, not full Chromium session history, real WebView history/cache clearing, cross-frame navigation history, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 344: BrowserWindow WebContents Focus Owner Media Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.focus()` / `isFocused()` / `getOwnerBrowserWindow()` / `getMediaSourceId()` / `isBeingCaptured()` / `setIgnoreMenuShortcuts()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Bound the existing `data-browser-window-webcontents-focus-state` / `data-browser-window-webcontents-owner-media` marker guards together with new `focusResult` / `ignoreMenuShortcutsResult` and bridge/host state checks.
- Verified the bridge initializes hosted focus/media/shortcut state, exposes the owner BrowserWindow handle and capture getter, and routes host focus/shortcut actions through hosted state updates and focus events.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **238/290 (82.1%) -> 239/290 (82.4%)**

Remaining boundary:

- This closes hosted focus/owner/media/shortcut compatibility smoke, not OS-level native focus, real DesktopCapturerSource or tab capture semantics, native app menu shortcut handling, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 343: BrowserWindow WebContents Crash Lifecycle Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.isCrashed()` / `forcefullyCrashRenderer()` / targeted `render-process-gone` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for `data-browser-window-render-process-gone`, `data-browser-window-webcontents-crash`, and `data-browser-window-webcontents-crash-reload`.
- Verified the bridge synchronously marks hosted crash state, the host dispatches explicit `{ reason: "crashed", exitCode: 1 }` details, and load/reload clears hosted crash state.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **237/290 (81.7%) -> 238/290 (82.1%)**

Remaining boundary:

- This closes hosted crash lifecycle compatibility smoke, not real Chromium renderer termination, Electron crash semantics fidelity, waiting-response row, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 342: BrowserWindow WebContents Lifecycle Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.loadURL(url[, options])`, `reload()`, `stop()`, `isDestroyed()`, and `getType()` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Added direct source guards for the Web preview lifecycle smoke markers `data-browser-window-webcontents-load-url` and `data-browser-window-webcontents-lifecycle`.
- Verified the bridge and host continue routing hosted WebContents load/reload/stop through the child iframe navigation state, while `stop()` keeps the void-return shape and clears loading state.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **236/290 (81.4%) -> 237/290 (81.7%)**

Remaining boundary:

- This closes hosted WebContents lifecycle smoke, not crash lifecycle rows, waiting-response row, real Chromium network lifecycle fidelity, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 341: BrowserWindow Runtime State Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.getUserAgent()` / `setUserAgent()`, `getFrameRate()` / `setFrameRate()`, `getBackgroundThrottling()` / `setBackgroundThrottling()`, and process identity checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to split runtime verification into `data-browser-window-runtime-defaults`, `data-browser-window-runtime-process`, `data-browser-window-runtime-setters`, and aggregate `data-browser-window-runtime-state`.
- Verified hosted defaults, void-return setters with immediately readable sync getters, and positive hosted process IDs that differ between renderer compatibility and OS compatibility identity.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **235/290 (81.0%) -> 236/290 (81.4%)**

Remaining boundary:

- This closes hosted runtime state compatibility smoke, not real Electron renderer/OS process identity, lifecycle rows, crash rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 340: BrowserWindow Capture Print Save Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.capturePage([rect, opts])`, `print([options], [callback])`, `printToPDF(options)`, and `savePage(fullPath, saveType)` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to record `data-browser-window-capture-print-save-state`, covering NativeImage-compatible capture data, explicit native-only print callback failure, PDF byte header, and savePage void result.
- Kept host-side guards on hosted snapshot generation, minimal PDF byte serialization, and Tauri-scoped savePage filesystem writes.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **234/290 (80.7%) -> 235/290 (81.0%)**

Remaining boundary:

- This closes hosted capture/print/save compatibility smoke, not native print UI, Chromium pixel capture fidelity, broader PDF layout fidelity, runtime state rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 339: BrowserWindow InspectElement Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.inspectElement(x, y)` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to record `data-browser-window-inspect-element-state` for void-return shape plus synchronous DevTools open/focus state.
- Added targeted `devtools-opened` event summary checks via `data-browser-window-inspect-element-summary`, covering the compact inspected element payload from the hosted child iframe coordinates.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **233/290 (80.3%) -> 234/290 (80.7%)**

Remaining boundary:

- This closes hosted `inspectElement()` compatibility state and compact element summary smoke, not Chromium native inspect UI, element highlight overlay, DevTools protocol attachment, capture/print rows, runtime rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 338: BrowserWindow DevTools Smoke Binding

Completed:

- Bound the BrowserWindow hosted DevTools state/events checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to record `data-browser-window-devtools-state`, covering `openDevTools()`, `toggleDevTools()`, focused `openDevTools()`, `closeDevTools()`, `isDevToolsOpened()`, and `isDevToolsFocused()`.
- Added App smoke guards for targeted `devtools-opened` / `devtools-closed` payloads, including mode/title/focus state from the hosted DevTools result.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **232/290 (80.0%) -> 233/290 (80.3%)**

Remaining boundary:

- This closes hosted DevTools compatibility state and event smoke, not Chromium native DevTools windows/docking/protocol attachment, inspectElement row, native session history/cache semantics, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 337: BrowserWindow WebContents Navigation Smoke Binding

Completed:

- Bound the BrowserWindow hosted WebContents navigation state checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to record `data-browser-window-navigation-sync-state`, covering `getURL()` / `getTitle()` / loading flags / back-forward booleans after `loadURL()`, `reloadIgnoringCache()`, `goBack()`, and `goForward()`.
- Added bridge and host guards for `syncWebContentsNavigationState()`, cached URL/title/loading/history-index updates, and hosted history routing for `webContents.goBack()` / `goForward()`.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **231/290 (79.7%) -> 232/290 (80.0%)**

Remaining boundary:

- This closes hosted child iframe WebContents navigation state smoke, not Chromium native session history, true cache bypass, cross-process frame routing, navigationHistory row, DevTools rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 336: BrowserWindow FindInPage Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.findInPage(text[, options])` / `stopFindInPage(action)` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke listener to assert targeted `found-in-page` final results, request-id correlation, and `stopFindInPage("clearSelection")` void-return shape.
- Added host source guards for targeted found-in-page event dispatch, active match ordinal/final result shape, stop action routing, and targeted child selection clearing.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **230/290 (79.3%) -> 231/290 (79.7%)**

Remaining boundary:

- This closes hosted child iframe text search and stop-selection smoke, not Chromium native find UI, cross-frame find routing, isolated worlds, native selection painting, navigation rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 335: BrowserWindow InsertCSS Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.insertCSS(css[, options])` / `removeInsertedCSS(key)` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to assert returned CSS key shape, keyed stylesheet injection marker, keyed removal void shape, computed style cleanup, and no residual `style[data-atools-browser-window-css-key]` nodes after removal.
- Added host source guards for key/origin attributes, inserted CSS registry set/delete, and keyed style removal query.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **229/290 (79.0%) -> 230/290 (79.3%)**

Remaining boundary:

- This closes hosted keyed DOM stylesheet injection/removal smoke inside the PluginPanel child iframe, not Chromium native user/author origin cascade, isolated worlds, cross-frame CSS, find/navigation rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 334: BrowserWindow SendInputEvent Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.sendInputEvent(inputEvent)` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke from keyboard-only input to keyboard, mouse, and wheel DOM dispatch, with parent `data-browser-window-send-input-event-dom` and child `data-send-input-event-*` markers.
- Added a post-`webContents.loadURL()` / `webContents.reload()` input check that records `data-browser-window-send-input-event-after-webcontents-reload`, proving follow-up WebContents actions target the loaded child document rather than an initial empty document.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **228/290 (78.6%) -> 229/290 (79.0%)**

Remaining boundary:

- This closes hosted DOM input dispatch smoke for keyboard/mouse/wheel inside the PluginPanel child iframe, not OS-level native input injection, IME/native before-input-event, isolated worlds, CSS/find/navigation rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 333: BrowserWindow ExecuteJavaScript Smoke Binding

Completed:

- Bound the BrowserWindow hosted `webContents.executeJavaScript(code[, userGesture])` checklist row into `pnpm test:plugin-window-browser-bridge`.
- Extended the Web preview BrowserWindow smoke to record successful child iframe evaluation through parent `data-browser-window-execute-js` and child `data-execute-js`.
- Added a thrown child-script path that records `data-browser-window-execute-js-error` only when the rejection includes method-scoped `webContents.executeJavaScript` context and the original `execute-js-smoke` error.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **227/290 (78.3%) -> 228/290 (78.6%)**

Remaining boundary:

- This closes hosted child iframe script evaluation success/error smoke, not isolated worlds, native Electron frame routing, sendInputEvent/CSS/find/navigation rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 332: BrowserWindow WebContents IPC Smoke Binding

Completed:

- Bound the BrowserWindow hosted IPC checklist row into `pnpm test:plugin-window-browser-bridge`, covering parent `webContents.send(channel, ...args)`, child `require("electron").ipcRenderer.on()` / `once()`, and child `sendToParent()` callback routing.
- Extended the Web preview child BrowserWindow smoke to register `ipcRenderer.once("ping", ...)` and record `data-child-ipc-once` alongside the existing `data-child-ipc-ping` marker.
- Added App source guards for parent send acceptance, child IPC receive markers, and parent callback channel state.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **226/290 (77.9%) -> 227/290 (78.3%)**

Remaining boundary:

- This closes hosted BrowserWindow `webContents.send()` IPC inside the PluginPanel shell, not native Electron IPC, executeJavaScript rows, sendInputEvent rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 331: BrowserWindow Content Size Constraint Smoke Binding

Completed:

- Bound the BrowserWindow content-size/min-max/aspect-ratio checklist row into `pnpm test:plugin-window-browser-bridge`, covering `getContentSize()` / `setContentSize()`, `getMinimumSize()` / `setMinimumSize()`, `getMaximumSize()` / `setMaximumSize()`, and `setAspectRatio()`.
- Extended the Web preview browser-window smoke to record aspect-ratio state and restored final content size after the `setContentSize(420, 260)` restore path.
- Added source guards that `setBounds()`, `setSize()`, and `setContentSize()` continue to share hosted size normalization and min/max constraint helpers.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **225/290 (77.6%) -> 226/290 (77.9%)**

Remaining boundary:

- This closes hosted BrowserWindow content-size/min-max/aspect-ratio state inside the PluginPanel shell, not native OS chrome bounds, user drag constraints, IPC rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 330: BrowserWindow Z-Order Media Source Smoke Binding

Completed:

- Bound the BrowserWindow z-order/media-source checklist row into `pnpm test:plugin-window-browser-bridge`, covering `getMediaSourceId()`, `moveTop()`, and `moveAbove(mediaSourceId)`.
- Extended the Web preview browser-window smoke to record z-order/media-source state after `moveTop()` plus a temporary reference-window `moveAbove(sourceId)` flow.
- Added source guards that `pluginBrowserWindowLayer()` writes `childWindow.zOrder` into hosted z-index and that the Web preview replacement targets remain wired.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **224/290 (77.2%) -> 225/290 (77.6%)**

Remaining boundary:

- This closes hosted BrowserWindow z-order/media-source state inside the PluginPanel shell, not native OS stacking, DesktopCapturerSource identity, content-size rows, IPC rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 329: BrowserWindow Focus Attention Progress Smoke Binding

Completed:

- Bound the BrowserWindow focus/attention/progress checklist row into `pnpm test:plugin-window-browser-bridge`, covering `setFocusable()` / `isFocusable()`, `flashFrame()`, and `setProgressBar()`.
- Extended the Web preview browser-window smoke to record restored focusable state and a combined flash/progress cleanup marker after `flashFrame(true)` / `flashFrame(false)` and `setProgressBar(0.42)` / `setProgressBar(-1)`.
- Added source guard that hosted flashing state has a shell class/style and hosted progress state renders a titlebar progress strip only while active.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **223/290 (76.9%) -> 224/290 (77.2%)**

Remaining boundary:

- This closes hosted BrowserWindow focus/attention/progress state inside the PluginPanel shell, not OS native focusability, Dock/taskbar flash/progress, z-order rows, content-size rows, IPC rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 328: BrowserWindow System-State Smoke Binding

Completed:

- Bound the BrowserWindow system-state checklist row into `pnpm test:plugin-window-browser-bridge`, covering `setSkipTaskbar()`, `setKiosk()` / `isKiosk()`, `setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()`, and `setContentProtection()` / `isContentProtected()`.
- Existing Web preview smoke toggles skip-taskbar, kiosk, workspace visibility, and content protection, recording hosted readback markers for kiosk/workspace/content-protection state.
- Added source guard that hosted `kiosk` child windows use the same fill-layer CSS path as maximized/full-screen child windows.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **222/290 (76.6%) -> 223/290 (76.9%)**

Remaining boundary:

- This closes hosted BrowserWindow system-state inside the PluginPanel shell, not OS native taskbar/Dock behavior, native kiosk/workspace/capture protection, focus-attention-progress rows, z-order rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 327: BrowserWindow Background Color Smoke Binding

Completed:

- Bound the BrowserWindow background-color checklist row into `pnpm test:plugin-window-browser-bridge`, covering `setBackgroundColor(color)` / `getBackgroundColor()`.
- Existing Web preview smoke validates `setBackgroundColor('rgb(16, 32, 48)')` has void-return shape and `getBackgroundColor()` normalizes to `#102030`.
- Added source guard that hosted shell style uses `childWindow.backgroundColor`.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **221/290 (76.2%) -> 222/290 (76.6%)**

Remaining boundary:

- This closes hosted BrowserWindow background-color state inside the PluginPanel shell, not OS native background material/color behavior, system-state rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 326: BrowserWindow Appearance State Smoke Binding

Completed:

- Bound the BrowserWindow appearance-state checklist row into `pnpm test:plugin-window-browser-bridge`, covering `getOpacity()` / `setOpacity()`, `hasShadow()` / `setHasShadow()`, and `invalidateShadow()`.
- Extended the Web preview `?parity=1&pluginHostSmoke=browserWindow` chain to set opacity to `0.72`, read it back, restore opacity to `1`, read it back again, disable shadow, read it back, restore shadow, read it back again, and then continue the existing system-state smoke path.
- Added source-level guardrails that the hosted shell only emits inline opacity when opacity is below 1, and only applies `noShadow` while hosted shadow is disabled.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **220/290 (75.9%) -> 221/290 (76.2%)**

Remaining boundary:

- This closes hosted BrowserWindow appearance state inside the PluginPanel shell, not native OS-level opacity/shadow behavior, background-color rows, system-state rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 325: BrowserWindow Full-Screen State Smoke Binding

Completed:

- Bound the BrowserWindow full-screen state checklist row into `pnpm test:plugin-window-browser-bridge`, covering `isFullScreen()` / `setFullScreen()` and `isFullScreenable()` / `setFullScreenable()`.
- Extended the Web preview `?parity=1&pluginHostSmoke=browserWindow` chain to register hosted `enter-full-screen` / `leave-full-screen` listeners, verify `fullScreenable:false` blocks `setFullScreen(true)`, restore `fullScreenable:true`, and then continue the existing full-screen enter/leave smoke path.
- Added source-level guardrails for the blocked full-screen marker, restored full-screenable marker, and enter/leave event markers.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **219/290 (75.5%) -> 220/290 (75.9%)**

Remaining boundary:

- This closes hosted BrowserWindow full-screen/full-screenable state inside the PluginPanel shell, not native OS-level fullscreen, appearance rows, system-state rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 324: BrowserWindow Capability State Smoke Binding

Completed:

- Bound the BrowserWindow capability-state checklist row into `pnpm test:plugin-window-browser-bridge`, covering `isResizable()` / `setResizable()`, `isMovable()` / `setMovable()`, `isClosable()` / `setClosable()`, `isMinimizable()` / `setMinimizable()`, and `isMaximizable()` / `setMaximizable()`.
- Extended the Web preview `?parity=1&pluginHostSmoke=browserWindow` chain to toggle each capability false, read it back, record a `data-browser-window-*` marker, and restore the capability before continuing the existing full-screen/appearance/system smoke path.
- Added source-level guardrails that `closable:false` disables the hosted BrowserWindow close button and exposes the disabled close title.

Verification:

- `pnpm test:plugin-window-browser-bridge`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **218/290 (75.2%) -> 219/290 (75.5%)**

Remaining boundary:

- This closes hosted capability state binding for the in-host BrowserWindow shell, not native OS-level window capability management, full-screen/full-screenable behavior, appearance/system-state rows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 323: Built-In Plugin Search Desktop Smoke

Completed:

- Bound macOS smoke checklist rows 281 and 282 into the real desktop smoke path: `plugin_runtime_smoke` now requires calculator search activation and timestamp search activation, and `plugin_panel_render_smoke` requires timestamp input visibility.
- Hardened desktop smoke against current/legacy built-in plugin coexistence: hashed plugin ids are accepted, `calc`/`计算器` and `timestamp`/`时间戳` feature codes are both considered, and the search helper tries later valid candidates if an earlier indexed candidate has an unusable plugin path.
- Extended the PluginPanel smoke bridge probe to report visible iframe input state, so both newer host SubInput plugins and older self-contained timestamp pages can prove the timestamp input row without re-adding `allow-same-origin`.

Verification:

- `pnpm test:tauri-desktop-smoke-script`
- `cargo test --manifest-path src-tauri/Cargo.toml desktop_smoke --lib`
- `ATOOLS_DESKTOP_SMOKE_TIMEOUT_MS=180000 pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **216/290 (74.5%) -> 218/290 (75.2%)**

Remaining boundary:

- This closes calculator/timestamp search-entry and timestamp input smoke coverage, not the broader timestamp output-list interactions, JSON/color plugin flows, side-effecting native bridge replay, signing, notarization, or auto-update.

### Batch 322: Plugin Resource Compatibility Checklist Binding

Completed:

- Bound macOS smoke checklist row 280 directly into `scripts/test-plugin-resource-html.mjs` and `scripts/test-plugin-resource-runtime.mjs`, so the existing static and runtime resource compatibility tests must stay aligned with the checked checklist row.
- `pnpm test:plugin-resource-html` covers plugin `main_url` subdirectories, relative script/style inlining, CSS `url(...)` / `@import`, `srcset`, link icon/modulepreload/media resources, and local `<base href>` directory resolution while preserving the original base marker.
- `pnpm test:plugin-resource-runtime` covers dynamic image/media/script/link/object/style resources, inline style attributes, `CSSStyleSheet.insertRule()`, `appendChild` / `insertBefore` / `append` / `prepend` / `before` / `after` / `replaceWith` preflight for fetch-sensitive script/link insertion, and live local base href handling.

Verification:

- Red/green: `node scripts/test-plugin-resource-html.mjs` first passed resource behavior and failed on the unchecked checklist row; after row 280 was marked checked, `pnpm test:plugin-resource-html && pnpm test:plugin-resource-runtime` passed.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- macOS smoke checklist closure: **215/290 (74.1%) -> 216/290 (74.5%)**

Remaining boundary:

- This closes resource URL conversion coverage, not real plugin functional search, real Tauri PluginPanel FS import, native bridge side effects, signing, notarization, or auto-update.

### Batch 321: Plugin Host Smoke Browser Layout

Completed:

- Added `scripts/test-plugin-host-smoke-browser.mjs` and `pnpm test:plugin-host-smoke-browser` to open `http://localhost:1420/?parity=1&pluginHostSmoke=1` through headless Chrome/CDP.
- The Browser smoke validates the synthetic PluginPanel host UI only: title `插件运行态预览`, feature/source labels, exactly 4 runtime cards, bridge detail `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, SubInput value `time`, two output rows, no plugin iframe body, no framework overlay, no horizontal overflow, console 0 warn/error, and no overlap among header/runtime/SubInput/body with the output layer contained inside body.
- Closed macOS smoke checklist row 279 without expanding it into real plugin search or Tauri FS runtime validation.

Verification:

- Red/green: `node scripts/test-plugin-host-smoke-browser.mjs` first exposed overly narrow assertions for existing UI text/selection and parent-child layout, then failed on the unchecked checklist row; after row 279 and the package script were added, `pnpm test:plugin-host-smoke-browser` passed.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **214/290 (73.8%) -> 215/290 (74.1%)**

Remaining boundary:

- This verifies the Web preview synthetic host UI, not real `activate_feature` desktop plugin search, real Tauri PluginPanel FS import, side-effecting native bridge replay, or signing/notarization/update work.

### Batch 320: UI Host Report Scope Regression

Completed:

- Added `scripts/test-ztools-ui-host-report-scope.mjs` and `pnpm test:ztools-ui-host-report-scope` to bind the UI host report's scope row to structured evidence rather than narrative notes.
- The scope test validates the real report summary, per-plan `externalPlan` synthetic `srcdoc` probe回传, real-entry HTML/readiness/hash fields, script/stylesheet dependency readiness/hash fields, copied CSS/font support files, generated fixture bridge API replay markers, standalone fixture matrix, Web preview PluginPanel matrix, and the 20-artifact screenshot manifest.
- Closed macOS smoke checklist row 274 while preserving the explicit boundary that this remains an external UI host fixture/report path, not real Tauri FS import, full native bridge replay, or complete sandbox/signing coverage.

Verification:

- Red/green: `node scripts/test-ztools-ui-host-report-scope.mjs` first failed on the unchecked checklist row after the report evidence passed; after row 274 and the package script were added, the scope regression passed.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **213/290 (73.4%) -> 214/290 (73.8%)**

Remaining boundary:

- Real Tauri FS import activation, side-effecting native bridge replay, complete iframe sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 319: UI Host Screenshot Capture Browser Smoke

Completed:

- Added `scripts/capture-ztools-ui-host-screenshots.mjs` to open each UI host `web_preview` URL, apply the two planned `screenshot_viewports`, wait for `宿主探针 5/5`, and capture viewport PNG pixels through headless Chrome/CDP.
- Added `scripts/test-ztools-ui-host-screenshot-capture-browser.mjs` and `pnpm test:ztools-ui-host-screenshot-capture-browser` to validate all 20 screenshot artifacts, PNG headers, dimensions, byte sizes, page titles, plugin titles, host probe values, console 0 warn/error, no framework overlay, and no horizontal overflow.
- `scripts/chrome-cdp-smoke-utils.mjs` now supports per-command CDP timeouts, so `Page.captureScreenshot` failures surface as bounded test failures instead of hanging the smoke run.

Verification:

- Red/green: `node scripts/test-ztools-ui-host-screenshot-capture-browser.mjs` first failed because the capture module was missing; after the capture implementation, it generated all PNG artifacts and failed only on the unchecked checklist row; after row 273 and the npm script were added, the smoke passed.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **212/290 (73.1%) -> 213/290 (73.4%)**

Remaining boundary:

- This closes Browser screenshot capture for the UI host report's planned viewport checks. Real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 318: UI Host ExternalPlan Browser Smoke

Completed:

- Added `scripts/test-ztools-ui-host-external-plan-browser.mjs` and `pnpm test:ztools-ui-host-external-plan-browser` to open the first `web_preview.mode=externalPlan` URL through headless Chrome/CDP.
- Browser smoke now verifies the base64url action preserves `计算稿纸`, embeds synthetic `srcdoc` with `__atools_ui_host_probe_result__`, loads PluginPanel as `iframe` mode, receives the srcdoc probe postMessage, and renders `宿主探针 5/5` with bridge capability strip, sandbox `allow-scripts allow-popups`, 0 console warn/error, no framework overlay, and no horizontal overflow.

Verification:

- Red/green: `node scripts/test-ztools-ui-host-external-plan-browser.mjs` first passed the externalPlan Browser assertions and failed only on unchecked checklist row 266; after rows 266/267 and the npm script were added, the smoke passed.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **210/290 (72.4%) -> 212/290 (73.1%)**

Remaining boundary:

- This closes the externalPlan `srcdoc` host probe and first externalPlan Browser smoke rows. Screenshot capture, real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 317: UI Host First Fixture Browser Smoke

Completed:

- Added `scripts/test-ztools-ui-host-first-fixture-browser.mjs` and `pnpm test:ztools-ui-host-first-fixture-browser` to serve `output/ztools-ui-host-real-entry-fixtures` at `127.0.0.1:1434` and open the first generated fixture `001-calculation-paper-calc.html` through headless Chrome/CDP.
- Browser smoke now verifies the visible `计算公式` input, `data-atools-real-entry-fixture=true`, `data-atools-real-entry-ready=true`, `data-atools-real-entry-bridge-present=true`, `data-atools-real-entry-ztools-alias=true`, plugin id `calculation-paper`, feature code `calc`, bridge API 9/9, and 0 console warn/error.

Verification:

- Red/green: `node scripts/test-ztools-ui-host-first-fixture-browser.mjs` first failed on report/test field assumptions, then passed Browser assertions and failed only on the unchecked checklist row; after row 268 and the npm script were added, the smoke passed.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **209/290 (72.1%) -> 210/290 (72.4%)**

Remaining boundary:

- This closes the first standalone real-entry fixture Browser DOM row. externalPlan `srcdoc` PluginPanel strip, externalPlan Browser smoke, screenshot capture, real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 316: UI Host PluginPanel Matrix Browser Smoke

Completed:

- Added `scripts/test-ztools-ui-host-plugin-panel-matrix-browser.mjs` and `pnpm test:ztools-ui-host-plugin-panel-matrix-browser` to launch Vite at `127.0.0.1:1420`, serve real-entry fixtures at `127.0.0.1:1434`, and open `real_entry_plugin_panel_matrix.browser_url` through headless Chrome/CDP.
- Browser smoke now verifies `http://127.0.0.1:1434/plugin-panel-matrix.html`, the PluginPanel matrix marker, expected/ready/error/all-ready attributes, 10 PluginPanel iframes, 10 status rows, every row `ready passed=15/15 failed=`, the matrix runtime object, 0 console warn/error, and the static `messages=` forwarding path for fixture errors.
- `scripts/chrome-cdp-smoke-utils.mjs` now owns shared `launchViteServer()` process management, so the single PluginPanel smoke and PluginPanel matrix smoke use the same strict-port startup and cleanup path.

Verification:

- Red/green: `node scripts/test-ztools-ui-host-plugin-panel-matrix-browser.mjs` first passed the real Browser matrix assertions and failed only on the unchecked checklist row, then passed after the PluginPanel matrix Browser row was marked complete.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **208/290 (71.7%) -> 209/290 (72.1%)**

Remaining boundary:

- This closes the generated PluginPanel matrix Browser smoke. externalPlan `srcdoc` PluginPanel strip, first standalone fixture DOM row, screenshot capture, real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 315: UI Host PluginPanel Real Fixture Browser Smoke

Completed:

- Added `scripts/test-ztools-ui-host-plugin-panel-browser.mjs` and `pnpm test:ztools-ui-host-plugin-panel-browser` to launch Vite at `127.0.0.1:1420`, serve real-entry fixtures at `127.0.0.1:1434`, and open the first `real_entry_plugin_panel.url` through headless Chrome/CDP.
- Browser smoke now verifies the actual PluginPanel shell title `ATools 3.0`, plugin title `计算稿纸`, main plugin iframe `src=http://127.0.0.1:1434/001-calculation-paper-calc.html`, empty `srcdoc`, sandbox `allow-scripts allow-popups`, iframe runtime mode, bridge capability strip, `宿主探针 15/15`, 0 console warn/error, no Vite/Svelte error overlay, and no horizontal overflow.
- The row expectation was updated from the earlier `宿主探针 6/6` wording to the current `15/15` real fixture coverage, matching the Browser-observed fixture bridge API probes and existing PluginPanel matrix baseline.

Verification:

- Red/green: `node scripts/test-ztools-ui-host-plugin-panel-browser.mjs` first failed on stale `宿主探针 6/6`, then failed only on the unchecked checklist row after aligning the smoke to current `15/15` coverage, and passed after the PluginPanel real fixture Browser row was marked complete.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **207/290 (71.4%) -> 208/290 (71.7%)**

Remaining boundary:

- This closes the single first PluginPanel real fixture Browser smoke only. externalPlan `srcdoc` PluginPanel strip, first standalone fixture DOM row, full PluginPanel matrix Browser smoke, screenshot capture, real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 314: UI Host Fixture Matrix Browser Smoke

Completed:

- Added `scripts/test-ztools-ui-host-fixture-matrix-browser.mjs` and `pnpm test:ztools-ui-host-fixture-matrix-browser` to run a dependency-free headless Chrome/CDP smoke against the local fixture server.
- Browser smoke now opens `http://127.0.0.1:1434/index.html` and verifies the real-entry matrix marker, expected/ready/error/all-ready attributes, 10 fixture iframes, 10 status rows, per-row ready/bridge/ztools/identity state, `bridgeApi=9/9 bridgeApiFailed= errors=0`, and 0 console warn/error.
- The real-entry fixture bridge now stubs `umami.init()` and `ztools.internal` development-project methods used by current ZTools plugins, removing the IBox Umami and developer-plugin console errors without filtering them out.
- Regenerated `output/ztools-plugin-ui-host-smoke-report.json`; the current real report baseline is now 10 planned / 10 UI host samples / 27 real entry resources / 10 fixtures / 10 fixture matrix / 10 PluginPanel matrix / 77 runtime support files.

Verification:

- Red/green: `pnpm test:ztools-ui-host-fixture-matrix-browser` first failed on real Browser console errors from `ibox-wallpaper` and `ztools-developer-plugin`, then failed only on the unchecked checklist row after bridge mocks and report regeneration, and passed after the matrix Browser row was marked complete.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **206/290 (71.0%) -> 207/290 (71.4%)**

Remaining boundary:

- This closes generated standalone fixture matrix Browser execution only. externalPlan `srcdoc` PluginPanel strip, first standalone fixture DOM row, single PluginPanel real fixture Browser smoke, PluginPanel matrix Browser smoke, screenshot capture, real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 313: UI Host Fixture Server Evidence

Completed:

- Fixture server evidence now binds `pnpm serve:ztools-ui-host-fixtures -- --root output/ztools-ui-host-real-entry-fixtures --host 127.0.0.1 --port 1434` to the real UI host report's PluginPanel fixture URLs and matrix browser URL.
- `scripts/test-ztools-ui-host-fixture-server.mjs` now verifies CORS headers, `OPTIONS` preflight, `GET`/`HEAD`, HTML/script/json/font MIME types, root `index.html` serving, encoded path traversal rejection, and malformed percent-encoding 400 handling.

Verification:

- Red/green: `pnpm test:ztools-ui-host-fixture-server` failed until the fixture server checklist row was marked complete.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **205/290 (70.7%) -> 206/290 (71.0%)**

Remaining boundary:

- This closes fixture-server readiness only. Browser DOM execution rows for standalone fixtures, matrix all-ready state, PluginPanel matrix, console 0 warn/error, screenshots, real Tauri FS import, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 312: UI Host Report Structure Baseline Evidence

Completed:

- Real UI host smoke report evidence now binds the generated JSON output and current 10-sample summary baseline from `output/ztools-plugin-ui-host-smoke-report.json`.
- Each real UI host plan is now checklist-bound to desktop `FeatureAction` fixture shape, externalPlan Web preview URL, iframe-ready expectation, screenshot viewport list, bridge probes, real entry HTML/resources, generated real-entry fixture, and generated PluginPanel fixture URL.
- Top-level real entry fixture and PluginPanel matrix metadata is now checklist-bound, including ready status, counts, file/browser URLs, bytes, SHA-256, and summary fields.
- UTF-8 action payload evidence now verifies Chinese plugin name and trigger text survive base64url decode without mojibake.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` failed until the UI host report checklist rows were marked complete.

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **195/290 (67.2%) -> 205/290 (70.7%)**

Remaining boundary:

- This closes report structure and generated fixture metadata only. Browser execution rows for `宿主探针 5/5`, externalPlan page rendering, standalone fixture/matrix console checks, PluginPanel matrix checks, real Tauri FS import, screenshots, native bridge replay, complete sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 311: Real ZTools Report Baseline Evidence

Completed:

- Real ZTools compatibility report evidence now binds the generated JSON output, non-empty scan count, `unsupported_cmd_plugins=0`, and current error-plugin cause classification to checklist rows.
- Real ZTools runtime sample report evidence now binds the generated JSON output, selected sample list length, and current sample-risk baseline of 125 scanned, 61 launchable, 21 ready, 40 risk, 64 blocked, and 20 selected candidates.
- Report checklist tests now fail if the checked rows drift away from the generated report baselines in `output/ztools-plugin-compatibility-report.json` or `output/ztools-plugin-runtime-sample-report.json`.

Verification:

- Red/green: `pnpm test:ztools-plugin-compatibility-report` and `pnpm test:ztools-plugin-runtime-sample-report` failed until the report checklist rows were marked complete and the stale runtime baseline was updated.

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **186/290 (64.1%) -> 195/290 (67.2%)**

Remaining boundary:

- This closes report generation and risk-baseline evidence only. It does not close real per-plugin import, enable, activation, UI load, bridge replay, visual screenshot, complete sandbox isolation, signing, notarization, or auto-update gates.

### Batch 310: Global Hotkey Conflict Evidence

Completed:

- Global hotkey recorder evidence now binds macOS reserved combinations such as `Command+Space` / `Control+Space` to an explicit conflict-risk status instead of treating them as silently saved shortcuts.
- Native registration failure evidence now binds `shortcutStatusMessage()` and the Settings `冲突/保存状态` row to `保存失败：<error detail>`, preserving the original registration error text for the user.
- SettingsPanel evidence now confirms the hotkey input title, error pill, and conflict/save row all use the same shared shortcut validation/save-status model.

Verification:

- Red/green: `pnpm test:hotkey-recorder` failed until the reserved-shortcut and native-failure checklist rows were marked complete.

Completion:

- Settings page functional parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **184/290 (63.4%) -> 186/290 (64.1%)**

Remaining boundary:

- This closes the model/UI evidence for hotkey conflict feedback. Real keypress behavior, menu bar tray visibility, real LaunchAgent write/delete, app launch checks, signing, notarization, and auto-update remain open.

### Batch 309: Agent Permission Dialog Evidence

Completed:

- Permission confirmation dialog evidence now binds client id, tool name, scope labels, execution mode, key arguments, and full JSON details.
- File-oriented permission requests now have checklist-bound evidence for `涉及路径`, path rendering from preview data, long-value wrapping, and scrollable dialog content that keeps action buttons reachable.
- High/medium-risk permission evidence now covers `shell`, `file_write`, and `system_settings` risk levels and explicit risk copy in the dialog.

Verification:

- Red/green: `pnpm test:permission-preview` failed until the permission dialog checklist rows were marked complete.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Permission/audit confidence: **98% -> 98%**
- macOS smoke checklist closure: **181/290 (62.4%) -> 184/290 (63.4%)**

Remaining boundary:

- The contiguous Agent/MCP permission and audit UI checklist block is now closed. Remaining macOS smoke gaps move back to desktop/system integration, broader plugin runtime/browser-window compatibility, external fixture smoke, and release items such as signing, notarization, and auto-update.

### Batch 308: Agent Audit Detail Replay Diff

Completed:

- Expanded audit detail evidence now binds `回放摘要` to permission result, execution mode, local side-effect state, and execution result rows.
- `rename_files`, `compress_images`, and `open_or_reveal_path` audit details now have checklist-bound evidence for `副作用 diff`, `路径副作用`, source/target/status rendering, long-path wrapping, and dry-run labeling as `dry-run 预览`.
- `compress_images` detail evidence now covers original size, output size, reduction percentage, `max_bytes` target fields, `target_unmet` status, and target-miss diff text.
- WebP compression evidence now binds `format:"webp"`, `compressed-<stem>.webp`, RIFF/WEBP magic bytes, original/output sizes, and the current lossless WebP encoder path.

Verification:

- Red/green: `pnpm test:audit-view` failed until the audit detail checklist rows were marked complete.
- Rust regression: `compress_images_writes_webp_output_when_requested` now directly asserts WebP `original_size` in addition to output filename, format, magic bytes, and output size.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **174/290 (60.0%) -> 181/290 (62.4%)**

Remaining boundary:

- Audit detail rows are now closed. Open Agent/MCP smoke rows are concentrated in the permission confirmation dialog rendering for client/tool/scope/key parameters, file path wrapping in the dialog, and high/medium-risk warning copy.

### Batch 307: Agent Audit Filter Pagination Saved Views

Completed:

- Audit filtering now has checklist-bound evidence for keyword/status/tool/client filters, filter summaries, path/error/argument search hits, and empty result messaging.
- Audit pagination evidence now binds `已加载 x / y 条`, `加载更多`, offset-based backend queries, and append behavior that preserves active filters.
- Saved audit filter views now have checklist-bound evidence for local persistence, apply/delete flows, and preserved query/status/tool/client filter values.
- Filtered JSONL export evidence now binds the AgentPanel export action to `export_audit_entries_jsonl_filtered`, current backend filters, clipboard copy, and the `当前筛选` success hint.

Verification:

- Red/green: `pnpm test:audit-view` failed until the audit filter/search checklist rows were marked complete.
- Red/green: `pnpm test:mcp-audit-settings` failed until the audit pagination and filtered-export checklist rows were marked complete.
- Red/green: `pnpm test:audit-filter-views` failed until the saved audit filter view checklist row was marked complete.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **169/290 (58.3%) -> 174/290 (60.0%)**

Remaining boundary:

- This proves the audit list control plane. Open audit rows now focus on expanded replay details, side-effect diff/path presentation, compression target/WebP detail rows, and permission dialog rendering.

### Batch 306: Agent Audit Refresh Clear JSONL Copy

Completed:

- Agent audit replay now has a dedicated `刷新` action beside `导出` and `清空`, reusing `reloadAuditsForFilters()` so the current query/status/tool/client filters are preserved while the first audit page is reloaded.
- The audit settings test now binds the AgentPanel refresh, clear, filtered JSONL export, clipboard copy helper, copied-count status, and native/core clear/export commands.
- The macOS smoke checklist marks audit refresh/clear/copy JSONL complete based on that frontend and backend evidence.

Verification:

- Red/green: `pnpm test:mcp-audit-settings` failed until the Agent audit section exposed the filtered refresh button, then failed until the checklist marked the row complete.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **168/290 (57.9%) -> 169/290 (58.3%)**

Remaining boundary:

- This proves audit refresh/clear/JSONL-copy paths. Broader audit rows remain open for saved filter flows, filtered export checklist closure, search hit/empty states, replay summaries, side-effect diffs, and permission dialog rendering.

### Batch 305: MCP Scope Policy Full-Coverage Verification

Completed:

- The MCP permission policy test now covers the full backend scope set: `clipboard_read`, `clipboard_write`, `file_read`, `file_write`, `network`, `shell`, `screenshot`, `browser_context`, `plugin_data`, and `system_settings`.
- A Rust integration test verifies `list_agent_scope_policies()` returns every scope in order, marks the five high-risk scopes, and that `set_agent_scope_policy("system_settings", "deny")` can be restored with `"confirm"`.
- The macOS smoke checklist now marks the all-scope deny/confirm policy row complete based on frontend and backend evidence.

Verification:

- Red/green: `pnpm test:mcp-permission-policy-settings` failed until the macOS checklist marked the all-scope deny/confirm verification row complete.
- `cargo test -p atools --test agent_tools_tests scope_policy_lists_all_scopes_and_restores_denied_scope_to_confirm`
- `cargo fmt --check`
- `cargo test -p atools --lib`

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **167/290 (57.6%) -> 168/290 (57.9%)**

Remaining boundary:

- This proves policy listing and deny/confirm persistence. Broader manual MCP/Agent rows remain open for audit list refresh/export, saved audit filters, detailed replay/diff display, and permission dialog path/risk rendering.

### Batch 304: System Settings Desktop Smoke LaunchAgent File Check

Completed:

- `system_settings_smoke` now requires `launch_agent_write_checked` and `launch_agent_cleanup_checked`, proving the desktop smoke can write a LaunchAgent plist to an isolated temp path, validate its label/RunAtLoad/executable content, and delete it again.
- The smoke parser requires those fields, and the macOS checklist marks the automated system-settings command-chain evidence complete without claiming that the smoke writes the real `~/Library/LaunchAgents` path.
- The temp plist path is unique per process/time and created with `create_dir`, reducing stale-path and concurrent-run interference.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed until the parser required the new fields and the fixture included them.
- Red/green: `pnpm test:tauri-desktop-smoke-checklist` failed until the checklist documented the new automated system-settings evidence.
- `cargo test -p atools --lib desktop_smoke_snapshot_reports_core_runtime_state`
- `ATOOLS_DESKTOP_SMOKE_TIMEOUT_MS=180000 pnpm smoke:tauri-desktop`: passed with `status:"ok"` and `system_settings_smoke.launch_agent_write_checked:true`, `launch_agent_cleanup_checked:true`, `settings_preserved:true`.

Completion:

- Tauri/Rust desktop foundation: **97% -> 97%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **166/289 (57.4%) -> 167/290 (57.6%)**

Remaining boundary:

- This proves the command-chain and temp-file plist path. Manual checks for visible menu bar tray state, real `~/Library/LaunchAgents` write/delete, hotkey press behavior, signing, notarization, and auto-update remain open.

### Batch 303: Real External Activation Desktop Smoke Closure

Completed:

- Added `render_smoke` metadata to the real ZTools activation plan so activation coverage can retain `ztools-developer-plugin/ui.router` while excluding that iframe-probe-unsafe sample from PluginPanel render smoke.
- Desktop smoke now skips unsafe render samples, waits longer for external plan PluginPanel render queues, and verifies 9 real imported/activated/cleaned external samples plus 8 render-safe filesystem `srcdoc` samples.
- `PluginPanel` desktop smoke bridge probe timeout now has a 12s lower bound and 15s cap, keeping large external plugin entries from failing due to an undersized probe budget.

Verification:

- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`: passed with 10 planned, 9 imported, 9 activated, 9 UI actions checked, 9 PluginPanel FS load specs checked, 9 assertions checked, 9 cleanup verified, 1 skipped, and `plugin_panel_render_smoke` rendering/probing 8/8 render-safe external plan samples with 40/40 bridge probe checks and 32/32 native method probe checks.
- `pnpm smoke:tauri-desktop`: passed with the default indexed PluginPanel render sample and empty external activation summary.
- `pnpm test:tauri-desktop-smoke-checklist`
- `pnpm check`
- `pnpm build`
- `cargo test --workspace`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **132/288 (45.8%) -> 166/289 (57.4%)**
- Third-party plugin regression scope: **external activation smoke plan -> real desktop activation/import/render-safe PluginPanel queue**

Remaining boundary:

- This closes the real external activation desktop smoke path. It still does not replace broader third-party visual screenshots, plugin-authored interaction replay, side-effecting native bridge coverage, full cross-origin sandbox isolation, certificate-chain/revocation policy, signing, notarization, or auto-update.

### Batch 302: find_local_files Ignore Behavior Smoke Closure

Completed:

- Added `scripts/test-settings-mcp-find-local-files-ignore.mjs` to guard the `find_local_files` option struct, MCP argument parsing, traversal behavior, wildcard matcher, MCP schema, Rust tests, and matching smoke checklist row.
- Bound existing Rust coverage for `ignore_dirs` + `max_depth`, `ignore_patterns` examples `*.tmp` and `generated/**`, and Unix permission-denied skip accounting.
- `docs/macos-smoke-checklist.md` now marks the `find_local_files` ignore/depth/permission behavior row complete.

Verification:

- Red/green: the checklist-bound script first passed source/schema/Rust-test assertions and failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Built-in Agent tools: **86% -> 86%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **131/288 (45.5%) -> 132/288 (45.8%)**
- macOS smoke checklist alignment: **find_local_files ignore/depth/permission row unchecked -> verified and regression-guarded**

Remaining boundary:

- Permission/audit UI rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 301: ask_ai_model Audit Redaction Smoke Closure

Completed:

- Added `ask_ai_model_success_audit_keeps_prompt_and_output_without_api_key` to Rust Agent tool tests, using a local OpenAI-compatible chat-completion server and a concrete API-key sentinel to prove the persisted audit keeps the prompt and assistant text but not the secret.
- Added `scripts/test-settings-mcp-ask-ai-audit-redaction.mjs` to guard the audit call path, `ask_ai_model` output shape, Rust redaction regression, and the matching macOS smoke checklist row.
- `docs/macos-smoke-checklist.md` now marks the `ask_ai_model` successful-call audit redaction row complete.

Verification:

- Red/green: the focused Rust test first failed on an overly strict request-header casing assertion, then passed after the assertion was corrected; the checklist-bound script first passed source/test assertions and failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Permission/audit foundation: **97% -> 97%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **130/288 (45.1%) -> 131/288 (45.5%)**
- macOS smoke checklist alignment: **ask_ai_model successful audit redaction unchecked -> verified and regression-guarded**

Remaining boundary:

- Permission/audit UI rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 300: ask_ai_model Permission Confirmation Smoke Closure

Completed:

- Added `ask_ai_model_requires_network_scope_confirmation_in_conservative_mode` to Rust Agent tool tests, explicitly covering `ask_ai_model` declaring `network` scope, default conservative mode returning `Confirm`, and the permission-required payload carrying the prompt and `network` scope.
- `scripts/test-settings-mcp-ask-ai-permission.mjs` now guards the Settings `MCP 服务` row: Settings displays tool scopes, pending request controls are present, `ask_ai_model` declares `PermissionScope::Network`, and `call_tool_with_audit` returns a permission-required pending request before executing the model call when unconfirmed.
- `docs/macos-smoke-checklist.md` now marks the `ask_ai_model` network scope / conservative confirmation row complete.

Verification:

- Red/green: the new Rust behavior test passed against the existing implementation; the checklist-bound script first passed UI/backend behavior assertions and failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Permission/audit foundation: **97% -> 97%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **129/288 (44.8%) -> 130/288 (45.1%)**
- macOS smoke checklist alignment: **ask_ai_model network scope / conservative confirmation unchecked -> verified and regression-guarded**

Remaining boundary:

- `ask_ai_model` successful-call audit redaction row, `find_local_files` ignore behavior row, remaining permission/audit UI rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 299: Plugin Manifest Tool MCP Whitelist Exposure

Completed:

- Fixed `ToolRegistry::list_enabled()` so user-enabled plugin manifest tools can appear in MCP `tools/list`; previously MCP discovery still excluded plugin tools because they are intentionally `enabled_by_default: false`.
- Added `mcp_tools_list_includes_user_enabled_plugin_tools` to core MCP tests, covering an enabled plugin tool with `enabled_by_default: false` appearing in `tools/list`.
- `scripts/test-settings-mcp-plugin-tool-whitelist.mjs` now guards the full row: Settings displays plugin tools returned by `list_agent_tools`, plugin manifest tools use `plugin_<plugin>_<tool>`, default off, only enter MCP after user enablement, and are removed when the plugin is disabled or no longer synced.
- `docs/macos-smoke-checklist.md` now marks the plugin manifest tool whitelist behavior row complete.

Verification:

- Red/green: the new Rust MCP test first failed because `tools/list` omitted a user-enabled plugin tool; after changing the registry filter to respect `tool.enabled`, the Rust test passed. The checklist-bound script then failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **128/288 (44.4%) -> 129/288 (44.8%)**
- macOS smoke checklist alignment: **plugin manifest tool whitelist / MCP exposure unchecked -> fixed, verified, and regression-guarded**

Remaining boundary:

- `ask_ai_model` permission/audit rows, `find_local_files` ignore behavior row, remaining permission/audit UI rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 298: Settings MCP Tool Whitelist Smoke Closure

Completed:

- `scripts/test-settings-mcp-tool-whitelist.mjs` now guards the Settings `MCP 服务` tool whitelist: it verifies Settings loads `list_agent_tools`, renders the `工具开关` section, displays every tool name, description, scope list, enabled state, and toggle action.
- The same script binds the UI row to the Rust built-in registry and test coverage: the canonical default whitelist is exactly 8 built-in tools and includes `ask_ai_model`.
- `docs/macos-smoke-checklist.md` now marks the Settings MCP tool whitelist row complete.

Verification:

- Red/green: the new script first passed Settings UI and Rust whitelist assertions, then failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **127/288 (44.1%) -> 128/288 (44.4%)**
- macOS smoke checklist alignment: **Settings MCP default tool whitelist unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the default built-in tool whitelist row. Plugin manifest tool whitelist behavior, `ask_ai_model` permission/audit rows, `find_local_files` ignore behavior row, remaining permission/audit UI rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 297: Settings MCP Config Merge Safety Smoke Closure

Completed:

- `scripts/test-settings-mcp-install-safety.mjs` now guards Settings `MCP 服务` config merge safety: it verifies the Settings merge action opens a JSON file picker before invoking writes, cancels without writing, calls `install_mcp_client_config` only with `serverName: "atools"` and `confirmed: true`, and surfaces backend errors through `mcpPageStatus`.
- Rust command tests now explicitly cover invalid existing JSON and non-object `mcpServers`: both cases return clear errors, preserve the original file content, and create no `*.atools-backup-*` side effects.
- `docs/macos-smoke-checklist.md` now marks the Settings MCP config merge safety row complete.

Verification:

- Red/green: the new Settings safety script first passed UI/backend behavior assertions and failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **126/288 (43.8%) -> 127/288 (44.1%)**
- macOS smoke checklist alignment: **Settings MCP invalid JSON/non-object merge protection unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Settings MCP config merge safety row. Tool whitelist/Agent tool behavior rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 296: Agent Panel MCP Merge-To-File Behavior Smoke Closure

Completed:

- `scripts/test-agent-panel-mcp-install.mjs` now guards the Agent/MCP `合并到文件...` flow: it verifies the AgentPanel action defaults the file picker to the shared suggested path, opens a JSON save dialog before invoking the write command, exits without invoking when the picker is cancelled, and calls `install_mcp_client_config` only with `serverName: "atools"` and `confirmed: true`.
- The same script ties the UI flow to Rust command coverage: unconfirmed writes must error without creating the target file, existing JSON writes must create a real `*.atools-backup-*` file, top-level fields and other `mcpServers` must be preserved, and stale `mcpServers.atools` entries must be replaced.
- `docs/macos-smoke-checklist.md` now marks the Agent/MCP panel merge-to-file behavior row complete.

Verification:

- Red/green: the new script first passed source behavior assertions and failed only on the unchecked smoke row; updating the checklist row turned it green.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **125/288 (43.4%) -> 126/288 (43.8%)**
- macOS smoke checklist alignment: **AgentPanel MCP merge-to-file behavior unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Agent/MCP independent panel merge-to-file behavior row. The Settings MCP invalid JSON / non-object `mcpServers` protection row, tool whitelist/Agent tool behavior rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 295: Agent Panel MCP Client Config Smoke Checklist Closure

Completed:

- `scripts/test-agent-panel-mcp-config.mjs` now guards AgentPanel MCP bind URL display, masked token, recommended transport, token safety hint, HTTP/stdout config copy actions, four shared client templates, install-plan target paths, merge steps, safe-merge state, copy actions, merge-to-file actions, and known Claude/Cursor suggested target paths.
- `docs/macos-smoke-checklist.md` now marks the 5 verified Agent/MCP panel client-config display rows complete.

Verification:

- Red/green: the new script first failed on an over-specific component string assumption, was corrected to verify shared template model output plus AgentPanel structure, then failed only on unchecked smoke rows before the checklist update.
- Follow-up full gates are tracked in the long plan Batch 295 section.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **120/288 (41.7%) -> 125/288 (43.4%)**
- macOS smoke checklist alignment: **AgentPanel MCP client config rows unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Agent/MCP panel client-config display/copy/template rows. The real merge-to-file behavior row, invalid-JSON protection row, tool whitelist/Agent tool behavior rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 294: Settings MCP And Data Overview Smoke Checklist Closure

Completed:

- `scripts/test-mcp-governance-overview.mjs` now guards Settings `MCP 服务` governance cards, audit-chain wording, permission policy rows, pending request actions, persistent grants, recent audit rows, masked token/recommended transport, and client template copy/merge UI.
- `scripts/test-data-settings-overview.mjs` now guards Settings `我的数据` overview cards, local privacy boundary wording, audit overview empty/populated sections, retention policy, prune action, and audit archive action.
- `docs/macos-smoke-checklist.md` now marks the 12 verified Settings `MCP 服务` rows and 3 verified `我的数据` overview rows complete.

Verification:

- Red/green: the two updated scripts first failed only on unchecked smoke rows after the source/model assertions passed.
- Follow-up full gates are tracked in the long plan Batch 294 section.

Completion:

- Agent/MCP local foundation: **99% -> 99%**
- Permissions and audit: **97% -> 97%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **105/288 (36.5%) -> 120/288 (41.7%)**
- macOS smoke checklist alignment: **Settings MCP/Data overview unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Settings `MCP 服务` page overview/governance/template display rows and `我的数据` overview rows. The separate Agent/MCP panel rows, config merge invalid-JSON protection row, tool whitelist/Agent tool behavior rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 293: Local Launch Responsive Row Smoke Checklist Closure

Completed:

- `src/components/SettingsPanel.svelte` now keeps Local Launch rows in a two-column shell at desktop and 1280px widths, with the path input on its own row and row actions below the fields instead of squeezing the inputs.
- `src/components/SettingsPanel.svelte` now stacks Local Launch fields at the 860px narrow breakpoint while keeping actions aligned to the content column.
- `scripts/test-local-launch-settings.mjs` now guards the 1280px and narrow Local Launch CSS rules and ties the responsive smoke row to the checked checklist item.
- `docs/macos-smoke-checklist.md` now marks the Local Launch responsive row layout smoke item complete.

Verification:

- Red/green: `pnpm test:local-launch-settings` first failed on missing 1280px responsive CSS, then after the CSS fix failed only on the unchecked smoke row, and passed after the checklist update.
- Follow-up full gates are tracked in the long plan Batch 293 section.

Completion:

- Settings shell and navigation: **88% -> 88%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **104/288 (36.1%) -> 105/288 (36.5%)**
- macOS smoke checklist alignment: **Local Launch responsive row unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Local Launch 1280px/narrow row layout drift. MCP/My Data rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 292: Home Search Shell And Grouped Results Smoke Checklist Closure

Completed:

- `scripts/test-z-mark.mjs` now verifies the Home search shell uses the prominent ZTools-style search input, keeps the right-side three-stroke Z badge, and ties that row to the checked smoke checklist item.
- `scripts/test-home-surface.mjs` now verifies empty search Home ordering, pinned empty state, `管理固定指令` navigation to `所有指令`, and the four compact first-screen entries stay tied to checked smoke rows.
- `scripts/test-result-presentation.mjs` now verifies grouped search-result presentation includes row title, description, source detail, and match label, and ties the `set` grouped-result row to the checked smoke row.
- `docs/macos-smoke-checklist.md` now marks the 6 verified Home shell, pinned-empty, first-screen entries, and grouped-result rows complete.

Verification:

- Red/green: the three updated scripts first failed only on unchecked smoke rows, after the underlying source/model assertions had passed.
- `pnpm test:z-mark`
- `pnpm test:home-surface`
- `pnpm test:result-presentation`
- Follow-up full gates are tracked in the long plan Batch 292 section.

Completion:

- Home/search experience: **88% -> 89%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **98/288 (34.0%) -> 104/288 (36.1%)**
- macOS smoke checklist alignment: **Home shell / pinned empty / first-screen entries / grouped results unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the top Home/search Web preview smoke drift. Local Launch narrow row layout is now closed in Batch 293; MCP/My Data rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 291: Home Icon And Result Metadata Smoke Checklist Closure

Completed:

- `scripts/test-home-quick-action-icons.mjs` now verifies the four Home quick actions use explicit SVG icons, avoid first-letter fallback, expose `打开...` aria labels, and stay tied to the checked smoke row.
- `scripts/test-home-recent-type-icons.mjs` now verifies recent/home command tiles use source-type SVG icons with the 38px tile shell and no title-letter fallback.
- `scripts/test-ztools-import-view.mjs` now verifies the ZTools import panel starts in a waiting state, exposes `选择目录并扫描`, does not auto-run import on mount, and keeps the import smoke row checked.
- `scripts/test-result-type-icons.mjs` now verifies search-result fallback icons cover system/app/folder/web/link/text/paste/history/alias/plugin while real app icons can still use Tauri asset conversion.
- `scripts/test-match-type-meta.mjs` now verifies alias/fuzzy match metadata and keeps the visual match-tone smoke row checked.
- `docs/macos-smoke-checklist.md` now marks the 5 verified Home/search icon, import-entry, fallback-icon, and match-tone rows complete.

Verification:

- Red/green: the five updated scripts first failed only on unchecked smoke checklist rows, after the existing behavior/model assertions had already passed.
- `pnpm test:home-quick-action-icons`
- `pnpm test:home-recent-type-icons`
- `pnpm test:ztools-import-view`
- `pnpm test:result-type-icons`
- `pnpm test:match-type-meta`
- Follow-up full gates are tracked in the long plan Batch 291 section.

Completion:

- Home/search experience: **87% -> 88%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **93/288 (32.3%) -> 98/288 (34.0%)**
- macOS smoke checklist alignment: **Home icons / import entry / result metadata unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Home quick-action icon, recent tile icon, ZTools import entry, result fallback icon, and match-tone smoke drift. Home pinned-empty management, first-screen import/plugin/Agent/settings entry visibility, result grouping for `set`, Local Launch narrow row layout, MCP/My Data rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remained open until Batch 292.

### Batch 290: Home Status And General Settings Smoke Checklist Closure

Completed:

- `scripts/test-search-status-bar.mjs` now verifies the 34px Home/search status bar, Settings-page status-bar exclusion, and fixed/recent status text stay tied to checked smoke rows.
- `scripts/test-home-search-overview.mjs` now verifies the Home search Z badge is rendered only on the Home surface and opens General settings through the existing badge click path.
- `scripts/test-home-surface.mjs` and `scripts/test-home-pinned-sections.mjs` now verify recent and pinned row limits remain `rows * 9`, including fixed-section capacity isolation, the one-row smoke expectations, and persisted pinned-row setting.
- `scripts/test-general-settings-overview.mjs` now verifies disabling `showRecentInSearch` hides Home recent items and keeps the smoke row checked.
- `scripts/test-settings-normalization.mjs` now exercises real settings persistence plus dark theme, orange theme color, custom theme color, color picker, and CSS variable application.
- `docs/macos-smoke-checklist.md` now marks the 11 verified Home status / General settings rows complete.

Verification:

- Red/green: the updated Home/status/general settings scripts first failed on unchecked smoke rows; `test:home-pinned-sections` also caught the generic fixed-section capacity row, and `test:settings-normalization` caught the stale dark-theme CSS expectation before the checklist red.
- `pnpm test:search-status-bar`
- `pnpm test:home-search-overview`
- `pnpm test:home-surface`
- `pnpm test:home-pinned-sections`
- `pnpm test:general-settings-overview`
- `pnpm test:settings-normalization`
- Follow-up full gates are tracked in the long plan Batch 290 section.

Completion:

- Settings shell and navigation: **88% -> 88%**
- Settings page functional parity: **99% -> 99%**
- Home/search experience: **86% -> 87%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **82/288 (28.5%) -> 93/288 (32.3%)**
- macOS smoke checklist alignment: **Home status / General settings unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Home status bar, Z badge navigation, recent/pinned row-limit, recent toggle, persistence, dark theme, orange theme, and custom color smoke drift. Local Launch narrow row layout, MCP/My Data rows, plugin certificate-chain/revocation, full sandbox isolation, signing, notarization, and auto-update remain open.

### Batch 289: Settings Shell Layout And Dialog Smoke Checklist Closure

Completed:

- `scripts/test-settings-header-style.mjs` now verifies the 94px Settings header, 72px tabs, small/large Z marks, three-stroke circular Z structure, centered more button dots, and related smoke rows.
- `scripts/test-settings-header-menu.mjs` now verifies the top more menu, runtime-info copy status, Esc-only menu close path, and return-home action stay tied to the smoke row.
- `scripts/test-settings-confirm-dialog.mjs` now verifies Settings destructive actions use the embedded confirm dialog, avoid browser `confirm`, and Esc/cancel close only the dialog.
- `scripts/test-settings-ztools-scale.mjs`, `test-settings-sidebar-style`, `test-settings-content-style`, `test-settings-controls-style`, and `test-settings-scrollbar-style` now bind the 860px shell, low-viewport `min(100vh, target)`, sidebar/content sizing, large controls, responsive max-width guard, and thin rounded scrollbars to checked smoke rows.
- `src/components/SettingsPanel.svelte` now adds `max-width: 100%` to narrow-viewport input/select/number controls, closing the overflow evidence gap found by the red test.
- `docs/macos-smoke-checklist.md` now marks the 9 verified Settings shell/layout/menu/dialog rows complete.

Verification:

- Red/green: the updated Settings style/menu/dialog scripts first failed on unchecked smoke rows; `test:settings-controls-style` also exposed the missing narrow-control `max-width: 100%` guard before the checklist red.
- `pnpm test:settings-header-style`
- `pnpm test:settings-header-menu`
- `pnpm test:settings-confirm-dialog`
- `pnpm test:settings-ztools-scale`
- `pnpm test:settings-sidebar-style`
- `pnpm test:settings-content-style`
- `pnpm test:settings-controls-style`
- `pnpm test:settings-scrollbar-style`
- Follow-up full gates are tracked in the long plan Batch 289 section.

Completion:

- Settings shell and navigation: **87% -> 88%**
- Settings page functional parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **73/288 (25.3%) -> 82/288 (28.5%)**
- macOS smoke checklist alignment: **Settings shell/layout/menu/dialog unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the Settings shell/layout/menu/dialog smoke drift. Home Z-icon navigation, pinned/recent status text, Local Launch narrow row layout, and general/MCP/My Data rows remain open until covered by targeted verification.

### Batch 288: Shortcuts Commands And Wakeup Blacklist Smoke Checklist Closure

Completed:

- `scripts/test-settings-pages.mjs` now verifies the hotkey quick-settings dropdown, the Shortcut settings three-tab structure, built-in app shortcut rows, custom shortcut creation/editing conflict state, and shortcut alias controls stay tied to checked smoke rows.
- `scripts/test-app-shortcuts.mjs` now verifies custom app shortcuts persist through settings normalization, are restored by the app settings path, trigger targets from the main search, and stay guarded in ordinary editable inputs.
- `scripts/test-command-center-settings.mjs` now verifies the Command Center page has summary cards, source filtering, target rows, alias actions, local/web enable toggles, system-command disabled state, search, and status filtering tied to checked smoke rows.
- `scripts/test-pinned-commands.mjs` now verifies Command Center pin/unpin uses the pinned command store, dispatches updates to the home surface, and renders pinned home items.
- `scripts/test-wakeup-blacklist.mjs` now verifies `添加当前窗口` reads the foreground app through desktop Tauri, disables itself in Web preview, and reports clear inline status.
- `docs/macos-smoke-checklist.md` now marks the 15 verified Shortcut / Command Center / Wakeup Blacklist rows complete.

Verification:

- Red/green: `pnpm test:settings-pages`, `pnpm test:app-shortcuts`, `pnpm test:command-center-settings`, `pnpm test:pinned-commands`, and `pnpm test:wakeup-blacklist` first failed because the verified smoke checklist rows were still unchecked.
- `pnpm test:settings-pages`
- `pnpm test:app-shortcuts`
- `pnpm test:command-center-settings`
- `pnpm test:pinned-commands`
- `pnpm test:wakeup-blacklist`
- `pnpm test:settings-normalization`
- `pnpm test:hotkey-recorder`
- `pnpm test:command-aliases`
- `pnpm test:home-pinned-sections`
- `pnpm check`
- `pnpm smoke:tauri-desktop`

Completion:

- Settings page functional parity: **99% -> 99%**
- Home/search experience: **86% -> 86%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist closure: **58/288 (20.1%) -> 73/288 (25.3%)**
- macOS smoke checklist alignment: **Shortcut / Command Center / Wakeup Blacklist unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the verified Shortcut, Command Center, and Wakeup Blacklist smoke drift. Direct responsive layout rows and MCP/My Data/general settings rows remain open until covered by targeted verification.

### Batch 287: Web Quick Open And Local Launch Smoke Checklist Closure

Completed:

- `scripts/test-web-quick-open-overview.mjs` now verifies Web quick-open defaults stay Google/GitHub/NPM, cards expose enable state, keyword chips, URL previews, actions, wrapped URLs, and the smoke checklist row remains checked.
- `scripts/test-web-quick-open-settings.mjs` now verifies the inline editor, search/direct mode switch, field editing, URL preview, Esc close path, validation delegate, delete confirmation, and related smoke checklist rows.
- `scripts/test-local-launch-settings.mjs` now verifies desktop picker wiring, Web preview picker guard, drag/drop area, manual add, row open/reveal/delete actions, delete confirmation, persisted add/remove behavior, and related smoke checklist rows.
- `docs/macos-smoke-checklist.md` now marks the verified Web quick-open and Local Launch rows complete while keeping the separate narrow-layout Local Launch row open.

Verification:

- Red/green: `pnpm test:web-quick-open-overview`, `pnpm test:web-quick-open-settings`, and `pnpm test:local-launch-settings` first failed because the verified smoke checklist rows were still unchecked.
- `pnpm test:web-quick-open-overview`
- `pnpm test:web-quick-open-settings`
- `pnpm test:local-launch-settings`
- `pnpm test:web-quick-open`
- `pnpm test:local-launch`
- `pnpm test:local-launch-overview`
- `pnpm check`
- `pnpm smoke:tauri-desktop`

Completion:

- Settings page functional parity: **99% -> 99%**
- Home/search experience: **86% -> 86%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist alignment: **Web quick-open/local launch unchecked -> verified and regression-guarded**

Remaining boundary:

- This closes the verified quick-open/local-launch smoke drift. Local Launch 1280px/narrow layout smoke is now closed in Batch 293.

### Batch 286: Debug Log Smoke Checklist Closure

Completed:

- `scripts/test-debug-settings-overview.mjs` now verifies the Debug Log page stays tied to the macOS smoke checklist and exposes environment info, desktop runtime diagnostics, local configuration status, MCP state, crash logs, and recent audit errors.
- `scripts/test-debug-diagnostics.mjs` now verifies copied debug info is an `atools_diagnostic_bundle` and does not contain MCP token, AI API Key, WebDAV password, or proxy credentials.
- The existing debug diagnostics model continues to cover runtime cards, local data diagnostics, audit error summaries, crash log summaries, warnings, and redacted settings output.
- `docs/macos-smoke-checklist.md` now marks the verified Debug Log page and copied diagnostic bundle rows complete.

Verification:

- Red/green: `pnpm test:debug-settings-overview` and `pnpm test:debug-diagnostics` first failed because the verified Debug Log smoke checklist rows were still unchecked.
- `pnpm test:debug-settings-overview`
- `pnpm test:debug-diagnostics`
- `cargo test -p atools commands::tests::runtime_diagnostics_snapshot_reports_paths_counts_mcp_and_events`
- `cargo test -p atools --test crash_tests`
- `pnpm check`
- `pnpm smoke:tauri-desktop`

Completion:

- Settings page functional parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist alignment: **Debug Log unchecked -> Debug Log verified and regression-guarded**

Remaining boundary:

- This closes Debug Log smoke drift for the current implementation. It does not complete release signing/notarization, auto-update, or the remaining manual smoke rows outside Debug Log.

### Batch 285: WebDAV Smoke Checklist Closure

Completed:

- `scripts/test-webdav-sync-view.mjs` now verifies the WebDAV macOS smoke checklist rows for Web-preview guards, sync/preview/plan summaries, settings restore, clipboard import, embedded confirmations, and current capability scope stay checked.
- `scripts/test-webdav-settings-overview.mjs` now verifies the WebDAV page fields, http/https enable gate, local credential/privacy copy, embedded confirmation ordering, cancel statuses, and append-only/redacted restore copy.
- Existing Rust WebDAV tests already cover remote upload plus manifest verification, preview read-only fetches, restore-plan diff generation, settings restore confirmation with redacted secret skipping, and clipboard import confirmation with append-only behavior.
- `docs/macos-smoke-checklist.md` now marks the verified WebDAV settings/sync/restore/import rows complete while keeping unrelated debug-log rows open.

Verification:

- Red/green: `pnpm test:webdav-sync-view` and `pnpm test:webdav-settings-overview` first failed because the verified WebDAV smoke checklist rows were still unchecked.
- `pnpm test:webdav-sync-view`
- `pnpm test:webdav-settings-overview`
- `cargo test -p atools --test webdav_tests`
- `cargo test -p atools commands::settings_command_tests::webdav_clipboard_import_appends_missing_entries_without_touching_existing_text`
- `cargo test -p atools commands::settings_command_tests::webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts`
- `pnpm check`
- `pnpm smoke:tauri-desktop`

Completion:

- Settings page functional parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist alignment: **WebDAV unchecked -> WebDAV verified and regression-guarded**

Remaining boundary:

- This closes WebDAV smoke drift for the current implementation. It does not add full remote-overwrite restore, live third-party WebDAV provider coverage, release signing/notarization, or auto-update.

### Batch 284: Installed Plugins Smoke Checklist Closure

Completed:

- `scripts/test-plugin-inventory.mjs` now verifies the six installed-plugin macOS smoke checklist rows stay checked once covered by model, UI, and native-command tests.
- The shared inventory model already covers total/enabled/disabled/feature counts, source labels, feature previews, query/status/source filters, selected plugin details, imported-vs-builtin action availability, and manifest capability audit rows.
- The SettingsPanel regression checks desktop-only local directory install/update, Finder reveal, authorization, uninstall confirmation, persistent runtime grant clearing, and Web preview guards.
- The existing Rust test covers local same-plugin updates preserving enabled state and rejecting installed source paths.
- `docs/macos-smoke-checklist.md` now marks the verified installed-plugin management rows complete.

Verification:

- Red/green: `pnpm test:plugin-inventory` first failed because the verified installed-plugin smoke checklist rows were still unchecked.
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `cargo test -p atools plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source`
- `pnpm check`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Settings page functional parity: **99% -> 99%**
- macOS smoke checklist alignment: **Installed plugins unchecked -> installed plugins verified and regression-guarded**

Remaining boundary:

- This closes installed-plugin management smoke drift for the current local implementation. Full plugin permission isolation, certificate-chain/revocation policy, and broader third-party plugin visual/native replay remain out of scope.

### Batch 283: AI Model Smoke Checklist Closure

Completed:

- `scripts/test-ai-settings-overview.mjs` now verifies the six AI model macOS smoke checklist rows stay checked once covered by implementation tests.
- The AI settings overview regression still requires provider/default model/Agent default/connection state cards, privacy copy, and local-only API key copy.
- The existing connection-view test covers the Web preview disabled connection button and `/models` result rows.
- The existing Rust tests cover `/v1/models` connection-test requests and `ask_ai_model` posting to `/v1/chat/completions` with the saved Agent AI settings while omitting API key from tool output.
- `docs/macos-smoke-checklist.md` now marks the verified AI model settings and Agent default model rows complete.

Verification:

- Red/green: `pnpm test:ai-settings-overview` first failed because the verified AI model smoke checklist rows were still unchecked.
- `pnpm test:ai-settings-overview`
- `pnpm test:ai-connection-view`
- `cargo test -p atools --test agent_tools_tests ask_ai_model_posts_chat_completion_using_agent_settings`
- `cargo test -p atools commands::settings_command_tests::ai_connection_test_fetches_models_and_reports_selected_model`

Completion:

- Settings page functional parity: **99% -> 99%**
- Agent/MCP local foundation: **99% -> 99%**
- macOS smoke checklist alignment: **AI model unchecked -> AI model verified and regression-guarded**

Remaining boundary:

- This closes the AI model settings smoke drift for the current local implementation. It does not prove live third-party provider credentials, streaming chat completions, or broader MCP client prompt flows.

### Batch 282: About Page Smoke Checklist Closure

Completed:

- `scripts/test-about-settings.mjs` now verifies the About page against the macOS smoke checklist instead of only checking loose source markers.
- The regression test requires copied About runtime info to hide the raw MCP token with `<hidden>`.
- The regression test requires the About page's `打开 MCP 服务` action to navigate directly to the `mcp` settings page.
- The macOS smoke checklist now marks the four verified `关于` page items complete: nonblank product facts, local environment rows, diagnostic actions, and MCP Service navigation.

Verification:

- Red/green: `pnpm test:about-settings` first failed because the verified About smoke checklist rows were still unchecked.
- `pnpm test:about-settings`
- `pnpm test:about-overview`

Completion:

- Settings page functional parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- macOS smoke checklist alignment: **About unchecked -> About verified and regression-guarded**

Remaining boundary:

- This closes the About page smoke checklist drift. It does not change the remaining settings smoke items for shortcuts, WebDAV, installed plugins, AI manual flows, or release signing/notarization/update configuration.

### Batch 281: Real Tauri Native Context Scope And Large Srcdoc Probe Hardening

Completed:

- `src-tauri/capabilities/default.json` now scopes `shell:allow-execute` to a named `osascript` command with only `["-e", { "validator": "(?s).+" }]` allowed, so PluginPanel context/shell bridges can execute their existing AppleScript paths instead of failing at Tauri capability lookup.
- `PluginPanel` desktop smoke now computes bridge-probe timeout from the prepared `srcdoc` size, with a 12s minimum and 15s cap. Large real plugin entries get more time to parse, run the injected probe, and complete the async native method checks.
- The desktop smoke script test now requires the scoped `osascript` capability, and the PluginPanel host-view test requires the dynamic timeout budget to receive `html.length`.
- Real standard and external-plan desktop smoke logs no longer show `Scoped command osascript not found`.

Verification:

- Red/green: `node scripts/test-tauri-desktop-smoke-script.mjs` failed until `shell:allow-execute` carried a scoped `osascript` command. A first attempted `shell:scope` entry also failed real Tauri build validation, which confirmed the correct schema is a scoped permission object.
- Red/green: `pnpm test:plugin-host-view` failed until `PluginPanel` added `desktopSmokeBridgeProbeTimeoutMs()` and passed `html.length` into `waitForDesktopSmokeBridgeProbe()`.
- `pnpm smoke:tauri-desktop`: passed with the default single indexed PluginPanel render sample, 5/5 bridge probe checks, and 4/4 native method probe checks.
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`: passed with 10 planned, 9 imported, 9 activated, 9 UI actions checked, 9 PluginPanel FS load specs checked, 9 assertions checked, 9 cleanup verified, 1 skipped, and `plugin_panel_render_smoke` rendering/probing 8/8 render-safe external plan samples with 40/40 bridge probe checks and 32/32 native method probe checks.
- `node scripts/test-tauri-desktop-smoke-script.mjs`
- `pnpm test:plugin-host-view`
- `pnpm check`

Completion:

- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- Third-party plugin regression scope: **native/system method probe queue -> scoped native context execution path plus large-srcdoc probe wait hardening**

Remaining boundary:

- This proves the current AppleScript bridge path is Tauri-scope reachable and that large real entries get a realistic probe budget. It still does not replace plugin-authored interaction replay, visual screenshots, side-effecting native bridge coverage, or full cross-origin sandbox isolation across every third-party plugin.

### Batch 280: Real Tauri PluginPanel Native Method Probe Smoke

Completed:

- Real Tauri `PluginPanel` desktop smoke now keeps the existing 5 synchronous iframe bridge probes and adds a separate async `nativeMethodProbes` result set from inside the same sandboxed plugin iframe.
- The new native/system method probes execute `utools.getPath("home")`, `utools.desktopCaptureSources({ types:["screen"] })`, `utools.readCurrentBrowserUrl()`, and `utools.readCurrentFolderPath()` for every rendered smoke sample.
- Smoke-only permission handling now grants only the fixed low-risk probe permissions (`system.path`, `screen.desktopCaptureSources`, `context.browser`, `context.finder`) when `VITE_ATOOLS_DESKTOP_SMOKE` is active; normal plugin runtime permissions stay unchanged.
- `plugin_panel_render_smoke` now reports native method aggregate fields: `native_method_probe_expected_samples`, `native_method_probe_reported_samples`, `native_method_probe_passed_samples`, `native_method_probe_checks`, `native_method_probe_passed_checks`, and `native_method_probe_failed_ids`.

Verification:

- Red/green: `pnpm test:plugin-host-view` failed until `PluginPanel` injected/reported `nativeMethodProbes` and included the native probe IDs.
- Red/green: `cargo test -p atools desktop_smoke::tests::plugin_panel_render_smoke_summary_accumulates_external_plan_reports` failed until the Rust report/summary structs aggregated `native_method_probe_*` fields.
- `pnpm smoke:tauri-desktop`: passed with the default single indexed PluginPanel render sample, 5/5 bridge probe checks, and 4/4 native method probe checks.
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`: passed with 10 planned, 8 imported, 8 activated, 8 UI actions checked, 8 PluginPanel FS load specs checked, 8 assertions checked, 8 cleanup verified, 2 skipped, and `plugin_panel_render_smoke` rendering/probing 6/6 external plan samples with 30/30 bridge probe checks and 24/24 native method probe checks.
- `node scripts/test-tauri-desktop-smoke-script.mjs`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `cargo fmt --check`
- `cargo test -p atools desktop_smoke`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Third-party plugin regression scope: **external plan iframe bridge probe queue -> external plan iframe native/system method probe queue, 6/6 samples, 30/30 bridge checks, and 24/24 native method checks**

Remaining boundary:

- This proves no-side-effect native/system method probes from real Tauri plugin iframes. It still does not replace plugin-authored interaction replay, visual screenshots, side-effecting native bridge coverage, or full cross-origin sandbox isolation across every third-party plugin.

### Batch 279: Real Tauri PluginPanel Iframe Bridge Probe Smoke

Completed:

- Real Tauri `PluginPanel` desktop smoke now injects a smoke-only iframe probe after the plugin bridge is installed.
- The probe runs inside the sandboxed plugin iframe and checks `utools/ztools` aliasing, `getWindowType()`, app identity, `dbStorage` roundtrip, and platform flag APIs without triggering dialogs, system automation, or native side effects.
- `plugin_panel_render_smoke` now reports bridge probe aggregate fields: `bridge_probe_expected_samples`, `bridge_probe_reported_samples`, `bridge_probe_passed_samples`, `bridge_probe_checks`, `bridge_probe_passed_checks`, and `bridge_probe_failed_ids`.
- Rust summary merging now keeps partial bridge-probe progress error-free while the action queue is still running, and only finalizes missing probe samples at snapshot time.

Verification:

- Red/green: `pnpm test:plugin-host-view` failed until `PluginPanel` handled `__atools_desktop_smoke_bridge_probe__`, waited for probe results, and reported bridge probe fields.
- Red/green: `cargo test -p atools desktop_smoke::tests::plugin_panel_render_smoke_summary_keeps_partial_bridge_probe_progress_error_free` reproduced and fixed the partial-progress error leak.
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`: passed with 10 planned, 8 imported, 8 activated, 8 UI actions checked, 8 PluginPanel FS load specs checked, 8 assertions checked, 8 cleanup verified, 2 skipped, and `plugin_panel_render_smoke` rendering/probing 7/7 external plan samples with 35/35 bridge probe checks.
- `pnpm smoke:tauri-desktop`: passed with the default single indexed PluginPanel render sample and 5/5 bridge probe checks.
- `node scripts/test-tauri-desktop-smoke-script.mjs`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `cargo test -p atools desktop_smoke`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Third-party plugin regression scope: **external plan filesystem render queue -> external plan iframe bridge probe queue, 7/7 samples and 35/35 checks**

Remaining boundary:

- This proves smoke-injected iframe bridge basics inside real Tauri `srcdoc`; it still does not replace plugin-authored interaction replay, visual screenshots, or full native/system bridge method probes across every third-party plugin.

### Batch 278: External Plan PluginPanel Render Queue Smoke

Completed:

- `desktop_smoke_plugin_panel_actions` now returns a queue of renderable PluginPanel actions. With `ATOOLS_ZTOOLS_ACTIVATION_PLAN` set, it imports valid external plan samples into `/tmp/atools-ztools-plugin-smoke`, reconstructs real `FeatureAction` payloads, marks them as external plan samples, and falls back to the indexed-plugin single-sample path when no plan actions are available.
- `PluginPanel` render reports now include `expected_samples`, `sample_index`, and `external_plan_sample`; the Rust summary merges per-sample reports into aggregate `reported_samples`, `rendered_samples`, `external_plan_expected_samples`, `external_plan_rendered_samples`, and `sample_plugin_ids`.
- The desktop smoke parser and static tests require those aggregate fields, require the frontend action queue/report wiring, and require the Tauri FS capability to allow the fixed smoke install root `/tmp/atools-ztools-plugin-smoke/**`.

Verification:

- Red/green: `node scripts/test-tauri-desktop-smoke-script.mjs` failed until `/tmp/atools-ztools-plugin-smoke/**` was added to `fs:scope`.
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`: passed with 10 planned, 8 imported, 8 activated, 8 UI actions checked, 8 PluginPanel FS load specs checked, 8 assertions checked, 8 cleanup verified, 2 skipped, and `plugin_panel_render_smoke` rendering 6/6 external plan samples.
- `pnpm smoke:tauri-desktop`: passed with the default single indexed PluginPanel render sample and empty external activation summary.
- `node scripts/test-tauri-desktop-smoke-script.mjs`
- `pnpm test:plugin-host-view`
- `cargo fmt --check`
- `pnpm check`
- `cargo test -p atools desktop_smoke`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Third-party plugin regression scope: **desktop PluginPanel FS load spec check -> renderable external plan PluginPanel queue, 6/6 rendered samples**

Remaining boundary:

- This proves the renderable external plan queue can reach real Tauri PluginPanel filesystem `srcdoc` loading. It still does not replace per-plugin visual screenshots, exhaustive interaction replay, or full native bridge probes inside every third-party iframe.

### Batch 276: Desktop PluginPanel FS Load Spec Smoke

Completed:

- `src-tauri/src/desktop_smoke.rs` now adds `ztools_external_activation_smoke.plugin_panel_fs_load_checked`.
- External activation smoke increments that count only when the imported plugin's `FeatureAction` can form the same filesystem load spec that real `PluginPanel.loadPluginHtml()` uses: canonical `plugin_path` matches the imported plugin directory, `main_url` is a relative file inside that directory, optional preload is inside the same directory, and payload does not use Web preview `iframeSrc` or `srcdoc`.
- `scripts/smoke-tauri-desktop.mjs` now treats `plugin_panel_fs_load_checked` as a required machine-readable smoke field.
- `src-tauri/tests/webdav_tests.rs` test fixtures now include `proxy_url: None`, so full `cargo test -p atools` compiles against the current `WebdavSyncConfig` shape.

Verification:

- Red/green: `cargo test -p atools --lib desktop_smoke::tests::ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample` first failed because `ZToolsExternalActivationSmokeSummary` had no `plugin_panel_fs_load_checked`; it passed after adding the field and FS load spec check.
- Red/green: `pnpm test:tauri-desktop-smoke-script` first failed because missing `plugin_panel_fs_load_checked` was not rejected; it passed after adding parser validation.
- `cargo test -p atools`: passed after updating WebDAV test fixture config fields, covering 75 lib tests, Agent tests, crash tests, WebDAV tests, and ZTools import tests.
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`: passed with 10 planned, 8 imported, 8 activated, 8 UI actions checked, 8 `plugin_panel_fs_load_checked`, 8 assertions checked, 8 cleanup verified, 2 skipped, `error:null`.
- `pnpm smoke:tauri-desktop`: passed with empty external activation summary and `plugin_panel_fs_load_checked:0`.
- `pnpm check`
- `pnpm build`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Testing/release confidence: **99% -> 99%**
- Third-party plugin regression scope: **`desktop FeatureAction payload check -> desktop PluginPanel filesystem load spec check, 8/8 imported samples`**

Remaining boundary:

- This proves real desktop activation results can form a valid filesystem load spec for `PluginPanel`; it is still not an automated rendered Tauri UI iframe check.
- It does not replace visual screenshots, full native bridge replay inside the rendered PluginPanel iframe, or real per-plugin interaction smoke.
- Certificate chain/revocation/platform trust, complete sandbox/cross-origin isolation beyond the current main iframe policy, BrowserWindow child iframe same-origin debt, signing, notarization, and auto-update remain outside this batch.

### Batch 275: Real Fixture Bridge API Probe Replay

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now defines 9 real-entry fixture bridge API probes covering `getPath`, `getContext`, `dbStorage`, `db.allDocs`, app identity, platform/dev flags, `Preload.ky`, shared services, and web storage.
- Generated real-entry fixtures execute those probes in the browser, expose `data-atools-real-entry-bridge-api-*` DOM attributes, retain `window.__atoolsRealEntryFixture.bridgeApiProbes`, and include the bridge API probe results in `__atools_real_entry_fixture_probe__`.
- The standalone real-entry fixture matrix aggregates bridge API probe counts and renders row-level `bridgeApi=X/Y bridgeApiFailed=...`; failed bridge API probes now fail the matrix row.
- The smoke report summary now records `real_entry_fixture_bridge_api_probe_checks`, and each plan's `real_entry_fixture.bridge_api_probe_ids` records the expected probe IDs.
- `scripts/test-ztools-plugin-ui-host-smoke-report.mjs` now asserts the summary count, per-plan bridge API probe IDs, generated fixture script markers, DOM attributes, and standalone matrix rendering.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because `real_entry_fixture_bridge_api_probe_checks` was missing (`undefined !== 18`); it passed after adding bridge API probe replay and matrix aggregation.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/`: 10/10 UI host samples, 10 generated fixtures, 3744497 fixture bytes, 10 standalone matrix fixtures, 12770 matrix bytes, 10/10 PluginPanel fixture URLs ready, 10 PluginPanel matrix panels, 27695 PluginPanel matrix bytes, 90 real-entry fixture bridge API probe checks, 85 runtime support files, and 6315299 runtime support bytes.
- Browser standalone matrix check with fixture server at `http://127.0.0.1:1434/index.html`: 10 fixture iframes, 10 rows, every row `ready ready=true bridge=true ztools=true identity=true bridgeApi=9/9 bridgeApiFailed= errors=0`, and Browser dev logs `[]`.
- Browser PluginPanel matrix check at `http://127.0.0.1:1434/plugin-panel-matrix.html`: 10 panel iframes, 10 rows, every row `ready passed=15/15 failed=`, and Browser dev logs `[]`.
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:ztools-ui-host-fixture-server`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Plugin runtime parity: **99% -> 99%**
- Third-party plugin regression scope: **`PluginPanel matrix resource-clean pass -> generated real-entry bridge API probe replay, standalone rows bridgeApi=9/9, PluginPanel rows passed=15/15`**

Remaining boundary:

- Matrix iframes still use Web preview `PluginPanel` URLs and local HTTP fixture URLs; this is not the real Tauri FS `PluginPanel` loading imported plugin directories.
- Bridge API probes run against the generated fixture bridge and browser storage stubs, not the full native/Tauri plugin bridge for every imported plugin page.
- This remains lifecycle/bridge/API row evidence, not pixel-perfect visual screenshot evidence.
- Certificate chain/revocation/platform trust, complete sandbox/cross-origin isolation beyond the current main iframe policy, BrowserWindow child iframe same-origin debt, signing, notarization, and auto-update remain outside this batch.

### Batch 274: PluginPanel Matrix Resource Clean Pass

Completed:

- Added `scripts/serve-ztools-ui-host-fixtures.mjs` and `pnpm serve:ztools-ui-host-fixtures` so local fixture validation serves files with CORS headers, `OPTIONS` preflight support, font/script/json MIME types, and path traversal protection.
- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now copies CSS `@import` / `url()` dependencies, including FontAwesome/ClearSans font files, into browser-resolved fixture paths.
- The real-entry fixture bridge now installs sandbox-safe `localStorage` and `sessionStorage` stubs when the sandboxed iframe lacks `allow-same-origin`, fixing the `latex-ocr` sandbox storage error without relaxing the main plugin iframe sandbox.
- `src/components/PluginPanel.svelte` now forwards real fixture error messages to the PluginPanel matrix; the matrix renders `messages=` diagnostics when a row fails.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed on missing CSS/font fixture support, missing matrix diagnostics, and missing sandbox storage stubs; it passed after the generator/bridge changes.
- Red/green: `pnpm test:ztools-ui-host-fixture-server` first failed because the CORS fixture server and package scripts were missing; it passed after adding the server.
- Red/green: `pnpm test:plugin-host-view` first failed because `PluginPanel` did not preserve forwarded real fixture error messages; it passed after adding `errors: errorMessages`.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/`: 10/10 UI host samples, 10 generated fixtures, 3702617 fixture bytes, 10 standalone matrix fixtures, 11608 matrix bytes, 10/10 PluginPanel fixture URLs ready, 10 PluginPanel matrix panels, 27695 PluginPanel matrix bytes, 85 runtime support files, and 6315299 runtime support bytes.
- Browser check with `pnpm serve:ztools-ui-host-fixtures -- --root output/ztools-ui-host-real-entry-fixtures --host 127.0.0.1 --port 1434`: matrix DOM reported expected 10, ready 10, errors 0, allReady true, 10 app iframes, every row `ready passed=6/6 failed=`, and Browser dev logs `[]`.
- `pnpm test:ztools-ui-host-fixture-server`
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Third-party plugin regression scope: **`PluginPanel matrix probe-only pass -> PluginPanel matrix resource-clean pass with CORS server, copied CSS/font assets, sandbox storage stub, and console 0 warn/error`**

Remaining boundary:

- Matrix iframes still use Web preview `PluginPanel` URLs and local HTTP fixture URLs; this is not the real Tauri FS `PluginPanel` loading imported plugin directories.
- The matrix is now clean for lifecycle/probe/script-error/console resources in Browser, but it is still not pixel-perfect visual screenshot evidence or full real bridge-probe replay for every plugin.
- Browser screenshot capture remains blocked by the known CDP timeout in this environment.
- Certificate chain/revocation/platform trust, complete sandbox/cross-origin isolation beyond the current main iframe policy, BrowserWindow child iframe same-origin debt, signing, notarization, and auto-update remain outside this batch.

### Batch 273: PluginPanel Real Fixture Matrix

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now emits top-level `real_entry_plugin_panel_matrix` beside generated fixtures.
- The matrix HTML embeds all ready `real_entry_plugin_panel.url` app preview URLs, so every row goes through the actual Web preview `PluginPanel` shell before loading the generated real fixture.
- `src/components/PluginPanel.svelte` now forwards real-entry fixture probe results to a parent matrix with `__atools_plugin_panel_real_entry_probe__`.
- Report summary now records `real_entry_plugin_panel_matrix_count` and `real_entry_plugin_panel_matrix_bytes`.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because PluginPanel matrix fields were missing; it passed after adding matrix generation.
- Red/green: `pnpm test:plugin-host-view` first failed because `PluginPanel` did not forward real-entry probes to parent matrix pages; it passed after adding the matrix postMessage path.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1434/`: 10/10 UI host samples, 10 generated fixtures, 3691187 fixture bytes, 10 standalone matrix fixtures, 11608 matrix bytes, 10/10 PluginPanel fixture URLs ready, 10 PluginPanel matrix panels, 27351 PluginPanel matrix bytes, 70 runtime support files, and 4949752 runtime support bytes.
- Browser check: app served at `localhost:1420`, fixture matrix served at `127.0.0.1:1434/plugin-panel-matrix.html`; matrix DOM reported expected 10, ready 10, errors 0, allReady true, 10 app iframes, and every row `ready passed=6/6 failed=`.
- Playwright full-frame console still reports known deeper asset/runtime boundaries: 26 errors and 12 warnings from sandbox/null-origin FontAwesome fonts, dynamic chunk CORS, JSON preflight, codec script loading, favicon, target-densitydpi warnings, and one third-party Umami init error.
- Batch 274 later resolves this PluginPanel matrix Browser resource/console boundary with the CORS fixture server, CSS/font support copying, and sandbox storage stubs.
- Matrix proof is PluginPanel lifecycle/bridge/script-error probe readiness, not complete visual asset coverage.
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Third-party plugin regression scope: **`first PluginPanel fixture -> all 10 generated fixtures loaded through Web preview PluginPanel matrix with probe 6/6`**

Remaining boundary:

- Matrix iframes use Web preview `PluginPanel` URLs and local HTTP fixture URLs; this is still not the real Tauri FS `PluginPanel` loading imported plugin directories.
- The matrix proves host shell/lifecycle/bridge/probe readiness for all 10 generated fixtures, not pixel-perfect visuals or full decorative/runtime asset coverage.
- Browser screenshot capture remains blocked by the known CDP timeout in this environment.
- True bridge probe replay against every plugin page, certificate chain/revocation/platform trust, complete sandbox/cross-origin isolation, BrowserWindow child iframe same-origin debt, signing, notarization, and auto-update remain outside this batch.

### Batch 272: PluginPanel Real Fixture URL Smoke

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now accepts `--fixture-base-url` and emits per-plan `real_entry_plugin_panel` smoke URLs.
- `real_entry_plugin_panel` loads the generated real fixture through Web preview `PluginPanel` using `payload.iframeSrc` instead of embedding third-party HTML into `srcdoc`.
- Generated real fixtures now post named real-entry probe results back to their parent: ready, bridge, ztools alias, identity, and script-error status.
- `src/components/PluginPanel.svelte` now supports preview iframe `src` and keeps `srcdoc` mutually exclusive when a generated fixture URL is active.
- `PluginPanel` now consumes `__atools_real_entry_fixture_probe__` messages and converts them into the existing `宿主探针` runtime chip.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because `real_entry_plugin_panel_*` summary fields and action payload were missing; it passed after adding `real_entry_plugin_panel`.
- Red/green: `pnpm test:plugin-host-view` first failed because `PluginPanel` lacked `iframeSrc` state and real fixture probe handling; it passed after adding preview iframe URL support.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures --fixture-base-url http://127.0.0.1:1432/`: 10/10 UI host samples, 10/10 real entry HTML ready, 30/30 local script/stylesheet resources ready, 10 generated fixtures, 3691187 fixture bytes, 10 matrix fixtures, 11608 matrix bytes, 10/10 PluginPanel fixture URLs ready, 70 runtime support files, and 4949752 runtime support bytes.
- Browser check: served fixtures at `127.0.0.1:1432`, opened the first `real_entry_plugin_panel.url` in the app at `localhost:1420`, and verified title `计算稿纸`, iframe `src=http://127.0.0.1:1432/001-calculation-paper-calc.html`, empty `srcdoc`, sandbox `allow-scripts allow-popups`, runtime `iframe`, bridge chip, `宿主探针 6/6`, no horizontal overflow, no Vite error overlay, and Browser dev logs 0 warn/error.
- Browser screenshot capture still timed out on `Page.captureScreenshot`, so screenshot pixels are not used as pass evidence.
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Plugin iframe host parity: **99% -> 99%**
- Third-party plugin regression scope: **`all 10 standalone fixture matrix -> plus first generated real fixture loaded through the actual PluginPanel shell via iframe src and probe chip`**

Remaining boundary:

- This batch verifies the first generated fixture through Web preview `PluginPanel`; it does not yet run all 10 generated fixtures through app `PluginPanel`.
- The iframe source is a local HTTP fixture URL, not the real app `PluginPanel` loading imported plugins through Tauri FS.
- The current app `PluginPanel` sandbox still excludes `allow-same-origin`; this is intentional for parity/security but means future all-fixture PluginPanel replay may expose additional CORS/module/fetch gaps.
- Pixel-perfect visual screenshots, full runtime asset coverage, true bridge probe replay against every plugin page, certificate chain/revocation/platform trust, complete sandbox/cross-origin isolation, BrowserWindow child iframe same-origin debt, signing, notarization, and auto-update remain outside this batch.

### Batch 271: Real Entry Fixture Matrix Verification

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now writes an `index.html` matrix harness beside generated real entry fixtures.
- The matrix loads all generated fixture HTML files in same-origin iframes and exposes DOM-readable expected/ready/error/all-ready markers.
- Fixture generation now copies runtime support files needed by real browser execution, including sibling dynamic JS/CSS/JSON/assets and plugin-root `json/`.
- The fixture bridge now reports DOM-readable error messages, passes a realistic plugin enter context, exposes `db.promises`, sync path/context/platform helpers, and common preload service stubs such as `window.services`, `window.Preload.ky.create`, and `formatMybatisLog`.
- Report summary now records fixture matrix count/bytes and runtime support file/byte totals.

Verification:

- Red/green: fixture matrix summary and generated `index.html` assertions failed first, then passed after adding the matrix harness.
- Red/green: DOM-readable fixture error-message assertions failed first, then passed after adding `data-atools-real-entry-error-messages`.
- Red/green: bridge/context/service/runtime-support assertions failed first, then passed after adding `getPath`, `getContext`, realistic enter context, `db.promises`, service stubs, copied dynamic chunks, plugin-root `json/`, and runtime support summary fields.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures`: 10/10 UI host samples, 10/10 real entry HTML ready, 30/30 local script/stylesheet resources ready, 10 generated fixtures, 3684367 fixture bytes, 10 matrix fixtures, 11608 matrix bytes, 70 runtime support files, and 4949752 runtime support bytes.
- Browser matrix check through local HTTP at `127.0.0.1:1431/index.html`: expected 10, ready 10, errors 0, allReady true, every row bridge/ztools/identity ready, and console 0 warn/error.
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **99% -> 99%**
- Third-party plugin regression scope: **`first real fixture rendered -> all 10 generated real entry fixtures browser-matrix executed with lifecycle/bridge identity ready and 0 script errors`**

Remaining boundary:

- Matrix fixtures are standalone browser fixtures, not yet the real app `PluginPanel` iframe loading imported plugins through Tauri FS.
- Matrix proves lifecycle/bridge identity/script-error readiness, not pixel-perfect visual screenshots or every runtime asset; font/image/MathJax decorative assets still need a deeper visual resource pass.
- Browser screenshot capture remains blocked by the known CDP timeout in this environment.
- Certificate chain, revocation, platform trust, complete sandbox/cross-origin isolation, BrowserWindow child iframe same-origin debt, signing, notarization, and auto-update remain outside this batch.

### Batch 270: Real Entry Browser Fixture Emission

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now supports `--fixture-output`.
- When a fixture output directory is provided, each real entry HTML sample is emitted as a browser-loadable fixture file under that directory.
- Fixture generation inlines local entry scripts and stylesheets, injects a minimal `utools`/`ztools` bridge before plugin code, and adds DOM-readable probe markers for fixture identity, ready state, bridge presence, and ztools alias.
- Each UI host plan now includes `real_entry_fixture` with status, path, file URL, byte size, SHA-256, inlined script/stylesheet counts, and probe ids.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because `real_entry_fixture_bytes` was missing; it passed after adding fixture generation.
- Red/green: a follow-up test first failed because the generated fixture did not expose a DOM-readable bridge marker; it passed after adding `data-atools-real-entry-bridge-present` and `data-atools-real-entry-ztools-alias`.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/ --fixture-output output/ztools-ui-host-real-entry-fixtures`: 10/10 UI host samples, 10/10 real entry HTML ready, 30/30 local script/stylesheet resources ready, 10 generated fixtures, and 3644645 fixture bytes.
- Browser check: direct `file://` was blocked by Browser URL policy, so the fixture directory was served through local HTTP at `127.0.0.1:1430`.
- Browser rendered first fixture `001-calculation-paper-calc.html`: visible DOM contained the real `计算公式` textbox and action buttons, `data-atools-real-entry-fixture=true`, `data-atools-real-entry-ready=true`, `data-atools-real-entry-bridge-present=true`, `data-atools-real-entry-ztools-alias=true`, plugin id `calculation-paper`, feature code `calc`, and console 0 warn/error.
- `pnpm test:ztools-plugin-ui-host-smoke-report`

Completion:

- Plugin install/import/market: **98% -> 99%**
- Third-party plugin regression scope: **`real local dependency readiness/hash baseline -> plus browser-loadable real HTML fixtures with bridge/lifecycle DOM probes and first fixture rendered`**

Remaining boundary:

- This batch renders the first generated real fixture through Browser, but it does not yet run all 10 fixtures through an automated Browser loop.
- Generated fixtures are standalone browser fixtures, not yet the real app `PluginPanel` iframe loading the imported plugin through Tauri FS.
- Browser screenshot capture remains blocked by the known CDP timeout in this environment.
- Real per-plugin visual screenshot and true bridge probe assertions against all actual plugin pages are still pending.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 269: Real Entry Resource Dependency Baseline

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now parses each real entry HTML file for local `<script src>` and stylesheet `<link rel="stylesheet">` dependencies.
- Each UI host plan now includes `real_entry_resources` with total/ready/missing counts, total bytes, script resource details, stylesheet resource details, and missing resource records.
- Script resources record `kind`, original URL, resolved absolute path, `module` flag, byte size, and SHA-256.
- Stylesheet resources record `kind`, original URL, resolved absolute path, byte size, and SHA-256.
- Non-local URLs such as HTTP(S), protocol-relative, data URLs, and hash-only references are skipped instead of being counted as missing local files.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because summary lacked `real_entry_resource_*` counts; it passed after adding local script/stylesheet dependency collection.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/`: 10/10 UI host samples, 10/10 real entry HTML ready, 30/30 local script/stylesheet resources ready, 0 missing resources, and 3530202 dependency bytes.
- First real dependency sample: `calculation-paper -> index.js`, 1025290 bytes, SHA-256 `f501c6389c211754cf459253c9e6f9d204b44d59cc65b08b29e30665a535a54a`.
- `pnpm test:ztools-plugin-ui-host-smoke-report`

Completion:

- Plugin install/import/market: **97% -> 98%**
- Third-party plugin regression scope: **`real entry HTML readiness/hash baseline -> plus real local script/stylesheet dependency readiness/hash baseline for every UI host sample`**

Remaining boundary:

- This batch still does not execute the 10 real third-party HTML pages in an app iframe; it proves entry scripts/stylesheets are present and traceable before real rendering.
- Browser screenshot capture remains blocked by the known CDP timeout in this environment.
- Real per-plugin iframe-ready, visual screenshot, and bridge probes against actual plugin pages are still pending.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 268: Real Entry HTML Readiness Baseline

Completed:

- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now reads each sample's real `manifest.main` HTML from the external plugin source path.
- Each UI host plan now includes `real_entry_html` with readiness status, `main_url`, absolute `html_path`, entry directory, relative entry directory, byte size, SHA-256, and resource signals.
- Resource signals currently count script `src`, module scripts, inline scripts, stylesheet links, image/media `src` references, and direct `utools`/`ztools` bridge references in the entry HTML.
- The Web preview fixture still uses the minimal probe `srcdoc`; this batch adds real entry evidence without embedding third-party plugin HTML into generated URLs.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because summary lacked `real_entry_html_*` counts; it passed after adding real entry HTML readiness collection.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/`: 10/10 UI host samples, 10 iframe-ready checks, 20 screenshot viewport checks, 50 bridge probes, 10/10 real entry HTML ready, 0 missing, and 80631 real entry HTML bytes.
- First real entry HTML sample: `calculation-paper -> index.html`, 163 bytes, SHA-256 `d776b6d7eb19b9cecf2319ce529a2d17dbf8c0a03de954bb1f18b6197ef7add0`, 1 external script, 0 stylesheet links, 0 image/media refs.
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:plugin-host-view`
- `pnpm check` (0 errors / 0 warnings)
- `pnpm build` (passes with the existing Vite chunk-size warning)

Completion:

- Plugin install/import/market: **96% -> 97%**
- Third-party plugin regression scope: **`host-side probe recovery -> plus real entry HTML readiness/hash/resource baseline for every UI host sample`**

Remaining boundary:

- This batch does not execute the 10 real third-party HTML pages in the iframe; it proves their entry files are present and traceable as automation inputs.
- Browser screenshot capture remains blocked by the known CDP timeout in this environment.
- Real per-plugin iframe-ready, visual screenshot, and bridge probes against actual plugin pages are still pending.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 267: ExternalPlan Probe Result Recovery

Completed:

- `src/lib/pluginHostView.ts` now includes a `宿主探针` runtime chip when recovered UI host probe counts are available.
- `src/components/PluginPanel.svelte` now handles `__atools_ui_host_probe_result__`, ignores stale plugin/feature reports, normalizes pass/fail counts, and resets probe state when the active plugin changes.
- `scripts/ztools-plugin-ui-host-smoke-report.mjs` now makes the externalPlan `srcdoc` report 5 named lifecycle/bridge probes after the iframe receives host lifecycle messages.
- The recovered probes cover plugin enter event, plugin ready event, `utools` bridge presence, `ztools` alias presence, and iframe DOM identity.

Verification:

- Red/green: `pnpm test:plugin-host-view` first failed because the runtime strip still ended at `桥接能力`; it passed after adding the recovered `宿主探针` chip.
- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because generated externalPlan HTML did not post `__atools_ui_host_probe_result__`; it passed after adding probe collection and parent `postMessage`.
- Real report regenerated with `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/`: 10/10 UI host samples, 10 iframe-ready checks, 20 screenshot viewport checks, 50 bridge probes, and top plan `calculation-paper -> calc`.
- Browser rendered check: the first externalPlan URL loaded `ATools 3.0`, rendered `计算稿纸`, showed the bridge strip and `宿主探针 5/5`, used sandbox `allow-scripts allow-popups`, had console 0 warn/error, no framework overlay, and no horizontal overflow.
- Browser screenshot capture still timed out at `Page.captureScreenshot`, so screenshot pixels are still not pass evidence for this batch.
- `pnpm test:plugin-host-view`
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm check` (0 errors / 0 warnings)
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop` passed serially after an initial parallel smoke attempt failed only because two Vite instances raced on port 1420.
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop` passed with 10 planned, 8 imported, 8 activated, 8 UI actions checked, 8 assertions checked, 8 cleanup verified, 2 skipped collisions, and no error.

Completion:

- Plugin install/import/market: **95% -> 96%**
- Third-party plugin regression scope: **`UI host fixture/report baseline -> plus host-side probe result recovery visible in PluginPanel`**

Remaining boundary:

- The externalPlan page still uses a minimal `srcdoc`; it does not execute every real third-party plugin HTML page.
- Browser screenshot capture is still blocked by the known CDP timeout in this environment.
- Real per-plugin bridge probes against actual plugin pages are still pending.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 266: External ZTools UI Host Smoke Report

Completed:

- Added `scripts/ztools-plugin-ui-host-smoke-report.mjs`.
- Added `pnpm report:ztools-ui-host-smoke` and `pnpm test:ztools-plugin-ui-host-smoke-report`.
- The report consumes `output/ztools-plugin-activation-plan.json` and emits per-sample desktop `FeatureAction` fixtures, Web preview `pluginHostSmoke=externalPlan` URLs, iframe-ready expectations, 2 screenshot viewports per sample, and 5 bridge probes per sample.
- `src/App.svelte` now supports `pluginHostSmoke=externalPlan` by decoding a base64url UTF-8 `pluginHostSmokeAction` fixture into a `FeatureAction`.
- The Web preview fixture intentionally uses a minimal probe `srcdoc` instead of copying third-party plugin HTML into the generated report.

Verification:

- Red/green: `pnpm test:ztools-plugin-ui-host-smoke-report` first failed because the UI host smoke report builder did not exist; it passed after adding the report script, package entries, and App preview mode.
- Debug red/green: Browser validation exposed mojibake in the generated Chinese plugin title because App decoded UTF-8 base64url data with raw `atob()`; the test then failed on the missing `TextDecoder` path and passed after switching to UTF-8 byte decoding.
- Real report: `pnpm report:ztools-ui-host-smoke -- --plan output/ztools-plugin-activation-plan.json --output output/ztools-plugin-ui-host-smoke-report.json --base-url http://localhost:1420/` produced 10 UI host samples from 10 planned samples, 10 iframe-ready checks, 20 screenshot viewport checks, 50 bridge probes, 6 preload-expected samples, 0 skipped, and top plan `calculation-paper -> calc`.
- Browser rendered check: `http://localhost:1420/?parity=1&pluginHostSmoke=externalPlan&pluginHostSmokeAction=...` loaded `ATools 3.0`, rendered `计算稿纸`, stayed in iframe mode, showed the bridge capability strip, used sandbox `allow-scripts allow-popups`, had no relevant console warnings/errors, no framework overlay, and no horizontal overflow.
- Browser screenshot capture still timed out at `Page.captureScreenshot`, so screenshot pixels are not pass evidence for this batch.
- `pnpm test:ztools-plugin-ui-host-smoke-report`
- `pnpm test:ztools-plugin-activation-plan`
- `pnpm test:plugin-host-view`
- `pnpm check` (0 errors / 0 warnings)
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop`
- `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop` passed with 10 planned, 8 imported, 8 activated, 8 UI actions checked, 8 assertions checked, 8 cleanup verified, 2 skipped collisions, and no error.

Completion:

- Plugin install/import/market: **94% -> 95%**
- Third-party plugin regression scope: **`FeatureAction` payload evidence -> plus executable UI host fixture/report baseline for iframe-ready, bridge-probe, and screenshot-viewport automation**

Remaining boundary:

- The report is an executable fixture baseline; it still does not run every real third-party plugin HTML page through iframe-ready, screenshot, and bridge assertions.
- Browser screenshot capture is still blocked by the known CDP timeout in this environment.
- The 2 desktop activation skipped samples remain skipped because their feature codes already belong to existing installed plugins.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 265: External ZTools Activation Smoke Validates Plugin Host Payload

Completed:

- Extended `ztools_external_activation_smoke` with `ui_actions_checked`.
- The external activation desktop smoke now calls the same `activate_feature_inner` path used by real feature launch after importing each external sample.
- The smoke validates the returned `FeatureAction` payload needed by `PluginPanel`: expected plugin id, feature code, plugin directory, entry `main_url`, optional preload file, and capped `expand_height`.
- The success condition now requires imported samples, activated samples, UI action payload checks, assertions, and cleanup counts to match.

Verification:

- Red/green: `cargo test -p atools --lib ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample` first failed on the missing `ui_actions_checked` field; it passed after adding the summary field and `activate_feature_inner` payload validation.
- External plan smoke: `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:65409"`, and `ztools_external_activation_smoke` reporting 10 planned samples, 8 imported, 8 activated, 8 UI actions checked, 8 assertions checked, 8 cleanup verified, 2 skipped collisions, and no error.
- Standard smoke: `pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:49688"`, and empty no-plan `ztools_external_activation_smoke` counts including `ui_actions_checked:0`.
- `cargo test -p atools --lib desktop_smoke` (10 passed)
- `cargo test -p atools --test ztools_import_tests` (3 passed)
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm test:ztools-plugin-activation-plan`
- `pnpm test:ztools-plugin-runtime-sample-report`
- `pnpm test:ztools-plugin-compatibility-report`
- `pnpm test:ztools-import-view`
- `pnpm check` (0 errors / 0 warnings)
- `pnpm build` (passes with the existing Vite chunk-size warning)

Completion:

- Plugin install/import/market: **93% -> 94%**
- Third-party plugin regression scope: **desktop import/index/activation lookup/assertion/cleanup -> plus `FeatureAction` payload evidence for the `PluginPanel` host**

Remaining boundary:

- This still is not visual UI load, iframe-ready screenshot validation, or per-plugin bridge-call replay.
- Two planned samples are still skipped because their feature codes already belong to existing installed plugins.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 264: Desktop Smoke Consumes External ZTools Activation Plan

Completed:

- Extended desktop smoke output with `ztools_external_activation_smoke`.
- Added `ATOOLS_ZTOOLS_ACTIVATION_PLAN` support so real Tauri desktop smoke can consume `output/ztools-plugin-activation-plan.json`.
- The external activation smoke imports planned samples with the existing ZTools import path, verifies feature-code activation lookup, plugin path, main/preload assertions, and cleanup of imported plugin DB rows and install files.
- Feature-code collisions with existing installed plugins are skipped instead of overwriting built-in feature ownership.
- Relative activation plan paths are resolved against the repo root even when the Tauri process starts from `src-tauri`.

Verification:

- Red/green: `cargo test -p atools --lib ztools_external_activation_smoke_consumes_plan_imports_and_cleans_up_sample` first failed because the desktop smoke activation summary function did not exist; it passed after adding plan parsing, import/lookup/assertion/cleanup logic.
- Debug red/green: `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop` first failed because the Tauri process resolved the relative plan path from the wrong cwd; `cargo test -p atools --lib ztools_activation_plan_path_resolves_repo_relative_output_from_tauri_cwd` then failed on the missing resolver and passed after adding repo-root fallback path resolution.
- External plan smoke: `ATOOLS_ZTOOLS_ACTIVATION_PLAN=output/ztools-plugin-activation-plan.json pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:63786"`, and `ztools_external_activation_smoke` reporting 10 planned samples, 8 imported, 8 activated, 8 assertions checked, 8 cleanup verified, 2 skipped collisions, and no error.
- Standard smoke: `pnpm smoke:tauri-desktop` still passed with `status:"ok"` and an empty skipped `ztools_external_activation_smoke` summary.
- `cargo test -p atools --lib desktop_smoke` (10 passed)
- `cargo test -p atools --test ztools_import_tests` (3 passed)
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm test:ztools-plugin-activation-plan`
- `pnpm test:ztools-plugin-runtime-sample-report`
- `pnpm test:ztools-plugin-compatibility-report`
- `pnpm test:ztools-import-view`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)

Completion:

- Plugin install/import/market: **92% -> 93%**
- Third-party plugin regression scope: **activation smoke plan baseline -> plus real desktop import/index/activation lookup/assertion/cleanup smoke over selected external samples**

Remaining boundary:

- The smoke still does not visually open each external plugin UI or exercise per-plugin bridge calls.
- Two planned samples are skipped because their feature codes already belong to existing installed plugins; the smoke avoids corrupting feature ownership.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 263: Real ZTools Activation Smoke Plan

Completed:

- Added `scripts/ztools-plugin-activation-plan.mjs`, a read-only activation plan generator that turns ranked external runtime candidates into concrete desktop smoke steps.
- Added `pnpm report:ztools-activation-plan` and `pnpm test:ztools-plugin-activation-plan`.
- Each plan item includes the source plugin directory, expected sanitized install ID, install root, overwrite behavior, enabled-after-import expectation, selected feature code, trigger type/query or typed payload, runtime assertions, risk list, and cleanup instructions.
- Generated the current baseline at `output/ztools-plugin-activation-plan.json`.

Verification:

- Red/green: `pnpm test:ztools-plugin-activation-plan` first failed because the activation plan module did not exist; it passed after adding plan generation, manifest feature/cmd parsing, text/regex/typed trigger selection, expected install ID normalization, assertions, and cleanup output.
- Real sample plan: `pnpm report:ztools-activation-plan -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-activation-plan.json --limit 10 --install-root /tmp/atools-ztools-plugin-smoke` produced 10 plans from 61 launchable plugins, skipped 64 blocked plugins, selected 10 ready plans, 0 risk plans, and all 10 have text triggers. The top plan is `calculation-paper -> calc`.
- `pnpm test:ztools-plugin-runtime-sample-report`
- `pnpm test:ztools-plugin-compatibility-report`
- `pnpm test:ztools-import-view`
- `cargo test -p atools --test ztools_import_tests`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:61353"`, `agent_tools_count:8`, and plugin runtime smoke passing on sample plugin `calculator` / `calc`.

Completion:

- Plugin install/import/market: **91% -> 92%**
- Third-party plugin regression scope: **ranked runtime activation candidate baseline -> plus executable activation smoke plan baseline**

Remaining boundary:

- The plan is still not the actual desktop loop that imports, enables, activates, visually verifies, and cleans up every selected external plugin.
- The next runtime regression step should consume `output/ztools-plugin-activation-plan.json` from a desktop smoke harness and record per-plugin pass/fail evidence.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 262: Real ZTools Runtime Sample Candidate Report

Completed:

- Added `scripts/ztools-plugin-runtime-sample-report.mjs`, a read-only runtime sample candidate scanner that builds on the real manifest compatibility report.
- Added `pnpm report:ztools-runtime-samples` and `pnpm test:ztools-plugin-runtime-sample-report`.
- The report classifies external plugins as `ready`, `risk`, or `blocked` for follow-up runtime smoke by checking main HTML availability, macOS platform support, local entry resource existence, external entry resources, missing preload files, and Electron/Node preload require signals.
- Generated the current baseline at `output/ztools-plugin-runtime-sample-report.json`.

Verification:

- Red/green: `pnpm test:ztools-plugin-runtime-sample-report` first failed because the runtime sample report module did not exist; it passed after adding the scanner, CLI writer, entry-resource analysis, preload-risk analysis, scoring, and sample selection.
- Real sample report: `pnpm report:ztools-runtime-samples -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-runtime-sample-report.json --limit 20` scanned 125 manifests, found 61 launchable plugins, 21 ready candidates, 40 risk candidates, 64 blocked plugins, 10 plugins with missing local entry resources, 6 plugins with external entry resources, 4 missing preload files, 26 Electron preload require signals, and 69 Node preload require signals. The report selected 20 ranked sample candidates for follow-up activation smoke.
- `pnpm test:ztools-plugin-compatibility-report`
- `pnpm test:ztools-import-view`
- `cargo test -p atools --test ztools_import_tests`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:59508"`, `agent_tools_count:8`, and plugin runtime smoke passing on sample plugin `calculator` / `calc`.

Completion:

- Plugin install/import/market: **90% -> 91%**
- Third-party plugin regression scope: **manifest compatibility baseline -> plus ranked runtime activation candidate baseline**

Remaining boundary:

- The new report still does not automatically import, enable, activate, or visually verify every third-party plugin.
- Full runtime regression still needs a desktop activation loop over selected external samples, UI load evidence, bridge-call evidence, and cleanup.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 261: Real ZTools Plugin Compatibility Report

Completed:

- Added `scripts/ztools-plugin-compatibility-report.mjs`, a read-only compatibility scanner for real ZTools plugin directories.
- The scanner recursively finds `plugin.json` while skipping `node_modules`, parses manifest metadata, validates `main` / `preload` / `logo` files, checks macOS platform support, counts features and commands, records unsupported typed command families, and reports duplicate feature codes across plugins.
- Added `pnpm report:ztools-compat` to produce a human summary or JSON report, plus `pnpm test:ztools-plugin-compatibility-report` for deterministic fixture coverage.
- Generated a current real-sample baseline at `output/ztools-plugin-compatibility-report.json` from `/Users/harris/Desktop/ZTools-plugins/plugins`.

Verification:

- Red/green: `pnpm test:ztools-plugin-compatibility-report` first failed because the compatibility report module did not exist; it passed after adding the scanner, CLI writer, fixture parser, summary metrics, unsupported cmd type counts, and duplicate feature-code reporting.
- Real sample report: `pnpm report:ztools-compat -- --source /Users/harris/Desktop/ZTools-plugins/plugins --output output/ztools-plugin-compatibility-report.json` scanned 125 manifests, found 59 compatible, 6 warning, 60 error, 254 features, 738 commands, 0 unsupported cmd-type plugins, and 11 duplicate feature-code groups. The dominant error class is missing built `main` files in source-style plugin packages.
- `pnpm test:ztools-import-view`
- `cargo test -p atools --test ztools_import_tests`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:56588"`, `agent_tools_count:8`, and plugin runtime smoke passing on sample plugin `calculator` / `calc`.

Completion:

- Plugin install/import/market: **89% -> 90%**
- Testing/regression scope: **real third-party manifest compatibility now has a reproducible report baseline**

Remaining boundary:

- The report is manifest/import compatibility, not full runtime execution compatibility for every third-party plugin.
- Source-style plugins without built output still need build/install strategy decisions before they can pass runtime activation.
- Certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation, and BrowserWindow child iframe same-origin debt remain outside this batch.

### Batch 260: Persistent Runtime Permission Grants

Completed:

- Added shared runtime grant storage helpers in `src/lib/pluginRuntimePermissions.ts`, with normalized plugin IDs, normalized permission strings, deduped per-plugin grant lists, a versioned local storage key, and a shared update event.
- PluginPanel now separates session approvals from persistent approvals, loads persistent grants for the active plugin, listens for Settings-side grant changes, and adds `始终允许` alongside `本次会话允许`.
- Persistent approvals save the exact requested API permission for the current plugin while preserving the existing session-only approval path.
- Settings -> `已安装插件` -> `插件权限/能力审计` now shows `持久运行时授权` and exposes `清除授权` for the selected plugin.

Verification:

- Red/green: `pnpm test:plugin-runtime-permission-grants` first failed on the missing persistent grant helper module; it passed after adding normalized load/grant/list/clear helpers.
- Red/green: `pnpm test:plugin-runtime-permissions` first failed on the missing `始终允许` action, persistent save call, active-plugin grant loading, and update-event listener; it passed after PluginPanel was wired.
- Red/green: `pnpm test:plugin-inventory` first failed on the missing Settings persistent-grant audit/clear UI; it passed after the installed-plugin audit section was extended.
- Browser smoke: `http://localhost:1420/?pluginHostSmoke=permissionPrompt` showed `拒绝` / `本次会话允许` / `始终允许`; clicking `始终允许` closed the prompt, and reloading the same permission-smoke page did not prompt again. Settings -> `已安装插件` opened cleanly in Web preview with zero warning/error logs; desktop-only plugin inventory remains covered by the desktop smoke and static Settings tests. Browser screenshot capture timed out in the current automation backend and was not used as pass evidence.
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:53794"`, `agent_tools_count:8`, and plugin runtime smoke passing on sample plugin `calculator` / `calc`.

Completion:

- Plugin iframe host parity: **98% -> 99%**
- Plugin install/import/market: **88% -> 89%**
- Settings page functional parity: **99% -> 99%**
- Plugin security scope: **manifest allowlist + opaque main iframe + per-API session prompt -> plus persistent per-plugin grant management in Settings**

Remaining boundary:

- This is still not a certificate chain, revocation model, platform notary-style trust policy, complete sandbox/cross-origin capability isolation model, or broad third-party plugin compatibility regression.
- BrowserWindow child iframe still keeps same-origin for hosted WebContents compatibility; fully cross-origin BrowserWindow parity needs a separate child-window control channel.

### Batch 259: Runtime Per-API Permission Prompt

Completed:

- Missing sensitive runtime API permissions no longer fail immediately inside the injected plugin bridge; the bridge now sends `__atools_permission_request__` and waits for the host decision.
- PluginPanel renders an in-host runtime permission dialog showing the requesting plugin and exact API permission.
- `本次会话允许` grants only the requested permission for the active session, while `拒绝` rejects the original plugin call before any native/Tauri command is reached.
- Host fallback/direct `postMessage` paths now also run through the async permission request before invoking native bridge or Tauri commands.
- Web preview smoke gained `pluginHostSmoke=permissionPrompt` so the dialog can be verified in a real iframe runtime.

Verification:

- Red/green: `pnpm test:plugin-runtime-permissions` first failed on the missing runtime permission request path, missing permission prompt UI, and missing permission-prompt Web smoke mode; it passed after the bridge, host queue, session approval, denial, and smoke mode were implemented.
- Browser smoke: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=permissionPrompt&batch=259-runtime-permission-prompt` rendered the plugin iframe runtime, showed exactly one `clipboard.write` runtime prompt, and both `本次会话允许` and `拒绝` closed the prompt with no console errors or warnings.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-resource-runtime`
- `pnpm test:plugin-iframe-sandbox`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-iframe-context-menu`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `pnpm smoke:tauri-desktop` passed with `status:"ok"`, `mcp_bind:"127.0.0.1:50584"`, `agent_tools_count:8`, and plugin runtime smoke passing on sample plugin `calculator` / `calc`.

Completion:

- Plugin iframe host parity: **97% -> 98%**
- Settings page functional parity: **99% -> 99%**
- Plugin security scope: **manifest allowlist + opaque main iframe -> plus per-API session approval prompt**

Remaining boundary:

- Runtime per-API authorization is session-only and not yet persisted or centrally managed in Settings.
- This is not a certificate chain, revocation, platform notary-style trust policy, complete sandbox/cross-origin capability isolation model, or broad third-party plugin compatibility regression.

### Batch 258: Main Plugin Iframe Sandbox Isolation

Completed:

- Main plugin iframe sandbox is now centralized as `allow-scripts allow-popups`, removing `allow-same-origin` from the primary plugin execution frame.
- BrowserWindow child iframe sandbox is explicitly centralized as a separate compatibility policy, still retaining `allow-same-origin` because hosted WebContents/BrowserWindow parity depends on parent-side DOM control.
- `onPluginOut` / `onPluginDetach` lifecycle dispatch now uses postMessage into the plugin bridge, so the host no longer needs same-origin access to construct iframe-owned `CustomEvent` objects.
- Main iframe `findInPage` / selection cleanup now degrades as best effort when sandbox isolation prevents parent-side DOM access.
- SettingsPanel and SystemPanel runtime detection now checks for `__TAURI_INTERNALS__.invoke` rather than only the key name, and the home `插件管理` shortcut shows a preview-safe unavailable state instead of a raw Tauri invoke TypeError.

Verification:

- Red/green: `pnpm test:plugin-iframe-sandbox` first failed because the main and child iframe sandbox attributes were inline `allow-scripts allow-same-origin allow-popups`; it passed after adding separate sandbox constants, removing same-origin from the main plugin iframe, and moving lifecycle dispatch to postMessage.
- Red/green: `pnpm test:settings-tauri-runtime-guard` first failed because SettingsPanel/SystemPanel used insufficient runtime guards or surfaced raw invoke errors; it passed after invoke-based guards and preview fallbacks.
- `pnpm test:plugin-runtime-permissions`
- `pnpm test:plugin-resource-runtime`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=iframeContext&batch=258-iframe-sandbox&v=7`; the rendered main plugin iframe had `sandbox="allow-scripts allow-popups"` and no console errors or warnings.
- In-app Browser loaded `http://127.0.0.1:1420/?batch=258-iframe-sandbox&v=5`, opened the home `插件管理` shortcut, and showed `Tauri 运行时未连接，已安装插件需在桌面应用中查看` with no console errors or warnings.
- `pnpm smoke:tauri-desktop` passed, including plugin runtime, MCP, permission audit, and desktop window smoke.

Completion:

- Settings shell and navigation: **86% -> 87%**
- Plugin iframe host parity: **96% -> 97%**
- Settings page functional parity: **99% -> 99%**
- Plugin security scope: **runtime allowlist -> plus main plugin iframe opaque sandbox**

Remaining boundary:

- Main plugin iframe no longer gets same-origin access, but BrowserWindow child iframes still retain same-origin compatibility for hosted WebContents APIs.
- This is not yet a complete iframe sandbox/cross-origin capability isolation model for every hosted frame.
- Runtime per-API user prompts, certificate chains, revocation, platform notary-style trust policy, and broad third-party plugin compatibility regression remain unfinished.

## Previous Batch

### Batch 257: Plugin Runtime Permission Allowlist

Completed:

- `plugin.json` now supports a `permissions` array and round-trips through the Rust manifest model.
- `activate_feature` includes `plugin_permissions` in `FeatureAction`, so the runtime host receives the plugin's declared allowlist.
- The injected `utools`/`ztools` bridge checks permissions before sensitive `invoke` and native bridge calls, including plugin data, clipboard, shell, screen, dialog, context, system, and BrowserWindow families.
- The PluginPanel host re-checks the same allowlist for postMessage fallback calls, so direct `__ipc_call__` / `__atools_native_call__` messages are also denied before reaching Tauri commands.
- Settings -> `已安装插件` permission audit now shows a `运行时权限` row, and authorization summaries include declared runtime permissions.

Verification:

- Red/green: `cargo test -p atools-core --test models_tests test_plugin_manifest_roundtrip` first failed because `PluginManifest` had no `permissions` field, then passed after adding the manifest field and serde default.
- Red/green: `cargo test -p atools --lib activate_feature_includes_manifest_permissions_for_runtime_allowlist` first failed because `activate_feature_inner` / `plugin_permissions` did not exist, then passed after adding the runtime action field.
- Red/green: `pnpm test:plugin-runtime-permissions` first failed because `FeatureAction` and the injected bridge lacked permission slots/checks, then passed after bridge and host fallback enforcement.
- `cargo fmt`
- `cargo test -p atools-core --test models_tests`
- `cargo test -p atools --lib activate_feature`
- `cargo test -p atools --lib` passed 73 tests.
- `cargo test -p atools-api-shim`
- `pnpm test:plugin-runtime-permissions`
- `pnpm test:plugin-system-shell-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-context-bridge`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://127.0.0.1:1420/?batch=257-runtime-permissions`; Settings -> `已安装插件` rendered normally with no console errors or warnings.
- `pnpm smoke:tauri-desktop` passed, including plugin runtime, MCP, permission audit, and desktop window smoke.

Completion:

- Plugin install/import/market: **86% -> 88%**
- Plugin iframe host parity: **95% -> 96%**
- Settings page functional parity: **99% -> 99%**
- Plugin security scope: **authorization gate -> plus manifest runtime allowlist and bridge fallback enforcement**

Remaining boundary:

- Runtime allowlist enforcement covers the injected bridge and PluginPanel postMessage fallback, but it is not yet a full iframe sandbox or cross-origin capability isolation model.
- Only http/https `.zip` catalog entries are installable/updatable.
- Catalog-provided Ed25519 signature/public-key verification is implemented, but certificate chains, revocation, and platform notary-style trust policy are not.
- Broad third-party plugin compatibility regression remains unfinished.

## Previous Batch

### Batch 256: Plugin Permission Authorization Gate

Completed:

- Remote market installs and updates are saved disabled until the user explicitly authorizes the plugin.
- Added `authorize_plugin_permissions`; authorization enables the plugin, rebuilds feature rows, and syncs plugin Agent tools.
- `toggle_plugin` now rebuilds feature rows after enabled-state changes so feature search remains consistent.
- Settings -> `已安装插件` shows `授权启用` for disabled imported plugins and confirms `确认 manifest 权限` with declared entry, preload, feature, tool, and data rows.
- Disabled remote plugins stay out of `all_features()` and main search until authorization.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_download_installs_plugin_and_rejects_zip_slip` and `cargo test -p atools --lib plugin_market_zip_update_requires_reauthorization_before_searchable` first failed because authorization did not exist and remote installs/updates stayed searchable immediately, then passed after the authorization gate and feature rebuild.
- Red/green: `pnpm test:plugin-inventory` first failed because disabled imported plugins had no `授权启用` Settings action, then passed after the inventory and Settings wiring.
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://127.0.0.1:1420/`; Settings -> `已安装插件` rendered `插件库存概览` and the desktop-runtime boundary copy with no console errors or warnings.
- `cargo test -p atools --lib` passed 72 tests.
- `pnpm smoke:tauri-desktop` passed, including plugin runtime, MCP, permission audit, and desktop window smoke.

Completion:

- Plugin install/import/market: **83% -> 86%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **cancellable/retryable remote install/update -> plus permission authorization gate**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Catalog-provided Ed25519 signature/public-key verification is implemented, but certificate chains, revocation, and platform notary-style trust policy are not.
- The authorization gate is in place, but full sandbox isolation, per-API runtime prompts/interception, and broad third-party plugin compatibility regression remain unfinished.

## Previous Batch

### Batch 255: Plugin Market Cancel And Retry

Completed:

- Remote install/update now accepts a per-run `operationId`, includes it in progress events, and exposes `cancel_plugin_market_operation`.
- Remote ZIP downloads retry transient request failures up to 3 attempts and emit `retrying` progress with attempt metadata.
- Active downloads can be cancelled between chunks before checksum/signature verification and before any local plugin write.
- Settings -> `插件市场` passes `operationId`, shows attempt-aware progress, exposes `取消下载`, and offers `重试` after failure or cancellation.
- Remote capability status now includes `取消/重试`; an unloaded catalog reports `0/10 可用`, and a signed/rated loaded catalog reports `10/10 可用`.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_download_retries_transient_request_failure_and_reports_attempts`, `cargo test -p atools --lib plugin_market_zip_download_can_be_cancelled_before_local_write`, and `pnpm test:plugin-market-catalog` first failed because operation IDs, attempt metadata, cancel command, and the `取消/重试` capability did not exist, then passed after implementation.
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://127.0.0.1:1420/`; Settings -> `插件市场` showed `0/10 可用`, `取消/重试`, `下载进度`, and `签名信任`, with the old `签名信任暂缓接入` text absent.
- `cargo test -p atools --lib` passed 71 tests.
- `pnpm smoke:tauri-desktop` passed with no new Rust dead-code warnings.

Completion:

- Plugin install/import/market: **80% -> 83%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **Ed25519 signature trust -> plus cancellable/retryable remote install/update**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Catalog-provided Ed25519 signature/public-key verification is implemented, but certificate chains, revocation, and platform notary-style trust policy are not.
- Full plugin sandbox permission prompts and broad third-party plugin compatibility regression remain unfinished.

## Previous Batch

### Batch 254: Plugin Market Ed25519 Signature Trust

Completed:

- Remote catalog entries now parse and expose publisher metadata plus `signature` and `publicKey` / `public_key` fields.
- Remote install/update accepts catalog signature material and verifies an Ed25519 signature over the ZIP bytes after SHA-256 verification and before extraction.
- Bad signatures reject update before local writes, preserving the currently installed plugin version.
- Settings -> `插件市场` passes signature/public key fields into install/update, shows publisher details, and marks signed entries as `签名信任`.
- Remote capability status now enables `签名信任` when a loaded catalog has signed entries; a signed and rated loaded catalog reports `9/9 可用`.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_download_verifies_ed25519_signature_before_install_or_update`, `cargo test -p atools --lib plugin_market_catalog_fetches_and_normalizes_remote_json`, and `pnpm test:plugin-market-catalog` first failed because signature helpers, catalog fields, and signed capability status did not exist, then passed after implementation.
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://127.0.0.1:1420/`; Settings -> `插件市场` showed `0/9 可用`, `签名信任`, and the unloaded signed-trust guidance.
- `cargo test -p atools --lib` passed 69 tests.
- `pnpm smoke:tauri-desktop` passed with no new Rust dead-code warnings.

Completion:

- Plugin install/import/market: **77% -> 80%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **install/update progress events and UI -> plus Ed25519 signature trust**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Catalog-provided Ed25519 signature/public-key verification is implemented, but certificate chains, revocation, and platform notary-style trust policy are not.
- Full plugin sandbox permission prompts and broad third-party plugin compatibility regression remain unfinished.

## Earlier Batches

### Batch 253: Plugin Market Download Progress

Completed:

- Remote plugin install/update now streams ZIP downloads instead of reading the whole response at once, enforcing the existing 50 MB limit while reporting byte progress.
- Tauri commands emit `plugin-market-progress` events for request, download, checksum verification, local install/update write, and completion stages.
- Settings -> `插件市场` listens for progress events and shows `下载进度：...` with percent and byte counts when available.
- Remote capability status now includes `下载进度`; a loaded catalog with rating metadata reports `8/9 可用`, while signature/publisher trust remains unavailable.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_download_reports_progress_events`, `pnpm test:plugin-market-catalog`, `pnpm test:plugin-market-status`, and `pnpm test:plugin-market-overview` first failed because progress helpers/events/UI/capability rows did not exist, then passed after implementation.
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://127.0.0.1:1420/`; Settings -> `插件市场` showed `0/9 可用` and the `下载进度` remote capability row.
- `cargo test -p atools --lib` passed 68 tests.
- `pnpm smoke:tauri-desktop` passed with no new Rust dead-code warnings.

Completion:

- Plugin install/import/market: **75% -> 77%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **remote catalog details/ratings plus safe ZIP install/update -> plus install/update progress events and UI**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Signature/publisher trust, background cancel/retry, full plugin sandbox permission prompts, and broad third-party plugin compatibility regression remain unfinished.

## Earlier Batches

### Batch 252: Plugin Market Remote Details And Ratings

Completed:

- Remote catalog entries now parse and expose optional `rating`, `ratingCount`/`rating_count`, `downloads`, and plugin-level `updatedAt`/`updated_at` metadata.
- Settings -> `插件市场` now tracks a selected remote catalog plugin and shows a `远程详情` panel with id, version, author, update time, market rating, rating count, download count, download URL, checksum, and homepage when available.
- Remote catalog rows now expose a `详情` action plus rating/download metadata pills, including `暂无评分` when a catalog item has no rating.
- Market status now counts 8 remote capabilities: `目录读取`, `市场搜索`, `下载/安装/更新`, `SHA-256 校验`, `安装确认`, `远程详情`, `远程评分`, and `签名信任`.
- When a loaded catalog includes rating metadata, the market overview reports `7/8 可用`; signature/publisher trust remains explicit as unavailable.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_catalog_fetches_and_normalizes_remote_json`, `pnpm test:plugin-market-catalog`, `pnpm test:plugin-market-status`, and `pnpm test:plugin-market-overview` first failed on missing metadata fields, missing remote capability rows, and missing Settings detail UI, then passed after the implementation.
- `cargo fmt`
- `cargo test -p atools --lib plugin_market`
- `pnpm test:plugin-market-catalog`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `cargo test -p atools --lib`
- In-app Browser loaded `http://127.0.0.1:1420/`; Settings -> `插件市场` showed `0/8 可用`, `远程详情`, `远程评分`, and `签名信任`. Browser screenshot capture timed out at the CDP layer, so this batch uses DOM verification rather than a screenshot artifact.
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **72% -> 75%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **safe ZIP install/update with SHA-256 and install confirmation -> plus remote catalog detail and rating metadata display**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Signature/publisher trust, background cancel/retry, install/update progress, full plugin sandbox permission prompts, and broad third-party plugin compatibility regression remain unfinished.

## Earlier Batch

### Batch 251: Plugin Market Install/Update Confirmation

Completed:

- Settings -> `插件市场` now treats install/update confirmation as a first-class remote capability after a custom catalog is loaded.
- Remote catalog `安装` / `重装` / `更新` actions now call the existing in-page `confirmSettingsAction` before setting busy state or invoking Tauri.
- The confirmation message includes plugin name, version, source ZIP URL, the local write side effect, and whether directory SHA-256 will be verified.
- Cancelling the confirmation leaves the plugin inventory untouched, does not start the download/update invoke path, and reports `已取消{安装|重装|更新} <plugin>`.
- Market overview copy and capability counts now include `安装确认` alongside directory read, market search, ZIP install/update, and SHA-256 verification.

Verification:

- Red/green: `pnpm test:plugin-market-catalog`, `pnpm test:plugin-market-status`, and `pnpm test:plugin-market-overview` first failed because `安装确认` was missing from the market capability model and Settings install/update did not call `confirmSettingsAction`, then passed after adding the capability row and invoke-before-confirm guard.
- `pnpm test:settings-confirm-dialog`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- `cargo test -p atools --lib plugin_market`
- In-app Browser loaded `http://localhost:1420/?bust=251-market-confirm`; Settings -> `插件市场` showed `插件市场概览`, `下载/安装/更新`, `SHA-256 校验`, `安装确认`, and `刷新插件`, with no horizontal overflow, no error overlay, and console 0 warnings/errors.
- Playwright fallback at `http://localhost:1420/?bust=251-market-confirm-pw` verified the same state at 1280px and saved `/Users/harris/Desktop/atools-b251-market-confirm.png`.
- `pnpm smoke:tauri-desktop`
- `cargo test -p atools --lib`

Completion:

- Plugin install/import/market: **70% -> 72%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **safe ZIP install/update with SHA-256 -> safe ZIP install/update with SHA-256 plus explicit install/update confirmation**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Signature/publisher trust, ratings, remote details, background cancel/retry, install/update progress, full plugin sandbox permission prompts, and broad third-party plugin compatibility regression remain unfinished.

## Earlier Batch

### Batch 250: Plugin Market SHA-256 Checksum Verification

Completed:

- Custom plugin market catalog entries now accept optional `checksum` or `sha256` values, normalize SHA-256 digests to `sha256:<hex>`, and expose the checksum to Settings.
- `install_plugin_from_market` and `update_plugin_from_market` now accept an optional checksum from the catalog row and verify the downloaded ZIP bytes before staging, extraction, install, or update.
- Wrong SHA-256 values now fail with an explicit checksum mismatch and leave the existing installed plugin record/version unchanged.
- Settings -> `插件市场` now passes `checksum: plugin.checksum ?? null`, adds a `SHA-256 已校验` marker for catalog rows that provide a checksum, and lists `SHA-256 校验` as an available remote capability after a catalog is loaded.
- User-facing boundaries now say directory-provided SHA-256 is checked while signature/publisher trust remains deferred.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_download_verifies_sha256_checksum_before_install` first failed because the checksum-aware helpers and catalog field did not exist, then passed after adding catalog parsing, command parameters, SHA-256 hashing, and mismatch rejection.
- Red/green: `pnpm test:plugin-market-catalog`, `pnpm test:plugin-market-status`, and `pnpm test:plugin-market-overview` first failed because `SHA-256 校验` was not in the capability model and Settings did not pass/display checksum, then passed after wiring the model and Settings row.
- `cargo test -p atools --lib plugin_market`
- `cargo test -p atools --lib`
- `cargo fmt`
- `pnpm check`
- `pnpm build` (passes with the existing Vite chunk-size warning)
- In-app Browser loaded `http://localhost:1420/?bust=250-market-sha256`; Settings -> `插件市场` showed `插件市场概览`, `下载/安装/更新`, `SHA-256 校验`, `刷新插件`, no horizontal overflow, and console 0 errors/0 warnings. Browser screenshot capture timed out again, so visual evidence used Playwright fallback.
- Playwright fallback at `http://localhost:1420/?bust=250-market-sha256-pw` verified the same plugin market state at 1280px, no error overlays, no console warnings/errors, and saved `/Users/harris/Desktop/atools-b250-market-sha256.png`.
- `pnpm smoke:tauri-desktop` passed after stopping the manual dev server used for browser smoke; final desktop smoke output had no Rust warnings.

Completion:

- Plugin install/import/market: **67% -> 70%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **safe ZIP install/update -> safe ZIP install/update plus optional catalog SHA-256 verification**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Signature/publisher trust, ratings, remote details, background cancel/retry, install/update progress, plugin sandbox permission prompts, and broad third-party plugin compatibility regression remain unfinished.

### Batch 249: Plugin Market Remote ZIP Update

Completed:

- Custom plugin market catalog rows now distinguish installed plugins from new plugins: fresh entries show `安装`, same-version installed entries show `重装`, and different-version installed entries show `更新`.
- Added native `update_plugin_from_market(plugin_id, download_url)`, reusing the same remote ZIP download, 50 MiB size limit, staging extraction, zip-slip defense, symlink rejection, and single-`plugin.json` detection from market install.
- Remote updates now reuse the existing same-ID local update path, so they reject manifest ID mismatches, preserve the installed plugin's enabled/disabled state and original `created_at`, replace stale files, refresh feature indexes, and resync Agent plugin tools.
- `install_plugin_from_market` now accepts the catalog plugin id from Settings and validates the staged ZIP manifest id before installing, so a catalog row cannot silently install a different plugin id.
- Market status copy and capability rows now expose `下载/安装/更新` when a remote catalog is loaded; ratings, remote details, signature/checksum verification, cancellation/retry jobs, and full plugin permission isolation remain deferred.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_update_preserves_enabled_state_and_rejects_id_mismatch` first failed because `update_plugin_from_market_url_inner` did not exist, then passed after adding the remote update command and staged update path.
- Red/green: `pnpm test:plugin-market-catalog` and `pnpm test:plugin-market-status` first failed because the status model still exposed `下载/安装`; both passed after changing the capability to `下载/安装/更新` and wiring the Settings update action.
- `pnpm test:plugin-market-overview`
- `pnpm test:plugin-inventory`
- `cargo test -p atools --lib plugin_market`
- `cargo test -p atools --lib`
- `cargo fmt`
- `pnpm check`
- `pnpm build`
- In-app Browser loaded `http://localhost:1420/?bust=249-market-update`; Settings -> `插件市场` showed `插件市场概览`, `网络插件市场下载安装更新需先配置并读取自定义目录`, `下载/安装/更新`, and `刷新插件`, with console 0 errors/0 warnings. Browser screenshot capture timed out, so final visual evidence used Playwright fallback.
- Playwright fallback at `http://localhost:1420/?bust=249-market-update-pw` verified the same market overview copy and saved `/Users/harris/Desktop/atools-b249-market-update.png` with console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **64% -> 67%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **safe ZIP install -> safe ZIP install plus same-ID remote update**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable/updatable.
- Signature/checksum verification, ratings, remote details, background cancel/retry, install/update progress, plugin sandbox permission prompts, and broad third-party plugin compatibility regression remain unfinished.

### Batch 248: Plugin Market Remote ZIP Install

Completed:

- Custom plugin market catalog rows now expose a desktop install action for http/https `.zip` entries.
- The native install command downloads the ZIP, enforces a 50 MiB limit, extracts into a temporary market staging directory, rejects unsafe ZIP paths, rejects symlink entries, requires exactly one staged `plugin.json`, then reuses the existing local plugin install flow so database plugin records, feature indexes, and Agent plugin tools stay aligned.
- Settings -> `插件市场` now shows the loaded custom catalog as display plus ZIP install, with per-row busy state and refresh of the installed plugin inventory after success.
- Market status copy now marks `下载/安装` available only after a remote catalog is loaded; ratings, remote details, remote updates, signature verification, cancellation/retry jobs, and full plugin permission isolation remain deferred.

Verification:

- Red/green: `cargo test -p atools --lib plugin_market_zip_download_installs_plugin_and_rejects_zip_slip` first failed because the market install helper did not exist, then passed after adding the download, staging, ZIP extraction, manifest detection, and install path.
- Red/green: `pnpm test:plugin-market-catalog` first failed because the status model still exposed `下载/更新=false`, then passed after switching the loaded catalog capability to `下载/安装=true` and wiring the Settings install action.
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm test:plugin-inventory`
- `cargo test -p atools --lib plugin_market`
- `cargo test -p atools --lib`
- `pnpm check`
- `pnpm build`
- In-app Browser loaded `http://localhost:1420/?bust=248-market-install`; Settings -> `插件市场` showed `插件市场概览`, the custom market boundary copy, `下载/安装`, `刷新插件`, and no console errors. Browser screenshot capture timed out, so final visual evidence used Playwright fallback.
- Playwright fallback at `http://localhost:1420/?bust=248-market-install-pw` verified the same market overview copy and saved `/Users/harris/Desktop/atools-b248-market-install.png` with console 0 errors.
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin install/import/market: **61% -> 64%**
- Settings page functional parity: **99% -> 99%**
- Plugin market scope: **remote JSON catalog display -> remote JSON catalog display plus safe ZIP install**

Remaining boundary:

- Only http/https `.zip` catalog entries are installable.
- Remote update, signature/checksum verification, ratings, remote details, background cancel/retry, plugin sandbox permission prompts, and broad third-party plugin compatibility regression remain unfinished.

## Earlier Batch

### Batch 247: BrowserWindow Hosted Document And Parent State Bridge

Completed:

- Hosted BrowserWindow handles now expose current Electron/BaseWindow document and relationship APIs: `isNormal()`, `isModal()`, `setDocumentEdited(edited)`, `isDocumentEdited()`, `setRepresentedFilename(filename)`, `getRepresentedFilename()`, `setParentWindow(parent | null)`, `getParentWindow()`, and `getChildWindows()`.
- Document-state setters preserve Electron's `undefined` return shape while keeping synchronous getter caches readable immediately.
- `setParentWindow(parent)` now stores hosted parent/child relationships by BrowserWindow handle, `getParentWindow()` returns the parent handle, and `getChildWindows()` returns active hosted child handles; `setParentWindow(null)` clears the relationship.
- Browser-window Web preview now verifies `data-browser-window-document-parent-state="true"` while preserving titlebar/material, menu-bar, waiting-response/background-color, navigationHistory, focus/owner/media, crash lifecycle, navigation/lifecycle, runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Electron docs source checked through Context7 for current BaseWindow/BrowserWindow document, normal/modal, and parent/child method names and return shapes.
- Red/green: `pnpm test:plugin-window-browser-bridge` first failed at `browser-window handle should expose isNormal()`, then passed after adding hosted document/parent cache, handle methods, host action routes, and Web preview smoke calls.
- In-app Browser loaded `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=247-document-parent-browser`; page identity and non-blank DOM passed, but sandboxed iframe attribute reads and screenshot capture still hit known Browser limitations, so final iframe assertions used Playwright MCP fallback.
- Playwright MCP at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=247-document-parent-mcp` recorded `data-browser-window-document-parent-state="true"` and `data-browser-window-parent-child-state="true"` together with all existing BrowserWindow smoke attributes.
- Playwright screenshot captured as `/Users/harris/Desktop/atools-b247-document-parent-smoke.png`; console reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **94% -> 95%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted titlebar/material state bridge -> hosted document/parent state bridge**

## Earlier Batch

### Batch 246: BrowserWindow Hosted Titlebar And Material State Bridge

Completed:

- Hosted BrowserWindow handles now expose current Electron/macOS titlebar and material APIs: `setWindowButtonVisibility(visible)`, `setWindowButtonPosition(position | null)`, `getWindowButtonPosition()`, `setVibrancy(type[, options])`, `setBackgroundMaterial(material)`, and `setSheetOffset(offsetY[, offsetX])`.
- `setWindowButtonPosition(null)` resets the hosted button position cache to the system default `null`, matching the current API that replaces deprecated `setTrafficLightPosition()` / `getTrafficLightPosition()`.
- Setter-style titlebar/material APIs preserve Electron's `undefined` return shape while routing explicit hosted actions and synchronizing the handle cache where a getter exists.
- Browser-window Web preview now verifies `data-browser-window-titlebar-material-state="true"` while preserving menu-bar, waiting-response/background-color, navigationHistory, focus/owner/media, crash lifecycle, navigation/lifecycle, runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Electron docs source checked through Context7 for current BrowserWindow `setWindowButtonVisibility()`, `setWindowButtonPosition()` / `getWindowButtonPosition()`, `setVibrancy()`, `setBackgroundMaterial()`, and BaseWindow `setSheetOffset()` semantics, including the deprecation of `setTrafficLightPosition()` / `getTrafficLightPosition()`.
- Red/green: `pnpm test:plugin-window-browser-bridge` first failed at `browser-window handle should expose setWindowButtonVisibility()`, then passed after adding the hosted titlebar/material cache, handle methods, host action routes, and Web preview smoke calls.
- In-app Browser loaded `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=246-titlebar-material-iab`; page identity and non-blank DOM passed, but sandboxed/transformed iframe attribute reads and screenshot capture still hit the known Browser limitations, so final iframe assertions used Playwright MCP fallback on the same smoke page.
- Playwright MCP at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=246-titlebar-material-mcp` recorded `data-browser-window-titlebar-material-state="true"` together with the existing BrowserWindow attributes; the host shell had `windowButtonsHidden`, close button `visibility:hidden`, child title `子窗口已更新`, `data-child-ipc-ping="true"`, `data-execute-js="42"`, and `data-send-input-event="Enter:shift"`.
- Playwright screenshot captured as `/Users/harris/Desktop/atools-b246-titlebar-material-smoke.png`; console reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **93% -> 94%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted menu-bar state bridge -> hosted titlebar/material state bridge**

## Earlier Batch

### Batch 245: BrowserWindow Hosted Menu Bar State Bridge

Completed:

- Hosted BrowserWindow handles now expose `setAutoHideMenuBar(hide)`, `isMenuBarAutoHide()`, `setMenuBarVisibility(visible)`, `isMenuBarVisible()`, `removeMenu()`, and `setMenu(menu)`.
- Setter-style menu APIs preserve Electron's `undefined` return shape while synchronizing the hosted handle cache immediately, so plugin code can read back auto-hide and visibility state without waiting for an async host roundtrip.
- `removeMenu()` marks the hosted shell menu as removed and hidden; `setMenu(menu)` restores menu presence for non-null menus and treats `null` as a remove path.
- Browser-window Web preview now verifies `data-browser-window-menu-bar-state="true"` while preserving waiting-response/background-color, navigationHistory, focus/owner/media, crash lifecycle, navigation/lifecycle, runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Electron docs source checked through Context7 for BrowserWindow `setAutoHideMenuBar()` / `isMenuBarAutoHide()` / `setMenuBarVisibility()` / `isMenuBarVisible()` / `setMenu()` / `removeMenu()` semantics and platform scope.
- Red/green: `pnpm test:plugin-window-browser-bridge` first failed at `browser-window handle should expose setAutoHideMenuBar()`, then passed after adding the hosted menu-bar cache, handle methods, host action routes, and Web preview smoke calls.
- In-app Browser loaded `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=245-menu-bar-iab4`; sandboxed/transformed iframe automation and screenshot capture remained limited, so final iframe attribute assertions used Playwright MCP on the same localhost smoke page.
- Playwright MCP at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=245-menu-bar-mcp` recorded `data-browser-window-menu-bar-state="true"` together with the existing BrowserWindow attributes, child title `子窗口已更新`, child `data-child-ipc-ping="true"`, `data-execute-js="42"`, and `data-send-input-event="Enter:shift"`.
- Playwright screenshot captured as `/Users/harris/Desktop/atools-b245-menu-bar-smoke.png`; console reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **92% -> 93%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted waiting-response/background-color bridge -> hosted menu-bar state bridge**

## Earlier Batch

### Batch 244: BrowserWindow Hosted Background Color And WebContents Waiting Response Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes `isWaitingForResponse()`, backed by the hosted child iframe loading cache so plugins can observe a true state between `loadURL()` dispatch and first hosted response completion.
- Hosted BrowserWindow handles now expose `setBackgroundColor(color)` and `getBackgroundColor()`, preserving Electron's void-return setter shape and normalizing CSS color input to the `#RRGGBB` getter cache used by the hosted shell.
- `PluginPanel` applies the hosted background color to normal, positioned, minimized, full-screen, maximized, and kiosk child-window styles, and stores the normalized value in BrowserWindow state.
- Browser-window Web preview now verifies `data-browser-window-webcontents-waiting-response="true"` and `data-browser-window-background-color="true"` while preserving navigationHistory, focus/owner/media, crash lifecycle, navigation/lifecycle, runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Electron docs source checked through Context7 for `webContents.isWaitingForResponse()` and BrowserWindow `setBackgroundColor()` / `getBackgroundColor()` semantics.
- Red/green: `pnpm test:plugin-window-browser-bridge` first failed at `browser-window webContents should expose isWaitingForResponse()`, then passed after adding the hosted waiting-response cache, background-color handle methods, host action routes, and Web preview smoke calls.
- Browser smoke caught an injected JavaScript regex escape bug in the color normalizer; the hosted RGB parser was replaced with a non-regex parser, then the Browser smoke reported 0 errors and only the existing 2 iframe sandbox warnings.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=244-waiting-background-pw3` recorded `data-browser-window-webcontents-waiting-response="true"` and `data-browser-window-background-color="true"` together with the existing BrowserWindow attributes.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **91% -> 92%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents navigationHistory bridge -> hosted WebContents waiting-response and BrowserWindow background-color bridge**

## Earlier Batch

### Batch 243: BrowserWindow Hosted WebContents NavigationHistory Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes `navigationHistory` with `canGoBack()`, `canGoForward()`, `goBack()`, `goForward()`, `goToIndex(index)`, `canGoToOffset(offset)`, `goToOffset(offset)`, and `clear()`.
- `goBack()`, `goForward()`, `goToIndex()`, `goToOffset()`, and `clear()` keep Electron's void-return shape while routing explicit host actions and synchronizing the existing hosted child iframe history state.
- `clear()` collapses the hosted history to the current child entry, so subsequent `canGoBack()` / `canGoForward()` checks return false without destroying or reloading the child iframe.
- Browser-window Web preview now verifies `data-browser-window-navigation-history="true"` while preserving focus/owner/media, crash lifecycle, render-process-gone, navigation/lifecycle, runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `navigationHistory`, then passed after adding the hosted object, sync state helpers, host action routes, and Web preview smoke calls.
- VM coverage verifies method exposure, initial can-go state, `loadURL()` history growth, `goToOffset(-1)`, `goForward()`, `goToIndex(0)`, `clear()`, void-return shape, sync `canGoBack()` / `canGoForward()` updates, and native bridge route/args.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=243-navigation-history-pw` checked 68 BrowserWindow/WebContents attributes with no mismatches, including `data-browser-window-navigation-history="true"`.
- In-app Browser loaded the same smoke page and displayed the hosted BrowserWindow UI; headless browser automation was used for final sandboxed iframe attribute assertions because the in-app Browser automation hit its known sandbox iframe `MutationObserver` limitation.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- Electron docs source checked through Context7 for the current `webContents.navigationHistory` replacement surface and deprecated old WebContents navigation APIs.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **90% -> 91%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents focus/owner/media/shortcut state bridge -> hosted WebContents navigationHistory bridge**

## Earlier Batch

### Batch 242: BrowserWindow Hosted WebContents Focus Owner Media Shortcut Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes focus/owner/media/shortcut methods: `focus()`, `isFocused()`, `getOwnerBrowserWindow()`, `getMediaSourceId()`, `isBeingCaptured()`, and `setIgnoreMenuShortcuts(ignore)`.
- `webContents.focus()` keeps Electron's void-return shape, synchronously marks the hosted WebContents focused, routes a host action, and keeps BrowserWindow focus/blur/showInactive state synchronized with the WebContents cache.
- `getOwnerBrowserWindow()` returns the owning hosted BrowserWindow handle, `getMediaSourceId()` returns a stable hosted stream id such as `web-contents:1:0`, and `isBeingCaptured()` returns the hosted capture state without pretending to track real Chromium tab capture.
- `setIgnoreMenuShortcuts(ignore)` keeps Electron's void-return shape, updates the hosted shortcut cache, and routes `webContents.setIgnoreMenuShortcuts` through the BrowserWindow action bridge.
- Browser-window Web preview now verifies `data-browser-window-webcontents-focus-state` and `data-browser-window-webcontents-owner-media` while preserving crash, render-process-gone, navigation/lifecycle, runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `focus()`, then passed after adding the hosted focus/owner/media/shortcut state, host action route, and Web preview smoke calls.
- VM coverage verifies method exposure, `focus()` and `setIgnoreMenuShortcuts()` void-return shape, synchronous `isFocused()` cache updates after `blur()` and `focus()`, owner handle identity, stable hosted media source id, default `isBeingCaptured() === false`, and native bridge route/args.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=242-webcontents-focus-owner-pw` checked 60 BrowserWindow/WebContents attributes with no mismatches, including `data-browser-window-webcontents-focus-state="true"` and `data-browser-window-webcontents-owner-media="true"`.
- In-app Browser loaded the same smoke page and showed the hosted BrowserWindow UI; sandboxed iframe attributes were read through headless browser automation because the in-app Browser could not access the sandboxed child frame document.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- Electron docs source checked through Context7 for `webContents.focus()`, `isFocused()`, `getMediaSourceId()`, `setIgnoreMenuShortcuts(ignore)`, and `BrowserWindow.fromWebContents(webContents)`.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **89% -> 90%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents crash lifecycle bridge -> hosted WebContents focus/owner/media/shortcut state bridge**

## Earlier Batch

### Batch 241: BrowserWindow Hosted WebContents Crash Lifecycle Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes crash lifecycle methods: `isCrashed()` and `forcefullyCrashRenderer()`.
- `forcefullyCrashRenderer()` keeps Electron's void-return shape, marks hosted `webContents` crashed synchronously, routes a host action, and emits a targeted `render-process-gone` event with compatibility details `{ reason: "crashed", exitCode: 1 }`.
- Hosted `loadURL()` / `reload()` / history navigation clear the hosted crashed flag, matching the recovery flow where reload after a renderer crash returns the page to usable state.
- Browser-window Web preview now verifies `data-browser-window-render-process-gone`, `data-browser-window-webcontents-crash`, and `data-browser-window-webcontents-crash-reload` while preserving runtime state, navigation/lifecycle, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `isCrashed()`, then passed after adding the hosted crash state, host action route, event dispatch, and Web preview smoke calls.
- VM coverage verifies method exposure, default `isCrashed() === false`, `forcefullyCrashRenderer()` void-return shape, synchronous crash state, native bridge route/args, targeted `render-process-gone` details, and persisted crash state until reload.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=241-webcontents-crash` checked 58 BrowserWindow/WebContents attributes with no mismatches, including `data-browser-window-render-process-gone="true"`, `data-browser-window-webcontents-crash="true"`, and `data-browser-window-webcontents-crash-reload="true"`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- Electron docs source checked through Context7 for `webContents.isCrashed()`, `forcefullyCrashRenderer()`, and `render-process-gone`.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **88% -> 89%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents navigation/lifecycle bridge -> hosted WebContents crash lifecycle bridge**

## Earlier Batch

### Batch 240: BrowserWindow Hosted WebContents Navigation And Lifecycle Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes navigation/lifecycle methods: `loadURL(url[, options])`, `reload()`, `stop()`, `isDestroyed()`, and `getType()`.
- PluginPanel routes `webContents.loadURL()` and `webContents.reload()` through the hosted child-window navigation path, keeps URL/title/history/loading state synchronized, and preserves the current hosted promise result shape used by the existing BrowserWindow bridge.
- `webContents.stop()` keeps Electron's void-return shape and clears hosted loading/loading-main-frame state synchronously while routing a stop action to the host.
- Closed hosted browser-window events now mark both the BrowserWindow handle and its `webContents` as destroyed; hosted `getType()` reports `"window"` for compatibility with the current child iframe surface.
- Browser-window Web preview now verifies `data-browser-window-webcontents-load-url` and `data-browser-window-webcontents-lifecycle` while preserving runtime state, capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, navigation, IPC, find-in-page, CSS insert/remove, and always-on-top coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `loadURL()`, then passed after adding the bridge, host action routing, and Web preview smoke calls.
- VM coverage verifies method exposure, `isDestroyed()` false/true transitions, `getType() === "window"`, `webContents.loadURL()` route/args/loading/history state, `webContents.reload()` route/result, and `webContents.stop()` void return plus synchronous loading clear.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=240-webcontents-nav-life` checked 44 key attributes with no mismatches, including `data-browser-window-webcontents-load-url="true"`, `data-browser-window-webcontents-lifecycle="true"`, and `data-browser-window-runtime-state="true"`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- Electron docs source checked through Context7 for `webContents.loadURL`, `reload`, `stop`, `isDestroyed`, and `getType`.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **87% -> 88%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents identity/runtime state bridge -> hosted WebContents navigation/lifecycle bridge**

## Earlier Batch

### Batch 239: BrowserWindow Hosted WebContents Identity And Runtime State Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes identity/runtime methods: `getUserAgent()`, `setUserAgent(userAgent)`, `getFrameRate()`, `setFrameRate(fps)`, `getBackgroundThrottling()`, `setBackgroundThrottling(allowed)`, `getProcessId()`, and `getOSProcessId()`.
- PluginPanel keeps Electron's sync getter and void setter shape for the mutable runtime state: user agent, frame rate, and background throttling update the hosted handle cache immediately while routing state changes through the child-window action bridge.
- Hosted process IDs are stable positive compatibility IDs for the current in-host child BrowserWindow, not real Electron renderer or OS process IDs.
- Browser-window Web preview now verifies runtime state through `data-browser-window-runtime-state` while preserving page capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, navigation, IPC, find-in-page, and always-on-top coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `getUserAgent()`, then passed after adding the bridge, host state, and action routing.
- VM coverage verifies method exposure, default user agent/frame-rate/background-throttling values, positive hosted process IDs, void-return setter shape, native bridge route/args, and synchronous getter updates.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=239-runtime-state` recorded `data-browser-window-runtime-state="true"` for `setUserAgent` / `getUserAgent`, `setFrameRate` / `getFrameRate`, `setBackgroundThrottling` / `getBackgroundThrottling`, `getProcessId`, and `getOSProcessId`, while capture/export, selection/scroll, edit, inspect, audio, zoom, DevTools, navigation, IPC, find-in-page, CSS insert/remove, and always-on-top checks stayed true.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- Electron docs source checked through Context7 for WebContents `getUserAgent` / `setUserAgent`, `getFrameRate` / `setFrameRate`, `getBackgroundThrottling` / `setBackgroundThrottling`, `getProcessId`, and `getOSProcessId`.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **86% -> 87%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents page capture/export bridge -> hosted WebContents identity/runtime state bridge**

## Earlier Batch

### Batch 238: BrowserWindow Hosted WebContents Page Capture And Export Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes page capture/export methods: `capturePage([rect, opts])`, `print([options], [callback])`, `printToPDF(options)`, and `savePage(fullPath, saveType)`.
- PluginPanel keeps Electron-compatible call shapes: `capturePage()` resolves a NativeImage-compatible object with `toDataURL()` / `getSize()` / `isEmpty()`, `print()` returns `undefined` and invokes the callback with `(success, failureReason)`, `printToPDF()` resolves Buffer-compatible PDF bytes, and `savePage()` resolves `undefined`.
- Host behavior now routes these methods to the matching hosted child iframe: `capturePage()` returns a deterministic SVG snapshot data URL for the requested rect, `printToPDF()` emits a minimal PDF byte stream from child iframe text, `savePage()` serializes the current child iframe document and writes it through Tauri FS when a desktop runtime and allowed path are available, and `print()` reports an explicit hosted native-only failure instead of fake success.
- Browser-window Web preview now verifies `capturePage`, `print`, `printToPDF`, and `savePage` through `data-browser-window-capture-page`, `data-browser-window-print`, `data-browser-window-print-to-pdf`, and `data-browser-window-save-page`, while preserving selection/scroll, edit, inspect, audio, zoom, DevTools, navigation, IPC, find-in-page, and always-on-top coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `capturePage()`, then passed after adding the bridge and host actions.
- VM coverage verifies method exposure, native bridge route/args, NativeImage-compatible capture result shape, explicit `print()` callback failure shape, Buffer-compatible PDF bytes, and `savePage()` Promise void result.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=238-capture-export` recorded `data-browser-window-capture-page="true"`, `data-browser-window-print="true"`, `data-browser-window-print-to-pdf="true"`, and `data-browser-window-save-page="true"`, while prior BrowserWindow WebContents checks stayed true.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`

Completion:

- Plugin iframe host parity: **85% -> 86%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents selection and scroll bridge -> hosted WebContents page capture/export bridge**

## Earlier Batch

### Batch 237: BrowserWindow Hosted WebContents Selection And Scroll Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes selection and scroll commands: `centerSelection()`, `scrollToTop()`, `scrollToBottom()`, and `adjustSelection(options)`.
- PluginPanel keeps Electron's void-return shape while routing these commands to the focused hosted child iframe.
- Host behavior now scrolls the child iframe document to top/bottom, centers the current editable target or DOM selection, and adjusts text-control selection ranges with `{ start, end }` deltas; contenteditable selection adjustment remains best-effort through browser `Selection.modify` when available.
- Browser-window Web preview now verifies `centerSelection`, `adjustSelection`, `scrollToBottom`, and `scrollToTop` through `data-browser-window-selection-scroll-commands`, `data-browser-window-adjust-selection`, and `data-browser-window-scroll-top`, while preserving edit/inspect/audio/zoom/DevTools/browser-window coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `centerSelection()`, then passed after adding the bridge and host action.
- VM coverage verifies method exposure, native bridge route/args, `adjustSelection({ start, end })` payload shape, and void-return shape for all four commands.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=237-selection-scroll` recorded `data-browser-window-selection-scroll-commands="true"`, `data-browser-window-adjust-selection="true"`, and `data-browser-window-scroll-top="true"`, while edit, inspect, audio, zoom, DevTools, navigation, IPC, find-in-page, and always-on-top checks stayed true; child frame transform remained `matrix(0.833333, 0, 0, 0.833333, 0, 0)`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **84% -> 85%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents edit command bridge -> hosted WebContents selection and scroll bridge**

## Earlier Batch

### Batch 236: BrowserWindow Hosted WebContents Edit Commands Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes `insertText(text)` plus editing commands: `undo()`, `redo()`, `cut()`, `copy()`, `paste()`, `pasteAndMatchStyle()`, `delete()`, `selectAll()`, `unselect()`, `replace(text)`, and `replaceMisspelling(text)`.
- PluginPanel keeps Electron return-shape compatibility: `insertText()` resolves `undefined`, and synchronous edit commands return `undefined` while routing to the focused hosted child iframe.
- Hosted edit commands now edit focused `input` / `textarea` / `contenteditable` targets; `copy` / `cut` / `paste` use a hosted local edit clipboard instead of the system clipboard.
- Browser-window Web preview now verifies `insertText`, `selectAll`, `copy`, `cut`, and `paste` through `data-browser-window-insert-text`, `data-browser-window-edit-commands`, and `data-browser-window-edit-value`, while preserving inspect/audio/zoom/DevTools/browser-window coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `insertText()`, then passed after adding the bridge and host action.
- VM coverage verifies method exposure, native bridge route/args, `insertText()` Promise void result, edit command void-return shape, and static App smoke coverage.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=236-edit2` recorded `data-browser-window-insert-text="true"`, `data-browser-window-edit-commands="true"`, and `data-browser-window-edit-value="true"`, while inspect, audio, zoom, DevTools, navigation, IPC, find-in-page, and always-on-top checks stayed true; child frame transform remained `matrix(0.833333, 0, 0, 0.833333, 0, 0)`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- In-app Browser was attempted first but still hit the local URL crash/policy page in this environment, so the rendering smoke used independent Playwright.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **83% -> 84%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents inspectElement bridge -> hosted WebContents edit command bridge**

## Earlier Batch

### Batch 235: BrowserWindow Hosted WebContents Inspect Element Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes `inspectElement(x, y)`.
- PluginPanel keeps Electron's void-return shape, opens/focuses hosted DevTools state synchronously, routes `webContents.inspectElement` through the child-window bridge, and records a compact summary of the DOM element under the requested iframe coordinates.
- Browser-window Web preview now verifies `inspectElement(12, 8)` returns `undefined` while `isDevToolsOpened()` and `isDevToolsFocused()` immediately read true, then preserves prior audio/zoom/DevTools/browser-window coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because hosted BrowserWindow `webContents` did not expose `inspectElement()`, then passed after adding the bridge and host action.
- VM coverage verifies method exposure, void-return `inspectElement(12, 8)`, native bridge action args, and DevTools cache staying open/focused after host response.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=235-inspect` recorded `data-browser-window-inspect-element="true"`, while audio, zoom, DevTools, navigation, IPC, find-in-page, and always-on-top checks stayed true; child frame transform remained `matrix(0.833333, 0, 0, 0.833333, 0, 0)`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- In-app Browser was attempted first but still hit the local URL crash/policy page in this environment, so the rendering smoke used independent Playwright.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`

Completion:

- Plugin iframe host parity: **82% -> 83%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents audio state bridge -> hosted WebContents inspectElement DevTools inspection bridge**

## Earlier Batch

### Batch 234: BrowserWindow Hosted WebContents Audio State Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes audio state methods: `setAudioMuted(muted)`, `isAudioMuted()`, and `isCurrentlyAudible()`.
- PluginPanel tracks hosted muted/audible state per child BrowserWindow; `setAudioMuted()` keeps Electron's void-return shape, sync getters update immediately, and muting clears the hosted audible cache.
- Targeted `webContents` event handling now supports `audio-state-changed`, including `event.audible` and the boolean listener argument for hosted compatibility.
- Browser-window Web preview now verifies initial muted/audible state, mute/unmute void shape, sync getter updates, and preserves prior DevTools/zoom/browser-window smoke coverage.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow `webContents` did not expose `setAudioMuted()`, then passed after adding the bridge and host state routing.
- VM coverage verifies method exposure, initial `isAudioMuted() === false`, targeted `audio-state-changed` event sync, void-return `setAudioMuted(true/false)`, and async host response cache updates.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=234-audio` recorded `data-browser-window-audio-initial="true"`, `data-browser-window-audio-muted="true"`, `data-browser-window-audio-unmuted="true"`, while prior zoom checks stayed true and child frame transform remained `matrix(0.833333, 0, 0, 0.833333, 0, 0)`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **81% -> 82%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents zoom state bridge -> hosted WebContents audio state bridge**

## Earlier Batch

### Batch 233: BrowserWindow Hosted WebContents Zoom State Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes zoom methods: `setZoomFactor(factor)`, `getZoomFactor()`, `setZoomLevel(level)`, `getZoomLevel()`, and `setVisualZoomLevelLimits(minimumLevel, maximumLevel)`.
- PluginPanel tracks hosted zoom factor, zoom level, and visual zoom limits per child BrowserWindow; `setZoomFactor()` and `setZoomLevel()` keep Electron's void-return shape while sync getters update immediately.
- Hosted child iframe rendering now applies the current zoom factor via CSS scale, while documenting that this is not Chromium's full page zoom pipeline.
- Browser-window Web preview now verifies factor/level conversion, sync state reads, visual zoom limits, and the final child iframe transform.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow `webContents` did not expose `setZoomFactor()`, then passed after adding the bridge and host state routing.
- VM coverage verifies method exposure, initial `getZoomFactor() === 1`, initial `getZoomLevel() === 0`, void-return `setZoomFactor()` / `setZoomLevel()`, async host response cache updates, and void-resolving `setVisualZoomLevelLimits()`.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=233-zoom-void` recorded `data-browser-window-zoom-factor="true"`, `data-browser-window-zoom-level="true"`, `data-browser-window-visual-zoom-limits="true"`, and child frame transform `matrix(0.833333, 0, 0, 0.833333, 0, 0)`.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **80% -> 81%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents DevTools state bridge -> hosted WebContents zoom state bridge**

## Earlier Batch

### Batch 232: BrowserWindow Hosted WebContents DevTools State Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes DevTools methods: `openDevTools(options)`, `closeDevTools()`, `toggleDevTools()`, `isDevToolsOpened()`, and `isDevToolsFocused()`.
- PluginPanel tracks hosted DevTools open/focus/mode/title state per child BrowserWindow without claiming to open a native Chromium DevTools window.
- DevTools opened/closed state changes dispatch targeted `webContents` events: `devtools-opened` and `devtools-closed`.
- Browser-window Web preview now verifies `openDevTools({ mode:"detach", activate:false })`, `toggleDevTools()`, focused `openDevTools({ mode:"bottom" })`, `closeDevTools()`, sync state reads, and opened/closed events.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow `webContents` did not expose `openDevTools()`, then passed after adding the bridge and host state routing.
- VM coverage verifies method exposure, initial false state, `webContents.openDevTools` / `toggleDevTools` / `closeDevTools` bridge routing, sync `isDevToolsOpened()` / `isDevToolsFocused()` cache updates, and targeted `devtools-opened` / `devtools-closed` events.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=232-devtools-iab` reached the chain tail with `最近消息 window:setAlwaysOnTop +1` and child window title `子窗口已更新`.
- Playwright frame check at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=232-devtools-detail` recorded `data-browser-window-devtools-event-opened="true"`, `data-browser-window-devtools-open="true"`, `data-browser-window-devtools-event-closed="true"`, `data-browser-window-devtools-toggle="true"`, `data-browser-window-devtools-reopen="true"`, and `data-browser-window-devtools-close="true"` while preserving previous navigation, IPC, executeJavaScript, sendInputEvent, CSS insert/remove, and findInPage checks.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **79% -> 80%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents navigation/status/history bridge -> hosted WebContents DevTools state bridge**

## Earlier Batch

### Batch 231: BrowserWindow Hosted WebContents Navigation State Bridge

Completed:

- Hosted BrowserWindow `webContents` now exposes synchronous navigation/status methods: `getURL()`, `getTitle()`, `isLoading()`, `isLoadingMainFrame()`, `canGoBack()`, and `canGoForward()`.
- Hosted BrowserWindow `loadURL()` / `reload()` now update the same WebContents navigation cache, while `webContents.reloadIgnoringCache()`, `webContents.goBack()`, and `webContents.goForward()` route through the hosted child-window action bridge.
- PluginPanel tracks per-window history entries, current history index, and loading state; `loadURL()` truncates forward history, reload preserves the current entry, and back/forward restore the hosted child iframe URL/title/srcdoc.
- Browser-window Web preview now records the WebContents URL/title/loading/history booleans, verifies `reloadIgnoringCache()` returns an ignore-cache result, and verifies back/forward history state around `child.html` and `child-reloaded.html`.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow `webContents` did not expose `getURL()`, then passed after adding sync navigation/status methods and host-side history routing.
- VM coverage verifies `webContents.getURL()` / `getTitle()` / `isLoading()` / `isLoadingMainFrame()` / `canGoBack()` / `canGoForward()` initial state, `loadURL()` cache sync, and bridge routing for `webContents.reloadIgnoringCache`, `webContents.goBack`, and `webContents.goForward`.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=231-nav-iab-clean` reached the chain tail with `最近消息 window:setAlwaysOnTop +1` and child window URL `child-reloaded.html`.
- Playwright frame check at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=231-nav-debug` recorded `data-browser-window-webcontents-url="child-reloaded.html"`, `data-browser-window-webcontents-title="child-reloaded.html"`, `data-browser-window-webcontents-loading="true"`, `data-browser-window-can-go-back="true"`, `data-browser-window-reload-ignoring-cache="true"`, `data-browser-window-go-back="true"`, and `data-browser-window-go-forward="true"` while preserving IPC, executeJavaScript, sendInputEvent, CSS insert/remove, and findInPage checks.
- Console check reported 0 errors and only the existing iframe sandbox warnings.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **78% -> 79%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents page-search/event bridge -> hosted WebContents navigation/status/history bridge**

## Earlier Batch

### Batch 230: BrowserWindow Hosted `findInPage()` / `stopFindInPage()` Bridge

Completed:

- Hosted BrowserWindow `webContents` now has its own EventEmitter surface (`on` / `addListener` / `once` / `off` / `removeListener` / `removeAllListeners`) for targeted WebContents events.
- Hosted BrowserWindow handles expose `webContents.findInPage(text[, options])` with Electron-compatible synchronous request ids, and `webContents.stopFindInPage(action)` with void-return shape.
- PluginPanel routes `webContents.findInPage` to the matching child iframe, counts matches in the child document text, and dispatches a targeted `found-in-page` event with request id, match count, active ordinal, selection area, and `finalUpdate:true`.
- Browser-window Web preview now registers `webContents.on("found-in-page", ...)`, starts a search against the child iframe text, verifies the request id and final event, and calls `stopFindInPage("clearSelection")`.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow `webContents` did not expose `findInPage()`, then passed after adding the bridge and host-side search path.
- VM coverage verifies `findInPage("needle", { forward:false, matchCase:true })` returns request id `1` synchronously and routes action `webContents.findInPage`; `stopFindInPage("clearSelection")` routes action `webContents.stopFindInPage` and returns `undefined`.
- Event coverage verifies targeted `found-in-page` events arrive only through `browserWindowHandle.webContents.on/once`, including one-shot listener removal.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=230-find-fixed` recorded `data-browser-window-find-in-page="true"`, `data-browser-window-found-in-page="true"`, `data-browser-window-found-request="true"`, and `data-browser-window-stop-find-in-page="true"` while preserving prior IPC, executeJavaScript, sendInputEvent, and CSS insert/remove checks.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **77% -> 78%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted WebContents CSS injection/removal bridge -> hosted WebContents page-search/event bridge**

## Earlier Batch

### Batch 229: BrowserWindow Hosted `insertCSS()` / `removeInsertedCSS()` Bridge

Completed:

- Hosted BrowserWindow handles now expose `webContents.insertCSS(css[, options])` and `webContents.removeInsertedCSS(key)` alongside the existing hosted WebContents subset.
- PluginPanel routes `browserWindowAction` actions `webContents.insertCSS` and `webContents.removeInsertedCSS` to the matching hosted child iframe, injects a keyed `<style>` into the child document, and removes it by the returned key.
- Inserted CSS keys are scoped to the owning hosted BrowserWindow; close/load/reload clears stale CSS keys so a later page cannot be mutated through an old key.
- Browser-window Web preview now inserts a CSS custom property into the child iframe, verifies it through `executeJavaScript(getComputedStyle(...))`, removes the stylesheet by key, and verifies the custom property is gone.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `webContents.insertCSS`, then passed after adding the handle methods and host-side keyed stylesheet path.
- VM coverage verifies `insertCSS("body { --atools-insert-css: inserted; }", { cssOrigin: "user" })` routes through `browserWindowAction` with action `webContents.insertCSS` and resolves a key, and `removeInsertedCSS(key)` routes through `webContents.removeInsertedCSS` and resolves `undefined`.
- Static coverage verifies `insertPluginBrowserWindowCss()`, `removePluginBrowserWindowCss()`, bridge routing, and Web preview smoke coverage.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=229-css`: final child count stayed `1`, title changed to `子窗口已更新`, class had `positioned focused alwaysOnTop`, inline style was `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`, and no Vite/Svelte framework error overlay rendered.
- Playwright frame verification at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=229-css-nd`: parent iframe recorded `data-browser-window-insert-css="true"`, `data-browser-window-remove-inserted-css="true"`, and `data-browser-window-insert-css-removed="true"`; child iframe retained prior `data-child-ipc-ping="true"`, `data-execute-js="42"`, and `data-send-input-event="Enter:shift"`; no `style[data-atools-browser-window-css-key]` remained after removal.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **76% -> 77%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted webContents sendInputEvent bridge -> hosted webContents CSS injection/removal bridge**

## Earlier Batch

### Batch 228: BrowserWindow Hosted `sendInputEvent()` Bridge

Completed:

- Hosted BrowserWindow handles now expose `webContents.sendInputEvent(inputEvent)` alongside `webContents.send()` and `webContents.executeJavaScript()`.
- PluginPanel routes `browserWindowAction` action `webContents.sendInputEvent` to the matching hosted child iframe and dispatches compatible DOM `KeyboardEvent`, `MouseEvent`, or `WheelEvent` objects into that child document.
- Hosted browser-window iframe readiness is now tracked through frame refs and load state so `loadURL()` / `reload()` chains do not resolve before the child document is usable; `webContents.send()` remains fire-and-forget but retries delivery after the child frame is ready.
- Browser-window Web preview now sends Shift+Enter into the child iframe, records `data-browser-window-send-input-event="true"` on the parent iframe, and records `data-send-input-event="Enter:shift"` on the child iframe.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `webContents.sendInputEvent`, then passed after adding the handle method and host-side input dispatch path.
- VM coverage verifies `webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter", modifiers: ["shift"] })` routes through `browserWindowAction` with action `webContents.sendInputEvent` and resolves with Electron-compatible `undefined`.
- Static coverage verifies `dispatchPluginBrowserWindowInputEvent()`, `webContents.sendInputEvent` bridge routing, and Web preview smoke coverage.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=228-send-nonblocking`: final child count stayed `1`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, class had `positioned focused alwaysOnTop`, inline style was `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`, and no Vite/Svelte framework error overlay rendered.
- Playwright frame verification at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=228-final-nd`: parent iframe recorded `data-browser-window-webcontents-send="true"`, `data-browser-window-execute-js="true"`, `data-browser-window-send-input-event="true"`, and callback state `browser-window-ipc:browserWindow`; child iframe recorded `data-child-ipc-ping="true"`, `data-execute-js="42"`, and `data-send-input-event="Enter:shift"`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **75% -> 76%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted webContents executeJavaScript bridge -> hosted webContents sendInputEvent bridge and frame-readiness guard**

## Earlier Batch

### Batch 227: BrowserWindow Hosted `executeJavaScript()` Bridge

Completed:

- Hosted BrowserWindow handles now expose `webContents.executeJavaScript(code[, userGesture])` alongside `webContents.send()`.
- PluginPanel routes `browserWindowAction` action `webContents.executeJavaScript` to the matching hosted child iframe and evaluates the supplied code inside that child window.
- The host returns the evaluated result through the existing native bridge promise path and rejects with a method-scoped error if the child window is inactive, not ready, or throws.
- Browser-window Web preview now executes script in the child iframe, writes `data-execute-js="42"` on the child body, and records the returned result on the parent iframe as `data-browser-window-execute-js="true"`.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `webContents.executeJavaScript`, then passed after adding the handle method and host-side execution path.
- VM coverage verifies `webContents.executeJavaScript("window.__answer = 40 + 2; window.__answer", true)` routes through `browserWindowAction` with action `webContents.executeJavaScript` and resolves the returned value; it also verifies numeric code such as `0` is preserved through `String(code)` instead of being coerced to an empty script.
- Static coverage verifies `executePluginBrowserWindowJavaScript()`, `webContents.executeJavaScript` bridge routing, and Web preview smoke coverage.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=227`: final child count returned to `1`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, class had `positioned focused alwaysOnTop`, inline style was `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`, parent iframe `data-browser-window-execute-js` was `true`, child iframe `data-execute-js` was `42`, `webContents.send` and child `ipcRenderer.on()` still passed, and no Vite/Svelte framework error overlay rendered.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **74% -> 75%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted webContents child IPC bridge -> hosted webContents executeJavaScript bridge**

## Earlier Batch

### Batch 226: BrowserWindow Hosted WebContents IPC Bridge

Completed:

- Hosted BrowserWindow handles now expose a non-enumerable `webContents` object with `webContents.send(channel, ...args)`.
- Hosted child-window preload now exposes a minimal Electron-compatible `require("electron").ipcRenderer` listener surface: `on()`, `addListener()`, `once()`, `off()`, `removeListener()`, and `removeAllListeners()`.
- PluginPanel now tracks hosted child iframe refs and routes parent `webContents.send()` payloads to the matching child iframe instead of broadcasting through the parent plugin iframe.
- Browser-window Web preview now sends `ping` from parent to child; the child receives it through `ipcRenderer.on()` and automatically replies through `sendToParent()`.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `webContents`, then passed after adding `webContents.send` and hosted child IPC routing.
- VM coverage verifies `webContents.send("ping", { value: 42 }, "payload")` routes through `browserWindowAction` with action `webContents.send`, and child `ipcRenderer.on()` / `once()` listeners receive the expected payload while removed listeners do not fire.
- Static coverage verifies `dispatchPluginBrowserWindowIpcMessage()`, `__atools_browser_window_ipc__`, Web preview `win.webContents.send()`, and child `ipcRenderer.on()`.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=226`: final child count returned to `1`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, class had `positioned focused alwaysOnTop`, inline style was `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`, `webContents.send` was accepted, child iframe `data-child-ipc-ping` was `true`, parent iframe callback channel was `browser-window-ipc`, and no Vite/framework error overlay rendered.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **73% -> 74%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted sizing constraint methods -> hosted webContents child IPC bridge**

## Older Batch

### Batch 225: BrowserWindow Hosted Sizing Constraints Handle

Completed:

- Hosted BrowserWindow handles now expose `getContentSize()` / `setContentSize()`, `getMinimumSize()` / `setMinimumSize()`, `getMaximumSize()` / `setMaximumSize()`, and `setAspectRatio()`.
- PluginPanel now tracks hosted child-window minimum/maximum size and aspect-ratio state.
- Hosted `setBounds()`, `setSize()`, and `setContentSize()` share the same size normalization and min/max constraint path.
- Browser-window Web preview now exercises content-size, min/max-size, and aspect-ratio calls, then restores the final child window to `420x260`.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `getContentSize()`, then passed after adding sizing constraint handle methods and host state routing.
- VM coverage verifies content-size, minimum-size, maximum-size, and aspect-ratio calls route through `browserWindowAction` with expected actions and arguments.
- Static coverage verifies hosted minimum/maximum/aspect-ratio fields, `normalizePluginBrowserWindowSize()`, `constrainPluginBrowserWindowSize()`, and Web preview calls for the new methods.
- Browser smoke at `http://localhost:1420/?parity=1&pluginHostSmoke=browserWindow&bust=225`: final child count returned to `1`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, class had `positioned focused alwaysOnTop`, inline style was `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3003;`, computed size was `420px x 260px`, and hosted progress strip was cleared.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **72% -> 73%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted z-order/media-source methods -> hosted sizing constraint methods**

## Older Batch

### Batch 224: BrowserWindow Hosted Z-order/Media-source Handle

Completed:

- Hosted BrowserWindow handles now expose `getMediaSourceId()`, `moveTop()`, and `moveAbove(mediaSourceId)`.
- PluginPanel now tracks hosted child-window `mediaSourceId` and `zOrder` state.
- Hosted `moveTop()` and `moveAbove()` update child-window z-index through `pluginBrowserWindowLayer()` without changing focus or pretending to control OS-level native z-order.
- Browser-window Web preview now reads the main child media source id, creates a temporary reference child window, moves the main child above it, closes the reference window, and continues to the final title/always-on-top checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `getMediaSourceId()`, then passed after adding z-order/media-source handle methods and host state routing.
- VM coverage verifies `getMediaSourceId`, `moveTop`, and `moveAbove` route through `browserWindowAction` with expected actions and arguments.
- Static coverage verifies hosted `mediaSourceId` / `zOrder` fields, `pluginBrowserWindowLayer()`, and Web preview calls for the new methods.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=224`: final child count returned to `1`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, class had `positioned focused alwaysOnTop` without transient state classes, inline style included `z-index: 3003`, and hosted progress strip was cleared.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`

Completion:

- Plugin iframe host parity: **71% -> 72%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted focus/attention/progress methods -> hosted z-order/media-source methods**

### Batch 223: BrowserWindow Hosted Focus/Attention/Progress Handle

Completed:

- Hosted BrowserWindow handles now expose `setFocusable()` / `isFocusable()`, `flashFrame()`, and `setProgressBar()`.
- PluginPanel now tracks hosted child-window `focusable`, `flashing`, `progressBar`, and `progressBarMode` state, initialized from `createBrowserWindow()` options where applicable.
- `setFocusable(false)` changes subsequent hosted `show()` / `focus()` focus results; `flashFrame(true)` renders a hosted `flashing` class; `setProgressBar()` renders a thin hosted titlebar progress strip and clears it when progress is negative.
- Browser-window Web preview now exercises focusable, flashFrame, and progressBar before continuing through existing navigation, state, event, bounds, capability flag, full-screen, appearance, system-state, title, and always-on-top checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `setFocusable()`, then passed after adding focus/attention/progress handle methods and host state routing.
- VM coverage verifies `setFocusable` / `isFocusable`, `flashFrame`, and `setProgressBar` route through `browserWindowAction` with expected actions and arguments.
- Static coverage verifies hosted focus/attention/progress fields on `PluginBrowserWindowState`, `class:flashing={childWindow.flashing}`, `plugin-browser-window-progress`, and Web preview calls for the new methods.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=223`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop` without `flashing/kiosk/fullScreen/minimized/maximized/noShadow`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, computed opacity returned to `1`, and hosted progress strip was cleared.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **70% -> 71%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted system-state methods -> hosted focus/attention/progress methods**

## Older Batch

### Batch 222: BrowserWindow Hosted System-state Handle

Completed:

- Hosted BrowserWindow handles now expose system-state methods: `setSkipTaskbar()`, `setKiosk()` / `isKiosk()`, `setVisibleOnAllWorkspaces()` / `isVisibleOnAllWorkspaces()`, and `setContentProtection()` / `isContentProtected()`.
- PluginPanel now tracks hosted child-window `skipTaskbar`, `kiosk`, `visibleOnAllWorkspaces`, and `contentProtected` state, initialized from `createBrowserWindow()` options.
- `setKiosk(true)` fills the current hosted browser-window layer, focuses the child window, clears minimized/maximized state, and renders a hosted `kiosk` class; `setKiosk(false)` restores the normal hosted bounds.
- Browser-window Web preview now exercises skip-taskbar, kiosk, visible-on-all-workspaces, and content-protection before continuing through existing navigation, state, event, bounds, capability flag, full-screen, appearance, title, always-on-top, and parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `setSkipTaskbar()`, then passed after adding system-state handle methods and host state routing.
- VM coverage verifies `setSkipTaskbar`, `setKiosk` / `isKiosk`, `setVisibleOnAllWorkspaces` / `isVisibleOnAllWorkspaces`, and `setContentProtection` / `isContentProtected` route through `browserWindowAction` with expected actions and arguments.
- Static coverage verifies hosted system-state fields on `PluginBrowserWindowState`, `class:kiosk={childWindow.kiosk}`, and Web preview calls for the new methods.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=222`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop` without `kiosk/fullScreen/minimized/maximized/noShadow`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, computed opacity returned to `1`, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **69% -> 70%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted opacity/shadow appearance methods -> hosted system-state methods**

## Older Batch

### Batch 221: BrowserWindow Hosted Appearance Handle

Completed:

- Hosted BrowserWindow handles now expose appearance methods: `getOpacity()` / `setOpacity()`, `hasShadow()` / `setHasShadow()`, and `invalidateShadow()`.
- PluginPanel now tracks hosted child-window `opacity` and `hasShadow` state, initialized from `createBrowserWindow()` options.
- Non-1 opacity is rendered as hosted child-window inline style; `setOpacity(1)` restores the default final style without an opacity residue.
- `setHasShadow(false)` applies a hosted `noShadow` class; `setHasShadow(true)` restores normal shadow rendering.
- Browser-window Web preview now exercises `setOpacity(0.72) -> getOpacity() -> setOpacity(1)` and `setHasShadow(false) -> hasShadow() -> setHasShadow(true) -> invalidateShadow()` before continuing through existing navigation, state, event, bounds, capability flag, full-screen, title, always-on-top, and parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `getOpacity()`, then passed after adding appearance handle methods and host state routing.
- VM coverage verifies `setOpacity` / `getOpacity` / `setHasShadow` / `hasShadow` / `invalidateShadow` route through `browserWindowAction` with expected actions and arguments.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=221`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop` without `fullScreen/minimized/maximized/noShadow`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, computed opacity returned to `1`, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **68% -> 69%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted full-screen methods -> hosted opacity/shadow appearance methods**

## Older Batch

### Batch 220: BrowserWindow Hosted Full-screen Handle

Completed:

- Hosted BrowserWindow handles now expose full-screen methods: `isFullScreen()` / `setFullScreen()` and `isFullScreenable()` / `setFullScreenable()`.
- PluginPanel now tracks hosted child-window `fullScreen` and `fullScreenable` state, initialized from `createBrowserWindow()` options.
- `setFullScreen(true)` fills the current hosted browser-window layer, clears minimized/maximized state, focuses the child window, and dispatches `enter-full-screen`; `setFullScreen(false)` restores normal hosted bounds and dispatches `leave-full-screen`.
- Browser-window Web preview now exercises `setFullScreen(true) -> isFullScreen() -> setFullScreen(false) -> isFullScreen()` before continuing through existing navigation, state, event, bounds, capability flag, title, always-on-top, and parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `isFullScreen()`, then passed after adding full-screen handle methods and host state routing.
- VM coverage verifies `setFullScreen` / `isFullScreen` / `setFullScreenable` / `isFullScreenable` route through `browserWindowAction` with expected actions and arguments.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=220`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop` without `fullScreen/minimized/maximized`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **67% -> 68%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted capability flag methods -> hosted full-screen methods**

## Older Batch

### Batch 219: BrowserWindow Capability Flag Handle

Completed:

- Hosted BrowserWindow handles now expose capability flag methods: `isResizable()` / `setResizable()`, `isMovable()` / `setMovable()`, `isClosable()` / `setClosable()`, `isMinimizable()` / `setMinimizable()`, and `isMaximizable()` / `setMaximizable()`.
- PluginPanel now tracks hosted child-window `resizable`, `movable`, `closable`, `minimizable`, and `maximizable` state, initialized from `createBrowserWindow()` options with default `true`.
- `closable:false` disables the hosted child-window close button while keeping programmatic `close()` available.
- Browser-window Web preview now exercises `setResizable(false) -> isResizable() -> setResizable(true)` before continuing through existing navigation, state, event, bounds, title, always-on-top, and parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `isResizable()`, then passed after adding capability handle methods and host state routing.
- VM coverage verifies each capability `set*` / `is*` pair routes through `browserWindowAction` with the expected action and arguments.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=219`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, close button was enabled after restoring resizable, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **66% -> 67%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted geometry resize/move events -> hosted capability flag methods**

## Older Batch

### Batch 218: BrowserWindow Geometry Event Routing

Completed:

- Hosted BrowserWindow geometry actions now emit event-listener callbacks: `setBounds()` dispatches `resize` and `move`, `setSize()` dispatches `resize`, and `setPosition()` / `center()` dispatch `move`.
- Geometry events continue through the existing `__atools_browser_window_event__` channel, so parent plugin iframe handles can consume them through `on()` / `once()`.
- Browser-window Web preview now registers `resize` and one-shot `move` listeners before continuing through existing navigation, state, bounds, title, always-on-top, and parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because `setBounds/setSize` did not dispatch hosted BrowserWindow `resize`, then passed after adding geometry event routing.
- Static coverage verifies hosted `resize` / `move` event dispatch and Web preview registration of `win.on('resize', ...)` / `win.once('move', ...)`.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=218`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **65% -> 66%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted EventEmitter lifecycle/action events -> hosted geometry resize/move events**

## Older Batch

### Batch 217: BrowserWindow Event Listener Handle

Completed:

- `createBrowserWindow()` now returns hosted BrowserWindow EventEmitter methods: `on()`, `addListener()`, `once()`, `off()`, `removeListener()`, and `removeAllListeners()`.
- PluginPanel now forwards hosted child-window lifecycle/action events through `__atools_browser_window_event__`.
- Hosted events currently cover `show`, `hide`, `focus`, `blur`, `minimize`, `restore`, `maximize`, `unmaximize`, and `closed`.
- `closed` events mark the created handle as destroyed and clean up callback/event dispatch state.
- Browser-window Web preview now registers `focus`, `maximize`, and one-shot `restore` listeners before continuing through existing navigation, state, bounds, title, always-on-top, and parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `on()`, then passed after adding event listener methods and host event routing.
- VM coverage verifies `on`, `addListener`, `once`, `off`, `removeListener`, `removeAllListeners`, host `focus` event dispatch, listener removal, one-shot `closed`, and `isDestroyed()` after host `closed`.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=217`: final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`. Browser runtime could not reliably read nested sandbox iframe attributes, so event attributes are covered by VM red/green tests.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **64% -> 65%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted minimize/maximize/restore -> hosted EventEmitter lifecycle/action events**

## Older Batch

### Batch 216: BrowserWindow Minimize/Maximize/Restore Handle

Completed:

- `createBrowserWindow()` now returns hosted BrowserWindow window-state methods: `minimize()`, `isMinimized()`, `restore()`, `maximize()`, `unmaximize()`, and `isMaximized()`.
- New handle methods route through `browserWindowAction` into PluginPanel and update the hosted child iframe shell state instead of mutating only local JavaScript state.
- PluginPanel now tracks hosted child-window `minimized` and `maximized` state.
- Minimized child windows collapse the child iframe body; maximized child windows fill the current PluginPanel child-window layer; `restore()` returns to the previous hosted bounds.
- Browser-window Web preview now auto-runs `minimize -> isMinimized -> restore -> maximize -> isMaximized -> unmaximize -> restore` before continuing through focus, bounds, title, always-on-top, and child parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `minimize()`, then passed after adding minimize/maximize/restore routing and host rendering state.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=216`: parent iframe recorded `data-browser-window-minimized="true"` and `data-browser-window-maximized="true"`; final child window rendered at `420x260`, title changed to `子窗口已更新`, header URL stayed `child-reloaded.html`, had `focused positioned alwaysOnTop` without `minimized/maximized`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **63% -> 64%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted URL/load/reload -> hosted minimize/maximize/restore**

## Older Batch

### Batch 215: BrowserWindow URL/Load/Reload Handle

Completed:

- `createBrowserWindow()` now returns hosted BrowserWindow navigation methods: `getURL()`, `loadURL(url)`, and `reload()`.
- New handle methods route through `browserWindowAction` into PluginPanel and update the hosted child iframe URL/srcdoc state instead of mutating only local JavaScript state.
- PluginPanel reuses the existing plugin HTML resource preparation and bridge injection path when loading or reloading a hosted child window.
- `loadURL()` updates the hosted child window URL and title; `reload()` rebuilds the child iframe content for the current URL while preserving the current title.
- Browser-window Web preview now auto-runs `loadURL('child-reloaded.html') -> getURL() -> reload()` before continuing through focus, bounds, title, always-on-top, and child parent-message checks.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `getURL()`, then passed after adding URL/load/reload routing and host state updates.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=215`: child window rendered, title changed to `子窗口已更新`, header URL changed to `child-reloaded.html`, had `focused positioned alwaysOnTop`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, parent iframe recorded URL/bounds/always-on-top state, and coordinate-clicking the child button changed the runtime strip to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **62% -> 63%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted title/visibility/focus/always-on-top state -> hosted URL/load/reload**

## Older Batch

### Batch 214: BrowserWindow Title/Visibility/Always-on-top State Handle

Completed:

- `createBrowserWindow()` now returns hosted BrowserWindow state/title methods: `isVisible()`, `isFocused()`, `showInactive()`, `blur()`, `getTitle()`, `setTitle()`, `isAlwaysOnTop()`, and `setAlwaysOnTop()`.
- New handle methods route through `browserWindowAction` into PluginPanel and update the hosted child iframe instead of mutating only local JavaScript state.
- PluginPanel now tracks hosted child-window `alwaysOnTop` state, reuses `visible` / `focused` / `title`, and initializes always-on-top state from browser-window options.
- Child-window shell renders an `alwaysOnTop` class and higher hosted `z-index`; this is a PluginPanel layer state, not system-level native always-on-top.
- Browser-window Web preview now auto-runs `hide -> show -> showInactive -> isVisible -> focus -> setBounds -> getBounds -> setTitle -> setAlwaysOnTop -> isAlwaysOnTop` before the child sends a parent message.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `isVisible()`, then passed after adding state/title/always-on-top routing and host rendering.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=214`: child window rendered, title changed to `子窗口已更新`, had `focused positioned alwaysOnTop`, inline style `width: 420px; height: 260px; left: 24px; top: 32px; z-index: 3;`, actual rect `420x260`, runtime strip showed `Browser 窗口 1 个 最近消息 window:setAlwaysOnTop +1`, and clicking the child button changed it to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **61% -> 62%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted bounds/size/position/center -> hosted title/visibility/focus/always-on-top state**

## Older Batch

### Batch 213: BrowserWindow Bounds/Size/Position Handle

Completed:

- `createBrowserWindow()` returns hosted BrowserWindow bounds/size/position methods: `getBounds()`, `setBounds()`, `getSize()`, `setSize()`, `getPosition()`, `setPosition()`, and `center()`.
- Handle methods route through `browserWindowAction` into PluginPanel and update the hosted child iframe instead of mutating only local JavaScript state.
- PluginPanel tracks hosted child-window `x`, `y`, `width`, `height`, and `positioned` state, initializes from browser-window options, and normalizes extreme values before rendering.
- Child-window shell renders inline `width` / `height` / `left` / `top` style and uses a `positioned` class for explicit placement; `center()` returns to the hosted centered layout.
- Browser-window Web preview auto-runs `hide -> show -> focus -> setBounds -> getBounds` before the child sends a parent message.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because the hosted BrowserWindow handle did not expose `getBounds()`, then passed after adding bounds/size/position/center routing and host rendering.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=213`: child window rendered, had `focused positioned`, inline style `width: 420px; height: 260px; left: 24px; top: 32px;`, actual rect `420x260`, runtime strip showed `Browser 窗口 1 个 最近消息 window:setBounds +1`, and clicking the child button changed it to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **60% -> 61%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted handle show/hide/focus/close/isDestroyed -> hosted bounds/size/position/center**

## Older Batch

### Batch 212: BrowserWindow Handle Show/Hide/Focus/Close

Completed:

- `createBrowserWindow()` returns a hosted BrowserWindow handle with id/type/windowType/url/title and `show()`, `hide()`, `focus()`, `close()`, and `isDestroyed()`.
- Handle methods route through `browserWindowAction` into PluginPanel instead of mutating only local JavaScript state.
- PluginPanel tracks hosted child-window `visible` and `focused` state, hides child iframes without destroying them, focuses the requested child window, and removes the child on close.
- Child-window shell adds visible `focused` styling and `hidden` class support.
- Browser-window Web preview auto-runs `hide -> show -> focus` before the child sends a parent message.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because createBrowserWindow returned a plain object without `show()`, then passed after adding the hosted handle and `browserWindowAction` host routing.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=212`: child window rendered, remained visible after `hide/show/focus`, had the `focused` class, runtime strip showed `Browser 窗口 1 个 最近消息 window:focus`, and clicking the child button changed it to `browser-window-message +1`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`

Completion:

- Plugin iframe host parity: **59% -> 60%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **hosted child iframe + parent callback -> hosted handle show/hide/focus/close/isDestroyed**

### Batch 211: Plugin Browser-window Child Iframe Messaging

Completed:

- `createBrowserWindow(url, options, callback)` creates a hosted child iframe inside PluginPanel and returns a browser-window handle with id/type/windowType/url/title.
- Child iframe bridge injection carries `browserWindow` type and window id; `utools.getWindowType()` returns `browserWindow` inside the child.
- `sendToParent(channel, ...args)` from the child iframe is validated by the host, forwarded to the parent plugin iframe, and delivered to the `createBrowserWindow` callback.
- Runtime strip shows `Browser 窗口` count and the latest parent message, for example `browser-window-message +1`.
- Web preview gained `?pluginHostSmoke=browserWindow` for browser-window rendering and interaction smoke.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` first failed because createBrowserWindow callback did not receive child sendToParent messages, then passed after adding hosted child-window state, bridge metadata, and parent-message forwarding.
- Browser smoke at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=browserWindow&bust=214`: child window rendered, child srcdoc contained `sendToParent` and `var _atoolsWindowType = "browserWindow"`, clicking the child button changed the runtime strip to `Browser 窗口 1 个 最近消息 browser-window-message +1`, and there was no framework overlay.

Completion:

- Plugin iframe host parity: **57% -> 59%**
- Plugin runtime parity: **99% -> 99%**
- Browser-window coverage: **fixed unsupported -> hosted child iframe + sendToParent parent callback**

### Batch 210: Plugin Iframe Contextmenu Event Reporting

Completed:

- Added an injected iframe `contextmenu` observer that runs in capture phase, reports target metadata to the host, and does not call `preventDefault()`.
- `PluginPanel.svelte` now records the latest iframe context-menu event and closes any output-row menu to avoid stale layered menu state.
- `pluginHostView` surfaces the iframe right-click path as a `右键菜单 / iframe button` runtime chip.
- Web preview gained `?pluginHostSmoke=iframeContext`, and preview srcdoc now reuses the real bridge injection path.
- Runtime resource observation now falls back from `documentElement` to `body` if an iframe realm rejects the first target.

Verification:

- Red/green: `pnpm test:plugin-iframe-context-menu` first failed because the injected bridge did not observe iframe `contextmenu`, then passed after adding the bridge and host handler.
- Red/green: Browser exposed missing bridge injection in preview HTML; the test then required shared `injectPluginBridge()` and passed after preview and real plugin paths shared it.
- Red/green: Browser exposed early bridge insertion for no-head preview HTML; the test then required body-positioned injection and passed after `bodyOpenMatch`.
- Red/green: `pnpm test:plugin-resource-runtime` simulated `MutationObserver.observe(documentElement)` throwing, then passed after body fallback.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-output-context-menu`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-events-bridge`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- Browser interaction check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=iframeContext&bust=213`: iframe mode rendered, srcdoc contained the bridge and `右键测试按钮`, bridge injection appeared after `<body>`, right-clicking the iframe button area surfaced `右键菜单 / iframe button`, and there was no framework overlay. Browser dev logs still showed a `MutationObserver.observe(document)` error from Browser/Playwright injection; current srcdoc did not contain that call.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:61889"`, `main_window:true`, `settings_window:true`, `mcp_ready:true`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime `context_bridge_checked:true`, `browser_context_checked:true`, `finder_context_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:61889`. Shutdown still printed Vite/esbuild `EPIPE`, but the smoke command exited 0.

Completion:

- Plugin iframe host parity: **56% -> 57%**
- Plugin runtime parity: **99% -> 99%**
- Iframe right-click coverage: **output-only right-click copy -> output copy + iframe contextmenu event reporting**

## Older Batch

### Batch 209: Plugin Output Right-click Copy Menu

Completed:

- Added an output-row right-click context menu in `PluginPanel.svelte` with a single `复制结果` command.
- Reused `copyPluginOutputItem(idx)` for click, Enter, and right-click menu copy so copy feedback stays consistent.
- Synchronized right-click target selection with the output list and closed the menu on page click or SubInput selection changes.
- Captured `Escape` while the menu is open and stopped propagation so the menu closes without exiting plugin mode.

Verification:

- Red/green: `pnpm test:plugin-output-context-menu` first failed because `PluginPanel.svelte` lacked output context-menu state, handlers, DOM, and Escape capture; it passed after the focused implementation.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-events-bridge`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-input-bridge`
- `pnpm check`
- `pnpm build`
- Browser interaction check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin host preview rendered, output layer had 2 rows, right-click on the first row opened `复制结果`, `Esc` closed only the menu and stayed in plugin mode, no framework overlay, no horizontal overflow, and console reported 0 errors / 0 warnings. Browser screenshot capture timed out and was not used as a pass condition.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:55361"`, `main_window:true`, `settings_window:true`, `mcp_ready:true`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime `context_bridge_checked:true`, `browser_context_checked:true`, `finder_context_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:55361`.

Completion:

- Plugin iframe host parity: **55% -> 56%**
- Plugin runtime parity: **99% -> 99%**
- Output interaction coverage: **click/Enter copy -> click/Enter/right-click copy + menu Escape guard**

## Older Batch

### Batch 208: Plugin Detach Lifecycle Dispatch

Completed:

- Enabled the plugin titlebar `分离` action in `pluginHostView` while keeping `设置` disabled.
- Added `dispatchPluginDetachEvent()` in `PluginPanel.svelte` to dispatch `atools-plugin-detach` into the plugin iframe for registered `utools.onPluginDetach(callback)` handlers.
- Routed plugin chrome actions through `handlePluginChromeAction()` and guarded duplicate detach dispatch per active plugin owner.
- Kept the scope explicit: this batch does not create an independent plugin window or change `getWindowType()` to `detach`.

Verification:

- Red/green: `pnpm test:plugin-host-view` first failed because `detach` still had `available:false`, then passed after enabling the action.
- Red/green: `pnpm test:plugin-events-bridge` first failed because `PluginPanel.svelte` lacked `dispatchPluginDetachEvent()`, then passed after adding the host dispatch path.
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-window-page-search`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin host preview rendered, `分离` was enabled and unique, `设置` remained disabled, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no framework overlay, no horizontal overflow, and console reported 0 errors / 0 warnings. This Web preview renders the output layer without an iframe, so detach event delivery is covered by the VM/static bridge tests.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:51618"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime `context_bridge_checked:true`, `browser_context_checked:true`, `finder_context_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:51618`.

Completion:

- Plugin iframe host parity: **54% -> 55%**
- Plugin runtime parity: **99% -> 99%**
- Detach lifecycle bridge: **API registration coverage -> titlebar action + host dispatch coverage**

## Older Batch

### Batch 207: Plugin Out Lifecycle Dispatch

Completed:

- Added a focused regression to `scripts/test-plugin-events-bridge.mjs` for host-side `onPluginOut` lifecycle dispatch.
- `PluginPanel.svelte` now dispatches `atools-plugin-out` into the plugin iframe before host back, iframe `__ipc_close__`, and Web preview close leave plugin mode.
- Svelte destroy fallback dispatches `atools-plugin-out` with `isKill:true`; normal host exits dispatch with `isKill:false`.
- The dispatch path is guarded against duplicate delivery per plugin owner and resets when `dynamicFeatureOwner` changes.

Verification:

- Red/green: `pnpm test:plugin-events-bridge` first failed because `PluginPanel.svelte` lacked a destroy-time lifecycle hook, then passed after the host dispatch implementation.
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-context-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-screen-interactive`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin host preview rendered, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings. Browser screenshot capture timed out and was not used as a pass condition.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:65113"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime `context_bridge_checked:true`, `browser_context_checked:true`, `finder_context_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:65113`.

Completion:

- Plugin iframe host parity: **53% -> 54%**
- Plugin runtime parity: **99% -> 99%**
- Lifecycle bridge: **event API registration coverage -> registration + host exit dispatch coverage**

## Older Batch

### Batch 206: Plugin Current Context Bridge

Completed:

- Added a focused VM regression test for `utools.readCurrentBrowserUrl()`, official alias `utools.getCurrentBrowserUrl()`, and `utools.readCurrentFolderPath()`.
- The test now verifies plugin iframe native-call routing, browser URL/null result handling, Finder folder path result handling, supported macOS browser coverage, and Finder Desktop fallback source coverage.
- Added `getCurrentBrowserUrl` to the shared `上下文` bridge capability inventory so the runtime strip reflects the actual injected API surface.
- Added `pnpm test:plugin-context-bridge`.

Verification:

- Red/green: `pnpm test:plugin-context-bridge` first failed because the shared capability inventory did not include `getCurrentBrowserUrl`, then passed after adding the alias.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-events-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin host preview rendered, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings. Browser screenshot capture timed out and was not used as a pass condition.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:61734"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime `context_bridge_checked:true`, `browser_context_checked:true`, `finder_context_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:61734`. Ports `1420` and `61734` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **52% -> 53%**
- Plugin runtime parity: **99% -> 99%**
- Context bridge: **command-layer smoke coverage -> plugin iframe VM regression + runtime capability alias coverage**

## Older Batch

### Batch 205: Plugin Screen Color Pick Bridge

Completed:

- Changed `screenColorPick(callback)` from fixed method-scoped unsupported to a WebView EyeDropper-compatible host path.
- The host now returns `{ hex, rgb }` from `EyeDropper.open()` when available.
- Missing EyeDropper support or invalid color output returns an explicit `screenColorPick unavailable` error instead of fake success.

Verification:

- Red/green: `pnpm test:plugin-screen-interactive` first failed because `PluginPanel.svelte` still contained `screenColorPick unsupported`, then passed after adding the EyeDropper host path.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:57656"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime context/dialog/data checks true, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57656`. Ports `1420` and `57656` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **51% -> 52%**
- Plugin runtime parity: **99% -> 99%**
- Screen bridge: **screenColorPick fixed unsupported -> EyeDropper-compatible host behavior**

## Older Batch

### Batch 204: Plugin Image/File Paste Input Bridge

Completed:

- Changed `hideMainWindowPasteImage(image)` from method-scoped unsupported to real WebView host behavior.
- Changed `hideMainWindowPasteFile(file)` from method-scoped unsupported to real WebView host behavior.
- The host now writes image payloads or one-or-more file paths to the clipboard, hides the main window, and sends macOS `Command+V` through System Events.

Verification:

- Red/green: `pnpm test:plugin-input-bridge` first failed because `PluginPanel.svelte` still contained `hideMainWindowPasteImage unsupported`, then passed after adding the image/file paste host paths.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:55442"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime context/dialog/data checks true, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:55442`. Ports `1420` and `55442` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **50% -> 51%**
- Plugin runtime parity: **99% -> 99%**
- External input bridge: **text paste + direct type -> text/image/file paste + direct type host behavior**

## Older Batch

### Batch 203: Plugin Type String Input Bridge

Completed:

- Changed `hideMainWindowTypeString(text)` from method-scoped unsupported to real WebView host behavior.
- The host now hides the main window, escapes plugin text with `appleScriptString`, and sends direct text input through macOS System Events.
- Kept `hideMainWindowPasteImage` and `hideMainWindowPasteFile` as explicit unsupported paths until their focus/permission/clipboard behavior can be implemented safely.

Verification:

- Red/green: `pnpm test:plugin-input-bridge` first failed because `PluginPanel.svelte` still contained `hideMainWindowTypeString unsupported`, then passed after adding the type-string host path.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:53032"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime context/dialog/data checks true, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:53032`. Ports `1420` and `53032` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **49% -> 50%**
- Plugin runtime parity: **99% -> 99%**
- External input bridge: **text paste only -> text paste + direct type host behavior**

## Older Batch

### Batch 202: Plugin Paste Text Input Bridge

Completed:

- Changed `hideMainWindowPasteText(text)` from method-scoped unsupported to real WebView host behavior.
- The host now writes plugin text to the clipboard, hides the main window, and sends macOS `Command+V` through System Events.
- Kept `hideMainWindowPasteImage`, `hideMainWindowPasteFile`, and `hideMainWindowTypeString` as explicit unsupported paths until their focus/permission/clipboard behavior can be implemented safely.

Verification:

- Red/green: `pnpm test:plugin-input-bridge` first failed because `PluginPanel.svelte` still contained `hideMainWindowPasteText unsupported`, then passed after adding the text paste host path.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:50359"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime context/dialog/data checks true, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:50359`. Ports `1420` and `50359` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **48% -> 49%**
- Plugin runtime parity: **99% -> 99%**
- External input bridge: **text paste unsupported -> clipboard + hide + paste host behavior**

## Older Batch

### Batch 201: Plugin Dynamic Base Href Resources

Completed:

- Runtime resource resolution now checks the live `<base href>` before falling back to the static `data-atools-plugin-base-href` marker.
- Dynamic resource requests use the live local base when plugins update `<base href>` after load.
- Static asset-rewritten base tags continue to use the preserved marker, so Batch 200 behavior remains intact.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because a live `./live/` base href still sent stale `baseDir: "./runtime/"`, then passed after preferring live local href.
- `pnpm test:plugin-resource-html`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:64085"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime context/dialog/data checks true, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:64085`. Ports `1420` and `64085` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **47% -> 48%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **static marker base href -> live local base href with marker fallback**

## Older Batch

### Batch 200: Plugin Runtime Base Href Resources

Completed:

- Preserved the original local `<base href>` as `data-atools-plugin-base-href` when rewriting the base tag to a WebView-loadable asset URL.
- Runtime resource resolution now reads that marker and includes it as `baseDir` for dynamic resource requests.
- Parent-side runtime resource handling converts the local base href into the plugin resource directory before resolving dynamic URLs.
- Dynamic image/media/srcset/object/script/link/style/CSSOM resources now resolve from the current local base directory when a plugin declares one.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because runtime image requests sent an empty `baseDir`, then passed after the bridge read the base marker.
- Red/green: `pnpm test:plugin-resource-html` first failed because rewritten `<base>` dropped the original local href marker, then passed after marker preservation.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:61828"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, plugin runtime context/dialog/data checks true, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:61828`. Ports `1420` and `61828` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **46% -> 47%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **local base href-aware static resources -> local base href-aware static and runtime resources**

## Older Batch

### Batch 199: Plugin Base Href Static Resources

Completed:

- Added local `<base href>` detection to plugin entry HTML resource preparation.
- Static script/style/img/icon/srcset resources now resolve from the declared local base directory when present.
- Stylesheet inlining also uses the base-resolved stylesheet path, so CSS `url(...)` and `@import` continue to resolve from the stylesheet file location.
- Rewrites the `<base href>` itself to a WebView-loadable asset URL while leaving remote/data/protocol base values alone.

Verification:

- Red/green: `pnpm test:plugin-resource-html` first failed because `<base href="./app/">` still read `pages/scripts/base.js` and `pages/styles/base.css`, then passed after base-aware resource preparation.
- `pnpm test:plugin-resource-runtime`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:60295"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, `data_debug_smoke.audit_filtered_export_checked:true`, `data_debug_smoke.audit_filtered_export_count_checked:true`, `permission_smoke.scope_deny_audit_recorded:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:60295`. Ports `1420` and `60295` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **45% -> 46%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **main_url-relative static resources -> local base href-aware static resources**

## Older Batch

### Batch 198: Plugin Variadic DOM Preinsert Resources

Completed:

- Extended dynamic script/link resource preflight beyond `appendChild()` / `insertBefore()` to modern DOM insertion methods.
- Patched `append()`, `prepend()`, `before()`, `after()`, and `replaceWith()` when available on Element/Document/DocumentFragment prototypes.
- For local `<script src>` and `<link href>` arguments, the bridge now resolves resource URLs through the parent host before calling the original variadic DOM method.
- Preserved variadic DOM method return semantics (`undefined`) and left non-local/already-converted arguments on the original immediate path.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because `append()` inserted a local dynamic script before resource resolution, then passed after adding variadic pre-insertion resource preflight.
- `pnpm test:plugin-resource-html`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:59460"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, `data_debug_smoke.audit_filtered_export_checked:true`, `data_debug_smoke.audit_filtered_export_count_checked:true`, `permission_smoke.scope_deny_audit_recorded:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:59460`. Ports `1420` and `59460` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **44% -> 45%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **script/link appendChild/insertBefore preflight -> modern DOM variadic insertion preflight**

### Batch 197: Plugin Script Link Preinsert Resources

Completed:

- Patched dynamic DOM insertion for fetch-sensitive local resources by wrapping `Node.prototype.appendChild` and `insertBefore` when available.
- For local `<script src>` and `<link href>` nodes, the bridge now resolves the resource through the parent host before calling the original DOM insertion method.
- Preserved synchronous return values for `appendChild()` / `insertBefore()` while the actual insertion completes after URL conversion.
- Left non-local and already-converted resources on the original immediate insertion path.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because local dynamic script nodes were appended before resource resolution, then passed after adding pre-insertion resource preflight.
- `pnpm test:plugin-resource-html`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:58562"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, `data_debug_smoke.audit_filtered_export_checked:true`, `data_debug_smoke.audit_filtered_export_count_checked:true`, `permission_smoke.scope_deny_audit_recorded:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:58562`. Ports `1420` and `58562` had no leftover listeners after smoke.

Completion:

- Plugin iframe host parity: **43% -> 44%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **post-insertion observer coverage -> script/link pre-insertion resource preflight**

### Batch 196: Plugin CSSStyleSheet InsertRule Resource Resolver

Completed:

- Patched `CSSStyleSheet.prototype.insertRule` inside the injected plugin iframe bridge when CSSOM is available.
- Preserved synchronous `insertRule()` return behavior, then asynchronously rewrote inserted CSS rules containing local `url(...)` / string `@import` resources.
- Replaced the inserted rule with the converted asset URL rule using the original `deleteRule` / `insertRule` methods, avoiding recursive bridge calls.
- Kept external/data URLs unchanged through the existing runtime CSS token scanner.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because `CSSStyleSheet.insertRule` did not emit a runtime resource resolve request, then passed after patching `insertRule`.
- `pnpm test:plugin-resource-html`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:57531"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57531`.

Completion:

- Plugin iframe host parity: **42% -> 43%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **dynamic style text/attributes -> CSSOM insertRule coverage**

## Previous Batch

### Batch 195: Plugin Runtime CSS Resource Resolver

Completed:

- Extended the runtime resource scanner to include `<style>` nodes and `[style]` attributes.
- Added bridge-side CSS token rewriting for runtime CSS `url(...)` and string `@import "..."` values without relying on template-string-sensitive regex parsing.
- Added `MutationObserver` coverage for `style` attribute changes and style text mutations via `characterData`.
- Preserved remote/data URLs and only asked the parent host to convert local CSS resource URLs.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because the runtime scanner did not include style elements or style attributes, then passed after adding CSS token scanning and style mutation observation.
- `pnpm test:plugin-resource-html`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:56742"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:56742`.

Completion:

- Plugin iframe host parity: **41% -> 42%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **dynamic node attributes -> dynamic CSS text and inline style resource coverage**

## Previous Batch

### Batch 194: Plugin Runtime Resource Resolver

Completed:

- Added a runtime `__atools_resolve_plugin_resource__` bridge inside the injected plugin iframe script.
- Added parent-window `__atools_resource_resolve__` / `__atools_resource_response__` handling in `PluginPanel`, using `convertPluginResourceUrl()` with the current plugin path and `main_url`.
- Added a best-effort runtime scanner and `MutationObserver` for common dynamically inserted resource attributes: `src`, `poster`, `srcset`, `href`, and `data` on image/media/script/link/object style nodes.
- Preserved external, data, protocol, hash-only, and already-converted asset URLs, and marked resolved attributes to avoid repeated rewrites.

Verification:

- Red/green: `pnpm test:plugin-resource-runtime` first failed because the bridge did not expose `__atools_resolve_plugin_resource__`, then passed after adding the runtime resolver, initial scan, mutation observer, `srcset` candidate handling, and parent response path.
- `pnpm test:plugin-resource-html`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin preview rendered, output layer had 2 rows, SubInput was visible with value `time`, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:56147"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:56147`.

Completion:

- Plugin iframe host parity: **40% -> 41%**
- Plugin runtime parity: **99% -> 99%**
- Runtime resource loading: **static entry-only coverage -> best-effort dynamic node attribute resolution**

## Previous Batch

### Batch 193: Plugin Srcset And CSS Import Resources

Completed:

- Extended `pluginResourceHtml` so static entry resource preparation now rewrites `srcset` candidates for `img` / `source` style media elements.
- Preserved data/external candidates inside `srcset` while converting local candidates through the same `main_url`-relative `convertFileSrc` path.
- Added stylesheet string `@import "./file.css"` rewriting in addition to existing `url(...)` rewriting; `@import url(...)` remains covered by the URL pass.
- Covered non-stylesheet link resources such as icon and modulepreload in the regression test, matching real ZTools/Vite plugin resource shapes seen on this machine.

Verification:

- Red/green: `pnpm test:plugin-resource-html` first failed because `srcset` stayed as `./small.png` / `../assets/logo@2x.png`, then passed after adding `rewriteSrcsetResourceUrls()` and CSS string `@import` rewriting.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: output layer rendered, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, SubInput was visible with value `time`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:55175"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:55175`. Vite printed shutdown-time `The service was stopped` noise after the smoke JSON, but the command exited 0 and no residual process remained.

Completion:

- Plugin iframe host parity: **39% -> 40%**
- Plugin runtime parity: **99% -> 99%**
- Static resource loading: **script/style/image basics -> srcset, CSS @import, icon/modulepreload coverage**

## Previous Batch

### Batch 192: Plugin HTML Resource Paths

Completed:

- Added `pluginResourceHtml` helpers to prepare plugin entry HTML before it is assigned to iframe `srcdoc`.
- Fixed resource resolution to use the directory of `main_url`, so plugins with entries such as `pages/index.html` load sibling scripts/styles instead of incorrectly resolving them from the plugin root.
- Inlined local `<script src>` and stylesheet links, rewrote stylesheet `url(...)` references through Tauri asset URLs, and rewrote common HTML image/media resource attributes through `convertFileSrc`.
- Left external, data, protocol, and hash-only URLs unchanged so remote/plugin-authored links do not get misinterpreted as local files.

Verification:

- Red/green: `pnpm test:plugin-resource-html` first failed with `AssertionError: pluginResourceHtml helper should exist`, then passed after adding the helper and wiring `PluginPanel`.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: output layer rendered, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, SubInput DOM was visible with smoke value `time`, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:54808"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:54808`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Plugin iframe host parity: **38% -> 39%**
- Plugin runtime parity: **99% -> 99%**
- Plugin resource loading: **root-only script inlining / broken CSS-image relatives -> `main_url`-relative script/style/image preparation**

## Previous Batch

### Batch 191: Plugin Desktop Capture Sources

Completed:

- Added `pluginScreenBridge` helpers for `desktopCaptureSources(options)`, producing a primary screen source from the current WebView display metadata.
- Changed `PluginPanel` host handling for `desktopCaptureSources` from immediate unsupported to a side-effect-free compatibility source list when `types` includes `screen`.
- Kept `types:["window"]` honest by returning an empty list, because native window enumeration is still not implemented.
- Kept `screenColorPick(callback)` unchanged as explicit native-only unsupported; this batch does not introduce an interactive color picker.

Verification:

- Red/green: `pnpm test:plugin-screen-interactive` first failed because `pluginScreenBridge` did not exist, then passed after adding `desktopCaptureSourcesForDisplay()` and wiring `PluginPanel`.
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-system-shell-bridge`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin host preview rendered, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, SubInput/output were visible, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:53851"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:53851`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Plugin iframe host parity: **37% -> 38%**
- Plugin runtime parity: **99% -> 99%**
- Desktop capture source bridge: **native-only unsupported -> primary screen compatibility source**

## Previous Batch

### Batch 190: Plugin Shell Trash Bridge

Completed:

- Added `pluginSystemShellBridge` helpers for `shellTrashItem`, including non-empty path validation and AppleScript string escaping.
- Changed `PluginPanel` host handling for `shellTrashItem(path)` from immediate unsupported to a real macOS Finder `delete POSIX file ...` bridge, which moves the target into Trash.
- Kept the bridge scoped: no silent delete, no network/plugin permission model changes, and no broad implementation of unrelated paste/screen/browser bridge stubs.

Verification:

- Red/green: `pnpm test:plugin-system-shell-bridge` first failed because `pluginSystemShellBridge` did not exist, then passed after adding the helper and wiring `PluginPanel` to `shellTrashAppleScript`.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1`: plugin host preview rendered, bridge detail showed `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, SubInput/output were visible, no horizontal overflow, and console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:53438"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:53438`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Plugin iframe host parity: **36% -> 37%**
- Plugin runtime parity: **99% -> 99%**
- Plugin shell bridge: **exposed unsupported -> macOS move-to-Trash bridge**

## Previous Batch

### Batch 189: Search Result Keyboard Hint Refinement

Completed:

- Refined the search results status bar so result mode shows separate `↑ 上一行` and `↓ 下一行` hints instead of the older combined `↑↓ 移动` label.
- Kept contextual `Enter` actions tied to the selected result: system/plugin results use `执行`, web/link/local launch results use `打开`, and text quick actions use `复制`.
- Adjusted the narrow-screen status bar rule so the first three hints remain visible after splitting directions: `↑`, `↓`, and `Enter`.
- Rechecked already-implemented Settings smoke items for `HTTP 服务` and `快捷键 / 全局快捷键`, then synced the macOS smoke checklist with the automated evidence.

Verification:

- Red/green: `pnpm test:search-status-bar` first failed because result mode still returned `↑↓:移动` and the component hid hints from the third item on narrow screens, then passed after splitting the navigation hints and preserving the `Enter` hint.
- `pnpm test:result-presentation`
- `pnpm test:http-service-settings`
- `pnpm test:http-service-overview`
- `pnpm test:hotkey-recorder`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser render check at `http://127.0.0.1:1420/`: typing `set` showed `Enter 执行`, `↑ 上一行`, `↓ 下一行`; dispatching `ArrowDown` moved to `打开 桌面` and showed `Enter 打开`; console reported 0 errors / 0 warnings.
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:52877"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:52877`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Home/search experience: **85% -> 86%**
- ZTools/uTools main search experience: **99% -> 100%**
- Settings smoke checklist accuracy: **stale unchecked items -> checked with script evidence**

## Previous Batch

### Batch 188: Custom Plugin Market Remote Catalog

Completed:

- Added a typed `PluginMarketCatalog` bridge shape shared by Svelte and the Tauri command result.
- Added `fetch_plugin_market_catalog`, a desktop command that fetches an http/https custom market JSON catalog, normalizes `updatedAt`, filters out entries without a valid `downloadUrl`, and returns safe display metadata.
- Updated plugin market status cards so a loaded custom catalog becomes `目录可用`, with `目录读取` and `市场搜索` marked available while `下载/更新` and `远程评分` remain deferred.
- Updated Settings -> `插件市场` refresh flow to read installed plugins and, when a custom market URL is enabled, fetch and render the remote catalog list.
- Kept the boundary explicit: this batch reads and displays remote catalog metadata only; it does not install, update, download, score, or execute remote plugins.

Verification:

- Red/green: `pnpm test:plugin-market-status` first failed because `remoteCatalogLoaded` was missing, then passed after adding catalog state to `pluginMarketStatus()`.
- Red/green: `pnpm test:plugin-market-overview` first failed on stale card expectations and local-entry tone, then passed after the overview model represented the market address and remote capability counts.
- Red/green: `pnpm test:plugin-market-catalog` first failed because market status remained `disabled` and SettingsPanel had no catalog fetch path, then passed after adding the remote catalog UI and command invocation.
- Red/green: `cargo test -p atools --lib plugin_market_catalog` first failed because `fetch_plugin_market_catalog_from_url` did not exist, then passed after adding the HTTP catalog fetcher and normalizer.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm test:plugin-market-catalog`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:52087"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:52087`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Settings page functional parity: **99% -> 99%**
- Settings real functionality: **99% -> 99%**
- Plugin install/import/market: **59% -> 61%**
- Custom plugin market remote catalog: **disabled metadata placeholder -> desktop JSON catalog fetch/display**

## Previous Batch

### Batch 187: Super Panel Desktop Window

Completed:

- Stopped forcing `superPanelEnabled` back to `false`; saved settings now preserve a real boolean while still rejecting non-boolean legacy values.
- Removed super panel from `generalUnsupportedCapabilities()` and updated the general overview copy so only the GPU launch parameter remains deferred.
- Enabled Settings -> `通用设置` -> `启用超级面板` with live desktop status and a direct `set_super_panel_visible` call.
- Added the Tauri `super-panel` Webview window at `/#/super-panel`: transparent, decorationless, always on top, skipped from taskbar, top-centered on the primary monitor, and hidden instead of destroyed when disabled.
- Added the super-panel frontend route in `App.svelte`; it reads clipboard text, supports refresh/copy, and calls `show_main_window` from the `打开主搜索` action.
- Extended desktop smoke with `system_settings_smoke.super_panel_window=true`, exercising create/show/hide without mutating saved settings.

Verification:

- Red/green: `pnpm test:settings-normalization` first failed because `superPanelEnabled` still normalized to `false`, then passed after preserving a real boolean.
- Red/green: `pnpm test:settings-pages` first failed because `superPanel` remained in `generalUnsupportedCapabilities`, then passed after removing it from the deferred list.
- Red/green: `pnpm test:general-settings-overview` first failed because SettingsPanel still rendered the disabled “not implemented” copy, then passed after enabling the control and native command path.
- Red/green: `pnpm test:super-panel-ui` first failed because App had no super-panel route, then passed after adding `/#/super-panel` UI, clipboard actions, and `show_main_window`.
- Red/green: `cargo test -p atools --lib super_panel` first failed because the Rust window helpers did not exist, then passed after adding settings parsing and monitor geometry helpers.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:settings-normalization`
- `pnpm test:settings-pages`
- `pnpm test:general-settings-overview`
- `pnpm test:super-panel-ui`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:51238"`, `system_settings_smoke.floating_ball_window:true`, `system_settings_smoke.super_panel_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:51238`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Settings page functional parity: **99% -> 99%**
- Settings real functionality: **99% -> 99%**
- Super panel setting/window: **disabled placeholder -> desktop window create/show/hide + clipboard entry + click-to-main**

## Earlier Batch

### Batch 186: Floating Ball Desktop Window

Completed:

- Stopped forcing `floatingBallEnabled` back to `false`; saved settings now preserve a real boolean value while keeping super panel and GPU launch parameters unavailable.
- Removed floating ball from `generalUnsupportedCapabilities()` and updated the general overview copy so only super panel and GPU launch parameters remain deferred.
- Enabled Settings -> `通用设置` -> `显示悬浮球` with live desktop status and a direct `set_floating_ball_visible` call.
- Added the Tauri `floating-ball` Webview window at `/#/floating-ball`: transparent, decorationless, always on top, skipped from taskbar, positioned near the primary monitor bottom-right edge, and hidden instead of destroyed when disabled.
- Added the floating-ball frontend route in `App.svelte`; it renders a compact Z button and calls `show_main_window` when clicked.
- Extended desktop smoke with `system_settings_smoke.floating_ball_window=true`, exercising create/show/hide without mutating saved settings.

Verification:

- Red/green: `pnpm test:settings-normalization` first failed because `floatingBallEnabled` still normalized to `false`, then passed after preserving a real boolean.
- Red/green: `pnpm test:settings-pages` first failed because `floatingBall` remained in `generalUnsupportedCapabilities`, then passed after removing it from the deferred list.
- Red/green: `pnpm test:general-settings-overview` first failed because SettingsPanel still rendered the disabled “not implemented” copy, then passed after enabling the control and native command path.
- Red/green: `pnpm test:floating-ball-ui` first failed because App had no floating-ball route, then passed after adding `/#/floating-ball` UI and `show_main_window`.
- Red/green: `cargo test -p atools --lib floating_ball` first failed because the Rust window helpers did not exist, then passed after adding settings parsing and monitor geometry helpers.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:settings-normalization`
- `pnpm test:settings-pages`
- `pnpm test:general-settings-overview`
- `pnpm test:floating-ball-ui`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:50223"`, `system_settings_smoke.floating_ball_window:true`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:50223`.
- Residual checks after smoke: no listener on TCP `1420`, and no matching `target/debug/atools`, `pnpm dev`, `vite`, or `smoke-tauri-desktop` process.

Completion:

- Settings page functional parity: **99% -> 99%**
- Settings real functionality: **99% -> 99%**
- Floating ball setting/window: **disabled placeholder -> desktop window create/show/hide + click-to-main**

## Earlier Batch

### Batch 185: Custom Plugin Market Address

Completed:

- Added `pluginMarketUrl` to settings defaults and normalization. The saved address is trimmed, accepts only `http` / `https`, and only enables `pluginMarketCustom` when a valid address is present.
- Removed custom plugin market from the general unsupported-capabilities list while keeping the then-deferred super panel, floating ball, and GPU launch parameter clearly marked unavailable.
- Enabled Settings -> `通用设置` custom plugin market controls with a real `插件市场地址` input and an enabled toggle once an address exists.
- Extended Settings -> `插件市场` status with `customMarketConfigured`, the saved URL, a `市场地址` overview card, a local `自定义地址` capability row, and a desktop `打开市场地址` action using `shell_open`.
- Kept the boundary explicit: remote market browsing, download/update, ratings, and remote details still remain deferred.

Verification:

- Red/green: `pnpm test:settings-normalization` first failed because `pluginMarketUrl` did not exist, then passed after URL normalization and custom-market enable gating.
- Red/green: `pnpm test:settings-pages` first failed because `pluginMarketCustom` still appeared in `generalUnsupportedCapabilities`, then passed after removing it from the unsupported list.
- Red/green: `pnpm test:general-settings-overview` first failed because SettingsPanel did not render `插件市场地址`, then passed after adding the input, toggle copy, and open action.
- Red/green: `pnpm test:plugin-market-status` first failed because market status had no custom-market fields, then passed after adding configured URL status and overview rows.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:settings-normalization`
- `pnpm test:settings-pages`
- `pnpm test:general-settings-overview`
- `pnpm test:plugin-market-status`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:64612"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:64612`. Vite/esbuild printed shutdown-time service-stop noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **99% -> 99%**
- Settings real functionality: **99% -> 99%**
- Custom plugin market address setting: **disabled placeholder -> saved http/https external market entry**

## Earlier Batch

### Batch 184: DevTools Position Preference and Open Command

Completed:

- Added `DevToolsMode` normalization for `detach`, `right`, `bottom`, and `undocked`; invalid old values fall back to the default `detach`.
- Stopped forcing `devToolsMode` back to the default during settings save/apply.
- Removed DevTools position from the general unsupported-capabilities list.
- Enabled the Settings -> `通用设置` `开发者工具位置` select and added a desktop-only `打开主窗口 DevTools` test action.
- Added the Tauri command `open_devtools_for_window`, which validates the saved mode, targets `main` or `settings`, and calls Tauri `open_devtools()` on the selected window.
- Kept the user-facing status honest: dock/undock is saved as a preference, while actual native docking behavior depends on the current WebView.

Verification:

- Red/green: `pnpm test:settings-normalization` first failed because `devToolsMode` was still normalized back to `detach`, then passed after adding valid-mode preservation and invalid-mode fallback.
- Red/green: `pnpm test:settings-pages` first failed because `devToolsMode` still appeared in `generalUnsupportedCapabilities`, then passed after removing that unsupported entry.
- Red/green: `pnpm test:general-settings-overview` first failed because SettingsPanel still showed the DevTools unsupported copy and disabled select, then passed after adding the enabled select and command button.
- Red/green: `cargo test -p atools --lib devtools_mode_settings_are_parsed_for_window_opening` first failed because the DevTools helper functions did not exist, then passed after adding the helper and desktop command.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:settings-normalization`
- `pnpm test:settings-pages`
- `pnpm test:general-settings-overview`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:63289"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:63289`. Vite/esbuild printed shutdown-time service-stop noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **99% -> 99%**
- Settings real functionality: **99% -> 99%**
- DevTools position setting completion: **disabled placeholder -> saved preference plus Tauri DevTools open command**

## Earlier Batch

### Batch 183: Network Proxy Request Layer

Completed:

- Added `proxyUrl` to settings defaults and normalization. Proxy stays enabled only when a valid trimmed `http` or `https` URL is present; invalid schemes are cleared instead of being saved as active settings.
- Re-enabled the Settings -> `通用设置` network proxy controls with a real `代理地址` input and copy that explains the proxy is used by WebDAV sync and AI model connection tests.
- Removed proxy from the general unsupported-capabilities list.
- Wired the normalized proxy URL into the Rust request layer for AI `/models` connection tests and WebDAV sync, remote preview, restore-plan, settings restore, clipboard import, and plugin-data import downloads.
- Added proxy URL validation on the Rust side so enabled proxy settings with an empty URL or non-http/https scheme return an explicit proxy error.
- Added proxy state to redacted diagnostics while always redacting `proxyUrl`.

Verification:

- Red/green: `pnpm test:settings-normalization` first failed because `normalizeSettings()` still forced `proxyEnabled` to `false`, then passed after proxy URL normalization was added.
- Red/green: `pnpm test:settings-pages` first failed because proxy still appeared in `generalUnsupportedCapabilities`, then passed after removing that unsupported entry.
- Red/green: `pnpm test:general-settings-overview` first failed because SettingsPanel did not render `代理地址`, then passed after adding the enabled proxy controls.
- Red/green: `cargo test -p atools --lib network_proxy_settings_are_parsed_for_ai_and_webdav_requests` first failed because AI and WebDAV configs had no `proxy_url`, then passed after request-layer wiring.
- Red/green: `pnpm test:debug-diagnostics` first failed because the diagnostic bundle omitted proxy fields, then passed after adding redacted proxy diagnostics.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:settings-normalization`
- `pnpm test:settings-pages`
- `pnpm test:general-settings-overview`
- `pnpm test:debug-diagnostics`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:62052"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:62052`. Vite printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **99% -> 99%**
- Settings real functionality: **99% -> 99%**
- Network proxy setting completion: **disabled placeholder -> connected to WebDAV/AI request layer**

## Earlier Batch

### Batch 182: WebDAV Plugin Data Per-Document Conflict Selection

Completed:

- Added plugin-data conflict documents to the WebDAV restore plan. The plan now exposes same-plugin, same-document-ID conflicts with plugin name, document ID, local summary, and remote summary.
- Added an explicit `overwrite_selected_conflicts` restore mode. It imports missing plugin documents and overwrites only the selected same-ID conflict documents; unselected conflicts remain skipped.
- Kept existing restore modes compatible: `append_missing` still skips every conflict, and `overwrite_conflicts` still overwrites all conflicts after explicit confirmation.
- Updated Settings -> `WebDAV 同步` with a `插件数据冲突选择` list, `全选冲突` / `清空选择`, and a separate high-risk `覆盖选中冲突` action.
- Updated restore plan rows so plugin restore previews show conflict counts, e.g. `冲突 2 条`.

Verification:

- Red/green: `cargo test -p atools --lib webdav_plugin_data_restore_selected_conflicts_only_replaces_chosen_docs` first failed because `WebdavPluginDataConflictSelection`, `OverwriteSelectedConflicts`, and the selected-conflict function argument did not exist, then passed after selective overwrite support was added.
- Red/green: `cargo test -p atools --lib plugin_data_restore_plan_lists_same_id_conflict_documents` first failed because `WebdavRestorePlanItem.plugin_conflicts` did not exist, then passed after restore plans exposed per-document conflicts.
- Red/green: `pnpm test:webdav-sync-view` first failed because `webdavPluginDataSelectedOverwriteButtonState` did not exist, then passed after adding the selected overwrite button model and restore-plan conflict count text.
- Red/green: `pnpm test:webdav-settings-overview` first failed because SettingsPanel did not render `覆盖选中冲突`, `插件数据冲突选择`, or `mode: "overwrite_selected_conflicts"`, then passed after adding the UI action.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:webdav-sync-view`
- `pnpm test:webdav-settings-overview`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:60478"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:60478`. Vite printed shutdown-time `The service was stopped` noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **99% -> 99%**
- WebDAV plugin data restore completion: **99% -> 100%**

## Earlier Batch

### Batch 181: WebDAV Plugin Data Conflict Overwrite

Completed:

- Added an explicit `overwrite_conflicts` restore mode for WebDAV plugin data.
- Kept the default `append_missing` behavior unchanged: missing documents are imported and same-ID conflicts are skipped.
- Added conflict overwrite accounting with `overwritten_documents`, while still reporting conflicts, unchanged documents, skipped documents, and missing plugins.
- Updated Settings -> `WebDAV 同步` with a separate high-risk `覆盖冲突数据` action. The action passes `mode: "overwrite_conflicts"` and requires a dedicated confirmation explaining that remote same-ID documents will replace local conflict documents.
- Updated WebDAV result rows so plugin restore output shows `已覆盖` separately from `已导入`.

Verification:

- Red/green: `cargo test -p atools --lib webdav_plugin_data_restore_overwrite_mode_replaces_conflicts` first failed because `apply_webdav_plugin_data_payload_with_mode` and `WebdavPluginDataRestoreMode` did not exist, then passed after mode-aware restore was added.
- Red/green: `pnpm test:webdav-sync-view` first failed because `webdavPluginDataOverwriteButtonState` did not exist, then passed after adding the explicit overwrite button model and `已覆盖` result row.
- Red/green: `pnpm test:webdav-settings-overview` first failed because SettingsPanel did not render the overwrite action or pass `mode: "overwrite_conflicts"`, then passed after adding the UI action.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:webdav-sync-view`
- `pnpm test:webdav-settings-overview`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:59235"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:59235`. Vite printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **98% -> 99%**

## Earlier Batch

### Batch 180: WebDAV Plugin Data Append Restore

Completed:

- Added `restore_webdav_plugin_data`, which downloads `plugin-data.json` from the configured WebDAV backup after explicit confirmation.
- Added a safe local plugin data apply path: installed-plugin missing documents are imported, existing matching documents are skipped as unchanged, conflicting same-ID documents are skipped without overwriting local plugin data, and missing plugins are reported.
- Updated Settings -> `WebDAV 同步` with a `导入插件数据` action, confirmation copy, result rows, and conflict-handling status text.
- Updated the shared WebDAV view model with plugin data restore button state and result rows.

Verification:

- Red/green: `cargo test -p atools --lib webdav_plugin_data_restore_imports_missing_docs_and_skips_conflicts` first failed because `apply_webdav_plugin_data_payload` did not exist, then passed after the safe apply helper was added.
- Red/green: `pnpm test:webdav-sync-view` first failed because `webdavPluginDataRestoreButtonState` did not exist, then passed after adding the shared button/result model.
- Red/green: `pnpm test:webdav-settings-overview` first failed because SettingsPanel had no plugin data restore action, then passed after adding the UI invoke path.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:webdav-sync-view`
- `pnpm test:webdav-settings-overview`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:58329"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:58329`.

Completion:

- Settings page functional parity: **97% -> 98%**

## Earlier Batch

### Batch 179: Audit JSONL File Archive

Completed:

- Added native audit archive writing with explicit confirmation, parent-directory creation, and a serialized `{ path, count }` result.
- Exposed `archive_audit_entries_jsonl` as a Tauri command and registered it in the desktop invoke handler.
- Updated Settings -> `我的数据` so audit records can be saved to a user-selected `atools-audit-archive-YYYY-MM-DD.jsonl` file, separate from clipboard export and retention cleanup.
- Updated the shared data overview copy so audit data now documents retention cleanup and file archive support.

Verification:

- Red/green: `cargo test -p atools --lib audit_archive_file_requires_confirmation_and_writes_jsonl` first failed because `write_audit_archive_file` did not exist, then passed after the native archive helper was added.
- Red/green: `pnpm test:data-settings-overview` first failed because the audit card and SettingsPanel lacked archive support, then passed after adding the shared copy and archive action.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --lib`
- `pnpm test:data-settings-overview`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:57168"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57168`. Vite/esbuild printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0.

Completion:

- Permission and audit foundation: **96% -> 97%**

## Older Batches

### Batch 178: Audit Retention Cleanup

Completed:

- Added native audit pruning that applies both age retention and latest-count retention in SQLite.
- Exposed `prune_audit_entries` as a Tauri command, with `retentionDays` converted to a UTC cutoff and `keepLatest` enforced by timestamp ordering.
- Updated Settings -> `我的数据` with an `审计保留策略` section and a `清理旧记录` action using the default 90-day / latest-1000 policy.
- Updated the data overview model so audit records explicitly describe local retention cleanup rather than only export/clear.

Verification:

- Red/green: `cargo test -p atools-core --lib test_prune_audit_entries_applies_age_and_count_retention` first failed because `prune_audit_entries` did not exist, then passed after the DB method was added.
- Red/green: `pnpm test:data-settings-overview` first failed because the audit card lacked retention copy, then passed after adding the shared model and SettingsPanel action.
- `cargo fmt --check`
- `cargo test -p atools-core --lib`
- `cargo test -p atools --lib`
- `pnpm test:data-settings-overview`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:56250"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:56250`. Vite/esbuild printed shutdown-time noise after the smoke JSON, but the command exited 0.

Completion:

- Permission and audit foundation: **95% -> 96%**

## Older Completed Batches

### Batch 177: Plugin Agent Tool Preload Lazy Load

Completed:

- Added a retry path for plugin Agent tool execution when the plugin runtime reports `Context not found`.
- Lazy-loads the plugin manifest `preload` into the Agent runtime before retrying the registered tool handler, so MCP/plugin Agent tools no longer require the plugin UI to have been opened first.
- Rejects absolute or parent-directory preload paths before reading from disk, keeping lazy-load bounded to the installed plugin directory.
- Added a smoke-script config guard that hidden startup windows must not request focus, then changed the hidden main window from `focus:true` to `focus:false`; this resolved the real desktop smoke hang in macOS window creation.

Verification:

- Red/green: `cargo test -p atools --test agent_tools_tests plugin_manifest_tool_lazy_loads_preload_when_context_is_missing` first failed with `Context not found`, then passed after preload lazy-load.
- Red/green: `cargo test -p atools --test agent_tools_tests plugin_manifest_tool_lazy_load_rejects_preload_outside_plugin_directory` covers preload path escape rejection.
- Red/green: `pnpm test:tauri-desktop-smoke-script` first failed with `hidden startup window main must not request focus`, then passed after changing the Tauri window config.
- `cargo fmt --check`
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-db-storage`
- `pnpm check`
- `pnpm test:settings-pages`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:55238"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:55238`. Vite printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0.

Completion:

- Agent/MCP local foundation: **98% -> 99%**

## Earlier Batch

### Batch 176: Async Plugin Agent Tool Execution

Completed:

- Extended `____callAgentTool____` so plugin Agent tools can return Promise/async handler results instead of being rejected as unsupported.
- Added async result tracking in the plugin shim and a Rust worker wait path that drives QuickJS microtasks while waiting for completion.
- Fixed the IPC dispatcher root cause that made single async plugin IPC calls starve: spawned tasks on a current-thread runtime were not polled while the dispatcher blocked for more crossbeam messages.
- Covered both plain Promise handlers and async handlers that await `utools.dbStorage` IPC calls.

Verification:

- Red/green: `cargo test -p atools-plugin --lib call_agent_tool_awaits_async_handler_promise` first failed with `Failed to call function: Exception`, then passed after async result tracking.
- Red/green: `cargo test -p atools --test agent_tools_tests plugin_manifest_tool_executes_async_handler_that_uses_ipc_bridge` first timed out waiting for the async plugin result, then passed after fixing the IPC dispatcher polling path.
- `cargo fmt --check`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-api-shim`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:50957"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:50957`. Vite printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0. Ports `1420` and `50957` had no leftover listeners after smoke.

Completion:

- Agent/MCP local foundation: **97% -> 98%**

## Earlier Batch

### Batch 175: Plugin Agent Tool Sync Execution Bridge

Completed:

- Routed Agent tool execution by `ToolDefinition.source`: plugin tools now call the plugin runtime instead of always entering the builtin executor.
- Added a plugin-runtime `____callAgentTool____` bridge that resolves original manifest tool names and normalized `plugin_<plugin>_<tool>` names.
- Supported synchronous handlers registered with `utools.registerTool(name, definition, handler)` and returned their JSON result through the Agent/MCP path.
- Kept unsupported cases explicit: missing handlers and async/Promise handlers return controlled plugin-tool errors rather than silent success.
- Added runtime and Tauri Agent tests covering a registered plugin manifest tool executing with arguments.

Verification:

- Red/green: `cargo test -p atools-plugin --lib call_agent_tool_invokes_registered_sync_handler` first failed with `Function ____callAgentTool____ not found`, then passed after adding the runtime bridge.
- Red/green: `cargo test -p atools --test agent_tools_tests plugin_manifest_tool_executes_registered_plugin_handler` first failed before `execute_plugin_tool` existed, then passed after routing plugin tools through the runtime.
- `cargo fmt --check`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `pnpm check`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:63773"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:63773`. Vite/esbuild printed shutdown-time `write EPIPE` / callback noise after the smoke JSON, but the command exited 0. Ports `1420` and `63773` had no leftover listeners after smoke.

Completion:

- Agent/MCP local foundation: **96% -> 97%**

## Earlier Batch

### Batch 174: Local Imported Plugin Update

Completed:

- Changed imported-plugin detail `更新插件` from a remote-update placeholder into a real local update action.
- Added native `update_plugin_from_path` with same-plugin manifest ID validation before replacement.
- Preserved existing plugin enabled state and `created_at` during updates; refreshed `updated_at`, manifest, files, feature index, and plugin Agent tool whitelist.
- Rejected unsafe update sources that overlap the installed plugin directory, avoiding the old install-flow risk of deleting the selected source.
- Kept builtin plugins protected: they still cannot be replaced from Settings and continue to update only with the app.

Verification:

- Red/green: `cargo test -p atools --lib plugin_update_from_path_replaces_same_plugin_and_rejects_installed_source` first failed because `plugin_update_from_path_inner` did not exist, then passed after adding the update helper and command.
- Red/green: `pnpm test:plugin-inventory` first failed because `更新插件` still returned `available:false` / `远程更新未接入`, then passed after the inventory model and SettingsPanel wiring were updated.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `pnpm check`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:60226"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:60226`. Vite/esbuild printed shutdown-time `write EPIPE` / callback noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **96% -> 97%**

## Earlier Batch

### Batch 173: Plugin Permission Capability Audit

Completed:

- Changed plugin detail `插件权限` from an unavailable placeholder into a real read-only view action.
- Added shared inventory permission rows for each selected plugin: runtime entry (`main` / `preload`), feature command match count, manifest `tools`, and local data boundary.
- Added `pluginPermissionPanelOpen` in SettingsPanel and a `插件权限/能力审计` section that renders the shared permission rows.
- Kept the scope honest: this is a manifest/capability audit. Agent tool authorization still lives in the Agent/MCP whitelist, and full plugin permission isolation is not claimed.

Verification:

- Red/green: `pnpm test:plugin-inventory` first failed because `插件权限` was still unavailable with `插件权限模型未接入`, then passed after the inventory model and SettingsPanel wiring were updated.
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `pnpm check`
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:57531"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57531`. Vite/esbuild printed shutdown-time `write EPIPE` / callback noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **95% -> 96%**

## Earlier Batch

### Batch 172: Local Plugin Directory Install

Completed:

- Changed the Settings `已安装插件` top-level `安装插件` button from a hard-disabled placeholder into a desktop-only local install entry.
- Added `installPluginFromDirectory` in SettingsPanel to open a directory picker for folders containing `plugin.json`.
- Routed the selected directory through native `install_plugin`, selected the returned plugin, and refreshed the installed plugin inventory after install.
- Kept browser preview safe: without Tauri runtime, the button reports `浏览器预览模式无法安装插件` and never opens a native dialog.
- Updated the plugin inventory overview card to `本地安装`, with copy that local `plugin.json` directory install is available while network install and remote update remain unavailable.

Verification:

- Red/green: `pnpm test:plugin-inventory` first failed because SettingsPanel did not expose `installPluginFromDirectory`, then passed after the install handler and button wiring were added.
- Red/green: `pnpm test:plugin-inventory-overview` first failed because the install overview still returned `本地导入`, then passed after the model copy was updated.
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `pnpm check`
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:54990"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:54990`. Vite/esbuild printed shutdown-time `write EPIPE` / callback noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **94% -> 95%**

## Earlier Batch

### Batch 171: Plugin Directory Reveal Action

Completed:

- Changed plugin detail `打开目录` from an unavailable placeholder into a real available action.
- Added `openInstalledPluginDirectory` in SettingsPanel to call native `shell_show_item_in_folder` with the selected plugin path.
- Kept browser preview safe: without Tauri runtime, the action reports that the path cannot be located from Web preview.
- Kept `更新插件` and `插件权限` unavailable; this batch only connects local directory reveal.
- Updated plugin inventory action copy to `在 Finder 中定位插件目录`.

Verification:

- Red/green: `pnpm test:plugin-inventory` first failed because `打开目录` still returned `available:false` with `暂不从设置页触发本地副作用`, then passed after model and SettingsPanel wiring.
- `pnpm test:plugin-inventory`
- `pnpm check`
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `pnpm test:plugin-inventory-overview`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:52951"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:52951`. Vite printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **93% -> 94%**

## Earlier Batch

### Batch 170: Imported Plugin Uninstall Flow

Completed:

- Added an installed-plugin detail action that allows uninstalling imported plugins.
- Kept builtin plugins protected: their uninstall action remains unavailable with an explicit `内置插件不可卸载，可停用以隐藏指令` reason.
- Routed imported-plugin uninstall through the existing in-page destructive confirmation dialog, with copy that states plugin files, feature indexes, and plugin data are removed.
- Wired the settings page to call the native `uninstall_plugin` command, clear the current selection, and refresh the installed plugin inventory after success.
- Hardened the native uninstall command so it only removes plugin directories inside the ATools user plugins directory, preventing accidental deletion of bundled resource plugins.
- Updated the plugin inventory overview copy: network install and remote update remain unavailable, while imported plugin uninstall is now available.

Verification:

- Red/green: `pnpm test:plugin-inventory` first failed because `卸载插件` was still unavailable with `卸载流程和数据确认未接入`, then passed after the inventory model and SettingsPanel wiring were updated.
- Red/green: `pnpm test:plugin-inventory-overview` first failed because the overview still said uninstall was not connected, then passed after copy was updated.
- Red/green: `cargo test -p atools --lib plugin_uninstall_path_allows_only_user_plugin_directories` first failed because `plugin_uninstall_path_allowed` did not exist, then passed after adding the path guard.
- `cargo fmt --check`
- `cargo test -p atools --lib`
- `pnpm check`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `pnpm test:settings-pages`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:49273"`, `agent_tools_count:8`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:49273`. Vite printed shutdown-time `write EPIPE` noise after the smoke JSON, but the command exited 0.

Completion:

- Settings page functional parity: **92% -> 93%**

## Earlier Batch

### Batch 169: Plugin Manifest Tools Whitelist Exposure

Completed:

- Added plugin manifest tool discovery from enabled installed plugins.
- Normalized plugin tool names to `plugin_<plugin_id>_<tool_name>` and persisted them into the Agent tool whitelist with `source:"plugin"` and `plugin_id`.
- Preserved plugin tool input/output schemas from the manifest and assigned `PluginData` scope.
- Kept plugin tools disabled by default; they only enter the enabled tool registry and MCP `tools/list` after the user explicitly enables them.
- Pruned plugin-sourced Agent tools when the plugin is disabled, uninstalled, or no longer declares the tool.
- Switched Agent/MCP tool management to load the full whitelist, so disabled plugin tools can be seen and toggled.
- Synced plugin Agent tools after plugin install/import, enable/disable, uninstall, and builtin plugin loading.

Boundary:

- This batch exposes plugin tools to the Agent/MCP whitelist and enabled registry only. Actual plugin tool execution is still not implemented; enabled plugin tools currently stop at the existing controlled executor error path until the plugin bridge call path is added.

Verification:

- Red/green: `cargo test -p atools --test agent_tools_tests plugin_tool` first failed because `sync_plugin_tools` did not exist, then passed after implementation.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo fmt --check`
- `pnpm test:mcp-audit-settings`
- `pnpm check`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:62485"`, `agent_tools_count:8`, `enabled_agent_tools:["ask_ai_model","compress_images","find_local_files","get_current_context","ocr_image","open_or_reveal_path","rename_files","search_clipboard"]`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:62485`.

Completion:

- Agent/MCP local foundation: **95% -> 96%**

## Earlier Batch

### Batch 168: Saved Audit Filter Views

Completed:

- Added `src/lib/auditFilterViews.ts` for localStorage-backed saved audit filter views.
- Covered normalization, generated labels, upsert-by-label behavior, removal, and storage round-trip in `scripts/test-audit-filter-views.mjs`.
- Added Agent/MCP audit filter view controls:
  - `已保存视图` selector
  - `名称` input
  - `保存视图`
  - `应用`
  - `删除`
- Kept audit filters and saved-view controls visible even when the current audit list is empty.
- Preserved saved tool/client filter values in select controls even if the current loaded audit page does not include that tool/client.

Verification:

- Red/green: `pnpm test:audit-filter-views` first failed because `src/lib/auditFilterViews.ts` did not exist, then passed after adding the helper and UI wiring.
- Red/green: the rendered Web preview initially showed that saved-view controls were hidden when `audits.length === 0`; after adding a source regression assertion and moving the filters outside the non-empty branch, the test passed.
- `pnpm test:audit-filter-views`
- `pnpm test:mcp-audit-settings`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo fmt --check`
- `pnpm smoke:tauri-desktop`
- Rendered fallback validation: Browser plugin route was unavailable (`No Codex browser route is available`), so Playwright opened `http://localhost:1420/`, clicked `Agent / MCP`, verified `审计回放`, `已保存视图`, and `保存视图` are visible with no console error/warn, saved `Denied opens`, and confirmed `localStorage["atools:audit-filter-views"]` was written.
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:57668"`, `agent_tools_count:8`, `data_debug_smoke.audit_filtered_export_checked:true`, `data_debug_smoke.audit_filtered_export_count_checked:true`, `permission_smoke.scope_deny_audit_recorded:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57668`.

Completion:

- Agent/MCP local foundation: **94% -> 95%**

### Batch 167: Audit Query Pagination and Indexes

Completed:

- Added `AuditLogPage` and `AuditLogQuery.offset` so backend audit queries can return `entries`, `total`, `limit`, and `offset`.
- Kept the old `query_audit_entries` list API compatible by delegating it through the paged query.
- Added SQLite audit filter indexes for status, tool, and client lookup ordered by timestamp.
- Added the Tauri command `query_audit_entries_page` and TypeScript `AuditLogPage` type.
- Updated Agent/MCP audit loading to use the paged command, show `已加载 x / y 条`, reload the first page when filters change, and append more rows through `加载更多`.
- Styled the load-more action to match the existing compact Agent panel controls.

Verification:

- Red/green: `cargo test -p atools-core --test agent_tests audit_entries_query_page_returns_total_and_offset_window` first failed because `AuditLogPage`, `AuditLogQuery.offset`, and `query_audit_entries_page` did not exist, then passed after implementation.
- Red/green: `cargo test -p atools-core --lib audit_log_filter_indexes_exist` first failed because the audit filter indexes did not exist, then passed after adding them.
- Red/green: `pnpm test:mcp-audit-settings` first failed because AgentPanel still used the non-paged audit command, then passed after wiring the paged command and load-more UI.
- `pnpm test:mcp-audit-settings`
- `cargo test -p atools-core --test agent_tests audit_entries_query_page_returns_total_and_offset_window`
- `cargo test -p atools-core --lib audit_log_filter_indexes_exist`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-core --lib`
- `cargo test -p atools --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `mcp_bind:"127.0.0.1:52280"`, `agent_tools_count:8`, `data_debug_smoke.audit_filtered_export_checked:true`, `data_debug_smoke.audit_filtered_export_count_checked:true`, `permission_smoke.scope_deny_audit_recorded:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:52280`.

Completion:

- Agent/MCP local foundation: **93% -> 94%**

## Previous Batch

### Batch 166: MCP Client Default Target Paths

Completed:

- Added `mcpClientSuggestedTargetPath()` and `suggestedTargetPath` install-plan metadata.
- Suggested known macOS paths for Claude Desktop and Cursor:
  - Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
  - Cursor global MCP config: `~/.cursor/mcp.json`
- Wired Agent/MCP and Settings -> MCP 服务 install buttons so the file picker starts from the suggested path when the home directory is available.
- Displayed the suggested target path in each MCP template install plan.
- Fixed a real desktop smoke flaky: the raw MCP HTTP reader now tolerates a bounded transient `WouldBlock` before the first response payload, while still failing incomplete responses.

Verification:

- Red/green: `pnpm test:mcp-client-config` first failed because `mcpClientSuggestedTargetPath` did not exist, then passed after adding target-path suggestions.
- Red/green: `cargo test -p atools --lib mcp_http_smoke_reader` first failed because `read_mcp_http_response_with_would_block_retries` did not exist, then passed after adding bounded retry behavior.
- `pnpm test:mcp-client-config`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo fmt --check`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_resources_ok:true`, `data_debug_smoke.mcp_prompts_ok:true`, `data_debug_smoke.mcp_batch_ok:true`, `data_debug_smoke.mcp_notification_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:61984`.

Completion:

- Agent/MCP local foundation: **92% -> 93%**

## Previous Batch

### Batch 165: MCP Client Config Safe Merge/Install

Completed:

- Added the `install_mcp_client_config` Tauri command for confirmed MCP client config writes.
- Added safe JSON merge behavior: preserve top-level fields and other `mcpServers`, replace or add only `mcpServers.atools`.
- Added existing-file backups with adjacent `*.atools-backup-*` names before changed writes.
- Exposed frontend merge/install model helpers and updated install plans from `暂不自动写入` to `可安全合并`.
- Added `合并到文件...` actions in Agent/MCP and Settings -> MCP 服务, while keeping copy actions.
- Updated MCP client setup docs and macOS smoke checklist for the safe merge flow.

Verification:

- Red/green: `pnpm test:mcp-client-config` first failed with `mergeMcpClientConfig is not a function`, then passed after adding the frontend merge helper and new install plan state.
- Red/green: `cargo test -p atools --lib mcp_client_config` first failed on missing merge/write helpers, then passed after adding the Rust merge/write implementation.
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm test:mcp-client-config`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_resources_ok:true`, `data_debug_smoke.mcp_prompts_ok:true`, `data_debug_smoke.mcp_batch_ok:true`, `data_debug_smoke.mcp_notification_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:58582`.

Completion:

- Agent/MCP local foundation: **91% -> 92%**

## Previous Batch

### Batch 164: MCP Built-in Resource Catalog

Source: [MCP resources specification](https://modelcontextprotocol.io/specification/2025-06-18/server/resources).

Completed:

- Added a built-in MCP resource, `atools://agent/tools`, exposed through `resources/list` as `agent_tools` with `application/json` MIME type.
- Implemented `resources/read` in the shared static MCP handler so clients can retrieve a JSON snapshot of current enabled Agent tools, including schemas.
- Returned MCP resource-not-found errors as JSON-RPC `-32002` with the requested URI in error data.
- Aligned stdio fallback so `resources/read` works from the local static registry when the desktop app is not running.
- Extended real desktop smoke with `data_debug_smoke.mcp_resources_ok`, covering both HTTP `resources/list` and `resources/read`.

Verification:

- Red/green: `cargo test -p atools-core --test agent_tests mcp_static_handler_exposes_builtin_agent_tools_resource_and_read` first failed because `resources/list` returned no resource URI, then passed after adding the resource catalog and `resources/read`.
- Red/green: `cargo test -p atools --lib local_stdio_fallback_handles_builtin_resource_read` first failed because fallback routed `resources/read` away from the static handler, then passed after adding it to the fallback whitelist.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_initialized_notification_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `data_debug_smoke.mcp_resources_ok:true`, `data_debug_smoke.mcp_prompts_ok:true`, `data_debug_smoke.mcp_batch_ok:true`, `data_debug_smoke.mcp_notification_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:52584`.
- Rendered UI validation was not rerun for this batch because the change is backend MCP protocol behavior and smoke parser coverage only; no Svelte UI rendering changed.

## Previous Batch

### Batch 163: MCP Built-in Prompt Catalog

Source: [MCP prompts specification](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts).

Completed:

- Added a built-in MCP prompt catalog entry, `atools_agent_tool_guide`, with optional `task` argument metadata.
- Implemented `prompts/get` in the shared static MCP handler so clients can retrieve tool-selection guidance tailored to the current task.
- Aligned stdio fallback with the prompt catalog so `prompts/list` and `prompts/get` work when the desktop app is not running.
- Extended real desktop smoke with `data_debug_smoke.mcp_prompts_ok`, covering both HTTP `prompts/list` and `prompts/get`.
- Hardened the desktop smoke raw HTTP reader to stop after the declared `Content-Length`, avoiding flaky MCP smoke failures when the socket has not reached EOF yet.

Verification:

- Red/green: `cargo test -p atools-core --test agent_tests mcp_static_handler_exposes_builtin_prompt_catalog_and_get` first failed because `prompts/list` was empty, then passed after adding the prompt catalog and `prompts/get`.
- Red/green: `cargo test -p atools --lib local_stdio_fallback_handles_builtin_prompt_get` first failed because fallback routed `prompts/get` to the desktop-not-running error, then passed after adding it to the local static fallback.
- Red/green: `pnpm test:tauri-desktop-smoke-script` first failed with missing `data_debug_smoke.mcp_prompts_ok`, then passed after extending the parser fixture and Rust desktop smoke output.
- Red/green: `cargo test -p atools --lib mcp_http_smoke_reader` first failed because the Content-Length-based smoke reader did not exist, then passed after adding it.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_initialized_notification_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `data_debug_smoke.mcp_prompts_ok:true`, `data_debug_smoke.mcp_batch_ok:true`, `data_debug_smoke.mcp_notification_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:64617`.
- Rendered UI validation was not rerun for this batch because the change is backend MCP protocol behavior and smoke parser coverage only; no Svelte UI rendering changed.

## Previous Batch

### Batch 162: MCP Id-less Notification Semantics

Source: [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification) notification semantics.

Completed:

- Updated the shared static MCP handler so any single JSON-RPC message without an `id` is treated as a notification and produces no response.
- Prevented id-less `tools/call` messages from invoking tool handlers, avoiding silent tool execution when no client response can be returned.
- Aligned stdio fallback with the same notification behavior: id-less `ping`, discovery, or `tools/call` messages write no stdout response line.
- Aligned HTTP `/mcp` with the same behavior: id-less messages return `204 No Content`, including id-less `tools/call`.
- Extended desktop smoke with `data_debug_smoke.mcp_notification_ok`, backed by a real HTTP request to the running MCP server.

Verification:

- Red/green: `cargo test -p atools-core --test agent_tests mcp_static_handler_treats_idless_requests_as_notifications` first failed because id-less `ping` returned a JSON-RPC response, then passed after adding generic notification handling.
- Red/green: `cargo test -p atools --lib local_stdio_fallback_skips_idless_notifications` first failed because stdio fallback returned a response for id-less `ping`, then passed after the shared/fallback fix.
- Red/green: `pnpm test:tauri-desktop-smoke-script` first failed with missing `data_debug_smoke.mcp_notification_ok`, then passed after extending the parser fixture and Rust desktop smoke output.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_initialized_notification_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `data_debug_smoke.mcp_batch_ok:true`, `data_debug_smoke.mcp_notification_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:59721`.
- Rendered UI validation was not rerun for this batch because the change is backend MCP protocol behavior and smoke parser coverage only; no Svelte UI rendering changed.

## Previous Batch

### Batch 161: MCP JSON-RPC Batch Support

Source: JSON-RPC batch request semantics and the existing ATools MCP HTTP/stdio handlers.

Completed:

- Added JSON-RPC batch handling to the shared static MCP handler: non-empty arrays are processed item-by-item, notification-only batches return no response, and empty batches return `-32600 Invalid Request`.
- Added stdio fallback batch support so local `--mcp-stdio` can answer batched `initialize` / `ping` / discovery requests even when the desktop server is not running.
- Added HTTP `/mcp` batch support, including real per-item handling for `tools/call` and omission of `notifications/initialized` responses inside mixed batches.
- Extended desktop smoke with `data_debug_smoke.mcp_batch_ok`, backed by a real TCP request to the running local MCP server.
- Updated the smoke parser fixture so CI fails if future desktop smoke output drops the batch check.

Verification:

- Red/green: `cargo test -p atools-core --test agent_tests mcp_static_handler_handles_json_rpc_batches` first failed because array payloads returned no response, then passed after adding static batch dispatch.
- Red/green: `cargo test -p atools --lib local_stdio_fallback_handles_json_rpc_batches` first failed because stdio fallback returned `None` for batch payloads, then passed after adding fallback batch dispatch.
- Red/green: `pnpm test:tauri-desktop-smoke-script` first failed with missing `data_debug_smoke.mcp_batch_ok`, then passed after extending the parser fixture and Rust desktop smoke output.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_initialized_notification_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `data_debug_smoke.mcp_batch_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57269`.
- Rendered UI validation was not rerun for this batch because the change is backend MCP protocol behavior and smoke parser coverage only; no Svelte UI rendering changed.

## Previous Batch

### Batch 160: find_local_files Ignore Patterns

Source: existing built-in Agent `find_local_files` behavior and MCP tool schema.

Completed:

- Added `ignore_patterns` to `FindLocalFilesOptions` and the built-in Agent `find_local_files` tool input.
- Supported simple wildcard matching with `*` and `?` against both file names and root-relative slash paths.
- Added directory-subtree skipping for patterns such as `generated/**`, so ignored generated/cache folders are not searched recursively.
- Kept existing `ignore_dirs`, `max_depth`, `limit`, and permission-denied skip counting behavior unchanged.
- Exposed `ignore_patterns` in the MCP input schema so clients can discover and pass the new ignore rules.

Verification:

- Red/green: `cargo test -p atools --test agent_tools_tests find_local_files_respects_ignore_patterns_for_files_and_paths` first failed to compile because `FindLocalFilesOptions` had no `ignore_patterns` field, then passed after adding the option, matching, tool parsing, and schema exposure.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, enabled tools include `find_local_files`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `plugin_runtime_smoke.feature_activated:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:53841`. Vite printed shutdown-time `The service was stopped` noise after the smoke JSON, but the command exited 0.
- Rendered UI validation was not rerun for this batch because the change is backend Agent tool behavior and MCP schema only; no Svelte UI rendering changed.

## Previous Batch

### Batch 159: Agent Finder Context Bridge

Source: existing command-layer `read_current_folder_path` bridge and macOS desktop smoke coverage.

Completed:

- Updated the built-in Agent `get_current_context` tool so `finder_path` reuses `crate::commands::read_current_folder_path()` instead of maintaining a separate Agent-only Finder AppleScript.
- Aligned Agent Finder context with the plugin/command bridge behavior: a Finder window returns its target path, no Finder window falls back to the Desktop path through the command-layer bridge, and bridge errors return an explicit `Unable to read the current Finder path: ...` reason.
- Added a macOS unit regression that compares Agent `read_finder_path()` against the command-layer folder bridge output, catching the previous divergence where Agent returned `null` while the command bridge returned `/Users/harris/Desktop/`.
- Kept `browser_url`, foreground app, and existing context field shapes unchanged.
- Updated current Agent/MCP docs and smoke notes with the shared Finder-context boundary.

Verification:

- Red/green: `cargo test -p atools --lib finder_context_matches_command_layer_folder_bridge -- --nocapture` failed first with `left: Null` and `right: String("/Users/harris/Desktop/")`, then passed after wiring Agent Finder context to the command-layer bridge.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, enabled tools include `get_current_context`, `plugin_runtime_smoke.finder_context_checked:true`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:51474`. Vite/esbuild printed shutdown-time `The service was stopped: write EPIPE` noise after the smoke JSON, but the command exited 0.
- Rendered UI validation was not rerun for this batch because the change is backend Agent tool behavior only; no Svelte UI rendering changed.

## Previous Batch

### Batch 158: Agent Current Browser Context Bridge

Source: existing command-layer `read_current_browser_url` bridge and macOS desktop smoke coverage.

Completed:

- Updated the built-in Agent `get_current_context` tool so `browser_url` is no longer a hardcoded not-implemented placeholder.
- Reused `crate::commands::read_current_browser_url()` so Agent tools and the plugin/command context bridge share the same macOS browser URL detection path for supported frontmost browsers.
- Kept the result explicit in all cases: a non-empty URL returns `browser_url`, an unavailable browser returns `browser_url:null` with `No current browser URL is available from the frontmost supported browser.`, and bridge errors return `Unable to read the current browser URL: ...`.
- Preserved the existing foreground-app and Finder-path empty-field explanations while tightening the regression so the browser reason cannot regress to `not implemented`.
- Updated current Agent/MCP documentation and smoke notes with the browser-context boundary.

Verification:

- Red/green: `cargo test -p atools --test agent_tools_tests get_current_context_explains_empty_browser_foreground_and_finder_fields` failed first because `browser_url_reason` still contained `not implemented`, then passed after wiring the command-layer browser URL bridge.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools --lib commands::settings_command_tests::apple_scripts_cover_browser_and_finder_context`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, enabled tools include `get_current_context`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `plugin_runtime_smoke.feature_activated:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:49498`. Vite/esbuild printed shutdown-time `The service was stopped: write EPIPE` noise after the smoke JSON, but the command exited 0.
- Rendered UI validation was not rerun for this batch because the change is backend Agent tool behavior only; no Svelte UI rendering changed.

## Previous Batch

### Batch 157: compress_images WebP Output

Source: [`image` crate WebPEncoder 0.25.10 docs](https://docs.rs/image/0.25.10/image/codecs/webp/struct.WebPEncoder.html).

Completed:

- Added `format: "webp"` support to the built-in Agent `compress_images` tool while keeping the default `format: "original"` behavior unchanged.
- Added lossless WebP encoding through `image::codecs::webp::WebPEncoder::new_lossless`, producing `compressed-<stem>.webp` outputs and returning `format:"webp"` in each result item.
- Preserved existing `max_bytes` reporting semantics for WebP outputs: target size, target-met boolean, target reason, output size, and compression ratio are still returned; lossless WebP does not fake lossy quality tuning.
- Exposed the new `format` enum in the MCP tool input schema so clients can discover and pass `original` or `webp`.
- Updated current docs to remove the stale “WebP output not implemented” limitation and record the lossless WebP boundary.

Verification:

- Red/green: `cargo test -p atools --test agent_tools_tests compress_images_writes_webp_output_when_requested` failed first because `format` was absent and the output path stayed PNG, then passed after adding the WebP encoder path.
- Red/green: `cargo test -p atools --test agent_tools_tests builtin_registry_contains_agent_whitelist` failed first because the `compress_images` schema had no `format` enum, then passed after updating the tool schema.
- `cargo test -p atools --test agent_tools_tests`
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `agent_tools_count:8`, enabled tools include `compress_images`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `plugin_runtime_smoke.feature_activated:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:61713`.
- Rendered UI validation was not rerun for this batch because the change is backend Agent tool behavior and MCP schema only; no Svelte UI rendering changed.

## Previous Batch

### Batch 156: MCP Resources/Prompts Discovery Bridge

Source: [MCP resources spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/resources) and [MCP prompts spec 2025-06-18](https://modelcontextprotocol.io/specification/2025-06-18/server/prompts).

Completed:

- Added static MCP handler coverage for the first MCP discovery list bridge and no pagination cursor.
- Updated `initialize` capabilities to declare empty `resources` and `prompts` capability objects alongside the existing `tools` capability.
- Extended the local stdio fallback so these discovery list methods work even when the desktop app is not running, while `tools/call` still returns the explicit desktop-not-running error.
- Extended real desktop smoke with `data_debug_smoke.mcp_discovery_lists_ok`, backed by actual HTTP MCP requests against the running desktop server.
- Updated MCP client and macOS smoke docs with the initial empty discovery list behavior.

Verification:

- Red/green: `cargo test -p atools-core --test agent_tests mcp_static_handler_exposes_empty_resources_and_prompts_lists` failed first because `resources/list` returned no `resources` array, then passed after adding the discovery list handlers.
- Red/green: `cargo test -p atools --lib local_stdio_fallback_handles_mcp_discovery_lists` failed first because the stdio fallback returned no discovery arrays, then passed after adding the fallback methods.
- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because `data_debug_smoke.mcp_discovery_lists_ok` was not required by the smoke parser, then passed after extending the parser and fixtures.
- `cargo test -p atools-core --test agent_tests`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_initialized_notification_ok:true`, `data_debug_smoke.mcp_discovery_lists_ok:true`, `plugin_runtime_smoke.feature_activated:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:57911`. Vite printed shutdown-time `The service was stopped` messages after the smoke JSON, but the command exited 0.
- Rendered UI validation was not rerun for this batch because the change is MCP/backend smoke-only and does not alter rendered Svelte UI.

## Previous Batch

### Batch 155: Plugin Event Callback Bridge

Source: [uTools event API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/events.html).

Completed:

- Added a focused VM regression for the official plugin event surface: `utools.onMainPush(callback, onSelect)`, `utools.onPluginDetach(callback)`, richer `utools.onPluginEnter(action)`, and `utools.onPluginOut(isKill)`.
- Updated the injected PluginPanel bridge so host `__ipc_main_push__` messages call the plugin callback and return `MainPushResult[]`, while `__ipc_main_push_select__` dispatches the official selection callback.
- Added `onPluginDetach` and official `onPluginOut(isKill)` forwarding in the WebView event bridge, and included the active payload in `onPluginEnter`.
- Synced the Rust plugin shim `onMainPush` signature with the official two-callback API and added a shared `事件` capability group to the runtime bridge inventory.

Verification:

- Red/green: `pnpm test:plugin-events-bridge` failed first because `utools.onMainPush` was undefined in the injected PluginPanel bridge, then passed after adding the event callbacks and host message dispatch.
- `pnpm test:plugin-events-bridge`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-dynamic-features`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `data_debug_smoke.mcp_initialized_notification_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.data_bridge_checked:true`, `plugin_runtime_smoke.bulk_docs_checked:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:51720`.
- Browser rendered bridge check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host in the in-app Browser at 1280x720, title `ATools 3.0`, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 事件 / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the previous no-events detail, showed 2 output rows, allowed `ArrowDown` from SubInput to select `当前时间戳毫秒`, reported 0 severe console errors, had no framework overlay or horizontal overflow, and captured `/tmp/atools-batch155-desktop.png`.
- Browser mobile viewport check: the in-app Browser viewport override reached 390x800, showed the same event bridge detail and 2 output rows, reported 0 severe console errors, no framework overlay, and no horizontal overflow; screenshot capture at that overridden viewport timed out with `Timed out running CDP command "Page.captureScreenshot" for tab 9`, so the mobile evidence is DOM/console/overflow only for this batch.

## Previous Batch

### Batch 154: Plugin DB allDocs Filter Bridge

Source: [uTools local DB API docs](https://www.u-tools.cn/docs/developer/api-reference/db/local-db.html).

Completed:

- Added a focused VM regression for the official `utools.db.allDocs([idStartsWith])` and `utools.db.allDocs(ids)` filtering semantics.
- Updated the injected PluginPanel DB bridge so `allDocs(prefix)` filters by document ID prefix and `allDocs(ids)` returns existing documents in the requested ID order while still using the plugin-scoped data bridge.
- Kept `utools.db.promises.allDocs` aligned with the same filtering behavior through the existing `db.promises` alias.
- Synced the API shim `db.allDocs` handler with the same prefix and ID-list semantics so secondary plugin contexts no longer return all docs when a filter argument is supplied.

Verification:

- Red/green: `pnpm test:plugin-db-all-docs-filter` failed first because `allDocs("user/")` returned `settings` and attachment metadata too, then passed after adding PluginPanel-side filtering.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_db_all_docs` failed first because the API shim ignored the `user/` prefix, then passed after handler filtering.
- `pnpm test:plugin-db-all-docs-filter`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.data_bridge_checked:true`, `plugin_runtime_smoke.bulk_docs_checked:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:63217`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`), reported 0 severe console errors, had no framework overlay or horizontal overflow, and captured screenshots at `/tmp/atools-batch154-desktop.png` and `/tmp/atools-batch154-mobile.png`.

## Previous Batch

### Batch 153: Plugin Dynamic Settings Redirect Bridge

Source: [uTools dynamic feature API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/features.html).

Completed:

- Added a focused VM regression test for the official `utools.redirectHotKeySetting(cmdLabel[, autocopy])` and `utools.redirectAiModelsSetting()` dynamic feature settings redirect surface.
- Exposed both APIs in the injected PluginPanel bridge and routed them through the native bridge so plugins receive a real host navigation result instead of missing methods.
- Added App host routing that exits plugin mode and opens the local `快捷键` or `AI 模型` settings page; `autocopy` performs a best-effort command-label clipboard copy before opening shortcuts.
- Synced the shared bridge capability inventory plus Rust plugin shim/API shim, with API shim classifying settings redirects as native-only when no host UI is available.

Verification:

- Red/green: `pnpm test:plugin-dynamic-settings-bridge` failed first because `utools.redirectHotKeySetting` was undefined, then passed after adding the bridge and App settings routing.
- Red/green: `pnpm test:plugin-bridge-capabilities` failed first because `窗口` did not include the two settings redirect methods, then passed after updating the shared inventory.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_dynamic_settings_redirect_api_surface` failed first because the Rust shim lacked both methods, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first because `settings.redirectHotKey` was unknown, then passed after classifying settings redirects as native-only.
- `pnpm test:plugin-dynamic-settings-bridge`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-redirect-bridge`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-system-shell-bridge`
- `pnpm test:plugin-keyboard-guard`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo test -p atools --lib`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke: one initial run reported `status:"degraded"` only because `data_debug_smoke.mcp_ping_ok:false` hit `Resource temporarily unavailable (os error 35)`; an immediate rerun passed with `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:59794`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`), reported 0 severe console errors, had no framework overlay or horizontal overflow, and captured screenshots at `/tmp/atools-batch153-desktop.png` and `/tmp/atools-batch153-mobile.png`.

## Earlier Batches

### Batch 152: Plugin System Shell Bridge

Source: [uTools system API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/system.html).

Completed:

- Added a focused VM regression test for the official `utools.getFileIcon(filePath)`, `utools.shellTrashItem(path)`, `utools.shellBeep()`, and platform probe surface (`isMacOS` / `isWindows` / `isLinux`).
- Exposed a stable PluginPanel file-icon data URL fallback and shell native routing; `shellTrashItem` originally returned an explicit unsupported error, and Batch 190 later upgraded the main WebView host path to Finder move-to-Trash routing, while `shellBeep` routes to native beep.
- Synced the Rust plugin shim and API shim with platform boolean functions, `system.getFileIcon` SVG fallback, and native-only classification for shell trash/beep calls.
- Updated the shared bridge capability inventory so the rendered runtime strip continues to advertise the official `系统` group from a single source of truth.

Verification:

- Red/green: `pnpm test:plugin-system-shell-bridge` failed first because `utools.getFileIcon` was undefined, then passed after adding the injected bridge and host shell cases.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_system_shell_api_surface` failed first because the Rust shim lacked `getFileIcon`, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_system_methods_return_expected` failed first on unsupported `system.isWindows`, then passed after adding platform booleans and `system.getFileIcon`.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first on unknown `shell.trashItem`, then passed after classifying shell trash/beep as native-only.
- `pnpm test:plugin-system-shell-bridge`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-redirect-bridge`
- `pnpm test:plugin-window-theme-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-keyboard-guard`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:56115`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`), kept SubInput visible with value `time`, reported 0 severe console errors, had no framework overlay or horizontal overflow, and captured screenshots at `/tmp/atools-batch152-desktop.png` and `/tmp/atools-batch152-mobile.png`.

## Earlier Batches

### Batch 151: Plugin Window Browser Bridge

Source: [uTools window API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html).

Completed:

- Added a focused VM regression test for the official `utools.createBrowserWindow(url[, options][, callback])` and `utools.sendToParent(channel[, ...args])` browser-window API surface.
- Exposed both methods in the injected PluginPanel bridge and routed calls through the native bridge with normalized arguments, including callback presence and variadic parent-message args.
- Added method-scoped host errors for the current WebView host so plugins receive explicit detached-window/native-only unsupported failures instead of missing APIs or fake window handles.
- Added `createBrowserWindow` and `sendToParent` to the shared `窗口` bridge capability inventory.
- Synced the Rust plugin shim and API shim so secondary plugin contexts expose the same method names and classify them as native-only when no native browser-window host is available.

Verification:

- Red/green: `pnpm test:plugin-window-browser-bridge` failed first because `utools.createBrowserWindow` was undefined, then passed after adding the injected bridge and host unsupported cases.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_window_browser_api_surface` failed first because the Rust shim lacked both browser-window APIs, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first because `window.createBrowserWindow` was an unknown IPC method, then passed after classifying browser-window methods as native-only.
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-window-redirect-bridge`
- `pnpm test:plugin-window-theme-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:51294`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`), kept SubInput visible with value `time`, reported 0 console errors / warnings, had no framework overlay or horizontal overflow, and captured screenshots at `/tmp/atools-batch151-desktop.png` and `/tmp/atools-batch151-mobile.png`.

## Earlier Batches

### Batch 150: Plugin Window Redirect Bridge

Source: [uTools window API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html).

Completed:

- Added a focused regression for the official `utools.redirect(label[, payload])` API, covering string labels, `[plugin, command]` labels, payload forwarding, invalid labels, ambiguous matches, not-found results, and missing-host errors.
- Added shared redirect selection helpers so host routing normalizes labels and only activates a unique plugin feature match instead of guessing.
- Exposed `redirect` in the injected PluginPanel bridge and wired it to `App.svelte` host search via `search_features`, followed by `activateFeature(code, payload)`.
- Added `redirect` to the shared `窗口` bridge capability inventory so the runtime bridge detail remains backed by the official window API surface.
- Changed the API shim `app.redirect` path to explicit native-only unsupported behavior, avoiding a misleading `null` fake success where the shim cannot search and activate host features.

Verification:

- Red/green: `pnpm test:plugin-window-redirect-bridge` failed first because `src/lib/pluginRedirect.ts` did not exist, then passed after adding the normalization/selection helper and host bridge checks.
- Red/green: `pnpm test:plugin-bridge-capabilities` failed first because `窗口` did not list `redirect`, then passed after updating the shared capability inventory.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first because `app.redirect` returned `Ok(Null)`, then passed after classifying it as native-only.
- Regression fix: `cargo test -p atools-api-shim --test handler_tests` then caught the stale delegated-null assertion for `app.redirect`; removing that old expectation made all 19 handler tests pass.
- `pnpm test:plugin-window-redirect-bridge`
- `pnpm test:plugin-window-theme-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-user-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-copied-files-shape`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:63558`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`), kept SubInput visible with value `time`, reported 0 console errors / warnings, had no framework overlay or horizontal overflow, and captured screenshots at `/tmp/atools-batch150-desktop.png` and `/tmp/atools-batch150-mobile.png`.

## Earlier Batches

### Batch 149: Plugin Window Theme Bridge

Source: [uTools window API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html).

Completed:

- Added a focused VM regression test for the official `utools.isDarkColors()` window theme probe, covering dark mode, light mode, and missing `matchMedia` fallback.
- Moved injected theme detection behind a safe `_isDarkColors()` helper so plugins always receive a boolean instead of a thrown `matchMedia` error.
- Added `isDarkColors` to the shared `窗口` bridge capability inventory so the runtime bridge detail continues to reflect the official window API surface.
- Synced the Rust plugin shim and API shim with `window.isDarkColors`; the local-only API shim returns a stable light-theme boolean fallback where no WebView media query exists.

Verification:

- Red/green: `pnpm test:plugin-window-theme-bridge` failed first because missing `matchMedia` threw `TypeError: window.matchMedia is not a function`, then passed after adding `_isDarkColors()`.
- Red/green: `pnpm test:plugin-bridge-capabilities` failed first because the shared `窗口` group did not list `isDarkColors`, then passed after updating the inventory.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_window_theme_api_surface` failed first because the Rust shim lacked `isDarkColors`, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_window_theme_probe_returns_boolean` failed first because `window.isDarkColors` was an unsupported IPC method, then passed after adding the local-only boolean fallback.
- `pnpm test:plugin-window-theme-bridge`
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-user-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-copied-files-shape`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:59037`. Vite printed shutdown-time `The service was stopped` messages after the smoke JSON, but the command exited 0.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, and showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`). SubInput focused to the `time` input successfully, console checks reported 0 errors / 0 warnings, there was no framework overlay or horizontal overflow, and screenshots were captured at `/tmp/atools-batch149-desktop.png` and `/tmp/atools-batch149-mobile.png`.

## Earlier Batches

### Batch 148: Plugin Window Drag Bridge

Source: [uTools window API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html).

Completed:

- Added a focused VM regression test for the official `utools.startDrag(filePath)` window surface, covering both string and string-array file path arguments.
- Exposed `startDrag(filePath)` in the injected `PluginPanel` bridge and routed calls through the native bridge instead of leaving the method undefined.
- Returned a method-scoped native-only unsupported error from the current WebView host, avoiding fake drag success until real native file dragging is implemented.
- Added `startDrag` to the shared `窗口` bridge capability inventory so the runtime bridge detail remains backed by the common uTools/ZTools API list.
- Synced the Rust plugin shim and API shim so secondary plugin contexts expose `window.startDrag` and classify it as native-only when no native handler is present.

Verification:

- Red/green: `pnpm exec node scripts/test-plugin-window-drag-bridge.mjs` failed first because `utools.startDrag` was not exposed, then passed after adding the bridge.
- Red/green: `pnpm test:plugin-bridge-capabilities` failed first because the shared `窗口` group did not list `startDrag`, then passed after updating the inventory.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_window_drag_api_surface` failed first because the Rust shim lacked `startDrag`, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first because `window.startDrag` was an unknown IPC method, then passed after classifying it as native-only.
- `pnpm test:plugin-window-drag-bridge`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-user-bridge`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-copied-files-shape`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, sample selected plugin `calculator` / `calc`, and `Desktop smoke passed: 127.0.0.1:55224`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, did not show the old no-user detail, and showed 2 output rows (`当前时间戳`, `当前时间戳毫秒`). SubInput focused to the `time` input successfully, console checks reported 0 errors / 0 warnings, there was no framework overlay or horizontal overflow, and screenshots were captured at `/tmp/atools-batch148-desktop.png` and `/tmp/atools-batch148-mobile.png`.

### Batch 147: Plugin User API Bridge

Source: [uTools user API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/user.html).

Completed:

- Added a focused VM regression test for the official `utools.getUser()` and `fetchUserServerTemporaryToken()` user surfaces.
- Exposed `getUser()` in the injected `PluginPanel` bridge as a synchronous local-only result returning `null`, matching the official unauthenticated shape without inventing fake account data.
- Exposed `fetchUserServerTemporaryToken()` with a method-scoped native-only unsupported error so plugins fail explicitly instead of seeing a missing API or fake token.
- Added a shared `用户` bridge capability group and updated the runtime bridge detail to `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`.
- Synced the Rust plugin shim and API shim with the same local-only user semantics: `user.get` returns `null`, while `user.fetchServerTemporaryToken` requires native host support.

Verification:

- Red/green: `pnpm exec node scripts/test-plugin-user-bridge.mjs` failed first because `utools.getUser` was not exposed, then passed after adding the user bridge.
- Red/green: `pnpm test:plugin-bridge-capabilities` failed first because the shared capability inventory did not include `用户`, then passed after adding the group.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_user_api_surface` failed first because the Rust shim lacked the user API surface, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_user_methods_return_local_only_results` failed first because `user.get` was still an unsupported IPC method, then passed after mapping user methods.
- `pnpm test:plugin-user-bridge`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-copied-files-shape`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Desktop smoke note: the first real smoke run degraded only in `data_debug_smoke.mcp_ping_ok` with `Resource temporarily unavailable (os error 35)` while plugin runtime checks were all true; after confirming no residual Vite/Tauri/smoke listeners remained, an immediate rerun passed.
- Real desktop smoke output from the passing rerun: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:51739`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 用户 / 上下文`, and 2 output rows (`当前时间戳`, `当前时间戳毫秒`). SubInput focused to the `time` input successfully, console checks reported 0 errors / 0 warnings, there was no framework overlay or horizontal overflow, and screenshots were captured at `/tmp/atools-batch147-desktop.png` and `/tmp/atools-batch147-mobile.png`.

### Batch 146: Plugin Copied Files Shape Bridge

Source: [uTools copy API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/copy.html).

Completed:

- Added a focused VM regression test for `utools.getCopyedFiles()` and the corrected `getCopiedFiles()` alias, covering native path-list results and native results that already contain object fields.
- Normalized plugin-facing copied-file results to the official `CopiedFile[]` shape with `path`, `name`, `isFile`, and the documented `isDiractory` field.
- Kept both aliases routed through the uTools `getCopyedFiles` native bridge method while preserving extra object fields returned by a future native host.
- Updated the WebView host `getCopyedFiles` path-only AppleScript result to return CopiedFile-shaped entries to injected plugins.
- Synced the Rust plugin shim so secondary plugin contexts expose the same normalized copied-file API surface and `getCopiedFiles` alias.

Verification:

- Red/green: `pnpm exec node scripts/test-plugin-copied-files-shape.mjs` failed first because `getCopyedFiles()` returned raw strings (`/tmp/example.txt`, `/tmp/folder/`), then passed after adding copied-file normalization.
- Red/green: `cargo test -p atools-plugin --lib shim_normalizes_copied_file_api_surface` failed first because the Rust shim lacked `normalizeCopiedFiles` and `getCopiedFiles`, then passed after syncing the shim.
- `pnpm test:plugin-copied-files-shape`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-input-bridge`
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 上下文`, and 2 output rows (`当前时间戳`, `当前时间戳毫秒`). SubInput focused successfully, console checks reported 0 errors / 0 warnings, there was no framework overlay or horizontal overflow, and screenshots were captured at `/tmp/atools-batch146-desktop.png` and `/tmp/atools-batch146-mobile.png`.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.copied_files_read_checked:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:61514`.

## Previous Batch

### Batch 145: Plugin External Input Bridge

Source: [uTools input API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/input.html).

Completed:

- Added a focused VM regression test for the official `utools.hideMainWindowPasteText(text)`, `hideMainWindowPasteImage(image)`, `hideMainWindowPasteFile(file)`, and `hideMainWindowTypeString(text)` surfaces.
- Exposed the four external input APIs in the injected `PluginPanel` bridge and routed them through the existing native-bridge request/response path.
- Added method-scoped unsupported errors in the WebView host so external paste/type automation does not fail as a missing API and does not silently pretend success.
- Added a shared `输入` bridge capability group and updated the runtime bridge detail to `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 上下文`.
- Synced the Rust plugin shim with `hideMainWindowTypeString` and changed API shim handling for external paste/type methods from delegated `null` to explicit native-only errors.

Verification:

- Red/green: `pnpm exec node scripts/test-plugin-input-bridge.mjs` failed first because `utools.hideMainWindowPasteText` was not exposed, then passed after adding the external input bridge.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_external_input_api_surface` failed first because `hideMainWindowTypeString` was missing from the Rust shim, then passed after adding the method.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first because external paste methods returned `null`, then passed after mapping them to native-only errors.
- `pnpm test:plugin-input-bridge`
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 输入 / 对话框 / 窗口 / 系统 / 上下文`, SubInput value `time`, and 2 output rows (`当前时间戳`, `当前时间戳毫秒`). Console checks reported 0 errors / 0 warnings, with screenshots captured at `/tmp/atools-batch145-desktop.png` and `/tmp/atools-batch145-mobile.png`.
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:56136`.

## Previous Batch

### Batch 144: Plugin Screen Interactive Bridge

Source: [uTools screen API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/screen.html).

Completed:

- Added a focused VM regression test for the official `utools.screenCapture(callback)`, `screenColorPick(callback)`, and `desktopCaptureSources(options)` surfaces.
- Updated `screenCapture(callback)` to call the plugin callback with the native result while preserving the existing promise-compatible return for ATools plugins.
- Routed `screenCapture` through the existing Tauri `screen_capture` command, and changed the command to return `data:image/png;base64,...` after cleaning the temporary screenshot file.
- Added explicit method-scoped unsupported errors for `screenColorPick` and `desktopCaptureSources` in the WebView host, avoiding missing APIs or fake success for interactive/native-only screen features.
- Synced the Rust plugin shim and API shim native-only handler so the secondary uTools bridge exposes the same screen interactive method names.
- Added `screenColorPick` and `desktopCaptureSources` to the shared context bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-screen-interactive` failed first because `utools.screenColorPick` was not exposed, then passed after adding the interactive screen bridge.
- Red/green: `cargo test -p atools --lib screen_capture_file_to_data_url_encodes_png_and_removes_temp_file` failed first because `screen_capture_file_to_data_url` did not exist, then passed after extracting the screenshot Data URL helper.
- Red/green: `cargo test -p atools-plugin --lib shim_exposes_screen_interactive_api_surface` failed first because the Rust shim only exposed the old no-callback `screenCapture`, then passed after syncing the shim.
- Red/green: `cargo test -p atools-api-shim --test handler_tests test_native_bridge_methods_error_when_not_handled_by_native_layer` failed first because `screen.colorPick` was treated as an unknown method, then passed after mapping the new screen methods to native-only errors.
- `pnpm test:plugin-screen-interactive`
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `cargo test -p atools --lib`
- `cargo test -p atools-plugin --lib`
- `cargo test -p atools-api-shim --test handler_tests`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, SubInput value `time`, and 2 output rows (`当前时间戳`, `当前时间戳毫秒`). Console checks reported 0 errors / 0 warnings, with screenshots captured at `/tmp/atools-batch144-desktop.png` and `/tmp/atools-batch144-mobile.png`.
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:52413`.

## Previous Batch

### Batch 143: Plugin Screen Display Bridge

Source: [uTools screen API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/screen.html).

Completed:

- Added a focused VM regression test for the official `utools.getPrimaryDisplay()`, `getAllDisplays()`, `getCursorScreenPoint()`, `getDisplayNearestPoint(point)`, `getDisplayMatching(rect)`, `screenToDipPoint(point)`, `dipToScreenPoint(point)`, `screenToDipRect(rect)`, and `dipToScreenRect(rect)` surfaces.
- Exposed a WebView-compatible display snapshot based on `window.screen`, including `bounds`, `workArea`, `size`, `workAreaSize`, `scaleFactor`, and color-depth fields.
- Added recent cursor tracking from iframe `mousemove` events for `getCursorScreenPoint()`.
- Added DIP/screen point and rect conversion helpers using `window.devicePixelRatio`.
- Added the nine screen/display methods to the shared context bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-screen-display` failed first because `utools.getPrimaryDisplay` was not exposed, then passed after adding the screen display bridge.
- `pnpm test:plugin-screen-display`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, SubInput value `time`, and 2 output rows. Console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:63815`.

## Previous Batch

### Batch 142: Plugin System Identity Bridge

Source: [uTools system API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/system.html).

Completed:

- Added a focused VM regression test for the official `utools.getNativeId()`, `getAppName()`, `getAppVersion()`, `isDev()`, and `isLinux()` surfaces.
- Imported package metadata into `PluginPanel` and injects `productName` / `version` into the plugin bridge so `getAppName()` and `getAppVersion()` follow the current package values.
- Added a stable local `getNativeId()` compatibility value using `localStorage` key `atools:nativeId`, with iframe-memory fallback when storage is unavailable.
- Added `isDev()` as `false` for imported/local plugin hosts and added Linux detection using `navigator.platform` / `navigator.userAgent`.
- Added the five methods to the shared system bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-system-identity` failed first because `utools.getNativeId` was not exposed, then passed after adding the system identity bridge.
- `pnpm test:plugin-system-identity`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, SubInput value `time`, and 2 output rows. Console checks reported 0 errors / 0 warnings, with screenshots captured at `/tmp/atools-batch142-desktop.png` and `/tmp/atools-batch142-mobile.png`.
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:61097`.

## Previous Batch

### Batch 141: Plugin Window Page Search Bridge

Source: [uTools window API docs](https://www.u-tools.cn/docs/developer/api-reference/utools/window.html).

Completed:

- Added a focused VM regression test for the official `utools.getWindowType()`, `utools.findInPage(text, options)`, and `utools.stopFindInPage(action)` surfaces.
- Exposed `getWindowType()` in the injected bridge, returning `main` for the current PluginPanel host mode.
- Exposed `findInPage()` / `stopFindInPage()` as void-return APIs that post explicit host messages instead of silently being absent.
- Added host handling that runs iframe `window.find(...)` when a plugin iframe is active and clears iframe selection for `clearSelection`.
- Added the three methods to the shared window bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-window-page-search` failed first because `utools.getWindowType` was not exposed, then passed after adding the bridge and host page-search path.
- `pnpm test:plugin-window-page-search`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Desktop smoke note: the first run returned `status:"degraded"` only because `data_debug_smoke.mcp_ping_ok:false` hit `Resource temporarily unavailable (os error 35)` while `plugin_runtime_smoke.error:null`; a clean rerun passed with `status:"ok"`.
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed `插件运行态预览`, runtime labels `运行状态` / `SubInput` / `输出结果` / `桥接能力`, bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, SubInput value `time`, and 2 output rows. Posting `__ipc_find_in_page__` / `__ipc_stop_find_in_page__` kept the output-layer preview stable; this Web preview has `iframeCount:0`, so iframe search behavior is covered by the VM/static regression and still needs real plugin iframe regression. Console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.mcp_ping_ok:true`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:57937`.

## Previous Batch

### Batch 140: Plugin SubInput Select Bridge

Completed:

- Added a focused regression test for the official `utools.subInputSelect()` bridge surface.
- Exposed `subInputSelect()` in the injected plugin bridge and made it post an explicit `__ipc_subinput_focus__` / `select` action to the host.
- Updated `PluginPanel` host handling so select requests focus the rendered SubInput and call `select()` on it.
- Added `subInputSelect` to the shared window bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-subinput-select` failed first because `utools.subInputSelect` was not exposed, then passed after adding the bridge and host selection path.
- `pnpm test:plugin-subinput-select`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-dialog-bridge`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, posted the SubInput `select` host action, and verified `input.sub-input` was focused with value `time`, `selectionStart:0`, `selectionEnd:4`, with console checks reporting 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:53687`.

## Previous Batch

### Batch 139: Plugin DB Storage Bridge

Completed:

- Added a focused VM regression test for the official `utools.dbStorage.setItem(key, value)`, `getItem(key)`, and `removeItem(key)` surface.
- Exposed `utools.dbStorage` in the injected plugin bridge as a synchronous key/value API, preserving `setItem` / `removeItem` void-return behavior.
- Stored values under an `atools:dbStorage:<pluginId>:` namespace so different plugin IDs do not collide.
- Values are JSON-wrapped so strings, booleans, numbers, arrays, and objects round-trip without losing type information.
- Added an iframe memory fallback for environments where `localStorage` is unavailable.
- Added the three `dbStorage` methods to the shared DB bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-db-storage` failed first because `utools.dbStorage` was not exposed, then passed after adding the storage bridge.
- `pnpm test:plugin-db-storage`
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-dialog-bridge`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, accepted a host dynamic-feature message and displayed `动态指令` / `1 项`, kept SubInput visible with value `time`, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:50274`.

## Previous Batch

### Batch 138: Plugin DB Attachment Metadata Bridge

Completed:

- Added a focused VM regression test for `utools.db.getAttachmentType(id)` / `utools.db.promises.getAttachmentType(id)` and `utools.db.replicateStateFromCloud()` / `utools.db.promises.replicateStateFromCloud()`.
- Added `_getAttachmentType` to the injected plugin bridge, reading the same stored attachment metadata document used by `getAttachment`.
- `postAttachment` / `putAttachment` now have a matching type lookup path: stored `contentType` is returned, missing attachments return `null`, and missing ids reject with a method-scoped error.
- Added `replicateStateFromCloud()` as an explicit local-only compatibility result returning `null`, matching the official "not enabled" cloud-sync state instead of leaving the method absent.
- Added both methods to the shared DB bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-db-attachment-metadata` failed first because `utools.db.getAttachmentType` was not exposed, then passed after adding the bridge methods.
- `pnpm test:plugin-db-attachment-metadata`
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-dialog-bridge`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, accepted a host dynamic-feature message and displayed `动态指令` / `1 项`, kept SubInput visible with value `time`, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:63821`.

## Previous Batch

### Batch 137: Plugin DB Pull Event Bridge

Completed:

- Added a focused VM regression test for the official `utools.onDbPull(callback)` bridge event.
- Exposed `utools.onDbPull` in the injected plugin bridge and kept the official void-return shape for registration.
- Added `__ipc_db_pull__` message handling inside the iframe bridge so host-supplied database pull payloads are normalized and delivered to registered callbacks.
- Listener failures are isolated and reported with `[onDbPull]` so one plugin callback cannot prevent the remaining callbacks from running.
- Added `onDbPull` to the shared DB bridge capability inventory.

Verification:

- Red/green: `pnpm test:plugin-db-pull-event` failed first because `utools.onDbPull` was not exposed, then passed after adding the event bridge.
- `pnpm test:plugin-db-pull-event`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-dialog-bridge`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the rendered validation used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host on 1280x820 and 390x800 viewports, showed bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`, accepted a host dynamic-feature message and displayed `动态指令` / `1 项`, kept SubInput visible with value `time`, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:59738`.

## Previous Batch

### Batch 136: Plugin Main Window Lifecycle Bridge

Completed:

- Added a focused regression test for `utools.hideMainWindow(isRestorePreWindow)` and `utools.showMainWindow()`.
- Replaced the old close-only `hideMainWindow()` / `Promise.resolve(null)` path with explicit `__ipc_main_window__` lifecycle messages that return boolean compatibility results.
- `PluginPanel` now handles main-window lifecycle messages by calling the existing native `hide_main_window` / `show_main_window` commands in Tauri, while Web preview maps hide to closing the plugin panel for visible validation.
- Added a `窗口` group to the shared plugin bridge capability inventory, covering main-window lifecycle, plugin height, and SubInput APIs.

Verification:

- Red/green: `pnpm test:plugin-window-lifecycle` failed first because `hideMainWindow` still used the old no-argument close path and `showMainWindow` was absent, then passed after adding the lifecycle bridge and host handling.
- Red/green: `pnpm test:plugin-bridge-capabilities` failed first because the shared bridge inventory had no `窗口` group, then passed after adding the group and updating the runtime detail.
- `pnpm test:plugin-window-lifecycle`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-dialog-bridge`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the target interaction used Playwright fallback.
- Playwright rendered bridge check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` showed bridge detail `DB / 剪贴板 / 对话框 / 窗口 / 系统 / 上下文`; posting `__ipc_main_window__` with `show` kept the plugin host visible, and posting `hide` returned Web preview to the Home surface, with console checks reporting 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:55722`.

## Previous Batch

### Batch 135: Plugin SubInput Removal Bridge

Completed:

- Added a focused regression test for `utools.removeSubInput`, including host view before/after expectations and bridge message wiring checks.
- Exposed `removeSubInput` in the plugin bridge and made it post a host removal message instead of silently leaving the SubInput in place.
- `PluginPanel` now handles `__ipc_subinput_remove__` by clearing SubInput options, clearing the current SubInput value, and blurring the rendered input.
- The runtime strip returns to `SubInput` / `未启用` after removal, keeping the visible host state aligned with plugin intent.

Verification:

- Red/green: `pnpm test:plugin-subinput-remove` failed first because `utools.removeSubInput` was not exposed, then passed after adding the bridge method and host message handler.
- `pnpm test:plugin-subinput-remove`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the target interaction used Playwright fallback.
- Playwright rendered bridge check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` started with `SubInput` / `已启用` and input value `time`; posting `__ipc_subinput_remove__` removed `input.sub-input`, hid the placeholder, changed the runtime strip to `SubInput` / `未启用`, kept the plugin host and bridge sections rendered, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:50850`.

## Previous Batch

### Batch 134: Plugin Dynamic Height Request

Completed:

- Added a focused regression test for dynamic plugin height requests, including default-hidden and clamped-height runtime chip behavior.
- `utools.setExpendHeight` and `utools.setExpandHeight` now normalize plugin height requests, clamp them to a safe host range, and post them to the parent host.
- `PluginPanel` tracks the requested plugin height per active plugin feature and resets it when the feature changes.
- `pluginHostView` shows a `动态高度` runtime chip with the normalized pixel value when a plugin requests host height.

Verification:

- Red/green: `pnpm test:plugin-dynamic-height` failed first because no `动态高度` runtime chip existed, then passed after adding height request state, bridge aliases, and host message handling.
- `pnpm test:plugin-dynamic-height`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach for this browser-use page`), so the target interaction used Playwright fallback.
- Playwright rendered bridge check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` initially had no `动态高度` chip; posting `__ipc_plugin_height__` with height `420` showed `动态高度` / `420 px`, kept the plugin host and bridge sections rendered, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, `plugin_runtime_smoke.expand_height_valid:true`, and sample selected plugin was `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed: 127.0.0.1:64411`.

## Previous Batch

### Batch 133: Plugin Registered Tool Visibility

Completed:

- Added registered-tool host state to `PluginPanel` and reset it when the active plugin feature changes.
- `registerTool` messages now update host-visible runtime state instead of only posting an unhandled message.
- `pluginHostView` shows a `注册工具` runtime chip when a plugin registers runtime tool handlers.
- Added a focused regression test for registered tool runtime chips and host message wiring.

Verification:

- Red/green: `pnpm test:plugin-registered-tools` failed first because no `注册工具` runtime chip existed, then passed after adding registered-tool count state and host message handling.
- `pnpm test:plugin-registered-tools`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser path: in-app Browser failed to attach to the webview in this run (`Timed out waiting for the Browser webview to attach...`), so the target interaction used Playwright fallback.
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` initially had no `注册工具` chip; posting `__ipc_register_tool__` with `summarizeSelection` showed `注册工具` / `1 项`, kept the host and bridge sections rendered, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, and sample selected plugin remained `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 132: Plugin Keyboard Simulation Guard

Completed:

- Replaced the silent `simulateKeyboardTap` no-op with a native bridge call carrying the key and modifiers.
- Added a host-side `simulateKeyboardTap` bridge case that returns a method-scoped unsupported error without performing keyboard automation side effects.
- Added a focused regression test so future bridge edits cannot silently pretend keyboard simulation succeeded.

Verification:

- Red/green: `pnpm test:plugin-keyboard-guard` failed first because `simulateKeyboardTap` still returned `Promise.resolve(null)`, then passed after routing it through the native bridge and adding the explicit unsupported case.
- `pnpm test:plugin-keyboard-guard`
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Playwright rendered bridge check: `http://localhost:1420/?parity=1&pluginHostSmoke=1` returned `simulateKeyboardTap unsupported: keyboard automation is not available for A` through `__atools_native_response__`, with plugin host/SubInput still rendered and console checks reporting 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.native_bridge_checked:true`, and sample selected plugin remained `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 131: Plugin SubInput Focus Bridge

Completed:

- Replaced the silent `subInputFocus` / `subInputBlur` bridge stubs with parent-host messages.
- `PluginPanel` now handles `__ipc_subinput_focus__`, keeps SubInput visibility state in sync, and calls the rendered input's `focus()` or `blur()`.
- Added a focused regression test so future bridge edits cannot reintroduce no-op SubInput focus behavior.

Verification:

- Red/green: `pnpm test:plugin-subinput-focus` failed first because `subInputFocus` still returned `Promise.resolve(null)`, then passed after adding the iframe-to-host focus bridge.
- `pnpm test:plugin-subinput-focus`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser page check: Browser loaded `http://localhost:1420/?parity=1&pluginHostSmoke=1`, confirmed title `ATools 3.0`, non-empty plugin host DOM, no framework overlay, and captured a viewport screenshot. Browser's page execution environment could not call `window.postMessage`, so the target message interaction used Playwright fallback.
- Playwright interaction fallback: posting `__ipc_subinput_focus__` with `action:"focus"` made `input.sub-input` the active element, posting `action:"blur"` removed focus, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `plugin_runtime_smoke.dialog_guard_checked:true`, and sample selected plugin remained `calculator` / `calc` on this machine. The command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 130: Plugin Dynamic Feature Registry

Completed:

- Replaced the silent `setFeature` / `removeFeature` bridge stubs with an in-iframe dynamic feature registry.
- `setFeature` / `setFeatures` now normalize single or array feature payloads, store them by feature code, post state to the parent host, and return the current dynamic feature list.
- `removeFeature` removes by code/object/array and `getFeatures` returns the current in-memory list.
- `PluginPanel` now tracks dynamic feature messages from the iframe and passes the count into `pluginHostView`.
- `pluginHostView` shows a `动态指令` runtime chip only when a plugin registers temporary runtime features.

Verification:

- Red/green: `pnpm test:plugin-dynamic-features` failed first because no dynamic runtime chip existed and `setFeature` / `removeFeature` were still silent stubs, then passed after adding the registry and host state wiring.
- `pnpm test:plugin-dynamic-features`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser fallback via Playwright: `http://localhost:1420/?parity=1&pluginHostSmoke=1` rendered the plugin host, a real `postMessage({ __ipc_dynamic_feature__: true, ... })` update showed `动态指令` / `1 项`, and console checks reported 0 errors / 0 warnings.
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.dialog_guard_checked:true`, `feature_activated:true`, and sample selected plugin remained `calculator` / `calc` on this machine. Vite/esbuild still printed shutdown `write EPIPE` noise after the smoke line, but the successful command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 129: Plugin Dialog Bridge Smoke Guard

Completed:

- Added a shared `pluginDialogBridge` helper for dialog option normalization, smoke guard detection, and explicit guard errors.
- `PluginPanel` now blocks `showOpenDialog` / `showSaveDialog` when `VITE_ATOOLS_DESKTOP_SMOKE` is active, so automated smoke cannot launch interactive file picker panels.
- `pnpm smoke:tauri-desktop` now propagates `VITE_ATOOLS_DESKTOP_SMOKE=1` alongside `ATOOLS_DESKTOP_SMOKE=1`.
- Extended `plugin_runtime_smoke` with `dialog_guard_checked`, and tightened the parser so missing dialog guard evidence fails smoke output validation.

Verification:

- Red/green: `pnpm test:plugin-dialog-bridge` failed first because `src/lib/pluginDialogBridge.ts` did not exist, then passed after adding the helper and PluginPanel guard wiring.
- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because `plugin_runtime_smoke.dialog_guard_checked` was absent, then passed after adding required-field validation and smoke output.
- Red/green: `cargo test -p atools --lib desktop_smoke` failed first because `PluginRuntimeSmokeSummary` had no `dialog_guard_checked` field, then passed after adding the field and env propagation check.
- `pnpm test:plugin-dialog-bridge`
- `pnpm test:tauri-desktop-smoke-script`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-bridge-capabilities`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.dialog_guard_checked:true`, `native_bridge_checked:true`, and `screen_capture_guard_checked:true`; sample selected plugin remained `calculator` / `calc` on this machine. One earlier smoke attempt degraded on a transient MCP ping `Resource temporarily unavailable (os error 35)`, then the immediate rerun passed. Vite/esbuild still printed shutdown `write EPIPE` / callback noise after the smoke line, but the successful command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 128: Plugin Screen Capture Smoke Guard

Completed:

- Extended `plugin_runtime_smoke` with `screen_capture_guard_checked`.
- Added an explicit `screenCapture skipped during desktop smoke...` guard to the command layer when `ATOOLS_DESKTOP_SMOKE` is active, so automated smoke never launches the interactive macOS screenshot UI.
- The desktop smoke now verifies this no-side-effect guard path while preserving production `screen_capture` behavior outside smoke.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when the screen capture guard field is absent.

Verification:

- Red/green: `cargo test -p atools --lib screen_capture_smoke_guard_is_explicit_and_noninteractive` failed first because the smoke guard helper was missing, then passed after adding the explicit guard error.
- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because the parser accepted missing `plugin_runtime_smoke.screen_capture_guard_checked`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib screen_capture_smoke_guard_is_explicit_and_noninteractive`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.screen_capture_guard_checked:true`, `native_bridge_checked:true`, and `copied_files_read_checked:true`; sample selected plugin remained `calculator` / `calc` on this machine. Vite still printed shutdown `write EPIPE` noise after the smoke line, but the command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 127: Plugin Clipboard Files Read Smoke

Completed:

- Extended `plugin_runtime_smoke` with `copied_files_read_checked`.
- The desktop smoke now calls the command-layer `get_copyed_files` bridge path and accepts a real non-empty file path list, an empty list, or an explicit `getCopyedFiles` / unsupported-platform error.
- This covers `getCopyedFiles` / `getCopiedFiles` against silent fake success while keeping the smoke read-only: it does not write clipboard data or open local files.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when the clipboard file-list field is absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because the parser accepted missing `plugin_runtime_smoke.copied_files_read_checked`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.copied_files_read_checked:true`, `native_bridge_checked:true`, and `native_error_checked:true`; sample selected plugin remained `calculator` / `calc` on this machine. Vite still printed shutdown `write EPIPE` noise after the smoke line, but the command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 126: Plugin Shell Reveal Error Smoke

Completed:

- Extended `plugin_runtime_smoke` with `shell_show_item_error_checked`.
- Wrapped macOS `shell_show_item_in_folder` failures as `shellShowItemInFolder failed: ...`, so plugin bridge errors identify the API method instead of only exposing the underlying `open` command.
- The desktop smoke now calls `shell_show_item_in_folder` with a unique missing temp path and requires an explicit missing-path or unsupported-platform error.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when the shell reveal error field is absent.

Verification:

- Red/green: `cargo test -p atools --lib shell_show_item_in_folder_missing_path_reports_bridge_method` failed first because the missing-path error did not contain `shellShowItemInFolder`, then passed after wrapping the native command error.
- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because the parser accepted missing `plugin_runtime_smoke.shell_show_item_error_checked`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib shell_show_item_in_folder_missing_path_reports_bridge_method`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.shell_show_item_error_checked:true`, `native_error_checked:true`, `copy_file_error_checked:true`, and `copy_image_error_checked:true`; sample selected plugin remained `calculator` / `calc` on this machine. Vite/esbuild printed shutdown noise after the smoke line, but the command exited 0 and printed `Desktop smoke passed`.

## Previous Batch

### Batch 125: Plugin Context Bridge Smoke

Completed:

- Extended `plugin_runtime_smoke` with `context_bridge_checked`, `browser_context_checked`, and `finder_context_checked`.
- The desktop smoke now calls the command-layer `read_current_browser_url` and `read_current_folder_path` bridge paths and only accepts a real non-empty value, an explicit empty result, or an explicit `osascript` / unsupported-platform error.
- This covers `readCurrentBrowserUrl` / `readCurrentFolderPath` against silent fake success without opening URLs, launching Finder actions, taking screenshots, or mutating clipboard/files.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when context bridge fields are absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because the parser accepted missing `plugin_runtime_smoke.finder_context_checked`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`

## Previous Batch

### Batch 124: Agent Tool Toggle Smoke

Completed:

- Extended `permission_smoke` with `tool_toggle_persisted` and `tool_toggle_restored`.
- The desktop smoke now reads the current `search_clipboard` enabled state, flips it, verifies the changed state persists through the database, restores the original state, and verifies the restoration.
- This covers the Settings/Agent “工具开关能保存” requirement at the desktop runtime layer without calling the tool or mutating user clipboard/search data.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when tool-toggle fields are absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because the parser did not reject missing `permission_smoke.tool_toggle_restored`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `permission_smoke.tool_toggle_persisted:true`, `tool_toggle_restored:true`, `enabled_agent_tools` still contains `search_clipboard` after restore, and `audit_entries_count:0`; sample selected plugin remained `calculator` / `calc` on this machine.

## Previous Batch

### Batch 123: Scope Deny Permission Smoke

Completed:

- Extended `permission_smoke` with `scope_deny_overrides_developer` and `scope_deny_audit_recorded`.
- The desktop smoke now preserves the user's current permission mode and scope policy, temporarily switches to developer mode with `shell` denied, calls `open_or_reveal_path`, verifies the tool is denied before any path open/reveal side effect, then restores both settings.
- The smoke also verifies a denied audit row is written for that blocked `open_or_reveal_path` call and cleans up both temporary audit rows created during the permission smoke.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when these scope-deny fields are absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because the parser did not reject missing `permission_smoke.scope_deny_audit_recorded`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `permission_smoke.scope_deny_overrides_developer:true`, `scope_deny_audit_recorded:true`, `cleanup_deleted_audits:2`, and `permission_mode:"conservative"` after restore; sample selected plugin remained `calculator` / `calc` on this machine.

## Previous Batch

### Batch 122: Filtered Audit Export Desktop Smoke

Completed:

- Extended `data_debug_smoke` with `audit_filtered_export_checked` and `audit_filtered_export_count_checked`.
- The desktop smoke now inserts two uniquely identified temporary audit rows, exports JSONL with query/status/tool/client filters, verifies exactly one matching row is returned, and deletes the temporary audit rows afterward.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when filtered audit export fields are absent.
- This gives the Agent/MCP audit UI's “导出当前筛选” behavior a real desktop regression signal instead of only model-level filtering tests.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first on missing `data_debug_smoke.audit_filtered_export_checked`, then passed after adding required-field validation and smoke output.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `cargo fmt --check`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `data_debug_smoke.audit_filtered_export_checked:true`, `audit_filtered_export_count_checked:true`, and `audit_entries_count:0` after cleanup; sample selected plugin remained `calculator` / `calc` on this machine.

## Previous Batch

### Batch 121: Plugin Bridge Capability Inventory

Completed:

- Added a shared `pluginBridgeCapabilities` model that groups the exposed bridge surface into DB, clipboard, dialog, system, and context capabilities.
- Marked fully implemented groups as `ready` and partial groups as `partial`, so future bridge work has one inventory to update instead of hard-coded runtime copy.
- Wired the plugin runtime `桥接能力` chip to `pluginBridgeRuntimeDetail()`, changing the visible detail to `DB / 剪贴板 / 对话框 / 系统 / 上下文`.
- Extended the plugin host view harness so it resolves the new shared capability module and keeps the runtime strip expectation aligned with the model.

Verification:

- Red/green: `pnpm test:plugin-bridge-capabilities` failed first on the missing capability module, then passed after adding the shared inventory.
- Red/green: `pnpm test:plugin-host-view` failed first on the missing transformed dependency and then the old bridge detail expectation, then passed after wiring the shared detail.
- `pnpm test:plugin-bridge-capabilities`
- `pnpm test:plugin-host-view`
- `pnpm check`
- `pnpm build`
- `pnpm smoke:tauri-desktop`
- Browser behavior check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` shows 4 runtime chips and the `桥接能力` chip detail `DB / 剪贴板 / 对话框 / 系统 / 上下文`; no horizontal overflow; console 0 errors/0 warnings.
- In-app Browser DOM and console validation passed; its screenshot call timed out, so fallback Playwright screenshot captured at `/Users/harris/Desktop/atools/output/playwright/plugin-bridge-smoke-20260603.png`.
- Real desktop smoke output: `status:"ok"` and existing `plugin_runtime_smoke` bridge fields remained true; sample selected plugin was `calculator` / `calc` on this machine.

## Previous Batch

### Batch 120: Desktop Native Bridge Error Smoke

Completed:

- Extended `plugin_runtime_smoke` with explicit native bridge error-path checks for `copyFile` and `copyImage`.
- Added `native_error_checked`, `copy_file_error_checked`, and `copy_image_error_checked` to the smoke output.
- The smoke calls the command-layer `copy_file` / `copy_image` with unique missing temp paths and only accepts explicit `does not exist` / `unsupported` errors; success is treated as a smoke failure.
- This keeps the automatic smoke side-effect free: it does not write the system clipboard or open files, while still proving these high-priority bridge APIs do not silently pretend success.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when native bridge error fields are absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because missing native error fields were accepted, then passed after adding required-field validation.
- Red/green: `cargo test -p atools --lib desktop_smoke` failed first because `PluginRuntimeSmokeSummary` did not include native error fields, then passed after adding the missing-path smoke.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.native_error_checked:true`, `copy_file_error_checked:true`, and `copy_image_error_checked:true`; sample selected plugin was `calculator` / `calc` on this machine.

## Previous Batch

### Batch 119: Desktop Native Bridge Smoke

Completed:

- Extended `plugin_runtime_smoke` with safe native bridge checks that do not open URLs, reveal files, show notifications, or mutate clipboard.
- Added `native_bridge_checked`, `system_path_checked`, and `shell_target_checked` to the smoke output.
- The smoke now verifies `system_get_path("temp")` returns an existing temp directory and unknown path names return an empty fallback.
- The smoke also verifies the same `shell_open` target classifier used by the command layer treats `https:` and `mailto:` values as URLs, and local paths as paths.
- Exposed `shell_open_target` and `ShellOpenTarget` as `pub(crate)` so desktop smoke can validate the actual command classifier instead of duplicating URL-scheme logic.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing when native bridge fields are absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because missing native bridge fields were accepted, then passed after adding required-field validation.
- Red/green: `cargo test -p atools --lib desktop_smoke` failed first because `PluginRuntimeSmokeSummary` did not include native bridge fields, then passed after adding the safe bridge smoke.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.native_bridge_checked:true`, `system_path_checked:true`, and `shell_target_checked:true`; sample selected plugin was `calculator` / `calc` on this machine.
- Vite still prints `write EPIPE` during smoke shutdown after the app exits; the smoke command exits 0 and prints `Desktop smoke passed`.

## Previous Batch

### Batch 118: Desktop Plugin Data Bridge Smoke

Completed:

- Extended `plugin_runtime_smoke` with real plugin data bridge checks for the selected indexed plugin.
- The desktop smoke now writes a unique temporary plugin document, reads it back with revision metadata, bulk-writes two more documents, stores and reads a binary attachment, then removes all temporary documents and attachment.
- `plugin_runtime_smoke.ok()` now requires `data_bridge_checked`, `data_roundtrip_checked`, `bulk_docs_checked`, `attachment_checked`, and `data_cleanup_checked`.
- Tightened `scripts/smoke-tauri-desktop.mjs` so machine-readable smoke output fails parsing if any plugin data bridge field is missing.
- The check uses real `Database` plugin data and attachment APIs but unique `__atools_desktop_smoke_*` IDs, so it validates the bridge without leaving persistent test data behind.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because missing plugin data bridge fields were accepted, then passed after adding required-field validation.
- Red/green: `cargo test -p atools --lib desktop_smoke` failed first because `PluginRuntimeSmokeSummary` did not include the data bridge fields, then passed after implementing the bridge smoke.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.data_bridge_checked:true`, `data_roundtrip_checked:true`, `bulk_docs_checked:true`, `attachment_checked:true`, and `data_cleanup_checked:true`; sample selected plugin was `calculator` / `calc` on this machine.

## Previous Batch

### Batch 117: Desktop Plugin Runtime Smoke Snapshot

Completed:

- Added `plugin_runtime_smoke` to the machine-readable `ATOOLS_DESKTOP_SMOKE` snapshot.
- The smoke now selects an indexed plugin feature from the real desktop database and verifies feature activation lookup, plugin id/name/code, plugin directory existence, `main` entry existence, preload file presence when declared, and capped plugin window height.
- `status:"ok"` now requires `plugin_runtime_smoke.ok()`, so a missing plugin entry, missing plugin directory, missing `index.html`, missing preload, or invalid height degrades the desktop smoke.
- The plugin smoke selector continues past broken entries and uses the first valid plugin, while preserving a degraded error summary if none are valid.
- Tightened `scripts/smoke-tauri-desktop.mjs` parsing so CI/local smoke fails if `plugin_runtime_smoke` or any required plugin-runtime field is absent.

Verification:

- Red/green: `pnpm test:tauri-desktop-smoke-script` failed first because missing `plugin_runtime_smoke` was accepted, then passed after adding required-field validation.
- Red/green: `cargo test -p atools --lib desktop_smoke` failed first on the missing Rust summary/snapshot fields, then passed after adding `PluginRuntimeSmokeSummary`.
- `pnpm test:tauri-desktop-smoke-script`
- `cargo test -p atools --lib desktop_smoke`
- `pnpm smoke:tauri-desktop`
- Real desktop smoke output: `status:"ok"`, `plugin_runtime_smoke.feature_activated:true`, `main_exists:true`, `plugin_path_exists:true`, `expand_height_valid:true`, `preload_checked:true`; sample selected plugin was `calculator` / `calc` on this machine.
- Vite still prints `write EPIPE` during smoke shutdown after the app exits; the smoke command exits 0 and prints `Desktop smoke passed`.

## Previous Batch

### Batch 116: Plugin Host Runtime Status Strip

Completed:

- Added `runtimeChips` to the shared `pluginHostView` model, covering runtime mode, SubInput state, output result count, and `utools/ztools` bridge capability.
- Rendered a compact `插件运行状态` strip between the plugin header and SubInput/body so users can see whether the host is loading, iframe-ready, output-layer active, or failed.
- Kept the strip in its own flex row; titlebar, runtime strip, SubInput, iframe body, and output layer remain separate layout slots.
- Added a Web-preview-only `?pluginHostSmoke=1` harness that renders a local fixture PluginPanel when no Tauri runtime is present; real desktop `activate_feature` is unchanged.
- Preserved disabled `设置` / `分离` chrome actions and existing output row keyboard/copy affordance.

Verification:

- Red/green: `pnpm test:plugin-host-view` failed first on missing runtime layout slot/chips, then passed after adding `runtimeChips` and the rendered runtime strip.
- Red/green: `pnpm test:plugin-host-view` failed first on missing Web-preview plugin-host smoke path, then passed after adding the `pluginHostSmoke` fixture path.
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-inventory-overview`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-market-overview`
- `pnpm check`
- `pnpm build`
- Browser behavior check: `http://127.0.0.1:1420/?parity=1&pluginHostSmoke=1` shows `插件运行状态`, 4 runtime chips, SubInput value `time`, 2 output rows, and no horizontal overflow; header/runtime/SubInput/body/output regions do not overlap; console 0 errors/0 warnings.
- In-app Browser DOM and console validation passed; its screenshot call timed out after 8000ms, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T01-04-57-972Z.png`.
- Real desktop plugin runtime remains covered by `pnpm smoke:tauri-desktop`; deeper plugin API parity still needs targeted desktop smoke for built-in timestamp/json/color/calculator plugins.

## Previous Batch

### Batch 115: Home Search Overview Strip

Completed:

- Added a shared `homeSearchOverviewCards` model for the Home surface, covering searchable source classes, fixed command count, recent history count, and first-screen entry count.
- Rendered a compact `搜索概览` strip above Home quick actions, so the first screen now exposes current search readiness before the fixed/recent command grids.
- Wired overview data to live Home state: local app search setting, local launch search setting, command alias count, enabled local launch entries, and enabled web quick-open entries.
- Fixed Home shell height calculation for the no-fixed-command empty state; the fixed empty row and new overview strip now have explicit target-height budget, preventing the status bar from covering recent commands.
- Kept existing quick actions, fixed command management entry, recent command activation/removal, keyboard selection, and search result mode intact.

Verification:

- Red/green: `pnpm test:home-search-overview` failed first on missing `homeSearchOverviewCards`, then passed after the overview model/rendering implementation.
- Red/green: after browser screenshot exposed Home status-bar overlap, `pnpm test:home-search-overview` failed first on missing fixed-empty height accounting, then passed after adding `HOME_PINNED_EMPTY_HEIGHT`.
- `pnpm test:home-search-overview`
- `pnpm test:home-surface`
- `pnpm test:home-pinned-sections`
- `pnpm test:home-quick-action-icons`
- `pnpm test:home-recent-type-icons`
- `pnpm test:search-status-bar`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home first screen shows `搜索概览`, 4 overview cards, 4 quick actions, fixed empty action, recent commands, and no horizontal overflow; `ip` query switches into search results mode without console errors.
- In-app Browser DOM and console validation passed; its screenshot call timed out after 8000ms, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-56-22-651Z.png`.
- Layout proof: Home shell height is 515px, recent command grid bottom is above the status bar, and the status bar no longer covers the second recent row.

## Earlier Batch

### Batch 114: About Page Runtime Overview

Completed:

- Added a shared `aboutOverviewCards` model for Settings `关于`, covering product version, desktop runtime state, local MCP tool readiness, and redacted diagnostics availability.
- Replaced the previous hero-only first section with a first-screen `关于概览`, so runtime/MCP/diagnostic state is visible before product direction and raw rows.
- Added 4 compact overview cards: `版本`, `桌面运行时`, `本地 MCP`, and `诊断包`.
- Made the diagnostics privacy boundary explicit: copied diagnostics include local runtime state and redacted config only; MCP token, AI API Key, and WebDAV password are excluded.
- Kept existing product direction cards, runtime rows, local environment rows, copy runtime info, copy redacted diagnostics, and navigation to Debug/MCP pages intact.

Verification:

- Red/green: `pnpm test:about-overview` failed first on missing `aboutOverviewCards`, then passed after implementation.
- `pnpm test:about-overview`
- `pnpm test:about-settings`
- `pnpm test:mcp-client-config`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `关于` shows `关于概览`, 4 overview cards, diagnostics privacy boundary text, `产品方向`, `运行信息`, `本地环境`, diagnostic copy actions, and no horizontal overflow; console 0 errors/0 warnings.
- In-app Browser DOM and console validation passed; its screenshot call timed out at `Page.captureScreenshot`, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-44-07-249Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 113: HTTP Service First-screen Overview

Completed:

- Added a shared `httpServiceOverviewCards` model for Settings `HTTP 服务`, covering legacy HTTP API state, MCP replacement state, Bearer token/auth audit state, and client configuration availability.
- Split `HTTP 服务` into a first-screen `HTTP 服务概览` section and a lower `MCP 连接入口` section, so the page starts with the actual current automation path instead of raw status rows.
- Added 4 compact overview cards: `HTTP API`, `替代入口`, `认证审计`, and `客户端配置`.
- Made the boundary explicit: traditional HTTP show/hide/toggle API is not enabled in the current version; automation is consolidated through local MCP.
- Kept existing MCP address copy, MCP client config copy, MCP page jump, security hint, status rows, and legacy HTTP disabled row intact.

Verification:

- Red/green: `pnpm test:http-service-overview` failed first on missing `httpServiceOverviewCards`, then passed after implementation.
- `pnpm test:http-service-overview`
- `pnpm test:http-service-settings`
- `pnpm test:mcp-client-config`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `HTTP 服务` shows `HTTP 服务概览`, 4 overview cards, traditional HTTP disabled boundary text, `MCP 连接入口`, copy MCP URL/config actions, and no horizontal overflow; console 0 errors/0 warnings.
- In-app Browser DOM and console validation passed; its screenshot call timed out at `Page.captureScreenshot`, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-35-22-922Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 112: General Settings First-screen Overview

Completed:

- Added a shared `generalOverviewCards` model for Settings `通用设置`, covering hotkey save state, launch/tray system entry state, local search source toggles, and deferred capability count.
- Split `通用设置` into a first-screen `通用设置概览` section and a lower `基础设置` section, so the page starts with scannable state before the long form.
- Added 4 compact overview cards: `呼出快捷键`, `系统入口`, `搜索来源`, and `暂缓能力`.
- Made the local/system boundary explicit: settings are saved locally, while hotkey, launch-at-login, and tray visibility sync to desktop system capabilities.
- Kept existing hotkey recorder, quick presets, launch/tray toggles, wakeup blacklist, appearance controls, search controls, behavior controls, and unsupported capability list intact.

Verification:

- Red/green: `pnpm test:general-settings-overview` failed first on missing `generalOverviewCards`, then passed after implementation.
- `pnpm test:general-settings-overview`
- `pnpm test:settings-pages`
- `pnpm test:settings-controls-style`
- `pnpm test:settings-normalization`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `通用设置` shows `通用设置概览`, 4 overview cards, local/system boundary text, `基础设置`, hotkey input, unsupported capability list, and no horizontal overflow; console 0 errors/0 warnings.
- In-app Browser DOM and console validation passed; its screenshot call timed out at `Page.captureScreenshot`, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-28-20-848Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 111: Plugin Market First-screen Overview

Completed:

- Added a shared `pluginMarketOverviewCards` model for Settings `插件市场`, covering market connection state, local fallback entries, installed plugin count, remote capability deferrals, and desktop preview state.
- Split `插件市场` into a first-screen `插件市场概览` section and a lower `本地替代入口` section, so the page starts with current market readiness instead of raw debug rows.
- Added compact overview cards for `市场状态`, `市场地址`, `本地入口`, `已安装插件`, and `远程能力`.
- Made the boundary explicit: the network plugin market does not download or update plugins in the current version; local import, installed plugin management, and data export remain the supported desktop paths.
- Kept the refresh action, local capability list, remote deferred capability list, and later custom market address entry aligned with the no-download boundary.

Verification:

- Red/green: `pnpm test:plugin-market-overview` failed first on missing `pluginMarketOverviewCards`, then passed after implementation.
- `pnpm test:plugin-market-overview`
- `pnpm test:plugin-market-status`
- `pnpm test:plugin-inventory-overview`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `插件市场` shows `插件市场概览`, market boundary text, custom market address status when configured, `本地替代入口`, and no horizontal overflow; console 0 errors/0 warnings.
- In-app Browser DOM and console validation passed; its screenshot call timed out at `Page.captureScreenshot`, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-21-58-315Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 110: Installed Plugin Inventory First-screen Overview

Completed:

- Added a shared `pluginInventoryOverviewCards` model for Settings `已安装插件`, covering inventory count, enabled/disabled state, feature-command count, install entry status, and desktop preview state.
- Split `已安装插件` into a first-screen `插件库存概览` section and a lower `插件筛选` section, so the page starts with inventory readiness before list filtering.
- Added 4 compact overview cards: `插件库存`, `启用状态`, `Feature 指令`, and `安装入口`.
- Made the local boundary explicit: enable status and the local plugin manifest stay on this machine; plugin market download, remote update, and uninstall remain unconnected.
- Kept existing refresh, status/source/query filters, selected plugin details, enable/disable controls, and local import affordance intact.

Verification:

- Red/green: `pnpm test:plugin-inventory-overview` failed first on missing `pluginInventoryOverviewCards`, then passed after implementation.
- `pnpm test:plugin-inventory-overview`
- `pnpm test:plugin-inventory`
- `pnpm test:plugin-market-status`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check at that time: Home -> Settings -> `已安装插件` shows `插件库存概览`, 4 overview cards, local-only inventory boundary text, `插件筛选`, then-disabled install entry in Web preview, and no horizontal overflow; console 0 errors/0 warnings; dark theme value color resolves to `rgb(243, 244, 246)`. Batch 172 later replaced the disabled install placeholder with a desktop local directory install action.
- In-app Browser DOM and console validation passed; its screenshot call timed out at `Page.captureScreenshot`, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-12-43-262Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 109: Local Launch First-screen Overview

Completed:

- Added a shared `localLaunchOverviewCards` model for Settings `本地启动`, covering enabled launch entries, type distribution, desktop-only path capabilities, save status, and local-only path boundaries.
- Split `本地启动` into a first-screen `本地启动概览` section and a lower `启动项配置` section, so the page starts with search/path readiness before editable path rows.
- Added 4 compact overview cards: `启动入口`, `类型分布`, `桌面能力`, and `保存状态`.
- Made the local boundary explicit: names, keywords, types, and paths stay on this machine; opening or revealing paths only runs in the desktop app.
- Kept existing file/folder/app picker buttons, manual add, reset, drag-and-drop, open, reveal, delete, and row editing behavior intact.

Verification:

- Red/green: `pnpm test:local-launch-overview` failed first on missing `localLaunchOverviewCards`, then passed after implementation.
- `pnpm test:local-launch-overview`
- `pnpm test:local-launch`
- `pnpm test:local-launch-settings`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `本地启动` shows `本地启动概览`, 4 overview cards, local-only path boundary text, `启动项配置`, drag-and-drop dropzone, 2 default launch rows, and disabled desktop picker buttons in Web preview; no horizontal overflow; console 0 errors/0 warnings; dark theme value color resolves to `rgb(243, 244, 246)`.
- In-app Browser DOM and console validation passed; its screenshot call still timed out at `Page.captureScreenshot`, so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-03T00-04-55-682Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 108: Web Quick Open First-screen Overview

Completed:

- Added a shared `webQuickOpenOverviewCards` model for Settings `网页快开`, covering enabled quick-open entries, search-template count, fixed-URL count, save status, and local-only configuration boundaries.
- Split `网页快开` into a first-screen `网页快开概览` section and a lower `快开配置` section, so the page starts with search readiness before individual editable cards.
- Added 4 compact overview cards: `快开入口`, `搜索模板`, `固定网址`, and `保存状态`.
- Made the local boundary explicit: names, keywords, and URL templates stay on this machine; preview only opens the target URL and does not upload search terms or local configuration.
- Kept existing add, reset, edit, preview, delete, mode switch, and URL preview behavior intact.

Verification:

- Red/green: `pnpm test:web-quick-open-overview` failed first on missing `webQuickOpenOverviewCards`, then passed after implementation.
- `pnpm test:web-quick-open-overview`
- `pnpm test:web-quick-open`
- `pnpm test:web-quick-open-settings`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `网页快开` shows `网页快开概览`, 4 overview cards, local-only boundary text, `快开配置`, and 3 quick-open cards; no horizontal overflow; console 0 errors/0 warnings; dark theme value color resolves to `rgb(243, 244, 246)`.
- In-app Browser DOM and console validation passed; its screenshot API was unavailable (`tab.playwright.screenshot` not exposed), so fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T23-55-29-064Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 107: Debug Diagnostics First-screen Overview

Completed:

- Added a shared `debugOverviewCards` model for Settings `调试日志`, covering desktop runtime state, MCP service readiness, audit anomalies, crash logs, browser preview state, and redaction-safe status copy.
- Split `调试日志` into a first-screen `诊断概览` section and a lower `环境信息` section, so diagnostics now start with the actionable ZTools-style state summary instead of raw environment rows.
- Added 4 compact overview cards: `桌面运行时`, `MCP 服务`, `审计异常`, and `崩溃日志`.
- Made the safety boundary explicit: the redacted diagnostic bundle does not include MCP token, AI API Key, or WebDAV password; paths, audit records, and crash logs remain local.
- Kept existing refresh/copy actions and runtime, local data, MCP, crash, and audit detail sections intact.

Verification:

- Red/green: `pnpm test:debug-settings-overview` failed first on missing `debugOverviewCards`, then passed after implementation.
- Red/green: the debug overview theme assertion failed first while card values used a fixed `#333333`, then passed after changing values to inherit the active theme text color.
- `pnpm test:debug-settings-overview`
- `pnpm test:debug-diagnostics`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `调试日志` shows `诊断概览`, 4 overview cards, redaction text, and `环境信息`; no horizontal overflow; console 0 errors/0 warnings; dark theme value color resolves to `rgb(243, 244, 246)`.
- Browser screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T23-44-01-603Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 106: WebDAV First-screen Overview

Completed:

- Added a shared `webdavOverviewCards` model for Settings `WebDAV 同步`, covering connection readiness, remote directory, selected sync scopes, latest sync/preview/restore-plan status, desktop preview state, and incomplete configuration warnings.
- Split `WebDAV 同步` into a first-screen `WebDAV 概览` section and a lower `连接配置` section, matching the ZTools-style settings rhythm: status first, controls second.
- Added 4 compact overview cards: `连接配置`, `远端目录`, `同步范围`, and `最近结果`.
- Made the safety boundary explicit: password or token stays local; remote backup checks only read `manifest` and file summaries, and do not overwrite local settings, plugin data, or clipboard history.
- Kept existing WebDAV actions intact: sync, remote preview, restore plan, settings restore, and clipboard import.

Verification:

- Red/green: `pnpm test:webdav-settings-overview` failed first on missing `webdavOverviewCards`, then passed after implementation.
- `pnpm test:webdav-settings-overview`
- `pnpm test:webdav-sync-view`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `WebDAV 同步` shows `WebDAV 概览`, 4 overview cards, `连接配置`, local credential/safety text, no horizontal overflow, console 0 errors/0 warnings.
- In-app Browser screenshot still times out at `Page.captureScreenshot`; fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T23-30-04-352Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 105: AI Model First-screen Overview

Completed:

- Added a shared `aiOverviewCards` model for Settings `AI 模型`, covering provider state, default model, Agent default binding, connection status, desktop preview state, and incomplete configuration warnings.
- Split the `AI 模型` page into a first-screen `AI 模型概览` section and a lower `模型配置` section, so the page reads like a ZTools-style settings page instead of starting directly with a form.
- Added 4 compact overview cards: `模型提供商`, `默认模型`, `Agent 默认`, and `连接状态`.
- Made the local privacy boundary explicit: connection testing only reads `/models`, never sends chat content, and `API Key` remains local and is not written to audit or MCP configuration.
- Kept plugin behavior untouched; this batch only improves built-in settings UX.

Verification:

- Red/green: `pnpm test:ai-settings-overview` failed first on missing `aiOverviewCards`, then passed after implementation.
- `pnpm test:ai-settings-overview`
- `pnpm test:ai-connection-view`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Home -> Settings -> `AI 模型` shows `AI 模型概览`, 4 overview cards, `模型配置`, local API key/privacy text, no horizontal overflow, console 0 errors/0 warnings.
- In-app Browser screenshot still times out at `Page.captureScreenshot`; fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T23-20-23-598Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 104: MCP Recent Audit Feed in Settings

Completed:

- Added a shared `mcpAuditRows` model for Settings `MCP 服务`, covering tool/client identity, status label, tone, duration, timestamp, and compact result/error preview.
- Added `最近调用审计` to Settings `MCP 服务`, so the MCP page now covers governance, permission policy, pending requests, persistent grants, recent audit visibility, service connection, client templates, and tool switches.
- Loaded recent audit entries through the existing `list_audit_entries` command with a small page-local limit.
- Added `打开我的数据` from the MCP audit feed to jump into the full local data/audit overview page for export, clearing, and deeper review.
- Kept Web preview honest: recent audit entries show a desktop-only empty state instead of fake local records.

Verification:

- Red/green: `pnpm test:mcp-audit-settings` failed first on missing `mcpAuditRows`, then passed after implementation.
- `pnpm test:mcp-audit-settings`
- `pnpm test:mcp-request-grants-settings`
- `pnpm test:mcp-permission-policy-settings`
- `pnpm test:mcp-governance-overview`
- `pnpm test:audit-view`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `MCP 服务` shows `最近调用审计`, `打开我的数据`, desktop-only audit empty state in Web preview, no horizontal overflow, console 0 errors/0 warnings.
- In-app Browser screenshot still times out at `Page.captureScreenshot`; fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T23-12-27-050Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 103: MCP Pending Requests and Grants in Settings

Completed:

- Added shared `mcpPendingRequestRows` and `mcpGrantRows` models for Settings `MCP 服务`, covering pending request preview, scope labels, client/tool identity, and grant summaries.
- Added `待确认请求` to Settings `MCP 服务` with `允许一次`, `允许并记住`, and `拒绝` actions.
- Added `持久授权` to Settings `MCP 服务` with persistent grant visibility and `撤销` action.
- Reused existing Rust/Tauri commands: `list_agent_tool_grants`, `call_agent_tool`, `grant_agent_tool`, `dismiss_pending_agent_request`, and `revoke_agent_tool`.
- Kept Web preview honest: pending requests and grants show desktop-only empty states instead of fake local data.

Verification:

- Red/green: `pnpm test:mcp-request-grants-settings` failed first on missing `mcpPendingRequestRows`, then passed after implementation.
- `pnpm test:mcp-request-grants-settings`
- `pnpm test:mcp-permission-policy-settings`
- `pnpm test:mcp-governance-overview`
- `pnpm test:mcp-client-config`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `MCP 服务` shows `待确认请求` and `持久授权`, both with desktop-only empty states in Web preview, no horizontal overflow, console 0 errors/0 warnings.
- In-app Browser screenshot still times out at `Page.captureScreenshot`; fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T23-06-29-835Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 102: MCP Permission Policy Controls in Settings

Completed:

- Added a shared `mcpScopePolicyRows` model for Settings `MCP 服务`, covering scope label, description, risk label, decision label, and blocked state.
- Added a `权限策略` section to Settings `MCP 服务` so permission mode and scope policy controls live in the same page as MCP governance, connection, templates, and tool switches.
- Reused existing Rust/Tauri commands: `set_permission_mode` and `set_agent_scope_policy`; no plugin exposure behavior changed.
- Added a disabled Web preview state that clearly says permission Scope data must be read in the macOS desktop app.
- Added ZTools-style dense policy rows with high-risk labels and `确认` / `阻断` controls, responsive without horizontal overflow.

Verification:

- Red/green: `pnpm test:mcp-permission-policy-settings` failed first on missing `mcpScopePolicyRows`, then passed after implementation.
- `pnpm test:mcp-permission-policy-settings`
- `pnpm test:mcp-governance-overview`
- `pnpm test:mcp-client-config`
- `pnpm test:settings-pages`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `MCP 服务` shows `权限策略`, disabled `MCP 权限模式` in Web preview, desktop-only Scope hint, no horizontal overflow, console 0 errors/0 warnings.
- In-app Browser screenshot still times out at `Page.captureScreenshot`; fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T22-59-17-218Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 101: MCP Service Governance Overview

Completed:

- Added a shared `mcpGovernanceOverview` model for Settings `MCP 服务`, covering tool whitelist exposure, default permission mode, high-risk scopes, and pending Agent requests.
- Updated the Settings `MCP 服务` first screen so users see governance state before connection templates and tool switches.
- Reused real Rust/Tauri commands already used by the Agent panel: MCP status, tool registry, permission mode, scope policies, and pending requests.
- Added a local audit-chain summary so the page explains that Agent calls are governed by permission policy and written to local audit records.
- Kept plugin exposure unchanged: plugin-declared tools still require explicit authorization and are not part of this built-in UI pass.

Verification:

- Red/green: `pnpm test:mcp-governance-overview` failed first on missing `mcpGovernanceOverview`, then passed after implementation.
- `pnpm test:mcp-governance-overview`
- `pnpm test:mcp-client-config`
- `pnpm test:settings-pages`
- `pnpm test:data-settings-overview`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `MCP 服务` shows `MCP 治理概览`, 4 overview cards, `本地审计链路`, active left menu, no horizontal overflow, console 0 errors/0 warnings.
- In-app Browser screenshot still times out at `Page.captureScreenshot`; fallback Playwright screenshot captured at `/Users/harris/Desktop/.playwright-mcp/page-2026-06-02T22-50-47-970Z.png`.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 100: My Data First-screen Overview

Completed:

- Added a `数据概览` model for Settings `我的数据`, covering settings, recent usage, clipboard history, audit records, and plugin data.
- Added first-screen overview cards so the page no longer starts as a plain action list.
- Added a local privacy boundary note: settings, recent usage, clipboard history, audits, and plugin data stay local by default.
- Made Agent access constraints explicit: Agent can only read local data through authorized tools, with local audit records.
- Kept existing export/clear actions and audit/clipboard/history/plugin detail sections intact.

Verification:

- Red/green: `pnpm test:data-settings-overview` failed first on missing `dataOverviewCards`, then passed after implementation.
- `pnpm test:data-settings-overview`
- `pnpm test:settings-pages`
- `pnpm test:audit-view`
- `pnpm test:debug-diagnostics`
- `pnpm test:about-settings`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `我的数据` shows `数据概览`, 5 overview cards, `本地隐私边界`, and Agent authorization constraint; no horizontal overflow; console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 99: About Page Runtime and Diagnostics Actions

Completed:

- Turned Settings `关于` from a static fact page into a usable local runtime/diagnostics page.
- Added read-only runtime refresh for About: MCP status, Agent tool counts, runtime diagnostics, recent audits, and crash log summaries.
- Added `本地环境` rows for local data path, database path, plugin directory, Agent tool counts, MCP bind, and runtime events.
- Added `诊断入口` actions: `复制运行信息`, `复制脱敏诊断`, `打开调试日志`, and `打开 MCP 服务`.
- Reused the same redacted diagnostic bundle as `调试日志`, and kept MCP token hidden in copied runtime info.

Verification:

- Red/green: `pnpm test:about-settings` failed first on missing `refreshAboutPage`, then passed after implementation.
- `pnpm test:about-settings`
- `pnpm test:settings-pages`
- `pnpm test:debug-diagnostics`
- `pnpm test:mcp-client-config`
- `pnpm test:http-service-settings`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `关于` shows `本地环境`, `本地数据路径`, `本地 Agent 能力`, `诊断入口`, all four actions; `复制运行信息` shows inline success, `打开 MCP 服务` navigates to MCP settings; no horizontal overflow; console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

## Earlier Batch

### Batch 98: HTTP Service MCP Handoff

Completed:

- Reworked Settings `HTTP 服务` from a passive compatibility note into a usable MCP handoff page.
- Added live MCP status/security copy so the page explains local Bearer token behavior and stdio proxy fallback.
- Added `复制 MCP 地址` with a disabled state until the desktop MCP token is available.
- Added `复制 MCP 配置` and `查看 MCP 服务` actions so users can move from the ZTools-style HTTP entry to the ATools MCP-first flow.
- Kept `传统 HTTP API` visibly `未接入` instead of exposing a fake switch.

Verification:

- `pnpm test:http-service-settings`
- `pnpm test:settings-pages`
- `pnpm test:mcp-client-config`
- `pnpm test:settings-header-menu`
- `pnpm check`
- `pnpm build`
- Browser behavior check: Settings -> `HTTP 服务` shows `MCP 替代入口`, `复制 MCP 地址`, `复制 MCP 配置`, and `传统 HTTP API`; no horizontal overflow; console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

### Batch 97: Pinned Empty State and Direct Management Entry

Completed:

- Added an empty `固定` section on the home surface when no commands are pinned.
- Added a compact `管理固定指令` action in that empty section.
- Added a controlled settings navigation path: HomePanel -> App -> SystemPanel -> SettingsPanel can now open Settings directly on `所有指令`.
- Added `initialMenu` support to SettingsPanel without Svelte warnings.

Verification:

- `pnpm test:home-surface`
- `pnpm test:home-pinned-sections`
- `pnpm check`
- `pnpm test:search-status-bar`
- `pnpm test:settings-pages`
- `pnpm test:command-center-settings`
- `pnpm build`
- Browser behavior check: no pinned commands shows `固定` empty section with `管理固定指令`; clicking it opens Settings with `所有指令` active; no horizontal overflow; console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

### Batch 96: Section-aware Home Status Bar

Completed:

- Added `homeCommandStatus` so the selected home command reports its section, section-relative index, and selected label.
- Extended `SearchStatusBar` with optional title/detail overrides while preserving default search/result behavior.
- Updated App home mode so the bottom status bar shows `固定 1/2 · GitHub` for fixed commands and switches to `最近使用 1/11 · ...` when selection moves into recent commands.
- Kept HomePanel keyboard navigation as one continuous list across fixed and recent sections.

Verification:

- `pnpm test:home-surface`
- `pnpm test:search-status-bar`
- `pnpm test:home-pinned-sections`
- `pnpm check`
- `pnpm test:command-history`
- `pnpm test:pinned-commands`
- `pnpm test:settings-normalization`
- `pnpm build`
- Browser behavior check: status bar shows `固定 1/2 · GitHub`, then after keyboard movement shows `最近使用 1/11 · 打开链接 example.com/docs`; no horizontal overflow; console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

### Batch 95: Home Pinned Section and Fixed Row Count

Completed:

- Enabled `固定栏显示行数` in General settings and persisted `pinnedRows` through settings normalization, load, and save.
- Added `homeCommandSections` to split home commands into `固定` and `最近使用` sections.
- Updated HomePanel so pinned commands render in their own section with a continuous keyboard selection index.
- Capped visible pinned commands by `pinnedRows * 9` before filling recent/recommended commands, so fixed entries no longer crowd out recent usage.
- Kept browser test state clean by restoring pinned commands and pinned row count after visual verification.

Verification:

- `pnpm test:settings-normalization`
- `pnpm test:home-surface`
- `pnpm test:home-pinned-sections`
- `pnpm test:command-history`
- `pnpm test:pinned-commands`
- `pnpm test:settings-pages`
- `pnpm test:command-center-settings`
- `pnpm test:home-quick-action-icons`
- `pnpm test:home-recent-type-icons`
- `pnpm check`
- `pnpm build`
- Browser render check: `固定` and `最近使用` sections visible, `固定栏显示行数` select editable, one-row fixed section caps at 9 entries, no horizontal overflow, console 0 errors/0 warnings.
- `pnpm smoke:tauri-desktop`

### Batch 94: All Commands Pinning and Built-in Target Management

Completed:

- Added `src/lib/pinnedCommands.ts` for localStorage-backed pinned command codes, normalization, toggle, and update events.
- Extended `commandCenterRows` with `pinned`, `pinLabel`, and `pinStatusLabel`; pinned rows sort before normal rows and can be found by fixed status.
- Updated Settings `所有指令` with a `固定指令` summary card, row-level `固定/取消固定`, and row-level `启用/停用` for local launch and web quick open targets.
- Kept system commands explicit: they show `不可停用` instead of pretending to support disable.
- Connected pinned commands to the home panel so fixed commands appear before recent/history/recommended commands and activate by code.

Verification:

- `pnpm test:pinned-commands`
- `pnpm test:command-history`
- `pnpm test:settings-pages`
- `pnpm test:command-center-settings`
- `pnpm test:local-launch`
- `pnpm test:web-quick-open`
- `pnpm test:local-launch-settings`
- `pnpm test:web-quick-open-settings`
- `pnpm test:home-surface`
- `pnpm check`
- `pnpm build`
- Browser render check: `所有指令` has 9 rows, pin/toggle controls visible, no horizontal overflow, console 0 errors/0 warnings.
- Browser behavior check: local target enable/disable works and is restored; pinning GitHub web quick open moves it to the first home tile, then test state is cleared.
- `pnpm smoke:tauri-desktop`

## Next Built-in UX Tasks

- Continue Settings page parity for detailed subpages that still behave like capability summaries rather than full controls.
- Keep plugin iframe/runtime parity deferred until built-in settings and home/search UX are closer to ZTools/uTools.

### Batch 98: Release Bundle Split and Plugin Host Lazy Load

Completed:

- Moved `PluginPanel` out of the initial app bundle and lazy-load it only when a plugin is active.
- Added named release chunks for `plugin-panel-*` and `pinyin-engine-*`.
- Filtered known lazy chunks out of generated `modulepreload` links so startup does not eagerly fetch the plugin host.
- Added `pnpm test:release-bundle-budget` to enforce a 560KB initial JS budget and require named lazy chunks.
- Raised the desktop smoke bridge-probe timeout floor for large lazy-loaded PluginPanel HTML so real Tauri FS render probes remain stable.

Verification:

- `pnpm test:release-bundle-budget`
- `pnpm test:pinyin-lazy-load`
- `pnpm test:plugin-host-view`
- `pnpm test:plugin-window-browser-bridge`
- `pnpm test:plugin-resource-html`
- `pnpm test:macos-release-readiness`
- `pnpm check`
- `pnpm build`
- `cargo test --workspace`
- `pnpm smoke:tauri-desktop`
- `pnpm exec tauri build`

Release evidence:

- Production build emits initial `index-*` JS at about 384KB, below the 560KB budget.
- `plugin-panel-*` is about 275KB and `pinyin-engine-*` is about 302KB, both named lazy chunks.
- `dist/index.html` loads only the main `index-*` script and does not modulepreload `plugin-panel-*` or `pinyin-engine-*`.
- Tauri release bundle produced `target/release/bundle/macos/ATools 3.0.app` and `target/release/bundle/dmg/ATools 3.0_0.1.0_aarch64.dmg`.
