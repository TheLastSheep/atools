import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { transformWithEsbuild } from "vite";

const beforeRoot = process.argv[2];
const beforeManifestPath = process.argv[3];
const outputPath = process.argv[4] ?? "/private/tmp/atools-batch47-candidate/performance-controlled-v1.json";
assert.ok(beforeRoot && beforeManifestPath,
  "Usage: node scripts/test-plugin-inventory-query-performance.mjs <before-source-root> <before-snapshot.json> [report.json]");
const root = resolve(new URL("../", import.meta.url).pathname);
const temp = await mkdtemp(join(root, ".tmp-plugin-inventory-query-perf-"));
const queries = [
  ["feature-code", "feature-7-042"],
  ["feature-label", "功能名称 7-042"],
  ["feature-explain", "单功能解释-7-042"],
  ["metadata", "插件标题 7"],
  ["ambiguous", "功能名称"],
  ["no-match", "query-no-match-b47"],
];
const fixture = Array.from({ length: 12 }, (_, pluginIndex) => ({
  id: `fixture-plugin-${String(pluginIndex).padStart(2, "0")}`,
  source_kind: "imported",
  name: `合成插件 ${String(pluginIndex).padStart(2, "0")}`,
  version: "1.0.0",
  path: `/fixture/plugins/${pluginIndex}`,
  enabled: true,
  manifest: {
    title: `插件标题 ${pluginIndex}`,
    description: `插件说明 ${pluginIndex}`,
    features: Array.from({ length: 100 }, (_, featureIndex) => {
      const suffix = `${pluginIndex}-${String(featureIndex).padStart(3, "0")}`;
      return { code: `feature-${suffix}`, label: `功能名称 ${suffix}`, explain: `单功能解释-${suffix}` };
    }),
  },
}));
const sha = data => createHash("sha256").update(data).digest("hex");
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.max(0, Math.ceil(fraction * samples.length) - 1)];

async function compileInventory(sourcePath, destination, importHelperPath = null) {
  const source = await readFile(sourcePath);
  const transformed = await transformWithEsbuild(source.toString(), sourcePath, { format: "esm", target: "esnext", loader: "ts" });
  const code = importHelperPath
    ? transformed.code.replaceAll('from "./pluginInventoryFeatureSearch"', `from "${importHelperPath}"`)
    : transformed.code;
  await writeFile(destination, code);
  return { source, transformed: Buffer.from(code) };
}

