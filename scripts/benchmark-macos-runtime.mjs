import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  defaultAppPath,
  inspectAppBundle,
  launchAppBundle,
} from "./smoke-macos-release-app.mjs";

export const RUNTIME_BENCHMARK_PREFIX = "ATOOLS_MACOS_RUNTIME_BENCHMARK ";

export async function runMacosRuntimeBenchmark(options = {}) {
  if (platform() !== "darwin") {
    throw new Error("macOS runtime benchmark requires darwin");
  }
  const root = options.root ?? process.cwd();
  const appPath = options.appPath ?? defaultAppPath(root);
  const bundle = inspectAppBundle(appPath);
  if (!bundle.ok) throw new Error(bundle.errors.join("; "));

  const iterations = Math.max(1, Number(options.iterations ?? 20));
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? 15000));
  const stableMs = Math.max(1000, Number(options.stableMs ?? 1000));
  const idleSampleMs = Math.max(0, Number(options.idleSampleMs ?? 0));
  const runs = [];
  for (let index = 0; index < iterations; index += 1) {
    const reportDir = mkdtempSync(join(tmpdir(), "atools-runtime-benchmark-"));
    const reportPath = join(reportDir, "release-smoke.json");
    try {
      const launch = await launchAppBundle({
        appPath,
        executablePath: bundle.executable_path,
        timeoutMs,
        stableMs,
        reportPath,
      });
      if (
        launch.open_status !== 0 ||
        !Number.isFinite(launch.launch_to_pid_ms) ||
        !Number.isFinite(launch.launch_to_first_report_ms) ||
        !Number.isFinite(launch.launch_to_smoke_complete_ms) ||
        !Number.isFinite(launch.rss_kib) ||
        !Number.isFinite(launch.cpu_percent) ||
        !Number.isFinite(launch.release_smoke_progress?.plugin_activation_ms) ||
        typeof launch.release_smoke_progress?.plugin_activation_feature !== "string" ||
        launch.release_smoke_progress.plugin_activation_feature.trim().length === 0 ||
        !Array.isArray(launch.release_smoke_progress?.errors) ||
        launch.release_smoke_progress.errors.length > 0 ||
        launch.release_smoke_progress?.completed !== true ||
        launch.terminated !== true
      ) {
        throw new Error(`Runtime launch ${index + 1} was incomplete: ${JSON.stringify(launch)}`);
      }
      runs.push({
        iteration: index + 1,
        launch_to_pid_ms: launch.launch_to_pid_ms,
        launch_to_first_report_ms: launch.launch_to_first_report_ms,
        launch_to_smoke_complete_ms: launch.launch_to_smoke_complete_ms,
        rss_kib: launch.rss_kib,
        cpu_percent: launch.cpu_percent,
        plugin_activation_feature: launch.release_smoke_progress.plugin_activation_feature,
        plugin_activation_ms: launch.release_smoke_progress.plugin_activation_ms,
      });
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }

  let idleSample = null;
  if (idleSampleMs > 0) {
    const reportDir = mkdtempSync(join(tmpdir(), "atools-runtime-idle-"));
    const reportPath = join(reportDir, "release-smoke.json");
    try {
      const launch = await launchAppBundle({
        appPath,
        executablePath: bundle.executable_path,
        timeoutMs,
        stableMs,
        resourceSettleMs: idleSampleMs,
        reportPath,
      });
      if (
        launch.open_status !== 0 ||
        launch.release_smoke_progress?.completed !== true ||
        !Array.isArray(launch.release_smoke_progress?.errors) ||
        launch.release_smoke_progress.errors.length > 0 ||
        !Number.isFinite(launch.release_smoke_progress?.plugin_activation_ms) ||
        typeof launch.release_smoke_progress?.plugin_activation_feature !== "string" ||
        launch.release_smoke_progress.plugin_activation_feature.trim().length === 0 ||
        launch.alive_after_resource_settle !== true ||
        launch.resource_settle_ms < idleSampleMs ||
        !Number.isFinite(launch.rss_kib) ||
        !Number.isFinite(launch.cpu_percent) ||
        launch.terminated !== true
      ) {
        throw new Error(`Idle resource sample was incomplete: ${JSON.stringify(launch)}`);
      }
      idleSample = {
        target_settle_ms: idleSampleMs,
        actual_settle_ms: launch.resource_settle_ms,
        alive: launch.alive_after_resource_settle,
        release_smoke_completed: true,
        rss_mib: round(launch.rss_kib / 1024),
        cpu_percent: round(launch.cpu_percent),
      };
    } finally {
      rmSync(reportDir, { recursive: true, force: true });
    }
  }

  const thresholds = {
    first_report_ms: Number(options.firstReportThresholdMs ?? 5000),
    rss_mib: Number(options.rssThresholdMib ?? 300),
    bundle_mib: Number(options.bundleThresholdMib ?? 100),
  };
  const app = {
    bundle_bytes: pathBytes(appPath),
    executable_bytes: statSync(bundle.executable_path).size,
  };
  const metrics = {
    launch_to_pid_ms: distribution(runs.map((run) => run.launch_to_pid_ms)),
    launch_to_first_report_ms: distribution(runs.map((run) => run.launch_to_first_report_ms)),
    launch_to_smoke_complete_ms: distribution(runs.map((run) => run.launch_to_smoke_complete_ms)),
    rss_mib: distribution(runs.map((run) => run.rss_kib / 1024)),
    cpu_percent: distribution(runs.map((run) => run.cpu_percent)),
    plugin_activation_ms: distribution(runs.map((run) => run.plugin_activation_ms)),
  };
  const exceeded =
    metrics.launch_to_first_report_ms.p99 > thresholds.first_report_ms ||
    metrics.rss_mib.p99 > thresholds.rss_mib ||
    (idleSample?.rss_mib ?? 0) > thresholds.rss_mib ||
    app.bundle_bytes / 1024 / 1024 > thresholds.bundle_mib;
  return {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    commit: process.env.GITHUB_SHA ?? "local",
    machine: {
      platform: platform(),
      arch: arch(),
      runner_image: process.env.ImageOS ?? null,
      runner_version: process.env.ImageVersion ?? null,
    },
    config: { iterations, timeout_ms: timeoutMs, stable_ms: stableMs, idle_sample_ms: idleSampleMs, thresholds },
    status: exceeded ? "warn" : "pass",
    app,
    first_launch: runs[0],
    idle_sample: idleSample,
    metrics,
    runs,
  };
}

