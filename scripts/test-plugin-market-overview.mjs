import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-market-overview-"));
const outFile = join(outDir, "pluginMarketStatus.mjs");

try {
  const sourcePath = new URL("src/lib/pluginMarketStatus.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  assert.equal(typeof mod.pluginMarketOverviewCards, "function", "plugin market should expose overview cards");

  const status = mod.pluginMarketStatus({ installedPluginCount: 18, hasTauriRuntime: true });
  const cards = mod.pluginMarketOverviewCards(status);
  assert.deepEqual(
    cards.map((card) => card.label),
    ["市场状态", "市场地址", "本地入口", "已安装插件", "远程能力"],
  );

  assert.equal(cards[0].value, "未接入");
  assert.match(cards[0].detail, /网络市场/);
  assert.equal(cards[0].tone, "warning");

  assert.equal(cards[1].value, "未配置");
  assert.match(cards[1].detail, /通用设置/);
  assert.equal(cards[1].tone, "warning");

  assert.equal(cards[2].value, "4/5 可用");
  assert.match(cards[2].detail, /本地导入/);
  assert.equal(cards[2].tone, "ready");

  assert.equal(cards[3].value, "18 个");
  assert.match(cards[3].detail, /已安装插件/);
  assert.equal(cards[3].tone, "ready");

  assert.equal(cards[4].value, "0/10 可用");
  assert.match(cards[4].detail, /详情/);
  assert.equal(cards[4].tone, "warning");

  const previewStatus = mod.pluginMarketStatus({ installedPluginCount: 0, hasTauriRuntime: false });
  const previewCards = mod.pluginMarketOverviewCards(previewStatus);
  assert.equal(previewCards[2].value, "3/5 可用");
  assert.equal(previewCards[2].tone, "desktop");
  assert.equal(previewCards[3].value, "桌面端读取");
  assert.equal(previewCards[3].tone, "desktop");

  const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
  assert.match(panel, /pluginMarketOverviewCards/);
  assert.match(panel, /插件市场概览/);
  assert.match(panel, /本地替代入口/);
  assert.match(panel, /网络插件市场下载安装更新需先配置并读取自定义目录/);
  assert.match(panel, /class="plugin-market-overview-grid"/);
  assert.match(panel, /class="plugin-market-overview-card"/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
