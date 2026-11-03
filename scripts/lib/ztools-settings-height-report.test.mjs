import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { validateHeightReport } from './ztools-settings-height-report.mjs';
import { attachHeightProof, heightReportFixture } from './ztools-settings-height-fixtures.mjs';

for (const heightCase of ['a', 'b', 'c', 'd']) test(`independently accepts case ${heightCase} geometry and raw progression`, () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), heightCase);
  assert.deepEqual(validateHeightReport(report, expected), { valid: true, passed: true, errors: [] });
});

const mutations = {
  'wrong pid': r => { r.pid++; },
  'wrong root': r => { r.root += '/other'; },
  'forged pass geometry': r => { r.openings[0].child.sizePhysical.height = 1200; },
  'wrong rounding': r => { r.openings[0].child.positionPhysical.y = 118; },
  'save resizes current window': r => { r.openings[1].parent.innerPhysical.height--; },
  'reopen reuses old session': r => { r.openings[2].sessionId = r.openings[0].sessionId; },
  'foreign child URL': r => { r.openings[0].child.url = 'https://example.com/'; },
  'unreleased registration': r => { r.closes[0].diagnostics.layoutRegistrationCount = 1; },
  'unfinished stages': r => { r.stagesCompleted.pop(); },
  'unknown field lost': r => { r.rawGeneral.after = '{"windowDefaultHeight":200.5}'; },
  'DB not committed': r => { r.rawGeneral.after = r.rawGeneral.before; },
  'unbound formal artifact': r => { r.sources.settingsProvenanceSha256 = 'e'.repeat(64); },
  'clipboard activity': r => { r.isolation.clipboardReads = 1; },
  'real login probe claim': r => { r.isolation.loginItemStatus = 'enabled'; },
  'claimed GUI acceptance': r => { r.guiAcceptance = 'passed'; },
  'nonfinite geometry': r => { r.openings[0].parent.scale = NaN; },
  'producer beyond175s': r => { r.elapsedMs = 175001; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''));
  mutate(report); assert.equal(validateHeightReport(report, expected).passed, false);
});

test('D cannot substitute a clipped child for requested2001 even with all producer checks true', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), 'd');
  report.openings[0].child.sizePhysical.height = report.openings[0].parent.innerPhysical.height - 116;
  assert.equal(validateHeightReport(report, expected).passed, false);
});

test('B/C/D must bind the exact closed sibling seed', () => {
  for (const heightCase of ['b', 'c', 'd']) {
    const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), heightCase);
    report.seed.path += '.other';
    assert.equal(validateHeightReport(report, expected).passed, false);
  }
});

function atScaleOne(report) {
  for (const opening of report.openings) {
    const desired = opening.expectedDesired;
    opening.parent.scale = 1;
    opening.parent.innerPhysical = { width: 600, height: Math.min(Math.ceil(desired + 58), 880) };
    opening.parent.outerPhysical = { width: 600, height: opening.parent.innerPhysical.height + 20 };
    opening.parent.workArea = { position: { x: 0, y: 0 }, size: { width: 1200, height: 900 } };
    opening.child.positionPhysical = { x: 0, y: 58 };
    opening.child.sizePhysical = { width: 600, height: Math.round(desired) };
    opening.child.logicalHeight = Math.round(desired);
    opening.parentClipped = desired + 58 > 880;
    attachHeightProof(opening);
  }
}

test('fractional logical requests use exact final ceil/round physical targets', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
  atScaleOne(report);
  assert.equal(report.openings[0].parent.innerPhysical.height, 259);
  assert.equal(report.openings[0].child.sizePhysical.height, 201);
  assert.equal(validateHeightReport(report, expected).passed, true);
  for (const opening of report.openings) { opening.child.sizePhysical.height = 200; opening.child.logicalHeight = 200; }
  assert.equal(validateHeightReport(report, expected).passed, false);
});

