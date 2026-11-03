import { constants as fsConstants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, realpath, readdir, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createGunzip, createGzip } from "node:zlib";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { MAX_ARCHIVE_BYTES } from "./node-runtime-archive.mjs";
import { MAX_NODE_BYTES, prepareNodeRuntime } from "./node-runtime-package.mjs";
import { removeOwnedSnapshot, runDefaultCodesign, signAndVerify, snapshotApprovedEntitlements, validateTeam, verifyCompressedNodeSignature } from "./node-runtime-signature.mjs";

export const MAX_LICENSE_BYTES = 5 * 1024 * 1024;
export const MAX_COMPRESSED_BYTES = 80 * 1024 * 1024;
const STREAM_BYTES = 64 * 1024;
const execFileAsync = promisify(execFile);
const METADATA_NAME = "compressed-runtime.json";
const ownedPayloads = new WeakMap();

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function fixedTarget(target) {
  if (target !== "aarch64-apple-darwin" && target !== "x86_64-apple-darwin") throw new Error("Unsupported compressed Node target");
  return target;
}
function validatePinBinding(pin, pinSha256, target) {
  if (!pin || typeof pin !== "object" || !/^[a-f\d]{64}$/.test(pinSha256 || "") || sha256(`${JSON.stringify(pin, null, 2)}\n`) !== pinSha256) throw new Error("Runtime pin bytes do not match their recorded SHA-256");
  const selected = pin.targets?.[target];
  if (!selected || !/^v22\.\d+\.\d+$/.test(pin.version) || selected.archive !== `node-${pin.version}-darwin-${target === "aarch64-apple-darwin" ? "arm64" : "x64"}.tar.gz` || !/^[a-f\d]{64}$/.test(selected.sha256 || "") || !/^[a-f\d]{64}$/.test(selected.binarySha256 || "") || !/^[a-f\d]{64}$/.test(selected.licenseSha256 || "") || !Number.isSafeInteger(selected.binaryBytes) || selected.binaryBytes < 1024 * 1024 || selected.binaryBytes > MAX_NODE_BYTES || typeof pin.minimumMacOS !== "string") throw new Error("Runtime pin does not contain a supported official target");
  return selected;
}

async function assertNoSymlinkPath(path) {
  if (!isAbsolute(path)) throw new Error("Filesystem paths must be absolute");
  const absolute = resolve(path);
  const parts = absolute.split(sep).filter(Boolean);
  let cursor = sep;
  for (const part of parts) {
    cursor = join(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error("Symlink filesystem paths are not accepted");
  }
  return absolute;
}

async function identityOf(path) {
  const info = await lstat(path, { bigint: true });
  return { dev: info.dev, ino: info.ino, mode: info.mode, isDirectory: info.isDirectory() };
}
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.isDirectory === right.isDirectory;
}

async function checkedRegularDigest(path, limit) {
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(path, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error("Runtime payload is not a bounded regular file");
    const hash = createHash("sha256");
    let bytes = 0;
    const stream = handle.createReadStream({ autoClose: false, highWaterMark: STREAM_BYTES });
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > limit) throw new Error("Runtime payload exceeded its byte budget");
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes) !== after.size) {
      throw new Error("Runtime payload changed while being read");
    }
    return { sha256: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}

export async function readRegularBounded(path, limit) {
  const handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new Error("Runtime metadata is not a bounded regular file");
    const chunks = [];
    let total = 0;
    while (total < Number(before.size)) {
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_BYTES, Number(before.size) - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > limit) throw new Error("Runtime metadata exceeded its byte budget");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(total) !== after.size) throw new Error("Runtime metadata changed while being read");
    return Buffer.concat(chunks, total);
  } finally { await handle.close(); }
}

