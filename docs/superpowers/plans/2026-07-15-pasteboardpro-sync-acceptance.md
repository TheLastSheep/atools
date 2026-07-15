# PasteboardPro Encrypted Sync and Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement interoperable encrypted WebDAV replication, secure credentials, cross-host visual/behavior verification, and real macOS delivery evidence.

**Architecture:** The existing ATools WebDAV settings-backup flow remains intact. PasteboardPro uses a separate `PasteboardPro/v1` encrypted vault with shared wire contracts, immutable record/blob objects, HLC field merges, tombstones, and conditional ETag index updates. Rust and Node implementations must pass the same byte-level fixtures.

**Tech Stack:** Rust `aes-gcm`/`scrypt`/`hmac`, Node `crypto`, macOS Keychain, reqwest/WebDAV, Electron/Node HTTP, Vitest, Rust integration tests, Playwright, local temporary WebDAV server.

---

## File map

**Shared workspace:**

- `packages/sync-protocol/src/wire.ts`
- `packages/sync-protocol/src/crypto-contract.ts`
- `packages/sync-protocol/src/vault.ts`
- `packages/sync-protocol/fixtures/crypto-v1.json`
- `packages/sync-protocol/fixtures/merge-v1.json`
- `packages/sync-protocol/tests/wire.test.ts`
- `packages/sync-protocol/tests/fixtures.test.ts`
- `scripts/verify-cross-host-crypto.mjs`

**ATools:**

- `src-tauri/src/pasteboard_sync.rs`
- `src-tauri/src/pasteboard_keychain.rs`
- `src-tauri/tests/pasteboard_sync_tests.rs`
- `src/lib/pasteboardSyncView.ts`
- `scripts/test-pasteboard-sync-view.mjs`
- `src/components/SettingsPanel.svelte`

**ZTools:**

- `apps/ztools/preload/sync.ts`
- `apps/ztools/preload/keychain.ts`
- `apps/ztools/tests/sync.test.ts`
- `apps/ztools/tests/keychain.test.ts`
- `apps/ztools/src/components/SyncSettings.vue`

**Acceptance:**

- `scripts/pasteboardpro-webdav-fixture-server.mjs`
- `scripts/verify-pasteboardpro-cross-host.mjs`
- `scripts/smoke-pasteboardpro-macos.mjs`
- `scripts/benchmark-pasteboardpro.mjs`

### Task 1: Freeze the wire format and byte-level crypto fixtures

**Files:**
- Create: shared `wire.ts`, `crypto-contract.ts`, `vault.ts`
- Create: `fixtures/crypto-v1.json`
- Create: `tests/wire.test.ts`, `tests/fixtures.test.ts`

- [ ] **Step 1: Write failing fixture tests**

```ts
it("derives and encrypts the v1 fixture exactly", async () => {
  const fixture = cryptoFixtureV1;
  const key = await deriveVaultKey(fixture.password, hexToBytes(fixture.salt), fixture.kdf);
  const encrypted = await encryptObject(key, fixture.object, hexToBytes(fixture.nonce));
  expect(bytesToHex(encrypted)).toBe(fixture.ciphertextHex);
});
```

- [ ] **Step 2: Verify failure**

Expected: missing crypto contract.

- [ ] **Step 3: Define the exact v1 envelope**

```ts
export type VaultObjectEnvelope = {
  version: 1;
  objectType: "item" | "pinboard" | "tombstone" | "index" | "blob";
  objectId: string;
  revision: string;
  nonce: string;
  ciphertext: string;
};
```

Canonical JSON uses UTF-8, lexicographically sorted object keys, no insignificant whitespace, and RFC 3339 UTC timestamps.

- [ ] **Step 4: Implement the TypeScript reference crypto**

Use scrypt parameters `N=32768`, `r=8`, `p=1`, 32-byte output; AES-256-GCM with a 12-byte nonce and 16-byte tag; AAD is `version\0objectType\0objectId\0revision`.

- [ ] **Step 5: Run shared tests**

Expected: deterministic fixture PASS; production helpers reject caller-supplied nonce values.