function setFixed2005AtScaleTwo(report, { parentDelta = 0, childDelta = 0 } = {}) {
  for (const opening of report.openings) {
    opening.parent.scale = 2;
    opening.parent.innerPhysical = { width: 1200, height: 518 + parentDelta };
    opening.parent.outerPhysical = { width: 1200, height: 558 + parentDelta };
    opening.parent.positionPhysical = { x: 0, y: 0 };
    opening.parent.workArea = { position: { x: 0, y: 0 }, size: { width: 2400, height: 1800 } };
    opening.child.positionPhysical = { x: 0, y: 116 };
    opening.child.sizePhysical = { width: 1200, height: 402 + childDelta };
    opening.child.logicalHeight = (402 + childDelta) / 2;
    opening.parentClipped = false;
    attachHeightProof(opening);
  }
}

test('the 200.5 at scale 2 fixture uses fixed 518 parent and 402 child constants', () => {
  const { report } = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
  assert.deepEqual(report.openings.map(opening => ({
    parent: opening.parent.innerPhysical.height,
    child: opening.child.sizePhysical.height,
  })), [{ parent: 518, child: 402 }, { parent: 518, child: 402 }, { parent: 518, child: 402 }]);
});

test('200.5 at scale 2 accepts only fixed 518 parent and 402 child geometry', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
  setFixed2005AtScaleTwo(report);
  assert.deepEqual(validateHeightReport(report, expected), { valid: true, passed: true, errors: [] });

  const oldGeometry = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
  setFixed2005AtScaleTwo(oldGeometry.report, { parentDelta: -1, childDelta: -1 });
  assert.equal(validateHeightReport(oldGeometry.report, oldGeometry.expected).passed, false,
    'Old 517/401 geometry must be rejected');

  for (const [field, deltas] of [['parent', [-1, 1]], ['child', [-1, 1]]]) {
    for (const delta of deltas) {
      const deviation = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
      setFixed2005AtScaleTwo(deviation.report, field === 'parent' ? { parentDelta: delta } : { childDelta: delta });
      assert.equal(validateHeightReport(deviation.report, deviation.expected).passed, false,
        `${field} deviation ${delta} must be rejected`);
    }
  }
});

test('fractional 200.5 at scale 1.5 follows the fixed integer-logical projection', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
  for (const opening of report.openings) {
    opening.parent.scale = 1.5;
    opening.parent.innerPhysical = { width: 900, height: 389 };
    opening.parent.outerPhysical = { width: 900, height: 419 };
    opening.parent.positionPhysical = { x: 0, y: 0 };
    opening.parent.workArea = { position: { x: 0, y: 0 }, size: { width: 1800, height: 1400 } };
    opening.child.positionPhysical = { x: 0, y: 87 };
    opening.child.sizePhysical = { width: 900, height: 302 };
    opening.child.logicalHeight = 302 / 1.5;
    opening.parentClipped = false;
    attachHeightProof(opening);
  }
  assert.deepEqual(validateHeightReport(report, expected), { valid: true, passed: true, errors: [] });
  for (const opening of report.openings) {
    opening.child.sizePhysical.height++;
    opening.child.logicalHeight = opening.child.sizePhysical.height / 1.5;
    attachHeightProof(opening);
  }
  assert.equal(validateHeightReport(report, expected).passed, false, 'Scale 1.5 child geometry stays exact');
});

test('a/c both fixed to600 at scale1 cannot pass: explicit541 must be599', () => {
  for (const heightCase of ['a', 'c']) {
    const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), heightCase);
    atScaleOne(report);
    for (const opening of report.openings) { opening.parent.innerPhysical.height = 600; opening.parent.outerPhysical.height = 620; attachHeightProof(opening); }
    assert.equal(validateHeightReport(report, expected).passed, heightCase === 'a');
  }
});

test('reset immediately decreasing the current actual parent by one pixel is rejected', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''), 'b');
  report.openings[1].parent.innerPhysical.height--; report.openings[1].parent.outerPhysical.height--;
  assert.equal(validateHeightReport(report, expected).passed, false);
});

test('same-scale/workarea reopen one-pixel movement is rejected even if workarea key order changes', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''));
  const last = report.openings[2]; last.parent.positionPhysical.y++;
  last.parent.workArea = { size: last.parent.workArea.size, position: last.parent.workArea.position };
  assert.equal(validateHeightReport(report, expected).passed, false);
});

test('host setup declarations cannot claim a different native window path', () => {
  const { report, expected } = heightReportFixture(randomUUID().replaceAll('-', ''));
  report.hostSetup.macosMainPanelPrototype = true;
  assert.equal(validateHeightReport(report, expected).passed, false);
});
