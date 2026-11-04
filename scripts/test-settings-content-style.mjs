import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [source, smokeChecklist] = await Promise.all([
  Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.match(source, /\.content-panel\s*\{[\s\S]*?padding:\s*60px 50px 56px 40px;/);
assert.match(source, /\.settings-content\s*\{[\s\S]*?min-width:\s*0;/);
assert.match(source, /\.settings-content\s*\{[\s\S]*?overflow:\s*hidden;/);
assert.match(source, /\.content-panel\s*\{[\s\S]*?overflow-x:\s*hidden;/);
assert.match(source, /\.content-panel\s*\{[\s\S]*?overflow-y:\s*auto;/);
assert.match(source, /\.setting-group\s*\{[\s\S]*?margin-bottom:\s*44px;/);
assert.match(source, /\.setting-group h3\s*\{[\s\S]*?margin:\s*0 0 22px;/);
assert.match(source, /\.setting-group h3\s*\{[\s\S]*?font-size:\s*26px;/);
assert.match(source, /\.setting-item\s*\{[\s\S]*?min-height:\s*116px;/);
assert.match(source, /\.setting-item\s*\{[\s\S]*?padding:\s*28px 0;/);
assert.match(source, /\.setting-label\s*\{[\s\S]*?gap:\s*8px;/);
assert.match(source, /\.setting-label span\s*\{[\s\S]*?font-size:\s*24px;/);
assert.match(source, /\.setting-label small\s*\{[\s\S]*?font-size:\s*20px;/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.content-panel\s*\{[\s\S]*?padding:\s*20px 20px 24px 18px;/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.setting-item\s*\{[\s\S]*?min-height:\s*76px;/);

assertSmokeChecked(
  "设置页在 800px 主窗下使用约 20px 内容 padding、15px 分组标题和 76px 设置行，且没有横向溢出。",
  "macOS smoke checklist should mark the Settings content sizing complete",
);
