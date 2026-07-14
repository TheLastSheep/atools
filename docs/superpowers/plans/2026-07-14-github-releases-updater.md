# GitHub Releases Updater Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, user-confirmed Tauri updater for ATools 3.0 and a two-stage GitHub Releases pipeline for signed Apple Silicon and Intel macOS builds.

**Architecture:** A Rust updater coordinator owns checking, download/install, progress, error classification, and restart; the Svelte frontend consumes only narrow custom commands through a shared state controller. A tag-triggered GitHub workflow uploads both architectures into one Draft Release, validates `latest.json` and signed assets, then promotes the exact tested release.

**Tech Stack:** Tauri 2.11, `tauri-plugin-updater` 2.10, Rust/Tokio/Serde, Svelte 5, Vitest + Testing Library, Node 24 scripts, GitHub Actions, `tauri-apps/tauri-action`.

---

## Scope and execution notes

- Source design: `docs/superpowers/specs/2026-07-14-github-releases-updater-design.md`.
- The workspace currently has no `.git` directory. Every commit step below is conditional: run it only after the user restores or creates the intended Git repository. Do not initialize Git or create a remote as an implicit implementation step.
- Updater private-key generation is an operator ceremony. The private key stays under `$HOME/.atools-release/`, is mode `0600`, and is never added to the repository.
- Real Apple signing, notarization, GitHub Secrets, and publication are external acceptance gates. Local implementation must still close all deterministic code and test gates.

## File map

**Create**

- `src-tauri/src/updater.rs` — updater domain types, coordinator, native backend, commands, and Rust tests.
- `src/lib/appUpdater.ts` — shared frontend updater controller and state store.
- `src/components/AppUpdatePrompt.svelte` — non-blocking `稍后` / `更新并重启` prompt.
- `tests/components/AppUpdaterHarness.svelte` — component harness for updater state rendering.
- `tests/components/app-updater.test.ts` — frontend controller and prompt behavior.
- `scripts/test-updater-contract.mjs` — dependency/config/registration/capability contract.
- `scripts/version-contract.mjs` — side-effect-free version readers and stable-tag validation.
- `scripts/validate-release-tag.mjs` — publish-workflow entry point for the shared version contract.
- `scripts/test-publish-workflow.mjs` — stable-tag and two-stage workflow contract.
- `scripts/verify-github-release-updater.mjs` — validate `latest.json` and referenced assets.
- `scripts/test-github-release-updater.mjs` — verifier fixtures and failure cases.
- `scripts/smoke-updater-package.mjs` — disposable packaged-upgrade orchestrator.
- `scripts/test-smoke-updater-package.mjs` — smoke orchestration safety/cleanup contract.
- `.github/workflows/publish-macos.yml` — Draft/build/verify/promote release pipeline.

**Modify**

- `src-tauri/Cargo.toml` and `Cargo.lock` — updater dependency.
- `src-tauri/tauri.conf.json` — updater artifacts, endpoint, and public key.
- `src-tauri/src/lib.rs` — module, plugin, managed coordinator, and commands.
- `src/App.svelte` — one delayed startup check and prompt rendering.
- `src/components/SettingsPanel.svelte` — About-page status and manual action.
- `src-tauri/capabilities/default.json` — retain no broad updater frontend permission.
- `package.json` — focused test and smoke commands.
- `scripts/check-macos-release-readiness.mjs` — exact production updater checks.
- `scripts/test-macos-release-readiness.mjs` — new readiness expectations.
- `scripts/test-version-consistency.mjs` — reusable tag/version export.
- `scripts/test-ci-workflow.mjs` — keep CI and publish workflows separated.
- `.test-plan.md`, `docs/macos-smoke-checklist.md`, and the long-running delivery plan — final evidence.

### Task 1: Bootstrap updater trust and lock the production configuration

**Files:**
- Create: `scripts/test-updater-contract.mjs`
- Modify: `package.json`
- Modify: `src-tauri/Cargo.toml`
- Modify: `Cargo.lock`
- Modify: `src-tauri/tauri.conf.json`
- Verify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Write the failing updater contract test**

