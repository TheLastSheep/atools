import assert from "node:assert/strict";
import test from "node:test";
import {
  SETTINGS_INPUT_NATIVE_STAGES,
  SETTINGS_INPUT_NATIVE_SCOPE,
  validateSettingsInputNativeReport,
} from "./ztools-settings-input-native-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const firstSession = "11111111111111111111111111111111";
const secondSession = "22222222222222222222222222222222";
const root = `/private/tmp/atools-renderer-settings-input-${runId}`;
const identifier = `dev.atools.renderer-settings-input.${runId}`;
const owner = { runId, root, identifier, pid: 9876 };

function dom({ child = true, route = true, matched = null, restored = null, baseline = 7,
  filtered = 7, empty = true, query = null, childFocus = false } = {}) {
  return {
    mainReady: true, childReady: child, routeValid: child ? route : null,
    matchedCount: child ? matched : null, restoredCount: child ? restored : null,
    inputEmpty: empty, queryMatches: child ? query : null,
    baselineCount: child ? baseline : null, filteredCount: child ? filtered : null,
    mainDocumentHidden: true, mainDocumentHasFocus: false,
    childDocumentHidden: child ? true : null, childDocumentHasFocus: child ? childFocus : null,
  };
}

function native({ active = true, sessionId = firstSession, generation = 1, valueVersion = 0,
  controlSequence = 1, userSequence = 0, valueBytes = 0, inputVisible = active,
  staleInputRejected = null, freshSession = null } = {}) {
  return {
    sessionCount: Number(active), childCount: Number(active), layoutCount: Number(active),
    pendingCalls: 0, pendingWrites: 0, controlSequence, userSequence, valueBytes,
    inputVisible, windowVisible: false, windowFocused: false, focusGainedEvents: 0,
    generation: active ? generation : null, valueVersion: active ? valueVersion : null,
    mainDataStorePersistent: false, childDataStorePersistent: active ? false : null,
    staleInputRejected, freshSession, opaqueSessionId: active ? sessionId : null,
  };
}

function activation(final = false) {
  return {
    known: true, installed: !final, registered: 2, removed: final ? 2 : 0,
    appActive: false, frontmostIsSelf: false, appActivationEvents: 0, mainKeyEvents: 0,
  };
}

function stage(key, options = {}) {
  return {
    key, passed: true, elapsedMs: 3,
    dom: dom(options.dom), native: native(options.native), activation: activation(key === "finalCleanup"),
    presentation: { hiddenSmoke: true, suppressedFocusRequests: key === "startup" ? 0 : 3 },
    errors: [],
  };
}

function searchPins() {
  return {
    initiallyEmpty: true, pinStored: true, pinReadBack: true, mainPinned: true,
    unpinStored: true, unpinReadBack: true, mainUnpinned: true, historyUnchanged: true,
    initialRevision: 7, pinnedRevision: 8, unpinnedRevision: 9,
  };
}

