export const CLIPBOARD_REPORT_FILENAME = "native-clipboard-context-report.json";
export const CLIPBOARD_JOURNEY = "clipboard-context";
export const CLIPBOARD_SCOPE = "isolated-original-main-clipboard-context";

const ERROR_CODES = new Set([
  "clipboard-context-main-ready-timeout",
  "clipboard-context-probe-injection-failed",
  "clipboard-context-probe-ready-invalid",
  "clipboard-context-probe-timeout",
  "clipboard-context-probe-invalid",
  "clipboard-context-fixture-invalid",
  "clipboard-context-permission-baseline-invalid",
  "clipboard-context-stage-failed",
  "clipboard-context-privacy-audit-failed",
  "clipboard-context-cleanup-failed",
  "clipboard-context-report-write-failed",
  "clipboard-context-watchdog-timeout",
]);
const HEX_SHA256 = /^[0-9a-f]{64}$/;
const EMPTY_HISTORY_SHA256 = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const RUN_ID = /^[0-9a-f]{32}$/;
const TOP_KEYS = ["schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId", "elapsedMs",
  "source", "stages", "counters", "taskRuns", "audits", "history", "runtime", "cleanup", "errors", "declaredPassed", "fullProductAcceptance"];
const SOURCE_KEYS = ["journey", "renderer", "genericReportAbsent", "documentRoot", "searchInputCount",
  "clipboardGetterAvailable", "readerCommandObserved", "assets"];
const ASSET_KEYS = ["runtimeAssetCount", "runtimeAssetBytes", "javascriptAssetCount", "fallbackSettingsAssets"];
const STAGE_KEYS = {
  ready: ["probeReady", "documentVisibility", "documentHasFocus", "mainWindowVisible", "mainWindowFocused", "searchInputCount", "clipboardGetterAvailable"],
  textEmpty: ["pasteCanceled", "clipboardCommandDelta", "boardSnapshotDelta", "inputEmpty", "textChipMatches", "launchContextObserved"],
  textSelection: ["pasteCanceled", "clipboardCommandDelta", "boardSnapshotDelta", "inputValueMatches", "selectionMatches", "launchContextObserved"],
  image: ["pasteCanceled", "clipboardCommandDelta", "boardSnapshotDelta", "imageChipMatches", "naturalWidth", "naturalHeight", "launchContextObserved"],
  file: ["pasteCanceled", "clipboardCommandDelta", "boardSnapshotDelta", "fileChipMatches", "fileNameMatches", "launchContextObserved", "pasteboardChangeCountBefore", "pasteboardChangeCountAfter"],
  expiredSameCount: ["getterReturnedNull", "clipboardCommandDelta", "boardSnapshotDelta", "changeCountBefore", "changeCountAfter", "changeCountUnchanged", "launchContextUnchanged"],
  empty: ["getterReturnedNull", "clipboardCommandDelta", "boardSnapshotDelta", "uiUnchanged", "launchContextUnchanged"],
  denied: ["getterRejected", "clipboardCommandDelta", "boardSnapshotDelta", "uiUnchanged", "launchContextUnchanged", "deniedTaskRun", "deniedAudit"],
};
const COUNTER_KEYS = ["clipboardCommandCalls", "boardSnapshots", "boardChangeCountReads", "pasteboardChangeCountBefore",
  "pasteboardChangeCountAfter", "backgroundCaptures", "writesRejected", "pastesRejected"];
const TASK_KEYS = ["before", "after", "succeeded", "cancelled", "other", "allTerminal", "summaryOnly", "rawPayloadAbsent"];
const AUDIT_KEYS = ["before", "after", "confirmed", "denied", "other", "finalized", "metadataOnly", "rawPayloadAbsent"];
const HISTORY_KEYS = ["beforeCount", "afterCount", "beforeSha256", "afterSha256", "unchanged", "fixtureContentAbsent", "nativeBeforeEmpty", "nativeAfterEmpty"];
const RUNTIME_KEYS = ["activePluginAbsent", "activeTaskRuns", "mcpStatusAbsent", "pasteboardCaptureTaskAbsent", "nodeSidecarStarted", "pluginRuntimeStarted"];
const CLEANUP_KEYS = ["boardCleared", "boardClearVerified", "permissionRestored", "mainWindowPresent", "settingsWindowCount",
  "pluginWindowCount", "pendingProbeCount", "pendingCommandCount", "adapterOutstandingNativeCalls", "taskRunsTerminal",
  "auditsTerminal", "mediaPermitsBefore", "mediaPermitsAfter", "probeDisposed"];
