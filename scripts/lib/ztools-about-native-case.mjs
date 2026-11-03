import assert from 'node:assert/strict';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { stageRendererNativeApp, runNativeChild, readJsonNoFollow, nativeChildEnvironment,
  cleanupOwnedFixtureRoot, cleanupOwnedRendererApp, OWNER_MARKER_NAME } from './ztools-renderer-native-runtime.mjs';
import { fingerprintNativeExecutable } from './ztools-renderer-native-source-binding.mjs';
import { stageUpdaterNativeAssets, hashUpdaterTree } from './ztools-updater-native-assets.mjs';
import { updaterFixtureRoot, updaterRunId } from './ztools-updater-native-protocol.mjs';
import { validateAboutNativeReport } from './ztools-about-native-report.mjs';
import { buildAboutNativeArgs } from './ztools-about-native-protocol.mjs';
import { stageAboutNativeAssets, verifyAboutStagedAssets } from './ztools-about-native-assets.mjs';

const ABOUT_NATIVE_REPORT_MAX_BYTES = 256 * 1024;

export async function assertUpdaterPathAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw Error('Owned updater root/report/App must not already exist');
}
export async function createAboutNativeRunDirectory(root, runId) {
  runId = updaterRunId(runId);
  let directory = root;
  for (const part of ['output', 'renderer-about-update-r79-2026-11-02', 'native', 'node-runner', 'runs']) {
    directory = join(directory, part); await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory); assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(await realpath(directory), directory);
  }
  directory = join(directory, runId); await mkdir(directory, { mode: 0o700 });
  assert.equal((await lstat(directory)).mode & 0o077, 0);
  return directory;
}
function errorRecord(error) { return { name: error.name ?? 'Error', code: error.code ?? null, message: String(error.message).slice(0, 400) }; }
export function assertUpdaterNativeTerminal(child) {
  assert.equal(child.spawned, true); assert.equal(child.terminalObserved, true, 'No runtime claim before actual child terminal');
  assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
  assert.equal(child.timedOut, false, 'Timeout termination is failure, never completion');
  assert.equal(child.exitCode, 0); assert.equal(child.signal, null);
}

/** Exactly one child is observed through its actual terminal close; never resume/retry a failed journey. */
export async function runAboutNativeCase({ root, runDirectory, runId, inputs }, ports = {}) {
  const fixtureRoot = updaterFixtureRoot(runId), output = join(runDirectory, 'native-report.json');
  const result = { runId, fixtureRoot, nativeReport: null, process: null, app: null,
    cleanup: { processTerminal: null, allOwnedResourcesClean: false }, errors: [], passed: false };
  let staged, child, marker, rootIdentity, markerIdentity, reportValid = false;
  try {
    for (const path of [fixtureRoot, output, join(runDirectory, 'case-never.app')]) await assertUpdaterPathAbsent(path);
    staged = await stageRendererNativeApp({ binary: inputs.binary.path, runDirectory, autoClear: 'never', runId,
      expectedSha256: inputs.binary.sha256, mode: 'multiwebview' });
    assert.equal(staged.identifier, `dev.atools.renderer-smoke.${runId}`);
    const updater = await stageUpdaterNativeAssets({ snapshot: inputs.assets.updater, staged });
    const about = await stageAboutNativeAssets({ assets: inputs.assets, staged });
    result.app = { identifier: staged.identifier, executable: 'Contents/MacOS/AToolsRendererSmoke',
      sourceSha256: staged.sourceSha256, stagedSha256: staged.stagedSha256, updater, about };
    assert.equal((await fingerprintNativeExecutable(staged.executable)).sha256, inputs.binary.sha256);
    child = await (ports.launchChild ?? runNativeChild)(staged.executable, buildAboutNativeArgs({ runId, fixtureRoot,
      rendererDist: about.mainDist, output }), {
      timeoutMs: 150000, spawnOptions: { cwd: root, env: nativeChildEnvironment(process.env) } });
    result.process = child;
    if (child.terminalObserved) {
      try { result.nativeReport = await readJsonNoFollow(output, ABOUT_NATIVE_REPORT_MAX_BYTES); }
      catch (error) { result.reportReadError = errorRecord(error); }
    }
    assertUpdaterNativeTerminal(child);
    marker = await readJsonNoFollow(join(fixtureRoot, OWNER_MARKER_NAME), 4096);
    const rootInfo = await lstat(fixtureRoot, { bigint: true }), markerInfo = await lstat(join(fixtureRoot, OWNER_MARKER_NAME), { bigint: true });
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink()); assert.equal(await realpath(fixtureRoot), fixtureRoot);
    assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink());
    assert.equal(rootInfo.mode & 0o777n, 0o700n); assert.equal(markerInfo.mode & 0o777n, 0o600n);
    assert.equal(marker.root, fixtureRoot); assert.equal(marker.pid, child.pid);
    assert.equal(marker.identifier, staged.identifier);
    rootIdentity = `${rootInfo.dev}:${rootInfo.ino}`; markerIdentity = `${markerInfo.dev}:${markerInfo.ino}`;
    result.cleanup.ownership = { rootIdentity, markerIdentity };
    (ports.validateReport ?? validateAboutNativeReport)(result.nativeReport, { runId, pid: child.pid });
    assert.deepEqual(await hashUpdaterTree(join(staged.bundlePath, 'Contents/Resources/ztools-updater')), inputs.assets.updater.files);
    assert.equal((await fingerprintNativeExecutable(staged.executable)).sha256, inputs.binary.sha256);
    await verifyAboutStagedAssets({ assets: inputs.assets, staged });
    reportValid = true;
  } catch (error) { result.errors.push(errorRecord(error)); }
  finally {
    const terminal = child ? (!child.spawned || child.terminalObserved) : true;
    result.cleanup.processTerminal = terminal;
    // The outer owner must pass its final source/binary/asset/receipt gate before invoking cleanup.
    result.cleanup.retained = { reason: !terminal ? 'child-not-terminal' : reportValid ? 'final-input-gate-pending' : 'failed-journey-evidence', fixtureRoot,
      bundlePath: staged?.bundlePath ?? null };
  }
  result.runtimePassed = reportValid && result.errors.length === 0;
  let completed = false;
  Object.defineProperty(result, 'completeCleanup', { value: async () => {
    if (completed || !result.runtimePassed || !result.cleanup.processTerminal || !marker) return result;
    completed = true;
    try {
      result.cleanup.fixtureRoot = await (ports.cleanupFixtureRoot ?? cleanupOwnedFixtureRoot)({ root: fixtureRoot,
        childPid: child.pid, processTerminal: true, expectedRootIdentity: rootIdentity, expectedMarkerIdentity: markerIdentity });
      if (result.cleanup.fixtureRoot.rootAbsent === true) {
        result.cleanup.app = await cleanupOwnedRendererApp({ ...staged, processTerminal: true });
        result.cleanup.allOwnedResourcesClean = result.cleanup.app.bundleAbsent === true;
      }
      if (result.cleanup.allOwnedResourcesClean) delete result.cleanup.retained;
      else result.cleanup.retained.reason = 'owned-cleanup-rejected';
    } catch (error) { result.errors.push(errorRecord(error)); result.cleanup.retained.reason = 'owned-cleanup-failed'; }
    result.passed = result.runtimePassed && result.errors.length === 0 && result.cleanup.allOwnedResourcesClean;
    return result;
  } });
  return result;
}
