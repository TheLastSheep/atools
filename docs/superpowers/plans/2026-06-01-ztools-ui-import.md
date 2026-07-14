# ZTools UI Restore And Plugin Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ATools toward the ZTools main-program experience and add one-click import for ZTools plugins.

**Architecture:** Rust/Tauri owns plugin scanning, manifest validation, import, and feature indexing. Svelte owns the command-center shell, system panels, import workflow, and plugin host presentation. Existing plugin iframe and utools/ztools bridge remain intact.

**Tech Stack:** Tauri 2, Rust, SQLite/rusqlite, Svelte 5, TypeScript, Vite, Playwright or browser screenshot smoke checks.

---

## Scope

This plan implements two deliverables:

1. **ZTools 主程序体验还原**：主窗口、搜索、结果列表、空态、系统入口、插件运行态更接近 ZTools/uTools 类命令中心。
2. **一键导入 ZTools 插件**：选择目录、扫描 `plugin.json`、预检、批量导入、显示导入报告。

It does not implement Windows support, plugin data migration, raw Electron/Node API, or pixel-perfect cloning without reference screenshots.

The repository at `/Users/harris/Desktop/atools` is not a git repository. Commit steps are replaced with verification commands.

## File Structure

- Create `src-tauri/src/ztools_import.rs`
  - Rust scanner, candidate model, report model, manifest checks, recursive directory traversal.
- Modify `src-tauri/src/lib.rs`
  - Register new module and commands.
- Modify `src-tauri/src/commands.rs`
  - Add `scan_ztools_plugins` and `import_ztools_plugins`.
- Modify `src/lib/types.ts`
  - Add TS mirrors for import candidates, failures, reports, shell panel state.
- Create `src/lib/uiState.ts`
  - Small constants for shell panels and display groups.
- Create `src/components/ShellFrame.svelte`
  - Main window chrome, toolbar, panel placement.
- Create `src/components/HomePanel.svelte`
  - Recent/recommended commands and system actions.
- Create `src/components/SystemPanel.svelte`
  - Plugin import, Agent, audit/permission entry container.
- Create `src/components/ZToolsImportPanel.svelte`
  - Directory scan, candidate list, import report.
- Modify `src/App.svelte`
  - Compose shell states and panels.
- Modify `src/components/SearchBar.svelte`
  - Compact command input presentation.
- Modify `src/components/ResultsList.svelte`
  - Grouped dense results.
- Modify `src/components/PluginPanel.svelte`
  - ZTools-like plugin host chrome and sub-input placement.
- Add tests in `src-tauri/tests/ztools_import_tests.rs`
  - Scanner/import behavior using temp plugin fixtures.

---

### Task 1: Rust ZTools Import Scanner

**Files:**
- Create: `/Users/harris/Desktop/atools/src-tauri/src/ztools_import.rs`
- Create: `/Users/harris/Desktop/atools/src-tauri/tests/ztools_import_tests.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/lib.rs`

- [x] **Step 1: Write failing scanner tests**

Create `/Users/harris/Desktop/atools/src-tauri/tests/ztools_import_tests.rs`:

```rust
use std::fs;
use tempfile::TempDir;

fn write_plugin(root: &std::path::Path, name: &str) -> std::path::PathBuf {
    let dir = root.join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("index.html"), "<html></html>").unwrap();
    fs::write(dir.join("logo.svg"), "<svg></svg>").unwrap();
    fs::write(
        dir.join("plugin.json"),
        r#"{
          "name": "image-batch-studio",
          "title": "图片批处理",
          "version": "0.1.0",
          "main": "index.html",
          "logo": "logo.svg",
          "platform": ["darwin"],
          "features": [{
            "code": "image-batch",
            "explain": "图片批处理",
            "cmds": ["图片批处理", {"type": "files", "label": "批量处理图片"}]
          }]
        }"#,
    )
    .unwrap();
    dir
}

#[test]
fn scan_ztools_plugins_finds_valid_manifest() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "image-batch-studio");

    let candidates = atools_lib::ztools_import::scan_ztools_plugin_candidates(temp.path()).unwrap();

    assert_eq!(candidates.len(), 1);
    assert_eq!(candidates[0].path, plugin_dir.to_string_lossy());
    assert_eq!(candidates[0].name, "image-batch-studio");
    assert_eq!(candidates[0].title.as_deref(), Some("图片批处理"));
    assert!(candidates[0].main_exists);
    assert!(candidates[0].platform_supported);
    assert!(candidates[0].errors.is_empty());
}

#[test]
fn scan_ztools_plugins_reports_missing_main() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "broken-plugin");
    fs::remove_file(plugin_dir.join("index.html")).unwrap();

    let candidates = atools_lib::ztools_import::scan_ztools_plugin_candidates(temp.path()).unwrap();

    assert_eq!(candidates.len(), 1);
    assert!(!candidates[0].main_exists);
    assert!(candidates[0].errors.iter().any(|error| error.contains("main")));
}
```

