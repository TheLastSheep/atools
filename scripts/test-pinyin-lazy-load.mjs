import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-pinyin-lazy-load-"));

try {
  const searchSourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const searchSource = await readFile(searchSourcePath, "utf8");
  assert.equal(searchSource.includes('from "pinyin-pro"'), false, "searchMatch.ts must not statically import pinyin-pro");
  assert.equal(searchSource.includes("from 'pinyin-pro'"), false, "searchMatch.ts must not statically import pinyin-pro");

  const transformedSearch = await transformWithEsbuild(searchSource, searchSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(join(outDir, "searchMatch.mjs"), transformedSearch.code);

  const pinyinSourcePath = new URL("src/lib/pinyinSearch.ts", root).pathname;
  const pinyinSource = await readFile(pinyinSourcePath, "utf8");
  assert.equal(pinyinSource.includes('import("pinyin-pro")'), true, "pinyinSearch.ts should lazy-load pinyin-pro");
  const transformedPinyin = await transformWithEsbuild(pinyinSource, pinyinSourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(
    join(outDir, "pinyinSearch.mjs"),
    transformedPinyin.code.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'),
  );

  const search = await import(pathToFileURL(join(outDir, "searchMatch.mjs")).href);
  const pinyin = await import(pathToFileURL(join(outDir, "pinyinSearch.mjs")).href);

  search.clearSearchPinyinResolver();
  assert.equal(search.searchMatchForQuery("sz", { text: "设置" }), null);

  assert.equal(await pinyin.loadSearchPinyinEngine(), true);
  assert.equal(search.searchMatchForQuery("sz", { text: "设置" })?.type, "pinyin");
  assert.equal(search.searchMatchForQuery("shezhi", { text: "设置" })?.type, "pinyin");

  assert.equal(await pinyin.loadSearchPinyinEngine(), true, "loading the pinyin engine should be idempotent");
} finally {
  await rm(outDir, { recursive: true, force: true });
}
