const TRACE_KEYS = Object.freeze([
  "schemaVersion", "baseline", "afterOrderFront", "lastVisibility", "afterHide", "visibilitySamples",
]);
const FACT_KEYS = Object.freeze([
  "visible", "occlusionVisible", "onActiveSpace", "windowFocused", "windowKey", "appActive", "appHidden",
  "frontmostIsSelf",
]);
const PHASES = Object.freeze(["baseline", "afterOrderFront", "lastVisibility", "afterHide"]);

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function validateFacts(value, phase, errors) {
  if (value === null) return null;
  if (!exactKeys(value, FACT_KEYS)
      || FACT_KEYS.some(key => !(value[key] === null || typeof value[key] === "boolean"))) {
    errors.push(`presented-window-trace-${phase}-shape`);
    return null;
  }
  return Object.fromEntries(FACT_KEYS.map(key => [key, value[key]]));
}

function isInitialHidden(facts) {
  return facts !== null && facts.visible === false && facts.windowFocused === false
    && facts.windowKey === false && facts.appActive === false && facts.frontmostIsSelf === false;
}

function isSafeAfterOrderFront(facts) {
  return facts !== null && facts.visible === true && facts.windowFocused === false
    && facts.windowKey === false && facts.appActive === false && facts.appHidden === false
    && facts.frontmostIsSelf === false;
}

function isUnfocusedVisible(facts) {
  return facts !== null && facts.visible === true && facts.occlusionVisible === true
    && facts.onActiveSpace === true && facts.windowFocused === false && facts.windowKey === false
    && facts.appActive === false && facts.appHidden === false && facts.frontmostIsSelf === false;
}

function isHiddenAfterClose(facts) {
  return facts !== null && facts.visible === false && facts.windowFocused === false
    && facts.windowKey === false && facts.appActive === false && facts.frontmostIsSelf === false;
}

/** Validates bounded AppKit observations and separately derives whether they support a successful paint run. */
export function validatePresentedWindowTrace(value) {
  const errors = [];
  if (!exactKeys(value, TRACE_KEYS)) {
    return { valid: false, passed: false, errors: ["presented-window-trace-shape"], summary: null };
  }
  if (value.schemaVersion !== 1) errors.push("presented-window-trace-version");

  const phases = Object.fromEntries(PHASES.map(phase => [phase, validateFacts(value[phase], phase, errors)]));
  const sampleCountValid = Number.isSafeInteger(value.visibilitySamples)
    && value.visibilitySamples >= 0 && value.visibilitySamples <= 256;
  if (!sampleCountValid) errors.push("presented-window-trace-visibility-samples");
  else if ((value.visibilitySamples === 0) !== (phases.lastVisibility === null)) {
    errors.push("presented-window-trace-visibility-count");
  }

  const valid = errors.length === 0;
  const passed = valid && isInitialHidden(phases.baseline) && isSafeAfterOrderFront(phases.afterOrderFront)
    && isUnfocusedVisible(phases.lastVisibility) && isHiddenAfterClose(phases.afterHide);
  return {
    valid,
    passed,
    errors,
    summary: {
      schemaVersion: value.schemaVersion === 1 ? 1 : null,
      ...phases,
      visibilitySamples: sampleCountValid ? value.visibilitySamples : null,
    },
  };
}
