import assert from "node:assert/strict";
import test from "node:test";
import {
  validateMainHotkeyRecoveryFirst,
  validateMainHotkeyRecoveryPair,
  validateMainHotkeyRecoverySecond,
} from "./ztools-main-hotkey-startup-native-report.mjs";

const owner = {
  runId: "0123456789abcdef0123456789abcdef",
  identifier: "dev.atools.renderer-settings-input.0123456789abcdef0123456789abcdef",
  root: "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef",
};
const firstProcess = {
  spawned: true, terminalObserved: true, pid: 41001, exitCode: 0, signal: null, timedOut: false,
  termination: { attempted: false, signals: [] },
};
const secondProcess = {
  spawned: true, terminalObserved: true, pid: 41002, exitCode: 0, signal: null, timedOut: false,
  termination: { attempted: false, signals: [] },
};

function firstReport() {
  return {
    schemaVersion: 1,
    journey: "main-hotkey-startup-recovery-first",
    scope: "invalid-hotkey-first-process",
    ...owner,
    pid: firstProcess.pid,
    observations: {
      startupNeedsRecovery: true, startupAttempted: true, ownedHotkeyUnregistered: true, generalOpened: true,
      hotkeyControlEmpty: true, placeholderEditDispatched: true, placeholderStored: true,
      invalidHotkeyPreserved: true, repairChordDispatched: true, repairStored: true, repairOwnedState: true,
      repairManagerRegistered: true, childClosed: true, hotkeyOwnedBeforeExit: true, pluginUiOpened: false,
      preloadStarted: false, databaseDevice: "16777234", databaseInode: "123456",
    },
    errors: [],
  };
}

function secondReport() {
  return {
    schemaVersion: 1,
    journey: "main-hotkey-startup-recovery-second",
    scope: "same-db-cold-start",
    ...owner,
    pid: secondProcess.pid,
    previousPid: firstProcess.pid,
    observations: {
      resumeClaimed: true, startupRegistered: true, startupOwnedStateB: true, startupManagerRegistered: true,
      generalOpened: true, generalReadBackB: true, releaseAttempted: true, releaseConfirmed: true,
      childClosed: true, pluginUiOpened: false, preloadStarted: false,
      databaseDevice: "16777234", databaseInode: "123456",
    },
    errors: [],
  };
}

test("startup recovery pair passes only with terminal owners and same database identity", () => {
  const result = validateMainHotkeyRecoveryPair({
    firstReport: firstReport(), secondReport: secondReport(), firstProcess, secondProcess, expectedOwner: owner,
  });
  assert.equal(result.valid, true);
  assert.equal(result.passed, true);
  assert.deepEqual(result.errors, []);
});

test("strict native shape rejects forged pass fields, missing observations, and unknown keys", () => {
  const forged = firstReport();
  forged.passed = true;
  assert.equal(validateMainHotkeyRecoveryFirst(forged, firstProcess, owner).passed, false);

  const missing = firstReport();
  delete missing.observations.invalidHotkeyPreserved;
  assert.equal(validateMainHotkeyRecoveryFirst(missing, firstProcess, owner).passed, false);

  const extra = secondReport();
  extra.unreviewed = true;
  assert.equal(validateMainHotkeyRecoverySecond(extra, secondProcess, owner).passed, false);
});

test("unknown owner, process, and Native error facts cannot pass", () => {
  const wrongOwner = firstReport();
  wrongOwner.root = "/private/tmp/other";
  assert.equal(validateMainHotkeyRecoveryFirst(wrongOwner, firstProcess, owner).passed, false);
  assert.equal(validateMainHotkeyRecoveryFirst(firstReport(), { ...firstProcess, terminalObserved: false }, owner).passed, false);

  const nativeError = secondReport();
  nativeError.errors = ["settings-main-hotkey-recovery-unknown"];
  assert.equal(validateMainHotkeyRecoverySecond(nativeError, secondProcess, owner).passed, false);

  for (const invalidProcess of [
    { ...firstProcess, timedOut: true },
    { ...firstProcess, signal: "SIGTERM" },
    { ...firstProcess, termination: { attempted: true, signals: [{ signal: "SIGTERM", accepted: true }] } },
  ]) {
    assert.equal(validateMainHotkeyRecoveryFirst(firstReport(), invalidProcess, owner).passed, false);
  }

  const forgedIdentity = firstReport();
  forgedIdentity.runId = "fedcba9876543210fedcba9876543210";
  forgedIdentity.identifier = owner.identifier;
  forgedIdentity.root = owner.root;
  const matchingForgedOwner = { ...owner, runId: forgedIdentity.runId };
  assert.equal(validateMainHotkeyRecoveryFirst(forgedIdentity, firstProcess, matchingForgedOwner).passed, false);
});

test("unknown and null required facts and a changed DB identity are rejected", () => {
  const missingState = firstReport();
  missingState.observations.ownedHotkeyUnregistered = null;
  assert.equal(validateMainHotkeyRecoveryFirst(missingState, firstProcess, owner).passed, false);

  const changedDb = secondReport();
  changedDb.observations.databaseInode = "123457";
  const pair = validateMainHotkeyRecoveryPair({
    firstReport: firstReport(), secondReport: changedDb, firstProcess, secondProcess, expectedOwner: owner,
  });
  assert.equal(pair.passed, false);
  assert.ok(pair.errors.includes("database-identity-changed"));
});
