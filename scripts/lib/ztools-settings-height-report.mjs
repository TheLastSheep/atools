import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { assertHeightMainReceipt, assertHeightStability } from './ztools-settings-height-proof.mjs';

export const A_RAW = '{"autoBackToSearch":"never","autoClear":"never","autoPaste":"off","opacity":1.0,"r76Unknown":{"keep":"unchanged"},"showTrayIcon":false,"theme":"dark"}';
export const HEIGHT_CASES = Object.freeze({
  a: { desired: 542, next: 200.5 }, b: { desired: 200.5, next: 541 },
  c: { desired: 541, next: 2001 }, d: { desired: 2001, next: null },
});
export const HEIGHT_HOST_SETUP = Object.freeze({ windowPath: 'production-create-main-from-config',
  materialPath: 'production-install-configured', resizePath: 'production-settings-lifecycle-f64-workarea',
  macosMainPanelPrototype: false, excludedStartupServices: ['desktop-plugins', 'catalog-watcher', 'tray',
    'login-item-probe', 'clipboard-monitor', 'mcp', 'node', 'launch-probes'] });
const uuid = value => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value);
const sessionId = value => uuid(value) && value[12] === '4' && '89ab'.includes(value[16]);
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const number = value => typeof value === 'number' && Number.isFinite(value);
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 2147483647;
const positive = value => integer(value) && value > 0;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const size = value => exact(value, ['width', 'height']) && positive(value.width) && positive(value.height);
const position = value => exact(value, ['x', 'y']) && integer(value.x) && integer(value.y);

/** Fixed macOS/Wry R76 projection; report data cannot choose a looser geometry policy. */
export function projectMacosWrySettingsHeight(desired, scale) {
  assert.ok(number(desired) && desired > 0 && number(scale) && scale > 0);
  const requestedPhysical = Math.round(desired * scale);
  const logicalHeight = Math.round(requestedPhysical / scale);
  const childPhysicalHeight = Math.round(logicalHeight * scale);
  const parentPhysicalHeight = Math.ceil((logicalHeight + 58) * scale);
  assert.ok(Number.isSafeInteger(requestedPhysical) && Number.isSafeInteger(logicalHeight)
    && Number.isSafeInteger(childPhysicalHeight) && Number.isSafeInteger(parentPhysicalHeight));
  return { logicalHeight, childPhysicalHeight, parentPhysicalHeight };
}

export function heightPaths(runId) {
  assert.ok(uuid(runId), 'Invalid height run ID');
  const root = `/private/tmp/atools-renderer-smoke-${runId}`;
  return { runId, root, identifier: `dev.atools.renderer-smoke.${runId}`,
    output: `${root}/report.json`, seed: `${root}.seed.sqlite`, database: `${root}/app-data/data.db` };
}

export function assertHeightRawChange(before, after, heightCase) {
  assert.ok(Object.hasOwn(HEIGHT_CASES, heightCase));
  assert.ok(typeof before === 'string' && before.length <= 65536 && typeof after === 'string' && after.length <= 65536);
  const previous = JSON.parse(before), next = JSON.parse(after), spec = HEIGHT_CASES[heightCase];
  assert.ok(previous && typeof previous === 'object' && !Array.isArray(previous));
  assert.ok(next && typeof next === 'object' && !Array.isArray(next));
  assert.deepEqual(previous.r76Unknown, { keep: 'unchanged' });
  if (heightCase === 'a') { assert.equal(before, A_RAW); assert.equal(Object.hasOwn(previous, 'windowDefaultHeight'), false); }
  else assert.equal(previous.windowDefaultHeight, spec.desired);
  if (spec.next === null) assert.equal(after, before);
  else assert.deepEqual(next, { ...previous, windowDefaultHeight: spec.next });
}

