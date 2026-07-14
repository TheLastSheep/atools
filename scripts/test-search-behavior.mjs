import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const outDir = await mkdtemp(join(root.pathname, ".tmp-search-behavior-"));
const outFile = join(outDir, "searchBehavior.mjs");

try {
  const sourcePath = new URL("src/lib/searchBehavior.ts", root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  await writeFile(outFile, transformed.code);

  const mod = await import(pathToFileURL(outFile).href);

  assert.equal(mod.behaviorDelayMs("immediately"), 0);
  assert.equal(mod.behaviorDelayMs("1s"), 1000);
  assert.equal(mod.behaviorDelayMs("30s"), 30000);
  assert.equal(mod.behaviorDelayMs("3m"), 180000);
  assert.equal(mod.behaviorDelayMs("never"), null);
  assert.equal(mod.behaviorDelayMs("off"), null);
  assert.equal(mod.behaviorDelayMs("bad-value"), null);

  assert.equal(mod.autoClearDelayMs("immediately"), 0);
  assert.equal(mod.autoClearDelayMs("5m"), 300000);
  assert.equal(mod.autoClearDelayMs("never"), null);

  assert.equal(mod.autoBackToSearchDelayMs("30s"), 30000);
  assert.equal(mod.autoBackToSearchDelayMs("never"), null);

  assert.equal(mod.autoPasteDelayMs("3s"), 3000);
  assert.equal(mod.autoPasteDelayMs("off"), null);
  assert.equal(mod.autoPasteQueryCandidate({
    setting: "3s",
    now: 5_000,
    clipboardChangedAt: 3_000,
    clipboardText: "https://example.com/docs",
    currentQuery: "",
    lastAutoPastedText: "",
  }), "https://example.com/docs");
  assert.equal(mod.autoPasteQueryCandidate({
    setting: "3s",
    now: 7_001,
    clipboardChangedAt: 3_000,
    clipboardText: "expired",
    currentQuery: "",
    lastAutoPastedText: "",
  }), null);
  assert.equal(mod.autoPasteQueryCandidate({
    setting: "3s",
    now: 5_000,
    clipboardChangedAt: 3_000,
    clipboardText: "do-not-overwrite",
    currentQuery: "user typed",
    lastAutoPastedText: "",
  }), null);
  assert.equal(mod.autoPasteQueryCandidate({
    setting: "3s",
    now: 5_000,
    clipboardChangedAt: 3_000,
    clipboardText: "same",
    currentQuery: "",
    lastAutoPastedText: "same",
  }), null);

  assert.equal(mod.includeLocalLaunchSearch({ localLaunchSearch: true }), true);
  assert.equal(mod.includeLocalLaunchSearch({ localLaunchSearch: false }), false);
  assert.equal(mod.includeLocalAppSearch({ localAppSearch: true }), true);
  assert.equal(mod.includeLocalAppSearch({ localAppSearch: false }), false);
} finally {
  await rm(outDir, { recursive: true, force: true });
}
