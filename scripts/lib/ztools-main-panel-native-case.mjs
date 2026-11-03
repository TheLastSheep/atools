import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  cleanupOwnedFixtureRoot,
  cleanupOwnedRendererApp,
  nativeChildEnvironment,
  readJsonNoFollow,
  runNativeChild,
  stageRendererNativeApp,
} from "./ztools-renderer-native-runtime.mjs";
import { validateMainPanelNativeReport } from "./ztools-main-panel-native-report.mjs";

export const MAIN_PANEL_NATIVE_REPORT_FILENAME = "native-main-panel-report.json";
const MAX_REPORT_BYTES = 1024 * 1024;
const OWNER_KEYS = ["schemaVersion", "pid", "identifier", "root"];
const RUN_ID_PATTERN = /^[0-9a-f]{32}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function isPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function identity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function safeException(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    code: error?.code ? String(error.code).slice(0, 80) : null,
  };
}

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectAbsent(path) {
  try { return (await optionalLstat(path)) === null; }
  catch { return null; }
}

function processTerminal(value, attempted) {
  if (!attempted) return true;
  if (!isRecord(value)) return false;
  if (value.spawned === false) return value.pid == null;
  return value.spawned === true && isPid(value.pid) && value.terminalObserved === true;
}

function processSucceeded(value) {
  return value?.spawned === true && isPid(value.pid) && value.terminalObserved === true
    && value.exitCode === 0 && value.signal === null && value.timedOut === false
    && value.termination?.attempted === false && Array.isArray(value.termination.signals)
    && value.termination.signals.length === 0;
}

function processSummary(value) {
  if (!isRecord(value)) return null;
  const capture = stream => isRecord(stream) ? {
    capturedBytes: stream.capturedBytes ?? null,
    observedBytes: stream.observedBytes ?? null,
    truncated: stream.truncated === true,
    sha256: stream.sha256 ?? null,
  } : null;
  return {
    spawned: value.spawned === true,
    pid: isPid(value.pid) ? value.pid : null,
    terminalObserved: value.terminalObserved === true,
    exitCode: Number.isInteger(value.exitCode) ? value.exitCode : null,
    signal: typeof value.signal === "string" ? value.signal : null,
    timedOut: value.timedOut === true,
    termination: isRecord(value.termination) ? {
      attempted: value.termination.attempted === true,
      signals: Array.isArray(value.termination.signals) ? value.termination.signals.map(item => ({
        signal: typeof item?.signal === "string" ? item.signal : null,
        accepted: item?.accepted === true,
        exception: item?.exception ? safeException(item.exception) : null,
      })) : null,
    } : null,
    stdout: capture(value.stdout),
    stderr: capture(value.stderr),
    exception: value.exception ? safeException(value.exception) : null,
  };
}

async function readOwnedPlist(path, expectedIdentity) {
  const before = await optionalLstat(path);
  if (!before || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > 16_384n || Number(before.mode & 0o777n) !== 0o600) return null;
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || identity(opened) !== identity(before)
        || expectedIdentity && identity(before) !== expectedIdentity) return null;
    const text = (await handle.readFile()).toString("utf8");
    const after = await optionalLstat(path);
    if (!after || after.isSymbolicLink() || identity(after) !== identity(before)) return null;
    return text;
  } finally {
    await handle.close();
  }
}

