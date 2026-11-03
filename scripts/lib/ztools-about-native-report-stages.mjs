import assert from 'node:assert/strict';
import { hex, assertSettingsClosed, assertUpdaterClosed, assertRuntimeStopped } from './ztools-about-native-report-shapes.mjs';
export function assertAboutStages(report) {
  let firstChild, secondChild, candidate, popup, onRevision, onHash, initialHash;
  for (const row of report.stages) {
    const { stage, sourceKind, sourceLabel, sessionId, dom, receipt, native: { settings: s, updater: u, general: g, runtime: r } } = row;
    const expectedKind = stage.startsWith('settings-') ? 'native' : stage.startsWith('popup-') ? 'popup' : stage.startsWith('main-') ? 'main' : 'child';
    assert.equal(sourceKind, expectedKind);
    if (sourceKind === 'native') {
      for (const value of [sourceLabel, sessionId, dom, receipt]) assert.equal(value, null);
      assertSettingsClosed(s);
    } else {
      assert.ok(dom); assert.equal(dom.ready, true);
      if (sourceKind === 'main') { assert.equal(sourceLabel, 'main'); assert.equal(sessionId, null); }
      else { hex(sessionId); assert.equal(sourceLabel, `${sourceKind === 'child' ? 'ztools-settings' : 'renderer-updater'}-${sessionId}`); }
    }
    if (sourceKind === 'child') {
      assert.equal(s.childCount, 1); assert.equal(s.sessionCount, 1); assert.equal(s.ready, true);
      assert.equal(s.phase, 'open'); assert.equal(s.documentAuthorized, true); assert.equal(s.revoked, false);
      assert.equal(s.bundleRevisionPresent, true); assert.equal(dom.bundleRevision, s.compiledBundleRevision);
      assert.equal(dom.appVersion, `v${report.appVersion}`); assert.equal(dom.bridgePresent, true);
      assert.ok(receipt); assert.equal(receipt.negative, null);
      if (stage === 'about-ready') firstChild = sessionId;
      else if (stage === 'about-reopened') { secondChild = sessionId; assert.notEqual(secondChild, firstChild); }
      else assert.equal(sessionId, firstChild);
    }
    if (stage === 'main-ready') {
      assert.deepEqual(receipt, { version: null, manual: null, auto: null, apiCalls: null, negative: { badToken: true, wrongFrame: true } });
      assert.equal(dom.bridgePresent, true); assert.equal(g.autoCheckUpdate, false); initialHash = g.rawSha256;
      assert.equal(u.windowCount, 0); assert.equal(u.sessionId, null); assert.equal(u.candidateId, null);
    }
    if (stage === 'about-ready' || stage === 'about-reopened') {
      assert.deepEqual(receipt, { version: report.appVersion, manual: null, auto: null, apiCalls: { version: 1, manual: 0, auto: 0 }, negative: null });
      assert.equal(dom.autoChecked, false); assert.equal(g.autoCheckUpdate, false);
      if (stage === 'about-ready') initialHash = g.rawSha256;
    }
    if (stage === 'about-manual') {
      assert.deepEqual(receipt, { version: null, manual: { success: true, hasUpdate: true, status: 'available', version: '99.78.0' }, auto: null, apiCalls: { version: 1, manual: 1, auto: 0 }, negative: null });
      hex(u.candidateId); candidate = u.candidateId;
    }
    if (['auto-on', 'auto-off'].includes(stage)) {
      assert.equal(receipt.version, null); assert.equal(receipt.manual, null);
      assert.deepEqual(receipt.apiCalls, { version: 1, manual: 1, auto: stage === 'auto-on' ? 1 : 2 });
      const enabled = stage === 'auto-on', auto = receipt.auto;
      assert.ok(auto); assert.equal(auto.autoValue, enabled); assert.equal(auto.notificationDelivered, true);
      assert.equal(auto.runtimeApplied, true); assert.equal(auto.runtimeError, null);
      assert.equal(dom.autoChecked, enabled); assert.equal(g.autoCheckUpdate, enabled); assert.equal(g.onlyAutoFieldChanged, true);
      if (r.schedulerDirectlyObserved) { assert.equal(r.scheduler.enabled, enabled); assert.equal(r.scheduler.stopped, false); }
      if (enabled) { onRevision = auto.revision; onHash = g.rawSha256; assert.notEqual(onHash, initialHash); }
      else { assert.notEqual(auto.revision, onRevision); assert.notEqual(g.rawSha256, onHash); assert.equal(g.rawSha256, initialHash); }
    }
    if (['popup-ready', 'popup-disposed', 'main-disposed'].includes(stage)) assert.equal(receipt, null);
    if (stage === 'popup-ready') {
      popup = sessionId; assert.equal(u.sessionId, popup); assert.equal(u.ready, true); assert.match(dom.title, /99\.78\.0/); assert.equal(dom.bridgePresent, true);
    }
    if (candidate && !['popup-disposed', 'main-disposed'].includes(stage)) {
      assert.equal(u.candidateId, candidate);
      if (!popup) continue;
      assert.equal(u.sessionCandidateId, candidate);
      hex(u.sessionId); if (popup) assert.equal(u.sessionId, popup);
      assert.equal(u.windowExists, true); assert.equal(u.windowCount, 1); assert.equal(u.opening, false);
      assert.equal(u.alive, true); assert.equal(u.closing, false); assert.equal(u.busy, false); assert.equal(u.phase, 'available');
      assert.equal(u.operationId, null);
    }
    if (stage === 'popup-disposed') { assert.equal(u.candidateId, candidate); assert.equal(u.sessionId, popup); assert.equal(sessionId, popup); assert.equal(dom.bridgePresent, false); assert.equal(dom.disposed, true); }
    if (stage === 'main-disposed') {
      assert.equal(dom.bridgePresent, false); assert.equal(dom.disposed, true);
      assertSettingsClosed(s); assertUpdaterClosed(u); assertRuntimeStopped(r);
    }
    if (['auto-off', 'settings-closed', 'about-reopened', 'settings-final-closed', 'popup-disposed', 'main-disposed'].includes(stage)) assert.equal(g.autoCheckUpdate, false);
  }
  assert.ok(firstChild && secondChild && candidate && popup && onRevision);
}
