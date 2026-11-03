import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const TRAY_VISIBILITY_REPORT_FILENAME = "native-tray-visibility-report.json";
export const TRAY_VISIBILITY_ERRORS = Object.freeze([
  "settings-tray-visibility-baseline-invalid", "settings-tray-visibility-open-failed",
  "settings-tray-visibility-disable-failed", "settings-tray-visibility-reopen-failed",
  "settings-tray-visibility-enable-failed", "settings-tray-visibility-readback-invalid",
  "settings-tray-visibility-unrelated-changed", "settings-tray-visibility-close-failed",
  "settings-tray-visibility-cleanup-failed", "settings-tray-visibility-report-write-failed",
]);

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "observations", "errors",
]);
const OBSERVATION_KEYS = Object.freeze([
  "startupDefaultVisible", "initialUiEnabled", "disableDispatched", "disabledStored", "disabledNative",
  "freshChildOnReopen", "reopenUiDisabled", "reopenStoredDisabled", "reopenNativeDisabled",
  "enableDispatched", "enabledStored", "enabledNative", "unrelatedPreserved", "childClosed",
  "trayReleased", "pluginUiOpened", "preloadStarted",
]);
const SUCCESS_TRUE = Object.freeze(OBSERVATION_KEYS.slice(0, 15));
const ERROR_SET = new Set(TRAY_VISIBILITY_ERRORS);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function observationsValid(value) {
  return exactKeys(value, OBSERVATION_KEYS)
    && OBSERVATION_KEYS.every(key => value[key] === null || typeof value[key] === "boolean");
}

function errorsValid(value) {
  return Array.isArray(value) && value.length <= ERROR_SET.size && Object.keys(value).length === value.length
    && value.every(code => typeof code === "string" && ERROR_SET.has(code))
    && new Set(value).size === value.length;
}

function ownerMatches(report, expectedOwner) {
  const runId = report.runId;
  return report.schemaVersion === 1 && report.journey === "settings-tray-visibility"
    && report.scope === "hidden-original-vue-tray-visibility"
    && typeof runId === "string" && /^[0-9a-f]{32}$/.test(runId)
    && report.identifier === `dev.atools.renderer-settings-input.${runId}`
    && report.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0 && isRecord(expectedOwner)
    && expectedOwner.runId === runId && expectedOwner.identifier === report.identifier
    && expectedOwner.root === report.root && expectedOwner.pid === report.pid
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

function observationsPassed(value) {
  return observationsValid(value) && SUCCESS_TRUE.every(key => value[key] === true)
    && value.pluginUiOpened === false && value.preloadStarted === false;
}

/** Recomputes tray visibility success from exact owner-bound nullable facts. */
export function validateTrayVisibilityReport(report, expectedOwner) {
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

/** Requires the sidecar to match a terminal, clean settings-input case. */
export async function readTrayVisibilityReport(path, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded) {
  let file;
  try { file = await readJsonFile(path, 16 * 1024); }
  catch { file = { exists: false, value: null, exception: { name: "ReadError", code: null } }; }
  const result = validateTrayVisibilityReport(file.value, expectedOwner);
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
