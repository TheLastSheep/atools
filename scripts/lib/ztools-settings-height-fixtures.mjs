import { A_RAW, HEIGHT_CASES, HEIGHT_HOST_SETUP, heightPaths, projectMacosWrySettingsHeight } from './ztools-settings-height-report.mjs';

export function attachHeightProof(opening) {
  opening.mainClient = mainFixture('loaded'); opening.mainWindowNotifications = notificationsFixture();
  Object.assign(opening.diagnostics, { phase: 'open', revoked: false, bundleRevisionPresent: true });
  const p = opening.parent, c = opening.child;
  const sample = { parentLabel: 'main', parentInnerPhysical: structuredClone(p.innerPhysical),
    parentOuterPhysical: structuredClone(p.outerPhysical), parentPositionPhysical: structuredClone(p.positionPhysical),
    scale: p.scale, monitor: { name: 'test-monitor', position: { x: 0, y: 0 }, size: { width: 2400, height: 1800 },
      scale: p.scale, workArea: structuredClone(p.workArea) }, childLabel: c.label, childUrl: c.url, childParent: 'main',
    childPositionPhysical: structuredClone(c.positionPhysical), childSizePhysical: structuredClone(c.sizePhysical),
    ownedChildren: [c.label], session: Object.fromEntries(['sessionCount', 'phase', 'documentAuthorized', 'ready',
      'revoked', 'childPresent', 'layoutLeasePresent', 'layoutRegistrationCount', 'bundleRevisionPresent']
      .map(key => [key, opening.diagnostics[key]])), hidden: true, unfocused: true };
  opening.stability = { attempts: 1, before: structuredClone(sample), after: sample };
}
const mainFixture = phase => ({ version: 1, listenerState: 'listening', activePhase: phase, pendingOpen: false,
  openFailures: 0, closeFailures: 0, invalidPayloads: 0, registrationErrors: 0, lateListenerUnlistens: 0, cleanupErrors: 0 });
const notificationsFixture = () => ({ pendingReplies: 0, failures: 0, cancelled: 0, dropped: 0 });
export const TEST_MAIN_SHA = 'a'.repeat(64), TEST_SETTINGS_SHA = 'b'.repeat(64);
export function heightReportFixture(runId, heightCase = 'a', seed = null, rawBefore = null) {
  const paths = heightPaths(runId), spec = HEIGHT_CASES[heightCase];
  rawBefore ??= heightCase === 'a' ? A_RAW : JSON.stringify({ ...JSON.parse(A_RAW), windowDefaultHeight: spec.desired });
  if (heightCase !== 'a' && seed === null) seed = { path: paths.seed, sha256: 'd'.repeat(64), bytes: 4096 };
  const ids = ['aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa', 'bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb'];
  const desired = spec.desired, scale = 2, projected = projectMacosWrySettingsHeight(desired, scale);
  const parentHeight = Math.min(projected.parentPhysicalHeight, 1760);
  const checks = Object.fromEntries(['identity', 'ready', 'registration', 'parentHeight', 'parentWidthPositive',
    'childHeight', 'childHeader', 'childWidth', 'hidden', 'unfocused'].map(key => [key, true]));
  const stages = spec.next === null ? ['initial'] : ['initial', 'after-write', 'reopened'];
  const openings = stages.map((stage, i) => {
    const sessionId = ids[i === 2 ? 1 : 0];
    return { stage, sessionId, bundleRevision: TEST_SETTINGS_SHA, expectedDesired: desired,
      expectedSource: i === 0 ? heightCase === 'a' ? 'raw-absent' : 'raw-value' : 'runtime-cache',
      observedBehavior: ['initial-native-geometry', 'committed-raw-changed-geometry-unchanged', 'new-session-reused-height'][i],
      parent: { innerPhysical: { width: 1200, height: parentHeight }, outerPhysical: { width: 1200, height: parentHeight + 40 },
        positionPhysical: { x: 0, y: 0 }, scale, workArea: { position: { x: 0, y: 0 }, size: { width: 2400, height: 1800 } } },
      child: { label: `ztools-settings-${sessionId}`, url: `atools-settings://${sessionId}.localhost/index.html#/generalSetting`,
        positionPhysical: { x: 0, y: 116 }, sizePhysical: { width: 1200, height: projected.childPhysicalHeight },
        logicalHeight: projected.childPhysicalHeight / scale },
      diagnostics: { sessionCount: 1, childPresent: true, ready: true, documentAuthorized: true, layoutLeasePresent: true, layoutRegistrationCount: 1, pendingWrites: 0 },
      hidden: true, unfocused: true, checks, parentClipped: projected.parentPhysicalHeight > 1760 };
  });
  openings.forEach(attachHeightProof);
  const report = { schemaVersion: 1, kind: 'settings-height', ...paths, pid: 12345678, heightCase,
    deadlineSeconds: 165, lifecyclePhase: 'journey-complete-before-host-teardown', status: 'passed', errors: [],
    rawGeneral: { before: rawBefore, after: spec.next === null ? rawBefore : JSON.stringify({ ...JSON.parse(rawBefore), windowDefaultHeight: spec.next }) },
    seed: structuredClone(seed), openings, closes: ids.slice(0, spec.next === null ? 1 : 2).map(sessionId => ({ sessionId,
      diagnostics: { sessionCount: 0, childPresent: false, layoutLeasePresent: false, layoutRegistrationCount: 0, pendingCalls: 0, pendingWrites: 0 },
      mainClient: mainFixture('back-to-search'), mainWindowNotifications: notificationsFixture(),
      childAbsent: true, layoutAbsent: true, pendingDrained: true, hidden: true, unfocused: true })),
    stagesCompleted: spec.next === null ? ['initial-open', 'initial-closed']
      : ['initial-open', 'patch-committed', 'after-write-observed', 'initial-closed', 'reopened', 'reopened-closed'],
    elapsedMs: 1234, elapsedSamplePhase: 'before-report-serialization-and-fsync', processExit: null, guiAcceptance: 'unverified',
    isolation: { loginItemStatus: 'fixture-unavailable', shortcutPluginInstalled: false, clipboardReads: 0, clipboardWrites: 0, clipboardPastes: 0 },
    sources: { mainProvenanceSha256: TEST_MAIN_SHA, settingsProvenanceSha256: TEST_SETTINGS_SHA },
    hostSetup: structuredClone(HEIGHT_HOST_SETUP) };
  // CLI paths are not report fields.
  delete report.output; delete report.database;
  const expected = { ...paths, heightCase, pid: report.pid, bundleRevision: TEST_SETTINGS_SHA,
    mainProvenanceSha256: TEST_MAIN_SHA, rawBefore, seed };
  return { report, expected };
}
