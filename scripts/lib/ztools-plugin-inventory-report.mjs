export const PLUGIN_INVENTORY_OBSERVATIONS_FILENAME = "native-plugin-inventory-observations.json";

const ROOT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "readiness",
  "disable", "restore", "errors",
]);
const READINESS_KEYS = Object.freeze([
  "waiterObserved", "pendingListReadCount", "pendingNativeCalls", "storeReadyBeforeRelease",
  "registrationCommitted", "firstListReadCount", "storeReadyAfterRelease", "timestampMatchCount",
  "targetAppCount", "pluginCatalogSettled", "startupEventDelivered", "eventInvalidPayloadsAfterStartup",
]);
const MUTATION_KEYS = Object.freeze([
  "mutationCommitted", "eventListenerReadyBefore", "eventListenerReadyAfter", "eventDeliveredBefore",
  "eventDeliveredAfter", "eventInvalidPayloadsBefore", "eventInvalidPayloadsAfter",
  "eventCallbackErrorsBefore", "eventCallbackErrorsAfter", "listReadBefore", "listReadAfter",
  "storeReady", "timestampMatchCount", "targetAppCount", "pluginUiOpened", "preloadStarted",
]);
const READINESS_BOOLEAN_KEYS = Object.freeze([
  "waiterObserved", "storeReadyBeforeRelease", "registrationCommitted", "storeReadyAfterRelease",
  "pluginCatalogSettled",
]);
const READINESS_COUNT_KEYS = Object.freeze([
  "pendingListReadCount", "pendingNativeCalls", "firstListReadCount", "timestampMatchCount",
  "targetAppCount", "startupEventDelivered", "eventInvalidPayloadsAfterStartup",
]);
const MUTATION_BOOLEAN_KEYS = Object.freeze([
  "mutationCommitted", "eventListenerReadyBefore", "eventListenerReadyAfter", "storeReady",
  "pluginUiOpened", "preloadStarted",
]);
const MUTATION_COUNT_KEYS = Object.freeze([
  "eventDeliveredBefore", "eventDeliveredAfter", "eventInvalidPayloadsBefore", "eventInvalidPayloadsAfter",
  "eventCallbackErrorsBefore", "eventCallbackErrorsAfter", "listReadBefore", "listReadAfter",
  "timestampMatchCount", "targetAppCount",
]);
const ERROR_CODES = new Set([
  "settings-input-plugin-inventory-readiness-timeout",
  "settings-input-plugin-inventory-pending-state-invalid",
  "settings-input-plugin-inventory-timestamp-register-failed",
  "settings-input-plugin-inventory-ready-state-invalid",
  "settings-input-plugin-inventory-event-listener-invalid",
  "settings-input-plugin-inventory-disable-mutation-failed",
  "settings-input-plugin-inventory-disable-refresh-invalid",
  "settings-input-plugin-inventory-restore-mutation-failed",
  "settings-input-plugin-inventory-restore-refresh-invalid",
  "settings-input-plugin-inventory-runtime-started",
  "settings-input-plugin-inventory-report-write-failed",
]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function optionalType(value, typeCheck) {
  return value === null || typeCheck(value);
}

function validReadiness(value) {
  return exactKeys(value, READINESS_KEYS)
    && READINESS_BOOLEAN_KEYS.every(key => optionalType(value[key], item => typeof item === "boolean"))
    && READINESS_COUNT_KEYS.every(key => optionalType(value[key], boundedCount));
}

function validMutation(value) {
  return exactKeys(value, MUTATION_KEYS)
    && MUTATION_BOOLEAN_KEYS.every(key => optionalType(value[key], item => typeof item === "boolean"))
    && MUTATION_COUNT_KEYS.every(key => optionalType(value[key], boundedCount));
}

function validNativeErrors(errors) {
  return Array.isArray(errors) && errors.length <= ERROR_CODES.size
    && Object.keys(errors).length === errors.length
    && errors.every(error => typeof error === "string" && ERROR_CODES.has(error))
    && new Set(errors).size === errors.length;
}

function identityMatches(report, owner) {
  const runId = report.runId;
  return report.schemaVersion === 1
    && report.journey === "settings-plugin-inventory"
    && report.scope === "hidden-original-vue-plugin-inventory"
    && typeof runId === "string" && /^[0-9a-f]{32}$/.test(runId)
    && report.identifier === `dev.atools.renderer-settings-input.${runId}`
    && report.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(report.pid) && report.pid > 0
    && owner?.runId === report.runId && owner?.identifier === report.identifier
    && owner?.root === report.root && owner?.pid === report.pid
    && Number.isSafeInteger(owner.pid) && owner.pid > 0;
}

function readinessPassed(value) {
  return value.waiterObserved === true
    && value.pendingListReadCount === 1
    && value.pendingNativeCalls !== null && value.pendingNativeCalls >= 1
    && value.storeReadyBeforeRelease === false
    && value.registrationCommitted === true
    && (value.firstListReadCount === 1 || value.firstListReadCount === 2)
    && value.storeReadyAfterRelease === true
    && value.timestampMatchCount === 1
    && value.targetAppCount === 1
    && value.pluginCatalogSettled === true
    && value.startupEventDelivered === 1
    && value.eventInvalidPayloadsAfterStartup === 0;
}

function mutationPassed(value, expectedTimestampCount) {
  return MUTATION_COUNT_KEYS.every(key => boundedCount(value[key]))
    && value.mutationCommitted === true
    && value.eventListenerReadyBefore === true
    && value.eventListenerReadyAfter === true
    && value.eventDeliveredAfter === value.eventDeliveredBefore + 1
    && value.eventInvalidPayloadsAfter === value.eventInvalidPayloadsBefore
    && value.eventCallbackErrorsAfter === value.eventCallbackErrorsBefore
    && value.listReadAfter === value.listReadBefore + 1
    && value.storeReady === true
    && value.timestampMatchCount === expectedTimestampCount
    && value.targetAppCount === 1
    && value.pluginUiOpened === false
    && value.preloadStarted === false;
}

function phasesAreContinuous(readiness, disable, restore) {
  return disable.listReadBefore === readiness.firstListReadCount
    && disable.eventDeliveredBefore === readiness.startupEventDelivered
    && disable.eventInvalidPayloadsBefore === readiness.eventInvalidPayloadsAfterStartup
    && disable.eventCallbackErrorsBefore === 0
    && restore.listReadBefore === disable.listReadAfter
    && restore.eventDeliveredBefore === disable.eventDeliveredAfter
    && restore.eventInvalidPayloadsBefore === disable.eventInvalidPayloadsAfter
    && restore.eventCallbackErrorsBefore === disable.eventCallbackErrorsAfter;
}

/** Validates the fixed fixture observations and derives pass status from observed state transitions. */
export function validatePluginInventoryReport(report, expectedOwner) {
  const validationErrors = [];
  const factErrors = [];
  if (!exactKeys(report, ROOT_KEYS)) {
    return {
      valid: false,
      passed: false,
      errors: ["plugin-inventory-report-shape"],
      summary: { readiness: null, disable: null, restore: null, nativeErrors: [] },
    };
  }

  if (!identityMatches(report, expectedOwner)) validationErrors.push("plugin-inventory-owner");
  const phasesValid = validReadiness(report.readiness) && validMutation(report.disable)
    && validMutation(report.restore);
  if (!phasesValid) validationErrors.push("plugin-inventory-observation-shape");
  const nativeErrorsValid = validNativeErrors(report.errors);
  if (!nativeErrorsValid) validationErrors.push("plugin-inventory-native-errors");

  if (phasesValid) {
    if (!readinessPassed(report.readiness)) factErrors.push("plugin-inventory-readiness-incomplete");
    if (!mutationPassed(report.disable, 0)) factErrors.push("plugin-inventory-disable-transition-invalid");
    if (!mutationPassed(report.restore, 1)) factErrors.push("plugin-inventory-restore-transition-invalid");
    if (!phasesAreContinuous(report.readiness, report.disable, report.restore)) {
      factErrors.push("plugin-inventory-phase-counters-discontinuous");
    }
  }
  const nativeErrors = nativeErrorsValid ? [...report.errors] : [];
  if (nativeErrors.length > 0) factErrors.push("plugin-inventory-native-reported-errors");

  const errors = [...new Set([...validationErrors, ...factErrors])];
  const valid = validationErrors.length === 0;
  return {
    valid,
    passed: valid && factErrors.length === 0,
    errors,
    summary: {
      readiness: validReadiness(report.readiness) ? { ...report.readiness } : null,
      disable: validMutation(report.disable) ? { ...report.disable } : null,
      restore: validMutation(report.restore) ? { ...report.restore } : null,
      nativeErrors,
    },
  };
}
