import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-home-search-overview-"));
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
  assert.equal(typeof mod.homeSearchOverviewCards, "function");

  const cards = mod.homeSearchOverviewCards([
    { code: "system:settings", label: "设置", explain: "设置", source: "pinned" },
    { code: "web:github", label: "GitHub", explain: "网页快开", source: "pinned" },
    { code: "history:json", label: "JSON 格式化", explain: "开发工具", source: "history" },
    { code: "history:qr", label: "二维码", explain: "图片工具", source: "history" },
  ], {
    pinnedRows: 2,
    recentRows: 2,
    localAppSearch: true,
    localLaunchSearch: true,
    commandAliasCount: 3,
    localLaunchCount: 2,
    webQuickOpenCount: 4,
  });

  assert.deepEqual(cards.map((card) => card.label), [
    "可搜来源",
    "固定指令",
    "最近历史",
    "首屏入口",
  ]);
  assert.deepEqual(cards.map((card) => card.value), ["7 类", "2 项", "2 项", "4 个"]);
  assert.match(cards[0].detail, /内置/);
  assert.match(cards[0].detail, /别名 3/);
  assert.match(cards[0].detail, /本地启动 2/);
  assert.match(cards[0].detail, /网页快开 4/);
  assert.equal(cards[1].detail, "固定栏 2 行，优先展示");
  assert.equal(cards[2].detail, "键盘方向键可直接选择");
  assert.equal(cards[3].detail, "导入 / 插件 / Agent / 设置");
  assert.ok(cards.every((card) => card.detail.length <= 28), "Overview details must stay compact");

  const emptyCards = mod.homeSearchOverviewCards([], {
    pinnedRows: 1,
    recentRows: 1,
    localAppSearch: false,
    localLaunchSearch: false,
    commandAliasCount: 0,
    localLaunchCount: 0,
    webQuickOpenCount: 0,
  });
  assert.equal(emptyCards[0].value, "3 类");
  assert.equal(emptyCards[1].value, "0 项");
  assert.equal(emptyCards[2].value, "0 项");
  assert.equal(emptyCards[2].detail, "首次使用时显示推荐指令");

  const [homePanel, app, searchBar] = await Promise.all([
    readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/SearchBar.svelte", root), "utf8"),
  ]);

  assert.match(homePanel, /homeSearchOverviewCards/);
  assert.match(homePanel, /aria-label="搜索概览"/);
  assert.match(homePanel, /class="home-overview"/);
  assert.match(homePanel, /overview-card/);
  assert.match(homePanel, /localAppSearch/);
  assert.match(homePanel, /localLaunchSearch/);
  assert.match(homePanel, /\.home-overview\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/);
  assert.match(homePanel, /\.overview-detail\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);

  assert.match(app, /localAppSearch=\{includeLocalAppSearch\(appSettings\)\}/);
  assert.match(app, /localLaunchSearch=\{includeLocalLaunchSearch\(appSettings\)\}/);
  assert.match(app, /commandAliasCount=\{commandAliases\.length\}/);
  assert.match(app, /localLaunchCount=\{localLaunchEntries\.filter/);
  assert.match(app, /webQuickOpenCount=\{webQuickOpenEntries\.filter/);
  assert.match(app, /const HOME_OVERVIEW_HEIGHT = 66;/);
  assert.match(app, /const HOME_PINNED_EMPTY_HEIGHT = 76;/);
  assert.match(app, /HOME_PANEL_VERTICAL_CHROME \+ HOME_OVERVIEW_HEIGHT/);
  assert.match(app, /pinnedCount > 0\s*\? extraSectionChrome\s*:\s*HOME_PINNED_EMPTY_HEIGHT/);

  assert.match(searchBar, /showBadge/);
  assert.match(searchBar, /class="app-badge"/);
  assert.match(searchBar, /aria-label="打开设置"/);
  assert.match(searchBar, /onclick=\{onbadgeclick\}/);
  assert.match(app, /showBadge=\{activePlugin === null\}/);
  assert.match(app, /onbadgeclick=\{\(\) => openSettingsMenu\("general"\)\}/);

  assertSmokeChecked(
    "点击 Z 图标进入设置页。",
    "macOS smoke checklist should mark clicking the Z badge to open Settings complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
