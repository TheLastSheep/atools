import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-market-status-"));
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
  const status = mod.pluginMarketStatus({
    installedPluginCount: 18,
    hasTauriRuntime: true,
    customMarketEnabled: true,
    customMarketUrl: "https://market.example.com/catalog.json",
  });

  assert.equal(status.state, "disabled");
  assert.equal(status.label, "未接入");
  assert.equal(status.installedPluginCount, 18);
  assert.equal(status.networkMarketAvailable, false);
  assert.equal(status.remoteCatalogLoaded, false);
  assert.equal(status.remotePluginCount, 0);
  assert.equal(status.customMarketConfigured, true);
  assert.equal(status.customMarketUrl, "https://market.example.com/catalog.json");
  assert.match(status.summary, /自定义市场地址已保存/);
  assert.match(status.summary, /读取后可确认安装或更新远程 ZIP/);

  assert.deepEqual(
    status.localCapabilities.map((item) => [item.label, item.available]),
    [
      ["内置插件", true],
      ["本地导入", true],
      ["启停管理", true],
      ["插件数据导出", true],
      ["自定义地址", true],
    ],
  );

  assert.deepEqual(
    status.remoteCapabilities.map((item) => [item.label, item.available]),
    [
      ["目录读取", false],
      ["市场搜索", false],
      ["下载/安装/更新", false],
      ["SHA-256 校验", false],
      ["安装确认", false],
      ["下载进度", false],
      ["取消/重试", false],
      ["远程详情", false],
      ["远程评分", false],
      ["签名信任", false],
    ],
  );

  const cards = mod.pluginMarketOverviewCards(status);
  assert.equal(cards.find((card) => card.label === "市场地址")?.value, "已配置");
  assert.match(cards.find((card) => card.label === "市场地址")?.detail ?? "", /market.example.com/);

  const previewStatus = mod.pluginMarketStatus({ installedPluginCount: 0, hasTauriRuntime: false });
  assert.equal(previewStatus.installedPluginCount, 0);
  assert.equal(previewStatus.remoteCatalogLoaded, false);
  assert.match(previewStatus.summary, /桌面应用中查看/);
  assert.equal(previewStatus.localCapabilities.find((item) => item.label === "插件数据导出")?.available, false);
  assert.equal(previewStatus.localCapabilities.find((item) => item.label === "自定义地址")?.available, false);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
