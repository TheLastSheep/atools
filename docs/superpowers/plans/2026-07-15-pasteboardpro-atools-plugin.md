# PasteboardPro ATools Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the ATools native Pasteboard Runtime and ship the Svelte PasteboardPro plugin against the same Capability/TaskRun/MCP pipeline.

**Architecture:** `atools-core` owns durable pasteboard records and migrations; `src-tauri` owns native capture, OCR, direct paste, blobs, secure credentials, commands, and shelf window management. A narrow `window.atools.pasteboard` bridge connects the external Svelte plugin to that runtime.

**Tech Stack:** Rust, rusqlite, Tauri 2, objc2 AppKit/Vision, macOS Keychain, Svelte 5, Vite, Vitest, existing ATools Node contract tests.

---

## File map

**Create in ATools:**

- `crates/atools-core/src/pasteboard.rs`
- `crates/atools-core/tests/pasteboard_tests.rs`
- `src-tauri/src/pasteboard_runtime.rs`
- `src-tauri/src/pasteboard_native.rs`
- `src-tauri/src/pasteboard_window.rs`
- `src-tauri/tests/pasteboard_runtime_tests.rs`
- `src/lib/pasteboardBridge.ts`
- `scripts/test-pasteboard-plugin-bridge.mjs`
- `scripts/test-pasteboard-shelf-window.mjs`

**Modify in ATools:**

- `crates/atools-core/src/lib.rs`
- `crates/atools-core/src/config.rs`
- `crates/atools-core/src/db.rs`
- `Cargo.toml`, `src-tauri/Cargo.toml`, `Cargo.lock`
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/agent_tools.rs`
- `src-tauri/src/window.rs`
- `src/components/PluginPanel.svelte`
- `src/lib/types.ts`
- `src/lib/pluginBridgeCapabilities.ts`
- `src/lib/pluginInvokePolicy.ts`
- `src/lib/pluginRuntimePermissions.ts`
- `package.json`, `docs/macos-smoke-checklist.md`

**Create in the plugin workspace:**

- `plugins/pasteboard-pro/apps/atools/package.json`
- `plugins/pasteboard-pro/apps/atools/src/main.ts`
- `plugins/pasteboard-pro/apps/atools/src/App.svelte`
- `plugins/pasteboard-pro/apps/atools/src/adapter.ts`
- `plugins/pasteboard-pro/apps/atools/src/state.ts`
- `plugins/pasteboard-pro/apps/atools/src/components/Shelf.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/Toolbar.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/Timeline.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/PasteCard.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/SearchBar.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/PinboardStrip.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/Preview.svelte`
- `plugins/pasteboard-pro/apps/atools/src/components/PasteStack.svelte`
- `plugins/pasteboard-pro/apps/atools/public/plugin.json`
- `plugins/pasteboard-pro/apps/atools/public/package.json`
- `plugins/pasteboard-pro/apps/atools/tests/keyboard.test.ts`
- `plugins/pasteboard-pro/apps/atools/tests/visual-state.test.ts`
- `plugins/pasteboard-pro/apps/atools/scripts/assemble-dist.mjs`

### Task 1: Add durable pasteboard records and blob paths

**Files:**
- Create: `crates/atools-core/src/pasteboard.rs`
- Modify: `crates/atools-core/src/lib.rs`
- Modify: `crates/atools-core/src/config.rs`
- Modify: `crates/atools-core/src/db.rs`
- Create: `crates/atools-core/tests/pasteboard_tests.rs`

- [ ] **Step 1: Write failing storage tests**

```rust
#[test]
fn pasteboard_item_round_trips_and_preserves_pinboards() {
    let db = Database::in_memory().unwrap();
    db.upsert_pasteboard_item(&text_item("item-1", "hello")).unwrap();
    db.upsert_pinboard(&pinboard("board-1", "Design", "a0")).unwrap();
    db.assign_pasteboard_item("item-1", Some("board-1"), Some("a0")).unwrap();
    assert_eq!(db.get_pasteboard_item("item-1").unwrap().unwrap().pinboard_id.as_deref(), Some("board-1"));
}

