import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureNativeSourceSnapshot,
  fingerprintNativeExecutable,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";
import { readJsonFile } from "./lib/ztools-renderer-launch-runtime.mjs";
import {
  setupNativeRendererSourceLock,
  snapshotNativeRendererSources,
} from "./lib/ztools-renderer-native-source-snapshots.mjs";
import {
  assertSettingsNativeSourcesUnchanged,
  captureSettingsNativeSources,
  summarizeSettingsNativeSources,
} from "./lib/ztools-settings-native-sources.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import { runBuiltinStateNativeCase } from "./lib/ztools-builtin-state-native-case.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const reportParent = join(root, "output/renderer-builtin-state-native-2026-10-28");
const fixtureFiles = [
  "scripts/test-ztools-builtin-state-native.mjs",
  "scripts/lib/ztools-builtin-state-native-case.mjs",
  "scripts/lib/ztools-builtin-state-native-case.test.mjs",
  "scripts/lib/ztools-builtin-state-native-report.mjs",
  "scripts/lib/ztools-builtin-state-native-report.test.mjs",
  "scripts/lib/ztools-renderer-native-runtime.mjs",
  "scripts/lib/ztools-renderer-launch-runtime.mjs",
  "scripts/lib/ztools-launcher-native-validation.mjs",
  "scripts/lib/ztools-renderer-launch-probes.mjs",
  "scripts/lib/ztools-renderer-native-source-binding.mjs",
  "scripts/lib/ztools-renderer-native-source-snapshots.mjs",
  "scripts/lib/ztools-renderer-browser-source-lock.mjs",
  "scripts/lib/ztools-renderer-native-provenance.mjs",
  "scripts/lib/ztools-settings-input-native-bundle.mjs",
  "scripts/lib/ztools-settings-input-builtin-control.mjs",
  "scripts/lib/ztools-settings-native-sources.mjs",
  "scripts/lib/ztools-settings-resource-budget.mjs",
  "scripts/lib/ztools-settings-resource-budget.test.mjs",
  "resources/plugins/builtin/timestamp/index.html",
  "resources/plugins/builtin/timestamp/logo.svg",
  "resources/plugins/builtin/timestamp/plugin.json",
  "packages/ztools-settings/src/host-bridge-build.mjs",
  "packages/ztools-renderer/build.mjs",
  "packages/ztools-renderer/upstream-compatibility-patches.mjs",
  "packages/ztools-renderer/post-minifier.mjs",
  "packages/ztools-renderer/output-transaction.mjs",
  "packages/ztools-renderer/package.json",
  "packages/ztools-renderer/package-lock.json",
  "packages/ztools-renderer/source-manifest.json",
];

function parseArgs(argv) {
  const values = new Map();
  const allowed = new Set(["--binary", "--build-receipt"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || values.has(flag) || !value || value.startsWith("--") || !isAbsolute(value)) {
      throw new Error("Only absolute --binary and --build-receipt arguments are accepted once each");
    }
    values.set(flag, value);
    index += 1;
  }
  const binary = values.get("--binary");
  const buildReceipt = values.get("--build-receipt");
  if (!binary || !buildReceipt) throw new Error("--binary and --build-receipt are required");
  return { binary, buildReceipt };
}

function safeException(error) {
  return { name: String(error?.name || "Error").slice(0, 80), code: error?.code ? String(error.code).slice(0, 80) : null };
}

function sameJson(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function summarizeFileMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { fileCount: Object.keys(value).length, sha256: hashJson(value) };
}

function summarizeNativeSources(value) {
  return value ? { sha256: value.sha256, fileCount: value.fileCount, totalBytes: value.totalBytes } : null;
}

