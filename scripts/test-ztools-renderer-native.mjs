import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureNativeSourceSnapshot,
  fingerprintNativeExecutable,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";
import {
  buildNativeCaseArgs,
  createNativeRunDirectory,
  cleanupOwnedFixtureRoot,
  cleanupOwnedRendererApp,
  nativeChildEnvironment,
  parseNativeRunnerArgs,
  runNativeChild,
  stageRendererNativeApp,
} from "./lib/ztools-renderer-native-runtime.mjs";
import {
  captureLauncherProbeFingerprint,
  inspectOptionalPathAbsence,
  optionalLstat,
  readJsonFile,
  readMarkerSafely,
  runLauncherNativeCase,
  summarizeLauncherProbeFingerprint,
  verifyLauncherProbeFingerprintUnchanged,
} from "./lib/ztools-renderer-launch-runtime.mjs";
import { setupNativeRendererSourceLock, snapshotNativeRendererSources } from "./lib/ztools-renderer-native-source-snapshots.mjs";
import { summarizeNativeReport, validateMultiwebviewMode } from "./lib/ztools-renderer-multiwebview-validation.mjs";
import {
  assertSettingsNativeSourcesUnchanged,
  captureSettingsNativeSources,
  summarizeSettingsNativeSources,
} from "./lib/ztools-settings-native-sources.mjs";
import { summarizeSettingsNativeReport, validateSettingsViewMode } from "./lib/ztools-settings-native-validation.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const cases = ["immediately", "never"];
const fixtureFiles = [
  "scripts/test-ztools-renderer-native.mjs",
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

function errorRecord(error) {
  return {
    name: String(error?.name || "Error").slice(0, 100),
    code: error?.code ? String(error.code).slice(0, 100) : null,
    message: String(error?.message || "Native renderer runner failed").slice(0, 500),
  };
}

function sameJson(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

async function runCase(options) {
  if (options.mode === "launcher") return runLauncherNativeCase({
    autoClear: options.autoClear,
    runDirectory: options.runDirectory,
    binary: options.binary,
    sourceSha256: options.sourceSha256,
    rendererDist: options.distRoot,
    launcherProbeFingerprint: options.launcherProbeFingerprint,
    nativeRunnerRoot: root,
  });
  const { mode, autoClear, runDirectory, binary, distRoot: rendererDist, sourceSha256, settingsSourceSnapshot } = options;
  const caseUUID = randomUUID();
  const runId = caseUUID.replaceAll("-", "");
  const fixtureRoot = `/private/tmp/atools-renderer-native-${caseUUID}-${autoClear}`;
  const reportPath = join(runDirectory, `case-${autoClear}.json`);
  const bundlePath = join(runDirectory, `case-${autoClear}.app`);
  const result = {
    mode,
    autoClear,
    runId,
    fixtureRoot,
    reportPath,
    passed: false,
    appBundle: null,
    process: null,
    nativeReport: null,
    cleanup: {
      processTerminal: null,
      fixtureRootAbsent: null,
      appBundleAbsent: null,
      fixtureRoot: null,
      appBundle: null,
      cleanupBeforeNextCase: false,
    },
    exception: null,
  };
  let staged = null;
  let processResult = null;
  let fixtureRootWasFresh = false;
  try {
    const [existingRoot, existingReport] = await Promise.all([optionalLstat(fixtureRoot), optionalLstat(reportPath)]);
    if (existingRoot) throw new Error("Fixture root already exists; refusing to reuse it");
    if (existingReport) throw new Error("Native report output must be fresh");
    fixtureRootWasFresh = true;
    staged = await stageRendererNativeApp({
      binary, runDirectory, autoClear, runId, expectedSha256: sourceSha256, mode, settingsSourceSnapshot,
    });
    result.appBundle = {
      identifier: staged.identifier,
      displayName: staged.displayName,
      executable: "Contents/MacOS/AToolsRendererSmoke",
      sourceSha256: staged.sourceSha256,
      stagedSha256: staged.stagedSha256,
      mode: staged.mode,
      probeResource: staged.probeResource,
      ...(staged.settingsBundle ? { settingsBundle: staged.settingsBundle } : {}),
      infoPlist: staged.infoPlist,
    };
    const args = buildNativeCaseArgs({ fixtureRoot, rendererDist, output: reportPath, autoClear, runId, mode });
    console.log(`native renderer case ${autoClear}: starting direct bundle executable`);
    processResult = await runNativeChild(staged.executable, args, {
      timeoutMs: mode === "settings" ? 150_000 : mode === "multiwebview" ? 75_000 : 45_000,
      spawnOptions: { cwd: root, env: nativeChildEnvironment(process.env) },
    });
    result.process = processResult;
    result.cleanup.processTerminal = processResult.spawned ? processResult.terminalObserved : null;

    if (processResult.terminalObserved && processResult.pid !== null) {
      const [reportFile, markerFile] = await Promise.all([
        readJsonFile(reportPath, 1024 * 1024),
        readMarkerSafely(fixtureRoot),
      ]);
      const summary = mode === "settings" ? summarizeSettingsNativeReport : summarizeNativeReport;
      result.nativeReport = summary(reportFile, markerFile, { mode, autoClear, fixtureRoot, childPid: processResult.pid });
      result.cleanup.fixtureRoot = await cleanupOwnedFixtureRoot({
        root: fixtureRoot,
        childPid: processResult.pid,
        processTerminal: true,
      });
      result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
    } else if (processResult.terminalObserved) {
      result.nativeReport = {
        exists: false, valid: false, version: null, autoClear: null, passed: false,
        metadataMatchesOwner: false, exception: processResult.exception,
        modeEvidence: mode === "settings" ? validateSettingsViewMode(null) : validateMultiwebviewMode(null, mode),
        owner: { exists: false, valid: false, identifier: null, markerPidMatchesChild: false, rootMatchesFixture: false },
      };
      result.cleanup.fixtureRoot = await cleanupOwnedFixtureRoot({ root: fixtureRoot, childPid: null, processTerminal: true });
      result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
    } else {
      result.cleanup.fixtureRoot = await cleanupOwnedFixtureRoot({
        root: fixtureRoot,
        childPid: processResult.pid,
        processTerminal: processResult.spawned ? false : true,
      });
      result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
    }
  } catch (error) {
    result.exception = errorRecord(error);
    if (fixtureRootWasFresh && !processResult) {
      result.cleanup.fixtureRoot = await cleanupOwnedFixtureRoot({ root: fixtureRoot, childPid: null, processTerminal: true });
      result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
    }
  }

  if (staged) {
    result.cleanup.appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath,
      runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity,
      processTerminal: processResult ? (!processResult.spawned || processResult.terminalObserved) : true,
    });
  } else {
    const absence = await inspectOptionalPathAbsence(bundlePath);
    const bundleAbsent = absence.known ? absence.absent : null;
    result.cleanup.appBundle = {
      processTerminal: processResult?.terminalObserved ?? null,
      bundleAbsent,
      status: absence.known && absence.absent ? "not_created_or_stage_cleaned" : "preserved",
      reason: !absence.known ? "bundle_inspection_failed"
        : absence.absent ? null : "bundle_stage_ownership_unavailable",
    };
  }
  result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;
  result.cleanup.cleanupBeforeNextCase = result.cleanup.processTerminal === true
    && result.cleanup.fixtureRootAbsent === true && result.cleanup.appBundleAbsent === true;
  result.passed = processResult?.spawned === true && processResult.terminalObserved === true
    && processResult.exitCode === 0 && processResult.signal === null && processResult.timedOut === false
    && result.nativeReport?.valid === true && result.cleanup.cleanupBeforeNextCase === true;
  console.log(`native renderer ${mode} case ${autoClear}: terminal=${result.cleanup.processTerminal}; passed=${result.passed}; cleanup=${result.cleanup.cleanupBeforeNextCase}`);
  return result;
}

