export const DISABLED_COMMAND_CHECKS = Object.freeze([
  "baselineEnabled", "disableMenuDispatched", "disabledStored", "childDisabledReadBack",
  "mainExcluded", "enableMenuDispatched", "enabledStored", "childEnabledReadBack",
  "mainRestored", "unrelatedSettingsUnchanged",
]);

const ROOT_KEYS = ["schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId",
  "passed", "errors", "checks"];
const ERROR_CODES = new Set([
  "baseline-invalid", "disable-failed", "disable-not-stored", "main-not-excluded",
  "enable-failed", "enable-not-stored", "main-not-restored", "unrelated-settings-changed",
  "probe-failed", "restore-failed", "report-write-failed",
].map(code => `settings-command-availability-${code}`));

function exactRecord(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validateDisabledCommandsReport(value, owner) {
  const errors = [];
  const check = (condition, code) => { if (!condition) errors.push(code); };
  const empty = { checks: null, nativeErrors: [] };
  if (!exactRecord(value, ROOT_KEYS)) {
    return { valid: false, passed: false, errors: ["disabled-commands-report-shape"], summary: empty };
  }
  check(value.schemaVersion === 1 && value.journey === "settings-command-availability"
    && value.scope === "hidden-original-vue-command-availability", "disabled-commands-report-schema");
  check(typeof owner?.runId === "string" && /^[a-f0-9]{32}$/.test(owner.runId)
    && value.runId === owner.runId, "disabled-commands-report-run-owner");
  check(typeof owner?.identifier === "string" && value.identifier === owner.identifier,
    "disabled-commands-report-identifier-owner");
  check(typeof owner?.root === "string" && owner.root.length > 0 && value.root === owner.root,
    "disabled-commands-report-root-owner");
  check(Number.isSafeInteger(owner?.pid) && owner.pid > 0 && value.pid === owner.pid,
    "disabled-commands-report-process-owner");
  const checksValid = exactRecord(value.checks, DISABLED_COMMAND_CHECKS)
    && DISABLED_COMMAND_CHECKS.every(key => typeof value.checks[key] === "boolean");
  check(checksValid, "disabled-commands-report-checks");
  const nativeErrorsValid = Array.isArray(value.errors) && value.errors.length <= 16
    && new Set(value.errors).size === value.errors.length
    && value.errors.every(error => ERROR_CODES.has(error));
  check(nativeErrorsValid, "disabled-commands-report-errors");
  const completed = checksValid && nativeErrorsValid && value.errors.length === 0
    && DISABLED_COMMAND_CHECKS.every(key => value.checks[key] === true);
  check(typeof value.passed === "boolean" && value.passed === completed,
    "disabled-commands-report-passed-consistency");
  return {
    valid: errors.length === 0,
    passed: errors.length === 0 && completed,
    errors,
    summary: {
      checks: checksValid ? { ...value.checks } : null,
      nativeErrors: nativeErrorsValid ? [...value.errors] : [],
    },
  };
}
