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

const fixture = await benchmark.runSearchBenchmark({
  scale: 12,
  iterations: 2,
  thresholdMs: 100,
  timestamp: "2026-06-02T00:00:00.000Z",
});

assert.equal(fixture.status, "ok");
assert.equal(fixture.timestamp, "2026-06-02T00:00:00.000Z");
assert.equal(fixture.datasets.aliases, 12);
assert.equal(fixture.datasets.local_launch, 12);
assert.equal(fixture.datasets.web_quick_open, 12);
assert.equal(fixture.summary.total_cases, fixture.cases.length);
assert.ok(fixture.summary.max_duration_ms >= 0);
assert.ok(fixture.summary.threshold_ms === 100);
assert.ok(fixture.cases.length >= 4);
assert.ok(fixture.cases.every((item) => typeof item.name === "string" && item.duration_ms >= 0));
assert.ok(fixture.cases.every((item) => Number.isInteger(item.result_count) && item.result_count >= 0));
