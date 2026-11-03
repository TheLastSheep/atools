import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const WINDOW_OPACITY_REPORT_FILENAME = "native-window-opacity-report.json";
export const WINDOW_OPACITY_ERRORS = Object.freeze([
  "settings-window-opacity-baseline-invalid", "settings-window-opacity-open-failed",
  "settings-window-opacity-change-failed", "settings-window-opacity-reopen-failed",
  "settings-window-opacity-restore-failed", "settings-window-opacity-readback-invalid",
  "settings-window-opacity-unrelated-changed", "settings-window-opacity-close-failed",
  "settings-window-opacity-report-write-failed",
]);

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "observations", "errors",
]);
const BOOL_KEYS = Object.freeze([
  "initialStateValid", "changeDispatched", "changedUiMatches", "changedStored", "changedNativeMatches",
  "freshChildOnReopen", "reopenUiMatches", "reopenStored", "reopenNativeMatches", "restoreDispatched",
  "restoredStored", "restoredNativeMatches", "unrelatedPreserved", "closed", "pluginUiOpened", "preloadStarted",
]);
const TRUE_KEYS = Object.freeze(BOOL_KEYS.slice(0, 14));
const OPACITY_KEYS = Object.freeze(["changedNativeOpacity", "reopenedNativeOpacity", "restoredNativeOpacity"]);
const OBSERVATION_KEYS = Object.freeze([...BOOL_KEYS, ...OPACITY_KEYS]);
const ERROR_SET = new Set(WINDOW_OPACITY_ERRORS);
const IDENTITY = Object.freeze({
  schemaVersion: 1,
  journey: "settings-window-opacity",
  scope: "hidden-original-vue-window-opacity",
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function exactErrors(errors) {
  return Array.isArray(errors) && errors.length <= ERROR_SET.size && Object.keys(errors).length === errors.length
    && errors.every(error => typeof error === "string" && ERROR_SET.has(error))
    && new Set(errors).size === errors.length;
}

function boundedOpacity(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function observationsValid(value) {
  return exactKeys(value, OBSERVATION_KEYS)
    && BOOL_KEYS.every(key => value[key] === null || typeof value[key] === "boolean")
    && OPACITY_KEYS.every(key => value[key] === null || boundedOpacity(value[key]));
}

function near(value, expected) {
  return boundedOpacity(value) && Math.abs(value - expected) <= 0.005000001;
}

function observationsPassed(value) {
  return observationsValid(value) && TRUE_KEYS.every(key => value[key] === true)
    && value.pluginUiOpened === false && value.preloadStarted === false
    && near(value.changedNativeOpacity, 0.65)
    && near(value.reopenedNativeOpacity, 0.65)
    && near(value.restoredNativeOpacity, 1);
}

function ownerMatches(report, expectedOwner) {
  const runId = report.runId;
  return report.schemaVersion === IDENTITY.schemaVersion && report.journey === IDENTITY.journey
    && report.scope === IDENTITY.scope && typeof runId === "string" && /^[0-9a-f]{32}$/.test(runId)
    && report.identifier === `dev.atools.renderer-settings-input.${runId}`
    && report.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0 && isRecord(expectedOwner)
    && expectedOwner?.runId === runId && expectedOwner?.identifier === report.identifier
    && expectedOwner?.root === report.root && expectedOwner?.pid === report.pid
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

/** Native pass flags are excluded; success is recomputed from exact owner-bound observations. */
export function validateWindowOpacityReport(report, expectedOwner) {
  if (!exactKeys(report, REPORT_KEYS)) {
    return { valid: false, passed: false, errors: ["report-shape"], summary: { observations: null, nativeErrors: [] } };
  }
  const errors = [];
  const ownerValid = ownerMatches(report, expectedOwner);
  if (!ownerValid) errors.push("report-owner");
  const factsValid = observationsValid(report.observations);
  if (!factsValid) errors.push("observation-shape");
  const errorsValid = exactErrors(report.errors);
  if (!errorsValid) errors.push("native-errors-shape");
  if (factsValid && !observationsPassed(report.observations)) errors.push("observations-incomplete");
  const nativeErrors = errorsValid ? [...report.errors] : [];
  if (nativeErrors.length > 0) errors.push("native-reported-errors");
  const valid = ownerValid && factsValid && errorsValid;
  return {
    valid,
    passed: valid && nativeErrors.length === 0 && observationsPassed(report.observations),
    errors: [...new Set(errors)],
    summary: { observations: factsValid ? { ...report.observations } : null, nativeErrors },
  };
}

/** Requires the report to match the terminal, clean settings-input case. */
export async function readWindowOpacityReport(path, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded) {
  let file;
  try { file = await readJsonFile(path, 16 * 1024); }
  catch { file = { exists: false, value: null, exception: { name: "ReadError", code: null } }; }
  const result = validateWindowOpacityReport(file.value, expectedOwner);
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
