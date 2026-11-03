import { isAbsolute } from "node:path";
import { lstat, realpath, rm } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import {
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  cleanupOwnedRendererApp,
  nativeChildEnvironment,
  readJsonNoFollow,
  runNativeChild,
} from "./ztools-renderer-native-runtime.mjs";
import { readJsonFile, readMarkerSafely } from "./ztools-renderer-launch-runtime.mjs";
import { stageSettingsInputNativeBundle } from "./ztools-settings-input-native-bundle.mjs";
import {
  SETTINGS_INPUT_NATIVE_SCOPE,
  validateSettingsInputNativeReport,
} from "./ztools-settings-input-native-report.mjs";
import {
  LOGIN_CROSS_ENTRY_REPORT_FILENAME,
  readLoginCrossEntryReport,
} from "./ztools-login-cross-entry-report.mjs";
import {
  LAUNCH_AT_LOGIN_REPORT_FILENAME,
  validateLaunchAtLoginReport,
} from "./ztools-launch-at-login-report.mjs";

export function launchAtLoginCleanupAllowsDeletion(processTerminal, ownerMatches, report) {
  return processTerminal === true && ownerMatches === true
    && report?.valid === true && report.cleanupSafe === true;
}

export function loginCrossEntryCleanupAllowsDeletion(processTerminal, ownerMatches, report) {
  return processTerminal === true && ownerMatches === true
    && report?.valid === true && report.cleanupSafe === true;
}

