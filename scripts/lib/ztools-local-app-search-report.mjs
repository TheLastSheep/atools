export const LOCAL_APP_SEARCH_CHECKS = Object.freeze([
  "initialUiEnabled", "initialDatabaseEnabled", "disableUiClick", "disabledDatabaseStored",
  "mainAppExcluded", "mainNonAppPreservedDisabled", "reopenedChildFresh", "reopenedUiPersistedDisabled",
  "reopenedDatabasePersistedDisabled", "enableUiClick", "enabledDatabaseStored", "mainAppRestored",
  "mainNonAppPreservedEnabled", "nativeCatalogUnchanged", "finalUiEnabled", "childClosed",
  "targetCanonicalPathResolved",
]);
export const LOCAL_APP_SEARCH_REPORT_FILENAME = "native-local-app-search-report.json";

const ERROR_PREFIX = "settings-input-local-app-search-";
const ERROR_SUFFIXES = Object.freeze([
  "baseline-invalid", "checkbox-toggle-failed", "disabled-not-stored", "main-app-not-excluded",
  "non-app-control-missing", "child-close-failed", "reopen-failed", "persistence-readback-invalid",
  "enabled-not-stored", "main-app-not-restored", "native-catalog-changed", "path-resolve-invalid",
  "cleanup-failed", "probe-failed", "report-write-failed",
]);
export const LOCAL_APP_SEARCH_ERRORS = Object.freeze(ERROR_SUFFIXES.map(suffix => `${ERROR_PREFIX}${suffix}`));

const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "passed", "errors", "checks",
]);
const IDENTITY = Object.freeze({
  schemaVersion: 1,
  journey: "settings-local-app-search",
  scope: "hidden-original-vue-local-app-search",
});
const NATIVE_ERROR_SET = new Set(LOCAL_APP_SEARCH_ERRORS);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value) && Object.keys(value).length === expected.length
    && expected.every(key => Object.hasOwn(value, key));
}

function invalidResult(errors) {
  return {
    valid: false,
    passed: false,
    errors,
    summary: { checks: null, nativeErrors: [] },
  };
}

/** Validates bounded Native observations and derives success from facts, never the Native pass bit. */
export function validateLocalAppSearchReport(report, expectedOwner) {
  if (!exactKeys(report, REPORT_KEYS)) return invalidResult(["report-shape"]);

  const errors = [];
  const identityValid = report.schemaVersion === IDENTITY.schemaVersion
    && report.journey === IDENTITY.journey && report.scope === IDENTITY.scope
    && typeof report.runId === "string" && /^[0-9a-f]{32}$/.test(report.runId)
    && report.identifier === `dev.atools.renderer-settings-input.${report.runId}`
    && typeof report.root === "string" && report.root === `/private/tmp/atools-renderer-settings-input-${report.runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0;
  if (!identityValid) errors.push("report-identity");

  const owner = isRecord(expectedOwner) ? expectedOwner : {};
  const ownerMatches = identityValid && report.runId === owner.runId && report.identifier === owner.identifier
    && report.root === owner.root && report.pid === owner.pid
    && Number.isSafeInteger(owner.pid) && owner.pid > 0;
  if (!ownerMatches) errors.push("report-owner-mismatch");

  const checksShape = exactKeys(report.checks, LOCAL_APP_SEARCH_CHECKS);
  if (!checksShape) errors.push("report-checks-shape");
  const checksValid = checksShape && LOCAL_APP_SEARCH_CHECKS.every(key => typeof report.checks[key] === "boolean");
  if (checksShape && !checksValid) errors.push("report-checks-type");

  const nativeErrorsValid = Array.isArray(report.errors) && report.errors.length <= 16
    && Object.keys(report.errors).length === report.errors.length
    && report.errors.every(error => typeof error === "string" && NATIVE_ERROR_SET.has(error))
    && new Set(report.errors).size === report.errors.length;
  if (!nativeErrorsValid) errors.push("report-errors-invalid");
  if (typeof report.passed !== "boolean") errors.push("report-passed-type");

  const derivedPass = nativeErrorsValid && report.errors.length === 0 && checksValid
    && LOCAL_APP_SEARCH_CHECKS.every(key => report.checks[key] === true);
  if (typeof report.passed === "boolean" && report.passed !== derivedPass) {
    errors.push("report-pass-mismatch");
  }

  const uniqueErrors = [...new Set(errors)];
  const valid = uniqueErrors.length === 0;
  return {
    valid,
    passed: valid && ownerMatches && derivedPass,
    errors: uniqueErrors,
    summary: {
      checks: checksValid ? Object.fromEntries(LOCAL_APP_SEARCH_CHECKS.map(key => [key, report.checks[key]])) : null,
      nativeErrors: nativeErrorsValid ? [...report.errors] : [],
    },
  };
}
