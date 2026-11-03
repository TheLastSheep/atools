import { constants, createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, lstat, mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { stageSettingsNativeBundle } from "./ztools-settings-native-sources.mjs";

export const MAX_CAPTURE_BYTES_PER_STREAM = 64 * 1024;
export const MAX_NATIVE_TIMEOUT_MS = 180_000;
export const OWNER_MARKER_NAME = ".atools-renderer-smoke-owner.json";
export const MULTIWEBVIEW_PROBE_RESOURCE = "renderer-multiwebview-probe.txt";

const MULTIWEBVIEW_PROBE_CONTENT = "ATools renderer multiwebview resource probe\n";

const UUID_PATTERN = /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const CHILD_SMOKE_ENV_KEYS = [
  "ATOOLS_VISUAL_SMOKE",
  "ATOOLS_DESKTOP_SMOKE",
  "VITE_ATOOLS_DESKTOP_SMOKE",
  "VITE_ATOOLS_NATIVE_DIALOG_ACCEPTANCE",
  "ATOOLS_PASTEBOARD_SHELF_SMOKE",
  "ATOOLS_RELEASE_SMOKE_TOKEN",
  "RELEASE_SMOKE_TOKEN",
  "ATOOLS_RELEASE_SMOKE_REPORT_PATH",
];

export function parseNativeRunnerArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!new Set(["--mode", "--binary", "--build-receipt", "--launcher-probe-binary"]).has(flag)
        || values.has(flag) || index + 1 >= argv.length) {
      throw new Error("Supported options are one --mode single|multiwebview|settings|launcher and absolute --binary/--build-receipt paths; launcher requires --launcher-probe-binary");
    }
    const value = argv[index + 1];
    index += 1;
    if (flag === "--mode") {
      if (!new Set(["single", "multiwebview", "settings", "launcher"]).has(value)) {
        throw new Error("--mode must be single, multiwebview, settings, or launcher");
      }
    } else if (!isAbsolute(value)) {
      throw new Error(`${flag} must be an absolute path`);
    }
    values.set(flag, value);
  }
  const mode = values.get("--mode") ?? "single";
  const launcherProbeBinary = values.get("--launcher-probe-binary");
  if ((mode === "launcher") !== Boolean(launcherProbeBinary)) {
    throw new Error("--launcher-probe-binary is required only when --mode is launcher");
  }
  return {
    mode,
    binary: values.get("--binary"),
    buildReceipt: values.get("--build-receipt"),
    ...(launcherProbeBinary ? { launcherProbeBinary } : {}),
  };
}

export function buildNativeCaseArgs({ fixtureRoot, rendererDist, output, autoClear, runId, mode = "single" }) {
  if (!isAbsolute(fixtureRoot) || !isAbsolute(rendererDist) || !isAbsolute(output)) {
    throw new Error("Native case paths must be absolute");
  }
  if (!new Set(["immediately", "never"]).has(autoClear)) {
    throw new Error("autoClear must be immediately or never");
  }
  if (typeof runId !== "string" || !UUID_PATTERN.test(runId)) throw new Error("runId must be a UUID");
  if (!new Set(["single", "multiwebview", "settings", "launcher"]).has(mode)) throw new Error("Unsupported native runner mode");
  const args = [
    "--fixture-root", fixtureRoot,
    "--renderer-dist", rendererDist,
    "--output", output,
    "--auto-clear", autoClear,
    "--run-id", runId,
  ];
  if (mode === "settings") args.push("--journey", "settings");
  if (mode === "launcher") args.push("--journey", "launcher");
  return args;
}

export function nativeChildEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of CHILD_SMOKE_ENV_KEYS) delete result[key];
  return result;
}

