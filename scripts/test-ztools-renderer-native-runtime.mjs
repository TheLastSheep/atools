import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  MAX_CAPTURE_BYTES_PER_STREAM,
  MAX_NATIVE_TIMEOUT_MS,
  MULTIWEBVIEW_PROBE_RESOURCE,
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  cleanupOwnedFixtureRoot,
  cleanupOwnedRendererApp,
  createNativeRunDirectory,
  createBoundedCapture,
  markerMatches,
  nativeChildEnvironment,
  parseNativeRunnerArgs,
  runNativeChild,
  stageRendererNativeApp,
  validateNativeReport,
} from "./lib/ztools-renderer-native-runtime.mjs";
import {
  captureNativeSourceSnapshot,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";

const runId = "0123456789abcdef0123456789abcdef";
const identifier = `dev.atools.renderer-smoke.${runId}`;

async function temporaryDirectory() {
  return mkdtemp(join(tmpdir(), "atools-renderer-native-unit-"));
}

async function ownedRoot(parent, name, pid, options = {}) {
  const root = join(parent, name);
  await mkdir(root, { mode: 0o700 });
  if (!options.noMarker) {
    await writeFile(join(root, OWNER_MARKER_NAME), JSON.stringify({
      schemaVersion: 1,
      pid: options.markerPid ?? pid,
      identifier: options.identifier ?? identifier,
      root,
    }), { flag: "wx", mode: 0o600 });
  }
  if (options.children !== false) {
    await mkdir(join(root, "app-data"), { mode: 0o700 });
    await mkdir(join(root, "webview"), { mode: 0o700 });
  }
  return root;
}

class FakeChild extends EventEmitter {
  constructor(pid = 77721) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    if (signal === "SIGKILL") {
      setImmediate(() => {
        this.stdout.end();
        this.stderr.end();
        this.emit("close", null, "SIGKILL");
      });
    }
    return true;
  }
}

test("runner accepts a unique mode and optional absolute binary and build-receipt overrides", () => {
  assert.deepEqual(parseNativeRunnerArgs([]), { mode: "single", binary: undefined, buildReceipt: undefined });
  assert.deepEqual(parseNativeRunnerArgs(["--binary", "/tmp/renderer-smoke"]), {
    mode: "single", binary: "/tmp/renderer-smoke", buildReceipt: undefined,
  });
  assert.deepEqual(parseNativeRunnerArgs(["--mode", "multiwebview"]), {
    mode: "multiwebview", binary: undefined, buildReceipt: undefined,
  });
  assert.deepEqual(parseNativeRunnerArgs(["--mode", "settings"]), {
    mode: "settings", binary: undefined, buildReceipt: undefined,
  });
  assert.deepEqual(parseNativeRunnerArgs(["--mode", "launcher", "--launcher-probe-binary", "/tmp/owned-launch-probe"]), {
    mode: "launcher", binary: undefined, buildReceipt: undefined,
    launcherProbeBinary: "/tmp/owned-launch-probe",
  });
  assert.deepEqual(parseNativeRunnerArgs(["--build-receipt", "/tmp/native-build-binding.json"]), {
    mode: "single", binary: undefined, buildReceipt: "/tmp/native-build-binding.json",
  });
  assert.throws(() => parseNativeRunnerArgs(["--mode", "unknown"]), /single, multiwebview, settings, or launcher/);
  assert.throws(() => parseNativeRunnerArgs(["--mode", "launcher"]), /required only when --mode is launcher/);
  assert.throws(() => parseNativeRunnerArgs(["--launcher-probe-binary", "/tmp/probe"]), /required only when --mode is launcher/);
  assert.throws(() => parseNativeRunnerArgs(["--mode", "settings", "--launcher-probe-binary", "/tmp/probe"]), /required only when --mode is launcher/);
  assert.throws(() => parseNativeRunnerArgs(["--mode", "single", "--mode", "multiwebview"]), /Supported options/);
  assert.throws(() => parseNativeRunnerArgs(["--binary", "relative"]), /absolute/);
  assert.throws(() => parseNativeRunnerArgs(["--build-receipt", "relative"]), /absolute/);
  assert.throws(() => parseNativeRunnerArgs(["--mode", "launcher", "--launcher-probe-binary", "relative"]), /absolute/);
  assert.throws(() => parseNativeRunnerArgs(["--unknown"]), /Supported options/);
  assert.throws(() => parseNativeRunnerArgs(["--binary"]), /Supported options/);
  assert.throws(() => parseNativeRunnerArgs(["--binary", "/tmp/a", "--binary", "/tmp/b"]), /Supported options/);
});

