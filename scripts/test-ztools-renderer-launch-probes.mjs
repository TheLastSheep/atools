import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fingerprintNativeExecutable } from "./lib/ztools-renderer-native-source-binding.mjs";
import {
  inspectRendererLaunchProbes,
  launcherProbeFingerprintMatchesReceipt,
  LAUNCHER_PROBE_BUNDLE_NAMES,
  LAUNCHER_PROBE_CONFIG,
  LAUNCHER_PROBE_EXECUTABLE,
  LAUNCHER_PROBE_EXITING,
  LAUNCHER_PROBE_STARTED,
  stageRendererLaunchProbes,
} from "./lib/ztools-renderer-launch-probes.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const hostPid = 99123;

async function makeStage(t, { backgroundOnly = false, hostInfoPlist = null } = {}) {
  const temporary = await mkdtemp(join(tmpdir(), "atools-launch-probes-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const hostBundlePath = join(temporary, "Host.app");
  const resources = join(hostBundlePath, "Contents", "Resources");
  await mkdir(resources, { recursive: true, mode: 0o700 });
  if (hostInfoPlist !== null) await writeFile(join(hostBundlePath, "Contents", "Info.plist"), hostInfoPlist);
  await chmod(hostBundlePath, 0o700);
  await chmod(join(hostBundlePath, "Contents"), 0o700);
  await chmod(resources, 0o700);
  const binary = join(temporary, "atools_owned_launch_probe");
  await writeFile(binary, "fake Mach-O bytes used only by the staging unit test", { mode: 0o755 });
  await chmod(binary, 0o755);
  const binaryFingerprint = await fingerprintNativeExecutable(binary);
  const staged = await stageRendererLaunchProbes({ hostBundlePath, binaryFingerprint, runId, backgroundOnly });
  return { temporary, hostBundlePath, binary, binaryFingerprint, staged,
    hostInfoPlistPath: join(hostBundlePath, "Contents", "Info.plist"),
    launcherRoot: join(resources, "launcher-apps") };
}

function bundleResources(root, probeIndex = 0) {
  return join(root, LAUNCHER_PROBE_BUNDLE_NAMES[probeIndex], "Contents", "Resources");
}

test("stages two private probe bundles with exact config, identifiers, and executable hashes", async t => {
  const fixture = await makeStage(t);
  assert.equal(fixture.staged.bundleCount, 2);
  assert.deepEqual(fixture.staged.probeIds, ["first", "second"]);
  const inspected = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
  });
  assert.equal(inspected.valid, true);
  assert.equal(inspected.bundleCount, 2);
  assert.deepEqual(inspected, {
    valid: true,
    errors: [],
    bundleCount: 2,
    selectedProbe: null,
    processStarts: 0,
    processExits: 0,
    probesTerminal: false,
    liveProbeProcesses: null,
  });

  for (const [index, probeId] of ["first", "second"].entries()) {
    const bundle = join(fixture.launcherRoot, LAUNCHER_PROBE_BUNDLE_NAMES[index]);
    const resources = bundleResources(fixture.launcherRoot, index);
    const executable = join(bundle, "Contents", "MacOS", LAUNCHER_PROBE_EXECUTABLE);
    const executableStat = await lstat(executable);
    const resourceStat = await lstat(resources);
    assert.equal(executableStat.mode & 0o777, 0o700);
    assert.equal(resourceStat.mode & 0o777, 0o700);
    assert.equal(await readFile(join(resources, LAUNCHER_PROBE_CONFIG), "utf8"), `${runId}\n${probeId}\n`);
    assert.equal(await readFile(executable, "utf8"), await readFile(fixture.binary, "utf8"));
    const plist = await readFile(join(bundle, "Contents", "Info.plist"), "utf8");
    const bundleName = probeId === "first" ? "AToolsOwnedProbeFirst" : "AToolsOwnedProbeSecond";
    assert.equal(plist, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>AToolsOwnedLaunchProbe</string>
<key>CFBundleIdentifier</key><string>dev.atools.launch-probe.${runId}.${probeId}</string>
<key>CFBundleName</key><string>${bundleName}</string>
<key>CFBundleDisplayName</key><string>${bundleName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
</dict></plist>
`);
  }
});

test("background-only is opt-in, exact for both staged probes, and never applied to the host bundle", async t => {
  const hostInfoPlist = "host Info.plist stays unchanged\n";
  const fixture = await makeStage(t, { backgroundOnly: true, hostInfoPlist });
  assert.equal(fixture.staged.backgroundOnly, true);
  assert.equal(await readFile(fixture.hostInfoPlistPath, "utf8"), hostInfoPlist);

  for (let index = 0; index < LAUNCHER_PROBE_BUNDLE_NAMES.length; index += 1) {
    const plist = await readFile(join(fixture.launcherRoot, LAUNCHER_PROBE_BUNDLE_NAMES[index], "Contents", "Info.plist"), "utf8");
    assert.match(plist, /<key>LSBackgroundOnly<\/key><true\/>/);
  }

  const matching = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    backgroundOnly: true,
  });
  assert.equal(matching.valid, true);
  const defaultPolicy = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
  });
  assert.equal(defaultPolicy.valid, false);
  assert.ok(defaultPolicy.errors.includes("probe-plist-mismatch"));
  const invalidPolicy = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    backgroundOnly: "true",
  });
  assert.equal(invalidPolicy.valid, false);
  assert.deepEqual(invalidPolicy.errors, ["invalid-inspection-input"]);
});

test("rejects invalid background-only factory options and malformed hidden-mode plists", async t => {
  const fixture = await makeStage(t);
  await assert.rejects(stageRendererLaunchProbes({
    hostBundlePath: fixture.hostBundlePath,
    binaryFingerprint: fixture.binaryFingerprint,
    runId,
    backgroundOnly: "true",
  }), /Invalid launcher probe staging inputs/);

  const hiddenFixture = await makeStage(t, { backgroundOnly: true });
  const infoPath = join(hiddenFixture.launcherRoot, LAUNCHER_PROBE_BUNDLE_NAMES[0], "Contents", "Info.plist");
  const expectedPlist = await readFile(infoPath, "utf8");
  const inspect = () => inspectRendererLaunchProbes({
    root: hiddenFixture.launcherRoot,
    runId,
    executableSha256: hiddenFixture.binaryFingerprint.sha256,
    backgroundOnly: true,
  });

  for (const malformed of [
    expectedPlist.replace("<key>LSBackgroundOnly</key><true/>\n", ""),
    expectedPlist.replace("<key>LSBackgroundOnly</key><true/>", "<key>LSBackgroundOnly</key><false/>"),
    expectedPlist.replace("<key>LSBackgroundOnly</key><true/>", "<key>LSBackgroundOnly</key><string>true</string>"),
  ]) {
    await writeFile(infoPath, malformed);
    const result = await inspect();
    assert.equal(result.valid, false);
    assert.ok(result.errors.includes("probe-plist-mismatch"));
  }
});

test("inspects started and exiting markers against the selected probe and host PID", async t => {
  const fixture = await makeStage(t);
  const resources = bundleResources(fixture.launcherRoot);
  const marker = { schemaVersion: 1, runId, probeId: "first", pid: 88771 };
  await writeFile(join(resources, LAUNCHER_PROBE_STARTED), JSON.stringify(marker), { mode: 0o600 });
  await writeFile(join(resources, LAUNCHER_PROBE_EXITING), JSON.stringify(marker), { mode: 0o600 });

  const terminal = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    allowMarkers: true,
    expectedProbeId: "first",
    hostPid,
    pidIsActive: () => false,
  });
  assert.equal(terminal.valid, true);
  assert.equal(terminal.selectedProbe, "first");
  assert.equal(terminal.processStarts, 1);
  assert.equal(terminal.processExits, 1);
  assert.equal(terminal.probesTerminal, true);
  assert.equal(terminal.liveProbeProcesses, 0);

  const live = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    allowMarkers: true,
    expectedProbeId: "first",
    hostPid,
    pidIsActive: () => true,
  });
  assert.equal(live.valid, false);
  assert.equal(live.probesTerminal, false);
  assert.equal(live.liveProbeProcesses, 1);

  await writeFile(join(resources, LAUNCHER_PROBE_EXITING), JSON.stringify({ ...marker, pid: 88772 }), { mode: 0o600 });
  const mismatch = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    allowMarkers: true,
    expectedProbeId: "first",
    hostPid,
    pidIsActive: () => false,
  });
  assert.equal(mismatch.valid, false);
  assert.equal(mismatch.probesTerminal, false);
});

test("inspects both ordered launch-return probe receipts and independently requires ESRCH", async t => {
  const fixture = await makeStage(t, { backgroundOnly: true });
  for (const [index, probeId] of ["first", "second"].entries()) {
    const resources = bundleResources(fixture.launcherRoot, index);
    const marker = { schemaVersion: 1, runId, probeId, pid: 88771 + index };
    await writeFile(join(resources, LAUNCHER_PROBE_STARTED), JSON.stringify(marker), { mode: 0o600 });
    await writeFile(join(resources, LAUNCHER_PROBE_EXITING), JSON.stringify(marker), { mode: 0o600 });
  }

  const terminal = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    backgroundOnly: true,
    allowMarkers: true,
    expectedProbeIds: ["first", "second"],
    hostPid,
    pidIsActive: () => false,
  });
  assert.equal(terminal.valid, true);
  assert.deepEqual(terminal.selectedProbes, ["first", "second"]);
  assert.deepEqual(terminal.probeReceipts.map(receipt => [receipt.probeId, receipt.pid, receipt.processTerminal]), [
    ["first", 88771, true],
    ["second", 88772, true],
  ]);
  assert.equal(terminal.probesTerminal, true);
  assert.equal(terminal.liveProbeProcesses, 0);

  const stillLive = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
    backgroundOnly: true,
    allowMarkers: true,
    expectedProbeIds: ["first", "second"],
    hostPid,
    pidIsActive: pid => pid === 88772,
  });
  assert.equal(stillLive.valid, false);
  assert.equal(stillLive.probesTerminal, false);
  assert.equal(stillLive.liveProbeProcesses, 1);
});

test("rejects extra files, symlinks, wrong config, and a mismatched probe receipt fingerprint", async t => {
  const fixture = await makeStage(t);
  const resources = bundleResources(fixture.launcherRoot, 1);
  const outside = join(fixture.temporary, "outside");
  await writeFile(outside, "outside");
  await symlink(outside, join(resources, "extra-link"));
  const linked = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
  });
  assert.equal(linked.valid, false);

  await rm(join(resources, "extra-link"));
  await writeFile(join(resources, "unexpected"), "unexpected");
  const extra = await inspectRendererLaunchProbes({
    root: fixture.launcherRoot,
    runId,
    executableSha256: fixture.binaryFingerprint.sha256,
  });
  assert.equal(extra.valid, false);

  const receipt = { exists: true, value: { launcherProbe: fixture.binaryFingerprint } };
  assert.equal(launcherProbeFingerprintMatchesReceipt(receipt, fixture.binaryFingerprint), true);
  assert.equal(launcherProbeFingerprintMatchesReceipt(receipt, { ...fixture.binaryFingerprint, inode: "0" }), false);
  assert.equal(launcherProbeFingerprintMatchesReceipt({ exists: true, value: { launcherProbe: {
    ...fixture.binaryFingerprint, unknown: true,
  } } }, fixture.binaryFingerprint), false);
});
