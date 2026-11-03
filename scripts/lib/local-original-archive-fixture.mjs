import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdtemp, open, readFile, readdir, realpath, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { brotliDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializeInspectedFiles } from "./published-plugin-fixture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const REGISTRY = new URL("../../tests/fixtures/local-original-archive-cases.json", import.meta.url);
const MAX_ARCHIVE = 50 * 1024 * 1024;
const MAX_ASAR = 32 * 1024 * 1024;
const MAX_FILE = 8 * 1024 * 1024;
const MAX_FILES = 32;
const MAX_DIRS = 32;
const MAX_DEPTH = 8;
const STATUS = "prepared_for_parent_native_fixture_decision";
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const cmp = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

function safeRelative(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 1024 || value.startsWith("/")
    || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) throw Error("Unsafe ASAR path");
  const parts = value.split("/");
  if (parts.length > MAX_DEPTH || parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw Error("Unsafe ASAR path component");
  }
  return value;
}

async function registered(caseId) {
  const registry = JSON.parse(await readFile(REGISTRY, "utf8"));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.cases)) throw Error("Invalid original archive registry");
  const profile = registry.cases.find(item => item.caseId === caseId);
  const witness = registry.witnesses?.[caseId];
  if (!profile || profile.sourceKind !== "local_original_archive" || profile.archiveExtension !== "zpx"
    || !/^[a-f0-9]{64}$/.test(profile.archiveSha256) || !Number.isSafeInteger(profile.archiveBytes)
    || profile.archiveBytes < 1 || profile.archiveBytes > MAX_ARCHIVE || profile.fileCount > MAX_FILES
    || profile.sourceReviewStatus !== STATUS || profile.verifyDataPersistence !== false
    || !witness || witness.archiveSha256 !== profile.archiveSha256 || witness.archiveBytes !== profile.archiveBytes
    || !Array.isArray(witness.files) || witness.files.length !== profile.fileCount || !Array.isArray(witness.directories)) {
    throw Error("Unknown or invalid local original archive profile: " + caseId);
  }
  return { profile: Object.freeze(profile), witness, sourceReview: registry.sourceReview?.[caseId] };
}

async function sourceFile(sourcePath) {
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath.startsWith("/") || sourcePath.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(sourcePath)
    || sourcePath.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw Error("Original archive path must be a safe repository-relative path");
  }
  const repo = await realpath(REPO_ROOT);
  const target = path.resolve(repo, ...sourcePath.split("/"));
  const relative = path.relative(repo, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error("Original archive escapes repository");
  let current = repo;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw Error("Original archive source path contains symlink");
  }
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > MAX_ARCHIVE) throw Error("Original archive source must be a bounded regular file");
  return { target: await realpath(target), stat };
}