/** Keeps report identity separate from its business and lifecycle pass gates. */
export function settingsInputNativeIdentityMatches(report, expectedOwner) {
  return report !== null && typeof report === "object" && !Array.isArray(report)
    && expectedOwner !== null && typeof expectedOwner === "object" && !Array.isArray(expectedOwner)
    && report.schemaVersion === 3 && report.journey === "settings-input"
    && report.scope === SETTINGS_INPUT_NATIVE_SCOPE && report.autoClear === "never"
    && report.runId === expectedOwner.runId && report.identifier === expectedOwner.identifier
    && report.root === expectedOwner.root && report.pid === expectedOwner.pid
    && typeof expectedOwner.runId === "string" && /^[0-9a-f]{32}$/.test(expectedOwner.runId)
    && expectedOwner.identifier === `dev.atools.renderer-settings-input.${expectedOwner.runId}`
    && expectedOwner.root === `/private/tmp/atools-renderer-settings-input-${expectedOwner.runId}`
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

export function parseSettingsInputNativeArgs(argv) {
  const values = new Map();
  const pathFlags = new Set(["--binary", "--build-receipt"]);
  const acceptedFlags = new Set([...pathFlags, "--paint-presentation"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!acceptedFlags.has(flag)
        || values.has(flag) || index + 1 >= argv.length) {
      throw new Error("Only --binary, --build-receipt, and --paint-presentation are accepted once each");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    if (pathFlags.has(flag) && !isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
    if (flag === "--paint-presentation" && !isPaintPresentation(value)) {
      throw new Error("--paint-presentation must be hidden or visible-unfocused");
    }
    values.set(flag, value);
  }
  const binary = values.get("--binary");
  const buildReceipt = values.get("--build-receipt");
  if (!binary || !buildReceipt) throw new Error("--binary and --build-receipt are required");
  return { binary, buildReceipt, paintPresentation: values.get("--paint-presentation") ?? "hidden" };
}

export function buildSettingsInputNativeArgs({ fixtureRoot, rendererDist, output, runId,
  paintPresentation = "hidden" }) {
  if (!isPaintPresentation(paintPresentation)) {
    throw new Error("paintPresentation must be hidden or visible-unfocused");
  }
  const args = buildNativeCaseArgs({
    fixtureRoot, rendererDist, output, autoClear: "never", runId, mode: "single",
  });
  args.push("--journey", "settings-input");
  args.push("--paint-presentation", paintPresentation);
  return args;
}

function isPaintPresentation(value) {
  return value === "hidden" || value === "visible-unfocused";
}

function directoryIdentity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function inspectOwnedSettingsInputRoot({ root, runId, childPid }) {
  const expectedRoot = `/private/tmp/atools-renderer-settings-input-${runId}`;
  const expectedIdentifier = `dev.atools.renderer-settings-input.${runId}`;
  if (typeof runId !== "string" || !/^[0-9a-f]{32}$/.test(runId)
      || root !== expectedRoot || dirname(root) !== "/private/tmp" || normalize(root) !== root
      || !Number.isSafeInteger(childPid) || childPid <= 0) {
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
  if (!exactKeys(marker, ["schemaVersion", "pid", "identifier", "root"])
      || marker.schemaVersion !== 1 || marker.pid !== childPid
      || marker.identifier !== expectedIdentifier || marker.root !== root
      || !markerAfter || markerAfter.isSymbolicLink() || directoryIdentity(markerInfo) !== directoryIdentity(markerAfter)
      || !rootAfter || rootAfter.isSymbolicLink() || directoryIdentity(rootInfo) !== directoryIdentity(rootAfter)) {
    return { valid: false, reason: "owner-marker-mismatch" };
  }
  for (const name of ["app-data", "webview"]) {
    const childPath = join(root, name);
    const childInfo = await optionalLstat(childPath);
    if (!childInfo) continue;
    if (childInfo.isSymbolicLink() || !childInfo.isDirectory() || Number(childInfo.mode & 0o777n) !== 0o700
        || await realpath(childPath) !== join(root, name)) {
      return { valid: false, reason: "owned-child-directory-invalid" };
    }
  }
  return { valid: true, rootInfo, markerInfo, markerPath, marker };
}

/** Removes only the settings-input profile for its terminal child PID and exact run identity. */
export async function cleanupOwnedSettingsInputFixtureRoot({ root, runId, childPid, processTerminal }) {
  if (!isAbsolute(root) || normalize(root) !== root) {
    return { processTerminal, rootAbsent: null, status: "preserved", reason: "invalid-root-path" };
  }
  const current = await optionalLstat(root).catch(error => ({ inspectionError: error.code || "root-inspection-failed" }));
  if (!current) return { processTerminal, rootAbsent: true, status: "already_absent", reason: null };
  if (current.inspectionError) return { processTerminal, rootAbsent: null, status: "preserved", reason: current.inspectionError };
  if (!processTerminal) return { processTerminal: false, rootAbsent: false, status: "not_attempted", reason: "child-not-terminal" };

  const owner = await inspectOwnedSettingsInputRoot({ root, runId, childPid }).catch(error => ({
    valid: false, reason: error.code || "owner-inspection-failed",
  }));
  if (!owner.valid) return { processTerminal: true, rootAbsent: false, status: "preserved", reason: owner.reason };

  const latestRoot = await optionalLstat(root);
  const latestMarker = await optionalLstat(owner.markerPath);
  if (!latestRoot || !latestMarker || latestRoot.isSymbolicLink() || latestMarker.isSymbolicLink()
      || directoryIdentity(latestRoot) !== directoryIdentity(owner.rootInfo)
      || directoryIdentity(latestMarker) !== directoryIdentity(owner.markerInfo)) {
    return { processTerminal: true, rootAbsent: latestRoot === null, status: "preserved", reason: "ownership-changed-before-removal" };
  }
  const marker = await readJsonNoFollow(owner.markerPath, 4096).catch(() => null);
  if (!exactKeys(marker, ["schemaVersion", "pid", "identifier", "root"])
      || marker.schemaVersion !== 1 || marker.pid !== childPid
      || marker.identifier !== `dev.atools.renderer-settings-input.${runId}` || marker.root !== root) {
    return { processTerminal: true, rootAbsent: false, status: "preserved", reason: "owner-marker-changed-before-removal" };
  }
  try {
    await rm(root, { recursive: true, force: false, maxRetries: 0 });
    const absent = (await optionalLstat(root)) === null;
    return { processTerminal: true, rootAbsent: absent, status: absent ? "removed_owned_root" : "preserved",
      reason: absent ? null : "root-still-exists" };
  } catch (error) {
    const absent = await optionalLstat(root).then(value => value === null).catch(() => null);
    return { processTerminal: true, rootAbsent: absent, status: "preserved", reason: error.code || "root-removal-failed" };
  }
}

function safeProcessSummary(value) {
  if (!value) return null;
  return {
    spawned: value.spawned === true, pid: value.pid ?? null,
    terminalObserved: value.terminalObserved === true, exitCode: value.exitCode ?? null,
    signal: value.signal ?? null, timedOut: value.timedOut === true,
    termination: value.termination ? {
      attempted: value.termination.attempted === true,
      signals: Array.isArray(value.termination.signals) ? value.termination.signals.map(item => ({
        signal: item?.signal ?? null, accepted: item?.accepted === true,
        exception: item?.exception ? { name: item.exception.name, code: item.exception.code } : null,
      })) : [],
    } : null,
    stdout: value.stdout ? { capturedBytes: value.stdout.capturedBytes, observedBytes: value.stdout.observedBytes,
      truncated: value.stdout.truncated, sha256: value.stdout.sha256 } : null,
    stderr: value.stderr ? { capturedBytes: value.stderr.capturedBytes, observedBytes: value.stderr.observedBytes,
      truncated: value.stderr.truncated, sha256: value.stderr.sha256 } : null,
    exception: value.exception ? { name: value.exception.name, code: value.exception.code } : null,
  };
}

function safeException(error) {
  return { name: String(error?.name || "Error").slice(0, 80), code: error?.code ? String(error.code).slice(0, 80) : null };
}

async function inspectAbsent(path) {
  const info = await optionalLstat(path).catch(() => undefined);
  return info === null ? true : info === undefined ? null : false;
}

export async function runSettingsInputNativeCase({
  runDirectory, workspaceRoot, binaryFingerprint, rendererDist, runId, settingsSourceSnapshot, nativeSourceHashes,
  fallbackSourceSnapshot, paintPresentation = "hidden",
}) {
  const fixtureRoot = `/private/tmp/atools-renderer-settings-input-${runId}`;
  const nativeReportPath = join(runDirectory, "native-report.json");
  const bundlePath = join(runDirectory, "case-never.app");
  const identifier = `dev.atools.renderer-settings-input.${runId}`;
  const result = {
    runId, identifier, autoClear: "never", paintPresentation,
    nativeReportArtifact: "native-report.json",
    appBundle: null, process: null, nativeReport: null, profileOwner: null, launchAtLogin: null, loginCrossEntry: null,
    cleanup: { processTerminal: null, fixtureRootAbsent: null, appBundleAbsent: null,
      fixtureRoot: null, appBundle: null, launchAtLoginCleanupSafe: false,
      loginCrossEntryCleanupSafe: false, allOwnedResourcesClean: false },
    exception: null, passed: false,
  };
  let staged = null;
  let processResult = null;
  let nativeFile = { exists: false, value: null, exception: null };
  let nativeOwnerMatches = false;
  try {
    if (await inspectAbsent(fixtureRoot) !== true || await inspectAbsent(nativeReportPath) !== true
        || await inspectAbsent(bundlePath) !== true) throw new Error("settings-input run artifacts must be fresh");
    if (!fallbackSourceSnapshot) throw new Error("settings-input requires verified fallback Settings sources");
    staged = await stageSettingsInputNativeBundle({
      binaryFingerprint, runDirectory, runId, settingsSourceSnapshot, nativeSourceHashes, fallbackSourceSnapshot,
    });
    if (staged.identifier !== identifier || staged.infoPlistIdentifier !== identifier
        || !staged.settingsBundle?.staged || !staged.fallbackSettingsBundle?.staged) {
      throw new Error("Settings-input app identity or child resources are incomplete");
    }
    result.appBundle = {
      identifier: staged.identifier,
      infoPlistIdentifier: staged.infoPlistIdentifier,
      executable: "Contents/MacOS/AToolsRendererSmoke",
      sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256,
      builtinControl: staged.builtinControl,
      settingsBundle: staged.settingsBundle,
      fallbackSettingsBundle: staged.fallbackSettingsBundle,
    };
    const args = buildSettingsInputNativeArgs({
      fixtureRoot, rendererDist, output: nativeReportPath, runId, paintPresentation,
    });
    processResult = await runNativeChild(staged.executable, args, {
      timeoutMs: 180_000,
      spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
    });
    result.process = safeProcessSummary(processResult);
    const terminal = !processResult.spawned || processResult.terminalObserved;
    result.cleanup.processTerminal = terminal;

    if (processResult.terminalObserved && processResult.pid !== null) {
      const [file, marker] = await Promise.all([
        readJsonFile(nativeReportPath, 2 * 1024 * 1024), readMarkerSafely(fixtureRoot),
      ]);
      nativeFile = file;
      const owner = await inspectOwnedSettingsInputRoot({ root: fixtureRoot, runId, childPid: processResult.pid })
        .catch(() => ({ valid: false }));
      result.profileOwner = {
        valid: owner.valid === true && marker.value?.pid === processResult.pid
          && marker.value?.identifier === identifier && marker.value?.root === fixtureRoot
          && staged.identifier === identifier && staged.infoPlistIdentifier === identifier,
        pidMatches: marker.value?.pid === processResult.pid,
        identifierMatches: marker.value?.identifier === identifier,
        reportRootMatches: marker.value?.root === fixtureRoot,
        bundleIdentifierMatches: staged.identifier === identifier && staged.infoPlistIdentifier === identifier,
      };
      const validated = validateSettingsInputNativeReport(nativeFile.value, {
        runId, identifier, root: fixtureRoot, pid: processResult.pid,
      });
      result.nativeReport = { exists: nativeFile.exists === true, ...validated };
      const expectedOwner = { runId, identifier, root: fixtureRoot, pid: processResult.pid };
      nativeOwnerMatches = result.profileOwner.valid === true
        && settingsInputNativeIdentityMatches(nativeFile.value, expectedOwner);
      const loginFile = await readJsonFile(join(runDirectory, LAUNCH_AT_LOGIN_REPORT_FILENAME), 16 * 1024)
        .catch(error => ({ exists: false, value: null, exception: safeException(error) }));
      const loginValidation = validateLaunchAtLoginReport(loginFile.value, {
        runId, identifier, root: fixtureRoot, pid: processResult.pid,
      });
      result.launchAtLogin = {
        exists: loginFile.exists === true,
        ...loginValidation,
        ownerMatchesNativeReport: nativeOwnerMatches,
        exception: loginFile.exception ?? null,
      };
      const processSucceeded = processResult.spawned === true && processResult.terminalObserved === true
        && processResult.exitCode === 0 && processResult.signal === null && processResult.timedOut === false;
      const crossEntry = await readLoginCrossEntryReport(
        join(runDirectory, LOGIN_CROSS_ENTRY_REPORT_FILENAME),
        expectedOwner,
        {
          nativeOwnerMatches,
          nativeProcessTerminal: terminal,
          nativeProcessSucceeded: processSucceeded,
          nativeCaseSucceeded: result.nativeReport.valid === true && result.launchAtLogin.passed === true,
        },
      );
      result.loginCrossEntry = {
        ...crossEntry,
        ownerMatchesNativeReport: nativeOwnerMatches,
        nativeCaseSucceeded: result.nativeReport.valid === true && result.launchAtLogin.passed === true,
      };
    }
  } catch (error) {
    result.exception = safeException(error);
  }

  const processTerminal = processResult ? (!processResult.spawned || processResult.terminalObserved) : true;
  const childPid = processResult?.pid ?? null;
  result.cleanup.processTerminal = processTerminal;
  const loginCleanupConfirmed = launchAtLoginCleanupAllowsDeletion(
    processTerminal, result.profileOwner?.valid === true, result.launchAtLogin,
  );
  const crossEntryCleanupConfirmed = loginCrossEntryCleanupAllowsDeletion(
    processTerminal, nativeOwnerMatches,
    result.loginCrossEntry,
  );
  const appCleanupConfirmed = loginCleanupConfirmed && crossEntryCleanupConfirmed;
  result.cleanup.launchAtLoginCleanupSafe = loginCleanupConfirmed;
  result.cleanup.loginCrossEntryCleanupSafe = crossEntryCleanupConfirmed;
  result.cleanup.fixtureRoot = appCleanupConfirmed
    ? await cleanupOwnedSettingsInputFixtureRoot({ root: fixtureRoot, runId, childPid, processTerminal })
    : await preserveOwnedPath(fixtureRoot, processTerminal, "settings-cleanup-unconfirmed");
  result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
  if (staged && appCleanupConfirmed) {
    result.cleanup.appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath, runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity, processTerminal,
    });
  } else if (staged) {
    result.cleanup.appBundle = await preserveOwnedPath(
      staged.bundlePath, processTerminal, "settings-cleanup-unconfirmed", "bundleAbsent",
    );
  } else {
    const absent = await inspectAbsent(bundlePath);
    result.cleanup.appBundle = {
      processTerminal, bundleAbsent: absent,
      status: absent === true ? "not-created-or-stage-cleaned" : "preserved",
      reason: absent === true ? null : absent === false ? "bundle-ownership-unavailable" : "bundle-inspection-failed",
    };
  }
  result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;
  result.cleanup.allOwnedResourcesClean = processTerminal === true
    && appCleanupConfirmed && result.cleanup.fixtureRootAbsent === true && result.cleanup.appBundleAbsent === true;
  const hostSucceeded = processResult?.spawned === true && processResult.terminalObserved === true
    && processResult.exitCode === 0 && processResult.signal === null && processResult.timedOut === false;
  result.passed = hostSucceeded && result.exception === null && result.profileOwner?.valid === true
    && result.nativeReport?.valid === true && result.launchAtLogin?.passed === true
    && result.loginCrossEntry?.passed === true
    && result.cleanup.allOwnedResourcesClean === true;
  return result;
}

async function preserveOwnedPath(path, processTerminal, reason, absenceKey = "rootAbsent") {
  const absent = await inspectAbsent(path);
  return {
    processTerminal,
    [absenceKey]: absent,
    status: absent === true ? "already_absent" : "preserved",
    reason: absent === true ? null : absent === null ? "path-inspection-failed" : reason,
  };
}
