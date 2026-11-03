import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [atoolsMark, searchBar, settingsHeader, settingsPanel, app, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/AToolsMark.svelte", root), "utf8"),
  readFile(new URL("src/components/SearchBar.svelte", root), "utf8"),
  readFile(new URL("src/components/SettingsHeader.svelte", root), "utf8"),
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokePending = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [ ] ${row}`), message);
};

assert.match(atoolsMark, /class=\{`atools-mark \$\{size\}`\}/);
assert.match(atoolsMark, /linear-gradient\(135deg, #645cf0 0%, #8060ed 52%, #a650e2 100%\)/);
assert.match(atoolsMark, /<svg viewBox="0 0 128 128"/);
assert.match(atoolsMark, /<path d="M25 99/);
assert.match(atoolsMark, /aria-hidden={!label}/);
assert.match(atoolsMark, /aria-label=\{label \|\| undefined\}/);
assert.match(atoolsMark, /--mark-size:\s*38px;/);
assert.match(atoolsMark, /\.atools-mark\.small\s*\{\s*--mark-size:\s*42px;/);
assert.match(atoolsMark, /\.atools-mark\.large\s*\{\s*--mark-size:\s*72px;/);
assert.doesNotMatch(atoolsMark, /z-stroke|border-radius:\s*50%/);

assert.match(searchBar, /import AToolsMark from "\.\/AToolsMark\.svelte";/);
assert.match(searchBar, /<AToolsMark size="badge" label="打开设置" \/>/);
assert.doesNotMatch(searchBar, /class="app-badge"[^>]*>Z<\/button>/);
assert.match(searchBar, /class="search-container"/);
assert.match(searchBar, /class:prominent/);
assert.match(searchBar, /class="search-input"/);
assert.match(searchBar, /class="app-badge"/);
assert.match(searchBar, /\.search-container\.prominent\s*\{[\s\S]*?min-height:\s*58px;/);
assert.match(searchBar, /\.prominent \.search-input\s*\{[\s\S]*?font-size:\s*25px;/);
assert.match(searchBar, /\.app-badge:focus-visible\s*\{[\s\S]*?outline:\s*2px solid var\(--accent\)/);

assert.match(settingsHeader, /import AToolsMark from "\.\/AToolsMark\.svelte";/);
assert.equal([...settingsHeader.matchAll(/<AToolsMark\b/g)].length, 1);
assert.match(settingsHeader, /<AToolsMark size="small"\s*\/>/);
assert.doesNotMatch(settingsHeader, /<AToolsMark[^>]*label=/);
assert.match(settingsHeader, /<div class="settings-title">[\s\S]*?<h1>\s*设置\s*<\/h1>[\s\S]*?<\/div>/);
assert.doesNotMatch(settingsHeader, />Z<\/span>|>Z<\/button>/);

assert.match(settingsPanel, /import AToolsMark from "\.\/AToolsMark\.svelte";/);
assert.match(settingsPanel, /<AToolsMark size="small" \/>/);
assert.match(app, /import AToolsMark from "\.\/components\/AToolsMark\.svelte";/);

assertSmokePending(
  "首页显示 ATools 紫色 A 标记和搜索框；设置页与关于页使用同一标记。",
  "macOS smoke checklist should record the ATools mark on Home",
);