async function readSourceNoFollow(filename, expectedStat) {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  if (typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
  const handle = await open(filename, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== expectedStat.dev || opened.ino !== expectedStat.ino || opened.size !== expectedStat.size) {
      throw Error("Original archive changed while opening");
    }
    const chunks = [];
    let size = 0;
    while (size <= MAX_ARCHIVE) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_ARCHIVE + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
    if (size > MAX_ARCHIVE || size !== expectedStat.size) throw Error("Original archive exceeded bounded read");
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Error("Original archive changed while reading");
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

function inspectAsar(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 16 || bytes.length > MAX_ASAR) throw Error("Invalid or oversized decompressed ASAR");
  const marker = bytes.readUInt32LE(0), headerSize = bytes.readUInt32LE(4), payloadSize = bytes.readUInt32LE(8), jsonSize = bytes.readUInt32LE(12);
  const jsonEnd = 16 + jsonSize, contentOffset = headerSize + 8;
  if (marker !== 4 || headerSize < 8 || payloadSize + 4 !== headerSize || jsonEnd > bytes.length
    || jsonEnd > contentOffset || contentOffset > bytes.length) throw Error("Inconsistent ASAR header");
  let header;
  try { header = JSON.parse(bytes.toString("utf8", 16, jsonEnd)); } catch { throw Error("Invalid ASAR header JSON"); }
  const files = new Map(), directories = new Set(), ranges = [];
  let entries = 0, expanded = 0;
  function walk(node, prefix = "", depth = 0) {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > MAX_DEPTH) throw Error("Invalid ASAR node or depth budget");
    const children = node.files;
    if (children === undefined) {
      if (Object.keys(node).some(key => !["size", "offset", "executable", "integrity"].includes(key))) throw Error("ASAR regular file metadata is unsupported");
      if (!Number.isSafeInteger(node.size) || node.size < 0 || node.size > MAX_FILE || typeof node.offset !== "string" || !/^\d+$/.test(node.offset)) {
        throw Error("ASAR regular file size or offset is invalid");
      }
      if (!prefix) throw Error("ASAR root cannot be a regular file");
      const offset = Number(node.offset), end = offset + node.size, start = contentOffset + offset;
      if (!Number.isSafeInteger(end) || start < contentOffset || start + node.size > bytes.length) throw Error("ASAR file data is out of bounds");
      const data = Buffer.from(bytes.subarray(start, start + node.size));
      expanded += data.length;
      if (expanded > MAX_ASAR || files.size >= MAX_FILES) throw Error("ASAR expanded file budget exceeded");
      ranges.push([offset, end]); files.set(prefix, data); return;
    }
    if (!children || typeof children !== "object" || Array.isArray(children)) throw Error("ASAR entry must be a directory or regular file");
    for (const name of Object.keys(children)) {
      const rel = safeRelative(prefix ? `${prefix}/${name}` : name), item = children[name];
      if (++entries > MAX_FILES + MAX_DIRS) throw Error("ASAR entry count exceeds budget");
      if (!item || typeof item !== "object" || Array.isArray(item) || item.link || item.unpacked === true) throw Error("ASAR links and unpacked entries are forbidden");
      if (item.files !== undefined) {
        if (Object.keys(item).some(key => key !== "files")) throw Error("ASAR directory has unsupported metadata");
        directories.add(rel);
        if (directories.size > MAX_DIRS) throw Error("ASAR directory count exceeds budget");
        walk(item, rel, depth + 1); continue;
      }
      walk(item, rel, depth + 1);
    }
  }
  walk(header);
  ranges.sort((a, b) => a[0] - b[0]);
  let packedEnd = 0;
  for (const [start, end] of ranges) {
    if (start !== packedEnd) throw Error(start < packedEnd ? "ASAR file data overlaps" : "ASAR packed data contains unreferenced bytes");
    packedEnd = end;
  }
  if (packedEnd !== bytes.length - contentOffset) throw Error("ASAR packed data has trailing unreferenced bytes");
  return { files, directories, header };
}

export function inspectLocalZpxArchive(archiveBytes, witness) {
  if (!Buffer.isBuffer(archiveBytes) || archiveBytes.length > MAX_ARCHIVE) throw Error("ZPX archive is not bounded bytes");
  let asar;
  try { asar = brotliDecompressSync(archiveBytes, { maxOutputLength: MAX_ASAR }); }
  catch { throw Error("Invalid or oversized Brotli-compressed ZPX"); }
  const inspected = inspectAsar(asar);
  const expected = [...witness.files].sort((a, b) => cmp(a.path, b.path));
  const actual = [...inspected.files].sort(([a], [b]) => cmp(a, b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
  if (JSON.stringify(actual) !== JSON.stringify(expected)
    || JSON.stringify([...inspected.directories].sort(cmp)) !== JSON.stringify([...witness.directories].sort(cmp))) {
    throw Error("ZPX ASAR members differ from exact pinned witness");
  }
  return inspected.files;
}

async function validateTempParent(parent = tmpdir()) {
  const canonical = await realpath(path.resolve(parent));
  const roots = await Promise.all([realpath(tmpdir()), realpath("/private/tmp").catch(() => "/private/tmp")]);
  if (!roots.some(root => canonical === root || canonical.startsWith(`${root}${path.sep}`))) throw Error("Archive fixture may only write beneath private temporary directories");
  const info = await lstat(canonical);
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Temporary parent must be a real directory");
  return canonical;
}

async function writePrivateFile(filename, bytes) {
  const handle = await open(filename, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o600);
  try { await handle.writeFile(bytes); } finally { await handle.close(); }
  await chmod(filename, 0o600);
}

async function verifyReviewTree(pluginRoot, witness) {
  const files = new Map(), dirs = new Set();
  let totalBytes = 0;
  async function walk(folder, prefix = "", depth = 0) {
    if (depth > MAX_DEPTH) throw Error("Fixture directory depth exceeds budget");
    for (const name of (await readdir(folder)).sort(cmp)) {
      const relative = safeRelative(prefix ? `${prefix}/${name}` : name), filename = path.join(pluginRoot, ...relative.split("/")), info = await lstat(filename);
      if (info.isSymbolicLink()) throw Error("Archive fixture contains a symlink");
      if (info.isDirectory()) {
        if ((info.mode & 0o777) !== 0o700) throw Error("Archive fixture directory must be mode 0700");
        dirs.add(relative); if (dirs.size > MAX_DIRS) throw Error("Fixture directory count exceeds budget"); await walk(filename, relative, depth + 1);
      }
      else if (info.isFile()) {
        if (files.size >= MAX_FILES || info.size > MAX_FILE) throw Error("Archive fixture file budget exceeded");
        if ((info.mode & 0o777) !== 0o600) throw Error("Archive fixture file must be mode 0600");
        const bytes = await readRegularNoFollow(filename, info, MAX_FILE);
        totalBytes += bytes.length;
        if (totalBytes > MAX_ASAR) throw Error("Archive fixture expanded bytes exceed budget");
        if (info.size !== bytes.length) throw Error("Archive fixture changed while reading");
        files.set(relative, bytes);
      } else throw Error("Archive fixture contains a special file");
    }
  }
  const rootInfo = await lstat(pluginRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o777) !== 0o700) throw Error("Archive plugin root must be a private real directory");
  await walk(pluginRoot);
  inspectWitness(files, dirs, witness);
  return files;
}

async function readRegularNoFollow(filename, before, cap) {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  if (typeof fsConstants.O_NONBLOCK === "number") flags |= fsConstants.O_NONBLOCK;
  const handle = await open(filename, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.size > cap) throw Error("Fixture file changed while opening");
    const chunks = []; let size = 0;
    while (size <= cap) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, cap + 1 - size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, size);
      if (!bytesRead) break;
      chunks.push(buffer.subarray(0, bytesRead)); size += bytesRead;
    }
    const after = await handle.stat();
    if (size > cap || size !== before.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) throw Error("Fixture file changed while reading");
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}