async function createRunDirectory(runId) {
  await mkdir(join(root, "output"), { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(join(root, "output"), { bigint: true });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || await realpath(join(root, "output")) !== join(root, "output")) {
    throw new Error("Output root must be a real directory");
  }
  await mkdir(reportParent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(reportParent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(reportParent) !== reportParent) {
    throw new Error("Builtin-state report directory must be a real directory");
  }
  const runDirectory = join(reportParent, `run-${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  const info = await lstat(runDirectory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || Number(info.mode & 0o077n) !== 0
      || await realpath(runDirectory) !== runDirectory) {
    throw new Error("Builtin-state run directory must be private");
  }
  return runDirectory;
}

async function validateReceiptPath(path) {
  const canonical = await realpath(path);
  assert.equal(dirname(canonical), reportParent, "Use a fresh builtin-state build receipt");
  assert.match(basename(canonical), /^native-build-receipt-\d+\.json$/, "Build receipt filename must be unique");
  const info = await lstat(path, { bigint: true });
  const ageMs = Date.now() - Number(info.mtimeMs);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000, "Build receipt must be a fresh regular file");
  return ageMs;
}

async function captureActualRendererBundle(sourceLock, snapshot, manifest, provenance) {
  assert.equal(snapshot.errors.length, 0, "Renderer sources, dist, and upstream must be readable");
  assert.ok(snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Original renderer dist entry is missing");
  const adapterSources = await sourceLock.readHostAdapterSources();
  assert.ok(adapterSources.length > 0 && adapterSources.length <= 64, "Host adapter source set must be bounded");
  assert.equal(new Set(adapterSources.map(item => item.path)).size, adapterSources.length, "Host adapter paths must be unique");
  assert.ok(adapterSources.every(item => typeof item.path === "string" && item.path.endsWith(".ts")
    && Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[0-9a-f]{64}$/.test(item.sha256)),
  "Host adapter source hashes must be complete");
  assert.deepEqual(adapterSources, provenance.hostAdapterSources, "Host adapter source hashes differ from provenance");
  const chunks = Object.keys(snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
  assert.equal(chunks.length, 3, "Use the current renderer's three JavaScript chunks");
  assert.ok(chunks.every(path => path.startsWith("packages/ztools-renderer/dist/")), "Renderer chunks must stay inside dist");
  let actualJavaScriptBytes = 0;
  for (const path of chunks) actualJavaScriptBytes += (await readFile(join(root, path))).byteLength;
  validateRendererNativeProvenance(manifest, provenance, snapshot.upstream, actualJavaScriptBytes);
  return { actualJavaScriptBytes, chunkCount: chunks.length, adapterSourceCount: adapterSources.length };
}

export async function runBuiltinStateNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  let runDirectory;
  try { runDirectory = await createRunDirectory(runId); }
  catch (error) {
    console.error(`builtin-state report directory unavailable (${error.code || error.name || "error"})`);
    return 1;
  }
  const reportPath = join(runDirectory, "report.json");
  const report = {
    schemaVersion: 1,
    journey: "builtin-state-cold-restart",
    scope: "private-timestamp-disabled-seed-to-cold-main",
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    passed: false,
    runner: { nodeVersion: process.versions.node, productRuntime: false },
    binary: { sha256: null, sizeBytes: null, stable: false },
    source: {
      before: null, after: null, nativeSourcesBefore: null, nativeSourcesAfter: null,
      packageSourceStable: false, upstreamStable: false, distStable: false, nativeSourcesStable: false,
      settingsBefore: null, settingsAfter: null, settingsStable: false, provenance: null,
    },
    buildReceipt: { before: null, after: null, matchesRunInputs: false, stable: false, ageMs: null, validationErrors: [] },
    case: null,
    exception: null,
    reportPath: relative(root, reportPath).split("\\").join("/"),
  };
  let cli = null;
  let sourceLock = null;
  let setup = null;
  let settingsSourceSnapshot = null;
  let upstreamPath = null;
  let binaryBefore = null;
  let receiptBefore = null;
  let preflightPassed = false;

  try {
    cli = parseArgs(argv);
    assert.equal(process.platform, "darwin", "Builtin-state native acceptance requires macOS");
    assert.equal(process.versions.node, "22.23.3", "Use the pinned Product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the ATools Product Node binary");
    report.runner.productRuntime = true;
    report.buildReceipt.ageMs = await validateReceiptPath(cli.buildReceipt);
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    assert.ok(upstreamPath && isAbsolute(upstreamPath), "Set ATOOLS_ZTOOLS_SOURCE to the absolute pinned ZTools checkout");

    setup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles });
    sourceLock = setup.sourceLock;
    report.source.before = {
      packageFiles: summarizeFileMap(setup.snapshot.packageFiles),
      distFiles: summarizeFileMap(setup.snapshot.distFiles),
      upstream: setup.snapshot.upstream ? {
        commit: setup.snapshot.upstream.commit,
        clean: setup.snapshot.upstream.dirty === "",
        files: setup.snapshot.upstream.files,
        sha256: setup.snapshot.upstream.sha256,
      } : null,
      errors: setup.snapshot.errors.map(item => ({ area: item.area, name: item.name, code: item.code ?? null })),
    };
    report.source.nativeSourcesBefore = summarizeNativeSources(await captureNativeSourceSnapshot(root));
    settingsSourceSnapshot = await captureSettingsNativeSources(root);
    report.source.settingsBefore = summarizeSettingsNativeSources(settingsSourceSnapshot);
    const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
    const renderer = await captureActualRendererBundle(sourceLock, setup.snapshot, manifest, provenance);
    report.source.provenance = {
      sourceCommit: provenance.sourceCommit,
      sourceTreeSha256: provenance.sourceTreeSha256,
      sourceFiles: provenance.sourceFiles,
      totalJavaScriptBytes: renderer.actualJavaScriptBytes,
      runtimeChunkCount: renderer.chunkCount,
      hostAdapterSourceCount: renderer.adapterSourceCount,
      settingsSourcesSha256: settingsSourceSnapshot.sha256,
      settingsSourceFileCount: settingsSourceSnapshot.packageFileCount,
      settingsSourceBytes: settingsSourceSnapshot.packageBytes,
      settingsBundleBytes: settingsSourceSnapshot.bundle.resourceBytes,
    };

    binaryBefore = await fingerprintNativeExecutable(cli.binary);
    report.binary.sha256 = binaryBefore.sha256;
    report.binary.sizeBytes = binaryBefore.sizeBytes;
    receiptBefore = await readJsonFile(cli.buildReceipt, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(receiptBefore);
    const binding = validateNativeBuildReceipt(receiptBefore, report.source.nativeSourcesBefore, binaryBefore.sha256);
    report.buildReceipt.matchesRunInputs = binding.valid;
    report.buildReceipt.validationErrors = binding.errors;
    assert.equal(binding.valid, true, "Build receipt must bind this binary and exact native source closure");
    preflightPassed = true;

    report.case = await runBuiltinStateNativeCase({
      runDirectory,
      workspaceRoot: root,
      binaryFingerprint: binaryBefore,
      rendererDist: distRoot,
      runId,
      settingsSourceSnapshot,
      nativeSourceHashes: setup.snapshot.packageFiles,
    });
  } catch (error) {
    report.exception = safeException(error);
  } finally {
    if (sourceLock) {
      const after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
      report.source.after = {
        packageFiles: summarizeFileMap(after.packageFiles),
        distFiles: summarizeFileMap(after.distFiles),
        upstream: after.upstream ? {
          commit: after.upstream.commit,
          clean: after.upstream.dirty === "",
          files: after.upstream.files,
          sha256: after.upstream.sha256,
        } : null,
        errors: after.errors.map(item => ({ area: item.area, name: item.name, code: item.code ?? null })),
      };
      const complete = report.source.after.errors.length === 0;
      report.source.packageSourceStable = complete
        && sameJson(report.source.before?.packageFiles, report.source.after.packageFiles);
      report.source.distStable = complete
        && sameJson(report.source.before?.distFiles, report.source.after.distFiles);
      report.source.upstreamStable = report.source.before?.errors?.length === 0 && complete
        && sameJson(report.source.before?.upstream, report.source.after?.upstream)
        && report.source.before?.upstream?.clean === true;
    }
    if (settingsSourceSnapshot) {
      try {
        report.source.settingsAfter = summarizeSettingsNativeSources(
          await assertSettingsNativeSourcesUnchanged(settingsSourceSnapshot),
        );
        report.source.settingsStable = true;
      } catch (error) {
        report.source.settingsStable = false;
        report.source.settingsAfterException = safeException(error);
        try {
          report.source.settingsAfter = summarizeSettingsNativeSources(await captureSettingsNativeSources(root));
        } catch (captureError) {
          report.source.settingsAfterCaptureException = safeException(captureError);
        }
      }
    }
    try { report.source.nativeSourcesAfter = summarizeNativeSources(await captureNativeSourceSnapshot(root)); }
    catch (error) { report.source.nativeSourcesAfterException = safeException(error); }
    report.source.nativeSourcesStable = Boolean(report.source.nativeSourcesBefore && report.source.nativeSourcesAfter)
      && sameJson(report.source.nativeSourcesBefore, report.source.nativeSourcesAfter);
    if (cli?.binary && binaryBefore) {
      try {
        const after = await fingerprintNativeExecutable(cli.binary);
        report.binary.stable = after.sha256 === binaryBefore.sha256 && after.sizeBytes === binaryBefore.sizeBytes
          && after.mtimeNs === binaryBefore.mtimeNs && after.device === binaryBefore.device && after.inode === binaryBefore.inode;
      } catch (error) { report.binary.afterException = safeException(error); }
    }
    if (cli?.buildReceipt) {
      try {
        const after = await readJsonFile(cli.buildReceipt, 1024 * 1024);
        report.buildReceipt.after = summarizeNativeBuildReceipt(after);
        report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256 && report.buildReceipt.after?.contentSha256)
          && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256;
      } catch (error) { report.buildReceipt.afterException = safeException(error); }
    }
    report.finishedAt = new Date().toISOString();
    report.passed = preflightPassed && report.exception === null && report.case?.passed === true
      && report.binary.stable && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable
      && report.source.packageSourceStable && report.source.upstreamStable && report.source.distStable
      && report.source.nativeSourcesStable && report.source.settingsStable
      && report.case?.appBundle?.settingsBundle?.staged === true;
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`builtin-state Native report: ${relative(root, reportPath).split("\\").join("/")}`);
      console.log(`builtin-state passed=${report.passed}; seed=${report.case?.seed?.passed ?? false}; main=${report.case?.main?.passed ?? false}; clean=${report.case?.cleanup?.allOwnedResourcesClean ?? false}`);
    } catch (error) {
      console.error(`builtin-state report write failed (${error.code || error.name || "error"})`);
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBuiltinStateNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`builtin-state Native runner failed (${error.code || error.name || "error"})`);
    process.exitCode = 1;
  });
}
