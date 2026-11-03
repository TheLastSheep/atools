import { constants } from "node:fs";
import { lstat, open, realpath, rm } from "node:fs/promises";
import { isAbsolute, dirname, join, normalize } from "node:path";
import {
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  cleanupOwnedRendererApp,
  nativeChildEnvironment,
  readJsonNoFollow,
  runNativeChild,
} from "./ztools-renderer-native-runtime.mjs";
import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";
import { fingerprintNativeExecutable } from "./ztools-renderer-native-source-binding.mjs";
import { stageSettingsInputNativeBundle } from "./ztools-settings-input-native-bundle.mjs";
import {
  BUILTIN_STATE_MAIN_REPORT_FILENAME,
  BUILTIN_STATE_SEED_REPORT_FILENAME,
  validateBuiltinStateNativeReports,
  validateBuiltinStateSeedReport,
} from "./ztools-builtin-state-native-report.mjs";

const RESUME_PERMIT_NAME = ".atools-builtin-state-resume-permit.json";
const OWNER_KEYS = Object.freeze(["schemaVersion", "pid", "identifier", "root"]);
const PERMIT_KEYS = Object.freeze(["schemaVersion", "journey", "runId", "seedPid", "identifier", "root"]);

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validRunId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function directoryIdentity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function expectedOwner(runId) {
  return {
    runId,
    identifier: `dev.atools.renderer-settings-input.${runId}`,
    root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  };
}

export function buildBuiltinStateNativeArgs({
  fixtureRoot, rendererDist, output, runId, journey, resumeSeedPid = null,
}) {
  if (!validRunId(runId)) throw new Error("runId must be a lowercase UUID");
  const args = buildNativeCaseArgs({ fixtureRoot, rendererDist, output, autoClear: "never", runId, mode: "single" });
  if (journey === "builtin-state-seed") {
    if (resumeSeedPid !== null) throw new Error("seed journey cannot resume another process");
    args.push("--journey", "builtin-state-seed");
    return args;
  }
  if (journey === "builtin-state") {
    if (!Number.isSafeInteger(resumeSeedPid) || resumeSeedPid <= 0) {
      throw new Error("Main journey requires the terminal seed PID");
    }
    args.push("--journey", "builtin-state", "--resume-seed-pid", String(resumeSeedPid));
    return args;
  }
  throw new Error("journey must be builtin-state-seed or builtin-state");
}

async function inspectOwnedRoot({ root, runId, expectedPid }) {
  const owner = expectedOwner(runId);
  if (!validRunId(runId) || root !== owner.root || dirname(root) !== "/private/tmp"
      || normalize(root) !== root || (expectedPid !== null
        && (!Number.isSafeInteger(expectedPid) || expectedPid <= 0))) {
    return { valid: false, reason: "invalid-owner-inputs" };
  }
  const rootInfo = await optionalLstat(root);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()
      || Number(rootInfo.mode & 0o777n) !== 0o700) return { valid: false, reason: "root-not-private-directory" };
  if (await realpath("/private/tmp") !== "/private/tmp" || await realpath(root) !== root) {
    return { valid: false, reason: "root-not-direct-temp-child" };
  }
  const markerPath = join(root, OWNER_MARKER_NAME);
  const markerInfo = await optionalLstat(markerPath);
  if (!markerInfo || markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.nlink !== 1n
      || markerInfo.size > 4096n || Number(markerInfo.mode & 0o777n) !== 0o600) {
    return { valid: false, reason: "owner-marker-invalid" };
  }
  const marker = await readJsonNoFollow(markerPath, 4096).catch(() => null);
  const markerAfter = await optionalLstat(markerPath);
  const rootAfter = await optionalLstat(root);
  if (!exactKeys(marker, OWNER_KEYS) || marker.schemaVersion !== 1
      || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
      || expectedPid !== null && marker.pid !== expectedPid
      || marker.identifier !== owner.identifier || marker.root !== root
      || !markerAfter || markerAfter.isSymbolicLink() || directoryIdentity(markerInfo) !== directoryIdentity(markerAfter)
      || !rootAfter || rootAfter.isSymbolicLink() || directoryIdentity(rootInfo) !== directoryIdentity(rootAfter)) {
    return { valid: false, reason: "owner-marker-mismatch" };
  }
  const children = {};
  for (const name of ["app-data", "webview"]) {
    const childPath = join(root, name);
    const childInfo = await optionalLstat(childPath);
    if (!childInfo || childInfo.isSymbolicLink() || !childInfo.isDirectory()
        || Number(childInfo.mode & 0o777n) !== 0o700 || await realpath(childPath) !== join(root, name)) {
      return { valid: false, reason: "owned-child-directory-invalid" };
    }
    children[name] = directoryIdentity(childInfo);
  }
  return { valid: true, rootInfo, markerInfo, markerPath, marker, children };
}

