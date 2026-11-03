import { constants } from "node:fs";
import { open, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  cleanupOwnedRendererApp,
  nativeChildEnvironment,
  readJsonNoFollow,
  runNativeChild,
} from "./ztools-renderer-native-runtime.mjs";
import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";
import { stageSettingsInputNativeBundle, settingsInputBundleIdentifier } from "./ztools-settings-input-native-bundle.mjs";
import { cleanupOwnedSettingsInputFixtureRoot } from "./ztools-settings-input-native-case.mjs";
import {
  MAIN_HOTKEY_RECOVERY_FIRST_REPORT,
  MAIN_HOTKEY_RECOVERY_SECOND_REPORT,
  validateMainHotkeyRecoveryFirst,
  validateMainHotkeyRecoveryPair,
  validateMainHotkeyRecoverySecond,
} from "./ztools-main-hotkey-startup-native-report.mjs";

const OWNER_KEYS = ["schemaVersion", "pid", "identifier", "root"];
const PERMIT_NAME = ".atools-main-hotkey-recovery-resume-permit.json";
const CLAIM_NAME = ".atools-main-hotkey-recovery-resume-claimed";
const MAX_REPORT_BYTES = 64 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function validRunId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function isPid(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function identity(info) {
  return String(info.dev) + ":" + String(info.ino);
}

function safeException(error) {
  return { name: String(error?.name || "Error").slice(0, 80), code: error?.code ? String(error.code).slice(0, 80) : null };
}

function safeProcessSummary(value) {
  if (!value) return null;
  const capture = item => item ? {
    capturedBytes: item.capturedBytes, observedBytes: item.observedBytes,
    truncated: item.truncated === true, sha256: item.sha256,
  } : null;
  return {
    spawned: value.spawned === true, pid: value.pid ?? null,
    terminalObserved: value.terminalObserved === true, exitCode: value.exitCode ?? null,
    signal: value.signal ?? null, timedOut: value.timedOut === true,
    termination: value.termination ? {
      attempted: value.termination.attempted === true,
      signals: Array.isArray(value.termination.signals) ? value.termination.signals.map(item => ({
        signal: item?.signal ?? null, accepted: item?.accepted === true,
        exception: item?.exception ? safeException(item.exception) : null,
      })) : null,
    } : null,
    stdout: capture(value.stdout), stderr: capture(value.stderr),
    exception: value.exception ? safeException(value.exception) : null,
  };
}

function processSucceeded(value) {
  return value?.spawned === true && value.terminalObserved === true && isPid(value.pid)
    && value.exitCode === 0 && value.signal === null && value.timedOut === false
    && value.termination?.attempted === false && Array.isArray(value.termination.signals)
    && value.termination.signals.length === 0;
}

function processTerminal(value) {
  return !value?.spawned || value.terminalObserved === true;
}

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectAbsent(path) {
  try { await lstat(path); return false; }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
}

async function inspectProfileOwner(root, runId, pid) {
  const identifier = settingsInputBundleIdentifier(runId);
  if (!isPid(pid) || root !== "/private/tmp/atools-renderer-settings-input-" + runId
      || dirname(root) !== "/private/tmp" || normalize(root) !== root) return { valid: false };
  const before = await optionalLstat(root);
  if (!before || before.isSymbolicLink() || !before.isDirectory() || Number(before.mode & 0o777n) !== 0o700) {
    return { valid: false };
  }
  if (await realpath("/private/tmp") !== "/private/tmp" || await realpath(root) !== root) return { valid: false };
  const markerPath = join(root, OWNER_MARKER_NAME);
  const markerInfo = await optionalLstat(markerPath);
  if (!markerInfo || markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.nlink !== 1n
      || markerInfo.size > 4096n || Number(markerInfo.mode & 0o777n) !== 0o600) return { valid: false };
  const marker = await readJsonNoFollow(markerPath, 4096).catch(() => null);
  const after = await optionalLstat(root);
  const markerAfter = await optionalLstat(markerPath);
  if (!exactKeys(marker, OWNER_KEYS) || marker.schemaVersion !== 1 || marker.pid !== pid
      || marker.identifier !== identifier || marker.root !== root || !after || !markerAfter
      || after.isSymbolicLink() || markerAfter.isSymbolicLink()
      || identity(before) !== identity(after) || identity(markerInfo) !== identity(markerAfter)) return { valid: false };
  for (const name of ["app-data", "webview"]) {
    const child = await optionalLstat(join(root, name));
    if (child && (child.isSymbolicLink() || !child.isDirectory() || Number(child.mode & 0o777n) !== 0o700)) {
      return { valid: false };
    }
  }
  return { valid: true, pidMatches: true, identifierMatches: true, rootMatches: true };
}

async function writeResumePermit(root, owner) {
  const path = join(root, PERMIT_NAME);
  const bytes = JSON.stringify({
    schemaVersion: 1, journey: "main-hotkey-startup-recovery-resume", runId: owner.runId,
    seedPid: owner.seedPid, identifier: owner.identifier, root: owner.root,
  });
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
  try {
    await handle.writeFile(bytes, "utf8");
    await handle.sync();
    const info = await handle.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600 || info.size > 4096n) {
      throw new Error("resume permit file is invalid");
    }
  } finally {
    await handle.close();
  }
  return path;
}

