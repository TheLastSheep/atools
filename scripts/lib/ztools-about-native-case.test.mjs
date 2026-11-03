// Port doubles below verify runner ownership/terminal gates; none is Native acceptance.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, symlink, realpath, lstat, readFile, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sha256 } from '../../packages/ztools-build/pinned-inputs.mjs';
import { stageRendererNativeApp, cleanupOwnedRendererApp, cleanupOwnedFixtureRoot, OWNER_MARKER_NAME } from './ztools-renderer-native-runtime.mjs';
import { stageUpdaterNativeAssets, hashUpdaterTree } from './ztools-updater-native-assets.mjs';
import { fingerprintNativeExecutable } from './ztools-renderer-native-source-binding.mjs';
import { runAboutNativeCase } from './ztools-about-native-case.mjs';
import { ABOUT_NATIVE_STAGES, validateAboutNativeReport } from './ztools-about-native-report.mjs';
import { ABOUT_SETTINGS_FORMAL } from './ztools-about-native-protocol.mjs';
import { captureAboutRuntimeAssets } from './ztools-about-native-sources.mjs';
import { runAboutNativeAcceptance } from '../test-ztools-about-native.mjs';

async function isolatedCase(reportText = '{}') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'r79-cleanup-gates-')));
  const distRoot = join(directory, 'dist'), runDirectory = join(directory, 'run'), binary = join(directory, 'fixture-binary');
  await mkdir(join(distRoot, 'assets'), { recursive: true }); await mkdir(runDirectory, { mode: 0o700 });
  await writeFile(binary, 'never executed', { mode: 0o755 });
  for (const name of ['updater.html', 'assets/app.js', 'assets/app.css', 'assets/logo.png', 'build-provenance.json', 'source-manifest.json', 'ZTools-LICENSE'])
    await writeFile(join(distRoot, name), name);
  process.env.ATOOLS_ZTOOLS_SOURCE = '/Users/harris/Desktop/ZTools';
  const actualAssets = await captureAboutRuntimeAssets(process.cwd());
  const inputs = { binary: await fingerprintNativeExecutable(binary), assets: { ...actualAssets, updater: {
    distRoot, files: await hashUpdaterTree(distRoot), identity: { provenanceSha256: 'b'.repeat(64) } } } };
  let fixtureRoot;
  const ports = { validateReport() {}, async launchChild(_binary, args) {
    const value = flag => args[args.indexOf(flag) + 1]; fixtureRoot = value('--fixture-root');
    await mkdir(fixtureRoot, { mode: 0o700 });
    await writeFile(join(fixtureRoot, OWNER_MARKER_NAME), JSON.stringify({ schemaVersion: 1, pid: process.pid,
      root: fixtureRoot, identifier: `dev.atools.renderer-smoke.${value('--run-id')}` }), { mode: 0o600 });
    await writeFile(value('--output'), reportText);
    return { spawned: true, terminalObserved: true, pid: process.pid, timedOut: false, exitCode: 0, signal: null };
  } };
  return { directory, runDirectory, inputs, ports, root: () => fixtureRoot, async close() {
    if (fixtureRoot) { await rm(fixtureRoot, { recursive: true, force: true }); await rm(fixtureRoot + '.held', { recursive: true, force: true }); }
    await rm(directory, { recursive: true, force: true });
  } };
}