#[test]
fn pruning_never_removes_pinboard_items() {
    let db = Database::in_memory().unwrap();
    // insert one expired regular item and one expired Pinboard item
    assert_eq!(db.prune_pasteboard_history("2026-04-16T00:00:00Z", 1_073_741_824).unwrap().deleted_items, 1);
}
```

- [ ] **Step 2: Run and verify failure**

```bash
cargo test -p atools-core --test pasteboard_tests
```

Expected: FAIL because pasteboard types and database methods are missing.

- [ ] **Step 3: Define the Rust domain types**

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PasteboardItem {
    pub id: String,
    pub kind: PasteboardItemKind,
    pub title: Option<String>,
    pub source_app: Option<PasteboardSourceApp>,
    pub source_device_id: String,
    pub copied_at: String,
    pub updated_at: String,
    pub content_fingerprint: String,
    pub payload: Value,
    pub ocr_text: Option<String>,
    pub pinboard_id: Option<String>,
    pub pinboard_order_key: Option<String>,
    pub pinned: bool,
    pub field_clocks: Value,
}
```

Add `pasteboard_items`, `pasteboard_pinboards`, `pasteboard_tombstones`, and `pasteboard_blobs` tables plus indexes in `run_migrations()`.

- [ ] **Step 4: Add managed blob directories**

```rust
pub fn pasteboard_dir(&self) -> PathBuf { self.base_dir.join("pasteboard") }
pub fn pasteboard_blobs_dir(&self) -> PathBuf { self.pasteboard_dir().join("blobs") }
```

`ensure_dirs()` must create both directories.

- [ ] **Step 5: Run tests**

```bash
cargo test -p atools-core --test pasteboard_tests
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/atools-core
git commit -m "feat: 增加 PasteboardPro 持久化模型" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 2: Build the capture, privacy, and retention coordinator

**Files:**
- Create: `src-tauri/src/pasteboard_runtime.rs`
- Create: `src-tauri/tests/pasteboard_runtime_tests.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write fake-backend tests first**

```rust
#[async_trait]
pub trait PasteboardBackend: Send + Sync {
    async fn snapshot_if_changed(&self, previous_change_count: i64) -> Result<Option<NativePasteboardSnapshot>, String>;
    async fn write_item(&self, item: &PasteboardItem, plain_text: bool) -> Result<(), String>;
    async fn paste_frontmost(&self) -> Result<(), String>;
}

#[tokio::test]
async fn ignored_snapshots_are_not_persisted() {
    let runtime = test_runtime(snapshot_from("com.1password.1password", "secret"));
    runtime.capture_once().await.unwrap();
    assert_eq!(runtime.store().count_items().unwrap(), 0);
}
```

- [ ] **Step 2: Verify red state**

```bash
cargo test -p atools --test pasteboard_runtime_tests
```

Expected: FAIL because the runtime does not exist.

- [ ] **Step 3: Implement the coordinator**

```rust
pub struct PasteboardRuntime<B> {
    backend: B,
    db: Database,
    config: AppConfig,
    state: tokio::sync::Mutex<CaptureState>,
}

impl<B: PasteboardBackend> PasteboardRuntime<B> {
    pub async fn capture_once(&self) -> Result<CaptureOutcome, String> {
        let previous = self.state.lock().await.change_count;
        let Some(snapshot) = self.backend.snapshot_if_changed(previous).await? else {
            return Ok(CaptureOutcome::Unchanged);
        };
        if self.should_ignore(&snapshot)? {
            self.state.lock().await.change_count = snapshot.change_count;
            return Ok(CaptureOutcome::Ignored);
        }
        let item = self.normalize_snapshot(snapshot).await?;
        self.persist_item(&item).await?;
        self.apply_retention()?;
        Ok(CaptureOutcome::Captured(item.id))
    }

    pub async fn paste_item(&self, id: &str, plain_text: bool) -> Result<PasteOutcome, String> {
        let item = self.db.get_pasteboard_item(id).map_err(|error| error.to_string())?
            .ok_or_else(|| format!("Pasteboard item not found: {id}"))?;
        self.backend.write_item(&item, plain_text).await?;
        match self.backend.paste_frontmost().await {
            Ok(()) => Ok(PasteOutcome::pasted()),
            Err(message) => Ok(PasteOutcome::copied_with_warning("accessibility_required", message)),
        }
    }
}
```

Define `should_ignore`, `normalize_snapshot`, `persist_item`, and `apply_retention` as private methods in the same task; each method receives all inputs explicitly and has focused unit coverage.

Apply confidential/transient flags, ignored bundle IDs, user literal/wildcard/regex rules, and token detection before any database/blob write.

- [ ] **Step 4: Add the background loop**

