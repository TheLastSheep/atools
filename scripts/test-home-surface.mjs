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

  const emptyPinnedSections = mod.homeCommandSections([
    { code: "history:one", label: "最近 1", explain: "history", source: "history" },
  ], {
    pinnedRows: 2,
    recentRows: 1,
  });
  assert.deepEqual(emptyPinnedSections.map((section) => [section.id, section.label, section.commands.length]), [
    ["recent", "最近使用", 1],
  ]);

  const [homePanel, app] = await Promise.all([
    readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
  ]);
  assert.doesNotMatch(homePanel, /class="quick-actions"/);
  assert.doesNotMatch(homePanel, /class="home-overview"/);
  assert.doesNotMatch(homePanel, /class="pinned-empty"/);
  assert.match(homePanel, /resultIconSrc/);
  assert.match(homePanel, /<img src=\{source\} alt="" \/>/);
  assert.match(app, /showHomeRecent/);
  assert.match(app, /showQueryResults/);
  assert.doesNotMatch(app, /<HomePanel[\s\S]*?onsettingsmenu=\{openSettingsMenu\}/);
  assert.match(app, /const HOME_MIN_WINDOW_HEIGHT = 280;/);
  assert.match(app, /const HOME_MAX_WINDOW_HEIGHT = 340;/);
  assert.match(app, /invoke<SearchResult\[]>\("feature_catalog"\)/);
  assert.match(app, /listen\("builtin-plugins-loaded"/);
  assert.match(app, /featureCatalogRetryCount < 8/);
  assert.match(app, /setTimeout\(\(\) =>[\s\S]*?refreshFeatureCatalog\(\)[\s\S]*?250/);
  for (const implementedCode of ["paste-clipboard", "ip", "process-manager", "http-client", "hosts", "todo", "calc", "codec", "timestamp", "qr-code", "json", "color-converter", "翻译"]) {
    assert.ok(uiStateSource.includes(`code: "${implementedCode}"`), `Home recommendations should include implemented feature ${implementedCode}`);
  }
  for (const unavailableLabel of ["图片批处理", "上次匹配", "OCR", "ctool"]) {
    assert.ok(!uiStateSource.includes(`label: "${unavailableLabel}"`), `Home recommendations should not advertise unavailable feature ${unavailableLabel}`);
  }

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
    "空搜索且没有固定指令时不渲染固定空态，首页直接进入最近使用。",
    "macOS smoke checklist should mark compact empty-pinned behavior complete",
  );
  assertSmokeChecked(
    "默认首页只显示搜索、固定指令（存在时）和最近使用，不显示统计卡或管理入口。",
    "macOS smoke checklist should mark compact search-first home complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
