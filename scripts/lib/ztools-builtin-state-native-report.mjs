export const BUILTIN_STATE_SEED_REPORT_FILENAME = "native-builtin-state-seed-report.json";
export const BUILTIN_STATE_MAIN_REPORT_FILENAME = "native-builtin-state-report.json";

const SEED_ROOT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "observations", "errors",
]);
const MAIN_ROOT_KEYS = Object.freeze([
  ...SEED_ROOT_KEYS.filter(key => key !== "observations" && key !== "errors"),
  "seedPid", "observations", "errors",
]);
const SEED_OBSERVATION_KEYS = Object.freeze([
  "stagedPackageValid", "metadataRegistered", "pluginIdResolved", "disableCommitted", "enabledAfterDisable",
  "documentWritten", "attachmentWritten", "databaseDevice", "databaseInode", "createdAtFingerprint",
  "traySettingStored", "trayConfiguredVisible",
]);
const MAIN_OBSERVATION_KEYS = Object.freeze([
  "resumeClaimed", "pendingWaiterObserved", "pendingListReadCount", "pendingNativeCalls", "storeReadyBeforeRelease",
  "metadataRegistered", "enabledAfterMetadataRefresh", "documentPreserved", "attachmentPreserved", "startupStoreReady",
  "startupTimestampMatchCount", "startupTargetAppCount", "startupEventDeliveredBefore", "startupEventDeliveredAfter",
  "startupListReadBefore", "startupListReadAfter", "restoreCommitted", "enabledAfterRestore", "finalTimestampMatchCount",
  "finalTargetAppCount", "restoreEventDeliveredBefore", "restoreEventDeliveredAfter", "restoreListReadBefore",
  "restoreListReadAfter", "pluginUiOpened", "preloadStarted", "databaseDevice", "databaseInode", "createdAtFingerprint",
  "trayConfiguredVisible", "trayNativeVisible",
]);
const SEED_BOOLEAN_KEYS = Object.freeze([
  "stagedPackageValid", "metadataRegistered", "pluginIdResolved", "disableCommitted", "enabledAfterDisable",
  "documentWritten", "attachmentWritten", "traySettingStored", "trayConfiguredVisible",
]);
const MAIN_BOOLEAN_KEYS = Object.freeze([
  "resumeClaimed", "pendingWaiterObserved", "storeReadyBeforeRelease", "metadataRegistered",
  "enabledAfterMetadataRefresh", "documentPreserved", "attachmentPreserved", "startupStoreReady", "restoreCommitted",
  "enabledAfterRestore", "pluginUiOpened", "preloadStarted", "trayConfiguredVisible", "trayNativeVisible",
]);
const MAIN_COUNT_KEYS = Object.freeze([
  "pendingListReadCount", "pendingNativeCalls", "startupTimestampMatchCount", "startupTargetAppCount",
  "startupEventDeliveredBefore", "startupEventDeliveredAfter", "startupListReadBefore", "startupListReadAfter",
  "finalTimestampMatchCount", "finalTargetAppCount", "restoreEventDeliveredBefore", "restoreEventDeliveredAfter",
  "restoreListReadBefore", "restoreListReadAfter",
]);
const ERROR_CODES = new Set([
  "builtin-state-seed-package-invalid",
  "builtin-state-seed-metadata-register-failed",
  "builtin-state-seed-disabled-write-failed",
  "builtin-state-seed-state-invalid",
  "builtin-state-seed-document-write-failed",
  "builtin-state-seed-attachment-write-failed",
  "builtin-state-seed-database-identity-invalid",
  "builtin-state-seed-report-write-failed",
  "builtin-state-resume-owner-invalid",
  "builtin-state-pending-timeout",
  "builtin-state-pending-state-invalid",
  "builtin-state-metadata-register-failed",
  "builtin-state-disabled-state-not-preserved",
  "builtin-state-document-not-preserved",
  "builtin-state-attachment-not-preserved",
  "builtin-state-startup-refresh-invalid",
  "builtin-state-restore-mutation-failed",
  "builtin-state-restore-refresh-invalid",
  "builtin-state-runtime-started",
  "builtin-state-database-identity-invalid",
  "builtin-state-report-write-failed",
]);
const U64_MAX = 18_446_744_073_709_551_615n;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function optionalBoolean(value) {
  return value === null || typeof value === "boolean";
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function optionalCount(value) {
  return value === null || boundedCount(value);
}

function optionalDatabaseIdentity(value) {
  if (value === null) return true;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value)) return false;
  try { return BigInt(value) <= U64_MAX; }
  catch { return false; }
}

