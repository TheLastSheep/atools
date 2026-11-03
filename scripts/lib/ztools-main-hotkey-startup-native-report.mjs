export const MAIN_HOTKEY_RECOVERY_FIRST_REPORT = "native-main-hotkey-recovery-first-report.json";
export const MAIN_HOTKEY_RECOVERY_SECOND_REPORT = "native-main-hotkey-recovery-second-report.json";

const FIRST_ROOT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "observations", "errors",
]);
const SECOND_ROOT_KEYS = Object.freeze([
  ...FIRST_ROOT_KEYS.slice(0, -2), "previousPid", "observations", "errors",
]);
const FIRST_OBSERVATIONS = Object.freeze([
  "startupNeedsRecovery", "startupAttempted", "ownedHotkeyUnregistered", "generalOpened", "hotkeyControlEmpty",
  "placeholderEditDispatched", "placeholderStored", "invalidHotkeyPreserved", "repairChordDispatched",
  "repairStored", "repairOwnedState", "repairManagerRegistered", "childClosed", "hotkeyOwnedBeforeExit",
  "pluginUiOpened", "preloadStarted", "databaseDevice", "databaseInode",
]);
const SECOND_OBSERVATIONS = Object.freeze([
  "resumeClaimed", "startupRegistered", "startupOwnedStateB", "startupManagerRegistered", "generalOpened",
  "generalReadBackB", "releaseAttempted", "releaseConfirmed", "childClosed", "pluginUiOpened", "preloadStarted",
  "databaseDevice", "databaseInode",
]);
const FIRST_EXPECTED = Object.freeze({
  startupNeedsRecovery: true, startupAttempted: true, ownedHotkeyUnregistered: true, generalOpened: true,
  hotkeyControlEmpty: true, placeholderEditDispatched: true, placeholderStored: true, invalidHotkeyPreserved: true,
  repairChordDispatched: true, repairStored: true, repairOwnedState: true, repairManagerRegistered: true,
  childClosed: true, hotkeyOwnedBeforeExit: true, pluginUiOpened: false, preloadStarted: false,
});
const SECOND_EXPECTED = Object.freeze({
  resumeClaimed: true, startupRegistered: true, startupOwnedStateB: true, startupManagerRegistered: true,
  generalOpened: true, generalReadBackB: true, releaseAttempted: true, releaseConfirmed: true,
  childClosed: true, pluginUiOpened: false, preloadStarted: false,
});
const ERRORS = new Set([
  "settings-main-hotkey-recovery-owner-invalid", "settings-main-hotkey-recovery-startup-invalid",
  "settings-main-hotkey-recovery-general-open-failed", "settings-main-hotkey-recovery-ui-invalid",
  "settings-main-hotkey-recovery-placeholder-failed", "settings-main-hotkey-recovery-invalid-preserved-failed",
  "settings-main-hotkey-recovery-record-failed", "settings-main-hotkey-recovery-state-invalid",
  "settings-main-hotkey-recovery-close-failed", "settings-main-hotkey-recovery-release-failed",
  "settings-main-hotkey-recovery-runtime-started", "settings-main-hotkey-recovery-report-write-failed",
]);
const U64_MAX = 18_446_744_073_709_551_615n;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function validRunId(value) {
  return typeof value === "string" && /^[0-9a-f]{32}$/.test(value);
}

function validDatabaseIdentity(value) {
  if (value === null || typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try { return BigInt(value) <= U64_MAX; } catch { return false; }
}

function validErrors(value) {
  return Array.isArray(value) && value.length <= ERRORS.size && new Set(value).size === value.length
    && value.every(error => typeof error === "string" && ERRORS.has(error));
}

function validateStage(report, process, owner, stage) {
  const first = stage === "first";
  const rootKeys = first ? FIRST_ROOT_KEYS : SECOND_ROOT_KEYS;
  const observations = first ? FIRST_OBSERVATIONS : SECOND_OBSERVATIONS;
  const expected = first ? FIRST_EXPECTED : SECOND_EXPECTED;
  const journey = first ? "main-hotkey-startup-recovery-first" : "main-hotkey-startup-recovery-second";
  const scope = first ? "invalid-hotkey-first-process" : "same-db-cold-start";
  const errors = [];
  const processOk = process?.spawned === true && process.terminalObserved === true
    && Number.isSafeInteger(process.pid) && process.pid > 0 && process.exitCode === 0
    && process.signal === null && process.timedOut === false
    && process.termination?.attempted === false
    && Array.isArray(process.termination.signals) && process.termination.signals.length === 0;
  if (!processOk) errors.push(`${stage}-process-not-successfully-terminal`);
  if (!exactKeys(report, rootKeys)) return { valid: false, passed: false, errors: [...errors, `${stage}-report-shape-invalid`] };
  if (report.schemaVersion !== 1 || report.journey !== journey || report.scope !== scope
      || report.identifier !== owner?.identifier || report.root !== owner?.root || report.runId !== owner?.runId
      || report.pid !== process?.pid || !validRunId(report.runId)
      || report.identifier !== `dev.atools.renderer-settings-input.${report.runId}`
      || report.root !== `/private/tmp/atools-renderer-settings-input-${report.runId}`) {
    errors.push(`${stage}-owner-invalid`);
  }
  if (!first && (!Number.isSafeInteger(report.previousPid) || report.previousPid <= 0)) {
    errors.push("second-previous-pid-invalid");
  }
  const value = report.observations;
  if (!exactKeys(value, observations)) {
    errors.push(`${stage}-observations-shape-invalid`);
  } else {
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) errors.push(`${stage}-${key}-invalid`);
    }
    for (const key of ["databaseDevice", "databaseInode"]) {
      if (!validDatabaseIdentity(value[key])) errors.push(`${stage}-${key}-invalid`);
    }
  }
  if (!validErrors(report.errors) || report.errors.length > 0) errors.push(`${stage}-native-errors-present-or-invalid`);
  return { valid: errors.length === 0, passed: errors.length === 0, errors };
}

export function validateMainHotkeyRecoveryFirst(report, process, expectedOwner) {
  return validateStage(report, process, expectedOwner, "first");
}

export function validateMainHotkeyRecoverySecond(report, process, expectedOwner) {
  return validateStage(report, process, expectedOwner, "second");
}

export function validateMainHotkeyRecoveryPair({
  firstReport, secondReport, firstProcess, secondProcess, expectedOwner,
}) {
  const first = validateMainHotkeyRecoveryFirst(firstReport, firstProcess, expectedOwner);
  const second = validateMainHotkeyRecoverySecond(secondReport, secondProcess, expectedOwner);
  const errors = [...first.errors, ...second.errors];
  if (firstProcess?.pid === secondProcess?.pid) errors.push("process-pids-not-distinct");
  if (secondReport?.previousPid !== firstProcess?.pid) errors.push("resume-owner-pid-mismatch");
  const firstFacts = firstReport?.observations;
  const secondFacts = secondReport?.observations;
  if (firstFacts?.databaseDevice !== secondFacts?.databaseDevice
      || firstFacts?.databaseInode !== secondFacts?.databaseInode) errors.push("database-identity-changed");
  return { valid: errors.length === 0, passed: errors.length === 0, errors, first, second };
}
