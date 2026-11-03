import assert from 'node:assert/strict';
import { updaterRunId } from './ztools-updater-native-protocol.mjs';

export const UPDATER_NATIVE_STAGES = ['main-ready', 'main-check', 'popup-ready', 'popup-busy', 'popup-error', 'popup-disposed', 'main-disposed'];
const id = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
function exact(value, keys) { assert.ok(value && typeof value === 'object' && !Array.isArray(value)); assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); }
function text(value, max) { assert.equal(typeof value, 'string'); assert.ok(Buffer.byteLength(value) <= max); }
function nativeShape(native) {
  exact(native, ['session', 'window', 'main', 'opening', 'windowCount', 'busy', 'phase', 'operationId', 'candidateId', 'sequence', 'errorCode']);
  if (native.main !== null) {
    exact(native.main, ['visible', 'focused']);
    for (const field of ['visible', 'focused']) assert.ok(native.main[field] === null || native.main[field] === false, 'Hidden private Main must never report visible/focused true');
  }
  for (const field of ['opening', 'busy']) assert.equal(typeof native[field], 'boolean');
  for (const field of ['windowCount', 'sequence']) assert.ok(integer(native[field]));
  assert.ok(['idle', 'checking', 'not-available', 'available', 'downloading', 'downloaded', 'installing', 'install-unknown', 'restart-pending', 'restarting', 'error'].includes(native.phase));
  for (const field of ['operationId', 'candidateId']) assert.ok(native[field] === null || id(native[field]));
  assert.ok(native.errorCode === null || typeof native.errorCode === 'string' && native.errorCode.length <= 128);
}
function popup(native) {
  assert.equal(native.windowCount, 1); assert.equal(native.opening, false);
  exact(native.session, ['windowId', 'label', 'ready', 'alive', 'closing', 'candidateId', 'lastSequence']);
  const session = native.session; assert.ok(id(session.windowId) && id(session.candidateId));
  assert.equal(session.label, `renderer-updater-${session.windowId}`);
  assert.equal(session.candidateId, native.candidateId); assert.equal(session.ready, true);
  assert.equal(session.alive, true); assert.equal(session.closing, false); assert.ok(integer(session.lastSequence));
  exact(native.window, ['exists', 'visible', 'focused', 'url']);
  assert.equal(native.window.exists, true); assert.equal(native.window.visible, false); assert.equal(native.window.focused, false);
  assert.equal(native.window.url, `atools-updater://localhost/${session.windowId}/updater.html`);
}
function closed(native) {
  nativeShape(native); assert.equal(native.session, null); assert.equal(native.window, null);
  assert.equal(native.windowCount, 0); assert.equal(native.opening, false); assert.equal(native.busy, false);
}
/** Independent gate over the actual finite Rust report; no synthetic listener count or SDK claim. */
export function validateUpdaterNativeReport(report, { runId, pid }) {
  exact(report, ['schemaVersion', 'journey', 'runId', 'pid', 'passed', 'errors', 'inputSource', 'physicalOsInput', 'realSdk', 'stages', 'fixture', 'rejectedProbeCalls', 'cleanup']);
  assert.equal(report.schemaVersion, 1); assert.equal(report.journey, 'updater'); assert.equal(report.runId, updaterRunId(runId));
  assert.ok(Number.isSafeInteger(pid) && pid > 0); assert.equal(report.pid, pid); assert.equal(report.passed, true);
  assert.deepEqual(report.errors, []); assert.equal(report.inputSource, 'rust-injected-javascript');
  assert.equal(report.physicalOsInput, false); assert.equal(report.realSdk, false); assert.equal(report.rejectedProbeCalls, 2);
  assert.ok(Array.isArray(report.stages)); assert.deepEqual(report.stages.map(row => row.stage), UPDATER_NATIVE_STAGES);
  let popupIdentity, mainCandidate, previousSequence = -1;
  for (const row of report.stages) {
    exact(row, ['stage', 'sourceLabel', 'dom', 'native']);
    exact(row.dom, ['ready', 'title', 'text', 'confirmDisabled', 'cancelDisabled', 'bridgePresent', 'rejected']);
    const dom = row.dom, native = row.native;
    assert.equal(dom.ready, true); text(dom.title, 256); text(dom.text, 2048);
    assert.equal(typeof dom.bridgePresent, 'boolean'); assert.equal(typeof dom.rejected, 'boolean');
    for (const field of ['confirmDisabled', 'cancelDisabled']) assert.ok(dom[field] === null || typeof dom[field] === 'boolean');
    nativeShape(native); assert.ok(native.sequence >= previousSequence); previousSequence = native.sequence;
    if (row.stage.startsWith('popup-')) {
      popup(native); assert.equal(row.sourceLabel, native.session.label);
      const identity = { windowId: native.session.windowId, candidateId: native.candidateId };
      assert.equal(identity.candidateId, mainCandidate, 'Popup must display the candidate observed through original Main');
      if (popupIdentity) assert.deepEqual(identity, popupIdentity); else popupIdentity = identity;
    } else assert.equal(row.sourceLabel, 'main');
    if (row.stage === 'main-ready') { assert.equal(dom.bridgePresent, true); assert.equal(dom.rejected, true); assert.equal(native.windowCount, 0); }
    if (row.stage === 'main-check') {
      assert.equal(dom.bridgePresent, true); assert.equal(dom.rejected, true); assert.equal(dom.text, '99.78.0');
      assert.equal(native.windowCount, 1); assert.ok(id(native.candidateId)); mainCandidate = native.candidateId;
    }
    if (row.stage === 'popup-ready') {
      assert.equal(native.phase, 'available'); assert.equal(native.busy, false); assert.equal(dom.bridgePresent, true);
      assert.match(dom.title, /99\.78\.0/); assert.equal(dom.confirmDisabled, false); assert.equal(dom.cancelDisabled, false);
    }
    if (row.stage === 'popup-busy') {
      assert.equal(native.phase, 'downloading'); assert.equal(native.busy, true); assert.ok(id(native.operationId));
      assert.equal(dom.confirmDisabled, true); assert.equal(dom.cancelDisabled, true); assert.equal(dom.rejected, true); assert.match(dom.text, /50%/);
    }
    if (row.stage === 'popup-error') {
      assert.equal(native.phase, 'error'); assert.equal(native.errorCode, 'download_failed'); assert.equal(native.busy, false);
      assert.equal(dom.cancelDisabled, false); assert.match(dom.text, /下载失败/);
    }
    if (row.stage === 'popup-disposed') { assert.equal(dom.bridgePresent, false); assert.equal(native.busy, false); }
    if (row.stage === 'main-disposed') { assert.equal(dom.bridgePresent, false); assert.equal(dom.text, 'disposed'); closed(native); }
  }
  exact(report.fixture, ['checkCalls', 'downloadCalls', 'activeWork', 'forbiddenEffectCalls', 'installCalls', 'applyCalls', 'restartCalls', 'archiveProduction']);
  assert.equal(report.fixture.checkCalls, 1); assert.equal(report.fixture.downloadCalls, 1);
  for (const field of ['activeWork', 'forbiddenEffectCalls', 'installCalls', 'applyCalls', 'restartCalls']) assert.equal(report.fixture[field], 0);
  assert.equal(report.fixture.archiveProduction, 'unsupported');
  exact(report.cleanup, ['native', 'destroyedEvents', 'activeWork', 'listenerCount', 'listenersDirectlyObserved']);
  assert.equal(report.cleanup.destroyedEvents, 1); assert.equal(report.cleanup.activeWork, 0);
  assert.equal(report.cleanup.listenerCount, null); assert.equal(report.cleanup.listenersDirectlyObserved, false);
  closed(report.cleanup.native); assert.ok(report.cleanup.native.sequence >= previousSequence);
  return { valid: true, passed: true, actualDestroyed: 1, listenerCount: null, listenersDirectlyObserved: false };
}
