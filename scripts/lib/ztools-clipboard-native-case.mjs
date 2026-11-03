import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import {
  OWNER_MARKER_NAME,
  buildNativeCaseArgs,
  cleanupOwnedRendererApp,
  nativeChildEnvironment,
  readJsonNoFollow,
  runNativeChild,
  stageRendererNativeApp,
} from "./ztools-renderer-native-runtime.mjs";
import { readJsonFile } from "./ztools-renderer-launch-runtime.mjs";
import {
  CLIPBOARD_JOURNEY,
  CLIPBOARD_REPORT_FILENAME,
  CLIPBOARD_SCOPE,
  validateClipboardContextReport,
} from "./ztools-clipboard-native-report.mjs";

export { CLIPBOARD_JOURNEY, CLIPBOARD_REPORT_FILENAME, CLIPBOARD_SCOPE };

export const CLIPBOARD_RUN_PARENT = "/Users/harris/Desktop/atools/output/renderer-clipboard-native-2026-10-29";

const RUN_ID_RE = /^[0-9a-f]{32}$/;
const OWNER_KEYS = ["schemaVersion", "pid", "identifier", "root"];
const MAX_REPORT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024;

function identity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function errorSummary(error) {
  return {
    name: String(error?.name || "Error").slice(0, 80),
    code: error?.code ? String(error.code).slice(0, 80) : null,
  };
}

function optionalError(error) {
  return { error: errorSummary(error) };
}

async function optionalLstat(path) {
  try { return await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export function expectedClipboardOwner(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId)) throw new Error("runId must be 32 lowercase hexadecimal characters");
  return Object.freeze({
    runId,
    identifier: `dev.atools.renderer-clipboard.${runId}`,
    root: `/private/tmp/atools-renderer-clipboard-${runId}`,
  });
}

export function parseClipboardNativeArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if ((flag !== "--binary" && flag !== "--build-receipt") || values.has(flag) || index + 1 >= argv.length) {
      throw new Error("Only required --binary and --build-receipt absolute paths are accepted");
    }
    const value = argv[++index];
    if (!value || value.startsWith("--") || !isAbsolute(value)) throw new Error(`${flag} must be an absolute path`);
    values.set(flag, value);
  }
  const binary = values.get("--binary");
  const buildReceipt = values.get("--build-receipt");
  if (!binary || !buildReceipt) throw new Error("Both --binary and --build-receipt are required");
  return { binary, buildReceipt };
}

export async function createClipboardRunDirectory(root, runId) {
  if (!isAbsolute(root) || !RUN_ID_RE.test(runId)) throw new Error("Invalid run output identity");
  const outputRoot = join(root, "output");
  const outputInfo = await lstat(outputRoot, { bigint: true });
  if (!outputInfo.isDirectory() || outputInfo.isSymbolicLink()) throw new Error("Workspace output must be a real directory");
  const parentInfo = await lstat(CLIPBOARD_RUN_PARENT, { bigint: true }).catch(async error => {
    if (error.code !== "ENOENT") throw error;
    await mkdir(CLIPBOARD_RUN_PARENT, { mode: 0o700 });
    return lstat(CLIPBOARD_RUN_PARENT, { bigint: true });
  });
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()
      || await realpath(CLIPBOARD_RUN_PARENT) !== CLIPBOARD_RUN_PARENT) {
    throw new Error("Clipboard run parent must be a real canonical directory");
  }
  const runDirectory = join(CLIPBOARD_RUN_PARENT, `run-${runId}`);
  await mkdir(runDirectory, { mode: 0o700 });
  const runInfo = await lstat(runDirectory, { bigint: true });
  if (!runInfo.isDirectory() || runInfo.isSymbolicLink() || Number(runInfo.mode & 0o777n) !== 0o700
      || await realpath(runDirectory) !== runDirectory) {
    throw new Error("Clipboard run directory must be a new private directory");
  }
  return runDirectory;
}

export function buildClipboardNativeArgs({ fixtureRoot, rendererDist, output, runId }) {
  const args = buildNativeCaseArgs({
    fixtureRoot, rendererDist, output, autoClear: "never", runId, mode: "single",
  });
  args.push("--journey", CLIPBOARD_JOURNEY);
  return args;
}

