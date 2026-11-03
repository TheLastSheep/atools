import test from "node:test";
import assert from "node:assert/strict";
import { validateClipboardContextReport } from "./ztools-clipboard-native-report.mjs";

const RUN_ID = "0123456789abcdef0123456789abcdef";
const owner = {
  runId: RUN_ID,
  identifier: `dev.atools.renderer-clipboard.${RUN_ID}`,
  root: `/private/tmp/atools-renderer-clipboard-${RUN_ID}`,
  pid: 7123,
};
const HASH = "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";
const ASSETS = {
  runtimeAssetCount: 4,
  runtimeAssetBytes: 1024,
  javascriptAssetCount: 2,
  fallbackSettingsAssets: null,
};

function validReport() {
  return {
    schemaVersion: 1,
    journey: "clipboard-context",
    scope: "isolated-original-main-clipboard-context",
    ...owner,
    elapsedMs: 9000,
    source: {
      journey: "clipboard-context",
      renderer: "unchanged-original-vue",
      genericReportAbsent: true,
      documentRoot: true,
      searchInputCount: 1,
      clipboardGetterAvailable: true,
      readerCommandObserved: true,
      assets: { ...ASSETS },
    },
    stages: {
      ready: {
        probeReady: true,
        documentVisibility: "hidden",
        documentHasFocus: false,
        mainWindowVisible: false,
        mainWindowFocused: false,
        searchInputCount: 1,
        clipboardGetterAvailable: true,
      },
      textEmpty: {
        pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1,
        inputEmpty: true, textChipMatches: true, launchContextObserved: true,
      },
      textSelection: {
        pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1,
        inputValueMatches: true, selectionMatches: true, launchContextObserved: true,
      },
      image: {
        pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1,
        imageChipMatches: true, naturalWidth: 1, naturalHeight: 1, launchContextObserved: true,
      },
      file: {
        pasteCanceled: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1,
        fileChipMatches: true, fileNameMatches: true, launchContextObserved: true,
        pasteboardChangeCountBefore: 13, pasteboardChangeCountAfter: 13,
      },
      expiredSameCount: {
        getterReturnedNull: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1,
        changeCountBefore: 13, changeCountAfter: 13,
        changeCountUnchanged: true, launchContextUnchanged: true,
      },
      empty: {
        getterReturnedNull: true, clipboardCommandDelta: 1, boardSnapshotDelta: 1,
        uiUnchanged: true, launchContextUnchanged: true,
      },
      denied: {
        getterRejected: true, clipboardCommandDelta: 1, boardSnapshotDelta: 0,
        uiUnchanged: true, launchContextUnchanged: true, deniedTaskRun: true, deniedAudit: true,
      },
    },
    counters: {
      clipboardCommandCalls: 7,
      boardSnapshots: 6,
      boardChangeCountReads: 8,
      pasteboardChangeCountBefore: 10,
      pasteboardChangeCountAfter: 15,
      backgroundCaptures: 0,
      writesRejected: 0,
      pastesRejected: 0,
    },
    taskRuns: {
      before: 0, after: 7, succeeded: 6, cancelled: 1, other: 0,
      allTerminal: true, summaryOnly: true, rawPayloadAbsent: true,
    },
    audits: {
      before: 0, after: 7, confirmed: 6, denied: 1, other: 0,
      finalized: true, metadataOnly: true, rawPayloadAbsent: true,
    },
    history: {
      beforeCount: 0, afterCount: 0, beforeSha256: HASH, afterSha256: HASH,
      unchanged: true, fixtureContentAbsent: true, nativeBeforeEmpty: true, nativeAfterEmpty: true,
    },
    runtime: {
      activePluginAbsent: true, activeTaskRuns: 0, mcpStatusAbsent: true,
      pasteboardCaptureTaskAbsent: true, nodeSidecarStarted: null, pluginRuntimeStarted: null,
    },
    cleanup: {
      boardCleared: true, boardClearVerified: true, permissionRestored: true, mainWindowPresent: true,
      settingsWindowCount: 0, pluginWindowCount: 0, pendingProbeCount: 0, pendingCommandCount: 0,
      adapterOutstandingNativeCalls: 0, taskRunsTerminal: true, auditsTerminal: true,
      mediaPermitsBefore: 2, mediaPermitsAfter: 2, probeDisposed: true,
    },
    errors: [],
    declaredPassed: true,
    fullProductAcceptance: false,
  };
}

