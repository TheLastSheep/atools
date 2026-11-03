import assert from "node:assert/strict";
import test from "node:test";
import { summarizeSettingsNativeReport, validateSettingsViewMode } from "./ztools-settings-native-validation.mjs";

const preferenceFields = [
  "showRecentInSearch", "recentRows", "pinnedRows", "searchMode",
  "showMatchRecommendation", "tabKeyFunction", "tabTargetCommand", "spaceOpenCommand",
];

function validReport() {
  return {
    version: 1,
    autoClear: "never",
    passed: true,
    multiwebview: null,
    settingsView: {
      schemaVersion: 2,
      enabled: true,
      passed: true,
      bootstrap: {
        domMounted: true,
        nativeReady: true,
        platform: "darwin",
        launchAtLoginAvailable: true,
        opacityApplied: true,
        sourceTrusted: true,
      },
      entryPoints: {
        button: { mainPluginMode: true, childViews: 1 },
        keyboard: { mainPluginMode: true, childViews: 1 },
      },
      save: { inputChanged: true, committed: true, rawUpdated: true, mainNotified: true },
      reopen: { freshDocument: true, persistedDOM: true },
      preferences: {
        schemaVersion: 1,
        editableFieldCount: 13,
        coldStartup: { passed: true, fieldCount: 13, tabTargetCommandBytes: 2049 },
        fields: preferenceFields.map(field => ({ field, edited: true, committed: true, mainApplied: true, reopened: true })),
        readonlyRejected: true,
        invalidValueRejected: true,
        mainObservation: { searchModeStructure: {
          verified: true, visible: true, mode: "aggregate", selector: ".aggregate-view",
          queryInjected: true, queryRestored: true, resultCount: 1,
          rowCountClaimed: false, unavailableReason: "none",
        } },
      },
      exit: {
        button: { childAbsent: true, layoutRegistrations: 0, searchQueryEmpty: true, searchFocused: true },
        childEscape: { childAbsent: true, layoutRegistrations: 0, searchQueryEmpty: true, searchFocused: true },
      },
      isolation: {
        secretsAbsent: true,
        staleSessionRejected: true,
        genericAppDenied: true,
        coreDenied: true,
        unlistedResourceDenied: true,
      },
      cleanup: { sessions: 0, childViews: 0, layoutRegistrations: 0, pendingCalls: 0, pendingWrites: 0 },
      errors: [],
    },
  };
}

test("settings validator independently accepts every required native evidence field", () => {
  const evidence = validateSettingsViewMode(validReport());
  assert.equal(evidence.valid, true);
  assert.equal(evidence.enabled, true);
  assert.equal(evidence.passed, true);
  assert.deepEqual(evidence.errors, []);
});

test("settings validator rejects every missing or malformed evidence field", () => {
  const invalidators = [
    ["multiwebview", report => { delete report.multiwebview; }],
    ["schemaVersion", report => { report.settingsView.schemaVersion = 1; }],
    ["enabled", report => { report.settingsView.enabled = false; }],
    ["passed", report => { report.settingsView.passed = null; }],
    ["errors", report => { delete report.settingsView.errors; }],
    ["bootstrap.domMounted", report => { report.settingsView.bootstrap.domMounted = false; }],
    ["bootstrap.nativeReady", report => { delete report.settingsView.bootstrap.nativeReady; }],
    ["bootstrap.platform", report => { report.settingsView.bootstrap.platform = "linux"; }],
    ["bootstrap.launchAtLoginAvailable", report => { report.settingsView.bootstrap.launchAtLoginAvailable = null; }],
    ["bootstrap.opacityApplied", report => { report.settingsView.bootstrap.opacityApplied = false; }],
    ["bootstrap.sourceTrusted", report => { report.settingsView.bootstrap.sourceTrusted = false; }],
    ["entryPoints.button.mainPluginMode", report => { report.settingsView.entryPoints.button.mainPluginMode = false; }],
    ["entryPoints.button.childViews", report => { report.settingsView.entryPoints.button.childViews = 2; }],
    ["entryPoints.keyboard.mainPluginMode", report => { report.settingsView.entryPoints.keyboard.mainPluginMode = null; }],
    ["entryPoints.keyboard.childViews", report => { delete report.settingsView.entryPoints.keyboard.childViews; }],
    ["save.inputChanged", report => { report.settingsView.save.inputChanged = false; }],
    ["save.committed", report => { report.settingsView.save.committed = false; }],
    ["save.rawUpdated", report => { report.settingsView.save.rawUpdated = null; }],
    ["save.mainNotified", report => { report.settingsView.save.mainNotified = false; }],
    ["reopen.freshDocument", report => { report.settingsView.reopen.freshDocument = false; }],
    ["reopen.persistedDOM", report => { delete report.settingsView.reopen.persistedDOM; }],
    ["exit.button.childAbsent", report => { report.settingsView.exit.button.childAbsent = false; }],
    ["exit.button.layoutRegistrations", report => { report.settingsView.exit.button.layoutRegistrations = 1; }],
    ["exit.button.searchQueryEmpty", report => { report.settingsView.exit.button.searchQueryEmpty = null; }],
    ["exit.button.searchFocused", report => { report.settingsView.exit.button.searchFocused = false; }],
    ["exit.childEscape.childAbsent", report => { report.settingsView.exit.childEscape.childAbsent = false; }],
    ["exit.childEscape.layoutRegistrations", report => { report.settingsView.exit.childEscape.layoutRegistrations = -1; }],
    ["exit.childEscape.searchQueryEmpty", report => { report.settingsView.exit.childEscape.searchQueryEmpty = false; }],
    ["exit.childEscape.searchFocused", report => { report.settingsView.exit.childEscape.searchFocused = null; }],
    ["isolation.secretsAbsent", report => { report.settingsView.isolation.secretsAbsent = false; }],
    ["isolation.staleSessionRejected", report => { report.settingsView.isolation.staleSessionRejected = false; }],
    ["isolation.genericAppDenied", report => { report.settingsView.isolation.genericAppDenied = null; }],
    ["isolation.coreDenied", report => { report.settingsView.isolation.coreDenied = false; }],
    ["isolation.unlistedResourceDenied", report => { delete report.settingsView.isolation.unlistedResourceDenied; }],
    ["cleanup.sessions", report => { report.settingsView.cleanup.sessions = 1; }],
    ["cleanup.childViews", report => { report.settingsView.cleanup.childViews = null; }],
    ["cleanup.layoutRegistrations", report => { report.settingsView.cleanup.layoutRegistrations = -1; }],
    ["cleanup.pendingCalls", report => { delete report.settingsView.cleanup.pendingCalls; }],
    ["cleanup.pendingWrites", report => { report.settingsView.cleanup.pendingWrites = 2; }],
  ];
  for (const [field, mutate] of invalidators) {
    const report = structuredClone(validReport());
    mutate(report);
    const evidence = validateSettingsViewMode(report);
    assert.equal(evidence.valid, false, `${field} must fail closed`);
    assert.ok(evidence.errors.length > 0, `${field} must produce validation errors`);
  }
  assert.equal(validateSettingsViewMode({ ...validReport(), settingsView: null }).valid, false);
  assert.equal(validateSettingsViewMode({ ...validReport(), settingsView: { ...validReport().settingsView, errors: ["failure"] } }).valid, false);
});