function sameChildren(left, right) {
  return left && right && ["app-data", "webview"].every(name => left[name] === right[name]);
}

async function writeResumePermit({ root, runId, seedPid, ownerSnapshot }) {
  if (!ownerSnapshot?.valid || ownerSnapshot.marker.pid !== seedPid) {
    throw new Error("Seed owner must be verified before resume permit creation");
  }
  const currentOwner = await inspectOwnedRoot({ root, runId, expectedPid: seedPid });
  if (!currentOwner.valid || directoryIdentity(currentOwner.rootInfo) !== directoryIdentity(ownerSnapshot.rootInfo)
      || directoryIdentity(currentOwner.markerInfo) !== directoryIdentity(ownerSnapshot.markerInfo)
      || !sameChildren(currentOwner.children, ownerSnapshot.children)) {
    throw new Error("Seed owner changed before resume permit creation");
  }
  const permit = {
    schemaVersion: 1,
    journey: "builtin-state-resume",
    runId,
    seedPid,
    identifier: expectedOwner(runId).identifier,
    root,
  };
  if (!exactKeys(permit, PERMIT_KEYS)) throw new Error("Resume permit schema mismatch");
  const path = join(root, RESUME_PERMIT_NAME);
  if (await optionalLstat(path) !== null) throw new Error("Resume permit path must be fresh");
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await handle.writeFile(JSON.stringify(permit), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  const info = await optionalLstat(path);
  const rootAfter = await optionalLstat(root);
  const permitAfter = await readJsonNoFollow(path, 4096).catch(() => null);
  const permitInfoAfter = await optionalLstat(path);
  const ownerAfter = await inspectOwnedRoot({ root, runId, expectedPid: seedPid }).catch(() => ({ valid: false }));
  if (!info || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n
      || info.size > 4096n || Number(info.mode & 0o777n) !== 0o600
      || !rootAfter || rootAfter.isSymbolicLink()
      || !permitInfoAfter || permitInfoAfter.isSymbolicLink()
      || directoryIdentity(info) !== directoryIdentity(permitInfoAfter)
      || directoryIdentity(ownerSnapshot.rootInfo) !== directoryIdentity(rootAfter)
      || !exactKeys(permitAfter, PERMIT_KEYS) || permitAfter.schemaVersion !== 1
      || permitAfter.journey !== "builtin-state-resume" || permitAfter.runId !== runId
      || permitAfter.seedPid !== seedPid || permitAfter.identifier !== expectedOwner(runId).identifier
      || permitAfter.root !== root || !ownerAfter.valid
      || directoryIdentity(ownerSnapshot.markerInfo) !== directoryIdentity(ownerAfter.markerInfo)
      || !sameChildren(ownerSnapshot.children, ownerAfter.children)) {
    throw new Error("Resume permit was not created safely");
  }
  return path;
}

function processSummary(value) {
  if (!value) return null;
  return {
    spawned: value.spawned === true,
    pid: value.pid ?? null,
    terminalObserved: value.terminalObserved === true,
    exitCode: value.exitCode ?? null,
    signal: value.signal ?? null,
    timedOut: value.timedOut === true,
    termination: value.termination ? {
      attempted: value.termination.attempted === true,
      signals: Array.isArray(value.termination.signals) ? value.termination.signals.map(item => ({
        signal: item?.signal ?? null,
        accepted: item?.accepted === true,
        exception: item?.exception ? { name: item.exception.name, code: item.exception.code } : null,
      })) : [],
    } : null,
    exception: value.exception ? { name: value.exception.name, code: value.exception.code } : null,
  };
}

function processTerminal(value) {
  return !value || value.spawned !== true || value.terminalObserved === true;
}

function terminalPids(processes) {
  return [...new Set(processes.filter(value => value?.spawned === true && value.terminalObserved === true
    && Number.isSafeInteger(value.pid) && value.pid > 0).map(value => value.pid))];
}

/** Remove this profile only after every spawned child is terminal and the marker belongs to one of them. */
export async function cleanupOwnedBuiltinStateFixtureRoot({ root, runId, processes }) {
  const terminal = processes.every(processTerminal);
  const absent = await optionalLstat(root).catch(() => undefined);
  if (absent === null) return { processTerminal: terminal, rootAbsent: true, status: "already_absent", reason: null };
  if (absent === undefined) return { processTerminal: terminal, rootAbsent: null, status: "preserved", reason: "root-inspection-failed" };
  if (!terminal) return { processTerminal: false, rootAbsent: false, status: "not_attempted", reason: "child-not-terminal" };
  const allowedPids = terminalPids(processes);
  if (allowedPids.length === 0) return { processTerminal: true, rootAbsent: false, status: "preserved", reason: "no-terminal-owner-pid" };
  const owner = await inspectOwnedRoot({ root, runId, expectedPid: null }).catch(error => ({
    valid: false, reason: error.code || "owner-inspection-failed",
  }));
  if (!owner.valid || !allowedPids.includes(owner.marker.pid)) {
    return { processTerminal: true, rootAbsent: false, status: "preserved", reason: owner.valid ? "owner-pid-not-in-case" : owner.reason };
  }
  const latestRoot = await optionalLstat(root);
  const latestMarker = await optionalLstat(owner.markerPath);
  if (!latestRoot || !latestMarker || latestRoot.isSymbolicLink() || latestMarker.isSymbolicLink()
      || directoryIdentity(latestRoot) !== directoryIdentity(owner.rootInfo)
      || directoryIdentity(latestMarker) !== directoryIdentity(owner.markerInfo)) {
    return { processTerminal: true, rootAbsent: latestRoot === null, status: "preserved", reason: "ownership-changed-before-removal" };
  }
  for (const name of ["app-data", "webview"]) {
    const childInfo = await optionalLstat(join(root, name));
    if (!childInfo || childInfo.isSymbolicLink() || !childInfo.isDirectory()
        || directoryIdentity(childInfo) !== owner.children[name]) {
      return { processTerminal: true, rootAbsent: false, status: "preserved", reason: "owned-child-changed-before-removal" };
    }
  }
  const marker = await readJsonNoFollow(owner.markerPath, 4096).catch(() => null);
  const markerAfter = await optionalLstat(owner.markerPath);
  const rootAfter = await optionalLstat(root);
  if (!exactKeys(marker, OWNER_KEYS) || marker.schemaVersion !== 1 || !allowedPids.includes(marker.pid)
      || !markerAfter || markerAfter.isSymbolicLink()
      || directoryIdentity(latestMarker) !== directoryIdentity(markerAfter)
      || !rootAfter || rootAfter.isSymbolicLink()
      || directoryIdentity(latestRoot) !== directoryIdentity(rootAfter)
      || marker.identifier !== expectedOwner(runId).identifier || marker.root !== root) {
    return { processTerminal: true, rootAbsent: false, status: "preserved", reason: "owner-marker-changed-before-removal" };
  }
  try {
    await rm(root, { recursive: true, force: false, maxRetries: 0 });
    const rootAbsent = (await optionalLstat(root)) === null;
    return { processTerminal: true, rootAbsent, status: rootAbsent ? "removed_owned_root" : "preserved",
      reason: rootAbsent ? null : "root-still-exists" };
  } catch (error) {
    const rootAbsent = await optionalLstat(root).then(value => value === null).catch(() => null);
    return { processTerminal: true, rootAbsent, status: "preserved", reason: error.code || "root-removal-failed" };
  }
}

async function inspectAbsent(path) {
  const info = await optionalLstat(path).catch(() => undefined);
  return info === null ? true : info === undefined ? null : false;
}

async function readNativeReport(path) {
  return readJsonFile(path, 32 * 1024);
}

/** Runs a seed process to terminal, validates its receipt, then starts a cold Main against the same DB. */
export async function runBuiltinStateNativeCase({
  runDirectory,
  workspaceRoot,
  binaryFingerprint,
  rendererDist,
  runId,
  settingsSourceSnapshot,
  nativeSourceHashes,
  launchChild = runNativeChild,
}) {
  const owner = expectedOwner(runId);
  const bundlePath = join(runDirectory, "case-never.app");
  const seedReportPath = join(runDirectory, BUILTIN_STATE_SEED_REPORT_FILENAME);
  const mainReportPath = join(runDirectory, BUILTIN_STATE_MAIN_REPORT_FILENAME);
  const result = {
    runId,
    identifier: owner.identifier,
    root: owner.root,
    appBundle: null,
    seed: {
      reportArtifact: BUILTIN_STATE_SEED_REPORT_FILENAME,
      process: null, reportExists: false, reportValid: false, passed: false, errors: [], summary: null,
    },
    main: {
      reportArtifact: BUILTIN_STATE_MAIN_REPORT_FILENAME,
      process: null, reportExists: false, reportValid: false, passed: false, errors: [], summary: null,
    },
    cleanup: {
      processesTerminal: null,
      fixtureRoot: null,
      appBundle: null,
      allOwnedResourcesClean: false,
    },
    exception: null,
    passed: false,
  };
  const processes = [];
  let staged = null;
  let stagedBinaryBefore = null;
  let seedReport = null;
  let mainReport = null;
  let pairValidation = null;
  let stagedBinaryStable = false;
  try {
    if (!validRunId(runId) || await inspectAbsent(owner.root) !== true
        || await inspectAbsent(bundlePath) !== true || await inspectAbsent(seedReportPath) !== true
        || await inspectAbsent(mainReportPath) !== true) {
      throw new Error("Builtin-state case artifacts and fixture root must be fresh");
    }
    staged = await stageSettingsInputNativeBundle({
      binaryFingerprint, runDirectory, runId, settingsSourceSnapshot, nativeSourceHashes,
    });
    if (staged.identifier !== owner.identifier || staged.infoPlistIdentifier !== owner.identifier
        || staged.sourceSha256 !== binaryFingerprint.sha256 || staged.stagedSha256 !== binaryFingerprint.sha256
        || staged.settingsBundle?.staged !== true) {
      throw new Error("Builtin-state bundle identity or staged source binding is incomplete");
    }
    stagedBinaryBefore = await fingerprintNativeExecutable(staged.executable);
    if (stagedBinaryBefore.sha256 !== staged.stagedSha256
        || stagedBinaryBefore.sizeBytes !== binaryFingerprint.sizeBytes) {
      throw new Error("Staged executable fingerprint differs from the bound source binary");
    }
    result.appBundle = {
      identifier: staged.identifier,
      infoPlistIdentifier: staged.infoPlistIdentifier,
      executable: "Contents/MacOS/AToolsRendererSmoke",
      sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256,
      builtinControl: staged.builtinControl,
      settingsBundle: staged.settingsBundle,
    };

    const seedArgs = buildBuiltinStateNativeArgs({
      fixtureRoot: owner.root, rendererDist, output: seedReportPath, runId, journey: "builtin-state-seed",
    });
    const seedProcess = await launchChild(staged.executable, seedArgs, {
      timeoutMs: 180_000,
      spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
    });
    processes.push(seedProcess);
    result.seed.process = processSummary(seedProcess);
    if (seedProcess.spawned && seedProcess.terminalObserved && Number.isSafeInteger(seedProcess.pid)) {
      const [file, ownerState] = await Promise.all([
        readNativeReport(seedReportPath),
        inspectOwnedRoot({ root: owner.root, runId, expectedPid: seedProcess.pid }).catch(error => ({
          valid: false, reason: error.code || "owner-inspection-failed",
        })),
      ]);
      result.seed.reportExists = file.exists === true;
      seedReport = file.value;
      const validation = validateBuiltinStateSeedReport(seedReport, processSummary(seedProcess), owner);
      result.seed.reportValid = validation.valid === true && ownerState.valid === true;
      result.seed.passed = validation.passed === true && ownerState.valid === true;
      result.seed.errors = [...new Set([
        ...validation.errors,
        ...(file.exists === true ? [] : ["builtin-state-seed-report-missing"]),
        ...(ownerState.valid ? [] : ["builtin-state-seed-owner-invalid"]),
      ])];
      result.seed.summary = validation.summary;

      const afterSeedBinary = await fingerprintNativeExecutable(staged.executable).catch(() => null);
      stagedBinaryStable = Boolean(afterSeedBinary && afterSeedBinary.sha256 === staged.stagedSha256
        && afterSeedBinary.sizeBytes === stagedBinaryBefore.sizeBytes
        && afterSeedBinary.mtimeNs === stagedBinaryBefore.mtimeNs
        && afterSeedBinary.device === stagedBinaryBefore.device && afterSeedBinary.inode === stagedBinaryBefore.inode);
      if (result.seed.passed && stagedBinaryStable) {
        await writeResumePermit({ root: owner.root, runId, seedPid: seedProcess.pid, ownerSnapshot: ownerState });
        const mainArgs = buildBuiltinStateNativeArgs({
          fixtureRoot: owner.root,
          rendererDist,
          output: mainReportPath,
          runId,
          journey: "builtin-state",
          resumeSeedPid: seedProcess.pid,
        });
        const mainProcess = await launchChild(staged.executable, mainArgs, {
          timeoutMs: 180_000,
          spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
        });
        processes.push(mainProcess);
        result.main.process = processSummary(mainProcess);
        if (mainProcess.spawned && mainProcess.terminalObserved) {
          const afterMainBinary = await fingerprintNativeExecutable(staged.executable).catch(() => null);
          stagedBinaryStable = stagedBinaryStable && Boolean(afterMainBinary
            && afterMainBinary.sha256 === staged.stagedSha256
            && afterMainBinary.sizeBytes === stagedBinaryBefore.sizeBytes
            && afterMainBinary.mtimeNs === stagedBinaryBefore.mtimeNs
            && afterMainBinary.device === stagedBinaryBefore.device
            && afterMainBinary.inode === stagedBinaryBefore.inode);
        }
        if (mainProcess.spawned && mainProcess.terminalObserved && Number.isSafeInteger(mainProcess.pid)) {
          const [file, ownerAfterMain] = await Promise.all([
            readNativeReport(mainReportPath),
            inspectOwnedRoot({ root: owner.root, runId, expectedPid: mainProcess.pid }).catch(error => ({
              valid: false, reason: error.code || "owner-inspection-failed",
            })),
          ]);
          result.main.reportExists = file.exists === true;
          mainReport = file.value;
          pairValidation = validateBuiltinStateNativeReports({
            seedReport, mainReport, seedProcess: processSummary(seedProcess),
            mainProcess: processSummary(mainProcess), expectedOwner: owner,
          });
          result.main.reportValid = pairValidation.valid === true && ownerAfterMain.valid === true;
          result.main.passed = pairValidation.passed === true && ownerAfterMain.valid === true;
          result.main.errors = [...new Set([
            ...pairValidation.errors,
            ...(file.exists === true ? [] : ["builtin-state-main-report-missing"]),
            ...(ownerAfterMain.valid ? [] : ["builtin-state-main-owner-invalid"]),
          ])];
          result.main.summary = pairValidation.summary.main;
        } else {
          result.main.errors.push("builtin-state-main-process-not-terminal-or-pid-invalid");
        }
      } else {
        if (!stagedBinaryStable) result.seed.errors.push("builtin-state-staged-binary-changed");
        if (!result.seed.passed) result.main.errors.push("builtin-state-main-not-started-seed-invalid");
      }
    } else {
      result.seed.errors.push("builtin-state-seed-process-not-terminal-or-pid-invalid");
      result.main.errors.push("builtin-state-main-not-started-seed-invalid");
    }
  } catch (error) {
    result.exception = {
      name: String(error?.name || "Error").slice(0, 80),
      code: error?.code ? String(error.code).slice(0, 80) : null,
    };
  }

  const allTerminal = processes.every(processTerminal);
  result.cleanup.processesTerminal = allTerminal;
  result.cleanup.fixtureRoot = await cleanupOwnedBuiltinStateFixtureRoot({
    root: owner.root, runId, processes,
  }).catch(error => ({
    processTerminal: allTerminal,
    rootAbsent: null,
    status: "preserved",
    reason: error.code || "fixture-cleanup-failed",
  }));
  if (staged) {
    result.cleanup.appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath,
      runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity,
      processTerminal: allTerminal,
    }).catch(async error => ({
      processTerminal: allTerminal,
      bundleAbsent: await inspectAbsent(staged.bundlePath),
      status: "preserved",
      reason: error.code || "bundle-cleanup-failed",
    }));
  } else {
    const bundleAbsent = await inspectAbsent(bundlePath);
    result.cleanup.appBundle = {
      processTerminal: allTerminal,
      bundleAbsent,
      status: bundleAbsent === true ? "not-created-or-stage-cleaned" : "preserved",
      reason: bundleAbsent === true ? null : "bundle-ownership-unavailable",
    };
  }
  result.cleanup.allOwnedResourcesClean = allTerminal === true
    && result.cleanup.fixtureRoot.rootAbsent === true && result.cleanup.appBundle.bundleAbsent === true;
  result.pairValidation = pairValidation ? {
    valid: pairValidation.valid,
    passed: pairValidation.passed,
    errors: pairValidation.errors,
  } : null;
  result.passed = result.seed.passed === true && result.main.passed === true
    && result.exception === null && stagedBinaryStable && result.cleanup.allOwnedResourcesClean === true;
  return result;
}
