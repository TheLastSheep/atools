import assert from "node:assert/strict";
import test from "node:test";
import {
  LOCAL_APP_SEARCH_CHECKS,
  LOCAL_APP_SEARCH_ERRORS,
  LOCAL_APP_SEARCH_REPORT_FILENAME,
  validateLocalAppSearchReport,
} from "./ztools-local-app-search-report.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};

function validReport() {
  return {
    schemaVersion: 1,
    journey: "settings-local-app-search",
    scope: "hidden-original-vue-local-app-search",
    identifier: owner.identifier,
    root: owner.root,
    pid: owner.pid,
    runId,
    passed: true,
    errors: [],
    checks: Object.fromEntries(LOCAL_APP_SEARCH_CHECKS.map(key => [key, true])),
  };
}

test("accepts the exact report when all 17 facts pass for the native owner", () => {
  const result = validateLocalAppSearchReport(validReport(), owner);
  assert.equal(LOCAL_APP_SEARCH_REPORT_FILENAME, "native-local-app-search-report.json");
  assert.equal(LOCAL_APP_SEARCH_CHECKS.length, 17);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.passed, true);
  assert.equal(Object.keys(result.summary.checks).length, 17);
});

test("rejects every mismatched owner identity component", () => {
  for (const field of ["runId", "identifier", "root", "pid"]) {
    const report = validReport();
    report[field] = field === "pid" ? owner.pid + 1 : `foreign-${field}`;
    const result = validateLocalAppSearchReport(report, owner);
    assert.equal(result.valid, false, field);
    assert.equal(result.passed, false, field);
  }
});

test("rejects missing, extra, and nonboolean schema values", () => {
  for (const mutate of [
    report => { delete report.scope; },
    report => { report.extra = true; },
    report => { delete report.checks.finalUiEnabled; },
    report => { report.checks.extra = true; },
    report => { report.checks.disableUiClick = null; },
    report => { report.checks.disableUiClick = "true"; },
    report => { report.errors = null; },
    report => { report.passed = null; },
  ]) {
    const result = validateLocalAppSearchReport(mutateAndGet(mutate), owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }
});

test("keeps real failed facts valid but never accepts a fabricated passed bit", () => {
  const failedReport = validReport();
  failedReport.checks.mainAppExcluded = false;
  failedReport.passed = false;
  const failed = validateLocalAppSearchReport(failedReport, owner);
  assert.equal(failed.valid, true, JSON.stringify(failed));
  assert.equal(failed.passed, false);

  const fabricatedPass = validReport();
  fabricatedPass.checks.childClosed = false;
  const rejected = validateLocalAppSearchReport(fabricatedPass, owner);
  assert.equal(rejected.valid, false);
  assert.equal(rejected.passed, false);
});

test("accepts only fixed unique native error codes within the deduplication bound", () => {
  const oneKnownError = validReport();
  oneKnownError.errors = [LOCAL_APP_SEARCH_ERRORS[0]];
  oneKnownError.passed = false;
  const known = validateLocalAppSearchReport(oneKnownError, owner);
  assert.equal(known.valid, true, JSON.stringify(known));
  assert.equal(known.passed, false);

  for (const errors of [
    ["settings-input-local-app-search-unrecognized"],
    [LOCAL_APP_SEARCH_ERRORS[0], LOCAL_APP_SEARCH_ERRORS[0]],
    [...LOCAL_APP_SEARCH_ERRORS, LOCAL_APP_SEARCH_ERRORS[0]],
    new Array(1),
  ]) {
    const report = validReport();
    report.errors = errors;
    report.passed = false;
    const result = validateLocalAppSearchReport(report, owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }

  const allKnownErrors = validReport();
  allKnownErrors.errors = [...LOCAL_APP_SEARCH_ERRORS];
  allKnownErrors.passed = false;
  const allowed = validateLocalAppSearchReport(allKnownErrors, owner);
  assert.equal(allowed.valid, true, JSON.stringify(allowed));
  assert.equal(allowed.passed, false);
});

function mutateAndGet(mutate) {
  const report = validReport();
  mutate(report);
  return report;
}
