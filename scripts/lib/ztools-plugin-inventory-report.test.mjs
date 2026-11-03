import assert from "node:assert/strict";
import test from "node:test";
import {
  PLUGIN_INVENTORY_OBSERVATIONS_FILENAME,
  validatePluginInventoryReport,
} from "./ztools-plugin-inventory-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};

function readiness() {
  return {
    waiterObserved: true,
    pendingListReadCount: 1,
    pendingNativeCalls: 1,
    storeReadyBeforeRelease: false,
    registrationCommitted: true,
    firstListReadCount: 1,
    storeReadyAfterRelease: true,
    timestampMatchCount: 1,
    targetAppCount: 1,
    pluginCatalogSettled: true,
    startupEventDelivered: 1,
    eventInvalidPayloadsAfterStartup: 0,
  };
}

function mutation({ beforeRead, beforeEvent, afterEvent, timestampMatchCount }) {
  return {
    mutationCommitted: true,
    eventListenerReadyBefore: true,
    eventListenerReadyAfter: true,
    eventDeliveredBefore: beforeEvent,
    eventDeliveredAfter: afterEvent,
    eventInvalidPayloadsBefore: 0,
    eventInvalidPayloadsAfter: 0,
    eventCallbackErrorsBefore: 0,
    eventCallbackErrorsAfter: 0,
    listReadBefore: beforeRead,
    listReadAfter: beforeRead + 1,
    storeReady: true,
    timestampMatchCount,
    targetAppCount: 1,
    pluginUiOpened: false,
    preloadStarted: false,
  };
}

function validReport() {
  return {
    schemaVersion: 1,
    journey: "settings-plugin-inventory",
    scope: "hidden-original-vue-plugin-inventory",
    identifier: owner.identifier,
    root: owner.root,
    pid: owner.pid,
    runId,
    readiness: readiness(),
    disable: mutation({ beforeRead: 1, beforeEvent: 1, afterEvent: 2, timestampMatchCount: 0 }),
    restore: mutation({ beforeRead: 2, beforeEvent: 2, afterEvent: 3, timestampMatchCount: 1 }),
    errors: [],
  };
}

test("accepts the exact owner-bound timestamp match transition", () => {
  const result = validatePluginInventoryReport(validReport(), owner);
  assert.equal(PLUGIN_INVENTORY_OBSERVATIONS_FILENAME, "native-plugin-inventory-observations.json");
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.passed, true);
  assert.deepEqual(result.summary.nativeErrors, []);
});

test("filters the timestamp plugin while retaining the OS app result", () => {
  const report = validReport();
  assert.equal(report.disable.timestampMatchCount, 0);
  assert.equal(report.disable.targetAppCount, 1);
  assert.equal(validatePluginInventoryReport(report, owner).passed, true);

  report.disable.timestampMatchCount = 1;
  report.disable.targetAppCount = 0;
  const wrongTarget = validatePluginInventoryReport(report, owner);
  assert.equal(wrongTarget.valid, true);
  assert.equal(wrongTarget.passed, false);
});

test("requires one delivered startup event and carries that baseline into mutations", () => {
  const report = validReport();
  report.readiness.startupEventDelivered = 0;
  report.disable.eventDeliveredBefore = 0;
  report.disable.eventDeliveredAfter = 1;
  const missingStartupEvent = validatePluginInventoryReport(report, owner);
  assert.equal(missingStartupEvent.valid, true);
  assert.equal(missingStartupEvent.passed, false);

  const multipleStartupEvents = validReport();
  multipleStartupEvents.readiness.startupEventDelivered = 2;
  multipleStartupEvents.disable.eventDeliveredBefore = 2;
  multipleStartupEvents.disable.eventDeliveredAfter = 3;
  multipleStartupEvents.restore.eventDeliveredBefore = 3;
  multipleStartupEvents.restore.eventDeliveredAfter = 4;
  assert.equal(validatePluginInventoryReport(multipleStartupEvents, owner).passed, false);
});

test("allows one or two real readiness list reads while preserving count continuity", () => {
  const report = validReport();
  report.readiness.firstListReadCount = 2;
  report.disable.listReadBefore = 2;
  report.disable.listReadAfter = 3;
  report.restore.listReadBefore = 3;
  report.restore.listReadAfter = 4;
  const result = validatePluginInventoryReport(report, owner);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.passed, true);
});

