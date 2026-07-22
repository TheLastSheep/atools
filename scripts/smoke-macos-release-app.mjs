import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

export const RELEASE_APP_SMOKE_PREFIX = "ATOOLS_MACOS_RELEASE_APP_SMOKE ";

export function parseReleaseAppSmokeOutput(output) {
  const line = output
    .split(/\r?\n/)
    .find((item) => item.startsWith(RELEASE_APP_SMOKE_PREFIX));
  if (!line) {
    throw new Error("Missing ATOOLS_MACOS_RELEASE_APP_SMOKE output");
  }
  return JSON.parse(line.slice(RELEASE_APP_SMOKE_PREFIX.length));
}

export function inspectAppBundle(appPath) {
  const infoPlistPath = join(appPath, "Contents", "Info.plist");
  const result = {
    ok: false,
    app_path: normalize(appPath),
    info_plist_path: normalize(infoPlistPath),
    executable_name: null,
    executable_path: null,
    executable_exists: false,
    bundle_identifier: null,
    errors: [],
  };

  if (!existsSync(appPath)) {
    result.errors.push(`App bundle is missing: ${appPath}`);
    return result;
  }
  if (!isDirectory(appPath)) {
    result.errors.push(`App bundle path is not a directory: ${appPath}`);
    return result;
  }
  if (!existsSync(infoPlistPath)) {
    result.errors.push(`Info.plist is missing: ${infoPlistPath}`);
    return result;
  }

  const source = readFileSync(infoPlistPath, "utf8");
  const executableName = plistStringValue(source, "CFBundleExecutable");
  const bundleIdentifier = plistStringValue(source, "CFBundleIdentifier");
  result.executable_name = executableName;
  result.bundle_identifier = bundleIdentifier;

  if (!executableName) {
    result.errors.push("Info.plist does not contain CFBundleExecutable");
    return result;
  }

  const executablePath = join(appPath, "Contents", "MacOS", executableName);
  result.executable_path = normalize(executablePath);
  result.executable_exists = existsSync(executablePath) && isFile(executablePath);
  if (!result.executable_exists) {
    result.errors.push(`Bundle executable is missing: ${executablePath}`);
    return result;
  }

  result.ok = true;
  return result;
}

export function classifyCodesignResult(commandResult) {
  const output = commandResult.output ?? "";
  if (commandResult.status === 0) {
    const signature = firstMatch(output, /^Signature=(.+)$/m) ?? "unknown";
    const identifier = firstMatch(output, /^Identifier=(.+)$/m) ?? null;
    const authorities = [...output.matchAll(/^Authority=(.+)$/gm)].map((match) => match[1]);
    return {
      status: "ok",
      signature,
      identifier,
      authorities,
      output,
      message: `codesign accepted bundle signature (${signature})`,
      output_preview: preview(output),
    };
  }
  return {
    status: "warn",
    signature: null,
    identifier: null,
    authorities: [],
    output,
    message: `codesign check did not accept the bundle: ${preview(output)}`,
    output_preview: preview(output),
  };
}

export function classifySpctlResult(commandResult) {
  const output = commandResult.output ?? "";
  if (commandResult.status === 0) {
    return {
      status: "ok",
      output,
      message: `Gatekeeper accepted the bundle: ${preview(output)}`,
      output_preview: preview(output),
    };
  }
  return {
    status: "warn",
    output,
    message: `Gatekeeper did not accept the local bundle: ${preview(output)}`,
    output_preview: preview(output),
  };
}

export function isKnownLocalAdhocGatekeeperWarning(spctlResult, codesignResult) {
  if (!spctlResult || !codesignResult) return false;
  if (spctlResult.status !== "warn") return false;
  const signature = String(codesignResult.signature ?? "").trim().toLowerCase();
  if (!signature.startsWith("adhoc")) return false;
  const source = `${spctlResult.message} ${(spctlResult.output ?? "").toLowerCase()} ${(spctlResult.output_preview ?? "").toLowerCase()}`;
  return /code has no resources but signature indicates they must be present/.test(source);
}

export function shouldFailStrictMode(result, options = {}) {
  if (!options.strict) return false;
  if (result.summary?.error > 0) return true;

  const ignoreLocalAdhocGatekeeperWarning =
    !options.strictGatekeeper &&
    isKnownLocalAdhocGatekeeperWarning(options.spctlResult, options.codesignResult);

  const hasBlockingWarning = result.checks.some(
    (check) =>
      check.status === "warn" &&
      !(ignoreLocalAdhocGatekeeperWarning && check.id === "gatekeeper-assess")
  );
  if (hasBlockingWarning) return true;

  if (options.strictGatekeeper) {
    return (options.spctlResult?.status ?? "warn") !== "ok";
  }

  return false;
}

