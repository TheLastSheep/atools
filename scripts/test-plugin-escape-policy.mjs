import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { bundleTsTestModule } from "./lib/bundle-ts-test-module.mjs";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-escape-policy-"));
try {
  const settingsPath = new URL("src/lib/settings.ts", root).pathname;
  const settingsSource = await readFile(settingsPath, "utf8");
  const outFile = join(outDir, "settings.mjs");
  await writeFile(outFile, await bundleTsTestModule(settingsPath));
  const settings = await import(pathToFileURL(outFile).href);

  assert.equal(settings.DEFAULT_ATOOLS_SETTINGS.pluginEscapeToSearch, true);
  assert.equal(settings.normalizeSettings({}).pluginEscapeToSearch, true);
  assert.equal(settings.normalizeSettings({ pluginEscapeToSearch: false }).pluginEscapeToSearch, false);

  const [app, panel, settingsPanel] = await Promise.all([
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
    Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0")),
  ]);

  assert.match(app, /if \(!appSettings\.pluginEscapeToSearch\) return;/);
  assert.match(app, /onescape: onEscape/);
  assert.match(panel, /window\.parent\.postMessage\(\{ __ipc_plugin_escape__: true \}/);
  assert.match(panel, /if \(event\.defaultPrevented === true\) return;/);
  assert.match(panel, /if \(data\.__ipc_plugin_escape__\)/);
  assert.match(panel, /void requestEscape\(\)\.catch/);
  assert.match(panel, /if \(onescape\) await onescape\(\);/);
  assert.match(settingsPanel, /<span>ESC 退出插件<\/span>/);
  assert.match(settingsPanel, /bind:checked=\{pluginEscapeToSearch\}/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