const validate = report => validateClipboardContextReport(report, owner, { expectedAssetSummary: ASSETS });

test("strict clipboard sidecar independently passes its scoped journey evidence", () => {
  const result = validate(validReport());
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.nativeErrors.length, 0);
});

test("partial null observations retain valid shape but cannot pass", () => {
  const report = validReport();
  report.stages.expiredSameCount.changeCountUnchanged = null;
  report.declaredPassed = false;
  const result = validate(report);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  const earlyFailure = validReport();
  earlyFailure.source.searchInputCount = null;
  earlyFailure.source.clipboardGetterAvailable = null;
  earlyFailure.source.assets.runtimeAssetBytes = null;
  earlyFailure.stages.ready.probeReady = null;
  earlyFailure.declaredPassed = false;
  const partial = validate(earlyFailure);
  assert.equal(partial.valid, true);
  assert.equal(partial.passed, false);
});

test("the denied call is observed but must not snapshot or return clipboard data", () => {
  const report = validReport();
  report.stages.denied.boardSnapshotDelta = 1;
  report.counters.boardSnapshots = 7;
  report.declaredPassed = false;
  assert.equal(validate(report).passed, false);
  const notRejected = validReport();
  notRejected.stages.denied.getterRejected = false;
  notRejected.declaredPassed = false;
  assert.equal(validate(notRejected).passed, false);
  const changedContext = validReport();
  changedContext.stages.denied.launchContextUnchanged = false;
  changedContext.declaredPassed = false;
  const contextResult = validate(changedContext);
  assert.equal(contextResult.valid, true);
  assert.equal(contextResult.passed, false);
  const unknownContext = validReport();
  unknownContext.stages.denied.launchContextUnchanged = null;
  unknownContext.declaredPassed = false;
  const unknownContextResult = validate(unknownContext);
  assert.equal(unknownContextResult.valid, true);
  assert.equal(unknownContextResult.passed, false);
});

test("task, audit and history facts prevent fixture payload persistence", () => {
  const taskReport = validReport();
  taskReport.taskRuns.rawPayloadAbsent = false;
  taskReport.declaredPassed = false;
  assert.equal(validate(taskReport).passed, false);
  const auditReport = validReport();
  auditReport.audits.metadataOnly = false;
  auditReport.declaredPassed = false;
  assert.equal(validate(auditReport).passed, false);
  const historyReport = validReport();
  historyReport.history.fixtureContentAbsent = false;
  historyReport.declaredPassed = false;
  assert.equal(validate(historyReport).passed, false);
  const nativeItemsPresent = validReport();
  nativeItemsPresent.history.nativeBeforeEmpty = false;
  nativeItemsPresent.history.nativeAfterEmpty = false;
  nativeItemsPresent.declaredPassed = false;
  assert.equal(nativeItemsPresent.history.beforeCount, 0);
  assert.equal(nativeItemsPresent.history.beforeSha256, HASH);
  assert.equal(validate(nativeItemsPresent).valid, true);
  assert.equal(validate(nativeItemsPresent).passed, false);
  const nativeItemsUnknown = validReport();
  nativeItemsUnknown.history.nativeAfterEmpty = null;
  nativeItemsUnknown.declaredPassed = false;
  assert.equal(nativeItemsUnknown.history.beforeCount, 0);
  assert.equal(nativeItemsUnknown.history.beforeSha256, HASH);
  assert.equal(validate(nativeItemsUnknown).valid, true);
  assert.equal(validate(nativeItemsUnknown).passed, false);
  const unknownInitialNativeItems = validReport();
  unknownInitialNativeItems.history.nativeBeforeEmpty = null;
  unknownInitialNativeItems.declaredPassed = false;
  assert.equal(validate(unknownInitialNativeItems).valid, false);
  assert.equal(validate(unknownInitialNativeItems).passed, false);
  const fabricatedEmptyHash = validReport();
  fabricatedEmptyHash.history.beforeSha256 = "a".repeat(64);
  fabricatedEmptyHash.history.afterSha256 = "a".repeat(64);
  fabricatedEmptyHash.declaredPassed = false;
  assert.equal(validate(fabricatedEmptyHash).passed, false);
});

