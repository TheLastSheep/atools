import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-result-type-icons-"));
const outFile = join(outDir, "resultIcons.mjs");
const typesOutFile = join(outDir, "types.mjs");

try {
  const sourcePath = new URL("src/lib/resultIcons.ts", root).pathname;
  const typesPath = new URL("src/lib/types.ts", root).pathname;
  const [source, typesSource] = await Promise.all([
    readFile(sourcePath, "utf8"),
    readFile(typesPath, "utf8"),
  ]);
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  const typesTransformed = await transformWithEsbuild(typesSource, typesPath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(typesOutFile, typesTransformed.code);
  await writeFile(outFile, transformed.code.replaceAll('from "./types";', 'from "./types.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);
  const smokeChecklist = await readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8");
  const assertSmokeChecked = (row, message) => {
    assert.ok(smokeChecklist.includes(`- [x] ${row}`), message);
  };

  assert.equal(mod.resultFallbackIcon(searchResult({ code: "system:settings", plugin_id: "system" })), "system");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "local-app:/Applications/Terminal.app", plugin_id: "local-app" })), "app");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "local:downloads", plugin_id: "local-launch" })), "folder");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "web:github", plugin_id: "web-quick-open" })), "web");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "url:https%3A%2F%2Fexample.com", plugin_id: "url-quick-open" })), "link");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "text:%7B%7D", plugin_id: "text-quick-actions" })), "text");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "paste:ocr:paste-1", plugin_id: "paste" })), "paste");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "history:%7B%7D", plugin_id: "history" })), "history");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "alias:%7B%7D", plugin_id: "command-alias" })), "alias");
  assert.equal(mod.resultFallbackIcon(searchResult({ code: "plugin:demo", plugin_id: "plugin" })), "plugin");

  const [resultsList, iconComponent] = await Promise.all([
    readFile(new URL("src/components/ResultsList.svelte", root), "utf8"),
    readFile(new URL("src/components/ResultTypeIcon.svelte", root), "utf8"),
  ]);

  assert.match(resultsList, /import ResultTypeIcon from "\.\/ResultTypeIcon\.svelte";/);
  assert.match(resultsList, /resultFallbackIcon/);
  assert.match(resultsList, /<ResultTypeIcon icon=\{resultFallbackIcon\(item\.result\)\}/);
  assert.doesNotMatch(resultsList, /class="icon-letter"/);

  for (const icon of ["system", "app", "folder", "web", "link", "text", "paste", "history", "alias", "plugin"]) {
    assert.match(iconComponent, new RegExp(`icon === "${icon}"`));
  }
  assert.match(iconComponent, /<svg[\s\S]*?aria-hidden="true"/);
  assert.match(iconComponent, /\.result-type-icon\s*\{[\s\S]*?width:\s*30px;[\s\S]*?height:\s*30px;/);

  assertSmokeChecked(
    "没有真实应用图标的内置搜索结果显示来源类型 SVG 图标，不显示标题首字 fallback；真实本地应用结果仍显示应用图标。",
    "macOS smoke checklist should mark search result fallback icons complete",
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
