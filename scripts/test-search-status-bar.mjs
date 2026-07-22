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
  });
  assert.equal(results.title, "搜索结果");
  assert.equal(results.detail, "3 / 4 · GitHub 搜索 rust");
  assert.deepEqual(results.hints.map((hint) => `${hint.key}:${hint.label}`), [
    "↑:上一行",
    "↓:下一行",
    "Enter:打开",
    "Tab:执行",
    "Esc:清空",
  ]);

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
    "Enter:执行首项",
    "Tab:切换",
    "Esc:清空",
  ]);

  const [component, app, commands] = await Promise.all([
    readFile(new URL("src/components/SearchStatusBar.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src-tauri/src/commands.rs", root), "utf8"),
  ]);

  assert.match(component, /class="search-status-bar"/);
  assert.match(component, /\.search-status-bar\s*\{[\s\S]*?height:\s*34px;/);
  assert.match(component, /\.search-status-bar\s*\{[\s\S]*?border-top:\s*1px solid var\(--border\);/);
  assert.match(component, /\.status-detail\s*\{[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.match(component, /\.status-hints\s*\{[\s\S]*?display:\s*flex;/);
  assert.match(component, /\.keycap\s*\{[\s\S]*?min-width:\s*24px;/);
  assert.match(component, /\.hint:nth-child\(n \+ 4\)\s*\{[\s\S]*?display:\s*none;/);

  assert.match(app, /import SearchStatusBar from "\.\/components\/SearchStatusBar\.svelte";/);
  assert.match(app, /const SEARCH_STATUS_BAR_HEIGHT = 34;/);
  assert.match(app, /const REMOTE_SEARCH_DEBOUNCE_MS = 16;/);
  assert.match(app, /const FEATURE_SEARCH_TIMEOUT_MS = 1200;/);
  assert.match(app, /const LOCAL_APP_SEARCH_TIMEOUT_MS = 1800;/);
  assert.match(app, /const HOME_PANEL_VERTICAL_PADDING = 18;/);
  assert.match(app, /const HOME_MIN_WINDOW_HEIGHT = 280;/);
  assert.match(app, /const HOME_MAX_WINDOW_HEIGHT = 340;/);
  assert.match(app, /HOME_PANEL_VERTICAL_PADDING[\s\S]*?\+ SEARCH_STATUS_BAR_HEIGHT[\s\S]*?Math\.max\(HOME_MIN_WINDOW_HEIGHT, Math\.min\(HOME_MAX_WINDOW_HEIGHT, measured\)\)/);
  assert.match(app, /return SEARCH_BAR_HEIGHT \+ listHeight \+ SEARCH_STATUS_BAR_HEIGHT \+ SHELL_BORDER_HEIGHT;/);
  assert.match(app, /\{#if activePanel === "settings" && activePlugin === null\}[\s\S]*?<SettingsHeader/);
  assert.match(app, /<SearchStatusBar[\s\S]*?mode="results"/);
  assert.match(app, /<SearchStatusBar[\s\S]*?mode="home"/);
  assert.match(
    app,
    /const featureSettled = await settleSearchWithin\([\s\S]*?featureCall,[\s\S]*?FEATURE_SEARCH_TIMEOUT_MS[\s\S]*?results = partialResults[\s\S]*?const localAppSettled = await settleSearchWithin\([\s\S]*?localAppCall,[\s\S]*?LOCAL_APP_SEARCH_TIMEOUT_MS/,
    "Plugin results should render before slower local application search completes",
  );
  assert.match(
    app,
    /setTimeout\(resolve, REMOTE_SEARCH_DEBOUNCE_MS\)[\s\S]*?runId !== searchRunId[\s\S]*?invoke<SearchResult\[]>\("search_features"/,
    "Remote searches should debounce and discard superseded keystrokes before invoking Rust",
  );
  assert.match(
    app,
    /results = partialResults;[\s\S]*?remoteSearchStatus = "ready";[\s\S]*?const localAppSettled/,
    "Local application enrichment must not leave the primary search response stuck in searching state",
  );
  assert.match(
    app,
    /function settleSearchWithin<T>[\s\S]*?setTimeout\(\(\) =>[\s\S]*?status: "rejected"[\s\S]*?clearTimeout\(timeoutId\)/,
    "Every native search stage should have a deadline instead of leaving the palette searching forever",
  );
  assert.doesNotMatch(
    app,
    /await resizePalette\(resultsWindowHeightFor\((?:localResults|partialResults|mergedResults)\)\)/,
    "Window resizing should not serialize the search response path",
  );
  assert.match(
    commands,
    /pub async fn search_features\([\s\S]*?spawn_blocking\(move \|\| \{[\s\S]*?search_features_inner/,
    "SQLite feature search should execute outside the Tauri UI command path",
  );
  assert.match(
    app,
    /void hydrateLocalAppResultIcons\(runId, newQuery, localAppResults\)/,
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
