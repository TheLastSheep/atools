import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readLocalOriginalRegistry, selectLocalOriginalRegistration } from "./local-original-registry.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_FILES = 64;
const MAX_DIRECTORIES = 64;
const MAX_DEPTH = 16;
const MAX_PATH_BYTES = 2048;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const utf8Compare = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * Directory digest v1, shared with local_package_verification.rs:
 * SHA256("AToolsLocalTreeV1\\0" || sorted directory records || sorted file records).
 * A directory record is byte 'D', u32be(path UTF-8 length), path UTF-8.
 * A file record is byte 'F', u32be(path length), path, u64be(content bytes), raw SHA256(content).
 * Root itself is excluded; explicit empty directories are included.
 */
export function summarizeLocalTree(files, directories) {
  const orderedDirs = [...directories].sort(utf8Compare);
  const orderedFiles = [...files.entries()].sort(([a], [b]) => utf8Compare(a, b));
  const hash = createHash("sha256").update(Buffer.from("AToolsLocalTreeV1\0", "utf8"));
  const dirWitness = orderedDirs.map(relative => {
    const name = validateRelative(relative);
    const nameBytes = Buffer.from(name, "utf8");
    const record = Buffer.allocUnsafe(5 + nameBytes.length);
    record[0] = 0x44;
    record.writeUInt32BE(nameBytes.length, 1);
    nameBytes.copy(record, 5);
    hash.update(record);
    return name;
  });
  const fileWitness = orderedFiles.map(([relative, bytes]) => {
    const name = validateRelative(relative);
    if (!Buffer.isBuffer(bytes)) throw Error(`Expected bytes for ${name}`);
    const nameBytes = Buffer.from(name, "utf8");
    const digest = Buffer.from(sha256(bytes), "hex");
    const record = Buffer.allocUnsafe(1 + 4 + nameBytes.length + 8 + 32);
    record[0] = 0x46;
    record.writeUInt32BE(nameBytes.length, 1);
    nameBytes.copy(record, 5);
    record.writeBigUInt64BE(BigInt(bytes.length), 5 + nameBytes.length);
    digest.copy(record, 13 + nameBytes.length);
    hash.update(record);
    return { path: name, bytes: bytes.length, sha256: digest.toString("hex") };
  });
  return { directorySha256: hash.digest("hex"), fileCount: fileWitness.length, files: fileWitness, directories: dirWitness };
}

function validateRelative(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value, "utf8") > MAX_PATH_BYTES
    || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw Error("Unsafe local package relative path");
  }
  const parts = value.split("/");
  if (parts.length > MAX_DEPTH || parts.some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw Error("Unsafe local package path component");
  }
  return value;
}

export async function scanLocalDirectory(root) {
  const files = new Map();
  const directories = new Set();
  let totalBytes = 0;

  async function walk(absolute, relative, depth) {
    if (depth > MAX_DEPTH) throw Error("Local package directory depth exceeds budget");
    const entries = await readdir(absolute, { withFileTypes: true });
    entries.sort((a, b) => utf8Compare(a.name, b.name));
    for (const entry of entries) {
      const childRelative = validateRelative(relative ? `${relative}/${entry.name}` : entry.name);
      const childPath = path.join(root, ...childRelative.split("/"));
      const metadata = await lstat(childPath);
      if (metadata.isSymbolicLink()) throw Error(`Local package contains symlink: ${childRelative}`);
      if (metadata.isDirectory()) {
        directories.add(childRelative);
        if (directories.size > MAX_DIRECTORIES) throw Error("Local package directory count exceeds budget");
        await walk(childPath, childRelative, depth + 1);
        continue;
      }
      if (!metadata.isFile()) throw Error(`Local package contains a special file: ${childRelative}`);
      if (files.size >= MAX_FILES || metadata.size > MAX_FILE_BYTES) throw Error("Local package file budget exceeded");
      const bytes = await readRegularNoFollow(childPath, metadata);
      totalBytes += bytes.length;
      if (totalBytes > MAX_TREE_BYTES) throw Error("Local package expanded size exceeds budget");
      files.set(childRelative, bytes);
    }
  }

  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw Error("Local package root must be a real directory");
  const canonical = await realpath(root);
  if (canonical !== root) throw Error("Local package root must be canonical");
  await walk(root, "", 0);
  return { files, directories };
}

