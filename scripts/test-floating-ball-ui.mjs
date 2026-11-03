import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [app, floatingBall, auxiliaryController] = await Promise.all([
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("src/components/FloatingBallWindow.svelte", root), "utf8"),
  readFile(new URL("src/lib/launcherAuxiliaryWindowController.ts", root), "utf8"),
]);
const combined = app + "\n" + floatingBall + "\n" + auxiliaryController;

assert.match(combined, /isFloatingBallWindow/);
assert.match(combined, /window\.location\.hash === "#\/floating-ball"/);
assert.match(combined, /openMainFromFloatingBall/);
assert.match(combined, /invoke\("show_main_window"\)/);
assert.match(combined, /class="floating-ball-shell"/);
assert.match(combined, /class="floating-ball-button"/);
assert.match(combined, /aria-label="打开 ATools 主搜索"/);
