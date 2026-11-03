import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildMainHotkeyRecoveryNativeArgs,
  parseMainHotkeyStartupNativeArgs,
  runMainHotkeyStartupNativeCase,
} from "./ztools-main-hotkey-startup-native-case.mjs";

const FIRST_PID = 41_001;
const SECOND_PID = 41_002;
const FIXTURE_PARENT = "/private/tmp";

function ownerFor(runId) {
  return {
    runId,
    identifier: `dev.atools.renderer-settings-input.${runId}`,
    root: `${FIXTURE_PARENT}/atools-renderer-settings-input-${runId}`,
  };
}

function firstReport(owner, pid = FIRST_PID) {
  return {
    schemaVersion: 1,
    journey: "main-hotkey-startup-recovery-first",
    scope: "invalid-hotkey-first-process",
    ...owner,
    pid,
    observations: {
      startupNeedsRecovery: true, startupAttempted: true, ownedHotkeyUnregistered: true, generalOpened: true,
      hotkeyControlEmpty: true, placeholderEditDispatched: true, placeholderStored: true,
      invalidHotkeyPreserved: true, repairChordDispatched: true, repairStored: true, repairOwnedState: true,
      repairManagerRegistered: true, childClosed: true, hotkeyOwnedBeforeExit: true, pluginUiOpened: false,
      preloadStarted: false, databaseDevice: "16777234", databaseInode: "123456",
    },
    errors: [],
  };
}

function secondReport(owner, pid = SECOND_PID, databaseInode = "123456") {
  return {
    schemaVersion: 1,
    journey: "main-hotkey-startup-recovery-second",
    scope: "same-db-cold-start",
    ...owner,
    pid,
    previousPid: FIRST_PID,
    observations: {
      resumeClaimed: true, startupRegistered: true, startupOwnedStateB: true, startupManagerRegistered: true,
      generalOpened: true, generalReadBackB: true, releaseAttempted: true, releaseConfirmed: true,
      childClosed: true, pluginUiOpened: false, preloadStarted: false,
      databaseDevice: "16777234", databaseInode,
    },
    errors: [],
  };
}

function terminalProcess(pid, exitCode = 0) {
  return {
    spawned: true, pid, terminalObserved: true, exitCode, signal: null, timedOut: false,
    termination: { attempted: false, signals: [] },
    stdout: { capturedBytes: 0, observedBytes: 0, truncated: false, sha256: "0".repeat(64) },
    stderr: { capturedBytes: 0, observedBytes: 0, truncated: false, sha256: "0".repeat(64) },
  };
}

function readFlag(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : null;
}

async function setupProfileRoot(owner, pid) {
  await mkdir(owner.root, { mode: 0o700 });
  await mkdir(join(owner.root, "app-data"), { mode: 0o700 });
  await mkdir(join(owner.root, "webview"), { mode: 0o700 });
  await writeFile(join(owner.root, ".atools-renderer-smoke-owner.json"), JSON.stringify({
    schemaVersion: 1, pid, identifier: owner.identifier, root: owner.root,
  }), { flag: "wx", mode: 0o600 });
}

async function writeNativeSidecar(output, reportFilename, report) {
  await writeFile(join(output.slice(0, output.lastIndexOf("/")), reportFilename), JSON.stringify(report), {
    flag: "wx", mode: 0o600,
  });
}

test("R45 CLI is strict and creates separate first and resume process argument sets", () => {
  assert.deepEqual(parseMainHotkeyStartupNativeArgs([
    "--binary", "/private/tmp/AToolsRendererSmoke",
    "--build-receipt", "/private/tmp/native-build-receipt-1790000000000.json",
  ]), {
    binary: "/private/tmp/AToolsRendererSmoke",
    buildReceipt: "/private/tmp/native-build-receipt-1790000000000.json",
  });
  for (const args of [
    [],
    ["--binary", "relative", "--build-receipt", "/private/tmp/receipt.json"],
    ["--binary", "/private/tmp/a", "--build-receipt", "/private/tmp/r", "--journey", "settings"],
    ["--binary", "/private/tmp/a", "--binary", "/private/tmp/b", "--build-receipt", "/private/tmp/r"],
  ]) assert.throws(() => parseMainHotkeyStartupNativeArgs(args));

  const owner = ownerFor("0123456789abcdef0123456789abcdef");
  const common = {
    fixtureRoot: owner.root,
    rendererDist: "/workspace/packages/ztools-renderer/dist",
    output: "/workspace/run/first/native-report.json",
    runId: owner.runId,
  };
  assert.deepEqual(buildMainHotkeyRecoveryNativeArgs({ ...common, phase: "first" }).slice(-2),
    ["--journey", "main-hotkey-recovery-first"]);
  assert.deepEqual(buildMainHotkeyRecoveryNativeArgs({
    ...common, output: "/workspace/run/second/native-report.json", phase: "second", previousPid: FIRST_PID,
  }).slice(-2), ["--resume-hotkey-owner-pid", String(FIRST_PID)]);
  assert.throws(() => buildMainHotkeyRecoveryNativeArgs({ ...common, phase: "second" }));
  assert.throws(() => buildMainHotkeyRecoveryNativeArgs({ ...common, phase: "first", previousPid: FIRST_PID }));
});

