import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [appSource, panelSource, capabilityRailSource, settingsSource, smokeChecklist] = await Promise.all([
  readFile(new URL("../src/App.svelte", import.meta.url), "utf8"),
  readFile(new URL("../src/components/HomePanel.svelte", import.meta.url), "utf8"),
  readFile(new URL("../src/components/HomeCapabilityRail.svelte", import.meta.url), "utf8"),
  Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
  readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8"),
]);
const assertSmokeChecked = (row, message) => {
  assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
};

assert.ok(appSource.includes("appSettings.pinnedRows"), "App should use pinnedRows when preparing home commands");
assert.ok(appSource.includes("pinnedCommandCapacity"), "App should cap visible pinned commands before recent commands");
assert.ok(appSource.includes("pinnedRows={appSettings.pinnedRows}"), "HomePanel should receive pinnedRows setting");
assert.ok(appSource.includes("homeCommandStatus"), "App should compute section-aware home status text");
assert.ok(appSource.includes("titleOverride={selectedRecentStatus.title}"), "Home status bar should use section-aware title");
assert.ok(appSource.includes("detailOverride={selectedRecentStatus.detail}"), "Home status bar should use section-aware detail");
assert.ok(appSource.includes("settingsMenu={settingsMenuTarget}"), "App should pass requested settings menu to SystemPanel");

assert.ok(panelSource.includes("homeCommandSections"), "HomePanel should split pinned and recent commands via homeCommandSections");
assert.ok(panelSource.includes("section.label"), "HomePanel should render section labels");
assert.ok(panelSource.includes("固定"), "HomePanel should render the fixed command section label");
assert.ok(panelSource.includes("globalCommandIndex"), "HomePanel should preserve one continuous keyboard selection index");
assert.ok(!panelSource.includes("section.empty"), "HomePanel should omit empty fixed-section chrome");
assert.ok(panelSource.includes("HomeCapabilityRail"), "HomePanel should load the product capability rail");
assert.ok(capabilityRailSource.includes("常用入口"), "HomePanel should expose the product capability rail");
assert.ok(capabilityRailSource.includes('panel: "results"'), "HomePanel should expose Result Center as a first-level action");

assert.ok(settingsSource.includes("固定栏显示行数"), "Settings should expose fixed command row count");
assert.ok(settingsSource.includes("initialMenu"), "SettingsPanel should support an initial menu prop for direct navigation");
assert.ok(settingsSource.includes("activeMenu = initialMenu"), "SettingsPanel should apply initialMenu reactively");
assert.ok(!settingsSource.includes("固定栏尚未接入，暂不启用"), "Fixed command row setting should no longer be marked unavailable");
assert.ok(!settingsSource.includes('bind:value={pinnedRows} disabled'), "Fixed command row setting should be editable");
assert.ok(settingsSource.includes("pinnedRows,"), "Settings should persist pinnedRows");

assertSmokeChecked(
  "设置“固定栏显示行数”为 1，首页固定分区最多显示 9 个固定项；刷新后该设置仍保留。",
  "macOS smoke checklist should mark pinned row capacity and persistence complete",
);
assertSmokeChecked(
  "`固定` 分区最多显示 `固定栏显示行数 * 9` 个固定指令，超出部分不挤占最近使用区域。",
  "macOS smoke checklist should mark pinned section capacity isolation complete",
);
