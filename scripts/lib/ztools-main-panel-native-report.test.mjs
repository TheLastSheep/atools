import assert from "node:assert/strict";
import test from "node:test";
import { validateMainPanelNativeReport } from "./ztools-main-panel-native-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = Object.freeze({
  root: `/private/tmp/atools-renderer-smoke-${runId}`,
  runId,
  identifier: `dev.atools.renderer-smoke.${runId}`,
  pid: 43210,
});

function classAssessment() {
  return {
    kind: "tao",
    actualClass: "TaoWindow",
    reportedClass: "TaoWindow",
    actualSuperclass: "NSWindow",
    actualInstanceSize: 512,
    taoInstanceSize: 512,
    ownIvarCount: 0,
    ownMethodNames: [],
    taoDirectSuperclassIsNsWindow: true,
  };
}

function conversion(textInputMethodAdded = false) {
  return {
    scopedIdentifierMatches: true,
    mainWindowHiddenBeforeConversion: true,
    sameNativeWindow: true,
    originalClass: "TaoWindow",
    originalClassAssessment: classAssessment(),
    panelClass: "AToolsMainPanel",
    originalInstanceSize: 512,
    panelInstanceSize: 256,
    taoFocusableOffset: 400,
    nsPanelOwnIvarCount: 0,
    focusableLayoutSafe: true,
    isPanel: true,
    panelClassMatches: true,
    nonactivatingStyle: true,
    selectorAvailable: true,
    canBecomeKey: true,
    canBecomeMain: false,
    stillHidden: true,
    originalDelegateUnchanged: true,
    contentViewAndParentUnchanged: true,
    collectionBehaviorUnchanged: true,
    releasedWhenClosedUnchanged: true,
    subviewMasksAdjusted: true,
    level: 9,
    floating: true,
    hidesOnDeactivate: false,
    becomesKeyOnlyIfNeeded: false,
    subviewCount: 4,
    textInputMethodAdded,
    runtimeMethodLifetime: "until-process-exit",
    runtimeMethodRemovalSupported: false,
  };
}

function restoration(textInputMethodRemains = false) {
  return {
    sameNativeWindow: true,
    originalClassRestored: true,
    originalDelegateRestored: true,
    releasedWhenClosedRestored: true,
    subviewMasksRestored: true,
    contentViewRestored: true,
    styleMaskRestored: true,
    levelRestored: true,
    collectionBehaviorRestored: true,
    hidesOnDeactivateRestored: true,
    canBecomeKeyRestored: true,
    canBecomeMainRestored: true,
    panelFloatingBaselineRestored: true,
    panelBecomesKeyBaselineRestored: true,
    windowRestored: true,
    textInputMethodRemains,
    runtimeMethodLifetime: "until-process-exit",
    runtimeMethodRemovalSupported: false,
  };
}

function foreground(stage, appActive) {
  const shown = stage === "shown" || stage === "reshown";
  return {
    appActive,
    appHidden: shown ? false : false,
    frontmostIsSelf: false,
    mainWindowAvailable: true,
    mainVisible: shown,
    mainKey: shown,
    mainFocused: shown,
    mainOnActiveSpace: shown,
    mainOcclusionVisible: shown,
  };
}

function stage(name, appActive, appEvents, keyEvents, baseAppEvents, baseKeyEvents) {
  return {
    foreground: foreground(name, appActive),
    frontmostMatchesBaseline: true,
    inputFound: true,
    inputFocused: name === "shown" || name === "reshown",
    documentVisible: name === "shown" || name === "reshown",
    documentHasFocus: name === "shown" || name === "reshown",
    contentViewStable: true,
    appActivationEvents: appEvents,
    appActivationEventDelta: appEvents - baseAppEvents,
    mainKeyEvents: keyEvents,
    mainKeyEventDelta: keyEvents - baseKeyEvents,
  };
}

function validReport(appActive = false, textMethod = false) {
  const baselineAppEvents = 3;
  const baselineKeyEvents = 10;
  return {
    schemaVersion: 1,
    kind: "main-panel-prototype",
    journey: "main-panel",
    scope: "isolated-main-window-panel-prototype",
    ...owner,
    fullProductAcceptance: false,
    visualStatus: "not-captured",
    conversion: conversion(textMethod),
    restoration: restoration(textMethod),
    stages: {
      baseline: stage("baseline", appActive, 3, 10, baselineAppEvents, baselineKeyEvents),
      shown: stage("shown", appActive, 3, 11, baselineAppEvents, baselineKeyEvents),
      hidden: stage("hidden", appActive, 3, 11, baselineAppEvents, baselineKeyEvents),
      reshown: stage("reshown", appActive, 3, 12, baselineAppEvents, baselineKeyEvents),
    },
    activation: {
      baselineAppActivationEvents: baselineAppEvents,
      finalAppActivationEvents: 3,
      appActivationEventDelta: 0,
      baselineMainKeyEvents: baselineKeyEvents,
      finalMainKeyEvents: 12,
      mainKeyEventDelta: 2,
      observerRegistered: 2,
      observerRemoved: 2,
      observerInstalled: false,
    },
    cleanup: {
      windowHidden: true,
      panelActive: false,
      nativeOperationsTerminal: true,
      observersRemoved: true,
    },
    errors: [],
    passed: true,
  };
}

