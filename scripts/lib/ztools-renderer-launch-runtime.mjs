import { lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { fingerprintNativeExecutable } from "./ztools-renderer-native-source-binding.mjs";
import { summarizeLauncherNativeReport, validateLauncherMode } from "./ztools-launcher-native-validation.mjs";
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
import {
  inspectRendererLaunchProbes,
  MAX_LAUNCHER_PROBE_BYTES,
  launcherProbeFingerprintMatchesReceipt,
  sameLauncherProbeFingerprint,
  stageRendererLaunchProbes,
} from "./ztools-renderer-launch-probes.mjs";

const OWNER_KEYS = ["schemaVersion", "pid", "identifier", "root"];

function identity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function inspectOptionalPathAbsence(path, inspect = optionalLstat) {
  try {
    const value = await inspect(path);
    if (value === null) return { known: true, absent: true };
    if (value && typeof value === "object") return { known: true, absent: false };
    return { known: false, absent: null };
  } catch {
    return { known: false, absent: null };
  }
}

export async function readJsonFile(path, maxBytes) {
  const info = await optionalLstat(path);
  if (!info) return { exists: false, value: null, exception: null };
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.size > BigInt(maxBytes)) {
    return { exists: true, value: null, exception: { name: "InvalidFile", code: null } };
  }
  try {
    return { exists: true, value: await readJsonNoFollow(path, maxBytes), exception: null };
  } catch (error) {
    return { exists: true, value: null, exception: { name: error.name || "Error", code: error.code || null } };
  }
}

export async function readMarkerSafely(fixtureRoot) {
  const before = await optionalLstat(fixtureRoot);
  if (!before) return { exists: false, value: null, exception: null };
  if (before.isSymbolicLink() || !before.isDirectory()) {
    return { exists: null, value: null, exception: { name: "UntrustedRoot", code: null } };
  }
  const marker = await readJsonFile(join(fixtureRoot, OWNER_MARKER_NAME), 4096);
  const after = await optionalLstat(fixtureRoot);
  if (!after || after.isSymbolicLink() || identity(before) !== identity(after)) {
    return { exists: null, value: null, exception: { name: "RootChanged", code: null } };
  }
  return marker;
}

async function readLauncherProfileOwner(fixtureRoot, childPid, expectedIdentifier) {
  const fail = (exists, name) => ({ valid: false,
    markerFile: { exists, value: null, exception: { name, code: null } } });
  if (!isAbsolute(fixtureRoot) || normalize(fixtureRoot) !== fixtureRoot
      || !Number.isSafeInteger(childPid) || childPid <= 0) return fail(null, "InvalidOwnerInputs");
  const before = await optionalLstat(fixtureRoot);
  if (!before) return fail(false, "OwnerRootMissing");
  if (!before.isDirectory() || before.isSymbolicLink() || Number(before.mode & 0o777n) !== 0o700) {
    return fail(null, "UntrustedOwnerRoot");
  }
  try {
    const canonicalParent = await realpath(dirname(fixtureRoot));
    if (await realpath(fixtureRoot) !== join(canonicalParent, basename(fixtureRoot))) return fail(null, "OwnerRootChanged");
  } catch {
    return fail(null, "OwnerRootUnresolvable");
  }
  const markerPath = join(fixtureRoot, OWNER_MARKER_NAME);
  const markerInfo = await optionalLstat(markerPath);
  if (!markerInfo) return fail(false, "OwnerMarkerMissing");
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || markerInfo.nlink !== 1n
      || markerInfo.size > 4096n || Number(markerInfo.mode & 0o777n) !== 0o600) {
    return fail(true, "OwnerMarkerInvalidFile");
  }
  let marker;
  try { marker = await readJsonNoFollow(markerPath, 4096); }
  catch { return fail(true, "OwnerMarkerUnreadable"); }
  const markerAfter = await optionalLstat(markerPath);
  const rootAfter = await optionalLstat(fixtureRoot);
  if (!markerAfter || markerAfter.isSymbolicLink() || identity(markerInfo) !== identity(markerAfter)
      || !rootAfter || rootAfter.isSymbolicLink() || identity(before) !== identity(rootAfter)) {
    return fail(null, "OwnerChangedDuringRead");
  }
  if (!exactKeys(marker, OWNER_KEYS) || marker.schemaVersion !== 1 || marker.pid !== childPid
      || marker.root !== fixtureRoot || marker.identifier !== expectedIdentifier) {
    return fail(true, "OwnerMarkerMismatch");
  }
  for (const child of ["app-data", "webview"]) {
    const childInfo = await optionalLstat(join(fixtureRoot, child));
    if (!childInfo || childInfo.isSymbolicLink() || !childInfo.isDirectory()
        || Number(childInfo.mode & 0o777n) !== 0o700) return fail(true, "OwnerChildDirectoryInvalid");
  }
  const launcherRootInfo = await optionalLstat(join(fixtureRoot, "launcher-apps"));
  if (!launcherRootInfo || launcherRootInfo.isSymbolicLink() || !launcherRootInfo.isDirectory()
      || Number(launcherRootInfo.mode & 0o777n) !== 0o700) return fail(true, "LauncherRootInvalid");
  return { valid: true, markerFile: { exists: true, value: marker, exception: null } };
}

