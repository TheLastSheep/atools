import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureNativeSourceSnapshot,
  fingerprintNativeExecutable,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";
import {
  setupNativeRendererSourceLock,
  snapshotNativeRendererSources,
} from "./lib/ztools-renderer-native-source-snapshots.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import { readJsonFile } from "./lib/ztools-renderer-launch-runtime.mjs";
import {
  createClipboardRunDirectory,
  parseClipboardNativeArgs,
  runClipboardNativeCase,
} from "./lib/ztools-clipboard-native-case.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const FIXED_UPSTREAM = "/Users/harris/Desktop/ZTools";
const RUNTIME_ASSET_EXTENSIONS = new Set([
  ".js", ".mjs", ".css", ".png", ".svg", ".webp", ".jpg", ".jpeg", ".gif", ".ico",
  ".avif", ".woff", ".woff2", ".ttf", ".otf", ".eot", ".wasm",
]);
const fixtureFiles = [
  "scripts/test-ztools-clipboard-native.mjs",
  "scripts/lib/ztools-clipboard-native-case.mjs",
  "scripts/lib/ztools-clipboard-native-case.test.mjs",
  "scripts/lib/ztools-clipboard-native-report.mjs",
  "scripts/lib/ztools-clipboard-native-report.test.mjs",
  "scripts/lib/ztools-renderer-native-provenance.mjs",
  "scripts/lib/ztools-renderer-native-provenance.test.mjs",
  "scripts/test-ztools-renderer-build-output.mjs",
  "scripts/test-ztools-renderer-native-runtime.mjs",
  "scripts/test-ztools-renderer-native-source-snapshots.mjs",
  "scripts/test-ztools-renderer-launch-runtime.mjs",
  "scripts/test-ztools-renderer-launch-probes.mjs",
  "scripts/test-ztools-renderer-multiwebview-validation.mjs",
  "scripts/lib/ztools-renderer-launch-runtime.mjs",
  "scripts/lib/ztools-renderer-launch-probes.mjs",
  "scripts/lib/ztools-renderer-native-source-snapshots.mjs",
  "scripts/lib/ztools-launcher-native-validation.mjs",
  "scripts/lib/ztools-launcher-native-validation.test.mjs",
  "scripts/test-ztools-launcher-native-probe.mjs",
  "scripts/lib/ztools-renderer-native-runtime.mjs",
  "scripts/lib/ztools-renderer-multiwebview-validation.mjs",
  "scripts/lib/ztools-renderer-native-source-binding.mjs",
  "scripts/lib/ztools-renderer-browser-source-lock.mjs",
  "scripts/lib/ztools-settings-native-sources.mjs",
  "scripts/lib/ztools-settings-resource-budget.mjs",
  "scripts/lib/ztools-settings-native-validation.mjs",
  "packages/ztools-settings/src/host-bridge-build.mjs",
  "packages/ztools-renderer/build.mjs",
  "packages/ztools-renderer/upstream-compatibility-patches.mjs",
  "packages/ztools-renderer/post-minifier.mjs",
  "packages/ztools-renderer/output-transaction.mjs",
  "packages/ztools-renderer/package.json",
  "packages/ztools-renderer/package-lock.json",
  "packages/ztools-renderer/source-manifest.json",
];

function safeError(error) {
  return { name: String(error?.name || "Error").slice(0, 80), code: error?.code ? String(error.code).slice(0, 80) : null };
}

function sameJson(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

async function writeReport(path, value) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
    | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
}

