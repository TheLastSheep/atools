import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(tmpdir(), "atools-url-quick-open-"));
const outFile = join(outDir, "urlQuickOpen.mjs");

try {
  const sourcePath = new URL("src/lib/urlQuickOpen.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(mod.normalizeUrlInput("https://example.com/a?b=c"), "https://example.com/a?b=c");
  assert.equal(mod.normalizeUrlInput("example.com/docs"), "https://example.com/docs");
  assert.equal(mod.normalizeUrlInput("localhost:1420/?parity=1"), "http://localhost:1420/?parity=1");
  assert.equal(mod.normalizeUrlInput("127.0.0.1:1420/test"), "http://127.0.0.1:1420/test");
  assert.equal(mod.normalizeUrlInput("g rust"), null);
  assert.equal(mod.normalizeUrlInput("hello world"), null);

  const results = mod.urlQuickOpenResultsForQuery("example.com/docs");
  assert.equal(results.length, 1);
  assert.deepEqual(results[0], {
    code: "url:https%3A%2F%2Fexample.com%2Fdocs",
    plugin_id: "url-quick-open",
    plugin_name: "链接快开",
    label: "打开链接 example.com/docs",
    icon: null,
    explain: "https://example.com/docs",
    score: 99,
    match_type: "exact",
  });
  assert.equal(mod.urlFromQuickOpenCode(results[0].code), "https://example.com/docs");
  assert.equal(mod.urlFromQuickOpenCode("web:google"), null);
  assert.deepEqual(mod.urlQuickOpenResultsForQuery("not a url"), []);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
