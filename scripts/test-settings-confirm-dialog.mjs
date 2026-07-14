import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [panel, dialog, appSource, smokeChecklist] = await Promise.all([
  readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
  readFile(new URL("src/components/SettingsConfirmDialog.svelte", root), "utf8"),
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(panel, /import SettingsConfirmDialog from "\.\/SettingsConfirmDialog\.svelte";/);
assert.match(panel, /type SettingsConfirmRequest = \{/);
assert.match(panel, /let settingsConfirmRequest = \$state<SettingsConfirmRequest \| null>\(null\);/);
assert.match(panel, /function confirmSettingsAction\(/);
assert.match(panel, /function resolveSettingsConfirm\(/);
assert.match(panel, /<SettingsConfirmDialog/);
assert.match(panel, /settingsConfirmRequest = null;/);
assert.doesNotMatch(panel, /\bconfirm\(/);
assert.doesNotMatch(panel, /window\.confirm/);

for (const phrase of [
  "恢复 WebDAV 设置",
  "导入剪贴板历史",
  "清空最近使用历史",
  "清空剪贴板历史",
  "恢复默认设置",
  "清空审计记录",
  "清空插件数据",
  "清空崩溃日志",
]) {
  assert.match(panel, new RegExp(phrase));
}

assert.match(dialog, /role="dialog"/);
assert.match(dialog, /aria-modal="true"/);
assert.match(dialog, /class="confirm-scrim"/);
assert.match(dialog, /class="confirm-panel"/);
assert.match(dialog, /class:danger=\{tone === "danger"\}/);
assert.match(dialog, /onclick=\{onconfirm\}/);
assert.match(dialog, /onclick=\{oncancel\}/);
assert.match(dialog, /event\.key === "Escape"/);
assert.match(dialog, /event\.stopPropagation\(\);/);
assert.match(dialog, /\.confirm-panel\s*\{[\s\S]*?border-radius:\s*12px;/);
assert.match(dialog, /\.confirm-button\.danger\s*\{[\s\S]*?color:\s*#fff;/);

assert.match(appSource, /function settingsConfirmDialogOpen\(\)/);
assert.match(appSource, /document\.querySelector\([\s\S]*?\[role="dialog"\]\[aria-modal="true"\][\s\S]*?\)/);
assert.match(appSource, /settingsHeaderMenuOpen\(\) \|\| settingsConfirmDialogOpen\(\)/);

assertSmokeChecked(
  "设置页恢复默认、清空历史/审计/插件数据/崩溃日志、WebDAV 恢复/导入剪贴板等危险操作使用应用内确认弹窗，不出现浏览器原生 `confirm`；按 `Esc` 或 `取消` 只关闭弹窗，不关闭设置页且保留当前左侧菜单。",
  "macOS smoke checklist should mark embedded Settings confirmation dialogs complete",
);
