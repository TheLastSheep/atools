import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_HOTKEY_ERRORS,
  MAIN_HOTKEY_REPORT_FILENAME,
  readMainHotkeyReport,
  validateMainHotkeyReport,
} from "./ztools-main-hotkey-report.mjs";
import { readSettingsInputFinalReports } from "./ztools-settings-input-final-reports.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const owner = {
  runId,
  identifier: `dev.atools.renderer-settings-input.${runId}`,
  root: `/private/tmp/atools-renderer-settings-input-${runId}`,
  pid: 9876,
};

function validReport() {
  const observations = Object.fromEntries([
    "initialOwnedRegistered", "initialUiMatches", "recordDispatched", "changedStored",
    "changedOwnedRegistered", "previousUnregistered", "changedUiMatches", "freshChildOnReopen",
    "reopenUiMatches", "reopenStored", "reopenOwnedRegistered", "conflictDispatched",
    "conflictUiRestored", "conflictStoredUnchanged", "conflictPrimaryPreserved", "conflictOtherPreserved",
    "restoreDispatched", "restoredStored", "restoredOwnedRegistered", "alternateUnregistered",
    "unrelatedPreserved", "childClosed", "ownedPrimaryReleased", "otherShortcutReleased",
    "mainRawHotkeyMutationDenied", "childRawHotkeyMutationDenied",
    "pluginUiOpened", "preloadStarted",
  ].map(key => [key, !["pluginUiOpened", "preloadStarted"].includes(key)]));
  return {
    schemaVersion: 1,
    journey: "settings-main-hotkey",
    scope: "hidden-original-vue-main-hotkey",
    ...owner,
    observations,
    errors: [],
  };
}

test("derives pass from all 28 exact facts and the fixed owner", () => {
  const report = validReport();
  const result = validateMainHotkeyReport(report, owner);
  assert.equal(MAIN_HOTKEY_REPORT_FILENAME, "native-main-hotkey-report.json");
  assert.equal(Object.keys(report).length, 9);
  assert.equal(Object.keys(report.observations).length, 28);
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
});

test("rejects a different owner, additional facts, and native pass flags", () => {
  const wrongOwner = validReport();
  wrongOwner.pid += 1;
  assert.equal(validateMainHotkeyReport(wrongOwner, owner).passed, false);
  for (const mutate of [
    report => { report.passed = true; },
    report => { report.observations.extra = true; },
    report => { delete report.observations.conflictOtherPreserved; },
  ]) assert.equal(validateMainHotkeyReport(mutateAndGet(mutate), owner).valid, false);
});

test("nullable and false required facts remain valid evidence but cannot pass", () => {
  for (const [key, value] of [["changedOwnedRegistered", null], ["conflictPrimaryPreserved", false]]) {
    const report = validReport();
    report.observations[key] = value;
    const result = validateMainHotkeyReport(report, owner);
    assert.equal(result.valid, true);
    assert.equal(result.passed, false);
  }
  for (const key of ["mainRawHotkeyMutationDenied", "childRawHotkeyMutationDenied"]) {
    const report = validReport();
    report.observations[key] = false;
    const result = validateMainHotkeyReport(report, owner);
    assert.equal(result.valid, true);
    assert.equal(result.passed, false);
  }
  for (const value of [0, "true"]) {
    const report = validReport();
    report.observations.recordDispatched = value;
    assert.equal(validateMainHotkeyReport(report, owner).valid, false);
  }
});

test("preserves only known Native errors and blocks them", () => {
  const report = validReport();
  report.errors = [MAIN_HOTKEY_ERRORS[0]];
  assert.equal(validateMainHotkeyReport(report, owner).valid, true);
  assert.equal(validateMainHotkeyReport(report, owner).passed, false);
  for (const errors of [["settings-main-hotkey-unknown"], [MAIN_HOTKEY_ERRORS[0], MAIN_HOTKEY_ERRORS[0]]]) {
    const malformed = validReport();
    malformed.errors = errors;
    assert.equal(validateMainHotkeyReport(malformed, owner).valid, false);
  }
});

test("missing, malformed, oversized, unowned, or nonterminal files fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-main-hotkey-"));
  try {
    const path = join(directory, MAIN_HOTKEY_REPORT_FILENAME);
    assert.equal((await readMainHotkeyReport(path, owner, true, true)).passed, false);
    await writeFile(path, "{", { mode: 0o600 });
    assert.equal((await readMainHotkeyReport(path, owner, true, true)).passed, false);
    await writeFile(path, JSON.stringify(validReport()), { mode: 0o600 });
    assert.equal((await readMainHotkeyReport(path, owner, false, true)).passed, false);
    assert.equal((await readMainHotkeyReport(path, owner, true, false)).passed, false);
    await writeFile(path, " ".repeat(16 * 1024 + 1), { mode: 0o600 });
    assert.equal((await readMainHotkeyReport(path, owner, true, true)).passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the runner's late-report collector requires the new report and binds its Native outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-settings-input-reports-"));
  try {
    const reports = await readSettingsInputFinalReports(directory, owner, true, true);
    assert.equal(reports.mainHotkey.exists, false);
    assert.equal(reports.mainHotkey.passed, false);
    assert.equal(reports.commandAliases.passed, false);
    assert.equal(reports.windowOpacity.passed, false);
    assert.equal(reports.trayVisibility.passed, false);
    const unowned = await readSettingsInputFinalReports(directory, owner, false, true);
    assert.equal(unowned.mainHotkey.passed, false);
    const nonterminal = await readSettingsInputFinalReports(directory, owner, true, false);
    assert.equal(nonterminal.mainHotkey.passed, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function mutateAndGet(mutate) {
  const report = validReport();
  mutate(report);
  return report;
}
