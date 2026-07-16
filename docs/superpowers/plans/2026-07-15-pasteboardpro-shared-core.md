# PasteboardPro Shared Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create the self-contained PasteboardPro workspace and framework-independent contracts consumed by both the Svelte and Vue plugins.

**Architecture:** A pnpm workspace under `plugins/pasteboard-pro` publishes local packages for domain types, query parsing, interaction state, design tokens, sync records, and deterministic fixtures. No package imports Svelte, Vue, Electron, Tauri, Node-only APIs, or browser globals.

**Tech Stack:** TypeScript 5.6+, pnpm 11, Vitest, Zod, Web Crypto-compatible types.

---

## Implemented status (2026-07-16)

Shared Core Tasks 1-6B are implemented in the isolated ZTools worktree on
`codex/pasteboardpro-ztools`. The checked-in workspace is the source of truth
for host consumers; this plan records the verified contract rather than an
unexecuted proposal.

Fresh verification used Node 24.8.0 and pnpm 11.7.0:

```bash
export PATH=/Users/harris/.nvm/versions/node/v24.8.0/bin:$PATH
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 test:contract
corepack pnpm@11.7.0 typecheck
```

Result: 9 test files and 142 tests passed, the workspace contract passed, and
the four-project TypeScript build graph passed. A separate exhaustive probe
also checked 3,905 adjacent base62 order-key pairs plus open bounds.

The only observed warning is Vite's non-blocking CJS Node API deprecation.

---

## File map

**Create under `/Users/harris/.codex/worktrees/ztools-pasteboardpro/plugins/pasteboard-pro/`:**

- `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `tsconfig.base.json`, `vitest.config.ts`
- `scripts/test-workspace-contract.mjs`
- `packages/core/tsconfig.json`
- `packages/core/src/types.ts`
- `packages/core/src/query.ts`
- `packages/core/src/selection.ts`
- `packages/core/src/pinboards.ts`
- `packages/core/src/paste-stack.ts`
- `packages/core/src/index.ts`
- `packages/core/tests/types.test.ts`
- `packages/core/tests/query.test.ts`
- `packages/core/tests/selection.test.ts`
- `packages/core/tests/pinboards.test.ts`
- `packages/core/tests/paste-stack.test.ts`
- `packages/design-tokens/tsconfig.json`
- `packages/design-tokens/src/tokens.ts`
- `packages/design-tokens/src/geometry.ts`
- `packages/design-tokens/src/index.ts`
- `packages/design-tokens/tests/geometry.test.ts`
- `packages/sync-protocol/tsconfig.json`
- `packages/sync-protocol/src/clock.ts`
- `packages/sync-protocol/src/merge.ts`
- `packages/sync-protocol/src/index.ts`
- `packages/sync-protocol/tests/clock.test.ts`
- `packages/sync-protocol/tests/merge.test.ts`
- `packages/contract-fixtures/package.json`
- `packages/contract-fixtures/tsconfig.json`
- `packages/contract-fixtures/src/freeze.ts`
- `packages/contract-fixtures/src/history.ts`
- `packages/contract-fixtures/src/keyboard.ts`
- `packages/contract-fixtures/src/sync.ts`
- `packages/contract-fixtures/src/index.ts`
- `packages/contract-fixtures/tests/fixtures.test.ts`
- `.gitignore`

### Task 1: Scaffold the isolated workspace

**Files:**
- Create: `plugins/pasteboard-pro/package.json`
- Create: `plugins/pasteboard-pro/pnpm-workspace.yaml`
- Create: `plugins/pasteboard-pro/tsconfig.json`
- Create: `plugins/pasteboard-pro/tsconfig.base.json`
- Create: `plugins/pasteboard-pro/vitest.config.ts`
- Create: `plugins/pasteboard-pro/.gitignore`

- [ ] **Step 1: Write the workspace contract test**

Create `plugins/pasteboard-pro/scripts/test-workspace-contract.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const tsconfig = JSON.parse(await readFile(new URL("tsconfig.json", root), "utf8"));
const workspace = await readFile(new URL("pnpm-workspace.yaml", root), "utf8");
const normalizedWorkspace = workspace.replace(/\r\n/g, "\n");

