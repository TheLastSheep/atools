import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-ztools-import-view-"));
const outFile = join(outDir, "ztoolsImportView.mjs");

try {
  const sourcePath = new URL("src/lib/ztoolsImportView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const uiRestoreChecklist = await readFile(new URL("docs/ui-ztools-restore-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };
  const assertUiRestoreChecked = (row, message) => {
    assert.ok(uiRestoreChecklist.includes(`- [x] ${row}`), message);
  };

  const candidates = [
    {
      path: "/plugins/ok",
      name: "ok-plugin",
      title: "OK 插件",
      version: "1.2.3",
      features_count: 3,
      platform_supported: true,
      main_exists: true,
      preload_exists: true,
      logo_exists: true,
      unsupported_cmd_types: [],
      warnings: [],
      errors: [],
    },
    {
      path: "/plugins/warn",
      name: "warn-plugin",
      title: null,
      version: "",
      features_count: 2,
      platform_supported: true,
      main_exists: true,
      preload_exists: false,
      logo_exists: false,
      unsupported_cmd_types: ["regex"],
      warnings: ["preload.js 不存在", "存在暂不支持的 cmd type: regex"],
      errors: [],
    },
    {
      path: "/plugins/bad",
      name: "bad-plugin",
      title: "Bad 插件",
      version: "0.0.1",
      features_count: 4,
      platform_supported: false,
      main_exists: false,
      preload_exists: false,
      logo_exists: false,
      unsupported_cmd_types: [],
      warnings: ["缺少图标"],
      errors: ["main 入口不存在"],
    },
  ];

  assert.equal(typeof mod.ztoolsImportView, "function");
  const emptyView = mod.ztoolsImportView([], new Set());
  assert.deepEqual(emptyView.summary, {
    total: 0,
    selectable: 0,
    selected: 0,
    warning: 0,
    blocked: 0,
    features: 0,
  });
  assert.deepEqual(emptyView.rows, []);
  assert.equal(emptyView.emptyText, "选择 ZTools 插件目录后，这里会显示可导入插件和预检结果。");

  const view = mod.ztoolsImportView(candidates, new Set(["/plugins/ok", "/plugins/warn", "/plugins/bad"]));
  assert.deepEqual(view.summary, {
    total: 3,
    selectable: 2,
    selected: 2,
    warning: 1,
    blocked: 1,
    features: 9,
  });
  assert.deepEqual(view.summaryChips.map((chip) => chip.label), [
    "候选 3",
    "可导入 2",
    "已选 2",
    "警告 1",
    "错误 1",
  ]);
  assert.deepEqual(view.rows.map((row) => [row.path, row.status, row.statusLabel, row.selectable, row.selected]), [
    ["/plugins/ok", "ready", "可导入", true, true],
    ["/plugins/warn", "warning", "需注意", true, true],
    ["/plugins/bad", "blocked", "不可导入", false, false],
  ]);
  const allImportableView = mod.ztoolsImportView(
    candidates,
    new Set(view.rows.filter((row) => row.selectable).map((row) => row.path)),
  );
  assert.deepEqual(allImportableView.rows.map((row) => [row.path, row.selected]), [
    ["/plugins/ok", true],
    ["/plugins/warn", true],
    ["/plugins/bad", false],
  ]);
  const clearedSelectionView = mod.ztoolsImportView(candidates, new Set());
  assert.equal(clearedSelectionView.summary.selected, 0);
  assert.deepEqual(clearedSelectionView.rows.map((row) => [row.path, row.selected]), [
    ["/plugins/ok", false],
    ["/plugins/warn", false],
    ["/plugins/bad", false],
  ]);
  assert.equal(view.rows[0].title, "OK 插件");
  assert.equal(view.rows[0].subtitle, "ok-plugin · 1.2.3 · 3 指令");
  assert.equal(view.rows[1].title, "warn-plugin");
  assert.equal(view.rows[1].subtitle, "warn-plugin · 0.0.0 · 2 指令");
  assert.deepEqual(view.rows[1].missingFlags, ["缺少 preload", "缺少图标", "未支持 regex"]);
  assert.deepEqual(view.rows[1].messages, ["preload.js 不存在", "存在暂不支持的 cmd type: regex"]);
  assert.deepEqual(view.rows[2].missingFlags, ["平台不匹配", "缺少入口", "缺少 preload", "缺少图标"]);
  assert.deepEqual(view.rows[2].messages, ["缺少图标", "main 入口不存在"]);

  const report = mod.ztoolsImportReportView({
    imported: ["/plugins/ok"],
    skipped: [candidates[1]],
    failed: [{ path: "/plugins/bad", error: "manifest parse failed" }],
  });
  assert.deepEqual(report.summary, {
    imported: 1,
    skipped: 1,
    failed: 1,
    total: 3,
  });
  assert.deepEqual(report.rows.map((row) => [row.kind, row.title, row.detail]), [
    ["imported", "已导入", "/plugins/ok"],
    ["skipped", "已跳过", "warn-plugin · 0.0.0"],
    ["failed", "导入失败", "manifest parse failed"],
  ]);
  assert.deepEqual(report.rows.map((row) => [row.kind, row.path]), [
    ["imported", "/plugins/ok"],
    ["skipped", "/plugins/warn"],
    ["failed", "/plugins/bad"],
  ]);
  assert.equal(report.rows[1].path, "/plugins/warn");
  assert.equal(report.hasFailures, true);

  const emptyReport = mod.ztoolsImportReportView(null);
  assert.equal(emptyReport, null);

  const [homeSurface, homePanel, appShell, systemPanel, importPanel] = await Promise.all([
    readFile(new URL("src/lib/homeSurface.ts", root), "utf8"),
    readFile(new URL("src/components/HomePanel.svelte", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/SystemPanel.svelte", root), "utf8"),
    readFile(new URL("src/components/ZToolsImportPanel.svelte", root), "utf8"),
  ]);
  assert.match(homeSurface, /code: "home:import-ztools"[\s\S]*label: "导入 ZTools 插件"[\s\S]*panel: "import"/);
  assert.match(homePanel, /function activateQuickAction\(action: HomeQuickAction\) \{[\s\S]*if \(action\.panel\) \{[\s\S]*onpanelchange\(action\.panel\);[\s\S]*return;[\s\S]*\}/);
  assert.match(appShell, /<HomePanel[\s\S]*onpanelchange=\{onHomePanelChange\}/);
  assert.match(appShell, /async function onHomePanelChange\(panel: ShellPanel\) \{[\s\S]*await onPanelChange\(panel\);[\s\S]*\}/);
  assert.match(appShell, /<SystemPanel panel=\{activePanel\} settingsMenu=\{settingsMenuTarget\} onpanelchange=\{onPanelChange\} \/>/);
  assert.match(systemPanel, /import ZToolsImportPanel from "\.\/ZToolsImportPanel\.svelte";/);
  assert.match(systemPanel, /\{:else if panel === "import"\}[\s\S]*<ZToolsImportPanel \/>/);
  assert.match(importPanel, /import \{ open \} from "@tauri-apps\/plugin-dialog";/);
  assert.match(importPanel, /const root = await open\(\{ directory: true, multiple: false \}\);/);
  assert.match(importPanel, /if \(typeof root !== "string"\) return;/);
  assert.match(importPanel, /candidates = await invoke<ZToolsImportCandidate\[]>\("scan_ztools_plugins", \{ root \}\);/);
  assert.match(importPanel, /selected = new Set\([\s\S]*candidates[\s\S]*\.filter\(\(item\) => item\.errors\.length === 0\)[\s\S]*\.map\(\(item\) => item\.path\),[\s\S]*\);/);
  assert.match(importPanel, /report = null;/);
  assert.match(importPanel, /等待扫描/);
  assert.match(importPanel, /选择目录并扫描/);
  assert.match(importPanel, /onclick=\{chooseAndScan\}/);
  assert.doesNotMatch(importPanel, /onMount\(\(\)\s*=>\s*chooseAndScan/);
  assert.match(importPanel, /\{#if candidates\.length > 0\}[\s\S]*class="candidate-summary"[\s\S]*class="candidate-list"[\s\S]*class="import-actions"[\s\S]*\{:else\}[\s\S]*class="empty-import-state"/);
  assert.match(importPanel, /class=\{`summary-chip \$\{chip\.tone\}`\}/);
  assert.match(importPanel, /class=\{`status-pill \$\{row\.status\}`\}/);
  assert.match(importPanel, /class="flag-list"/);
  assert.match(importPanel, /class="message-list"/);
  assert.match(importPanel, /disabled=\{!row\.selectable\}/);
  assert.match(importPanel, /function selectAllImportable\(\)\s*\{\s*selected = new Set\(importView\.rows\.filter\(\(row\) => row\.selectable\)\.map\(\(row\) => row\.path\)\);\s*\}/);
  assert.match(importPanel, /function clearSelection\(\)\s*\{\s*selected = new Set\(\);\s*\}/);
  assert.match(importPanel, /全选可导入/);
  assert.match(importPanel, /清空选择/);
  assert.match(importPanel, /`导入 \$\{importView\.summary\.selected\} 个插件`/);
  assert.match(importPanel, /\{#if reportView\}[\s\S]*class="report"/);
  assert.match(importPanel, /<strong>导入报告<\/strong>/);
  assert.match(importPanel, /成功 \{reportView\.summary\.imported\} 个，跳过 \{reportView\.summary\.skipped\} 个，失败 \{reportView\.summary\.failed\} 个。/);
  assert.match(importPanel, /class=\{`report-row \$\{row\.kind\}`\}/);
  assert.match(importPanel, /<strong>\{row\.detail\}<\/strong>/);
  assert.match(importPanel, /<small>\{row\.path\}<\/small>/);

  assertSmokeChecked(
    "打开导入面板。",
    "macOS smoke checklist should mark ZTools import panel shell navigation complete",
  );
  assertSmokeChecked(
    "点击 `导入 ZTools 插件` 只进入导入面板，并显示 `选择目录并扫描`、`等待扫描`，不自动执行导入。",
    "macOS smoke checklist should mark ZTools import entry behavior complete",
  );
  assertSmokeChecked(
    "未扫描时显示 `等待扫描` 空态，不显示候选统计、候选行或报告行。",
    "macOS smoke checklist should mark ZTools import empty state complete",
  );
  assertSmokeChecked(
    "选择本机 ZTools 插件目录。",
    "macOS smoke checklist should mark local ZTools plugin directory selection complete",
  );
  assertSmokeChecked(
    "显示候选插件、候选/可导入/已选/警告/错误统计、warnings/errors、缺失标记、状态胶囊和 selected count。",
    "macOS smoke checklist should mark ZTools import candidate summary complete",
  );
  assertSmokeChecked(
    "候选结果中不可导入项禁用 checkbox，可导入项支持 `全选可导入` 和 `清空选择`。",
    "macOS smoke checklist should mark ZTools import checkbox selection complete",
  );
  assertSmokeChecked(
    "导入报告显示成功、跳过、失败三类明细；失败项必须显示错误原因。",
    "macOS smoke checklist should mark ZTools import report rows complete",
  );
  assertUiRestoreChecked(
    "Import panel: candidates, warnings/errors, selected count, report all visible.",
    "UI restore checklist should keep import panel coverage checked",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
