import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCatalogNativeArgs,
  parseCatalogNativeArgs,
  validateCatalogProvenance,
} from "../test-ztools-catalog-native.mjs";
import {
  CATALOG_NATIVE_SCOPE,
  summarizeCatalogNativeReport,
  validateCatalogNativeMode,
} from "./ztools-catalog-native-report.mjs";

const fixtureRoot = "/private/tmp/atools-renderer-catalog-01234567-89ab-cdef-0123-456789abcdef";
const runId = "0123456789abcdef0123456789abcdef";
const childPid = 78921;
const marker = {
  schemaVersion: 1,
  pid: childPid,
  identifier: `dev.atools.renderer-smoke.${runId}`,
  root: fixtureRoot,
};

test("catalog preflight binds measured JavaScript bytes and preserves both resource budgets", () => {
  const commit = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
  const treeSha256 = "a".repeat(64);
  const manifest = { source: { commit }, build: {
    budgetMilestone: "original-vue-settings-input-2026-10-27",
    previousTotalJavaScriptBytes: 587945, maxIncrementalJavaScriptBytes: 1879,
    totalJavaScriptBudgetBytes: 589824,
  } };
  const upstream = { commit, dirty: "", files: 61, sha256: treeSha256 };
  const provenance = { sourceCommit: commit, sourceFiles: 61, sourceTreeSha256: treeSha256,
    bundle: { totalJavaScriptBytes: 588068 } };
  assert.doesNotThrow(() => validateCatalogProvenance(manifest, provenance, upstream, 588068));
  const atLimit = structuredClone(provenance);
  atLimit.bundle.totalJavaScriptBytes = 587945 + 1879;
  assert.doesNotThrow(() => validateCatalogProvenance(manifest, atLimit, upstream, 587945 + 1879));
  assert.throws(() => validateCatalogProvenance(manifest, provenance, upstream, 588069), /emitted chunks/);
  for (const bytes of [589825, 0, NaN]) {
    const changed = structuredClone(provenance);
    changed.bundle.totalJavaScriptBytes = bytes;
    assert.throws(() => validateCatalogProvenance(manifest, changed, upstream, bytes));
  }
  const overIncrement = structuredClone(provenance);
  overIncrement.bundle.totalJavaScriptBytes = 587945 + 1880;
  assert.throws(() => validateCatalogProvenance(manifest, overIncrement, upstream, 587945 + 1880));
  assert.throws(() => validateCatalogProvenance(manifest, provenance, { ...upstream, dirty: "M source" }, 588068));
});
const events = [0, 1, 2, 2, 2];
const appCalls = [1, 2, 3, 4, 4];
const witnessEvents = [0, 1, 2, 2, 3];
const appCatalogSubscribers = [2, 2, 2, 0, 0];
const stageTitles = [
  ["ATools Catalog Initial"],
  ["ATools Catalog Added", "ATools Catalog Initial"],
  ["ATools Catalog Initial"],
  ["ATools Catalog Initial"],
  ["ATools Catalog Initial"],
];

function eventSource(name, index) {
  return {
    subscribers: name === "appCatalog" ? appCatalogSubscribers[index] : index < 3 ? 1 : 0,
    listenerState: index < 3 ? "listening" : "disposed",
    deliveredEvents: name === "appCatalog" ? events[index] : 0,
    registrationErrors: 0,
    callbackErrors: 0,
    registrationsPending: 0,
    cleanupPending: 0,
    cleanupErrors: 0,
  };
}

function stage(index) {
  const disposed = index >= 3;
  const names = ["initial", "added", "removed", "disposed", "post-dispose"];
  return {
    stage: names[index],
    elapsedMs: [100, 300, 600, 800, 1100][index],
    dom: {
      inputFound: true,
      inputValue: "ATools Catalog",
      titles: stageTitles[index],
      documentVisibility: "hidden",
      documentHasFocus: false,
      appListCalls: appCalls[index],
      catalogDeliveredEvents: events[index],
      catalogSubscriberCount: appCatalogSubscribers[index],
      pendingNativeCalls: 0,
      appReadPending: false,
      disposed,
      icon: index < 2 ? { complete: true, width: 64, height: 64, analysisSucceeded: true } : null,
      eventSources: Object.fromEntries(["focusEvents", "appState", "contextMenu", "appCatalog"]
        .map(name => [name, eventSource(name, index)])),
      settingsView: { listenerState: disposed ? "disposed" : "listening", registrationErrors: 0, cleanupErrors: 0 },
      nativeCatalogEvents: witnessEvents[index],
      witnessStopped: index === 4,
    },
    native: {
      visible: false,
      focused: false,
      focusGainedEvents: 0,
      activeChildLayouts: 0,
      childWebviews: 0,
      dataStorePersistent: false,
      catalogItems: [1, 2, 1, 1, 2][index],
    },
    errors: [],
  };
}

