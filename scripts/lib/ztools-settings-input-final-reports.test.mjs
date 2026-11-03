import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emptySettingsInputFinalReports,
  readSettingsInputFinalReports,
  settingsInputFinalReportsPassed,
} from "./ztools-settings-input-final-reports.mjs";

const REPORT_NAMES = ["commandAliases", "windowOpacity", "trayVisibility", "mainHotkey", "generalPolicies", "launchAtLogin", "loginCrossEntry"];

function passingReports() {
  return Object.fromEntries(REPORT_NAMES.map(name => [name, {
    exists: true, valid: true, passed: true, ownerMatchesNativeReport: true, nativeCaseSucceeded: true,
  }]));
}

test("all seven final sidecars, owner bindings, and terminal Native success are required", () => {
  const empty = emptySettingsInputFinalReports();
  assert.deepEqual(Object.keys(empty), REPORT_NAMES);
  assert.equal(settingsInputFinalReportsPassed(empty), false);
  const reports = passingReports();
  assert.equal(settingsInputFinalReportsPassed(reports), true);
  for (const name of REPORT_NAMES) {
    for (const changed of [
      undefined,
      { ...reports[name], exists: false },
      { ...reports[name], valid: false },
      { ...reports[name], passed: false },
      { ...reports[name], ownerMatchesNativeReport: false },
      { ...reports[name], nativeCaseSucceeded: false },
    ]) {
      const candidate = { ...reports, [name]: changed };
      assert.equal(settingsInputFinalReportsPassed(candidate), false, `${name} must fail closed`);
    }
  }
});

test("a missing General Policies sidecar remains invalid even after Native owner and case success", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-final-reports-"));
  try {
    const reports = await readSettingsInputFinalReports(directory, {}, true, true);
    assert.equal(reports.generalPolicies.exists, false);
    assert.equal(reports.generalPolicies.valid, false);
    assert.equal(reports.generalPolicies.passed, false);
    assert.equal(reports.generalPolicies.nativeCaseSucceeded, true);
    assert.equal(settingsInputFinalReportsPassed(reports), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing launch-at-login sidecar remains a required failed gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-final-reports-"));
  try {
    const reports = await readSettingsInputFinalReports(directory, {}, true, true);
    assert.equal(reports.launchAtLogin.exists, false);
    assert.equal(reports.launchAtLogin.valid, false);
    assert.equal(reports.launchAtLogin.passed, false);
    assert.equal(reports.launchAtLogin.nativeCaseSucceeded, true);
    assert.equal(settingsInputFinalReportsPassed(reports), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing cross-entry sidecar remains a required failed gate", async () => {
  const directory = await mkdtemp(join(tmpdir(), "atools-final-reports-"));
  try {
    const reports = await readSettingsInputFinalReports(directory, {}, true, true, true);
    assert.equal(reports.loginCrossEntry.exists, false);
    assert.equal(reports.loginCrossEntry.valid, false);
    assert.equal(reports.loginCrossEntry.passed, false);
    assert.equal(reports.loginCrossEntry.cleanupSafe, false);
    assert.equal(reports.loginCrossEntry.nativeCaseSucceeded, true);
    assert.equal(settingsInputFinalReportsPassed(reports), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
