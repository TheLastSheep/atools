import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const [nativeSource, nativeLib, settingsPanel, pasteboardShelf] = await Promise.all([
  readFile(new URL("src-tauri/src/accessibility.rs", root), "utf8"),
  readFile(new URL("src-tauri/src/lib.rs", root), "utf8"),
  Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
  readFile(new URL("src/components/PasteboardShelf.svelte", root), "utf8"),
]);

assert.match(nativeSource, /AXIsProcessTrusted/);
assert.match(nativeSource, /Privacy_Accessibility/);
assert.match(nativeSource, /pub fn get_accessibility_permission_status/);
assert.match(nativeSource, /pub fn open_accessibility_settings/);
assert.match(nativeLib, /accessibility::get_accessibility_permission_status/);
assert.match(nativeLib, /accessibility::open_accessibility_settings/);

assert.match(settingsPanel, /<span>辅助功能权限<\/span>/);
assert.match(settingsPanel, /get_accessibility_permission_status/);
assert.match(settingsPanel, /open_accessibility_settings/);
assert.match(settingsPanel, /打开系统设置/);
assert.match(settingsPanel, /重新检测/);

assert.match(pasteboardShelf, /warningCode === "accessibility_required"/);
assert.match(pasteboardShelf, /open_accessibility_settings/);
assert.match(pasteboardShelf, /get_accessibility_permission_status/);
