import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { transformWithEsbuild } from "vite";

const root = new URL("../", import.meta.url);
const BENCHMARK_PREFIX = "ATOOLS_SEARCH_BENCHMARK ";

export function parseBenchmarkOutput(output) {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.startsWith(BENCHMARK_PREFIX));
  if (!line) {
    throw new Error("Missing ATOOLS_SEARCH_BENCHMARK output");
  }
  return JSON.parse(line.slice(BENCHMARK_PREFIX.length));
}

export async function runSearchBenchmark(options = {}) {
  const scale = Math.max(1, Number(options.scale ?? 2_000));
  const iterations = Math.max(1, Number(options.iterations ?? 5));
  const thresholdMs = Math.max(1, Number(options.thresholdMs ?? 80));
  const timestamp = options.timestamp ?? new Date().toISOString();
  const outDir = await mkdtemp(join(tmpdir(), "atools-search-benchmark-"));

  try {
    const modules = await loadSearchModules(outDir);
    const datasets = createBenchmarkDatasets(scale);
    const resolveTarget = (code) => datasets.targets.get(code) ?? null;
    const aggregate = (query) => [
      ...modules.commandAliases.commandAliasResultsForQuery(query, datasets.aliases, resolveTarget),
      ...modules.localLaunch.localLaunchResultsForQuery(query, datasets.localLaunch),
      ...modules.webQuickOpen.webQuickOpenResultsForQuery(query, datasets.webQuickOpen),
    ].sort((a, b) => b.score - a.score);

    const cases = [
      measureCase("alias_exact", `alias${scale - 1}`, iterations, (query) =>
        modules.commandAliases.commandAliasResultsForQuery(query, datasets.aliases, resolveTarget)),
      measureCase("local_launch_path_contains", `workspace-${scale - 1}`, iterations, (query) =>
        modules.localLaunch.localLaunchResultsForQuery(query, datasets.localLaunch)),
      measureCase("web_quick_open_prefix", `site${scale - 1} rust tauri`, iterations, (query) =>
        modules.webQuickOpen.webQuickOpenResultsForQuery(query, datasets.webQuickOpen)),
      measureCase("aggregate_keyword", "project", iterations, aggregate),
      measureCase("aggregate_no_match", "zzzz-no-match", iterations, aggregate),
    ];
    const maxDurationMs = Math.max(...cases.map((item) => item.max_duration_ms));

    return {
      status: maxDurationMs <= thresholdMs ? "ok" : "warn",
      timestamp,
      iterations,
      datasets: {
        aliases: datasets.aliases.length,
        local_launch: datasets.localLaunch.length,
        web_quick_open: datasets.webQuickOpen.length,
      },
      summary: {
        total_cases: cases.length,
        max_duration_ms: roundMs(maxDurationMs),
        threshold_ms: thresholdMs,
      },
      cases,
    };
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
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

function measureCase(name, query, iterations, run) {
  let result = [];
  const durations = [];
  for (let index = 0; index < iterations; index += 1) {
    const start = performance.now();
    result = run(query);
    durations.push(performance.now() - start);
  }
  const durationMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  const maxDurationMs = Math.max(...durations);

  return {
    name,
    query,
    result_count: result.length,
    top_label: result[0]?.label ?? null,
    duration_ms: roundMs(durationMs),
    max_duration_ms: roundMs(maxDurationMs),
  };
}

function roundMs(value) {
  return Math.round(value * 1_000) / 1_000;
}

function parseCliArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--scale") options.scale = Number(argv[++index]);
    if (arg === "--iterations") options.iterations = Number(argv[++index]);
    if (arg === "--threshold-ms") options.thresholdMs = Number(argv[++index]);
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