test("settings preference verifier rejects missing, duplicated, malformed or unproven rows", () => {
  const invalidators = [
    report => { delete report.settingsView.preferences; },
    report => { report.settingsView.preferences.schemaVersion = 2; },
    report => { report.settingsView.preferences.editableFieldCount = 5; },
    report => { delete report.settingsView.preferences.coldStartup; },
    report => { report.settingsView.preferences.coldStartup.passed = false; },
    report => { report.settingsView.preferences.coldStartup.fieldCount = 12; },
    report => { report.settingsView.preferences.coldStartup.tabTargetCommandBytes = 0; },
    report => { report.settingsView.preferences.readonlyRejected = false; },
    report => { report.settingsView.preferences.invalidValueRejected = 1; },
    report => { delete report.settingsView.preferences.mainObservation; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.verified = false; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.visible = false; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.mode = "list"; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.queryInjected = false; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.queryRestored = false; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.resultCount = 0; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.resultCount = 1.5; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.rowCountClaimed = true; },
    report => { report.settingsView.preferences.mainObservation.searchModeStructure.unavailableReason = "catalog-empty"; },
    report => { report.settingsView.preferences.fields.pop(); },
    report => { report.settingsView.preferences.fields[0] = null; },
    report => { report.settingsView.preferences.fields[0].field = "unknownSecret"; },
    report => { report.settingsView.preferences.fields[0].field = preferenceFields[1]; },
    report => { report.settingsView.preferences.fields[0].extra = true; },
  ];
  for (let index = 0; index < preferenceFields.length; index += 1) {
    for (const key of ["edited", "committed", "mainApplied", "reopened"]) {
      invalidators.push(report => { report.settingsView.preferences.fields[index][key] = false; });
      invalidators.push(report => { delete report.settingsView.preferences.fields[index][key]; });
    }
  }
  for (const mutate of invalidators) {
    const report = validReport();
    mutate(report);
    assert.equal(validateSettingsViewMode(report).valid, false);
  }
  const reordered = validReport();
  reordered.settingsView.preferences.fields.reverse();
  reordered.settingsView.preferences.mainObservation.source = "observer-only";
  assert.equal(validateSettingsViewMode(reordered).valid, true);
});

test("settings report summary combines generic ownership checks with the settings validator", () => {
  const root = "/private/tmp/native-settings-root";
  const marker = {
    schemaVersion: 1,
    pid: 77721,
    identifier: `dev.atools.renderer-smoke.${"0123456789abcdef0123456789abcdef"}`,
    root,
  };
  const result = summarizeSettingsNativeReport(
    { exists: true, value: validReport(), exception: null },
    { exists: true, value: marker, exception: null },
    { autoClear: "never", fixtureRoot: root, childPid: 77721 }
  );
  assert.equal(result.valid, true);
  assert.equal(result.multiwebview, null);
  assert.equal(result.settingsView.valid, true);
  assert.equal(result.owner.valid, true);
});

