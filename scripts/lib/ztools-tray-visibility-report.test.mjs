import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRAY_VISIBILITY_ERRORS,
  TRAY_VISIBILITY_REPORT_FILENAME,
  readTrayVisibilityReport,
  validateTrayVisibilityReport,
} from "./ztools-tray-visibility-report.mjs";

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
    journey: "settings-tray-visibility",
    scope: "hidden-original-vue-tray-visibility",
    ...owner,
    observations: {
      startupDefaultVisible: true, initialUiEnabled: true, disableDispatched: true,
      disabledStored: true, disabledNative: true, freshChildOnReopen: true, reopenUiDisabled: true,
      reopenStoredDisabled: true, reopenNativeDisabled: true, enableDispatched: true,
      enabledStored: true, enabledNative: true, unrelatedPreserved: true, childClosed: true,
      trayReleased: true, pluginUiOpened: false, preloadStarted: false,
    },
    errors: [],
  };
}

test("derives pass from default, checkbox, persistence, Native state, and release facts", () => {
  const result = validateTrayVisibilityReport(validReport(), owner);
  assert.equal(TRAY_VISIBILITY_REPORT_FILENAME, "native-tray-visibility-report.json");
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
});

test("rejects owner mismatch and forged or unknown facts", () => {
  const wrongOwner = validReport();
  wrongOwner.pid += 1;
  assert.equal(validateTrayVisibilityReport(wrongOwner, owner).passed, false);
  for (const mutate of [
    report => { report.passed = true; },
    report => { report.observations.extra = true; },
    report => { report.observations.disabledNative = 1; },
  ]) assert.equal(validateTrayVisibilityReport(mutateAndGet(mutate), owner).valid, false);
});

test("null facts remain diagnosable and cannot satisfy 1 to 0 to 1 or release", () => {
  for (const key of ["startupDefaultVisible", "disabledNative", "reopenStoredDisabled", "enabledNative", "trayReleased"]) {
    const report = validReport();
    report.observations[key] = null;
    const result = validateTrayVisibilityReport(report, owner);
    assert.equal(result.valid, true);
    assert.equal(result.passed, false);
  }
});

test("known Native errors are preserved and block success", () => {
  const report = validReport();
  report.errors = [TRAY_VISIBILITY_ERRORS[0]];
  assert.equal(validateTrayVisibilityReport(report, owner).valid, true);
  assert.equal(validateTrayVisibilityReport(report, owner).passed, false);
  for (const errors of [["settings-tray-visibility-unknown"], [TRAY_VISIBILITY_ERRORS[0], TRAY_VISIBILITY_ERRORS[0]]]) {
    const malformed = validReport();
    malformed.errors = errors;
    assert.equal(validateTrayVisibilityReport(malformed, owner).valid, false);
  }
});

test("missing, malformed, oversized, nonterminal, and unowned reports fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-tray-visibility-"));
  try {
    const path = join(directory, TRAY_VISIBILITY_REPORT_FILENAME);
    assert.equal((await readTrayVisibilityReport(path, owner, true, true)).passed, false);
    await writeFile(path, "{", { mode: 0o600 });
    assert.equal((await readTrayVisibilityReport(path, owner, true, true)).passed, false);
    await writeFile(path, JSON.stringify(validReport()), { mode: 0o600 });
    assert.equal((await readTrayVisibilityReport(path, owner, false, true)).passed, false);
    assert.equal((await readTrayVisibilityReport(path, owner, true, false)).passed, false);
    await writeFile(path, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
    assert.equal((await readTrayVisibilityReport(path, owner, true, true)).passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function mutateAndGet(mutate) {
  const report = validReport();
  mutate(report);
  return report;
}
