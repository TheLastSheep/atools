import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [nativeSource, nativeLib, settingsPanel, pasteboardShelf] = await Promise.all([
  readFile(new URL("src-tauri/src/accessibility.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  readFile(new URL("src/components/PasteboardShelf.svelte", root), "utf8"),
]);

assert.match(nativeSource, /AXIsProcessTrusted/);
assert.match(nativeSource, /Privacy_Accessibility/);
assert.match(nativeSource, /pub fn get_accessibility_permission_status/);
assert.match(nativeSource, /pub fn open_accessibility_settings/);
assert.match(nativeLib, /accessibility::get_accessibility_permission_status/);
assert.match(nativeLib, /accessibility::open_accessibility_settings/);

assert.match(settingsPanel, /<span>辅助功能权限<\/span>/);
assert.match(settingsPanel, /get_accessibility_permission_status/);
assert.match(settingsPanel, /open_accessibility_settings/);
assert.match(settingsPanel, /打开系统设置/);
assert.match(settingsPanel, /重新检测/);

assert.match(pasteboardShelf, /warningCode === "accessibility_required"/);
assert.match(pasteboardShelf, /open_accessibility_settings/);
assert.match(pasteboardShelf, /get_accessibility_permission_status/);