test("R45 runs first recovery then cold resume on the same owned DB and cleans after both terminate", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const parent = await realpath("/private/tmp");
  assert.equal(parent, FIXTURE_PARENT);
  const runDirectory = await realpath(await import("node:os").then(({ tmpdir }) => tmpdir()));
  const runRoot = join(runDirectory, `atools-r45-native-case-${runId}`);
  await mkdir(runRoot, { mode: 0o700 });
  const run = join(runRoot, "run");
  await mkdir(run, { mode: 0o700 });
  let spawnCount = 0;
  let bundlePath = null;
  try {
    const result = await runMainHotkeyStartupNativeCase({
      runDirectory: run,
      workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: "a".repeat(64) },
      rendererDist: "/workspace/packages/ztools-renderer/dist",
      runId,
      settingsSourceSnapshot: {},
      nativeSourceHashes: {},
      stageBundle: async ({ runDirectory, runId: stagedRunId }) => {
        assert.equal(stagedRunId, runId);
        bundlePath = join(runDirectory, "case-never.app");
        await mkdir(bundlePath, { mode: 0o700 });
        const info = await lstat(bundlePath, { bigint: true });
        return {
          executable: "/workspace/fake-native",
          bundlePath,
          runDirectory,
          identifier: owner.identifier,
          infoPlistIdentifier: owner.identifier,
          sourceSha256: "a".repeat(64),
          stagedSha256: "a".repeat(64),
          ownerIdentity: `${String(info.dev)}:${String(info.ino)}`,
        };
      },
      runProcess: async (_binary, args) => {
        spawnCount += 1;
        const output = readFlag(args, "--output");
        const fixtureRoot = readFlag(args, "--fixture-root");
        assert.equal(fixtureRoot, owner.root);
        assert.equal(readFlag(args, "--run-id"), runId);
        assert.equal(readFlag(args, "--auto-clear"), "never");
        if (spawnCount === 1) {
          assert.equal(readFlag(args, "--journey"), "main-hotkey-recovery-first");
          assert.equal(readFlag(args, "--resume-hotkey-owner-pid"), null);
          await setupProfileRoot(owner, FIRST_PID);
          await writeNativeSidecar(output, "native-main-hotkey-recovery-first-report.json", firstReport(owner));
          return terminalProcess(FIRST_PID);
        }
        assert.equal(spawnCount, 2);
        assert.equal(readFlag(args, "--journey"), "main-hotkey-recovery-second");
        assert.equal(readFlag(args, "--resume-hotkey-owner-pid"), String(FIRST_PID));
        const permit = JSON.parse(await readFile(join(owner.root,
          ".atools-main-hotkey-recovery-resume-permit.json"), "utf8"));
        assert.deepEqual(permit, {
          schemaVersion: 1, journey: "main-hotkey-startup-recovery-resume", runId,
          seedPid: FIRST_PID, identifier: owner.identifier, root: owner.root,
        });
        await writeFile(join(owner.root, ".atools-renderer-smoke-owner.json"), JSON.stringify({
          schemaVersion: 1, pid: SECOND_PID, identifier: owner.identifier, root: owner.root,
        }), { mode: 0o600 });
        await writeFile(join(owner.root, ".atools-main-hotkey-recovery-resume-claimed"), runId,
          { flag: "wx", mode: 0o600 });
        await rm(join(owner.root, ".atools-main-hotkey-recovery-resume-permit.json"));
        await writeNativeSidecar(output, "native-main-hotkey-recovery-second-report.json", secondReport(owner));
        return terminalProcess(SECOND_PID);
      },
    });

    assert.equal(spawnCount, 2, JSON.stringify({ exception: result.exception, handoff: result.resumeHandoff, first: result.first }));
    assert.equal(result.pair?.passed, true);
    assert.equal(result.resumeHandoff?.permitCreated, true);
    assert.equal(result.resumeHandoff?.permitVerified, true);
    assert.equal(result.resumeHandoff?.claimConfirmed, true);
    assert.equal(result.resumeHandoff?.permitConsumed, true);
    assert.equal(result.cleanup?.allOwnedResourcesClean, true);
    assert.equal(result.passed, true);
    assert.equal(await lstat(owner.root).then(() => true, () => false), false);
    assert.equal(await lstat(bundlePath).then(() => true, () => false), false);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
  }
});

