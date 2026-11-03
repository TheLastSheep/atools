import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  buildNativeCaseArgs,
  cleanupOwnedFixtureRoot,
  cleanupOwnedRendererApp,
  markerMatches,
  nativeChildEnvironment,
  runNativeChild,
  stageRendererNativeApp,
} from "./ztools-renderer-native-runtime.mjs";
import { readJsonFile, readMarkerSafely } from "./ztools-renderer-launch-runtime.mjs";
import { inspectRendererLaunchProbes, stageRendererLaunchProbes } from "./ztools-renderer-launch-probes.mjs";
import { validateLaunchReturnNativeReport } from "./ztools-launch-return-native-report.mjs";
import { inspectLaunchReturnSettingsSqlite } from "./ztools-launch-return-settings-sqlite.mjs";

const probeIds = ["first", "second"];
const probeBundleNames = ["AToolsOwnedProbeFirst.app", "AToolsOwnedProbeSecond.app"];

export function errorRecord(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: error?.code ? String(error.code).slice(0, 100) : null,
    message: String(error?.message || "Launch-return native runner failed").slice(0, 500),
  };
}

export function buildLaunchReturnNativeArgs({ fixtureRoot, rendererDist, output, runId, targetKind = "app", registrationSource = "core-seed" }) {
  if (!["app", "local-shortcut"].includes(targetKind)) throw new Error("targetKind must be app or local-shortcut");
  if (!["core-seed", "settings-child"].includes(registrationSource)
      || registrationSource === "settings-child" && targetKind !== "local-shortcut") {
    throw new Error("registrationSource must be core-seed or settings-child; settings-child requires local-shortcut");
  }
  const args = buildNativeCaseArgs({ fixtureRoot, rendererDist, output, autoClear: "never", runId, mode: "single" });
  args.push("--journey", "launch-return");
  args.push("--target-kind", targetKind);
  args.push("--registration-source", registrationSource);
  return args;
}

async function inspectAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return error.code === "ENOENT" ? true : null;
  }
}

async function readJsonSnapshot(path, maxBytes) {
  try {
    const file = await readJsonFile(path, maxBytes);
    return { exists: file.exists, value: file.value, exception: file.exception };
  } catch (error) {
    return { exists: null, value: null, exception: errorRecord(error) };
  }
}

