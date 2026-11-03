import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";

export const GENERAL_POLICIES_REPORT_FILENAME = "native-general-policies-report.json";
export const GENERAL_POLICIES_ERRORS = Object.freeze([
  "settings-input-general-policies-baseline-invalid", "settings-input-general-policies-open-failed",
  "settings-input-general-policies-window-policy-failed", "settings-input-general-policies-window-geometry-invalid",
  "settings-input-general-policies-clipboard-edit-failed", "settings-input-general-policies-clipboard-capture-failed",
  "settings-input-general-policies-reopen-failed", "settings-input-general-policies-restore-failed",
  "settings-input-general-policies-unrelated-changed", "settings-input-general-policies-safety-invalid",
  "settings-input-general-policies-close-failed", "settings-input-general-policies-readback-invalid",
  "settings-input-general-policies-report-write-failed",
]);

const STRATEGIES = Object.freeze(["remember", "cursor", "primary", "lastActive"]);
const PHASES = Object.freeze([
  "baseline", "afterCursor", "afterPrimary", "afterLastActive", "afterRememberSave",
  "afterRememberMove", "afterRememberRestore", "after30Save", "after30Capture", "after1Save",
  "after1Capture", "afterReset180", "afterResetCapture", "afterFreshReopen", "afterRestore", "afterClose",
]);
const REPORT_KEYS = Object.freeze([
  "schemaVersion", "journey", "scope", "runId", "identifier", "pid", "root", "observations", "errors",
]);
const OBSERVATION_KEYS = Object.freeze(["windowUi", "geometry", "clipboard", "windowSafety", "pluginUiOpened", "preloadStarted", "childClosed"]);
const UI_KEYS = Object.freeze([
  "initialUiStrategy", "initialStoredStrategy", "cursor", "primary", "lastActive", "remember",
  "reopened", "restored", "unrelatedSettingsPreserved",
]);
const SELECTION_KEYS = Object.freeze(["uiSelected", "storedStrategy"]);
const REOPEN_KEYS = Object.freeze(["freshSession", "uiStrategy", "storedStrategy"]);
const RESTORED_KEYS = Object.freeze(["uiStrategy", "storedStrategy"]);
const GEOMETRY_KEYS = Object.freeze(["cursor", "primary", "lastActiveFallback", "remember"]);
const CLIPBOARD_KEYS = Object.freeze(["initialUiDays", "initialStoredDays", "at30", "at1", "afterReset180", "finalUiDays", "finalStoredDays"]);
const RETENTION_KEYS = Object.freeze(["uiDays", "storedDays", "resetDispatched", "beforeCapture", "captureSucceeded", "afterCapture"]);
const RESET_KEYS = Object.freeze([
  "uiDays", "storedDays", "resetDispatched", "beforeReset", "afterReset", "beforeCapture", "captureSucceeded", "afterCapture",
]);
const SNAPSHOT_KEYS = Object.freeze([
  "pasteboardCount", "legacyCount", "expiredUnpinnedPresent", "recentUnpinnedPresent", "expiredPinnedPresent",
  "legacyExpiredPresent", "legacyRecentPresent", "reset100DayPresent", "legacyReset100DayPresent",
]);
const SAFETY_KEYS = Object.freeze(["phases", "focusEventsBefore", "focusEventsAfter"]);
const SAFETY_FACT_KEYS = Object.freeze(["visible", "focused"]);
const SAMPLE_KEYS = Object.freeze(["cursor", "monitor", "window"]);
const LAST_ACTIVE_KEYS = Object.freeze(["externalWindowAvailable", "position"]);
const CURSOR_KEYS = Object.freeze(["x", "y"]);
const MONITOR_KEYS = Object.freeze([
  "x", "y", "width", "height", "workX", "workY", "workWidth", "workHeight", "scaleFactor", "isPrimary",
]);
const WINDOW_KEYS = Object.freeze(["x", "y", "width", "height"]);
const REMEMBER_KEYS = Object.freeze(["monitor", "windowSize", "saved", "moved", "restored"]);
const SIZE_KEYS = Object.freeze(["width", "height"]);
const POINT_KEYS = Object.freeze(["x", "y"]);
const ERROR_SET = new Set(GENERAL_POLICIES_ERRORS);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function nullableBoolean(value) {
  return value === null || typeof value === "boolean";
}

function boundedCount(value) {
  return value === null || Number.isSafeInteger(value) && value >= 0 && value <= 4096;
}

function nullableInteger(value, minimum = 0) {
  return value === null || Number.isSafeInteger(value) && value >= minimum && value <= 2_147_483_647;
}

function nullableDays(value) {
  return value === null || Number.isSafeInteger(value) && value >= 1 && value <= 3650;
}

