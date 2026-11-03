import { constants } from "node:fs";
import { lstat, open, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupOwnedFixtureRoot, cleanupOwnedRendererApp } from "./ztools-renderer-native-runtime.mjs";

export const MAIN_FILE_DROP_REPORT_NAME = "main-drop-report.json";
export const MAIN_FILE_DROP_REPORT_LIMIT_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{32}$/;
const TOP_KEYS = ["schemaVersion", "kind", "inputSource", "contextObservation", "runId", "pid", "root",
  "passed", "errors", "stagesCompleted", "observed", "guiAcceptance", "osDropAcceptance"];
const OBSERVED_KEYS = ["targetRegistered", "nativeDropAccepted", "metadataFiles", "mainChipCount", "mainFileCount",
  "chipNames", "launchContextQuery", "launchContextFiles", "inputBefore", "inputAfterRestore", "targetRevoked",
  "actualWorkers", "pendingBatches"];
const STAGES = ["registered", "injected", "main-observed", "input-restored", "disposed"];
const EXPECTED_FILES = [
  { relativePath: "r77-main-drop/file.txt", name: "file.txt", isDirectory: false },
  { relativePath: "r77-main-drop/folder", name: "folder", isDirectory: true },
];

const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const inputSnapshot = value => exactKeys(value, ["query", "files"]) && value.query === "ATools Catalog"
  && Array.isArray(value.files) && value.files.length === 0;
const inputRootFor = root => join(root, "r77-main-drop");

export function validateMainFileDropNativeReport(value, { runId, pid, root }) {
  const errors = [];
  const require = (condition, code) => { if (!condition) errors.push(code); };
  require(exactKeys(value, TOP_KEYS), "top-level-shape");
  require(value?.schemaVersion === 1 && value?.kind === "renderer-main-file-drop", "schema-kind");
  require(value?.inputSource === "rust-injected-native-drop", "input-source");
  require(value?.contextObservation === "accepted-updateLaunchContext-call", "context-observation");
  require(UUID.test(runId) && value?.runId === runId, "run-id-mismatch");
  require(Number.isSafeInteger(pid) && pid > 0 && value?.pid === pid, "pid-mismatch");
  require(typeof root === "string" && value?.root === root, "root-mismatch");
  require(value?.passed === true, "native-probe-failed");
  require(Array.isArray(value?.errors) && value.errors.length === 0, "native-errors");
  require(Array.isArray(value?.stagesCompleted) && value.stagesCompleted.length === STAGES.length
    && STAGES.every((stage, index) => value.stagesCompleted[index] === stage), "stages-incomplete-or-out-of-order");
  const observed = value?.observed;
  require(exactKeys(observed, OBSERVED_KEYS), "observed-shape");
  require(observed?.targetRegistered === true && observed?.nativeDropAccepted === true, "target-not-accepted");
  require(observed?.metadataFiles === 2 && observed?.mainChipCount === 1 && observed?.mainFileCount === 2,
    "metadata-or-dom-counts");
  require(Array.isArray(observed?.chipNames) && observed.chipNames.length === 1
    && observed.chipNames[0] === "file.txt", "chip-names");
  require(observed?.launchContextQuery === "", "launch-query-not-cleared");
  const files = observed?.launchContextFiles;
  require(Array.isArray(files) && files.length === EXPECTED_FILES.length
    && EXPECTED_FILES.every((expected, index) => exactKeys(files[index], ["relativePath", "name", "isDirectory"])
      && files[index].relativePath === expected.relativePath && files[index].name === expected.name
      && files[index].isDirectory === expected.isDirectory), "launch-context-files");
  require(inputSnapshot(observed?.inputBefore) && inputSnapshot(observed?.inputAfterRestore), "query-restoration");
  require(observed?.targetRevoked === true, "target-not-revoked");
  require(observed?.actualWorkers === 0 && observed?.pendingBatches === 0, "worker-or-batch-not-drained");
  require(value?.guiAcceptance === "unverified" && value?.osDropAcceptance === "unverified",
    "acceptance-overclaim");
  return { valid: errors.length === 0, passed: errors.length === 0 && value?.passed === true, errors };
}

