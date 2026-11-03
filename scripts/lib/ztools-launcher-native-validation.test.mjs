import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeLauncherNativeReport, validateLauncherMode } from './ztools-launcher-native-validation.mjs';

const root = '/private/tmp/atools-renderer-native-01234567-89ab-4cde-8abc-0123456789ab-immediately';
const marker = { schemaVersion: 1, pid: 123, root, identifier: 'dev.atools.renderer-smoke.0123456789ab4cde8abc0123456789ab' };

function fixture(autoClear = 'immediately') {
  const enter = autoClear === 'immediately';
  return {
    version: 1, autoClear, passed: true, identifier: marker.identifier,
    error: null, verificationErrors: [], settingsView: null, multiwebview: null,
    stages: ['shown', 'prepared', 'hidden', 'reshown', 'prepared-blur', 'blur-hidden', 'blur-return', 'disposed', 'disposed-return']
      .map(stage => ({ stage, elapsedMs: 1, errors: [], native: {}, dom: {
        schemaVersion: 1, stage, stageReady: true, stageWaitMs: 1, inputFound: true,
        documentVisibility: 'visible', documentHasFocus: true, inputFocused: true,
        inputValue: null, selectionStart: 0, selectionEnd: 0, adapter: {},
        preDisposeCounters: null, disposeError: null,
      } })),
    launcher: {
      schemaVersion: 1, enabled: true, passed: true, errors: [],
      catalog: { fixtureOnly: true, itemCount: 2, confined: true },
      input: { key: enter ? 'Enter' : 'Space', spaceEnabled: !enter, domInput: true,
        resultCount: 2, selectionChanged: true, selectedIdentityMatched: true, selectedProbe: 'second' },
      spaceDisabled: { applicable: enter, checked: enter, noTaskRun: true, noMarker: true, noHistory: true },
      unlisted: { rejected: true, noTaskRun: true, noMarker: true, noHistory: true },
      denied: { policyReadback: true, taskRunCancelled: true, auditDenied: true, noMarker: true, noHistory: true },
      launched: { policyCleared: true, taskRunSucceeded: true, auditSucceeded: true,
        markerStarted: true, markerNonceMatched: true, exitMarker: true, processTerminal: true,
        historyRecordedOnce: true, mainHistoryApplied: true, useCount: 1 },
      counts: { taskRuns: 2, denied: 1, succeeded: 1, historyItems: 1, processStarts: 1, processExits: 1 },
      cleanup: { probesTerminal: true, pendingLaunches: 0, liveProbeProcesses: 0 },
    },
  };
}

test('launcher accepts both real-key scenarios only with complete evidence', () => {
  for (const policy of ['immediately', 'never']) assert.equal(validateLauncherMode(fixture(policy)).valid, true);
  assert.equal(validateLauncherMode(null).valid, false);
  const minimal = { launcher: fixture().launcher, autoClear: 'immediately' };
  assert.equal(validateLauncherMode(minimal).valid, false, 'a claimed success cannot replace window and mode evidence');
});

test('every launcher scalar evidence field is mandatory and type-strict', () => {
  const sections = ['catalog', 'input', 'spaceDisabled', 'unlisted', 'denied', 'launched', 'counts', 'cleanup'];
  for (const policy of ['immediately', 'never']) {
    for (const section of sections) {
      const baseline = fixture(policy);
      for (const [key, value] of Object.entries(baseline.launcher[section])) {
        for (const invalid of [undefined, null, typeof value === 'boolean' ? !value : false,
          typeof value === 'number' ? String(value) : 123]) {
          const changed = structuredClone(baseline);
          if (invalid === undefined) delete changed.launcher[section][key];
          else changed.launcher[section][key] = invalid;
          assert.equal(validateLauncherMode(changed).valid, false, `${policy}:${section}.${key}:${String(invalid)}`);
        }
      }
    }
  }
});

test('unknown details, errors, mismatched scenarios and incomplete stages cannot be green', () => {
  for (const mutate of [
    r => { r.launcher.query = 'private-query'; },
    r => { r.launcher.input.path = '/private/app'; },
    r => { r.launcher.errors.push('marker-missing'); },
    r => { r.launcher.passed = false; },
    r => { r.launcher.schemaVersion = 2; },
    r => { r.launcher.input.selectedProbe = 'third'; },
    r => { r.launcher.input.key = 'Space'; },
    r => { r.launcher.counts.taskRuns = 3; },
    r => { r.settingsView = {}; },
    r => { r.multiwebview = {}; },
    r => { r.verificationErrors.push('failed'); },
    r => { r.stages.pop(); },
    r => { r.stages[1].stage = 'shown'; },
    r => { r.stages[1].errors.push('not-visible'); },
    r => { r.stages[1].dom.inputValue = 'private-query'; },
    r => { r.stages[1].dom.query = 'private-query'; },
    r => { r.stages[1].query = 'private-query'; },
    r => { r.stages[1].dom.disposeError = 'private-query'; },
  ]) {
    const report = fixture(); mutate(report); assert.equal(validateLauncherMode(report).valid, false);
  }
});

test('launcher summary retains generic owner and report guards', () => {
  const opts = { autoClear: 'immediately', fixtureRoot: root, childPid: marker.pid };
  const report = { exists: true, value: fixture() };
  assert.equal(summarizeLauncherNativeReport(report, { value: marker }, opts).valid, true);
  assert.equal(summarizeLauncherNativeReport(report, { value: { ...marker, pid: 999 } }, opts).valid, false);
  assert.equal(summarizeLauncherNativeReport({ exists: false }, { value: marker }, opts).valid, false);
  assert.equal(summarizeLauncherNativeReport({ exists: true, value: { ...fixture(), passed: false } }, { value: marker }, opts).valid, false);
  assert.equal(summarizeLauncherNativeReport(report, { value: marker }, { ...opts, autoClear: 'never' }).valid, false);
});