export async function createNativeRunDirectory(root, runId) {
  if (!isAbsolute(root) || typeof runId !== "string" || !UUID_PATTERN.test(runId)) throw new Error("Native run root and UUID are required");
  const outputRoot = join(root, "output");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(outputRoot, { bigint: true });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error("Output root must be a real directory");
  const parent = join(outputRoot, "renderer-native-2026-10-27");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(parent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Native report directory must be a real directory");
  const runDirectory = join(parent, `run-${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  const runInfo = await lstat(runDirectory, { bigint: true });
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o077n) !== 0) {
    throw new Error("Native run directory must be private");
  }
  return runDirectory;
}

export function createBoundedCapture(limit = MAX_CAPTURE_BYTES_PER_STREAM) {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Capture limit must be a nonnegative integer");
  const chunks = [];
  let capturedBytes = 0;
  let observedBytes = 0;
  return Object.freeze({
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      observedBytes += bytes.byteLength;
      const remaining = Math.max(0, limit - capturedBytes);
      if (remaining > 0) {
        const kept = bytes.subarray(0, remaining);
        chunks.push(Buffer.from(kept));
        capturedBytes += kept.byteLength;
      }
    },
    metadata() {
      const bytes = Buffer.concat(chunks, capturedBytes);
      return {
        capturedBytes,
        observedBytes,
        truncated: observedBytes > capturedBytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    },
  });
}

function processError(error) {
  if (!error) return null;
  return { name: String(error.name || "Error").slice(0, 80), code: error.code ? String(error.code).slice(0, 80) : null };
}

function isKnownPid(pid) {
  return Number.isSafeInteger(pid) && pid > 0;
}

async function raceTerminal(terminal, milliseconds) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), milliseconds);
    terminal.then(value => {
      clearTimeout(timer);
      resolve(value);
    });
  });
}

export async function runNativeChild(binary, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const termGraceMs = options.termGraceMs ?? 2_000;
  const killGraceMs = options.killGraceMs ?? 5_000;
  const noHandleGraceMs = options.noHandleGraceMs ?? 2_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_NATIVE_TIMEOUT_MS) {
    throw new Error(`Native child timeout must be between 1 and ${MAX_NATIVE_TIMEOUT_MS} ms`);
  }
  const spawnImpl = options.spawnImpl ?? spawn;
  const stdout = createBoundedCapture();
  const stderr = createBoundedCapture();
  let spawnException = null;
  let child;
  try {
    child = spawnImpl(binary, args, {
      ...(options.spawnOptions ?? {}),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      spawned: false,
      pid: null,
      exitCode: null,
      signal: null,
      terminalObserved: false,
      timedOut: false,
      termination: { attempted: false, signals: [] },
      stdout: stdout.metadata(),
      stderr: stderr.metadata(),
      exception: processError(error),
    };
  }

  child.stdout?.on("data", chunk => stdout.append(chunk));
  child.stderr?.on("data", chunk => stderr.append(chunk));
  const terminal = new Promise(resolve => {
    child.once("error", error => { spawnException = processError(error); });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const pid = isKnownPid(child.pid) ? child.pid : null;
  let terminalResult = await raceTerminal(terminal, timeoutMs);
  const termination = { attempted: false, signals: [] };
  let timedOut = terminalResult === null;

  if (timedOut && pid !== null && typeof child.kill === "function") {
    termination.attempted = true;
    for (const [signal, graceMs] of [["SIGTERM", termGraceMs], ["SIGKILL", killGraceMs]]) {
      let accepted = false;
      try { accepted = child.kill(signal) === true; }
      catch (error) { termination.signals.push({ signal, accepted: false, exception: processError(error) }); }
      if (!termination.signals.some(item => item.signal === signal)) {
        termination.signals.push({ signal, accepted });
      }
      terminalResult = await raceTerminal(terminal, graceMs);
      if (terminalResult !== null) break;
    }
  } else if (timedOut) {
    terminalResult = await raceTerminal(terminal, noHandleGraceMs);
  }

  return {
    spawned: true,
    pid,
    exitCode: terminalResult?.exitCode ?? null,
    signal: terminalResult?.signal ?? null,
    terminalObserved: terminalResult !== null,
    timedOut,
    termination,
    stdout: stdout.metadata(),
    stderr: stderr.metadata(),
    exception: spawnException,
  };
}

function identity(statResult) {
  return `${String(statResult.dev)}:${String(statResult.ino)}`;
}

async function hashFile(path) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function rendererInfoPlist({ executableName, identifier, displayName }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${escapeXml(executableName)}</string>
<key>CFBundleIdentifier</key><string>${escapeXml(identifier)}</string>
<key>CFBundleName</key><string>${escapeXml(displayName)}</string>
<key>CFBundleDisplayName</key><string>${escapeXml(displayName)}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSUIElement</key><false/>
</dict></plist>
`;
}

export async function stageRendererNativeApp({
  binary, runDirectory, autoClear, runId, expectedSha256, mode = "single", settingsSourceSnapshot = null,
}) {
  if (!isAbsolute(binary) || !isAbsolute(runDirectory) || !new Set(["immediately", "never"]).has(autoClear)
      || !new Set(["single", "multiwebview", "settings", "launcher"]).has(mode)
      || (mode === "settings" && !settingsSourceSnapshot)
      || typeof runId !== "string" || !UUID_PATTERN.test(runId)) {
    throw new Error("Invalid renderer app staging inputs");
  }
  const runInfo = await lstat(runDirectory, { bigint: true });
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o077n) !== 0) {
    throw new Error("Renderer output directory must be a private real directory");
  }
  const canonicalRunDirectory = await realpath(runDirectory);
  const identifier = `dev.atools.renderer-smoke.${runId.replaceAll("-", "")}`;
  const displayName = `ATools Renderer QA ${runId.replaceAll("-", "").slice(0, 8)}`;
  const executableName = "AToolsRendererSmoke";
  const bundlePath = join(canonicalRunDirectory, `case-${autoClear}.app`);
  await mkdir(bundlePath, { mode: 0o700 });
  const rootInfo = await lstat(bundlePath, { bigint: true });
  const contentsPath = join(bundlePath, "Contents");
  const executableDirectory = join(contentsPath, "MacOS");
  const resourcesDirectory = join(contentsPath, "Resources");
  const executable = join(executableDirectory, executableName);
  const infoPlistPath = join(contentsPath, "Info.plist");
  const probeResourcePath = join(resourcesDirectory, MULTIWEBVIEW_PROBE_RESOURCE);
  let completed = false;
  try {
    await mkdir(contentsPath, { mode: 0o700 });
    await mkdir(executableDirectory, { mode: 0o700 });
    await mkdir(resourcesDirectory, { mode: 0o700 });
    await copyFile(binary, executable, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
    await chmod(executable, 0o755);
    const stagedSha256 = await hashFile(executable);
    if (stagedSha256 !== expectedSha256) throw new Error("Staged app executable SHA-256 differs from the source binary");
    let probeResource = null;
    if (mode === "multiwebview") {
      await writeFile(probeResourcePath, MULTIWEBVIEW_PROBE_CONTENT, { flag: "wx", mode: 0o600 });
      const probeInfo = await lstat(probeResourcePath, { bigint: true });
      if (!probeInfo.isFile() || probeInfo.isSymbolicLink() || Number(probeInfo.mode & 0o077n) !== 0) {
        throw new Error("Multiwebview resource probe must be a private regular file");
      }
      probeResource = {
        path: `Contents/Resources/${MULTIWEBVIEW_PROBE_RESOURCE}`,
        bytes: Number(probeInfo.size),
        sha256: await hashFile(probeResourcePath),
      };
    }
    const settingsBundle = mode === "settings"
      ? await stageSettingsNativeBundle({ snapshot: settingsSourceSnapshot, appBundlePath: bundlePath })
      : null;
    const infoPlist = rendererInfoPlist({ executableName, identifier, displayName });
    await writeFile(infoPlistPath, infoPlist, { flag: "wx", mode: 0o600 });
    completed = true;
    return {
      bundlePath,
      runDirectory: canonicalRunDirectory,
      executable,
      identifier,
      displayName,
      runId: runId.replaceAll("-", ""),
      sourceSha256: expectedSha256,
      stagedSha256,
      mode,
      probeResource,
      ...(settingsBundle ? { settingsBundle } : {}),
      infoPlist,
      ownerIdentity: identity(rootInfo),
    };
  } finally {
    if (!completed) await cleanupOwnedRendererApp({
      bundlePath, runDirectory: canonicalRunDirectory, ownerIdentity: identity(rootInfo), processTerminal: true,
    });
  }
}

export async function cleanupOwnedRendererApp({ bundlePath, runDirectory, ownerIdentity, processTerminal }) {
  const isDirectApp = isAbsolute(bundlePath) && dirname(bundlePath) === runDirectory
    && /^case-(?:immediately|never)\.app$/.test(bundlePath.slice(runDirectory.length + 1));
  if (!isDirectApp) return { processTerminal, bundleAbsent: null, status: "preserved", reason: "invalid_bundle_path" };
  let before;
  try { before = await lstat(bundlePath, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return { processTerminal, bundleAbsent: true, status: "already_absent", reason: null };
    return { processTerminal, bundleAbsent: null, status: "preserved", reason: error.code || "bundle_inspection_failed" };
  }
  if (!processTerminal) return { processTerminal: false, bundleAbsent: false, status: "not_attempted", reason: "child_not_terminal" };
  if (before.isSymbolicLink() || !before.isDirectory() || identity(before) !== ownerIdentity) {
    return { processTerminal: true, bundleAbsent: false, status: "preserved", reason: "bundle_ownership_mismatch" };
  }
  try {
    const latest = await lstat(bundlePath, { bigint: true });
    if (latest.isSymbolicLink() || !latest.isDirectory() || identity(latest) !== ownerIdentity) {
      return { processTerminal: true, bundleAbsent: false, status: "preserved", reason: "bundle_changed_before_removal" };
    }
    await rm(bundlePath, { recursive: true, force: false, maxRetries: 0 });
    const absent = (await lstatOrNull(bundlePath)) === null;
    return { processTerminal: true, bundleAbsent: absent, status: absent ? "removed_owned_bundle" : "preserved", reason: absent ? null : "bundle_still_exists" };
  } catch (error) {
    const absent = await lstatOrNull(bundlePath).then(value => value === null).catch(() => null);
    return { processTerminal: true, bundleAbsent: absent, status: "preserved", reason: error.code || "bundle_removal_failed" };
  }
}

async function lstatOrNull(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function readJsonNoFollow(path, maxBytes) {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.size > BigInt(maxBytes)) throw new Error("Invalid bounded JSON file");
    return JSON.parse((await handle.readFile()).toString("utf8"));
  } finally {
    await handle.close();
  }
}

function validIdentifier(identifier) {
  const prefix = "dev.atools.renderer-smoke.";
  return typeof identifier === "string" && identifier.startsWith(prefix)
    && UUID_PATTERN.test(identifier.slice(prefix.length));
}

export function markerMatches(marker, root, childPid) {
  return marker && marker.schemaVersion === 1 && marker.pid === childPid
    && marker.root === root && validIdentifier(marker.identifier);
}

function cleanupResult(processTerminal, rootAbsent, status, reason, ownership = "not_checked") {
  return { processTerminal, rootAbsent, status, reason, ownership };
}

export async function cleanupOwnedFixtureRoot({ root, childPid, processTerminal, expectedRootIdentity, expectedMarkerIdentity }) {
  if (!isAbsolute(root) || normalize(root) !== root) {
    return cleanupResult(processTerminal, null, "preserved", "invalid_root_path");
  }
  let rootInfo;
  try { rootInfo = await lstatOrNull(root); }
  catch (error) { return cleanupResult(processTerminal, null, "preserved", error.code || "root_inspection_failed"); }
  if (!rootInfo) return cleanupResult(processTerminal, true, "already_absent", null, "absent");
  if (expectedRootIdentity && identity(rootInfo) !== expectedRootIdentity) return cleanupResult(processTerminal, false, "preserved", "root_identity_changed");
  if (!processTerminal) return cleanupResult(false, false, "not_attempted", "child_not_terminal");
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return cleanupResult(true, false, "preserved", "root_not_real_directory", "invalid");
  }

  const markerPath = join(root, OWNER_MARKER_NAME);
  let markerInfo;
  try { markerInfo = await lstatOrNull(markerPath); }
  catch (error) { return cleanupResult(true, false, "preserved", error.code || "marker_inspection_failed", "invalid"); }

  if (!markerInfo) return cleanupResult(true, false, "preserved", "owner_marker_missing", "missing");
  if (expectedMarkerIdentity && identity(markerInfo) !== expectedMarkerIdentity) return cleanupResult(true, false, "preserved", "marker_identity_changed");

  if (markerInfo.isSymbolicLink() || !markerInfo.isFile()) {
    return cleanupResult(true, false, "preserved", "owner_marker_not_regular_file", "invalid");
  }
  let marker;
  try { marker = await readJsonNoFollow(markerPath, 4096); }
  catch (error) { return cleanupResult(true, false, "preserved", error.code || "owner_marker_invalid", "invalid"); }
  if (!markerMatches(marker, root, childPid)) {
    return cleanupResult(true, false, "preserved", "owner_marker_mismatch", "invalid");
  }

  let rootReal;
  try { rootReal = await realpath(root); }
  catch (error) { return cleanupResult(true, false, "preserved", error.code || "root_realpath_failed", "valid"); }
  for (const name of ["app-data", "webview"]) {
    const path = join(root, name);
    let childInfo;
    try { childInfo = await lstatOrNull(path); }
    catch (error) { return cleanupResult(true, false, "preserved", error.code || `${name}_inspection_failed`, "valid"); }
    if (!childInfo) continue;
    if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
      return cleanupResult(true, false, "preserved", `${name}_not_real_directory`, "valid");
    }
    try {
      if (await realpath(path) !== join(rootReal, name)) {
        return cleanupResult(true, false, "preserved", `${name}_outside_owned_root`, "valid");
      }
    } catch (error) {
      return cleanupResult(true, false, "preserved", error.code || `${name}_realpath_failed`, "valid");
    }
  }

  try {
    const latestRoot = await lstatOrNull(root);
    const latestMarker = await lstatOrNull(markerPath);
    if (!latestRoot || identity(latestRoot) !== identity(rootInfo) || latestRoot.isSymbolicLink()
        || !latestMarker || latestMarker.isSymbolicLink() || identity(latestMarker) !== identity(markerInfo)) {
      return cleanupResult(true, latestRoot === null, "preserved", "ownership_changed_before_removal", "valid");
    }
    const latestMarkerValue = await readJsonNoFollow(markerPath, 4096);
    if (!markerMatches(latestMarkerValue, root, childPid)) {
      return cleanupResult(true, false, "preserved", "owner_marker_changed_before_removal", "invalid");
    }
    await rm(root, { recursive: true, force: false, maxRetries: 0 });
    const absent = (await lstatOrNull(root)) === null;
    return cleanupResult(true, absent, absent ? "removed_owned_root" : "preserved", absent ? null : "root_still_exists", "valid");
  } catch (error) {
    const absent = await lstatOrNull(root).then(value => value === null).catch(() => null);
    return cleanupResult(true, absent, "preserved", error.code || "owned_root_removal_failed", "valid");
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function profileMetadataMismatches(report, marker) {
  const candidates = [];
  for (const value of [report, report.profile, report.profileMetadata, report.metadata,
    report.metadata?.profile, report.metadata?.profileMetadata]) {
    if (isObject(value)) candidates.push(value);
  }
  const ids = candidates.flatMap(value => [value.profileId, value.profileIdentifier, value.identifier]);
  const roots = candidates.flatMap(value => [value.profileRoot, value.fixtureRoot, value.root]);
  return ids.some(value => value !== undefined && value !== marker.identifier)
    || roots.some(value => value !== undefined && value !== marker.root);
}

export function validateNativeReport(report, { autoClear, marker, fixtureRoot, childPid }) {
  const ownerMatches = markerMatches(marker, fixtureRoot, childPid);
  const metadataMatchesOwner = isObject(report) && ownerMatches && !profileMetadataMismatches(report, marker);
  const valid = isObject(report) && report.version === 1 && report.autoClear === autoClear
    && report.passed === true && metadataMatchesOwner;
  return {
    valid,
    version: isObject(report) ? report.version ?? null : null,
    autoClear: isObject(report) ? report.autoClear ?? null : null,
    passed: isObject(report) ? report.passed === true : false,
    metadataMatchesOwner,
  };
}