- [ ] **Step 6: Commit**

```bash
git add plugins/pasteboard-pro/packages/sync-protocol
git commit -m "feat: 固化 PasteboardPro 加密线协议" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 2: Implement ATools Keychain and encrypted vault client

**Files:**
- Create: `src-tauri/src/pasteboard_keychain.rs`
- Create: `src-tauri/src/pasteboard_sync.rs`
- Create: `src-tauri/tests/pasteboard_sync_tests.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/Cargo.toml`, `Cargo.lock`

- [ ] **Step 1: Write failing Rust compatibility tests**

Load `crypto-v1.json` and assert Rust derives the same key/ciphertext and decrypts the TypeScript fixture. Add a mock WebDAV test for 412 retry.

- [ ] **Step 2: Verify red state**

```bash
cargo test -p atools --test pasteboard_sync_tests
```

Expected: missing modules/dependencies.

- [ ] **Step 3: Add dependencies**

```toml
aes-gcm = "0.10"
scrypt = "0.11"
hmac = "0.12"
rand = "0.8"
security-framework = "3"
```

- [ ] **Step 4: Implement secure credential references**

```rust
pub trait PasteboardSecretStore {
    fn save(&self, account: &str, secret: &[u8]) -> Result<(), String>;
    fn load(&self, account: &str) -> Result<Option<Vec<u8>>, String>;
    fn delete(&self, account: &str) -> Result<(), String>;
}
```

Move the WebDAV password and derived sync key out of settings JSON. Settings retain `webdavCredentialRef` and `pasteboardSyncKeyRef` only.

- [ ] **Step 5: Implement the vault client**

Expose:

```rust
pub async fn sync_pasteboard_vault(runtime: &PasteboardRuntime, config: PasteboardSyncConfig) -> Result<PasteboardSyncResult, String>;
```

The client reads `vault.json`, decrypts `index.enc`, merges records, uploads immutable objects, and updates the index with `If-Match`. Retry 412 conflicts three times; return `partial` with failed object IDs after scoped retries.

Sync text, rich text, HTML, URLs, colors, OCR metadata, images, and PDFs by default. Sync arbitrary file contents only when the user enables the option and reject any individual file larger than 100 MiB; otherwise sync metadata and mark the remote item unavailable.

- [ ] **Step 6: Run Rust tests**

Expected: fixture compatibility, wrong-password no-write, corrupted-tag rejection, ETag retry, interrupted blob resume, and tombstone merge PASS.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml Cargo.lock src-tauri/src/pasteboard_keychain.rs src-tauri/src/pasteboard_sync.rs src-tauri/src/lib.rs src-tauri/src/commands.rs src-tauri/tests/pasteboard_sync_tests.rs
git commit -m "feat: 增加 ATools 加密剪贴板同步" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 3: Implement ZTools Keychain and encrypted vault client

**Files:**
- Create: `apps/ztools/preload/keychain.ts`
- Create: `apps/ztools/preload/sync.ts`
- Create: `apps/ztools/tests/keychain.test.ts`
- Create: `apps/ztools/tests/sync.test.ts`

- [ ] **Step 1: Write failing Keychain command tests**

The adapter must use `execFile`, never `exec` or a shell string:

```ts
expect(calls[0]).toEqual({ file: "/usr/bin/security", args: ["add-generic-password", "-U", "-s", service, "-a", account, "-w", secret] });
```

- [ ] **Step 2: Verify failure**

Expected: missing Keychain/sync modules.

- [ ] **Step 3: Implement Keychain access**

Use service `com.pasteboardpro.ztools.sync`; store WebDAV credential and derived key as separate accounts. Cap stderr/stdout and redact command arguments from logs.

- [ ] **Step 4: Implement Node crypto compatibility**

Use `crypto.scrypt(password, salt, 32, options, callback)`, `createCipheriv("aes-256-gcm", key, nonce)`, `setAAD(aad)`, and `getAuthTag()`. Read the shared fixture and produce the exact same bytes as Rust/TypeScript.

- [ ] **Step 5: Implement WebDAV conditional sync**

Use HTTPS only, Basic Auth from Keychain, origin allowlisting, `If-Match`, three merge retries, and scoped blob retry. Never send credentials to preview URLs.

Apply the same payload selection policy as Rust: images/PDFs default on, arbitrary file contents opt-in, 100 MiB per-item maximum, and explicit unavailable state for metadata-only remote files.

- [ ] **Step 6: Run ZTools sync tests**

Expected: PASS for fixture compatibility, wrong password, 412 conflict, corruption, and offline queue.

- [ ] **Step 7: Commit**

```bash
git add plugins/pasteboard-pro/apps/ztools/preload/keychain.ts plugins/pasteboard-pro/apps/ztools/preload/sync.ts plugins/pasteboard-pro/apps/ztools/tests
git commit -m "feat: 增加 ZTools 加密剪贴板同步" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 4: Add sync settings and status without storing secrets in UI state

