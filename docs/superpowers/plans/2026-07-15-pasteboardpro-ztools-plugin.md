# PasteboardPro ZTools Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Vue 3 ZTools PasteboardPro plugin with canonical local records, native floating shelf behavior, direct paste, local OCR, and the same interaction contract as the ATools Svelte plugin.

**Architecture:** The plugin mirrors `window.ztools.clipboard` history into its private canonical store, uses ZTools `createBrowserWindow` for the shelf, and delegates OCR/Keychain operations to narrow macOS helpers. Vue components consume only shared reducers, tokens, schemas, and adapter interfaces.

**Tech Stack:** Vue 3, TypeScript, Vite, Vitest, ZTools preload APIs, Node/Electron, Swift Vision helper, macOS Keychain.

---

## Implemented status (2026-07-16)

Implemented on `codex/pasteboardpro-ztools`:

- Vue/Vite plugin manifest, renderer/preload build graph, source package verifier,
  and repository category mapping.
- Canonical ZTools history mirror with cursor restart, privacy pre-filtering,
  PouchDB-style persistence, real `search_history`, and direct-paste fallback.
- Floating shelf geometry, multi-display fallback, edge-aware corners, content
  protection, duplicate-window reuse, and same-preload child-window bridge.
- Capture pause, ignored apps, secret detection, bounded regex rules, 90-day / 1
  GiB retention execution, failure reporting, and owned-blob cleanup contract.
- Pinboard create/rename/fractional ordering, canonical card assignment, and
  multi-selection drag/drop.
- Vue timeline, search, preview, Quick Paste 1-9, selection, Compact mode, and
  Paste Stack state using the shared reducers and tokens.
- Swift Vision helper source plus constrained JSON-line Node caller. The helper
  is not compiled locally; release and PR workflows build it on macOS, while
  release requires Developer ID signing and notarization secrets.
- ZTools release assembly verifier and `build-plugin.sh` integration so the
  repository packages only `plugins/pasteboard-pro/dist/ztools`.

Fresh lightweight verification:

```bash
export PATH=/Users/harris/.nvm/versions/node/v24.8.0/bin:$PATH
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 test:contract
corepack pnpm@11.7.0 typecheck
corepack pnpm@11.7.0 --filter @pasteboard-pro/ztools typecheck
node apps/ztools/scripts/verify-package.mjs
```

Result: 18 test files / 184 tests passed, TypeScript and Vue template checks
passed, both workflow YAML files parsed, and the source package contract passed.

Still unverified or incomplete: real ZTools activation, compiled helper runtime,
Developer ID/notarization secrets, assembled ZIP verification, real capture and
paste permissions, image rotation/editing, Pinboard deletion, encrypted WebDAV,
visual screenshot parity, and performance evidence.

---

## File map

**Create under `plugins/pasteboard-pro/apps/ztools/`:**

- `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`
- `public/plugin.json`, `public/package.json`, `public/logo.png`
- `preload/index.ts`, `preload/clipboard-store.ts`, `preload/keychain.ts`, `preload/window.ts`, `preload/ocr.ts`, `preload/tools.ts`
- `src/main.ts`, `src/App.vue`, `src/adapter.ts`, `src/state.ts`
- `src/components/Shelf.vue`, `src/components/Toolbar.vue`, `src/components/Timeline.vue`, `src/components/PasteCard.vue`
- `src/components/SearchBar.vue`, `src/components/PinboardStrip.vue`, `src/components/Preview.vue`, `src/components/PasteStack.vue`
- `src/styles/tokens.css`, `src/styles/glass.css`, `src/styles/layout.css`
- `tests/adapter.test.ts`, `tests/keyboard.test.ts`, `tests/window.test.ts`, `tests/visual-state.test.ts`
- `native/vision-helper/main.swift`, `native/vision-helper/build.sh`
- `scripts/assemble-dist.mjs`, `scripts/verify-package.mjs`

### Task 1: Scaffold the Vue plugin and manifest

**Files:**
- Create: `apps/ztools/package.json`
- Create: `apps/ztools/vite.config.ts`
- Create: `apps/ztools/public/plugin.json`
- Create: `apps/ztools/preload/index.ts`
- Create: `apps/ztools/scripts/verify-package.mjs`

