import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureNativeSourceSnapshot,
  fingerprintNativeExecutable,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";
import { readJsonFile } from "./lib/ztools-renderer-launch-runtime.mjs";
import { setupNativeRendererSourceLock, snapshotNativeRendererSources } from "./lib/ztools-renderer-native-source-snapshots.mjs";
import {
  assertSettingsNativeSourcesUnchanged,
  captureSettingsNativeSources,
  summarizeSettingsNativeSources,
} from "./lib/ztools-settings-native-sources.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import { runMainHotkeyStartupNativeCase, parseMainHotkeyStartupNativeArgs } from "./lib/ztools-main-hotkey-startup-native-case.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const reportParent = join(root, "output/renderer-main-hotkey-startup-native-2026-10-29");
const fixtureFiles = [
  "docs/contracts/ztools-main-hotkey-startup-recovery-2026-10-29.md",
  "scripts/test-ztools-main-hotkey-startup-native.mjs",
  "scripts/lib/ztools-main-hotkey-startup-native-case.mjs",
  "scripts/lib/ztools-main-hotkey-startup-native-case.test.mjs",
  "scripts/lib/ztools-main-hotkey-startup-native-report.mjs",
  "scripts/lib/ztools-main-hotkey-startup-native-report.test.mjs",
  "scripts/lib/ztools-main-hotkey-startup-probe.test.mjs",
  "scripts/lib/ztools-renderer-native-provenance.test.mjs",
  "scripts/lib/ztools-renderer-native-runtime.mjs",
  "scripts/lib/ztools-renderer-native-source-binding.mjs",
  "scripts/lib/ztools-renderer-native-source-snapshots.mjs",
  "scripts/lib/ztools-renderer-browser-source-lock.mjs",
  "scripts/lib/ztools-renderer-launch-runtime.mjs",
  "scripts/lib/ztools-settings-native-sources.mjs",
  "scripts/lib/ztools-settings-input-native-bundle.mjs",
  "scripts/lib/ztools-settings-input-native-bundle.test.mjs",
  "scripts/lib/ztools-settings-input-builtin-control.mjs",
  "scripts/lib/ztools-settings-input-builtin-control.test.mjs",
  "scripts/lib/ztools-settings-input-native-case.mjs",
  "scripts/lib/ztools-settings-input-native-case.test.mjs",
  "scripts/lib/ztools-settings-input-native-report.mjs",
  "scripts/lib/ztools-settings-resource-budget.mjs",
  "scripts/lib/ztools-renderer-native-provenance.mjs",
  "scripts/lib/ztools-settings-resource-budget.test.mjs",
  "packages/ztools-renderer/build.mjs",
  "packages/ztools-renderer/upstream-compatibility-patches.mjs",
  "packages/ztools-renderer/post-minifier.mjs",
  "packages/ztools-renderer/output-transaction.mjs",
  "packages/ztools-renderer/package.json",
  "packages/ztools-renderer/package-lock.json",
  "packages/ztools-renderer/source-manifest.json",
  "resources/plugins/builtin/timestamp/index.html",
  "resources/plugins/builtin/timestamp/logo.svg",
  "resources/plugins/builtin/timestamp/plugin.json",
  "src-tauri/src/renderer_desktop_smoke/mod.rs",
  "src-tauri/src/renderer_desktop_smoke/fixture_owner.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/mod.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/probe.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/probe_assets.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/probe_operation_schema.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/schema.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/state.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/main_hotkey_startup_journey.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/main_hotkey_startup_schema.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/main_hotkey_startup_storage.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/main_hotkey_startup/probe.rs",
  "src-tauri/src/renderer_desktop_smoke/settings_input_journey/main_hotkey_startup/main-hotkey-startup-probe.js",
];

