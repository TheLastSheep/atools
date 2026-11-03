import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  buildSettingsInputNativeArgs,
  cleanupOwnedSettingsInputFixtureRoot,
  launchAtLoginCleanupAllowsDeletion,
  loginCrossEntryCleanupAllowsDeletion,
  parseSettingsInputNativeArgs,
  settingsInputNativeIdentityMatches,
} from "./ztools-settings-input-native-case.mjs";

test("settings-input CLI requires only one absolute fresh binary and receipt", () => {
  assert.deepEqual(parseSettingsInputNativeArgs([
    "--binary", "/private/tmp/renderer-smoke",
    "--build-receipt", "/private/tmp/native-build-receipt-1790000000000.json",
  ]), {
    binary: "/private/tmp/renderer-smoke",
    buildReceipt: "/private/tmp/native-build-receipt-1790000000000.json",
    paintPresentation: "hidden",
  });
  assert.deepEqual(parseSettingsInputNativeArgs([
    "--paint-presentation", "visible-unfocused",
    "--binary", "/private/tmp/renderer-smoke",
    "--build-receipt", "/private/tmp/native-build-receipt-1790000000000.json",
  ]), {
    binary: "/private/tmp/renderer-smoke",
    buildReceipt: "/private/tmp/native-build-receipt-1790000000000.json",
    paintPresentation: "visible-unfocused",
  });
  for (const args of [
    [],
    ["--binary", "/private/tmp/renderer-smoke"],
    ["--binary", "relative", "--build-receipt", "/private/tmp/receipt.json"],
    ["--binary", "/private/tmp/a", "--binary", "/private/tmp/b", "--build-receipt", "/private/tmp/r"],
    ["--binary", "/private/tmp/a", "--build-receipt", "/private/tmp/r", "--journey", "catalog"],
    ["--binary", "/private/tmp/a", "--build-receipt", "/private/tmp/r", "--paint-presentation", "shown"],
    ["--binary", "/private/tmp/a", "--build-receipt", "/private/tmp/r", "--paint-presentation"],
    ["--binary", "/private/tmp/a", "--build-receipt", "/private/tmp/r", "--paint-presentation", "hidden", "--paint-presentation", "visible-unfocused"],
  ]) assert.throws(() => parseSettingsInputNativeArgs(args));
});

test("settings-input launches the isolated hidden journey with never-clear and a UUID profile", () => {
  assert.deepEqual(buildSettingsInputNativeArgs({
    fixtureRoot: "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef",
    rendererDist: "/workspace/packages/ztools-renderer/dist",
    output: "/workspace/output/native-report.json",
    runId: "0123456789abcdef0123456789abcdef",
  }), [
    "--fixture-root", "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef",
    "--renderer-dist", "/workspace/packages/ztools-renderer/dist",
    "--output", "/workspace/output/native-report.json",
    "--auto-clear", "never",
    "--run-id", "0123456789abcdef0123456789abcdef",
    "--journey", "settings-input",
    "--paint-presentation", "hidden",
  ]);
  assert.deepEqual(buildSettingsInputNativeArgs({
    fixtureRoot: "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef",
    rendererDist: "/workspace/packages/ztools-renderer/dist",
    output: "/workspace/output/native-report.json",
    runId: "0123456789abcdef0123456789abcdef",
    paintPresentation: "visible-unfocused",
  }).slice(-2), ["--paint-presentation", "visible-unfocused"]);
  assert.throws(() => buildSettingsInputNativeArgs({
    fixtureRoot: "/private/tmp/atools-renderer-settings-input-0123456789abcdef0123456789abcdef",
    rendererDist: "/workspace/packages/ztools-renderer/dist",
    output: "/workspace/output/native-report.json",
    runId: "0123456789abcdef0123456789abcdef",
    paintPresentation: "unfocused",
  }));
  assert.throws(() => buildSettingsInputNativeArgs({
    fixtureRoot: "relative", rendererDist: "/workspace/dist", output: "/workspace/report.json",
    runId: "0123456789abcdef0123456789abcdef",
  }));
});

