import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [commands, actions, lib, policy, panel, capabilities] = await Promise.all([
  readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/pasteboard_actions.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/pluginInvokePolicy.ts", import.meta.url), "utf8"),
  readFile(new URL("../src/components/PluginPanel.svelte", import.meta.url), "utf8"),
  readFile(new URL("../src/lib/pluginBridgeCapabilities.ts", import.meta.url), "utf8"),
]);

for (const command of [
  "pasteboard_list_items",
  "pasteboard_list_pinboards",
  "pasteboard_create_pinboard",
  "pasteboard_rename_pinboard",
  "pasteboard_update_pinboard",
  "pasteboard_move_pinboard",
  "pasteboard_delete_pinboard",
  "pasteboard_assign_items",
  "pasteboard_create_text_item",
  "pasteboard_update_text_item",
  "pasteboard_update_item_title",
  "get_pasteboard_capture_status",
  "set_pasteboard_capture_paused",
  "get_pasteboard_preferences",
  "set_pasteboard_preferences",
  "get_pasteboard_shelf_window_state",
  "start_pasteboard_shelf_drag",
  "hide_pasteboard_shelf",
  "pasteboard_get_item_preview",
  "pasteboard_recognize_item",
  "pasteboard_rotate_image",
  "pasteboard_quick_look_item",
]) {
  const commandPattern = command === "pasteboard_recognize_item"
    ? `pub async fn ${command}\\(`
    : `pub fn ${command}\\(`;
  assert.match(commands, new RegExp(commandPattern));
  assert.match(lib, new RegExp(`commands::${command}`));
  assert.match(policy, new RegExp(`"${command}"`));
}
assert.match(commands, /pub async fn pasteboard_paste_item\(/);
assert.match(commands, /pub async fn pasteboard_copy_item\(/);
assert.match(commands, /pub\(crate\) async fn pasteboard_paste_item_inner\(/);
assert.match(commands, /pasteboard_paste_item_inner\(&app, state\.inner\(\), &item_id, plain_text, true\)\.await/);
assert.match(lib, /commands::pasteboard_paste_item/);
assert.match(policy, /"pasteboard_paste_item"/);
assert.match(actions, /DEVICE_ID_SETTING_KEY/);
assert.match(actions, /pasteboard_order_key_between/);
assert.match(actions, /assign_pasteboard_item_from_device/);
assert.match(commands, /crate::pasteboard_actions::create_pinboard/);
assert.match(commands, /crate::pasteboard_actions::assign_items/);
assert.match(commands, /TaskRun::new\(\s*"pasteboard\.paste"/);
assert.match(commands, /"contentRedacted": true/);
assert.match(commands, /TaskRunStatus::Partial/);
for (const permission of ["pasteboard.read", "pasteboard.write", "pasteboard.sync"]) {
  assert.match(policy, new RegExp(`"${permission.replace(".", "\\.")}"`));
}
assert.match(panel, /window\.atools = \{\s*pasteboard:/);
for (const method of ["listItems", "listPinboards", "createPinboard", "renamePinboard", "updatePinboard", "movePinboard", "deletePinboard", "assignItems", "createTextItem", "updateTextItem", "updateItemTitle", "captureStatus", "setCapturePaused", "preferences", "savePreferences", "windowState", "startShelfDrag", "hideShelf", "itemPreview", "recognizeItem", "rotateImage", "quickLookItem", "copyItem", "pasteItem", "syncNow"]) {
  assert.match(panel, new RegExp(`${method}: function`));
  assert.match(capabilities, new RegExp(`pasteboard\\.${method}`));
}
assert.match(commands, /set_content_protected\(saved\.screen_share_protection\)/);
assert.match(commands, /update_preferences\(preferences\)/);
assert.match(commands, /TaskRun::new\(\s*capability/);
assert.match(commands, /"contentRedacted": true/);

console.log("ATools PasteboardPro plugin bridge source verified");
