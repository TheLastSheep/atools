import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { captureNativeSourceSnapshot, fingerprintNativeExecutable, summarizeNativeBuildReceipt,
  validateNativeBuildReceipt } from "./lib/ztools-renderer-native-source-binding.mjs";
import { setupNativeRendererSourceLock, snapshotNativeRendererSources } from "./lib/ztools-renderer-native-source-snapshots.mjs";
import { readJsonFile } from "./lib/ztools-renderer-launch-runtime.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import { runMainPanelNativeCase } from "./lib/ztools-main-panel-native-case.mjs";
import { runNativeChild } from "./lib/ztools-renderer-native-runtime.mjs";
import { readDesktopSession, assertInteractiveDesktopSession } from "./lib/ztools-main-panel-desktop-session.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const reportParent = join(root, "output/renderer-main-panel-native-2026-10-29");
const fixtureFiles = [
  "scripts/test-ztools-main-panel-native.mjs",
  "scripts/lib/ztools-main-panel-native-case.mjs",
  "scripts/lib/ztools-main-panel-native-case.test.mjs",
  "scripts/lib/ztools-main-panel-native-report.mjs",
  "scripts/lib/ztools-main-panel-native-report.test.mjs",
  "scripts/lib/ztools-main-panel-desktop-session.mjs",
  "scripts/lib/ztools-main-panel-desktop-session.test.mjs",
  "scripts/lib/ztools-renderer-native-runtime.mjs",
  "scripts/lib/ztools-renderer-native-source-binding.mjs",
  "scripts/lib/ztools-renderer-native-source-snapshots.mjs",
  "scripts/lib/ztools-renderer-browser-source-lock.mjs",
  "scripts/lib/ztools-renderer-launch-runtime.mjs",
  "scripts/lib/ztools-launcher-native-validation.mjs",
  "scripts/lib/ztools-renderer-launch-probes.mjs",
  "scripts/lib/ztools-settings-native-sources.mjs",
  "scripts/lib/ztools-settings-resource-budget.mjs",
  "packages/ztools-settings/src/host-bridge-build.mjs",
  "scripts/lib/ztools-renderer-native-provenance.mjs",
];
const hashJson = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (left, right) => left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
const sourceSummary = value => value ? { sha256: value.sha256, fileCount: value.fileCount, totalBytes: value.totalBytes } : null;
const fileMapSummary = value => value && typeof value === "object" && !Array.isArray(value)
  ? { sha256: hashJson(value), fileCount: Object.keys(value).length } : null;
const exception = error => ({ name: String(error?.name || "Error").slice(0, 80),
  code: error?.code ? String(error.code).slice(0, 80) : null,
  message: String(error?.message || "Main panel acceptance failed").slice(0, 400) });

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    assert.ok(["--binary", "--build-receipt"].includes(flag) && !values.has(flag)
      && typeof value === "string" && isAbsolute(value), "Use unique absolute --binary and --build-receipt paths");
    values.set(flag, value);
  }
  assert.equal(values.size, 2, "Both --binary and --build-receipt are required");
  return { binary: values.get("--binary"), receipt: values.get("--build-receipt") };
}

async function createRunDirectory(runId) {
  await mkdir(reportParent, { recursive: true, mode: 0o700 });
  for (const path of [join(root, "output"), reportParent]) {
    const info = await lstat(path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && await realpath(path) === path,
      "Report parent must be a canonical directory");
  }
  const path = join(reportParent, "run-" + runId);
  await mkdir(path, { mode: 0o700 });
  const info = await lstat(path, { bigint: true });
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && Number(info.mode & 0o777n) === 0o700
    && await realpath(path) === path, "Run directory must be fresh and private");
  return path;
}

async function receiptAge(path) {
  assert.equal(await realpath(path), path, "Receipt must be canonical");
  assert.equal(dirname(path), reportParent, "Use a receipt from the main-panel report parent");
  assert.match(basename(path), /^native-build-receipt-\d+\.json$/);
  const info = await lstat(path, { bigint: true });
  const age = Date.now() - Number(info.mtimeMs);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && info.size > 0n
    && info.size <= 1024n * 1024n && age >= 0 && age < 86_400_000, "Use a fresh bounded build receipt");
  return age;
}

function summarizeSnapshot(snapshot) {
  return {
    packageFiles: fileMapSummary(snapshot.packageFiles), distFiles: fileMapSummary(snapshot.distFiles),
    upstream: snapshot.upstream ? { commit: snapshot.upstream.commit, clean: snapshot.upstream.dirty === "",
      sha256: snapshot.upstream.sha256, files: snapshot.upstream.files } : null,
    errors: snapshot.errors.map(({ area, name, code }) => ({ area, name, code: code ?? null })),
  };
}

