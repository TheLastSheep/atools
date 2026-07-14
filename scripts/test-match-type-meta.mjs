import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-match-type-meta-"));
const outFile = join(outDir, "types.mjs");

try {
  const sourcePath = new URL("src/lib/types.ts", root).pathname;
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

  assert.equal(mod.MATCH_TYPE_META.alias.label, "别名");
  assert.equal(mod.MATCH_TYPE_META.alias.tone, "alias");
  assert.equal(mod.MATCH_TYPE_META.fuzzy.label, "模糊");
  assert.equal(mod.MATCH_TYPE_META.fuzzy.tone, "fuzzy");

  assertSmokeChecked(
    "搜索结果匹配标签带有类型 tone，`精确/前缀/包含`、`别名`、`拼音`、`模糊`、`待处理` 视觉上可区分。",
    "macOS smoke checklist should mark match tag tone coverage complete",
  );
} finally {
  await rm(outDir, { recursive: true, force: true });
}
