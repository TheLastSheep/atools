import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintNativeExecutable } from "./lib/ztools-renderer-native-source-binding.mjs";
import {
  captureLauncherProbeFingerprint,
  inspectOptionalPathAbsence,
  launcherFixtureRootCleanupAllowed,
  summarizeLauncherProbeFingerprint,
  verifyLauncherProbeFingerprintUnchanged,
} from "./lib/ztools-renderer-launch-runtime.mjs";

test("launcher probe preflight requires the source closure and matches the full receipt fingerprint", async t => {
  const root = await mkdtemp(join(tmpdir(), "atools-launch-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binaryPath = join(root, "probe");
  await writeFile(binaryPath, "fake executable bytes");
  await chmod(binaryPath, 0o700);
  const nativeSources = { files: [{ path: "src-tauri/examples/atools_owned_launch_probe.rs" }] };
  const binaryFingerprint = await fingerprintNativeExecutable(binaryPath);
  const first = await captureLauncherProbeFingerprint({
    binaryPath,
    nativeSources,
    receiptSnapshot: { exists: true, value: { launcherProbe: binaryFingerprint } },
  });
  assert.equal(first.matchesReceipt, true);
  assert.deepEqual(Object.keys(summarizeLauncherProbeFingerprint(first.fingerprint)).sort(),
    ["device", "inode", "mtimeNs", "sha256", "sizeBytes"]);
  await assert.rejects(captureLauncherProbeFingerprint({
    binaryPath,
    receiptSnapshot: { exists: true, value: { launcherProbe: first.fingerprint } },
    nativeSources: { files: [] },
  }), /source closure/);

  await writeFile(binaryPath, "changed fake executable bytes");
  const after = await verifyLauncherProbeFingerprintUnchanged(binaryPath, first.fingerprint);
  assert.equal(after.stable, false);
  await truncate(binaryPath, 32 * 1024 * 1024 + 1);
  await assert.rejects(captureLauncherProbeFingerprint({
    binaryPath,
    receiptSnapshot: { exists: true, value: { launcherProbe: first.fingerprint } },
    nativeSources,
  }), /within 32 MiB/);
});

test("launcher fixture cleanup requires every independent host, report, and probe exit signal", () => {
  const valid = {
    hostProcessSucceeded: true,
    profileOwnerValid: true,
    nativeReportValid: true,
    launcherModeValid: true,
    probesValid: true,
    probesTerminal: true,
    liveProbeProcesses: 0,
    pendingLaunches: 0,
    nativeLiveProbeProcesses: 0,
    nativeProbesTerminal: true,
  };
  assert.equal(launcherFixtureRootCleanupAllowed(valid), true);
  for (const key of ["hostProcessSucceeded", "profileOwnerValid", "nativeReportValid", "launcherModeValid",
    "probesValid", "probesTerminal", "nativeProbesTerminal"]) {
    assert.equal(launcherFixtureRootCleanupAllowed({ ...valid, [key]: false }), false, key);
  }
  for (const key of ["liveProbeProcesses", "pendingLaunches", "nativeLiveProbeProcesses"]) {
    assert.equal(launcherFixtureRootCleanupAllowed({ ...valid, [key]: null }), false, key);
    assert.equal(launcherFixtureRootCleanupAllowed({ ...valid, [key]: 1 }), false, key);
  }
});

test("optional path inspection distinguishes confirmed absence from existing and uninspectable paths", async () => {
  assert.deepEqual(await inspectOptionalPathAbsence("fixture", async () => null), { known: true, absent: true });
  assert.deepEqual(await inspectOptionalPathAbsence("bundle", async () => ({ isDirectory: true })), { known: true, absent: false });
  assert.deepEqual(await inspectOptionalPathAbsence("denied", async () => { throw Object.assign(new Error(), { code: "EACCES" }); }),
    { known: false, absent: null });
});