Manage one runtime in `AppState`; start a cancellable 250 ms polling loop during Tauri setup and stop it during app shutdown. Repeated change counts must perform no database work.

- [ ] **Step 5: Run runtime tests**

Expected: PASS for ignore rules, deduplication, blob cleanup, paused capture, 90-day retention, and Pinboard protection.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pasteboard_runtime.rs src-tauri/tests/pasteboard_runtime_tests.rs src-tauri/src/lib.rs
git commit -m "feat: 增加本地剪贴板捕获运行时" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 3: Implement macOS capture, OCR, preview, and direct paste

**Files:**
- Create: `src-tauri/src/pasteboard_native.rs`
- Modify: `src-tauri/Cargo.toml`, `Cargo.lock`
- Modify: `src-tauri/src/pasteboard_runtime.rs`

- [ ] **Step 1: Add failing native normalization tests**

Test that AppKit type payloads normalize to the canonical kinds:

```rust
assert_eq!(normalize_types(&["public.html", "public.utf8-plain-text"]).kind, PasteboardItemKind::Html);
assert_eq!(normalize_types(&["public.file-url"]).kind, PasteboardItemKind::Files);
assert_eq!(normalize_types(&["com.apple.cocoa.pasteboard.color"]).kind, PasteboardItemKind::Color);
```

- [ ] **Step 2: Add native dependencies**

```toml
objc2 = "0.6"
objc2-foundation = "0.3"
objc2-app-kit = "0.3"
objc2-vision = "0.3"
security-framework = "3"
```

Place AppKit, Vision, and Security Framework dependencies under `[target.'cfg(target_os = "macos")'.dependencies]` so Windows/Linux builds retain the basic plugin UI without linking macOS frameworks.

- [ ] **Step 3: Implement `MacPasteboardBackend`**

The backend must read `NSPasteboard.changeCount`, capture ordered representations, preserve original bytes for rich text/images/PDF, and record the frontmost application bundle ID before the shelf takes focus.

Expose these concrete methods:

```rust
pub struct MacPasteboardBackend;
impl MacPasteboardBackend {
    pub fn snapshot() -> Result<NativePasteboardSnapshot, String>;
    pub fn recognize_text(image_path: &Path) -> Result<String, String>;
    pub fn quick_look_path(item: &PasteboardItem, blobs: &Path) -> Result<PathBuf, String>;
    pub fn paste_with_command_v() -> Result<(), String>;
}
```

- [ ] **Step 4: Add permission-aware fallback**

If Accessibility paste fails, keep the selected item on the system clipboard and return:

```rust
PasteOutcome { copied: true, pasted: false, warning_code: Some("accessibility_required".into()) }
```

- [ ] **Step 5: Run native unit tests and macOS smoke guard tests**

Expected: normalization tests PASS; smoke mode does not trigger real UI or paste events.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/pasteboard_native.rs src-tauri/src/pasteboard_runtime.rs
git commit -m "feat: 接入 macOS 剪贴板与 Vision 能力" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 4: Add the native shelf window and docking geometry

