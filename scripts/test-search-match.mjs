import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const rootPath = root.pathname;
const outDir = await mkdtemp(join(rootPath, ".tmp-search-match-"));
const outFile = join(outDir, "searchMatch.mjs");

try {
  const sourcePath = new URL("src/lib/searchMatch.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  mod.setSearchPinyinResolver((value) => {
    const map = new Map([
      ["设置", { full: "shezhi", spaced: "she zhi", initials: "sz" }],
      ["我的数据", { full: "wodeshuju", spaced: "wo de shu ju", initials: "wdsj" }],
      ["下载", { full: "xiazai", spaced: "xia zai", initials: "xz" }],
    ]);
    return map.get(value.trim()) ?? null;
  });

  assert.equal(mod.searchMatchForQuery("设置", { text: "设置", aliases: ["config"] })?.type, "exact");
  assert.equal(mod.searchMatchForQuery("set", { text: "设置", aliases: ["settings"] })?.type, "alias");
  assert.equal(mod.searchMatchForQuery("sz", { text: "设置", extraText: "打开工具设置" })?.type, "pinyin");
  assert.equal(mod.searchMatchForQuery("shezhi", { text: "设置" })?.type, "pinyin");
  assert.equal(mod.searchMatchForQuery("wdsj", { text: "我的数据" })?.type, "pinyin");
  assert.equal(mod.searchMatchForQuery("xz", { text: "下载", aliases: ["downloads"] })?.type, "pinyin");
  assert.equal(mod.searchMatchForQuery("gub", { text: "GitHub" })?.type, "fuzzy");
  assert.equal(mod.searchMatchForQuery("desk", { text: "桌面", aliases: ["desktop"] })?.type, "alias");
  assert.equal(mod.searchMatchForQuery("github", { text: "GitHub" })?.type, "exact");
  assert.equal(mod.searchMatchForQuery("git", { text: "GitHub" })?.type, "prefix");
  assert.equal(mod.searchMatchForQuery("hub", { text: "GitHub" })?.type, "contains");
  assert.equal(mod.searchMatchForQuery("zzzz", { text: "设置" }), null);
  assert.equal(mod.searchMatchForQuery("git hb extra", { text: "GitHub Extension" }), null);

  const bounded = [];
  for (const score of [10, 30, 20, 40]) mod.insertBoundedSearchResult(bounded, { score }, 3);
  assert.deepEqual(bounded.map((item) => item.score), [40, 30, 20]);

  const preparedCandidates = [
    mod.prepareSearchMatchCandidate({ text: "Project Workspace 100", extraText: "/tmp/workspace-100" }),
    mod.prepareSearchMatchCandidate({ text: "Project Workspace 99999", extraText: "/tmp/workspace-99999" }),
    mod.prepareSearchMatchCandidate({ text: "Downloads", extraText: "/tmp/downloads" }),
  ];
  const trigramIndex = mod.buildPreparedSearchTrigramIndex(preparedCandidates);
  assert.deepEqual(mod.preparedSearchCandidateIndexes("workspace 99999", trigramIndex), [1]);
  assert.deepEqual(mod.preparedSearchCandidateIndexes("never present", trigramIndex), []);
  assert.equal(mod.preparedSearchCandidateIndexes("gub", trigramIndex), null);

  const sorted = mod.sortSearchMatches([
    { id: "contains", match: mod.searchMatchForQuery("hub", { text: "GitHub" }) },
    { id: "pinyin", match: mod.searchMatchForQuery("sz", { text: "设置" }) },
    { id: "alias", match: mod.searchMatchForQuery("set", { text: "设置", aliases: ["settings"] }) },
  ]);
  assert.deepEqual(sorted.map((item) => item.id), ["alias", "pinyin", "contains"]);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