async function ownedProfileLayoutValid(fixtureRoot) {
  try {
    const rootInfo = await lstat(fixtureRoot, { bigint: true });
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || Number(rootInfo.mode & 0o777n) !== 0o700
        || await realpath(fixtureRoot) !== fixtureRoot) return false;
    for (const name of ["app-data", "webview", "launcher-apps"]) {
      const path = join(fixtureRoot, name);
      const info = await lstat(path, { bigint: true });
      if (!info.isDirectory() || info.isSymbolicLink() || Number(info.mode & 0o777n) !== 0o700
          || await realpath(path) !== path) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function launchReturnProbeReportsAgree(nativeReport, nodeEvidence) {
  if (!Array.isArray(nativeReport?.probes) || nativeReport.probes.length !== probeIds.length
      || !Array.isArray(nodeEvidence?.probeReceipts) || nodeEvidence.probeReceipts.length !== probeIds.length
      || nodeEvidence.valid !== true || nodeEvidence.probesTerminal !== true
      || nodeEvidence.liveProbeProcesses !== 0) return false;
  return probeIds.every((probeId, index) => {
    const native = nativeReport.probes[index];
    const node = nodeEvidence.probeReceipts[index];
    const marker = native?.marker;
    return native?.probeId === probeId && native.bundleName === probeBundleNames[index]
      && native.backgroundOnly === true && marker?.started === true && marker.exiting === true
      && marker.runIdMatched === true && marker.probeIdMatched === true && marker.processTerminal === true
      && marker.pid === node?.pid && node?.probeId === probeId && node.started === true && node.exited === true
      && node.processTerminal === true && node.liveProbeProcesses === 0;
  });
}

export function launchReturnProbeIssues(nativeReport, nodeEvidence) {
  return probeIds.flatMap((probeId, index) => {
    const native = nativeReport?.probes?.[index];
    const marker = native?.marker;
    const node = nodeEvidence?.probeReceipts?.[index];
    const terminal = native?.bundleName === probeBundleNames[index] && native.backgroundOnly === true
      && marker?.started === true && marker.exiting === true && marker.runIdMatched === true
      && marker.probeIdMatched === true && marker.processTerminal === true
      && node?.probeId === probeId && node.started === true && node.exited === true
      && node.processTerminal === true && node.liveProbeProcesses === 0 && marker.pid === node.pid;
    if (terminal) return [];
    return [{
      probeId,
      stage: probeId === "first" ? "direct-return" : "keyboard-return",
      pid: node?.pid ?? marker?.pid ?? null,
      started: node?.started ?? marker?.started ?? null,
      exited: node?.exited ?? marker?.exiting ?? null,
      processTerminal: node?.processTerminal ?? marker?.processTerminal ?? null,
      liveProbeProcesses: node?.liveProbeProcesses ?? null,
    }];
  });
}

export function launchReturnRootCleanupAllowed(evidence) {
  return evidence?.hostProcessSucceeded === true && evidence.profileOwnerValid === true
    && evidence.nativeReportValid === true && evidence.probeReportsAgree === true
    && evidence.probesValid === true && evidence.probesTerminal === true
    && evidence.liveProbeProcesses === 0 && evidence.pendingLaunches === 0
    && evidence.nativeLiveProbeProcesses === 0 && evidence.nativeProbesTerminal === true
    && (evidence.registrationSource === "core-seed"
      || evidence.registrationSource === "settings-child" && evidence.registrationSqliteValid === true);
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

function processSummary(value) {
  if (!value) return null;
  return {
    spawned: value.spawned === true, pid: value.pid ?? null,
    terminalObserved: value.terminalObserved === true, exitCode: value.exitCode ?? null,
    signal: value.signal ?? null, timedOut: value.timedOut === true,
    termination: value.termination, stdout: value.stdout, stderr: value.stderr, exception: value.exception,
  };
}

export async function runLaunchReturnCase({ runDirectory, workspaceRoot, binaryFingerprint, launcherProbeFingerprint, rendererDist,
  targetKind = "app", registrationSource = "core-seed", settingsSourceSnapshot = null }) {
  const runId = randomUUID().replaceAll("-", "");
  const fixtureRoot = `/private/tmp/atools-renderer-launch-return-${runId}`;
  const nativeReportPath = join(runDirectory, "native-report.json");
  const bundlePath = join(runDirectory, "case-never.app");
  const expectedIdentifier = `dev.atools.renderer-smoke.${runId}`;
  const result = {
    runId, identifier: expectedIdentifier, fixtureRoot, autoClear: "never", registrationSource,
    appBundle: null, process: null, nativeReport: null, profileOwner: null,
    probes: { valid: false, errors: ["profile-unavailable"], probeReceipts: [], probesTerminal: false, liveProbeProcesses: null },
    probeReportsAgree: false, probeIssues: [], registrationSqlite: null,
    cleanup: {
      hostProcessTerminal: null, fixtureRootAbsent: null, appBundleAbsent: null,
      fixtureRoot: null, appBundle: null, pendingLaunches: null, liveProbeProcesses: null,
      nativeLiveProbeProcesses: null, probesTerminal: false, allOwnedResourcesClean: false,
    },
    exception: null,
    passed: false,
  };
  let staged = null;
  let processResult = null;
  let nativeFile = { exists: false, value: null, exception: null };
  let ownerFile = { exists: false, value: null, exception: null };
  try {
    if (registrationSource === "settings-child" && !settingsSourceSnapshot) throw new Error("Settings source snapshot is required");
    const [rootFresh, reportFresh, bundleFresh] = await Promise.all([
      inspectAbsent(fixtureRoot), inspectAbsent(nativeReportPath), inspectAbsent(bundlePath),
    ]);
    if (rootFresh !== true) throw new Error("Launch-return fixture root is present or cannot be inspected");
    if (reportFresh !== true || bundleFresh !== true) throw new Error("Launch-return outputs must be fresh");
    staged = await stageRendererNativeApp({
      binary: binaryFingerprint.path, runDirectory, autoClear: "never", runId,
      expectedSha256: binaryFingerprint.sha256,
      mode: registrationSource === "settings-child" ? "settings" : "single", settingsSourceSnapshot,
    });
    if (staged.infoPlist.includes("LSBackgroundOnly")) throw new Error("Host bundle must not be background-only");
    const probeStage = await stageRendererLaunchProbes({
      hostBundlePath: staged.bundlePath, binaryFingerprint: launcherProbeFingerprint, runId, backgroundOnly: true,
    });
    result.appBundle = {
      identifier: staged.identifier, executable: "Contents/MacOS/AToolsRendererSmoke",
      sourceSha256: staged.sourceSha256, stagedSha256: staged.stagedSha256, hostBackgroundOnly: false,
      probeExecutableSha256: probeStage.executableSha256, probeBundleCount: probeStage.bundleCount,
      probeIds: probeStage.probeIds, probeBackgroundOnly: probeStage.backgroundOnly,
      settingsBundle: staged.settingsBundle ?? null,
    };
    assert.equal(staged.identifier, expectedIdentifier, "Staged host identifier must match this run");
    const args = buildLaunchReturnNativeArgs({ fixtureRoot, rendererDist, output: nativeReportPath, runId, targetKind, registrationSource });
    processResult = await runNativeChild(staged.executable, args, {
      timeoutMs: 180_000,
      spawnOptions: { cwd: workspaceRoot, env: nativeChildEnvironment(process.env) },
    });
    result.process = processSummary(processResult);
    result.cleanup.hostProcessTerminal = processResult.spawned ? processResult.terminalObserved : null;

    if (processResult.terminalObserved && processResult.pid !== null) {
      [nativeFile, ownerFile] = await Promise.all([
        readJsonSnapshot(nativeReportPath, 2 * 1024 * 1024), readMarkerSafely(fixtureRoot),
      ]);
      const ownerValid = markerMatches(ownerFile.value, fixtureRoot, processResult.pid)
        && ownerFile.value?.identifier === expectedIdentifier && await ownedProfileLayoutValid(fixtureRoot);
      result.profileOwner = {
        exists: ownerFile.exists === true, valid: ownerValid,
        identifier: ownerFile.value?.identifier ?? null, pidMatchesHost: ownerFile.value?.pid === processResult.pid,
        rootMatches: ownerFile.value?.root === fixtureRoot,
      };
      if (registrationSource === "settings-child" && ownerValid) {
        result.registrationSqlite = await inspectLaunchReturnSettingsSqlite({
          fixtureRoot, runDirectory, runId, hostPid: processResult.pid, marker: ownerFile.value,
          hostProcessTerminal: processResult.terminalObserved,
        });
      }
      result.nativeReport = {
        exists: nativeFile.exists === true,
        ...validateLaunchReturnNativeReport(nativeFile.value, {
          runId, identifier: expectedIdentifier, root: fixtureRoot,
          pid: processResult.pid, marker: ownerFile.value, targetKind, registrationSource,
          requiredSchemaVersion: registrationSource === "settings-child" ? 3 : 2,
          settingsBundleRevision: settingsSourceSnapshot?.bundle.provenanceSha256,
          registrationSqlite: result.registrationSqlite,
        }),
      };
      if (ownerValid) {
        result.probes = await inspectRendererLaunchProbes({
          root: join(fixtureRoot, "launcher-apps"), runId,
          executableSha256: launcherProbeFingerprint.sha256,
          backgroundOnly: true, allowMarkers: true, expectedProbeIds: probeIds,
          hostPid: processResult.pid,
        });
      }
      result.probeReportsAgree = launchReturnProbeReportsAgree(nativeFile.value, result.probes);
    }
  } catch (error) {
    result.exception = errorRecord(error);
  }
  result.probeIssues = launchReturnProbeIssues(nativeFile.value, result.probes);

  const hostProcessTerminal = processResult ? (!processResult.spawned || processResult.terminalObserved) : true;
  result.cleanup.hostProcessTerminal = hostProcessTerminal;
  const nativeCleanup = nativeFile.value?.stages?.at(-1)?.native?.probes;
  result.cleanup.pendingLaunches = Number.isSafeInteger(nativeCleanup?.pendingLaunches)
    ? nativeCleanup.pendingLaunches : null;
  result.cleanup.nativeLiveProbeProcesses = Number.isSafeInteger(nativeCleanup?.liveProcesses)
    ? nativeCleanup.liveProcesses : null;
  result.cleanup.probesTerminal = result.probes.probesTerminal === true
    && result.probeReportsAgree && result.nativeReport?.valid === true;
  result.cleanup.liveProbeProcesses = result.probes.liveProbeProcesses;
  const hostProcessSucceeded = processResult?.spawned === true && processResult.terminalObserved === true
    && processResult.exitCode === 0 && processResult.signal === null && processResult.timedOut === false;
  const nativeProbesTerminal = result.nativeReport?.valid === true && nativeCleanup?.started === 2
    && nativeCleanup?.exited === 2 && nativeCleanup?.liveProcesses === 0;
  const safeRootCleanup = launchReturnRootCleanupAllowed({
    hostProcessSucceeded, profileOwnerValid: result.profileOwner?.valid,
    nativeReportValid: result.nativeReport?.valid, probeReportsAgree: result.probeReportsAgree,
    probesValid: result.probes.valid, probesTerminal: result.probes.probesTerminal,
    liveProbeProcesses: result.probes.liveProbeProcesses, pendingLaunches: result.cleanup.pendingLaunches,
    nativeLiveProbeProcesses: result.cleanup.nativeLiveProbeProcesses, nativeProbesTerminal,
    registrationSource, registrationSqliteValid: result.registrationSqlite?.valid === true,
  });
  if (safeRootCleanup) {
    result.cleanup.fixtureRoot = await cleanupOwnedFixtureRoot({
      root: fixtureRoot, childPid: processResult.pid, processTerminal: true,
    });
  } else {
    const rootAbsence = await inspectAbsent(fixtureRoot);
    result.cleanup.fixtureRoot = preserveFixtureRoot(
      hostProcessTerminal, rootAbsence,
      rootAbsence === null ? "fixture-root-inspection-failed" : "complete-launch-and-exit-evidence-required",
    );
  }
  result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;

  if (staged) {
    result.cleanup.appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath, runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity, processTerminal: hostProcessTerminal,
    });
  } else {
    const absent = await inspectAbsent(bundlePath);
    result.cleanup.appBundle = {
      processTerminal: hostProcessTerminal, bundleAbsent: absent,
      status: absent === true ? "not_created_or_stage_cleaned" : "preserved",
      reason: absent === true ? null : absent === false ? "bundle-ownership-unavailable" : "bundle-inspection-failed",
    };
  }
  result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;
  result.cleanup.allOwnedResourcesClean = hostProcessTerminal === true
    && result.cleanup.fixtureRootAbsent === true && result.cleanup.appBundleAbsent === true;
  result.passed = hostProcessSucceeded && result.exception === null && result.profileOwner?.valid === true
    && result.nativeReport?.valid === true && result.probes.valid === true && result.probeReportsAgree === true
    && result.cleanup.probesTerminal === true && result.cleanup.pendingLaunches === 0
    && result.cleanup.liveProbeProcesses === 0 && result.cleanup.nativeLiveProbeProcesses === 0
    && result.cleanup.allOwnedResourcesClean === true;
  return result;
}
