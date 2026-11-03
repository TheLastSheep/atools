import assert from "node:assert/strict";
import test from "node:test";
import { DISABLED_COMMAND_CHECKS, validateDisabledCommandsReport } from "./ztools-disabled-commands-report.mjs";

const owner = {
  runId: "1234567890ab4cde8fab1234567890ab", identifier: "dev.atools.renderer-settings-input.fixture",
  root: "/private/tmp/owned-fixture", pid: 1234,
};
function report() {
  return { schemaVersion: 1, journey: "settings-command-availability",
    scope: "hidden-original-vue-command-availability", ...owner, passed: true, errors: [],
    checks: Object.fromEntries(DISABLED_COMMAND_CHECKS.map(key => [key, true])) };
}

test("requires the complete menu, SQLite, child readback and original Main search cycle", () => {
  assert.equal(validateDisabledCommandsReport(report(), owner).passed, true);
  for (const key of DISABLED_COMMAND_CHECKS) {
    const failed = report();
    failed.checks[key] = false;
    assert.equal(validateDisabledCommandsReport(failed, owner).passed, false, key);
    assert.equal(validateDisabledCommandsReport(failed, owner).valid, false, key);
    failed.passed = false;
    assert.equal(validateDisabledCommandsReport(failed, owner).valid, true, key);
  }
});

test("rejects evidence from another run, root, application or process", () => {
  for (const [key, wrong] of [["runId", "a".repeat(32)], ["root", "/private/tmp/other"],
    ["identifier", "dev.other"], ["pid", 999]]) {
    assert.equal(validateDisabledCommandsReport({ ...report(), [key]: wrong }, owner).valid, false);
  }
  assert.equal(validateDisabledCommandsReport(report(), { ...owner, pid: null }).valid, false);
});

test("rejects missing, extra, malformed and falsely passed records", () => {
  const missing = report();
  delete missing.checks.mainRestored;
  const extraCheck = report();
  extraCheck.checks.extra = true;
  const wrongType = report();
  wrongType.checks.mainExcluded = 1;
  for (const candidate of [null, [], { ...report(), extra: true }, missing, extraCheck, wrongType,
    { ...report(), schemaVersion: 2 }, { ...report(), scope: "visible" }, { ...report(), passed: false }]) {
    assert.equal(validateDisabledCommandsReport(candidate, owner).valid, false);
  }
});

test("preserves bounded fixed native failure codes without accepting them as success", () => {
  const failed = report();
  failed.errors = ["settings-command-availability-main-not-excluded"];
  failed.passed = false;
  const result = validateDisabledCommandsReport(failed, owner);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.deepEqual(result.summary.nativeErrors, failed.errors);
  for (const errors of [["arbitrary error text"], [failed.errors[0], failed.errors[0]], Array(17).fill("x"), null]) {
    assert.equal(validateDisabledCommandsReport({ ...failed, errors }, owner).valid, false);
  }
});
