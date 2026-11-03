import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [app, superPanel, auxiliaryController] = await Promise.all([
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src/components/SuperPanelWindow.svelte", root), "utf8"),
  readFile(new URL("src/lib/launcherAuxiliaryWindowController.ts", root), "utf8"),
]);
const combined = app + "\n" + superPanel + "\n" + auxiliaryController;

assert.match(combined, /isSuperPanelWindow/);
assert.match(combined, /window\.location\.hash === "#\/super-panel"/);
assert.match(combined, /openMainFromSuperPanel/);
assert.match(combined, /invoke\("show_main_window"\)/);
assert.match(combined, /superPanelClipboardText/);
assert.match(combined, /readClipboardText|readText\(\)/);
assert.match(combined, /copySuperPanelText/);
assert.match(combined, /class="super-panel-shell"/);
assert.match(combined, /class="super-panel-surface"/);
assert.match(combined, /aria-label="打开 ATools 主搜索"/);
