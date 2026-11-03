export const SETTINGS_INPUT_NATIVE_SCOPE = "hidden-original-vue-real-settings-input";
export const SETTINGS_INPUT_NATIVE_STAGES = Object.freeze([
  "startup", "openAllCommands", "mainMatch", "mainNoMatch", "mainClear", "pinSearch",
  "childValueReturn", "ownerRotation", "closeCleanup", "freshReopen", "unpinSearch", "finalCleanup",
]);

const ROOT_KEYS = ["schemaVersion", "journey", "scope", "identifier", "root", "pid", "runId",
  "autoClear", "passed", "timedOut", "elapsedMs", "updaterStatus", "catalogSelection", "searchPins",
  "stages", "cleanup", "errors"];
const UPDATER_KEYS = ["startupCalls", "verifiedCalls", "idle", "unchecked", "hasUpdate",
  "hasDownloadedAbsent", "nativeIdle", "nativeUnchecked", "nativeUpdateAbsent", "nativeErrorAbsent"];
const CATALOG_KEYS = ["available", "canonicalNonEmpty"];
const SEARCH_PIN_KEYS = ["initiallyEmpty", "pinStored", "pinReadBack", "mainPinned", "unpinStored",
  "unpinReadBack", "mainUnpinned", "historyUnchanged", "initialRevision", "pinnedRevision", "unpinnedRevision"];
const STAGE_KEYS = ["key", "passed", "elapsedMs", "dom", "native", "activation", "presentation", "errors"];
const DOM_KEYS = ["mainReady", "childReady", "routeValid", "matchedCount", "restoredCount", "inputEmpty",
  "queryMatches", "baselineCount", "filteredCount", "mainDocumentHidden", "mainDocumentHasFocus",
  "childDocumentHidden", "childDocumentHasFocus"];
const NATIVE_KEYS = ["sessionCount", "childCount", "layoutCount", "pendingCalls", "pendingWrites",
  "controlSequence", "userSequence", "valueBytes", "inputVisible", "windowVisible", "windowFocused",
  "focusGainedEvents", "generation", "valueVersion", "mainDataStorePersistent", "childDataStorePersistent",
  "staleInputRejected", "freshSession", "opaqueSessionId"];
const ACTIVATION_KEYS = ["known", "installed", "registered", "removed", "appActive", "frontmostIsSelf",
  "appActivationEvents", "mainKeyEvents"];