async function readRegularNoFollow(filePath, before) {
  let flags = fsConstants.O_RDONLY;
  if (typeof fsConstants.O_NOFOLLOW === "number") flags |= fsConstants.O_NOFOLLOW;
  const handle = await open(filePath, flags);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw Error("Local package file changed while opening");
    }
    const chunks = [];
    let total = 0;
    while (total <= MAX_FILE_BYTES) {
      const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > MAX_FILE_BYTES) throw Error("Local package file exceeded its bounded stream read");
    const bytes = Buffer.concat(chunks, total);
    const after = await handle.stat();
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== opened.mtimeMs) {
      throw Error("Local package file changed while reading");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

function sameWitness(actual, expected) {
  return JSON.stringify(actual.files) === JSON.stringify(expected.files)
    && JSON.stringify(actual.directories) === JSON.stringify(expected.directories)
    && actual.directorySha256 === expected.directorySha256
    && actual.fileCount === expected.fileCount;
}

async function loadProfile(caseId) {
  return selectLocalOriginalRegistration(await readLocalOriginalRegistry(), caseId);
}

/** Resolve a repo-relative source only after canonicalizing the repository and checking each child component without following links. */
export async function resolveCanonicalRepositorySource(sourcePath, repositoryRoot = REPO_ROOT) {
  if (typeof sourcePath !== "string" || !sourcePath || sourcePath.startsWith("/") || sourcePath.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(sourcePath)
    || sourcePath.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) {
    throw Error("Local source package path must be a safe repository-relative path");
  }
  const canonicalRepositoryRoot = await realpath(path.resolve(repositoryRoot));
  const absolute = path.resolve(canonicalRepositoryRoot, ...sourcePath.split("/"));
  const relative = path.relative(canonicalRepositoryRoot, absolute);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw Error("Local source package escapes canonical repository root");
  }

  let current = canonicalRepositoryRoot;
  const components = relative.split(path.sep);
  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw Error(`Local source package path contains symlink: ${components.slice(0, index + 1).join("/")}`);
    const isLast = index === components.length - 1;
    if ((!isLast && !metadata.isDirectory()) || (isLast && !metadata.isDirectory())) {
      throw Error("Local source package path must resolve to a real directory");
    }
  }
  const canonicalSource = await realpath(absolute);
  const canonicalRelative = path.relative(canonicalRepositoryRoot, canonicalSource);
  if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${path.sep}`) || path.isAbsolute(canonicalRelative)) {
    throw Error("Resolved local source package escapes canonical repository root");
  }
  return canonicalSource;
}

async function validateTempParent(requested = tmpdir()) {
  const absolute = path.resolve(requested);
  const canonical = await realpath(absolute);
  const allowedRoots = [await realpath(tmpdir()), await realpath("/private/tmp").catch(() => "/private/tmp")];
  if (!allowedRoots.some(root => canonical === root || canonical.startsWith(`${root}${path.sep}`))) {
    throw Error("Local fixture may only write beneath a private temporary directory");
  }
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw Error("Temporary parent must be a real directory");
  return canonical;
}

function buildReview(profile, sourceRoot, fixtureRoot, witness, sourceReview) {
  return {
    schemaVersion: 1,
    sourceKind: "local_full_directory",
    status: profile.sourceReviewStatus,
    profile: {
      caseId: profile.caseId, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: profile.directorySha256, fileCount: profile.fileCount,
    },
    fixture: {
      id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount,
      ownedRoot: fixtureRoot, sourceRoot, pluginRoot: path.join(fixtureRoot, "plugin"),
      files: witness.files, directories: witness.directories,
    },
    sourceInspection: sourceReview,
    verificationBoundary: "Original package directory bytes only; this report performs no plugin execution or runtime acceptance.",
  };
}

/** Materialize a reviewed original directory into an owned, mode-restricted temporary fixture. */
export async function prepareLocalOriginalFixture(caseId, { temporaryParent } = {}) {
  const { profile, witness: expectedWitness, sourceReview } = await loadProfile(caseId);
  const sourceRoot = await resolveCanonicalRepositorySource(profile.sourcePath);
  const source = await scanLocalDirectory(sourceRoot);
  const witness = summarizeLocalTree(source.files, source.directories);
  if (!sameWitness(witness, expectedWitness)) throw Error("Current original package differs from its pinned directory witness");

  const parent = await validateTempParent(temporaryParent);
  const ownedRoot = await mkdtemp(path.join(parent, "atools-local-plugin-fixture-"));
  await chmod(ownedRoot, 0o700);
  const pluginRoot = path.join(ownedRoot, "plugin");
  try {
    await mkdir(pluginRoot, { mode: 0o700 });
    await chmod(pluginRoot, 0o700);
    for (const relative of [...source.directories].sort((a, b) => a.split("/").length - b.split("/").length || utf8Compare(a, b))) {
      const directory = path.join(pluginRoot, ...relative.split("/"));
      await mkdir(directory, { mode: 0o700 });
      await chmod(directory, 0o700);
    }
    for (const [relative, bytes] of source.files) {
      const destination = path.join(pluginRoot, ...relative.split("/"));
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      await chmod(destination, 0o600);
    }

    const sourceAfter = await scanLocalDirectory(sourceRoot);
    const copied = await scanLocalDirectory(pluginRoot);
    const sourceWitnessAfter = summarizeLocalTree(sourceAfter.files, sourceAfter.directories);
    const copiedWitness = summarizeLocalTree(copied.files, copied.directories);
    if (!sameWitness(sourceWitnessAfter, witness) || !sameWitness(copiedWitness, expectedWitness)) {
      throw Error("Original source changed during fixture materialization or copied bytes failed verification");
    }
    const review = buildReview(profile, sourceRoot, ownedRoot, copiedWitness, sourceReview);
    const sourceReviewJSON = path.join(ownedRoot, "source-review.json");
    await writeFile(sourceReviewJSON, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return {
      profile,
      fixture: {
        ownedRoot, pluginRoot, sourceRoot, sourceReviewJSON,
        id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
        directorySha256: copiedWitness.directorySha256, fileCount: copiedWitness.fileCount,
        files: copiedWitness.files, directories: copiedWitness.directories,
      },
      review,
      cleanup: async () => rm(ownedRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(ownedRoot, { recursive: true, force: true });
    throw error;
  }
}

/** Read and pin the original source directory without copying it or executing package code. */
export async function reviewLocalOriginalSource(caseId) {
  const { profile, witness: expectedWitness, sourceReview } = await loadProfile(caseId);
  const sourceRoot = await resolveCanonicalRepositorySource(profile.sourcePath);
  const source = await scanLocalDirectory(sourceRoot);
  const witness = summarizeLocalTree(source.files, source.directories);
  if (!sameWitness(witness, expectedWitness)) throw Error("Current original package differs from its pinned directory witness");
  const manifest = JSON.parse(source.files.get("plugin.json")?.toString("utf8") || "null");
  if (manifest?.name !== profile.id || manifest?.version !== profile.version
    || !manifest.features?.some(feature => feature.code === profile.featureCode)) {
    throw Error("Original manifest identity or feature differs from the pinned profile");
  }
  const review = {
    schemaVersion: 1,
    sourceKind: "local_full_directory",
    status: profile.sourceReviewStatus,
    profile: {
      caseId: profile.caseId, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: profile.directorySha256, fileCount: profile.fileCount,
    },
    fixture: {
      id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, sourceRoot,
      files: witness.files, directories: witness.directories,
    },
    sourceInspection: sourceReview,
    verificationBoundary: "Original directory source review only; no copy or plugin execution.",
  };
  return {
    profile,
    sourceRoot,
    witness,
    review,
  };
}

/** Re-read source and materialized package before/after runtime use; returns verified copied bytes. */
export async function verifyLocalOriginalFixture(fixture, profile) {
  if (!["web", "node"].includes(profile?.runtime)) throw Error("Unsupported local original fixture runtime");
  const { profile: registered, witness } = await loadProfile(profile?.caseId);
  if (JSON.stringify(registered) !== JSON.stringify(profile)
    || fixture?.sourceRoot !== await resolveCanonicalRepositorySource(registered.sourcePath)
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-local-plugin-fixture-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "plugin")) {
    throw Error("Local original fixture identity or owned root does not match the pinned profile");
  }
  const source = await scanLocalDirectory(fixture.sourceRoot);
  const copied = await scanLocalDirectory(fixture.pluginRoot);
  const sourceWitness = summarizeLocalTree(source.files, source.directories);
  const copiedWitness = summarizeLocalTree(copied.files, copied.directories);
  if (!sameWitness(sourceWitness, witness) || !sameWitness(copiedWitness, witness)
    || fixture.directorySha256 !== registered.directorySha256 || fixture.fileCount !== registered.fileCount) {
    throw Error("Local original source or fixture changed from the independently registered witness");
  }
  return {
    verification: {
      sourceBytesUnchanged: true, fixtureBytesMatchPinnedSource: true,
      sourceKind: "local_full_directory", directorySha256: copiedWitness.directorySha256,
      fileCount: copiedWitness.fileCount, unchangedFileCount: copiedWitness.fileCount,
      expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      files: copiedWitness.files, directories: copiedWitness.directories,
      pluginCodeExecutedByVerification: false,
    },
    files: copied.files,
  };
}