async function verifyResumePermit(path, owner) {
  const before = await optionalLstat(path);
  if (!before || before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
      || before.size > 4096n || Number(before.mode & 0o777n) !== 0o600) return false;
  const permit = await readJsonNoFollow(path, 4096).catch(() => null);
  const after = await optionalLstat(path);
  return exactKeys(permit, ["schemaVersion", "journey", "runId", "seedPid", "identifier", "root"])
    && permit.schemaVersion === 1 && permit.journey === "main-hotkey-startup-recovery-resume"
    && permit.runId === owner.runId && permit.seedPid === owner.seedPid
    && permit.identifier === owner.identifier && permit.root === owner.root
    && Boolean(after && !after.isSymbolicLink() && identity(before) === identity(after));
}

async function inspectClaim(path) {
  const info = await optionalLstat(path);
  return Boolean(info && !info.isSymbolicLink() && info.isFile() && info.nlink === 1n
    && info.size <= 4096n && Number(info.mode & 0o777n) === 0o600);
}

async function readStageReport(path, validate) {
  const file = await readJsonFile(path, MAX_REPORT_BYTES).catch(error => ({
    exists: false, value: null, exception: safeException(error),
  }));
  const validation = validate(file.value);
  return {
    value: file.value,
    exists: file.exists === true,
    valid: file.exists === true && validation.valid === true,
    passed: file.exists === true && validation.passed === true,
    errors: validation.errors,
    exception: file.exception ? safeException(file.exception) : null,
  };
}

function summarizeStageReport(report) {
  return {
    exists: report.exists, valid: report.valid, passed: report.passed,
    errors: report.errors, exception: report.exception,
  };
}

export function parseMainHotkeyStartupNativeArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!new Set(["--binary", "--build-receipt"]).has(flag) || values.has(flag) || index + 1 >= argv.length) {
      throw new Error("Only --binary and --build-receipt are accepted once each");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--") || !isAbsolute(value)) throw new Error(flag + " must be an absolute path");
    values.set(flag, value);
  }
  const binary = values.get("--binary");
  const buildReceipt = values.get("--build-receipt");
  if (!binary || !buildReceipt) throw new Error("--binary and --build-receipt are required");
  return { binary, buildReceipt };
}

export function buildMainHotkeyRecoveryNativeArgs({ fixtureRoot, rendererDist, output, runId, phase, previousPid }) {
  if (![fixtureRoot, rendererDist, output].every(value => typeof value === "string" && isAbsolute(value))
      || !validRunId(runId) || !new Set(["first", "second"]).has(phase)) {
    throw new Error("Invalid main hotkey startup recovery arguments");
  }
  if (phase === "second" ? !isPid(previousPid) : previousPid !== undefined) {
    throw new Error("Only the second phase accepts the first terminal PID");
  }
  const args = buildNativeCaseArgs({ fixtureRoot, rendererDist, output, autoClear: "never", runId, mode: "single" });
  args.push("--journey", phase === "first" ? "main-hotkey-recovery-first" : "main-hotkey-recovery-second");
  if (phase === "second") args.push("--resume-hotkey-owner-pid", String(previousPid));
  return args;
}

