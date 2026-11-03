import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSharedPinnedNodePathUnchanged, inspectSharedPinnedNodePath, PublishedFixtureNodePathError,
  withSharedNodePathFilesystemErrors } from "./published-fixture-node-override.mjs";

const NODE_PRELOAD_CASES = new Set(["converted-deepread-source"]);
const STREAM_BYTES = 64 * 1024;
const MAX_PINNED_NODE_BYTES = 256 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export function profileRequiresPinnedNodeRuntime(profile) {
  return profile?.runtime === "node" || NODE_PRELOAD_CASES.has(profile?.caseId);
}

function targetForArchitecture(architecture) {
  if (architecture === "arm64") return "aarch64-apple-darwin";
  if (architecture === "x64") return "x86_64-apple-darwin";
  throw new Error("Pinned native Node runtime does not support this architecture");
}

function sameFile(left, right) {
  return left.isFile() && right.isFile() && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size && left.mode === right.mode && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

async function hashPinnedBinary(filename, expectedBytes, sharedPath) {
  const filesystem = (stage, operation) => sharedPath
    ? withSharedNodePathFilesystemErrors(stage, operation) : operation();
  const verificationError = (stage, code, message) => sharedPath
    ? new PublishedFixtureNodePathError(stage, code) : new Error(message);
  if (typeof fsConstants.O_NOFOLLOW !== "number") {
    throw verificationError("hash-open", "SHARED_NODE_NOFOLLOW_UNAVAILABLE", "Pinned Node runtime no-follow open is unavailable");
  }
  const beforePath = await filesystem("hash-path-lstat", () => lstat(filename, { bigint: true }));
  if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.size !== BigInt(expectedBytes)) {
    throw verificationError("hash-path-validation", "SHARED_NODE_BINARY_SHAPE", "Pinned Node runtime binary size or file type mismatch");
  }
  const handle = await filesystem("hash-open", () => open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW));
  try {
    const before = await filesystem("hash-fstat", () => handle.stat({ bigint: true }));
    if (!sameFile(beforePath, before)) throw verificationError("hash-precheck", "SHARED_NODE_BINARY_CHANGED", "Pinned Node runtime binary changed before hashing");
    const hash = createHash("sha256");
    const limit = BigInt(expectedBytes);
    const buffer = Buffer.allocUnsafe(STREAM_BYTES);
    let total = 0n;
    while (true) {
      const length = Number(total < limit ? (limit - total + 1n < BigInt(STREAM_BYTES) ? limit - total + 1n : BigInt(STREAM_BYTES)) : 1n);
      const { bytesRead } = await filesystem("hash-read", () => handle.read(buffer, 0, length, null));
      if (!bytesRead) break;
      total += BigInt(bytesRead);
      if (total > limit) throw verificationError("hash-limit", "SHARED_NODE_BINARY_SIZE", "Pinned Node runtime binary exceeds its exact size pin");
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await filesystem("hash-final-fstat", () => handle.stat({ bigint: true }));
    const afterPath = await filesystem("hash-final-lstat", () => lstat(filename, { bigint: true }));
    if (!sameFile(before, after) || !sameFile(before, afterPath) || total !== limit) {
      throw verificationError("hash-toctou", "SHARED_NODE_BINARY_CHANGED", "Pinned Node runtime binary changed while hashing");
    }
    return { bytes: Number(total), sha256: hash.digest("hex") };
  } finally {
    await filesystem("hash-close", () => handle.close());
  }
}

export async function preparePublishedFixtureNodeRuntime(profile, environment, root, options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)
    || Reflect.ownKeys(options).some(key => key !== "architecture" && key !== "nodeRuntimeBinaryPath")) {
    throw new Error("Native fixture Node runtime options are invalid");
  }
  const architectureOption = Object.getOwnPropertyDescriptor(options, "architecture");
  const sharedPathOption = Object.getOwnPropertyDescriptor(options, "nodeRuntimeBinaryPath");
  if ((architectureOption && !Object.hasOwn(architectureOption, "value"))
    || (sharedPathOption && !Object.hasOwn(sharedPathOption, "value"))) {
    throw new Error("Native fixture Node runtime options must be data properties");
  }
  const architecture = architectureOption?.value ?? process.arch;
  const hasSharedPath = Object.hasOwn(options, "nodeRuntimeBinaryPath");
  const sharedPath = sharedPathOption?.value;
  if (hasSharedPath && (typeof sharedPath !== "string" || profile?.caseId !== "converted-deepread-source"
    || profile?.sourceKind !== "converted_handoff_directory" || profile?.runtime !== "web")) {
    throw new Error("Shared pinned Node path is restricted to converted DeepRead");
  }
  if (!profileRequiresPinnedNodeRuntime(profile)) return { required: false, configured: false };
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new Error("Native fixture environment is invalid");
  }
  const pin = JSON.parse(await readFile(join(root, "resources/node-runtime/pin.json"), "utf8"));
  const target = targetForArchitecture(architecture);
  const selected = pin?.targets?.[target];
  if (typeof pin?.version !== "string" || !/^v22\.\d+\.\d+$/u.test(pin.version)
    || !Number.isSafeInteger(selected?.binaryBytes) || selected.binaryBytes < 1 || selected.binaryBytes > MAX_PINNED_NODE_BYTES
    || typeof selected?.binarySha256 !== "string" || !SHA256.test(selected.binarySha256)) {
    throw new Error("Pinned Node runtime metadata is invalid");
  }
  const binary = hasSharedPath ? sharedPath : join(root, "src-tauri/binaries/node-" + target);
  const sharedPathIdentity = hasSharedPath ? await inspectSharedPinnedNodePath(binary, target) : null;
  const fingerprint = await hashPinnedBinary(binary, selected.binaryBytes, hasSharedPath);
  if (fingerprint.sha256 !== selected.binarySha256) {
    if (hasSharedPath) throw new PublishedFixtureNodePathError("hash-verify", "SHARED_NODE_BINARY_HASH_MISMATCH");
    throw new Error("Pinned Node runtime checksum mismatch");
  }
  if (sharedPathIdentity) await assertSharedPinnedNodePathUnchanged(binary, target, sharedPathIdentity);
  environment.ATOOLS_NODE_BINARY = binary;
  return { required: true, configured: true, version: pin.version, binarySha256: fingerprint.sha256,
    ...(hasSharedPath ? { sharedPrivateBinaryPath: true } : {}) };
}