export function catalogMainFileDropProbeEnvironment(environment, enabled) {
  if (!record(environment) || typeof enabled !== "boolean") throw new Error("Invalid Main drop probe environment");
  const result = { ...environment };
  delete result.ATOOLS_MAIN_DROP_PROBE;
  if (enabled) result.ATOOLS_MAIN_DROP_PROBE = "1";
  return result;
}

export function mainFileDropProbeAllowsCleanup({ enabled, processResult, catalogReport, windowDragReport, probeReport }) {
  if (enabled === false) return true;
  if (enabled !== true) return false;
  return catalogReport?.owner?.valid === true
    && processResult?.spawned === true && processResult?.terminalObserved === true
    && processResult?.exitCode === 0 && processResult?.signal === null && processResult?.timedOut === false
    && catalogReport?.valid === true && catalogReport?.passed === true
    && windowDragReport?.valid === true && windowDragReport?.passed === true
    && probeReport?.valid === true && probeReport?.passed === true;
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) { return error.code === "ENOENT" ? true : null; }
}

/** Inspect only; failed opt-in probe runs retain both owned resources for diagnosis. */
export async function preserveCatalogMainDropResources({ fixtureRoot, bundlePath, processTerminal }) {
  const [rootAbsent, bundleAbsent] = await Promise.all([absent(fixtureRoot), absent(bundlePath)]);
  const reason = rootAbsent === true && bundleAbsent === true ? null
    : rootAbsent === null || bundleAbsent === null ? "main-drop-preserve-inspection-failed"
      : "main-drop-probe-not-accepted";
  return {
    fixtureRoot: { processTerminal, rootAbsent, status: rootAbsent === true ? "already_absent" : "preserved",
      reason, ownership: "not_attempted" },
    fixtureRootAbsent: rootAbsent,
    appBundle: { processTerminal, bundleAbsent, status: bundleAbsent === true ? "already_absent" : "preserved", reason },
    appBundleAbsent: bundleAbsent,
    allOwnedResourcesClean: false,
  };
}

export async function finalizeCatalogMainDropResources({ enabled, fixtureRoot, bundlePath, staged, processResult,
  catalogReport, windowDragReport, probeReport }) {
  const processTerminal = processResult ? (!processResult.spawned || processResult.terminalObserved) : true;
  if (!mainFileDropProbeAllowsCleanup({
    enabled, processResult, catalogReport, windowDragReport, probeReport,
  })) {
    return preserveCatalogMainDropResources({ fixtureRoot, bundlePath, processTerminal });
  }
  const fixtureRootCleanup = await cleanupOwnedFixtureRoot({
    root: fixtureRoot,
    childPid: processResult?.pid ?? null,
    processTerminal,
  });
  let appBundle;
  if (staged) {
    appBundle = await cleanupOwnedRendererApp({
      bundlePath: staged.bundlePath,
      runDirectory: staged.runDirectory,
      ownerIdentity: staged.ownerIdentity,
      processTerminal,
    });
  } else {
    const bundleAbsent = await absent(bundlePath);
    appBundle = {
      processTerminal,
      bundleAbsent,
      status: bundleAbsent === true ? "not_created_or_stage_cleaned" : "preserved",
      reason: bundleAbsent === true ? null : bundleAbsent === false ? "bundle_ownership_unavailable" : "bundle_inspection_failed",
    };
  }
  const fixtureRootAbsent = fixtureRootCleanup.rootAbsent;
  const appBundleAbsent = appBundle.bundleAbsent;
  return {
    processTerminal,
    fixtureRoot: fixtureRootCleanup,
    fixtureRootAbsent,
    appBundle,
    appBundleAbsent,
    allOwnedResourcesClean: processTerminal === true && fixtureRootAbsent === true && appBundleAbsent === true,
  };
}

async function validateFixedInputTypes(root) {
  const errors = [];
  const inputRoot = inputRootFor(root);
  try {
    const info = await lstat(inputRoot, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(inputRoot) !== inputRoot) {
      return ["fixed-input-root-type"];
    }
  } catch (error) { return [error.code === "ENOENT" ? "fixed-input-root-missing" : "fixed-input-root-unreadable"]; }
  for (const [relativePath, kind] of [["file.txt", "file"], ["folder", "directory"]]) {
    const path = join(inputRoot, relativePath);
    try {
      const info = await lstat(path, { bigint: true });
      const matches = kind === "file" ? info.isFile() : info.isDirectory();
      if (info.isSymbolicLink() || !matches || await realpath(path) !== path) errors.push(`fixed-input-${kind}-type`);
    } catch (error) { errors.push(`fixed-input-${kind}-${error.code === "ENOENT" ? "missing" : "unreadable"}`); }
  }
  return errors;
}

