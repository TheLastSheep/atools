import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const BENCHMARK_PREFIX = "ATOOLS_SEARCH_BENCHMARK ";
const DEFAULT_SCALES = [10_000, 100_000];

export function parseBenchmarkOutput(output) {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.startsWith(BENCHMARK_PREFIX));
  if (!line) {
    throw new Error("Missing ATOOLS_SEARCH_BENCHMARK output");
  }
  return JSON.parse(line.slice(BENCHMARK_PREFIX.length));
}

export function percentile(values, requestedPercentile) {
  if (values.length === 0) {
    throw new Error("Cannot calculate a percentile from an empty sample");
  }
  if (requestedPercentile < 0 || requestedPercentile > 100) {
    throw new Error("Percentile must be between 0 and 100");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil((requestedPercentile / 100) * sorted.length) - 1);
  return sorted[index];
}

export async function runSearchBenchmark(options = {}) {
  const scales = normalizeScales(options.scales ?? (options.scale ? [options.scale] : DEFAULT_SCALES));
  const iterations = positiveInteger(options.iterations, 20);
  const warmupIterations = nonNegativeInteger(options.warmupIterations, 3);
  const thresholdMs = positiveNumber(options.thresholdMs, 80);
  const timestamp = options.timestamp ?? new Date().toISOString();
  const outDir = await mkdtemp(join(options.tmpDir ?? process.env.RUNNER_TEMP ?? process.env.TMPDIR ?? "/tmp", "atools-search-benchmark-"));

  try {
    const modules = await loadSearchModules(outDir);
    const runs = [];
    for (const scale of scales) {
      runs.push(runScaleBenchmark({ modules, scale, iterations, warmupIterations, thresholdMs }));
    }

    const allCases = runs.flatMap((run) => run.cases);
    const worstP99Ms = Math.max(...allCases.map((item) => item.p99_ms));
    const worstMaxDurationMs = Math.max(...allCases.map((item) => item.max_duration_ms));
    const result = {
      schema_version: 2,
      status: runs.every((run) => run.status === "ok") ? "ok" : "warn",
      timestamp,
      source: {
        repository: process.env.GITHUB_REPOSITORY ?? null,
        commit: process.env.GITHUB_SHA ?? null,
        run_id: process.env.GITHUB_RUN_ID ?? null,
      },
      machine: machineMetadata(),
      config: {
        scales,
        iterations,
        warmup_iterations: warmupIterations,
        threshold_ms: thresholdMs,
      },
      summary: {
        scale_count: runs.length,
        total_cases: allCases.length,
        worst_p99_ms: roundMs(worstP99Ms),
        worst_max_duration_ms: roundMs(worstMaxDurationMs),
        threshold_ms: thresholdMs,
      },
      runs,
    };

    if (options.outputPath) {
      const outputPath = resolve(options.outputPath);
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    }
    return result;
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
}

function runScaleBenchmark({ modules, scale, iterations, warmupIterations, thresholdMs }) {
  const datasets = createBenchmarkDatasets(scale);
  const resolveTarget = (code) => datasets.targets.get(code) ?? null;
  const aggregate = (query) => [
    ...modules.commandAliases.commandAliasResultsForQuery(query, datasets.aliases, resolveTarget),
    ...modules.localLaunch.localLaunchResultsForQuery(query, datasets.localLaunch),
    ...modules.webQuickOpen.webQuickOpenResultsForQuery(query, datasets.webQuickOpen),
  ].sort((a, b) => b.score - a.score);

  const cases = [
    measureCase("alias_exact", `alias${scale - 1}`, iterations, warmupIterations, (query) =>
      modules.commandAliases.commandAliasResultsForQuery(query, datasets.aliases, resolveTarget)),
    measureCase("local_launch_path_contains", `workspace-${scale - 1}`, iterations, warmupIterations, (query) =>
      modules.localLaunch.localLaunchResultsForQuery(query, datasets.localLaunch)),
    measureCase("web_quick_open_prefix", `site${scale - 1} rust tauri`, iterations, warmupIterations, (query) =>
      modules.webQuickOpen.webQuickOpenResultsForQuery(query, datasets.webQuickOpen)),
    measureCase("aggregate_keyword", "project", iterations, warmupIterations, aggregate),
    measureCase("aggregate_no_match", "zzzz-no-match", iterations, warmupIterations, aggregate),
  ];
  const worstP99Ms = Math.max(...cases.map((item) => item.p99_ms));

  return {
    scale,
    status: worstP99Ms <= thresholdMs ? "ok" : "warn",
    datasets: {
      aliases: datasets.aliases.length,
      local_launch: datasets.localLaunch.length,
      web_quick_open: datasets.webQuickOpen.length,
      total_records: datasets.aliases.length + datasets.localLaunch.length + datasets.webQuickOpen.length,
    },
    summary: {
      total_cases: cases.length,
      worst_p99_ms: roundMs(worstP99Ms),
      threshold_ms: thresholdMs,
    },
    cases,
  };
}

async function loadSearchModules(outDir) {
  await writeTransformedModule("src/lib/searchMatch.ts", join(outDir, "searchMatch.mjs"));
  await writeSearchModule("src/lib/commandAliases.ts", join(outDir, "commandAliases.mjs"));
  await writeSearchModule("src/lib/localLaunch.ts", join(outDir, "localLaunch.mjs"));
  await writeSearchModule("src/lib/webQuickOpen.ts", join(outDir, "webQuickOpen.mjs"));

  return {
    commandAliases: await import(pathToFileURL(join(outDir, "commandAliases.mjs")).href),
    localLaunch: await import(pathToFileURL(join(outDir, "localLaunch.mjs")).href),
    webQuickOpen: await import(pathToFileURL(join(outDir, "webQuickOpen.mjs")).href),
  };
}

async function writeSearchModule(sourceRelativePath, outFile) {
  const source = await transformedSource(sourceRelativePath);
  await writeFile(outFile, source.replaceAll('from "./searchMatch";', 'from "./searchMatch.mjs";'));
}

async function writeTransformedModule(sourceRelativePath, outFile) {
  await writeFile(outFile, await transformedSource(sourceRelativePath));
}

async function transformedSource(sourceRelativePath) {
  const sourcePath = new URL(sourceRelativePath, root).pathname;
  const source = await readFile(sourcePath, "utf8");
  const transformed = await transformWithEsbuild(source, sourcePath, {
    format: "esm",
    target: "esnext",
    loader: "ts",
  });
  return transformed.code;
}

function createBenchmarkDatasets(scale) {
  const targets = new Map();
  const aliases = [];
  const localLaunch = [];
  const webQuickOpen = [];

  for (let index = 0; index < scale; index += 1) {
    const localCode = `local:project-${index}`;
    const webCode = `web:site-${index}`;
    const systemCode = index % 2 === 0 ? localCode : webCode;

    localLaunch.push({
      id: `project-${index}`,
      name: `Project Workspace ${index}`,
      keyword: `proj${index}`,
      path: `/tmp/ATools/Workspace-${index}`,
      kind: "folder",
      enabled: true,
    });
    webQuickOpen.push({
      id: `site-${index}`,
      name: `Search Site ${index}`,
      keyword: `site${index}`,
      template: `https://example.com/search/${index}?q={query}`,
      enabled: true,
    });
    targets.set(localCode, {
      code: localCode,
      label: `Project Workspace ${index}`,
      explain: `/tmp/ATools/Workspace-${index}`,
      plugin_id: "local-launch",
      plugin_name: "本地启动",
    });
    targets.set(webCode, {
      code: webCode,
      label: `Search Site ${index}`,
      explain: `site${index} quick search`,
      plugin_id: "web-quick-open",
      plugin_name: "网页快开",
    });
    aliases.push({
      id: `alias-${index}`,
      alias: `alias${index}`,
      targetCode: systemCode,
      enabled: true,
    });
  }

  return {
    aliases,
    localLaunch,
    webQuickOpen,
    targets,
  };
}

function measureCase(name, query, iterations, warmupIterations, run) {
  let result = [];
  for (let index = 0; index < warmupIterations; index += 1) {
    result = run(query);
  }

  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    result = run(query);
    durations.push(performance.now() - start);
  }

  return {
    name,
    query,
    result_count: result.length,
    top_label: result[0]?.label ?? null,
    samples: durations.length,
    mean_ms: roundMs(durations.reduce((sum, value) => sum + value, 0) / durations.length),
    p50_ms: roundMs(percentile(durations, 50)),
    p95_ms: roundMs(percentile(durations, 95)),
    p99_ms: roundMs(percentile(durations, 99)),
    min_duration_ms: roundMs(Math.min(...durations)),
    max_duration_ms: roundMs(Math.max(...durations)),
  };
}

