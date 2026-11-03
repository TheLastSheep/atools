import assert from 'node:assert/strict';
import { ABOUT_SETTINGS_FORMAL } from './ztools-about-native-protocol.mjs';
export function exact(value, keys) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
export function text(value, max) { assert.equal(typeof value, 'string'); assert.ok(Buffer.byteLength(value) <= max); }
export function hex(value, size = 32) { assert.equal(typeof value, 'string'); assert.match(value, new RegExp(`^[0-9a-f]{${size}}$`)); }
function bool(value) { assert.equal(typeof value, 'boolean'); }
function count(value, max = Number.MAX_SAFE_INTEGER) { assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= max); }
function nullable(value, validate) { if (value !== null) validate(value); }
const phases = ['idle', 'checking', 'not-available', 'available', 'downloading', 'downloaded', 'installing', 'install-unknown', 'restart-pending', 'restarting', 'error'];
function phase(value) { assert.ok(phases.includes(value)); }
export function settingsShape(s) {
  exact(s, ['sessionCount', 'childCount', 'ready', 'phase', 'documentAuthorized', 'revoked', 'pendingCalls', 'pendingWrites', 'bundleRevisionPresent', 'compiledBundleRevision', 'layoutRegistrationCount']);
  for (const k of ['sessionCount', 'childCount']) count(s[k], 1);
  for (const k of ['pendingCalls', 'pendingWrites']) count(s[k], 32);
  for (const k of ['ready', 'documentAuthorized', 'revoked', 'bundleRevisionPresent']) bool(s[k]);
  assert.ok([null, 'opening', 'open', 'closing'].includes(s.phase));
  hex(s.compiledBundleRevision, 64); assert.equal(s.compiledBundleRevision, ABOUT_SETTINGS_FORMAL.provenanceSha256);
  nullable(s.layoutRegistrationCount, count);
}
export function updaterShape(u) {
  exact(u, ['sessionId', 'sessionCandidateId', 'candidateId', 'phase', 'ready', 'alive', 'closing', 'windowExists', 'windowCount', 'opening', 'busy', 'operationId', 'windowVisible', 'windowFocused']);
  for (const k of ['sessionId', 'sessionCandidateId', 'candidateId', 'operationId']) nullable(u[k], hex);
  phase(u.phase); count(u.windowCount, 1);
  for (const k of ['ready', 'alive', 'closing', 'windowExists', 'opening', 'busy']) bool(u[k]);
  for (const k of ['windowVisible', 'windowFocused']) { nullable(u[k], bool); assert.notEqual(u[k], true, 'Owned updater stays hidden'); }
}
export function runtimeShape(r) {
  exact(r, ['scheduler', 'manualSlotCount', 'schedulerDirectlyObserved', 'manualSlotDirectlyObserved']);
  bool(r.schedulerDirectlyObserved); bool(r.manualSlotDirectlyObserved);
  nullable(r.manualSlotCount, v => count(v, 1));
  assert.equal(r.scheduler !== null, r.schedulerDirectlyObserved);
  assert.equal(r.manualSlotCount !== null, r.manualSlotDirectlyObserved);
  if (r.scheduler !== null) {
    const s = r.scheduler;
    exact(s, ['generation', 'initialized', 'enabled', 'stopped', 'controllerStarted', 'workerActive', 'timerCount', 'timerDirectlyObserved']);
    count(s.generation);
    for (const k of ['initialized', 'enabled', 'stopped', 'controllerStarted', 'workerActive']) bool(s[k]);
    assert.equal(s.timerCount, null); assert.equal(s.timerDirectlyObserved, false);
  }
}
function generalShape(g) {
  exact(g, ['autoCheckUpdate', 'sentinelMatches', 'onlyAutoFieldChanged', 'rawSha256', 'casWrites', 'casWritesDirectlyObserved']);
  bool(g.autoCheckUpdate); assert.equal(g.sentinelMatches, true); nullable(g.onlyAutoFieldChanged, bool);
  hex(g.rawSha256, 64); assert.equal(g.casWrites, null); assert.equal(g.casWritesDirectlyObserved, false);
}
function domShape(d) {
  exact(d, ['ready', 'title', 'text', 'appVersion', 'autoChecked', 'checkDisabled', 'bridgePresent', 'disposed', 'bundleRevision']);
  bool(d.ready); bool(d.bridgePresent); text(d.title, 256); text(d.text, 2048);
  nullable(d.appVersion, v => text(v, 128));
  for (const k of ['autoChecked', 'checkDisabled', 'disposed']) nullable(d[k], bool);
  nullable(d.bundleRevision, v => hex(v, 64));
}
function receiptShape(r) {
  exact(r, ['version', 'manual', 'auto', 'apiCalls', 'negative']);
  nullable(r.version, v => text(v, 128));
  if (r.manual !== null) {
    exact(r.manual, ['success', 'hasUpdate', 'status', 'version']);
    assert.equal(r.manual.success, true); assert.equal(r.manual.hasUpdate, true);
    assert.equal(r.manual.status, 'available'); assert.equal(r.manual.version, '99.78.0');
  }
  if (r.auto !== null) {
    exact(r.auto, ['revision', 'autoValue', 'notificationDelivered', 'runtimeApplied', 'runtimeError']);
    hex(r.auto.revision);
    for (const k of ['autoValue', 'notificationDelivered', 'runtimeApplied']) bool(r.auto[k]);
    if (r.auto.runtimeError !== null) {
      exact(r.auto.runtimeError, ['code', 'message']);
      assert.ok(['SETTINGS_UPDATER_RUNTIME_UNAVAILABLE', 'SETTINGS_UPDATER_PROVIDER_DISABLED', 'SETTINGS_UPDATER_PROVIDER_UNAVAILABLE', 'SETTINGS_UPDATER_RUNTIME_STOPPED'].includes(r.auto.runtimeError.code));
      text(r.auto.runtimeError.message, 2048);
    }
  }
  if (r.apiCalls !== null) {
    exact(r.apiCalls, ['version', 'manual', 'auto']); for (const value of Object.values(r.apiCalls)) count(value, 2);
  }
  if (r.negative !== null) { exact(r.negative, ['badToken', 'wrongFrame']); bool(r.negative.badToken); bool(r.negative.wrongFrame); }
}
export function assertSettingsClosed(s) {
  for (const k of ['sessionCount', 'childCount', 'pendingCalls', 'pendingWrites']) assert.equal(s[k], 0);
  assert.equal(s.ready, false); assert.equal(s.documentAuthorized, false); assert.equal(s.phase, null);
  assert.equal(s.bundleRevisionPresent, false);
  if (s.layoutRegistrationCount !== null) assert.equal(s.layoutRegistrationCount, 0);
}
export function assertUpdaterClosed(u) {
  for (const k of ['sessionId', 'sessionCandidateId']) assert.equal(u[k], null);
  for (const k of ['windowExists', 'ready', 'alive', 'closing', 'opening', 'busy']) assert.equal(u[k], false);
  assert.equal(u.windowCount, 0);
}
export function assertRuntimeStopped(r) {
  if (r.schedulerDirectlyObserved) {
    assert.equal(r.scheduler.stopped, true); assert.equal(r.scheduler.enabled, false); assert.equal(r.scheduler.workerActive, false);
  }
  if (r.manualSlotDirectlyObserved) assert.equal(r.manualSlotCount, 0);
}
export function assertAboutNativeShapes(report) {
  assert.ok(Buffer.byteLength(JSON.stringify(report)) <= 256 * 1024);
  for (const row of report.stages) {
    settingsShape(row.native.settings); updaterShape(row.native.updater); generalShape(row.native.general); runtimeShape(row.native.runtime);
    if (row.dom !== null) domShape(row.dom);
    if (row.receipt !== null) receiptShape(row.receipt);
  }
  settingsShape(report.cleanup.settings); updaterShape(report.cleanup.updater); runtimeShape(report.cleanup.runtime);
  assertSettingsClosed(report.cleanup.settings); assertUpdaterClosed(report.cleanup.updater); assertRuntimeStopped(report.cleanup.runtime);
}