function kvoReport() {
  const report = validReport();
  const assessment = report.conversion.originalClassAssessment;
  report.conversion.originalClass = "NSKVONotifying_TaoWindow";
  Object.assign(assessment, {
    kind: "foundation-kvo-content-view",
    actualClass: "NSKVONotifying_TaoWindow",
    reportedClass: "TaoWindow",
    actualSuperclass: "TaoWindow",
    ownIvarCount: 0,
    ownMethodNames: ["_isKVOA", "class", "dealloc", "setContentView:"],
  });
  return report;
}

function partialReport(error = "main-panel-prototype-panel-install-failed") {
  return {
    schemaVersion: 1,
    kind: "main-panel-prototype",
    journey: "main-panel",
    scope: "isolated-main-window-panel-prototype",
    ...owner,
    fullProductAcceptance: false,
    visualStatus: "not-captured",
    conversion: null,
    restoration: null,
    stages: { baseline: null, shown: null, hidden: null, reshown: null },
    activation: {
      baselineAppActivationEvents: null,
      finalAppActivationEvents: null,
      appActivationEventDelta: null,
      baselineMainKeyEvents: null,
      finalMainKeyEvents: null,
      mainKeyEventDelta: null,
      observerRegistered: null,
      observerRemoved: null,
      observerInstalled: null,
    },
    cleanup: {
      windowHidden: null,
      panelActive: null,
      nativeOperationsTerminal: true,
      observersRemoved: null,
    },
    errors: [error],
    passed: false,
  };
}

function expectSemanticFailure(change, appActive = false) {
  const report = structuredClone(validReport(appActive));
  change(report);
  report.passed = false;
  const result = validateMainPanelNativeReport(report, owner);
  assert.equal(result.valid, true, result.errors.join(","));
  assert.equal(result.passed, false);
}

test("recomputes a complete report for either stable baseline app-active state", () => {
  for (const active of [false, true]) {
    const result = validateMainPanelNativeReport(validReport(active), owner);
    assert.deepEqual(result, { valid: true, passed: true, errors: [] });
  }
});

test("accepts the exact Foundation KVO content-view subclass assessment", () => {
  const result = validateMainPanelNativeReport(kvoReport(), owner);
  assert.deepEqual(result, { valid: true, passed: true, errors: [] });
});

test("requires exact KVO ancestry, layout, reported class and complete method facts", () => {
  const cases = [
    report => { report.conversion.originalClassAssessment.ownMethodNames.push("setTitle:"); },
    report => { report.conversion.originalClassAssessment.ownIvarCount = 1; },
    report => { report.conversion.originalClassAssessment.actualSuperclass = "NSObject"; },
    report => { report.conversion.originalClassAssessment.actualInstanceSize += 8; },
    report => { report.conversion.originalClassAssessment.reportedClass = "OtherWindow"; },
    report => { report.conversion.originalClassAssessment.taoDirectSuperclassIsNsWindow = false; },
    report => { report.conversion.originalClass = "TaoWindow"; },
  ];
  for (const change of cases) {
    const report = kvoReport();
    change(report);
    report.passed = false;
    const result = validateMainPanelNativeReport(report, owner);
    assert.equal(result.valid, true, result.errors.join(","));
    assert.equal(result.passed, false);
  }

  const malformed = kvoReport();
  malformed.conversion.originalClassAssessment.ownMethodNames = null;
  malformed.passed = false;
  assert.equal(validateMainPanelNativeReport(malformed, owner).valid, false);

  const reportedClassType = kvoReport();
  reportedClassType.conversion.originalClassAssessment.reportedClass = 7;
  reportedClassType.passed = false;
  assert.equal(validateMainPanelNativeReport(reportedClassType, owner).valid, false);

  const unsortedMethods = kvoReport();
  unsortedMethods.conversion.originalClassAssessment.ownMethodNames.reverse();
  unsortedMethods.passed = false;
  assert.equal(validateMainPanelNativeReport(unsortedMethods, owner).valid, false);
});

