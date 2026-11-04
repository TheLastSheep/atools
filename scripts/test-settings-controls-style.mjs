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

assert.match(source, /\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?height:\s*66px;/);
assert.match(source, /\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?border-radius:\s*9px;/);
assert.match(source, /\.hotkey-input\s*\{[\s\S]*?width:\s*300px;/);
assert.match(source, /\.text-input\s*\{[\s\S]*?width:\s*380px;/);
assert.match(source, /\.text-input\.wide\s*\{[\s\S]*?width:\s*440px;/);
assert.match(source, /\.select-control\s*\{[\s\S]*?min-width:\s*300px;/);
assert.match(source, /\.select-control\s*\{[\s\S]*?background:[\s\S]*?calc\(100% - 29px\) 29px \/ 9px 9px no-repeat,[\s\S]*?calc\(100% - 22px\) 29px \/ 9px 9px no-repeat,/);
assert.match(source, /\.icon-button,\s*\n\s*\.plain-button\s*\{[\s\S]*?min-height:\s*54px;/);
assert.match(source, /\.icon-button\s*\{[\s\S]*?width:\s*56px;/);
assert.match(source, /\.plain-button\s*\{[\s\S]*?padding:\s*0 22px;/);
assert.match(source, /\.toggle\s*\{[\s\S]*?width:\s*86px;[\s\S]*?height:\s*48px;[\s\S]*?flex:\s*0 0 86px;/);
assert.match(source, /\.toggle span::before\s*\{[\s\S]*?top:\s*5px;[\s\S]*?left:\s*5px;[\s\S]*?width:\s*34px;[\s\S]*?height:\s*34px;/);
assert.match(source, /\.toggle input:checked \+ span::before\s*\{[\s\S]*?transform:\s*translateX\(38px\);/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?height:\s*40px;/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.hotkey-input,\s*\n\s*\.select-control,\s*\n\s*\.text-input,\s*\n\s*\.number-input\s*\{[\s\S]*?max-width:\s*100%;/);
assert.match(source, /@media \(max-width: 1000px\)\s*\{[\s\S]*?\.toggle\s*\{[\s\S]*?width:\s*52px;[\s\S]*?height:\s*30px;/);

assertSmokeChecked(
  "设置页在 800px 主窗下使用约 40px 高输入/下拉、36px 按钮和 52x30px 开关，且没有横向溢出。",
  "macOS smoke checklist should mark the Settings desktop controls sizing complete",
);