async function copyVerifiedArchive(source, destination, expectedSha256) {
  const sourcePath = await assertNoSymlinkPath(source);
  const sourceHandle = await open(sourcePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let outputHandle;
  try {
    outputHandle = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    const before = await sourceHandle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_ARCHIVE_BYTES)) throw new Error("Pinned Node archive is not a bounded regular file");
    const hash = createHash("sha256");
    const size = Number(before.size);
    let bytes = 0;
    while (bytes < size) {
      const buffer = Buffer.allocUnsafe(Math.min(STREAM_BYTES, size - bytes));
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, bytes);
      if (bytesRead === 0) throw new Error("Pinned Node archive ended before its descriptor size");
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await outputHandle.write(buffer, written, bytesRead - written, bytes + written);
        if (result.bytesWritten === 0) throw new Error("Pinned Node archive copy made no write progress");
        written += result.bytesWritten;
      }
      bytes += bytesRead;
    }
    const after = await sourceHandle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(bytes) !== after.size) {
      throw new Error("Pinned Node archive changed while being copied");
    }
    const digest = hash.digest("hex");
    if (digest !== expectedSha256) throw new Error("Pinned Node archive SHA-256 mismatch");
    await outputHandle.sync();
    const copied = await outputHandle.stat({ bigint: true });
    if (!copied.isFile() || copied.size !== BigInt(bytes)) throw new Error("Pinned Node archive copy size does not match its descriptor bytes");
    return { sha256: digest, bytes };
  } finally {
    try { await sourceHandle.close(); }
    finally { if (outputHandle) await outputHandle.close(); }
  }
}

function expectedMetadata(pin, pinSha256, target, expectedTeamId, entitlementsSha256, signed, compressed) {
  const selected = pin.targets[target];
  return {
    schemaVersion: 2,
    version: pin.version,
    target,
    minimumMacOS: pin.minimumMacOS,
    pinSha256,
    archive: selected.archive,
    archiveUrl: `https://nodejs.org/dist/${pin.version}/${selected.archive}`,
    archiveSha256: selected.sha256,
    upstreamBinarySha256: selected.binarySha256,
    upstreamBinaryBytes: selected.binaryBytes,
    licenseSha256: selected.licenseSha256,
    publisherTeamId: expectedTeamId,
    entitlementsSha256,
    signedBinarySha256: signed.sha256,
    signedBinaryBytes: signed.bytes,
    compressed: { format: "gzip", level: 6, file: `node-${target}.gz`, sha256: compressed.sha256, bytes: compressed.bytes },
  };
}

async function boundedStream(source, destination, { limit, sourceLimit = limit, decompressor, compressor }) {
  const digest = createHash("sha256");
  let bytes = 0;
  const input = await open(source, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  let output;
  let pendingRead = Promise.resolve();
  let pendingWrite = Promise.resolve();
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(sourceLimit)) throw new Error("Runtime stream source is not a bounded regular file");
    output = await open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    const sourceSize = Number(before.size);
    let sourceBytes = 0;
    let outputBytes = 0;
    async function* readChunks() {
      while (sourceBytes < sourceSize) {
        const buffer = Buffer.allocUnsafe(Math.min(STREAM_BYTES, sourceSize - sourceBytes));
        pendingRead = input.read(buffer, 0, buffer.length, sourceBytes);
        const { bytesRead } = await pendingRead;
        pendingRead = Promise.resolve();
        if (bytesRead === 0) throw new Error("Runtime stream source ended before its descriptor size");
        sourceBytes += bytesRead;
        yield buffer.subarray(0, bytesRead);
      }
    }
    const writer = new Writable({
      highWaterMark: STREAM_BYTES,
      write(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > limit) return callback(new Error("Compressed runtime payload exceeded its byte budget"));
        digest.update(chunk);
        let written = 0;
        const writeChunk = async () => {
          while (written < chunk.length) {
            const result = await output.write(chunk, written, chunk.length - written, outputBytes + written);
            if (result.bytesWritten === 0) throw new Error("Runtime stream output made no write progress");
            written += result.bytesWritten;
          }
          outputBytes += chunk.length;
        };
        pendingWrite = writeChunk();
        pendingWrite.then(() => callback(), callback);
      },
    });
    const streams = [Readable.from(readChunks(), { objectMode: false, highWaterMark: STREAM_BYTES })];
    if (decompressor) streams.push(decompressor);
    if (compressor) streams.push(compressor);
    streams.push(writer);
    await pipeline(...streams);
    const after = await input.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(sourceBytes) !== after.size) throw new Error("Runtime stream source changed while being processed");
    await output.sync();
    const outputStat = await output.stat({ bigint: true });
    if (!outputStat.isFile() || outputStat.size !== BigInt(outputBytes) || outputBytes !== bytes) throw new Error("Runtime stream output size does not match written bytes");
    return { sha256: digest.digest("hex"), bytes };
  } finally {
    await Promise.allSettled([pendingRead, pendingWrite]);
    try { await input.close(); }
    finally { if (output) await output.close(); }
  }
}