export async function launchStagedClipboardApp({ stagedClipboard, sourceBinary, args, options, runChild = runNativeChild }) {
  const executablePath = stagedClipboard?.executable;
  const expectedExecutable = typeof stagedClipboard?.bundlePath === "string"
    ? join(stagedClipboard.bundlePath, "Contents/MacOS/AToolsRendererSmoke") : null;
  if (typeof executablePath !== "string" || !isAbsolute(executablePath)
      || executablePath !== expectedExecutable || executablePath === sourceBinary) {
    throw new Error("Clipboard child must launch the staged bundle executable");
  }
  return { executablePath, processResult: await runChild(executablePath, args, options) };
}

export function clipboardProcessSucceeded(processResult) {
  return processResult?.spawned === true
    && processResult.terminalObserved === true
    && processResult.exitCode === 0
    && processResult.signal === null
    && processResult.timedOut === false
    && processResult.termination?.attempted === false
    && Array.isArray(processResult.termination.signals)
    && processResult.termination.signals.length === 0
    && processResult.exception === null;
}

async function replaceBundleIdentifier(staged, expectedIdentifier) {
  const infoPath = join(staged.bundlePath, "Contents/Info.plist");
  const before = await lstat(infoPath, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n
      || before.size > 64n * 1024n || Number(before.mode & 0o777n) !== 0o600) {
    throw new Error("Staged Info.plist must be a bounded private regular file");
  }
  const oldIdentifier = `dev.atools.renderer-smoke.${staged.runId}`;
  const readHandle = await open(infoPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let source;
  try { source = (await readHandle.readFile()).toString("utf8"); }
  finally { await readHandle.close(); }
  const oldXml = `<key>CFBundleIdentifier</key><string>${oldIdentifier}</string>`;
  const newXml = `<key>CFBundleIdentifier</key><string>${expectedIdentifier}</string>`;
  if (source.split(oldXml).length !== 2 || source.includes(expectedIdentifier)) {
    throw new Error("Fresh staged app identifier did not match the expected smoke bundle");
  }
  const replacement = Buffer.from(source.replace(oldXml, newXml), "utf8");
  const handle = await open(infoPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n || identity(before) !== identity(opened)) {
      throw new Error("Staged Info.plist changed before bundle identity update");
    }
    await handle.truncate(0);
    await handle.writeFile(replacement);
    await handle.sync();
    const after = await handle.stat({ bigint: true });
    if (identity(before) !== identity(after) || Number(after.mode & 0o777n) !== 0o600) {
      throw new Error("Staged Info.plist identity changed during bundle update");
    }
  } finally {
    await handle.close();
  }
  const verified = await open(infoPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = (await verified.readFile()).toString("utf8");
    const finalStat = await verified.stat({ bigint: true });
    if (identity(before) !== identity(finalStat) || actual.split(newXml).length !== 2 || actual.includes(oldXml)) {
      throw new Error("Staged Info.plist clipboard identifier verification failed");
    }
    return { ...staged, identifier: expectedIdentifier, infoPlistIdentifier: expectedIdentifier };
  } finally {
    await verified.close();
  }
}

