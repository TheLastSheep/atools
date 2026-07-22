import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const pluginRoot = new URL("resources/plugins/builtin/clipboard/", root);
const [manifestText, preload, commands, appLib, pluginPanel, shelf, dialog, nativeRuntime, nativeBackend, nativeWindow] = await Promise.all([
  readFile(new URL("plugin.json", pluginRoot), "utf8"),
  readFile(new URL("preload.js", pluginRoot), "utf8"),
  readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/components/PasteboardShelf.svelte", root), "utf8"),
  readFile(new URL("src/components/PasteboardDialog.svelte", root), "utf8"),
  readFile(new URL("src-tauri/src/pasteboard_runtime.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/pasteboard_native.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/pasteboard_window.rs", root), "utf8"),
]);
const manifest = JSON.parse(manifestText);

assert.equal(manifest.name, "Paste剪切板");
assert.equal(manifest.version, "2.0.0");
assert.equal(manifest.main, "index.html");
assert.equal(manifest.preload, "preload.js");
assert.equal(manifest.logo, "logo.png");
assert.deepEqual(manifest.permissions, ["clipboard.read", "clipboard.write"]);
await access(new URL(manifest.main, pluginRoot));
await access(new URL(manifest.logo, pluginRoot));
assert.equal(manifest.features[0].code, "paste-clipboard");
assert.equal(manifest.features[0].label, "Paste剪切板");

assert.match(preload, /utools\.clipboard\.readText\(\)/);
assert.match(preload, /utools\.clipboard\.history\(filter, MAX_HISTORY\)/);
assert.doesNotMatch(preload, /utools\.db\./);
assert.match(commands, /pub fn capture_current_clipboard_text/);
assert.match(commands, /contentRedacted/);
assert.match(commands, /record_clipboard_text/);
assert.match(appLib, /commands::capture_current_clipboard_text/);
assert.match(pluginPanel, /case 'readClipboardText':/);
assert.match(pluginPanel, /case 'listClipboardHistory':/);
assert.match(pluginPanel, /"capture_current_clipboard_text"/);
assert.match(pluginPanel, /"list_clipboard_history"/);
assert.match(appLib, /commands::pasteboard_list_items/);
assert.match(appLib, /commands::open_pasteboard_shelf_window/);
assert.match(commands, /pub fn pasteboard_list_items/);
assert.match(commands, /pub async fn pasteboard_paste_item/);
assert.match(commands, /TaskRun::new/);
assert.match(nativeRuntime, /snapshot_if_changed/);
assert.match(nativeRuntime, /prune_pasteboard_history/);
assert.match(nativeBackend, /NSPasteboard::generalPasteboard/);
assert.match(nativeBackend, /CGPreflightPostEventAccess/);
assert.match(nativeWindow, /PASTEBOARD_SHELF_LABEL/);
assert.match(nativeWindow, /transparent\(true\)/);
assert.match(nativeWindow, /visible_on_all_workspaces\(true\)/);
assert.match(shelf, /pasteboard:\/\/changed/);
assert.match(shelf, /pasteboard_list_items/);
assert.match(shelf, /队列/);
assert.match(dialog, /pasteboardAttachmentBudgetBytes/);
assert.match(dialog, /<option>MB<\/option><option>GB<\/option><option>TB<\/option>/);
