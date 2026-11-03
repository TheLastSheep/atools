import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-market-catalog-"));
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
    remoteCatalogLoaded: true,
    remotePluginCount: 2,
    remoteRatedPluginCount: 1,
    remoteSignedPluginCount: 1,
    remoteTrustedPluginCount: 0,
  });

  assert.equal(status.state, "ready");
  assert.equal(status.label, "目录可用");
  assert.equal(status.networkMarketAvailable, true);
  assert.equal(status.remoteCatalogLoaded, true);
  assert.equal(status.remotePluginCount, 2);
  assert.match(status.summary, /已读取自定义市场目录 2 个插件/);
  assert.deepEqual(
    status.remoteCapabilities.map((item) => [item.label, item.available]),
    [
      ["目录读取", true],
      ["市场搜索", true],
      ["下载/安装/更新", true],
      ["SHA-256 校验", true],
      ["安装确认", true],
      ["下载进度", true],
      ["取消/重试", true],
      ["远程详情", true],
      ["远程评分", true],
      ["签名信任", false],
    ],
  );

  const cards = mod.pluginMarketOverviewCards(status);
  assert.equal(cards.find((card) => card.label === "市场状态")?.value, "目录可用");
  assert.equal(cards.find((card) => card.label === "远程能力")?.value, "9/10 可用");
  assert.match(cards.find((card) => card.label === "远程能力")?.detail ?? "", /目录读取/);

  const trustedStatus = mod.pluginMarketStatus({
    installedPluginCount: 18,
    hasTauriRuntime: true,
    customMarketEnabled: true,
    customMarketUrl: "https://market.example.com/catalog.json",
    remoteCatalogLoaded: true,
    remotePluginCount: 2,
    remoteSignedPluginCount: 1,
    remoteTrustedPluginCount: 1,
  });
  assert.equal(
    trustedStatus.remoteCapabilities.find((capability) => capability.label === "签名信任")?.available,
    true,
  );
  assert.match(trustedStatus.summary, /1 个公钥已被本地信任/);

  // Catalog execution, source races, confirmation and retry behavior are covered by
  // tests/components/plugin-market-controller.test.ts and plugin-market-panel.test.ts.
  const officialStatus = mod.pluginMarketStatus({
    installedPluginCount: 0, hasTauriRuntime: true, customMarketEnabled: false,
    activeSourceUrl: "https://z-tools.top/api/market", activeSourceKind: "ztools",
    remoteCatalogLoaded: true, remotePluginCount: 30,
  });
  assert.equal(officialStatus.remoteCatalogLoaded, true);
  assert.equal(officialStatus.customMarketConfigured, false);
  assert.match(officialStatus.summary, /ZTools 官方市场目录 30 个插件/);
  assert.match(officialStatus.remoteCapabilities.find((item) => item.label === "市场搜索").description, /未读取的分页/);

} finally {
  await rm(outDir, { recursive: true, force: true });
}