function nullableStrategy(value) {
  return value === null || STRATEGIES.includes(value);
}

function validSelection(value) {
  return exactKeys(value, SELECTION_KEYS) && nullableBoolean(value.uiSelected) && nullableStrategy(value.storedStrategy);
}

function validUi(value) {
  return exactKeys(value, UI_KEYS)
    && nullableStrategy(value.initialUiStrategy)
    && nullableStrategy(value.initialStoredStrategy)
    && ["cursor", "primary", "lastActive", "remember"].every(key => validSelection(value[key]))
    && exactKeys(value.reopened, REOPEN_KEYS)
    && nullableBoolean(value.reopened.freshSession)
    && nullableStrategy(value.reopened.uiStrategy)
    && nullableStrategy(value.reopened.storedStrategy)
    && exactKeys(value.restored, RESTORED_KEYS)
    && nullableStrategy(value.restored.uiStrategy)
    && nullableStrategy(value.restored.storedStrategy)
    && nullableBoolean(value.unrelatedSettingsPreserved);
}

function nullablePoint(value) {
  return exactKeys(value, POINT_KEYS) && POINT_KEYS.every(key => nullableInteger(value[key], -2_147_483_648));
}

function validMonitor(value) {
  if (!exactKeys(value, MONITOR_KEYS)) return false;
  return ["x", "y", "workX", "workY"].every(key => nullableInteger(value[key], -2_147_483_648))
    && ["width", "height", "workWidth", "workHeight"].every(key => nullableInteger(value[key], 1))
    && (value.scaleFactor === null || Number.isFinite(value.scaleFactor) && value.scaleFactor > 0 && value.scaleFactor <= 8)
    && nullableBoolean(value.isPrimary);
}

function validWindow(value) {
  return exactKeys(value, WINDOW_KEYS)
    && ["x", "y"].every(key => nullableInteger(value[key], -2_147_483_648))
    && ["width", "height"].every(key => nullableInteger(value[key], 1));
}

function validPositionSample(value) {
  return exactKeys(value, SAMPLE_KEYS)
    && nullablePoint(value.cursor)
    && validMonitor(value.monitor)
    && validWindow(value.window);
}

function validRemember(value) {
  return exactKeys(value, REMEMBER_KEYS)
    && validMonitor(value.monitor)
    && exactKeys(value.windowSize, SIZE_KEYS)
    && ["width", "height"].every(key => nullableInteger(value.windowSize[key], 1))
    && nullablePoint(value.saved) && nullablePoint(value.moved) && nullablePoint(value.restored);
}

function validGeometry(value) {
  return exactKeys(value, GEOMETRY_KEYS)
    && validPositionSample(value.cursor)
    && validPositionSample(value.primary)
    && exactKeys(value.lastActiveFallback, LAST_ACTIVE_KEYS)
    && nullableBoolean(value.lastActiveFallback.externalWindowAvailable)
    && validPositionSample(value.lastActiveFallback.position)
    && validRemember(value.remember);
}

function validSnapshot(value) {
  return exactKeys(value, SNAPSHOT_KEYS)
    && ["pasteboardCount", "legacyCount"].every(key => boundedCount(value[key]))
    && SNAPSHOT_KEYS.slice(2).every(key => nullableBoolean(value[key]));
}

function validRetention(value) {
  return exactKeys(value, RETENTION_KEYS)
    && nullableDays(value.uiDays) && nullableDays(value.storedDays)
    && nullableBoolean(value.resetDispatched) && validSnapshot(value.beforeCapture)
    && nullableBoolean(value.captureSucceeded) && validSnapshot(value.afterCapture);
}

function validClipboard(value) {
  return exactKeys(value, CLIPBOARD_KEYS)
    && nullableDays(value.initialUiDays) && nullableDays(value.initialStoredDays)
    && validRetention(value.at30) && validRetention(value.at1)
    && exactKeys(value.afterReset180, RESET_KEYS)
    && nullableDays(value.afterReset180.uiDays) && nullableDays(value.afterReset180.storedDays)
    && nullableBoolean(value.afterReset180.resetDispatched)
    && validSnapshot(value.afterReset180.beforeReset) && validSnapshot(value.afterReset180.afterReset)
    && validSnapshot(value.afterReset180.beforeCapture) && nullableBoolean(value.afterReset180.captureSucceeded)
    && validSnapshot(value.afterReset180.afterCapture)
    && nullableDays(value.finalUiDays) && nullableDays(value.finalStoredDays);
}

function validSafety(value) {
  return exactKeys(value, SAFETY_KEYS)
    && exactKeys(value.phases, PHASES)
    && PHASES.every(phase => exactKeys(value.phases[phase], SAFETY_FACT_KEYS)
      && SAFETY_FACT_KEYS.every(key => nullableBoolean(value.phases[phase][key])))
    && boundedCount(value.focusEventsBefore) && boundedCount(value.focusEventsAfter);
}

