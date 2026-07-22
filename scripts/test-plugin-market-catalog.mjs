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

  const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
  assert.match(panel, /listen/);
  assert.match(panel, /PluginMarketCatalog/);
  assert.match(panel, /PluginMarketProgressEvent/);
  assert.match(panel, /operation_id\?: string/);
  assert.match(panel, /attempt: number/);
  assert.match(panel, /max_attempts: number/);
  assert.match(panel, /checksum\?: string/);
  assert.match(panel, /rating\?: string/);
  assert.match(panel, /rating_count\?: number/);
  assert.match(panel, /downloads\?: number/);
  assert.match(panel, /updated_at\?: string/);
  assert.match(panel, /publisher\?: string/);
  assert.match(panel, /publisher_url\?: string/);
  assert.match(panel, /signature\?: string/);
  assert.match(panel, /public_key\?: string/);
  assert.match(panel, /pluginMarketCatalog/);
  assert.match(panel, /pluginMarketProgress/);
  assert.match(panel, /pluginMarketOperationId/);
  assert.match(panel, /pluginMarketRetryAction/);
  assert.match(panel, /function handlePluginMarketProgress/);
  assert.match(panel, /function marketProgressLabel/);
  assert.match(panel, /function nextPluginMarketOperationId/);
  assert.match(panel, /function cancelPluginMarketOperation/);
  assert.match(panel, /function retryLastPluginMarketAction/);
  assert.match(panel, /selectedMarketPluginId/);
  assert.match(panel, /function selectedMarketCatalogPlugin/);
  assert.match(panel, /function openMarketCatalogDetails/);
  assert.match(panel, /installingMarketPluginId/);
  assert.match(panel, /marketCatalogInstalledPlugin/);
  assert.match(panel, /marketCatalogActionLabel/);
  assert.match(panel, /marketCatalogBusyLabel/);
  assert.match(panel, /function pluginMarketPublicKeyTrusted/);
  assert.match(panel, /fetch_plugin_market_catalog/);
  assert.match(panel, /invoke<PluginMarketCatalog>\("fetch_plugin_market_catalog", \{ url: effectivePluginMarketUrl\(\) \}\)/);
  assert.match(panel, /install_plugin_from_market/);
  assert.match(panel, /invoke\("install_plugin_from_market", \{ pluginId: plugin\.id, downloadUrl: resolved\.download_url, checksum: plugin\.checksum \?\? null, signature: plugin\.signature \?\? null, publicKey: plugin\.public_key \?\? null, operationId, sourceKind: pluginMarketCatalog\?\.source_kind \?\? null, sourceUrl: pluginMarketCatalog\?\.source_url \?\? null, confirmedUnsigned: officialUnsigned \}\)/);
  assert.match(panel, /update_plugin_from_market/);
  assert.match(panel, /invoke\("update_plugin_from_market", \{ pluginId: plugin\.id, downloadUrl: resolved\.download_url, checksum: plugin\.checksum \?\? null, signature: plugin\.signature \?\? null, publicKey: plugin\.public_key \?\? null, operationId, sourceKind: pluginMarketCatalog\?\.source_kind \?\? null, sourceUrl: pluginMarketCatalog\?\.source_url \?\? null, confirmedUnsigned: officialUnsigned \}\)/);
  assert.match(panel, /invoke\("cancel_plugin_market_operation", \{ operationId: pluginMarketOperationId \}\)/);
  assert.match(panel, /installPluginFromMarketCatalog/);
  assert.match(panel, /plugin-market-progress/);
  assert.match(panel, /下载进度/);
  assert.match(panel, /取消下载/);
  assert.match(panel, /重试/);
  assert.match(panel, /取消\/重试/);
  assert.match(panel, /签名信任/);
  assert.match(panel, /发布者/);
  assert.match(panel, /confirmSettingsAction\(\{\s*title: `\$\{actionLabel\}插件`,[\s\S]*?远程插件会下载 \$\{resolved\.package_format\.toUpperCase\(\)\} 并写入本地插件目录/);
  assert.match(panel, /ZTools 官方包服务器[\s\S]*?confirmedUnsigned: officialUnsigned/);
  assert.match(panel, /confirmLabel: actionLabel/);
  assert.match(panel, /pluginMarketStatusText = `已取消\$\{actionLabel\} \$\{plugin\.name\}`;/);
  assert.match(panel, /remoteCatalogLoaded: Boolean\(pluginMarketCatalog\)/);
  assert.match(panel, /remotePluginCount: pluginMarketCatalog\?\.plugins\.length/);
  assert.match(panel, /class="plugin-market-catalog-list"/);
  assert.match(panel, /远程目录/);
  assert.match(panel, /远程详情/);
  assert.match(panel, /市场评分/);
  assert.match(panel, /下载次数/);
  assert.match(panel, /openMarketCatalogDetails\(plugin\)/);
  assert.match(panel, /\{plugin\.rating \? `评分 \$\{plugin\.rating\}` : "暂无评分"\}/);
  assert.match(panel, /SHA-256 已校验/);
  assert.match(panel, /marketCatalogBusyLabel\(plugin\) : marketCatalogActionLabel\(plugin\)/);
  assert.match(panel, /!pluginMarketInstallAllowed\(plugin\)/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
