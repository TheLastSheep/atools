# Task11 main-owned clipboard copy contract

Original scope remains full ZTools capability parity. This slice repairs public synchronous copy results, preserving unchanged Harris packages. No GUI/App/AppleScript/native probe, dependency install, Rust migration, global budget increase, commit or external write.

## Interface and ownership

`createPluginClipboardCopyApi(target, ports)` is a self-contained serializable factory in `src/lib/pluginClipboardCopyApi.ts`. target supplies addEventListener/removeEventListener; ports supplies `permission(): boolean`, `host(): {writeText?,writeContent?}|undefined`, `writeImage(value: string|Uint8Array): unknown`. The compiler constructs this factory within the existing trusted UTools closure, before exposing the utools object; image adapter lookup is lazy because the Electron adapter script runs later, before original preload/page code. Returns `{copyText,copyImage,copyFile,dispose}`. Public methods require exactly one documented argument and return an immediate boolean; errors return false. No fallbacks to async native calls, no retained payloads/retries/polling. Only null/undefined synchronous write completion is success. Lifecycle pagehide/plugin-out disables captured methods and removes listeners; later calls return false.

Core factory owns cheap argument validation, budgets and lifecycle. Text at most256KiB UTF8; image binary at most512KiB, data URL at most700KiB, local path8192 UTF8 bytes; file list at most20 entries and64KiB total paths. Match existing protocol; do not raise limits. Accept actual Uint8Array/Buffer across realms, respect byteOffset/byteLength, copy owned visible bytes, reject DataView/other typed arrays/array-like/accessors. Local paths are absolute POSIX, Windows drive or UNC, no NUL. Preserve existing supported image normalizations rather than asserting arbitrary nativeImage parity.

Trusted UTools closure constructs the factory and exposes methods in window.utools/ztools. Permission callback checks `_pluginPermissionAllowed('clipboard.write')`. If missing, at most one concurrent `_requestPluginPermission` (handled reject, reset upon settle) and immediately returnsfalse; never defer the write until grant. Existing host clipboard session gate/TaskRun remain independent; missing endpoint likewise returnsfalse and existingbridge requests permission with no data replay. No new public authority hook.

Injected writeImage lazily resolves current installed Electron adapter. Existing nativeImage.createFromDataURL/createFromPath/createFromBuffer produce branded images; clipboard.writeImage commits via hostClipboardBridge.image_write. For Uint8Array use a bounded visible-byte snapshot and current Buffer facade; no Node start on standalone PNG bytes/DURL. NonPNG/path use existing active permissioned Node/nativeImage path and must fail honestly when unavailable; path still requires FileRead. No shadow filesystem authority.

Compiler serializes factory through explicit placeholder; raw VM helper must inject the exact same production factory, preserve unknown/missing/unfilled checks. Other source, original packages and prior geometry/broadcast behavior remain intact.

## Verification

A owns original Harris red/regression test (and meaningful fixture if needed), never production. B owns core factory + focused behavioral tests. C owns trusted UTools glue/provider fields/compiler/helper wiring plus narrow production integration tests. No overlapping writes. Main owns contract, call-chain decisions, review and independent full relevant tests/type/build/budget. All workers are Luna, no descendants, shared dirty worktree must be preserved.

Original Snipaste2.0.1 storage function returns copiedToSystemClipboard based on immediate Boolean; actual compiled publiccopy functions must be used, not Promise stubs. Assert first-time auth failure/denial/write failure/closed session false and explicit successful retry true, no duplicate write or deferred payload. Existing original paster unconditionally sets success badge, and text path uses plainText rather than service.text; neither is fixed by this host slice. Native OS/complete UI remains pending.