function safeException(error) {
  return { name: String(error?.name || "Error").slice(0, 80), code: error?.code ? String(error.code).slice(0, 80) : null };
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sameJson(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function summarizeFileMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { fileCount: Object.keys(value).length, sha256: hashJson(value) };
}

function summarizeNativeSources(value) {
  return value ? { sha256: value.sha256, fileCount: value.fileCount, totalBytes: value.totalBytes } : null;
}

function summarizeUpstream(value) {
  return value ? {
    commit: value.commit, clean: value.dirty === "", files: value.files, sha256: value.sha256,
  } : null;
}

async function createRunDirectory(runId) {
  const outputRoot = join(root, "output");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(outputRoot, { bigint: true });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || await realpath(outputRoot) !== outputRoot) {
    throw new Error("Output root must be a real canonical directory");
  }
  await mkdir(reportParent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(reportParent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(reportParent) !== reportParent) {
    throw new Error("Native report parent must be a real canonical directory");
  }
  const runDirectory = join(reportParent, "run-" + runId);
  await mkdir(runDirectory, { mode: 0o700 });
  const runInfo = await lstat(runDirectory, { bigint: true });
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o077n) !== 0
      || await realpath(runDirectory) !== runDirectory) throw new Error("Native run directory must be private");
  return runDirectory;
}

async function validateBuildReceiptPath(path) {
  const canonical = await realpath(path);
  assert.equal(canonical, path, "Use a canonical run-specific build receipt path");
  assert.equal(dirname(canonical), reportParent, "Use a fresh main-hotkey build receipt in this report parent");
  assert.match(basename(canonical), /^native-build-receipt-\d+\.json$/, "Build receipt filename must be unique");
  const info = await lstat(path, { bigint: true });
  const ageMs = Date.now() - Number(info.mtimeMs);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    && info.size > 0n && info.size <= 1024n * 1024n && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000,
  "Build receipt must be a fresh regular file");
  return ageMs;
}