function validReport() {
  const opened = stage("openAllCommands", { dom: { matched: 7 } });
  const match = stage("mainMatch", { dom: { matched: 1, filtered: 1, empty: false, query: true },
    native: { userSequence: 1, valueBytes: 8 } });
  const noMatch = stage("mainNoMatch", { dom: { matched: 0, filtered: 0, empty: false, query: true },
    native: { userSequence: 2, valueBytes: 9 } });
  const clear = stage("mainClear", { dom: { matched: 7, restored: 7, filtered: 7, empty: true, query: true },
    native: { userSequence: 3, valueBytes: 0 } });
  const pinned = stage("pinSearch", { dom: { matched: 7, filtered: 7, empty: true, query: true },
    native: { userSequence: 3, valueBytes: 0 } });
  const childValue = stage("childValueReturn", { dom: { matched: 1, filtered: 1, empty: false, query: true },
    native: { controlSequence: 2, valueVersion: 1, userSequence: 3, valueBytes: 6 } });
  const rotated = stage("ownerRotation", { dom: { baseline: null, filtered: null, matched: null, empty: false, query: null },
    native: { generation: 2, controlSequence: 3, staleInputRejected: true } });
  const closed = stage("closeCleanup", { dom: { child: false }, native: { active: false, valueBytes: 0,
    controlSequence: 3, userSequence: 3 } });
  const reopened = stage("freshReopen", { dom: { matched: 7, filtered: 7, empty: true },
    native: { sessionId: secondSession, freshSession: true, staleInputRejected: true } });
  const unpinned = stage("unpinSearch", { dom: { matched: 7, filtered: 7, empty: true, query: true },
    native: { sessionId: secondSession } });
  const final = stage("finalCleanup", { dom: { child: false }, native: { active: false, valueBytes: 0,
    controlSequence: 1, userSequence: 0 } });
  const stages = [stage("startup", { dom: { child: false }, native: { active: false,
    controlSequence: 0, userSequence: 0, generation: null, valueVersion: null } }),
  opened, match, noMatch, clear, pinned, childValue, rotated, closed, reopened, unpinned, final];
  return {
    schemaVersion: 3, journey: "settings-input", scope: SETTINGS_INPUT_NATIVE_SCOPE,
    identifier, root, pid: owner.pid, runId, autoClear: "never", passed: true,
    timedOut: false, elapsedMs: 150,
    updaterStatus: {
      startupCalls: 1, verifiedCalls: 2, idle: true, unchecked: true, hasUpdate: false,
      hasDownloadedAbsent: true, nativeIdle: true, nativeUnchecked: true,
      nativeUpdateAbsent: true, nativeErrorAbsent: true,
    },
    catalogSelection: { available: true, canonicalNonEmpty: true }, searchPins: searchPins(), stages,
    cleanup: {
      sessionCount: 0, childCount: 0, layoutCount: 0, pendingCalls: 0, pendingWrites: 0,
      observerRemoved: 2, observerRegistered: 2, activationKnown: true, appActive: false,
      frontmostIsSelf: false, focusGainedEvents: 0, appActivationEvents: 0, mainKeyEvents: 0,
    },
    errors: [],
  };
}

test("accepts all twelve observed hidden settings-input stages and complete search-pin evidence", () => {
  const report = validReport();
  assert.deepEqual(report.stages.map(item => item.key), SETTINGS_INPUT_NATIVE_STAGES);
  assert.deepEqual(validateSettingsInputNativeReport(report, owner), { valid: true, passed: true, errors: [] });
});

test("allows a clean zero-count final cleanup without letting an early stop pass", () => {
  const early = validReport();
  for (let index = 1; index < SETTINGS_INPUT_NATIVE_STAGES.length - 1; index += 1) {
    const placeholder = stage(SETTINGS_INPUT_NATIVE_STAGES[index]);
    placeholder.passed = false;
    placeholder.errors = ["settings-input-stage-not-reached"];
    placeholder.presentation = { hiddenSmoke: false, suppressedFocusRequests: 0 };
    early.stages[index] = placeholder;
  }
  early.stages.at(-1).presentation.suppressedFocusRequests = 0;
  early.passed = false;
  early.errors = ["settings-input-stage-not-reached"];

  const result = validateSettingsInputNativeReport(early, owner);
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
  assert.ok(result.errors.includes("openAllCommands-stage-errors"));
  assert.equal(result.errors.includes("finalCleanup-focus-not-suppressed"), false);
  assert.equal(result.errors.includes("stage-focus-suppression-monotonic-finalCleanup"), false);
  assert.equal(result.errors.some(error => error.startsWith("cleanup-")), false);
});

test("rejects a successful run whose final focus-suppression count regresses", () => {
  const report = validReport();
  report.stages.at(-1).presentation.suppressedFocusRequests = 0;
  const result = validateSettingsInputNativeReport(report, owner);
  assert.equal(result.valid, false);
  assert.ok(result.errors.includes("stage-focus-suppression-monotonic-finalCleanup"));
  assert.equal(result.errors.includes("finalCleanup-focus-not-suppressed"), false);
});

test("rejects unknown fields, missing or reordered stages, and any reported error", () => {
  const extraField = validReport();
  extraField.stages[2].dom.inputText = "private";
  assert.equal(validateSettingsInputNativeReport(extraField, owner).valid, false);

  const missingStage = validReport();
  missingStage.stages.pop();
  assert.equal(validateSettingsInputNativeReport(missingStage, owner).valid, false);

  const reordered = validReport();
  [reordered.stages[2], reordered.stages[3]] = [reordered.stages[3], reordered.stages[2]];
  assert.equal(validateSettingsInputNativeReport(reordered, owner).valid, false);

  const errored = validReport();
  errored.stages[2].errors = ["bounded-native-error"];
  assert.equal(validateSettingsInputNativeReport(errored, owner).valid, false);
});

