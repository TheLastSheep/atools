import assert from 'node:assert/strict';
import { assertAboutStages } from './ztools-about-native-report-stages.mjs';
import { assertAboutNativeShapes } from './ztools-about-native-report-shapes.mjs';
export const ABOUT_NATIVE_STAGES = ['main-ready', 'about-ready', 'about-manual', 'popup-ready', 'auto-on', 'auto-off',
  'settings-closed', 'about-reopened', 'settings-final-closed', 'popup-disposed', 'main-disposed'];
function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
export function validateAboutNativeReport(report, { runId, pid }) {
  exact(report, ['schemaVersion', 'journey', 'mode', 'runId', 'pid', 'passed', 'errors', 'inputSource', 'physicalOsInput',
    'realSdk', 'realNetwork', 'fakeClock', 'appVersion', 'stages', 'fixture', 'rejectedProbeCalls', 'cleanup']);
  assert.match(runId, /^[0-9a-f]{32}$/); assert.equal(report.runId, runId);
  assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.equal(report.pid, pid);
  assert.equal(report.schemaVersion, 1); assert.equal(report.journey, 'updater'); assert.equal(report.mode, 'about');
  assert.equal(report.passed, true); assert.deepEqual(report.errors, []);
  assert.equal(report.inputSource, 'rust-injected-javascript');
  for (const key of ['physicalOsInput', 'realSdk', 'realNetwork', 'fakeClock']) assert.equal(report[key], false);
  assert.equal(report.rejectedProbeCalls, 2);
  assert.equal(typeof report.appVersion, 'string'); assert.ok(Buffer.byteLength(report.appVersion) > 0 && Buffer.byteLength(report.appVersion) <= 128);
  assert.ok(Array.isArray(report.stages)); assert.deepEqual(report.stages.map(s => s.stage), ABOUT_NATIVE_STAGES);
  for (const row of report.stages) {
    exact(row, ['stage', 'sourceKind', 'sourceLabel', 'sessionId', 'dom', 'receipt', 'native']);
    assert.ok(['main', 'child', 'popup', 'native'].includes(row.sourceKind));
    if (row.sourceKind === 'native') { assert.equal(row.sourceLabel, null); assert.equal(row.sessionId, null); }
    if (row.receipt !== null) assert.ok(Buffer.byteLength(JSON.stringify(row.receipt)) <= 8192);
    exact(row.native, ['settings', 'updater', 'general', 'runtime']);
  }
  exact(report.fixture, ['checkCalls', 'downloadCalls', 'activeWork', 'forbiddenEffectCalls', 'installCalls', 'applyCalls', 'restartCalls', 'archiveProduction']);
  assert.equal(report.fixture.checkCalls, 1); assert.equal(report.fixture.archiveProduction, 'unsupported');
  for (const k of ['downloadCalls', 'activeWork', 'forbiddenEffectCalls', 'installCalls', 'applyCalls', 'restartCalls']) assert.equal(report.fixture[k], 0);
  exact(report.cleanup, ['settings', 'updater', 'runtime', 'destroyedEvents', 'closedChildGenerations', 'staleChildRejected', 'activeWork', 'listenerCount', 'listenersDirectlyObserved']);
  assert.equal(report.cleanup.destroyedEvents, 1); assert.equal(report.cleanup.closedChildGenerations, 2);
  assert.equal(report.cleanup.staleChildRejected, true); assert.equal(report.cleanup.activeWork, 0);
  assert.equal(report.cleanup.listenerCount, null); assert.equal(report.cleanup.listenersDirectlyObserved, false);
  assertAboutNativeShapes(report);
  assertAboutStages(report);
  return { valid: true, passed: true, actualDestroyed: 1 };
}
