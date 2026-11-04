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

assert.match(source, /\.settings-sidebar,\s*\.content-panel\s*\{[\s\S]*?scrollbar-gutter:\s*stable;/);
assert.match(source, /\.settings-sidebar,\s*\.content-panel\s*\{[\s\S]*?scrollbar-width:\s*thin;/);
assert.match(source, /\.settings-sidebar,\s*\.content-panel\s*\{[\s\S]*?scrollbar-color:\s*rgba\(0,\s*0,\s*0,\s*0\.2\)\s*transparent;/);

assert.match(source, /\.settings-sidebar::-webkit-scrollbar,\s*\.content-panel::-webkit-scrollbar\s*\{[\s\S]*?width:\s*10px;/);
assert.match(source, /\.settings-sidebar::-webkit-scrollbar-track,\s*\.content-panel::-webkit-scrollbar-track\s*\{[\s\S]*?background:\s*transparent;/);
assert.match(source, /\.settings-sidebar::-webkit-scrollbar-thumb,\s*\.content-panel::-webkit-scrollbar-thumb\s*\{[\s\S]*?border:\s*3px solid transparent;/);
assert.match(source, /\.settings-sidebar::-webkit-scrollbar-thumb,\s*\.content-panel::-webkit-scrollbar-thumb\s*\{[\s\S]*?border-radius:\s*999px;/);
assert.match(source, /\.settings-sidebar::-webkit-scrollbar-thumb,\s*\.content-panel::-webkit-scrollbar-thumb\s*\{[\s\S]*?background-clip:\s*content-box;/);
assert.match(source, /\.settings-sidebar::-webkit-scrollbar-thumb:hover,\s*\.content-panel::-webkit-scrollbar-thumb:hover\s*\{[\s\S]*?background-color:\s*rgba\(0,\s*0,\s*0,\s*0\.32\);/);

assert.match(source, /:global\(:root\[data-atools-theme="dark"\]\)\s*\.settings-sidebar,\s*:global\(:root\[data-atools-theme="dark"\]\)\s*\.content-panel\s*\{[\s\S]*?scrollbar-color:\s*rgba\(255,\s*255,\s*255,\s*0\.24\)\s*transparent;/);
assert.match(source, /:global\(:root\[data-atools-theme="dark"\]\)\s*\.settings-sidebar::-webkit-scrollbar-thumb,\s*:global\(:root\[data-atools-theme="dark"\]\)\s*\.content-panel::-webkit-scrollbar-thumb\s*\{[\s\S]*?background-color:\s*rgba\(255,\s*255,\s*255,\s*0\.24\);/);

assert.match(source, /@media \(max-width:\s*1000px\)\s*\{[\s\S]*?\.settings-sidebar::-webkit-scrollbar,\s*\.content-panel::-webkit-scrollbar\s*\{[\s\S]*?width:\s*8px;/);

assertSmokeChecked(
  "设置页左侧菜单和右侧内容区都有细窄圆角滚动条，亮/暗主题颜色正确，滚动条出现时布局不抖动且没有横向溢出。",
  "macOS smoke checklist should mark the Settings scrollbar styling complete",
);