assert.equal(pkg.private, true);
assert.equal(pkg.packageManager, "pnpm@11.7.0");
assert.equal(pkg.scripts.test, "vitest run");
assert.deepEqual(tsconfig.files, []);
assert.equal(Array.isArray(tsconfig.references), true);
assert.equal(normalizedWorkspace, "packages:\n  - packages/*\n  - apps/*\n");
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
node plugins/pasteboard-pro/scripts/test-workspace-contract.mjs
```

Expected: FAIL because the workspace files do not exist.

- [ ] **Step 3: Add the workspace files**

`package.json`:

```json
{
  "name": "pasteboard-pro-workspace",
  "private": true,
  "packageManager": "pnpm@11.7.0",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc -b --pretty false",
    "test:contract": "node scripts/test-workspace-contract.mjs"
  },
  "devDependencies": {
    "typescript": "^5.6.3",
    "vitest": "^2.1.9",
    "zod": "^3.24.2"
  }
}
```

`pnpm-workspace.yaml`:

```yaml
packages:
  - packages/*
  - apps/*
```

`tsconfig.json`:

```json
{
  "files": [],
  "references": []
}
```

This root config is the `tsc -b` solution entry point. Later tasks add package references incrementally as each composite project is introduced.

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "declaration": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "skipLibCheck": true
  }
}
```

- [ ] **Step 4: Run the no-install contract test**

```bash
node plugins/pasteboard-pro/scripts/test-workspace-contract.mjs
```

Expected: PASS. Do not run `pnpm install` while the no-local-build constraint remains active.

- [ ] **Step 5: Commit**

```bash
git add plugins/pasteboard-pro
git commit -m "chore: 初始化 PasteboardPro 双插件工作区" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 2: Define the canonical domain schema

**Files:**
- Create: `packages/core/package.json`
- Create: `packages/core/tsconfig.json`
- Modify: `plugins/pasteboard-pro/tsconfig.json`
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/index.ts`
- Create: `packages/core/tests/types.test.ts`

- [ ] **Step 1: Write failing schema tests**

```ts
import { describe, expect, it } from "vitest";
import { PasteItemSchema, PinboardSchema } from "../src/types";

describe("PasteItem schema", () => {
  it("accepts a versioned text item and rejects an unknown kind", () => {
    expect(PasteItemSchema.parse({
      id: "item-1", kind: "text", sourceDeviceId: "mac-a",
      copiedAt: "2026-07-15T10:00:00Z", updatedAt: "2026-07-15T10:00:00Z",
      contentFingerprint: "fp-1", payload: { revision: "rev-1", text: "hello" },
      pinned: false, fieldClocks: {}
    }).id).toBe("item-1");
    expect(() => PasteItemSchema.parse({ id: "bad", kind: "audio" })).toThrow();
  });

  it("requires stable Pinboard ordering", () => {
    expect(PinboardSchema.parse({
      id: "board-1", name: "Design", color: "violet", orderKey: "a0",
      createdAt: "2026-07-15T10:00:00Z", updatedAt: "2026-07-15T10:00:00Z",
      fieldClocks: {}
    }).orderKey).toBe("a0");
  });
});
```

- [ ] **Step 2: Run the test and verify failure**

```bash
pnpm --dir plugins/pasteboard-pro test packages/core/tests/types.test.ts
```

Expected: FAIL because the schemas are missing. Run only after builds are authorized and dependencies are installed.

- [ ] **Step 3: Implement the schemas**

Create `packages/core/package.json`:

```json
{
  "name": "@pasteboard-pro/core",
  "version": "1.0.0",
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": { "zod": "^3.24.2" }
}
```

Create `packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Update the root `plugins/pasteboard-pro/tsconfig.json` so its references contain only the core project:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" }
  ]
}
```

```ts
import { z } from "zod";

export const HybridClockSchema = z.object({ wallMs: z.number().int(), counter: z.number().int().nonnegative(), deviceId: z.string().min(1) });
export type HybridClock = z.infer<typeof HybridClockSchema>;

export const PastePayloadSchema = z.object({
  revision: z.string().min(1), text: z.string().optional(), html: z.string().optional(),
  blobId: z.string().optional(), filePaths: z.array(z.string()).optional(), mediaType: z.string().optional()
});

export const PasteItemSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["text", "rich_text", "html", "url", "image", "pdf", "color", "files"]),
  title: z.string().optional(), sourceApp: z.object({ bundleId: z.string().optional(), name: z.string().optional() }).optional(),
  sourceDeviceId: z.string().min(1), copiedAt: z.string().datetime(), updatedAt: z.string().datetime(),
  contentFingerprint: z.string().min(1), payload: PastePayloadSchema, ocrText: z.string().optional(),
  pinboardId: z.string().optional(), pinboardOrderKey: z.string().optional(), pinned: z.boolean(),
  fieldClocks: z.record(HybridClockSchema)
});

export const PinboardSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), color: z.string().min(1), orderKey: z.string().min(1),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime(), fieldClocks: z.record(HybridClockSchema)
});
```

- [ ] **Step 4: Run schema tests**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add plugins/pasteboard-pro/packages/core plugins/pasteboard-pro/tsconfig.json
git commit -m "feat: 定义 PasteboardPro 共享数据契约" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 3: Implement query parsing and deterministic filtering

**Files:**
- Create: `packages/core/src/query.ts`
- Create: `packages/core/tests/query.test.ts`

- [ ] **Step 1: Write failing search tests**

```ts
it("combines text, type, app and date filters", () => {
  const query = parsePasteQuery('roadmap type:image app:"Preview" date:week');
  expect(query).toEqual({ text: ["roadmap"], types: ["image"], apps: ["Preview"], dates: ["week"] });
});

it("matches OCR and preserves newest-first ties", () => {
  expect(searchPasteItems(historyFixture, "invoice").map(item => item.id)).toEqual(["image-new", "text-old"]);
});
```

- [ ] **Step 2: Verify red state**

Run the focused Vitest file. Expected: missing exports.

- [ ] **Step 3: Implement the parser and search API**

```ts
export type PasteQuery = { text: string[]; types: string[]; apps: string[]; devices: string[]; dates: string[]; pinboards: string[] };

export function parsePasteQuery(input: string): PasteQuery {
  const result: PasteQuery = { text: [], types: [], apps: [], devices: [], dates: [], pinboards: [] };
  for (const token of tokenizeQuoted(input)) {
    const [key, value] = splitFilter(token);
    if (key === "type") result.types.push(value);
    else if (key === "app" || key === "from") result.apps.push(value);
    else if (key === "device") result.devices.push(value);
    else if (key === "date") result.dates.push(value);
    else if (key === "pinboard" || key === "board") result.pinboards.push(value);
    else result.text.push(token.toLocaleLowerCase());
  }
  return result;
}
```

`searchPasteItems()` must search title, text/html/url payloads, source metadata, file names, and OCR text, then sort by score and `copiedAt` descending.

- [ ] **Step 4: Run query tests**

Expected: PASS for quoted filters, aliases, OCR, empty query, and stable ordering.

- [ ] **Step 5: Commit**

```bash
git add plugins/pasteboard-pro/packages/core/src/query.ts plugins/pasteboard-pro/packages/core/tests/query.test.ts
git commit -m "feat: 实现剪贴板搜索与过滤契约" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 4: Implement interaction state machines

**Files:**
- Create: `packages/core/src/selection.ts`
- Create: `packages/core/src/pinboards.ts`
- Create: `packages/core/src/paste-stack.ts`
- Create: `packages/core/tests/selection.test.ts`
- Create: `packages/core/tests/pinboards.test.ts`
- Create: `packages/core/tests/paste-stack.test.ts`

- [ ] **Step 1: Write failing keyboard, ordering, and stack tests**

```ts
expect(reduceSelection({ selected: ["a"], anchor: "a" }, { type: "extend", orderedIds: ["a", "b", "c"], direction: 1 }).selected).toEqual(["a", "b"]);
expect(orderKeyBetween("a0", "a2")).toBe("a1");
expect(reducePasteStack({ direction: "forward", itemIds: ["a", "b"] }, { type: "consume" }).itemIds).toEqual(["b"]);
```

- [ ] **Step 2: Verify failures**

Run the three focused test files. Expected: missing reducers.

- [ ] **Step 3: Implement pure reducers**

Expose these stable signatures:

```ts
export function reduceSelection(state: SelectionState, action: SelectionAction): SelectionState;
export function orderKeyBetween(before?: string, after?: string): string;
export function reducePasteStack(state: PasteStackState, action: PasteStackAction): PasteStackState;
```

Reducers must not read DOM state, current time, random values, or host APIs.

- [ ] **Step 4: Run focused and package tests**

Expected: PASS including multi-select restoration and reverse-stack consumption.

- [ ] **Step 5: Commit**

```bash
git add plugins/pasteboard-pro/packages/core
git commit -m "feat: 增加选择看板与 Paste Stack 状态机" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 5: Define design tokens and edge-aware geometry

**Files:**
- Create: `packages/design-tokens/package.json`
- Create: `packages/design-tokens/tsconfig.json`
- Modify: `plugins/pasteboard-pro/tsconfig.json`
- Create: `packages/design-tokens/src/tokens.ts`
- Create: `packages/design-tokens/src/geometry.ts`
- Create: `packages/design-tokens/tests/geometry.test.ts`

- [ ] **Step 1: Write failing dock geometry tests**

```ts
expect(shelfRadius("floating")).toEqual({ topLeft: 28, topRight: 28, bottomRight: 28, bottomLeft: 28 });
expect(shelfRadius("bottom")).toEqual({ topLeft: 28, topRight: 28, bottomRight: 0, bottomLeft: 0 });
expect(resolveDockEdge({ x: 5, y: 400, width: 900, height: 260 }, display, 12)).toBe("left");
```

- [ ] **Step 2: Verify failure**

Expected: geometry exports do not exist.

- [ ] **Step 3: Implement shared tokens**

Create `packages/design-tokens/package.json` with name `@pasteboard-pro/design-tokens`, version `1.0.0`, type `module`, and export `./src/index.ts`.

Create `packages/design-tokens/tsconfig.json` as an independent composite project:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"]
}
```

Update the root `plugins/pasteboard-pro/tsconfig.json` to retain core and add design tokens:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/design-tokens" }
  ]
}
```

```ts
export const pasteboardTokens = {
  radius: 28, snapZone: 12, dockTransitionMs: 160,
  cardGap: 12, expandedCardWidth: 220, compactCardWidth: 148,
  glassBorder: "rgba(255,255,255,0.32)", glassBlurPx: 26
} as const;
```

Implement `shelfRadius()` for `floating | bottom | left | right` and clamp bounds to the visible display work area.

- [ ] **Step 4: Run geometry tests**

Expected: PASS for all four radius states, snap threshold, and multi-display work areas.

- [ ] **Step 5: Commit**

```bash
git add plugins/pasteboard-pro/packages/design-tokens plugins/pasteboard-pro/tsconfig.json
git commit -m "feat: 固化 PasteboardPro 视觉与停靠 token" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 6A: Implement clocks and deterministic merge rules

**Files:**
- Create: `packages/sync-protocol/package.json`
- Create: `packages/sync-protocol/tsconfig.json`
- Create: `packages/sync-protocol/src/clock.ts`
- Create: `packages/sync-protocol/src/merge.ts`
- Create: `packages/sync-protocol/tests/clock.test.ts`
- Create: `packages/sync-protocol/tests/merge.test.ts`
- Modify: `plugins/pasteboard-pro/tsconfig.json`

- [x] **Step 1: Write failing merge tests**

```ts
expect(compareClock({ wallMs: 10, counter: 0, deviceId: "a" }, { wallMs: 10, counter: 0, deviceId: "b" })).toBeLessThan(0);
expect(mergePasteItem(localTitleEdit, remotePinboardEdit)).toMatchObject({ title: "Local title", pinboardId: "board-2" });
expect(mergeEntity(oldEdit, newerTombstone).deleted).toBe(true);
```

- [x] **Step 2: Verify failures**

Expected: missing clock and merge modules.

- [x] **Step 3: Implement deterministic clocks and field merge**

Create `packages/sync-protocol/package.json` with name `@pasteboard-pro/sync-protocol`, version `1.0.0`, type `module`, dependency `@pasteboard-pro/core: workspace:*`, and export `./src/index.ts`.

Create `packages/sync-protocol/tsconfig.json` with a project reference to core:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "references": [
    { "path": "../core" }
  ]
}
```

```ts
export function compareClock(a: HybridClock, b: HybridClock): -1 | 0 | 1 {
  // Compare each component explicitly so extreme wall times cannot overflow.
}

export function pickNewer<T>(left: T, leftClock: HybridClock, right: T, rightClock: HybridClock): T {
  // Return the newer value. Equal clocks accept only Object.is-equal values;
  // conflicting values throw RangeError in both merge orders.
}
```

`mergePasteItem()` merges title, payload, OCR text, Pinboard membership/order,
and pinned state independently. A payload revision is immutable: identical
revision IDs with different payload content are rejected. All winning paths
deep-clone payloads, file path arrays, field clocks, live entities, and
tombstones. Equal clocks with different values are rejected to preserve
commutativity, and a tombstone wins an exact live-clock tie to prevent silent
resurrection.

- [x] **Step 4: Run focused merge tests**

Expected and verified: clock ordering, field-level merge, payload revision
invariants, tombstone anti-resurrection, prototype-safe field clocks,
commutativity, and input isolation all pass.

- [x] **Step 5: Commit**

The implementation was committed in focused RED/GREEN/review increments rather
than one combined commit.

### Task 6B: Add fixed cross-host contract fixtures

**Files:**
- Create: `packages/contract-fixtures/package.json`
- Create: `packages/contract-fixtures/tsconfig.json`
- Create: `packages/contract-fixtures/src/freeze.ts`
- Create: `packages/contract-fixtures/src/history.ts`
- Create: `packages/contract-fixtures/src/keyboard.ts`
- Create: `packages/contract-fixtures/src/sync.ts`
- Create: `packages/contract-fixtures/src/index.ts`
- Create: `packages/contract-fixtures/tests/fixtures.test.ts`
- Modify: `plugins/pasteboard-pro/package.json`
- Modify: `plugins/pasteboard-pro/pnpm-lock.yaml`
- Modify: `plugins/pasteboard-pro/tsconfig.json`

- [x] **Step 1: Add shared fixtures**

Create `packages/contract-fixtures/package.json` with name
`@pasteboard-pro/contract-fixtures`, version `1.0.0`, `private: true`, type
`module`, dependencies on the core and sync packages, and native Node 24 source
exports for `.`, `./history`, `./keyboard`, and `./sync`. Export fixed history,
Pinboards, keyboard event sequences, concurrent edits, tombstones, and the
AES-256-GCM zero vector. Do not generate fixture timestamps or IDs at runtime.

Use recursive `deepFreeze()` plus `ReadonlyDeep<T>` so every exported fixture
is deeply read-only at runtime and in TypeScript. Keep the private `#freeze`
package import unexported.

Create `packages/contract-fixtures/tsconfig.json` with project references to core and sync protocol:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "rootDir": ".",
    "outDir": "dist"
  },
  "include": ["src/**/*.ts", "tests/**/*.ts"],
  "references": [
    { "path": "../core" },
    { "path": "../sync-protocol" }
  ]
}
```

Update the root `plugins/pasteboard-pro/tsconfig.json` to contain the final shared-core project graph:

```json
{
  "files": [],
  "references": [
    { "path": "./packages/core" },
    { "path": "./packages/design-tokens" },
    { "path": "./packages/sync-protocol" },
    { "path": "./packages/contract-fixtures" }
  ]
}
```

- [x] **Step 2: Run all shared tests, package-contract checks, and typecheck**

```bash
export PATH=/Users/harris/.nvm/versions/node/v24.8.0/bin:$PATH
corepack pnpm@11.7.0 test
corepack pnpm@11.7.0 test:contract
corepack pnpm@11.7.0 typecheck
```

Expected and verified: 9 files / 142 tests pass, the package root and all three
fixture subpaths load through Node 24 native ESM, and the four referenced
composite projects typecheck.

- [x] **Step 3: Commit**

The fixtures, public exports, and boundary hardening were committed separately
so each review fix remains auditable.
