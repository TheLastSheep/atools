import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const app = await readFile(new URL("src/App.svelte", root), "utf8");

assert.match(app, /isFloatingBallWindow/);
assert.match(app, /window\.location\.hash === "#\/floating-ball"/);
assert.match(app, /openMainFromFloatingBall/);
assert.match(app, /invoke\("show_main_window"\)/);
assert.match(app, /class="floating-ball-shell"/);
assert.match(app, /class="floating-ball-button"/);
assert.match(app, /aria-label="打开 ATools 主搜索"/);
