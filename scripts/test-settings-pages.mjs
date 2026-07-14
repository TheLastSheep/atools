import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-settings-pages-"));
const outFile = join(outDir, "settingsPages.mjs");

try {
  const sourcePath = new URL("src/lib/settingsPages.ts", root).pathname;
  const [source, panelSource, smokeChecklist] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(new URL("src/components/SettingsPanel.svelte", root), "utf8"),
    readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
  ]);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };

  assert.deepEqual(
    mod.settingsMenuItems().map((item) => item.label),
    [
      "通用设置",
      "快捷键",
      "已安装插件",
      "插件市场",
      "AI 模型",
      "MCP 服务",
      "网页快开",
      "我的数据",
      "所有指令",
      "本地启动",
      "WebDAV 同步",
      "调试日志",
      "HTTP 服务",
      "关于",
    ],
  );

  assert.deepEqual(mod.hotkeyPresetsForPlatform("mac").map((item) => item.value), [
    "Option+Z",
    "Command+Space",
    "Control+Space",
  ]);
  assert.equal(mod.defaultHotkeyForPlatform("windows"), "Alt+Z");
  assert.match(panelSource, /let showHotkeyQuickActions = \$state\(false\);/);
  assert.match(panelSource, /class="quick-actions-wrapper"/);
  assert.match(panelSource, /aria-label="快捷设置"/);
  assert.match(panelSource, /\{#if showHotkeyQuickActions\}/);
  assert.match(panelSource, /\{#each hotkeyPresets\(\) as preset\}/);
  assert.match(panelSource, /onclick=\{\(\) => applyHotkeyPreset\(defaultHotkey\(\)\)\}/);

  const unsupported = mod.generalUnsupportedCapabilities();
  assert.equal(unsupported.length, 1);
  assert.equal(unsupported.every((item) => item.available === false), true);
  assert.equal(unsupported.some((item) => item.id === "proxy"), false);
  assert.equal(unsupported.some((item) => item.id === "devToolsMode"), false);
  assert.equal(unsupported.some((item) => item.id === "pluginMarketCustom"), false);
  assert.equal(unsupported.some((item) => item.id === "floatingBall"), false);
  assert.equal(unsupported.some((item) => item.id === "superPanel"), false);
  assert.equal(unsupported.some((item) => item.id === "disableGpuAcceleration"), true);

  const http = mod.httpServiceStatus({
    mcpEnabled: true,
    mcpUrl: "http://127.0.0.1:43123/mcp",
  });
  assert.equal(http.label, "未启用");
  assert.equal(http.rows.find((row) => row.label === "推荐替代")?.value, "MCP 服务");
  assert.equal(http.rows.find((row) => row.label === "MCP 地址")?.value, "http://127.0.0.1:43123/mcp");

  const about = mod.aboutProductFacts({
    version: "3.0.0",
    runtime: "Tauri WebView",
    platform: "MacIntel",
    mcpEnabled: true,
  });
  assert.equal(about.title, "ATools 3.0");
  assert.equal(about.cards.find((card) => card.label === "本地 MCP")?.value, "运行中");
  assert.equal(about.rows.find((row) => row.label === "运行时")?.value, "Tauri WebView");

  assert.deepEqual(mod.shortcutTabs().map((tab) => tab.label), [
    "全局快捷键",
    "应用快捷键",
    "指令别名",
  ]);
  assert.match(panelSource, /activeMenu === "shortcuts"/);
  assert.match(panelSource, /class="shortcut-tab-bar"/);
  assert.match(panelSource, /role="tablist"/);
  assert.match(panelSource, /class="shortcut-summary-grid"/);

  const macBuiltIns = mod.builtInAppShortcutsForPlatform("mac", {
    spaceOpenCommand: true,
    tabKeyFunction: "target-command",
  });
  assert.deepEqual(macBuiltIns.map((row) => row.shortcut), [
    "Command+D",
    "Command+F",
    "Tab",
    "Command+,",
    "Command+Q",
    "Command+W",
    "Option+Command+I",
    "Space",
  ]);
  assert.equal(macBuiltIns.find((row) => row.id === "builtin-space")?.target, "空搜索时打开选中指令");
  assert.equal(macBuiltIns.find((row) => row.id === "builtin-tab-target")?.target, "进入目标指令");
  assert.equal(macBuiltIns.length, 8);
  assert.notEqual(
    mod.builtInAppShortcutsForPlatform("mac", {
      spaceOpenCommand: false,
      tabKeyFunction: "focus-input",
    }).find((row) => row.id === "builtin-space")?.target,
    macBuiltIns.find((row) => row.id === "builtin-space")?.target,
  );
  assert.notEqual(
    mod.builtInAppShortcutsForPlatform("mac", {
      spaceOpenCommand: true,
      tabKeyFunction: "focus-input",
    }).find((row) => row.id === "builtin-tab-focus")?.target,
    macBuiltIns.find((row) => row.id === "builtin-tab-target")?.target,
  );

  const appShortcutTargets = [
    { code: "system:settings", label: "系统 · 设置", explain: "打开设置", enabled: true },
    { code: "web:github", label: "网页快开 · GitHub", explain: "gh", enabled: true },
  ];
  const newShortcut = mod.createAppShortcut("system:settings", ["Command+Option+1"], "mac", "shortcut-fixed");
  assert.deepEqual(newShortcut, {
    id: "shortcut-fixed",
    shortcut: "Command+Option+2",
    targetCode: "system:settings",
    enabled: true,
  });
  assert.deepEqual(mod.normalizeAppShortcuts([
    { id: " a ", shortcut: " Command+1 ", targetCode: " system:settings ", enabled: false },
    { id: "", shortcut: "Command+2", targetCode: "system:settings" },
    { id: "bad-shortcut", shortcut: " ", targetCode: "system:settings" },
    { id: "bad-target", shortcut: "Command+3", targetCode: "" },
  ]), [
    { id: "a", shortcut: "Command+1", targetCode: "system:settings", enabled: false },
    { id: "app-shortcut-1", shortcut: "Command+2", targetCode: "system:settings", enabled: true },
  ]);
  const appShortcutRows = mod.appShortcutRows({
    entries: [
      { id: "a", shortcut: "Command+1", targetCode: "system:settings", enabled: true },
      { id: "b", shortcut: "Command+1", targetCode: "web:github", enabled: true },
      { id: "c", shortcut: "Command+F", targetCode: "missing", enabled: false },
      { id: "d", shortcut: "F", targetCode: "system:settings", enabled: true },
    ],
    targets: appShortcutTargets,
    builtIns: macBuiltIns,
    platform: "mac",
  });
  assert.equal(appShortcutRows.find((row) => row.id === "a")?.targetLabel, "系统 · 设置");
  assert.equal(appShortcutRows.find((row) => row.id === "a")?.statusLabel, "重复");
  assert.equal(appShortcutRows.find((row) => row.id === "a")?.conflictLabel, "与 1 个自定义快捷键重复");
  assert.equal(appShortcutRows.find((row) => row.id === "c")?.targetLabel, "目标不存在");
  assert.equal(appShortcutRows.find((row) => row.id === "c")?.statusLabel, "已停用");
  assert.equal(appShortcutRows.find((row) => row.id === "c")?.conflictLabel, "与内置快捷键冲突");
  assert.equal(appShortcutRows.find((row) => row.id === "d")?.statusLabel, "无效");
  assert.match(panelSource, /onclick=\{\(\) => addAppShortcut\(\)\}>添加快捷键<\/button>/);
  assert.match(panelSource, /customAppCount: appShortcuts\.length/);
  assert.match(panelSource, /\{shortcutBuiltIns\(\)\.length\} 内置 \/ \{appShortcuts\.length\} 自定义/);
  assert.match(panelSource, /checked=\{row\.enabled\}/);
  assert.match(panelSource, /aria-label="应用快捷键"/);
  assert.match(panelSource, /aria-label="快捷键目标"/);
  assert.match(panelSource, /onclick=\{\(\) => removeAppShortcut\(row\.id\)\}>删除<\/button>/);

  const shortcutOverview = mod.shortcutPageOverview({
    hotkey: "Option+Z",
    saveLabel: "已保存",
    aliasCount: 2,
    targetCount: 9,
    customGlobalCount: 0,
    customAppCount: 2,
    builtinAppCount: macBuiltIns.length,
  });
  assert.equal(shortcutOverview.cards.find((card) => card.label === "呼出快捷键")?.value, "Option+Z");
  assert.equal(shortcutOverview.cards.find((card) => card.label === "应用快捷键")?.value, "8 个内置 / 2 个自定义");
  assert.equal(shortcutOverview.cards.find((card) => card.label === "应用快捷键")?.detail, "自定义快捷键可编辑");
  assert.equal(shortcutOverview.cards.find((card) => card.label === "指令别名")?.value, "2 个");
  assert.equal(shortcutOverview.emptyStates.global, "暂无自定义全局快捷键；首版只启用主呼出快捷键。");
  assert.equal(shortcutOverview.emptyStates.app, "2 个自定义应用快捷键");
  assert.match(panelSource, /activeShortcutTab === "alias"/);
  assert.match(panelSource, /onclick=\{\(\) => addCommandAlias\(\)\}>添加映射<\/button>/);
  assert.match(panelSource, /onclick=\{resetCommandAliases\}/);
  assert.match(panelSource, /checked=\{entry\.enabled\}/);
  assert.match(panelSource, /onchange=\{\(event\) => updateCommandAlias\(entry\.id, \{ enabled:/);
  assert.match(panelSource, /onclick=\{\(\) => removeCommandAlias\(entry\.id\)\}>删除<\/button>/);
  assert.match(panelSource, /\{shortcutSummary\.emptyStates\.alias\}/);

  const commandTargets = [
    { code: "system:settings", label: "系统 · 设置", explain: "打开设置", enabled: true },
    { code: "local:desktop", label: "本地启动 · 桌面", explain: "~/Desktop", enabled: false },
    { code: "web:github", label: "网页快开 · GitHub", explain: "gh", enabled: true },
  ];
  const commandAliases = [
    { id: "a", alias: "cfg", targetCode: "system:settings", enabled: true },
    { id: "b", alias: "desk", targetCode: "local:desktop", enabled: false },
  ];
  const commandOverview = mod.commandCenterOverview(commandTargets, commandAliases);
  assert.equal(commandOverview.totalTargets, 3);
  assert.equal(commandOverview.enabledTargets, 2);
  assert.equal(commandOverview.aliasCount, 2);
  assert.equal(commandOverview.groups.find((group) => group.id === "system")?.aliasCount, 1);
  assert.equal(commandOverview.groups.find((group) => group.id === "local")?.enabledCount, 0);
  assert.deepEqual(commandOverview.groups.map((group) => group.label), [
    "系统指令",
    "本地启动",
    "网页快开",
    "插件指令",
  ]);

  const localRows = mod.commandCenterRows({
    targets: commandTargets,
    aliases: commandAliases,
    source: "local",
    status: "disabled",
    query: "",
  });
  assert.deepEqual(localRows.map((row) => row.code), ["local:desktop"]);
  assert.equal(localRows[0].sourceLabel, "本地启动");
  assert.equal(localRows[0].statusLabel, "已停用");
  assert.equal(localRows[0].aliasLabel, "1 个别名 / 0 个启用");
  assert.equal(localRows[0].aliasActionLabel, "管理别名");
  assert.deepEqual(localRows[0].aliasPreview, ["desk"]);
  assert.equal(localRows[0].aliasHint, "别名均已停用");

  const webRows = mod.commandCenterRows({
    targets: commandTargets,
    aliases: commandAliases,
    source: "web",
    status: "all",
    query: "",
    pinnedCodes: ["web:github"],
  });
  assert.equal(webRows[0].pinned, true);
  assert.equal(webRows[0].pinLabel, "取消固定");
  assert.equal(webRows[0].pinStatusLabel, "已固定");
  assert.equal(webRows[0].aliasActionLabel, "添加别名");
  assert.deepEqual(webRows[0].aliasPreview, []);
  assert.equal(webRows[0].aliasHint, "未设置短词");

  const pinnedRows = mod.commandCenterRows({
    targets: commandTargets,
    aliases: commandAliases,
    source: "all",
    status: "all",
    query: "",
    pinnedCodes: ["web:github"],
  });
  assert.deepEqual(pinnedRows.map((row) => row.code), ["web:github", "system:settings", "local:desktop"]);

  const fixedRows = mod.commandCenterRows({
    targets: commandTargets,
    aliases: commandAliases,
    source: "all",
    status: "all",
    query: "已固定",
    pinnedCodes: ["web:github"],
  });
  assert.deepEqual(fixedRows.map((row) => row.code), ["web:github"]);

  const aliasRows = mod.commandCenterRows({
    targets: commandTargets,
    aliases: commandAliases,
    source: "all",
    status: "all",
    query: "cfg",
  });
  assert.deepEqual(aliasRows.map((row) => row.code), ["system:settings"]);

  assertSmokeChecked(
    "呼出快捷键右侧齿轮打开快捷设置，下拉包含默认快捷键、`Command+Space`、`Control+Space` 和重置项。",
    "macOS smoke checklist should mark the hotkey quick-settings dropdown complete",
  );
  assertSmokeChecked(
    "设置页 `快捷键` 不是简短说明页，显示 `全局快捷键`、`应用快捷键`、`指令别名` 三个 tab 和概览卡。",
    "macOS smoke checklist should mark the Shortcut settings structure complete",
  );
  assertSmokeChecked(
    "`快捷键 / 应用快捷键` tab 显示 8 个内置快捷键行，并且 `Space`、`Tab` 两项会随设置值更新文案。",
    "macOS smoke checklist should mark the built-in app shortcut rows complete",
  );
  assertSmokeChecked(
    "`快捷键 / 应用快捷键` tab 中点击 `添加快捷键` 会新增一条自定义应用快捷键，概览和页头自定义数量同步更新。",
    "macOS smoke checklist should mark custom app shortcut creation complete",
  );
  assertSmokeChecked(
    "自定义应用快捷键行支持启停、编辑快捷键、选择目标和删除；输入与内置快捷键重复时显示冲突提示。",
    "macOS smoke checklist should mark custom app shortcut row editing complete",
  );
  assertSmokeChecked(
    "`快捷键 / 指令别名` tab 显示真实的 `添加映射`、`清空别名`、启停和删除入口；无别名时显示空状态。",
    "macOS smoke checklist should mark shortcut alias management complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