- [ ] **Step 1: Write the failing package verifier**

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("public/plugin.json", root), "utf8"));
assert.equal(manifest.name, "pasteboard-pro");
assert.equal(manifest.main, "index.html");
assert.equal(manifest.preload, "preload.js");
assert.deepEqual(manifest.platform, ["darwin", "win32", "linux"]);
assert.ok(manifest.features.some(feature => feature.code === "pasteboard-pro"));
assert.ok(manifest.tools.search_history);
```

- [ ] **Step 2: Verify failure**

```bash
node plugins/pasteboard-pro/apps/ztools/scripts/verify-package.mjs
```

Expected: FAIL because the manifest is missing.

- [ ] **Step 3: Add the manifest and package scripts**

Create `apps/ztools/package.json`:

```json
{
  "name": "@pasteboard-pro/ztools",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "test": "vitest run", "verify": "node scripts/verify-package.mjs" },
  "dependencies": {
    "@pasteboard-pro/core": "workspace:*",
    "@pasteboard-pro/design-tokens": "workspace:*",
    "@pasteboard-pro/contract-fixtures": "workspace:*",
    "vue": "^3.5.22"
  }
}
```

```json
{
  "name": "pasteboard-pro",
  "title": "PasteboardPro",
  "description": "Paste-style local clipboard history, Pinboards and Paste Stack",
  "version": "1.0.0",
  "main": "index.html",
  "preload": "preload.js",
  "logo": "logo.png",
  "platform": ["darwin", "win32", "linux"],
  "features": [{ "code": "pasteboard-pro", "explain": "打开 PasteboardPro", "cmds": ["剪贴板", "PasteboardPro", "clipboard"] }],
  "tools": { "search_history": { "description": "搜索本地剪贴板历史", "inputSchema": { "type": "object", "properties": { "query": { "type": "string" }, "limit": { "type": "integer", "minimum": 1, "maximum": 100 } } } }
}
```

- [ ] **Step 4: Run the no-build verifier**

Expected: PASS. Do not install/build under the current disk constraint.

- [ ] **Step 5: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools
git commit -m "chore: 初始化 PasteboardPro ZTools 插件" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 2: Mirror ZTools history into the canonical store

**Files:**
- Create: `preload/clipboard-store.ts`
- Create: `tests/adapter.test.ts`
- Modify: `preload/index.ts`

- [ ] **Step 1: Write failing adapter tests**

```ts
it("normalizes host text, image and file items", async () => {
  const items = await adapter.importHostHistory(hostFixture);
  expect(items.map(item => item.kind)).toEqual(["text", "image", "files"]);
});

it("does not duplicate an unchanged host item", async () => {
  await adapter.importHostHistory(hostFixture);
  await adapter.importHostHistory(hostFixture);
  expect(await store.count()).toBe(3);
});
```

- [ ] **Step 2: Verify failure**

Run the focused Vitest file after dependency installation is authorized.

- [ ] **Step 3: Implement the adapter contract**

```ts
export interface ZToolsClipboardHost {
  getHistory(page: number, pageSize: number, query?: string): Promise<{ items: unknown[]; total: number }>;
  onChange(callback: () => void): void;
  write(id: string, shouldPaste: boolean): Promise<void>;
  writeContent(input: { type: string; content: unknown }, shouldPaste: boolean): Promise<void>;
}
```

Store canonical metadata in `window.ztools.db.promises`; store image/PDF bytes under a plugin-private directory returned from `window.ztools.getPath("appData")`. Use atomic temp-file rename for blob writes.

- [ ] **Step 4: Seed and subscribe**

On plugin initialization, page through host history until exhausted, then subscribe to `clipboard.onChange()` and import only the latest page. Persist the last normalized host timestamp/ID cursor.

On Windows/Linux, keep history browsing, search, Pinboards, copy, and metadata previews enabled; mark macOS-only OCR, native direct-paste guarantees, content protection, and Liquid Glass window behavior unavailable without blocking plugin activation.

- [ ] **Step 5: Run adapter tests**

Expected: PASS for normalization, deduplication, deleted file metadata, and cursor restart.

- [ ] **Step 6: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools/preload plugins/pasteboard-pro/apps/ztools/tests/adapter.test.ts
git commit -m "feat: 镜像 ZTools 剪贴板历史" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 3: Add privacy, retention, and direct paste paths

**Files:**
- Create: `preload/privacy.ts`
- Modify: `preload/clipboard-store.ts`
- Create: `tests/privacy.test.ts`

- [ ] **Step 1: Write failing privacy tests**

```ts
expect(shouldPersist({ sourceBundleId: "com.1password.1password", text: "secret" }, rules)).toBe(false);
expect(shouldPersist({ sourceBundleId: "com.apple.TextEdit", text: "hello" }, rules)).toBe(true);
expect(prunePlan(expiredItems, { days: 90, maxBlobBytes: 1_073_741_824 }).deletedIds).not.toContain("pinboard-item");
```

- [ ] **Step 2: Verify failure**

Expected: privacy/prune functions are missing.

- [ ] **Step 3: Implement pre-persistence gates**

Apply ignored app IDs, transient/confidential flags exposed by host data, token rules, and literal/wildcard/regex user rules before storing plugin metadata or copying blobs.

Persist pause state and optional resume time. While paused, `clipboard.onChange()` advances the host cursor but does not store canonical items, preventing a paused burst from being imported later.

- [ ] **Step 4: Implement direct paste fallback**

For host-native items call `clipboard.write(id, true)`. For synced/plugin-owned items call `writeContent()` with the canonical payload. If direct paste fails, retry with `shouldPaste=false` and return `accessibility_required` to the UI.

- [ ] **Step 5: Run tests**

Expected: PASS for privacy, 90-day retention, 1 GiB budget, Pinboard protection, and copy-only fallback.

- [ ] **Step 6: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools/preload plugins/pasteboard-pro/apps/ztools/tests
git commit -m "feat: 增加 ZTools 隐私保留与粘贴策略" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 4: Create the real floating shelf and docking behavior

**Files:**
- Create: `preload/window.ts`
- Create: `tests/window.test.ts`
- Modify: `preload/index.ts`

- [ ] **Step 1: Write failing BrowserWindow option tests**

```ts
expect(buildShelfWindowOptions(display, "bottom")).toMatchObject({
  transparent: true, frame: false, alwaysOnTop: true, skipTaskbar: true,
  minimizable: false, maximizable: false, fullscreenable: false
});
expect(buildShelfWindowOptions(display, "bottom").y).toBe(display.workArea.y + display.workArea.height - 280);
```

- [ ] **Step 2: Verify failure**

Expected: missing window module.

- [ ] **Step 3: Implement `createBrowserWindow` integration**

```ts
export function openShelf(initial: ShelfWindowState) {
  return window.ztools.createBrowserWindow("index.html?shelf=1", buildShelfWindowOptions(resolveDisplay(), initial.edge), onReady);
}
```

Use the shared 12 px snap zone, 160 ms transition token, per-display state, visible work area, and dock-specific radius classes.

Call `BrowserWindow.setContentProtection(true)` when screen-share protection is enabled and verify the state through the window adapter test double.

- [ ] **Step 4: Add lifecycle behavior**

Hide the ZTools main window after the shelf is ready; close/reuse the previous shelf on repeated activation; restore the prior frontmost app before direct paste.

- [ ] **Step 5: Run tests**

Expected: PASS for floating/bottom/left/right bounds, multi-display restoration, and duplicate-window prevention.

- [ ] **Step 6: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools/preload/window.ts plugins/pasteboard-pro/apps/ztools/tests/window.test.ts plugins/pasteboard-pro/apps/ztools/preload/index.ts
git commit -m "feat: 增加 ZTools PasteboardPro 浮窗" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 5: Build the constrained macOS Vision helper

**Files:**
- Create: `native/vision-helper/main.swift`
- Create: `native/vision-helper/build.sh`
- Create: `preload/ocr.ts`
- Create: `tests/ocr-helper-contract.test.ts`

- [ ] **Step 1: Write the helper protocol test**

The helper accepts one JSON line and returns one JSON line:

```json
{"requestId":"req-1","imagePath":"/absolute/input.png"}
{"requestId":"req-1","ok":true,"text":"recognized text"}
```

Reject relative paths, missing files, non-image UTI values, extra commands, and payloads larger than 8 KiB.

- [ ] **Step 2: Verify failure**

Run the TypeScript protocol test against a missing helper fixture. Expected: FAIL.

- [ ] **Step 3: Implement the Swift helper**

Use `VNRecognizeTextRequest`, `CGImageSourceCreateWithURL`, and JSONEncoder/JSONDecoder. The process performs no network requests and exposes no shell execution.

- [ ] **Step 4: Implement the Node caller**

Use `spawn()` with an absolute bundled helper path, `stdio: ["pipe", "pipe", "pipe"]`, a 15-second timeout, and a 1 MiB stdout limit. Never pass user content through shell command strings.

- [ ] **Step 5: Build and sign only after authorization**

```bash
./plugins/pasteboard-pro/apps/ztools/native/vision-helper/build.sh
codesign --verify --deep --strict plugins/pasteboard-pro/apps/ztools/native/vision-helper/dist/pasteboard-vision
```

Expected: build PASS and signature verification PASS. Missing signing identity remains an explicit release blocker.

- [ ] **Step 6: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools/native plugins/pasteboard-pro/apps/ztools/preload/ocr.ts plugins/pasteboard-pro/apps/ztools/tests/ocr-helper-contract.test.ts
git commit -m "feat: 增加本地 Vision OCR 适配" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 6: Implement the Vue UI from shared behavior contracts

**Files:**
- Create: `src/components/Shelf.vue`
- Create: `src/components/Toolbar.vue`
- Create: `src/components/Timeline.vue`
- Create: `src/components/PasteCard.vue`
- Create: `src/components/SearchBar.vue`
- Create: `src/components/PinboardStrip.vue`
- Create: `src/components/Preview.vue`
- Create: `src/components/PasteStack.vue`
- Create: `src/styles/tokens.css`
- Create: `src/styles/glass.css`
- Create: `src/styles/layout.css`
- Create: `src/App.vue`
- Create: `src/adapter.ts`
- Create: `src/state.ts`
- Create: `tests/keyboard.test.ts`
- Create: `tests/visual-state.test.ts`

- [ ] **Step 1: Write failing parity tests**

Replay `@pasteboard-pro/contract-fixtures/keyboard` and assert the same selected IDs as the Svelte app. Assert dock classes and card width tokens for Expanded/Compact modes.

- [ ] **Step 2: Verify failure**

Expected: components and adapter do not exist.

- [ ] **Step 3: Implement focused components**

Create `Shelf`, `Toolbar`, `Timeline`, `PasteCard`, `SearchBar`, `PinboardStrip`, `Preview`, and `PasteStack`. Use the shared reducers/tokens; no Element Plus, PrimeVue, or general-purpose component library.

Component/adapter tests must cover text creation, rename/edit, image rotation, OCR text copying, Pinboard drag/drop, multi-select, plain-text paste, Quick Paste 1–9, pause capture, and Paste Stack direction/consumption.

- [ ] **Step 4: Add accessibility and motion behavior**

Use roving tab index, visible focus, `aria-selected`, `aria-live` for sync/capture state, and `prefers-reduced-motion` to disable the 160 ms docking transition.

- [ ] **Step 5: Run component tests**

```bash
pnpm --dir plugins/pasteboard-pro --filter @pasteboard-pro/ztools test
```

Expected: PASS after builds are authorized.

- [ ] **Step 6: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools/src plugins/pasteboard-pro/apps/ztools/tests
git commit -m "feat: 实现 PasteboardPro Vue 交互界面" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 7: Register tools, assemble the package, and close ZTools verification

**Files:**
- Create: `preload/tools.ts`
- Create: `scripts/assemble-dist.mjs`
- Modify: `package.json`, `public/plugin.json`
- Modify: `/Users/harris/.codex/worktrees/ztools-pasteboardpro/categories-mapping.json`

- [ ] **Step 1: Write failing tool tests**

Require `search_history` to return canonical items with redacted/truncated outputs and `total`. The handler must be registered through `window.ztools.registerTool`.

- [ ] **Step 2: Implement the handler**

```ts
window.ztools.registerTool("search_history", async ({ query = "", limit = 10 }) => {
  const items = await store.search(String(query), Math.max(1, Math.min(100, Number(limit))));
  return { items: items.map(toToolResult), total: items.length };
});
```

- [ ] **Step 3: Assemble the dist package**

`assemble-dist.mjs` must copy the built Vue assets, `plugin.json`, `preload.js`, logo, and signed helper into `plugins/pasteboard-pro/dist/ztools/` without source maps, node_modules, credentials, or local databases.

- [ ] **Step 4: Verify package shape**

```bash
node plugins/pasteboard-pro/apps/ztools/scripts/verify-package.mjs
node plugins/pasteboard-pro/apps/ztools/scripts/assemble-dist.mjs --verify-only
```

Expected: PASS; helper signature and all manifest paths resolve.

- [ ] **Step 5: Add the plugin category**

Add `pasteboard-pro` to the productivity category without modifying unrelated existing entries.

- [ ] **Step 6: Run ZTools build only after authorization**

```bash
node scripts/detect-changes.js
node scripts/build-plugins.js
```

Expected: the release ZIP contains only the assembled ZTools package and passes the repository verifier.

- [ ] **Step 7: Commit**

```bash
git add plugins/pasteboard-pro categories-mapping.json
git commit -m "feat: 完成 PasteboardPro ZTools 插件打包" \
  -m "AI-Co-Authored-By: Codex"
```