test("build receipt must bind the exact native source closure and binary", () => {
  const snapshot = { sha256: "a".repeat(64), fileCount: 5 };
  const binarySha = "b".repeat(64);
  const receipt = { schemaVersion: 1, binary: { sha256: binarySha }, nativeSources: {
    sha256: snapshot.sha256, fileCount: snapshot.fileCount, stable: true,
  } };
  const fileSnapshot = { exists: true, value: receipt, exception: null };
  assert.equal(validateNativeBuildReceipt(fileSnapshot, snapshot, binarySha).valid, true);
  assert.equal(validateNativeBuildReceipt(fileSnapshot, snapshot, "c".repeat(64)).valid, false);
  assert.equal(validateNativeBuildReceipt({ exists: false }, snapshot, binarySha).valid, false);
  const first = summarizeNativeBuildReceipt(fileSnapshot);
  const reordered = summarizeNativeBuildReceipt({ exists: true, value: {
    nativeSources: receipt.nativeSources, binary: receipt.binary, schemaVersion: 1,
  } });
  assert.equal(first.contentSha256, reordered.contentSha256);
});

test("native source snapshot binds configured Rust inputs and excludes output and target", async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = {
    "Cargo.toml": "workspace manifest",
    "Cargo.lock": "workspace lock",
    "src-tauri/src/main.rs": "native entry",
    "src-tauri/src/renderer_desktop_smoke/probe.js": "probe source",
    "src-tauri/examples/ztools_renderer_desktop_smoke.rs": "example target",
    "src-tauri/examples/atools_owned_launch_probe.rs": "owned launch probe",
    "src-tauri/build.rs": "tauri build script",
    "src-tauri/Cargo.toml": "tauri crate manifest",
    "src-tauri/tauri.conf.json": "base tauri config",
    "src-tauri/tauri.ztools-renderer.conf.json": "renderer tauri config",
    "src-tauri/capabilities/default.json": "capability",
    "src-tauri/icons/icon.icns": "icon bytes",
    "crates/atools-core/Cargo.toml": "core manifest",
    "crates/atools-core/src/lib.rs": "core code",
    "target/debug/stale.rs": "ignored target source",
    "output/stale.rs": "ignored output source",
  };
  for (const [path, contents] of Object.entries(sources)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, contents);
  }

  const before = await captureNativeSourceSnapshot(root);
  const paths = before.files.map(file => file.path);
  assert.ok(paths.includes("src-tauri/src/renderer_desktop_smoke/probe.js"));
  assert.ok(paths.includes("src-tauri/examples/atools_owned_launch_probe.rs"));
  assert.ok(paths.includes("src-tauri/tauri.ztools-renderer.conf.json"));
  assert.ok(paths.includes("src-tauri/icons/icon.icns"));
  assert.ok(paths.includes("crates/atools-core/src/lib.rs"));
  assert.equal(paths.some(path => path.startsWith("target/") || path.startsWith("output/")), false);
  assert.equal(JSON.stringify(before).includes("probe source"), false);

  const binarySha = "d".repeat(64);
  const receipt = { exists: true, value: { schemaVersion: 1, binary: { sha256: binarySha }, nativeSources: {
    sha256: before.sha256, fileCount: before.fileCount, stable: true,
  } } };
  assert.equal(validateNativeBuildReceipt(receipt, before, binarySha).valid, true);
  await writeFile(join(root, "src-tauri/examples/atools_owned_launch_probe.rs"), "owned launch probe changed");
  const after = await captureNativeSourceSnapshot(root);
  assert.notEqual(before.sha256, after.sha256);
  assert.equal(validateNativeBuildReceipt(receipt, after, binarySha).valid, false);
  assert.equal(before.fileCount, after.fileCount);
});