function inspectWitness(files, dirs, witness) {
  const actual = [...files].sort(([a], [b]) => cmp(a, b)).map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: sha256(bytes) }));
  if (JSON.stringify(actual) !== JSON.stringify([...witness.files].sort((a, b) => cmp(a.path, b.path)))
    || JSON.stringify([...dirs].sort(cmp)) !== JSON.stringify([...witness.directories].sort(cmp))) throw Error("Archive fixture differs from exact pinned witness");
}

/** One-time static source review; it reads bytes and manifest only, never executing package code. */
export async function reviewLocalOriginalArchiveSource(caseId) {
  const { profile, witness, sourceReview } = await registered(caseId);
  const source = await sourceFile(profile.sourcePath);
  const archive = await readSourceNoFollow(source.target, source.stat);
  if (archive.length !== profile.archiveBytes || sha256(archive) !== profile.archiveSha256) throw Error("Original ZPX bytes differ from pinned archive SHA-256");
  const files = inspectLocalZpxArchive(archive, witness);
  const manifest = JSON.parse(files.get("plugin.json")?.toString("utf8") || "null");
  if (manifest?.name !== profile.id || manifest?.version !== profile.version || manifest?.title !== profile.title
    || manifest?.main !== "index.html" || !manifest?.features?.some(feature => feature.code === profile.featureCode)) throw Error("Archive manifest identity differs from profile");
  const extracted = [...files].sort(([a], [b]) => cmp(a, b)).map(([filePath, bytes]) => ({ path: filePath, bytes: bytes.length, sha256: sha256(bytes) }));
  return { schemaVersion: 1, sourceKind: profile.sourceKind, status: profile.sourceReviewStatus,
    profile: { ...profile }, sourcePath: source.target, archiveSha256: profile.archiveSha256,
    archiveBytes: profile.archiveBytes, fileCount: extracted.length, files: extracted,
    directories: [...witness.directories], sourceInspection: sourceReview,
    sourceBytesUnchanged: true, pluginCodeExecutedByReview: false,
    verificationBoundary: "Static original ZPX byte/header/manifest inspection only; no plugin code execution." };
}

function buildReview(profile, fixture, sourceReview) {
  return { schemaVersion: 1, sourceKind: profile.sourceKind, status: profile.sourceReviewStatus,
    profile: { ...profile }, fixture: { id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      ownedRoot: fixture.ownedRoot, pluginRoot: fixture.pluginRoot, archivePath: fixture.archivePath,
      packageImportPath: fixture.packageImportPath, originalSourcePath: fixture.originalSourcePath,
      archiveSha256: fixture.archiveSha256, archiveBytes: fixture.archiveBytes,
      fileCount: profile.fileCount, files: fixture.files, directories: fixture.directories },
    sourceInspection: sourceReview,
    verificationBoundary: "Original ZPX bytes and extracted member verification only; no plugin code is executed by fixture preparation." };
}

