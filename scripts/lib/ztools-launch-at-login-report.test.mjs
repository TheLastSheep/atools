import assert from "node:assert/strict";
import test from "node:test";
import {
  validateLaunchAtLoginReport,
} from "./ztools-launch-at-login-report.mjs";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const OWNER = {
  runId: RUN_ID,
  identifier: `dev.atools.renderer-settings-input.${RUN_ID}`,
  root: `/private/tmp/atools-renderer-settings-input-${RUN_ID}`,
  pid: 42,
};

function report() {
  return {
    schemaVersion: 1,
    journey: "settings-launch-at-login",
    scope: "hidden-original-vue-launch-at-login",
    ...OWNER,
    elapsedMs: 1200,
    attempted: true,
    observations: {
      install: { ownerVerified: true, attempted: true, proofInstalled: true },
      baseline: { routeGeneral: true, controlUnique: true, uiEnabled: false, getterEnabled: false, nativeEnabled: false },
      enable: { routeGeneral: true, controlUnique: true, clickDispatched: true, uiEnabled: true, getterEnabled: true, errorCode: null, nativeEnabled: true },
      freshEnabled: { newSession: true, routeGeneral: true, controlUnique: true, uiEnabled: true, getterEnabled: true, nativeEnabled: true },
      externalDisable: { attempted: true, confirmed: true, nativeEnabled: false },
      conflict: { routeGeneral: true, controlUnique: true, clickDispatched: true, uiEnabled: true, getterEnabled: null, rollbackObserved: true, errorCode: "conflict", nativeEnabled: false },
      freshDisabled: { newSession: true, routeGeneral: true, controlUnique: true, uiEnabled: false, getterEnabled: false, nativeEnabled: false },
      childClosed: true,
      pluginUiOpened: false,
      preloadStarted: false,
      cleanup: { attempted: true, unregistered: true, osEnabled: false, nativeCallsTerminal: true },
    },
    errors: [],
    passed: true,
  };
}

test("launch-at-login report recomputes the complete original-control and OS facts", () => {
  const value = report();
  assert.deepEqual(validateLaunchAtLoginReport(value, OWNER), {
    valid: true,
    passed: true,
    cleanupSafe: true,
    errors: [],
    summary: { observations: value.observations, nativeErrors: [] },
  });
});

test("a self-asserted pass cannot replace failed checkbox, fresh-session, or conflict evidence", () => {
  for (const mutate of [
    value => { value.observations.enable.clickDispatched = false; },
    value => { value.observations.freshEnabled.newSession = false; },
    value => { value.observations.conflict.errorCode = null; },
    value => { value.observations.conflict.getterEnabled = true; },
    value => { value.observations.conflict.getterEnabled = false; },
    value => { value.observations.freshDisabled.getterEnabled = true; },
  ]) {
    const value = report();
    mutate(value);
    assert.equal(validateLaunchAtLoginReport(value, OWNER).passed, false);
  }
});

test("cleanup safety is independent of the journey pass but requires proven unregister and false state", () => {
  const value = report();
  value.errors = ["settings-launch-at-login-conflict-invalid"];
  value.passed = false;
  const failedJourney = validateLaunchAtLoginReport(value, OWNER);
  assert.equal(failedJourney.passed, false);
  assert.equal(failedJourney.cleanupSafe, true);

  for (const mutate of [
    candidate => { candidate.observations.cleanup.unregistered = null; },
    candidate => { candidate.observations.cleanup.osEnabled = true; },
    candidate => { candidate.observations.cleanup.nativeCallsTerminal = false; },
    candidate => { candidate.observations.install.proofInstalled = false; },
    candidate => { candidate.root = `/private/tmp/foreign-${RUN_ID}`; },
  ]) {
    const candidate = report();
    mutate(candidate);
    assert.equal(validateLaunchAtLoginReport(candidate, OWNER).cleanupSafe, false);
  }
});

test("strict report parsing rejects unknown facts, unbounded timing, and non-fixed errors", () => {
  for (const mutate of [
    value => { value.observations.cleanup.extra = true; },
    value => { value.elapsedMs = Infinity; },
    value => { value.errors = ["raw service error"]; },
    value => { value.observations.conflict.errorCode = "SETTINGS_LAUNCH_AT_LOGIN_CONFLICT"; },
    value => { delete value.observations.cleanup.nativeCallsTerminal; },
  ]) {
    const value = report();
    mutate(value);
    assert.equal(validateLaunchAtLoginReport(value, OWNER).valid, false);
  }
});