test("native report run directories are unique, private, and beneath the dated output root", async t => {
  const root = await temporaryDirectory();
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDirectory = await createNativeRunDirectory(root, "00112233-4455-6677-8899-aabbccddeeff");
  assert.equal(runDirectory, join(root, "output/renderer-native-2026-10-27/run-00112233-4455-6677-8899-aabbccddeeff"));
  const info = await lstat(runDirectory);
  assert.equal(info.isDirectory(), true);
  assert.equal(info.mode & 0o077, 0);
});

test("native args bind exact fixture, dist, report, auto-clear, and case UUID", () => {
  assert.deepEqual(buildNativeCaseArgs({
    fixtureRoot: "/private/tmp/native-root",
    rendererDist: "/repo/packages/ztools-renderer/dist",
    output: "/repo/output/case.json",
    autoClear: "immediately",
    runId,
  }), [
    "--fixture-root", "/private/tmp/native-root",
    "--renderer-dist", "/repo/packages/ztools-renderer/dist",
    "--output", "/repo/output/case.json",
    "--auto-clear", "immediately",
    "--run-id", runId,
  ]);
  assert.throws(() => buildNativeCaseArgs({ fixtureRoot: "relative", rendererDist: "/dist", output: "/out", autoClear: "never", runId }), /absolute/);
  assert.deepEqual(buildNativeCaseArgs({
    fixtureRoot: "/private/tmp/native-root", rendererDist: "/repo/packages/ztools-renderer/dist",
    output: "/repo/output/case.json", autoClear: "never", runId, mode: "settings",
  }).slice(-2), ["--journey", "settings"]);
  assert.equal(buildNativeCaseArgs({
    fixtureRoot: "/private/tmp/native-root", rendererDist: "/repo/packages/ztools-renderer/dist",
    output: "/repo/output/case.json", autoClear: "never", runId, mode: "multiwebview",
  }).includes("--journey"), false);
  assert.deepEqual(buildNativeCaseArgs({
    fixtureRoot: "/private/tmp/native-root", rendererDist: "/repo/packages/ztools-renderer/dist",
    output: "/repo/output/case.json", autoClear: "never", runId, mode: "launcher",
  }).slice(-2), ["--journey", "launcher"]);
});

test("child smoke environment removes old activation and release flags without mutating parent", () => {
  const parent = {
    KEEP: "kept",
    ATOOLS_VISUAL_SMOKE: "1",
    ATOOLS_DESKTOP_SMOKE: "1",
    VITE_ATOOLS_DESKTOP_SMOKE: "1",
    ATOOLS_RELEASE_SMOKE_TOKEN: "secret",
    RELEASE_SMOKE_TOKEN: "secret",
  };
  const child = nativeChildEnvironment(parent);
  assert.deepEqual(child, { KEEP: "kept" });
  assert.equal(parent.ATOOLS_VISUAL_SMOKE, "1");
  assert.equal(parent.ATOOLS_RELEASE_SMOKE_TOKEN, "secret");
});