export function evaluateReleaseAppSmoke(input) {
  const checks = [];
  const bundle = input.bundle ?? inspectAppBundle(input.appPath);
  const appPath = input.appPath ?? bundle.app_path;
  const launch = input.launch ?? {};
  const releaseSmoke = input.release_smoke ?? null;
  const codesign = input.codesign ?? { status: "warn", message: "codesign was not run" };
  const spctl = input.spctl ?? { status: "warn", message: "spctl was not run" };
  const launched = launch.open_status === 0 && Number.isInteger(launch.pid);
  const releaseSmokeErrorPrefix = "release smoke report could not be read";

  checks.push(
    bundle.ok
      ? ok("app-bundle", `App bundle exists: ${bundle.app_path}`)
      : error("app-bundle", bundle.errors.join("; ") || "App bundle is not readable")
  );
  checks.push(
    bundle.executable_exists
      ? ok("app-executable", `Bundle executable exists: ${bundle.executable_path}`)
      : error("app-executable", "Bundle executable is missing")
  );
  checks.push(
    launched
      ? ok("app-launch", `LaunchServices started pid ${launch.pid}`)
      : error("app-launch", launch.error || `open exited with ${launch.open_status ?? "unknown"}`)
  );
  checks.push(
    launched && Number.isFinite(launch.stable_ms) && launch.stable_ms >= 1000
      ? ok("first-launch-stability", `Release app stayed alive for ${launch.stable_ms}ms`)
      : error("first-launch-stability", launch.stability_error || "Release app did not stay alive long enough")
  );
  checks.push(
    launch.terminated === true
      ? ok("release-smoke-cleanup", "Release smoke process was terminated after verification")
      : warn("release-smoke-cleanup", "Release smoke process cleanup could not be confirmed")
  );
  if (releaseSmoke) {
    checks.push(
      releaseSmoke.option_z_toggled === true
        ? ok("release-smoke-option-z", "Release smoke reported Option+Z action")
        : error("release-smoke-option-z", "Release smoke did not confirm Option+Z action")
    );
    const hotkeyShowMs = Number(releaseSmoke.hotkey_show_ms);
    const hotkeyToggleAttemptCount = Number(releaseSmoke.hotkey_toggle_attempt_count);
    const hotkeyToggleSuccessCount = Number(releaseSmoke.hotkey_toggle_success_count);
    checks.push(
      Number.isFinite(hotkeyShowMs) && hotkeyShowMs > 0
        ? ok("release-smoke-hotkey-latency", `Main window show path completed in ${hotkeyShowMs.toFixed(3)}ms`)
        : error("release-smoke-hotkey-latency", "Release smoke did not report a valid hotkey show duration")
    );
    checks.push(
      Number.isFinite(hotkeyToggleAttemptCount)
        && hotkeyToggleAttemptCount >= 5
        && hotkeyToggleSuccessCount === hotkeyToggleAttemptCount
        ? ok("release-smoke-hotkey-repeat", `Main window toggle path passed ${hotkeyToggleSuccessCount}/${hotkeyToggleAttemptCount} repeated attempts`)
        : error("release-smoke-hotkey-repeat", `Main window toggle path passed ${hotkeyToggleSuccessCount}/${hotkeyToggleAttemptCount} repeated attempts`)
    );
    const searchLatencyMs = Number(releaseSmoke.search_latency_ms);
    const searchResultCount = Number(releaseSmoke.search_result_count);
    checks.push(
      typeof releaseSmoke.search_query === "string"
        && releaseSmoke.search_query.trim().length > 0
        && Number.isFinite(searchLatencyMs)
        && searchLatencyMs > 0
        && Number.isFinite(searchResultCount)
        && searchResultCount > 0
        ? ok("release-smoke-search-latency", `${releaseSmoke.search_query} returned ${searchResultCount} results in ${searchLatencyMs.toFixed(3)}ms`)
        : error("release-smoke-search-latency", "Release smoke did not report a valid packaged search duration")
    );
    checks.push(
      releaseSmoke.settings_page_opened === true
        ? ok("release-smoke-settings", "Release smoke reported settings page opening")
        : error("release-smoke-settings", "Release smoke did not confirm settings page opening")
    );
    checks.push(
      releaseSmoke.plugin_page_opened === true
        ? ok("release-smoke-plugin", "Release smoke reported plugin page opening")
        : error("release-smoke-plugin", "Release smoke did not confirm plugin page opening")
    );
    checks.push(
      releaseSmoke.agent_page_opened === true
        ? ok("release-smoke-agent", "Release smoke reported agent/mcp page opening")
        : error("release-smoke-agent", "Release smoke did not confirm agent/mcp page opening")
    );
    checks.push(
      releaseSmoke.clipboard_copy_tracked === true
        ? ok("release-smoke-clipboard-task-run", "Release smoke confirmed redacted clipboard TaskRun persistence")
        : error("release-smoke-clipboard-task-run", "Release smoke did not confirm the redacted clipboard TaskRun contract")
    );
    const pluginActivationMs = Number(releaseSmoke.plugin_activation_ms);
    checks.push(
      typeof releaseSmoke.plugin_activation_feature === "string"
        && releaseSmoke.plugin_activation_feature.trim().length > 0
        && Number.isFinite(pluginActivationMs)
        && pluginActivationMs > 0
        ? ok("release-smoke-plugin-activation", `${releaseSmoke.plugin_activation_feature} plugin reported ready in ${pluginActivationMs.toFixed(3)}ms`)
        : error("release-smoke-plugin-activation", "Release smoke did not report a valid plugin cold activation duration")
    );
    if (!Array.isArray(releaseSmoke.errors)) {
      checks.push(
        warn(releaseSmokeErrorPrefix, `${releaseSmokeErrorPrefix}: missing errors field in report`)
      );
    }
  } else {
    checks.push({
      id: "release-smoke-progress",
      status: "warn",
      message: `${releaseSmokeErrorPrefix}: no report was available`,
    });
  }
  checks.push({
    id: "codesign-status",
    status: codesign.status,
    message: codesign.message,
    signature: codesign.signature,
    identifier: codesign.identifier,
    authorities: codesign.authorities,
  });
  checks.push({
    id: "gatekeeper-assess",
    status: spctl.status,
    message: spctl.message,
  });

  const summary = summarizeChecks(checks);
  return {
    status: summary.error > 0 ? "error" : summary.warn > 0 ? "warn" : "ok",
    summary,
    checks,
    app_path: normalize(appPath),
    executable_path: bundle.executable_path,
    bundle_identifier: bundle.bundle_identifier,
    launch_pid: launch.pid ?? null,
    timestamp: new Date().toISOString(),
  };
}