function observationsValid(value) {
  return exactKeys(value, OBSERVATION_KEYS)
    && validUi(value.windowUi) && validGeometry(value.geometry) && validClipboard(value.clipboard)
    && validSafety(value.windowSafety)
    && nullableBoolean(value.pluginUiOpened) && nullableBoolean(value.preloadStarted) && nullableBoolean(value.childClosed);
}

function errorsValid(value) {
  return Array.isArray(value) && value.length <= ERROR_SET.size && Object.keys(value).length === value.length
    && value.every(code => typeof code === "string" && ERROR_SET.has(code))
    && new Set(value).size === value.length;
}

function ownerMatches(value, expectedOwner) {
  const runId = value.runId;
  return value.schemaVersion === 1 && value.journey === "settings-general-policies"
    && value.scope === "hidden-original-General-position-and-retention"
    && typeof runId === "string" && /^[0-9a-f]{32}$/.test(runId)
    && value.identifier === `dev.atools.renderer-settings-input.${runId}`
    && value.root === `/private/tmp/atools-renderer-settings-input-${runId}`
    && Number.isSafeInteger(value.pid) && value.pid > 0 && isRecord(expectedOwner)
    && expectedOwner.runId === runId && expectedOwner.identifier === value.identifier
    && expectedOwner.root === value.root && expectedOwner.pid === value.pid
    && Number.isSafeInteger(expectedOwner.pid) && expectedOwner.pid > 0;
}

function expectedPosition(sample) {
  const { monitor, window } = sample;
  const centeredOffset = (physicalExtent, logicalAnchor) => Math.round(
    Math.floor(Math.max(physicalExtent / monitor.scaleFactor - logicalAnchor, 0) / 2)
      * monitor.scaleFactor,
  );
  const clamp = (position, origin, extent, actual) => {
    const maximum = origin + Math.max(extent - actual, 0);
    return Math.min(Math.max(position, origin), Math.max(maximum, origin));
  };
  const anchorX = monitor.workX + centeredOffset(monitor.workWidth, 800);
  const anchorY = monitor.workY + centeredOffset(monitor.workHeight, 600);
  return {
    x: clamp(anchorX, monitor.workX, monitor.workWidth, window.width),
    y: clamp(anchorY, monitor.workY, monitor.workHeight, window.height),
  };
}

function centered(sample, requirePrimary, requireCursorInside) {
  const { cursor, monitor, window } = sample;
  const withinMonitor = cursor.x >= monitor.x && cursor.x < monitor.x + monitor.width
    && cursor.y >= monitor.y && cursor.y < monitor.y + monitor.height;
  const expected = expectedPosition(sample);
  return (!requireCursorInside || withinMonitor) && (!requirePrimary || monitor.isPrimary === true)
    && window.x === expected.x && window.y === expected.y;
}

function sameMonitor(left, right) {
  return MONITOR_KEYS.every(key => left[key] === right[key]);
}

function rememberPassed(value, cursorSample) {
  const { monitor, windowSize, saved, moved, restored } = value;
  const sameSize = windowSize.width === cursorSample.window.width && windowSize.height === cursorSample.window.height;
  const sameTargetMonitor = sameMonitor(monitor, cursorSample.monitor);
  const restoreX = Math.min(Math.max(saved.x, monitor.workX), Math.max(monitor.workX + monitor.workWidth - windowSize.width, monitor.workX));
  const restoreY = Math.min(Math.max(saved.y, monitor.workY), Math.max(monitor.workY + monitor.workHeight - windowSize.height, monitor.workY));
  const inWorkArea = point => point.x >= monitor.workX && point.y >= monitor.workY
    && point.x + windowSize.width <= monitor.workX + monitor.workWidth
    && point.y + windowSize.height <= monitor.workY + monitor.workHeight;
  const defaultPosition = expectedPosition(cursorSample);
  return sameSize && sameTargetMonitor && inWorkArea(saved) && inWorkArea(moved)
    && (saved.x !== moved.x || saved.y !== moved.y)
    && (saved.x !== defaultPosition.x || saved.y !== defaultPosition.y)
    && restored.x === restoreX && restored.y === restoreY;
}

function snapshotMatches(value, counts, expected) {
  return value.pasteboardCount === counts.pasteboard && value.legacyCount === counts.legacy
    && Object.entries(expected).every(([key, valueExpected]) => value[key] === valueExpected);
}

function sameSnapshot(left, right) {
  return SNAPSHOT_KEYS.every(key => left[key] === right[key]);
}