function assertGeometry(value, desired) {
  const { parent, child } = value;
  assert.ok(exact(parent, ['innerPhysical', 'outerPhysical', 'positionPhysical', 'scale', 'workArea']));
  assert.ok(size(parent.innerPhysical) && size(parent.outerPhysical) && position(parent.positionPhysical));
  assert.ok(number(parent.scale) && parent.scale > 0);
  assert.ok(exact(parent.workArea, ['position', 'size']) && position(parent.workArea.position) && size(parent.workArea.size));
  assert.ok(exact(child, ['label', 'url', 'positionPhysical', 'sizePhysical', 'logicalHeight']));
  assert.ok(size(child.sizePhysical) && position(child.positionPhysical));
  assert.equal(child.label, `ztools-settings-${value.sessionId}`);
  assert.equal(child.url, `atools-settings://${value.sessionId}.localhost/index.html#/generalSetting`);
  const frame = parent.outerPhysical.height - parent.innerPhysical.height;
  assert.ok(frame >= 0 && parent.outerPhysical.width >= parent.innerPhysical.width);
  const available = parent.workArea.size.height - frame;
  assert.ok(available > 0);
  const projected = projectMacosWrySettingsHeight(desired, parent.scale);
  assert.equal(parent.innerPhysical.height, Math.min(projected.parentPhysicalHeight, available),
    'Parent did not use the fixed macOS/Wry projection with frame/workarea clipping');
  assert.ok(parent.positionPhysical.y >= parent.workArea.position.y
    && parent.positionPhysical.y + parent.outerPhysical.height <= parent.workArea.position.y + parent.workArea.size.height);
  assert.deepEqual(child.positionPhysical, { x: 0, y: Math.round(58 * parent.scale) });
  assert.equal(child.sizePhysical.height, projected.childPhysicalHeight, 'Child lost requested content height');
  assert.equal(child.sizePhysical.width, parent.innerPhysical.width);
  assert.ok(number(child.logicalHeight) && Math.abs(child.logicalHeight - child.sizePhysical.height / parent.scale) < 1e-8);
  assert.equal(value.parentClipped, projected.parentPhysicalHeight > available);
}