export async function runReleaseAppSmoke(options = {}) {
  const root = options.root ?? process.cwd();
  const appPath = options.appPath ?? defaultAppPath(root);
  const bundle = inspectAppBundle(appPath);
  const reportPath = options.reportPath ?? defaultReleaseSmokeReportPath(root);
  const codesign = bundle.ok
    ? classifyCodesignResult(runCommand("codesign", ["-dv", "--verbose=4", appPath]))
    : classifyCodesignResult({ status: 1, output: "app bundle missing" });
  const spctl = bundle.ok
    ? classifySpctlResult(runCommand("spctl", ["--assess", "--type", "execute", "--verbose", appPath]))
    : classifySpctlResult({ status: 1, output: "app bundle missing" });
  const launch = options.skipLaunch
    ? { open_status: null, error: "launch skipped by option", stable_ms: 0, terminated: false }
    : await launchAppBundle({
        appPath,
        executablePath: bundle.executable_path,
        timeoutMs: options.timeoutMs ?? 10000,
        stableMs: options.stableMs ?? 1500,
        resourceSettleMs: options.resourceSettleMs ?? 0,
        reportPath,
      });
  const releaseSmokeProgress = launch.release_smoke_progress ?? readReleaseSmokeProgress(reportPath);

  return evaluateReleaseAppSmoke({
    appPath,
    bundle,
    launch,
    codesign,
    spctl,
    release_smoke: releaseSmokeProgress,
  });
}