**Files:**
- Create: `src-tauri/src/pasteboard_window.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/window.rs`
- Modify: `src-tauri/src/commands.rs`
- Create: `scripts/test-pasteboard-shelf-window.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing window contract**

```js
assert.match(windowSource, /PASTEBOARD_SHELF_LABEL/);
assert.match(windowSource, /transparent\(true\)/);
assert.match(windowSource, /always_on_top\(true\)/);
assert.match(windowSource, /resolve_pasteboard_dock_edge/);
assert.match(libSource, /open_pasteboard_shelf_window/);
```

- [ ] **Step 2: Run and verify failure**

```bash
pnpm test:pasteboard-shelf-window
```

Expected: FAIL because the shelf window is missing.

- [ ] **Step 3: Implement the window state**

```rust
pub enum PasteboardDockEdge { Floating, Bottom, Left, Right }
pub struct PasteboardShelfBounds { pub x: i32, pub y: i32, pub width: u32, pub height: u32, pub edge: PasteboardDockEdge }
```

Create a frameless, transparent, always-on-top Tauri webview window loading the `pasteboard-pro` plugin feature. Persist bounds per monitor identifier. Snap at 12 physical pixels and clamp to the monitor work area.

Add a runtime toggle that applies native content protection to the shelf and preview window when “屏幕共享时隐藏” is enabled.

On non-macOS targets, create the plugin window without native glass/content-protection guarantees and expose explicit unavailable capability flags instead of failing plugin activation.

- [ ] **Step 4: Add the command and registration**

```rust
#[tauri::command]
pub fn open_pasteboard_shelf_window(app: tauri::AppHandle, feature_code: String) -> Result<(), String>;
```

- [ ] **Step 5: Run window contract and Rust geometry tests**

Expected: PASS for floating/bottom/left/right radii and multi-display restoration.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/pasteboard_window.rs src-tauri/src/window.rs src-tauri/src/commands.rs src-tauri/src/lib.rs scripts/test-pasteboard-shelf-window.mjs package.json
git commit -m "feat: 增加可停靠剪贴板浮窗" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 5: Expose the narrow plugin bridge and build the Svelte UI

**Files:**
- Modify: `src/components/PluginPanel.svelte`
- Modify: `src/lib/pluginBridgeCapabilities.ts`
- Modify: `src/lib/pluginInvokePolicy.ts`
- Modify: `src/lib/pluginRuntimePermissions.ts`
- Create: `src/lib/pasteboardBridge.ts`
- Create: `scripts/test-pasteboard-plugin-bridge.mjs`
- Create in ZTools worktree: `plugins/pasteboard-pro/apps/atools/package.json`
- Create in ZTools worktree: `plugins/pasteboard-pro/apps/atools/src/App.svelte`
- Create in ZTools worktree: `plugins/pasteboard-pro/apps/atools/src/adapter.ts`
- Create in ZTools worktree: `plugins/pasteboard-pro/apps/atools/src/state.ts`
- Create in ZTools worktree: the eight component files listed in the file map
- Create in ZTools worktree: `plugins/pasteboard-pro/apps/atools/tests/keyboard.test.ts`
- Create in ZTools worktree: `plugins/pasteboard-pro/apps/atools/tests/visual-state.test.ts`

- [ ] **Step 1: Write bridge and component tests first**

```js
assert.match(panel, /window\.atools\.pasteboard/);
for (const method of ["listItems", "search", "paste", "copy", "listPinboards", "savePinboard", "syncStatus"]) {
  assert.ok(panel.includes(`${method}: function`));
}
```

Svelte component tests must replay the shared keyboard fixture and assert selected item IDs, dock classes, and Paste Stack badges.

- [ ] **Step 2: Verify failures**

Run the bridge contract and focused Vitest tests. Expected: missing bridge/app.

- [ ] **Step 3: Implement the bridge**

Expose only:

```ts
interface AToolsPasteboardBridge {
  listItems(input: ListItemsInput): Promise<ListItemsResult>;
  search(input: SearchInput): Promise<SearchResult>;
  copy(input: ItemActionInput): Promise<PasteActionResult>;
  paste(input: ItemActionInput & { plainText: boolean }): Promise<PasteActionResult>;
  listPinboards(): Promise<Pinboard[]>;
  savePinboard(input: SavePinboardInput): Promise<Pinboard>;
  moveItem(input: MoveItemInput): Promise<PasteItem>;
  syncStatus(): Promise<SyncStatus>;
}
```

Bind every request to the active plugin frame, active plugin ID, declared permission, and reconstructed host arguments.

- [ ] **Step 4: Implement the Svelte app**

Create `apps/atools/package.json`:

```json
{
  "name": "@pasteboard-pro/atools",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": { "build": "vite build", "test": "vitest run", "check": "svelte-check --tsconfig ./tsconfig.json" },
  "dependencies": {
    "@pasteboard-pro/core": "workspace:*",
    "@pasteboard-pro/design-tokens": "workspace:*",
    "@pasteboard-pro/contract-fixtures": "workspace:*",
    "svelte": "^5.2.0"
  }
}
```

Create focused components: `Shelf.svelte`, `Toolbar.svelte`, `Timeline.svelte`, `PasteCard.svelte`, `SearchBar.svelte`, `PinboardStrip.svelte`, `Preview.svelte`, and `PasteStack.svelte`. Import reducers/tokens from the shared packages; do not duplicate search or keyboard logic.

The adapter/component tests must cover text creation, title editing, image rotation, OCR text copying, Pinboard drag/drop, plain-text paste, multi-select paste, Quick Paste 1–9, pause capture, and content-protection status.

Create `public/plugin.json` with plugin ID `pasteboard-pro`, feature code `pasteboard-pro`, and permissions `pasteboard.read`, `pasteboard.write`, `pasteboard.sync`, `window.shelf`, `file.read`, and `keychain`. Create `scripts/assemble-dist.mjs` to place the Svelte build, manifest, logo, and preload into `dist/atools/` without source maps or dependency directories.

- [ ] **Step 5: Run focused tests**

```bash
pnpm test:pasteboard-plugin-bridge
pnpm --dir plugins/pasteboard-pro --filter @pasteboard-pro/atools test
node plugins/pasteboard-pro/apps/atools/scripts/assemble-dist.mjs --verify-only
```

Expected: PASS after builds are authorized.

- [ ] **Step 6: Commit in ATools**

```bash
git add src/components/PluginPanel.svelte src/lib scripts/test-pasteboard-plugin-bridge.mjs package.json
git commit -m "feat: 暴露 PasteboardPro 插件桥" \
  -m "AI-Co-Authored-By: Codex"
