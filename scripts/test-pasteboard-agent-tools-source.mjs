import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [actions, commands, agentTools, mcp] = await Promise.all([
  readFile(new URL("../src-tauri/src/pasteboard_actions.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/agent_tools.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/src/mcp.rs", import.meta.url), "utf8"),
]);

for (const action of ["create_pinboard", "update_pinboard", "move_pinboard", "delete_pinboard", "assign_items"]) {
  assert.match(actions, new RegExp(`pub fn ${action}\\(`));
  assert.match(commands, new RegExp(`pasteboard_actions::${action}`));
  assert.match(agentTools, new RegExp(`pasteboard_actions::${action}`));
}
for (const tool of [
  "pasteboard_create_pinboard",
  "pasteboard_update_pinboard",
  "pasteboard_move_pinboard",
  "pasteboard_delete_pinboard",
  "pasteboard_assign_items",
  "pasteboard_paste_item",
  "pasteboard_copy_item",
  "pasteboard_get_item",
  "pasteboard_recognize_item",
  "pasteboard_sync_status",
  "pasteboard_sync_vault",
]) {
  assert.match(agentTools, new RegExp(`"${tool}"`));
  assert.match(mcp, new RegExp(tool));
}
assert.match(agentTools, /PermissionScope::ClipboardWrite/);
assert.match(agentTools, /agent_pinboard_tools_share_local_actions_and_write_scope/);
assert.match(commands, /pub\(crate\) async fn sync_pasteboard_vault_inner\(/);
assert.match(commands, /sync_pasteboard_vault_inner\(&state\)\.await/);
assert.match(commands, /TaskRun::new\(\s*"pasteboard\.sync"/);
assert.match(agentTools, /sync_pasteboard_vault_inner\(state\.inner\(\)\)\.await/);
const syncTool = agentTools.match(
  /fn pasteboard_sync_vault_tool\(\)[\s\S]*?\n\}/,
)?.[0];
assert.ok(syncTool, "missing PasteboardPro sync Agent tool");
for (const scope of ["ClipboardRead", "ClipboardWrite", "Network"]) {
  assert.match(syncTool, new RegExp(`PermissionScope::${scope}`));
}
assert.match(mcp, /use pasteboard_sync_vault only for a configured encrypted WebDAV vault/);
assert.match(commands, /pub\(crate\) async fn pasteboard_paste_item_inner\(/);
assert.match(commands, /pasteboard_paste_item_inner\(&app, state\.inner\(\), &item_id, plain_text, true\)\.await/);
assert.match(agentTools, /pasteboard_paste_item_inner\(\s*app,\s*state\.inner\(\),\s*&item_id,\s*plain_text,\s*true/);
const pasteTool = agentTools.match(
  /fn pasteboard_paste_item_tool\(\)[\s\S]*?\n\}/,
)?.[0];
assert.ok(pasteTool, "missing PasteboardPro paste Agent tool");
for (const scope of ["ClipboardRead", "ClipboardWrite", "Shell"]) {
  assert.match(pasteTool, new RegExp(`PermissionScope::${scope}`));
}
assert.match(mcp, /use pasteboard_paste_item only after ClipboardRead, ClipboardWrite, and Shell permission checks/);
const copyTool = agentTools.match(/fn pasteboard_copy_item_tool\(\)[\s\S]*?\n\}/)?.[0];
assert.ok(copyTool, "missing PasteboardPro copy Agent tool");
for (const scope of ["ClipboardRead", "ClipboardWrite"]) {
  assert.match(copyTool, new RegExp(`PermissionScope::${scope}`));
}
assert.doesNotMatch(copyTool, /PermissionScope::Shell/);
assert.match(mcp, /Use pasteboard_copy_item after ClipboardRead and ClipboardWrite permission checks/);
assert.match(commands, /pub\(crate\) async fn pasteboard_recognize_item_inner\(/);
assert.match(commands, /pasteboard_recognize_item_inner\(&app, state\.inner\(\), &item_id\)\.await/);
assert.match(agentTools, /pasteboard_recognize_item_inner\(app, state\.inner\(\), &item_id\)\.await/);
const recognizeTool = agentTools.match(
  /fn pasteboard_recognize_item_tool\(\)[\s\S]*?\n\}/,
)?.[0];
assert.ok(recognizeTool, "missing PasteboardPro item OCR Agent tool");
for (const scope of ["ClipboardRead", "Screenshot"]) {
  assert.match(recognizeTool, new RegExp(`PermissionScope::${scope}`));
}
assert.match(recognizeTool, /recognized body is saved locally for search but omitted from Agent audit and TaskRun output/);
assert.match(agentTools, /"contentRedacted": true/);
assert.doesNotMatch(
  agentTools.match(/async fn recognize_pasteboard_item[\s\S]*?\n\}/)?.[0] ?? "",
  /"text"\s*:/,
);
assert.match(mcp, /Use pasteboard_recognize_item for local OCR of a managed PasteboardPro image/);
assert.match(agentTools, /fn pasteboard_get_item_tool\(\)/);
assert.match(agentTools, /fn pasteboard_sync_status_tool\(\)/);
assert.match(agentTools, /"contentRedacted": true/);
assert.match(agentTools, /without returning clipboard text, OCR text, titles, or paths/);
assert.match(agentTools, /without returning WebDAV credentials, vault keys, URLs, or clipboard content/);
assert.match(agentTools, /pasteboard_sync_settings_inner\(state\.inner\(\)\)/);
assert.match(mcp, /Use pasteboard_sync_status for local redacted vault state/);

console.log("PasteboardPro shared UI and Agent actions verified");