function aggregateCleanup(values, expected) {
  if (values.some(value => value === false)) return false;
  if (values.length !== expected || values.some(value => value !== true)) return null;
  return true;
}

export async function runNativeRendererAcceptance(argv = process.argv.slice(2)) {
  const runUUID = randomUUID();
  let runDirectory;
  try { runDirectory = await createNativeRunDirectory(root, runUUID); }
  catch (error) {
    console.error(`native renderer report could not be created (${error.code || error.name || "error"})`);
    return 1;
  }

  const reportPath = join(runDirectory, "report.json");
  const startedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1,
    runId: runUUID,
    startedAt,
    finishedAt: null,
    mode: null,
    passed: false,
    runner: { nodeVersion: process.versions.node, nodePath: process.execPath },
    binary: { path: null, before: null, after: null, binaryStable: false },
    launcherProbe: null,
    source: {
      before: null,
      after: null,
      nativeSourcesBefore: null,
      nativeSourcesAfter: null,
      packageSourceStable: false,
      upstreamStable: false,
      distStable: false,
      nativeSourcesStable: false,
      settingsSource: null,
      provenance: null,
    },
    buildReceipt: { path: null, before: null, after: null, matchesRunInputs: false, stable: false, validationErrors: [] },
    cases: [],
    cleanup: {
      nativeProcessesTerminal: null,
      fixtureRootsAbsent: null,
      appBundlesAbsent: null,
      allCasesCleanBeforeNextSpawn: null,
    },
    exception: null,
    reportPath,
  };
  let sourceLock = null;
  let upstreamPath = null;
  let binaryPath = null;
  let launcherProbePath = null;
  let launcherProbeFingerprint = null;
  let buildReceiptPath = null;
  let cli = null;
  let settingsSourceSnapshot = null;
  let preflightPassed = false;

  try {
    cli = parseNativeRunnerArgs(argv);
    report.mode = cli.mode;
    assert.equal(process.versions.node, "22.23.3", "Use the pinned product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the ATools product Node binary");
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    if (upstreamPath && !upstreamPath.startsWith("/")) throw new Error("ATOOLS_ZTOOLS_SOURCE must be an absolute path");
    const sourceSetup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles });
    sourceLock = sourceSetup.sourceLock;
    report.source.before = sourceSetup.snapshot;
    report.source.nativeSourcesBefore = await captureNativeSourceSnapshot(root);
    if (cli.mode === "settings") {
      settingsSourceSnapshot = await captureSettingsNativeSources(root);
      report.source.settingsSource = { before: summarizeSettingsNativeSources(settingsSourceSnapshot), after: null, stable: false };
    }

    const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
    const adapterSources = await sourceLock.readHostAdapterSources();
    assert.ok(adapterSources.length > 0 && adapterSources.length <= 64, "Actual host adapter source set must be nonempty and bounded");
    assert.equal(new Set(adapterSources.map(source => source.path)).size, adapterSources.length, "Host adapter source paths must be unique");
    assert.ok(adapterSources.every(source => typeof source.path === "string" && source.path.endsWith(".ts")
      && Number.isSafeInteger(source.bytes) && source.bytes > 0 && /^[0-9a-f]{64}$/.test(source.sha256)),
    "Host adapter source hashes must be complete");
    assert.deepEqual(adapterSources, provenance.hostAdapterSources, "Host adapter source hashes differ from renderer provenance");
    assert.equal(sourceSetup.snapshot.errors.length, 0, "Source and dist snapshots must be readable");
    assert.ok(sourceSetup.snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Pinned Vue renderer dist/index.html is missing");
    const runtimeJavaScript = Object.keys(sourceSetup.snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
    assert.ok(runtimeJavaScript.length > 0 && runtimeJavaScript.length <= 64, "Renderer JavaScript chunk count must be bounded");
    let actualJavaScriptBytes = 0;
    for (const path of runtimeJavaScript) actualJavaScriptBytes += (await readFile(join(root, path))).byteLength;
    validateRendererNativeProvenance(manifest, provenance, sourceSetup.snapshot.upstream, actualJavaScriptBytes);
    report.source.provenance = {
      sourceCommit: provenance.sourceCommit,
      sourceTreeSha256: provenance.sourceTreeSha256,
      sourceFiles: provenance.sourceFiles,
      totalJavaScriptBytes: provenance.bundle.totalJavaScriptBytes,
      hostAdapterSourceCount: adapterSources.length,
      hostAdapterSources: adapterSources,
    };

    const requestedBinary = cli.binary || join(root, "target/debug/examples/ztools_renderer_desktop_smoke");
    const binaryFingerprint = await fingerprintNativeExecutable(requestedBinary);
    binaryPath = binaryFingerprint.path;
    report.binary.path = cli.binary ? "absolute --binary override" : relative(root, binaryFingerprint.path);
    report.binary.before = {
      sha256: binaryFingerprint.sha256,
      sizeBytes: binaryFingerprint.sizeBytes,
      mtimeNs: binaryFingerprint.mtimeNs,
      device: binaryFingerprint.device,
      inode: binaryFingerprint.inode,
    };
    buildReceiptPath = cli.buildReceipt || join(root, "output/renderer-native-2026-10-27/native-build-binding.json");
    report.buildReceipt.path = cli.buildReceipt ? "absolute --build-receipt override" : relative(root, buildReceiptPath);
    const buildReceiptBefore = await readJsonFile(buildReceiptPath, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(buildReceiptBefore);
    let launcherProbeMatchesReceipt = true;
    if (cli.mode === "launcher") {
      const probeInput = await captureLauncherProbeFingerprint({
        binaryPath: cli.launcherProbeBinary, receiptSnapshot: buildReceiptBefore,
        nativeSources: report.source.nativeSourcesBefore,
      });
      launcherProbeFingerprint = probeInput.fingerprint;
      launcherProbePath = launcherProbeFingerprint.path;
      launcherProbeMatchesReceipt = probeInput.matchesReceipt;
      report.launcherProbe = {
        path: "absolute --launcher-probe-binary override",
        before: summarizeLauncherProbeFingerprint(launcherProbeFingerprint),
        after: null,
        matchesBuildReceipt: launcherProbeMatchesReceipt,
        stable: false,
      };
    }
    const buildBinding = validateNativeBuildReceipt(
      buildReceiptBefore,
      report.source.nativeSourcesBefore,
      binaryFingerprint.sha256,
    );
    report.buildReceipt.matchesRunInputs = buildBinding.valid && launcherProbeMatchesReceipt;
    report.buildReceipt.validationErrors = [...buildBinding.errors,
      ...(!launcherProbeMatchesReceipt ? ["launcher-probe-fingerprint-mismatch"] : [])];
    assert.equal(buildBinding.valid, true, "Build receipt must bind this binary and the current stable native source closure");
    assert.equal(launcherProbeMatchesReceipt, true, "Build receipt must bind the launcher probe binary fingerprint");
    if (settingsSourceSnapshot) await assertSettingsNativeSourcesUnchanged(settingsSourceSnapshot);
    report.source.before = sourceSetup.snapshot;
    preflightPassed = true;
    console.log("native renderer: source provenance and direct executable identity verified");

    for (const autoClear of cases) {
      const caseResult = await runCase({
        mode: cli.mode,
        autoClear,
        runDirectory,
        binary: binaryFingerprint.path,
        distRoot,
        sourceSha256: binaryFingerprint.sha256,
        settingsSourceSnapshot,
        launcherProbeFingerprint,
      });
      report.cases.push(caseResult);
      if (!caseResult.cleanup.cleanupBeforeNextCase) break;
    }
  } catch (error) {
    report.exception = errorRecord(error);
  } finally {
    if (sourceLock) report.source.after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
    if (settingsSourceSnapshot) {
      try {
        const settingsAfter = await assertSettingsNativeSourcesUnchanged(settingsSourceSnapshot);
        report.source.settingsSource.after = summarizeSettingsNativeSources(settingsAfter);
        report.source.settingsSource.stable = true;
      } catch (error) {
        report.source.settingsSource.exception = errorRecord(error);
      }
    }
    try { report.source.nativeSourcesAfter = await captureNativeSourceSnapshot(root); }
    catch (error) { report.source.nativeSourcesAfterException = errorRecord(error); }
    if (report.binary.path) {
      try {
        const after = await fingerprintNativeExecutable(binaryPath);
        report.binary.after = {
          sha256: after.sha256,
          sizeBytes: after.sizeBytes,
          mtimeNs: after.mtimeNs,
          device: after.device,
          inode: after.inode,
        };
      }
      catch (error) { report.binary.afterException = errorRecord(error); }
    }
    if (launcherProbePath) {
      try {
        Object.assign(report.launcherProbe, await verifyLauncherProbeFingerprintUnchanged(launcherProbePath, launcherProbeFingerprint));
      } catch (error) { report.launcherProbe.afterException = errorRecord(error); }
    }
    if (buildReceiptPath) {
      const buildReceiptAfter = await readJsonFile(buildReceiptPath, 1024 * 1024);
      report.buildReceipt.after = summarizeNativeBuildReceipt(buildReceiptAfter);
    }
    report.binary.binaryStable = Boolean(report.binary.before && report.binary.after)
      && report.binary.before.sha256 === report.binary.after.sha256
      && report.binary.before.mtimeNs === report.binary.after.mtimeNs
      && report.binary.before.sizeBytes === report.binary.after.sizeBytes
      && report.binary.before.device === report.binary.after.device
      && report.binary.before.inode === report.binary.after.inode;
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
      && report.source.distStable && report.source.nativeSourcesStable
      && (report.mode !== "settings" || report.source.settingsSource?.stable === true);
    report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256 && report.buildReceipt.after?.contentSha256)
      && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256;
    report.cleanup.nativeProcessesTerminal = aggregateCleanup(report.cases.map(item => item.cleanup.processTerminal), cases.length);
    report.cleanup.fixtureRootsAbsent = aggregateCleanup(report.cases.map(item => item.cleanup.fixtureRootAbsent), cases.length);
    report.cleanup.appBundlesAbsent = aggregateCleanup(report.cases.map(item => item.cleanup.appBundleAbsent), cases.length);
    report.cleanup.allCasesCleanBeforeNextSpawn = report.cases.length === cases.length
      ? report.cases.every(item => item.cleanup.cleanupBeforeNextCase === true)
      : false;
    report.finishedAt = new Date().toISOString();
    report.passed = preflightPassed && report.exception === null && report.cases.length === cases.length
      && report.cases.every(item => item.passed)
      && report.binary.binaryStable && report.source.packageSourceStable
      && report.source.upstreamStable && report.source.distStable && report.source.nativeSourcesStable
      && (report.mode !== "settings" || report.source.settingsSource?.stable === true)
      && (report.mode !== "launcher" || (report.launcherProbe?.matchesBuildReceipt === true && report.launcherProbe.stable))
      && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable
      && report.cleanup.nativeProcessesTerminal === true
      && report.cleanup.fixtureRootsAbsent === true && report.cleanup.appBundlesAbsent === true
      && report.cleanup.allCasesCleanBeforeNextSpawn === true;
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`native renderer report: ${reportPath}`);
      console.log(`native renderer passed=${report.passed}; process-terminal=${report.cleanup.nativeProcessesTerminal}; roots-absent=${report.cleanup.fixtureRootsAbsent}; bundles-absent=${report.cleanup.appBundlesAbsent}`);
    } catch (error) {
      console.error(`native renderer summary write failed (${error.code || error.name || "error"})`);
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runNativeRendererAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`native renderer runner failed (${error.code || error.name || "error"})`);
    process.exitCode = 1;
  });
}
