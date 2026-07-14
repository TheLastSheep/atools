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

  const panel = await readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8");
  assert.match(panel, /httpServiceOverviewCards/);
  assert.match(panel, /HTTP 服务概览/);
  assert.match(panel, /MCP 连接入口/);
  assert.match(panel, /传统 HTTP API 不在当前版本启用/);
  assert.match(panel, /class="http-overview-grid"/);
  assert.match(panel, /class="http-overview-card"/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
