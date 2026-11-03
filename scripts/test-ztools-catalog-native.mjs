import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureNativeSourceSnapshot,
  fingerprintNativeExecutable,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";
import {
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  nativeChildEnvironment,
  readJsonNoFollow,
  runNativeChild,
  stageRendererNativeApp,
} from "./lib/ztools-renderer-native-runtime.mjs";
import {
  CATALOG_NATIVE_SCOPE,
  summarizeCatalogNativeReport,
} from "./lib/ztools-catalog-native-report.mjs";
import { summarizeWindowDragNativeReport } from "./lib/ztools-window-drag-native-report.mjs";
import {
  captureMainFileDropNativeReport,
  catalogMainFileDropProbeEnvironment,
  finalizeCatalogMainDropResources,
} from "./lib/ztools-main-file-drop-native-report.mjs";
import {
  setupNativeRendererSourceLock,
  snapshotNativeRendererSources,
} from "./lib/ztools-renderer-native-source-snapshots.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import { assertCatalogNativeSourceRecords } from "./lib/ztools-catalog-native-source-records.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const autoClear = "never";
const caseTimeoutMs = 150_000;
export const fixtureFiles = [
  "scripts/test-ztools-catalog-native.mjs",
  "scripts/lib/ztools-renderer-native-provenance.mjs",
  "scripts/lib/ztools-renderer-native-provenance.test.mjs",
  "scripts/lib/ztools-catalog-native-report.mjs",
  "scripts/lib/ztools-catalog-native-report.test.mjs",
  "scripts/lib/ztools-window-drag-native-report.mjs",
  "scripts/lib/ztools-window-drag-native-report.test.mjs",
  "scripts/lib/ztools-main-file-drop-native-report.mjs",
  "scripts/lib/ztools-main-file-drop-native-report.test.mjs",
  "scripts/lib/ztools-catalog-native-source-records.mjs",
  "scripts/lib/ztools-catalog-native-source-records.test.mjs",
  "scripts/lib/ztools-renderer-native-runtime.mjs",
  "scripts/lib/ztools-settings-native-sources.mjs",
  "scripts/lib/ztools-settings-resource-budget.mjs",
  "scripts/lib/ztools-renderer-native-source-binding.mjs",
  "scripts/lib/ztools-renderer-native-source-snapshots.mjs",
  "scripts/lib/ztools-renderer-browser-source-lock.mjs",
  "packages/ztools-settings/src/host-bridge-build.mjs",
  "packages/ztools-renderer/build.mjs",
  "packages/ztools-renderer/upstream-compatibility-patches.mjs",
  "packages/ztools-renderer/post-minifier.mjs",
  "packages/ztools-renderer/output-transaction.mjs",
  "packages/ztools-renderer/package.json",
  "packages/ztools-renderer/package-lock.json",
  "packages/ztools-renderer/source-manifest.json",
  "src-tauri/src/renderer_desktop_smoke/profile.rs",
  "src-tauri/src/renderer_desktop_smoke/profile_tests.rs",
  "src-tauri/src/renderer_desktop_smoke/fixture_owner.rs",
  "src-tauri/src/renderer_desktop_smoke/protocol_tests.rs",
  "src-tauri/src/renderer_desktop_smoke/catalog_journey/commands.rs",
  "src-tauri/src/renderer_desktop_smoke/catalog_journey/tests.rs",
  "src-tauri/src/renderer_desktop_smoke/window_drag_probe.rs",
  "src-tauri/src/renderer_desktop_smoke/window_drag_probe_lifecycle.rs",
  "src-tauri/src/renderer_desktop_smoke/window_drag_probe_schema.rs",
  "src-tauri/src/renderer_desktop_smoke/window_drag_probe.js",
  "src-tauri/src/renderer_desktop_smoke/window_drag_probe_resume.js",
];

function errorRecord(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: error?.code ? String(error.code).slice(0, 100) : null,
    message: String(error?.message || "Catalog native runner failed").slice(0, 500),
  };
}