function machineMetadata() {
  const cpuList = cpus();
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    hostname: hostname(),
    node: process.version,
    cpu_model: cpuList[0]?.model ?? "unknown",
    cpu_count: cpuList.length,
    total_memory_bytes: totalmem(),
  };
}

function roundMs(value) {
  return Math.round(value * 1_000) / 1_000;
}

function normalizeScales(scales) {
  const values = Array.isArray(scales) ? scales : String(scales).split(",");
  const normalized = [...new Set(values.map((value) => positiveInteger(value, null)).filter((value) => value !== null))];
  if (normalized.length === 0) {
    throw new Error("At least one positive benchmark scale is required");
  }
  return normalized;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scale") options.scales = [argv[++index]];
    if (arg === "--scales") options.scales = argv[++index];
    if (arg === "--iterations") options.iterations = argv[++index];
    if (arg === "--warmup-iterations") options.warmupIterations = argv[++index];
    if (arg === "--threshold-ms") options.thresholdMs = argv[++index];
    if (arg === "--output") options.outputPath = argv[++index];
    if (arg === "--fail-on-threshold") options.failOnThreshold = true;
  }
  return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseCliArgs(process.argv.slice(2));
  const result = await runSearchBenchmark(options);
  console.log(`${BENCHMARK_PREFIX}${JSON.stringify(result)}`);
  if (options.failOnThreshold && result.status !== "ok") {
    process.exitCode = 1;
  }
}
