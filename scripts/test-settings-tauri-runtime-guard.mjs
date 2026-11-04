import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
const systemPanelSource = await readFile(new URL("src/components/SystemPanel.svelte", root), "utf8");

assert.match(
  source,
  /function hasTauriRuntime\(\) \{[\s\S]*?__TAURI_INTERNALS__[\s\S]*?typeof runtime\?\.invoke === "function"[\s\S]*?\}/,
  "SettingsPanel should treat Tauri as available only when the runtime invoke function exists",
);
assert.doesNotMatch(
  source,
  /function hasTauriRuntime\(\) \{\s*return "__TAURI_INTERNALS__" in window;\s*\}/,
  "SettingsPanel should not use a key-exists-only Tauri runtime guard",
);
assert.match(
  source,
  /catch \(error\) \{\s*pluginsStatus = hasTauriRuntime\(\) \? String\(error\) : "Tauri 运行时未连接，已安装插件需在桌面应用中查看";\s*\}/,
  "Installed plugin refresh should not surface raw Tauri invoke TypeError in browser preview",
);

assert.match(
  systemPanelSource,
  /function hasTauriRuntime\(\) \{[\s\S]*?__TAURI_INTERNALS__[\s\S]*?typeof runtime\?\.invoke === "function"[\s\S]*?\}/,
  "SystemPanel plugin shortcut should use the same invoke-based Tauri runtime guard",
);
assert.match(
  systemPanelSource,
  /if \(!hasTauriRuntime\(\)\) \{[\s\S]*?pluginError = "Tauri 运行时未连接，已安装插件需在桌面应用中查看";[\s\S]*?return;[\s\S]*?\}/,
  "SystemPanel plugin shortcut should show a preview-safe unavailable state before list_plugins",
);
assert.match(
  systemPanelSource,
  /catch \(e\) \{[\s\S]*?pluginError = hasTauriRuntime\(\) \? String\(e\) : "Tauri 运行时未连接，已安装插件需在桌面应用中查看";[\s\S]*?\}/,
  "SystemPanel plugin shortcut should not surface raw invoke TypeError in browser preview",
);