export async function launchAppBundle(options) {
  if (process.platform !== "darwin") {
    return {
      open_status: null,
      error: "macOS release app launch smoke requires darwin",
      stable_ms: 0,
      terminated: false,
      token: null,
      report_path: null,
      release_smoke_progress: null,
    };
  }

  const launchStartedAt = Date.now();

  const token = `--atools-release-smoke-token=${Date.now()}-${process.pid}`;
  const reportArg = options.reportPath ? `--atools-release-smoke-report=${options.reportPath}` : null;
  const beforePids = processIdsForExecutable(options.executablePath);
  const openArgs = ["-n", options.appPath, "--args", token];
  if (reportArg) {
    openArgs.push(reportArg);
  }
  const opened = spawnSync("open", openArgs, {
    encoding: "utf8",
    timeout: 10000,
  });
  const output = `${opened.stdout ?? ""}${opened.stderr ?? ""}`.trim();
  if (opened.status !== 0) {
    return {
      open_status: opened.status,
      error: output || "open command failed",
      stable_ms: 0,
      terminated: false,
    };
  }

  const pid = await waitForLaunchPid({
    token,
    executablePath: options.executablePath,
    beforePids,
    timeoutMs: options.timeoutMs,
  });
  if (!pid) {
    return {
      open_status: 0,
      error: "open returned success but no release app process was observed",
      stable_ms: 0,
      terminated: false,
    };
  }

  const launchToPidMs = Date.now() - launchStartedAt;

  let launchToFirstReportMs = null;
  const releaseSmokePromise = waitForReleaseSmokeCompletion({
    pid,
    reportPath: options.reportPath,
    timeoutMs: options.timeoutMs,
    onProgress: () => {
      launchToFirstReportMs ??= Date.now() - launchStartedAt;
    },
  });
  const stableStart = Date.now();
  await sleep(options.stableMs);
  const aliveAfterWait = isProcessAlive(pid);
  const stableMs = aliveAfterWait ? Date.now() - stableStart : 0;
  const releaseSmokeProgress = await releaseSmokePromise;
  const launchToSmokeCompleteMs = releaseSmokeProgress?.completed === true
    ? Date.now() - launchStartedAt
    : null;
  const resourceSettleTargetMs = Math.max(0, Number(options.resourceSettleMs ?? 0));
  const resourceSettle = releaseSmokeProgress?.completed === true && aliveAfterWait
    ? await waitForProcessSettle(pid, resourceSettleTargetMs)
    : { alive: aliveAfterWait, elapsed_ms: 0 };
  const resources = resourceSettle.alive ? processResourceSample(pid) : null;
  const terminated = await terminateProcess(pid);
  return {
    open_status: 0,
    pid,
    token,
    report_path: options.reportPath ?? null,
    release_smoke_progress: releaseSmokeProgress,
    launch_to_pid_ms: launchToPidMs,
    launch_to_first_report_ms: launchToFirstReportMs,
    launch_to_smoke_complete_ms: launchToSmokeCompleteMs,
    rss_kib: resources?.rss_kib ?? null,
    cpu_percent: resources?.cpu_percent ?? null,
    resource_settle_target_ms: resourceSettleTargetMs,
    resource_settle_ms: resourceSettle.elapsed_ms,
    alive_after_resource_settle: resourceSettle.alive,
    stable_ms: stableMs,
    stability_error: !aliveAfterWait
      ? `Release app process ${pid} exited during first-launch window`
      : !resourceSettle.alive
        ? `Release app process ${pid} exited during the resource settle window`
        : null,
    terminated,
  };
}

async function waitForProcessSettle(pid, targetMs) {
  const startedAt = Date.now();
  const deadline = startedAt + targetMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return { alive: false, elapsed_ms: Date.now() - startedAt };
    }
    await sleep(Math.min(1000, deadline - Date.now()));
  }
  return {
    alive: isProcessAlive(pid),
    elapsed_ms: Date.now() - startedAt,
  };
}

export async function waitForReleaseSmokeCompletion(options) {
  const pollMs = Math.max(1, options.pollMs ?? 100);
  const attempts = Math.max(1, Math.ceil((options.timeoutMs ?? 10000) / pollMs));
  const isAlive = options.isAlive ?? isProcessAlive;
  const readProgress = options.readProgress ?? readReleaseSmokeProgress;
  const wait = options.wait ?? sleep;
  let latest = null;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!isAlive(options.pid)) break;
    latest = readProgress(options.reportPath);
    if (latest) options.onProgress?.(latest);
    if (latest?.completed === true) return latest;
    if (attempt + 1 < attempts) await wait(pollMs);
  }

  return latest;
}