async function ownOutputParent(outputParent) {
  const checked = await assertNoSymlinkPath(outputParent);
  const info = await lstat(checked);
  if (!info.isDirectory()) throw new Error("Output parent must be an existing directory");
  if (typeof process.getuid !== "function" || info.uid !== process.getuid() || (info.mode & 0o022) !== 0) throw new Error("Output parent must be owned by the current user and not group/world writable");
  const canonical = await realpath(checked);
  if (canonical !== checked) throw new Error("Output parent must be canonical");
  const outputDirectory = await mkdtemp(join(canonical, ".atools-node-payload-"));
  try { return { outputDirectory, identity: await identityOf(outputDirectory) }; }
  catch (error) { await rm(outputDirectory, { recursive: true, force: false }); throw error; }
}

async function removeOwnedDirectory(outputDirectory, expectedIdentity) {
  try {
    const current = await identityOf(outputDirectory);
    if (sameIdentity(current, expectedIdentity)) { await rm(outputDirectory, { recursive: true, force: false }); return true; }
    return false;
  } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

export async function prepareCompressedNodePayload({ pin, pinSha256, target, archive, outputParent, identity, expectedTeamId, runCodesign = runDefaultCodesign }) {
  target = fixedTarget(target);
  validateTeam(expectedTeamId);
  const selected = validatePinBinding(pin, pinSha256, target);
  const owned = await ownOutputParent(outputParent);
  const work = join(owned.outputDirectory, ".work");
  const archiveCopy = join(work, selected.archive);
  const extracted = join(work, "extracted");
  let workIdentity;
  try {
    await mkdir(work, { mode: 0o700 });
    workIdentity = await identityOf(work);
    await mkdir(extracted, { mode: 0o700 });
    const archiveInfo = await copyVerifiedArchive(archive, archiveCopy, selected.sha256);
    const prepared = await prepareNodeRuntime({ pin, target, destination: extracted, cacheDir: work, archive: archiveCopy, offline: true });
    const binaryInfo = await lstat(prepared.executable);
    if (!binaryInfo.isFile() || binaryInfo.isSymbolicLink()) throw new Error("Extracted Node copy is not a regular file");
    const entitlements = await snapshotApprovedEntitlements(work);
    try {
      await signAndVerify(prepared.executable, identity, expectedTeamId, runCodesign, entitlements);
    } finally {
      if (!(await removeOwnedSnapshot(entitlements.path, entitlements.identity))) {
        throw new Error("Owned Node entitlements snapshot could not be safely removed");
      }
    }
    const signedInfo = await checkedRegularDigest(prepared.executable, MAX_NODE_BYTES);
    const licenseInfo = await checkedRegularDigest(join(extracted, "node-runtime-metadata", "NODE-LICENSE"), MAX_LICENSE_BYTES);
    if (licenseInfo.sha256 !== selected.licenseSha256) throw new Error("Node license no longer matches the checked-in pin");
    const compressedPath = join(owned.outputDirectory, `node-${target}.gz`);
    const compressed = await boundedStream(prepared.executable, compressedPath, { limit: MAX_COMPRESSED_BYTES, sourceLimit: MAX_NODE_BYTES, compressor: createGzip({ level: 6, mtime: 0 }) });
    const roundtripPath = join(work, "roundtrip.node");
    const roundtrip = await boundedStream(compressedPath, roundtripPath, { limit: MAX_NODE_BYTES, decompressor: createGunzip() });
    if (roundtrip.sha256 !== signedInfo.sha256 || roundtrip.bytes !== signedInfo.bytes) throw new Error("Compressed Node payload failed its signed-byte round trip");
    const payload = expectedMetadata(pin, pinSha256, target, expectedTeamId, entitlements.sha256, signedInfo, compressed);
    const metadataPath = join(owned.outputDirectory, METADATA_NAME);
    const metadataHandle = await open(metadataPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
    try { await metadataHandle.writeFile(`${JSON.stringify(payload, null, 2)}\n`); await metadataHandle.sync(); }
    finally { await metadataHandle.close(); }
    await copyFile(join(extracted, "node-runtime-metadata", "NODE-LICENSE"), join(owned.outputDirectory, "NODE-LICENSE"), fsConstants.COPYFILE_EXCL);
    await removeOwnedDirectory(work, workIdentity);
    const finalNames = (await readdir(owned.outputDirectory)).sort();
    if (JSON.stringify(finalNames) !== JSON.stringify(["NODE-LICENSE", METADATA_NAME, `node-${target}.gz`].sort())) throw new Error("Compressed payload output contains unexpected entries");
    const metadataBytes = await readRegularBounded(metadataPath, 16 * 1024);
    const result = { outputDirectory: owned.outputDirectory, metadata: payload, archive: { sha256: archiveInfo.sha256, bytes: archiveInfo.bytes }, metadataSha256: sha256(metadataBytes) };
    ownedPayloads.set(result, owned.identity);
    return result;
  } catch (error) {
    await removeOwnedDirectory(owned.outputDirectory, owned.identity);
    throw error;
  }
}

export async function cleanupPreparedCompressedNodePayload(prepared) {
  const identity = prepared && ownedPayloads.get(prepared);
  if (!identity) return false;
  ownedPayloads.delete(prepared);
  return removeOwnedDirectory(prepared.outputDirectory, identity);
}

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}

async function executeNodeProbe(binary) {
  const source = "process.stdout.write(JSON.stringify({version:process.version,arch:process.arch,platform:process.platform,sha256:require('node:crypto').createHash('sha256').update('abc').digest('hex')}))";
  const { stdout } = await execFileAsync(binary, ["-e", source], {
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
    timeout: 5000,
    maxBuffer: 4096,
  });
  return JSON.parse(stdout);
}

export async function verifyCompressedNodePayload({
  pin,
  pinSha256,
  target,
  packageDirectory,
  expectedTeamId,
  runCodesign = runDefaultCodesign,
  execute = false,
  runNodeProbe = executeNodeProbe,
}) {
  target = fixedTarget(target);
  validateTeam(expectedTeamId);
  const directory = await assertNoSymlinkPath(packageDirectory);
  if (!(await lstat(directory)).isDirectory()) throw new Error("Compressed payload package must be a directory");
  const metadataPath = join(directory, METADATA_NAME);
  const metadataBytes = await readRegularBounded(metadataPath, 16 * 1024);
  const metadata = JSON.parse(metadataBytes.toString("utf8"));
  if (`${JSON.stringify(metadata, null, 2)}\n` !== metadataBytes.toString("utf8")) throw new Error("Compressed payload metadata is not in the canonical producer format");
  const compressedName = `node-${target}.gz`;
  const keys = ["schemaVersion", "version", "target", "minimumMacOS", "pinSha256", "archive", "archiveUrl", "archiveSha256", "upstreamBinarySha256", "upstreamBinaryBytes", "licenseSha256", "publisherTeamId", "entitlementsSha256", "signedBinarySha256", "signedBinaryBytes", "compressed"];
  if (!exactObject(metadata, keys) || !exactObject(metadata.compressed, ["format", "level", "file", "sha256", "bytes"])) throw new Error("Compressed payload metadata has an unexpected shape");
  const selected = validatePinBinding(pin, pinSha256, target);
  if (metadata.schemaVersion !== 2 || metadata.version !== pin.version || metadata.target !== target || metadata.minimumMacOS !== pin.minimumMacOS || metadata.pinSha256 !== pinSha256 || metadata.publisherTeamId !== expectedTeamId) throw new Error("Compressed payload metadata does not match the pinned target and publisher");
  if (!selected || metadata.archive !== selected.archive || metadata.archiveUrl !== `https://nodejs.org/dist/${pin.version}/${selected.archive}` || metadata.archiveSha256 !== selected.sha256 || metadata.upstreamBinarySha256 !== selected.binarySha256 || metadata.upstreamBinaryBytes !== selected.binaryBytes || metadata.licenseSha256 !== selected.licenseSha256) throw new Error("Compressed payload provenance does not match the checked-in Node pin");
  if (metadata.compressed.format !== "gzip" || metadata.compressed.level !== 6 || metadata.compressed.file !== compressedName || !/^[a-f\d]{64}$/.test(metadata.compressed.sha256) || !/^[a-f\d]{64}$/.test(metadata.signedBinarySha256) || !/^[a-f\d]{64}$/.test(metadata.entitlementsSha256) || !Number.isSafeInteger(metadata.compressed.bytes) || metadata.compressed.bytes < 1 || metadata.compressed.bytes > MAX_COMPRESSED_BYTES || !Number.isSafeInteger(metadata.signedBinaryBytes) || metadata.signedBinaryBytes < 1024 * 1024 || metadata.signedBinaryBytes > MAX_NODE_BYTES) throw new Error("Compressed payload metadata has invalid sizes or hashes");
  const names = (await readdir(directory)).sort();
  if (JSON.stringify(names) !== JSON.stringify(["NODE-LICENSE", METADATA_NAME, compressedName].sort())) throw new Error("Compressed payload package contains unexpected files");
  const compressedPath = join(directory, compressedName);
  const compressed = await checkedRegularDigest(compressedPath, MAX_COMPRESSED_BYTES);
  if (compressed.bytes !== metadata.compressed.bytes || compressed.sha256 !== metadata.compressed.sha256) throw new Error("Compressed Node payload hash mismatch");
  const license = await checkedRegularDigest(join(directory, "NODE-LICENSE"), MAX_LICENSE_BYTES);
  if (license.sha256 !== selected.licenseSha256) throw new Error("Compressed payload license hash mismatch");
  const work = await mkdtemp(join(dirname(directory), `.verify-${randomUUID()}-`));
  let workIdentity;
  try { workIdentity = await identityOf(work); }
  catch (error) { await rm(work, { recursive: true, force: false }); throw error; }
  const binary = join(work, "node");
  try {
    const decompressed = await boundedStream(compressedPath, binary, { limit: MAX_NODE_BYTES, sourceLimit: MAX_COMPRESSED_BYTES, decompressor: createGunzip() });
    if (decompressed.sha256 !== metadata.signedBinarySha256 || decompressed.bytes !== metadata.signedBinaryBytes) throw new Error("Decompressed signed Node bytes do not match metadata");
    await verifyCompressedNodeSignature(binary, expectedTeamId, metadata.entitlementsSha256, runCodesign);
    let runtime = null;
    if (execute) {
      if (process.platform !== "darwin") throw new Error("Compressed Node execution verification requires macOS");
      await chmod(binary, 0o700);
      runtime = await runNodeProbe(binary, target, pin.version);
      const expectedArch = target === "aarch64-apple-darwin" ? "arm64" : "x64";
      if (runtime?.version !== pin.version || runtime?.platform !== "darwin" || runtime?.arch !== expectedArch
        || runtime?.sha256 !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
        throw new Error("Decompressed signed Node failed its target runtime probe");
      }
    }
    return {
      passed: true,
      target,
      compressedBytes: compressed.bytes,
      signedBinaryBytes: decompressed.bytes,
      signedBinarySha256: decompressed.sha256,
      metadataSha256: sha256(metadataBytes),
      runtimeExecutionVerified: execute,
      runtime,
    };
  } finally { await removeOwnedDirectory(work, workIdentity); }
}