test("requires paired text-input method facts to agree whether added or already present", () => {
  assert.equal(validateMainPanelNativeReport(validReport(false, true), owner).passed, true);
  expectSemanticFailure(report => { report.restoration.textInputMethodRemains = !report.conversion.textInputMethodAdded; });
  expectSemanticFailure(report => { report.conversion.textInputMethodAdded = null; });
  expectSemanticFailure(report => { report.restoration.textInputMethodRemains = null; });
});

test("keeps a schema-valid failed partial report red while preserving unknown facts", () => {
  const result = validateMainPanelNativeReport(partialReport(), owner);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.errors, ["main-panel-prototype-panel-install-failed"]);
});

test("rejects mismatched owner, non-private roots and malformed run identifiers", () => {
  const report = validReport();
  assert.equal(validateMainPanelNativeReport(report, { ...owner, pid: owner.pid + 1 }).valid, false);
  for (const malformed of [
    { ...owner, root: `/tmp/atools-renderer-smoke-${runId}` },
    { ...owner, root: `/private/tmp/atools-renderer-smoke-${"f".repeat(32)}` },
    { ...owner, runId: "../" },
    { ...owner, identifier: "dev.atools.renderer-smoke.other" },
    { ...owner, pid: 0 },
  ]) {
    assert.equal(validateMainPanelNativeReport(report, malformed).valid, false);
  }
});

test("rejects unknown fields and wrong nested field types", () => {
  const malformed = [
    report => { report.extra = true; },
    report => { report.conversion.extra = true; },
    report => { delete report.conversion.originalClassAssessment; },
    report => { report.conversion.originalClassAssessment.extra = true; },
    report => { report.stages.shown.foreground.extra = false; },
    report => { report.activation.observerRegistered = "2"; },
    report => { report.cleanup.nativeOperationsTerminal = null; },
    report => { report.stages.baseline.documentVisible = null; },
    report => { delete report.stages.shown.contentViewStable; },
    report => { report.conversion.level = "9"; },
    report => { report.restoration.runtimeMethodRemovalSupported = 0; },
    report => { report.errors = ["unknown-error"]; },
    report => { report.errors.push(report.errors[0]); },
  ];
  for (const change of malformed) {
    const report = structuredClone(validReport());
    change(report);
    report.passed = false;
    assert.equal(validateMainPanelNativeReport(report, owner).valid, false);
  }
});

test("rejects an optimistic declared pass and an inconsistent event delta", () => {
  const optimistic = validReport();
  optimistic.conversion.level = 8;
  assert.equal(validateMainPanelNativeReport(optimistic, owner).valid, false);

  const inconsistent = validReport();
  inconsistent.passed = false;
  inconsistent.stages.shown.mainKeyEventDelta = 2;
  assert.equal(validateMainPanelNativeReport(inconsistent, owner).valid, false);

  const activationMismatch = validReport();
  activationMismatch.passed = false;
  activationMismatch.activation.appActivationEventDelta = 1;
  assert.equal(validateMainPanelNativeReport(activationMismatch, owner).valid, false);
});

test("does not green semantic failures in panel layout, restoration, lifecycle or observations", () => {
  const cases = [
    report => { report.conversion.panelClass = "NSPanel"; },
    report => { report.conversion.nsPanelOwnIvarCount = 1; },
    report => { report.conversion.taoFocusableOffset = report.conversion.originalInstanceSize; },
    report => { report.conversion.canBecomeKey = false; },
    report => { report.conversion.hidesOnDeactivate = true; },
    report => { report.restoration.levelRestored = false; },
    report => { report.stages.baseline.foreground.appActive = null; },
    report => { report.stages.baseline.documentHasFocus = true; },
    report => { report.stages.shown.foreground.mainVisible = false; },
    report => { report.stages.shown.documentVisible = false; },
    report => { report.stages.hidden.documentHasFocus = true; },
    report => { report.stages.reshown.documentVisible = false; },
    report => { report.stages.shown.foreground.appActive = true; },
    report => { report.activation.observerRegistered = 1; },
    report => { report.activation.observerInstalled = true; },
    report => { report.cleanup.panelActive = true; },
    report => { report.cleanup.observersRemoved = false; },
  ];
  for (const change of cases) expectSemanticFailure(change);
});

test("unknown event observations remain valid partial evidence but cannot pass", () => {
  expectSemanticFailure(report => {
    report.stages.shown.mainKeyEvents = null;
    report.stages.shown.mainKeyEventDelta = null;
  });
});

test("requires a positive content-view stability observation in every stage", () => {
  for (const name of ["baseline", "shown", "hidden", "reshown"]) {
    for (const value of [false, null]) {
      expectSemanticFailure(report => { report.stages[name].contentViewStable = value; });
    }
  }
});

