import assert from "node:assert/strict";
import test from "node:test";
import { buildCatalogNativeArgs, parseCatalogNativeArgs } from "../test-ztools-catalog-native.mjs";
import {
  summarizeWindowDragNativeReport,
  validateWindowDragNativeReport,
} from "./ztools-window-drag-native-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const fixtureRoot = `/private/tmp/atools-renderer-catalog-${runId}`;
const childPid = 7281;
const expectedIdentifier = `dev.atools.renderer-smoke.${runId}`;
const originalDocumentId = "0123456789abcdef0123456789abcdef";
const reloadedDocumentId = "abcdef0123456789abcdef0123456789";

function drag(overrides = {}) {
  return {
    pending: 0, queued: 0, inFlight: null, pendingPositionReads: 0, queuedMoves: 0, queuedLocks: 0,
    positionReads: 1, moveRequests: 0, lockRequests: 0, dispatchedPositions: 1, dispatchedMoves: 0,
    dispatchedLocks: 0, coalescedMoves: 0, rejectedOperations: 0, failures: 0, cancelledReads: 0,
    droppedAfterDispose: 0, disposed: false, ...overrides,
  };
}

function dom(index) {
  const values = [
    { drag: drag(), calls: 1, expands: 0, hides: 0 },
    { drag: drag({ positionReads: 2, moveRequests: 3, lockRequests: 1, dispatchedPositions: 2,
      dispatchedMoves: 2, dispatchedLocks: 1, coalescedMoves: 1 }), calls: 4, expands: 0, hides: 0 },
    { drag: drag({ positionReads: 2, moveRequests: 3, lockRequests: 1, dispatchedPositions: 2,
      dispatchedMoves: 2, dispatchedLocks: 1, coalescedMoves: 1 }), calls: 4, expands: 1, hides: 0 },
    { drag: drag({ positionReads: 2, moveRequests: 3, lockRequests: 2, dispatchedPositions: 2,
      dispatchedMoves: 2, dispatchedLocks: 2, coalescedMoves: 1 }), calls: 5, expands: 1, hides: 0 },
    { drag: drag({ positionReads: 2, moveRequests: 4, lockRequests: 2, dispatchedPositions: 2,
      dispatchedMoves: 3, dispatchedLocks: 2, coalescedMoves: 1 }), calls: 6, expands: 2, hides: 0 },
    { drag: drag({ positionReads: 2, moveRequests: 4, lockRequests: 3, dispatchedPositions: 2,
      dispatchedMoves: 3, dispatchedLocks: 3, coalescedMoves: 1 }), calls: 7, expands: 2, hides: 0 },
    { drag: drag({ positionReads: 2, moveRequests: 4, lockRequests: 3, dispatchedPositions: 2,
      dispatchedMoves: 3, dispatchedLocks: 3, coalescedMoves: 1 }), calls: 7, expands: 2, hides: 1 },
    { drag: drag({ positionReads: 2, moveRequests: 6, lockRequests: 4, dispatchedPositions: 2,
      dispatchedMoves: 5, dispatchedLocks: 4, coalescedMoves: 2 }), calls: 8, expands: 2, hides: 1 },
    { drag: drag(), calls: 1, expands: 0, hides: 0 },
    { drag: drag({ positionReads: 1, moveRequests: 3, lockRequests: 2, dispatchedPositions: 1,
      dispatchedMoves: 2, dispatchedLocks: 2, coalescedMoves: 1 }), calls: 6, expands: 1, hides: 0 },
  ][index];
  return {
    searchBoxFound: true,
    inputEmpty: true,
    documentVisibility: "hidden",
    documentHasFocus: false,
    documentId: index < 8 ? originalDocumentId : reloadedDocumentId,
    positionRead: index === 0 || index === 8 ? (index === 0 ? { x: 100, y: 200 } : { x: 108, y: 206 }) : null,
    outstandingNativeCalls: 0,
    rendererWindowDragCalls: values.calls,
    expandWindowCalls: values.expands,
    hideWindowCalls: values.hides,
    windowNotificationPendingReplies: 0,
    windowNotificationFailures: 0,
    drag: values.drag,
  };
}

