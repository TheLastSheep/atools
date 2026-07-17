import assert from "node:assert/strict";
import { createCipheriv, scrypt as scryptCallback } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const [syncSource, keychainSource, commandsSource, libSource, cargo, fixtureSource] = await Promise.all([
  readFile(new URL("../src-tauri/src/pasteboard_sync.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/pasteboard_keychain.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
  readFile(
    new URL(
      "../src-tauri/tests/fixtures/pasteboard-crypto-v1.json",
      import.meta.url,
    ),
    "utf8",
  ),
]);

for (const dependency of ["aes-gcm", "scrypt", "hmac", "rand", "security-framework"]) {
  assert.match(cargo, new RegExp(`^${dependency}\\s*=`, "m"));
}
assert.match(syncSource, /pub const SCRYPT_N: u32 = 32_768;/);
assert.match(syncSource, /pub const SCRYPT_R: u32 = 8;/);
assert.match(syncSource, /pub const SCRYPT_P: u32 = 1;/);
assert.match(syncSource, /pub const NONCE_BYTES: usize = 12;/);
assert.match(syncSource, /pub const TAG_BYTES: usize = 16;/);
assert.match(syncSource, /pub fn encrypt_object\([^)]*value: &Value,/s);
assert.doesNotMatch(
  syncSource.match(/pub fn encrypt_object[\s\S]*?\n\}/)?.[0] ?? "",
  /nonce_bytes/,
);
assert.match(syncSource, /fn encrypt_with_nonce\(/);
assert.match(keychainSource, /const SERVICE: &str = "com\.atools\.pasteboardpro\.sync";/);
assert.match(keychainSource, /WEBDAV_ACCOUNT: &str = "webdav"/);
assert.match(keychainSource, /VAULT_KEY_ACCOUNT: &str = "vault-key"/);
assert.doesNotMatch(keychainSource, /println!|dbg!|tracing::.*secret/);
assert.match(syncSource, /PasteboardPro WebDAV URL must use HTTPS/);
assert.match(syncSource, /redirect\(reqwest::redirect::Policy::none\(\)\)/);
assert.match(syncSource, /MAX_INDEX_CONFLICT_RETRIES: usize = 3/);
assert.match(syncSource, /pub async fn sync_pasteboard_vault</);
assert.match(syncSource, /pub fn encrypt_bytes/);
assert.match(syncSource, /pub fn decrypt_envelope_bytes/);
assert.match(syncSource, /pub fn vault_bytes_revision/);
assert.match(syncSource, /fn encrypted_blob/);
assert.match(syncSource, /fn parse_remote_blob/);
assert.match(syncSource, /fn store_remote_blob/);
assert.match(syncSource, /uploads_referenced_blob_before_publishing_the_index/);
assert.match(syncSource, /MAX_BLOB_PLAINTEXT_BYTES: usize = 100 \* 1024 \* 1024/);
assert.match(syncSource, /fn merge_items\(/);
assert.match(syncSource, /fn merge_pinboards\(/);
assert.match(syncSource, /fn merge_entities\(/);
assert.match(syncSource, /partial_object_upload_leaves_authoritative_index_untouched/);
assert.match(syncSource, /wrong_vault_key_never_writes_remote_objects_or_index/);
assert.match(syncSource, /authoritative index is left untouched/);
const indexUpdater = syncSource.match(
  /pub async fn update_encrypted_index[\s\S]*?PasteboardPro index retry state is unreachable/,
)?.[0];
assert.ok(indexUpdater, "missing conditional index updater");
assert.ok(
  indexUpdater.indexOf("let next_index = build_index") <
    indexUpdater.indexOf('"PUT"'),
  "index must be authenticated and built before the first PUT",
);
assert.match(commandsSource, /pub async fn configure_pasteboard_sync\(/);
assert.match(commandsSource, /verify_remote_vault_key\(&transport, &key\)\.await\?/);
const configureCommand = commandsSource.match(
  /pub async fn configure_pasteboard_sync\([\s\S]*?\n\}\n\n#\[derive\(Debug, Clone, serde::Serialize, PartialEq, Eq\)\]/,
)?.[0];
assert.ok(configureCommand, "missing PasteboardPro configuration command");
const remoteVerificationOffset = configureCommand.indexOf(
  "verify_remote_vault_key(&transport, &key).await?",
);
assert.ok(remoteVerificationOffset >= 0, "missing remote vault key verification");
for (const writeNeedle of [
  "keychain.save(WEBDAV_ACCOUNT",
  "keychain.save(VAULT_KEY_ACCOUNT",
  "save_pasteboard_sync_settings(&state.db, &settings)",
]) {
  assert.ok(
    configureCommand.indexOf(writeNeedle) > remoteVerificationOffset,
    `${writeNeedle} must happen after remote verification`,
  );
}
const publicSettings = commandsSource.match(
  /pub struct PasteboardSyncSettings \{[\s\S]*?\n\}/,
)?.[0];
assert.ok(publicSettings, "missing public PasteboardPro sync settings contract");
assert.doesNotMatch(publicSettings, /password|secret/i);
assert.match(libSource, /commands::configure_pasteboard_sync/);
assert.match(libSource, /commands::get_pasteboard_sync_settings/);
assert.match(libSource, /commands::sync_pasteboard_vault/);
assert.match(commandsSource, /run_pasteboard_vault_sync\(/);
assert.match(commandsSource, /&state\.config\.pasteboard_dir\(\)/);
assert.match(commandsSource, /pasteboard_sync_lock\s*\.try_lock\(\)/);
assert.match(commandsSource, /pub\(crate\) async fn sync_pasteboard_vault_inner\(/);
assert.match(commandsSource, /TaskRun::new\(\s*"pasteboard\.sync"/);
assert.match(commandsSource, /TaskRunStatus::Partial/);
assert.match(commandsSource, /TaskRunStatus::Failed/);

const fixture = JSON.parse(fixtureSource);
const scrypt = promisify(scryptCallback);
const key = await scrypt(
  fixture.password,
  Buffer.from(fixture.saltHex, "hex"),
  32,
  { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
);
assert.equal(Buffer.from(key).toString("hex"), fixture.derivedKeyHex);
const descriptor = fixture.descriptor;
const cipher = createCipheriv(
  "aes-256-gcm",
  key,
  Buffer.from(fixture.nonceHex, "hex"),
  { authTagLength: 16 },
);
cipher.setAAD(
  Buffer.from(
    `${descriptor.version}\0${descriptor.objectType}\0${descriptor.objectId}\0${descriptor.revision}`,
  ),
);
const canonicalObject = JSON.stringify(
  Object.fromEntries(Object.entries(fixture.object).sort(([a], [b]) => a.localeCompare(b))),
);
const encrypted = Buffer.concat([
  cipher.update(canonicalObject, "utf8"),
  cipher.final(),
  cipher.getAuthTag(),
]);
assert.equal(encrypted.toString("hex"), fixture.ciphertextAndTagHex);

console.log("PasteboardPro Rust source and cross-host crypto fixture verified");
