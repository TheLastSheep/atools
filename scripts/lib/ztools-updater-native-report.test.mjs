import assert from 'node:assert/strict';
import test from 'node:test';
import { validateUpdaterNativeReport, UPDATER_NATIVE_STAGES } from './ztools-updater-native-report.mjs';
import { assertUpdaterNativeTerminal } from './ztools-updater-native-case.mjs';

const runId = 'a'.repeat(32), windowId = 'b'.repeat(32), candidateId = 'c'.repeat(32), pid = 12345;
function fixtureReport() {
  const native = () => ({ session: null, window: null, main: { visible: false, focused: false }, opening: false, windowCount: 0, busy: false,
    phase: 'available', operationId: null, candidateId, sequence: 1, errorCode: null });
  const stages = UPDATER_NATIVE_STAGES.map((stage, index) => {
    const n = { ...native(), sequence: index + 1 };
    const dom = { ready: true, title: '', text: '', confirmDisabled: null, cancelDisabled: null, bridgePresent: true, rejected: false };
    if (stage === 'main-ready') { dom.rejected = true; n.candidateId = null; n.phase = 'idle'; }
    if (stage === 'main-check') { dom.text = '99.78.0'; dom.rejected = true; n.windowCount = 1; }
    if (stage.startsWith('popup-')) {
      n.session = { windowId, label: `renderer-updater-${windowId}`, ready: true, alive: true, closing: false, candidateId, lastSequence: index + 1 };
      n.window = { exists: true, visible: false, focused: false, url: `atools-updater://localhost/${windowId}/updater.html` };
      n.windowCount = 1; dom.title = '发现新版本 99.78.0'; dom.confirmDisabled = false; dom.cancelDisabled = false;
    }
    if (stage === 'popup-busy') { n.phase = 'downloading'; n.busy = true; n.operationId = 'd'.repeat(32); dom.confirmDisabled = dom.cancelDisabled = true; dom.rejected = true; dom.text = '50%'; }
    if (stage === 'popup-error') { n.phase = 'error'; n.errorCode = 'download_failed'; dom.text = '下载失败'; }
    if (stage === 'popup-disposed') dom.bridgePresent = false;
    if (stage === 'main-disposed') { dom.bridgePresent = false; dom.text = 'disposed'; }
    return { stage, sourceLabel: stage.startsWith('popup-') ? `renderer-updater-${windowId}` : 'main', dom, native: n };
  });
  return { schemaVersion: 1, journey: 'updater', runId, pid, passed: true, errors: [], inputSource: 'rust-injected-javascript', physicalOsInput: false, realSdk: false,
    stages, rejectedProbeCalls: 2, fixture: { checkCalls: 1, downloadCalls: 1, activeWork: 0, forbiddenEffectCalls: 0, installCalls: 0, applyCalls: 0, restartCalls: 0, archiveProduction: 'unsupported' },
    cleanup: { native: { ...native(), sequence: 8 }, destroyedEvents: 1, activeWork: 0, listenerCount: null, listenersDirectlyObserved: false } };
}
test('finite real-stage report requires busy rejection, failure terminal, actual Destroyed and honest unknown listeners', () => {
  const good = fixtureReport(); assert.equal(validateUpdaterNativeReport(good, { runId, pid }).valid, true);
  for (const mutate of [r => r.realSdk = true, r => r.pid++, r => r.stages[3].dom.rejected = false,
    r => r.stages[3].native.busy = false, r => r.stages[4].native.errorCode = 'no_update',
    r => r.stages[2].native.window.url = 'atools-updater://wrong/updater.html',
    r => r.stages[4].native.candidateId = 'e'.repeat(32), r => r.fixture.installCalls = 1,
    r => r.cleanup.destroyedEvents = 0, r => r.cleanup.listenerCount = 0, r => r.cleanup.native.windowCount = 1]) {
    const bad = structuredClone(good); mutate(bad); assert.throws(() => validateUpdaterNativeReport(bad, { runId, pid }));
  }
});
test('timeout, signal, missing terminal and nonzero exit cannot become runtime success', () => {
  const good = { spawned: true, terminalObserved: true, pid, timedOut: false, exitCode: 0, signal: null };
  assert.doesNotThrow(() => assertUpdaterNativeTerminal(good));
  for (const patch of [{ timedOut: true }, { terminalObserved: false }, { exitCode: 1 }, { signal: 'SIGTERM' }, { spawned: false }, { pid: null }])
    assert.throws(() => assertUpdaterNativeTerminal({ ...good, ...patch }));
});