export function distribution(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) throw new Error("Cannot summarize an empty sample");
  return {
    samples: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    p99: round(percentile(sorted, 99)),
    min: round(sorted[0]),
    max: round(sorted.at(-1)),
  };
}

export function percentile(sortedValues, value) {
  if (sortedValues.length === 0) throw new Error("Cannot compute an empty percentile");
  const index = Math.ceil((value / 100) * (sortedValues.length - 1));
  return sortedValues[Math.min(sortedValues.length - 1, Math.max(0, index))];
}

function pathBytes(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return stat.size;
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, entry) => total + pathBytes(join(path, entry)), 0);
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runMacosRuntimeBenchmark({
    appPath: optionValue("--app"),
    iterations: optionValue("--iterations"),
    timeoutMs: optionValue("--timeout-ms"),
    stableMs: optionValue("--stable-ms"),
    idleSampleMs: optionValue("--idle-sample-ms"),
    firstReportThresholdMs: optionValue("--first-report-threshold-ms"),
    rssThresholdMib: optionValue("--rss-threshold-mib"),
    bundleThresholdMib: optionValue("--bundle-threshold-mib"),
  });
  const output = optionValue("--output");
  if (output) {
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
  }
  console.log(`${RUNTIME_BENCHMARK_PREFIX}${JSON.stringify(result)}`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::${result.status === "pass" ? "notice" : "warning"} title=ATools macOS runtime benchmark::` +
      `first-report P99 ${result.metrics.launch_to_first_report_ms.p99}ms; ` +
      `RSS P99 ${result.metrics.rss_mib.p99}MiB; ` +
      `plugin activation P99 ${result.metrics.plugin_activation_ms.p99}ms; ` +
      `idle RSS ${result.idle_sample?.rss_mib ?? "not sampled"}MiB; ` +
      `bundle ${(result.app.bundle_bytes / 1024 / 1024).toFixed(2)}MiB`,
    );
  }
  if (result.status !== "pass" && process.argv.includes("--fail-on-threshold")) {
    process.exitCode = 1;
  }
}
