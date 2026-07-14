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

  const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
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
