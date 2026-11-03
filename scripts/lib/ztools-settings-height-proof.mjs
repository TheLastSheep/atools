import assert from 'node:assert/strict';

const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const integer = value => Number.isSafeInteger(value) && Math.abs(value) <= 2147483647;
const position = value => exact(value, ['x', 'y']) && integer(value.x) && integer(value.y);
const size = value => exact(value, ['width', 'height']) && integer(value.width) && value.width > 0
  && integer(value.height) && value.height > 0;
const positive = value => Number.isFinite(value) && value > 0;

/** Main adapter receipt is actual state, not the Native expected phase label. */
export function assertHeightMainReceipt(value, phase) {
  assert.deepEqual(value.mainClient, { version: 1, listenerState: 'listening', activePhase: phase,
    pendingOpen: false, openFailures: 0, closeFailures: 0, invalidPayloads: 0,
    registrationErrors: 0, lateListenerUnlistens: 0, cleanupErrors: 0 });
  assert.deepEqual(value.mainWindowNotifications, { pendingReplies: 0, failures: 0, cancelled: 0, dropped: 0 });
}

/** Bind both stable samples to the measured opening and the single owned Child. */
export function assertHeightStability(opening) {
  const proof = opening.stability;
  assert.ok(exact(proof, ['attempts', 'before', 'after']));
  assert.ok(Number.isInteger(proof.attempts) && proof.attempts >= 1 && proof.attempts <= 3);
  assert.deepEqual(proof.before, proof.after, 'Geometry/monitor/session changed during sample');
  const sample = proof.after, { parent, child, diagnostics } = opening;
  assert.ok(exact(sample, ['parentLabel', 'parentInnerPhysical', 'parentOuterPhysical',
    'parentPositionPhysical', 'scale', 'monitor', 'childLabel', 'childUrl', 'childParent',
    'childPositionPhysical', 'childSizePhysical', 'ownedChildren', 'session', 'hidden', 'unfocused']));
  assert.equal(sample.parentLabel, 'main'); assert.equal(sample.childParent, 'main');
  for (const [key, value] of Object.entries({ parentInnerPhysical: parent.innerPhysical,
    parentOuterPhysical: parent.outerPhysical, parentPositionPhysical: parent.positionPhysical,
    scale: parent.scale, childLabel: child.label, childUrl: child.url,
    childPositionPhysical: child.positionPhysical, childSizePhysical: child.sizePhysical,
    ownedChildren: [child.label], hidden: true, unfocused: true })) assert.deepEqual(sample[key], value, `Sample ${key}`);
  const monitor = sample.monitor;
  assert.ok(exact(monitor, ['name', 'position', 'size', 'scale', 'workArea']));
  assert.ok(monitor.name === null || typeof monitor.name === 'string');
  assert.ok(position(monitor.position) && size(monitor.size) && positive(monitor.scale));
  assert.deepEqual(monitor.workArea, parent.workArea);
  const expectedSession = { sessionCount: 1, phase: 'open', documentAuthorized: true, ready: true,
    revoked: false, childPresent: true, layoutLeasePresent: true, layoutRegistrationCount: 1,
    bundleRevisionPresent: true };
  assert.deepEqual(sample.session, expectedSession);
  for (const [key, value] of Object.entries(expectedSession)) assert.deepEqual(diagnostics[key], value, `Sample/session diagnostic ${key}`);
}
