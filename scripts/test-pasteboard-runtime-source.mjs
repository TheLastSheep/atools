import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [runtime, macosRuntime, state, lib, commands, agentTools, cargo] = await Promise.all([
  readFile(new URL("../src-tauri/src/pasteboard_runtime.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/pasteboard_macos.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/state.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/agent_tools.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
]);

for (const outcome of ["Captured", "Duplicate", "Paused", "Sensitive", "TooLarge"]) {
  assert.match(runtime, new RegExp(`\\b${outcome}`));
}
assert.match(agentTools, /pasteboard_search_history_tool\(\)/);
assert.match(agentTools, /pasteboard_list_pinboards_tool\(\)/);
assert.match(agentTools, /state\.pasteboard_runtime\.capture_text\(text\)/);
assert.match(agentTools, /search_pasteboard_items/);
assert.match(runtime, /find_pasteboard_item_by_fingerprint/);
assert.match(runtime, /pub fn capture_snapshot/);
assert.match(runtime, /pub fn rotate_image_item/);
assert.match(runtime, /rotating_an_image_replaces_payload_blob_and_invalidates_ocr/);
assert.match(runtime, /fn store_blob/);
assert.match(runtime, /upsert_pasteboard_blob/);
assert.match(runtime, /prune_pasteboard_history/);
assert.match(runtime, /upsert_pasteboard_tombstone/);
assert.match(runtime, /TOMBSTONE_RETENTION_DAYS: u64 = 180/);
assert.match(runtime, /DEFAULT_RETENTION_DAYS: u64 = 90/);
assert.match(runtime, /looks_like_payment_card/);
assert.match(runtime, /looks_like_otp/);
assert.doesNotMatch(runtime, /tracing::.*text|println!.*text|dbg!.*text/);
assert.match(state, /pasteboard_runtime: Arc<PasteboardRuntime>/);
assert.match(lib, /Duration::from_millis\(250\)/);
assert.match(lib, /capture_text\(&text\)/);
assert.match(lib, /read_general_pasteboard/);
assert.match(lib, /general_pasteboard_change_count/);
assert.match(lib, /failed without logging content/);
for (const nativeType of ["FileURL", "PDF", "PNG", "TIFF", "HTML", "RTF", "RTFD"]) {
  assert.match(macosRuntime, new RegExp(`NSPasteboardType${nativeType}`));
}
assert.match(macosRuntime, /org\.nspasteboard\.TransientType/);
assert.match(macosRuntime, /org\.nspasteboard\.ConcealedType/);
assert.match(macosRuntime, /org\.nspasteboard\.source/);
assert.match(cargo, /objc2-app-kit/);
assert.match(cargo, /"tiff"/);
for (const command of ["get_pasteboard_capture_status", "set_pasteboard_capture_paused"]) {
  assert.match(commands, new RegExp(`pub fn ${command}\\(`));
  assert.match(lib, new RegExp(`commands::${command}`));
}

console.log("PasteboardPro native multi-type capture runtime source verified");