function validAboutNativeReport(runId, pid) {
  const child1 = 'b'.repeat(32), child2 = 'c'.repeat(32), popup = 'd'.repeat(32), candidate = 'e'.repeat(32);
  const bundle = ABOUT_SETTINGS_FORMAL.provenanceSha256;
  const closedSettings = () => ({ sessionCount: 0, childCount: 0, ready: false, phase: null, documentAuthorized: false,
    revoked: false, pendingCalls: 0, pendingWrites: 0, bundleRevisionPresent: false, compiledBundleRevision: bundle, layoutRegistrationCount: 0 });
  const openSettings = () => ({ sessionCount: 1, childCount: 1, ready: true, phase: 'open', documentAuthorized: true,
    revoked: false, pendingCalls: 0, pendingWrites: 0, bundleRevisionPresent: true, compiledBundleRevision: bundle, layoutRegistrationCount: 1 });
  const runtime = (enabled = false, stopped = false) => ({ scheduler: { generation: 1, initialized: true, enabled, stopped,
    controllerStarted: true, workerActive: false, timerCount: null, timerDirectlyObserved: false },
    manualSlotCount: 0, schedulerDirectlyObserved: true, manualSlotDirectlyObserved: true });
  const reportStages = ABOUT_NATIVE_STAGES.map(stage => {
    const kind = stage.startsWith('settings-') ? 'native' : stage.startsWith('popup-') ? 'popup' : stage.startsWith('main-') ? 'main' : 'child';
    const nativeStage = kind === 'native';
    const disposed = stage === 'popup-disposed' || stage === 'main-disposed';
    const childSession = stage === 'about-reopened' ? child2 : child1;
    const sessionId = kind === 'native' ? null : kind === 'main' ? null : kind === 'popup' ? popup : childSession;
    const hasCandidate = ['about-manual', 'popup-ready', 'auto-on', 'auto-off', 'settings-closed',
      'about-reopened', 'settings-final-closed', 'popup-disposed'].includes(stage);
    const popupLive = ['popup-ready', 'auto-on', 'auto-off', 'settings-closed',
      'about-reopened', 'settings-final-closed', 'popup-disposed'].includes(stage);
    const updater = {
      sessionId: popupLive ? popup : null, sessionCandidateId: popupLive ? candidate : null,
      candidateId: hasCandidate ? candidate : null, phase: popupLive || hasCandidate ? 'available' : 'idle',
      ready: popupLive, alive: popupLive, closing: false, windowExists: popupLive, windowCount: popupLive ? 1 : 0,
      opening: false, busy: false, operationId: null, windowVisible: popupLive ? false : null, windowFocused: popupLive ? false : null,
    };
    let dom = null, receipt = null, sourceLabel = null;
    if (!nativeStage) {
      sourceLabel = kind === 'main' ? 'main' : (kind === 'child' ? 'ztools-settings-' : 'renderer-updater-') + sessionId;
      const appVersion = kind === 'child' ? 'v1.2.3' : null;
      dom = { ready: true, title: kind === 'popup' ? '发现新版本 99.78.0' : '', text: '', appVersion,
        autoChecked: kind === 'child' ? stage === 'auto-on' : null, checkDisabled: kind === 'child' ? false : null,
        bridgePresent: !disposed, disposed: disposed, bundleRevision: kind === 'child' ? bundle : null };
      if (!['popup-ready', 'popup-disposed', 'main-disposed'].includes(stage)) {
        receipt = { version: null, manual: null, auto: null, apiCalls: null, negative: null };
      }
      if (stage === 'main-ready') receipt.negative = { badToken: true, wrongFrame: true };
      if (stage === 'about-ready' || stage === 'about-reopened') {
        receipt.version = '1.2.3'; receipt.apiCalls = { version: 1, manual: 0, auto: 0 };
      }
      if (stage === 'about-manual') {
        receipt.manual = { success: true, hasUpdate: true, status: 'available', version: '99.78.0' };
        receipt.apiCalls = { version: 1, manual: 1, auto: 0 };
      }
      if (stage === 'auto-on' || stage === 'auto-off') {
        receipt.auto = { revision: (stage === 'auto-on' ? '1' : '2').repeat(32), autoValue: stage === 'auto-on',
          notificationDelivered: true, runtimeApplied: true, runtimeError: null };
        receipt.apiCalls = { version: 1, manual: 1, auto: stage === 'auto-on' ? 1 : 2 };
      }
    }
    const open = ['about-ready', 'about-manual', 'popup-ready', 'auto-on', 'auto-off', 'about-reopened'].includes(stage);
    const autoOn = stage === 'auto-on';
    const autoSwitch = autoOn || stage === 'auto-off';
    return { stage, sourceKind: kind, sourceLabel, sessionId, dom, receipt,
      native: { settings: open ? openSettings() : closedSettings(), updater,
        general: { autoCheckUpdate: autoOn, sentinelMatches: true, onlyAutoFieldChanged: autoSwitch ? true : null,
          rawSha256: autoOn ? '1'.repeat(64) : '0'.repeat(64), casWrites: null, casWritesDirectlyObserved: false },
        runtime: runtime(autoOn, stage === 'main-disposed') } };
  });
  return { schemaVersion: 1, journey: 'updater', mode: 'about', runId, pid, passed: true, errors: [],
    inputSource: 'rust-injected-javascript', physicalOsInput: false, realSdk: false, realNetwork: false,
    fakeClock: false, appVersion: '1.2.3', stages: reportStages,
    fixture: { checkCalls: 1, downloadCalls: 0, activeWork: 0, forbiddenEffectCalls: 0, installCalls: 0,
      applyCalls: 0, restartCalls: 0, archiveProduction: 'unsupported' }, rejectedProbeCalls: 2,
    cleanup: { settings: closedSettings(), updater: { sessionId: null, sessionCandidateId: null, candidateId: null,
      phase: 'idle', ready: false, alive: false, closing: false, windowExists: false, windowCount: 0, opening: false,
      busy: false, operationId: null, windowVisible: null, windowFocused: null },
      runtime: runtime(false, true), destroyedEvents: 1, closedChildGenerations: 2, staleChildRejected: true,
      activeWork: 0, listenerCount: null, listenersDirectlyObserved: false } };
}