function validReport() {
  return {
    schemaVersion: 1,
    journey: "catalog",
    scope: CATALOG_NATIVE_SCOPE,
    identifier: marker.identifier,
    root: fixtureRoot,
    pid: childPid,
    autoClear: "never",
    passed: true,
    metadata: {
      ownedFixture: true,
      rootCount: 1,
      windowPolicy: "hidden-no-foreground",
      dataStorePersistent: false,
    },
    clipboard: { reads: 0, writes: 0, pastes: 0 },
    staleLaunch: {
      rejected: true,
      taskRunsBefore: 0,
      taskRunsAfter: 0,
      historyBefore: 0,
      historyAfter: 0,
    },
    errors: [],
    stages: [0, 1, 2, 3, 4].map(stage),
  };
}

function validate(report = validReport(), owner = marker) {
  return validateCatalogNativeMode(report, {
    autoClear: "never", marker: owner, fixtureRoot, childPid,
    expectedIdentifier: `dev.atools.renderer-smoke.${runId}`,
  });
}

test("catalog report accepts only the complete hidden five-stage contract and exact owner", () => {
  const report = validReport();
  assert.deepEqual(validate(report), { journey: "catalog", valid: true, passed: true, errors: [] });
  const summary = summarizeCatalogNativeReport(
    { exists: true, value: report, exception: null },
    { exists: true, value: marker, exception: null },
    { autoClear: "never", fixtureRoot, childPid, expectedIdentifier: `dev.atools.renderer-smoke.${runId}` },
  );
  assert.equal(summary.valid, true);
  assert.equal(summary.metadataMatchesOwner, true);
  assert.equal(summary.evidence.stages.length, 5);
  assert.equal(summary.evidence.stages[4].dom.witnessStopped, true);
});