function sameJson(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

export function validateCatalogProvenance(manifest, provenance, upstream, actualJavaScriptBytes) {
  return validateRendererNativeProvenance(manifest, provenance, upstream, actualJavaScriptBytes);
}

export function parseCatalogNativeArgs(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!new Set(["--binary", "--build-receipt", "--window-drag", "--main-file-drop"]).has(flag)
      || options.has(flag) || index + 1 >= argv.length) {
      throw new Error("Only --binary, --build-receipt, --window-drag, and --main-file-drop are accepted once each");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires one value`);
    }
    if (flag === "--window-drag" || flag === "--main-file-drop") {
      if (value !== "true" && value !== "false") throw new Error(`${flag} must be true or false`);
      options.set(flag, value);
      continue;
    }
    if (!isAbsolute(value)) {
      throw new Error(`${flag} must be an absolute path`);
    }
    options.set(flag, value);
  }
  const binary = options.get("--binary");
  const buildReceipt = options.get("--build-receipt");
  if (!binary || !buildReceipt) throw new Error("Both --binary and --build-receipt are required");
  const parsed = { binary, buildReceipt, windowDrag: options.get("--window-drag") === "true" };
  if (options.has("--main-file-drop")) parsed.mainFileDrop = options.get("--main-file-drop") === "true";
  return parsed;
}

export function buildCatalogNativeArgs({ fixtureRoot, rendererDist, output, runId, windowDrag = false }) {
  const args = buildNativeCaseArgs({ fixtureRoot, rendererDist, output, autoClear, runId, mode: "multiwebview" });
  args.push("--journey", "catalog");
  if (windowDrag) args.push("--window-drag", "true");
  return args;
}

async function createCatalogRunDirectory(runId) {
  const outputRoot = join(root, "output");
  const parent = join(outputRoot, "renderer-catalog-native-2026-10-27");
  const runDirectory = join(parent, `run-${runId}`);
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  for (const directory of [outputRoot, parent]) {
    if (directory === parent) await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
      throw new Error("Catalog report path must use real workspace directories");
    }
  }
  await mkdir(runDirectory, { mode: 0o700 });
  const info = await lstat(runDirectory);
  if (info.isSymbolicLink() || !info.isDirectory() || (info.mode & 0o077) !== 0
      || await realpath(runDirectory) !== runDirectory) {
    throw new Error("Catalog run directory must be a private real directory");
  }
  return runDirectory;
}

async function readJsonSnapshot(path, maxBytes) {
  let exists;
  try {
    const info = await lstat(path);
    exists = true;
    if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) {
      return { exists, value: null, exception: { name: "Error", code: null, message: "Bounded JSON input is not a regular file" } };
    }
    return { exists, value: await readJsonNoFollow(path, maxBytes), exception: null };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, value: null, exception: errorRecord(error) };
    return { exists: exists ?? null, value: null, exception: errorRecord(error) };
  }
}

async function inspectAbsent(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    return error.code === "ENOENT" ? true : null;
  }
}

function fingerprintSummary(fingerprint) {
  if (!fingerprint) return null;
  return {
    sha256: fingerprint.sha256,
    sizeBytes: fingerprint.sizeBytes,
    mtimeNs: fingerprint.mtimeNs,
    device: fingerprint.device,
    inode: fingerprint.inode,
  };
}

function processSummary(processResult) {
  if (!processResult) return null;
  return {
    spawned: processResult.spawned,
    pid: processResult.pid,
    exitCode: processResult.exitCode,
    signal: processResult.signal,
    terminalObserved: processResult.terminalObserved,
    timedOut: processResult.timedOut,
    termination: processResult.termination,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
    exception: processResult.exception,
  };
}

async function runCatalogCase({ runDirectory, binary, binarySha256, distRoot, runId, windowDrag, mainFileDrop = false }) {
  const fixtureRoot = `/private/tmp/atools-renderer-catalog-${runId}`;
  const nativeReportPath = join(runDirectory, "catalog-native.json");
  const windowDragReportPath = join(runDirectory, "window-drag-native.json");
  const bundlePath = join(runDirectory, "case-never.app");
  const result = {
    journey: "catalog",
    autoClear,
    fixtureRoot,
    nativeReportPath: "catalog-native.json",
    windowDragEnabled: windowDrag,
    windowDragReport: null,
    appBundle: null,
    process: null,
    nativeReport: null,
    cleanup: {
      processTerminal: null,
      fixtureRootAbsent: null,
      appBundleAbsent: null,
      fixtureRoot: null,
      appBundle: null,
      allOwnedResourcesClean: false,
    },
    exception: null,
    passed: false,
  };
  if (mainFileDrop) {
    result.mainFileDropEnabled = true;
    result.mainFileDropReport = null;
  }
  let staged = null;
  let processResult = null;
  try {
    const [existingRoot, existingReport] = await Promise.all([
      inspectAbsent(fixtureRoot), inspectAbsent(nativeReportPath),
    ]);
    if (existingRoot !== true) throw new Error("Catalog fixture root is present or cannot be inspected");
    if (existingReport !== true) throw new Error("Catalog native report must be absent before launch");
    if (await inspectAbsent(windowDragReportPath) !== true) {
      throw new Error("Window drag native report must be absent before launch");
    }
    staged = await stageRendererNativeApp({
      binary, runDirectory, autoClear, runId, expectedSha256: binarySha256, mode: "multiwebview",
    });
    result.appBundle = {
      identifier: staged.identifier,
      displayName: staged.displayName,
      executable: "Contents/MacOS/AToolsRendererSmoke",
      sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256,
      mode: staged.mode,
      probeResource: staged.probeResource,
    };
    assert.equal(staged.identifier, `dev.atools.renderer-smoke.${runId}`,
      "Staged bundle identifier must match the catalog run UUID");
    const args = buildCatalogNativeArgs({
      fixtureRoot, rendererDist: distRoot, output: nativeReportPath, runId, windowDrag,
    });
    processResult = await runNativeChild(staged.executable, args, {
      timeoutMs: caseTimeoutMs,
      spawnOptions: { cwd: root, env: catalogMainFileDropProbeEnvironment(
        nativeChildEnvironment(process.env), mainFileDrop,
      ) },
    });
    result.process = processSummary(processResult);
    result.cleanup.processTerminal = processResult.spawned
      ? processResult.terminalObserved : true;
    if (processResult.terminalObserved) {
      const [nativeFile, markerFile] = await Promise.all([
        readJsonSnapshot(nativeReportPath, 1024 * 1024),
        readJsonSnapshot(join(fixtureRoot, OWNER_MARKER_NAME), 4096),
      ]);
      result.nativeReport = summarizeCatalogNativeReport(nativeFile, markerFile, {
        autoClear,
        fixtureRoot,
        childPid: processResult.pid,
        expectedIdentifier: `dev.atools.renderer-smoke.${runId}`,
      });
      const windowDragFile = await readJsonSnapshot(windowDragReportPath, 1024 * 1024);
      result.windowDragReport = windowDrag
        ? summarizeWindowDragNativeReport(windowDragFile, {
          runId,
          fixtureRoot,
          childPid: processResult.pid,
          expectedIdentifier: `dev.atools.renderer-smoke.${runId}`,
        })
        : {
          exists: windowDragFile.exists === true,
          valid: windowDragFile.exists === false && windowDragFile.exception?.code === "ENOENT",
          passed: windowDragFile.exists === false && windowDragFile.exception?.code === "ENOENT",
          errors: windowDragFile.exists === true ? ["unexpected-window-drag-report"] : [],
          exception: windowDragFile.exception ? {
            name: windowDragFile.exception.name,
            code: windowDragFile.exception.code,
          } : null,
        };
    }
    if (mainFileDrop) {
      result.mainFileDropReport = await captureMainFileDropNativeReport({
        fixtureRoot,
        runDirectory,
        runId,
        pid: processResult.pid,
        processTerminal: processResult.terminalObserved,
        ownerValidated: result.nativeReport?.owner?.valid === true,
      });
    }
  } catch (error) {
    result.exception = errorRecord(error);
  } finally {
    const processTerminal = processResult ? (!processResult.spawned || processResult.terminalObserved) : true;
    result.cleanup.processTerminal = processTerminal;
    Object.assign(result.cleanup, await finalizeCatalogMainDropResources({
      enabled: mainFileDrop,
      fixtureRoot,
      bundlePath,
      staged,
      processResult,
      catalogReport: result.nativeReport,
      windowDragReport: result.windowDragReport,
      probeReport: result.mainFileDropReport,
    }));
  }
  result.passed = processResult?.spawned === true && processResult.terminalObserved === true
    && processResult.exitCode === 0 && processResult.signal === null && processResult.timedOut === false
    && result.exception === null && result.nativeReport?.valid === true
    && result.windowDragReport?.valid === true
    && (!mainFileDrop || (result.mainFileDropReport?.valid === true && result.mainFileDropReport?.passed === true))
    && result.cleanup.allOwnedResourcesClean === true;
  return result;
}

export async function runCatalogNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  let runDirectory;
  try { runDirectory = await createCatalogRunDirectory(runId); }
  catch (error) {
    console.error(`catalog native report directory unavailable (${error.code || error.name || "error"})`);
    return 1;
  }
  const reportPath = join(runDirectory, "report.json");
  const report = {
    schemaVersion: 1,
    journey: "catalog",
    scope: CATALOG_NATIVE_SCOPE,
    runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    passed: false,
    runner: { nodeVersion: process.versions.node, nodePath: process.execPath },
    binary: { path: null, before: null, after: null, stable: false },
    source: {
      before: null, after: null, nativeSourcesBefore: null, nativeSourcesAfter: null,
      packageSourceStable: false, upstreamStable: false, distStable: false,
      nativeSourcesStable: false, sourceStable: false, provenance: null,
    },
    buildReceipt: { path: null, before: null, after: null, matchesRunInputs: false, stable: false, validationErrors: [] },
    case: null,
    exception: null,
    reportPath: relative(root, reportPath).split("\\").join("/"),
  };
  let sourceLock = null;
  let upstreamPath = null;
  let binaryPath = null;
  let receiptPath = null;
  let binaryBefore = null;
  let receiptBefore = null;
  let preflightPassed = false;
  try {
    const cli = parseCatalogNativeArgs(argv);
    assert.equal(process.versions.node, "22.23.3", "Use the pinned product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Use the ATools product Node binary");
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    assert.ok(upstreamPath && upstreamPath.startsWith("/"), "Set ATOOLS_ZTOOLS_SOURCE to the absolute pinned ZTools checkout");

    const setup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles });
    sourceLock = setup.sourceLock;
    report.source.before = setup.snapshot;
    report.source.nativeSourcesBefore = await captureNativeSourceSnapshot(root);
    assert.equal(setup.snapshot.errors.length, 0, "Renderer source and dist snapshots must be complete");
    assert.ok(setup.snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Renderer dist entry is missing");

    const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
    const adapterSources = await sourceLock.readHostAdapterSources();
    assertCatalogNativeSourceRecords(adapterSources, provenance.hostAdapterSources);
    const runtimeJavaScript = Object.keys(setup.snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
    assert.ok(runtimeJavaScript.length > 0 && runtimeJavaScript.length <= 64, "Renderer JavaScript chunk count must be bounded");
    let actualJavaScriptBytes = 0;
    for (const path of runtimeJavaScript) actualJavaScriptBytes += (await readFile(join(root, path))).byteLength;
    validateCatalogProvenance(manifest, provenance, setup.snapshot.upstream, actualJavaScriptBytes);
    report.source.provenance = {
      sourceCommit: provenance.sourceCommit,
      sourceTreeSha256: provenance.sourceTreeSha256,
      sourceFiles: provenance.sourceFiles,
      totalJavaScriptBytes: provenance.bundle.totalJavaScriptBytes,
      hostAdapterSourceCount: adapterSources.length,
      hostAdapterSources: adapterSources,
    };

    binaryBefore = await fingerprintNativeExecutable(cli.binary);
    binaryPath = binaryBefore.path;
    report.binary.path = "absolute --binary override";
    report.binary.before = fingerprintSummary(binaryBefore);
    receiptPath = cli.buildReceipt;
    report.buildReceipt.path = "absolute --build-receipt override";
    receiptBefore = await readJsonSnapshot(receiptPath, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(receiptBefore);
    const binding = validateNativeBuildReceipt(receiptBefore, report.source.nativeSourcesBefore, binaryBefore.sha256);
    report.buildReceipt.matchesRunInputs = binding.valid;
    report.buildReceipt.validationErrors = binding.errors;
    assert.equal(binding.valid, true, "Native build receipt must bind this executable and current native source closure");
    preflightPassed = true;

    report.case = await runCatalogCase({
      runDirectory,
      binary: binaryPath,
      binarySha256: binaryBefore.sha256,
      distRoot,
      runId,
      windowDrag: cli.windowDrag,
      mainFileDrop: cli.mainFileDrop === true,
    });
  } catch (error) {
    report.exception = errorRecord(error);
  } finally {
    if (sourceLock) report.source.after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
    try { report.source.nativeSourcesAfter = await captureNativeSourceSnapshot(root); }
    catch (error) { report.source.nativeSourcesAfterException = errorRecord(error); }
    if (binaryPath) {
      try { report.binary.after = fingerprintSummary(await fingerprintNativeExecutable(binaryPath)); }
      catch (error) { report.binary.afterException = errorRecord(error); }
    }
    if (receiptPath) {
      const receiptAfter = await readJsonSnapshot(receiptPath, 1024 * 1024);
      report.buildReceipt.after = summarizeNativeBuildReceipt(receiptAfter);
    }
    const before = report.source.before;
    const after = report.source.after;
    report.source.packageSourceStable = Boolean(before?.packageFiles && after?.packageFiles)
      && sameJson(before.packageFiles, after.packageFiles);
    report.source.upstreamStable = Boolean(before?.upstream && after?.upstream)
      && sameJson(before.upstream, after.upstream);
    report.source.distStable = Boolean(before?.distFiles && after?.distFiles)
      && sameJson(before.distFiles, after.distFiles);
    report.source.nativeSourcesStable = Boolean(report.source.nativeSourcesBefore && report.source.nativeSourcesAfter)
      && report.source.nativeSourcesBefore.sha256 === report.source.nativeSourcesAfter.sha256
      && report.source.nativeSourcesBefore.fileCount === report.source.nativeSourcesAfter.fileCount;
    report.source.sourceStable = report.source.packageSourceStable && report.source.upstreamStable
      && report.source.distStable && report.source.nativeSourcesStable;
    report.binary.stable = Boolean(report.binary.before && report.binary.after)
      && sameJson(report.binary.before, report.binary.after);
    report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256 && report.buildReceipt.after?.contentSha256)
      && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256;
    report.finishedAt = new Date().toISOString();
    report.passed = preflightPassed && report.exception === null && report.case?.passed === true
      && report.binary.stable && report.source.sourceStable
      && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable;
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`catalog native report: ${reportPath}`);
      console.log(`catalog native passed=${report.passed}; source-stable=${report.source.sourceStable}; cleanup=${report.case?.cleanup.allOwnedResourcesClean ?? false}`);
    } catch (error) {
      console.error(`catalog native report write failed (${error.code || error.name || "error"})`);
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCatalogNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`catalog native runner failed (${error.code || error.name || "error"})`);
    process.exitCode = 1;
  });
}