- [x] **Step 2: Run tests to verify RED**

Run:

```bash
cargo test -p atools --test ztools_import_tests
```

Expected: FAIL because `atools_lib::ztools_import` does not exist.

- [x] **Step 3: Implement scanner models and scan function**

Create `/Users/harris/Desktop/atools/src-tauri/src/ztools_import.rs` with:

```rust
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use atools_core::models::PluginManifest;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportCandidate {
    pub path: String,
    pub name: String,
    pub title: Option<String>,
    pub version: String,
    pub features_count: usize,
    pub platform_supported: bool,
    pub main_exists: bool,
    pub preload_exists: bool,
    pub logo_exists: bool,
    pub unsupported_cmd_types: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

pub fn scan_ztools_plugin_candidates(root: &Path) -> Result<Vec<ZToolsImportCandidate>, String> {
    let mut manifests = Vec::new();
    collect_plugin_manifests(root, &mut manifests)?;
    let mut candidates = Vec::new();
    for manifest_path in manifests {
        candidates.push(candidate_from_manifest(&manifest_path)?);
    }
    candidates.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(candidates)
}
```

Add helpers:

```rust
fn collect_plugin_manifests(root: &Path, out: &mut Vec<PathBuf>) -> Result<(), String> {
    if root.file_name().and_then(|name| name.to_str()) == Some("node_modules") {
        return Ok(());
    }
    if root.join("plugin.json").is_file() {
        out.push(root.join("plugin.json"));
        return Ok(());
    }
    for entry in fs::read_dir(root).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            let _ = collect_plugin_manifests(&entry.path(), out);
        }
    }
    Ok(())
}

fn candidate_from_manifest(manifest_path: &Path) -> Result<ZToolsImportCandidate, String> {
    let plugin_dir = manifest_path.parent().ok_or_else(|| "Invalid plugin path".to_string())?;
    let text = fs::read_to_string(manifest_path).map_err(|e| e.to_string())?;
    let raw: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let manifest: PluginManifest = serde_json::from_value(raw.clone()).map_err(|e| e.to_string())?;
    let title = raw.get("title").and_then(serde_json::Value::as_str).map(str::to_string);
    let platforms = raw.get("platform").and_then(serde_json::Value::as_array);
    let platform_supported = platforms
        .map(|items| items.iter().filter_map(serde_json::Value::as_str).any(|item| item == "darwin" || item == "macos"))
        .unwrap_or(true);
    let main_exists = manifest.main.as_ref().map(|main| plugin_dir.join(main).is_file()).unwrap_or(false);
    let preload_exists = manifest.preload.as_ref().map(|preload| plugin_dir.join(preload).is_file()).unwrap_or(true);
    let logo_exists = manifest.logo.as_ref().map(|logo| plugin_dir.join(logo).is_file()).unwrap_or(true);
    let unsupported_cmd_types = unsupported_cmd_types(&manifest);
    let mut warnings = Vec::new();
    let mut errors = Vec::new();
    if !platform_supported {
        warnings.push("Plugin platform does not include darwin".to_string());
    }
    if !main_exists {
        errors.push("Missing main file".to_string());
    }
    if !preload_exists {
        warnings.push("Missing preload file".to_string());
    }
    if !logo_exists {
        warnings.push("Missing logo file".to_string());
    }
    if !unsupported_cmd_types.is_empty() {
        warnings.push(format!("Unsupported command types: {}", unsupported_cmd_types.join(", ")));
    }

    Ok(ZToolsImportCandidate {
        path: plugin_dir.to_string_lossy().to_string(),
        name: manifest.name,
        title,
        version: manifest.version,
        features_count: manifest.features.len(),
        platform_supported,
        main_exists,
        preload_exists,
        logo_exists,
        unsupported_cmd_types,
        warnings,
        errors,
    })
}

fn unsupported_cmd_types(manifest: &PluginManifest) -> Vec<String> {
    let supported = BTreeSet::from(["text", "regex", "over", "img", "files", "window"]);
    let mut unsupported = BTreeSet::new();
    for feature in &manifest.features {
        for cmd in &feature.cmds {
            if let atools_core::models::Cmd::Typed { r#type, .. } = cmd {
                if !supported.contains(r#type.as_str()) {
                    unsupported.insert(r#type.clone());
                }
            }
        }
    }
    unsupported.into_iter().collect()
}
```