const COUNT_FIELDS = {
  counters: ["clipboardCommandCalls", "boardSnapshots", "boardChangeCountReads", "backgroundCaptures", "writesRejected", "pastesRejected"],
  taskRuns: ["before", "after", "succeeded", "cancelled", "other"],
  audits: ["before", "after", "confirmed", "denied", "other"],
  history: ["beforeCount", "afterCount"],
  runtime: ["activeTaskRuns"],
  cleanup: ["settingsWindowCount", "pluginWindowCount", "pendingProbeCount", "pendingCommandCount", "adapterOutstandingNativeCalls", "mediaPermitsBefore", "mediaPermitsAfter"],
};
const BOOL_FIELDS = {
  source: ["genericReportAbsent", "documentRoot", "readerCommandObserved"],
  taskRuns: ["allTerminal", "summaryOnly", "rawPayloadAbsent"],
  audits: ["finalized", "metadataOnly", "rawPayloadAbsent"],
  history: ["unchanged", "fixtureContentAbsent"],
  runtime: ["activePluginAbsent", "mcpStatusAbsent", "pasteboardCaptureTaskAbsent", "nodeSidecarStarted", "pluginRuntimeStarted"],
  cleanup: ["boardCleared", "boardClearVerified", "permissionRestored", "mainWindowPresent", "taskRunsTerminal", "auditsTerminal", "probeDisposed"],
};

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function nullableCount(value, maximum = 4096) {
  return value === null || (Number.isSafeInteger(value) && value >= 0 && value <= maximum);
}

function nullableBool(value) {
  return value === null || typeof value === "boolean";
}

function safeNonnegative(value, max) {
  return Number.isSafeInteger(value) && value >= 0 && value <= max;
}

