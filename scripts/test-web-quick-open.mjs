import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-web-quick-open-"));
const outFile = join(outDir, "webQuickOpen.mjs");

try {
  const matchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const matchSource = await readFile(matchSourcePath, "utf8");
  const transformedMatch = await transformWithEsbuild(matchSource, matchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedMatch.code);

  const sourcePath = new URL("src/lib/webQuickOpen.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));

  const mod = await import(pathToFileURL(outFile).href);

  const entries = mod.normalizeWebQuickOpenEntries([
    { id: "g", name: " Google ", keyword: " g ", template: " https://google.com/search?q={query} ", enabled: true },
    { id: "bad", name: "", keyword: "", template: "", enabled: true },
    { id: "gh", name: "GitHub", keyword: "gh", template: "https://github.com/search?q={query}", enabled: true },
    { id: "off", name: "Disabled", keyword: "off", template: "https://example.com?q={query}", enabled: false },
  ]);

  assert.equal(entries.length, 3);
  assert.equal(entries[0].name, "Google");
  assert.equal(entries[0].keyword, "g");
  assert.equal(entries[0].template, "https://google.com/search?q={query}");

  assert.equal(
    mod.buildWebQuickOpenUrl(entries[0], "svelte tauri"),
    "https://google.com/search?q=svelte%20tauri",
  );

  assert.equal(mod.webQuickOpenResultsForQuery("g rust", entries)[0]?.label, "Google 搜索 rust");
  assert.equal(mod.webQuickOpenResultsForQuery("off rust", entries).length, 0);
  assert.equal(mod.webQuickOpenResultsForQuery("google", entries)[0]?.code, "web:g");
  assert.equal(mod.webQuickOpenResultsForQuery("hub", entries)[0]?.code, "web:gh");
  assert.equal(mod.webQuickOpenResultsForQuery("gub", entries)[0]?.match_type, "fuzzy");
  assert.equal(mod.validateWebQuickOpenEntry(entries[0]), "");
  assert.equal(mod.validateWebQuickOpenEntry({ name: "", keyword: "x", template: "https://example.com" }), "名称不能为空");
  assert.equal(mod.validateWebQuickOpenEntry({ name: "Bad", keyword: "bad key", template: "https://example.com" }), "关键字不能包含空格");
  assert.equal(mod.validateWebQuickOpenEntry({ name: "Bad", keyword: "bad", template: "not-a-url" }), "请输入有效的 URL 模板");
  assert.equal(mod.validateWebQuickOpenEntry({ name: "Bad", keyword: "bad", template: "ftp://example.com" }), "URL 只支持 http 或 https");

  const created = mod.createWebQuickOpenEntry();
  assert.ok(created.id.startsWith("web-"));
  assert.equal(created.enabled, true);

  await writeFile(join(outDir, "passed"), "ok");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