async function inspectOwnedClipboardRoot({ owner, childPid }) {
  if (typeof owner?.runId !== "string" || !RUN_ID_RE.test(owner.runId)
      || owner.identifier !== `dev.atools.renderer-clipboard.${owner.runId}`
      || !Number.isSafeInteger(childPid) || childPid <= 0 || owner.root !== `/private/tmp/atools-renderer-clipboard-${owner.runId}`
      || dirname(owner.root) !== "/private/tmp" || normalize(owner.root) !== owner.root
      || await realpath("/private/tmp") !== "/private/tmp" || await realpath(owner.root) !== owner.root) {
    return { valid: false, reason: "owner-input-invalid" };
  }
  const rootInfo = await optionalLstat(owner.root);
  if (!rootInfo || rootInfo.isSymbolicLink() || !rootInfo.isDirectory()
      || Number(rootInfo.mode & 0o777n) !== 0o700) return { valid: false, reason: "root-not-private-directory" };
  const markerPath = join(owner.root, OWNER_MARKER_NAME);
  const markerInfo = await optionalLstat(markerPath);
  if (!markerInfo || markerInfo.isSymbolicLink() || !markerInfo.isFile() || markerInfo.nlink !== 1n
      || markerInfo.size > 4096n || Number(markerInfo.mode & 0o777n) !== 0o600) {
    return { valid: false, reason: "owner-marker-invalid" };
  }
  const marker = await readJsonNoFollow(markerPath, 4096);
  const rootAfter = await optionalLstat(owner.root);
  const markerAfter = await optionalLstat(markerPath);
  if (!exactKeys(marker, OWNER_KEYS) || marker.schemaVersion !== 1 || marker.pid !== childPid
      || marker.identifier !== owner.identifier || marker.root !== owner.root
      || !rootAfter || rootAfter.isSymbolicLink() || identity(rootInfo) !== identity(rootAfter)
      || !markerAfter || markerAfter.isSymbolicLink() || identity(markerInfo) !== identity(markerAfter)) {
    return { valid: false, reason: "owner-marker-mismatch" };
  }
  for (const name of ["app-data", "webview"]) {
    const childPath = join(owner.root, name);
    const childInfo = await optionalLstat(childPath);
    if (!childInfo || childInfo.isSymbolicLink() || !childInfo.isDirectory()
        || Number(childInfo.mode & 0o777n) !== 0o700 || await realpath(childPath) !== childPath) {
      return { valid: false, reason: "profile-child-directory-invalid" };
    }
  }
  return { valid: true, rootInfo, markerInfo, markerPath };
}

export async function cleanupOwnedClipboardRoot({ owner, childPid, processTerminal }) {
  let current;
  try { current = await optionalLstat(owner.root); }
  catch (error) { return { processTerminal, rootAbsent: null, status: "preserved", reason: error.code || "root-inspection-failed" }; }
  if (!current) return { processTerminal, rootAbsent: true, status: "already-absent", reason: null };
  if (processTerminal !== true) return { processTerminal: false, rootAbsent: false, status: "not-attempted", reason: "child-not-terminal" };
  let inspected;
  try { inspected = await inspectOwnedClipboardRoot({ owner, childPid }); }
  catch (error) { inspected = { valid: false, reason: error.code || "owner-inspection-failed" }; }
  if (!inspected.valid) return { processTerminal: true, rootAbsent: false, status: "preserved", reason: inspected.reason };
  try {
    const rootNow = await optionalLstat(owner.root);
    const markerNow = await optionalLstat(inspected.markerPath);
    if (!rootNow || !markerNow || rootNow.isSymbolicLink() || markerNow.isSymbolicLink()
        || identity(rootNow) !== identity(inspected.rootInfo) || identity(markerNow) !== identity(inspected.markerInfo)) {
      return { processTerminal: true, rootAbsent: false, status: "preserved", reason: "ownership-changed-before-removal" };
    }
    await rm(owner.root, { recursive: true, force: false, maxRetries: 0 });
    const absent = (await optionalLstat(owner.root)) === null;
    return { processTerminal: true, rootAbsent: absent, status: absent ? "removed-owned-root" : "preserved",
      reason: absent ? null : "root-still-exists" };
  } catch (error) {
    const absent = await optionalLstat(owner.root).then(value => value === null).catch(() => null);
    return { processTerminal: true, rootAbsent: absent, status: "preserved", reason: error.code || "root-removal-failed" };
  }
}

function boundedText(limit = MAX_OUTPUT_BYTES) {
  const chunks = [];
  let captured = 0;
  let observed = 0;
  return {
    append(value) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      observed += chunk.byteLength;
      const take = Math.min(chunk.byteLength, Math.max(0, limit - captured));
      if (take) { chunks.push(Buffer.from(chunk.subarray(0, take))); captured += take; }
    },
    result() {
      const data = Buffer.concat(chunks, captured);
      return { data, summary: { capturedBytes: captured, observedBytes: observed,
        truncated: observed > captured, sha256: createHash("sha256").update(data).digest("hex") } };
    },
  };
}

