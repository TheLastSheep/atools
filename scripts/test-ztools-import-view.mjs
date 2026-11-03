import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-ztools-import-view-"));
const outFile = join(outDir, "ztoolsImportView.mjs");
const marketNavigationFile = join(outDir, "pluginMarketNavigation.mjs");
const sourceSelectionFile = join(outDir, "ztoolsImportSelection.mjs");

try {
  const sourcePath = new URL("src/lib/ztoolsImportView.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const marketNavigationPath = new URL("src/lib/pluginMarketNavigation.ts", root).pathname;
  const marketNavigationSource = await readFile(marketNavigationPath, "utf8");
  const transformedMarketNavigation = await transformWithEsbuild(marketNavigationSource, marketNavigationPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(marketNavigationFile, transformedMarketNavigation.code);
  const sourceSelectionPath = new URL("src/lib/ztoolsImportSelection.ts", root).pathname;
  const sourceSelection = await readFile(sourceSelectionPath, "utf8");
  const transformedSourceSelection = await transformWithEsbuild(sourceSelection, sourceSelectionPath, { format: "esm", target: "esnext", loader: "ts" });
  await writeFile(sourceSelectionFile, transformedSourceSelection.code);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replace('"./pluginMarketNavigation"', '"./pluginMarketNavigation.mjs"').replace('"./ztoolsImportSelection"', '"./ztoolsImportSelection.mjs"'));

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
      source_type: "directory",
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
      source_type: "zpx",
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
      source_type: "asar",
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
      ["/plugins/bad", "blocked", "本地版本不支持当前系统", false, false],
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
  assert.equal(view.rows[0].subtitle, "ok-plugin · 1.2.3 · 目录 · 3 指令");
  assert.equal(view.rows[1].title, "warn-plugin");
  assert.equal(view.rows[1].subtitle, "warn-plugin · 0.0.0 · ZPX · 2 指令");
  assert.deepEqual(view.rows[1].missingFlags, ["缺少 preload", "缺少图标", "未支持 regex"]);
  assert.deepEqual(view.rows[1].messages, ["preload.js 不存在", "存在暂不支持的 cmd type: regex"]);
  assert.deepEqual(view.rows[2].missingFlags, ["平台不匹配", "缺少入口", "缺少 preload", "缺少图标"]);
  assert.deepEqual(view.rows[2].messages, ["缺少图标", "main 入口不存在"]);

  const sourcePackage = {
    ...candidates[0],
    path: "/plugins/source",
    name: "manifest-source-name",
    title: "不同的中文标题",
    entry_readiness: "requires_build",
  };
  const sourceRow = mod.ztoolsImportView([sourcePackage], new Set([sourcePackage.path])).rows[0];
  assert.equal(sourceRow.readiness, "requires_build");
  assert.equal(sourceRow.selectable, false);
  assert.equal(sourceRow.selected, false);
  assert.equal(sourceRow.statusLabel, "需要发布版");
  assert.deepEqual(sourceRow.marketRequest, { source: "official_ztools", pluginName: "manifest-source-name" });
  const sameInstallArchive = { ...sourcePackage, path: "/plugins/source/plugin.zpx", source_type: "zpx", entry_readiness: "ready", version: "0.9.0", installation_id: "source-install" };
  const sourceChoiceView = mod.ztoolsImportView([{ ...sourcePackage, installation_id: "source-install" }, sameInstallArchive], new Set());
  assert.equal(sourceChoiceView.sourceChoiceCount, 1);
  assert.equal(sourceChoiceView.pendingSourceChoices, 1);
  assert.match(sourceChoiceView.rows[0].readinessMessage, /已有可导入的安装包/);
  assert.equal(sourceChoiceView.rows[1].selected, false);
  assert.match(sourceChoiceView.rows[1].subtitle, /0\.9\.0 · ZPX/);
  const invalidNameRow = mod.ztoolsImportView([{ ...sourcePackage, name: "  " }], new Set()).rows[0];
  assert.equal(invalidNameRow.marketRequest, null);
  const incompleteDirectory = {
    ...candidates[0], path: "/plugins/incomplete-source", entry_readiness: "incomplete",
    main_exists: false, errors: ["main 入口不存在"],
  };
  const incompleteDirectoryRow = mod.ztoolsImportView([incompleteDirectory], new Set([incompleteDirectory.path])).rows[0];
  assert.equal(incompleteDirectoryRow.status, "blocked");
  assert.equal(incompleteDirectoryRow.statusLabel, "不可直接导入");
  assert.equal(incompleteDirectoryRow.selectable, false);
  assert.equal(incompleteDirectoryRow.selected, false);
  assert.equal(incompleteDirectoryRow.sourceBuildCheckable, true);
  assert.equal(incompleteDirectoryRow.readinessMessage, "此目录不能直接导入；可检查本机是否支持从源码转换。");
  assert.deepEqual(incompleteDirectoryRow.missingFlags, ["缺少入口"]);
  assert.deepEqual(incompleteDirectoryRow.messages, ["main 入口不存在"]);

  const incompleteArchiveRow = mod.ztoolsImportView([{
    ...incompleteDirectory, path: "/plugins/incomplete-source.zpx", source_type: "zpx",
  }], new Set()).rows[0];
  assert.equal(incompleteArchiveRow.statusLabel, "不可导入");
  assert.equal(incompleteArchiveRow.sourceBuildCheckable, false);
  assert.equal(incompleteArchiveRow.readinessMessage, null);

  const unsupportedIncompleteRow = mod.ztoolsImportView([{
    ...incompleteDirectory, path: "/plugins/unsupported-source", platform_supported: false,
  }], new Set()).rows[0];
  assert.equal(unsupportedIncompleteRow.statusLabel, "本地版本不支持当前系统");
  assert.equal(unsupportedIncompleteRow.sourceBuildCheckable, false);
  assert.match(unsupportedIncompleteRow.readinessMessage, /官方发布版/);

  const headlessIncompleteRow = mod.ztoolsImportView([{
    ...incompleteDirectory, path: "/plugins/headless-source", headless: true,
  }], new Set()).rows[0];
  assert.equal(headlessIncompleteRow.statusLabel, "不可导入");
  assert.equal(headlessIncompleteRow.sourceBuildCheckable, false);
  assert.equal(headlessIncompleteRow.readinessMessage, null);

  const unrelatedBlockedRow = mod.ztoolsImportView([{ ...sourcePackage, entry_readiness: "incomplete", errors: ["incomplete"] }], new Set()).rows[0];
  assert.equal(unrelatedBlockedRow.marketRequest, null);

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

  const [uiState, appShell, primarySurface, resultsSurface, navigationController, systemPanel, importPanel, candidateRow, importTypes, nativeImporter, nativeRegistry, nativeCargo, importController, importResults, nativeArchive, nativeArchiveTests, pluginTypes] = await Promise.all([
    readFile(new URL("src/lib/uiState.ts", root), "utf8"),
    readFile(new URL("src/App.svelte", root), "utf8"),
    readFile(new URL("src/components/LauncherPrimarySurface.svelte", root), "utf8"),
    readFile(new URL("src/components/LauncherResultsSurface.svelte", root), "utf8"),
    readFile(new URL("src/lib/launcherNavigationController.ts", root), "utf8"),
    readFile(new URL("src/components/SystemPanel.svelte", root), "utf8"),
    readFile(new URL("src/components/ZToolsImportPanel.svelte", root), "utf8"),
    readFile(new URL("src/components/ZToolsImportCandidateRow.svelte", root), "utf8"),
    readFile(new URL("src/lib/types.ts", root), "utf8"),
    readFile(new URL("src-tauri/src/ztools_import.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/command_registry.rs", root), "utf8"),
    readFile(new URL("src-tauri/Cargo.toml", root), "utf8"),
    readFile(new URL("src/lib/ztoolsImportController.ts", root), "utf8"),
    readFile(new URL("src/components/ZToolsImportResults.svelte", root), "utf8"),
    readFile(new URL("src-tauri/src/ztools_import/archive.rs", root), "utf8"),
    readFile(new URL("src-tauri/src/ztools_import/archive_tests.rs", root), "utf8"),
    readFile(new URL("src/lib/pluginTypes.ts", root), "utf8"),
  ]);
  assert.match(uiState, /id: "import", label: "导入 ZTools 插件"[\s\S]*aliases: \["import", "ztools"\]/);
  assert.doesNotMatch(appShell, /home:import-ztools/);
  assert.match(appShell, /import LauncherPrimarySurface from "\.\/components\/LauncherPrimarySurface\.svelte";/);
  assert.match(appShell, /const \{ onEscape,[\s\S]*onHomePanelChange,[\s\S]*\} = navigationController;/);
  assert.match(appShell, /<LauncherPrimarySurface[\s\S]*resultsSurface=\{\{[\s\S]*onHomeCommand, onHomePanelChange, onRecentSelectionChange,[\s\S]*\}\}/);
  assert.match(primarySurface, /import LauncherResultsSurface[\s\S]*from "\.\/LauncherResultsSurface\.svelte";/);
  assert.match(primarySurface, /<LauncherResultsSurface \{\.\.\.resultsSurface\} \/>/);
  assert.match(primarySurface, /await import\("\.\/SystemPanel\.svelte"\)[\s\S]*<SystemPanel panel=\{activePanel\}[\s\S]*onpanelchange=\{onPanelChange\}/);
  assert.match(resultsSurface, /import HomePanel from "\.\/HomePanel\.svelte";/);
  assert.match(resultsSurface, /<HomePanel[\s\S]*onpanelchange=\{onHomePanelChange\}/);
  assert.match(navigationController, /async function onHomePanelChange\(panel: ShellPanel\) \{[\s\S]*await onPanelChange\(panel\);[\s\S]*\}/);
  assert.match(systemPanel, /import ZToolsImportPanel from "\.\/ZToolsImportPanel\.svelte";/);
  assert.match(systemPanel, /\{:else if panel === "import"\}[\s\S]*<ZToolsImportPanel \{onmarketrequest\} \/>/);
  assert.match(importPanel, /import \{ open \} from "@tauri-apps\/plugin-dialog";/);
  assert.match(importPanel, /chooseDirectory: async \(\) => selectedPath\(await open\(\{ directory: true, multiple: false \}\)\)/);
  assert.match(importPanel, /return typeof result === "string" \? result : null;/);
  assert.match(importPanel, /scanPath: path => invoke<ZToolsImportCandidate\[]>\("scan_ztools_plugins", \{ root: path \}\)/);
  assert.match(importController, /let selected = selectUnambiguousImportSources\(candidates\);/);
  assert.match(importController, /if \(this\.selectionSession\?\.has\(root\)\) \{[\s\S]*selected = this\.selectionSession\.restore\(root, candidates, installed\);/);
  assert.match(importController, /this\.state = \{\s*candidates,\s*selected,/);
  assert.match(importController, /report: null/);
  assert.match(importPanel, /invoke<ZToolsImportCandidate\[]>\("scan_default_ztools_plugins"\)/);
  assert.match(importPanel, /onMount\(\(\) => \{[\s\S]*void controller\.scanDefault\(\);[\s\S]*controller\.dispose\(\)/);
  assert.match(importPanel, /extensions: \["zpx", "asar", "zip"\]/);
  assert.match(pluginTypes, /source_type: "directory" \| "zpx" \| "asar" \| "zip";/);
  assert.match(pluginTypes, /installation_id\?: string \| null;/);
  assert.match(pluginTypes, /installation_key\?: string \| null;/);
  assert.match(importTypes, /export type \{\s*InstalledPlugin,\s*PluginProviderDescriptor,\s*ZToolsImportCandidate,\s*ZToolsImportFailure,\s*ZToolsImportReport,\s*\} from "\.\/pluginTypes";/);
  assert.ok(importTypes.split("\n").length <= 500, "shared types should stay below the file-size boundary");
  assert.match(nativeRegistry, /commands::scan_default_ztools_plugins/);
  assert.match(nativeImporter, /home\.join\("\.ztools"\)\.join\("plugins"\)/);
  assert.match(nativeImporter, /MAX_ARCHIVE_BYTES: u64 = 64 \* 1024 \* 1024/);
  assert.match(nativeImporter, /MAX_ARCHIVE_ENTRIES: usize = 4096/);
  assert.match(nativeArchive, /flate2::read::GzDecoder/);
  assert.match(nativeArchive, /brotli::Decompressor/);
  assert.match(nativeArchive, /ASAR symbolic links are not supported/);
  assert.match(nativeArchiveTests, /scans_gzip_and_brotli_zpx_plugins/);
  assert.match(nativeCargo, /brotli = "8"/);
  assert.match(nativeCargo, /flate2 = "1"/);
  assert.doesNotMatch(nativeCargo, /^asar\s*=/m);
  assert.match(importPanel, /等待扫描/);
  assert.match(importPanel, /扫描 ZTools/);
  assert.match(importPanel, /选择目录/);
  assert.match(importPanel, /选择插件包/);
  assert.match(importPanel, /onclick=\{chooseDirectory\}/);
  assert.match(importPanel, /onclick=\{chooseArchive\}/);
  assert.doesNotMatch(importPanel, /onMount\(\(\)\s*=>\s*chooseDirectory/);
  assert.match(importPanel, /\{#if importState\.candidates\.length > 0\}[\s\S]*class="candidate-summary"[\s\S]*class="candidate-list"[\s\S]*class="import-actions[\s\S]*\{:else\}[\s\S]*class="empty-import-state"/);
  assert.match(importPanel, /class=\{`summary-chip \$\{chip\.tone\}`\}/);
  assert.match(importPanel, /<ZToolsImportCandidateRow[\s\S]*disabled=\{busy\}[\s\S]*\{onmarketrequest\}/);
  assert.match(candidateRow, /class=\{`status-pill \$\{row\.status\}`\}/);
  assert.match(candidateRow, /class="flag-list"/);
  assert.match(candidateRow, /class="message-list"/);
  assert.match(candidateRow, /disabled=\{disabled \|\| !row\.selectable\}/);
  assert.match(candidateRow, /在官方市场查找发布版/);
  assert.match(candidateRow, /row\.marketRequest && onmarketrequest/);
  assert.match(candidateRow, /type="button"/);
  assert.match(candidateRow, /<label[\s\S]*for=\{`ztools-import-\$\{encodeURIComponent\(row\.path\)\}`\}[\s\S]*<\/label>[\s\S]*<button/);
  assert.match(candidateRow, /\.market-recovery:active:not\(:disabled\)/);
  assert.doesNotMatch(candidateRow, /\.candidate-row\.blocked\s*\{\s*opacity/);
  assert.match(candidateRow, /readiness-message/);
  assert.match(importPanel, /onclick=\{\(\) => controller\.selectAll\(\)\}/);
  assert.match(importPanel, /onclick=\{\(\) => controller\.clearSelection\(\)\}/);
  assert.match(importPanel, /选择无冲突来源/);
  assert.match(importPanel, /清空选择/);
  assert.match(importPanel, /`导入 \$\{importView\.summary\.selected\} 个插件`/);
  assert.match(importPanel, /<ZToolsImportResults[\s\S]*report=\{importState\.report\}/);
  assert.match(importResults, /\{#if reportView\}[\s\S]*class="report"/);
  assert.match(importResults, /<strong>导入报告<\/strong>/);
  assert.match(importResults, /成功 \{reportView\.summary\.imported\} 个，跳过 \{reportView\.summary\.skipped\} 个，失败 \{reportView\.summary\.failed\} 个。/);
  assert.match(importResults, /class=\{`report-row \$\{row\.kind\}`\}/);
  assert.match(importResults, /<strong>\{row\.kind === "imported"[\s\S]*: row\.detail\}<\/strong>/);
  assert.match(importResults, /<small>\{row\.path\}<\/small>/);

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
