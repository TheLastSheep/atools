import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const benchmark = await readFile(
  new URL("crates/atools-core/examples/benchmark_database.rs", root),
  "utf8",
);
const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");

const command = packageJson.scripts["benchmark:database:ci"];
assert.match(command, /cargo run -p atools-core --release --example benchmark_database/);
assert.match(command, /--scales 10000,100000/);
assert.match(command, /--iterations 30/);
assert.match(command, /--threshold-ms 80/);
assert.match(command, /--fail-on-threshold/);
assert.match(command, /artifacts\/performance\/database-growth\.json/);

assert.match(benchmark, /const PREFIX: &str = "ATOOLS_DATABASE_BENCHMARK "/);
assert.match(benchmark, /schema_version: 1/);
assert.match(benchmark, /storage_size_bytes: db\.storage_size_bytes\(\)\?/);
for (const name of [
  "list_task_runs_100",
  "get_task_run",
  "list_memory_items_100",
  "find_scoped_memory_20",
]) {
  assert.match(benchmark, new RegExp(`measure\\(\"${name}\"`));
}

assert.match(workflow, /^  database-performance-evidence:/m);
assert.match(workflow, /pnpm benchmark:database:ci/);
assert.match(workflow, /path: artifacts\/performance\/database-growth\.json/);
