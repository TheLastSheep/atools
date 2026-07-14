import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-home-recent-type-icons-"));
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

  assert.equal(mod.homeCommandFallbackIcon(command({ code: "system:settings", panel: "settings" })), "system");
  assert.equal(mod.homeCommandFallbackIcon(command({ code: "local:downloads" })), "folder");
  assert.equal(mod.homeCommandFallbackIcon(command({ code: "local-app:/Applications/Terminal.app" })), "app");
  assert.equal(mod.homeCommandFallbackIcon(command({ code: "web:github" })), "web");
  assert.equal(mod.homeCommandFallbackIcon(command({ code: "url:https%3A%2F%2Fexample.com" })), "link");
  assert.equal(mod.homeCommandFallbackIcon(command({ code: "图片批处理" })), "plugin");

  const homePanel = await readFile(new URL("src/components/HomePanel.svelte", root), "utf8");
  assert.match(homePanel, /import ResultTypeIcon from "\.\/ResultTypeIcon\.svelte";/);
  assert.match(homePanel, /homeCommandFallbackIcon/);
  assert.match(homePanel, /<ResultTypeIcon icon=\{homeCommandFallbackIcon\(cmd\)\}/);
  assert.doesNotMatch(homePanel, /\{iconLabel\(cmd\.label\)\}/);
  assert.doesNotMatch(homePanel, /function iconLabel/);
  assert.match(homePanel, /\.recent-icon\s*\{[\s\S]*?width:\s*38px;[\s\S]*?height:\s*38px;/);

  assertSmokeChecked(
    "最近使用磁贴显示来源类型 SVG 图标，不显示命令标题首字 fallback；图标外层约 38px，且网格无横向溢出。",
    "macOS smoke checklist should mark Home recent type icons complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}

function command(overrides) {
  return {
    code: "图片批处理",
    label: "图片批处理",
    explain: "批量压缩、转换和处理图片",
    source: "recommended",
    ...overrides,
  };
}
