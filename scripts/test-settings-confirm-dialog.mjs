import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [panel, dialog, appSource, smokeChecklist] = await Promise.all([
  Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
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
