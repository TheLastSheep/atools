import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-search-status-bar-"));
const outFile = join(outDir, "searchStatusBar.mjs");

try {
  const sourcePath = new URL("src/lib/searchStatusBar.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };

  const home = mod.searchStatusBarView({
    mode: "home",
    count: 18,
    selectedIndex: 0,
    selectedLabel: "设置",
    tabAction: "select",
  });
  assert.equal(home.title, "最近使用");
  assert.equal(home.detail, "1 / 18 · 设置");
  assert.deepEqual(home.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "↑↓←→:移动",
    "Enter:打开",
    "Tab:切换",
    "Esc:收起",
  ]);

  const emptyHome = mod.searchStatusBarView({
    mode: "home",
    count: 0,
    selectedIndex: 0,
    selectedLabel: "",
    tabAction: "select",
  });
  assert.deepEqual(emptyHome.hints.map((hint) => `${hint.key}:${hint.label}`), ["Esc:收起"]);
  const emptyHomeTarget = mod.searchStatusBarView({
    mode: "home",
    count: 0,
    selectedIndex: 0,
    selectedLabel: "",
    tabAction: "target",
    tabTargetHint: "选择目标",
  });
  assert.deepEqual(emptyHomeTarget.hints.map((hint) => `${hint.key}:${hint.label}`), ["Tab:选择目标", "Esc:收起"]);

  const pinnedHome = mod.searchStatusBarView({
    mode: "home",
    count: 11,
    selectedIndex: 0,
    selectedLabel: "GitHub",
    titleOverride: "固定",
    detailOverride: "1 / 2 · GitHub",
    tabAction: "select",
  });
  assert.equal(pinnedHome.title, "固定");
  assert.equal(pinnedHome.detail, "1 / 2 · GitHub");
  assert.deepEqual(pinnedHome.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "↑↓←→:移动",
    "Enter:打开",
    "Tab:切换",
    "Esc:收起",
  ]);

  const results = mod.searchStatusBarView({
    mode: "results",
    count: 4,
    selectedIndex: 2,
    selectedLabel: "GitHub 搜索 rust",
    selectedAction: "打开",
    tabAction: "target",
    tabTargetHint: "交给 字符转换",
  });
  assert.equal(results.title, "搜索结果");
  assert.equal(results.detail, "3 / 4 · GitHub 搜索 rust");
  assert.deepEqual(results.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "↑:上一行",
    "↓:下一行",
    "PgUp/PgDn:翻页",
    "Enter:打开",
    "Tab:交给 字符转换",
    "Esc:清空",
  ]);

  const unconfigured = mod.searchStatusBarView({ mode: "results", count: 0, selectedIndex: 0, selectedLabel: "", tabAction: "target" });
  assert.ok(unconfigured.hints.some(hint => hint.key === "Tab" && hint.label === "设置目标"));

  const executeResult = mod.searchStatusBarView({
    mode: "results",
    count: 2,
    selectedIndex: 0,
    selectedLabel: "设置",
    selectedAction: "执行",
    tabAction: "select",
  });
  assert.equal(executeResult.detail, "1 / 2 · 设置");
  assert.deepEqual(executeResult.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "↑:上一行",
    "↓:下一行",
    "PgUp/PgDn:翻页",
    "Enter:执行",
    "Tab:切换",
    "Esc:清空",
  ]);

  const copiedTextResult = mod.searchStatusBarView({
    mode: "results",
    count: 3,
    selectedIndex: 1,
    selectedLabel: "复制格式化 JSON",
    selectedAction: "复制",
    tabAction: "select",
  });
  assert.equal(copiedTextResult.detail, "2 / 3 · 复制格式化 JSON");
  assert.deepEqual(copiedTextResult.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "↑:上一行",
    "↓:下一行",
    "PgUp/PgDn:翻页",
    "Enter:复制",
    "Tab:切换",
    "Esc:清空",
  ]);

  const empty = mod.searchStatusBarView({
    mode: "results",
    count: 0,
    selectedIndex: 0,
    selectedLabel: "",
    selectedAction: "",
    tabAction: "select",
  });
  assert.equal(empty.title, "搜索结果");
  assert.equal(empty.detail, "0 项匹配");
  assert.deepEqual(empty.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "Esc:清空",
  ]);

  const retryEmpty = mod.searchStatusBarView({
    mode: "results",
    count: 0,
    selectedIndex: 0,
    selectedLabel: "",
    tabAction: "select",
    retryOnEnter: true,
  });
  assert.deepEqual(retryEmpty.hints.map((hint) => `${hint.key}:${hint.label}`), ["Enter:重试搜索", "Esc:清空"]);

  const [component, app, primarySurface, resultsSurface, layout, surfacePresentation, searchController, commands, search] = await Promise.all([
    readFile(new URL("src/components/SearchStatusBar.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/LauncherPrimarySurface.svelte", root), "utf8"),
    readFile(new URL("src/components/LauncherResultsSurface.svelte", root), "utf8"),
    readFile(new URL("src/lib/launcherWindowLayout.ts", root), "utf8"),
    readFile(new URL("src/lib/launcherSurfacePresentation.svelte.ts", root), "utf8"),
    readFile(new URL("src/lib/launcherSearchController.ts", root), "utf8"),
    readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
    readFile(new URL("src/lib/launcherSearch.ts", root), "utf8"),
  ]);

  assert.match(component, /class="search-status-bar"/);
  assert.match(component, /\.search-status-bar\s*\{[\s\S]*?height:\s*34px;/);
  assert.match(component, /\.search-status-bar\s*\{[\s\S]*?border-top:\s*1px solid var\(--border\);/);
  assert.match(component, /\.status-detail\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(component, /\.status-hints\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(component, /\.keycap\s*\{[\s\S]*?min-width:\s*24px;/);
  assert.match(component, /container:\s*search-status \/ inline-size;/);
  assert.match(component, /@container search-status \(max-width: 880px\) \{(?:(?!@container search-status)[\s\S])*?\.hint\.navigation-hint, \.full-tab-label\s*\{\s*display:\s*none;/);
  assert.match(component, /@container search-status \(max-width: 640px\) \{(?:(?!@container search-status)[\s\S])*?\.hint\.paging-hint\s*\{\s*display:\s*none;/);
  assert.match(component, /@container search-status \(max-width: 640px\) \{(?:(?!@container search-status)[\s\S])*?\.status-title\s*\{\s*display:\s*none;/);
  assert.match(component, /@container search-status \(max-width: 640px\) \{(?:(?!@container search-status)[\s\S])*?\.status-position\s*\{\s*display:\s*inline;/);
  assert.match(component, /@container search-status \(max-width: 640px\) \{(?:(?!@container search-status)[\s\S])*?\.status-copy:not\(\.has-feedback\) \.status-detail\s*\{\s*display:\s*none;/);
  assert.match(component, /@container search-status \(max-width: 520px\) \{[\s\S]*?\.hint\.compact-navigation\s*\{\s*display:\s*none;/);
  assert.match(component, /@container search-status \(max-width: 520px\) \{[\s\S]*?\.action-menu-hint\s*\{\s*display:\s*none;/);
  assert.match(component, /\.hint\.navigation-hint, \.full-tab-label\s*\{\s*display:\s*none;/);
  assert.match(component, /\.hint\.compact-navigation\s*\{\s*display:\s*inline-flex;/);

  assert.match(app, /import LauncherPrimarySurface from "\.\/components\/LauncherPrimarySurface\.svelte";/);
  assert.match(app, /<LauncherPrimarySurface[\s\S]*?resultsSurface=\{/);
  assert.match(primarySurface, /import LauncherResultsSurface, \{ type LauncherResultsSurfaceProps \} from "\.\/LauncherResultsSurface\.svelte";/);
  assert.match(primarySurface, /<LauncherResultsSurface \{\.\.\.resultsSurface\} \/>/);
  assert.match(resultsSurface, /import SearchStatusBar from "\.\/SearchStatusBar\.svelte";/);
  assert.match(layout, /searchStatusBarHeight:\s*34/);
  assert.match(search, /const REMOTE_SEARCH_DEBOUNCE_MS = 16;/);
  assert.match(search, /const FEATURE_SEARCH_TIMEOUT_MS = 1200;/);
  assert.match(search, /const LOCAL_APP_SEARCH_TIMEOUT_MS = 1800;/);
  assert.match(layout, /homePanelVerticalPadding:\s*22/);
  assert.match(layout, /homeMinWindowHeight:\s*280/);
  assert.match(layout, /homeContentBorderHeight:\s*1/);
  assert.match(layout, /homeSectionHeaderHeight:\s*22/);
  assert.match(layout, /recentTileHeight:\s*86/);
  assert.match(layout, /recentRowGap:\s*0/);
  assert.doesNotMatch(layout, /homeMaxWindowHeight/);
  assert.match(layout, /export function homeWindowHeightFor[\s\S]*?return Math\.max\(LAUNCHER_LAYOUT\.homeMinWindowHeight, measured\)/);
  assert.match(layout, /return LAUNCHER_LAYOUT\.searchBarHeight \+ listHeight \+ LAUNCHER_LAYOUT\.searchStatusBarHeight \+ LAUNCHER_LAYOUT\.shellBorderHeight;/);
  assert.match(primarySurface, /\{#if showSettingsHeader\}[\s\S]*?<SettingsHeader/);
  assert.match(resultsSurface, /<SearchStatusBar[\s\S]*?mode="results"/);
  assert.match(resultsSurface, /<SearchStatusBar[\s\S]*?mode="home"/);
  assert.match(searchController, /await enrichLauncherSearch\(\{/);
  assert.match(surfacePresentation, /resolveSearchSelection\(state\.launcherResults, state\.userSearchSelection\)/);
  assert.match(search, /await Promise.all\(sources.map/);
  assert.match(search, /setTimeout[\s\S]*?status: "rejected"/);
  assert.match(searchController, /setTimeout\(resolve, REMOTE_SEARCH_DEBOUNCE_MS\)[\s\S]*?runId !== state\.searchRunId/);
  assert.doesNotMatch(
    surfacePresentation,
    /await ports\.resizePalette\(height\)/,
    "Window resizing should not serialize the search response path",
  );
  assert.match(surfacePresentation, /void ports\.resizePalette\(height\)/);
  assert.match(
    commands,
    /pub async fn search_features\([\s\S]*?spawn_blocking\(move \|\| \{[\s\S]*?search_features_inner/,
    "SQLite feature search should execute outside the Tauri UI command path",
  );
  assert.match(
    searchController,
    /onApps: \(items\) => \{ void hydrateLocalAppResultIcons\(runId, newQuery, items\); \}/,
    "Local app icon hydration should not block search completion",
  );

  assertSmokeChecked(
    "最近使用和搜索结果底部显示 34px 状态栏，展示当前位置/总数、当前选中项和 `Enter` / `Tab` / `Esc` 等按键提示；设置页不显示该底栏。",
    "macOS smoke checklist should mark the home/results search status bar complete",
  );
  assertSmokeChecked(
    "首页存在固定指令时，底部状态栏选中固定项显示 `固定 n/m · 名称`，移动到最近使用项后显示 `最近使用 n/m · 名称`。",
    "macOS smoke checklist should mark pinned/recent home status text complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
