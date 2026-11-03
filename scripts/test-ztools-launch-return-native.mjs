import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, realpath, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureNativeSourceSnapshot,
  fingerprintNativeExecutable,
  summarizeNativeBuildReceipt,
  validateNativeBuildReceipt,
} from "./lib/ztools-renderer-native-source-binding.mjs";
import {
  captureLauncherProbeFingerprint,
  readJsonFile,
  summarizeLauncherProbeFingerprint,
  verifyLauncherProbeFingerprintUnchanged,
} from "./lib/ztools-renderer-launch-runtime.mjs";
import {
  errorRecord,
  runLaunchReturnCase,
} from "./lib/ztools-launch-return-native-case.mjs";
import { launcherProbeFingerprintMatchesReceipt } from "./lib/ztools-renderer-launch-probes.mjs";
import {
  setupNativeRendererSourceLock,
  snapshotNativeRendererSources,
} from "./lib/ztools-renderer-native-source-snapshots.mjs";
import { validateRendererNativeProvenance } from "./lib/ztools-renderer-native-provenance.mjs";
import {
  assertLaunchReturnSettingsSourcesUnchanged, captureLaunchReturnSettingsSources,
  LAUNCH_RETURN_MAIN_JAVASCRIPT_BYTES, launchReturnSettingsBuildReceiptMatches, summarizeLaunchReturnSettingsSources,
} from "./lib/ztools-launch-return-settings-sources.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const reportParent = join(root, "output/renderer-launch-return-native-2026-10-27");
export const LAUNCH_RETURN_NATIVE_FIXTURE_FILES = [
  "scripts/test-ztools-launch-return-native.mjs",
  "scripts/lib/ztools-renderer-native-provenance.mjs",
  "scripts/lib/ztools-renderer-native-provenance.test.mjs",
  "scripts/lib/ztools-launch-return-native-case.mjs",
  "scripts/lib/ztools-launch-return-native-report.mjs",
  "scripts/lib/ztools-launch-return-native-report.test.mjs",
  "scripts/lib/ztools-launch-return-settings-registration.mjs",
  "scripts/lib/ztools-launch-return-settings-registration.test.mjs",
  "scripts/lib/ztools-launch-return-settings-fixtures.mjs",
  "scripts/lib/ztools-launch-return-settings-sqlite.mjs",
  "scripts/lib/ztools-launch-return-settings-sqlite.test.mjs",
  "scripts/lib/ztools-launch-return-settings-sources.mjs",
  "scripts/lib/ztools-launch-return-settings-sources.test.mjs",
  "scripts/lib/ztools-settings-native-sources.mjs",
  "scripts/lib/ztools-settings-native-sources.test.mjs",
  "scripts/lib/ztools-settings-resource-budget.mjs",
  "output/renderer-main-frontier-r68-2026-10-29/build-native.mjs",
  "scripts/test-ztools-launch-return-native-probe.mjs",
  "scripts/lib/ztools-renderer-launch-probes.mjs",
  "scripts/test-ztools-renderer-launch-probes.mjs",
  "scripts/test-ztools-catalog-native.mjs",
  "scripts/lib/ztools-catalog-native-report.mjs",
  "scripts/lib/ztools-renderer-launch-runtime.mjs",
  "scripts/lib/ztools-launcher-native-validation.mjs",
  "scripts/lib/ztools-renderer-native-runtime.mjs",
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
];

function sameJson(left, right) {
  return left !== null && right !== null && JSON.stringify(left) === JSON.stringify(right);
}

function fingerprintSummary(value) {
  if (!value) return null;
  const { sha256, sizeBytes, mtimeNs, device, inode } = value;
  return { sha256, sizeBytes, mtimeNs, device, inode };
}