export async function prepareLocalOriginalArchiveFixture(caseId, { temporaryParent } = {}) {
  const { profile, witness, sourceReview } = await registered(caseId);
  const sourceInfo = await sourceFile(profile.sourcePath);
  const archive = await readSourceNoFollow(sourceInfo.target, sourceInfo.stat);
  if (archive.length !== profile.archiveBytes || sha256(archive) !== profile.archiveSha256) throw Error("Original ZPX bytes differ from pinned archive SHA-256");
  const files = inspectLocalZpxArchive(archive, witness);
  const manifest = JSON.parse(files.get("plugin.json")?.toString("utf8") || "null");
  if (manifest?.name !== profile.id || manifest?.version !== profile.version || manifest?.title !== profile.title
    || manifest?.main !== "index.html" || !manifest?.features?.some(feature => feature.code === profile.featureCode)) throw Error("Archive manifest identity differs from profile");
  const parent = await validateTempParent(temporaryParent);
  const materialized = await materializeInspectedFiles(files, parent);
  const ownedRoot = materialized.ownedRoot, pluginRoot = path.join(ownedRoot, "plugin"), archivePath = path.join(ownedRoot, "source.zpx");
  try {
    await chmod(pluginRoot, 0o700);
    await writePrivateFile(archivePath, archive);
    const originalAgain = await readSourceNoFollow(sourceInfo.target, sourceInfo.stat);
    if (sha256(originalAgain) !== profile.archiveSha256 || sha256(await readFile(archivePath)) !== profile.archiveSha256) throw Error("Original or copied ZPX changed during fixture preparation");
    const copied = await verifyReviewTree(pluginRoot, witness);
    const fixture = { ...materialized, ownedRoot, pluginRoot, sourceKind: profile.sourceKind, id: profile.id, version: profile.version,
      packageImportPath: archivePath, archivePath, archiveSha256: profile.archiveSha256, archiveBytes: archive.length,
      originalSourcePath: sourceInfo.target, files: witness.files, directories: witness.directories };
    const review = buildReview(profile, fixture, sourceReview);
    const sourceReviewJSON = path.join(ownedRoot, "source-review.json");
    await writePrivateFile(sourceReviewJSON, Buffer.from(`${JSON.stringify(review, null, 2)}\n`));
    return { profile, fixture: { ...fixture, sourceReviewJSON }, review, cleanup: async () => rm(ownedRoot, { recursive: true, force: true }) };
  } catch (error) { await rm(ownedRoot, { recursive: true, force: true }); throw error; }
}

export async function verifyLocalOriginalArchiveFixture(fixture, profile) {
  const { profile: registeredProfile, witness } = await registered(profile?.caseId);
  if (JSON.stringify(registeredProfile) !== JSON.stringify(profile) || fixture?.sourceKind !== profile.sourceKind
    || fixture.archiveSha256 !== profile.archiveSha256 || fixture.archiveBytes !== profile.archiveBytes
    || fixture.archivePath !== path.join(fixture.ownedRoot || "", "source.zpx")
    || fixture.packageImportPath !== fixture.archivePath || fixture.pluginRoot !== path.join(fixture.ownedRoot || "", "plugin")
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-published-plugin-fixture-")
    || JSON.stringify(fixture.files) !== JSON.stringify(witness.files)
    || JSON.stringify(fixture.directories) !== JSON.stringify(witness.directories)) throw Error("Original archive fixture identity mismatch");
  const owned = await realpath(fixture.ownedRoot), stat = await lstat(fixture.ownedRoot);
  const privateRoots = await Promise.all([realpath(tmpdir()), realpath("/private/tmp").catch(() => "/private/tmp")]);
  if (owned !== fixture.ownedRoot || !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || !privateRoots.some(root => owned.startsWith(`${root}${path.sep}`))) throw Error("Original archive fixture owner is not private and canonical");
  const source = await sourceFile(profile.sourcePath);
  if (source.target !== fixture.originalSourcePath) throw Error("Original archive source path mismatch");
  const original = await readSourceNoFollow(source.target, source.stat), retainedStat = await lstat(fixture.archivePath);
  if (!retainedStat.isFile() || retainedStat.isSymbolicLink() || retainedStat.size !== profile.archiveBytes || (retainedStat.mode & 0o777) !== 0o600) throw Error("Retained ZPX must be a private regular file");
  const retained = await readRegularNoFollow(fixture.archivePath, retainedStat, MAX_ARCHIVE);
  if (original.length !== profile.archiveBytes || retained.length !== profile.archiveBytes || sha256(original) !== profile.archiveSha256
    || sha256(retained) !== profile.archiveSha256 || !original.equals(retained)) throw Error("Original or retained ZPX no longer matches pinned bytes");
  const files = await verifyReviewTree(fixture.pluginRoot, witness);
  const verification = { sourceKind: profile.sourceKind, sourceBytesUnchanged: true, fixtureBytesMatchPinnedSource: true,
    archiveSha256: profile.archiveSha256, archiveBytes: profile.archiveBytes, fileCount: files.size, unchangedFileCount: files.size,
    directories: witness.directories, files: witness.files, noPluginCodeExecutedByVerification: true };
  return { verification, files };
}
