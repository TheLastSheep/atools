import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOGIN_CROSS_ENTRY_REPORT_FILENAME,
  readLoginCrossEntryReport,
  validateLoginCrossEntryReport,
} from "./ztools-login-cross-entry-report.mjs";

const expectedOwner = {
  runId: "0123456789abcdef0123456789abcdef",
  identifier: "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef",
  root: "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef",
  pid: 9001,
};

function stage(surface, enabled, nativeEnabled, databaseEnabled, extra = {}) {
  const isVue = surface === "vue";
  const conflicted = !isVue && enabled === null;
  return {
    surface, ready: true, controlUnique: true, enabled,
    disabled: isVue ? null : conflicted,
    indeterminate: isVue ? null : conflicted,
    overviewUnknown: isVue ? null : conflicted,
    hasConflictMessage: isVue ? null : conflicted,
    saveState: isVue ? null : "saved", routeGeneral: isVue ? true : null, getterEnabled: isVue ? enabled : null,
    actionDispatched: null, actionSucceeded: null, nativeEnabled, databaseEnabled,
    unknownMarkerPreserved: true, ...extra,
  };
}

function validReport() {
  const stages = {
    initial: stage("vue", true, true, false, { unknownMarkerPreserved: true }),
    fallbackInitial: stage("fallback", true, true, false),
    fallbackDisabled: stage("fallback", false, false, false, { actionDispatched: true, actionSucceeded: true }),
    vueAfterDisabled: stage("vue", false, false, false),
    vueReenabled: stage("vue", true, true, false, { actionDispatched: true, actionSucceeded: true }),
    fallbackFresh: stage("fallback", true, true, false),
    ordinarySave: stage("fallback", true, true, false, {
      saveState: "saved", actionDispatched: true, actionSucceeded: true,
    }),
    conflict: stage("fallback", null, false, false, {
      actionDispatched: true, actionSucceeded: true,
    }),
    reread: stage("fallback", false, false, false, { actionDispatched: true, actionSucceeded: true }),
    final: stage("vue", true, true, false, {
      actionDispatched: true, actionSucceeded: true, unknownMarkerPreserved: null,
    }),
  };
  return {
    schemaVersion: 1, kind: "settings-login-cross-entry",
    ...expectedOwner,
    database: { beforeSha256: "a".repeat(64), afterSha256: "a".repeat(64), originalLaunchAtLogin: false },
    stages,
    counters: { readLaunchAtLogin: 3, changeLaunchAtLogin: 2, saveGeneralSettings: 1 },
    cleanup: { fallbackWindowCount: 0, coordinatorTerminal: true, databaseRestored: true, pendingProbes: 0 },
    errors: [], passed: true,
  };
}

const nativeSuccess = {
  nativeOwnerMatches: true, nativeProcessTerminal: true,
  nativeProcessSucceeded: true, nativeCaseSucceeded: true,
};

test("recomputes the cross-entry lifecycle and cleanup from fixed facts", () => {
  const report = validReport();
  const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.equal(result.cleanupSafe, true);
  assert.equal(result.summary.counters.changeLaunchAtLogin, 2);
  assert.equal(result.summary.nativePassedClaim, true);
});

test("does not trust Native passed when any stage, counter, or error fact disagrees", () => {
  const cases = [
    value => { value.passed = false; },
    value => { value.stages.fallbackDisabled.nativeEnabled = true; },
    value => { value.stages.conflict.getterEnabled = true; },
    value => { value.counters.changeLaunchAtLogin = 1; },
    value => { value.errors = ["unrecognized-native-error"]; },
    value => { value.errors = ["settings-login-cross-entry-reread-invalid"]; },
  ];
  for (const mutate of cases) {
    const report = validReport();
    mutate(report);
    const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
    assert.equal(result.passed, false);
  }
});

test("rejects fabricated fields unavailable on the other surface and stale DB enablement", () => {
  const cases = [
    value => { value.stages.fallbackInitial.routeGeneral = false; },
    value => { value.stages.fallbackInitial.getterEnabled = true; },
    value => { value.stages.initial.disabled = false; },
    value => { value.stages.vueAfterDisabled.indeterminate = true; },
    value => { value.stages.vueReenabled.overviewUnknown = false; },
    value => { value.stages.final.hasConflictMessage = true; },
    value => { value.stages.initial.saveState = "idle"; },
    value => { value.stages.vueReenabled.databaseEnabled = true; },
    value => { value.stages.conflict.actionSucceeded = false; },
  ];
  for (const mutate of cases) {
    const report = validReport();
    mutate(report);
    assert.equal(validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess).passed, false);
  }
});