Create `scripts/test-updater-contract.mjs` with these assertions:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const cargo = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
const lib = await readFile(new URL("src-tauri/src/lib.rs", root), "utf8");
const config = JSON.parse(await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"));
const capability = JSON.parse(await readFile(new URL("src-tauri/capabilities/default.json", root), "utf8"));

assert.match(cargo, /tauri-plugin-updater\s*=\s*"2\.10(?:\.\d+)?"/);
assert.match(lib, /tauri_plugin_updater::Builder::new\(\)\.build\(\)/);
assert.equal(config.bundle.createUpdaterArtifacts, true);
assert.deepEqual(config.plugins.updater.endpoints, [
  "https://github.com/harris/atools/releases/latest/download/latest.json",
]);
assert.equal(typeof config.plugins.updater.pubkey, "string");
assert.ok(config.plugins.updater.pubkey.trim().length >= 40);
assert.doesNotMatch(config.plugins.updater.pubkey, /placeholder|public.key|unconfigured/i);
assert.equal(config.plugins.updater.dangerousInsecureTransportProtocol, undefined);
assert.ok(!capability.permissions.some((permission) =>
  String(typeof permission === "string" ? permission : permission.identifier).startsWith("updater:"),
));
```

Add the focused script to `package.json`:

```json
"test:updater-contract": "node scripts/test-updater-contract.mjs"
```

- [ ] **Step 2: Run the contract test and verify the red state**

Run:

```bash
pnpm test:updater-contract
```

Expected: FAIL because the updater dependency, plugin registration, artifacts, endpoint, and public key do not exist.

- [ ] **Step 3: Generate the production updater keypair outside the repository**

Run interactively on the trusted local Mac:

```bash
mkdir -p "$HOME/.atools-release"
chmod 700 "$HOME/.atools-release"
pnpm exec tauri signer generate -w "$HOME/.atools-release/atools-updater.key"
chmod 600 "$HOME/.atools-release/atools-updater.key"
chmod 644 "$HOME/.atools-release/atools-updater.key.pub"
```

Expected: the CLI requests a password and creates the private/public key files. Record the password in the approved secret manager, not in shell history or a repository file.

- [ ] **Step 4: Add the dependency and exact production configuration**

Add to `src-tauri/Cargo.toml`:

```toml
tauri-plugin-updater = "2.10.1"
```

Read `$HOME/.atools-release/atools-updater.key.pub`, remove its trailing newline, and use `apply_patch` to set that exact generated value as `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. In the same patch, set `bundle.createUpdaterArtifacts` to `true` and set `plugins.updater.endpoints` to the one-element array `https://github.com/harris/atools/releases/latest/download/latest.json`. Do not put a descriptive stand-in value into the JSON; the contract test must pass against the real generated public key.

Run `cargo check --workspace` to update `Cargo.lock`.

- [ ] **Step 5: Register the plugin minimally so the contract can turn green**

In `src-tauri/src/lib.rs`, add the plugin next to other native plugins:

```rust
.plugin(tauri_plugin_updater::Builder::new().build())
```

Do not add `updater:*` permissions to `src-tauri/capabilities/default.json`.

- [ ] **Step 6: Run the focused and compile gates**

Run:

```bash
pnpm test:updater-contract
cargo check --workspace
```

Expected: updater contract PASS; Rust workspace check PASS.

- [ ] **Step 7: Commit if Git metadata is available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add package.json src-tauri/Cargo.toml Cargo.lock src-tauri/tauri.conf.json src-tauri/src/lib.rs scripts/test-updater-contract.mjs
  git commit -m "feat: configure signed app updates"
fi
```

### Task 2: Build the Rust updater coordinator with fake-backend tests

**Files:**
- Create: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Add failing coordinator tests first**

Start `src-tauri/src/updater.rs` with serializable domain types and tests for cache reuse, downgrade rejection, install serialization, progress, and restart gating. Use this public contract:

```rust
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    pub current_version: String,
    pub version: String,
    pub date: Option<String>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProgress {
    pub event: String,
    pub downloaded: u64,
    pub total: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct UpdateCommandError {
    pub code: String,
    pub message: String,
}

#[async_trait::async_trait]
pub trait UpdateBackend: Send + Sync {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError>;
    async fn install(
        &self,
        expected_version: &str,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError>;
    fn restart(&self) -> Result<(), UpdateCommandError>;
}
```

Tests must use a fake that counts `check` and `install` calls. Required assertions:

```rust
assert_eq!(backend.check_calls(), 1, "concurrent/fresh checks must share one result");
assert_eq!(result.as_ref().map(|item| item.version.as_str()), Some("3.0.1"));
assert_eq!(coordinator.install(&backend, "3.0.0", |_| {}).await.unwrap_err().code, "version_mismatch");
assert_eq!(backend.restart_calls(), 0, "failed installation must not restart");
assert_eq!(backend.restart_calls(), 1, "successful installation restarts exactly once");
```

- [ ] **Step 2: Run the Rust tests and confirm failure**

Run:

```bash
cargo test -p atools updater::tests --lib
```

Expected: FAIL because `UpdateCoordinator` and its methods are not implemented.

- [ ] **Step 3: Implement the coordinator state machine**

Implement a Tokio mutex around this internal state:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UpdateOperation {
    Idle,
    Checking,
    Installing,
}

struct CoordinatorInner {
    operation: UpdateOperation,
    checked_at: Option<std::time::Instant>,
    cached: Option<Option<UpdateMetadata>>,
}

pub struct UpdateCoordinator {
    inner: tokio::sync::Mutex<CoordinatorInner>,
    cache_ttl: std::time::Duration,
}
```

`check()` holds the mutex through the backend request. A second caller waits, then receives the cached result if it is no older than 10 seconds. `install()` requires an exact expected version, clears the cache after success, emits progress through the supplied closure, and calls `restart()` only after `backend.install()` returns `Ok(())`.

Normalize same-version and lower-version backend results to `Ok(None)` using `semver::Version`; add `semver = "1"` directly to `src-tauri/Cargo.toml`.

- [ ] **Step 4: Run coordinator tests**

```bash
cargo test -p atools updater::tests --lib
```

Expected: all updater coordinator tests PASS.

- [ ] **Step 5: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src-tauri/src/updater.rs src-tauri/src/lib.rs src-tauri/Cargo.toml Cargo.lock
  git commit -m "feat: add native update coordinator"
fi
```

### Task 3: Connect the coordinator to Tauri updater commands

**Files:**
- Modify: `src-tauri/src/updater.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `scripts/test-updater-contract.mjs`

- [ ] **Step 1: Extend the failing contract for the narrow command surface**

Add assertions:

```js
assert.match(lib, /\.manage\(updater::UpdateCoordinator::default\(\)\)/);
assert.match(lib, /updater::check_app_update/);
assert.match(lib, /updater::install_app_update/);
assert.match(lib, /updater::get_app_update_status/);
assert.doesNotMatch(lib, /updater:default|updater:allow-/);
```

Add Rust tests for caller validation:

```rust
assert!(ensure_updater_window("main").is_ok());
assert!(ensure_updater_window("settings").is_ok());
assert_eq!(ensure_updater_window("plugin-detach-1").unwrap_err().code, "forbidden_window");
```

- [ ] **Step 2: Run and verify red**

```bash
pnpm test:updater-contract
cargo test -p atools updater::tests --lib
```

Expected: FAIL on missing managed state and commands.

- [ ] **Step 3: Implement the Tauri backend and commands**

Use `tauri_plugin_updater::UpdaterExt` and map the plugin result without exposing URLs or signatures:

```rust
struct TauriUpdateBackend {
    app: tauri::AppHandle,
}

#[async_trait::async_trait]
impl UpdateBackend for TauriUpdateBackend {
    async fn check(&self) -> Result<Option<UpdateMetadata>, UpdateCommandError> {
        let update = self.app.updater()
            .map_err(classify_updater_error)?
            .check().await
            .map_err(classify_updater_error)?;
        Ok(update.map(|item| UpdateMetadata {
            current_version: item.current_version,
            version: item.version,
            date: item.date.map(|value| value.to_string()),
            body: item.body,
        }))
    }

    async fn install(
        &self,
        expected_version: &str,
        progress: Box<dyn Fn(UpdateProgress) + Send + Sync>,
    ) -> Result<(), UpdateCommandError> {
        let update = self.app.updater()
            .map_err(classify_updater_error)?
            .check().await
            .map_err(classify_updater_error)?
            .ok_or_else(|| UpdateCommandError::new("no_update", "没有可安装的更新"))?;
        if update.version != expected_version {
            return Err(UpdateCommandError::new("version_mismatch", "可用版本已变化，请重新检查"));
        }
        let mut downloaded = 0_u64;
        update.download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                progress(UpdateProgress {
                    event: "downloading".into(),
                    downloaded,
                    total,
                });
            },
            || {},
        ).await.map_err(classify_updater_error)
    }

    fn restart(&self) -> Result<(), UpdateCommandError> {
        self.app.restart()
    }
}
```

Implement commands receiving `tauri::WebviewWindow` so caller labels are checked:

```rust
#[tauri::command]
pub async fn check_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
) -> Result<Option<UpdateMetadata>, UpdateCommandError>;

#[tauri::command]
pub async fn install_app_update(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
    expected_version: String,
) -> Result<(), UpdateCommandError>;

#[tauri::command]
pub async fn get_app_update_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, UpdateCoordinator>,
) -> Result<UpdateStatus, UpdateCommandError>;
```

The install command emits `app-update-progress` with `app.emit(...)`. Map updater errors into the exact safe codes `network`, `invalid_manifest`, `missing_architecture`, `invalid_signature`, `download_failed`, `install_failed`, and `internal`; messages must not contain endpoint credentials or key material.

Register the module, managed state, and three commands in `src-tauri/src/lib.rs`.

- [ ] **Step 4: Run focused and strict Rust gates**

```bash
pnpm test:updater-contract
cargo fmt --all -- --check
cargo test -p atools updater::tests --lib
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: all commands PASS and Clippy reports no warnings.

- [ ] **Step 5: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src-tauri/src/updater.rs src-tauri/src/lib.rs scripts/test-updater-contract.mjs
  git commit -m "feat: expose narrow updater commands"
fi
```

### Task 4: Implement the shared frontend updater controller

**Files:**
- Create: `src/lib/appUpdater.ts`
- Create: `tests/components/app-updater.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing controller tests**

Define the state contract in the test:

```ts
type AppUpdaterPhase =
  | "idle" | "checking" | "up-to-date" | "available"
  | "downloading" | "installing" | "restarting" | "error";

const update = {
  currentVersion: "3.0.0",
  version: "3.0.1",
  date: "2026-07-15T00:00:00Z",
  body: "Security and reliability fixes",
};
```

Use fake `invoke`, `listen`, and timer dependencies. Assert:

```ts
expect(fakeInvoke).toHaveBeenCalledTimes(1);
expect(controller.snapshot().phase).toBe("available");
expect(controller.snapshot().update?.version).toBe("3.0.1");
expect(controller.scheduleStartupCheck()).toBeTypeOf("function");
expect(fakeTimer.delay).toBe(3000);
await controller.installAndRestart();
expect(fakeInvoke).toHaveBeenLastCalledWith("install_app_update", { expectedVersion: "3.0.1" });
```

Also test no update, joining the same in-flight promise, error normalization, progress with and without total bytes, `dismiss()` without install, and cleanup of the event listener.

- [ ] **Step 2: Run Vitest and verify red**

```bash
pnpm test:unit -- tests/components/app-updater.test.ts
```

Expected: FAIL because `src/lib/appUpdater.ts` does not exist.

- [ ] **Step 3: Implement the dependency-injected controller**

Export these types and factory:

```ts
import { writable, get, type Readable } from "svelte/store";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AppUpdaterPhase = "idle" | "checking" | "up-to-date" | "available"
  | "downloading" | "installing" | "restarting" | "error";

export type AppUpdateMetadata = {
  currentVersion: string;
  version: string;
  date: string | null;
  body: string | null;
};

export type AppUpdaterState = {
  phase: AppUpdaterPhase;
  update: AppUpdateMetadata | null;
  checkedAt: string | null;
  downloaded: number;
  total: number | null;
  errorCode: string;
  errorMessage: string;
  promptVisible: boolean;
};

export function createAppUpdaterController(deps = defaultDependencies): {
  state: Readable<AppUpdaterState>;
  snapshot(): AppUpdaterState;
  check(source: "startup" | "manual"): Promise<AppUpdateMetadata | null>;
  scheduleStartupCheck(): () => void;
  installAndRestart(): Promise<void>;
  dismiss(): void;
  startProgressListener(): Promise<() => void>;
};
```

Keep one module-level singleton and its readable state exported separately:

```ts
export const appUpdater = createAppUpdaterController();
export const appUpdaterState = appUpdater.state;
```

`check()` stores and returns one `inFlightCheck` promise, so About and startup calls share it. Startup errors set state but keep `promptVisible: false`. Manual errors are visible on the About page. `installAndRestart()` refuses to run without an available version.

- [ ] **Step 4: Run controller tests and frontend check**

```bash
pnpm test:unit -- tests/components/app-updater.test.ts
pnpm check
```

Expected: controller tests PASS; Svelte check 0 errors / 0 warnings.

- [ ] **Step 5: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/lib/appUpdater.ts tests/components/app-updater.test.ts package.json
  git commit -m "feat: add shared updater state controller"
fi
```

### Task 5: Add the non-blocking update prompt and startup integration

**Files:**
- Create: `src/components/AppUpdatePrompt.svelte`
- Create: `tests/components/AppUpdaterHarness.svelte`
- Modify: `tests/components/app-updater.test.ts`
- Modify: `src/App.svelte`

- [ ] **Step 1: Add failing prompt interaction tests**

Render the harness with an available update. Assert the DOM and clicks:

```ts
expect(screen.getByText("发现新版本 3.0.1")).toBeTruthy();
expect(screen.getByText("Security and reliability fixes")).toBeTruthy();
await fireEvent.click(screen.getByRole("button", { name: "稍后" }));
expect(onDismiss).toHaveBeenCalledTimes(1);
expect(onInstall).not.toHaveBeenCalled();
await fireEvent.click(screen.getByRole("button", { name: "更新并重启" }));
expect(onInstall).toHaveBeenCalledTimes(1);
```

Add cases for known progress (`50%`), unknown total (`正在下载` without a percent), disabled duplicate action, and text-only release notes containing `<script>alert(1)</script>`.

- [ ] **Step 2: Run the component test and verify red**

```bash
pnpm test:unit -- tests/components/app-updater.test.ts
```

Expected: FAIL because the prompt component is missing.

- [ ] **Step 3: Implement `AppUpdatePrompt.svelte`**

Use props rather than importing the singleton inside the component:

```svelte
<script lang="ts">
  import type { AppUpdaterState } from "../lib/appUpdater";
  type Props = {
    state: AppUpdaterState;
    ondismiss: () => void;
    oninstall: () => void | Promise<void>;
  };
  let { state, ondismiss, oninstall }: Props = $props();
  let percent = $derived(state.total && state.total > 0
    ? Math.min(100, Math.round((state.downloaded / state.total) * 100))
    : null);
</script>
```

Render release notes with a normal Svelte text expression `{state.update.body}`. Do not use `{@html}`. The prompt uses `role="status"`, does not use `aria-modal`, and does not autofocus.

- [ ] **Step 4: Integrate the singleton in `src/App.svelte`**

Import `appUpdater` and `appUpdaterState`, subscribe to the latter with Svelte's `$appUpdaterState` syntax, and in the normal main-window `onMount` branch:

```ts
const stopStartupCheck = appUpdater.scheduleStartupCheck();
let stopUpdateProgress: (() => void) | undefined;
void appUpdater.startProgressListener().then((stop) => {
  if (cancelled) stop();
  else stopUpdateProgress = stop;
});
```

Cleanup both handles on unmount. Render the prompt beside the permission dialog only when `$appUpdaterState.promptVisible` is true and pass `$appUpdaterState` as its `state` prop. Do not schedule checks in floating-ball, super-panel, or plugin-detach windows.

- [ ] **Step 5: Run UI and build gates**

```bash
pnpm test:unit -- tests/components/app-updater.test.ts
pnpm check
pnpm build
```

Expected: all PASS; release notes remain escaped text.

- [ ] **Step 6: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/components/AppUpdatePrompt.svelte tests/components/AppUpdaterHarness.svelte tests/components/app-updater.test.ts src/App.svelte
  git commit -m "feat: prompt before downloading app updates"
fi
```

### Task 6: Add updater status and manual checks to About

**Files:**
- Modify: `src/components/SettingsPanel.svelte`
- Modify: `scripts/test-about-settings.mjs`
- Modify: `scripts/test-about-overview.mjs`

- [ ] **Step 1: Write failing About-page assertions**

Add static and model assertions that require:

```js
assert.match(source, /appUpdater\.check\("manual"\)/);
assert.match(source, /检查更新/);
assert.match(source, /更新并重启/);
assert.match(source, /上次检查/);
assert.doesNotMatch(source, /\{@html\s+.*update/i);
```

Add a rendered component case that checks `已是最新版本`, `发现 3.0.1`, a retryable network error, and disabled checking/installing buttons.

- [ ] **Step 2: Run About tests and verify red**

```bash
pnpm test:about-settings
pnpm test:about-overview
```

Expected: FAIL because the About page has no updater section.

- [ ] **Step 3: Implement the About updater section**

Import the singleton and derive a Chinese label from the state:

```ts
function appUpdaterStatusText(state: AppUpdaterState) {
  if (state.phase === "checking") return "正在检查更新";
  if (state.phase === "up-to-date") return "已是最新版本";
  if (state.phase === "available") return `发现 ${state.update?.version ?? "新版本"}`;
  if (state.phase === "downloading") return "正在下载更新";
  if (state.phase === "installing") return "正在安装更新";
  if (state.phase === "restarting") return "正在重启";
  if (state.phase === "error") return state.errorMessage || "检查更新失败";
  return "尚未检查更新";
}
```

Import `appUpdater`, `appUpdaterState`, and `AppUpdaterState`; render from `$appUpdaterState`. The About page button calls `appUpdater.check("manual")`; when an update is available it also shows `更新并重启`. Display `checkedAt` in the local timezone. Browser preview keeps the button disabled with `桌面应用中可用`.

- [ ] **Step 4: Run About, unit, and Svelte gates**

```bash
pnpm test:about-settings
pnpm test:about-overview
pnpm test:unit
pnpm check
```

Expected: all PASS.

- [ ] **Step 5: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add src/components/SettingsPanel.svelte scripts/test-about-settings.mjs scripts/test-about-overview.mjs
  git commit -m "feat: add update controls to About"
fi
```

### Task 7: Make release readiness enforce the exact updater contract

**Files:**
- Create: `scripts/version-contract.mjs`
- Modify: `scripts/check-macos-release-readiness.mjs`
- Modify: `scripts/test-macos-release-readiness.mjs`
- Modify: `scripts/test-version-consistency.mjs`
- Modify: `package.json`

- [ ] **Step 1: Add failing readiness cases**

Extend tests with these invalid configurations:

```js
for (const updater of [
  { pubkey: "", endpoints: ["https://github.com/harris/atools/releases/latest/download/latest.json"] },
  { pubkey: "valid-public-key-content", endpoints: ["http://github.com/harris/atools/latest.json"] },
  { pubkey: "valid-public-key-content", endpoints: ["https://example.com/latest.json"] },
  { pubkey: "valid-public-key-content", endpoints: ["https://github.com/harris/atools/releases/latest/download/latest.json"], dangerousInsecureTransportProtocol: true },
]) {
  const result = readiness.evaluateMacosReleaseReadiness({ config: productionConfig(updater), env: {}, files: new Set() });
  assert.equal(result.checks.find((check) => check.id === "updater-config")?.status, "error");
}
```

Add a tag-version helper test:

```js
assert.equal(normalizeStableReleaseTag("v3.0.0"), "3.0.0");
assert.throws(() => normalizeStableReleaseTag("v3.0.0-beta.1"), /stable/);
assert.throws(() => normalizeStableReleaseTag("release-3.0.0"), /vX.Y.Z/);
```

- [ ] **Step 2: Run and verify red**

```bash
pnpm test:macos-release-readiness
pnpm test:version-consistency
```

Expected: FAIL because updater warnings are not exact errors and tag normalization is missing.

- [ ] **Step 3: Implement strict readiness and reusable version validation**

`updaterConfigCheck` must require all of:

```js
const EXPECTED_UPDATER_ENDPOINT =
  "https://github.com/harris/atools/releases/latest/download/latest.json";
const updaterReady = config.bundle?.createUpdaterArtifacts === true
  && typeof updater?.pubkey === "string"
  && updater.pubkey.trim().length >= 40
  && JSON.stringify(updater.endpoints) === JSON.stringify([EXPECTED_UPDATER_ENDPOINT])
  && updater.dangerousInsecureTransportProtocol !== true;
```

Create the side-effect-free `scripts/version-contract.mjs` and export `normalizeStableReleaseTag`, `readPackageVersion`, `readTauriVersion`, and `assertRepositoryVersions`. `scripts/test-version-consistency.mjs` must import and test those functions; the publish workflow validator must call the same `assertRepositoryVersions` and `normalizeStableReleaseTag` functions.

After updater configuration exists, change the signing-free expected baseline from `8 ok / 3 warn / 0 error` to `9 ok / 2 warn / 0 error`; remaining warnings are Apple signing identity and notarization credentials.

- [ ] **Step 4: Run release contract gates**

```bash
pnpm test:macos-release-readiness
pnpm test:version-consistency
pnpm release:check:macos:unsigned
```

Expected: `9 ok / 2 warn / 0 error` and process exit 0.

- [ ] **Step 5: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add scripts/check-macos-release-readiness.mjs scripts/test-macos-release-readiness.mjs scripts/test-version-consistency.mjs scripts/version-contract.mjs package.json
  git commit -m "test: enforce updater release readiness"
fi
```

### Task 8: Add the two-stage GitHub publish workflow

**Files:**
- Create: `.github/workflows/publish-macos.yml`
- Create: `scripts/test-publish-workflow.mjs`
- Create: `scripts/validate-release-tag.mjs`
- Modify: `scripts/test-ci-workflow.mjs`
- Modify: `package.json`

- [ ] **Step 1: Write the failing workflow contract**

Require the new workflow to contain:

```js
assert.match(workflow, /^name:\s*Publish macOS$/m);
assert.match(workflow, /tags:\s*\n\s+- ["']v\*["']/);
assert.match(workflow, /permissions:\s*\n\s+contents:\s*write/);
assert.match(workflow, /validate-version:/);
assert.match(workflow, /prepare-draft:/);
assert.match(workflow, /publish-macos:/);
assert.match(workflow, /max-parallel:\s*1/);
assert.match(workflow, /runs-on:\s*\$\{\{ matrix\.runner \}\}/);
assert.match(workflow, /runner:\s*macos-15\b/);
assert.match(workflow, /runner:\s*macos-15-intel\b/);
assert.match(workflow, /aarch64-apple-darwin/);
assert.match(workflow, /x86_64-apple-darwin/);
assert.match(workflow, /releaseId:/);
assert.match(workflow, /verify-release:/);
assert.match(workflow, /promote-release:/);
assert.match(workflow, /TAURI_SIGNING_PRIVATE_KEY/);
assert.match(workflow, /APPLE_CERTIFICATE/);
assert.match(workflow, /gh release edit .*--draft=false.*--prerelease=false/);
assert.doesNotMatch(workflow, /pull_request:/);
```

Also ensure `.github/workflows/ci.yml` remains `contents: read` and does not receive release secrets.

- [ ] **Step 2: Run and verify red**

```bash
pnpm test:publish-workflow
pnpm test:ci-workflow
```

Expected: publish workflow test FAIL because the file is missing; CI workflow test remains PASS.

- [ ] **Step 3: Create `.github/workflows/publish-macos.yml`**

Use this job graph:

```yaml
name: Publish macOS
on:
  push:
    tags:
      - "v*"
permissions:
  contents: write
concurrency:
  group: publish-macos-${{ github.ref }}
  cancel-in-progress: false
jobs:
  validate-version: {}
  prepare-draft:
    needs: validate-version
  publish-macos:
    needs: prepare-draft
    runs-on: ${{ matrix.runner }}
    strategy:
      fail-fast: false
      max-parallel: 1
      matrix:
        include:
          - target: aarch64-apple-darwin
            runner: macos-15
          - target: x86_64-apple-darwin
            runner: macos-15-intel
  verify-release:
    needs: [prepare-draft, publish-macos]
  verify-bundle:
    needs: [prepare-draft, publish-macos]
  promote-release:
    needs: [prepare-draft, verify-release, verify-bundle]
```

Fill each applicable job with explicit checkout v5, Node 24, pnpm 11.7.0, stable Rust, target installation, frozen install, and caches matching CI. Use `macos-15` for `aarch64-apple-darwin` and `macos-15-intel` for `x86_64-apple-darwin`; do not depend on the moving `macos-latest` label. `validate-version` runs the exact quality gates from the design plus:

```bash
node scripts/validate-release-tag.mjs "${GITHUB_REF_NAME}"
```

Implement `scripts/validate-release-tag.mjs` as a thin CLI: read its one tag argument, call `normalizeStableReleaseTag`, call `assertRepositoryVersions` against the repository root, require the normalized tag version to equal all repository versions, and print `ATOOLS_RELEASE_TAG_VALIDATED {"version":"3.0.0"}` on success.

`prepare-draft` creates or reuses only a matching Draft and exposes its numeric ID via `$GITHUB_OUTPUT`. `publish-macos` uses `tauri-apps/tauri-action@v0`, the prepared `releaseId`, `uploadUpdaterJson: true`, and:

```yaml
args: --target ${{ matrix.target }} --bundles app,dmg
env:
  GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
  APPLE_CERTIFICATE: ${{ secrets.APPLE_CERTIFICATE }}
  APPLE_CERTIFICATE_PASSWORD: ${{ secrets.APPLE_CERTIFICATE_PASSWORD }}
  APPLE_SIGNING_IDENTITY: ${{ secrets.APPLE_SIGNING_IDENTITY }}
  APPLE_ID: ${{ secrets.APPLE_ID }}
  APPLE_PASSWORD: ${{ secrets.APPLE_PASSWORD }}
  APPLE_TEAM_ID: ${{ secrets.APPLE_TEAM_ID }}
  KEYCHAIN_PASSWORD: ${{ secrets.KEYCHAIN_PASSWORD }}
```

`promote-release` runs only:

```bash
gh release edit "$GITHUB_REF_NAME" --draft=false --prerelease=false --latest
```

after the verifier succeeds.

- [ ] **Step 4: Run workflow tests**

```bash
pnpm test:publish-workflow
pnpm test:ci-workflow
```

Expected: both PASS.

- [ ] **Step 5: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add .github/workflows/publish-macos.yml scripts/test-publish-workflow.mjs scripts/test-ci-workflow.mjs package.json scripts/validate-release-tag.mjs
  git commit -m "ci: publish verified macOS draft releases"
fi
```

### Task 9: Verify GitHub updater manifests before promotion

**Files:**
- Create: `scripts/verify-github-release-updater.mjs`
- Create: `scripts/test-github-release-updater.mjs`
- Modify: `.github/workflows/publish-macos.yml`
- Modify: `package.json`

- [ ] **Step 1: Write failing verifier fixture tests**

Use a complete fixture:

```js
const manifest = {
  version: "3.0.0",
  notes: "ATools 3.0 stable",
  pub_date: "2026-07-14T00:00:00Z",
  platforms: {
    "darwin-aarch64": {
      signature: "RWQAA-valid-aarch64-signature",
      url: "https://github.com/harris/atools/releases/download/v3.0.0/ATools.aarch64.app.tar.gz",
    },
    "darwin-x86_64": {
      signature: "RWQAA-valid-x64-signature",
      url: "https://github.com/harris/atools/releases/download/v3.0.0/ATools.x64.app.tar.gz",
    },
  },
};
```

Assert success plus failures for missing platform, empty signature, HTTP URL, wrong repository, wrong tag/version, duplicate URL, and an asset basename absent from the Release asset list.

- [ ] **Step 2: Run and verify red**

```bash
pnpm test:github-release-updater
```

Expected: FAIL because the verifier module is missing.

- [ ] **Step 3: Implement the pure manifest validator and CLI**

Export:

```js
export const REQUIRED_MACOS_PLATFORMS = ["darwin-aarch64", "darwin-x86_64"];
export function validateUpdaterManifest({ manifest, version, tag, assets, repository = "harris/atools" }) {
  // Return { version, platforms } or throw a precise Error.
}
```

The CLI accepts `--manifest`, `--version`, `--tag`, and repeated `--asset` values. It parses the JSON, validates both entries, and prints one line prefixed with `ATOOLS_UPDATER_RELEASE_VERIFIED ` followed by JSON. It never fetches URLs itself; the workflow downloads Release assets with authenticated `gh release download`, then passes the exact asset names.

- [ ] **Step 4: Wire the verifier into `verify-release`**

The job must:

```bash
mkdir -p release-assets
gh release download "$GITHUB_REF_NAME" --dir release-assets
node scripts/verify-github-release-updater.mjs \
  --manifest release-assets/latest.json \
  --version "${GITHUB_REF_NAME#v}" \
  --tag "$GITHUB_REF_NAME" \
  $(find release-assets -maxdepth 1 -type f -exec basename {} \; | sort | sed 's/^/--asset /')
```

Add a `verify-bundle` matrix with the same target/runner pairs used by `publish-macos`, plus `dmgPattern: '*aarch64*.dmg'` for ARM and `dmgPattern: '*x64*.dmg'` for Intel. Each job downloads the Draft assets, requires exactly one matching DMG, mounts it, and resolves the packaged app with:

```bash
APP_PATH="$(find /Volumes -maxdepth 2 -name 'ATools 3.0.app' -print -quit)"
test -n "$APP_PATH"
codesign --verify --deep --strict "$APP_PATH"
spctl --assess --type execute "$APP_PATH"
xcrun stapler validate "$APP_PATH"
pnpm smoke:macos-release-app -- --app "$APP_PATH"
```

Always detach the mounted volume in an `if: always()` cleanup step. `promote-release` must depend on successful `verify-release` and both `verify-bundle` matrix jobs.

- [ ] **Step 5: Run verifier and workflow tests**

```bash
pnpm test:github-release-updater
pnpm test:publish-workflow
```

Expected: both PASS.

- [ ] **Step 6: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add scripts/verify-github-release-updater.mjs scripts/test-github-release-updater.mjs .github/workflows/publish-macos.yml package.json
  git commit -m "test: verify updater release manifests"
fi
```

### Task 10: Add a disposable packaged-upgrade smoke and finish delivery evidence

**Files:**
- Create: `scripts/smoke-updater-package.mjs`
- Create: `scripts/test-smoke-updater-package.mjs`
- Modify: `src-tauri/src/updater.rs`
- Modify: `package.json`
- Modify: `.test-plan.md`
- Modify: `docs/macos-smoke-checklist.md`
- Modify: `docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md`

- [ ] **Step 1: Write the smoke safety test before the orchestrator**

Require the orchestrator source to use a temporary root and reject production paths:

```js
assert.match(source, /mkdtempSync\(join\(tmpdir\(\), "atools-updater-smoke-"\)\)/);
assert.match(source, /ATOOLS_UPDATER_SMOKE/);
assert.match(source, /2\.99\.99/);
assert.match(source, /3\.0\.0/);
assert.match(source, /invalid-signature/);
assert.match(source, /missing-architecture/);
assert.match(source, /finally\s*\{/);
assert.match(source, /rmSync\(root, \{ recursive: true, force: true \}\)/);
assert.doesNotMatch(source, /\/Applications\/ATools|\.atools\/data\.db/);
```

Test the report parser with `no-update`, `invalid-signature`, `missing-architecture`, and `valid-update-relaunch` fixture results.

- [ ] **Step 2: Run and verify red**

```bash
pnpm test:smoke-updater-package
```

Expected: FAIL because the smoke orchestrator is missing.

- [ ] **Step 3: Add test-only updater smoke mode**

Extend `src-tauri/src/updater.rs` so runtime endpoint overrides are accepted only when all three conditions hold:

```rust
cfg!(debug_assertions)
    && std::env::var_os("ATOOLS_UPDATER_SMOKE").as_deref() == Some(std::ffi::OsStr::new("1"))
    && endpoint.starts_with("http://127.0.0.1:")
```

Production/release builds must ignore the override. Add Rust tests for all rejected combinations and the single accepted debug-loopback case.

- [ ] **Step 4: Implement the disposable orchestrator**

`scripts/smoke-updater-package.mjs` must:

1. Create one `atools-updater-smoke-*` temporary root.
2. Generate a test-only updater keypair inside that root.
3. Build a baseline bundle using a Tauri config overlay with version `2.99.99`.
4. Build the `3.0.0` updater artifact with the test signing key.
5. Start a loopback fixture server on an ephemeral port.
6. Serve four manifests: no update, missing architecture, invalid signature, and valid update.
7. Copy the baseline `.app` into the temporary root for every mutating scenario.
8. Launch with `ATOOLS_UPDATER_SMOKE=1`, the loopback endpoint, and a report path.
9. Assert the first three scenarios do not install or restart.
10. Assert the valid scenario downloads, verifies, installs, restarts, and reports bundle version `3.0.0`.
11. Terminate child processes and remove the temporary root in `finally`.

Print exactly one machine-readable line:

```text
ATOOLS_UPDATER_PACKAGE_SMOKE {"status":"ok","checks":[...]}
```

Add commands:

```json
"test:smoke-updater-package": "node scripts/test-smoke-updater-package.mjs",
"smoke:updater-package": "node scripts/smoke-updater-package.mjs"
```

- [ ] **Step 5: Run focused smoke tests**

```bash
pnpm test:smoke-updater-package
cargo test -p atools updater::tests --lib
pnpm smoke:updater-package
```

Expected: static/parser tests PASS, Rust tests PASS, disposable smoke reports all four checks PASS and leaves no matching process or temporary directory.

- [ ] **Step 6: Run the complete deterministic verification suite**

```bash
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm test:fast
pnpm test:browser
pnpm check
pnpm build
pnpm test:desktop
pnpm release:check:macos:unsigned
pnpm smoke:macos-release-app
```

Expected:

- Rust tests: 0 failures.
- Fast and Browser tiers: all focused scripts pass.
- Svelte: 0 errors / 0 warnings.
- Production bundle budget passes.
- Desktop smoke status `ok`.
- Signing-free readiness: `9 ok / 2 warn / 0 error` until Apple credentials are configured.
- Local release app smoke: all functional checks pass; local ad-hoc Gatekeeper remains the only expected warning.

- [ ] **Step 7: Update delivery documentation with exact fresh results**

Record the actual counts, timestamps, bundle sizes, updater endpoint, key-custody boundary, workflow state, and remaining external Apple/GitHub gates. Do not mark real signed Gatekeeper or GitHub publication complete until the real workflow proves them.

- [ ] **Step 8: Commit if available**

```bash
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git add scripts/smoke-updater-package.mjs scripts/test-smoke-updater-package.mjs src-tauri/src/updater.rs package.json .test-plan.md docs/macos-smoke-checklist.md docs/superpowers/plans/2026-06-02-atools-ztools-parity-subagent-plan.md
  git commit -m "test: verify packaged updater lifecycle"
fi
```

## External production acceptance after local implementation

These steps require repository administration and real secrets; they are not simulated as complete:

1. Ensure the public repository is `https://github.com/harris/atools` and contains the intended Git history.
2. Add `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, the seven Apple/keychain secrets listed in the design, and no extra client token.
3. Store and independently verify the encrypted offline updater-key backup.
4. Push the implementation and run normal CI.
5. Push tag `v3.0.0` only after CI is green and repository versions equal `3.0.0`.
6. Confirm the workflow keeps the Release in Draft until both architecture and verification jobs pass.
7. Confirm the published Release is non-prerelease/latest and `https://github.com/harris/atools/releases/latest/download/latest.json` is public.
8. Download both DMGs on clean Apple Silicon and Intel Macs; verify install, Gatekeeper launch, About manual check, and no same-version update prompt.
9. Preserve the workflow run URL, Release URL, asset list, signing identities, notarization/stapling output, and clean-machine results in the delivery documentation.