test("catalog report rejects an open or malformed top-level identity/schema", () => {
  for (const mutate of [
    value => { value.journey = "multiwebview"; },
    value => { value.scope = "visible-ui"; },
    value => { value.root = "/private/tmp/other"; },
    value => { value.pid += 1; },
    value => { value.identifier = "dev.atools.renderer-smoke.invalid"; },
    value => { value.autoClear = "immediately"; },
    value => { value.unreviewedSecret = "hidden-token"; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validate(report).valid, false);
  }
});

test("catalog report rejects owner mismatch, failure, errors, and persistent or unowned metadata", () => {
  const wrongMarker = { ...marker, pid: childPid + 1 };
  assert.equal(validate(validReport(), wrongMarker).valid, false);
  const wrongIdentifier = { ...marker, identifier: "dev.atools.renderer-smoke.ffffffffffffffffffffffffffffffff" };
  assert.equal(validate(validReport(), wrongIdentifier).valid, false);
  for (const mutate of [
    value => { value.passed = false; },
    value => { value.errors.push("catalog-watch-timeout"); },
    value => { value.metadata.ownedFixture = false; },
    value => { value.metadata.rootCount = 2; },
    value => { value.metadata.windowPolicy = "foreground"; },
    value => { value.metadata.dataStorePersistent = null; },
    value => { value.clipboard.reads = 1; },
    value => { value.staleLaunch.rejected = false; },
    value => { value.staleLaunch.taskRunsAfter = 1; },
    value => { value.staleLaunch.historyBefore = 1; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validate(report).valid, false);
  }
});

test("catalog stages enforce exact ordering, bounded elapsed time, query, sorted titles, and icon evidence", () => {
  for (const mutate of [
    value => { [value.stages[0], value.stages[1]] = [value.stages[1], value.stages[0]]; },
    value => { value.stages[2].stage = "post-dispose"; },
    value => { value.stages[3].elapsedMs = value.stages[2].elapsedMs - 1; },
    value => { value.stages[4].elapsedMs = 120_001; },
    value => { value.stages[1].dom.titles.reverse(); },
    value => { value.stages[0].dom.inputValue = "private query"; },
    value => { value.stages[0].dom.icon.width = 32; },
    value => { value.stages[1].dom.icon.analysisSucceeded = false; },
    value => { value.stages[4].dom.icon = { complete: true, width: 64, height: 64, analysisSucceeded: true }; },
    value => { value.stages[0].dom.icon.src = "atools-app-icon://secret"; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validate(report).valid, false);
  }
});

test("catalog proof rejects focus, visible native window, child/layout, and unknown native state", () => {
  for (const mutate of [
    value => { value.stages[0].dom.documentHasFocus = true; },
    value => { value.stages[0].dom.documentVisibility = "prerender"; },
    value => { value.stages[1].native.focused = true; },
    value => { value.stages[0].native.visible = true; },
    value => { value.stages[0].native.focusGainedEvents = 1; },
    value => { value.stages[0].native.activeChildLayouts = 1; },
    value => { value.stages[0].native.childWebviews = 1; },
    value => { value.stages[0].native.dataStorePersistent = null; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validate(report).valid, false);
  }
});

test("catalog DOM visibility stays hidden and removed-stage icon remains null", () => {
  for (let index = 0; index < 5; index += 1) {
    const report = validReport();
    report.stages[index].dom.documentVisibility = "visible";
    assert.equal(validate(report).valid, false, `stage ${report.stages[index].stage}`);
  }
  const report = validReport();
  report.stages[2].dom.icon = { complete: true, width: 64, height: 64, analysisSucceeded: true };
  assert.equal(validate(report).valid, false, "removed stage must not report another icon analysis");
});

test("catalog refresh and disposal require real listener state, progressing witness, and stable adapter after dispose", () => {
  for (const mutate of [
    value => { value.stages[1].dom.appListCalls = value.stages[0].dom.appListCalls; },
    value => { value.stages[1].dom.catalogDeliveredEvents = value.stages[0].dom.catalogDeliveredEvents; },
    value => { value.stages[2].dom.nativeCatalogEvents = value.stages[1].dom.nativeCatalogEvents; },
    value => { value.stages[4].dom.nativeCatalogEvents = value.stages[3].dom.nativeCatalogEvents; },
    value => { value.stages[4].dom.catalogDeliveredEvents += 1; },
    value => { value.stages[4].dom.appListCalls += 1; },
    value => { value.stages[4].dom.eventSources.appCatalog.deliveredEvents += 1; },
    value => { value.stages[1].dom.eventSources.appCatalog.listenerState = "failed"; },
    value => { value.stages[2].dom.eventSources.contextMenu.cleanupPending = 1; },
    value => { value.stages[3].dom.settingsView.listenerState = "listening"; },
    value => { value.stages[4].dom.witnessStopped = false; },
    value => { value.stages[2].dom.disposed = true; },
    value => { value.stages[4].dom.appReadPending = true; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.equal(validate(report).valid, false);
  }
});

test("malformed stage entries return structured invalid evidence instead of throwing", () => {
  for (const mutate of [
    value => { value.stages[1].dom = null; },
    value => { delete value.stages[1].dom; },
    value => { value.stages[2] = null; },
    value => { value.stages[4].dom = null; },
  ]) {
    const report = validReport();
    mutate(report);
    assert.doesNotThrow(() => validate(report));
    assert.equal(validate(report).valid, false);
    let summary;
    assert.doesNotThrow(() => {
      summary = summarizeCatalogNativeReport(
        { exists: true, value: report },
        { exists: true, value: marker },
        { autoClear: "never", fixtureRoot, childPid, expectedIdentifier: `dev.atools.renderer-smoke.${runId}` },
      );
    });
    assert.equal(summary.valid, false);
  }
});

test("catalog summary distinguishes missing and unreadable reports without leaking unreviewed fields", () => {
  const absent = summarizeCatalogNativeReport(
    { exists: false, value: null, exception: { code: "ENOENT" } },
    { exists: false, value: null },
    { fixtureRoot, childPid },
  );
  assert.equal(absent.valid, false);
  assert.deepEqual(absent.validationErrors, ["native-report-missing"]);

  const report = validReport();
  report.secret = "not-for-summary";
  report.stages[0].dom.extraPath = "/Users/private/secret";
  report.stages[0].native.visible = { token: "nested-secret" };
  report.stages[0].dom.eventSources.appCatalog.listenerState = { path: "/private/path" };
  report.clipboard.reads = { token: "clipboard-secret" };
  const summary = summarizeCatalogNativeReport(
    { exists: true, value: report },
    { exists: true, value: marker },
    { autoClear: "never", fixtureRoot, childPid, expectedIdentifier: `dev.atools.renderer-smoke.${runId}` },
  );
  assert.equal(summary.valid, false);
  assert.equal(JSON.stringify(summary).includes("not-for-summary"), false);
  assert.equal(JSON.stringify(summary).includes("/Users/private/secret"), false);
  assert.equal(JSON.stringify(summary).includes("nested-secret"), false);
  assert.equal(JSON.stringify(summary).includes("clipboard-secret"), false);
  assert.equal(summary.evidence.stages[0].native.visible, null);
  assert.equal(summary.evidence.clipboard.reads, null);
});

test("catalog CLI requires exactly absolute binary and receipt overrides", () => {
  assert.deepEqual(parseCatalogNativeArgs(["--binary", "/tmp/native", "--build-receipt", "/tmp/receipt.json"]), {
    binary: "/tmp/native", buildReceipt: "/tmp/receipt.json", windowDrag: false,
  });
  for (const argv of [
    [],
    ["--binary", "/tmp/native"],
    ["--build-receipt", "/tmp/receipt.json"],
    ["--binary", "relative", "--build-receipt", "/tmp/receipt.json"],
    ["--binary", "/tmp/native", "--build-receipt", "relative"],
    ["--binary", "/tmp/native", "--binary", "/tmp/other", "--build-receipt", "/tmp/receipt.json"],
    ["--mode", "launcher"],
  ]) assert.throws(() => parseCatalogNativeArgs(argv));
});

test("catalog child argv uses multiwebview resources and adds only the catalog journey", () => {
  const args = buildCatalogNativeArgs({
    fixtureRoot,
    rendererDist: "/repo/packages/ztools-renderer/dist",
    output: "/repo/output/catalog-native.json",
    runId,
  });
  assert.deepEqual(args, [
    "--fixture-root", fixtureRoot,
    "--renderer-dist", "/repo/packages/ztools-renderer/dist",
    "--output", "/repo/output/catalog-native.json",
    "--auto-clear", "never",
    "--run-id", runId,
    "--journey", "catalog",
  ]);
});
