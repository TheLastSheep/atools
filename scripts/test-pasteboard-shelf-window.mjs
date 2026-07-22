import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [windowSource, appLib, app, shelf, dialog] = await Promise.all([
  readFile(new URL("src-tauri/src/pasteboard_window.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src/components/PasteboardShelf.svelte", root), "utf8"),
  readFile(new URL("src/components/PasteboardDialog.svelte", root), "utf8"),
]);

assert.match(windowSource, /PASTEBOARD_SHELF_LABEL/);
assert.match(windowSource, /transparent\(true\)/);
assert.match(windowSource, /always_on_top\(true\)/);
assert.match(windowSource, /visible_on_all_workspaces\(true\)/);
assert.match(windowSource, /resolve_pasteboard_shelf_bounds/);
assert.match(windowSource, /work_width/);
assert.match(windowSource, /PASTEBOARD_DIALOG_LABEL/);
assert.match(appLib, /atools-pasteboard-shelf-smoke/);
assert.match(appLib, /show_pasteboard_shelf/);
assert.match(appLib, /if !pasteboard_shelf_smoke_enabled\(\)/);
assert.match(app, /PasteboardShelf/);
assert.match(app, /PasteboardDialog/);
assert.match(shelf, /class=\{`dock-\$\{dockEdge\}`\}/);
assert.match(shelf, /dockEdge === "left" \|\| dockEdge === "right"/);
assert.match(shelf, /Command\+V/);
assert.match(dialog, /pasteboardAttachmentBudgetBytes/);