test("requires action facts to match whether each stage performed a user action", () => {
  const operations = new Set(["fallbackDisabled", "vueReenabled", "ordinarySave", "conflict", "reread", "final"]);
  const stageNames = ["initial", "fallbackInitial", "fallbackDisabled", "vueAfterDisabled", "vueReenabled",
    "fallbackFresh", "ordinarySave", "conflict", "reread", "final"];
  for (const name of stageNames) {
    for (const field of ["actionDispatched", "actionSucceeded"]) {
      const report = validReport();
      report.stages[name][field] = operations.has(name) ? null : true;
      const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
      assert.equal(result.valid, true, `${name}.${field} shape`);
      assert.equal(result.passed, false, `${name}.${field} semantics`);
    }
  }
});

test("rejects idle fallback save-state reports", () => {
  const report = validReport();
  report.stages.fallbackInitial.saveState = "idle";
  const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
});

test("unknown save state is valid outside ordinarySave but cannot satisfy its saved gate", () => {
  const report = validReport();
  report.stages.fallbackInitial.saveState = "unknown";
  const observedUnknown = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(observedUnknown.valid, true);
  assert.equal(observedUnknown.passed, true);
  assert.equal(observedUnknown.cleanupSafe, true);

  report.stages.ordinarySave.saveState = "unknown";
  const unsaved = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(unsaved.valid, true);
  assert.equal(unsaved.passed, false);
  assert.equal(unsaved.cleanupSafe, true);
});

test("requires exact owner, stage schema, counters, restored DB digest, and cleanup facts", () => {
  const cases = [
    value => { value.pid += 1; },
    value => { delete value.stages.final; },
    value => { value.stages.initial.unexpected = true; },
    value => { value.database.afterSha256 = "b".repeat(64); },
    value => { value.stages.final.databaseEnabled = true; },
    value => { value.cleanup.pendingProbes = 1; },
    value => { value.cleanup.fallbackWindowCount = 1; },
    value => { value.cleanup.databaseRestored = false; },
  ];
  for (const mutate of cases) {
    const report = validReport();
    mutate(report);
    const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
    assert.equal(result.passed, false);
    if (report.cleanup.pendingProbes !== 0 || report.cleanup.fallbackWindowCount !== 0
        || report.cleanup.databaseRestored !== true || report.database.afterSha256 !== report.database.beforeSha256) {
      assert.equal(result.cleanupSafe, false);
    }
  }
});

test("unavailable original DB value is distinct from an unreadable DB hash", () => {
  const report = validReport();
  report.database.originalLaunchAtLogin = null;
  report.stages.final.databaseEnabled = null;
  const absentButHashBound = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(absentButHashBound.passed, true);
  report.database.beforeSha256 = null;
  report.database.afterSha256 = null;
  const hashUnavailable = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(hashUnavailable.passed, false);
  assert.equal(hashUnavailable.cleanupSafe, false);
});

test("cleanup may be safe after a failed workflow only when Native facts prove terminal restoration", () => {
  const report = validReport();
  report.passed = false;
  report.errors = ["settings-login-cross-entry-fallback-probe-invalid"];
  report.stages.fallbackFresh.enabled = false;
  const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
  assert.equal(result.passed, false);
  assert.equal(result.cleanupSafe, true);
  assert.equal(validateLoginCrossEntryReport(report, expectedOwner, {
    ...nativeSuccess, nativeProcessTerminal: false,
  }).cleanupSafe, false);
});

test("base Native business failure does not invalidate owner or independent cleanup proof", () => {
  const report = validReport();
  const result = validateLoginCrossEntryReport(report, expectedOwner, {
    nativeOwnerMatches: true,
    nativeProcessTerminal: true,
    nativeProcessSucceeded: false,
    nativeCaseSucceeded: false,
  });
  assert.equal(result.valid, true);
  assert.equal(result.cleanupSafe, true);
  assert.equal(result.passed, false);
});

test("fallback close timeout and replacement are recognized failures, never passes", () => {
  for (const code of [
    "settings-login-cross-entry-fallback-close-timeout",
    "settings-login-cross-entry-fallback-close-replaced",
  ]) {
    const report = validReport();
    report.passed = false;
    report.errors = [code];
    const result = validateLoginCrossEntryReport(report, expectedOwner, nativeSuccess);
    assert.equal(result.valid, true, code);
    assert.equal(result.passed, false, code);
    assert.equal(result.cleanupSafe, true, code);
  }
});

test("report reader treats missing or malformed sidecars as failed gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "login-cross-entry-report-"));
  try {
    const path = join(root, LOGIN_CROSS_ENTRY_REPORT_FILENAME);
    const missing = await readLoginCrossEntryReport(path, expectedOwner, nativeSuccess);
    assert.equal(missing.exists, false);
    assert.equal(missing.passed, false);
    await writeFile(path, "{not-json", { flag: "wx" });
    const invalid = await readLoginCrossEntryReport(path, expectedOwner, nativeSuccess);
    assert.equal(invalid.exists, true);
    assert.equal(invalid.valid, false);
    assert.equal(invalid.passed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
