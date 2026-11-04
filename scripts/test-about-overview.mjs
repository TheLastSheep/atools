import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-about-overview-"));
const outFile = join(outDir, "settingsPages.mjs");

try {
  const sourcePath = new URL("src/lib/settingsPages.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  assert.equal(typeof mod.aboutOverviewCards, "function", "settingsPages should expose About overview cards");

  const readyCards = mod.aboutOverviewCards({
    version: "3.0.0",
    runtime: "Tauri WebView",
    platform: "MacIntel",
    mcpEnabled: true,
    agentToolCount: 8,
    enabledAgentToolCount: 8,
    hasTauriRuntime: true,
  });
  assert.deepEqual(
    readyCards.map((card) => card.label),
    ["版本", "桌面运行时", "本地 MCP", "诊断包"],
  );
  assert.equal(readyCards[0].value, "v3.0.0");
  assert.match(readyCards[0].detail, /MacIntel/);
  assert.equal(readyCards[1].value, "Tauri WebView");
  assert.equal(readyCards[1].tone, "ready");
  assert.equal(readyCards[2].value, "8/8 工具");
  assert.match(readyCards[2].detail, /MCP 运行中/);
  assert.equal(readyCards[2].tone, "ready");
  assert.equal(readyCards[3].value, "可复制");
  assert.match(readyCards[3].detail, /不包含 MCP token/);

  const previewCards = mod.aboutOverviewCards({
    version: "",
    runtime: "浏览器预览",
    platform: "",
    mcpEnabled: false,
    agentToolCount: 0,
    enabledAgentToolCount: 0,
    hasTauriRuntime: false,
  });
  assert.equal(previewCards[0].value, "vunknown");
  assert.equal(previewCards[1].tone, "desktop");
  assert.equal(previewCards[2].value, "桌面端读取");
  assert.equal(previewCards[3].value, "预览不可用");

  const panel = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
  assert.match(panel, /aboutOverviewCards/);
  assert.match(panel, /关于概览/);
  assert.match(panel, /产品方向/);
  assert.match(panel, /诊断包只包含本机运行状态/);
  assert.match(panel, /应用更新/);
  assert.match(panel, /appUpdaterStatusText/);
  assert.match(panel, /appUpdater\.check\("manual"\)/);
  assert.match(panel, /appUpdater\.installAndRestart\(\)/);
  assert.match(panel, /class="about-overview-grid"/);
  assert.match(panel, /class="about-overview-card"/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
