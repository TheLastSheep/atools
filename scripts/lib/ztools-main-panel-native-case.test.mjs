import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runMainPanelNativeCase } from "./ztools-main-panel-native-case.mjs";

const FIXTURE_PARENT = "/private/tmp";
const PID = 48_271;
const SHA = "a".repeat(64);

function ownerFor(runId) {
  return {
    runId,
    identifier: `dev.atools.renderer-smoke.${runId}`,
    root: `${FIXTURE_PARENT}/atools-renderer-smoke-${runId}`,
  };
}

function foreground(appActive, visible) {
  return {
    appActive,
    appHidden: false,
    frontmostIsSelf: appActive,
    mainWindowAvailable: true,
    mainVisible: visible,
    mainKey: visible,
    mainFocused: visible,
    mainOnActiveSpace: visible,
    mainOcclusionVisible: visible,
  };
}

function stage(visible, appActive, keyEvents) {
  return {
    foreground: foreground(appActive, visible),
    frontmostMatchesBaseline: true,
    inputFound: true,
    inputFocused: visible,
    contentViewStable: true,
    documentVisible: visible,
    documentHasFocus: visible,
    appActivationEvents: 0,
    appActivationEventDelta: 0,
    mainKeyEvents: keyEvents,
    mainKeyEventDelta: keyEvents,
  };
}

function nativeReport(owner, pid = PID, passed = true) {
  const level = 9;
  return {
    schemaVersion: 1,
    kind: "main-panel-prototype",
    journey: "main-panel",
    scope: "isolated-main-window-panel-prototype",
    ...owner,
    pid,
    fullProductAcceptance: false,
    visualStatus: "not-captured",
    conversion: {
      scopedIdentifierMatches: true,
      mainWindowHiddenBeforeConversion: true,
      sameNativeWindow: true,
      originalClass: "TaoWindow",
      originalClassAssessment: {
        kind: "tao",
        actualClass: "TaoWindow",
        reportedClass: "TaoWindow",
        actualSuperclass: "NSWindow",
        actualInstanceSize: 512,
        taoInstanceSize: 512,
        ownIvarCount: 0,
        ownMethodNames: [],
        taoDirectSuperclassIsNsWindow: true,
      },
      panelClass: "AToolsMainPanel",
      originalInstanceSize: 512,
      panelInstanceSize: 448,
      taoFocusableOffset: 480,
      nsPanelOwnIvarCount: 0,
      focusableLayoutSafe: true,
      isPanel: true,
      panelClassMatches: true,
      nonactivatingStyle: true,
      selectorAvailable: true,
      canBecomeKey: true,
      canBecomeMain: false,
      stillHidden: true,
      originalDelegateUnchanged: true,
      contentViewAndParentUnchanged: true,
      collectionBehaviorUnchanged: true,
      releasedWhenClosedUnchanged: true,
      subviewMasksAdjusted: true,
      level,
      floating: true,
      hidesOnDeactivate: false,
      becomesKeyOnlyIfNeeded: false,
      subviewCount: 3,
      textInputMethodAdded: false,
      runtimeMethodLifetime: "until-process-exit",
      runtimeMethodRemovalSupported: false,
    },
    restoration: {
      sameNativeWindow: true,
      originalClassRestored: true,
      originalDelegateRestored: true,
      releasedWhenClosedRestored: true,
      subviewMasksRestored: true,
      contentViewRestored: true,
      styleMaskRestored: true,
      levelRestored: true,
      collectionBehaviorRestored: true,
      hidesOnDeactivateRestored: true,
      canBecomeKeyRestored: true,
      canBecomeMainRestored: true,
      panelFloatingBaselineRestored: true,
      panelBecomesKeyBaselineRestored: true,
      windowRestored: true,
      textInputMethodRemains: false,
      runtimeMethodLifetime: "until-process-exit",
      runtimeMethodRemovalSupported: false,
    },
    stages: {
      baseline: stage(false, false, 0),
      shown: stage(true, false, 1),
      hidden: stage(false, false, 2),
      reshown: stage(true, false, 3),
    },
    activation: {
      baselineAppActivationEvents: 0,
      finalAppActivationEvents: 0,
      appActivationEventDelta: 0,
      baselineMainKeyEvents: 0,
      finalMainKeyEvents: 3,
      mainKeyEventDelta: 3,
      observerRegistered: 2,
      observerRemoved: 2,
      observerInstalled: false,
    },
    cleanup: {
      windowHidden: true,
      panelActive: false,
      nativeOperationsTerminal: true,
      observersRemoved: true,
    },
    errors: passed ? [] : ["main-panel-prototype-show-failed"],
    passed,
  };
}

