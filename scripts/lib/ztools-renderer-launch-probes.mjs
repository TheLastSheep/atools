import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const LAUNCHER_PROBE_IDS = Object.freeze(["first", "second"]);
export const LAUNCHER_PROBE_BUNDLE_NAMES = Object.freeze([
  "AToolsOwnedProbeFirst.app",
  "AToolsOwnedProbeSecond.app",
]);
export const LAUNCHER_PROBE_EXECUTABLE = "AToolsOwnedLaunchProbe";
export const LAUNCHER_PROBE_CONFIG = "probe-config.txt";
export const LAUNCHER_PROBE_STARTED = "probe-started.json";
export const LAUNCHER_PROBE_EXITING = "probe-exiting.json";
export const MAX_LAUNCHER_PROBE_BYTES = 32 * 1024 * 1024;
const MAX_PLIST_BYTES = 4 * 1024;
const MAX_CONFIG_BYTES = 128;
const MAX_MARKER_BYTES = 4096;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const RUN_ID = /^[0-9a-f]{32}$/;
const FINGERPRINT_KEYS = ["path", "sha256", "sizeBytes", "mtimeNs", "device", "inode"];
const MARKER_KEYS = ["schemaVersion", "runId", "probeId", "pid"];

function error(code) {
  return { code };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) && Object.keys(value).length === keys.length
    && keys.every(key => Object.hasOwn(value, key));
}