test("bounded capture records at most 64 KiB and stores no raw child output", () => {
  const capture = createBoundedCapture();
  capture.append(Buffer.alloc(MAX_CAPTURE_BYTES_PER_STREAM + 19, 97));
  const evidence = capture.metadata();
  assert.equal(evidence.capturedBytes, MAX_CAPTURE_BYTES_PER_STREAM);
  assert.equal(evidence.observedBytes, MAX_CAPTURE_BYTES_PER_STREAM + 19);
  assert.equal(evidence.truncated, true);
  assert.match(evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal("text" in evidence, false);
});

test("native report requires pass, version, autoClear, and matching owner metadata", () => {
  const root = "/private/tmp/atools-renderer-native-test-root";
  const owner = { schemaVersion: 1, pid: 77721, identifier, root };
  assert.equal(markerMatches(owner, root, 77721), true);
  const valid = validateNativeReport({
    version: 1,
    autoClear: "never",
    passed: true,
    identifier,
    metadata: { profileRoot: root },
  }, { autoClear: "never", marker: owner, fixtureRoot: root, childPid: 77721 });
  assert.equal(valid.valid, true);
  assert.equal(validateNativeReport({ version: 1, autoClear: "never", passed: true, profile: { identifier, root: "/other" } }, {
    autoClear: "never", marker: owner, fixtureRoot: root, childPid: 77721,
  }).valid, false);
  assert.equal(validateNativeReport({ version: 1, autoClear: "immediately", passed: true }, {
    autoClear: "never", marker: owner, fixtureRoot: root, childPid: 77721,
  }).valid, false);
});

test("owned profile cleanup requires terminal process and exact marker PID", async t => {
  const parent = await temporaryDirectory();
  t.after(() => rm(parent, { recursive: true, force: true }));

  const liveRoot = await ownedRoot(parent, "live", 77721);
  const live = await cleanupOwnedFixtureRoot({ root: liveRoot, childPid: 77721, processTerminal: false });
  assert.equal(live.status, "not_attempted");
  assert.equal(live.processTerminal, false);
  assert.equal(live.rootAbsent, false);
  assert.equal((await lstat(liveRoot)).isDirectory(), true);

  const wrongPidRoot = await ownedRoot(parent, "wrong-pid", 77721, { markerPid: 12345 });
  const wrongPid = await cleanupOwnedFixtureRoot({ root: wrongPidRoot, childPid: 77721, processTerminal: true });
  assert.equal(wrongPid.status, "preserved");
  assert.equal(wrongPid.reason, "owner_marker_mismatch");
  assert.equal(wrongPid.rootAbsent, false);

  const unknownPidRoot = await ownedRoot(parent, "unknown-pid", 77721);
  const unknownPid = await cleanupOwnedFixtureRoot({ root: unknownPidRoot, childPid: null, processTerminal: true });
  assert.equal(unknownPid.status, "preserved");
  assert.equal(unknownPid.reason, "owner_marker_mismatch");
  assert.equal(unknownPid.rootAbsent, false);
});

test("roots without this run's owner marker remain; owned root symlinks are never followed", async t => {
  const parent = await temporaryDirectory();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const emptyRoot = join(parent, "empty");
  await mkdir(emptyRoot, { mode: 0o700 });
  const empty = await cleanupOwnedFixtureRoot({ root: emptyRoot, childPid: 77721, processTerminal: true });
  assert.equal(empty.status, "preserved");
  assert.equal(empty.reason, "owner_marker_missing");
  assert.equal(empty.rootAbsent, false);
  assert.equal((await lstat(emptyRoot)).isDirectory(), true);

  const noPidRoot = join(parent, "unknown-pid-empty");
  await mkdir(noPidRoot, { mode: 0o700 });
  const noPid = await cleanupOwnedFixtureRoot({ root: noPidRoot, childPid: null, processTerminal: true });
  assert.equal(noPid.reason, "owner_marker_missing");
  assert.equal(noPid.rootAbsent, false);
  assert.equal((await lstat(noPidRoot)).isDirectory(), true);

  const absent = await cleanupOwnedFixtureRoot({ root: join(parent, "already-absent"), childPid: null, processTerminal: true });
  assert.equal(absent.status, "already_absent");
  assert.equal(absent.rootAbsent, true);

  const nonemptyRoot = join(parent, "nonempty");
  await mkdir(nonemptyRoot, { mode: 0o700 });
  await writeFile(join(nonemptyRoot, "keep"), "preserve");
  const nonempty = await cleanupOwnedFixtureRoot({ root: nonemptyRoot, childPid: 77721, processTerminal: true });
  assert.equal(nonempty.reason, "owner_marker_missing");
  assert.equal(nonempty.rootAbsent, false);

  const target = join(parent, "target");
  await mkdir(target);
  await writeFile(join(target, "keep"), "preserve");
  const rootLink = join(parent, "root-link");
  await symlink(target, rootLink);
  const linked = await cleanupOwnedFixtureRoot({ root: rootLink, childPid: 77721, processTerminal: true });
  assert.equal(linked.reason, "root_not_real_directory");
  assert.equal(await readFile(join(target, "keep"), "utf8"), "preserve");
});

test("profile child paths reject symlinks, while nested symlinks are unlinked without deleting targets", async t => {
  const parent = await temporaryDirectory();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const target = join(parent, "outside");
  await mkdir(target);
  await writeFile(join(target, "keep"), "preserve");

  const topLinkRoot = await ownedRoot(parent, "top-link", 77721, { children: false });
  await symlink(target, join(topLinkRoot, "app-data"));
  const topLink = await cleanupOwnedFixtureRoot({ root: topLinkRoot, childPid: 77721, processTerminal: true });
  assert.equal(topLink.reason, "app-data_not_real_directory");
  assert.equal(await readFile(join(target, "keep"), "utf8"), "preserve");

  const nestedLinkRoot = await ownedRoot(parent, "nested-link", 77721);
  await symlink(target, join(nestedLinkRoot, "app-data", "external"));
  const nestedLink = await cleanupOwnedFixtureRoot({ root: nestedLinkRoot, childPid: 77721, processTerminal: true });
  assert.equal(nestedLink.status, "removed_owned_root");
  assert.equal(nestedLink.rootAbsent, true);
  assert.equal(await readFile(join(target, "keep"), "utf8"), "preserve");
});

test("timeout sends TERM then KILL only through the spawned child handle", async () => {
  const child = new FakeChild();
  let received = null;
  const result = await runNativeChild("/absolute/mock-binary", ["--arg"], {
    timeoutMs: 10,
    termGraceMs: 5,
    killGraceMs: 100,
    spawnImpl: (binary, args, options) => {
      received = { binary, args, options };
      return child;
    },
  });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(received.binary, "/absolute/mock-binary");
  assert.deepEqual(received.args, ["--arg"]);
  assert.equal(received.options.shell, false);
  assert.deepEqual(received.options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(result.pid, 77721);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminalObserved, true);
  assert.equal(result.signal, "SIGKILL");
});

test("timeout never signals a process without a known spawned PID", async () => {
  const child = new FakeChild();
  child.pid = undefined;
  const result = await runNativeChild("/absolute/mock-binary", [], {
    timeoutMs: 5,
    noHandleGraceMs: 5,
    spawnImpl: () => child,
  });
  assert.deepEqual(child.signals, []);
  assert.equal(result.pid, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.terminalObserved, false);
});

test("timeout bound includes bounded settings and multiwebview budgets without starting over-limit children", async () => {
  assert.equal(MAX_NATIVE_TIMEOUT_MS, 180_000);
  let spawned = false;
  await assert.rejects(runNativeChild("/absolute/mock-binary", [], {
    timeoutMs: MAX_NATIVE_TIMEOUT_MS + 1,
    spawnImpl: () => { spawned = true; return new FakeChild(); },
  }), /180000 ms/);
  assert.equal(spawned, false);
});

test("simulated child output is bounded independently on stdout and stderr", async () => {
  const child = new FakeChild(77722);
  const noisy = Buffer.alloc(MAX_CAPTURE_BYTES_PER_STREAM + 8, 120);
  const resultPromise = runNativeChild("/absolute/mock-binary", [], {
    timeoutMs: 500,
    spawnImpl: () => {
      setImmediate(() => {
        child.stdout.end(noisy);
        child.stderr.end(noisy);
        setImmediate(() => child.emit("close", 0, null));
      });
      return child;
    },
  });
  const result = await resultPromise;
  assert.equal(result.terminalObserved, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.capturedBytes, MAX_CAPTURE_BYTES_PER_STREAM);
  assert.equal(result.stderr.capturedBytes, MAX_CAPTURE_BYTES_PER_STREAM);
  assert.equal(result.stdout.truncated, true);
  assert.equal(result.stderr.truncated, true);
});

test("staged app bundle has reviewed identity and remains until process terminal", async t => {
  const parent = await temporaryDirectory();
  t.after(() => rm(parent, { recursive: true, force: true }));
  const runDirectory = join(parent, "run");
  await mkdir(runDirectory, { mode: 0o700 });
  const binary = join(parent, "native-binary");
  await writeFile(binary, "synthetic native executable", { mode: 0o755 });
  await chmod(binary, 0o755);
  const sourceSha256 = await (async () => {
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(await readFile(binary)).digest("hex");
  })();
  const staged = await stageRendererNativeApp({
    binary,
    runDirectory,
    autoClear: "never",
    runId,
    expectedSha256: sourceSha256,
    mode: "multiwebview",
  });
  assert.equal(staged.identifier, identifier);
  assert.equal(staged.stagedSha256, sourceSha256);
  assert.match(staged.infoPlist, /<key>CFBundleExecutable<\/key><string>AToolsRendererSmoke<\/string>/);
  assert.match(staged.infoPlist, /<key>LSUIElement<\/key><false\/>/);
  assert.match(staged.infoPlist, /<key>NSHighResolutionCapable<\/key><true\/>/);
  const probePath = join(staged.bundlePath, "Contents/Resources", MULTIWEBVIEW_PROBE_RESOURCE);
  const probeInfo = await lstat(probePath);
  assert.equal(probeInfo.isFile(), true);
  assert.equal(probeInfo.mode & 0o077, 0);
  assert.equal(await readFile(probePath, "utf8"), "ATools renderer multiwebview resource probe\n");
  assert.equal(staged.probeResource.path, `Contents/Resources/${MULTIWEBVIEW_PROBE_RESOURCE}`);
  assert.equal(staged.probeResource.bytes, Buffer.byteLength("ATools renderer multiwebview resource probe\n"));
  assert.match(staged.probeResource.sha256, /^[0-9a-f]{64}$/);
  assert.equal(constants.COPYFILE_EXCL > 0, true);
  const live = await cleanupOwnedRendererApp({
    bundlePath: staged.bundlePath,
    runDirectory: staged.runDirectory,
    ownerIdentity: staged.ownerIdentity,
    processTerminal: false,
  });
  assert.equal(live.bundleAbsent, false);
  assert.equal((await lstat(staged.bundlePath)).isDirectory(), true);
  const cleaned = await cleanupOwnedRendererApp({
    bundlePath: staged.bundlePath,
    runDirectory: staged.runDirectory,
    ownerIdentity: staged.ownerIdentity,
    processTerminal: true,
  });
  assert.equal(cleaned.bundleAbsent, true);

  const single = await stageRendererNativeApp({
    binary,
    runDirectory,
    autoClear: "immediately",
    runId,
    expectedSha256: sourceSha256,
  });
  assert.equal(single.probeResource, null);
  await assert.rejects(lstat(join(single.bundlePath, "Contents/Resources", MULTIWEBVIEW_PROBE_RESOURCE)), { code: "ENOENT" });
  const singleCleaned = await cleanupOwnedRendererApp({
    bundlePath: single.bundlePath,
    runDirectory: single.runDirectory,
    ownerIdentity: single.ownerIdentity,
    processTerminal: true,
  });
  assert.equal(singleCleaned.bundleAbsent, true);
  const launcher = await stageRendererNativeApp({
    binary, runDirectory, autoClear: "never", runId, expectedSha256: sourceSha256, mode: "launcher",
  });
  assert.equal(launcher.mode, "launcher");
  assert.equal(launcher.probeResource, null);
  const launcherCleaned = await cleanupOwnedRendererApp({
    bundlePath: launcher.bundlePath, runDirectory: launcher.runDirectory,
    ownerIdentity: launcher.ownerIdentity, processTerminal: true,
  });
  assert.equal(launcherCleaned.bundleAbsent, true);
  await assert.rejects(stageRendererNativeApp({
    binary, runDirectory, autoClear: "never", runId, expectedSha256: sourceSha256, mode: "settings",
  }), /Invalid renderer app staging inputs/);
});