function terminalProcess(pid = PID, exitCode = 0) {
  return {
    spawned: true,
    pid,
    terminalObserved: true,
    exitCode,
    signal: null,
    timedOut: false,
    termination: { attempted: false, signals: [] },
    stdout: { capturedBytes: 0, observedBytes: 0, truncated: false, sha256: "0".repeat(64) },
    stderr: { capturedBytes: 0, observedBytes: 0, truncated: false, sha256: "0".repeat(64) },
    exception: null,
  };
}

function readArg(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? null : args[index + 1];
}

async function createCaseDirectories(runId) {
  assert.equal(await realpath(FIXTURE_PARENT), FIXTURE_PARENT);
  const created = await mkdtemp(join(tmpdir(), `atools-r56-main-panel-${runId}-`));
  await chmod(created, 0o700);
  const parent = await realpath(created);
  const runDirectory = join(parent, "run");
  await mkdir(runDirectory, { mode: 0o700 });
  return { parent, runDirectory };
}

async function stageFake({ binary, runDirectory, runId, autoClear, expectedSha256, mode }) {
  assert.equal(mode, "single");
  assert.equal(autoClear, "never");
  assert.equal(binary, "/workspace/AToolsRendererSmoke");
  assert.equal(expectedSha256, SHA);
  const owner = ownerFor(runId);
  const bundlePath = join(runDirectory, "case-never.app");
  const executable = join(bundlePath, "Contents", "MacOS", "AToolsRendererSmoke");
  const infoPath = join(bundlePath, "Contents", "Info.plist");
  await mkdir(join(bundlePath, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
  await mkdir(join(bundlePath, "Contents", "Resources"), { mode: 0o700 });
  await writeFile(executable, "fake executable", { flag: "wx", mode: 0o755 });
  const infoPlist = `<plist><dict><key>CFBundleIdentifier</key><string>${owner.identifier}</string><key>LSUIElement</key><false/></dict></plist>`;
  await writeFile(infoPath, infoPlist, { flag: "wx", mode: 0o600 });
  const info = await lstat(bundlePath, { bigint: true });
  return {
    bundlePath,
    runDirectory,
    executable,
    identifier: owner.identifier,
    infoPlistIdentifier: owner.identifier,
    runId,
    sourceSha256: expectedSha256,
    stagedSha256: expectedSha256,
    ownerIdentity: `${String(info.dev)}:${String(info.ino)}`,
    mode,
    probeResource: null,
    settingsBundle: null,
    infoPlist,
  };
}

async function createProfileRoot(owner, pid, markerIdentifier = owner.identifier) {
  await mkdir(owner.root, { mode: 0o700 });
  await mkdir(join(owner.root, "app-data"), { mode: 0o700 });
  await mkdir(join(owner.root, "webview"), { mode: 0o700 });
  await writeFile(join(owner.root, ".atools-renderer-smoke-owner.json"), JSON.stringify({
    schemaVersion: 1, pid, identifier: markerIdentifier, root: owner.root,
  }), { flag: "wx", mode: 0o600 });
}

async function writeReport(path, value) {
  await writeFile(path, JSON.stringify(value), { flag: "wx", mode: 0o600 });
}

test("R56 single-app case accepts a valid report and reclaims its owned profile and bundle", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const { parent, runDirectory } = await createCaseDirectories(runId);
  let bundlePath;
  try {
    const result = await runMainPanelNativeCase({
      runDirectory,
      workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: SHA },
      rendererDist: "/workspace/packages/ztools-renderer/dist",
      runId,
      stageBundle: async args => {
        const staged = await stageFake(args);
        bundlePath = staged.bundlePath;
        return staged;
      },
      runProcess: async (binary, args, options) => {
        assert.equal(binary, join(bundlePath, "Contents", "MacOS", "AToolsRendererSmoke"));
        assert.equal(options.timeoutMs, 75_000);
        assert.equal(readArg(args, "--fixture-root"), owner.root);
        assert.equal(readArg(args, "--run-id"), runId);
        assert.equal(readArg(args, "--auto-clear"), "never");
        assert.equal(readArg(args, "--journey"), "main-panel");
        await createProfileRoot(owner, PID);
        await writeReport(readArg(args, "--output"), nativeReport(owner));
        return terminalProcess();
      },
    });
    assert.equal(result.nativeReport?.valid, true, JSON.stringify(result));
    assert.equal(result.nativeReport?.passed, true);
    assert.equal(result.appBundle?.mode, "single");
    assert.equal(result.appBundle?.probeResource, null);
    assert.equal(result.appBundle?.settingsBundle, null);
    assert.equal(result.appBundle?.nodeBundle, null);
    assert.equal(result.appBundle?.pluginResources, null);
    assert.equal(result.profileOwner?.valid, true);
    assert.equal(result.cleanup.allOwnedResourcesClean, true);
    assert.equal(result.passed, true);
    assert.equal(await lstat(owner.root).then(() => true, () => false), false);
    assert.equal(await lstat(bundlePath).then(() => true, () => false), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
  }
});

test("a valid business-failure report remains failed while terminal owned resources are reclaimed", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const { parent, runDirectory } = await createCaseDirectories(runId);
  let bundlePath;
  try {
    const result = await runMainPanelNativeCase({
      runDirectory,
      workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: SHA },
      rendererDist: "/workspace/packages/ztools-renderer/dist",
      runId,
      stageBundle: async args => {
        const staged = await stageFake(args);
        bundlePath = staged.bundlePath;
        return staged;
      },
      runProcess: async (_binary, args) => {
        await createProfileRoot(owner, PID);
        await writeReport(readArg(args, "--output"), nativeReport(owner, PID, false));
        return terminalProcess(PID, 1);
      },
    });
    assert.equal(result.nativeReport?.valid, true, JSON.stringify(result));
    assert.equal(result.nativeReport?.passed, false);
    assert.equal(result.passed, false);
    assert.equal(result.cleanup.allOwnedResourcesClean, true);
    assert.equal(await lstat(owner.root).then(() => true, () => false), false);
    assert.equal(await lstat(bundlePath).then(() => true, () => false), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
  }
});

