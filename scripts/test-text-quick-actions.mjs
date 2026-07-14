import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(tmpdir(), "atools-text-quick-actions-"));
const outFile = join(outDir, "textQuickActions.mjs");

try {
  const sourcePath = new URL("src/lib/textQuickActions.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  const jsonResults = mod.textQuickActionResultsForQuery('{"name":"ATools","enabled":true}');
  assert.equal(jsonResults.length, 1);
  assert.equal(jsonResults[0].label, "复制格式化 JSON");
  assert.equal(jsonResults[0].plugin_id, "text-quick-actions");
  assert.equal(jsonResults[0].match_type, "exact");
  assert.equal(
    mod.payloadFromTextQuickActionCode(jsonResults[0].code).output,
    '{\n  "name": "ATools",\n  "enabled": true\n}',
  );

  const colorResults = mod.textQuickActionResultsForQuery("#7c3aed");
  assert.equal(colorResults.length, 1);
  assert.deepEqual(
    {
      label: colorResults[0].label,
      explain: colorResults[0].explain,
      output: mod.payloadFromTextQuickActionCode(colorResults[0].code).output,
    },
    {
      label: "复制颜色 #7C3AED",
      explain: "RGB 124, 58, 237",
      output: "#7C3AED",
    },
  );

  const timestampResults = mod.textQuickActionResultsForQuery("1717243200");
  assert.equal(timestampResults.length, 1);
  assert.equal(timestampResults[0].label, "复制时间 2024-06-01T12:00:00.000Z");
  assert.equal(mod.payloadFromTextQuickActionCode(timestampResults[0].code).output, "2024-06-01T12:00:00.000Z");

  const pathResults = mod.textQuickActionResultsForQuery("~/Desktop/invoice.pdf");
  assert.deepEqual(pathResults.map((result) => result.label), [
    "打开路径 ~/Desktop/invoice.pdf",
    "在 Finder 中显示 ~/Desktop/invoice.pdf",
  ]);
  assert.deepEqual(mod.payloadFromTextQuickActionCode(pathResults[0].code), {
    kind: "path-open",
    output: "~/Desktop/invoice.pdf",
  });
  assert.deepEqual(mod.payloadFromTextQuickActionCode(pathResults[1].code), {
    kind: "path-reveal",
    output: "~/Desktop/invoice.pdf",
  });

  assert.deepEqual(mod.textQuickActionResultsForQuery("hello world"), []);
  assert.deepEqual(mod.textQuickActionResultsForQuery("example.com/docs"), []);
  assert.deepEqual(mod.payloadFromTextQuickActionCode("web:google"), null);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