async function writePrivateFile(path, bytes) {
  const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  const info = await lstat(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600) {
    throw new Error("Private run artifact is not a single-link 0600 file");
  }
}

function isChildProcessHandle(child) {
  return child !== null && typeof child === "object"
    && typeof child.once === "function" && typeof child.kill === "function";
}

export function createClipboardSpawnImpl({ captures, observation, spawnChild = spawn }) {
  return (binary, args, options) => {
    observation.spawnAttempted = true;
    const child = spawnChild(binary, args, options);
    observation.child = child;
    observation.childHandleObserved = isChildProcessHandle(child);
    observation.pid = Number.isSafeInteger(child?.pid) && child.pid > 0 ? child.pid : null;
    if (observation.childHandleObserved) {
      child.once("close", () => { observation.closeObserved = true; });
    }
    child.stdout?.on("data", chunk => captures.stdout.append(chunk));
    child.stderr?.on("data", chunk => captures.stderr.append(chunk));
    return child;
  };
}

export function clipboardProcessTerminal(observation, processResult) {
  if (observation?.spawnAttempted !== true) return true;
  return observation.childHandleObserved === true && observation.closeObserved === true;
}

function processObservationSummary(observation) {
  return {
    spawnAttempted: observation.spawnAttempted,
    childHandleObserved: observation.childHandleObserved,
    pid: observation.pid,
    closeObserved: observation.closeObserved,
  };
}

