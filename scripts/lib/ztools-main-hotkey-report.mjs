import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const MAIN_HOTKEY_REPORT_FILENAME = "native-main-hotkey-report.json";
export const MAIN_HOTKEY_ERRORS = Object.freeze([
  "settings-main-hotkey-baseline-invalid", "settings-main-hotkey-open-failed",
  "settings-main-hotkey-record-failed", "settings-main-hotkey-change-failed",
  "settings-main-hotkey-reopen-failed", "settings-main-hotkey-conflict-failed",
  "settings-main-hotkey-restore-failed", "settings-main-hotkey-readback-invalid",
  "settings-main-hotkey-unrelated-changed", "settings-main-hotkey-close-failed",
  "settings-main-hotkey-cleanup-failed", "settings-main-hotkey-report-write-failed",
]);

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "observations", "errors",
]);
const OBSERVATION_KEYS = Object.freeze([
  "initialOwnedRegistered", "initialUiMatches", "recordDispatched", "changedStored",
  "changedOwnedRegistered", "previousUnregistered", "changedUiMatches", "freshChildOnReopen",
  "reopenUiMatches", "reopenStored", "reopenOwnedRegistered", "conflictDispatched",
  "conflictUiRestored", "conflictStoredUnchanged", "conflictPrimaryPreserved", "conflictOtherPreserved",
  "restoreDispatched", "restoredStored", "restoredOwnedRegistered", "alternateUnregistered",
  "unrelatedPreserved", "childClosed", "ownedPrimaryReleased", "otherShortcutReleased",
  "mainRawHotkeyMutationDenied", "childRawHotkeyMutationDenied",
  "pluginUiOpened", "preloadStarted",
]);
const SUCCESS_TRUE = Object.freeze(OBSERVATION_KEYS.slice(0, 26));
const ERROR_SET = new Set(MAIN_HOTKEY_ERRORS);
const IDENTITY = Object.freeze({
  schemaVersion: 1,
  journey: "settings-main-hotkey",
  scope: "hidden-original-vue-main-hotkey",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function validRunId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function ownerMatches(report, expectedOwner) {
  const runId = report.runId;
  return report.schemaVersion === IDENTITY.schemaVersion && report.journey === IDENTITY.journey
    && report.scope === IDENTITY.scope && validRunId(runId)
    && report.identifier === `dev.atools.renderer-settings-input.${runId}`
    && report.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0 && isRecord(expectedOwner)
    && expectedOwner.runId === runId && expectedOwner.identifier === report.identifier
    && expectedOwner.root === report.root && expectedOwner.pid === report.pid
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

function observationsValid(value) {
  return exactKeys(value, OBSERVATION_KEYS)
    && OBSERVATION_KEYS.every(key => value[key] === null || typeof value[key] === "boolean");
}

function observationsPassed(value) {
  return observationsValid(value)
    && SUCCESS_TRUE.every(key => value[key] === true)
    && value.pluginUiOpened === false && value.preloadStarted === false;
}

function errorsValid(value) {
  return Array.isArray(value) && value.length <= ERROR_SET.size && Object.keys(value).length === value.length
    && value.every(code => typeof code === "string" && ERROR_SET.has(code))
    && new Set(value).size === value.length;
}

/** Native pass flags are intentionally absent; pass is derived from owner-bound facts. */
export function validateMainHotkeyReport(report, expectedOwner) {
  if (!exactKeys(report, REPORT_KEYS)) {
    return { valid: false, passed: false, errors: ["report-shape"], summary: { observations: null, nativeErrors: [] } };
  }
  const errors = [];
  const ownerValid = ownerMatches(report, expectedOwner);
  if (!ownerValid) errors.push("report-owner");
  const factsValid = observationsValid(report.observations);
  if (!factsValid) errors.push("observation-shape");
  const nativeErrorsValid = errorsValid(report.errors);
  if (!nativeErrorsValid) errors.push("native-errors-shape");
  if (factsValid && !observationsPassed(report.observations)) errors.push("observations-incomplete");
  const nativeErrors = nativeErrorsValid ? [...report.errors] : [];
  if (nativeErrors.length > 0) errors.push("native-reported-errors");
  const valid = ownerValid && factsValid && nativeErrorsValid;
  return {
    valid,
    passed: valid && nativeErrors.length === 0 && observationsPassed(report.observations),
    errors: [...new Set(errors)],
    summary: { observations: factsValid ? { ...report.observations } : null, nativeErrors },
  };
}

/** Requires the sidecar to belong to the terminal, cleaned settings-input run. */
export async function readMainHotkeyReport(path, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded) {
  let file;
  try { file = await readJsonFile(path, 16 * 1024); }
  catch { file = { exists: false, value: null, exception: { name: "ReadError", code: null } }; }
  const result = validateMainHotkeyReport(file.value, expectedOwner);
  const errors = [...result.errors];
  if (!file.exists) errors.push("report-missing");
  if (nativeOwnerMatches !== true) errors.push("native-owner-mismatch");
  if (nativeCaseSucceeded !== true) errors.push("native-case-not-terminal-success");
  return {
    exists: file.exists === true,
    valid: result.valid && nativeOwnerMatches === true && nativeCaseSucceeded === true && file.exists === true,
    passed: result.passed && nativeOwnerMatches === true && nativeCaseSucceeded === true && file.exists === true,
    errors: [...new Set(errors)],
    summary: result.summary,
    ownerMatchesNativeReport: nativeOwnerMatches === true,
    nativeCaseSucceeded: nativeCaseSucceeded === true,
    exception: file.exception ?? null,
  };
}