test("a nonterminal own process preserves its profile and staged app", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const { parent, runDirectory } = await createCaseDirectories(runId);
  let bundlePath;
  try {
    const result = await runMainPanelNativeCase({
      runDirectory,
      workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: SHA },
      rendererDist: "/workspace/packages/ztools-renderer/dist",
      runId,
      stageBundle: async args => {
        const staged = await stageFake(args);
        bundlePath = staged.bundlePath;
        return staged;
      },
      runProcess: async (_binary, args) => {
        await createProfileRoot(owner, PID);
        return { ...terminalProcess(), terminalObserved: false, exitCode: null, timedOut: true };
      },
    });
    assert.equal(result.passed, false);
    assert.equal(result.cleanup.processTerminal, false);
    assert.equal(result.cleanup.allOwnedResourcesClean, false);
    assert.equal(await lstat(owner.root).then(() => true, () => false), true);
    assert.equal(await lstat(bundlePath).then(() => true, () => false), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
  }
});

test("a terminal process with a mismatched profile owner cannot pass or trigger deletion", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const owner = ownerFor(runId);
  const { parent, runDirectory } = await createCaseDirectories(runId);
  let bundlePath;
  try {
    const result = await runMainPanelNativeCase({
      runDirectory,
      workspaceRoot: "/workspace/atools",
      binaryFingerprint: { path: "/workspace/AToolsRendererSmoke", sha256: SHA },
      rendererDist: "/workspace/packages/ztools-renderer/dist",
      runId,
      stageBundle: async args => {
        const staged = await stageFake(args);
        bundlePath = staged.bundlePath;
        return staged;
      },
      runProcess: async (_binary, args) => {
        await createProfileRoot(owner, PID, "dev.atools.renderer-smoke.ffffffffffffffffffffffffffffffff");
        await writeReport(readArg(args, "--output"), nativeReport(owner));
        return terminalProcess();
      },
    });
    assert.equal(result.profileOwner?.valid, false);
    assert.equal(result.passed, false);
    assert.equal(result.cleanup.allOwnedResourcesClean, false);
    assert.equal(await lstat(owner.root).then(() => true, () => false), true);
    assert.equal(await lstat(bundlePath).then(() => true, () => false), true);
  } finally {
    await rm(parent, { recursive: true, force: true });
    await rm(owner.root, { recursive: true, force: true });
  }
});
