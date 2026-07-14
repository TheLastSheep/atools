import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-inventory-overview-"));
const outFile = join(outDir, "pluginInventory.mjs");

try {
  const sourcePath = new URL("src/lib/pluginInventory.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(typeof mod.pluginInventoryOverviewCards, "function", "pluginInventory should expose overview cards");

  const inventory = mod.pluginInventory([
    {
      id: "builtin-json",
      name: "JSON",
      version: "1.0.0",
      path: "/Applications/ATools.app/Contents/Resources/plugins/json",
      enabled: true,
      manifest: {
        description: "内置 JSON 工具",
        features: [
          { code: "json", label: "JSON 格式化", explain: "格式化 JSON" },
          { code: "json-min", label: "压缩", explain: "压缩 JSON" },
        ],
      },
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    },
    {
      id: "imported-user",
      name: "Imported",
      version: "0.2.0",
      path: "/Users/harris/Library/Application Support/ATools/plugins/imported-user",
      enabled: false,
      manifest: {
        description: "用户导入插件",
        features: [
          { code: "open", label: "打开", explain: "打开数据" },
        ],
      },
      created_at: "2026-06-01T00:00:00Z",
      updated_at: "2026-06-02T00:00:00Z",
    },
  ]);

  const cards = mod.pluginInventoryOverviewCards({
    inventory,
    hasTauriRuntime: true,
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "插件库存",
    "启用状态",
    "Feature 指令",
    "安装入口",
  ]);
  assert.equal(cards.find((card) => card.label === "插件库存")?.value, "2 个");
  assert.match(cards.find((card) => card.label === "插件库存")?.detail ?? "", /1 内置/);
  assert.match(cards.find((card) => card.label === "插件库存")?.detail ?? "", /1 导入/);
  assert.equal(cards.find((card) => card.label === "插件库存")?.tone, "ready");
  assert.equal(cards.find((card) => card.label === "启用状态")?.value, "1 启用 / 1 停用");
  assert.match(cards.find((card) => card.label === "启用状态")?.detail ?? "", /已停用插件不会进入主搜索/);
  assert.equal(cards.find((card) => card.label === "Feature 指令")?.value, "3 个");
  assert.match(cards.find((card) => card.label === "Feature 指令")?.detail ?? "", /插件列表和所有指令/);
  assert.equal(cards.find((card) => card.label === "安装入口")?.value, "本地安装");
  assert.match(cards.find((card) => card.label === "安装入口")?.detail ?? "", /plugin\.json/);
  assert.match(cards.find((card) => card.label === "安装入口")?.detail ?? "", /远程 ZIP 安装\/更新/);
  assert.match(cards.find((card) => card.label === "安装入口")?.detail ?? "", /导入插件可卸载/);
  assert.equal(cards.find((card) => card.label === "安装入口")?.tone, "warning");

  const previewCards = mod.pluginInventoryOverviewCards({
    inventory: mod.pluginInventory([]),
    hasTauriRuntime: false,
  });
  assert.equal(previewCards.find((card) => card.label === "插件库存")?.value, "桌面端读取");
  assert.equal(previewCards.find((card) => card.label === "插件库存")?.tone, "desktop");
  assert.equal(previewCards.find((card) => card.label === "安装入口")?.value, "桌面端安装");
  assert.equal(previewCards.find((card) => card.label === "安装入口")?.tone, "desktop");

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  assert.ok(panel.includes("pluginInventoryOverviewCards"), "Installed plugin page should use the shared overview model");
  assert.ok(panel.includes("插件库存概览"), "Installed plugin page should render an overview section first");
  assert.ok(panel.includes("插件筛选"), "Installed plugin page should move filtering below overview");
  assert.ok(panel.includes("本地目录安装、启用状态、卸载和本地清单只保存在本机"), "Installed plugin page should state the local inventory boundary");
  assert.match(panel, /class="plugin-inventory-overview-grid"/);
  assert.match(panel, /class="plugin-inventory-overview-card"/);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
