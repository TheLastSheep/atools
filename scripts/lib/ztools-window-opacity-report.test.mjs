import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOW_OPACITY_ERRORS,
  WINDOW_OPACITY_REPORT_FILENAME,
  readWindowOpacityReport,
  validateWindowOpacityReport,
} from "./ztools-window-opacity-report.mjs";

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
    journey: "settings-window-opacity",
    scope: "hidden-original-vue-window-opacity",
    ...owner,
    observations: {
      initialStateValid: true, changeDispatched: true, changedUiMatches: true, changedStored: true,
      changedNativeMatches: true, freshChildOnReopen: true, reopenUiMatches: true, reopenStored: true,
      reopenNativeMatches: true, restoreDispatched: true, restoredStored: true, restoredNativeMatches: true,
      unrelatedPreserved: true, closed: true, pluginUiOpened: false, preloadStarted: false,
      changedNativeOpacity: 0.65, reopenedNativeOpacity: 0.65, restoredNativeOpacity: 1,
    },
    errors: [],
  };
}

test("recomputes pass from all UI, database, and Native alpha facts", () => {
  const result = validateWindowOpacityReport(validReport(), owner);
  assert.equal(WINDOW_OPACITY_REPORT_FILENAME, "native-window-opacity-report.json");
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
});

test("rejects a mismatched owner and unknown or forged fields", () => {
  const wrongOwner = validReport();
  wrongOwner.pid += 1;
  assert.equal(validateWindowOpacityReport(wrongOwner, owner).passed, false);
  for (const mutate of [
    report => { report.extra = true; },
    report => { report.passed = true; },
    report => { report.observations.extra = true; },
  ]) assert.equal(validateWindowOpacityReport(mutateAndGet(mutate), owner).valid, false);
});

test("preserves nullable failure facts without treating them as success", () => {
  const report = validReport();
  report.observations.changedNativeOpacity = null;
  report.observations.reopenUiMatches = null;
  const result = validateWindowOpacityReport(report, owner);
  assert.equal(result.valid, true);
  assert.equal(result.passed, false);
  assert.equal(result.summary.observations.changedNativeOpacity, null);
});

test("requires both persisted and reopened values and bounded native opacity", () => {
  for (const mutate of [
    report => { report.observations.changedNativeOpacity = 0.656; },
    report => { report.observations.reopenedNativeOpacity = 0.64; },
    report => { report.observations.restoredNativeOpacity = 0.994; },
    report => { report.observations.changedNativeOpacity = 1.01; },
    report => { report.observations.changedStored = false; },
    report => { report.observations.reopenUiMatches = false; },
    report => { report.observations.closed = false; },
    report => { report.observations.pluginUiOpened = true; },
  ]) assert.equal(validateWindowOpacityReport(mutateAndGet(mutate), owner).passed, false);
});

test("known native errors are retained and every native error blocks success", () => {
  const report = validReport();
  report.errors = [WINDOW_OPACITY_ERRORS[0]];
  assert.equal(validateWindowOpacityReport(report, owner).valid, true);
  assert.equal(validateWindowOpacityReport(report, owner).passed, false);
  for (const errors of [["settings-window-opacity-unknown"], [WINDOW_OPACITY_ERRORS[0], WINDOW_OPACITY_ERRORS[0]]]) {
    const malformed = validReport();
    malformed.errors = errors;
    const result = validateWindowOpacityReport(malformed, owner);
    assert.equal(result.valid, false);
    assert.equal(result.passed, false);
  }
});

test("missing, malformed, oversized, nonterminal, or mismatched base reports fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-window-opacity-"));
  try {
    const missing = await readWindowOpacityReport(join(directory, "missing.json"), owner, true, true);
    assert.equal(missing.exists, false);
    assert.equal(missing.passed, false);
    const path = join(directory, WINDOW_OPACITY_REPORT_FILENAME);
    await writeFile(path, "{", { mode: 0o600 });
    assert.equal((await readWindowOpacityReport(path, owner, true, true)).passed, false);
    await writeFile(path, JSON.stringify(validReport()), { mode: 0o600 });
    assert.equal((await readWindowOpacityReport(path, owner, false, true)).passed, false);
    assert.equal((await readWindowOpacityReport(path, owner, true, false)).passed, false);
    await writeFile(path, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
    assert.equal((await readWindowOpacityReport(path, owner, true, true)).passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function mutateAndGet(mutate) {
  const report = validReport();
  mutate(report);
  return report;
}