```

- [ ] **Step 7: Commit the Svelte plugin in ZTools**

```bash
git add plugins/pasteboard-pro/apps/atools
git commit -m "feat: 增加 PasteboardPro ATools Svelte 界面" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 6: Register TaskRun/MCP capabilities

**Files:**
- Modify: `src-tauri/src/agent_tools.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `crates/atools-core/src/agent.rs`
- Modify: `src/lib/types.ts`
- Create: `scripts/test-pasteboard-capability-contract.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write failing capability tests**

Require these tools: `pasteboard_search`, `pasteboard_list_pinboards`, `pasteboard_save_pinboard`, `pasteboard_copy_item`, `pasteboard_paste_item`, `pasteboard_sync`.

```js
for (const name of requiredTools) assert.ok(agentTools.includes(`"${name}"`));
assert.match(commands, /TaskRun::new\(\s*"pasteboard_paste_item"/);
assert.match(commands, /TaskRunInitiator::human/);
```

- [ ] **Step 2: Verify failure**

Run the focused Node contract and Rust agent tool tests.

- [ ] **Step 3: Register shared-runtime handlers**

Agent and human commands must call `PasteboardRuntime`, not duplicate database or native paste logic. Return `runId`, status, summary, structured output, warnings, and retry actions.

- [ ] **Step 4: Redact audit payloads**

Persist item IDs, kinds, counts, and sizes; replace raw text/OCR/title/path fields with redacted summaries before writing audit input/output.

- [ ] **Step 5: Run capability tests**

Expected: PASS for tool schemas, permission scopes, TaskRun transitions, human/agent convergence, and redaction.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/agent_tools.rs src-tauri/src/commands.rs crates/atools-core/src/agent.rs src/lib/types.ts scripts/test-pasteboard-capability-contract.mjs package.json
git commit -m "feat: 接入 PasteboardPro TaskRun 与 MCP" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 7: Close ATools tests and performance evidence

**Files:**
- Modify: `docs/macos-smoke-checklist.md`
- Create: `scripts/benchmark-pasteboard-search.mjs`
- Create: `scripts/test-pasteboard-retention.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add benchmark and retention contracts**

The benchmark must generate deterministic 10k/100k histories and fail when P95 exceeds the approved thresholds. Retention tests must prove Pinboard blobs survive cleanup.

- [ ] **Step 2: Run focused gates**

```bash
pnpm test:pasteboard-plugin-bridge
pnpm test:pasteboard-shelf-window
pnpm test:pasteboard-capability-contract
cargo test -p atools-core --test pasteboard_tests
cargo test -p atools --test pasteboard_runtime_tests
```

Expected: PASS.

- [ ] **Step 3: Run build/desktop gates only after authorization**

```bash
pnpm check
pnpm build
pnpm --dir /Users/harris/.codex/worktrees/ztools-pasteboardpro/plugins/pasteboard-pro --filter @pasteboard-pro/atools build
node /Users/harris/.codex/worktrees/ztools-pasteboardpro/plugins/pasteboard-pro/apps/atools/scripts/assemble-dist.mjs
pnpm smoke:tauri-desktop
```

Expected: PASS without increasing the release bundle beyond the recorded budget.

- [ ] **Step 4: Commit evidence**

```bash
git add package.json scripts/benchmark-pasteboard-search.mjs scripts/test-pasteboard-retention.mjs docs/macos-smoke-checklist.md
git commit -m "test: 补齐 PasteboardPro ATools 验收" \
  -m "AI-Co-Authored-By: Codex"
```