function privateMode(info, mode) {
  return Number(info.mode & 0o777n) === mode;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeFingerprint(value) {
  return isRecord(value) && hasExactKeys(value, FINGERPRINT_KEYS)
    && typeof value.path === "string" && isAbsolute(value.path)
    && /^[0-9a-f]{64}$/.test(value.sha256)
    && /^\d+$/.test(value.sizeBytes) && BigInt(value.sizeBytes) <= BigInt(MAX_LAUNCHER_PROBE_BYTES)
    && /^\d+$/.test(value.mtimeNs) && /^\d+$/.test(value.device) && /^\d+$/.test(value.inode);
}

export function launcherProbeFingerprintMatchesReceipt(receiptSnapshot, fingerprint) {
  const receipt = receiptSnapshot?.value?.launcherProbe;
  return receiptSnapshot?.exists === true && safeFingerprint(fingerprint) && safeFingerprint(receipt)
    && FINGERPRINT_KEYS.every(key => receipt[key] === fingerprint[key]);
}

export function sameLauncherProbeFingerprint(left, right) {
  return safeFingerprint(left) && safeFingerprint(right)
    && FINGERPRINT_KEYS.every(key => left[key] === right[key]);
}

function plistFor(probeId, runId, backgroundOnly = false) {
  const bundleName = probeId === "first" ? "AToolsOwnedProbeFirst" : "AToolsOwnedProbeSecond";
  const identifier = `dev.atools.launch-probe.${runId}.${probeId}`;
  const backgroundOnlyEntry = backgroundOnly ? "<key>LSBackgroundOnly</key><true/>\n" : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>${LAUNCHER_PROBE_EXECUTABLE}</string>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleName</key><string>${bundleName}</string>
<key>CFBundleDisplayName</key><string>${bundleName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
${backgroundOnlyEntry}<key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0.0</string>
</dict></plist>
`;
}

async function readRegularFile(path, maxBytes, expectedMode) {
  const handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)
        || !privateMode(before, expectedMode)) throw new Error("invalid-probe-file");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const entry = await lstat(path, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || !sameIdentity(before, after)
        || !sameIdentity(before, entry) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || BigInt(bytes.byteLength) !== after.size) throw new Error("probe-file-changed");
    return { bytes, info: after };
  } finally {
    await handle.close();
  }
}

async function readExecutableFile(path, expectedMode) {
  const handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(MAX_LAUNCHER_PROBE_BYTES)
        || (before.mode & 0o111n) === 0n || (before.mode & 0o022n) !== 0n
        || (expectedMode !== undefined && !privateMode(before, expectedMode))) throw new Error("invalid-probe-executable");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const entry = await lstat(path, { bigint: true });
    if (!entry.isFile() || entry.isSymbolicLink() || !sameIdentity(before, after)
        || !sameIdentity(before, entry) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
        || BigInt(bytes.byteLength) !== after.size) throw new Error("probe-executable-changed");
    return { bytes, info: after };
  } finally {
    await handle.close();
  }
}

async function readDirectory(path) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || !privateMode(info, 0o700)) {
    throw new Error("invalid-probe-directory");
  }
  const entries = await readdir(path, { withFileTypes: true });
  if (entries.some(entry => entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))) {
    throw new Error("invalid-probe-entry");
  }
  return entries.map(entry => entry.name).sort();
}

function exactNames(actual, expected) {
  return actual.length === expected.length && expected.every((name, index) => actual[index] === name);
}

async function verifyProbeBundle({ root, probeId, runId, executableSha256, backgroundOnly,
  allowMarkers, hostPid, pidIsActive }) {
  const appName = probeId === "first" ? LAUNCHER_PROBE_BUNDLE_NAMES[0] : LAUNCHER_PROBE_BUNDLE_NAMES[1];
  const bundle = join(root, appName);
  const contents = join(bundle, "Contents");
  const macos = join(contents, "MacOS");
  const resources = join(contents, "Resources");
  const executable = join(macos, LAUNCHER_PROBE_EXECUTABLE);
  const configPath = join(resources, LAUNCHER_PROBE_CONFIG);
  const startedPath = join(resources, LAUNCHER_PROBE_STARTED);
  const exitingPath = join(resources, LAUNCHER_PROBE_EXITING);
  const errors = [];
  try {
    if (!exactNames(await readDirectory(bundle), ["Contents"])) errors.push("bundle-file-set");
    const contentsNames = await readDirectory(contents);
    if (!exactNames(contentsNames, ["Info.plist", "MacOS", "Resources"])) errors.push("contents-file-set");
    if (!exactNames(await readDirectory(macos), [LAUNCHER_PROBE_EXECUTABLE])) errors.push("executable-file-set");

    const resourcesNames = await readDirectory(resources);
    const baseNames = [LAUNCHER_PROBE_CONFIG];
    const markerNames = [LAUNCHER_PROBE_STARTED, LAUNCHER_PROBE_EXITING];
    const expectedResources = allowMarkers
      ? [...baseNames, ...markerNames.filter(name => resourcesNames.includes(name))].sort()
      : baseNames;
    if (!exactNames(resourcesNames, expectedResources)) errors.push("resources-file-set");

    const infoPath = join(contents, "Info.plist");
    const info = await readRegularFile(infoPath, MAX_PLIST_BYTES, 0o600);
    if (info.bytes.toString("utf8") !== plistFor(probeId, runId, backgroundOnly)) errors.push("probe-plist-mismatch");
    const config = await readRegularFile(configPath, MAX_CONFIG_BYTES, 0o600);
    if (config.bytes.toString("utf8") !== `${runId}\n${probeId}\n`) errors.push("probe-config-mismatch");
    const executableFile = await readExecutableFile(executable, 0o700);
    const executableSha = createHash("sha256").update(executableFile.bytes).digest("hex");
    if (executableSha !== executableSha256) errors.push("probe-executable-hash-mismatch");

    const markers = [];
    for (const [name, markerPath] of [[LAUNCHER_PROBE_STARTED, startedPath], [LAUNCHER_PROBE_EXITING, exitingPath]]) {
      if (!resourcesNames.includes(name)) continue;
      if (!allowMarkers) {
        errors.push("unexpected-probe-marker");
        continue;
      }
      const markerFile = await readRegularFile(markerPath, MAX_MARKER_BYTES, 0o600);
      let marker;
      try { marker = JSON.parse(markerFile.bytes.toString("utf8")); }
      catch { errors.push("probe-marker-invalid-json"); continue; }
      if (!hasExactKeys(marker, MARKER_KEYS) || marker.schemaVersion !== 1 || marker.runId !== runId
          || marker.probeId !== probeId || !Number.isSafeInteger(marker.pid) || marker.pid <= 0
          || marker.pid === hostPid) {
        errors.push("probe-marker-mismatch");
        continue;
      }
      markers.push({ name, pid: marker.pid });
    }
    if ((markers.length !== 0 && markers.length !== 2)
        || (markers.length === 2 && (markers[0].pid !== markers[1].pid
          || markers[0].name !== LAUNCHER_PROBE_STARTED || markers[1].name !== LAUNCHER_PROBE_EXITING))) {
      errors.push("probe-marker-pair-mismatch");
    }
    let processTerminal = null;
    let liveProbeProcesses = null;
    if (markers.length === 2 && !errors.some(item => item === "probe-marker-mismatch" || item === "probe-marker-pair-mismatch")) {
      const active = pidIsActive(markers[0].pid);
      processTerminal = active === false;
      liveProbeProcesses = active === true ? 1 : active === false ? 0 : null;
      if (active === true) errors.push("probe-still-running");
      if (active === null) errors.push("probe-process-state-unknown");
    }
    return {
      valid: errors.length === 0,
      errors,
      probeId,
      started: markers.some(marker => marker.name === LAUNCHER_PROBE_STARTED),
      exited: markers.some(marker => marker.name === LAUNCHER_PROBE_EXITING),
      pid: markers.length === 2 ? markers[0].pid : null,
      processTerminal,
      liveProbeProcesses,
    };
  } catch {
    return {
      valid: false,
      errors: [...errors, "probe-bundle-inspection-failed"],
      probeId,
      started: false,
      exited: false,
      pid: null,
      processTerminal: null,
      liveProbeProcesses: null,
    };
  }
}

function defaultPidIsActive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    return null;
  }
}

export async function stageRendererLaunchProbes({ hostBundlePath, binaryFingerprint, runId, backgroundOnly = false }) {
  if (!isAbsolute(hostBundlePath) || !safeFingerprint(binaryFingerprint) || !RUN_ID.test(runId)
      || typeof backgroundOnly !== "boolean") {
    throw new Error("Invalid launcher probe staging inputs");
  }
  const canonicalBundle = await realpath(hostBundlePath);
  const bundleInfo = await lstat(canonicalBundle, { bigint: true });
  if (!bundleInfo.isDirectory() || bundleInfo.isSymbolicLink() || !privateMode(bundleInfo, 0o700)) {
    throw new Error("Host application bundle must be a private real directory");
  }
  const resources = join(canonicalBundle, "Contents", "Resources");
  const resourcesInfo = await lstat(resources, { bigint: true });
  if (!resourcesInfo.isDirectory() || resourcesInfo.isSymbolicLink() || !privateMode(resourcesInfo, 0o700)) {
    throw new Error("Host application resources must be a private real directory");
  }
  const binaryPath = await realpath(binaryFingerprint.path);
  if (binaryPath !== binaryFingerprint.path) throw new Error("Launcher probe binary path must be canonical");
  const source = await readExecutableFile(binaryPath);
  const sourceSha256 = createHash("sha256").update(source.bytes).digest("hex");
  if (sourceSha256 !== binaryFingerprint.sha256 || String(source.info.size) !== binaryFingerprint.sizeBytes
      || String(source.info.mtimeNs) !== binaryFingerprint.mtimeNs || String(source.info.dev) !== binaryFingerprint.device
      || String(source.info.ino) !== binaryFingerprint.inode) {
    throw new Error("Launcher probe binary differs from its build receipt fingerprint");
  }

  const launcherRoot = join(resources, "launcher-apps");
  await mkdir(launcherRoot, { mode: 0o700 });
  const rootInfo = await lstat(launcherRoot, { bigint: true });
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !privateMode(rootInfo, 0o700)) {
    throw new Error("Launcher probe staging root must be private");
  }
  const normalizedRunId = runId.toLowerCase();
  for (const probeId of LAUNCHER_PROBE_IDS) {
    const appName = probeId === "first" ? LAUNCHER_PROBE_BUNDLE_NAMES[0] : LAUNCHER_PROBE_BUNDLE_NAMES[1];
    const bundle = join(launcherRoot, appName);
    const contents = join(bundle, "Contents");
    const macos = join(contents, "MacOS");
    const probeResources = join(contents, "Resources");
    await mkdir(bundle, { mode: 0o700 });
    await mkdir(contents, { mode: 0o700 });
    await mkdir(macos, { mode: 0o700 });
    await mkdir(probeResources, { mode: 0o700 });
    await writeFile(join(contents, "Info.plist"), plistFor(probeId, normalizedRunId, backgroundOnly), { flag: "wx", mode: 0o600 });
    const executable = join(macos, LAUNCHER_PROBE_EXECUTABLE);
    await copyFile(binaryPath, executable, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    await chmod(executable, 0o700);
    await writeFile(join(probeResources, LAUNCHER_PROBE_CONFIG), `${normalizedRunId}\n${probeId}\n`, { flag: "wx", mode: 0o600 });
  }
  const verified = await inspectRendererLaunchProbes({
    root: launcherRoot,
    runId: normalizedRunId,
    executableSha256: binaryFingerprint.sha256,
    backgroundOnly,
  });
  if (!verified.valid || verified.bundleCount !== 2) throw new Error("Staged launcher probe bundle verification failed");
  return {
    bundleCount: verified.bundleCount,
    probeIds: [...LAUNCHER_PROBE_IDS],
    executableSha256: binaryFingerprint.sha256,
    executableSizeBytes: binaryFingerprint.sizeBytes,
    backgroundOnly,
  };
}

export async function inspectRendererLaunchProbes({
  root,
  runId,
  executableSha256,
  backgroundOnly = false,
  allowMarkers = false,
  expectedProbeId = null,
  expectedProbeIds = null,
  hostPid = null,
  pidIsActive = defaultPidIsActive,
}) {
  const errors = [];
  const fail = code => { errors.push(code); };
  const multiProbeMode = expectedProbeIds !== null;
  const validExpectedProbeIds = Array.isArray(expectedProbeIds)
    && expectedProbeIds.length > 0 && expectedProbeIds.length <= LAUNCHER_PROBE_IDS.length
    && expectedProbeIds.every(probeId => LAUNCHER_PROBE_IDS.includes(probeId))
    && new Set(expectedProbeIds).size === expectedProbeIds.length;
  if (!isAbsolute(root) || !RUN_ID.test(runId) || !/^[0-9a-f]{64}$/.test(executableSha256)
      || typeof backgroundOnly !== "boolean"
      || (multiProbeMode && (!allowMarkers || !validExpectedProbeIds))) {
    return { valid: false, errors: ["invalid-inspection-input"], bundleCount: 0,
      selectedProbe: null, processStarts: 0, processExits: 0, probesTerminal: false, liveProbeProcesses: null };
  }
  let names;
  try { names = await readDirectory(root); }
  catch { return { valid: false, errors: ["launcher-apps-root-invalid"], bundleCount: 0,
    selectedProbe: null, processStarts: 0, processExits: 0, probesTerminal: false, liveProbeProcesses: null }; }
  if (!exactNames(names, [...LAUNCHER_PROBE_BUNDLE_NAMES].sort())) fail("launcher-apps-file-set");

  const verified = [];
  for (const probeId of LAUNCHER_PROBE_IDS) {
    const result = await verifyProbeBundle({
      root,
      probeId,
      runId: runId.toLowerCase(),
      executableSha256,
      backgroundOnly,
      allowMarkers,
      hostPid,
      pidIsActive,
    });
    verified.push(result);
    errors.push(...result.errors);
  }
  const started = verified.filter(result => result.started);
  const exited = verified.filter(result => result.exited);
  const selectedProbe = started.length === 1 && exited.length === 1
    && started[0].probeId === exited[0].probeId ? started[0].probeId : null;
  const selectedProbes = verified.filter(result => result.started && result.exited).map(result => result.probeId);
  if (allowMarkers) {
    if (multiProbeMode) {
      if (started.length !== expectedProbeIds.length || exited.length !== expectedProbeIds.length
          || selectedProbes.length !== expectedProbeIds.length
          || expectedProbeIds.some(probeId => !selectedProbes.includes(probeId))) {
        fail("launcher-probe-count-mismatch");
      }
    } else {
      if (started.length !== 1 || exited.length !== 1 || selectedProbe === null) fail("launcher-probe-count-mismatch");
      if (!LAUNCHER_PROBE_IDS.includes(expectedProbeId) || selectedProbe !== expectedProbeId) {
        fail("launcher-probe-selection-mismatch");
      }
    }
  } else if (started.length !== 0 || exited.length !== 0) {
    fail("unexpected-launcher-probe-marker");
  }
  const liveValues = verified.filter(result => result.started).map(result => result.liveProbeProcesses);
  const liveProbeProcesses = liveValues.length === 0 || liveValues.some(value => value === null)
    ? null : liveValues.reduce((total, value) => total + value, 0);
  const expectedCount = multiProbeMode ? expectedProbeIds.length : 1;
  const probesTerminal = allowMarkers && started.length === expectedCount && exited.length === expectedCount
    && (multiProbeMode ? selectedProbes.length === expectedCount
      && expectedProbeIds.every(probeId => selectedProbes.includes(probeId)) : selectedProbe !== null)
    && liveProbeProcesses === 0 && verified.every(result => result.processTerminal !== false);
  const result = {
    valid: errors.length === 0,
    errors: [...new Set(errors)],
    bundleCount: names.length,
    selectedProbe,
    processStarts: started.length,
    processExits: exited.length,
    probesTerminal,
    liveProbeProcesses,
  };
  if (multiProbeMode) {
    result.selectedProbes = selectedProbes;
    result.probeReceipts = verified.map(probe => ({
      probeId: probe.probeId,
      started: probe.started,
      exited: probe.exited,
      pid: probe.pid,
      processTerminal: probe.processTerminal,
      liveProbeProcesses: probe.liveProbeProcesses,
    }));
  }
  return result;
}