function optionalFingerprint(value) {
  return value === null || typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function validErrors(value) {
  return Array.isArray(value) && value.length <= ERROR_CODES.size
    && Object.keys(value).length === value.length
    && value.every(code => typeof code === "string" && ERROR_CODES.has(code))
    && new Set(value).size === value.length;
}

function validSeedObservations(value) {
  return exactKeys(value, SEED_OBSERVATION_KEYS)
    && SEED_BOOLEAN_KEYS.every(key => optionalBoolean(value[key]))
    && optionalDatabaseIdentity(value.databaseDevice)
    && optionalDatabaseIdentity(value.databaseInode)
    && optionalFingerprint(value.createdAtFingerprint);
}

function validMainObservations(value) {
  return exactKeys(value, MAIN_OBSERVATION_KEYS)
    && MAIN_BOOLEAN_KEYS.every(key => optionalBoolean(value[key]))
    && MAIN_COUNT_KEYS.every(key => optionalCount(value[key]))
    && optionalDatabaseIdentity(value.databaseDevice)
    && optionalDatabaseIdentity(value.databaseInode)
    && optionalFingerprint(value.createdAtFingerprint);
}

function validExpectedOwner(owner) {
  return isRecord(owner) && typeof owner.runId === "string" && /^[0-9a-f]{32}$/.test(owner.runId)
    && owner.identifier === `dev.atools.renderer-settings-input.${owner.runId}`
    && owner.root === `/private/tmp/atools-renderer-settings-input-${owner.runId}`;
}

function validSeedIdentity(report, owner) {
  return isRecord(report) && report.schemaVersion === 2 && report.journey === "builtin-state-seed"
    && report.scope === "settings-input-timestamp-disabled-seed"
    && report.runId === owner.runId && report.identifier === owner.identifier && report.root === owner.root
    && Number.isSafeInteger(report.pid) && report.pid > 0;
}

function validMainIdentity(report, owner) {
  return isRecord(report) && report.schemaVersion === 2 && report.journey === "builtin-state"
    && report.scope === "settings-input-original-vue-cold-start"
    && report.runId === owner.runId && report.identifier === owner.identifier && report.root === owner.root
    && Number.isSafeInteger(report.pid) && report.pid > 0
    && Number.isSafeInteger(report.seedPid) && report.seedPid > 0;
}

function terminalSuccess(process, expectedPid = null) {
  return isRecord(process) && process.spawned === true && Number.isSafeInteger(process.pid) && process.pid > 0
    && (expectedPid === null || process.pid === expectedPid)
    && process.terminalObserved === true && process.exitCode === 0 && process.signal === null
    && process.timedOut === false;
}

function seedFactsPassed(value) {
  return value.stagedPackageValid === true && value.metadataRegistered === true && value.pluginIdResolved === true
    && value.disableCommitted === true && value.enabledAfterDisable === false
    && value.documentWritten === true && value.attachmentWritten === true
    && optionalDatabaseIdentity(value.databaseDevice) && value.databaseDevice !== null
    && optionalDatabaseIdentity(value.databaseInode) && value.databaseInode !== null
    && optionalFingerprint(value.createdAtFingerprint) && value.createdAtFingerprint !== null
    && value.traySettingStored === true && value.trayConfiguredVisible === false;
}

function mainFactsPassed(value) {
  return MAIN_COUNT_KEYS.every(key => boundedCount(value[key]))
    && value.resumeClaimed === true && value.pendingWaiterObserved === true
    && value.pendingListReadCount === 1 && boundedCount(value.pendingNativeCalls) && value.pendingNativeCalls >= 1
    && value.storeReadyBeforeRelease === false && value.metadataRegistered === true
    && value.enabledAfterMetadataRefresh === false && value.documentPreserved === true
    && value.attachmentPreserved === true && value.startupStoreReady === true
    && value.startupTimestampMatchCount === 0 && value.startupTargetAppCount === 1
    && value.startupEventDeliveredAfter === value.startupEventDeliveredBefore + 1
    && value.startupListReadBefore === 1
    && (value.startupListReadAfter === 1 || value.startupListReadAfter === 2)
    && value.restoreCommitted === true && value.enabledAfterRestore === true
    && value.finalTimestampMatchCount === 1 && value.finalTargetAppCount === 1
    && value.restoreEventDeliveredBefore === value.startupEventDeliveredAfter
    && value.restoreEventDeliveredAfter === value.restoreEventDeliveredBefore + 1
    && value.restoreListReadBefore === value.startupListReadAfter
    && value.restoreListReadAfter === value.restoreListReadBefore + 1
    && value.pluginUiOpened === false && value.preloadStarted === false
    && value.trayConfiguredVisible === false && value.trayNativeVisible === false
    && optionalDatabaseIdentity(value.databaseDevice) && value.databaseDevice !== null
    && optionalDatabaseIdentity(value.databaseInode) && value.databaseInode !== null
    && optionalFingerprint(value.createdAtFingerprint) && value.createdAtFingerprint !== null;
}

/** Validates the seed receipt before the caller is allowed to start cold Main. */
export function validateBuiltinStateSeedReport(report, process, expectedOwner) {
  const errors = [];
  if (!validExpectedOwner(expectedOwner)) errors.push("builtin-state-expected-owner-invalid");
  if (!exactKeys(report, SEED_ROOT_KEYS)) errors.push("builtin-state-seed-report-shape");
  const shapeValid = exactKeys(report, SEED_ROOT_KEYS) && validSeedObservations(report.observations)
    && validErrors(report.errors);
  if (exactKeys(report, SEED_ROOT_KEYS) && !validSeedObservations(report.observations)) {
    errors.push("builtin-state-seed-observation-shape");
  }
  if (exactKeys(report, SEED_ROOT_KEYS) && !validErrors(report.errors)) errors.push("builtin-state-seed-errors-shape");
  const identityValid = validExpectedOwner(expectedOwner) && validSeedIdentity(report, expectedOwner)
    && terminalSuccess(process, report?.pid);
  if (!identityValid) errors.push("builtin-state-seed-identity-or-process-invalid");
  const factsPassed = shapeValid && validSeedObservations(report.observations) && seedFactsPassed(report.observations)
    && Array.isArray(report.errors) && report.errors.length === 0;
  if (shapeValid && !factsPassed) errors.push("builtin-state-seed-facts-incomplete");
  return {
    valid: shapeValid && identityValid,
    passed: shapeValid && identityValid && factsPassed,
    errors: [...new Set(errors)],
    summary: {
      pid: Number.isSafeInteger(report?.pid) ? report.pid : null,
      databaseDevice: validSeedObservations(report?.observations) ? report.observations.databaseDevice : null,
      databaseInode: validSeedObservations(report?.observations) ? report.observations.databaseInode : null,
      createdAtFingerprint: validSeedObservations(report?.observations) ? report.observations.createdAtFingerprint : null,
      nativeErrors: validErrors(report?.errors) ? [...report.errors] : [],
    },
  };
}

/** Derives cold-restart success from two owner-bound reports and terminal process receipts. */
export function validateBuiltinStateNativeReports({
  seedReport, mainReport, seedProcess, mainProcess, expectedOwner,
}) {
  const seed = validateBuiltinStateSeedReport(seedReport, seedProcess, expectedOwner);
  const errors = [...seed.errors];
  if (!exactKeys(mainReport, MAIN_ROOT_KEYS)) errors.push("builtin-state-main-report-shape");
  const mainShapeValid = exactKeys(mainReport, MAIN_ROOT_KEYS) && validMainObservations(mainReport.observations)
    && validErrors(mainReport.errors);
  if (exactKeys(mainReport, MAIN_ROOT_KEYS) && !validMainObservations(mainReport.observations)) {
    errors.push("builtin-state-main-observation-shape");
  }
  if (exactKeys(mainReport, MAIN_ROOT_KEYS) && !validErrors(mainReport.errors)) errors.push("builtin-state-main-errors-shape");
  const mainIdentityValid = validExpectedOwner(expectedOwner) && validMainIdentity(mainReport, expectedOwner)
    && terminalSuccess(mainProcess, mainReport?.pid);
  if (!mainIdentityValid) errors.push("builtin-state-main-identity-or-process-invalid");

  const observations = mainReport?.observations;
  const continuityValid = seed.valid && mainShapeValid && mainIdentityValid
    && seedProcess.pid !== mainProcess.pid && mainReport.seedPid === seedProcess.pid
    && observations.databaseDevice === seed.summary.databaseDevice
    && observations.databaseInode === seed.summary.databaseInode
    && observations.createdAtFingerprint === seed.summary.createdAtFingerprint;
  if (!continuityValid) errors.push("builtin-state-cold-restart-continuity-invalid");

  const factsPassed = continuityValid && seed.passed && mainFactsPassed(observations)
    && Array.isArray(mainReport.errors) && mainReport.errors.length === 0;
  if (mainShapeValid && !mainFactsPassed(observations)) errors.push("builtin-state-main-facts-incomplete");
  if (mainShapeValid && mainReport.errors.length > 0) errors.push("builtin-state-native-errors-reported");
  const uniqueErrors = [...new Set(errors)];
  return {
    valid: seed.valid && mainShapeValid && mainIdentityValid,
    passed: factsPassed && uniqueErrors.length === 0,
    errors: uniqueErrors,
    summary: {
      seed: seed.summary,
      main: {
        pid: Number.isSafeInteger(mainReport?.pid) ? mainReport.pid : null,
        seedPid: Number.isSafeInteger(mainReport?.seedPid) ? mainReport.seedPid : null,
        databaseDevice: validMainObservations(observations) ? observations.databaseDevice : null,
        databaseInode: validMainObservations(observations) ? observations.databaseInode : null,
        createdAtFingerprint: validMainObservations(observations) ? observations.createdAtFingerprint : null,
        startupTimestampMatchCount: boundedCount(observations?.startupTimestampMatchCount)
          ? observations.startupTimestampMatchCount : null,
        startupTargetAppCount: boundedCount(observations?.startupTargetAppCount)
          ? observations.startupTargetAppCount : null,
        finalTimestampMatchCount: boundedCount(observations?.finalTimestampMatchCount)
          ? observations.finalTimestampMatchCount : null,
        finalTargetAppCount: boundedCount(observations?.finalTargetAppCount)
          ? observations.finalTargetAppCount : null,
        nativeErrors: validErrors(mainReport?.errors) ? [...mainReport.errors] : [],
      },
    },
  };
}
