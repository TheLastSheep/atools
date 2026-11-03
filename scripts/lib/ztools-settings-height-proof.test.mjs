import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { heightReportFixture } from './ztools-settings-height-fixtures.mjs';
import { validateHeightReport } from './ztools-settings-height-report.mjs';

const mutations = {
  'missing actual Main receipt': r => { delete r.openings[0].mainClient; },
  'expected loaded but actual Main still pending': r => { r.openings[0].mainClient.pendingOpen = true; },
  'open actual Main old phase': r => { r.openings[0].mainClient.activePhase = 'back-to-search'; },
  'Native phase remains loaded': r => {
    const opening = r.openings[0];
    opening.diagnostics.phase = 'loaded';
    opening.stability.before.session.phase = 'loaded';
    opening.stability.after.session.phase = 'loaded';
  },
  'Main phase remains open': r => { r.openings[0].mainClient.activePhase = 'open'; },
  'close actual Main still loaded': r => { r.closes[0].mainClient.activePhase = 'loaded'; },
  'Main listener registration failure': r => { r.openings[0].mainClient.registrationErrors = 1; },
  'Main close failure': r => { r.closes[0].mainClient.closeFailures = 1; },
  'actual window reply pending': r => { r.openings[0].mainWindowNotifications.pendingReplies = 1; },
  'actual window notification failure': r => { r.closes[0].mainWindowNotifications.failures = 1; },
  'dropped notification': r => { r.closes[0].mainWindowNotifications.dropped = 1; },
  'mixed sample scale': r => { r.openings[0].stability.after.scale = 1; },
  'mixed sample monitor': r => { r.openings[0].stability.after.monitor.name = 'another'; },
  'mixed sample lease': r => { r.openings[0].stability.after.session.layoutLeasePresent = false; },
  'out of bounded stability attempts': r => { r.openings[0].stability.attempts = 4; },
  'empty equal fingerprints': r => { r.openings[0].stability.before = r.openings[0].stability.after = {}; },
  'wrong receipt sampling phase': r => { r.elapsedSamplePhase = 'after-host-teardown'; },
};
for (const field of ['parentLabel', 'parentInnerPhysical', 'parentPositionPhysical', 'scale',
  'childLabel', 'childUrl', 'childParent', 'childSizePhysical', 'ownedChildren', 'session', 'hidden']) {
  mutations[`equal fingerprints forged ${field}`] = r => {
    const value = r.openings[0].stability;
    const bad = { parentLabel: 'other', parentInnerPhysical: { width: 1200, height: 1201 },
      parentPositionPhysical: { x: 1, y: 0 }, scale: 1, childLabel: 'foreign', childUrl: 'https://foreign/',
      childParent: 'other', childSizePhysical: { width: 1200, height: 1085 }, ownedChildren: ['foreign'],
      session: { sessionCount: 1 }, hidden: false }[field];
    value.before[field] = structuredClone(bad); value.after[field] = structuredClone(bad);
  };
}
for (const [name, mutate] of Object.entries(mutations)) test(`actual proof rejects ${name} despite passed labels`, () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''));
  mutate(report); assert.equal(validateHeightReport(report, expected).passed, false, name);
});
test('Native open/Main loaded and third stable sample are accepted independently of terminal', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''));
  assert.equal(report.openings[0].diagnostics.phase, 'open');
  assert.equal(report.openings[0].stability.after.session.phase, 'open');
  assert.equal(report.openings[0].mainClient.activePhase, 'loaded');
  for (const opening of report.openings) opening.stability.attempts = 3;
  report.elapsedMs = 175000;
  assert.equal(validateHeightReport(report, expected).passed, true);
  report.elapsedMs++;
  assert.equal(validateHeightReport(report, expected).passed, false);
});