function clipboardPassed(value) {
  const initialDays = value.initialUiDays;
  if (initialDays !== (value.initialStoredDays ?? 180)) return false;
  const stage = (item, days, beforeCounts, beforeFacts, afterCounts, afterFacts, reset) =>
    item.uiDays === days && item.storedDays === days && item.resetDispatched === reset
      && item.captureSucceeded === true
      && snapshotMatches(item.beforeCapture, beforeCounts, beforeFacts)
      && snapshotMatches(item.afterCapture, afterCounts, afterFacts);
  const present30 = { expiredUnpinnedPresent: true, recentUnpinnedPresent: true, expiredPinnedPresent: true,
    legacyExpiredPresent: true, legacyRecentPresent: true, reset100DayPresent: false, legacyReset100DayPresent: false };
  const retained30 = { ...present30, expiredUnpinnedPresent: false, legacyExpiredPresent: false };
  const before1 = { ...retained30 };
  const retained1 = { ...retained30, recentUnpinnedPresent: false, legacyRecentPresent: false };
  const beforeReset = { ...retained1 };
  const afterReset = { ...beforeReset };
  const with100Days = { ...beforeReset, reset100DayPresent: true, legacyReset100DayPresent: true };
  if (!stage(value.at30, 30, { pasteboard: 3, legacy: 2 }, present30, { pasteboard: 3, legacy: 2 }, retained30, false)
      || !stage(value.at1, 1, { pasteboard: 3, legacy: 2 }, before1, { pasteboard: 3, legacy: 2 }, retained1, false)) return false;
  const reset = value.afterReset180;
  const resetCounts = { pasteboard: 3, legacy: 2 };
  if (reset.uiDays !== 180 || reset.storedDays !== 180 || reset.resetDispatched !== true
      || !snapshotMatches(reset.beforeReset, resetCounts, beforeReset)
      || !snapshotMatches(reset.afterReset, resetCounts, afterReset)
      || !sameSnapshot(reset.beforeReset, reset.afterReset)
      || !snapshotMatches(reset.beforeCapture, { pasteboard: 4, legacy: 3 }, with100Days)
      || reset.captureSucceeded !== true
      || !snapshotMatches(reset.afterCapture, { pasteboard: 5, legacy: 4 }, with100Days)) return false;
  return value.finalUiDays === initialDays && value.finalStoredDays === initialDays;
}

function observationsPassed(value) {
  if (!observationsValid(value)) return false;
  const ui = value.windowUi;
  const initialStrategy = ui.initialStoredStrategy ?? "remember";
  const initialDays = value.clipboard.initialStoredDays ?? 180;
  const phasesSafe = PHASES.every(phase => value.windowSafety.phases[phase].visible === false
    && value.windowSafety.phases[phase].focused === false);
  return ui.initialUiStrategy === initialStrategy
    && ["cursor", "primary", "lastActive", "remember"].every(key => ui[key].uiSelected === true && ui[key].storedStrategy === key)
    && ui.reopened.freshSession === true && ui.reopened.uiStrategy === "remember" && ui.reopened.storedStrategy === "remember"
    && ui.restored.uiStrategy === initialStrategy && ui.restored.storedStrategy === initialStrategy
    && ui.unrelatedSettingsPreserved === true
    && centered(value.geometry.cursor, false, true) && centered(value.geometry.primary, true, false)
    && value.geometry.lastActiveFallback.externalWindowAvailable === false
    && sameMonitor(value.geometry.lastActiveFallback.position.monitor, value.geometry.cursor.monitor)
    && centered(value.geometry.lastActiveFallback.position, false, true)
    && rememberPassed(value.geometry.remember, value.geometry.cursor)
    && clipboardPassed(value.clipboard) && value.clipboard.finalUiDays === initialDays
    && phasesSafe && value.windowSafety.focusEventsBefore === 0
    && value.windowSafety.focusEventsAfter === value.windowSafety.focusEventsBefore
    && value.pluginUiOpened === false && value.preloadStarted === false && value.childClosed === true;
}

/** Independently validates the owner, geometry, original-UI choices, and retention facts. */
export function validateGeneralPoliciesReport(report, expectedOwner) {
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
    summary: { observations: factsValid ? structuredClone(report.observations) : null, nativeErrors },
  };
}

/** Requires an owner-matching sidecar and the completed, cleaned settings-input Native run. */
export async function readGeneralPoliciesReport(path, expectedOwner, nativeOwnerMatches, nativeCaseSucceeded) {
  let file;
  try { file = await readJsonFile(path, 16 * 1024); }
  catch { file = { exists: false, value: null, exception: { name: "ReadError", code: null } }; }
  const result = validateGeneralPoliciesReport(file.value, expectedOwner);
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