async function validateStagedApp(staged, { binaryFingerprint, runDirectory, bundlePath, identifier, runId }) {
  if (!isRecord(staged) || staged.bundlePath !== bundlePath || staged.runDirectory !== runDirectory
      || staged.identifier !== identifier
      || staged.runId !== runId || staged.mode !== "single" || staged.probeResource !== null
      || staged.sourceSha256 !== binaryFingerprint.sha256 || staged.stagedSha256 !== binaryFingerprint.sha256
      || !SHA256_PATTERN.test(staged.sourceSha256) || !SHA256_PATTERN.test(staged.stagedSha256)
      || !staged.ownerIdentity || typeof staged.ownerIdentity !== "string"
      || ![undefined, null].includes(staged.settingsBundle)
      || ![undefined, null].includes(staged.fallbackSettingsBundle)
      || ![undefined, null].includes(staged.builtinControl)
      || ![undefined, null].includes(staged.nodeBundle)
      || ![undefined, null].includes(staged.pluginResources)) return false;

  const bundleInfo = await optionalLstat(bundlePath);
  if (!bundleInfo || !bundleInfo.isDirectory() || bundleInfo.isSymbolicLink()
      || Number(bundleInfo.mode & 0o777n) !== 0o700 || identity(bundleInfo) !== staged.ownerIdentity
      || await realpath(bundlePath) !== bundlePath) return false;
  const executable = join(bundlePath, "Contents", "MacOS", "AToolsRendererSmoke");
  if (staged.executable !== executable) return false;
  const executableInfo = await optionalLstat(executable);
  if (!executableInfo || !executableInfo.isFile() || executableInfo.isSymbolicLink()
      || Number(executableInfo.mode & 0o777n) !== 0o755) return false;
  const plist = await readOwnedPlist(join(bundlePath, "Contents", "Info.plist"));
  return typeof plist === "string" && plist.includes("<key>LSUIElement</key><false/>")
    && plist.includes(`<key>CFBundleIdentifier</key><string>${identifier}</string>`)
    && !plist.includes("<key>LSBackgroundOnly</key>");
}

async function inspectProfileOwner({ root, runId, pid, identifier }) {
  const invalid = reason => ({
    valid: false, pidMatches: false, identifierMatches: false, rootMatches: false, reason,
  });
  if (!RUN_ID_PATTERN.test(runId) || root !== `/private/tmp/atools-renderer-smoke-${runId}`
      || dirname(root) !== "/private/tmp" || normalize(root) !== root || !isPid(pid)) {
    return invalid("owner-input-invalid");
  }
  const before = await optionalLstat(root);
  if (!before || before.isSymbolicLink() || !before.isDirectory() || Number(before.mode & 0o777n) !== 0o700) {
    return invalid("root-invalid");
  }
  if (await realpath("/private/tmp") !== "/private/tmp" || await realpath(root) !== root) {
    return invalid("root-not-canonical");
  }
  const markerPath = join(root, OWNER_MARKER_NAME);
  const markerInfo = await optionalLstat(markerPath);
  if (!markerInfo || markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.nlink !== 1n
      || markerInfo.size > 4096n || Number(markerInfo.mode & 0o777n) !== 0o600) {
    return invalid("marker-invalid");
  }
  const marker = await readJsonNoFollow(markerPath, 4096).catch(() => null);
  const markerAfter = await optionalLstat(markerPath);
  const rootAfter = await optionalLstat(root);
  const pidMatches = marker?.pid === pid;
  const identifierMatches = marker?.identifier === identifier;
  const rootMatches = marker?.root === root;
  if (!exactKeys(marker, OWNER_KEYS) || marker.schemaVersion !== 1 || !pidMatches
      || !identifierMatches || !rootMatches || !markerAfter || markerAfter.isSymbolicLink()
      || identity(markerInfo) !== identity(markerAfter) || !rootAfter || rootAfter.isSymbolicLink()
      || identity(before) !== identity(rootAfter)) return {
    valid: false, pidMatches, identifierMatches, rootMatches, reason: "marker-owner-mismatch",
  };
  for (const name of ["app-data", "webview"]) {
    const child = await optionalLstat(join(root, name));
    if (!child || child.isSymbolicLink() || !child.isDirectory()
        || Number(child.mode & 0o777n) !== 0o700 || await realpath(join(root, name)) !== join(root, name)) {
      return { valid: false, pidMatches, identifierMatches, rootMatches, reason: "profile-child-invalid" };
    }
  }
  return { valid: true, pidMatches, identifierMatches, rootMatches, reason: null };
}