function nullableChangeCount(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function shaOrNull(value) {
  return value === null || (typeof value === "string" && HEX_SHA256.test(value));
}

function ownerMatches(report, expected) {
  return typeof report.runId === "string" && RUN_ID.test(report.runId)
    && expected?.runId === report.runId
    && expected.identifier === `dev.atools.renderer-clipboard.${report.runId}`
    && expected.root === `/private/tmp/atools-renderer-clipboard-${report.runId}`
    && report.identifier === expected.identifier && report.root === expected.root
    && Number.isSafeInteger(expected.pid) && expected.pid > 0 && report.pid === expected.pid;
}

function validShape(report) {
  if (!exactKeys(report, TOP_KEYS) || report.schemaVersion !== 1 || report.journey !== CLIPBOARD_JOURNEY
      || report.scope !== CLIPBOARD_SCOPE || !RUN_ID.test(report.runId)
      || !safeNonnegative(report.elapsedMs, 180_000) || !Number.isSafeInteger(report.pid) || report.pid <= 0
      || typeof report.declaredPassed !== "boolean" || report.fullProductAcceptance !== false) return false;
  if (!exactKeys(report.source, SOURCE_KEYS) || report.source.journey !== CLIPBOARD_JOURNEY
      || report.source.renderer !== "unchanged-original-vue"
      || BOOL_FIELDS.source.some(key => typeof report.source[key] !== "boolean")
      || !nullableBool(report.source.clipboardGetterAvailable)
      || !nullableCount(report.source.searchInputCount)
      || !exactKeys(report.source.assets, ASSET_KEYS)) return false;
  for (const key of ASSET_KEYS) if (!nullableCount(report.source.assets[key], key === "runtimeAssetBytes" ? 2 * 1024 * 1024 : 64)) return false;
  if (report.source.assets.fallbackSettingsAssets !== null) return false;
  if (!exactKeys(report.stages, Object.keys(STAGE_KEYS))) return false;
  for (const [name, keys] of Object.entries(STAGE_KEYS)) {
    const stage = report.stages[name];
    if (!exactKeys(stage, keys)) return false;
    for (const [key, value] of Object.entries(stage)) {
      if (["clipboardCommandDelta", "boardSnapshotDelta", "naturalWidth", "naturalHeight"].includes(key)) {
        if (!nullableCount(value)) return false;
      } else if (["changeCountBefore", "changeCountAfter", "pasteboardChangeCountBefore", "pasteboardChangeCountAfter"].includes(key)) {
        if (!nullableChangeCount(value)) return false;
      } else if (name === "ready" && key === "documentVisibility") {
        if (value !== null && value !== "visible" && value !== "hidden") return false;
      } else if (name === "ready" && key === "searchInputCount") {
        if (!nullableCount(value)) return false;
      } else if (!nullableBool(value)) return false;
    }
  }
  for (const [section, keys] of Object.entries({
    counters: COUNTER_KEYS, taskRuns: TASK_KEYS, audits: AUDIT_KEYS, history: HISTORY_KEYS,
    runtime: RUNTIME_KEYS, cleanup: CLEANUP_KEYS,
  })) if (!exactKeys(report[section], keys)) return false;
  for (const [section, keys] of Object.entries(COUNT_FIELDS)) {
    for (const key of keys) {
      if (!nullableCount(report[section][key])) return false;
    }
  }
  for (const [section, keys] of Object.entries(BOOL_FIELDS)) {
    for (const key of keys) if (!nullableBool(report[section][key])) return false;
  }
  if (!nullableChangeCount(report.counters.pasteboardChangeCountBefore)
      || !nullableChangeCount(report.counters.pasteboardChangeCountAfter)
      || !shaOrNull(report.history.beforeSha256) || !shaOrNull(report.history.afterSha256)
      || typeof report.history.nativeBeforeEmpty !== "boolean"
      || !nullableBool(report.history.nativeAfterEmpty)) return false;
  if (!Array.isArray(report.errors) || report.errors.length > ERROR_CODES.size
      || report.errors.some(value => typeof value !== "string" || !ERROR_CODES.has(value))
      || new Set(report.errors).size !== report.errors.length) return false;
  return true;
}

function stagePassed(stage, expected) {
  return Object.entries(expected).every(([key, value]) => {
    const actual = stage[key];
    if (value === "positive-count-or-more") return Number.isSafeInteger(actual) && actual >= 1 && actual <= 4096;
    return actual === value;
  });
}

function businessPassed(report, expectedAssetSummary) {
  const source = report.source;
  if (source.journey !== CLIPBOARD_JOURNEY || source.renderer !== "unchanged-original-vue"
      || !BOOL_FIELDS.source.every(key => source[key] === true) || source.searchInputCount !== 1
      || !record(expectedAssetSummary) || !exactKeys(expectedAssetSummary, ASSET_KEYS)
      || !exactKeys(source.assets, ASSET_KEYS)
      || ASSET_KEYS.some(key => source.assets[key] !== expectedAssetSummary[key])) return false;
  const stages = report.stages;
  if (stages.ready.documentVisibility === null || stages.ready.documentHasFocus === null
      || !stagePassed(stages.ready, {
        probeReady: true, mainWindowVisible: false, mainWindowFocused: false,
        searchInputCount: 1, clipboardGetterAvailable: true,
      })) return false;
  const expectedStages = {
    textEmpty: { pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1, inputEmpty: true, textChipMatches: true, launchContextObserved: true },
    textSelection: { pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1, inputValueMatches: true, selectionMatches: true, launchContextObserved: true },
    image: { pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1, imageChipMatches: true, naturalWidth: 1, naturalHeight: 1, launchContextObserved: true },
    file: { pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1, fileChipMatches: true, fileNameMatches: true, launchContextObserved: true },
    expiredSameCount: { getterReturnedNull: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1, changeCountUnchanged: true, launchContextUnchanged: true },
    empty: { getterReturnedNull: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1, uiUnchanged: true, launchContextUnchanged: true },
    denied: { getterRejected: true, clipboardCommandDelta: 1, boardSnapshotDelta: 0, uiUnchanged: true, launchContextUnchanged: true, deniedTaskRun: true, deniedAudit: true },
  };
  if (Object.entries(expectedStages).some(([name, expected]) => !stagePassed(stages[name], expected))) return false;
  const beforeCount = stages.expiredSameCount.changeCountBefore;
  const afterCount = stages.expiredSameCount.changeCountAfter;
  if (beforeCount === null || afterCount === null || beforeCount !== afterCount
      || stages.file.pasteboardChangeCountBefore === null || stages.file.pasteboardChangeCountAfter === null
      || stages.file.pasteboardChangeCountBefore !== stages.file.pasteboardChangeCountAfter
      || beforeCount !== stages.file.pasteboardChangeCountAfter) return false;

  const counters = report.counters;
  if (counters.clipboardCommandCalls !== 7 || counters.boardSnapshots !== 6
      || counters.boardChangeCountReads < 6 || counters.backgroundCaptures !== 0
      || counters.writesRejected !== 0 || counters.pastesRejected !== 0
      || counters.pasteboardChangeCountBefore === null || counters.pasteboardChangeCountAfter === null) return false;
  const taskRuns = report.taskRuns;
  if (taskRuns.before !== 0 || taskRuns.after !== 7 || taskRuns.succeeded !== 6 || taskRuns.cancelled !== 1
      || taskRuns.other !== 0 || !taskRuns.allTerminal || !taskRuns.summaryOnly || !taskRuns.rawPayloadAbsent) return false;
  const audits = report.audits;
  if (audits.before !== 0 || audits.after !== 7 || audits.confirmed !== 6 || audits.denied !== 1
      || audits.other !== 0 || !audits.finalized || !audits.metadataOnly || !audits.rawPayloadAbsent) return false;
  const history = report.history;
  if (history.beforeCount === null || history.afterCount !== history.beforeCount
      || history.beforeSha256 !== EMPTY_HISTORY_SHA256 || history.afterSha256 !== EMPTY_HISTORY_SHA256
      || !history.unchanged || !history.fixtureContentAbsent
      || history.nativeBeforeEmpty !== true || history.nativeAfterEmpty !== true) return false;
  const runtime = report.runtime;
  if (runtime.activePluginAbsent !== true || runtime.activeTaskRuns !== 0
      || runtime.mcpStatusAbsent !== true || runtime.pasteboardCaptureTaskAbsent !== true
      || runtime.nodeSidecarStarted !== null || runtime.pluginRuntimeStarted !== null) return false;
  const cleanup = report.cleanup;
  return cleanup.boardCleared === true && cleanup.boardClearVerified === true
    && cleanup.permissionRestored === true && cleanup.mainWindowPresent === true
    && cleanup.settingsWindowCount === 0 && cleanup.pluginWindowCount === 0
    && cleanup.pendingProbeCount === 0 && cleanup.pendingCommandCount === 0
    && cleanup.adapterOutstandingNativeCalls === 0 && cleanup.taskRunsTerminal === true
    && cleanup.auditsTerminal === true && cleanup.mediaPermitsBefore === 2
    && cleanup.mediaPermitsAfter === 2 && cleanup.probeDisposed === true;
}

export function validateClipboardContextReport(report, expectedOwner, { exists = true, expectedAssetSummary = null } = {}) {
  const errors = [];
  if (!exists) errors.push("clipboard-report-missing");
  if (!validShape(report)) errors.push("clipboard-report-invalid-shape");
  const identityValid = record(report) && ownerMatches(report, expectedOwner);
  if (!identityValid) errors.push("clipboard-report-owner-mismatch");
  const shapeValid = exists && validShape(report) && identityValid;
  const computedPass = shapeValid && report.errors.length === 0 && businessPassed(report, expectedAssetSummary);
  if (shapeValid && report.declaredPassed !== computedPass) errors.push("clipboard-declared-pass-mismatch");
  return {
    exists: exists === true,
    valid: shapeValid,
    passed: computedPass && report.declaredPassed === true && errors.length === 0,
    identityValid,
    declaredPassed: record(report) && typeof report.declaredPassed === "boolean" ? report.declaredPassed : null,
    nativeErrors: shapeValid ? [...report.errors] : [],
    errors,
  };
}
