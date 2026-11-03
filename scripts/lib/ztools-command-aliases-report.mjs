import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const COMMAND_ALIASES_REPORT_FILENAME = "native-command-aliases-report.json";
export const COMMAND_ALIASES_ERRORS = Object.freeze([
  "settings-command-aliases-baseline-invalid", "settings-command-aliases-open-failed",
  "settings-command-aliases-add-failed", "settings-command-aliases-edit-failed",
  "settings-command-aliases-reopen-failed", "settings-command-aliases-delete-failed",
  "settings-command-aliases-main-search-invalid", "settings-command-aliases-state-invalid",
  "settings-command-aliases-unrelated-changed", "settings-command-aliases-counter-invalid",
  "settings-command-aliases-report-write-failed",
]);

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "observations", "errors",
]);
const OBSERVATION_KEYS = Object.freeze([
  "initialStateValid", "addMenuDispatched", "addDialogOpened", "addSaveDispatched", "addStored", "addMainMatched",
  "editSaveDispatched", "editStored", "editMainUpdated", "closedAfterEdit", "freshSessionOnReopen", "reopenReadBack",
  "deleteDialogOpened", "deleteConfirmed", "deleteStored", "deleteMainExcluded", "unrelatedPreserved",
  "noAppCatalogReload", "pluginUiOpened", "preloadStarted", "aliasEventsBefore", "aliasEventsAfterAdd",
  "aliasEventsAfterEdit", "aliasEventsAfterDelete", "appListReadsBefore", "appListReadsAfter", "addMatchCount",
  "editOldMatchCount", "editNewMatchCount", "deleteMatchCount",
]);
const BOOLEAN_KEYS = Object.freeze(OBSERVATION_KEYS.slice(0, 20));
const COUNT_KEYS = Object.freeze(OBSERVATION_KEYS.slice(20));
const SUCCESS_TRUE = Object.freeze(BOOLEAN_KEYS.slice(0, 18));
const ERROR_SET = new Set(COMMAND_ALIASES_ERRORS);
const IDENTITY = Object.freeze({ schemaVersion: 1, journey: "settings-command-aliases", scope: "hidden-original-vue-command-aliases" });

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function identityMatches(report, expectedOwner) {
  const runId = report.runId;
  return report.schemaVersion === IDENTITY.schemaVersion && report.journey === IDENTITY.journey
    && report.scope === IDENTITY.scope && typeof runId === "string" && /^[0-9a-f]{32}$/.test(runId)
    && report.identifier === `dev.atools.renderer-settings-input.${runId}`
    && report.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0
    && expectedOwner?.runId === report.runId && expectedOwner?.identifier === report.identifier
    && expectedOwner?.root === report.root && expectedOwner?.pid === report.pid
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

function validErrors(errors) {
  return Array.isArray(errors) && errors.length <= ERROR_SET.size && Object.keys(errors).length === errors.length
    && errors.every(error => typeof error === "string" && ERROR_SET.has(error))
    && new Set(errors).size === errors.length;
}

function validObservations(value) {
  return exactKeys(value, OBSERVATION_KEYS)
    && BOOLEAN_KEYS.every(key => value[key] === null || typeof value[key] === "boolean")
    && COUNT_KEYS.every(key => value[key] === null || boundedCount(value[key]));
}

function observationsPassed(value) {
  return COUNT_KEYS.every(key => boundedCount(value[key]))
    && SUCCESS_TRUE.every(key => value[key] === true)
    && value.pluginUiOpened === false && value.preloadStarted === false
    && value.aliasEventsAfterAdd === value.aliasEventsBefore + 1
    && value.aliasEventsAfterEdit === value.aliasEventsAfterAdd + 1
    && value.aliasEventsAfterDelete === value.aliasEventsAfterEdit + 1
    && value.appListReadsAfter === value.appListReadsBefore
    && value.addMatchCount === 1 && value.editOldMatchCount === 0
    && value.editNewMatchCount === 1 && value.deleteMatchCount === 0;
}

/** Recomputes success only from the exact owner-bound facts; Native success flags are not part of the schema. */
export function validateCommandAliasesReport(report, expectedOwner) {
  if (!exactKeys(report, REPORT_KEYS)) {
    return { valid: false, passed: false, errors: ["report-shape"], summary: { observations: null, nativeErrors: [] } };
  }

  const errors = [];
  const ownerValid = identityMatches(report, expectedOwner);
  if (!ownerValid) errors.push("report-owner");
  const observationsValid = validObservations(report.observations);
  if (!observationsValid) errors.push("observation-shape");
  const errorsValid = validErrors(report.errors);
  if (!errorsValid) errors.push("native-errors-shape");
  if (observationsValid && !observationsPassed(report.observations)) errors.push("observations-incomplete");
  const nativeErrors = errorsValid ? [...report.errors] : [];
  if (nativeErrors.length > 0) errors.push("native-reported-errors");
  const uniqueErrors = [...new Set(errors)];
  const valid = ownerValid && observationsValid && errorsValid;
  return {
    valid,
    passed: valid && errorsValid && nativeErrors.length === 0 && observationsValid && observationsPassed(report.observations),
    errors: uniqueErrors,
    summary: { observations: observationsValid ? { ...report.observations } : null, nativeErrors },
  };
}

/** Loads the fixed-size sidecar and binds it to the terminal, cleaned Native case before allowing pass. */
export async function readCommandAliasesReport(path, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded) {
  let file;
  try { file = await readJsonFile(path, 16 * 1024); }
  catch { file = { exists: false, value: null, exception: { name: "ReadError", code: null } }; }
  const result = validateCommandAliasesReport(file.value, expectedOwner);
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
