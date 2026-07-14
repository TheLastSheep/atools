import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);

const [zMark, searchBar, settingsHeader] = await Promise.all([
  readFile(new URL("src/components/ZMark.svelte", root), "utf8"),
  readFile(new URL("src/components/SearchBar.svelte", root), "utf8"),
  readFile(new URL("src/components/SettingsHeader.svelte", root), "utf8"),
]);
const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(zMark, /class=\{`z-mark \$\{size\}`\}/);
assert.match(zMark, /z-stroke top/);
assert.match(zMark, /z-stroke diagonal/);
assert.match(zMark, /z-stroke bottom/);
assert.match(zMark, /aria-hidden={!label}/);

assert.match(searchBar, /import ZMark from "\.\/ZMark\.svelte";/);
assert.match(searchBar, /<ZMark size="badge" label="打开设置" \/>/);
assert.doesNotMatch(searchBar, /class="app-badge"[^>]*>Z<\/button>/);
assert.match(searchBar, /class="search-container"/);
assert.match(searchBar, /class:prominent/);
assert.match(searchBar, /class="search-input"/);
assert.match(searchBar, /class="app-badge"/);
assert.match(searchBar, /\.search-container\.prominent\s*\{[\s\S]*?min-height:\s*58px;/);
assert.match(searchBar, /\.prominent \.search-input\s*\{[\s\S]*?font-size:\s*25px;/);

assert.match(settingsHeader, /import ZMark from "\.\/ZMark\.svelte";/);
assert.match(settingsHeader, /<ZMark size="small" \/>/);
assert.match(settingsHeader, /<ZMark size="large" label="设置" \/>/);
assert.doesNotMatch(settingsHeader, />Z<\/span>/);
assert.doesNotMatch(settingsHeader, />Z<\/button>/);

assertSmokeChecked(
  "首页显示 ZTools 风格搜索框和右侧三笔画圆形 Z 图标。",
  "macOS smoke checklist should mark Home search box and Z badge complete",
);
