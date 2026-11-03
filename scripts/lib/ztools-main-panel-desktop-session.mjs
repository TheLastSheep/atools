import { execFile as execFileCallback } from "node:child_process";
import { chmod, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { promisify } from "node:util";
import { join } from "node:path";

const execFile = promisify(execFileCallback);
const SWIFT_PATH = "/usr/bin/swift";
const TEMP_ROOT = "/private/tmp";
const TEMP_PREFIX = "atools-desktop-session-";
const MAX_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 4_096;
const RAW_KEYS = Object.freeze([
  "sessionAvailable",
  "onConsole",
  "loginDone",
  "screenLocked",
]);
const OBSERVATION_KEYS = Object.freeze([...RAW_KEYS, "observedAt"]);

const SWIFT_QUERY = String.raw`
import CoreGraphics
import Foundation

let rawSession = CGSessionCopyCurrentDictionary()
let session = rawSession as? [String: Any]
func optionalBool(_ key: String) -> Any {
  guard let value = session?[key] as? Bool else { return NSNull() }
  return value
}
let result: [String: Any] = [
  "sessionAvailable": rawSession != nil,
  "onConsole": optionalBool("kCGSSessionOnConsoleKey"),
  "loginDone": optionalBool("kCGSessionLoginDoneKey"),
  "screenLocked": optionalBool("CGSSessionScreenIsLocked")
]
let bytes = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(bytes)
FileHandle.standardOutput.write(Data([0x0a]))
`;

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function exactKeys(value, expected) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function boolOrNull(value) {
  return typeof value === "boolean" || value === null;
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function parseSwiftOutput(stdout) {
  if (typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT_BYTES) {
    throw fixedError("desktop-session-output-invalid");
  }
  let value;
  try {
    value = JSON.parse(stdout.trim());
  } catch {
    throw fixedError("desktop-session-output-invalid");
  }
  if (!exactKeys(value, RAW_KEYS) || !RAW_KEYS.every((key) => boolOrNull(value[key]))) {
    throw fixedError("desktop-session-output-invalid");
  }
  return { ...value, observedAt: new Date().toISOString() };
}

async function createPrivateModuleCache() {
  let cachePath;
  let identity;
  try {
    const rootInfo = await lstat(TEMP_ROOT);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(TEMP_ROOT) !== TEMP_ROOT) {
      throw fixedError("desktop-session-temp-unavailable");
    }
    cachePath = await mkdtemp(join(TEMP_ROOT, TEMP_PREFIX));
    const created = await lstat(cachePath);
    if (!created.isDirectory() || created.isSymbolicLink()) {
      throw fixedError("desktop-session-temp-unavailable");
    }
    identity = { dev: created.dev, ino: created.ino };
    await chmod(cachePath, 0o700);
    const secured = await lstat(cachePath);
    if (!secured.isDirectory() || secured.isSymbolicLink()
      || secured.dev !== identity.dev || secured.ino !== identity.ino
      || (secured.mode & 0o077) !== 0 || await realpath(cachePath) !== cachePath) {
      throw fixedError("desktop-session-temp-unavailable");
    }
    return { path: cachePath, ...identity };
  } catch {
    if (cachePath && identity) await removePrivateModuleCache({ path: cachePath, ...identity }).catch(() => {});
    throw fixedError("desktop-session-temp-unavailable");
  }
}

async function removePrivateModuleCache(cache) {
  let current;
  try {
    current = await lstat(cache.path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw fixedError("desktop-session-temp-cleanup-failed");
  }
  if (!current.isDirectory() || current.isSymbolicLink()
    || current.dev !== cache.dev || current.ino !== cache.ino
    || await realpath(cache.path).catch(() => null) !== cache.path) {
    throw fixedError("desktop-session-temp-cleanup-failed");
  }
  try {
    await rm(cache.path, { recursive: true, force: false });
  } catch {
    throw fixedError("desktop-session-temp-cleanup-failed");
  }
}

function queryFailure(error) {
  if (error?.code === "ETIMEDOUT" || error?.killed === true) {
    return fixedError("desktop-session-query-timeout");
  }
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return fixedError("desktop-session-output-invalid");
  }
  return fixedError("desktop-session-query-failed");
}

/** Reads only the current GUI-session booleans. The executor seam never changes the fixed command. */
export async function readDesktopSession({ execFileImpl = execFile } = {}) {
  if (process.platform !== "darwin") throw fixedError("desktop-session-unsupported-platform");
  if (typeof execFileImpl !== "function") throw fixedError("desktop-session-executor-invalid");

  const cache = await createPrivateModuleCache();
  let observation;
  let primaryError;
  try {
    let result;
    try {
      result = await execFileImpl(
        SWIFT_PATH,
        ["-module-cache-path", cache.path, "-e", SWIFT_QUERY],
        { encoding: "utf8", timeout: MAX_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
      );
    } catch (error) {
      throw queryFailure(error);
    }
    observation = parseSwiftOutput(result?.stdout);
  } catch (error) {
    primaryError = error;
  }

  try {
    await removePrivateModuleCache(cache);
  } catch (error) {
    if (primaryError) throw fixedError("desktop-session-temp-cleanup-failed");
    throw error;
  }
  if (primaryError) throw primaryError;
  return observation;
}

/** Fails closed unless the current session is logged in, on-console, and explicitly unlocked. */
export function assertInteractiveDesktopSession(observation) {
  if (!exactKeys(observation, OBSERVATION_KEYS)
    || !RAW_KEYS.every((key) => boolOrNull(observation[key]))
    || !validTimestamp(observation.observedAt)) {
    throw fixedError("desktop-session-observation-invalid");
  }
  if (observation.sessionAvailable !== true) {
    throw fixedError(observation.sessionAvailable === false
      ? "desktop-session-unavailable"
      : "desktop-session-availability-unknown");
  }
  if (observation.onConsole !== true) {
    throw fixedError(observation.onConsole === false
      ? "desktop-session-not-on-console"
      : "desktop-session-console-state-unknown");
  }
  if (observation.loginDone !== true) {
    throw fixedError(observation.loginDone === false
      ? "desktop-session-login-incomplete"
      : "desktop-session-login-state-unknown");
  }
  if (observation.screenLocked !== false) {
    throw fixedError(observation.screenLocked === true
      ? "desktop-session-locked"
      : "desktop-session-lock-state-unknown");
  }
  return observation;
}
