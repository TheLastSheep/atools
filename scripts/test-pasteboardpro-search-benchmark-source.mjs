import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [database, benchmark, workflow] = await Promise.all([
  readFile(new URL("../crates/atools-core/src/db.rs", import.meta.url), "utf8"),
  readFile(new URL("../crates/atools-core/examples/benchmark_pasteboard_search.rs", import.meta.url), "utf8"),
  readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
]);

assert.match(database, /pub fn upsert_pasteboard_items_batch/);
for (const token of ["10_000", "100_000", "50.0", "150.0", "MEASURED_RUNS", "p95_ms", "search_pasteboard_items"]) {
  assert.match(benchmark, new RegExp(token.replace(".", "\\.")));
}
assert.match(workflow, /pasteboardpro-search-performance/);
assert.match(workflow, /atools-search-performance\.json/);
console.log("PasteboardPro ATools search benchmark source verified");
