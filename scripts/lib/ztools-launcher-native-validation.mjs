import { markerMatches, validateNativeReport } from './ztools-renderer-native-runtime.mjs';

const STAGES = ['shown', 'prepared', 'hidden', 'reshown', 'prepared-blur', 'blur-hidden', 'blur-return', 'disposed', 'disposed-return'];
const STAGE_KEYS = ['dom', 'elapsedMs', 'errors', 'native', 'stage'];
const DOM_KEYS = ['schemaVersion', 'stage', 'stageReady', 'stageWaitMs', 'inputFound',
  'documentVisibility', 'documentHasFocus', 'inputFocused', 'inputValue',
  'selectionStart', 'selectionEnd', 'adapter', 'preDisposeCounters', 'disposeError'];
const SECTIONS = {
  catalog: ['fixtureOnly', 'itemCount', 'confined'],
  input: ['key', 'spaceEnabled', 'domInput', 'resultCount', 'selectionChanged', 'selectedIdentityMatched', 'selectedProbe'],
  spaceDisabled: ['applicable', 'checked', 'noTaskRun', 'noMarker', 'noHistory'],
  unlisted: ['rejected', 'noTaskRun', 'noMarker', 'noHistory'],
  denied: ['policyReadback', 'taskRunCancelled', 'auditDenied', 'noMarker', 'noHistory'],
  launched: ['policyCleared', 'taskRunSucceeded', 'auditSucceeded', 'markerStarted', 'markerNonceMatched', 'exitMarker', 'processTerminal', 'historyRecordedOnce', 'mainHistoryApplied', 'useCount'],
  counts: ['taskRuns', 'denied', 'succeeded', 'historyItems', 'processStarts', 'processExits'],
  cleanup: ['probesTerminal', 'pendingLaunches', 'liveProbeProcesses'],
};
const TRUE_FIELDS = {
  catalog: ['fixtureOnly', 'confined'],
  input: ['domInput', 'selectionChanged', 'selectedIdentityMatched'],
  spaceDisabled: ['noTaskRun', 'noMarker', 'noHistory'],
  unlisted: ['rejected', 'noTaskRun', 'noMarker', 'noHistory'],
  denied: ['policyReadback', 'taskRunCancelled', 'auditDenied', 'noMarker', 'noHistory'],
  launched: SECTIONS.launched.filter(key => key !== 'useCount'),
  cleanup: ['probesTerminal'],
};

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isObject(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

export function validateLauncherMode(report) {
  const errors = [];
  const check = (condition, name) => { if (!condition) errors.push(name); };
  const launcher = isObject(report) ? report.launcher : null;
  check(report?.settingsView === null && report?.multiwebview === null, 'launcher-exclusive-mode');
  check(report?.error === null && Array.isArray(report?.verificationErrors)
    && report.verificationErrors.length === 0, 'launcher-generic-errors');
  check(Array.isArray(report?.stages) && report.stages.length === STAGES.length
    && report.stages.every((stage, index) => exactKeys(stage, STAGE_KEYS)
      && stage.stage === STAGES[index] && exactKeys(stage.dom, DOM_KEYS)
      && stage.dom.inputValue === null && stage.dom.disposeError === null
      && Array.isArray(stage.errors) && stage.errors.length === 0), 'launcher-window-stages');
  check(exactKeys(launcher, ['schemaVersion', 'enabled', 'passed', 'errors', ...Object.keys(SECTIONS)]), 'launcher-report-shape');
  if (!isObject(launcher)) {
    return { mode: 'launcher', valid: false, enabled: false, passed: false, errors };
  }
  check(launcher.schemaVersion === 1, 'launcher-schema-version');
  check(launcher.enabled === true, 'launcher-enabled');
  check(launcher.passed === true, 'launcher-passed');
  check(Array.isArray(launcher.errors) && launcher.errors.length === 0, 'launcher-errors');
  for (const [section, fields] of Object.entries(SECTIONS)) {
    check(exactKeys(launcher[section], fields), `launcher-${section}-shape`);
  }
  for (const [section, fields] of Object.entries(TRUE_FIELDS)) {
    for (const field of fields) check(launcher[section]?.[field] === true, `launcher-${section}-${field}`);
  }
  const enterCase = report.autoClear === 'immediately';
  check(enterCase || report.autoClear === 'never', 'launcher-case-policy');
  check(launcher.input?.key === (enterCase ? 'Enter' : 'Space'), 'launcher-key');
  check(launcher.input?.spaceEnabled === !enterCase, 'launcher-space-preference');
  check(launcher.spaceDisabled?.applicable === enterCase
    && launcher.spaceDisabled?.checked === enterCase, 'launcher-space-disabled-scope');
  check(['first', 'second'].includes(launcher.input?.selectedProbe), 'launcher-selected-probe');
  for (const [section, field, expected] of [
    ['catalog', 'itemCount', 2], ['input', 'resultCount', 2], ['launched', 'useCount', 1],
    ['counts', 'taskRuns', 2], ['counts', 'denied', 1], ['counts', 'succeeded', 1],
    ['counts', 'historyItems', 1], ['counts', 'processStarts', 1], ['counts', 'processExits', 1],
    ['cleanup', 'pendingLaunches', 0], ['cleanup', 'liveProbeProcesses', 0],
  ]) check(launcher[section]?.[field] === expected, `launcher-${section}-${field}`);
  return { mode: 'launcher', valid: errors.length === 0, enabled: launcher.enabled === true,
    passed: launcher.passed === true, errors };
}

export function summarizeLauncherNativeReport(reportFile, markerFile, { autoClear, fixtureRoot, childPid }) {
  const marker = markerFile?.value;
  const owner = markerMatches(marker, fixtureRoot, childPid);
  if (!reportFile?.exists || !isObject(reportFile.value)) {
    const modeEvidence = validateLauncherMode(null);
    return { exists: reportFile?.exists ?? false, valid: false, version: null, autoClear: null,
      passed: false, metadataMatchesOwner: false, multiwebview: null, settingsView: null,
      launcher: modeEvidence, modeEvidence, exception: reportFile?.exception ?? null, owner };
  }
  const generic = validateNativeReport(reportFile.value, { autoClear, marker, fixtureRoot, childPid });
  const modeEvidence = validateLauncherMode(reportFile.value);
  return { exists: true, ...generic, valid: generic.valid && modeEvidence.valid,
    multiwebview: null, settingsView: null, launcher: modeEvidence, modeEvidence, exception: null, owner };
}
