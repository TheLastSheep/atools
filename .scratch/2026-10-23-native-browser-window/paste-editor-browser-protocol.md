# Task15 main-owned original editor browser protocol

The full objective remains ZTools parity, Harris originals first. Previous Task14 made real progress: two production modules fixed plus42 test files/351 passing invocations. No goal completion or native acceptance is inferred. GUI/App/AppleScript/system clipboard/global input hooks remain deferred.

## Frozen original entry

Read-only root `/Users/harris/Desktop/ZTools-plugins/plugins/pasteboard-pro/dist/ztools`.
Keep Task14 preload/chunk/worker pins and default source/runtime/payload budgets. Additional original assets:

- `assets/index-4mPfCjok.js`:257678B, SHA256 `1b2c8707c70131dacc782a55a949bf43b8a75c390633b0f880835b9e1503bfe2`.
- `assets/index-Cu7SjoI2.css`:68597B, SHA256 `5da7c41ec84c48edfc9d0ceb31e54a2f33e7393c32f02fcc237b31872838ecd4`.
- `logo.png`:241870B, SHA256 `fd3e919353fb07c5ef8bb4c1214a50b308a96d1705d569e01797bcb950611ef0`.

Load the real compiled Vue UI at `https://pasteboard-pro.fixture.invalid/?panel=editor&mode=create`. This is the original independent editor entry. Do not change URL-role classification to make a shelf/panel become the primary, or replace original UI/store/search functions. Use production `createPluginRuntimePreload.prepare`, `createPluginBridgeDocument` and HTML injection. Actual appVersion3.0.0 and original compatibility gate remain intact. Reuse Task14 real isolated product Node22.23.3 bootstrap/codec/Worker and temporary persistent SQLite.

## Browser and controlled boundaries

No Playwright/ui-skills package installation. Reuse existing `scripts/chrome-cdp-smoke-utils.mjs` headless Chrome with a new private temp profile, and the project's Vitest node environment or existing browser tier. Browser tests must be explicitly opt-in so normal unit runs do not unexpectedly launch Chrome. Do not connect to an existing user tab/browser or use native desktop controls.

Measured browser-fixture adjustment on this Mac/Chrome155: the strict Node fixture environment makes a minimal intercepted page stall before Fetch. Changing only Chrome's `HOME` field to `os.userInfo().homedir` makes the same page load; identity/temp/session/allocator and private CF home variants did not. Chrome therefore uses a newly constructed whitelisted environment with that one OS-home override and a private `--user-data-dir`; it is not a fully isolated Chrome home/configuration claim. Original plugin Node retains its separate temporary HOME and permission bounds. Do not spread ambient environment or infer that this environment adjustment changes product behavior. Evidence: `output/playwright/paste-original-editor/transport-probe-main.json`, `transport-isolated-probe-main.json`, `environment-matrix-main.json`, `environment-home-matrix-main.json`; all measured Chrome PIDs exited and ESRCH was checked.

Serve only hash-pinned original index/assets/logo using CDP Fetch interception or existing bounded static fixture tools. Allow only this fixture origin and the exact tokenized Task14 loopback endpoints; deny/record external requests, popups, downloads and unexpected native/IPC calls. Do not add a product network service or weaken production permissions. Test grants/data/clipboard/parent notifications are controlled ports, not proof of Rust/TaskRun/native window delivery. Any needed parent notification mock must validate the exact original method/channel/payload and record it; no broad null success. Do not fake parent history RPC or original bridge methods to expand this slice into unproved Shelf/preview coverage.

## Fixed operation and pass criteria

Title `ATools editor fixture`; body `Invoice #1042\n固定文本验收 — keep exact bytes.` (the sequence denotes a real newline). Operate the actual DOM by observed inputs and Chrome input events, not by directly invoking createTextItem or assigning Vue state.

1. Observe original editor form and disabled-save state for empty input. Capture actual screenshot/layout.
2. Type title/body into original controls. Inject exactly one explicit fixture `db.put` failure for the new canonical record before any commit. Verify visible failure, original inputs retained, save becomes usable, and no new persisted record.
3. Explicitly click save again. Verify one successful canonical record with exact title/body, trace real db.put, and confirm the expected close request/actual document close without claiming native OS window behavior.
4. Reopen the same original entry in a new document, reopen SQLite, and read the saved record through the original bridge API or actual persistent fixture (not synthetic UI fixtures). Do not claim this proves edit/preview UI reload if only readback was verified.
5. Dispose browser documents/Chrome/Node/Worker/listener/DB and all temporary files on success and failures. Recheck original pins. Preserve first failures and final output under `output/playwright/paste-original-editor/`.

If the actual entry requires an unimplemented production interface, preserve precise failure/call chain and report it for main coordination; do not silently create permissive ports or change original code. Every new/touched code file≤500 lines. Separate document generation from JSDOM execution if sharing Task14 frame code. No Git mutations, dependency installation or installed App replacement.

## Allocation

paste_startup_coverage owns only the new opt-in browser test and meaningful fixtures, plus extracting shared document construction from `tests/fixtures/paste-startup/frame-fixture.ts` when needed. Task14 Node worker/DB/manager and all production modules remain frozen. No descendants. Main owns call chain, permission/interface boundaries, review, independent run and acceptance. Other agents may inspect other packages read-only; do not overwrite shared edits.