async function inspectRendererAssetSummary(distRoot) {
  const rootInfo = await lstat(distRoot, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(distRoot) !== distRoot) {
    throw new Error("Renderer asset root must be a canonical real directory");
  }
  const budgets = { directories: 0, entries: 0, files: 0, bytes: 0, javascript: 0 };
  async function walk(directory, depth) {
    if (depth > 8 || ++budgets.directories > 64) throw new Error("Renderer asset scan limit exceeded");
    const entries = await readdir(directory, { withFileTypes: true });
    budgets.entries += entries.length;
    if (budgets.entries > 256) throw new Error("Renderer asset entry limit exceeded");
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Renderer asset dist must not contain symlinks");
      if (entry.isDirectory()) { await walk(path, depth + 1); continue; }
      if (!entry.isFile()) throw new Error("Renderer asset dist contains a nonregular entry");
      const relativePath = relative(distRoot, path).split(sep).join("/");
      const components = relativePath.split("/");
      if (components.some(part => !part || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
        throw new Error("Renderer asset path is not normalized");
      }
      if (relativePath !== "index.html"
          && !(relativePath.startsWith("assets/") && relativePath.slice("assets/".length)
            && RUNTIME_ASSET_EXTENSIONS.has(extname(relativePath)))) continue;
      if (budgets.files >= 64) throw new Error("Renderer runtime asset file limit exceeded");
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || before.size > 1024n * 1024n) throw new Error("Renderer runtime asset exceeds the per-file limit");
        const content = await handle.readFile();
        const after = await handle.stat({ bigint: true });
        if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
            || before.mtimeNs !== after.mtimeNs || BigInt(content.byteLength) !== after.size) {
          throw new Error("Renderer runtime asset changed during measurement");
        }
        budgets.bytes += content.byteLength;
        if (budgets.bytes > 2 * 1024 * 1024) throw new Error("Renderer runtime asset byte budget exceeded");
        budgets.files += 1;
        if ([".js", ".mjs"].includes(extname(relativePath))) budgets.javascript += 1;
      } finally { await handle.close(); }
    }
  }
  await walk(distRoot, 0);
  return { runtimeAssetCount: budgets.files, runtimeAssetBytes: budgets.bytes,
    javascriptAssetCount: budgets.javascript };
}