export async function runClipboardNativeCase({ root, runDirectory, binaryFingerprint, rendererDist, runId, expectedAssetSummary }) {
  const owner = expectedClipboardOwner(runId);
  const nativeReportPath = join(runDirectory, "native-report.json");
  const clipboardReportPath = join(runDirectory, CLIPBOARD_REPORT_FILENAME);
  const result = {
    owner: { ...owner, pid: null }, appBundle: null, process: null,
    profileOutput: { path: "native-report.json", requiredArtifact: false, absent: null },
    clipboardReport: { exists: false, valid: false, passed: false, errors: [] },
    cleanup: { processTerminal: null, fixtureRootAbsent: null, appBundleAbsent: null,
      fixtureRoot: null, appBundle: null, allOwnedResourcesClean: false },
    processObservation: null,
    stdout: null, stderr: null, exception: null, passed: false,
  };
  let staged = null;
  let processResult = null;
  let ownerValidated = false;
  const captures = { stdout: boundedText(), stderr: boundedText() };
  const spawnObservation = {
    spawnAttempted: false, child: null, childHandleObserved: false, pid: null, closeObserved: false,
  };
  try {
    for (const path of [owner.root, nativeReportPath, clipboardReportPath, join(runDirectory, "case-never.app")]) {
      if (await optionalLstat(path)) throw new Error("Clipboard case artifacts must be fresh");
    }
    staged = await stageRendererNativeApp({
      binary: binaryFingerprint.path, runDirectory, autoClear: "never", runId,
      expectedSha256: binaryFingerprint.sha256, mode: "single",
    });
    const stagedClipboard = await replaceBundleIdentifier(staged, owner.identifier);
    result.appBundle = {
      identifier: stagedClipboard.identifier, infoPlistIdentifier: stagedClipboard.infoPlistIdentifier,
      executable: "Contents/MacOS/AToolsRendererSmoke", sourceSha256: stagedClipboard.sourceSha256,
      executablePath: stagedClipboard.executable, stagedSha256: stagedClipboard.stagedSha256,
      mode: "single", infoPlist: "Contents/Info.plist",
    };
    const args = buildClipboardNativeArgs({ fixtureRoot: owner.root, rendererDist,
      output: nativeReportPath, runId });
    const launch = await launchStagedClipboardApp({
      stagedClipboard, sourceBinary: binaryFingerprint.path, args, options: {
      timeoutMs: 180_000,
      spawnOptions: { cwd: root, env: nativeChildEnvironment(process.env) },
      spawnImpl: createClipboardSpawnImpl({ captures, observation: spawnObservation }),
      },
    });
    processResult = launch.processResult;
    result.process = {
      ...processResult,
      executablePath: launch.executablePath,
      executableMatchesBundle: launch.executablePath === stagedClipboard.executable,
    };
    result.owner.pid = processResult.pid ?? spawnObservation.pid;
    const terminal = clipboardProcessTerminal(spawnObservation, processResult);
    result.cleanup.processTerminal = terminal;
    const [stdout, stderr] = [captures.stdout.result(), captures.stderr.result()];
    await writePrivateFile(join(runDirectory, "stdout.log"), stdout.data);
    await writePrivateFile(join(runDirectory, "stderr.log"), stderr.data);
    result.stdout = stdout.summary;
    result.stderr = stderr.summary;

    const processPid = processResult.pid ?? spawnObservation.pid;
    if (terminal && processPid !== null) {
      const markerFile = await readJsonFile(join(owner.root, OWNER_MARKER_NAME), 4096);
      const genericOutput = await optionalLstat(nativeReportPath);
      const clipboardFile = await readJsonFile(clipboardReportPath, MAX_REPORT_BYTES);
      const profile = await inspectOwnedClipboardRoot({ owner, childPid: processPid }).catch(() => ({ valid: false }));
      ownerValidated = profile.valid === true && markerFile.value?.identifier === owner.identifier
        && markerFile.value?.root === owner.root && markerFile.value?.pid === processPid;
      result.profileOutput.absent = genericOutput === null;
      result.clipboardReport = validateClipboardContextReport(clipboardFile.value,
        { ...owner, pid: processPid }, { exists: clipboardFile.exists, expectedAssetSummary });
      result.cleanup.fixtureRoot = await cleanupOwnedClipboardRoot({
        owner, childPid: processPid, processTerminal: terminal,
      });
      result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
    } else {
      result.cleanup.fixtureRoot = await cleanupOwnedClipboardRoot({
        owner, childPid: processResult.pid ?? spawnObservation.pid, processTerminal: terminal,
      });
      result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
    }
  } catch (error) {
    result.exception = errorSummary(error);
    const terminal = clipboardProcessTerminal(spawnObservation, processResult);
    result.cleanup.processTerminal = terminal;
    result.owner.pid = processResult?.pid ?? spawnObservation.pid;
    if (spawnObservation.spawnAttempted || processResult?.spawned) {
      const [stdout, stderr] = [captures.stdout.result(), captures.stderr.result()];
      result.stdout = stdout.summary;
      result.stderr = stderr.summary;
    }
    result.cleanup.fixtureRoot = await cleanupOwnedClipboardRoot({
      owner, childPid: processResult?.pid ?? spawnObservation.pid, processTerminal: terminal,
    });
    result.cleanup.fixtureRootAbsent = result.cleanup.fixtureRoot.rootAbsent;
  } finally {
    const canRemoveApp = clipboardProcessTerminal(spawnObservation, processResult);
    result.cleanup.processTerminal = canRemoveApp;
    result.processObservation = processObservationSummary(spawnObservation);
    if (staged) {
      result.cleanup.appBundle = await cleanupOwnedRendererApp({
        bundlePath: staged.bundlePath, runDirectory: staged.runDirectory,
        ownerIdentity: staged.ownerIdentity, processTerminal: canRemoveApp,
      });
    } else {
      const absent = await optionalLstat(join(runDirectory, "case-never.app")).then(info => info === null).catch(() => null);
      result.cleanup.appBundle = { processTerminal: canRemoveApp, bundleAbsent: absent,
        status: absent === true ? "not-created-or-stage-cleaned" : "preserved",
        reason: absent === true ? null : "bundle-ownership-unavailable" };
    }
    result.cleanup.appBundleAbsent = result.cleanup.appBundle.bundleAbsent;
    result.cleanup.allOwnedResourcesClean = result.cleanup.processTerminal === true
      && result.cleanup.fixtureRootAbsent === true && result.cleanup.appBundleAbsent === true;
    const processSucceeded = clipboardProcessSucceeded(processResult)
      && result.process?.executableMatchesBundle === true;
    result.passed = processSucceeded && ownerValidated && result.profileOutput.absent === true
      && result.clipboardReport.passed === true && result.cleanup.allOwnedResourcesClean === true
      && result.exception === null;
  }
  return result;
}