function native(index) {
  const values = [
    { position: { x: 100, y: 200 }, innerSize: { width: 520, height: 420 }, locked: false },
    { position: { x: 120, y: 215 }, innerSize: { width: 520, height: 420 }, locked: true },
    { position: { x: 120, y: 215 }, innerSize: { width: 520, height: 444 }, locked: true },
    { position: { x: 120, y: 215 }, innerSize: { width: 520, height: 444 }, locked: false },
    { position: { x: 100, y: 200 }, innerSize: { width: 520, height: 420 }, locked: false },
    { position: { x: 100, y: 200 }, innerSize: { width: 520, height: 420 }, locked: true },
    { position: { x: 100, y: 200 }, innerSize: { width: 520, height: 420 }, locked: false },
    { position: { x: 108, y: 206 }, innerSize: { width: 520, height: 420 }, locked: true },
    { position: { x: 108, y: 206 }, innerSize: { width: 520, height: 420 }, locked: false },
    { position: { x: 100, y: 200 }, innerSize: { width: 520, height: 420 }, locked: false },
  ][index];
  const reloaded = index >= 8;
  return {
    ...values,
    scaleFactor: 2,
    visible: false,
    focused: false,
    focusGainedEvents: 0,
    activeChildLayouts: 0,
    childWebviews: 0,
    dataStorePersistent: false,
    documentGeneration: reloaded ? 1 : 0,
    pageLoadStarts: reloaded ? 1 : 0,
    pageLoadFinishes: reloaded ? 1 : 0,
    documentId: reloaded ? reloadedDocumentId : originalDocumentId,
  };
}

function report() {
  return {
    schemaVersion: 2,
    journey: "window-drag",
    scope: "hidden-original-vue-searchbox-events",
    runId,
    identifier: expectedIdentifier,
    root: fixtureRoot,
    pid: childPid,
    passed: true,
    errors: [],
    stages: ["baseline", "dragged", "resized", "released", "restored", "hide-locked",
      "hidden-cleared", "redragged", "navigated", "recovered"].map((stage, index) => ({
      stage,
      elapsedMs: [100, 180, 240, 300, 380, 440, 500, 560, 620, 700][index],
      dom: dom(index),
      native: native(index),
      errors: [],
    })),
  };
}

const identity = { runId, fixtureRoot, childPid, expectedIdentifier };

test("window-drag validator accepts only the full ten-stage hidden owner-bound journey", () => {
  assert.deepEqual(validateWindowDragNativeReport(report(), identity), {
    journey: "window-drag", valid: true, passed: true, errors: [],
  });
});

test("window-drag validator rejects identity, schema, or stage omissions", () => {
  const invalid = [
    value => { value.root = "/private/tmp/another-run"; },
    value => { value.pid += 1; },
    value => { value.runId = "ffffffffffffffffffffffffffffffff"; },
    value => { value.schemaVersion = 1; },
    value => { value.unreviewed = true; },
    value => { value.stages.pop(); },
    value => { value.stages[2].stage = "dragged"; },
    value => { value.errors.push("window-drag-failed"); },
  ];
  for (const mutate of invalid) {
    const value = report();
    mutate(value);
    assert.equal(validateWindowDragNativeReport(value, identity).valid, false);
  }
});

test("window-drag validator requires Native movement, size lock, resize, release, and restoration", () => {
  const invalid = [
    value => { value.stages[1].native.position.x = 118; },
    value => { value.stages[1].native.locked = null; },
    value => { value.stages[2].native.innerSize.height = 420; },
    value => { value.stages[3].native.locked = true; },
    value => { value.stages[4].native.position.y = 202; },
    value => { value.stages[0].dom.positionRead.x = 101; },
    value => { value.stages[1].dom.drag.failures = 1; },
    value => { value.stages[1].dom.documentVisibility = "visible"; },
    value => { value.stages[0].dom.inputEmpty = false; },
    value => { value.stages[0].native.focused = true; },
  ];
  for (const mutate of invalid) {
    const value = report();
    mutate(value);
    assert.equal(validateWindowDragNativeReport(value, identity).valid, false);
  }
});