test("profile cleanup waits for the owning PID to terminate and validates the new exact identity", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const root = `/private/tmp/atools-renderer-settings-input-${runId}`;
  const childPid = process.pid;
  await mkdir(root, { mode: 0o700 });
  await mkdir(join(root, "app-data"), { mode: 0o700 });
  await mkdir(join(root, "webview"), { mode: 0o700 });
  await writeFile(join(root, ".atools-renderer-smoke-owner.json"), JSON.stringify({
    schemaVersion: 1, pid: childPid,
    identifier: `dev.atools.renderer-settings-input.${runId}`, root,
  }), { flag: "wx", mode: 0o600 });

  try {
    const held = await cleanupOwnedSettingsInputFixtureRoot({ root, runId, childPid, processTerminal: false });
    assert.equal(held.status, "not_attempted");
    assert.equal(held.rootAbsent, false);
    assert.equal((await cleanupOwnedSettingsInputFixtureRoot({ root, runId, childPid, processTerminal: true })).status,
      "removed_owned_root");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile cleanup preserves a mismatched or foreign-root identity", async () => {
  const runId = randomUUID().replaceAll("-", "");
  const root = `/private/tmp/atools-renderer-settings-input-${runId}`;
  await mkdir(root, { mode: 0o700 });
  await writeFile(join(root, ".atools-renderer-smoke-owner.json"), JSON.stringify({
    schemaVersion: 1, pid: process.pid, identifier: `dev.atools.renderer-smoke.${runId}`, root,
  }), { flag: "wx", mode: 0o600 });
  try {
    const result = await cleanupOwnedSettingsInputFixtureRoot({
      root, runId, childPid: process.pid, processTerminal: true,
    });
    assert.equal(result.status, "preserved");
    assert.equal(result.rootAbsent, false);
    assert.equal(result.reason, "owner-marker-mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("profile cleanup requires the exact run identifier, owning pid, and root", async () => {
  for (const mismatch of ["pid", "root"]) {
    const runId = randomUUID().replaceAll("-", "");
    const root = `/private/tmp/atools-renderer-settings-input-${runId}`;
    await mkdir(root, { mode: 0o700 });
    const marker = {
      schemaVersion: 1,
      pid: mismatch === "pid" ? process.pid + 1 : process.pid,
      identifier: `dev.atools.renderer-settings-input.${runId}`,
      root: mismatch === "root" ? `/private/tmp/foreign-${runId}` : root,
    };
    await writeFile(join(root, ".atools-renderer-smoke-owner.json"), JSON.stringify(marker), {
      flag: "wx", mode: 0o600,
    });
    try {
      const result = await cleanupOwnedSettingsInputFixtureRoot({
        root, runId, childPid: process.pid, processTerminal: true,
      });
      assert.equal(result.status, "preserved", mismatch);
      assert.equal(result.rootAbsent, false, mismatch);
      assert.equal(result.reason, "owner-marker-mismatch", mismatch);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("fixture root and app bundle deletion require a terminal owner-bound unregister proof", () => {
  const clean = { valid: true, cleanupSafe: true };
  assert.equal(launchAtLoginCleanupAllowsDeletion(true, true, clean), true);
  for (const input of [
    [false, true, clean], [true, false, clean], [true, true, null],
    [true, true, { valid: false, cleanupSafe: true }],
    [true, true, { valid: true, cleanupSafe: false }],
  ]) assert.equal(launchAtLoginCleanupAllowsDeletion(...input), false);
});

test("fixture and bundle deletion also require a terminal restored cross-entry proof", () => {
  const clean = { valid: true, cleanupSafe: true };
  assert.equal(loginCrossEntryCleanupAllowsDeletion(true, true, clean), true);
  assert.equal(loginCrossEntryCleanupAllowsDeletion(true, true, { valid: true, cleanupSafe: true, passed: false }), true);
  for (const input of [
    [false, true, clean], [true, false, clean], [true, true, null],
    [true, true, { valid: false, cleanupSafe: true }],
    [true, true, { valid: true, cleanupSafe: false }],
  ]) assert.equal(loginCrossEntryCleanupAllowsDeletion(...input), false);
});

test("settings-input identity remains matchable when the base report fails its business gate", () => {
  const runId = "0123456789abcdef0123456789abcdef";
  const expectedOwner = {
    runId,
    identifier: `dev.atools.renderer-settings-input.${runId}`,
    root: `/private/tmp/atools-renderer-settings-input-${runId}`,
    pid: 7374,
  };
  const failedBusinessReport = {
    schemaVersion: 3,
    journey: "settings-input",
    scope: "hidden-original-vue-real-settings-input",
    autoClear: "never",
    ...expectedOwner,
    passed: false,
    timedOut: false,
    errors: ["settings-input-probe-failed"],
  };
  assert.equal(settingsInputNativeIdentityMatches(failedBusinessReport, expectedOwner), true);
  assert.equal(settingsInputNativeIdentityMatches({ ...failedBusinessReport, pid: 7375 }, expectedOwner), false);
  assert.equal(settingsInputNativeIdentityMatches(failedBusinessReport, { ...expectedOwner, root: "/private/tmp/foreign" }), false);
});
