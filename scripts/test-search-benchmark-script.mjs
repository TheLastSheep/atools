import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const scriptUrl = pathToFileURL(new URL("benchmark-search-index.mjs", import.meta.url).pathname).href;
const benchmark = await import(scriptUrl);

const output = [
  "warmup",
  'ATOOLS_SEARCH_BENCHMARK {"status":"ok","datasets":{"aliases":10,"local_launch":10,"web_quick_open":10},"summary":{"total_cases":3,"max_duration_ms":2.4,"threshold_ms":50},"cases":[{"name":"alias_exact","query":"alias7","result_count":1,"duration_ms":0.8}]}',
  "done",
].join("\n");

const parsed = benchmark.parseBenchmarkOutput(output);
assert.equal(parsed.status, "ok");
assert.equal(parsed.datasets.aliases, 10);
assert.equal(parsed.summary.total_cases, 3);
assert.equal(parsed.cases[0].name, "alias_exact");
assert.throws(() => benchmark.parseBenchmarkOutput("missing"), /Missing ATOOLS_SEARCH_BENCHMARK/);
assert.equal(benchmark.percentile([1, 2, 3, 4], 50), 2);
assert.equal(benchmark.percentile([1, 2, 3, 4], 95), 4);
assert.throws(() => benchmark.percentile([], 50), /empty sample/);
await assert.rejects(() => benchmark.runSearchBenchmark({ scales: [] }), /positive benchmark scale/);

const fixture = await benchmark.runSearchBenchmark({
  scales: [12, 18],
  iterations: 3,
  warmupIterations: 1,
  thresholdMs: 100,
  timestamp: "2026-06-02T00:00:00.000Z",
});

assert.equal(fixture.status, "ok");
assert.equal(fixture.schema_version, 2);
assert.equal(fixture.timestamp, "2026-06-02T00:00:00.000Z");
assert.deepEqual(fixture.config.scales, [12, 18]);
assert.equal(fixture.config.warmup_iterations, 1);
assert.equal(fixture.runs[0].datasets.aliases, 12);
assert.equal(fixture.runs[0].datasets.local_launch, 12);
assert.equal(fixture.runs[0].datasets.web_quick_open, 12);
assert.equal(fixture.runs[1].datasets.total_records, 54);
assert.equal(fixture.summary.total_cases, fixture.runs.flatMap((run) => run.cases).length);
assert.ok(fixture.summary.worst_p99_ms >= 0);
assert.ok(fixture.summary.threshold_ms === 100);
assert.ok(fixture.runs.every((run) => run.summary.worst_p95_ms >= run.summary.worst_p50_ms));
assert.ok(fixture.runs.every((run) => run.summary.worst_p99_ms >= run.summary.worst_p95_ms));
const fixtureCases = fixture.runs.flatMap((run) => run.cases);
assert.ok(fixtureCases.length >= 8);
assert.ok(fixtureCases.every((item) => typeof item.name === "string" && item.p50_ms >= 0));
assert.ok(fixtureCases.every((item) => item.p95_ms >= item.p50_ms && item.p99_ms >= item.p95_ms));
assert.ok(fixtureCases.every((item) => item.samples === 3));
assert.ok(fixtureCases.every((item) => Number.isInteger(item.result_count) && item.result_count >= 0));
