import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const PRIVATE_TMP = "/private/tmp";
const PRIVATE_MODE = 0o700n;
export class PublishedFixtureNodePathError extends Error {
  constructor(stage, code) {
    super(safeMessage(code));
    this.name = "PublishedFixtureNodePathError";
    this.stage = stage;
    this.code = code;
    this.stack = `${this.name}: ${this.message}`;
  }
}

function safeMessage(code) {
  const messages = {
    SHARED_NODE_PATH_MISSING: "Shared pinned Node path component is missing",
    SHARED_NODE_PATH_DENIED: "Shared pinned Node path access is denied",
    SHARED_NODE_PATH_UNSAFE: "Shared pinned Node path contains a symlink or unexpected file type",
    SHARED_NODE_PATH_IO: "Shared pinned Node path inspection failed",
    SHARED_NODE_PATH_UNSUPPORTED: "Shared pinned Node path is supported only for macOS fixture runs",
    SHARED_NODE_PATH_NONCANONICAL: "Shared pinned Node path is not canonical under private temporary storage",
    SHARED_NODE_ROOT_PERMISSIONS: "Shared pinned Node root must be current-user-owned mode 0700",
    SHARED_NODE_BINARY_PERMISSIONS: "Shared pinned Node binary must be owner-executable and not group/world writable",
    SHARED_NODE_PATH_CHANGED: "Shared pinned Node path changed while hashing",
    SHARED_NODE_NOFOLLOW_UNAVAILABLE: "Pinned Node runtime no-follow open is unavailable",
    SHARED_NODE_BINARY_SHAPE: "Pinned Node runtime binary size or file type mismatch",
    SHARED_NODE_BINARY_CHANGED: "Pinned Node runtime binary changed while hashing",
    SHARED_NODE_BINARY_SIZE: "Pinned Node runtime binary exceeds its exact size pin",
    SHARED_NODE_BINARY_HASH_MISMATCH: "Pinned Node runtime checksum mismatch",
  };
  return Object.hasOwn(messages, code) ? messages[code] : "Shared pinned Node verification failed";
}

export async function withSharedNodePathFilesystemErrors(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    if (!error || typeof error !== "object" || typeof error.code !== "string"
      || typeof error.syscall !== "string" || !Number.isInteger(error.errno)) throw error;
    const code = error.code === "ENOENT" ? "SHARED_NODE_PATH_MISSING"
      : error.code === "EACCES" || error.code === "EPERM" ? "SHARED_NODE_PATH_DENIED"
        : error.code === "ELOOP" || error.code === "ENOTDIR" || error.code === "EISDIR"
          ? "SHARED_NODE_PATH_UNSAFE" : "SHARED_NODE_PATH_IO";
    throw new PublishedFixtureNodePathError(stage, code);
  }
}

export function serializePublishedFixtureNodePathError(error) {
  if (!(error instanceof PublishedFixtureNodePathError)) return null;
  return { name: error.name, code: error.code, stage: error.stage, message: error.message };
}

function invalidSharedPath(stage, code) {
  return new PublishedFixtureNodePathError(stage, code);
}

export function requestedPublishedNodeBinaryPath(options, profile, execution) {
  if (options === undefined) options = {};
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Object.getPrototypeOf(options) !== Object.prototype) {
    throw new Error("Published fixture Node runtime options are invalid");
  }
  const keys = Reflect.ownKeys(options);
  if (keys.some(key => key !== "nodeRuntimeBinaryPath")) {
    throw new Error("Unknown published fixture Node runtime option");
  }
  if (keys.length === 0) return null;
  const descriptor = Object.getOwnPropertyDescriptor(options, "nodeRuntimeBinaryPath");
  if (!descriptor || !Object.hasOwn(descriptor, "value")) {
    throw new Error("Shared pinned Node binary path must be a data property");
  }
  const path = descriptor.value;
  if (typeof path !== "string" || path.length === 0 || path.length > 4096) {
    throw new Error("Shared pinned Node binary path is invalid");
  }
  if (process.platform !== "darwin" || profile?.caseId !== "converted-deepread-source"
    || profile?.sourceKind !== "converted_handoff_directory" || profile?.runtime !== "web"
    || execution?.executeReviewedPackage !== true || execution?.buildOnly !== false
    || execution?.workerContractOnly !== false || execution?.nativeUiInput !== false
    || execution?.nativeLaunchMode !== "direct") {
    throw new Error("Shared pinned Node path is restricted to direct converted DeepRead fixture execution");
  }
  return path;
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
    && left.uid === right.uid && left.size === right.size && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

export async function inspectSharedPinnedNodePath(filename, target) {
  if (process.platform !== "darwin") throw invalidSharedPath("path-policy", "SHARED_NODE_PATH_UNSUPPORTED");
  if (typeof filename !== "string" || !filename.startsWith(PRIVATE_TMP + "/")
    || resolve(filename) !== filename || basename(filename) !== `node-${target}`) {
    throw invalidSharedPath("path-policy", "SHARED_NODE_PATH_NONCANONICAL");
  }
  const privateRoot = dirname(filename);
  const canonicalTmp = await withSharedNodePathFilesystemErrors("path-root-realpath", () => realpath(PRIVATE_TMP));
  if (dirname(privateRoot) !== PRIVATE_TMP || canonicalTmp !== PRIVATE_TMP) {
    throw invalidSharedPath("path-policy", "SHARED_NODE_PATH_NONCANONICAL");
  }

  const components = ["/", "/private", PRIVATE_TMP, privateRoot, filename];
  const identities = [];
  for (let index = 0; index < components.length; index++) {
    const component = components[index];
    const info = await withSharedNodePathFilesystemErrors("path-component-lstat", () => lstat(component, { bigint: true }));
    if (info.isSymbolicLink() || (index < components.length - 1 ? !info.isDirectory() : !info.isFile())) {
      throw invalidSharedPath("path-validation", "SHARED_NODE_PATH_UNSAFE");
    }
    if (index === components.length - 2) {
      if (info.uid !== BigInt(process.getuid()) || (info.mode & 0o777n) !== PRIVATE_MODE) {
        throw invalidSharedPath("path-validation", "SHARED_NODE_ROOT_PERMISSIONS");
      }
    }
    if (index === components.length - 1) {
      if (info.uid !== BigInt(process.getuid()) || (info.mode & 0o100n) === 0n
        || (info.mode & 0o022n) !== 0n) {
        throw invalidSharedPath("path-validation", "SHARED_NODE_BINARY_PERMISSIONS");
      }
    }
    identities.push(info);
  }
  const canonicalBinary = await withSharedNodePathFilesystemErrors("path-leaf-realpath", () => realpath(filename));
  if (canonicalBinary !== filename) throw invalidSharedPath("path-validation", "SHARED_NODE_PATH_NONCANONICAL");
  return identities;
}

export async function assertSharedPinnedNodePathUnchanged(filename, target, before) {
  const after = await inspectSharedPinnedNodePath(filename, target);
  if (before.length !== after.length || before.some((identity, index) => !sameIdentity(identity, after[index]))) {
    throw invalidSharedPath("path-recheck", "SHARED_NODE_PATH_CHANGED");
  }
}
