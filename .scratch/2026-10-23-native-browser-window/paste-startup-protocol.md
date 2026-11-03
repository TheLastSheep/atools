# Task14 main-owned original Paste startup contract

The full goal remains ZTools capability parity; Harris unchanged originals have priority. Task13 remains in progress until its original-business and native acceptance requirements are met. This slice executes the actual Paste 1.3.1 built preload, not only the auto-start helper or an extracted renamed minified class. Native GUI, AppleScript, global input hooks, system clipboard, package rewriting, dependency installation and Git mutations remain out of scope.

## Entry and fixture ownership

Original source root: `/Users/harris/Desktop/ZTools-plugins/plugins/pasteboard-pro`. Use `dist/ztools/plugin.json`, `preload.js`, its original relative chunk and required worker/helper files copied byte-for-byte into a private temporary package. Recheck pins from issue14 before execution. Prepare the whole graph with production `createPluginRuntimePreload.prepare`, keeping default 1s/2MiB/128-module/1024-read budgets. Build the document through `createPluginBridgeDocument` with `entryMode: preload`, actual package app version3.0.0 and ATools identity. Production paths bridge must return synchronous fixture paths. Do not override `window.ztools` to trick the original compatibility gate.

The VM/JSDOM document is an explicit WebView substitute. Original CJS executes through the production compiler, preload loader, Electron adapter, PluginData and Node module bridges. A real isolated Node bootstrap/codec owns native Node modules. Test-only transport, temporary persistent SQLite, permission admission and OS/clipboard ports are controlled boundaries; they are not the production Rust gate, actual SQLite schema or Tauri/App acceptance. Avoid same-thread HTTP serving for synchronous XHR; a separate worker can host the bridge server and stdio child.

Only a precise global-monitor launch may be redirected to a bounded observable pipe monitor. Never start the real Python/Accessibility hook. Reject and record all other OS commands and external networking. Restrict filesystem/configuration to temporary fixture paths and original source reads, use the established isolated child environment, and await owned processes/workers/listeners on every success or failure path. These are fixture controls, not claims of a new production sandbox.

## Required original business assertions

Seed real canonical history records and `pasteboard-pro:paste-stack` using their actual schemas before loading the original build. Verify original initialization loads valid text items, removes unresolved IDs, commits the repaired queue, and preserves it across persistent-store reopen. Observe original exposed business API/state and actual writes, not merely a spy on `get`. No synthetic Feature entry, Shelf/Panel window, keychain operation or global input is allowed during this background proof. Record any rejected unexpected capability as a concrete failure instead of a no-op success.

After the first executable full-preload slice, report exact failures and source callsites. Main coordinates production fixes. Graph-only preparation tests independently verify source-budget and safeStorage preflight behavior; they are not business-startup proof.

## File queue capability correction

The actual production Electron provider has no `writeBuffer`. Add a universal bounded file-list decoder for `NSFilenamesPboardType` XML plist, Harris-compatible `FileNameW` DROPFILES and `text/uri-list`. Unknown raw formats and binary plist stay explicitly unsupported; broad writeBuffer parity remains unfinished.

The adapter forwards decoded paths once to existing synchronous `host.clipboard.writeContent({kind:"files",paths})`. Keep the existing ClipboardWrite admission and private TaskRun path; no new network service, Node root, extra binary/base64 round trip or source-file read. Parser budgets: 512KiB raw bytes,20 paths,8192 UTF-8 bytes per path,64KiB JSON path list. Reject malformed encodings/structures, remote URIs, external/internal entities and unsafe paths before invoking the host. A failure, pending permission or Promise-returning host cannot report synchronous success or consume the original queue item. Win/Linux native writer availability remains a separate limitation.

## Work allocation

- paste_startup_coverage: new full-preload startup tests and meaningful fixture modules only; no production changes.
- background_native_finish: independent original graph/preflight preparation test only; no production changes.
- node_close_finish: pure file-buffer codec, minimal production Electron adapter injection and relevant codec/original-queue tests; no Rust/HostClipboardBridge/full-startup fixture changes.
- Main: interface/call chain, baseline/source pins, critical review and independent integration/size/budget acceptance. Workers are Luna, do not spawn descendants and preserve shared dirty work.

All code files must remain at most500 lines. Use the bundled Node22.23.3 and explicit Harris source environment. Local-loopback fixture tests may need a narrowly scoped tool escalation; no desktop/UI operations are authorized by it.