async function readNativeReport(path, owner) {
  const info = await optionalLstat(path);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n
      || info.size > BigInt(MAX_REPORT_BYTES) || Number(info.mode & 0o777n) !== 0o600) {
    return { exists: Boolean(info), value: null, validation: { valid: false, passed: false, errors: ["native-report-missing-or-invalid"] } };
  }
  const value = await readJsonNoFollow(path, MAX_REPORT_BYTES).catch(() => null);
  if (value === null) return {
    exists: true, value: null, validation: { valid: false, passed: false, errors: ["native-report-unreadable"] },
  };
  try {
    const validation = validateMainPanelNativeReport(value, owner);
    return { exists: true, value, validation };
  } catch (error) {
    return {
      exists: true,
      value,
      validation: { valid: false, passed: false, errors: ["native-report-validator-failed"] },
      exception: safeException(error),
    };
  }
}

async function preservedPath(path, processIsTerminal, absentKey) {
  const absent = await inspectAbsent(path);
  return {
    processTerminal: processIsTerminal,
    [absentKey]: absent,
    status: absent === true ? "already_absent" : "preserved",
    reason: absent === true ? null : absent === null ? "path-inspection-failed" : "cleanup-unconfirmed",
  };
}

function validInputs({ runDirectory, workspaceRoot, binaryFingerprint, rendererDist, runId }) {
  return RUN_ID_PATTERN.test(runId)
    && [runDirectory, workspaceRoot, rendererDist, binaryFingerprint?.path]
      .every(value => typeof value === "string" && isAbsolute(value) && normalize(value) === value)
    && SHA256_PATTERN.test(binaryFingerprint?.sha256 ?? "");
}

export function buildMainPanelNativeArgs({ fixtureRoot, rendererDist, output, runId }) {
  if (!RUN_ID_PATTERN.test(runId) || fixtureRoot !== `/private/tmp/atools-renderer-smoke-${runId}`
      || ![rendererDist, output].every(value => typeof value === "string" && isAbsolute(value))) {
    throw new Error("Invalid main-panel native case arguments");
  }
  const args = buildNativeCaseArgs({
    fixtureRoot, rendererDist, output, autoClear: "never", runId, mode: "single",
  });
  args.push("--journey", "main-panel");
  return args;
}