test("owner, missing sidecar, exact schema, and declared pass are enforced", () => {
  const report = validReport();
  assert.equal(validateClipboardContextReport({ ...report, pid: owner.pid + 1 }, owner, { expectedAssetSummary: ASSETS }).identityValid, false);
  assert.equal(validateClipboardContextReport(report, owner, { exists: false, expectedAssetSummary: ASSETS }).passed, false);
  assert.equal(validate({ ...report, passed: true }).valid, false);
  const falseFacts = validReport();
  falseFacts.stages.file.fileNameMatches = false;
  assert.equal(validate(falseFacts).passed, false);
  const dishonestDeclaredPass = validReport();
  dishonestDeclaredPass.stages.file.fileNameMatches = false;
  assert.equal(validate(dishonestDeclaredPass).errors.includes("clipboard-declared-pass-mismatch"), true);
});

test("bounded counters, fixed errors, assets, and cleanup are hard gates", () => {
  const oversized = validReport();
  oversized.counters.boardChangeCountReads = 4097;
  assert.equal(validate(oversized).valid, false);
  const knownFailure = validReport();
  knownFailure.errors = ["clipboard-context-stage-failed"];
  knownFailure.declaredPassed = false;
  const failureResult = validate(knownFailure);
  assert.equal(failureResult.valid, true);
  assert.equal(failureResult.passed, false);
  assert.deepEqual(failureResult.nativeErrors, knownFailure.errors);
  const unknownError = validReport();
  unknownError.errors = ["arbitrary-error"];
  unknownError.declaredPassed = false;
  assert.equal(validate(unknownError).valid, false);
  const dirtyCleanup = validReport();
  dirtyCleanup.cleanup.adapterOutstandingNativeCalls = 1;
  dirtyCleanup.declaredPassed = false;
  assert.equal(validate(dirtyCleanup).passed, false);
  assert.equal(validateClipboardContextReport(validReport(), owner, {
    expectedAssetSummary: { ...ASSETS, runtimeAssetCount: 5 },
  }).passed, false);
  const fallbackMounted = validReport();
  fallbackMounted.source.assets.fallbackSettingsAssets = { javascriptAssetCount: 1 };
  fallbackMounted.declaredPassed = false;
  assert.equal(validate(fallbackMounted).valid, false);
});

test("unknown runtime registries and unknown observations are not converted to green facts", () => {
  const report = validReport();
  report.runtime.nodeSidecarStarted = false;
  report.declaredPassed = false;
  assert.equal(validate(report).passed, false);
  const unknownVisibility = validReport();
  unknownVisibility.stages.ready.documentVisibility = null;
  unknownVisibility.declaredPassed = false;
  assert.equal(validate(unknownVisibility).passed, false);
  const unknownDomFocus = validReport();
  unknownDomFocus.stages.ready.documentHasFocus = null;
  unknownDomFocus.declaredPassed = false;
  assert.equal(validate(unknownDomFocus).passed, false);
  const visibleFocusedDom = validReport();
  visibleFocusedDom.stages.ready.documentVisibility = "visible";
  visibleFocusedDom.stages.ready.documentHasFocus = true;
  assert.equal(validate(visibleFocusedDom).passed, true);
  const unknownNativeWindow = validReport();
  unknownNativeWindow.stages.ready.mainWindowVisible = null;
  unknownNativeWindow.declaredPassed = false;
  assert.equal(validate(unknownNativeWindow).valid, true);
  assert.equal(validate(unknownNativeWindow).passed, false);
  const shownNativeWindow = validReport();
  shownNativeWindow.stages.ready.mainWindowVisible = true;
  shownNativeWindow.declaredPassed = false;
  assert.equal(validate(shownNativeWindow).passed, false);
});

test("file-to-expiry count continuity and fixed task baselines cannot be fabricated", () => {
  const changedFile = validReport();
  changedFile.stages.expiredSameCount.changeCountBefore += 1;
  changedFile.declaredPassed = false;
  assert.equal(validate(changedFile).passed, false);
  const nonemptyDatabase = validReport();
  nonemptyDatabase.taskRuns.before = 1;
  nonemptyDatabase.taskRuns.after = 8;
  nonemptyDatabase.declaredPassed = false;
  assert.equal(validate(nonemptyDatabase).passed, false);
});
