import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [header, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/SettingsHeader.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokePending = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [ ] ${row}`), message);
};
const count = (source, pattern) => [...source.matchAll(pattern)].length;

assert.equal(count(header, /<AToolsMark\b/g), 1, "settings header should render one brand mark");
assert.match(header, /<AToolsMark size="small"\s*\/>/);
assert.doesNotMatch(header, /<AToolsMark[^>]*label=/);
assert.equal(count(header, /<h1\b/g), 1, "settings header should have one primary heading");
assert.match(header, /<div class="settings-title">[\s\S]*?<h1>\s*设置\s*<\/h1>[\s\S]*?<\/div>/);
assert.doesNotMatch(header, /active-tab|secondary-tab|tab-close/);

assert.match(header, /<header class="settings-header">/);
assert.match(header, /\.settings-header\s*\{[\s\S]*?height:\s*56px;[\s\S]*?padding:\s*0\s+20px;/);
assert.match(header, /\.settings-header\s*\{[\s\S]*?-webkit-app-region:\s*drag;/);
assert.match(header, /\.settings-title\s*\{[\s\S]*?display:\s*flex;[\s\S]*?gap:\s*10px;/);
assert.match(header, /\.settings-header\s+:global\(\.atools-mark\.small\)\s*\{[\s\S]*?--mark-size:\s*30px;/);
assert.match(header, /\.more-btn\s*\{[\s\S]*?width:\s*32px;/);
assert.match(header, /\.return-button,\s*\.more-btn\s*\{[\s\S]*?height:\s*32px;/);
assert.match(header, /\.more-wrapper\s*\{[\s\S]*?-webkit-app-region:\s*no-drag;/);

const returnButton = header.match(/<button\b[^>]*class="return-button"[^>]*>[\s\S]*?<\/button>/)?.[0];
assert.ok(returnButton, "header should expose its close and return button");
assert.match(returnButton, /aria-label="回到主搜索"/);
assert.match(returnButton, /onclick=\{closeAndReturnHome\}/);
assert.match(returnButton, /返回搜索/);
assert.match(returnButton, /<svg\b[\s\S]*?(?:arrow|path)[\s\S]*?<\/svg>/i);
assert.match(header, /function closeAndReturnHome\(\)\s*\{[\s\S]*?showMoreMenu\s*=\s*false;[\s\S]*?onclose\(\);[\s\S]*?\}/);
assert.match(header, /class="more-btn"[\s\S]*?aria-haspopup="menu"[\s\S]*?aria-expanded=\{showMoreMenu\}[\s\S]*?onclick=\{toggleMoreMenu\}/);
assert.match(header, /role="menu"/);
assert.match(header, /role="menuitem"/);
assert.match(header, /function copyRuntimeInfo\(\)[\s\S]*?navigator\.clipboard\?\.writeText[\s\S]*?已复制运行信息[\s\S]*?复制失败/);
assert.match(header, /function onWindowKeydown\(event: KeyboardEvent\)[\s\S]*?event\.key !== "Escape"[\s\S]*?event\.stopImmediatePropagation\(\)[\s\S]*?closeMoreMenu\(\)/);
assert.match(header, /function onWindowClick\(\)[\s\S]*?closeMoreMenu\(\)/);

assert.match(header, /\.more-menu\s*\{[\s\S]*?right:\s*12px;/);
assert.match(header, /\.more-menu-item\s*\{[\s\S]*?min-height:\s*42px;/);
assertSmokePending(
  "设置页顶部标签、左侧宽侧栏菜单、通用设置布局接近 ZTools；顶部小/大紫色 A 标记与首页、关于页一致。",
  "macOS smoke checklist should retain manual settings header acceptance as pending",
);
