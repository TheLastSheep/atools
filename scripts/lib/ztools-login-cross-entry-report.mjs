import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const LOGIN_CROSS_ENTRY_REPORT_FILENAME = "native-login-cross-entry-report.json";

const REPORT_KEYS = ["schemaVersion", "kind", "identifier", "root", "pid", "runId", "database", "stages", "counters", "cleanup", "errors", "passed"];
const DATABASE_KEYS = ["beforeSha256", "afterSha256", "originalLaunchAtLogin"];
const STAGE_NAMES = ["initial", "fallbackInitial", "fallbackDisabled", "vueAfterDisabled", "vueReenabled", "fallbackFresh", "ordinarySave", "conflict", "reread", "final"];
const STAGE_KEYS = ["surface", "ready", "controlUnique", "enabled", "disabled", "indeterminate", "overviewUnknown", "hasConflictMessage", "saveState", "routeGeneral", "getterEnabled", "actionDispatched", "actionSucceeded", "nativeEnabled", "databaseEnabled", "unknownMarkerPreserved"];
const COUNTER_KEYS = ["readLaunchAtLogin", "changeLaunchAtLogin", "saveGeneralSettings"];
const CLEANUP_KEYS = ["fallbackWindowCount", "coordinatorTerminal", "databaseRestored", "pendingProbes"];
const ERROR_CODES = new Set([
  "settings-login-cross-entry-baseline-invalid",
  "settings-login-cross-entry-seed-failed",
  "settings-login-cross-entry-child-close-failed",
  "settings-login-cross-entry-fallback-open-failed",
  "settings-login-cross-entry-fallback-probe-invalid",
  "settings-login-cross-entry-fallback-disable-failed",
  "settings-login-cross-entry-vue-readback-invalid",
  "settings-login-cross-entry-vue-enable-failed",
  "settings-login-cross-entry-fallback-save-failed",
  "settings-login-cross-entry-conflict-invalid",
  "settings-login-cross-entry-reread-invalid",
  "settings-login-cross-entry-restore-failed",
  "settings-login-cross-entry-coordinator-timeout",
  "settings-login-cross-entry-fallback-close-timeout",
  "settings-login-cross-entry-fallback-close-replaced",
  "settings-login-cross-entry-cleanup-failed",
  "settings-login-cross-entry-report-write-failed",
]);
const MAX_REPORT_BYTES = 64 * 1024;

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function nullableBoolean(value) {
  return value === null || typeof value === "boolean";
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function validOwner(value, expectedOwner) {
  return value?.schemaVersion === 1 && value.kind === "settings-login-cross-entry"
    && value.identifier === expectedOwner?.identifier && value.root === expectedOwner?.root
    && value.pid === expectedOwner?.pid && value.runId === expectedOwner?.runId
    && typeof value.identifier === "string" && typeof value.root === "string"
    && Number.isSafeInteger(value.pid) && value.pid > 0
    && typeof value.runId === "string" && /^[0-9a-f]{32}$/.test(value.runId);
}

function validStage(stage) {
  if (!exactKeys(stage, STAGE_KEYS) || !new Set(["vue", "fallback"]).has(stage.surface)
      || !new Set(["saving", "saved", "error", "unknown", null]).has(stage.saveState)) return false;
  return ["ready", "controlUnique", "enabled", "disabled", "indeterminate", "overviewUnknown",
    "hasConflictMessage", "routeGeneral", "getterEnabled", "actionDispatched", "actionSucceeded",
    "nativeEnabled", "databaseEnabled", "unknownMarkerPreserved"].every(key => nullableBoolean(stage[key]));
}

function requiredFacts(stage, facts) {
  return Object.entries(facts).every(([key, value]) => stage[key] === value);
}

function stageSemantics(stages, originalLaunchAtLogin) {
  const vue = (enabled, nativeEnabled, databaseEnabled, unknownMarkerPreserved, extra = {}) => ({
    surface: "vue", ready: true, controlUnique: true, enabled,
    disabled: null, indeterminate: null, overviewUnknown: null, hasConflictMessage: null,
    saveState: null, routeGeneral: true, getterEnabled: enabled,
    nativeEnabled, databaseEnabled, unknownMarkerPreserved, ...extra,
  });
  const fallback = (enabled, nativeEnabled, databaseEnabled, unknownMarkerPreserved, extra = {}) => {
    const conflicted = enabled === null;
    return {
      surface: "fallback", ready: true, controlUnique: true, enabled,
      disabled: conflicted, indeterminate: conflicted, overviewUnknown: conflicted,
      hasConflictMessage: conflicted, routeGeneral: null, getterEnabled: null,
      nativeEnabled, databaseEnabled, unknownMarkerPreserved, ...extra,
    };
  };
  const facts = {
    initial: vue(true, true, false, true, { actionDispatched: null, actionSucceeded: null }),
    fallbackInitial: fallback(true, true, false, true, { actionDispatched: null, actionSucceeded: null }),
    fallbackDisabled: fallback(false, false, false, true, { actionDispatched: true, actionSucceeded: true }),
    vueAfterDisabled: vue(false, false, false, true, { actionDispatched: null, actionSucceeded: null }),
    vueReenabled: vue(true, true, false, true, { actionDispatched: true, actionSucceeded: true }),
    fallbackFresh: fallback(true, true, false, true, { actionDispatched: null, actionSucceeded: null }),
    ordinarySave: fallback(true, true, false, true, { saveState: "saved", actionDispatched: true, actionSucceeded: true }),
    conflict: fallback(null, false, false, true, { actionDispatched: true, actionSucceeded: true }),
    reread: fallback(false, false, false, true, { actionDispatched: true, actionSucceeded: true }),
    final: vue(true, true, originalLaunchAtLogin, null, { actionDispatched: true, actionSucceeded: true }),
  };
  return STAGE_NAMES.every(name => requiredFacts(stages[name], facts[name]));
}

function validCounters(value) {
  return exactKeys(value, COUNTER_KEYS) && COUNTER_KEYS.every(key => boundedCount(value[key]));
}

function validDatabase(value) {
  return exactKeys(value, DATABASE_KEYS)
    && (value.beforeSha256 === null || /^[0-9a-f]{64}$/.test(value.beforeSha256))
    && (value.afterSha256 === null || /^[0-9a-f]{64}$/.test(value.afterSha256))
    && nullableBoolean(value.originalLaunchAtLogin);
}

function validCleanup(value) {
  return exactKeys(value, CLEANUP_KEYS) && boundedCount(value.fallbackWindowCount)
    && typeof value.coordinatorTerminal === "boolean" && typeof value.databaseRestored === "boolean"
    && boundedCount(value.pendingProbes);
}

function semanticFacts(report) {
  return validDatabase(report.database) && STAGE_NAMES.every(name => validStage(report.stages[name]))
    && validCounters(report.counters) && validCleanup(report.cleanup)
    && report.counters.readLaunchAtLogin === 3
    && report.counters.changeLaunchAtLogin === 2
    && report.counters.saveGeneralSettings === 1
    && report.database.beforeSha256 !== null && report.database.beforeSha256 === report.database.afterSha256
    && report.stages.final.databaseEnabled === report.database.originalLaunchAtLogin
    && stageSemantics(report.stages, report.database.originalLaunchAtLogin);
}

export function validateLoginCrossEntryReport(value, expectedOwner, {
  nativeOwnerMatches = false,
  nativeProcessTerminal = false,
  nativeProcessSucceeded = false,
  nativeCaseSucceeded = false,
} = {}) {
  const errors = [];
  const structureValid = exactKeys(value, REPORT_KEYS) && validOwner(value, expectedOwner)
    && exactKeys(value.stages, STAGE_NAMES) && exactKeys(value.database, DATABASE_KEYS)
    && exactKeys(value.counters, COUNTER_KEYS) && exactKeys(value.cleanup, CLEANUP_KEYS)
    && typeof value.passed === "boolean" && Array.isArray(value.errors)
    && value.errors.length <= ERROR_CODES.size && new Set(value.errors).size === value.errors.length
    && value.errors.every(code => ERROR_CODES.has(code))
    && STAGE_NAMES.every(name => validStage(value.stages[name]))
    && validCounters(value.counters) && validDatabase(value.database) && validCleanup(value.cleanup);
  if (!structureValid) errors.push("login-cross-entry-report-invalid");
  const ownerMatches = structureValid && nativeOwnerMatches === true;
  if (!ownerMatches) errors.push("login-cross-entry-owner-invalid");

  const cleanupSafe = structureValid && ownerMatches && nativeProcessTerminal === true
    && value.database.beforeSha256 !== null && value.database.beforeSha256 === value.database.afterSha256
    && value.stages.final.databaseEnabled === value.database.originalLaunchAtLogin
    && value.cleanup.fallbackWindowCount === 0 && value.cleanup.coordinatorTerminal === true
    && value.cleanup.databaseRestored === true && value.cleanup.pendingProbes === 0;
  if (!cleanupSafe) errors.push("login-cross-entry-cleanup-unconfirmed");

  const countersMatch = structureValid && value.counters.readLaunchAtLogin === 3
    && value.counters.changeLaunchAtLogin === 2 && value.counters.saveGeneralSettings === 1;
  const stagesMatch = structureValid && stageSemantics(value.stages, value.database.originalLaunchAtLogin);
  const databaseMatches = structureValid && value.database.beforeSha256 !== null
    && value.database.beforeSha256 === value.database.afterSha256
    && value.stages.final.databaseEnabled === value.database.originalLaunchAtLogin;
  const reportClaimsSuccess = structureValid && value.passed === true && value.errors.length === 0;
  const passed = structureValid && ownerMatches && nativeProcessTerminal === true && nativeProcessSucceeded === true
    && nativeCaseSucceeded === true && reportClaimsSuccess && countersMatch && stagesMatch && databaseMatches && cleanupSafe;
  if (!passed) errors.push("login-cross-entry-acceptance-failed");
  return {
    valid: structureValid && ownerMatches,
    passed,
    cleanupSafe,
    errors,
    summary: structureValid ? {
      stages: Object.fromEntries(STAGE_NAMES.map(name => [name, {
        surface: value.stages[name].surface,
        enabled: value.stages[name].enabled,
        getterEnabled: value.stages[name].getterEnabled,
        nativeEnabled: value.stages[name].nativeEnabled,
        databaseEnabled: value.stages[name].databaseEnabled,
      }])),
      counters: { ...value.counters },
      database: { ...value.database },
      cleanup: { ...value.cleanup },
      nativePassedClaim: value.passed,
      nativeErrors: [...value.errors],
    } : null,
  };
}

export async function readLoginCrossEntryReport(path, expectedOwner, {
  nativeOwnerMatches = false,
  nativeProcessTerminal = false,
  nativeProcessSucceeded = false,
  nativeCaseSucceeded = false,
} = {}) {
  let file;
  try { file = await readJsonFile(path, MAX_REPORT_BYTES); }
  catch (error) {
    return {
      exists: false, valid: false, passed: false, cleanupSafe: false,
      errors: [error?.code === "ENOENT" ? "login-cross-entry-report-missing" : "login-cross-entry-report-read-failed"],
      summary: null, exception: { name: String(error?.name || "Error").slice(0, 80), code: error?.code ?? null },
    };
  }
  if (!file.exists) {
    return { exists: false, valid: false, passed: false, cleanupSafe: false,
      errors: ["login-cross-entry-report-missing"], summary: null, exception: null };
  }
  if (file.exception || file.value === null) {
    return { exists: true, valid: false, passed: false, cleanupSafe: false,
      errors: ["login-cross-entry-report-read-failed"], summary: null, exception: file.exception ?? null };
  }
  const result = validateLoginCrossEntryReport(file.value, expectedOwner, {
    nativeOwnerMatches, nativeProcessTerminal, nativeProcessSucceeded, nativeCaseSucceeded,
  });
  return { exists: file.exists === true, ...result, exception: null };
}