try {
  const baselineManifest = JSON.parse(await readFile(beforeManifestPath, "utf8"));
  const baselineEntry = baselineManifest.files?.find(item => item.path === "src/lib/pluginInventory.ts");
  assert.ok(baselineEntry?.sha256, "Before snapshot must bind the inventory source SHA");
  const beforeInventoryPath = join(resolve(beforeRoot), "src/lib/pluginInventory.ts");
  const candidateInventoryPath = join(root, "src/lib/pluginInventory.ts");
  const candidateHelperPath = join(root, "src/lib/pluginInventoryFeatureSearch.ts");
  const beforeSource = await readFile(beforeInventoryPath);
  assert.equal(sha(beforeSource), baselineEntry.sha256, "Before source must exactly match the saved B47 snapshot");

  const helperSource = await readFile(candidateHelperPath);
  const helperModule = await transformWithEsbuild(helperSource.toString(), candidateHelperPath, { format: "esm", target: "esnext", loader: "ts" });
  await writeFile(join(temp, "pluginInventoryFeatureSearch.mjs"), helperModule.code);
  const [beforeModules, candidateModules] = await Promise.all([
    compileInventory(beforeInventoryPath, join(temp, "before.mjs")),
    compileInventory(candidateInventoryPath, join(temp, "candidate.mjs"), "./pluginInventoryFeatureSearch.mjs"),
  ]);
  const beforeMod = await import(`${pathToFileURL(join(temp, "before.mjs")).href}?before=${Date.now()}`);
  const candidateMod = await import(`${pathToFileURL(join(temp, "candidate.mjs")).href}?candidate=${Date.now()}`);
  assert.equal(typeof beforeMod.pluginInventory, "function");
  assert.equal(typeof candidateMod.pluginInventory, "function");

  const raw = new Map(queries.map(([queryClass]) => [queryClass, { baseline: [], candidate: [] }]));
  for (const [queryClass, query] of queries) {
    for (let sample = 0; sample < 5; sample += 1) {
      beforeMod.pluginInventory(fixture, { query }); candidateMod.pluginInventory(fixture, { query });
    }
    // Interleave source order for every sample to reduce warmup/thermal bias.
    for (let sample = 0; sample < 60; sample += 1) {
      const runCandidateFirst = sample % 2 === 1;
      for (const candidateFirst of [runCandidateFirst, !runCandidateFirst]) {
        const start = performance.now();
        (candidateFirst ? candidateMod : beforeMod).pluginInventory(fixture, { query });
        raw.get(queryClass)[candidateFirst ? "candidate" : "baseline"].push(Number((performance.now() - start).toFixed(6)));
      }
    }
  }

  const measurements = queries.map(([queryClass, query]) => {
    const sample = raw.get(queryClass);
    return {
      queryClass, query,
      baselineMs: sample.baseline,
      candidateMs: sample.candidate,
      baselineP50Ms: percentile(sample.baseline, 0.5), baselineP95Ms: percentile(sample.baseline, 0.95), baselineP99Ms: percentile(sample.baseline, 0.99),
      candidateP50Ms: percentile(sample.candidate, 0.5), candidateP95Ms: percentile(sample.candidate, 0.95), candidateP99Ms: percentile(sample.candidate, 0.99),
    };
  });
  const worstCandidateP95Ms = Math.max(...measurements.map(item => item.candidateP95Ms));
  const self = await readFile(new URL(import.meta.url));
  const report = {
    schemaVersion: 1,
    kind: "controlled-pure-inventory-derive-comparison",
    scope: "Pure pluginInventory catalogue/query derive only; not OS keystroke latency, native UI, matcher, or end-to-end plugin activation.",
    earlierBaseline: {
      path: "/private/tmp/atools-batch47-candidate/performance-baseline-v1.json",
      binding: "early unbound baseline: sampled before this repeatable comparison script existed; retained for history, not used for candidate comparison",
      sha256: sha(await readFile("/private/tmp/atools-batch47-candidate/performance-baseline-v1.json")),
    },
    beforeSnapshot: { path: resolve(beforeManifestPath), sha256: sha(await readFile(beforeManifestPath)), source: baselineEntry },
    harness: { path: relativeTo(root, new URL(import.meta.url).pathname), sha256: sha(self) },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: cpus().length, model: cpus()[0]?.model ?? "unknown" },
    fixture: { plugins: fixture.length, features: fixture.reduce((count, plugin) => count + plugin.manifest.features.length, 0), queries, queryFixtureSha256: sha(Buffer.from(JSON.stringify({ fixture, queries }))), warmupSamplesPerQueryAndSource: 5, measuredSamplesPerQueryAndSource: 60, order: "alternate candidate-first and baseline-first within each query sample", percentileRule: "nearest-rank ceil(p*n)-1" },
    modules: {
      baseline: { sourceSha256: sha(beforeModules.source), transpiledSha256: sha(beforeModules.transformed) },
      candidate: { sourceSha256: sha(candidateModules.source), transpiledSha256: sha(candidateModules.transformed) },
      helper: { sourceSha256: sha(helperSource), transpiledSha256: sha(Buffer.from(helperModule.code)) },
    },
    measurements,
    worstCandidateP95Ms,
    budgetMs: 25,
    withinBudget: worstCandidateP95Ms <= 25,
  };
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, worstCandidateP95Ms, withinBudget: report.withinBudget,
    measurements: measurements.map(({ queryClass, baselineP95Ms, candidateP95Ms }) => ({ queryClass, baselineP95Ms, candidateP95Ms })) }));
  if (!report.withinBudget) process.exitCode = 1;
} finally {
  await rm(temp, { recursive: true, force: true });
}

function relativeTo(base, path) { return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path; }