export async function runClipboardNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  let runDirectory;
  try { runDirectory = await createClipboardRunDirectory(root, runId); }
  catch (error) {
    console.error(`clipboard native run directory unavailable (${error.code || error.name || "error"})`);
    return 1;
  }
  const reportPath = join(runDirectory, "verification.json");
  const report = {
    schemaVersion: 1, runId, startedAt: new Date().toISOString(), finishedAt: null,
    runner: { nodeVersion: process.versions.node, nodePath: process.execPath },
    binary: { path: null, before: null, after: null, stable: false },
    source: { before: null, after: null, nativeBefore: null, nativeAfter: null,
      packageStable: false, upstreamStable: false, distStable: false, nativeStable: false,
      provenance: null },
    buildReceipt: { path: null, before: null, after: null, matchesInputs: false, stable: false, errors: [] },
    nativeCase: null, exception: null, passed: false, reportPath,
  };
  let sourceLock = null;
  let upstreamPath = null;
  let binaryPath = null;
  let receiptPath = null;
  let preflightPassed = false;
  try {
    const cli = parseClipboardNativeArgs(argv);
    assert.equal(process.platform, "darwin", "Clipboard native acceptance requires macOS");
    assert.equal(process.versions.node, "22.23.3", "Run with the pinned product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the ATools product Node binary");
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || "";
    assert.equal(upstreamPath, FIXED_UPSTREAM, "ATOOLS_ZTOOLS_SOURCE must name the fixed ZTools checkout");
    assert.equal(await realpath(upstreamPath), FIXED_UPSTREAM, "Pinned ZTools checkout path must not be an alias");

    const sourceSetup = await setupNativeRendererSourceLock({
      root, upstreamPath, packageRoot, distRoot, fixtureFiles,
    });
    sourceLock = sourceSetup.sourceLock;
    report.source.before = sourceSetup.snapshot;
    report.source.nativeBefore = await captureNativeSourceSnapshot(root);

    const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
    const adapterSources = await sourceLock.readHostAdapterSources();
    assert.ok(adapterSources.length > 0 && adapterSources.length <= 64, "Renderer adapter source list must be bounded");
    assert.equal(new Set(adapterSources.map(item => item.path)).size, adapterSources.length, "Renderer adapter source paths must be unique");
    assert.ok(adapterSources.every(item => typeof item.path === "string" && item.path.endsWith(".ts")
      && Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[0-9a-f]{64}$/.test(item.sha256)),
    "Renderer adapter source hashes must be complete");
    assert.deepEqual(adapterSources, provenance.hostAdapterSources, "Host adapter source hashes differ from build provenance");
    assert.equal(sourceSetup.snapshot.errors.length, 0, "Renderer source snapshots must be readable");
    assert.ok(sourceSetup.snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Original Vue renderer dist is missing");
    const runtimeJs = Object.keys(sourceSetup.snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
    assert.ok(runtimeJs.length > 0 && runtimeJs.length <= 64, "Renderer JS chunk list must be bounded");
    let totalJavaScriptBytes = 0;
    for (const path of runtimeJs) totalJavaScriptBytes += (await readFile(join(root, path))).byteLength;
    validateRendererNativeProvenance(manifest, provenance, sourceSetup.snapshot.upstream, totalJavaScriptBytes);
    const expectedAssetSummary = {
      ...(await inspectRendererAssetSummary(distRoot)),
      fallbackSettingsAssets: null,
    };
    report.source.provenance = {
      sourceCommit: provenance.sourceCommit, sourceTreeSha256: provenance.sourceTreeSha256,
      sourceFiles: provenance.sourceFiles, totalJavaScriptBytes: provenance.bundle.totalJavaScriptBytes,
      hostAdapterSourceCount: adapterSources.length, hostAdapterSources: adapterSources,
    };

    const fingerprint = await fingerprintNativeExecutable(cli.binary);
    binaryPath = fingerprint.path;
    report.binary.path = "absolute --binary override";
    report.binary.before = { sha256: fingerprint.sha256, sizeBytes: fingerprint.sizeBytes,
      mtimeNs: fingerprint.mtimeNs, device: fingerprint.device, inode: fingerprint.inode };
    receiptPath = cli.buildReceipt;
    report.buildReceipt.path = "absolute --build-receipt override";
    const receiptBefore = await readJsonFile(receiptPath, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(receiptBefore);
    const receiptValidation = validateNativeBuildReceipt(receiptBefore, report.source.nativeBefore, fingerprint.sha256);
    report.buildReceipt.errors = receiptValidation.errors;
    report.buildReceipt.matchesInputs = receiptValidation.valid;
    assert.equal(receiptValidation.valid, true, "Receipt must bind current native sources and selected binary");
    preflightPassed = true;

    report.nativeCase = await runClipboardNativeCase({
      root, runDirectory, binaryFingerprint: fingerprint, rendererDist: distRoot, runId, expectedAssetSummary,
    });
  } catch (error) {
    report.exception = safeError(error);
  } finally {
    if (sourceLock) report.source.after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
    try { report.source.nativeAfter = await captureNativeSourceSnapshot(root); }
    catch (error) { report.source.nativeAfterException = safeError(error); }
    if (binaryPath) {
      try {
        const after = await fingerprintNativeExecutable(binaryPath);
        report.binary.after = { sha256: after.sha256, sizeBytes: after.sizeBytes,
          mtimeNs: after.mtimeNs, device: after.device, inode: after.inode };
      } catch (error) { report.binary.afterException = safeError(error); }
    }
    if (receiptPath) {
      report.buildReceipt.after = summarizeNativeBuildReceipt(await readJsonFile(receiptPath, 1024 * 1024));
    }
    const before = report.source.before;
    const after = report.source.after;
    report.source.packageStable = Boolean(before?.packageFiles && after?.packageFiles)
      && sameJson(before.packageFiles, after.packageFiles);
    report.source.upstreamStable = Boolean(before?.upstream && after?.upstream)
      && sameJson(before.upstream, after.upstream);
    report.source.distStable = Boolean(before?.distFiles && after?.distFiles)
      && sameJson(before.distFiles, after.distFiles);
    report.source.nativeStable = Boolean(report.source.nativeBefore && report.source.nativeAfter)
      && report.source.nativeBefore.sha256 === report.source.nativeAfter.sha256
      && report.source.nativeBefore.fileCount === report.source.nativeAfter.fileCount;
    report.binary.stable = Boolean(report.binary.before && report.binary.after)
      && sameJson(report.binary.before, report.binary.after);
    report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256 && report.buildReceipt.after?.contentSha256)
      && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256;
    report.finishedAt = new Date().toISOString();
    report.passed = preflightPassed && report.exception === null
      && report.nativeCase?.passed === true && report.source.packageStable && report.source.upstreamStable
      && report.source.distStable && report.source.nativeStable && report.binary.stable
      && report.buildReceipt.matchesInputs && report.buildReceipt.stable;
    try {
      await writeReport(reportPath, report);
      console.log(`clipboard native verification: ${reportPath}; passed=${report.passed}`);
    } catch (error) {
      console.error(`clipboard verification write failed (${error.code || error.name || "error"})`);
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runClipboardNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`clipboard native runner failed (${error.code || error.name || "error"})`);
    process.exitCode = 1;
  });
}