function launcherProcessSummary(processResult) {
  if (!processResult) return null;
  return {
    spawned: processResult.spawned === true,
    pid: processResult.pid ?? null,
    terminalObserved: processResult.terminalObserved === true,
    exitCode: processResult.exitCode ?? null,
    signal: processResult.signal ?? null,
    timedOut: processResult.timedOut === true,
    termination: processResult.termination,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    exception: processResult.exception,
  };
}

function safeException(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: error?.code ? String(error.code).slice(0, 100) : null,
  };
}

export function summarizeLauncherProbeFingerprint(fingerprint) {
  if (!fingerprint) return null;
  const { sha256, sizeBytes, mtimeNs, device, inode } = fingerprint;
  return { sha256, sizeBytes, mtimeNs, device, inode };
}

export async function captureLauncherProbeFingerprint({ binaryPath, receiptSnapshot, nativeSources }) {
  if (!nativeSources?.files?.some(file => file.path === "src-tauri/examples/atools_owned_launch_probe.rs")) {
    throw new Error("Launcher probe example must be present in the native source closure");
  }
  const canonicalPath = await realpath(binaryPath);
  const info = await lstat(canonicalPath, { bigint: true });
  if (!info.isFile() || info.size > BigInt(MAX_LAUNCHER_PROBE_BYTES) || (info.mode & 0o111n) === 0n) {
    throw new Error("Launcher probe binary must be an executable regular file within 32 MiB");
  }
  const fingerprint = await fingerprintNativeExecutable(canonicalPath);
  if (BigInt(fingerprint.sizeBytes) > BigInt(MAX_LAUNCHER_PROBE_BYTES)) {
    throw new Error("Launcher probe binary exceeds 32 MiB");
  }
  return { fingerprint, matchesReceipt: launcherProbeFingerprintMatchesReceipt(receiptSnapshot, fingerprint) };
}

export async function verifyLauncherProbeFingerprintUnchanged(binaryPath, before) {
  const after = await fingerprintNativeExecutable(binaryPath);
  return { after: summarizeLauncherProbeFingerprint(after), stable: sameLauncherProbeFingerprint(before, after) };
}

export function launcherFixtureRootCleanupAllowed(evidence) {
  return evidence?.hostProcessSucceeded === true && evidence.profileOwnerValid === true
    && evidence.nativeReportValid === true && evidence.launcherModeValid === true
    && evidence.probesValid === true && evidence.probesTerminal === true
    && evidence.liveProbeProcesses === 0 && evidence.pendingLaunches === 0
    && evidence.nativeLiveProbeProcesses === 0 && evidence.nativeProbesTerminal === true;
}

function preserveFixtureRoot(processTerminal, rootAbsent, reason) {
  return {
    processTerminal,
    rootAbsent,
    status: rootAbsent === true ? "already_absent" : "preserved",
    reason: rootAbsent === true ? null : reason,
    ownership: "not_removed_without_complete_probe_evidence",
  };
}