// launchChild writes only the report bytes; the production case reader and report validator remain active.
test('actual About case reader enforces the raw 256 KiB report boundary before JSON validation', async () => {
  const maxBytes = 256 * 1024;
  for (const overLimit of [false, true]) {
    const runId = randomUUID().replaceAll('-', ''), report = validAboutNativeReport(runId, process.pid);
    const compact = JSON.stringify(report), compactBytes = Buffer.byteLength(compact);
    assert.ok(compactBytes < maxBytes);
    const exactBoundary = compact + ' '.repeat(maxBytes - compactBytes);
    const rawReport = exactBoundary + (overLimit ? ' ' : '');
    assert.equal(Buffer.byteLength(rawReport), maxBytes + Number(overLimit));
    const fixture = await isolatedCase(rawReport);
    fixture.ports.validateReport = validateAboutNativeReport;
    try {
      const result = await runAboutNativeCase({ root: process.cwd(), runDirectory: fixture.runDirectory,
        runId, inputs: fixture.inputs }, fixture.ports);
      if (overLimit) {
        assert.equal(result.nativeReport, null);
        assert.equal(result.reportReadError.message, 'Invalid bounded JSON file');
        assert.equal(result.runtimePassed, false);
        assert.equal(result.cleanup.retained.reason, 'failed-journey-evidence');
      } else {
        assert.deepEqual(result.nativeReport, report, 'The actual bounded reader accepts legal trailing JSON whitespace at the byte cap');
        assert.equal(result.runtimePassed, true, JSON.stringify(result.errors));
        await result.completeCleanup();
        assert.equal(result.passed, true);
      }
    } finally { await fixture.close(); }
  }
});

test('actual runner preserves owned root/App when the final source gate drifts or throws', async () => {
  for (const failure of ['drift', 'throw']) {
    const fixture = await isolatedCase(); let reads = 0, cleanupCalls = 0;
    try {
      fixture.ports.cleanupFixtureRoot = async options => { cleanupCalls++; return cleanupOwnedFixtureRoot(options); };
      const code = await runAboutNativeAcceptance(['--journey', 'updater', '--updater-mode', 'about', '--auto-clear', 'never', '--binary', fixture.inputs.binary.path,
        '--build-receipt', join(fixture.directory, 'not-read-receipt.json')], {
        createRunDirectory: async () => fixture.runDirectory,
        preflight: async () => { if (++reads === 1) return fixture.inputs; if (failure === 'throw') throw Error('after-preflight failed'); return { ...fixture.inputs, changed: true }; },
        runCase: context => runAboutNativeCase(context, fixture.ports),
      });
      assert.equal(code, 1); assert.equal(cleanupCalls, 0, 'No cleanup before the actual final identity gate succeeds');
      assert.equal((await lstat(fixture.root())).isDirectory(), true);
      assert.equal((await lstat(join(fixture.runDirectory, 'case-never.app'))).isDirectory(), true);
    } finally { await fixture.close(); }
  }
});
test('actual cleanup caller rejects root or marker replacement carrying copied legal ownership', async () => {
  for (const replacement of ['root', 'marker']) {
    const fixture = await isolatedCase(); let cleanupResult;
    try {
    fixture.ports.cleanupFixtureRoot = async options => {
      const original = await readFile(join(options.root, OWNER_MARKER_NAME));
      if (replacement === 'root') { await rename(options.root, options.root + '.held'); await mkdir(options.root, { mode: 0o700 }); }
      else await rename(join(options.root, OWNER_MARKER_NAME), join(options.root, OWNER_MARKER_NAME + '.held'));
      await writeFile(join(options.root, OWNER_MARKER_NAME), original, { mode: 0o600 });
      cleanupResult = await cleanupOwnedFixtureRoot(options); return cleanupResult;
    };
    const result = await runAboutNativeCase({ root: process.cwd(), runDirectory: fixture.runDirectory,
      runId: randomUUID().replaceAll('-', ''), inputs: fixture.inputs }, fixture.ports);
    assert.equal(result.runtimePassed, true); await result.completeCleanup();
    assert.equal(cleanupResult.reason, replacement === 'root' ? 'root_identity_changed' : 'marker_identity_changed');
    assert.equal(cleanupResult.rootAbsent, false); assert.equal(result.passed, false);
    assert.equal((await lstat(fixture.root())).isDirectory(), true);
    assert.equal((await lstat(join(fixture.runDirectory, 'case-never.app'))).isDirectory(), true);
    if (replacement === 'root') assert.equal((await lstat(fixture.root() + '.held')).isDirectory(), true);
    } finally { await fixture.close(); }
  }
});
test('actual runner cleans the original owned resources only after its final identity gate succeeds', async () => {
  const fixture = await isolatedCase(); let reads = 0, cleanups = 0;
  try {
    fixture.ports.cleanupFixtureRoot = async options => { assert.equal(reads, 2); cleanups++; return cleanupOwnedFixtureRoot(options); };
    assert.equal(await runAboutNativeAcceptance(['--journey', 'updater', '--updater-mode', 'about', '--auto-clear', 'never', '--binary', fixture.inputs.binary.path,
      '--build-receipt', join(fixture.directory, 'not-read-receipt.json')], {
      createRunDirectory: async () => fixture.runDirectory, preflight: async () => { reads++; return fixture.inputs; },
      runCase: context => runAboutNativeCase(context, fixture.ports),
    }), 0);
    assert.equal(cleanups, 1); await assert.rejects(lstat(fixture.root()), { code: 'ENOENT' });
    await assert.rejects(lstat(join(fixture.runDirectory, 'case-never.app')), { code: 'ENOENT' });
  } finally { await fixture.close(); }
});