export function processResourceSample(pid) {
  const result = spawnSync("ps", ["-o", "rss=,%cpu=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 5000,
  });
  if (result.status !== 0) return null;
  const match = result.stdout.trim().match(/^(\d+)\s+([0-9.]+)$/);
  if (!match) return null;
  return {
    rss_kib: Number(match[1]),
    cpu_percent: Number(match[2]),
  };
}

function defaultReleaseSmokeReportPath(root) {
  const base = mkdtempSync(join(tmpdir(), "atools-release-smoke-"));
  return join(base, "release-smoke.json");
}

function readReleaseSmokeProgress(reportPath) {
  if (!reportPath || !existsSync(reportPath)) {
    return null;
  }
  try {
    const raw = readFileSync(reportPath, "utf8");
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (error) {
    return {
      errors: [`release smoke report read failed: ${String(error)}`],
    };
  }
}

export function defaultAppPath(root) {
  const candidates = [
    join(root, "target", "release", "bundle", "macos", "ATools 3.0.app"),
    join(root, "src-tauri", "target", "release", "bundle", "macos", "ATools 3.0.app"),
  ];
  return normalize(candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]);
}

function runCommand(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30000 });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
  };
}

function processIdsForExecutable(executablePath) {
  if (!executablePath) return new Set();
  return new Set(
    processRows()
      .filter((row) => row.command.includes(executablePath))
      .map((row) => row.pid)
  );
}

async function waitForLaunchPid(options) {
  const deadline = Date.now() + options.timeoutMs;
  while (Date.now() < deadline) {
    const rows = processRows();
    const tokenMatch = rows.find((row) => row.command.includes(options.token));
    if (tokenMatch) return tokenMatch.pid;
    if (options.executablePath) {
      const newProcess = rows.find(
        (row) => row.command.includes(options.executablePath) && !options.beforePids.has(row.pid)
      );
      if (newProcess) return newProcess.pid;
    }
    await sleep(200);
  }
  return null;
}

function processRows() {
  const result = spawnSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 5000 });
  if (result.status !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      return match ? { pid: Number(match[1]), command: match[2] } : null;
    })
    .filter(Boolean);
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(pid) {
  if (!isProcessAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return true;
  }
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await sleep(100);
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return true;
  }
  await sleep(100);
  return !isProcessAlive(pid);
}

function summarizeChecks(checks) {
  return checks.reduce(
    (summary, check) => {
      summary[check.status] += 1;
      return summary;
    },
    { ok: 0, warn: 0, error: 0 }
  );
}

function ok(id, message) {
  return { id, status: "ok", message };
}

function warn(id, message) {
  return { id, status: "warn", message };
}

function error(id, message) {
  return { id, status: "error", message };
}

function plistStringValue(source, key) {
  const pattern = new RegExp(`<key>\\s*${escapeRegExp(key)}\\s*<\\/key>\\s*<string>([^<]*)<\\/string>`);
  const value = source.match(pattern)?.[1];
  return value ? decodeXml(value.trim()) : null;
}

function firstMatch(source, pattern) {
  return source.match(pattern)?.[1]?.trim() ?? null;
}

function preview(output) {
  const normalized = String(output ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 240 ? `${normalized.slice(0, 237)}...` : normalized;
}

function decodeXml(value) {
  return value
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1] ?? null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const appPath = optionValue("--app");
  const stableMs = Number(optionValue("--stable-ms") ?? 1500);
  const timeoutMs = Number(optionValue("--timeout-ms") ?? 10000);
  const result = await runReleaseAppSmoke({
    appPath,
    reportPath: optionValue("--atools-release-smoke-report"),
    stableMs,
    timeoutMs,
    skipLaunch: process.argv.includes("--skip-launch"),
  });
  console.log(`${RELEASE_APP_SMOKE_PREFIX}${JSON.stringify(result)}`);
  const gatekeeper = result.checks.find((check) => check.id === "gatekeeper-assess");
  const codesign = result.checks.find((check) => check.id === "codesign-status");
  if (
    result.summary.error > 0 ||
    shouldFailStrictMode(result, {
      strict: process.argv.includes("--strict"),
      strictGatekeeper: process.argv.includes("--strict-gatekeeper"),
      spctlResult: gatekeeper,
      codesignResult: codesign,
    }) ||
    (process.argv.includes("--strict-gatekeeper") && gatekeeper?.status !== "ok")
  ) {
    process.exitCode = 1;
  }
}
