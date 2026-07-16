import assert from "node:assert/strict";
import { createCipheriv, scrypt as scryptCallback } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const [syncSource, keychainSource, cargo, fixtureSource] = await Promise.all([
  readFile(new URL("../src-tauri/src/pasteboard_sync.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/pasteboard_keychain.rs", import.meta.url), "utf8"),
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
