import assert from "node:assert/strict";
import test from "node:test";
import { validatePresentedWindowTrace } from "./ztools-presented-window-trace.mjs";

const baseline = {
  visible: false, occlusionVisible: false, onActiveSpace: false, windowFocused: false,
  windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
};
const afterOrderFront = {
  visible: true, occlusionVisible: false, onActiveSpace: false, windowFocused: false,
  windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
};
const lastVisibility = {
  visible: true, occlusionVisible: true, onActiveSpace: true, windowFocused: false,
  windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
};
const afterHide = {
  visible: false, occlusionVisible: false, onActiveSpace: false, windowFocused: false,
  windowKey: false, appActive: false, appHidden: false, frontmostIsSelf: false,
};

function trace(overrides = {}) {
  return {
    schemaVersion: 1,
    baseline: structuredClone(baseline),
    afterOrderFront: structuredClone(afterOrderFront),
    lastVisibility: structuredClone(lastVisibility),
    afterHide: structuredClone(afterHide),
    visibilitySamples: 1,
    ...overrides,
  };
}

test("accepts the exact bounded trace and allows WindowServer publication lag after orderFront", () => {
  const result = validatePresentedWindowTrace(trace());
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.summary.afterOrderFront, afterOrderFront);
});

test("preserves unknown fields without treating null as false", () => {
  const sample = trace();
  sample.baseline.occlusionVisible = null;
  sample.baseline.appHidden = null;
  sample.afterOrderFront.occlusionVisible = null;
  sample.afterOrderFront.onActiveSpace = null;
  sample.afterHide.occlusionVisible = null;
  sample.afterHide.onActiveSpace = null;
  sample.afterHide.appHidden = null;
  const result = validatePresentedWindowTrace(sample);
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.summary.baseline.appHidden, null);
  assert.deepEqual(result.summary.afterOrderFront, sample.afterOrderFront);
});

test("afterOrderFront requires known non-activation facts but preserves failed observations", () => {
  const keys = ["windowFocused", "windowKey", "appActive", "appHidden", "frontmostIsSelf"];
  for (const key of keys) {
    for (const value of [true, null]) {
      const sample = trace();
      sample.afterOrderFront[key] = value;
      const result = validatePresentedWindowTrace(sample);
      assert.equal(result.valid, true, `${key}=${value}`);
      assert.equal(result.passed, false, `${key}=${value}`);
      assert.equal(result.summary.afterOrderFront[key], value);
    }
  }

  for (const value of [false, null]) {
    const sample = trace();
    sample.afterOrderFront.visible = value;
    const result = validatePresentedWindowTrace(sample);
    assert.equal(result.valid, true, `visible=${value}`);
    assert.equal(result.passed, false, `visible=${value}`);
  }

  const unobserved = validatePresentedWindowTrace(trace({
    afterOrderFront: Object.fromEntries(Object.keys(afterOrderFront).map(key => [key, null])),
  }));
  assert.equal(unobserved.valid, true);
  assert.equal(unobserved.passed, false);
});

test("accepts an empty trace structure as a failed observation", () => {
  const result = validatePresentedWindowTrace(trace({
    baseline: null,
    afterOrderFront: null,
    lastVisibility: null,
    afterHide: null,
    visibilitySamples: 0,
  }));
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.equal(result.summary.visibilitySamples, 0);
});

test("false observations remain valid but every required safety fact gates success", () => {
  const cases = [
    { phase: "baseline", key: "visible", value: true },
    { phase: "baseline", key: "windowFocused", value: null },
    { phase: "baseline", key: "frontmostIsSelf", value: null },
    { phase: "lastVisibility", key: "occlusionVisible", value: false },
    { phase: "lastVisibility", key: "onActiveSpace", value: null },
    { phase: "lastVisibility", key: "visible", value: null },
    { phase: "lastVisibility", key: "onActiveSpace", value: false },
    { phase: "lastVisibility", key: "windowFocused", value: true },
    { phase: "lastVisibility", key: "windowKey", value: true },
    { phase: "lastVisibility", key: "appActive", value: true },
    { phase: "lastVisibility", key: "appHidden", value: true },
    { phase: "lastVisibility", key: "frontmostIsSelf", value: null },
    { phase: "afterHide", key: "visible", value: true },
    { phase: "afterHide", key: "visible", value: null },
    { phase: "afterHide", key: "windowFocused", value: null },
    { phase: "afterHide", key: "windowFocused", value: true },
    { phase: "afterHide", key: "windowKey", value: true },
    { phase: "afterHide", key: "appActive", value: true },
    { phase: "afterHide", key: "frontmostIsSelf", value: null },
  ];
  for (const { phase, key, value } of cases) {
    const sample = trace();
    sample[phase][key] = value;
    const result = validatePresentedWindowTrace(sample);
    assert.equal(result.valid, true, `${phase}.${key}`);
    assert.equal(result.passed, false, `${phase}.${key}`);
  }

  const missingOrderFront = validatePresentedWindowTrace(trace({ afterOrderFront: null }));
  assert.equal(missingOrderFront.valid, true);
  assert.equal(missingOrderFront.passed, false);
});

test("rejects extra keys, fact type errors, unsupported versions, and bad sample counts", () => {
  const cases = [
    trace({ unexpected: true }),
    trace({ schemaVersion: 2 }),
    trace({ lastVisibility: { ...lastVisibility, userPath: "/private/tmp/secret" } }),
    trace({ afterHide: { ...afterHide, appHidden: "unknown" } }),
    trace({ visibilitySamples: -1 }),
    trace({ visibilitySamples: 257 }),
    trace({ lastVisibility: null, visibilitySamples: 1 }),
    trace({ visibilitySamples: 0 }),
  ];
  for (const sample of cases) {
    const result = validatePresentedWindowTrace(sample);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
    assert.equal(JSON.stringify(result).includes("/private/tmp/secret"), false);
  }
});

test("accepts both ends of the bounded visibility sample range when consistent", () => {
  assert.equal(validatePresentedWindowTrace(trace({ visibilitySamples: 1 })).valid, true);
  const maximum = validatePresentedWindowTrace(trace({ visibilitySamples: 256 }));
  assert.equal(maximum.valid, true);
  assert.equal(maximum.summary.visibilitySamples, 256);
});