async function captureActualRendererBundle(sourceLock, snapshot, manifest, provenance) {
  assert.equal(snapshot.errors.length, 0, "Package, dist, and pinned upstream snapshots must be readable");
  assert.ok(snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Original renderer entry is missing");
  const adapterSources = await sourceLock.readHostAdapterSources();
  assert.ok(adapterSources.length > 0 && adapterSources.length <= 64, "Host adapter source set must be bounded");
  assert.equal(new Set(adapterSources.map(item => item.path)).size, adapterSources.length, "Host adapter paths must be unique");
  assert.ok(adapterSources.every(item => typeof item.path === "string" && item.path.endsWith(".ts")
    && Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[0-9a-f]{64}$/.test(item.sha256)),
  "Host adapter source hashes must be complete");
  assert.deepEqual(adapterSources, provenance.hostAdapterSources, "Renderer provenance does not bind current host adapter sources");
  const chunks = Object.keys(snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
  assert.equal(chunks.length, 3, "Use the pinned renderer's three emitted JavaScript chunks");
  assert.ok(chunks.every(path => path.startsWith("packages/ztools-renderer/dist/")), "Renderer chunks escaped the locked dist");
  let actualJavaScriptBytes = 0;
  for (const path of chunks) actualJavaScriptBytes += (await readFile(join(root, path))).byteLength;
  validateRendererNativeProvenance(manifest, provenance, snapshot.upstream, actualJavaScriptBytes);
  return { adapterSources, chunkCount: chunks.length, actualJavaScriptBytes };
}

function setupFileMap(snapshot, key) {
  return snapshot?.[key]?.sha256 ? snapshot[key] : null;
}

export async function runMainHotkeyStartupNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  let runDirectory;
  try { runDirectory = await createRunDirectory(runId); }
  catch (error) {
    console.error("main-hotkey report directory unavailable (" + (error.code || error.name || "error") + ")");
    return 1;
  }
  const reportPath = join(runDirectory, "report.json");
  const report = {
    schemaVersion: 1, journey: "main-hotkey-startup-recovery", scope: "two-process-same-db-owned-hotkey-recovery",
    runId, startedAt: new Date().toISOString(), finishedAt: null, passed: false,
    runner: { nodeVersion: process.versions.node, productRuntime: false },
    binary: { sha256: null, sizeBytes: null, stable: false },
    source: { before: null, after: null, nativeSourcesBefore: null, nativeSourcesAfter: null,
      packageSourceStable: false, upstreamStable: false, distStable: false, nativeSourcesStable: false,
      settingsBefore: null, settingsAfter: null, settingsStable: false, settingsBundleStaged: false,
      provenance: null, errors: [] },
    buildReceipt: { before: null, after: null, matchesRunInputs: false, stable: false, ageMs: null, validationErrors: [] },
    case: null, exception: null, reportPath: relative(root, reportPath).split("\\").join("/"),
  };
  let cli = null;
  let sourceLock = null;
  let setup = null;
  let settingsSourceSnapshot = null;
  let nativeSourcesSnapshot = null;
  let upstreamPath = null;
  let binaryPath = null;
  let binaryBefore = null;
  let preflightPassed = false;
  try {
    cli = parseMainHotkeyStartupNativeArgs(argv);
    assert.equal(process.platform, "darwin", "Native main-hotkey acceptance requires macOS");
    assert.equal(process.versions.node, "22.23.3", "Use the pinned Product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the ATools Product Node binary");
    report.runner.productRuntime = true;
    report.buildReceipt.ageMs = await validateBuildReceiptPath(cli.buildReceipt);
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    assert.ok(upstreamPath && isAbsolute(upstreamPath), "Set ATOOLS_ZTOOLS_SOURCE to the absolute pinned ZTools checkout");

    setup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles });
    sourceLock = setup.sourceLock;
    report.source.before = {
      packageFiles: summarizeFileMap(setup.snapshot.packageFiles),
      distFiles: summarizeFileMap(setup.snapshot.distFiles),
      upstream: summarizeUpstream(setup.snapshot.upstream),
      errors: setup.snapshot.errors.map(item => ({ area: item.area, name: item.name, code: item.code ?? null })),
    };
    nativeSourcesSnapshot = await captureNativeSourceSnapshot(root);
    report.source.nativeSourcesBefore = summarizeNativeSources(nativeSourcesSnapshot);
    settingsSourceSnapshot = await captureSettingsNativeSources(root);
    report.source.settingsBefore = summarizeSettingsNativeSources(settingsSourceSnapshot);
    const manifestFile = await readJsonFile(join(packageRoot, "source-manifest.json"), 256 * 1024);
    const provenanceFile = await readJsonFile(join(distRoot, "build-provenance.json"), 512 * 1024);
    assert.ok(manifestFile.exists && manifestFile.value && provenanceFile.exists && provenanceFile.value,
      "Renderer source manifest and strict dist provenance are required");
    const bundle = await captureActualRendererBundle(sourceLock, setup.snapshot, manifestFile.value, provenanceFile.value);
    report.source.provenance = {
      sourceCommit: provenanceFile.value.sourceCommit,
      sourceTreeSha256: provenanceFile.value.sourceTreeSha256,
      sourceFiles: provenanceFile.value.sourceFiles,
      totalJavaScriptBytes: bundle.actualJavaScriptBytes, runtimeChunkCount: bundle.chunkCount,
      hostAdapterSourceCount: bundle.adapterSources.length, hostAdapterSourceSha256: hashJson(bundle.adapterSources),
      settingsSourcesSha256: settingsSourceSnapshot.sha256, settingsSourceFileCount: settingsSourceSnapshot.packageFileCount,
      settingsSourceBytes: settingsSourceSnapshot.packageBytes, settingsBundleBytes: settingsSourceSnapshot.bundle.resourceBytes,
    };

    binaryBefore = await fingerprintNativeExecutable(cli.binary);
    binaryPath = binaryBefore.path;
    report.binary.sha256 = binaryBefore.sha256;
    report.binary.sizeBytes = binaryBefore.sizeBytes;
    const receiptBefore = await readJsonFile(cli.buildReceipt, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(receiptBefore);
    const binding = validateNativeBuildReceipt(receiptBefore, nativeSourcesSnapshot, binaryBefore.sha256);
    report.buildReceipt.matchesRunInputs = binding.valid;
    report.buildReceipt.validationErrors = binding.errors;
    assert.equal(binding.valid, true, "Fresh receipt must bind the exact binary and current Native source closure");
    preflightPassed = true;
    report.case = await runMainHotkeyStartupNativeCase({
      runDirectory, workspaceRoot: root, binaryFingerprint: binaryBefore, rendererDist: distRoot, runId,
      settingsSourceSnapshot, nativeSourceHashes: setup.snapshot.packageFiles,
    });
  } catch (error) {
    report.exception = safeException(error);
  } finally {
    if (sourceLock) {
      const after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
      report.source.after = {
        packageFiles: summarizeFileMap(after.packageFiles), distFiles: summarizeFileMap(after.distFiles),
        upstream: summarizeUpstream(after.upstream),
        errors: after.errors.map(item => ({ area: item.area, name: item.name, code: item.code ?? null })),
      };
      const complete = report.source.after.errors.length === 0;
      report.source.packageSourceStable = complete
        && sameJson(setupFileMap(report.source.before, "packageFiles"), setupFileMap(report.source.after, "packageFiles"));
      report.source.distStable = complete
        && sameJson(setupFileMap(report.source.before, "distFiles"), setupFileMap(report.source.after, "distFiles"));
      report.source.upstreamStable = report.source.before?.errors?.length === 0 && complete
        && sameJson(report.source.before?.upstream, report.source.after?.upstream)
        && report.source.before?.upstream?.clean === true;
    }
    if (settingsSourceSnapshot) {
      try {
        report.source.settingsAfter = summarizeSettingsNativeSources(await assertSettingsNativeSourcesUnchanged(settingsSourceSnapshot));
        report.source.settingsStable = true;
      } catch (error) {
        report.source.settingsStable = false;
        report.source.settingsAfterException = safeException(error);
      }
    }
    try {
      report.source.nativeSourcesAfter = summarizeNativeSources(await captureNativeSourceSnapshot(root));
      report.source.nativeSourcesStable = sameJson(report.source.nativeSourcesBefore, report.source.nativeSourcesAfter);
    } catch (error) { report.source.nativeSourcesAfterException = safeException(error); }
    if (binaryPath && binaryBefore) {
      try {
        const after = await fingerprintNativeExecutable(binaryPath);
        report.binary.stable = ["sha256", "sizeBytes", "mtimeNs", "device", "inode"]
          .every(key => after[key] === binaryBefore[key]);
      } catch (error) { report.binary.afterException = safeException(error); }
    }
    if (cli?.buildReceipt) {
      const after = await readJsonFile(cli.buildReceipt, 1024 * 1024).catch(() => ({ exists: false, value: null }));
      report.buildReceipt.after = summarizeNativeBuildReceipt(after);
      report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256
        && report.buildReceipt.after?.contentSha256
        && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256);
    }
    report.finishedAt = new Date().toISOString();
    report.source.settingsBundleStaged = report.case?.appBundle?.settingsBundle?.staged === true;
    report.passed = preflightPassed && report.exception === null && report.case?.passed === true
      && report.binary.stable && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable
      && report.source.packageSourceStable && report.source.upstreamStable && report.source.distStable
      && report.source.nativeSourcesStable && report.source.settingsStable && report.source.settingsBundleStaged;
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log("main-hotkey Native report: " + relative(root, reportPath).split("\\").join("/"));
      console.log("main-hotkey passed=" + report.passed + "; case-clean="
        + (report.case?.cleanup?.allOwnedResourcesClean ?? false) + "; two-process-pair="
        + (report.case?.pair?.passed ?? false));
    } catch (error) {
      console.error("main-hotkey report write failed (" + (error.code || error.name || "error") + ")");
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runMainHotkeyStartupNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error("main-hotkey Native runner failed (" + (error.code || error.name || "error") + ")");
    process.exitCode = 1;
  });
}