/** Derive facts from geometry/raw DB, not the producer's expectedDesired/status/check bits. */
export function validateHeightReport(value, expected) {
  try {
    const paths = heightPaths(expected.runId), spec = HEIGHT_CASES[expected.heightCase];
    assert.ok(spec && positive(expected.pid) && hash(expected.bundleRevision));
    assert.ok(exact(value, ['schemaVersion', 'kind', 'runId', 'pid', 'root', 'identifier', 'heightCase',
      'deadlineSeconds', 'lifecyclePhase', 'status', 'errors', 'rawGeneral', 'seed', 'openings', 'closes',
      'stagesCompleted', 'elapsedMs', 'processExit', 'guiAcceptance', 'isolation', 'sources', 'hostSetup', 'elapsedSamplePhase']));
    for (const key of ['runId', 'root', 'identifier']) assert.equal(value[key], paths[key]);
    assert.equal(value.pid, expected.pid); assert.equal(value.heightCase, expected.heightCase);
    assert.equal(value.schemaVersion, 1); assert.equal(value.kind, 'settings-height');
    assert.equal(value.deadlineSeconds, 165); assert.equal(value.lifecyclePhase, 'journey-complete-before-host-teardown');
    assert.equal(value.elapsedSamplePhase, 'before-report-serialization-and-fsync');
    assert.equal(value.status, 'passed'); assert.deepEqual(value.errors, []);
    assert.equal(value.guiAcceptance, 'unverified'); assert.equal(value.processExit, null);
    assert.ok(number(value.elapsedMs) && value.elapsedMs >= 0 && value.elapsedMs <= 175000);
    assert.deepEqual(value.isolation, { loginItemStatus: 'fixture-unavailable', shortcutPluginInstalled: false,
      clipboardReads: 0, clipboardWrites: 0, clipboardPastes: 0 });
    assert.ok(hash(expected.mainProvenanceSha256));
    assert.deepEqual(value.sources, { mainProvenanceSha256: expected.mainProvenanceSha256, settingsProvenanceSha256: expected.bundleRevision });
    assert.deepEqual(value.hostSetup, HEIGHT_HOST_SETUP); // source/config declaration, not an OS-class observation
    assert.ok(exact(value.rawGeneral, ['before', 'after']));
    assert.equal(value.rawGeneral.before, expected.rawBefore);
    assertHeightRawChange(value.rawGeneral.before, value.rawGeneral.after, expected.heightCase);
    if (expected.heightCase === 'a') { assert.equal(expected.seed, null); assert.equal(value.seed, null); }
    else {
      assert.ok(exact(expected.seed, ['path', 'sha256', 'bytes']) && expected.seed.path === paths.seed
        && hash(expected.seed.sha256) && positive(expected.seed.bytes) && expected.seed.bytes <= 64 * 1024 * 1024);
      assert.deepEqual(value.seed, expected.seed);
    }
    const stages = spec.next === null ? ['initial'] : ['initial', 'after-write', 'reopened'];
    assert.ok(Array.isArray(value.openings) && value.openings.length === stages.length);
    const checks = ['identity', 'ready', 'registration', 'parentHeight', 'parentWidthPositive', 'childHeight', 'childHeader', 'childWidth', 'hidden', 'unfocused'];
    for (let i = 0; i < stages.length; i++) {
      const opening = value.openings[i];
      assert.ok(exact(opening, ['stage', 'sessionId', 'bundleRevision', 'expectedDesired', 'expectedSource',
        'observedBehavior', 'parent', 'child', 'diagnostics', 'hidden', 'unfocused', 'checks', 'parentClipped', 'mainClient', 'mainWindowNotifications', 'stability']));
      assert.equal(opening.stage, stages[i]); assert.ok(sessionId(opening.sessionId));
      assert.equal(opening.bundleRevision, expected.bundleRevision);
      assert.equal(opening.expectedDesired, spec.desired);
      assert.equal(opening.expectedSource, i === 0 ? expected.heightCase === 'a' ? 'raw-absent' : 'raw-value' : 'runtime-cache');
      assert.equal(opening.observedBehavior, ['initial-native-geometry', 'committed-raw-changed-geometry-unchanged', 'new-session-reused-height'][i]);
      assert.equal(opening.hidden, true); assert.equal(opening.unfocused, true);
      assert.ok(exact(opening.checks, checks) && checks.every(key => opening.checks[key] === true));
      for (const [key, actual] of Object.entries({ sessionCount: 1, childPresent: true, ready: true, documentAuthorized: true, layoutLeasePresent: true, layoutRegistrationCount: 1, pendingWrites: 0 })) {
        assert.equal(opening.diagnostics?.[key], actual, `Opening diagnostic ${key}`);
      }
      assertGeometry(opening, spec.desired);
      assertHeightMainReceipt(opening, 'loaded');
      assertHeightStability(opening);
    }
    if (spec.next !== null) {
      assert.equal(value.openings[1].sessionId, value.openings[0].sessionId);
      assert.notEqual(value.openings[2].sessionId, value.openings[0].sessionId);
      assert.deepEqual(value.openings[1].parent, value.openings[0].parent, 'Save resized the current parent');
      assert.deepEqual(value.openings[1].child, value.openings[0].child, 'Save resized the current child');
      const initial = value.openings[0], reopened = value.openings[2];
      if (initial.parent.scale === reopened.parent.scale &&
          isDeepStrictEqual(initial.parent.workArea, reopened.parent.workArea)) {
        assert.deepEqual(reopened.parent, initial.parent, 'Same-scale/workarea reopen changed actual parent geometry');
        for (const key of ['positionPhysical', 'sizePhysical', 'logicalHeight']) {
          assert.deepEqual(reopened.child[key], initial.child[key], 'Reopen changed cached child geometry');
        }
      }
    } else assert.equal(value.openings[0].parentClipped, true, 'D must actually observe parent clipping');
    const closedSessions = spec.next === null ? [value.openings[0].sessionId] : [value.openings[0].sessionId, value.openings[2].sessionId];
    assert.ok(Array.isArray(value.closes) && value.closes.length === closedSessions.length);
    for (let i = 0; i < value.closes.length; i++) {
      const close = value.closes[i];
      assert.ok(exact(close, ['sessionId', 'diagnostics', 'childAbsent', 'layoutAbsent', 'pendingDrained', 'hidden', 'unfocused', 'mainClient', 'mainWindowNotifications']));
      assert.equal(close.sessionId, closedSessions[i]);
      assertHeightMainReceipt(close, 'back-to-search');
      for (const key of ['childAbsent', 'layoutAbsent', 'pendingDrained', 'hidden', 'unfocused']) assert.equal(close[key], true);
      for (const [key, actual] of Object.entries({ sessionCount: 0, childPresent: false, layoutLeasePresent: false, layoutRegistrationCount: 0, pendingCalls: 0, pendingWrites: 0 })) assert.equal(close.diagnostics?.[key], actual);
    }
    assert.deepEqual(value.stagesCompleted, spec.next === null ? ['initial-open', 'initial-closed']
      : ['initial-open', 'patch-committed', 'after-write-observed', 'initial-closed', 'reopened', 'reopened-closed']);
    return { valid: true, passed: true, errors: [] };
  } catch (error) { return { valid: false, passed: false, errors: [String(error.message).slice(0, 1000)] }; }
}
