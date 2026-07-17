import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [windowSource, commands, lib, hotkey, app] = await Promise.all([
  readFile(new URL("../src-tauri/src/window.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/commands.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/src/hotkey.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/App.svelte", import.meta.url), "utf8"),
]);

assert.match(windowSource, /PASTEBOARD_SHELF_LABEL: &str = "pasteboard-shelf"/);
assert.match(windowSource, /PASTEBOARD_SHELF_SNAP_ZONE: u32 = 12/);
assert.match(windowSource, /pasteboard\.shelf_placement/);
assert.match(windowSource, /available_monitors\(\)/);
assert.match(windowSource, /monitor_from_point\(/);
assert.match(windowSource, /restore_pasteboard_shelf_window/);
assert.match(windowSource, /reconcile_and_persist_pasteboard_shelf_window/);
assert.match(windowSource, /start_pasteboard_shelf_drag/);
assert.match(windowSource, /pasteboard_shelf_snaps_to_each_supported_edge/);
assert.match(windowSource, /pasteboard_shelf_floating_position_is_clamped_to_work_area/);
assert.match(windowSource, /pasteboard_shelf_initial_url/);
assert.match(windowSource, /\.decorations\(false\)/);
assert.match(windowSource, /\.transparent\(true\)/);
assert.match(windowSource, /\.always_on_top\(true\)/);
assert.match(windowSource, /\.skip_taskbar\(true\)/);
assert.match(windowSource, /\.content_protected\(true\)/);
assert.match(windowSource, /work_area\(\)/);
for (const command of [
  "show_pasteboard_shelf",
  "hide_pasteboard_shelf",
  "toggle_pasteboard_shelf",
  "start_pasteboard_shelf_drag",
  "get_pasteboard_shelf_window_state",
]) {
  assert.match(commands, new RegExp(`pub fn ${command}\\(`));
  assert.match(lib, new RegExp(`commands::${command}`));
}
assert.match(hotkey, /Cmd\+Shift\+V/);
assert.match(hotkey, /set_pasteboard_shelf_visible/);
assert.match(lib, /WindowEvent::Moved/);
assert.match(lib, /WindowEvent::Resized/);
assert.match(lib, /schedule_pasteboard_shelf_reconcile/);
assert.match(app, /#\/pasteboard-shelf/);
assert.match(app, /pasteboard-shelf-plugin-host/);
assert.match(app, /code === "pasteboard-pro-atools"/);

console.log("PasteboardPro shelf window source verified");