function noProbeEvidence() {
  return {
    valid: false,
    errors: ["owned-profile-unavailable"],
    bundleCount: 0,
    selectedProbe: null,
    processStarts: 0,
    processExits: 0,
    probesTerminal: false,
    liveProbeProcesses: null,
  };
}

export async function runLauncherNativeCase({
  autoClear,
  runDirectory,
  binary,
  sourceSha256,
  rendererDist,
  launcherProbeFingerprint,
  nativeRunnerRoot,
}) {
  const caseUUID = randomUUID();
  const runId = caseUUID.replaceAll("-", "");
  const fixtureRoot = `/private/tmp/atools-renderer-native-${caseUUID}-${autoClear}`;
  const reportPath = join(runDirectory, `case-${autoClear}.json`);
  const bundlePath = join(runDirectory, `case-${autoClear}.app`);
  const expectedIdentifier = `dev.atools.renderer-smoke.${runId}`;
  const result = {
    mode: "launcher",
    autoClear,
    runId,
    fixtureRoot,
    reportPath,
    passed: false,
    hostApp: null,
    process: null,
    nativeReport: null,
    launcherMode: validateLauncherMode(null),
    probes: noProbeEvidence(),
    exception: null,
    cleanup: {
      processTerminal: null,
      hostProcessTerminal: null,
      fixtureRootAbsent: null,
      appBundleAbsent: null,
      fixtureRoot: null,
      appBundle: null,
      probesTerminal: false,
      pendingLaunches: null,
      liveProbeProcesses: null,
      nativeLiveProbeProcesses: null,
      cleanupBeforeNextCase: false,
    },
  };
  let staged = null;
  let processResult = null;
  let profileOwner = { valid: false, markerFile: { exists: false, value: null, exception: null } };
  let reportFile = { exists: false, value: null, exception: null };

  try {
    const [existingRoot, existingReport] = await Promise.all([optionalLstat(fixtureRoot), optionalLstat(reportPath)]);
    if (existingRoot) throw new Error("Launcher fixture root already exists; refusing to reuse it");
    if (existingReport) throw new Error("Launcher report output must be fresh");
    staged = await stageRendererNativeApp({
      binary,
      runDirectory,
      autoClear,
      runId,
      expectedSha256: sourceSha256,
      mode: "launcher",
    });
    const probeStage = await stageRendererLaunchProbes({
      hostBundlePath: staged.bundlePath,
      binaryFingerprint: launcherProbeFingerprint,
      runId,
    });
    result.hostApp = {
      staged: true,
      sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256,
      launcherProbeSha256: launcherProbeFingerprint.sha256,
      probeBundleCount: probeStage.bundleCount,
      probeIds: probeStage.probeIds,
    };
    const args = buildNativeCaseArgs({
      fixtureRoot,
      rendererDist,
      output: reportPath,
      autoClear,
      runId,
      mode: "launcher",
    });
    console.log(`native renderer launcher case ${autoClear}: starting direct bundle executable`);
    processResult = await runNativeChild(staged.executable, args, {
      timeoutMs: 150_000,
      spawnOptions: { cwd: nativeRunnerRoot, env: nativeChildEnvironment(process.env) },
    });
    result.process = launcherProcessSummary(processResult);
    result.cleanup.hostProcessTerminal = processResult.spawned ? processResult.terminalObserved : null;
    result.cleanup.processTerminal = result.cleanup.hostProcessTerminal;

    if (processResult.terminalObserved && processResult.pid !== null) {
      reportFile = await readJsonFile(reportPath, 1024 * 1024);
      profileOwner = await readLauncherProfileOwner(fixtureRoot, processResult.pid, expectedIdentifier);
      result.launcherMode = validateLauncherMode(reportFile.value);
      result.nativeReport = summarizeLauncherNativeReport(reportFile, profileOwner.markerFile, {
        autoClear,
        fixtureRoot,
        childPid: processResult.pid,
      });
      if (profileOwner.valid) {
        result.probes = await inspectRendererLaunchProbes({
          root: join(fixtureRoot, "launcher-apps"),
          runId,
          executableSha256: launcherProbeFingerprint.sha256,
          allowMarkers: true,
          expectedProbeId: reportFile.value?.launcher?.input?.selectedProbe,
          hostPid: processResult.pid,
        });
      }
    }
  } catch (error) {
    result.exception = safeException(error);
  }

  const hostTerminal = processResult ? (!processResult.spawned || processResult.terminalObserved) : true;
  if (staged) {
    result.cleanup.appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath,
      runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity,
      processTerminal: hostTerminal,
    });
  } else {
    const absence = await inspectOptionalPathAbsence(bundlePath);
    const bundleAbsent = absence.known ? absence.absent : null;
    result.cleanup.appBundle = {
      processTerminal: hostTerminal,
      bundleAbsent,
      status: absence.known && absence.absent ? "not_created_or_stage_cleaned" : "preserved",
      reason: !absence.known ? "bundle_inspection_failed"
        : absence.absent ? null : "bundle_stage_ownership_unavailable",
    };
  }
  result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;

  const nativeCleanup = reportFile.value?.launcher?.cleanup;
  result.cleanup.pendingLaunches = Number.isSafeInteger(nativeCleanup?.pendingLaunches)
    ? nativeCleanup.pendingLaunches : null;
  result.cleanup.nativeLiveProbeProcesses = Number.isSafeInteger(nativeCleanup?.liveProbeProcesses)
    ? nativeCleanup.liveProbeProcesses : null;
  result.cleanup.probesTerminal = result.probes.probesTerminal === true && nativeCleanup?.probesTerminal === true;
  result.cleanup.liveProbeProcesses = result.probes.liveProbeProcesses;
  const hostProcessSucceeded = processResult?.spawned === true && processResult.terminalObserved === true
    && processResult.exitCode === 0 && processResult.signal === null && processResult.timedOut === false;
  const safeRootCleanup = launcherFixtureRootCleanupAllowed({
    hostProcessSucceeded,
    profileOwnerValid: profileOwner.valid,
    nativeReportValid: result.nativeReport?.valid,
    launcherModeValid: result.launcherMode.valid,
    probesValid: result.probes.valid,
    probesTerminal: result.probes.probesTerminal,
    liveProbeProcesses: result.probes.liveProbeProcesses,
    pendingLaunches: result.cleanup.pendingLaunches,
    nativeLiveProbeProcesses: result.cleanup.nativeLiveProbeProcesses,
    nativeProbesTerminal: nativeCleanup?.probesTerminal,
  });

  if (safeRootCleanup) {
    result.cleanup.fixtureRoot = await cleanupOwnedFixtureRoot({
      root: fixtureRoot,
      childPid: processResult.pid,
      processTerminal: true,
    });
  } else {
    const rootAbsence = await inspectOptionalPathAbsence(fixtureRoot);
    result.cleanup.fixtureRoot = preserveFixtureRoot(
      result.cleanup.hostProcessTerminal,
      rootAbsence.known ? rootAbsence.absent : null,
      rootAbsence.known ? "launcher-success-and-independent-probe-exit-evidence-required" : "fixture-root-inspection-failed",
    );
  }
  result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
  result.cleanup.cleanupBeforeNextCase = safeRootCleanup
    && result.cleanup.hostProcessTerminal === true && result.cleanup.fixtureRootAbsent === true
    && result.cleanup.appBundleAbsent === true;
  result.passed = hostProcessSucceeded && result.nativeReport?.valid === true
    && result.launcherMode.valid === true && result.probes.valid === true
    && result.cleanup.probesTerminal === true && result.cleanup.pendingLaunches === 0
    && result.cleanup.liveProbeProcesses === 0 && result.cleanup.nativeLiveProbeProcesses === 0
    && result.cleanup.cleanupBeforeNextCase === true;
  console.log(`native renderer launcher case ${autoClear}: host-terminal=${result.cleanup.hostProcessTerminal}; probes-terminal=${result.cleanup.probesTerminal}; passed=${result.passed}; cleanup=${result.cleanup.cleanupBeforeNextCase}`);
  return result;
}