function captureFailure(exists, code, copied = false) {
  return { exists, valid: false, passed: false, errors: [code], copyPath: copied ? MAIN_FILE_DROP_REPORT_NAME : null,
    sizeBytes: null };
}

/** Read only the fixed report after trusted terminal/owner checks; copy bounded raw evidence before parsing. */
export async function captureMainFileDropNativeReport({ fixtureRoot, runDirectory, runId, pid,
  processTerminal, ownerValidated }) {
  if (processTerminal !== true) return captureFailure(null, "native-process-not-terminal");
  if (ownerValidated !== true) return captureFailure(null, "catalog-owner-not-validated");
  if (!UUID.test(runId) || !Number.isSafeInteger(pid) || pid <= 0
      || fixtureRoot !== `/private/tmp/atools-renderer-catalog-${runId}`) return captureFailure(null, "expected-owner-identity-invalid");
  try {
    const rootInfo = await lstat(fixtureRoot, { bigint: true });
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory() || await realpath(fixtureRoot) !== fixtureRoot) {
      return captureFailure(null, "owned-root-not-real");
    }
    const outputInfo = await lstat(runDirectory, { bigint: true });
    if (outputInfo.isSymbolicLink() || !outputInfo.isDirectory() || Number(outputInfo.mode & 0o077n) !== 0
        || await realpath(runDirectory) !== runDirectory) return captureFailure(null, "run-directory-not-private");
  } catch (error) { return captureFailure(null, error.code === "ENOENT" ? "owned-root-missing" : "owned-path-unreadable"); }
  const sourcePath = join(fixtureRoot, MAIN_FILE_DROP_REPORT_NAME);
  let handle;
  let bytes;
  try {
    if (!Number.isInteger(constants.O_NOFOLLOW) || constants.O_NOFOLLOW === 0) return captureFailure(null, "nofollow-unavailable");
    handle = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) return captureFailure(true, "report-not-regular-file");
    if (info.size > BigInt(MAIN_FILE_DROP_REPORT_LIMIT_BYTES)) return captureFailure(true, "report-over-64kib");
    const buffer = Buffer.alloc(MAIN_FILE_DROP_REPORT_LIMIT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(buffer, bytesRead, buffer.byteLength - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const afterRead = await handle.stat({ bigint: true });
    if (bytesRead > MAIN_FILE_DROP_REPORT_LIMIT_BYTES) return captureFailure(true, "report-over-64kib");
    if (BigInt(bytesRead) !== info.size || afterRead.size !== info.size) {
      return captureFailure(true, "report-changed-during-read");
    }
    bytes = buffer.subarray(0, bytesRead);
  } catch (error) {
    return captureFailure(error.code === "ENOENT" ? false : null,
      error.code === "ELOOP" ? "report-symlink-rejected" : error.code === "ENOENT" ? "report-missing" : "report-read-failed");
  } finally { await handle?.close().catch(() => {}); }
  try { await writeFile(join(runDirectory, MAIN_FILE_DROP_REPORT_NAME), bytes, { flag: "wx", mode: 0o600 }); }
  catch { return captureFailure(true, "report-evidence-copy-failed"); }
  let report;
  try { report = JSON.parse(bytes.toString("utf8")); }
  catch { return captureFailure(true, "report-json-invalid", true); }
  const validation = validateMainFileDropNativeReport(report, { runId, pid, root: fixtureRoot });
  const inputErrors = await validateFixedInputTypes(fixtureRoot);
  const errors = [...validation.errors, ...inputErrors];
  return { exists: true, valid: errors.length === 0, passed: errors.length === 0 && validation.passed,
    errors, copyPath: MAIN_FILE_DROP_REPORT_NAME, sizeBytes: bytes.byteLength };
}