async function validateRenderer(sourceLock, snapshot) {
  assert.equal(snapshot.errors.length, 0, "All source snapshots must be readable");
  assert.ok(snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Original renderer entry is missing");
  const manifest = await readJsonFile(join(packageRoot, "source-manifest.json"), 256 * 1024);
  const provenance = await readJsonFile(join(distRoot, "build-provenance.json"), 512 * 1024);
  assert.ok(manifest.exists && manifest.value && provenance.exists && provenance.value, "Strict renderer provenance is required");
  const adapter = await sourceLock.readHostAdapterSources();
  assert.ok(adapter.length > 0 && adapter.length <= 64 && new Set(adapter.map(item => item.path)).size === adapter.length);
  assert.deepEqual(adapter, provenance.value.hostAdapterSources, "Current host adapter sources differ from dist provenance");
  const chunks = Object.keys(snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
  assert.equal(chunks.length, 3, "Use the fixed original renderer chunk set");
  let bytes = 0;
  for (const path of chunks) {
    assert.ok(path.startsWith("packages/ztools-renderer/dist/"));
    bytes += (await readFile(join(root, path))).byteLength;
  }
  validateRendererNativeProvenance(manifest.value, provenance.value, snapshot.upstream, bytes);
  return { sourceCommit: provenance.value.sourceCommit, sourceTreeSha256: provenance.value.sourceTreeSha256,
    sourceFiles: provenance.value.sourceFiles, totalJavaScriptBytes: bytes, chunkCount: chunks.length,
    hostAdapterSourceCount: adapter.length, hostAdapterSourceSha256: hashJson(adapter) };
}

function observedProcess(runDirectory, runId, diagnostics) {
  const prefixes = [
    ["main-panel-prototype installation-diagnostic ", "main-panel-installation-diagnostic"],
    ["main-panel-prototype constructor-probe ", "main-panel-constructor-probe"],
  ];
  return (binary, args, options) => runNativeChild(binary, args, { ...options, spawnImpl(...parameters) {
    assert.equal(binary, join(runDirectory, "case-never.app/Contents/MacOS/AToolsRendererSmoke"));
    const child = spawn(...parameters);
    let pending = "";
    const accept = line => {
      const match = prefixes.find(([prefix]) => line.startsWith(prefix));
      if (!match) return;
      const [prefix, kind] = match;
      if (line.length > 8192 || diagnostics.events.length >= 2 || diagnostics.errors.length >= 2) {
        if (diagnostics.errors.length < 2) diagnostics.errors.push("diagnostic-over-bound");
        return;
      }
      try {
        const value = JSON.parse(line.slice(prefix.length));
        assert.equal(value.schemaVersion, 1);
        assert.equal(value.kind, kind);
        assert.equal(value.pid, child.pid);
        assert.equal(value.runId, runId);
        if (kind === "main-panel-installation-diagnostic") {
          assert.match(value.errorCode, /^MAIN_PANEL_[A-Z_]+$/);
        } else {
          assert.equal(value.fullProductAcceptance, false);
          assert.ok(value.errorCode === null || /^CONSTRUCTOR_PROBE_[A-Z_]+$/.test(value.errorCode));
        }
        diagnostics.events.push(value);
      } catch { diagnostics.errors.push("diagnostic-invalid-or-unavailable"); }
    };
    child.stderr?.on("data", chunk => {
      pending += chunk.toString("utf8");
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) accept(line);
      if (pending.length > 8192) {
        if (prefixes.some(([prefix]) => pending.startsWith(prefix)) && diagnostics.errors.length < 2) diagnostics.errors.push("diagnostic-over-bound");
        pending = "";
      }
    });
    child.stderr?.on("end", () => { if (pending) accept(pending); });
    return child;
  } });
}

export async function runMainPanelNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  const runDirectory = await createRunDirectory(runId);
  const reportPath = join(runDirectory, "report.json");
  const report = {
    schemaVersion: 1, journey: "main-panel", scope: "isolated-main-window-panel-prototype",
    runId, startedAt: new Date().toISOString(), finishedAt: null, passed: false, fullProductAcceptance: false,
    runner: { productNode: false, nodeVersion: process.versions.node,
      constructorProbeRequested: process.env.ATOOLS_MAIN_PANEL_CONSTRUCTOR_PROBE === "1" },
    source: { before: null, after: null, nativeBefore: null, nativeAfter: null,
      packageStable: false, distStable: false, upstreamStable: false, nativeStable: false, provenance: null },
    binary: { before: null, stable: false },
    buildReceipt: { before: null, after: null, ageMs: null, matchesRunInputs: false, stable: false },
    diagnostics: { events: [], errors: [] }, case: null, exception: null,
    desktopSession: { before: null, after: null, interactiveBefore: false, interactiveAfter: false,
      afterException: null },
  };
  let cli = null, sourceLock = null, upstreamPath = null, nativeBefore = null, binaryBefore = null;
  let preflight = false;
  try {
    cli = parseArgs(argv);
    assert.equal(process.platform, "darwin");
    assert.equal(process.versions.node, "22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(join(root, "src-tauri/binaries/node-aarch64-apple-darwin")));
    report.runner.productNode = true;
    report.buildReceipt.ageMs = await receiptAge(cli.receipt);
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    assert.ok(upstreamPath && isAbsolute(upstreamPath), "Set the absolute pinned ATOOLS_ZTOOLS_SOURCE");
    const setup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles });
    sourceLock = setup.sourceLock;
    report.source.before = summarizeSnapshot(setup.snapshot);
    report.source.provenance = await validateRenderer(sourceLock, setup.snapshot);
    nativeBefore = await captureNativeSourceSnapshot(root);
    report.source.nativeBefore = sourceSummary(nativeBefore);
    binaryBefore = await fingerprintNativeExecutable(cli.binary);
    report.binary.before = { sha256: binaryBefore.sha256, sizeBytes: binaryBefore.sizeBytes,
      mtimeNs: binaryBefore.mtimeNs, device: binaryBefore.device, inode: binaryBefore.inode };
    const receipt = await readJsonFile(cli.receipt, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(receipt);
    const binding = validateNativeBuildReceipt(receipt, nativeBefore, binaryBefore.sha256);
    report.buildReceipt.matchesRunInputs = binding.valid;
    assert.equal(binding.valid, true, "Fresh build receipt must bind current Native sources and the exact executable");
    report.desktopSession.before = await readDesktopSession();
    assertInteractiveDesktopSession(report.desktopSession.before);
    report.desktopSession.interactiveBefore = true;
    preflight = true;
    report.case = await runMainPanelNativeCase({ runDirectory, workspaceRoot: root, binaryFingerprint: binaryBefore,
      rendererDist: distRoot, runId, runProcess: observedProcess(runDirectory, runId, report.diagnostics) });
  } catch (error) {
    report.exception = exception(error);
  } finally {
    if (preflight) {
      try {
        report.desktopSession.after = await readDesktopSession();
        assertInteractiveDesktopSession(report.desktopSession.after);
        report.desktopSession.interactiveAfter = true;
      } catch (error) { report.desktopSession.afterException = exception(error); }
    }
    if (sourceLock) {
      try {
        report.source.after = summarizeSnapshot(await snapshotNativeRendererSources(sourceLock, upstreamPath));
        const complete = report.source.before?.errors.length === 0 && report.source.after.errors.length === 0;
        report.source.packageStable = complete && same(report.source.before.packageFiles, report.source.after.packageFiles);
        report.source.distStable = complete && same(report.source.before.distFiles, report.source.after.distFiles);
        report.source.upstreamStable = complete && report.source.before.upstream?.clean === true
          && same(report.source.before.upstream, report.source.after.upstream);
      } catch (error) { report.source.afterException = exception(error); }
    }
    if (nativeBefore) {
      try {
        report.source.nativeAfter = sourceSummary(await captureNativeSourceSnapshot(root));
        report.source.nativeStable = same(report.source.nativeBefore, report.source.nativeAfter);
      } catch (error) { report.source.nativeAfterException = exception(error); }
    }
    if (binaryBefore) {
      try {
        const after = await fingerprintNativeExecutable(binaryBefore.path);
        report.binary.stable = ["sha256", "sizeBytes", "mtimeNs", "device", "inode"].every(key => after[key] === binaryBefore[key]);
      } catch (error) { report.binary.afterException = exception(error); }
    }
    if (cli) {
      try {
        report.buildReceipt.after = summarizeNativeBuildReceipt(await readJsonFile(cli.receipt, 1024 * 1024));
        report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256
          && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256);
      } catch (error) { report.buildReceipt.afterException = exception(error); }
    }
    report.finishedAt = new Date().toISOString();
    report.passed = preflight && report.exception === null && report.case?.passed === true
      && report.diagnostics.errors.length === 0
      && report.desktopSession.interactiveBefore && report.desktopSession.interactiveAfter
      && report.binary.stable && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable
      && report.source.packageStable && report.source.distStable && report.source.upstreamStable && report.source.nativeStable;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log("main-panel Native report: " + relative(root, reportPath));
    console.log("main-panel passed=" + report.passed + "; owned-clean=" + (report.case?.cleanup?.allOwnedResourcesClean ?? false));
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMainPanelNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error("main-panel runner failed: " + JSON.stringify(exception(error)));
    process.exitCode = 1;
  });
}
