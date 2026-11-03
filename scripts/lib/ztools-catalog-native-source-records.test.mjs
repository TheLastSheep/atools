import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { captureRendererHostSources } from "./ztools-renderer-host-sources.mjs";
import { assertCatalogNativeSourceRecords } from "./ztools-catalog-native-source-records.mjs";

const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const packageRoot = join(root, "packages/ztools-renderer");
const records = await captureRendererHostSources(packageRoot);
const provenance = JSON.parse(await readFile(join(packageRoot, "dist/build-provenance.json"), "utf8"));

test("accepts the current formal 43-source list, including its canonical MJS records", () => {
  assert.equal(records.length, 43);
  assert.deepEqual(records.filter(record => record.path.endsWith(".mjs")).map(record => record.path), [
    "src/builtinShortcutsCompatibility.mjs",
    "src/mainDropCompatibility.mjs",
    "upstream-compatibility-patches.mjs",
  ]);
  assert.doesNotThrow(() => assertCatalogNativeSourceRecords(records, provenance.hostAdapterSources));
});

test("rejects unknown suffixes, noncanonical paths, duplicates, and malformed source records", () => {
  const mutations = [
    list => { list[0].path = list[0].path.replace(/\.(?:ts|mjs)$/, ".js"); },
    list => { list[0].path = "src/unknown.mjs"; },
    list => { list[1].path = list[0].path; },
    list => { list[0].bytes = 0; },
    list => { list[0].bytes = 1.5; },
    list => { list[0].bytes = Number.MAX_SAFE_INTEGER + 1; },
    list => { list[0].sha256 = `${list[0].sha256[0] === "0" ? "1" : "0"}${list[0].sha256.slice(1)}`; },
    list => { list[0].sha256 = "g".repeat(64); },
    list => { delete list[0].bytes; },
    list => { list[0].extra = true; },
  ];
  for (const mutate of mutations) {
    const changed = structuredClone(records);
    mutate(changed);
    assert.throws(() => assertCatalogNativeSourceRecords(changed, provenance.hostAdapterSources), {
      code: "ERR_ASSERTION",
    });
  }
  assert.throws(() => assertCatalogNativeSourceRecords([], provenance.hostAdapterSources), /between 1 and 64/);
  assert.throws(() => assertCatalogNativeSourceRecords(Array(65).fill(records[0]), provenance.hostAdapterSources), /between 1 and 64/);
});
