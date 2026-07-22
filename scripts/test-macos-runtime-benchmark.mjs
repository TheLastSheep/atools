import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { distribution, percentile, runtimeThresholdExceeded } from "./benchmark-macos-runtime.mjs";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
const smoke = await readFile(new URL("scripts/smoke-macos-release-app.mjs", root), "utf8");
const benchmark = await readFile(new URL("scripts/benchmark-macos-runtime.mjs", root), "utf8");

assert.equal(percentile([1, 2, 3, 4], 50), 3);
assert.equal(percentile([1, 2, 3, 4], 95), 4);
assert.deepEqual(distribution([4, 1, 3, 2]), {
  samples: 4,
  p50: 3,
  p95: 4,
  p99: 4,
  min: 1,
  max: 4,
});
assert.throws(() => distribution([]), /empty sample/);

const thresholdInput = {
  metrics: {
    launch_to_first_report_ms: { p99: 900 },
    hotkey_show_ms: { p99: 220 },
    search_latency_ms: { p99: 40 },
    plugin_activation_ms: { p99: 700 },
    rss_mib: { p99: 180 },
  },
  idleSample: { rss_mib: 170 },
  app: { bundle_bytes: 80 * 1024 * 1024 },
  thresholds: {
    first_report_ms: 5000,
    hotkey_show_ms: 500,
    search_latency_ms: 150,
    plugin_activation_ms: 1500,
    rss_mib: 300,
    bundle_mib: 100,
  },
};
assert.equal(runtimeThresholdExceeded(thresholdInput), false);
assert.equal(runtimeThresholdExceeded({
  ...thresholdInput,
  metrics: { ...thresholdInput.metrics, hotkey_show_ms: { p99: 501 } },
}), true);
assert.equal(runtimeThresholdExceeded({
  ...thresholdInput,
  metrics: { ...thresholdInput.metrics, search_latency_ms: { p99: 151 } },
}), true);

assert.match(packageJson.scripts["benchmark:runtime:ci"], /--iterations 20/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--idle-sample-ms 300000/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--hotkey-threshold-ms 500/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--search-threshold-ms 150/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--plugin-activation-threshold-ms 1500/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /--fail-on-threshold/);
assert.match(packageJson.scripts["benchmark:runtime:ci"], /macos-runtime\.json/);
assert.match(workflow, /^  runtime-performance-evidence:/m);
assert.match(workflow, /createUpdaterArtifacts":false/);
assert.match(workflow, /pnpm benchmark:runtime:ci/);
assert.match(workflow, /path: artifacts\/performance\/macos-runtime\.json/);
assert.match(smoke, /launch_to_first_report_ms/);
assert.match(smoke, /rss_kib/);
assert.match(smoke, /alive_after_resource_settle/);
assert.match(benchmark, /schema_version: 5/);
assert.match(benchmark, /idle_sample: idleSample/);
assert.match(benchmark, /release_smoke_completed: true/);
assert.match(benchmark, /plugin_activation_ms/);
assert.match(benchmark, /hotkey_show_ms/);
assert.match(benchmark, /hotkey_toggle_success_count/);
assert.match(benchmark, /search_latency_ms/);
