import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-result-presentation-"));
const outFile = join(outDir, "resultPresentation.mjs");
const typesOutFile = join(outDir, "types.mjs");

try {
  const sourcePath = new URL("src/lib/resultPresentation.ts", root).pathname;
  const typesSourcePath = new URL("src/lib/types.ts", root).pathname;
  const [source, typesSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(typesSourcePath, "utf8"),
  ]);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  const transformedTypes = await transformWithEsbuild(typesSource, typesSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(typesOutFile, transformedTypes.code);
  await writeFile(outFile, transformed.code.replaceAll('from "./types";', 'from "./types.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };
  const results = [
    searchResult({ code: "system:settings", plugin_id: "system", plugin_name: "ATools", label: "设置", match_type: "exact" }),
    searchResult({ code: "local-app:/Applications/Terminal.app", plugin_id: "local-app", plugin_name: "本地应用", label: "打开 Terminal", match_type: "alias" }),
    searchResult({ code: "web:github", plugin_id: "web-quick-open", plugin_name: "网页快开", label: "GitHub", match_type: "prefix" }),
    searchResult({ code: "history:%7B%7D", plugin_id: "history", plugin_name: "最近使用", label: "上次设置", match_type: "contains" }),
    searchResult({ code: "alias:%7B%7D", plugin_id: "command-alias", plugin_name: "别名", label: "cfg", match_type: "alias" }),
  ];

  assert.deepEqual(mod.groupedResultPresentation(results).map((group) => group.label), [
    "系统命令",
    "本地应用",
    "网页快开",
    "最近使用",
    "指令别名",
  ]);

  assert.equal(mod.resultSourceLabel(results[1]), "本地应用");
  assert.equal(mod.resultSourceDetail(results[1]), "local-app · 本地应用");
  assert.equal(mod.resultMatchLabel(results[4]), "别名");
  assert.equal(mod.resultShortcutHint(results[0], true), "Enter 执行");
  assert.equal(mod.resultShortcutHint(results[2], true), "Enter 打开");
  assert.equal(mod.resultShortcutHint(results[0], false), "");
  assert.equal(mod.resultShortcutHint(searchResult({
    code: textCode({ kind: "json", output: '{\n  "ok": true\n}' }),
    plugin_id: "text-quick-actions",
    plugin_name: "文本快识别",
    label: "复制格式化 JSON",
  }), true), "Enter 复制");
  assert.equal(mod.resultShortcutHint(searchResult({
    code: textCode({ kind: "path-reveal", output: "/Users/harris/Desktop" }),
    plugin_id: "text-quick-actions",
    plugin_name: "文本快识别",
    label: "在 Finder 中显示 /Users/harris/Desktop",
  }), true), "Enter 定位");
  assert.equal(mod.resultShortcutHint(searchResult({
    code: "paste:ocr:paste-1",
    plugin_id: "paste",
    plugin_name: "粘贴内容",
    label: "识别图片文字 screenshot.png",
  }), true), "Enter 处理");

  const selected = mod.resultRowPresentation(results[2], { selected: true });
  assert.equal(selected.sourceLabel, "网页快开");
  assert.equal(selected.matchLabel, "前缀");
  assert.equal(selected.matchTone, "prefix");
  assert.equal(selected.shortcutHint, "Enter 打开");
  assert.equal(selected.ariaLabel, "GitHub，网页快开，前缀匹配，Enter 打开");

  const aliasRow = mod.resultRowPresentation(results[4], { selected: true });
  assert.equal(aliasRow.matchLabel, "别名");
  assert.equal(aliasRow.matchTone, "alias");

  const unknownRow = mod.resultRowPresentation(searchResult({ match_type: "custom-score" }), { selected: true });
  assert.equal(unknownRow.matchLabel, "custom-score");
  assert.equal(unknownRow.matchTone, "unknown");

  const resultsList = await readFile(new URL("src/components/ResultsList.svelte", root), "utf8");
  assert.match(resultsList, /groupedResultPresentation\(results\)/);
  assert.match(resultsList, /item\.result\.label/);
  assert.match(resultsList, /item\.result\.explain/);
  assert.match(resultsList, /rowMeta\.sourceDetail/);
  assert.match(resultsList, /rowMeta\.matchLabel/);

  assertSmokeChecked(
    "输入 `set` 后搜索结果按来源分组，结果行显示标题、说明、来源 detail、匹配标签。",
    "macOS smoke checklist should mark grouped result metadata complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

function searchResult(overrides) {
  return {
    code: "plugin:demo",
    plugin_id: "plugin",
    plugin_name: "插件",
    label: "Demo",
    icon: null,
    explain: "Demo explain",
    score: 100,
    match_type: "exact",
    ...overrides,
  };
}

function textCode(payload) {
  return `text:${encodeURIComponent(JSON.stringify(payload))}`;
}
