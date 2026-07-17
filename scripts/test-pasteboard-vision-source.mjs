import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [build, macosConfig, swift, vision, commands, database, lib] = await Promise.all([
  readFile(new URL("../src-tauri/build.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/tauri.macos.conf.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/native/vision-helper/main.swift", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/pasteboard_vision.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/src/db.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
]);

assert.match(build, /pasteboard-vision-\{target\}/);
assert.match(build, /MACOSX_DEPLOYMENT_TARGET/);
assert.match(macosConfig, /binaries\/pasteboard-vision/);
assert.match(swift, /VNRecognizeTextRequest/);
assert.match(swift, /recognitionLevel = \.accurate/);
assert.match(swift, /usesLanguageCorrection = true/);
assert.match(vision, /sidecar\("pasteboard-vision"\)/);
assert.match(vision, /OCR_TIMEOUT/);
assert.match(vision, /MAX_RESPONSE_BYTES/);
assert.match(commands, /pub async fn pasteboard_recognize_item\(/);
assert.match(commands, /pub\(crate\) async fn pasteboard_recognize_item_inner\(/);
assert.match(commands, /pasteboard_recognize_item_inner\(&app, state\.inner\(\), &item_id\)\.await/);
assert.match(commands, /pub fn pasteboard_rotate_image\(/);
assert.match(commands, /pub fn pasteboard_quick_look_item\(/);
assert.match(commands, /TaskRun::new\(\s*"pasteboard\.ocr"/);
assert.match(commands, /TaskRun::new\(\s*"pasteboard\.quick_look"/);
assert.match(commands, /TaskRun::new\(\s*"pasteboard\.rotate_image"/);
assert.match(database, /update_pasteboard_item_ocr_from_device/);
assert.match(commands, /"contentRedacted": true/);
assert.match(commands, /update_pasteboard_item_ocr_from_device/);
assert.match(database, /"ocrText"\.to_string\(\)/);
assert.match(lib, /commands::pasteboard_recognize_item/);

console.log("PasteboardPro macOS Vision OCR source verified");
