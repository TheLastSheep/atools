const REPORT_KEYS = Object.freeze([
  "schemaVersion", "kind", "journey", "scope", "identifier", "root", "pid", "runId",
  "fullProductAcceptance", "visualStatus", "conversion", "restoration", "stages", "activation",
  "cleanup", "errors", "passed",
]);
const CONVERSION_KEYS = Object.freeze([
  "scopedIdentifierMatches", "mainWindowHiddenBeforeConversion", "sameNativeWindow", "originalClass",
  "originalClassAssessment",
  "panelClass", "originalInstanceSize", "panelInstanceSize", "taoFocusableOffset", "nsPanelOwnIvarCount",
  "focusableLayoutSafe", "isPanel", "panelClassMatches", "nonactivatingStyle", "selectorAvailable",
  "canBecomeKey", "canBecomeMain", "stillHidden", "originalDelegateUnchanged",
  "contentViewAndParentUnchanged", "collectionBehaviorUnchanged", "releasedWhenClosedUnchanged",
  "subviewMasksAdjusted", "level", "floating", "hidesOnDeactivate", "becomesKeyOnlyIfNeeded",
  "subviewCount", "textInputMethodAdded", "runtimeMethodLifetime", "runtimeMethodRemovalSupported",
]);
const RESTORATION_KEYS = Object.freeze([
  "sameNativeWindow", "originalClassRestored", "originalDelegateRestored", "releasedWhenClosedRestored",
  "subviewMasksRestored", "contentViewRestored", "styleMaskRestored", "levelRestored",
  "collectionBehaviorRestored", "hidesOnDeactivateRestored", "canBecomeKeyRestored",
  "canBecomeMainRestored", "panelFloatingBaselineRestored", "panelBecomesKeyBaselineRestored",
  "windowRestored", "textInputMethodRemains", "runtimeMethodLifetime", "runtimeMethodRemovalSupported",
]);
const FOREGROUND_KEYS = Object.freeze([
  "appActive", "appHidden", "frontmostIsSelf", "mainWindowAvailable", "mainVisible", "mainKey",
  "mainFocused", "mainOnActiveSpace", "mainOcclusionVisible",
]);
const STAGE_KEYS = Object.freeze([
  "foreground", "frontmostMatchesBaseline", "inputFound", "inputFocused", "documentVisible",
  "documentHasFocus", "contentViewStable", "appActivationEvents", "appActivationEventDelta", "mainKeyEvents",
  "mainKeyEventDelta",
]);
const CLASS_ASSESSMENT_KEYS = Object.freeze([
  "kind", "actualClass", "reportedClass", "actualSuperclass", "actualInstanceSize", "taoInstanceSize",
  "ownIvarCount", "ownMethodNames", "taoDirectSuperclassIsNsWindow",
]);
const FOUNDATION_KVO_METHODS = Object.freeze(["_isKVOA", "class", "dealloc", "setContentView:"]);
const STAGE_NAMES = Object.freeze(["baseline", "shown", "hidden", "reshown"]);
const ACTIVATION_KEYS = Object.freeze([
  "baselineAppActivationEvents", "finalAppActivationEvents", "appActivationEventDelta",
  "baselineMainKeyEvents", "finalMainKeyEvents", "mainKeyEventDelta", "observerRegistered",
  "observerRemoved", "observerInstalled",
]);
const CLEANUP_KEYS = Object.freeze([
  "windowHidden", "panelActive", "nativeOperationsTerminal", "observersRemoved",
]);
const CONVERSION_TRUE = Object.freeze([
  "scopedIdentifierMatches", "mainWindowHiddenBeforeConversion", "sameNativeWindow", "focusableLayoutSafe",
  "isPanel", "panelClassMatches", "nonactivatingStyle", "selectorAvailable", "canBecomeKey", "stillHidden",
  "originalDelegateUnchanged", "contentViewAndParentUnchanged", "collectionBehaviorUnchanged",
  "releasedWhenClosedUnchanged", "subviewMasksAdjusted",
]);
const RESTORATION_TRUE = Object.freeze([
  "sameNativeWindow", "originalClassRestored", "originalDelegateRestored", "releasedWhenClosedRestored",
  "subviewMasksRestored", "contentViewRestored", "styleMaskRestored", "levelRestored",
  "collectionBehaviorRestored", "hidesOnDeactivateRestored", "canBecomeKeyRestored",
  "canBecomeMainRestored", "panelFloatingBaselineRestored", "panelBecomesKeyBaselineRestored", "windowRestored",
]);
const NATIVE_ERRORS = new Set([
  "main-panel-prototype-observer-install-failed",
  "main-panel-prototype-panel-install-failed",
  "main-panel-prototype-probe-injection-failed",
  "main-panel-prototype-dom-ready-timeout",
  "main-panel-prototype-probe-invalid",
  "main-panel-prototype-probe-order-invalid",
  "main-panel-prototype-probe-id-exhausted",
  "main-panel-prototype-baseline-invalid",
  "main-panel-prototype-show-failed",
  "main-panel-prototype-shown-invalid",
  "main-panel-prototype-hide-failed",
  "main-panel-prototype-hidden-invalid",
  "main-panel-prototype-toggle-reshow-failed",
  "main-panel-prototype-reshown-invalid",
  "main-panel-prototype-final-hide-failed",
  "main-panel-prototype-observer-cleanup-failed",
  "main-panel-prototype-restore-failed",
  "main-panel-prototype-cleanup-state-invalid",
  "main-panel-prototype-native-operation-timeout",
  "main-panel-prototype-watchdog-expired",
]);
const ROOT_PATTERN = /^\/private\/tmp\/atools-renderer-smoke-([0-9a-f]{32})$/;
const MAX_U32 = 0xffff_ffff;
const NS_MODAL_PANEL_WINDOW_LEVEL = 8;
const OBJC_BOOL_BYTES = 1;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function uint(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function uint32(value) {
  return uint(value) && value > 0 && value <= MAX_U32;
}

function int(value) {
  return Number.isSafeInteger(value);
}

function boolOrNull(value) {
  return value === null || typeof value === "boolean";
}

function uintOrNull(value) {
  return value === null || uint(value);
}

function validateClassAssessmentShape(value) {
  if (!exactKeys(value, CLASS_ASSESSMENT_KEYS)
      || !["tao", "foundation-kvo-content-view"].includes(value.kind)) return false;
  const names = value.ownMethodNames;
  return ["actualClass", "reportedClass", "actualSuperclass"].every(key =>
    typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 256)
    && ["actualInstanceSize", "taoInstanceSize", "ownIvarCount"].every(key => uint(value[key]))
    && typeof value.taoDirectSuperclassIsNsWindow === "boolean"
    && Array.isArray(names) && Object.keys(names).length === names.length && names.length <= 512
    && names.every((name, index) => typeof name === "string" && name.length > 0 && name.length <= 256
      && (index === 0 || names[index - 1] < name));
}

function classAssessmentPass(value, originalClass, originalInstanceSize) {
  if (!isRecord(value) || value.actualClass !== originalClass
      || value.actualInstanceSize !== originalInstanceSize
      || value.actualInstanceSize !== value.taoInstanceSize
      || value.taoDirectSuperclassIsNsWindow !== true) return false;
  if (value.kind === "tao") {
    return value.actualClass === "TaoWindow" && value.reportedClass === "TaoWindow"
      && value.actualSuperclass === "NSWindow";
  }
  return value.kind === "foundation-kvo-content-view"
    && value.actualClass === "NSKVONotifying_TaoWindow"
    && value.reportedClass === "TaoWindow"
    && value.actualSuperclass === "TaoWindow"
    && value.ownIvarCount === 0
    && value.ownMethodNames.length === FOUNDATION_KVO_METHODS.length
    && value.ownMethodNames.every((name, index) => name === FOUNDATION_KVO_METHODS[index]);
}

function check(errors, condition, name) {
  if (!condition) errors.push(name);
}

function validateExpectedOwner(owner, errors) {
  if (!exactKeys(owner, ["root", "runId", "identifier", "pid"])) {
    errors.push("expected-owner-shape");
    return false;
  }
  const runIdValid = typeof owner.runId === "string" && /^[0-9a-f]{32}$/.test(owner.runId);
  const rootMatch = typeof owner.root === "string" ? ROOT_PATTERN.exec(owner.root) : null;
  const valid = runIdValid && rootMatch?.[1] === owner.runId
    && owner.root === `/private/tmp/atools-renderer-smoke-${owner.runId}`
    && owner.identifier === `dev.atools.renderer-smoke.${owner.runId}`
    && uint32(owner.pid);
  check(errors, valid, "expected-owner-invalid");
  return valid;
}

function validateErrors(value) {
  return Array.isArray(value) && value.length <= NATIVE_ERRORS.size
    && Object.keys(value).length === value.length
    && value.every(code => typeof code === "string" && NATIVE_ERRORS.has(code))
    && new Set(value).size === value.length;
}

function validateConversionShape(value) {
  if (value === null) return true;
  if (!exactKeys(value, CONVERSION_KEYS)) return false;
  if (!validateClassAssessmentShape(value.originalClassAssessment)) return false;
  const boolKeys = [
    ...CONVERSION_TRUE, "canBecomeMain", "floating", "hidesOnDeactivate", "becomesKeyOnlyIfNeeded",
    "runtimeMethodRemovalSupported",
  ];
  return boolKeys.every(key => typeof value[key] === "boolean")
    && ["originalClass", "panelClass", "runtimeMethodLifetime"].every(key => typeof value[key] === "string")
    && ["originalInstanceSize", "panelInstanceSize", "taoFocusableOffset", "nsPanelOwnIvarCount", "subviewCount"]
      .every(key => uint(value[key]))
    && int(value.level) && boolOrNull(value.textInputMethodAdded);
}

function validateRestorationShape(value) {
  if (value === null) return true;
  if (!exactKeys(value, RESTORATION_KEYS)) return false;
  return [...RESTORATION_TRUE, "runtimeMethodRemovalSupported"].every(key => typeof value[key] === "boolean")
    && typeof value.runtimeMethodLifetime === "string"
    && boolOrNull(value.textInputMethodRemains);
}

function validateStageShape(value) {
  if (value === null) return true;
  if (!exactKeys(value, STAGE_KEYS) || !exactKeys(value.foreground, FOREGROUND_KEYS)) return false;
  return FOREGROUND_KEYS.every(key => boolOrNull(value.foreground[key]))
    && ["frontmostMatchesBaseline", "inputFound", "inputFocused"].every(key => boolOrNull(value[key]))
    && typeof value.documentVisible === "boolean"
    && typeof value.documentHasFocus === "boolean"
    && boolOrNull(value.contentViewStable)
    && ["appActivationEvents", "appActivationEventDelta", "mainKeyEvents", "mainKeyEventDelta"]
      .every(key => uintOrNull(value[key]));
}

function validateStagesShape(value) {
  return exactKeys(value, STAGE_NAMES) && STAGE_NAMES.every(name => validateStageShape(value[name]));
}

function validateActivationShape(value) {
  if (!exactKeys(value, ACTIVATION_KEYS)) return false;
  return ACTIVATION_KEYS.filter(key => key !== "observerInstalled").every(key => uintOrNull(value[key]))
    && boolOrNull(value.observerInstalled);
}

function validateCleanupShape(value) {
  return exactKeys(value, CLEANUP_KEYS)
    && ["windowHidden", "panelActive", "observersRemoved"].every(key => boolOrNull(value[key]))
    && typeof value.nativeOperationsTerminal === "boolean";
}

function checkedDelta(current, baseline) {
  return uint(current) && uint(baseline) && current >= baseline ? current - baseline : null;
}

function stageDeltasConsistent(stages) {
  const baseline = stages.baseline;
  if (baseline === null) return false;
  for (const name of STAGE_NAMES) {
    const stage = stages[name];
    if (stage === null) return false;
    const expectedApp = name === "baseline" ? 0
      : checkedDelta(stage.appActivationEvents, baseline.appActivationEvents);
    const expectedKey = name === "baseline" ? 0
      : checkedDelta(stage.mainKeyEvents, baseline.mainKeyEvents);
    if (stage.appActivationEventDelta !== expectedApp || stage.mainKeyEventDelta !== expectedKey) return false;
  }
  return true;
}

function activationDeltasConsistent(activation) {
  return activation.appActivationEventDelta
      === checkedDelta(activation.finalAppActivationEvents, activation.baselineAppActivationEvents)
    && activation.mainKeyEventDelta
      === checkedDelta(activation.finalMainKeyEvents, activation.baselineMainKeyEvents);
}

function reportDeltasConsistent(stages, activation) {
  const baseline = stages.baseline;
  if (baseline !== null) {
    for (const name of STAGE_NAMES) {
      const stage = stages[name];
      if (stage === null) continue;
      const expectedApp = name === "baseline" ? 0
        : checkedDelta(stage.appActivationEvents, baseline.appActivationEvents);
      const expectedKey = name === "baseline" ? 0
        : checkedDelta(stage.mainKeyEvents, baseline.mainKeyEvents);
      if (stage.appActivationEventDelta !== expectedApp || stage.mainKeyEventDelta !== expectedKey) return false;
    }
  }
  return activationDeltasConsistent(activation);
}

function conversionPass(value) {
  if (!isRecord(value)) return false;
  const original = value.originalInstanceSize;
  const panel = value.panelInstanceSize;
  const offset = value.taoFocusableOffset;
  return CONVERSION_TRUE.every(key => value[key] === true)
    && classAssessmentPass(value.originalClassAssessment, value.originalClass, original)
    && value.panelClass === "AToolsMainPanel"
    && original > 0 && panel > 0 && panel <= original && offset >= panel
    && Number.isSafeInteger(offset + OBJC_BOOL_BYTES) && offset + OBJC_BOOL_BYTES <= original
    && value.nsPanelOwnIvarCount === 0
    && value.canBecomeMain === false
    && value.floating === true
    && value.hidesOnDeactivate === false
    && value.becomesKeyOnlyIfNeeded === false
    && value.level === NS_MODAL_PANEL_WINDOW_LEVEL + 1
    && typeof value.textInputMethodAdded === "boolean"
    && value.runtimeMethodLifetime === "until-process-exit"
    && value.runtimeMethodRemovalSupported === false;
}

function restorationPass(value) {
  return isRecord(value)
    && RESTORATION_TRUE.every(key => value[key] === true)
    && typeof value.textInputMethodRemains === "boolean"
    && value.runtimeMethodLifetime === "until-process-exit"
    && value.runtimeMethodRemovalSupported === false;
}

function textMethodStateMatches(conversion, restoration) {
  return typeof conversion?.textInputMethodAdded === "boolean"
    && typeof restoration?.textInputMethodRemains === "boolean"
    && conversion.textInputMethodAdded === restoration.textInputMethodRemains;
}

function stagePass(name, facts, baselineActive, baselineKeyEvents) {
  if (!isRecord(facts) || typeof baselineActive !== "boolean") return false;
  const foreground = facts.foreground;
  const stable = foreground.appActive === baselineActive
    && facts.appActivationEventDelta === 0
    && facts.contentViewStable === true
    && facts.frontmostMatchesBaseline === true
    && facts.inputFound === true;
  if (!stable) return false;
  if (name === "baseline") {
    return facts.mainKeyEventDelta === 0
      && foreground.mainWindowAvailable === true
      && foreground.mainVisible === false && foreground.mainKey === false && foreground.mainFocused === false
      && !facts.documentHasFocus;
  }
  if (name === "hidden") {
    return facts.mainKeyEventDelta !== null && facts.mainKeyEventDelta >= 1
      && foreground.mainWindowAvailable === true
      && foreground.mainVisible === false && foreground.mainKey === false && foreground.mainFocused === false
      && !facts.documentHasFocus;
  }
  const requiredKeyDelta = name === "shown" ? 1 : 2;
  return facts.mainKeyEventDelta !== null && facts.mainKeyEventDelta >= requiredKeyDelta
    && foreground.appHidden === false
    && foreground.mainWindowAvailable === true
    && foreground.mainVisible === true && foreground.mainKey === true && foreground.mainFocused === true
    && foreground.mainOnActiveSpace === true && foreground.mainOcclusionVisible === true
    && facts.inputFocused === true && facts.documentVisible && facts.documentHasFocus
    && baselineKeyEvents !== null;
}

function factsPass(report) {
  const { conversion, restoration, stages, activation, cleanup, errors } = report;
  if (errors.length !== 0 || !conversionPass(conversion) || !restorationPass(restoration)
      || !textMethodStateMatches(conversion, restoration) || !stageDeltasConsistent(stages)
      || !activationDeltasConsistent(activation)) return false;

  const baseline = stages.baseline;
  const baselineActive = baseline.foreground.appActive;
  if (baselineActive !== true && baselineActive !== false) return false;
  if (activation.baselineAppActivationEvents !== baseline.appActivationEvents
      || activation.baselineMainKeyEvents !== baseline.mainKeyEvents) return false;

  let previousAppEvents = null;
  let previousKeyEvents = null;
  for (const name of STAGE_NAMES) {
    const stage = stages[name];
    if (!stagePass(name, stage, baselineActive, baseline.mainKeyEvents)) return false;
    if (!uint(stage.appActivationEvents) || !uint(stage.mainKeyEvents)) return false;
    if (previousAppEvents !== null && stage.appActivationEvents < previousAppEvents) return false;
    if (previousKeyEvents !== null && stage.mainKeyEvents < previousKeyEvents) return false;
    previousAppEvents = stage.appActivationEvents;
    previousKeyEvents = stage.mainKeyEvents;
  }

  return activation.finalAppActivationEvents >= previousAppEvents
    && activation.finalMainKeyEvents >= previousKeyEvents
    && activation.observerRegistered === 2
    && activation.observerRemoved === 2
    && activation.observerInstalled === false
    && activation.appActivationEventDelta === 0
    && activation.mainKeyEventDelta >= 2
    && cleanup.windowHidden === true
    && cleanup.panelActive === false
    && cleanup.nativeOperationsTerminal === true
    && cleanup.observersRemoved === true;
}

/** Validates the bounded Rust main-panel report and independently derives its pass bit. */
export function validateMainPanelNativeReport(value, expectedOwner = {}) {
  const errors = [];
  if (!exactKeys(value, REPORT_KEYS)) return { valid: false, passed: false, errors: ["report-shape"] };

  const ownerValid = validateExpectedOwner(expectedOwner, errors);
  check(errors, value.schemaVersion === 1 && value.kind === "main-panel-prototype"
    && value.journey === "main-panel" && value.scope === "isolated-main-window-panel-prototype",
  "report-contract");
  check(errors, value.identifier === expectedOwner.identifier && value.root === expectedOwner.root
    && value.runId === expectedOwner.runId && value.pid === expectedOwner.pid && uint32(value.pid),
  "report-owner-mismatch");
  check(errors, value.fullProductAcceptance === false && value.visualStatus === "not-captured",
    "report-acceptance-scope");
  check(errors, typeof value.passed === "boolean", "report-passed-type");

  const conversionShape = validateConversionShape(value.conversion);
  const restorationShape = validateRestorationShape(value.restoration);
  const stagesShape = validateStagesShape(value.stages);
  const activationShape = validateActivationShape(value.activation);
  const cleanupShape = validateCleanupShape(value.cleanup);
  const nativeErrorsValid = validateErrors(value.errors);
  check(errors, conversionShape, "conversion-shape");
  check(errors, restorationShape, "restoration-shape");
  check(errors, stagesShape, "stages-shape");
  check(errors, activationShape, "activation-shape");
  check(errors, cleanupShape, "cleanup-shape");
  check(errors, nativeErrorsValid, "report-errors");
  if (activationShape && stagesShape && !reportDeltasConsistent(value.stages, value.activation)) {
    errors.push("event-delta-inconsistent");
  }

  const usableFacts = conversionShape && restorationShape && stagesShape && activationShape && cleanupShape
    && nativeErrorsValid;
  const recomputedPassed = usableFacts && factsPass(value);
  if (value.passed !== recomputedPassed) errors.push("report-pass-mismatch");

  const uniqueErrors = [...new Set(errors)];
  const nativeErrors = nativeErrorsValid ? value.errors : [];
  const valid = uniqueErrors.length === 0;
  return {
    valid,
    passed: valid && ownerValid && recomputedPassed,
    errors: [...new Set([...uniqueErrors, ...nativeErrors])],
  };
}
