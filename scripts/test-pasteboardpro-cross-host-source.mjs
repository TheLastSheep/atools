import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [example, verifier, server] = await Promise.all([
  readFile(new URL("../src-tauri/examples/pasteboardpro_cross_host.rs", import.meta.url), "utf8"),
  readFile(new URL("./verify-pasteboardpro-cross-host.mjs", import.meta.url), "utf8"),
  readFile(new URL("./pasteboardpro-webdav-fixture-server.mjs", import.meta.url), "utf8"),
]);

for (const token of [
  "sync_pasteboard_vault",
  "ensure_vault_metadata",
  '"seed-sync"',
  '"mutate-title"',
  '"delete-item"',
  '"inspect"',
  "PASTEBOARDPRO_FIXTURE_JSON=",
  "loopback HTTP",
]) {
  assert.match(example, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
for (const token of [
  "Rust concurrent title",
  "node-pinboard",
  "plaintextLeaks",
  "conditionalConflicts",
  "corrupted",
  "offline",
  "auth_required",
]) {
  assert.match(verifier, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
for (const token of ["MKCOL", "PROPFIND", "if-none-match", "if-match", "interruptUpload", "corrupt"]) {
  assert.match(server, new RegExp(token));
}

console.log("PasteboardPro cross-host verifier source contract verified");