test("accepts only schema v3 and rejects stale reports from schemas v1 and v2", () => {
  for (const schemaVersion of [1, 2]) {
    const report = validReport();
    report.schemaVersion = schemaVersion;
    const result = validateSettingsInputNativeReport(report, owner);
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("report-identity"));
  }
});

test("requires every search-pin storage, readback, DOM, and history proof", () => {
  for (const key of Object.keys(searchPins()).slice(0, 8)) {
    const report = validReport();
    report.searchPins[key] = false;
    assert.ok(validateSettingsInputNativeReport(report, owner).errors.includes(`search-pins-${key}`));
  }

  const extraField = validReport();
  extraField.searchPins.targetPath = "/private";
  assert.ok(validateSettingsInputNativeReport(extraField, owner).errors.includes("search-pins-shape"));

  const missingField = validReport();
  delete missingField.searchPins.mainPinned;
  assert.ok(validateSettingsInputNativeReport(missingField, owner).errors.includes("search-pins-shape"));
});

test("requires safe consecutive revisions for pin and unpin", () => {
  for (const mutate of [
    value => { value.searchPins.pinnedRevision = value.searchPins.initialRevision; },
    value => { value.searchPins.unpinnedRevision += 2; },
    value => { value.searchPins.initialRevision = Number.MAX_SAFE_INTEGER + 1; },
    value => { value.searchPins.pinnedRevision = 1.5; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validateSettingsInputNativeReport(report, owner).valid, false);
  }
});

test("requires stale identity rejection at both rotation and fresh reopen only", () => {
  for (const [stageIndex, values] of [[7, [null, false]], [9, [null, false]]]) {
    for (const staleInputRejected of values) {
      const report = validReport();
      report.stages[stageIndex].native.staleInputRejected = staleInputRejected;
      assert.equal(validateSettingsInputNativeReport(report, owner).valid, false);
    }
  }

  const staleOutsideOwnerStages = validReport();
  staleOutsideOwnerStages.stages[2].native.staleInputRejected = true;
  assert.equal(validateSettingsInputNativeReport(staleOutsideOwnerStages, owner).valid, false);
});

test("requires actual matching, no-match, clear, pin, reverse-value, and stale-owner evidence", () => {
  for (const mutate of [
    value => { value.stages[2].dom.filteredCount = 0; },
    value => { value.stages[3].dom.filteredCount = 1; },
    value => { value.stages[4].dom.restoredCount = 6; },
    value => { value.stages[5].native.controlSequence += 1; },
    value => { value.stages[6].native.userSequence += 1; },
    value => { value.stages[7].native.staleInputRejected = false; },
    value => { value.stages[9].native.opaqueSessionId = firstSession; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validateSettingsInputNativeReport(report, owner).valid, false);
  }
});

test("rejects a visible or focused window, activation evidence, and unfinished cleanup", () => {
  for (const mutate of [
    value => { value.stages[3].native.windowFocused = true; },
    value => { value.stages[4].activation.mainKeyEvents = 1; },
    value => { value.stages[6].presentation.hiddenSmoke = false; },
    value => { value.cleanup.pendingWrites = 1; },
    value => { value.cleanup.observerRemoved = 1; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validateSettingsInputNativeReport(report, owner).valid, false);
  }
  const regressedSuppression = validReport();
  regressedSuppression.stages[6].presentation.suppressedFocusRequests = 1;
  assert.equal(validateSettingsInputNativeReport(regressedSuppression, owner).valid, false);
  const startupSuppression = validReport();
  startupSuppression.stages[0].presentation.suppressedFocusRequests = 1;
  assert.ok(validateSettingsInputNativeReport(startupSuppression, owner).errors.includes("startup-focus-count-not-zero"));
});

test("requires the single initial and explicit updater reads without downloaded status", () => {
  const report = validReport();
  report.updaterStatus.startupCalls = 2;
  assert.equal(validateSettingsInputNativeReport(report, owner).valid, false);
  const withDownloaded = validReport();
  withDownloaded.updaterStatus.hasDownloaded = false;
  assert.equal(validateSettingsInputNativeReport(withDownloaded, owner).valid, false);
});