test("window-drag lifecycle requires actual hide clearing, same-document redrag, and reloaded recovery", () => {
  const invalid = [
    value => { value.stages[5].native.locked = false; },
    value => { value.stages[6].native.locked = true; },
    value => { value.stages[7].native.position.x = 120; },
    value => { value.stages[7].native.locked = false; },
    value => { value.stages[8].native.locked = true; },
    value => { value.stages[8].native.documentGeneration = 0; },
    value => { value.stages[6].dom.hideWindowCalls = 0; },
    value => { value.stages[8].dom.drag.moveRequests = 1; },
    value => { value.stages[9].native.position.y = 202; },
    value => { value.stages[9].dom.drag.lockRequests = 0; },
  ];
  for (const mutate of invalid) {
    const value = report();
    mutate(value);
    assert.equal(validateWindowDragNativeReport(value, identity).valid, false);
  }
});

test("window-drag validator binds all DOM document ids to Native lifecycle counters", () => {
  const invalid = [
    value => { value.stages[2].dom.documentId = "bad"; },
    value => { value.stages[2].native.documentId = reloadedDocumentId; },
    value => { value.stages[8].native.pageLoadStarts = 2; },
    value => { value.stages[9].dom.documentId = originalDocumentId; },
    value => { value.stages[7].native.documentId = reloadedDocumentId; },
  ];
  for (const mutate of invalid) {
    const value = report();
    mutate(value);
    assert.equal(validateWindowDragNativeReport(value, identity).valid, false);
  }
});

test("navigated Vue mount may resize while fresh drag counters remain reset", () => {
  const value = report();
  value.stages[8].dom.expandWindowCalls = 1;
  value.stages[9].dom.expandWindowCalls = 2;
  assert.equal(validateWindowDragNativeReport(value, identity).valid, true);

  for (const mutate of [
    item => { item.stages[8].dom.drag.lockRequests = 1; },
    item => { item.stages[8].dom.drag.moveRequests = 1; },
  ]) {
    const invalid = report();
    mutate(invalid);
    assert.equal(validateWindowDragNativeReport(invalid, identity).valid, false);
  }
});

test("window-drag validator and summary reject arbitrary malformed nested evidence without throwing", () => {
  const invalid = [
    value => { value.stages[0] = null; },
    value => { value.stages[1] = null; },
    value => { value.stages[9] = null; },
    value => { value.stages[0].dom = null; },
    value => { value.stages[0].native = null; },
    value => { value.stages = value.stages.slice(0, 1); },
    value => { value.stages[0].elapsedMs = null; },
    value => { value.stages[0].dom.drag = null; },
  ];
  for (const mutate of invalid) {
    const value = report();
    mutate(value);
    assert.doesNotThrow(() => validateWindowDragNativeReport(value, identity));
    assert.equal(validateWindowDragNativeReport(value, identity).valid, false);
  }

  for (const file of [null, undefined, {}, { exists: true, exception: null, value: null }]) {
    assert.doesNotThrow(() => summarizeWindowDragNativeReport(file, identity));
    assert.equal(summarizeWindowDragNativeReport(file, identity).valid, false);
  }
});

test("runner accepts a strict optional window-drag flag and only forwards true", () => {
  const args = ["--binary", "/tmp/native", "--build-receipt", "/tmp/receipt.json"];
  assert.equal(parseCatalogNativeArgs(args).windowDrag, false);
  assert.equal(parseCatalogNativeArgs([...args, "--window-drag", "false"]).windowDrag, false);
  assert.equal(parseCatalogNativeArgs([...args, "--window-drag", "true"]).windowDrag, true);
  for (const invalid of ["yes", "1", "TRUE"]) {
    assert.throws(() => parseCatalogNativeArgs([...args, "--window-drag", invalid]));
  }
  assert.throws(() => parseCatalogNativeArgs([...args, "--window-drag", "true", "--window-drag", "false"]));

  const nativeArgs = buildCatalogNativeArgs({
    fixtureRoot, rendererDist: "/tmp/dist", output: "/tmp/catalog.json", runId,
  });
  assert.equal(nativeArgs.includes("--window-drag"), false);
  const enabled = buildCatalogNativeArgs({
    fixtureRoot, rendererDist: "/tmp/dist", output: "/tmp/catalog.json", runId, windowDrag: true,
  });
  assert.deepEqual(enabled.slice(-2), ["--window-drag", "true"]);
});
