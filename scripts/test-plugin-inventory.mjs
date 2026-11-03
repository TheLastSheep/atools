import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-inventory-"));
const outFile = join(outDir, "pluginInventory.mjs");
const featureSearchOutFile = join(outDir, "pluginInventoryFeatureSearch.mjs");

try {
  const sourcePath = new URL("src/lib/pluginInventory.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const featureSearchPath = new URL("src/lib/pluginInventoryFeatureSearch.ts", root).pathname;
  const featureSearchSource = await readFile(featureSearchPath, "utf8");
  const featureSearchTransformed = await transformWithEsbuild(featureSearchSource, featureSearchPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(featureSearchOutFile, featureSearchTransformed.code);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./pluginInventoryFeatureSearch"', 'from "./pluginInventoryFeatureSearch.mjs"'));

  const mod = await import(pathToFileURL(outFile).href);
  const plugins = [
    {
      id: "z-user",
      source_kind: "imported",
      name: "Z User Plugin",
      version: "1.2.3",
      path: "/Users/harris/Library/Application Support/ZTools/plugins/z-user",
      enabled: false,
      manifest: {
        description: "用户导入插件",
        main: "index.html",
        preload: "preload.js",
        pluginSetting: {
          height: 480,
          single: true,
        },
        tools: {
          summarize: { description: "汇总数据" },
          export_data: { description: "导出数据" },
        },
        permissions: ["clipboard", "shell.openExternal", "data"],
        features: [
          {
            code: "z-open",
            label: "打开",
            explain: "打开数据",
            cmds: [
              "open",
              { type: "regex", label: "链接", match: "^https?://" },
            ],
          },
        ],
      },
      created_at: "2026-06-01T01:00:00Z",
      updated_at: "2026-06-01T02:00:00Z",
    },
    {
      id: "builtin-json",
      source_kind: "builtin",
      name: "JSON",
      version: "",
      path: "/Applications/ATools.app/Contents/Resources/plugins/json",
      enabled: true,
      manifest: {
        features: [
          { code: "json", label: "JSON 格式化", explain: "格式化 JSON" },
          { code: "json-min", explain: "压缩 JSON" },
          { code: "json-escape", label: "", explain: "转义 JSON" },
          { code: "json-schema", label: "Schema", explain: "生成 Schema" },
        ],
      },
      created_at: "2026-06-02T01:00:00Z",
      updated_at: "2026-06-02T02:00:00Z",
    },
  ];
  const inventory = mod.pluginInventory(plugins);

  assert.deepEqual(inventory.summary, {
    total: 2,
    enabled: 1,
    disabled: 1,
    features: 5,
  });

  assert.deepEqual(inventory.rows.map((row) => row.id), ["builtin-json", "z-user"]);
  assert.equal(inventory.rows[0].versionLabel, "0.0.0");
  assert.equal(inventory.rows[0].sourceLabel, "内置");
  assert.equal(inventory.rows[0].featureCount, 4);
  assert.equal(inventory.rows[0].featurePreview, "JSON 格式化 / 压缩 JSON / json-escape");
  assert.equal(inventory.rows[0].hasMoreFeatures, true);
  assert.equal(inventory.rows[1].sourceLabel, "导入");
  assert.equal(inventory.rows[1].featurePreview, "打开");

  const selected = mod.pluginInventory(plugins, { selectedPluginId: "z-user" });
  assert.equal(selected.selectedPlugin.id, "z-user");
  assert.equal(selected.selectedPlugin.title, "Z User Plugin");
  assert.equal(selected.selectedPlugin.statusLabel, "已停用");
  assert.equal(selected.selectedPlugin.features.length, 1);
  assert.deepEqual(selected.selectedPlugin.features[0], {
    code: "z-open",
    label: "打开",
    explain: "打开数据",
  });
  assert.deepEqual(
    selected.selectedPlugin.actions.map((action) => [action.label, action.available, action.reason]),
    [
      ["打开目录", true, "在 Finder 中定位插件目录"],
      ["授权启用", true, "确认 manifest 权限后启用插件并同步 Agent tools 白名单"],
      ["更新插件", true, "选择本地目录更新同一插件"],
      ["卸载插件", true, "删除插件本体、指令索引和插件数据"],
      ["插件权限", true, "查看 manifest 声明的本地能力和 Agent tools"],
    ],
  );
  assert.deepEqual(
    selected.selectedPlugin.permissionRows.map((row) => [row.label, row.value, row.detail, row.tone]),
    [
      ["运行入口", "main + preload", "main: index.html；preload: preload.js；窗口高度 480px；单例运行", "ready"],
      ["Feature 指令", "1 个 feature / 2 条匹配", "Feature 会进入主搜索和插件详情；命令匹配只来自本地 manifest", "ready"],
      ["Agent Tools", "2 个", "summarize / export_data；默认关闭，需在 Agent/MCP 白名单启用", "warning"],
      ["运行时权限", "3 项", "clipboard / shell.openExternal / data", "warning"],
      ["本地数据边界", "本机插件目录", "插件文件位于 /Users/harris/Library/Application Support/ZTools/plugins/z-user；插件数据、启停状态和工具白名单只保存在本机", "normal"],
    ],
  );

  const builtinSelection = mod.pluginInventory(plugins, { selectedPluginId: "builtin-json" });
  assert.equal(
    builtinSelection.selectedPlugin.actions.find((action) => action.label === "授权启用"),
    undefined,
  );
  assert.equal(
    builtinSelection.selectedPlugin.actions.find((action) => action.label === "卸载插件")?.available,
    false,
  );
  assert.equal(
    builtinSelection.selectedPlugin.actions.find((action) => action.label === "卸载插件")?.reason,
    "内置插件不可卸载，可停用以隐藏指令",
  );
  assert.equal(
    builtinSelection.selectedPlugin.actions.find((action) => action.label === "更新插件")?.available,
    false,
  );
  assert.equal(
    builtinSelection.selectedPlugin.actions.find((action) => action.label === "更新插件")?.reason,
    "内置插件随应用更新，不能从设置页替换",
  );

  const fallbackSelection = mod.pluginInventory(plugins, { selectedPluginId: "missing" });
  assert.equal(fallbackSelection.selectedPlugin.id, "builtin-json");

  const queryFiltered = mod.pluginInventory(plugins, { query: "schema" });
  assert.equal(queryFiltered.summary.total, 2);
  assert.equal(queryFiltered.filteredSummary.total, 1);
  assert.deepEqual(queryFiltered.rows.map((row) => row.id), ["builtin-json"]);
  assert.equal(queryFiltered.selectedPlugin.id, "builtin-json");

  const disabledFiltered = mod.pluginInventory(plugins, { status: "disabled" });
  assert.equal(disabledFiltered.filteredSummary.enabled, 0);
  assert.equal(disabledFiltered.filteredSummary.disabled, 1);
  assert.deepEqual(disabledFiltered.rows.map((row) => row.id), ["z-user"]);

  const importedFiltered = mod.pluginInventory(plugins, { source: "imported" });
  assert.deepEqual(importedFiltered.rows.map((row) => row.id), ["z-user"]);

  const noMatch = mod.pluginInventory(plugins, { query: "missing-plugin" });
  assert.equal(noMatch.rows.length, 0);
  assert.equal(noMatch.selectedPlugin, null);
  assert.equal(noMatch.emptyText, "没有匹配的插件，调整筛选条件后重试。");

  const empty = mod.pluginInventory([]);
  assert.equal(empty.summary.total, 0);
  assert.equal(empty.emptyText, "暂无已安装插件，可以先使用本地导入。");
  assert.equal(empty.selectedPlugin, null);

  // UI behavior and native action recovery are covered by the Svelte inventory
  // component/controller tests; historical checklist text is not runtime evidence.
} finally {
  await rm(outDir, { recursive: true, force: true });
}