export async function runMainPanelNativeCase({
  runDirectory, workspaceRoot, binaryFingerprint, rendererDist, runId,
  stageBundle = stageRendererNativeApp,
  runProcess = runNativeChild,
}) {
  const validRunId = typeof runId === "string" && RUN_ID_PATTERN.test(runId);
  const fixtureRoot = validRunId ? `/private/tmp/atools-renderer-smoke-${runId}` : null;
  const identifier = validRunId ? `dev.atools.renderer-smoke.${runId}` : null;
  const hasAbsoluteRunDirectory = typeof runDirectory === "string" && isAbsolute(runDirectory);
  const reportPath = hasAbsoluteRunDirectory
    ? join(runDirectory, MAIN_PANEL_NATIVE_REPORT_FILENAME) : null;
  const bundlePath = hasAbsoluteRunDirectory ? join(runDirectory, "case-never.app") : null;
  const result = {
    runId: validRunId ? runId : null,
    identifier,
    fixtureRoot,
    nativeReportArtifact: MAIN_PANEL_NATIVE_REPORT_FILENAME,
    appBundle: null,
    process: null,
    nativeReport: null,
    profileOwner: null,
    cleanup: {
      processTerminal: null,
      fixtureRoot: null,
      fixtureRootAbsent: null,
      appBundle: null,
      appBundleAbsent: null,
      allOwnedResourcesClean: false,
    },
    exception: null,
    passed: false,
  };
  let staged = null;
  let stagedOwnerValid = false;
  let processResult = null;
  let processAttempted = false;
  try {
    if (!validInputs({ runDirectory, workspaceRoot, binaryFingerprint, rendererDist, runId })) {
      throw new Error("Main-panel case inputs are invalid");
    }
    const runInfo = await optionalLstat(runDirectory);
    if (!runInfo || !runInfo.isDirectory() || runInfo.isSymbolicLink()
        || Number(runInfo.mode & 0o777n) !== 0o700 || await realpath(runDirectory) !== runDirectory
        || await realpath("/private/tmp") !== "/private/tmp") {
      throw new Error("Main-panel run directory or private temp root is invalid");
    }
    if (await inspectAbsent(fixtureRoot) !== true || await inspectAbsent(reportPath) !== true
        || await inspectAbsent(bundlePath) !== true) throw new Error("Main-panel case paths must be fresh");

    staged = await stageBundle({
      binary: binaryFingerprint.path,
      runDirectory,
      autoClear: "never",
      runId,
      expectedSha256: binaryFingerprint.sha256,
      mode: "single",
    });
    stagedOwnerValid = await validateStagedApp(staged, {
      binaryFingerprint, runDirectory, bundlePath, identifier, runId,
    }).catch(() => false);
    if (!stagedOwnerValid) throw new Error("Staged single-window app failed identity or bundle checks");
    result.appBundle = {
      identifier: staged.identifier,
      infoPlistIdentifier: identifier,
      executable: "Contents/MacOS/AToolsRendererSmoke",
      sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256,
      mode: staged.mode,
      probeResource: staged.probeResource,
      settingsBundle: staged.settingsBundle ?? null,
      builtinControl: staged.builtinControl ?? null,
      nodeBundle: staged.nodeBundle ?? null,
      pluginResources: staged.pluginResources ?? null,
    };
    const args = buildMainPanelNativeArgs({ fixtureRoot, rendererDist, output: reportPath, runId });
    processAttempted = true;
    processResult = await runProcess(staged.executable, args, {
      timeoutMs: 75_000,
      spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
    });
    result.process = processSummary(processResult);

    const terminal = processTerminal(processResult, processAttempted);
    if (terminal && processResult?.spawned === true && isPid(processResult.pid)) {
      result.profileOwner = await inspectProfileOwner({
        root: fixtureRoot, runId, pid: processResult.pid, identifier,
      }).catch(error => ({
        valid: false, pidMatches: false, identifierMatches: false, rootMatches: false,
        reason: error?.code ? `owner-check-${String(error.code).slice(0, 40)}` : "owner-check-failed",
      }));
      const report = await readNativeReport(reportPath, {
        root: fixtureRoot, runId, identifier, pid: processResult.pid,
      });
      result.nativeReport = {
        exists: report.exists,
        raw: report.value,
        valid: report.validation.valid === true,
        passed: report.validation.valid === true && report.validation.passed === true,
        errors: Array.isArray(report.validation.errors) ? report.validation.errors : ["native-report-invalid"],
        exception: report.exception ?? null,
      };
    }
  } catch (error) {
    result.exception = safeException(error);
  }

  const terminal = processTerminal(processResult, processAttempted);
  result.cleanup.processTerminal = terminal;
  const noChildWasStarted = !processAttempted
    || processResult?.spawned === false && processResult.pid == null;
  const ownerConfirmed = noChildWasStarted || result.profileOwner?.valid === true;
  const rootCleanupReady = terminal && ownerConfirmed && result.profileOwner?.valid === true;
  const rootCleanupPid = isPid(processResult?.pid) ? processResult.pid : 0;
  result.cleanup.fixtureRoot = rootCleanupReady
    ? await cleanupOwnedFixtureRoot({ root: fixtureRoot, childPid: rootCleanupPid, processTerminal: true })
      .catch(error => ({ processTerminal: true, rootAbsent: null, status: "preserved", reason: error.code || "root-cleanup-failed" }))
    : await preservedPath(fixtureRoot, terminal, "rootAbsent");
  result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;

  const bundleCleanupReady = terminal && ownerConfirmed && stagedOwnerValid && staged;
  result.cleanup.appBundle = bundleCleanupReady
    ? await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath,
      runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity,
      processTerminal: true,
    }).catch(error => ({ processTerminal: true, bundleAbsent: null, status: "preserved", reason: error.code || "bundle-cleanup-failed" }))
    : await preservedPath(bundlePath, terminal, "bundleAbsent");
  result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;
  result.cleanup.allOwnedResourcesClean = terminal === true
    && result.cleanup.fixtureRootAbsent === true && result.cleanup.appBundleAbsent === true;
  result.passed = processSucceeded(processResult) && result.profileOwner?.valid === true
    && result.nativeReport?.valid === true && result.nativeReport.passed === true
    && result.cleanup.allOwnedResourcesClean === true && result.exception === null;
  result.errors = result.nativeReport?.errors ?? [];
  return result;
}
