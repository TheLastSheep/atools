import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-local-launch-overview-"));
const outFile = join(outDir, "localLaunch.mjs");

try {
  const matchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const matchSource = await readFile(matchSourcePath, "utf8");
  const transformedMatch = await transformWithEsbuild(matchSource, matchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedMatch.code);

  const sourcePath = new URL("src/lib/localLaunch.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(typeof mod.localLaunchOverviewCards, "function", "localLaunch should expose overview cards");

  const cards = mod.localLaunchOverviewCards({
    entries: [
      { id: "desktop", name: "Desktop", keyword: "desk", path: "~/Desktop", kind: "folder", enabled: true },
      { id: "code", name: "VS Code", keyword: "code", path: "/Applications/Visual Studio Code.app", kind: "app", enabled: true },
      { id: "hosts", name: "Hosts", keyword: "hosts", path: "/etc/hosts", kind: "file", enabled: false },
    ],
    statusLabel: "已保存本地启动项",
    hasTauriRuntime: true,
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "启动入口",
    "类型分布",
    "桌面能力",
    "保存状态",
  ]);
  assert.equal(cards.find((card) => card.label === "启动入口")?.value, "2/3 启用");
  assert.match(cards.find((card) => card.label === "启动入口")?.detail ?? "", /1 个停用/);
  assert.equal(cards.find((card) => card.label === "启动入口")?.tone, "ready");
  assert.equal(cards.find((card) => card.label === "类型分布")?.value, "1 文件夹 / 1 应用 / 1 文件");
  assert.match(cards.find((card) => card.label === "类型分布")?.detail ?? "", /desk/);
  assert.equal(cards.find((card) => card.label === "桌面能力")?.value, "可选择路径");
  assert.match(cards.find((card) => card.label === "桌面能力")?.detail ?? "", /拖拽/);
  assert.equal(cards.find((card) => card.label === "桌面能力")?.tone, "ready");
  assert.equal(cards.find((card) => card.label === "保存状态")?.value, "已保存本地启动项");
  assert.match(cards.find((card) => card.label === "保存状态")?.detail ?? "", /只保存在本机/);

  const previewCards = mod.localLaunchOverviewCards({
    entries: [
      { id: "off", name: "Off", keyword: "off", path: "/tmp/off", kind: "file", enabled: false },
    ],
    statusLabel: "",
    hasTauriRuntime: false,
  });
  assert.equal(previewCards.find((card) => card.label === "启动入口")?.value, "0/1 启用");
  assert.equal(previewCards.find((card) => card.label === "启动入口")?.tone, "warning");
  assert.equal(previewCards.find((card) => card.label === "桌面能力")?.value, "浏览器预览");
  assert.equal(previewCards.find((card) => card.label === "桌面能力")?.tone, "desktop");

  const panel = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
  assert.ok(panel.includes("localLaunchOverviewCards"), "Local launch page should use the shared overview model");
  assert.ok(panel.includes("本地启动概览"), "Local launch page should render an overview section first");
  assert.ok(panel.includes("启动项配置"), "Local launch page should move rows under a configuration section");
  assert.ok(panel.includes("名称、关键字、类型和本地路径只保存在本机"), "Local launch page should state the local path boundary");
  assert.match(panel, /class="local-launch-overview-grid"/);
  assert.match(panel, /class="local-launch-overview-card"/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
