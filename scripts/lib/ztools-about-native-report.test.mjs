// Synthetic values exercise only the independent report parser. Never Native runtime evidence.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ABOUT_NATIVE_STAGES, validateAboutNativeReport } from './ztools-about-native-report.mjs';
import { ABOUT_SETTINGS_FORMAL } from './ztools-about-native-protocol.mjs';
const runId = 'a'.repeat(32), child1 = 'b'.repeat(32), child2 = 'c'.repeat(32), popup = 'd'.repeat(32), candidate = 'e'.repeat(32), pid = 12345;
const bundle = ABOUT_SETTINGS_FORMAL.provenanceSha256;
function settings(open = false) {
  return { sessionCount: +open, childCount: +open, ready: open, phase: open ? 'open' : null, documentAuthorized: open,
    revoked: false, pendingCalls: 0, pendingWrites: 0, bundleRevisionPresent: open, compiledBundleRevision: bundle, layoutRegistrationCount: +open };
}
function updater(open = false) {
  return { sessionId: open ? popup : null, sessionCandidateId: open ? candidate : null, candidateId: open ? candidate : null,
    phase: open ? 'available' : 'idle', ready: open, alive: open, closing: false, windowExists: open, windowCount: +open,
    opening: false, busy: false, operationId: null, windowVisible: open ? false : null, windowFocused: open ? false : null };
}
function runtime(enabled = false, stopped = false) {
  return { scheduler: { generation: 1, initialized: true, enabled, stopped, controllerStarted: true, workerActive: false,
    timerCount: null, timerDirectlyObserved: false }, manualSlotCount: 0, schedulerDirectlyObserved: true, manualSlotDirectlyObserved: true };
}
function emptyReceipt() { return { version: null, manual: null, auto: null, apiCalls: null, negative: null }; }
function fixtureReport() {
  const stages = ABOUT_NATIVE_STAGES.map((stage, i) => {
    const kind = stage.startsWith('settings-') ? 'native' : stage.startsWith('popup-') ? 'popup' : stage.startsWith('main-') ? 'main' : 'child';
    const open = i > 0 && i < 9 && !stage.startsWith('settings-');
    const popupOpen = i >= 2 && i < 10;
    const dom = kind === 'native' ? null : { ready: true, title: kind === 'popup' ? '发现新版本 99.78.0' : '', text: '',
      appVersion: kind === 'child' ? 'v1.2.3' : null, autoChecked: kind === 'child' ? stage === 'auto-on' : null,
      checkDisabled: kind === 'child' ? false : null, bridgePresent: !stage.endsWith('disposed'), disposed: stage.endsWith('disposed'), bundleRevision: kind === 'child' ? bundle : null };
    const receipt = ['native', 'popup'].includes(kind) || stage === 'main-disposed' ? null : emptyReceipt();
    if (stage === 'main-ready') receipt.negative = { badToken: true, wrongFrame: true };
    if (stage === 'about-ready' || stage === 'about-reopened') { receipt.version = '1.2.3'; receipt.apiCalls = { version: 1, manual: 0, auto: 0 }; }
    if (stage === 'about-manual') {
      receipt.manual = { success: true, hasUpdate: true, status: 'available', version: '99.78.0' };
      receipt.apiCalls = { version: 1, manual: 1, auto: 0 };
    }
    if (stage === 'auto-on' || stage === 'auto-off') {
      receipt.auto = { revision: (stage === 'auto-on' ? '1' : '2').repeat(32), autoValue: stage === 'auto-on', notificationDelivered: true, runtimeApplied: true, runtimeError: null };
      receipt.apiCalls = { version: 1, manual: 1, auto: stage === 'auto-on' ? 1 : 2 };
    }
    const sessionId = kind === 'child' ? stage === 'about-reopened' ? child2 : child1 : kind === 'popup' ? popup : null;
    return { stage, sourceKind: kind, sourceLabel: kind === 'native' ? null : kind === 'main' ? 'main' : `${kind === 'child' ? 'ztools-settings' : 'renderer-updater'}-${sessionId}`, sessionId, dom, receipt,
      native: { settings: settings(open), updater: updater(popupOpen),
        general: { autoCheckUpdate: stage === 'auto-on', sentinelMatches: true, onlyAutoFieldChanged: stage === 'auto-on' || stage === 'auto-off' ? true : null,
          rawSha256: (stage === 'auto-on' ? '1' : '0').repeat(64), casWrites: null, casWritesDirectlyObserved: false }, runtime: runtime(stage === 'auto-on', stage === 'main-disposed') } };
  });
  return { schemaVersion: 1, journey: 'updater', mode: 'about', runId, pid, passed: true, errors: [], inputSource: 'rust-injected-javascript',
    physicalOsInput: false, realSdk: false, realNetwork: false, fakeClock: false, appVersion: '1.2.3', stages,
    fixture: { checkCalls: 1, downloadCalls: 0, activeWork: 0, forbiddenEffectCalls: 0, installCalls: 0, applyCalls: 0, restartCalls: 0, archiveProduction: 'unsupported' },
    rejectedProbeCalls: 2, cleanup: { settings: settings(), updater: updater(), runtime: runtime(false, true), destroyedEvents: 1,
      closedChildGenerations: 2, staleChildRejected: true, activeWork: 0, listenerCount: null, listenersDirectlyObserved: false } };
}
test('synthetic parser fixture follows frozen exact wire schema (not Native evidence)', () => {
  assert.equal(validateAboutNativeReport(fixtureReport(), { runId, pid }).valid, true);
});
test('closed report rejects wrong mode, extra keys, stage order, source reuse and cross-candidate claims', () => {
  for (const mutate of [r => r.mode = 'popup', r => r.extra = true, r => r.stages.reverse(), r => r.stages.pop(),
    r => r.stages[1].native.settings.extra = 0, r => r.stages[7].sessionId = child1,
    r => r.stages[3].native.updater.candidateId = 'f'.repeat(32), r => r.stages[1].dom.appVersion = '1.2.3',
    r => r.stages[6].sourceKind = 'child', r => r.stages[4].receipt.apiCalls.auto = 2,
    r => r.stages[5].receipt.auto.revision = r.stages[4].receipt.auto.revision,
    r => r.stages[4].receipt.auto.runtimeApplied = false, r => r.stages[5].native.general.onlyAutoFieldChanged = false,
    r => r.stages[8].native.general.sentinelMatches = false, r => r.stages[1].native.settings.compiledBundleRevision = '1'.repeat(64),
    r => r.stages[1].receipt.extra = 1, r => r.stages[4].receipt.auto.rawSql = 'bad', r => r.stages[1].dom.text = 'x'.repeat(2049)]) {
    const bad = fixtureReport(); mutate(bad); assert.throws(() => validateAboutNativeReport(bad, { runId, pid }));
  }
});
test('cleanup cannot infer zero listeners/timers/CAS, hide workers, or retain live child/window/manual work', () => {
  for (const mutate of [r => r.cleanup.listenerCount = 0, r => r.cleanup.destroyedEvents = 0, r => r.cleanup.closedChildGenerations = 1,
    r => r.cleanup.staleChildRejected = false, r => r.cleanup.settings.pendingCalls = 1, r => r.cleanup.settings.pendingWrites = 1,
    r => r.cleanup.updater.windowExists = true, r => r.cleanup.runtime.scheduler.workerActive = true,
    r => r.cleanup.runtime.scheduler.enabled = true, r => r.cleanup.runtime.scheduler.stopped = false,
    r => r.cleanup.runtime.manualSlotCount = 1, r => r.cleanup.runtime.scheduler.timerCount = 0,
    r => r.stages[1].native.general.casWrites = 1, r => r.cleanup.runtime.schedulerDirectlyObserved = false,
    r => r.fixture.downloadCalls = 1, r => r.fixture.checkCalls = 2, r => r.realNetwork = true, r => r.pid++]) {
    const bad = fixtureReport(); mutate(bad); assert.throws(() => validateAboutNativeReport(bad, { runId, pid }));
  }
});
