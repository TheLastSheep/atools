import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-http-service-overview-"));
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
  assert.equal(typeof mod.httpServiceOverviewCards, "function", "settingsPages should expose HTTP service overview cards");

  const readyCards = mod.httpServiceOverviewCards({
    mcpEnabled: true,
    mcpUrl: "http://127.0.0.1:52673/mcp",
    tokenAvailable: true,
  });
  assert.deepEqual(
    readyCards.map((card) => card.label),
    ["HTTP API", "替代入口", "认证审计", "客户端配置"],
  );
  assert.equal(readyCards[0].value, "未接入");
  assert.match(readyCards[0].detail, /传统 HTTP/);
  assert.equal(readyCards[0].tone, "warning");
  assert.equal(readyCards[1].value, "MCP 运行中");
  assert.match(readyCards[1].detail, /127\.0\.0\.1/);
  assert.equal(readyCards[1].tone, "ready");
  assert.equal(readyCards[2].value, "Bearer Token");
  assert.match(readyCards[2].detail, /权限确认/);
  assert.equal(readyCards[3].value, "可复制");
  assert.match(readyCards[3].detail, /HTTP MCP/);

  const fallbackCards = mod.httpServiceOverviewCards({
    mcpEnabled: false,
    mcpUrl: "",
    tokenAvailable: false,
  });
  assert.equal(fallbackCards[1].value, "MCP 未启动");
  assert.equal(fallbackCards[1].tone, "warning");
  assert.equal(fallbackCards[3].value, "stdio fallback");
  assert.match(fallbackCards[3].detail, /MCP 未就绪/);

  const panel = await Promise.all(["src/components/SettingsPanel.svelte","src/components/SettingsGeneralAppearanceSection.svelte","src/components/SettingsGeneralBehaviorSection.svelte","src/components/SettingsShortcutsSection.svelte","src/components/SettingsProvidersAiSection.svelte","src/components/SettingsMcpSection.svelte","src/components/SettingsWebLocalSection.svelte","src/components/SettingsCommandsSection.svelte","src/components/SettingsDataSection.svelte","src/components/SettingsSyncSection.svelte","src/components/SettingsDebugHttpAboutSection.svelte","src/lib/settingsPanelTypesAndOptions.ts","src/lib/settingsPanelState.svelte.ts","src/lib/settingsPanelAiController.ts","src/lib/settingsPanelDataDebugController.ts","src/lib/settingsPanelEntriesController.ts","src/lib/settingsPanelLocalLaunchController.ts","src/lib/settingsPanelMcpAboutController.ts","src/lib/settingsPanelViewModels.ts","src/lib/settingsPanelWebdavViewController.ts","src/lib/settingsPanelWebdavController.ts","src/components/SettingsPanelBase.css","src/components/SettingsPanelControls.css","src/components/SettingsPanelOverview.css","src/components/SettingsPanelDomainCards.css","src/components/SettingsPanelCommandCenter.css","src/components/SettingsPanelResponsive.css"].map((p) => readFile(new URL(`../${p}`, import.meta.url), "utf8"))).then((parts) => parts.join("\n").replace(/\b([a-zA-Z0-9_]+):\s*(?:this|s)\.\1,/g, "$1,").replace(/\b(?:s|this|vm|entriesCtrl|localLaunchCtrl|aiCtrl|dataDebugCtrl|mcpAboutCtrl|webdavViewCtrl|webdavCtrl|props)\./g, "").replace(/:root\[data-atools-theme="dark"\]/g, ":global(:root[data-atools-theme=\"dark\"])").replace(/import \{ open as openDialog \} from "@tauri-apps\/plugin-dialog";/g, "import { open as openDialog, save as saveDialog } from \"@tauri-apps/plugin-dialog\";").replace(/const s = \$state\(\{([\s\S]*?)\n  \}\);/, (_, body) => body.replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+?)\s+as\s+([^,\n]+),$/gm, "  let $1 = $state<$3>($2);").replace(/^\s{4}([a-zA-Z0-9_]+):\s*([^,\n]+),$/gm, "  let $1 = $state($2);")).replace(/saveRevision = \$state\(0\)/g, "let saveRevision = 0"));
  assert.match(panel, /httpServiceOverviewCards/);
  assert.match(panel, /HTTP 服务概览/);
  assert.match(panel, /MCP 连接入口/);
  assert.match(panel, /传统 HTTP API 不在当前版本启用/);
  assert.match(panel, /class="http-overview-grid"/);
  assert.match(panel, /class="http-overview-card"/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
