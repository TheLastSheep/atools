import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-plugin-inventory-"));
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
  const plugins = [
    {
      id: "z-user",
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

  const panel = await readFile(new URL("../src/components/SettingsPanel.svelte", import.meta.url), "utf8");
  const macosChecklist = await readFile(new URL("../docs/macos-smoke-checklist.md", import.meta.url), "utf8");
  assert.ok(panel.includes("openInstalledPluginDirectory"), "Installed plugin page should expose a plugin directory handler");
  assert.ok(panel.includes('callHumanCapability("open_or_reveal_path", { path: plugin.path, reveal: true })'), "Installed plugin page should reveal plugin directories through the human TaskRun capability pipeline");
  assert.ok(panel.includes("installPluginFromDirectory"), "Installed plugin page should expose a local plugin install handler");
  assert.ok(panel.includes("directory: true"), "Installed plugin install should open a directory picker");
  assert.ok(panel.includes('invoke("install_plugin", { path: selectedPath })'), "Installed plugin install should call the native install command with the selected directory");
  assert.ok(panel.includes("浏览器预览模式无法安装插件"), "Installed plugin install should stay desktop-only in Web preview");
  assert.ok(!panel.includes('<button class="plain-button" disabled>安装插件</button>'), "Installed plugin install button should not be hard-disabled");
  assert.ok(panel.includes("updateInstalledPluginFromDirectory"), "Installed plugin page should expose a local plugin update handler");
  assert.ok(panel.includes("authorizeInstalledPlugin"), "Installed plugin page should expose a plugin permission authorization handler");
  assert.ok(panel.includes('"authorize_plugin_permissions"'), "Installed plugin authorization should call the native authorization command");
  assert.ok(panel.includes("授权启用"), "Installed plugin page should show the authorization action for disabled imported plugins");
  assert.ok(panel.includes("确认 manifest 权限"), "Installed plugin authorization should explain that manifest permissions are being approved");
  assert.ok(panel.includes('invoke("update_plugin_from_path", { pluginId: plugin.id, path: selectedPath })'), "Installed plugin update should call the native update command with selected same-plugin directory");
  assert.ok(panel.includes("浏览器预览模式无法更新插件"), "Installed plugin update should stay desktop-only in Web preview");
  assert.ok(panel.includes("已取消更新插件"), "Installed plugin update should report cancelled directory picking");
  assert.ok(panel.includes("uninstallInstalledPlugin"), "Installed plugin page should expose an uninstall handler");
  assert.ok(panel.includes('invoke("uninstall_plugin"'), "Installed plugin page should call the native uninstall command");
  assert.ok(panel.includes("卸载插件"), "Installed plugin page should show the uninstall action");
  assert.ok(panel.includes("此操作会移除插件本体、指令索引和插件数据"), "Uninstall should require a destructive-action confirmation");
  assert.ok(panel.includes("pluginPermissionPanelOpen"), "Installed plugin page should track plugin permission detail visibility");
  assert.ok(panel.includes("插件权限/能力审计"), "Installed plugin page should render the plugin permission audit section");
  assert.ok(panel.includes("inventory.selectedPlugin.permissionRows"), "Installed plugin page should render permission rows from the shared model");
  assert.ok(panel.includes("pluginRuntimePermissionGrantList"), "Installed plugin page should read persistent runtime grant state");
  assert.ok(panel.includes("clearPluginRuntimePermissionGrants"), "Installed plugin page should allow clearing persistent runtime grants");
  assert.ok(panel.includes("持久运行时授权"), "Installed plugin permission audit should show persistent runtime grants");
  assert.ok(panel.includes("清除授权"), "Installed plugin permission audit should expose a clear grants action");
  assert.ok(panel.includes("已清除插件运行时授权"), "Installed plugin permission clear should provide explicit status feedback");
  assert.ok(panel.includes("已展开插件权限/能力审计"), "Installed plugin permission action should provide explicit status feedback");
  assert.ok(panel.includes('action.label === "插件权限" ? "查看"'), "Installed plugin permission action should expose a real view button");
  assert.ok(panel.includes('action.label === "更新插件" ? "更新"'), "Installed plugin update action should expose a real update button");

  const checkedInstalledPluginSmokeItems = [
    "设置页 `已安装插件` 不是旧占位页，显示插件总数、启用/停用数量、feature 数量、插件列表和本地路径。",
    "`已安装插件` 支持按名称、feature、描述、路径或来源筛选；状态筛选包含全部/启用/停用，来源筛选包含全部/内置/导入。",
    "`已安装插件` 中 `安装插件` 在桌面端可选择包含 `plugin.json` 的目录并调用本地安装；Web 预览不打开目录选择器并提示无法安装；网络 ZIP 安装/更新从插件市场远程目录触发；导入插件可卸载，内置插件只能停用。",
    "`已安装插件` 桌面端可刷新插件列表，插件行显示版本、来源、feature 预览和启用状态；Web 预览下提示需在桌面应用中查看。",
    "`已安装插件` 中选择插件后显示 `插件详情`，包含名称、状态、版本/来源、更新时间、描述、路径和 feature 明细。",
    "`插件详情` 中 `打开目录` 可用，桌面端会通过 Finder 定位插件路径；导入插件的 `更新插件` 可选择本地同 ID 插件目录更新，保留启停状态，拒绝当前安装目录或不匹配的 manifest；远程同 ID 更新从插件市场目录触发，保留启停状态，并可校验目录 SHA-256；`插件权限` 可展开只读 `插件权限/能力审计`，展示 main/preload、feature 匹配、Agent tools 和本地数据边界；完整插件权限授权/隔离模型仍保持未接入；导入插件的 `卸载插件` 可用，必须先显示会移除插件本体、指令索引和插件数据的页内危险确认，确认后刷新插件列表；内置插件的更新/卸载动作不可用。",
  ];

  for (const item of checkedInstalledPluginSmokeItems) {
    assert.ok(
      macosChecklist.includes(`- [x] ${item}`),
      `macOS smoke checklist should mark installed-plugin parity item as verified: ${item}`,
    );
  }
} finally {
  await rm(outDir, { recursive: true, force: true });
}
