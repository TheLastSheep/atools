import assert from "node:assert/strict";
import test from "node:test";
import { validateNativePaintDiagnostics } from "./ztools-native-paint-diagnostics.mjs";

function snapshot() {
  return {
    sidebar: {
      generalUnique: true,
      generalActive: true,
      generalColorComparable: true,
      generalColorUsesPrimary: true,
      shortcutUnique: true,
      shortcutInactive: true,
      shortcutColorComparable: true,
      shortcutColorUsesText: true,
    },
    menus: { total: 0, body: 0, theme: 0, leave: 0, enter: 0, ownersOpen: 0, visible: 0 },
  };
}

function record(nativeSchedulingPolicy = "none") {
  return {
    nativeSchedulingPolicy,
    observations: {
      documentHidden: true,
      before: snapshot(),
      after: snapshot(),
      rafCallbacks: 0,
      elapsedMs: 2000,
      timedOut: true,
    },
  };
}

function diagnostics(light = record("none"), dark = record("throttle")) {
  return { light, dark };
}

test("accepts bounded observations for each fixed policy without a pass flag", () => {
  for (const policy of ["none", "suspend", "throttle", "unsupported"]) {
    const result = validateNativePaintDiagnostics(diagnostics(record(policy), null));
    assert.equal(result.valid, true, JSON.stringify(result));
    assert.equal(result.summary.light.state, "observed");
    assert.equal(result.summary.light.nativeSchedulingPolicy, policy);
    assert.equal(Object.hasOwn(result.summary.light, "passed"), false);
  }
});

test("rejects missing root and record fields, malformed shapes, and unknown policies", () => {
  assert.equal(validateNativePaintDiagnostics(undefined).valid, false);

  const missingRecordField = diagnostics();
  delete missingRecordField.light.observations;
  assert.equal(validateNativePaintDiagnostics(missingRecordField).valid, false);

  const missingNestedField = diagnostics();
  delete missingNestedField.dark.observations.after.sidebar.generalActive;
  assert.equal(validateNativePaintDiagnostics(missingNestedField).valid, false);

  const unknownPolicy = diagnostics(record("disabled"));
  const result = validateNativePaintDiagnostics(unknownPolicy);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("paint-diagnostics-light-native-scheduling-policy"));
});

test("rejects nonboolean sidebar facts and menu counts outside 0 through 64", () => {
  for (const mutate of [
    value => { value.light.observations.before.sidebar.generalUnique = 1; },
    value => { value.light.observations.after.menus.total = 65; },
    value => { value.dark.observations.before.menus.body = -1; },
    value => { value.dark.observations.after.menus.visible = 1.5; },
  ]) {
    const value = diagnostics();
    mutate(value);
    assert.equal(validateNativePaintDiagnostics(value).valid, false);
  }
});

test("bounds RAF, elapsed time, timeout, and document visibility types", () => {
  const boundary = diagnostics();
  assert.equal(validateNativePaintDiagnostics(boundary).valid, true);

  for (const mutate of [
    value => { value.light.observations.rafCallbacks = 3; },
    value => { value.light.observations.rafCallbacks = -1; },
    value => { value.light.observations.elapsedMs = Infinity; },
    value => { value.light.observations.elapsedMs = 2000.1; },
    value => { value.light.observations.timedOut = 1; },
    value => { value.dark.observations.documentHidden = "true"; },
  ]) {
    const value = diagnostics();
    mutate(value);
    assert.equal(validateNativePaintDiagnostics(value).valid, false);
  }
});

test("null diagnostics remain explicitly unverified", () => {
  const result = validateNativePaintDiagnostics(diagnostics(null, null));
  assert.equal(result.valid, true);
  assert.deepEqual(result.summary, {
    light: { state: "unverified", reason: "diagnostics-unavailable" },
    dark: { state: "unverified", reason: "diagnostics-unavailable" },
  });
});
