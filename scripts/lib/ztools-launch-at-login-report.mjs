import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const LAUNCH_AT_LOGIN_REPORT_FILENAME = "native-launch-at-login-report.json";
export const LAUNCH_AT_LOGIN_ERRORS = Object.freeze([
  "settings-launch-at-login-owner-invalid", "settings-launch-at-login-install-failed",
  "settings-launch-at-login-baseline-invalid", "settings-launch-at-login-enable-failed",
  "settings-launch-at-login-close-failed", "settings-launch-at-login-reopen-failed",
  "settings-launch-at-login-external-disable-failed", "settings-launch-at-login-conflict-invalid",
  "settings-launch-at-login-readback-invalid", "settings-launch-at-login-safety-invalid",
  "settings-launch-at-login-cleanup-failed", "settings-launch-at-login-report-write-failed",
]);

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId",
  "elapsedMs", "attempted", "observations", "errors", "passed",
]);
const INSTALL_KEYS = Object.freeze(["ownerVerified", "attempted", "proofInstalled"]);
const BASELINE_KEYS = Object.freeze(["routeGeneral", "controlUnique", "uiEnabled", "getterEnabled", "nativeEnabled"]);
const CLICK_KEYS = Object.freeze([
  "routeGeneral", "controlUnique", "clickDispatched", "uiEnabled", "getterEnabled", "errorCode", "nativeEnabled",
]);
const REOPEN_KEYS = Object.freeze([
  "newSession", "routeGeneral", "controlUnique", "uiEnabled", "getterEnabled", "nativeEnabled",
]);
const EXTERNAL_KEYS = Object.freeze(["attempted", "confirmed", "nativeEnabled"]);
const CONFLICT_KEYS = Object.freeze([
  "routeGeneral", "controlUnique", "clickDispatched", "uiEnabled", "getterEnabled",
  "rollbackObserved", "errorCode", "nativeEnabled",
]);
const CLEANUP_KEYS = Object.freeze(["attempted", "unregistered", "osEnabled", "nativeCallsTerminal"]);
const OBSERVATION_KEYS = Object.freeze([
  "install", "baseline", "enable", "freshEnabled", "externalDisable", "conflict",
  "freshDisabled", "childClosed", "pluginUiOpened", "preloadStarted", "cleanup",
]);
const ERROR_CODES = new Set(LAUNCH_AT_LOGIN_ERRORS);
const PROBE_ERROR_CODES = new Set(["conflict", "approval", "legacy", "unavailable", "unsupported", "recovery", "other"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boolOrNull(value) {
  return value === null || typeof value === "boolean";
}

function validOwner(report, expectedOwner) {
  const runId = report.runId;
  return typeof runId === "string" && /^[0-9a-f]{32}$/.test(runId)
    && report.schemaVersion === 1 && report.journey === "settings-launch-at-login"
    && report.scope === "hidden-original-vue-launch-at-login"
    && report.identifier === `dev.atools.renderer-settings-input.${runId}`
    && report.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0 && isRecord(expectedOwner)
    && expectedOwner.runId === runId && expectedOwner.identifier === report.identifier
    && expectedOwner.root === report.root && expectedOwner.pid === report.pid
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

function validErrors(value) {
  return Array.isArray(value) && value.length <= ERROR_CODES.size && Object.keys(value).length === value.length
    && value.every(code => typeof code === "string" && ERROR_CODES.has(code))
    && new Set(value).size === value.length;
}

function validObservations(value) {
  if (!exactKeys(value, OBSERVATION_KEYS)
      || !exactKeys(value.install, INSTALL_KEYS)
      || !exactKeys(value.baseline, BASELINE_KEYS)
      || !exactKeys(value.enable, CLICK_KEYS)
      || !exactKeys(value.freshEnabled, REOPEN_KEYS)
      || !exactKeys(value.externalDisable, EXTERNAL_KEYS)
      || !exactKeys(value.conflict, CONFLICT_KEYS)
      || !exactKeys(value.freshDisabled, REOPEN_KEYS)
      || !exactKeys(value.cleanup, CLEANUP_KEYS)) return false;
  const booleanGroups = [value.install, value.baseline, value.enable, value.freshEnabled,
    value.externalDisable, value.conflict, value.freshDisabled, value.cleanup];
  return booleanGroups.every(group => Object.entries(group).every(([key, item]) =>
    key === "errorCode" ? item === null || PROBE_ERROR_CODES.has(item) : boolOrNull(item)))
    && boolOrNull(value.childClosed) && boolOrNull(value.pluginUiOpened) && boolOrNull(value.preloadStarted);
}

function observationsPassed(value) {
  return value.install.ownerVerified === true && value.install.attempted === true
    && value.install.proofInstalled === true
    && value.baseline.routeGeneral === true && value.baseline.controlUnique === true
    && value.baseline.uiEnabled === false && value.baseline.getterEnabled === false
    && value.baseline.nativeEnabled === false
    && value.enable.routeGeneral === true && value.enable.controlUnique === true
    && value.enable.clickDispatched === true && value.enable.uiEnabled === true
    && value.enable.getterEnabled === true && value.enable.errorCode === null
    && value.enable.nativeEnabled === true
    && value.freshEnabled.newSession === true && value.freshEnabled.routeGeneral === true
    && value.freshEnabled.controlUnique === true && value.freshEnabled.uiEnabled === true
    && value.freshEnabled.getterEnabled === true && value.freshEnabled.nativeEnabled === true
    && value.externalDisable.attempted === true && value.externalDisable.confirmed === true
    && value.externalDisable.nativeEnabled === false
    && value.conflict.routeGeneral === true && value.conflict.controlUnique === true
    && value.conflict.clickDispatched === true && value.conflict.uiEnabled === true
    && value.conflict.getterEnabled === null
    && value.conflict.rollbackObserved === true && value.conflict.errorCode === "conflict"
    && value.conflict.nativeEnabled === false
    && value.freshDisabled.newSession === true && value.freshDisabled.routeGeneral === true
    && value.freshDisabled.controlUnique === true && value.freshDisabled.uiEnabled === false
    && value.freshDisabled.getterEnabled === false && value.freshDisabled.nativeEnabled === false
    && value.childClosed === true && value.pluginUiOpened === false && value.preloadStarted === false
    && value.cleanup.attempted === true && value.cleanup.unregistered === true
    && value.cleanup.osEnabled === false && value.cleanup.nativeCallsTerminal === true;
}

/** Recomputes login-item success and the separate safe-to-delete proof from fixed facts. */
export function validateLaunchAtLoginReport(report, expectedOwner) {
  const shapeValid = exactKeys(report, REPORT_KEYS)
    && Number.isSafeInteger(report.elapsedMs) && report.elapsedMs >= 0 && report.elapsedMs <= 180_000
    && typeof report.attempted === "boolean" && typeof report.passed === "boolean"
    && validObservations(report.observations) && validErrors(report.errors);
  const ownerValid = shapeValid && validOwner(report, expectedOwner);
  const errorsValid = shapeValid && validErrors(report.errors);
  const factPass = shapeValid && observationsPassed(report.observations);
  const recomputed = ownerValid && errorsValid && factPass && report.errors.length === 0;
  const claimConsistent = shapeValid && report.passed === recomputed;
  const errors = [];
  if (!shapeValid) errors.push("report-shape");
  else if (!ownerValid) errors.push("report-owner");
  if (!errorsValid) errors.push("native-errors-shape");
  if (shapeValid && !factPass) errors.push("observations-incomplete");
  if (errorsValid && report.errors.length > 0) errors.push("native-reported-errors");
  if (!claimConsistent) errors.push("pass-claim-mismatch");
  const valid = shapeValid && ownerValid && errorsValid && claimConsistent;
  const cleanupSafe = valid && report.observations.install.ownerVerified === true
    && report.observations.install.attempted === true && report.observations.install.proofInstalled === true
    && report.observations.cleanup.attempted === true && report.observations.cleanup.unregistered === true
    && report.observations.cleanup.osEnabled === false
    && report.observations.cleanup.nativeCallsTerminal === true;
  return {
    valid,
    passed: valid && recomputed,
    cleanupSafe,
    errors: [...new Set(errors)],
    summary: { observations: shapeValid ? { ...report.observations } : null, nativeErrors: errorsValid ? [...report.errors] : [] },
  };
}

/** Requires the sidecar to match the terminal, owner-validated settings-input run. */
export async function readLaunchAtLoginReport(path, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded) {
  let file;
  try { file = await readJsonFile(path, 16 * 1024); }
  catch { file = { exists: false, value: null, exception: { name: "ReadError", code: null } }; }
  const result = validateLaunchAtLoginReport(file.value, expectedOwner);
  const errors = [...result.errors];
  if (!file.exists) errors.push("report-missing");
  if (nativeOwnerMatches !== true) errors.push("native-owner-mismatch");
  if (nativeCaseSucceeded !== true) errors.push("native-case-not-terminal-success");
  return {
    exists: file.exists === true,
    valid: result.valid && nativeOwnerMatches === true && nativeCaseSucceeded === true && file.exists === true,
    passed: result.passed && nativeOwnerMatches === true && nativeCaseSucceeded === true && file.exists === true,
    cleanupSafe: result.cleanupSafe && nativeOwnerMatches === true && file.exists === true,
    errors: [...new Set(errors)],
    summary: result.summary,
    ownerMatchesNativeReport: nativeOwnerMatches === true,
    nativeCaseSucceeded: nativeCaseSucceeded === true,
    exception: file.exception ?? null,
  };
}
