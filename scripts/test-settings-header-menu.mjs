import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [source, appSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/SettingsHeader.svelte", root), "utf8"),
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(source, /let showMoreMenu = \$state\(false\);/);
assert.match(source, /let moreMenuStatus = \$state\(""\);/);
assert.match(source, /async function copyRuntimeInfo\(\)/);
assert.match(source, /function runtimeInfoText\(\)/);
assert.match(source, /moreMenuStatus = "已复制运行信息";/);
assert.match(source, /event\.stopImmediatePropagation\(\);/);
assert.match(source, /event\.stopPropagation\(\);/);
assert.match(source, /showMoreMenu = false;\n\s*onclose\(\);/);
assert.match(source, /ATools 3\.0/);

assert.match(source, /aria-expanded=\{showMoreMenu\}/);
assert.match(source, /aria-controls="settings-more-menu"/);
assert.match(source, /class="more-menu"/);
assert.match(source, /id="settings-more-menu"/);
assert.match(source, /role="menu"/);
assert.match(source, /role="menuitem"/);
assert.match(source, />回到主搜索</);
assert.match(source, /复制运行信息/);

assert.match(source, /\.more-wrapper\s*\{[\s\S]*?position:\s*relative;/);
assert.match(source, /\.more-menu\s*\{[\s\S]*?position:\s*absolute;/);
assert.match(source, /\.more-menu\s*\{[\s\S]*?right:\s*12px;/);
assert.match(source, /\.more-menu-item\s*\{[\s\S]*?min-height:\s*42px;/);
assert.match(source, /\.more-status\s*\{[\s\S]*?font-size:\s*11px;/);

assert.match(appSource, /function settingsHeaderMenuOpen\(\)/);
assert.match(appSource, /document\.getElementById\("settings-more-menu"\)/);
assert.match(appSource, /if \(settingsHeaderMenuOpen\(\) \|\| settingsConfirmDialogOpen\(\)\) return;/);

assertSmokeChecked(
  "设置页顶部三点按钮可展开更多操作菜单；`复制运行信息` 显示复制状态，按 `Esc` 只关闭菜单不关闭设置页，`回到主搜索` 返回首页。",
  "macOS smoke checklist should mark the Settings header more menu complete",
);