export function parseLaunchReturnNativeArgs(argv) {
  const options = new Map();
  const supported = new Set(["--binary", "--build-receipt", "--launcher-probe-binary", "--target-kind", "--registration-source"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!supported.has(flag) || options.has(flag) || index + 1 >= argv.length) {
      throw new Error("Only --binary, --build-receipt, --launcher-probe-binary, --target-kind, and --registration-source are accepted once each");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--target-kind") {
      if (!["app", "local-shortcut"].includes(value)) throw new Error("--target-kind must be app or local-shortcut");
    } else if (flag === "--registration-source") {
      if (!["core-seed", "settings-child"].includes(value)) throw new Error("--registration-source must be core-seed or settings-child");
    } else if (!isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
    options.set(flag, value);
  }
  const binary = options.get("--binary");
  const buildReceipt = options.get("--build-receipt");
  const launcherProbeBinary = options.get("--launcher-probe-binary");
  if (!binary || !buildReceipt || !launcherProbeBinary) {
    throw new Error("--binary, --build-receipt, and --launcher-probe-binary are required");
  }
  const targetKind = options.get("--target-kind") || "app";
  const registrationSource = options.get("--registration-source") || "core-seed";
  if (registrationSource === "settings-child" && targetKind !== "local-shortcut") {
    throw new Error("--registration-source settings-child requires --target-kind local-shortcut");
  }
  return { binary, buildReceipt, launcherProbeBinary, targetKind, registrationSource };
}

async function createRunDirectory(runId) {
  await mkdir(reportParent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(reportParent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(reportParent) !== reportParent) {
    throw new Error("Launch-return output path must use real directories");
  }
  const runDirectory = join(reportParent, `run-${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  const runInfo = await lstat(runDirectory, { bigint: true });
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o077n) !== 0
      || await realpath(runDirectory) !== runDirectory) {
    throw new Error("Launch-return run directory must be private");
  }
  return runDirectory;
}

export async function runLaunchReturnNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  let runDirectory;
  try { runDirectory = await createRunDirectory(runId); }
  catch (error) {
    console.error(`launch-return report directory unavailable (${error.code || error.name || "error"})`);
    return 1;
  }
  const reportPath = join(runDirectory, "report.json");
  const report = {
    schemaVersion: 2, journey: "launch-return", scope: "hidden-original-vue-real-launch-return-runner", registrationSource: null,
    runId, startedAt: new Date().toISOString(), finishedAt: null, passed: false,
    runner: { nodeVersion: process.versions.node, nodePath: process.execPath },
    binary: { path: null, before: null, after: null, stable: false },
    launcherProbe: { path: null, before: null, after: null, matchesBuildReceipt: false, stable: false },
    source: { before: null, after: null, nativeSourcesBefore: null, nativeSourcesAfter: null,
      packageSourceStable: false, upstreamStable: false, distStable: false, nativeSourcesStable: false, provenance: null,
      settingsBefore: null, settingsAfter: null, settingsStable: null },
    buildReceipt: { path: null, before: null, after: null, matchesRunInputs: false, stable: false, validationErrors: [] },
    case: null, exception: null, reportPath: relative(root, reportPath).split("\\").join("/"),
  };
  let cli = null;
  let sourceLock = null;
  let upstreamPath = null;
  let binaryPath = null;
  let launcherProbePath = null;
  let launcherProbeFingerprint = null;
  let binaryBefore = null;
  let receiptBefore = null;
  let preflightPassed = false;
  let settingsSourceSnapshot = null;
  try {
    cli = parseLaunchReturnNativeArgs(argv);
    report.registrationSource = cli.registrationSource;
    assert.equal(process.platform, "darwin", "Launch-return Native acceptance requires macOS");
    assert.equal(process.versions.node, "22.23.3", "Run with the pinned product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the ATools product Node binary");
    const canonicalReceipt = await realpath(cli.buildReceipt);
    const receiptParent = join(root, "output/renderer-launch-return-2026-10-27");
    assert.equal(dirname(canonicalReceipt), receiptParent, "Use the fresh run-specific build receipt");
    assert.match(basename(canonicalReceipt), /^native-build-receipt-\d+\.json$/, "Build receipt filename must be unique to a fresh build");
    const receiptInfo = await lstat(cli.buildReceipt);
    const receiptAgeMs = Date.now() - receiptInfo.mtimeMs;
    assert.ok(receiptInfo.isFile() && !receiptInfo.isSymbolicLink() && receiptAgeMs >= 0
      && receiptAgeMs < 24 * 60 * 60 * 1000, "Build receipt must be a fresh regular file");
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    assert.ok(upstreamPath && isAbsolute(upstreamPath), "Set ATOOLS_ZTOOLS_SOURCE to the absolute pinned ZTools checkout");

    const setup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot,
      fixtureFiles: LAUNCH_RETURN_NATIVE_FIXTURE_FILES });
    sourceLock = setup.sourceLock;
    report.source.before = setup.snapshot;
    report.source.nativeSourcesBefore = await captureNativeSourceSnapshot(root);
    assert.equal(setup.snapshot.errors.length, 0, "Renderer source and dist snapshots must be complete");
    assert.ok(setup.snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Renderer dist entry is missing");
    const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
    const adapterSources = await sourceLock.readHostAdapterSources();
    assert.ok(adapterSources.length > 0 && adapterSources.length <= 64, "Renderer adapter source hashes must be bounded");
    assert.deepEqual(adapterSources, provenance.hostAdapterSources, "Host adapter source hashes differ from dist provenance");
    const runtimeJavaScript = Object.keys(setup.snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
    assert.ok(runtimeJavaScript.length > 0 && runtimeJavaScript.length <= 64, "Renderer JavaScript chunk count must be bounded");
    let actualJavaScriptBytes = 0;
    for (const path of runtimeJavaScript) actualJavaScriptBytes += (await readFile(join(root, path))).byteLength;
    validateRendererNativeProvenance(manifest, provenance, setup.snapshot.upstream, actualJavaScriptBytes);
    if (cli.registrationSource === "settings-child") {
      assert.equal(actualJavaScriptBytes, LAUNCH_RETURN_MAIN_JAVASCRIPT_BYTES, "Main production JavaScript bytes changed");
      settingsSourceSnapshot = await captureLaunchReturnSettingsSources(root);
      report.source.settingsBefore = summarizeLaunchReturnSettingsSources(settingsSourceSnapshot);
    }
    report.source.provenance = {
      sourceCommit: provenance.sourceCommit, sourceTreeSha256: provenance.sourceTreeSha256,
      sourceFiles: provenance.sourceFiles, totalJavaScriptBytes: provenance.bundle.totalJavaScriptBytes,
      hostAdapterSourceCount: adapterSources.length, hostAdapterSources: adapterSources,
    };

    binaryBefore = await fingerprintNativeExecutable(cli.binary);
    binaryPath = binaryBefore.path;
    report.binary.path = "absolute --binary override";
    report.binary.before = fingerprintSummary(binaryBefore);
    receiptBefore = await readJsonFile(cli.buildReceipt, 1024 * 1024);
    report.buildReceipt.path = "absolute --build-receipt override";
    report.buildReceipt.before = summarizeNativeBuildReceipt(receiptBefore);
    const probeInput = await captureLauncherProbeFingerprint({
      binaryPath: cli.launcherProbeBinary, receiptSnapshot: receiptBefore,
      nativeSources: report.source.nativeSourcesBefore,
    });
    launcherProbeFingerprint = probeInput.fingerprint;
    launcherProbePath = launcherProbeFingerprint.path;
    report.launcherProbe.path = "absolute --launcher-probe-binary override";
    report.launcherProbe.before = summarizeLauncherProbeFingerprint(launcherProbeFingerprint);
    const binding = validateNativeBuildReceipt(receiptBefore, report.source.nativeSourcesBefore, binaryBefore.sha256);
    const probeMatchesReceipt = launcherProbeFingerprintMatchesReceipt(receiptBefore, launcherProbeFingerprint);
    const settingsMatchReceipt = cli.registrationSource !== "settings-child"
      || launchReturnSettingsBuildReceiptMatches(receiptBefore.value, settingsSourceSnapshot, setup.snapshot);
    report.buildReceipt.matchesRunInputs = binding.valid && probeMatchesReceipt && settingsMatchReceipt;
    report.buildReceipt.validationErrors = [...binding.errors,
      ...(!probeMatchesReceipt ? ["launcher-probe-fingerprint-mismatch"] : []),
      ...(!settingsMatchReceipt ? ["settings-child-build-source-mismatch"] : [])];
    report.launcherProbe.matchesBuildReceipt = probeMatchesReceipt;
    assert.equal(binding.valid, true, "Build receipt must bind this example binary and current native sources");
    assert.equal(probeMatchesReceipt, true, "Build receipt must bind the owned launcher probe binary");
    assert.equal(settingsMatchReceipt, true, "Fresh build receipt must bind the Settings child and current runner/Main sources");
    preflightPassed = true;
    report.case = await runLaunchReturnCase({ runDirectory, workspaceRoot: root, binaryFingerprint: binaryBefore,
      launcherProbeFingerprint, rendererDist: distRoot, targetKind: cli.targetKind,
      registrationSource: cli.registrationSource, settingsSourceSnapshot });
  } catch (error) {
    report.exception = errorRecord(error);
  } finally {
    if (settingsSourceSnapshot) {
      try {
        const after = await assertLaunchReturnSettingsSourcesUnchanged(settingsSourceSnapshot);
        report.source.settingsAfter = summarizeLaunchReturnSettingsSources(after);
        report.source.settingsStable = true;
      } catch (error) { report.source.settingsStable = false; report.source.settingsAfterException = errorRecord(error); }
    }
    if (sourceLock) report.source.after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
    try { report.source.nativeSourcesAfter = await captureNativeSourceSnapshot(root); }
    catch (error) { report.source.nativeSourcesAfterException = errorRecord(error); }
    if (binaryPath) {
      try { report.binary.after = fingerprintSummary(await fingerprintNativeExecutable(binaryPath)); }
      catch (error) { report.binary.afterException = errorRecord(error); }
    }
    if (launcherProbePath && launcherProbeFingerprint) {
      try {
        const stable = await verifyLauncherProbeFingerprintUnchanged(launcherProbePath, launcherProbeFingerprint);
        report.launcherProbe.after = stable.after;
        report.launcherProbe.stable = stable.stable;
      } catch (error) { report.launcherProbe.afterException = errorRecord(error); }
    }
    if (cli?.buildReceipt) {
      const receiptAfter = await readJsonFile(cli.buildReceipt, 1024 * 1024);
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
    if (report.launcherProbe.before && report.launcherProbe.after) {
      report.launcherProbe.stable = report.launcherProbe.stable
        && sameJson(report.launcherProbe.before, report.launcherProbe.after);
    }
    report.binary.stable = Boolean(report.binary.before && report.binary.after)
      && sameJson(report.binary.before, report.binary.after);
    report.buildReceipt.stable = Boolean(report.buildReceipt.before?.contentSha256 && report.buildReceipt.after?.contentSha256)
      && report.buildReceipt.before.contentSha256 === report.buildReceipt.after.contentSha256;
    report.finishedAt = new Date().toISOString();
    report.passed = preflightPassed && report.exception === null && report.case?.passed === true
      && report.binary.stable && report.launcherProbe.matchesBuildReceipt && report.launcherProbe.stable
      && report.source.packageSourceStable && report.source.upstreamStable && report.source.distStable
      && report.source.nativeSourcesStable && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable
      && (cli?.registrationSource !== "settings-child" || report.source.settingsStable === true);
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`launch-return Native report: ${reportPath}`);
      console.log(`launch-return passed=${report.passed}; probes-terminal=${report.case?.cleanup.probesTerminal ?? false}; root-clean=${report.case?.cleanup.fixtureRootAbsent ?? false}`);
    } catch (error) {
      console.error(`launch-return report write failed (${error.code || error.name || "error"})`);
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runLaunchReturnNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`launch-return Native runner failed (${error.code || error.name || "error"})`);
    process.exitCode = 1;
  });
}