In `/Users/harris/Desktop/atools/src-tauri/src/lib.rs`, add:

```rust
pub mod ztools_import;
```

- [ ] **Step 4: Run scanner tests**

Run:

```bash
cargo test -p atools --test ztools_import_tests
```

Expected: PASS.

---

### Task 2: ZTools Import Commands

**Files:**
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/ztools_import.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/commands.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/lib.rs`
- Modify: `/Users/harris/Desktop/atools/src-tauri/tests/ztools_import_tests.rs`

- [x] **Step 1: Write failing import test**

Append to `src-tauri/tests/ztools_import_tests.rs`:

```rust
#[test]
fn import_ztools_plugin_copies_directory_and_indexes_feature() {
    let temp = TempDir::new().unwrap();
    let plugin_dir = write_plugin(temp.path(), "image-batch-studio");
    let install_root = temp.path().join("atools-plugins");
    let db = atools_core::Database::in_memory().unwrap();

    let report = atools_lib::ztools_import::import_ztools_plugins(
        &db,
        &install_root,
        &[plugin_dir.to_string_lossy().to_string()],
        true,
    )
    .unwrap();

    assert_eq!(report.imported.len(), 1);
    assert!(install_root.join("image-batch-studio").join("plugin.json").is_file());
    let features = db.all_features().unwrap();
    assert!(features.iter().any(|feature| feature.code == "image-batch"));
}
```

- [x] **Step 2: Run test to verify RED**

Run:

```bash
cargo test -p atools --test ztools_import_tests import_ztools_plugin_copies_directory_and_indexes_feature
```

Expected: FAIL because `import_ztools_plugins` and report types do not exist.

- [x] **Step 3: Implement import report and import function**

Add to `src-tauri/src/ztools_import.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportFailure {
    pub path: String,
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ZToolsImportReport {
    pub imported: Vec<String>,
    pub skipped: Vec<ZToolsImportCandidate>,
    pub failed: Vec<ZToolsImportFailure>,
}

pub fn import_ztools_plugins(
    db: &atools_core::Database,
    install_root: &Path,
    paths: &[String],
    overwrite: bool,
) -> Result<ZToolsImportReport, String> {
    fs::create_dir_all(install_root).map_err(|e| e.to_string())?;
    let mut report = ZToolsImportReport { imported: Vec::new(), skipped: Vec::new(), failed: Vec::new() };
    for path in paths {
        let source = PathBuf::from(path);
        match import_one(db, install_root, &source, overwrite) {
            Ok(name) => report.imported.push(name),
            Err(ImportSkip::Skip(candidate)) => report.skipped.push(candidate),
            Err(ImportSkip::Fail(error)) => report.failed.push(ZToolsImportFailure { path: path.clone(), error }),
        }
    }
    Ok(report)
}
```

Implement `import_one`, `copy_dir_recursive`, parse manifest, save plugin and index features using the same behavior as existing `install_plugin`.

- [x] **Step 4: Add Tauri commands**

In `src-tauri/src/commands.rs`, add:

```rust
#[tauri::command]
pub fn scan_ztools_plugins(root: String) -> Result<Vec<crate::ztools_import::ZToolsImportCandidate>, String> {
    crate::ztools_import::scan_ztools_plugin_candidates(std::path::Path::new(&root))
}

#[tauri::command]
pub fn import_ztools_plugins(
    state: tauri::State<AppState>,
    paths: Vec<String>,
    overwrite: Option<bool>,
) -> Result<crate::ztools_import::ZToolsImportReport, String> {
    crate::ztools_import::import_ztools_plugins(
        &state.db,
        &state.config.plugins_dir(),
        &paths,
        overwrite.unwrap_or(true),
    )
}
```

Register both commands in `src-tauri/src/lib.rs`.

- [x] **Step 5: Run Rust tests**

Run:

```bash
cargo test -p atools --test ztools_import_tests
cargo test --workspace
```

Expected: PASS.

---

### Task 3: Import UI Types And ZToolsImportPanel

**Files:**
- Modify: `/Users/harris/Desktop/atools/src/lib/types.ts`
- Create: `/Users/harris/Desktop/atools/src/components/ZToolsImportPanel.svelte`
- Modify: `/Users/harris/Desktop/atools/package.json` only if a test dependency is required; otherwise do not change it.

- [x] **Step 1: Add TS types**

Add to `src/lib/types.ts`:

```ts
export type ZToolsImportCandidate = {
  path: string;
  name: string;
  title: string | null;
  version: string;
  features_count: number;
  platform_supported: boolean;
  main_exists: boolean;
  preload_exists: boolean;
  logo_exists: boolean;
  unsupported_cmd_types: string[];
  warnings: string[];
  errors: string[];
};

export type ZToolsImportFailure = {
  path: string;
  error: string;
};

export type ZToolsImportReport = {
  imported: string[];
  skipped: ZToolsImportCandidate[];
  failed: ZToolsImportFailure[];
};
```

- [x] **Step 2: Create import panel**

Create `src/components/ZToolsImportPanel.svelte` with:

```svelte
<script lang="ts">
  import { invoke } from "@tauri-apps/api/core";
  import { open } from "@tauri-apps/plugin-dialog";
  import type { ZToolsImportCandidate, ZToolsImportReport } from "../lib/types";

  let candidates: ZToolsImportCandidate[] = $state([]);
  let selected = $state<Set<string>>(new Set());
  let report: ZToolsImportReport | null = $state(null);
  let scanning = $state(false);
  let importing = $state(false);
  let error = $state("");

  async function chooseAndScan() {
    const root = await open({ directory: true, multiple: false });
    if (typeof root !== "string") return;
    scanning = true;
    error = "";
    try {
      candidates = await invoke<ZToolsImportCandidate[]>("scan_ztools_plugins", { root });
      selected = new Set(candidates.filter((item) => item.errors.length === 0).map((item) => item.path));
      report = null;
    } catch (e) {
      error = String(e);
    } finally {
      scanning = false;
    }
  }

  async function importSelected() {
    importing = true;
    error = "";
    try {
      report = await invoke<ZToolsImportReport>("import_ztools_plugins", {
        paths: Array.from(selected),
        overwrite: true,
      });
    } catch (e) {
      error = String(e);
    } finally {
      importing = false;
    }
  }
</script>

<section class="import-panel">
  <div class="import-head">
    <div>
      <h3>导入 ZTools 插件</h3>
      <p>扫描包含 plugin.json 的插件目录，预检后批量导入。</p>
    </div>
    <button onclick={chooseAndScan} disabled={scanning}>{scanning ? "扫描中" : "选择目录"}</button>
  </div>

  {#if error}<div class="import-error">{error}</div>{/if}

  {#if candidates.length > 0}
    <div class="candidate-list">
      {#each candidates as item}
        <label class:error={item.errors.length > 0} class="candidate-row">
          <input
            type="checkbox"
            disabled={item.errors.length > 0}
            checked={selected.has(item.path)}
            onchange={(event) => {
              const next = new Set(selected);
              if ((event.target as HTMLInputElement).checked) next.add(item.path);
              else next.delete(item.path);
              selected = next;
            }}
          />
          <div>
            <strong>{item.title ?? item.name}</strong>
            <p>{item.name} · {item.version} · {item.features_count} features</p>
            {#if item.warnings.length > 0}<small>{item.warnings.join("；")}</small>{/if}
            {#if item.errors.length > 0}<small>{item.errors.join("；")}</small>{/if}
          </div>
        </label>
      {/each}
    </div>
    <button class="primary" onclick={importSelected} disabled={importing || selected.size === 0}>
      {importing ? "导入中" : `导入 ${selected.size} 个插件`}
    </button>
  {/if}

  {#if report}
    <div class="report">
      <strong>导入完成</strong>
      <p>成功 {report.imported.length} 个，跳过 {report.skipped.length} 个，失败 {report.failed.length} 个。</p>
    </div>
  {/if}
</section>
```

Style the panel using existing CSS variables. Keep cards shallow, radius <= 8px, and avoid nested card containers.

- [x] **Step 3: Run frontend check**

Run:

```bash
pnpm check
```

Expected: 0 errors and 0 warnings.

---

### Task 4: System Panel And Main Shell Composition

**Files:**
- Create: `/Users/harris/Desktop/atools/src/lib/uiState.ts`
- Create: `/Users/harris/Desktop/atools/src/components/ShellFrame.svelte`
- Create: `/Users/harris/Desktop/atools/src/components/HomePanel.svelte`
- Create: `/Users/harris/Desktop/atools/src/components/SystemPanel.svelte`
- Modify: `/Users/harris/Desktop/atools/src/App.svelte`

- [x] **Step 1: Add UI state constants**

Create `src/lib/uiState.ts`:

```ts
export type ShellPanel = "home" | "plugins" | "import" | "agent";

export const SYSTEM_ACTIONS: Array<{ id: ShellPanel; label: string; description: string }> = [
  { id: "plugins", label: "插件管理", description: "查看、启用、禁用已安装插件" },
  { id: "import", label: "导入 ZTools 插件", description: "扫描 plugin.json 并批量导入" },
  { id: "agent", label: "Agent / MCP", description: "管理工具、权限和审计" },
];
```

- [x] **Step 2: Create ShellFrame**

Create `ShellFrame.svelte` as a thin layout wrapper with top search slot, content slot, and bottom toolbar. The toolbar emits `panelchange`.

- [x] **Step 3: Create HomePanel**

Move the current welcome-state content out of `App.svelte`, but change it from large marketing cards to compact sections:

- 最近使用
- 推荐命令
- 系统工具

The import action must be visible without scrolling.

- [x] **Step 4: Create SystemPanel**

SystemPanel receives `panel` and renders:

- `"import"` -> `ZToolsImportPanel`
- `"agent"` -> existing `AgentPanel`
- `"plugins"` -> list from `list_plugins` with enable toggles

- [x] **Step 5: Refactor App.svelte**

`App.svelte` should only own:

- query/search state
- active plugin state
- active shell panel
- keyboard routing

It should render `ShellFrame`, `SearchBar`, `HomePanel`, `ResultsList`, `SystemPanel`, and `PluginPanel`.

- [x] **Step 6: Verify**

Run:

```bash
pnpm check
pnpm build
```

Expected: both pass.

---

### Task 5: ZTools-Like Search And Results Polish

**Files:**
- Modify: `/Users/harris/Desktop/atools/src/components/SearchBar.svelte`
- Modify: `/Users/harris/Desktop/atools/src/components/ResultsList.svelte`
- Modify: `/Users/harris/Desktop/atools/src/styles/global.css`

- [x] **Step 1: SearchBar density**

Update SearchBar to:

- height around 64px
- leading app glyph/command icon
- placeholder text without marketing phrase
- trailing compact shortcut hints
- no oversized decorative elements

- [x] **Step 2: Grouped ResultsList**

Group results by `plugin_name` or synthetic group:

- 命令
- 插件
- 系统

Keep list rows dense: 44-52px height, icon 28px, metadata right aligned.

- [x] **Step 3: Theme tokens**

Change global palette away from purple-heavy theme to a quiet macOS utility palette:

```css
--bg-primary: rgba(246, 247, 249, 0.92);
--bg-secondary: rgba(255, 255, 255, 0.72);
--text-primary: #1f2328;
--accent: #2563eb;
```

Keep dark mode support, but avoid one-note purple/blue gradients.

- [x] **Step 4: Verify**

Run:

```bash
pnpm check
pnpm build
```

Expected: both pass and no text overflow in common window widths.

---

### Task 6: Plugin Host Experience

**Files:**
- Modify: `/Users/harris/Desktop/atools/src/components/PluginPanel.svelte`
- Modify: `/Users/harris/Desktop/atools/src-tauri/src/window.rs` only if height policy needs adjustment.

- [x] **Step 1: Host chrome**

Adjust PluginPanel to:

- show title, feature, and source plugin clearly
- make close/back visually primary enough
- keep settings/detach disabled or hidden until implemented
- keep iframe full-bleed inside host body

- [x] **Step 2: SubInput**

Ensure `setSubInput` displays as a stable host input directly under the plugin titlebar. It should not resize iframe unpredictably.

- [x] **Step 3: Plugin output layer**

When plugin returns `outPlugin` items, show them in the same density and visual grammar as `ResultsList`.

- [ ] **Step 4: Verify with sample plugin**

  Status: Tauri app builds and a temp-home sample plugin database was prepared from `/Users/harris/Desktop/ztools-image-batch-studio/dist`, but the release app main window is configured `visible: false` and Computer Use could not capture a key window after launch/hotkey. Manual desktop activation of the sample plugin remains a follow-up smoke check.

Use imported `/Users/harris/Desktop/ztools-image-batch-studio/dist` or source directory. Activate `image-batch` and verify:

- plugin loads without blank iframe
- titlebar is visible
- subInput does not overlap iframe
- Escape closes plugin

Run:

```bash
pnpm check
cargo test --workspace
```

Expected: pass.

---

### Task 7: Visual And Release Verification

**Files:**
- Create: `/Users/harris/Desktop/atools/docs/ui-ztools-restore-checklist.md`

- [x] **Step 1: Add checklist**

Create checklist with four required states:

```markdown
# ZTools UI Restore Checklist

- [ ] Empty/home state: import entry visible, no marketing hero, compact command-center feel.
- [ ] Search results: dense rows, keyboard selection visible, source metadata readable.
- [ ] Import panel: candidates, warnings/errors, selected count, report all visible.
- [ ] Plugin host: titlebar, subInput, iframe, output layer do not overlap.
```

- [x] **Step 2: Full verification**

Run:

```bash
cargo test --workspace
pnpm check
pnpm build
pnpm exec tauri build --bundles app
```

Expected:

- Rust tests pass.
- Svelte check reports 0 errors and 0 warnings.
- Vite build succeeds.
- Tauri app exists at `/Users/harris/Desktop/atools/target/release/bundle/macos/ATools 3.0.app`.

---

## Self-Review

Spec coverage:

- ZTools主程序体验还原: Tasks 4, 5, 6, 7.
- 一键导入 ZTools 插件: Tasks 1, 2, 3.
- Existing iframe/plugin ecosystem preserved: Task 6 only changes host shell, not plugin internals.
- Verification: Tasks 1, 2, 3, 4, 5, 6, 7 include commands.

Placeholder scan:

- No `TBD`, `TODO`, or undefined later work is required to execute this plan.

Type consistency:

- Rust `ZToolsImportCandidate`, `ZToolsImportFailure`, `ZToolsImportReport` map to TypeScript types in `src/lib/types.ts`.
- Tauri commands `scan_ztools_plugins` and `import_ztools_plugins` match frontend `invoke` calls.