test("rejects missing, extra, and native pass-bit fields", () => {
  for (const mutate of [
    report => { delete report.readiness.waiterObserved; },
    report => { report.disable.extra = true; },
    report => { delete report.restore.targetAppCount; },
    report => { report.passed = true; },
    report => { report.errors = ["unrecognized-native-error"]; },
  ]) {
    const result = validatePluginInventoryReport(mutateAndGet(mutate), owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }
});

test("rejects each mismatched run owner field", () => {
  for (const field of ["runId", "identifier", "root", "pid"]) {
    const report = validReport();
    report[field] = field === "pid" ? owner.pid + 1 : `foreign-${field}`;
    const result = validatePluginInventoryReport(report, owner);
    assert.equal(result.valid, false, field);
    assert.equal(result.passed, false, field);
  }
});

test("null observations stay unknown and can never become zero for a passing report", () => {
  const report = validReport();
  report.readiness.pendingListReadCount = null;
  report.disable.listReadBefore = null;
  report.disable.listReadAfter = 1;
  const result = validatePluginInventoryReport(report, owner);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.equal(result.summary.readiness.pendingListReadCount, null);
  assert.ok(result.errors.includes("plugin-inventory-readiness-incomplete"));
  assert.ok(result.errors.includes("plugin-inventory-disable-transition-invalid"));
});

test("enforces fixed boolean, bounded-count, and native-error array types", () => {
  for (const mutate of [
    report => { report.readiness.waiterObserved = "true"; },
    report => { report.readiness.pendingNativeCalls = -1; },
    report => { report.disable.listReadAfter = 4097; },
    report => { report.restore.eventDeliveredAfter = 1.5; },
    report => { report.errors = ["settings-input-plugin-inventory-runtime-started", "settings-input-plugin-inventory-runtime-started"]; },
    report => { report.errors = new Array(1); },
  ]) {
    const result = validatePluginInventoryReport(mutateAndGet(mutate), owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }
});

test("requires readiness evidence and expected timestamp result counts", () => {
  for (const mutate of [
    report => { report.readiness.waiterObserved = false; },
    report => { report.readiness.pendingNativeCalls = 0; },
    report => { report.readiness.storeReadyBeforeRelease = true; },
    report => { report.readiness.registrationCommitted = false; },
    report => { report.readiness.pluginCatalogSettled = false; },
    report => { report.readiness.eventInvalidPayloadsAfterStartup = 1; },
    report => { report.readiness.firstListReadCount = 3; },
    report => { report.readiness.timestampMatchCount = null; },
    report => { report.disable.timestampMatchCount = 1; },
    report => { report.disable.targetAppCount = null; },
    report => { report.disable.eventCallbackErrorsBefore = 1; },
    report => { report.restore.timestampMatchCount = 0; },
    report => { report.restore.targetAppCount = 0; },
    report => { report.disable.pluginUiOpened = true; },
    report => { report.restore.preloadStarted = true; },
  ]) {
    const result = validatePluginInventoryReport(mutateAndGet(mutate), owner);
    assert.equal(result.valid, true);
    assert.equal(result.passed, false);
  }
});

test("requires one list refresh and one delivered event per committed mutation", () => {
  for (const mutate of [
    report => { report.disable.eventDeliveredAfter = report.disable.eventDeliveredBefore; },
    report => { report.disable.eventDeliveredAfter += 1; },
    report => { report.disable.listReadAfter = report.disable.listReadBefore; },
    report => { report.restore.eventInvalidPayloadsAfter += 1; },
    report => { report.restore.eventCallbackErrorsAfter += 1; },
    report => { report.restore.eventListenerReadyAfter = false; },
    report => { report.restore.listReadBefore += 1; },
    report => { report.restore.eventDeliveredBefore += 1; },
  ]) {
    const result = validatePluginInventoryReport(mutateAndGet(mutate), owner);
    assert.equal(result.valid, true);
    assert.equal(result.passed, false);
  }
});

test("preserves fixed native errors and refuses to pass when any are reported", () => {
  const report = validReport();
  report.errors = ["settings-input-plugin-inventory-runtime-started"];
  const result = validatePluginInventoryReport(report, owner);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.summary.nativeErrors, report.errors);
});

function mutateAndGet(mutate) {
  const report = validReport();
  mutate(report);
  return report;
}