test("an invalid first process report cannot mint a resume permit or launch the second process", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const runRoot = join(await realpath(await import("node:os").then(({ tmpdir }) => tmpdir())),
    `atools-r45-invalid-first-${runId}`);
  await mkdir(runRoot, { mode: 0o700 });
  const run = join(runRoot, "run");
  await mkdir(run, { mode: 0o700 });
  let calls = 0;
  let bundlePath = null;
  try {
    const result = await runMainHotkeyStartupNativeCase({
      runDirectory: run, workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: "b".repeat(64) },
      rendererDist: "/workspace/packages/ztools-renderer/dist", runId, settingsSourceSnapshot: {}, nativeSourceHashes: {},
      stageBundle: async ({ runDirectory }) => {
        bundlePath = join(runDirectory, "case-never.app");
        await mkdir(bundlePath, { mode: 0o700 });
        const info = await lstat(bundlePath, { bigint: true });
        return { executable: "/workspace/fake-native", bundlePath, runDirectory,
          identifier: owner.identifier, infoPlistIdentifier: owner.identifier,
          sourceSha256: "b".repeat(64), stagedSha256: "b".repeat(64),
          ownerIdentity: `${String(info.dev)}:${String(info.ino)}` };
      },
      runProcess: async (_binary, args) => {
        calls += 1;
        assert.equal(readFlag(args, "--journey"), "main-hotkey-recovery-first");
        await setupProfileRoot(owner, FIRST_PID);
        const bad = firstReport(owner);
        bad.observations.invalidHotkeyPreserved = false;
        await writeNativeSidecar(readFlag(args, "--output"), "native-main-hotkey-recovery-first-report.json", bad);
        return terminalProcess(FIRST_PID);
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.first?.report?.passed, false);
    assert.equal(result.second, null);
    assert.equal(result.resumeHandoff?.permitCreated, false);
    assert.equal(result.passed, false);
    assert.equal(result.cleanup?.allOwnedResourcesClean, true);
    assert.equal(await lstat(join(owner.root, ".atools-main-hotkey-recovery-resume-permit.json")).then(() => true, () => false), false);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
    if (bundlePath) await rm(bundlePath, { recursive: true, force: true });
  }
});

test("a nonterminal second process preserves its profile and staged app for safe recovery", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const runRoot = join(await realpath(await import("node:os").then(({ tmpdir }) => tmpdir())),
    `atools-r45-live-child-${runId}`);
  await mkdir(runRoot, { mode: 0o700 });
  const run = join(runRoot, "run");
  await mkdir(run, { mode: 0o700 });
  let calls = 0;
  let bundlePath = null;
  try {
    const result = await runMainHotkeyStartupNativeCase({
      runDirectory: run, workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: "c".repeat(64) },
      rendererDist: "/workspace/packages/ztools-renderer/dist", runId, settingsSourceSnapshot: {}, nativeSourceHashes: {},
      stageBundle: async ({ runDirectory }) => {
        bundlePath = join(runDirectory, "case-never.app");
        await mkdir(bundlePath, { mode: 0o700 });
        const info = await lstat(bundlePath, { bigint: true });
        return { executable: "/workspace/fake-native", bundlePath, runDirectory,
          identifier: owner.identifier, infoPlistIdentifier: owner.identifier,
          sourceSha256: "c".repeat(64), stagedSha256: "c".repeat(64),
          ownerIdentity: `${String(info.dev)}:${String(info.ino)}` };
      },
      runProcess: async (_binary, args) => {
        calls += 1;
        const output = readFlag(args, "--output");
        if (calls === 1) {
          await setupProfileRoot(owner, FIRST_PID);
          await writeNativeSidecar(output, "native-main-hotkey-recovery-first-report.json", firstReport(owner));
          return terminalProcess(FIRST_PID);
        }
        assert.equal(readFlag(args, "--resume-hotkey-owner-pid"), String(FIRST_PID));
        await writeFile(join(owner.root, ".atools-renderer-smoke-owner.json"), JSON.stringify({
          schemaVersion: 1, pid: SECOND_PID, identifier: owner.identifier, root: owner.root,
        }), { mode: 0o600 });
        return { ...terminalProcess(SECOND_PID), terminalObserved: false, exitCode: null, timedOut: true };
      },
    });
    assert.equal(calls, 2, JSON.stringify({ exception: result.exception, handoff: result.resumeHandoff, first: result.first }));
    assert.equal(result.passed, false);
    assert.equal(result.cleanup?.allProcessesTerminal, false);
    assert.equal(result.cleanup?.allOwnedResourcesClean, false);
    assert.equal(result.cleanup?.fixtureRootAbsent, false);
    assert.equal(result.cleanup?.appBundleAbsent, false);
    assert.equal(await lstat(owner.root).then(() => true, () => false), true);
    assert.equal(await lstat(bundlePath).then(() => true, () => false), true);
  } finally {
    await rm(runRoot, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
  }
});
