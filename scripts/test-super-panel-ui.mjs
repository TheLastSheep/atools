import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const app = await readFile(new URL("src/App.svelte", root), "utf8");

assert.match(app, /isSuperPanelWindow/);
assert.match(app, /window\.location\.hash === "#\/super-panel"/);
assert.match(app, /openMainFromSuperPanel/);
assert.match(app, /invoke\("show_main_window"\)/);
assert.match(app, /superPanelClipboardText/);
assert.match(app, /readText\(\)/);
assert.match(app, /copySuperPanelText/);
assert.match(app, /class="super-panel-shell"/);
assert.match(app, /class="super-panel-surface"/);
assert.match(app, /aria-label="打开 ATools 主搜索"/);