**Files:**
- Modify: ATools `src/components/SettingsPanel.svelte`, `src/lib/settings.ts`
- Create: ATools `src/lib/pasteboardSyncView.ts`, `scripts/test-pasteboard-sync-view.mjs`
- Create: ZTools `apps/ztools/src/components/SyncSettings.vue`

- [ ] **Step 1: Write failing view-model tests**

```ts
expect(pasteboardSyncStatus({ state: "wrong_password" }).tone).toBe("error");
expect(pasteboardSyncStatus({ state: "offline", pendingObjects: 4 }).action).toBe("retry");
expect(JSON.stringify(settings)).not.toContain("syncPassword");
```

- [ ] **Step 2: Verify failures**

Expected: missing view models/components.

- [ ] **Step 3: Add ATools settings**

Add enable toggle, WebDAV path, sync-password setup/rotation, last verified sync, pending objects, retry, and destructive new-vault confirmation. Password inputs are passed directly to native commands and cleared immediately.

- [ ] **Step 4: Add ZTools settings**

Expose the same user-visible states and actions in Vue. Do not persist password refs in the plugin database; store only Keychain account IDs and non-secret sync state.

- [ ] **Step 5: Run focused UI tests**

Expected: PASS for offline, wrong password, partial, corrupted, schema-too-new, and success states.

- [ ] **Step 6: Commit ATools changes**

```bash
git add src/components/SettingsPanel.svelte src/lib/settings.ts src/lib/pasteboardSyncView.ts scripts/test-pasteboard-sync-view.mjs package.json
git commit -m "feat: 增加 PasteboardPro 同步设置" \
  -m "AI-Co-Authored-By: Codex"
```

- [ ] **Step 7: Commit ZTools changes**

```bash
git add plugins/pasteboard-pro/apps/ztools/src/components/SyncSettings.vue
git commit -m "feat: 增加 ZTools 同步状态界面" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 5: Prove cross-host crypto and merge compatibility

**Files:**
- Create: shared `scripts/verify-cross-host-crypto.mjs`
- Create: ATools `scripts/pasteboardpro-webdav-fixture-server.mjs`
- Create: ATools `scripts/verify-pasteboardpro-cross-host.mjs`
- Modify: ATools `package.json`

- [ ] **Step 1: Implement the fixture server**

Support `MKCOL`, `PROPFIND`, `GET`, `PUT`, ETag, `If-Match`, injected 401/412/500 responses, byte corruption, and interrupted uploads. Bind only to `127.0.0.1` and use a temporary directory.

- [ ] **Step 2: Write the cross-host orchestration**

The verifier must:

1. Create a vault with ATools/Rust.
2. Read and update it with ZTools/Node.
3. Read the update with ATools/Rust.
4. Apply concurrent title and Pinboard edits.
5. Verify both survive merge.
6. Delete on one host and verify the tombstone on the other.

- [ ] **Step 3: Run the compatibility gate**

```bash
pnpm verify:pasteboardpro-cross-host
```

Expected: PASS with a JSON report containing fixture version, object counts, retries, and zero plaintext leaks.

- [ ] **Step 4: Add plaintext leak checks**

Search the temporary WebDAV directory for known fixture text, titles, OCR strings, file names, and credentials. The verifier must fail if any appear.

- [ ] **Step 5: Commit**

```bash
git add scripts/pasteboardpro-webdav-fixture-server.mjs scripts/verify-pasteboardpro-cross-host.mjs package.json
git commit -m "test: 验证 PasteboardPro 跨宿主加密兼容" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 6: Build visual, keyboard, and real macOS acceptance