const PRESENTATION_KEYS = ["hiddenSmoke", "suppressedFocusRequests"];
const CLEANUP_KEYS = ["sessionCount", "childCount", "layoutCount", "pendingCalls", "pendingWrites",
  "observerRemoved", "observerRegistered", "activationKnown", "appActive", "frontmostIsSelf",
  "focusGainedEvents", "appActivationEvents", "mainKeyEvents"];

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function count(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function duration(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function check(errors, condition, code) {
  if (!condition) errors.push(code);
}

function noErrors(value, code, errors) {
  check(errors, Array.isArray(value) && value.length === 0, code);
}

function validateUpdater(value, errors) {
  check(errors, exactKeys(value, UPDATER_KEYS), "updater-status-shape");
  if (!isRecord(value)) return;
  check(errors, value.startupCalls === 1 && value.verifiedCalls === 2, "updater-status-call-counts");
  check(errors, value.idle === true && value.unchecked === true && value.hasUpdate === false
    && value.hasDownloadedAbsent === true && value.nativeIdle === true && value.nativeUnchecked === true
    && value.nativeUpdateAbsent === true && value.nativeErrorAbsent === true, "updater-status-observation");
}

function validateCatalog(value, errors) {
  check(errors, exactKeys(value, CATALOG_KEYS), "catalog-selection-shape");
  if (!isRecord(value)) return;
  check(errors, value.available === true && value.canonicalNonEmpty === true, "catalog-selection-unavailable");
}

function validateSearchPins(value, errors) {
  check(errors, exactKeys(value, SEARCH_PIN_KEYS), "search-pins-shape");
  if (!isRecord(value)) return;
  for (const key of SEARCH_PIN_KEYS.slice(0, 8)) {
    check(errors, value[key] === true, `search-pins-${key}`);
  }
  for (const key of ["initialRevision", "pinnedRevision", "unpinnedRevision"]) {
    check(errors, count(value[key]), `search-pins-${key}-type`);
  }
  if (["initialRevision", "pinnedRevision", "unpinnedRevision"].every(key => count(value[key]))) {
    check(errors, value.pinnedRevision === value.initialRevision + 1
      && value.unpinnedRevision === value.pinnedRevision + 1,
    "search-pins-revision-progression");
  }
}

function validateDom(value, stageKey, errors) {
  check(errors, exactKeys(value, DOM_KEYS), `${stageKey}-dom-shape`);
  if (!isRecord(value)) return;
  check(errors, value.mainReady === true && value.mainDocumentHidden === true
    && value.mainDocumentHasFocus === false, `${stageKey}-main-document-policy`);
  const childExpected = !["startup", "closeCleanup", "finalCleanup"].includes(stageKey);
  check(errors, value.childReady === childExpected, `${stageKey}-child-ready`);
  if (childExpected) {
    check(errors, value.childDocumentHidden === true && value.childDocumentHasFocus === false,
      `${stageKey}-child-document-policy`);
  } else {
    check(errors, value.childDocumentHidden === null && value.childDocumentHasFocus === null,
      `${stageKey}-child-document-absent`);
  }
  for (const key of ["matchedCount", "restoredCount", "baselineCount", "filteredCount"]) {
    check(errors, value[key] === null || count(value[key]), `${stageKey}-dom-${key}`);
  }
  for (const key of ["inputEmpty", "routeValid", "queryMatches"]) {
    check(errors, value[key] === null || typeof value[key] === "boolean", `${stageKey}-dom-${key}-type`);
  }
  if (!childExpected) {
    check(errors, value.routeValid === null && value.matchedCount === null && value.restoredCount === null
      && value.baselineCount === null && value.filteredCount === null && value.queryMatches === null
      && value.inputEmpty === true, `${stageKey}-dom-no-child-state`);
  } else {
    check(errors, value.routeValid === true, `${stageKey}-route-invalid`);
  }
}

function validateNative(value, stageKey, errors) {
  check(errors, exactKeys(value, NATIVE_KEYS), `${stageKey}-native-shape`);
  if (!isRecord(value)) return;
  for (const key of ["sessionCount", "childCount", "layoutCount", "pendingCalls", "pendingWrites",
    "controlSequence", "userSequence", "valueBytes", "focusGainedEvents"]) {
    check(errors, count(value[key]), `${stageKey}-native-${key}`);
  }
  for (const key of ["inputVisible", "windowVisible", "windowFocused", "mainDataStorePersistent"]) {
    check(errors, typeof value[key] === "boolean", `${stageKey}-native-${key}-type`);
  }
  check(errors, value.childDataStorePersistent === null || typeof value.childDataStorePersistent === "boolean",
    `${stageKey}-native-child-store-type`);
  for (const key of ["generation", "valueVersion"]) {
    check(errors, value[key] === null || count(value[key]), `${stageKey}-native-${key}`);
  }
  for (const key of ["staleInputRejected", "freshSession"]) {
    check(errors, value[key] === null || typeof value[key] === "boolean", `${stageKey}-native-${key}-type`);
  }
  check(errors, value.opaqueSessionId === null
    || (typeof value.opaqueSessionId === "string" && /^[0-9a-f]{32}$/.test(value.opaqueSessionId)),
  `${stageKey}-opaque-session-id`);
  check(errors, value.windowVisible === false && value.windowFocused === false
    && value.focusGainedEvents === 0 && value.mainDataStorePersistent === false,
  `${stageKey}-native-hidden-policy`);
  check(errors, value.pendingCalls === 0 && value.pendingWrites === 0, `${stageKey}-native-drained`);

  const childExpected = !["startup", "closeCleanup", "finalCleanup"].includes(stageKey);
  check(errors, value.sessionCount === Number(childExpected) && value.childCount === Number(childExpected)
    && value.layoutCount === Number(childExpected), `${stageKey}-native-session-counts`);
  if (childExpected) {
    check(errors, value.generation !== null && value.generation > 0 && value.valueVersion !== null
      && value.childDataStorePersistent === false && value.inputVisible === true
      && value.opaqueSessionId !== null, `${stageKey}-native-active-input`);
  } else {
    check(errors, value.generation === null && value.valueVersion === null
      && value.childDataStorePersistent === null && value.inputVisible === false
      && value.opaqueSessionId === null && value.valueBytes === 0, `${stageKey}-native-absent-input`);
  }
  const staleIdentityStage = stageKey === "ownerRotation" || stageKey === "freshReopen";
  check(errors, staleIdentityStage ? value.staleInputRejected === true : value.staleInputRejected === null,
    `${stageKey}-stale-owner-evidence`);
  check(errors, stageKey === "freshReopen" ? value.freshSession === true : value.freshSession === null,
    `${stageKey}-fresh-session-evidence`);
}

function validateActivation(value, stageKey, errors) {
  check(errors, exactKeys(value, ACTIVATION_KEYS), `${stageKey}-activation-shape`);
  if (!isRecord(value)) return;
  const final = stageKey === "finalCleanup";
  check(errors, value.known === true && value.installed === !final
    && value.registered === 2 && value.removed === (final ? 2 : 0), `${stageKey}-activation-lifecycle`);
  check(errors, value.appActive === false && value.frontmostIsSelf === false
    && value.appActivationEvents === 0 && value.mainKeyEvents === 0, `${stageKey}-activation-inactive`);
}

function isStageNotReached(stage) {
  return isRecord(stage) && stage.passed === false && Array.isArray(stage.errors)
    && stage.errors.includes("settings-input-stage-not-reached");
}

function validatePresentation(value, stageKey, notReached, errors) {
  check(errors, exactKeys(value, PRESENTATION_KEYS), `${stageKey}-presentation-shape`);
  if (!isRecord(value)) return;
  check(errors, count(value.suppressedFocusRequests), `${stageKey}-focus-count-type`);
  if (notReached) return;
  check(errors, value.hiddenSmoke === true, `${stageKey}-presentation-hidden`);
  if (stageKey === "startup") {
    check(errors, value.suppressedFocusRequests === 0, "startup-focus-count-not-zero");
  } else if (stageKey !== "finalCleanup") {
    check(errors, value.suppressedFocusRequests > 0, `${stageKey}-focus-not-suppressed`);
  }
}

function validateStage(stage, index, errors) {
  const key = SETTINGS_INPUT_NATIVE_STAGES[index];
  check(errors, exactKeys(stage, STAGE_KEYS), `${key}-stage-shape`);
  if (!isRecord(stage)) return;
  check(errors, stage.key === key && stage.passed === true && duration(stage.elapsedMs) && stage.elapsedMs > 0,
    `${key}-stage-state`);
  noErrors(stage.errors, `${key}-stage-errors`, errors);
  validateDom(stage.dom, key, errors);
  validateNative(stage.native, key, errors);
  validateActivation(stage.activation, key, errors);
  validatePresentation(stage.presentation, key, isStageNotReached(stage), errors);
}

function validateStageProgression(stages, errors) {
  if (!Array.isArray(stages) || stages.length !== SETTINGS_INPUT_NATIVE_STAGES.length
      || stages.some(stage => !isRecord(stage))) return;
  for (const [index, expected] of SETTINGS_INPUT_NATIVE_STAGES.entries()) {
    check(errors, stages[index].key === expected, `stage-order-${expected}`);
  }
  let previousObserved = null;
  for (const stage of stages) {
    if (isStageNotReached(stage)) continue;
    const current = stage.presentation?.suppressedFocusRequests;
    if (previousObserved !== null) {
      check(errors, count(previousObserved.value) && count(current) && current >= previousObserved.value,
        `stage-focus-suppression-monotonic-${stage.key}`);
    }
    previousObserved = { key: stage.key, value: current };
  }
  const [startup, opened, match, noMatch, clear, pinned, childValue, rotated, closed, reopened, unpinned] = stages;
  if ([opened, match, noMatch, clear, pinned, childValue, rotated, closed, reopened, unpinned].every(isRecord)) {
    const baseline = opened.dom?.baselineCount;
    check(errors, count(baseline) && baseline > 0 && opened.dom.filteredCount === baseline
      && opened.dom.matchedCount === baseline && opened.dom.inputEmpty === true,
    "open-all-commands-baseline");
    for (const stage of [match, noMatch, clear, childValue]) {
      check(errors, stage.dom?.baselineCount === baseline, `${stage.key}-baseline-stable`);
    }
    check(errors, match.dom?.queryMatches === true && match.dom.filteredCount === 1
      && match.dom.matchedCount === 1 && match.dom.inputEmpty === false
      && match.native?.valueBytes > 0 && match.native?.userSequence > opened.native?.userSequence
      && sameControlOwner(opened.native, match.native), "main-match-observed");
    check(errors, noMatch.dom?.queryMatches === true && noMatch.dom.filteredCount === 0
      && noMatch.dom.matchedCount === 0 && noMatch.dom.inputEmpty === false
      && noMatch.native?.valueBytes > 0 && noMatch.native?.userSequence > match.native?.userSequence
      && sameControlOwner(match.native, noMatch.native), "main-no-match-observed");
    check(errors, clear.dom?.queryMatches === true && clear.dom.filteredCount === baseline
      && clear.dom.matchedCount === baseline && clear.dom.restoredCount === baseline
      && clear.dom.inputEmpty === true && clear.native?.valueBytes === 0
      && clear.native?.userSequence > noMatch.native?.userSequence
      && sameControlOwner(noMatch.native, clear.native), "main-clear-restores-baseline");
    check(errors, pinned.dom?.routeValid === true && pinned.dom?.baselineCount === baseline
      && pinned.dom?.filteredCount === baseline && pinned.dom?.matchedCount === baseline
      && pinned.dom?.inputEmpty === true && pinned.dom?.queryMatches === true
      && sameControlOwner(clear.native, pinned.native),
    "search-pin-keeps-original-all-commands-owner");
    check(errors, childValue.dom?.queryMatches === true && childValue.dom.filteredCount === 1
      && childValue.dom.matchedCount === 1 && childValue.dom.inputEmpty === false
      && childValue.native?.valueBytes > 0 && childValue.native?.userSequence === clear.native?.userSequence
      && childValue.native?.controlSequence > pinned.native?.controlSequence
      && childValue.native?.valueVersion > pinned.native?.valueVersion
      && childValue.native?.generation === pinned.native?.generation
      && childValue.native?.opaqueSessionId === pinned.native?.opaqueSessionId,
    "child-value-reaches-main-and-filter");
    check(errors, rotated.dom?.routeValid === true && rotated.native?.generation > childValue.native?.generation
      && rotated.native?.opaqueSessionId === childValue.native?.opaqueSessionId
      && rotated.native?.staleInputRejected === true, "owner-rotation-rejects-stale-input");
    check(errors, reopened.native?.freshSession === true && reopened.native?.staleInputRejected === true
      && reopened.native?.opaqueSessionId !== opened.native?.opaqueSessionId
      && reopened.dom?.baselineCount === baseline && reopened.native?.valueBytes === 0
      && reopened.dom?.inputEmpty === true, "fresh-reopen-has-new-empty-session");
    check(errors, unpinned.dom?.routeValid === true && unpinned.dom?.baselineCount === baseline
      && unpinned.dom?.filteredCount === baseline && unpinned.dom?.matchedCount === baseline
      && unpinned.dom?.inputEmpty === true && unpinned.dom?.queryMatches === true
      && sameControlOwner(reopened.native, unpinned.native),
    "search-unpin-keeps-fresh-all-commands-owner");
  }
  if (isRecord(startup) && isRecord(opened)) {
    check(errors, startup.native?.sessionCount === 0 && opened.native?.sessionCount === 1,
      "settings-child-opens-on-original-path");
  }
}

function sameControlOwner(left, right) {
  return isRecord(left) && isRecord(right) && left.controlSequence === right.controlSequence
    && left.generation === right.generation && left.valueVersion === right.valueVersion
    && left.opaqueSessionId === right.opaqueSessionId;
}

function validateCleanup(value, errors) {
  check(errors, exactKeys(value, CLEANUP_KEYS), "cleanup-shape");
  if (!isRecord(value)) return;
  for (const key of ["sessionCount", "childCount", "layoutCount", "pendingCalls", "pendingWrites",
    "focusGainedEvents", "appActivationEvents", "mainKeyEvents"]) {
    check(errors, count(value[key]) && value[key] === 0, `cleanup-${key}`);
  }
  check(errors, value.observerRemoved === 2 && value.observerRegistered === 2
    && value.activationKnown === true && value.appActive === false && value.frontmostIsSelf === false,
  "cleanup-observer-activation");
}

/** Validates the complete hidden settings-input evidence without retaining input text. */
export function validateSettingsInputNativeReport(report, expectedOwner) {
  const errors = [];
  if (!isRecord(report)) return { valid: false, passed: false, errors: ["report-shape"] };
  check(errors, exactKeys(report, ROOT_KEYS), "report-shape");
  check(errors, report.schemaVersion === 3 && report.journey === "settings-input"
    && report.scope === SETTINGS_INPUT_NATIVE_SCOPE, "report-identity");
  const owner = isRecord(expectedOwner) ? expectedOwner : {};
  check(errors, report.identifier === owner.identifier && report.root === owner.root
    && report.runId === owner.runId && report.pid === owner.pid && report.autoClear === "never",
  "report-owner-mismatch");
  check(errors, typeof report.runId === "string" && /^[0-9a-f]{32}$/.test(report.runId)
    && report.identifier === `dev.atools.renderer-settings-input.${report.runId}`,
  "report-profile-identity");
  check(errors, report.passed === true && report.timedOut === false
    && duration(report.elapsedMs) && report.elapsedMs > 0, "report-not-passed");
  noErrors(report.errors, "report-errors", errors);
  validateUpdater(report.updaterStatus, errors);
  validateCatalog(report.catalogSelection, errors);
  validateSearchPins(report.searchPins, errors);
  check(errors, Array.isArray(report.stages) && report.stages.length === SETTINGS_INPUT_NATIVE_STAGES.length,
    "report-stage-count");
  if (Array.isArray(report.stages)) {
    report.stages.slice(0, SETTINGS_INPUT_NATIVE_STAGES.length).forEach((stage, index) => validateStage(stage, index, errors));
  }
  validateStageProgression(report.stages, errors);
  validateCleanup(report.cleanup, errors);
  return { valid: errors.length === 0, passed: report.passed === true, errors: [...new Set(errors)] };
}
