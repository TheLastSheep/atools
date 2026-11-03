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
import { validateNativeMaterialReport } from "./lib/ztools-native-material-report.mjs";
import { validatePresentedPaintReport } from "./lib/ztools-presented-paint-report.mjs";
import { validateDisabledCommandsReport } from "./lib/ztools-disabled-commands-report.mjs";
import {
  LOCAL_APP_SEARCH_REPORT_FILENAME,
  validateLocalAppSearchReport,
} from "./lib/ztools-local-app-search-report.mjs";
import {
  PLUGIN_INVENTORY_OBSERVATIONS_FILENAME,
  validatePluginInventoryReport,
} from "./lib/ztools-plugin-inventory-report.mjs";
import {
  emptySettingsInputFinalReports,
  readSettingsInputFinalReports,
  settingsInputFinalReportsPassed,
} from "./lib/ztools-settings-input-final-reports.mjs";
import {
  parseSettingsInputNativeArgs,
  runSettingsInputNativeCase,
} from "./lib/ztools-settings-input-native-case.mjs";
import { settingsInputNativeFixtureFiles as fixtureFiles } from "./lib/ztools-settings-input-native-fixtures.mjs";
import {
  assertFallbackSettingsNativeSourcesUnchanged,
  captureFallbackSettingsNativeSources,
  summarizeFallbackSettingsNativeSources,
} from "./lib/fallback-settings-native-sources.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const reportParent = join(root, "output/renderer-settings-input-native-2026-10-27");
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
  const outputRoot = join(root, "output");
  await mkdir(outputRoot, { recursive: true, mode: 0o700 });
  const outputInfo = await lstat(outputRoot, { bigint: true });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink() || await realpath(outputRoot) !== outputRoot) {
    throw new Error("Output root must be a real directory");
  }
  await mkdir(reportParent, { recursive: true, mode: 0o700 });
  const parentInfo = await lstat(reportParent, { bigint: true });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(reportParent) !== reportParent) {
    throw new Error("settings-input output directory must be a real directory");
  }
  const runDirectory = join(reportParent, `run-${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  const runInfo = await lstat(runDirectory, { bigint: true });
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o077n) !== 0
      || await realpath(runDirectory) !== runDirectory) {
    throw new Error("settings-input run directory must be private");
  }
  return runDirectory;
}

async function validateBuildReceiptPath(path) {
  const canonical = await realpath(path);
  assert.equal(dirname(canonical), reportParent, "Use a fresh settings-input build receipt");
  assert.match(basename(canonical), /^native-build-receipt-\d+\.json$/, "Build receipt filename must be unique");
  const info = await lstat(path, { bigint: true });
  const ageMs = Date.now() - Number(info.mtimeMs);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n
    && ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000, "Build receipt must be a fresh regular file");
  return ageMs;
}

async function captureActualRendererBundle(sourceLock, snapshot, manifest, provenance) {
  assert.equal(snapshot.errors.length, 0, "Package, dist, and upstream snapshots must be readable");
  assert.ok(snapshot.distFiles?.["packages/ztools-renderer/dist/index.html"], "Original renderer dist entry is missing");
  const adapterSources = await sourceLock.readHostAdapterSources();
  assert.ok(adapterSources.length > 0 && adapterSources.length <= 64, "Host adapter source set must be bounded");
  assert.equal(new Set(adapterSources.map(item => item.path)).size, adapterSources.length, "Host adapter source paths must be unique");
  assert.ok(adapterSources.every(item => typeof item.path === "string" && item.path.endsWith(".ts")
    && Number.isSafeInteger(item.bytes) && item.bytes > 0 && /^[0-9a-f]{64}$/.test(item.sha256)),
  "Host adapter source hashes must be complete");
  assert.deepEqual(adapterSources, provenance.hostAdapterSources, "Host adapter source hashes differ from provenance");
  const chunks = Object.keys(snapshot.distFiles).filter(path => /\.[cm]?js$/.test(path));
  assert.equal(chunks.length, 3, "Use the current renderer's three emitted JavaScript chunks");
  assert.ok(chunks.every(path => path.startsWith("packages/ztools-renderer/dist/")), "Renderer chunks must stay inside the locked dist");
  let actualJavaScriptBytes = 0;
  for (const path of chunks) actualJavaScriptBytes += (await readFile(join(root, path))).byteLength;
  validateRendererNativeProvenance(manifest, provenance, snapshot.upstream, actualJavaScriptBytes);
  return { adapterSources, chunkCount: chunks.length, actualJavaScriptBytes };
}

export async function runSettingsInputNativeAcceptance(argv = process.argv.slice(2)) {
  const runId = randomUUID().replaceAll("-", "");
  let runDirectory;
  try { runDirectory = await createRunDirectory(runId); }
  catch (error) {
    console.error(`settings-input report directory unavailable (${error.code || error.name || "error"})`);
    return 1;
  }
  const reportPath = join(runDirectory, "report.json");
  const report = {
    schemaVersion: 1, journey: "settings-input", scope: "hidden-original-vue-real-settings-input-runner",
    runId, startedAt: new Date().toISOString(), finishedAt: null, passed: false,
    runner: { nodeVersion: process.versions.node, productRuntime: false },
    binary: { sha256: null, sizeBytes: null, stable: false },
    source: { before: null, after: null, nativeSourcesBefore: null, nativeSourcesAfter: null,
    packageSourceStable: false, upstreamStable: false, distStable: false, nativeSourcesStable: false,
    settingsBefore: null, settingsAfter: null, settingsStable: false, settingsBundleStaged: false,
    fallbackSettingsBefore: null, fallbackSettingsAfter: null, fallbackSettingsStable: false,
    fallbackSettingsStaged: false, provenance: null },
    buildReceipt: { before: null, after: null, matchesRunInputs: false, stable: false, ageMs: null, validationErrors: [] },
    case: null, material: null, paintPresentation: "hidden",
    localAppSearch: { exists: false, valid: false, passed: false, errors: [], summary: null,
      ownerMatchesNativeReport: null, exception: null },
    pluginInventory: { exists: false, valid: false, passed: false, errors: [], summary: null,
      ownerMatchesNativeReport: null, exception: null },
    ...emptySettingsInputFinalReports(),
    presentedPaint: { requested: false, mode: "hidden", status: "not-requested", valid: null, passed: false,
      errors: [], summary: null, ownerMatchesNativeReport: null, exception: null },
    exception: null, reportPath: relative(root, reportPath).split("\\").join("/"),
  };
  let cli = null;
  let sourceLock = null;
  let settingsSourceSnapshot = null;
  let fallbackSettingsSourceSnapshot = null;
  let upstreamPath = null;
  let binaryPath = null;
  let binaryBefore = null;
  let receiptBefore = null;
  let preflightPassed = false;

  try {
    cli = parseSettingsInputNativeArgs(argv);
    report.paintPresentation = cli.paintPresentation;
    report.presentedPaint = {
      requested: cli.paintPresentation === "visible-unfocused",
      mode: cli.paintPresentation,
      status: cli.paintPresentation === "hidden" ? "not-requested" : "pending",
      valid: null,
      passed: false,
      errors: [],
      summary: null,
      ownerMatchesNativeReport: null,
      exception: null,
    };
    assert.equal(process.platform, "darwin", "Native settings-input acceptance requires macOS");
    assert.equal(process.versions.node, "22.23.3", "Use the pinned Product Node 22.23.3");
    assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the ATools Product Node binary");
    report.runner.productRuntime = true;
    report.buildReceipt.ageMs = await validateBuildReceiptPath(cli.buildReceipt);
    upstreamPath = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() || null;
    assert.ok(upstreamPath && isAbsolute(upstreamPath), "Set ATOOLS_ZTOOLS_SOURCE to the absolute pinned ZTools checkout");

    const setup = await setupNativeRendererSourceLock({ root, upstreamPath, packageRoot, distRoot, fixtureFiles });
    sourceLock = setup.sourceLock;
    report.source.before = {
      packageFiles: summarizeFileMap(setup.snapshot.packageFiles),
      distFiles: summarizeFileMap(setup.snapshot.distFiles),
      upstream: setup.snapshot.upstream ? {
        commit: setup.snapshot.upstream.commit, clean: setup.snapshot.upstream.dirty === "",
        files: setup.snapshot.upstream.files, sha256: setup.snapshot.upstream.sha256,
      } : null,
      errors: setup.snapshot.errors.map(item => ({ area: item.area, name: item.name, code: item.code ?? null })),
    };
    report.source.nativeSourcesBefore = summarizeNativeSources(await captureNativeSourceSnapshot(root));
    settingsSourceSnapshot = await captureSettingsNativeSources(root);
    report.source.settingsBefore = summarizeSettingsNativeSources(settingsSourceSnapshot);
    fallbackSettingsSourceSnapshot = await captureFallbackSettingsNativeSources(root);
    report.source.fallbackSettingsBefore = summarizeFallbackSettingsNativeSources(fallbackSettingsSourceSnapshot);
    const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
    const provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
    const bundle = await captureActualRendererBundle(sourceLock, setup.snapshot, manifest, provenance);
    report.source.provenance = {
      sourceCommit: provenance.sourceCommit, sourceTreeSha256: provenance.sourceTreeSha256,
      sourceFiles: provenance.sourceFiles, totalJavaScriptBytes: bundle.actualJavaScriptBytes,
      runtimeChunkCount: bundle.chunkCount, hostAdapterSourceCount: bundle.adapterSources.length,
      hostAdapterSourceSha256: hashJson(bundle.adapterSources),
      settingsSourcesSha256: settingsSourceSnapshot.sha256,
      settingsSourceFileCount: settingsSourceSnapshot.packageFileCount,
      settingsSourceBytes: settingsSourceSnapshot.packageBytes,
      settingsBundleBytes: settingsSourceSnapshot.bundle.resourceBytes,
    };

    binaryBefore = await fingerprintNativeExecutable(cli.binary);
    binaryPath = binaryBefore.path;
    report.binary.sha256 = binaryBefore.sha256;
    report.binary.sizeBytes = binaryBefore.sizeBytes;
    receiptBefore = await readJsonFile(cli.buildReceipt, 1024 * 1024);
    report.buildReceipt.before = summarizeNativeBuildReceipt(receiptBefore);
    const binding = validateNativeBuildReceipt(receiptBefore, report.source.nativeSourcesBefore, binaryBefore.sha256);
    report.buildReceipt.matchesRunInputs = binding.valid;
    report.buildReceipt.validationErrors = binding.errors;
    assert.equal(binding.valid, true, "Fresh build receipt must bind this binary and exact native source closure");
    preflightPassed = true;
    report.case = await runSettingsInputNativeCase({
      runDirectory, workspaceRoot: root, binaryFingerprint: binaryBefore, rendererDist: distRoot, runId,
      settingsSourceSnapshot, nativeSourceHashes: setup.snapshot.packageFiles, fallbackSourceSnapshot: fallbackSettingsSourceSnapshot,
      paintPresentation: cli.paintPresentation,
    });
    let materialFile = null;
    try { materialFile = await readJsonFile(join(runDirectory, "native-material-report.json"), 512 * 1024); }
    catch (error) { materialFile = { exists: false, value: null, exception: safeException(error) }; }
    const childPid = report.case.process?.pid;
    const expectedOwner = {
      runId,
      identifier: `dev.atools.renderer-settings-input.${runId}`,
      root: `/private/tmp/atools-renderer-settings-input-${runId}`,
      pid: childPid,
    };
    const materialValidation = await validateNativeMaterialReport(
      materialFile?.value, expectedOwner, runDirectory,
    ).catch(error => ({
      valid: false, passed: false, errors: [safeException(error).code || "material-report-invalid"],
      paintDiagnostics: { light: { state: "invalid" }, dark: { state: "invalid" } },
      visual: { status: "unverified", passed: false, reason: "material-report-invalid", snapshots: {} },
    }));
    const sameNativeOwner = report.case.profileOwner?.valid === true && report.case.nativeReport?.valid === true
      && Number.isSafeInteger(childPid) && childPid === expectedOwner.pid;
    const materialErrors = [...materialValidation.errors];
    if (!materialFile?.exists) materialErrors.push("material-report-missing");
    if (!sameNativeOwner) materialErrors.push("base-native-report-owner-invalid");
    report.material = {
      exists: materialFile?.exists === true,
      valid: materialValidation.valid === true && sameNativeOwner && materialFile?.exists === true,
      passed: materialValidation.passed === true && sameNativeOwner && materialFile?.exists === true,
      errors: [...new Set(materialErrors)],
      paintDiagnostics: materialValidation.paintDiagnostics,
      visual: materialValidation.visual,
      ownerMatchesNativeReport: sameNativeOwner,
      exception: materialFile?.exception ? safeException(materialFile.exception) : null,
    };
    const disabledFile = await readJsonFile(join(runDirectory, "native-disabled-commands-report.json"), 16 * 1024)
      .catch(() => ({ exists: false, value: null }));
    const disabledValidation = validateDisabledCommandsReport(disabledFile?.value, expectedOwner);
    report.disabledCommands = {
      ...disabledValidation,
      valid: disabledValidation.valid && sameNativeOwner && disabledFile?.exists === true,
      passed: disabledValidation.passed && sameNativeOwner && disabledFile?.exists === true,
      ownerMatchesNativeReport: sameNativeOwner,
    };
    let localSearchFile = null;
    try {
      localSearchFile = await readJsonFile(join(runDirectory, LOCAL_APP_SEARCH_REPORT_FILENAME), 16 * 1024);
    } catch (error) {
      localSearchFile = { exists: false, value: null, exception: safeException(error) };
    }
    const localSearchValidation = validateLocalAppSearchReport(localSearchFile?.value, expectedOwner);
    const localSearchErrors = [...localSearchValidation.errors, ...localSearchValidation.summary.nativeErrors];
    if (!localSearchFile?.exists) localSearchErrors.push("local-app-search-report-missing");
    if (!sameNativeOwner) localSearchErrors.push("local-app-search-base-owner-invalid");
    report.localAppSearch = {
      exists: localSearchFile?.exists === true,
      valid: localSearchValidation.valid && sameNativeOwner && localSearchFile?.exists === true,
      passed: localSearchValidation.passed && sameNativeOwner && localSearchFile?.exists === true,
      errors: [...new Set(localSearchErrors)],
      summary: localSearchValidation.summary,
      ownerMatchesNativeReport: sameNativeOwner,
      exception: localSearchFile?.exception ?? null,
    };
    let inventoryFile = null;
    try {
      inventoryFile = await readJsonFile(join(runDirectory, PLUGIN_INVENTORY_OBSERVATIONS_FILENAME), 16 * 1024);
    } catch (error) {
      inventoryFile = { exists: false, value: null, exception: safeException(error) };
    }
    const inventoryValidation = validatePluginInventoryReport(inventoryFile?.value, expectedOwner);
    const inventoryErrors = [...inventoryValidation.errors, ...inventoryValidation.summary.nativeErrors];
    if (!inventoryFile?.exists) inventoryErrors.push("plugin-inventory-observations-missing");
    if (!sameNativeOwner) inventoryErrors.push("plugin-inventory-base-owner-invalid");
    report.pluginInventory = {
      exists: inventoryFile?.exists === true,
      valid: inventoryValidation.valid && sameNativeOwner && inventoryFile?.exists === true,
      passed: inventoryValidation.passed && sameNativeOwner && inventoryFile?.exists === true,
      errors: [...new Set(inventoryErrors)],
      summary: inventoryValidation.summary,
      ownerMatchesNativeReport: sameNativeOwner,
      exception: inventoryFile?.exception ?? null,
    };
    Object.assign(report, await readSettingsInputFinalReports(
      runDirectory, expectedOwner, sameNativeOwner, report.case?.passed === true,
      report.case?.cleanup?.processTerminal === true,
    ));
    if (cli.paintPresentation === "visible-unfocused") {
      let presentedFile = null;
      try {
        presentedFile = await readJsonFile(join(runDirectory, "native-presented-paint-report.json"), 512 * 1024);
      } catch (error) {
        presentedFile = { exists: false, value: null, exception: safeException(error) };
      }
      const presentedValidation = await validatePresentedPaintReport(
        presentedFile?.value, expectedOwner, runDirectory,
      ).catch(error => ({
        valid: false,
        passed: false,
        errors: ["presented-paint-report-invalid"],
        summary: {
          mode: null, attempted: false, presentation: null, steps: {}, restoration: null, cleanup: null,
          windowTrace: null, nativeErrors: [],
        },
      }));
      const presentedErrors = [...presentedValidation.errors];
      if (!presentedFile?.exists) presentedErrors.push("presented-paint-report-missing");
      if (!sameNativeOwner) presentedErrors.push("presented-paint-base-owner-invalid");
      const presentedValid = presentedValidation.valid === true && sameNativeOwner && presentedFile?.exists === true;
      report.presentedPaint = {
        requested: true,
        mode: "visible-unfocused",
        status: presentedValid ? "observed" : "invalid",
        valid: presentedValid,
        passed: presentedValidation.passed === true && sameNativeOwner && presentedFile?.exists === true,
        errors: [...new Set(presentedErrors)],
        summary: presentedValidation.summary,
        ownerMatchesNativeReport: sameNativeOwner,
        exception: presentedFile?.exception ?? null,
      };
    }
  } catch (error) {
    report.exception = safeException(error);
  } finally {
    if (sourceLock) {
      const after = await snapshotNativeRendererSources(sourceLock, upstreamPath);
      report.source.after = {
        packageFiles: summarizeFileMap(after.packageFiles),
        distFiles: summarizeFileMap(after.distFiles),
        upstream: after.upstream ? {
          commit: after.upstream.commit, clean: after.upstream.dirty === "",
          files: after.upstream.files, sha256: after.upstream.sha256,
        } : null,
        errors: after.errors.map(item => ({ area: item.area, name: item.name, code: item.code ?? null })),
      };
      const afterSnapshotComplete = report.source.after?.errors?.length === 0;
      report.source.packageSourceStable = afterSnapshotComplete
        && sameJson(setupFileMap(report.source.before, "packageFiles"), setupFileMap(report.source.after, "packageFiles"));
      report.source.distStable = afterSnapshotComplete
        && sameJson(setupFileMap(report.source.before, "distFiles"), setupFileMap(report.source.after, "distFiles"));
      report.source.upstreamStable = report.source.before?.errors?.length === 0
        && report.source.after?.errors?.length === 0
        && sameJson(report.source.before?.upstream, report.source.after?.upstream)
        && report.source.before?.upstream?.clean === true;
    }
    if (settingsSourceSnapshot) {
      try {
        const after = await assertSettingsNativeSourcesUnchanged(settingsSourceSnapshot);
        report.source.settingsAfter = summarizeSettingsNativeSources(after);
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
    if (fallbackSettingsSourceSnapshot) {
      try {
        const after = await assertFallbackSettingsNativeSourcesUnchanged(fallbackSettingsSourceSnapshot);
        report.source.fallbackSettingsAfter = summarizeFallbackSettingsNativeSources(after);
        report.source.fallbackSettingsStable = true;
      } catch (error) {
        report.source.fallbackSettingsStable = false;
        report.source.fallbackSettingsAfterException = safeException(error);
        try {
          const after = await captureFallbackSettingsNativeSources(root);
          report.source.fallbackSettingsAfter = summarizeFallbackSettingsNativeSources(after);
        } catch (captureError) { report.source.fallbackSettingsAfterCaptureException = safeException(captureError); }
      }
    }
    try { report.source.nativeSourcesAfter = summarizeNativeSources(await captureNativeSourceSnapshot(root)); }
    catch (error) { report.source.nativeSourcesAfterException = safeException(error); }
    report.source.nativeSourcesStable = Boolean(report.source.nativeSourcesBefore && report.source.nativeSourcesAfter)
      && sameJson(report.source.nativeSourcesBefore, report.source.nativeSourcesAfter);
    if (binaryPath && binaryBefore) {
      try {
        const after = await fingerprintNativeExecutable(binaryPath);
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
    report.source.settingsBundleStaged = report.case?.appBundle?.settingsBundle?.staged === true;
    report.source.fallbackSettingsStaged = report.case?.appBundle?.fallbackSettingsBundle?.staged === true;
    report.passed = preflightPassed && report.exception === null && report.case?.passed === true
      && report.material?.valid === true && report.material?.passed === true
      && report.disabledCommands?.valid === true && report.disabledCommands?.passed === true
      && report.localAppSearch?.valid === true && report.localAppSearch?.passed === true
      && report.pluginInventory?.valid === true && report.pluginInventory?.passed === true
      && settingsInputFinalReportsPassed(report)
      && (cli?.paintPresentation !== "visible-unfocused"
        || report.presentedPaint?.valid === true && report.presentedPaint?.passed === true)
      && report.binary.stable && report.buildReceipt.matchesRunInputs && report.buildReceipt.stable
      && report.source.packageSourceStable && report.source.upstreamStable && report.source.distStable
      && report.source.nativeSourcesStable && report.source.settingsStable && report.source.settingsBundleStaged
      && report.source.fallbackSettingsStable && report.source.fallbackSettingsStaged;
    try {
      await writeFile(reportPath, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      console.log(`settings-input Native report: ${relative(root, reportPath).split("\\").join("/")}`);
      console.log(`settings-input passed=${report.passed}; case-clean=${report.case?.cleanup.allOwnedResourcesClean ?? false}; material=${report.material?.passed ?? false}; visual=${report.material?.visual?.status ?? "unverified"}; local-app-search=${report.localAppSearch?.passed ?? false}; plugin-inventory=${report.pluginInventory?.passed ?? false}; command-aliases=${report.commandAliases?.passed ?? false}; opacity=${report.windowOpacity?.passed ?? false}; tray=${report.trayVisibility?.passed ?? false}; general-policies=${report.generalPolicies?.passed ?? false}; launch-at-login=${report.launchAtLogin?.passed ?? false}; login-cross-entry=${report.loginCrossEntry?.passed ?? false}; fallback-source-stable=${report.source.fallbackSettingsStable}; presented-paint=${report.presentedPaint?.passed === true ? "passed" : report.presentedPaint?.status ?? "unverified"}`);
    } catch (error) {
      console.error(`settings-input report write failed (${error.code || error.name || "error"})`);
      return 1;
    }
  }
  return report.passed ? 0 : 1;
}

function setupFileMap(snapshot, key) {
  return snapshot?.[key]?.sha256 ? snapshot[key] : null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runSettingsInputNativeAcceptance().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`settings-input Native runner failed (${error.code || error.name || "error"})`);
    process.exitCode = 1;
  });
}