export async function runMainHotkeyStartupNativeCase({
  runDirectory, workspaceRoot, binaryFingerprint, rendererDist, runId, settingsSourceSnapshot, nativeSourceHashes,
  stageBundle = stageSettingsInputNativeBundle, runProcess = runNativeChild,
}) {
  const fixtureRoot = "/private/tmp/atools-renderer-settings-input-" + runId;
  const identifier = settingsInputBundleIdentifier(runId);
  const result = {
    runId, identifier, autoClear: "never", first: null, second: null, appBundle: null,
    resumeHandoff: { permitCreated: false, permitVerified: false, claimConfirmed: false, permitConsumed: false },
    pair: null, cleanup: {
      allProcessesTerminal: null, fixtureRoot: null, fixtureRootAbsent: null,
      appBundle: null, appBundleAbsent: null, allOwnedResourcesClean: false,
    },
    exception: null, passed: false,
  };
  let staged = null;
  let firstProcess = null;
  let secondProcess = null;
  const startedProcesses = [];
  try {
    if (!validRunId(runId) || !isAbsolute(runDirectory) || !isAbsolute(workspaceRoot)
        || !binaryFingerprint || !isAbsolute(binaryFingerprint.path) || !isAbsolute(rendererDist)) {
      throw new Error("Main hotkey recovery case inputs are invalid");
    }
    const runInfo = await lstat(runDirectory, { bigint: true });
    if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o777n) !== 0o700
        || await realpath(runDirectory) !== runDirectory) throw new Error("Main hotkey recovery run directory is not private");
    if (await realpath("/private/tmp") !== "/private/tmp") throw new Error("Fixture parent is not canonical");
    const firstDirectory = join(runDirectory, "first");
    const secondDirectory = join(runDirectory, "second");
    await mkdir(firstDirectory, { mode: 0o700 });
    await mkdir(secondDirectory, { mode: 0o700 });
    const firstOutput = join(firstDirectory, "native-report.json");
    const secondOutput = join(secondDirectory, "native-report.json");
    const bundlePath = join(runDirectory, "case-never.app");
    if (await inspectAbsent(fixtureRoot) !== true || await inspectAbsent(firstOutput) !== true
        || await inspectAbsent(secondOutput) !== true || await inspectAbsent(bundlePath) !== true) {
      throw new Error("Main hotkey recovery artifacts must be fresh");
    }
    staged = await stageBundle({ binaryFingerprint, runDirectory, runId, settingsSourceSnapshot, nativeSourceHashes });
    if (staged.identifier !== identifier || staged.infoPlistIdentifier !== identifier
        || staged.stagedSha256 !== binaryFingerprint.sha256 || staged.sourceSha256 !== binaryFingerprint.sha256
        || staged.bundlePath !== bundlePath) throw new Error("Staged app identity or executable binding is invalid");
    result.appBundle = {
      identifier: staged.identifier, infoPlistIdentifier: staged.infoPlistIdentifier,
      executable: "Contents/MacOS/AToolsRendererSmoke", sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256, settingsBundle: staged.settingsBundle ?? null,
      builtinControl: staged.builtinControl ?? null,
    };

    const firstArgs = buildMainHotkeyRecoveryNativeArgs({
      fixtureRoot, rendererDist, output: firstOutput, runId, phase: "first",
    });
    firstProcess = await runProcess(staged.executable, firstArgs, {
      timeoutMs: 180_000, spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
    });
    startedProcesses.push(firstProcess);
    const firstReportPath = join(firstDirectory, MAIN_HOTKEY_RECOVERY_FIRST_REPORT);
    const firstReport = await readStageReport(firstReportPath, report =>
      validateMainHotkeyRecoveryFirst(report, firstProcess, { runId, identifier, root: fixtureRoot }));
    const firstOwner = processTerminal(firstProcess) && isPid(firstProcess?.pid)
      ? await inspectProfileOwner(fixtureRoot, runId, firstProcess.pid).catch(() => ({ valid: false }))
      : { valid: false };
    result.first = { process: safeProcessSummary(firstProcess), report: summarizeStageReport(firstReport), profileOwner: firstOwner };

    if (processSucceeded(firstProcess) && firstReport.passed && firstOwner.valid) {
      const permitPath = join(fixtureRoot, PERMIT_NAME);
      const claimPath = join(fixtureRoot, CLAIM_NAME);
      if (await inspectAbsent(permitPath) !== true || await inspectAbsent(claimPath) !== true) {
        throw new Error("Resume handoff files must be absent before transfer");
      }
      await writeResumePermit(fixtureRoot, {
        runId, seedPid: firstProcess.pid, identifier, root: fixtureRoot,
      });
      result.resumeHandoff.permitCreated = true;
      result.resumeHandoff.permitVerified = await verifyResumePermit(permitPath, {
        runId, seedPid: firstProcess.pid, identifier, root: fixtureRoot,
      });
      if (!result.resumeHandoff.permitVerified) throw new Error("Resume permit did not match the frozen owner data");
      const secondArgs = buildMainHotkeyRecoveryNativeArgs({
        fixtureRoot, rendererDist, output: secondOutput, runId, phase: "second", previousPid: firstProcess.pid,
      });
      secondProcess = await runProcess(staged.executable, secondArgs, {
        timeoutMs: 180_000, spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
      });
      startedProcesses.push(secondProcess);
      const secondReportPath = join(secondDirectory, MAIN_HOTKEY_RECOVERY_SECOND_REPORT);
      const secondReport = await readStageReport(secondReportPath, report =>
        validateMainHotkeyRecoverySecond(report, secondProcess, { runId, identifier, root: fixtureRoot }));
      const secondOwner = processTerminal(secondProcess) && isPid(secondProcess?.pid)
        ? await inspectProfileOwner(fixtureRoot, runId, secondProcess.pid).catch(() => ({ valid: false }))
        : { valid: false };
      const claimConfirmed = await inspectClaim(claimPath).catch(() => false);
      const permitConsumed = await inspectAbsent(permitPath).catch(() => false);
      result.second = { process: safeProcessSummary(secondProcess), report: summarizeStageReport(secondReport), profileOwner: secondOwner };
      result.resumeHandoff.claimConfirmed = claimConfirmed;
      result.resumeHandoff.permitConsumed = permitConsumed;
      if (secondReport.exists && firstReport.exists) {
        result.pair = validateMainHotkeyRecoveryPair({
          firstReport: firstReport.value, secondReport: secondReport.value,
          firstProcess, secondProcess, expectedOwner: { runId, identifier, root: fixtureRoot },
        });
      }
      if (secondOwner.valid !== true) result.second.profileOwner.valid = false;
    }
  } catch (error) {
    result.exception = safeException(error);
  }

  const allTerminal = startedProcesses.every(processTerminal);
  result.cleanup.allProcessesTerminal = allTerminal;
  const terminalPids = startedProcesses.filter(process => processTerminal(process) && isPid(process?.pid))
    .map(process => process.pid);
  let cleanupPid = terminalPids.at(-1) ?? terminalPids[0] ?? 0;
  for (const pid of terminalPids) {
    if ((await inspectProfileOwner(fixtureRoot, runId, pid).catch(() => ({ valid: false }))).valid) cleanupPid = pid;
  }
  result.cleanup.fixtureRoot = await cleanupOwnedSettingsInputFixtureRoot({
    root: fixtureRoot, runId, childPid: cleanupPid, processTerminal: allTerminal,
  }).catch(error => ({ processTerminal: allTerminal, rootAbsent: null, status: "preserved", reason: error.code || "cleanup-failed" }));
  result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
  if (staged) {
    result.cleanup.appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath, runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity, processTerminal: allTerminal,
    }).catch(error => ({ processTerminal: allTerminal, bundleAbsent: null, status: "preserved", reason: error.code || "cleanup-failed" }));
  } else {
    result.cleanup.appBundleAbsent = await inspectAbsent(join(runDirectory, "case-never.app")).catch(() => null);
    result.cleanup.appBundle = {
      processTerminal: allTerminal, bundleAbsent: result.cleanup.appBundleAbsent,
      status: result.cleanup.appBundleAbsent === true ? "not-created-or-stage-cleaned" : "preserved",
      reason: result.cleanup.appBundleAbsent === true ? null : "bundle-ownership-unavailable",
    };
  }
  if (staged) result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;
  result.cleanup.allOwnedResourcesClean = allTerminal === true && result.cleanup.fixtureRootAbsent === true
    && result.cleanup.appBundleAbsent === true;
  result.passed = result.exception === null && processSucceeded(firstProcess) && processSucceeded(secondProcess)
    && result.first?.report?.passed === true && result.second?.report?.passed === true
    && result.first?.profileOwner?.valid === true && result.second?.profileOwner?.valid === true
    && result.resumeHandoff.permitCreated && result.resumeHandoff.permitVerified
    && result.resumeHandoff.claimConfirmed && result.resumeHandoff.permitConsumed
    && result.pair?.passed === true && result.cleanup.allOwnedResourcesClean;
  return result;
}
