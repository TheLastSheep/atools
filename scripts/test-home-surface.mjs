import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-home-surface-"));
const outFile = join(outDir, "homeSurface.mjs");

try {
  const uiStatePath = new URL("src/lib/uiState.ts", root).pathname;
  const uiStateSource = await readFile(uiStatePath, "utf8");
  const uiStateTransformed = await transformWithEsbuild(uiStateSource, uiStatePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "uiState.mjs"), uiStateTransformed.code);

  const resultIconsPath = new URL("src/lib/resultIcons.ts", root).pathname;
  const resultIconsSource = await readFile(resultIconsPath, "utf8");
  const resultIconsTransformed = await transformWithEsbuild(resultIconsSource, resultIconsPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "resultIcons.mjs"), resultIconsTransformed.code.replaceAll('from "./types";', 'from "./types.mjs";'));
  await writeFile(join(outDir, "types.mjs"), "export {};\n");

  const sourcePath = new URL("src/lib/homeSurface.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code
    .replaceAll('from "./uiState";', 'from "./uiState.mjs";')
    .replaceAll('from "./resultIcons";', 'from "./resultIcons.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };

  assert.equal(typeof mod.homeQuickActions, "function");
  const actions = mod.homeQuickActions();
  assert.deepEqual(actions.map((action) => action.label), [
    "导入 ZTools 插件",
    "插件管理",
    "Agent / MCP",
    "设置",
  ]);
  assert.deepEqual(actions.map((action) => action.panel), ["import", "plugins", "agent", "settings"]);
  assert.deepEqual(actions.map((action) => action.source), ["recommended", "recommended", "recommended", "recommended"]);
  assert.ok(actions.every((action) => action.code.startsWith("home:")));
  assert.ok(actions.every((action) => action.explain.trim().length > 0));
  assert.equal(new Set(actions.map((action) => action.code)).size, actions.length);

  const visible = mod.homeSurfaceSections({
    recentCount: 0,
    showQuickActions: true,
  });
  assert.deepEqual(visible, ["quick-actions", "recent"]);

  const hidden = mod.homeSurfaceSections({
    recentCount: 0,
    showQuickActions: false,
  });
  assert.deepEqual(hidden, ["recent"]);

  const emptyPinnedSections = mod.homeCommandSections([
    { code: "history:one", label: "最近 1", explain: "history", source: "history" },
  ], {
    pinnedRows: 2,
    recentRows: 1,
    showPinnedEmpty: true,
  });
  assert.deepEqual(emptyPinnedSections.map((section) => [section.id, section.label, section.commands.length, section.empty]), [
    ["pinned", "固定", 0, true],
    ["recent", "最近使用", 1, false],
  ]);
  assert.equal(emptyPinnedSections[0].emptyActionLabel, "管理固定指令");

  const [homePanel, app] = await Promise.all([
    readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
  ]);
  assert.match(homePanel, /class="quick-actions"/);
  assert.match(homePanel, /aria-label="常用入口"/);
  assert.match(homePanel, /class="pinned-empty"/);
  assert.match(homePanel, /aria-label="管理固定指令"/);
  assert.match(homePanel, /onclick=\{openPinnedCommandsSettings\}/);
  assert.match(homePanel, /onsettingsmenu\("commands"\)/);
  assert.match(app, /showHomeRecent/);
  assert.match(app, /showQueryResults/);
  assert.match(app, /<HomePanel[\s\S]*?onsettingsmenu=\{openSettingsMenu\}/);

  const sections = mod.homeCommandSections([
    { code: "web:github", label: "GitHub", explain: "网页快开", source: "pinned" },
    { code: "system:settings", label: "设置", explain: "设置", source: "pinned", panel: "settings" },
    { code: "system:agent", label: "Agent / MCP", explain: "Agent", source: "pinned", panel: "agent" },
    { code: "system:import", label: "导入", explain: "导入", source: "pinned", panel: "import" },
    { code: "system:plugins", label: "插件管理", explain: "插件", source: "pinned", panel: "plugins" },
    { code: "local:desktop", label: "桌面", explain: "~/Desktop", source: "pinned" },
    { code: "local:downloads", label: "下载", explain: "~/Downloads", source: "pinned" },
    { code: "web:npm", label: "NPM", explain: "npm", source: "pinned" },
    { code: "web:google", label: "Google", explain: "g", source: "pinned" },
    { code: "web:overflow", label: "Overflow", explain: "hidden", source: "pinned" },
    { code: "history:one", label: "最近 1", explain: "history", source: "history" },
    { code: "history:two", label: "最近 2", explain: "history", source: "history" },
  ], {
    pinnedRows: 1,
    recentRows: 1,
  });
  assert.deepEqual(sections.map((section) => section.id), ["pinned", "recent"]);
  assert.equal(sections[0].label, "固定");
  assert.equal(sections[0].commands.length, 9);
  assert.equal(sections[0].commands.at(-1)?.code, "web:google");
  assert.equal(sections[1].label, "最近使用");
  assert.deepEqual(sections[1].commands.map((command) => command.code), ["history:one", "history:two"]);

  assert.deepEqual(mod.homeCommandStatus(sections.flatMap((section) => section.commands), 0, {
    pinnedRows: 1,
    recentRows: 1,
  }), {
    title: "固定",
    detail: "1 / 9 · GitHub",
    selectedLabel: "GitHub",
  });

  assert.deepEqual(mod.homeCommandStatus(sections.flatMap((section) => section.commands), 9, {
    pinnedRows: 1,
    recentRows: 1,
  }), {
    title: "最近使用",
    detail: "1 / 2 · 最近 1",
    selectedLabel: "最近 1",
  });

  assertSmokeChecked(
    "设置“最近使用显示行数”为 1，首页最多显示 9 个最近项。",
    "macOS smoke checklist should mark recent row capacity complete",
  );
  assertSmokeChecked(
    "空搜索时显示“最近使用”；存在固定指令时先显示 `固定` 分区，再显示 `最近使用` 分区。",
    "macOS smoke checklist should mark Home pinned/recent ordering complete",
  );
  assertSmokeChecked(
    "空搜索且没有固定指令时，首页仍显示紧凑 `固定` 空态，并提供 `管理固定指令` 入口。",
    "macOS smoke checklist should mark Home pinned empty state complete",
  );
  assertSmokeChecked(
    "点击首页 `管理固定指令` 会进入设置页并直接选中 `所有指令`，不落到通用设置。",
    "macOS smoke checklist should mark Home pinned management navigation complete",
  );
  assertSmokeChecked(
    "空搜索首页上方显示 `导入 ZTools 插件`、`插件管理`、`Agent / MCP`、`设置` 四个紧凑入口，不显示营销说明块。",
    "macOS smoke checklist should mark Home first-screen quick entries complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