**Files:**
- Create in both apps: `playwright.config.ts`
- Create in both apps: `tests/visual/shelf-modes.spec.ts`
- Create in both apps: `tests/visual/docking.spec.ts`
- Create in both apps: `tests/visual/search-pinboards.spec.ts`
- Create in both apps: `tests/visual/preview-stack.spec.ts`
- Create in ATools: `scripts/smoke-pasteboardpro-macos.mjs`, `scripts/benchmark-pasteboardpro.mjs`
- Modify: ATools `docs/macos-smoke-checklist.md`, `package.json`

- [ ] **Step 1: Add the visual matrix**

Capture host-specific goldens for Expanded/Compact, floating/bottom/left/right, light/dark, reduced motion, search, Pinboards, preview, and Paste Stack. Compare layout boxes and tokens across hosts even when pixel blur differs.

- [ ] **Step 2: Add shared keyboard replay**

Replay the same fixture through Svelte and Vue and write a JSON result. Fail if selected IDs, Paste Stack IDs, Pinboard order, or action names differ.

- [ ] **Step 3: Implement real macOS smoke**

Use disposable fixture content and controlled apps to verify text, rich text, HTML, links, images, PDFs, colors, files, OCR, multi-select, drag, plain text, Quick Paste, and Paste Stack. Guard every destructive/interactive action behind `ATOOLS_PASTEBOARDPRO_SMOKE=1`.

- [ ] **Step 4: Implement lifecycle and performance checks**

Cover restart, sleep/wake, display attach/detach, permission revoke/restore, burst capture, 10k/100k search, warm reveal P95, idle CPU, and scroll frames.

- [ ] **Step 5: Run deterministic gates**

```bash
pnpm verify:pasteboardpro-cross-host
pnpm test:pasteboardpro-visual
pnpm benchmark:pasteboardpro
```

Expected: PASS and reports under `artifacts/pasteboardpro/`.

- [ ] **Step 6: Run interactive macOS smoke only after authorization**

```bash
ATOOLS_PASTEBOARDPRO_SMOKE=1 pnpm smoke:pasteboardpro-macos
```

Expected: PASS on both ATools and ZTools with screenshot and action logs.

- [ ] **Step 7: Commit evidence**

```bash
git add package.json scripts/smoke-pasteboardpro-macos.mjs scripts/benchmark-pasteboardpro.mjs docs/macos-smoke-checklist.md
git commit -m "test: 完成 PasteboardPro 双端真实验收" \
  -m "AI-Co-Authored-By: Codex"
```

### Task 7: Close signing, packaging, and release blockers

**Files:**
- Modify: ATools `docs/pasteboardpro-delivery-audit.md`
- Modify: ZTools `plugins/pasteboard-pro/README.md`

- [ ] **Step 1: Verify package contents**

Reject source maps, node_modules, local databases, WebDAV credentials, Keychain dumps, test fixture secrets, unsigned helper binaries, and absolute development paths.

- [ ] **Step 2: Verify signatures and Gatekeeper**

```bash
codesign --verify --deep --strict <ATools.app>
spctl --assess --type execute --verbose=4 <ATools.app>
codesign --verify --deep --strict <pasteboard-vision-helper>
```

Expected: all PASS. Missing signing/notarization material is an explicit external blocker, not a local success.

- [ ] **Step 3: Record final release reachability**

Document exact branches, commits, workflow runs, artifacts, and whether both plugin packages are reachable from their intended distribution path.

- [ ] **Step 4: Commit final audit updates**

Use the delivery evidence commits defined in the roadmap plan.
