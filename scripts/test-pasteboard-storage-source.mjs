import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [model, database, config, exports, tests] = await Promise.all([
  readFile(new URL("../crates/atools-core/src/pasteboard.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/src/db.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/src/config.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/tests/pasteboard_tests.rs", import.meta.url), "utf8"),
]);

for (const canonicalField of [
  "source_device_id",
  "content_fingerprint",
  "pinboard_order_key",
  "field_clocks",
  "wall_ms",
  "entity_type",
]) {
  assert.match(model, new RegExp(`pub ${canonicalField}:`));
}
for (const kind of ["Text", "RichText", "Html", "Url", "Image", "Pdf", "Color", "Files"]) {
  assert.match(model, new RegExp(`\\b${kind},`));
}
for (const table of [
  "pasteboard_items",
  "pasteboard_pinboards",
  "pasteboard_tombstones",
  "pasteboard_blobs",
]) {
  assert.match(database, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
}
for (const method of [
  "upsert_pasteboard_item",
  "search_pasteboard_items",
  "list_pasteboard_items_for_sync",
  "assign_pasteboard_item_from_device",
  "upsert_pinboard",
  "upsert_pasteboard_tombstone",
  "upsert_pasteboard_blob",
  "prune_pasteboard_history",
]) {
  assert.match(database, new RegExp(`pub fn ${method}\\(`));
}
assert.match(database, /WHERE pinned = 0 AND pinboard_id IS NULL/);
assert.match(database, /delete_pasteboard_item_and_orphan_blob/);
assert.match(model, /pub deleted_item_ids: Vec<String>/);
assert.match(model, /pub fn pasteboard_order_key_between/);
assert.match(tests, /order_keys_match_the_shared_base62_contract/);
assert.match(config, /pub fn pasteboard_blobs_dir/);
assert.match(config, /create_dir_all\(self\.pasteboard_blobs_dir\(\)\)/);
assert.match(exports, /pub mod pasteboard;/);
assert.match(tests, /pruning_never_removes_pinboard_or_pinned_items/);
assert.match(tests, /tombstone_replaces_live_entity_and_live_revision_can_restore_it/);

console.log("PasteboardPro durable storage source verified");
