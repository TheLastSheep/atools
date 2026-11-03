import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const FALLBACK_SETTINGS_NATIVE_DIST = "output/fallback-settings-native-dist";
export const FALLBACK_SETTINGS_NATIVE_RESOURCE_PATH = "Contents/Resources/atools-fallback-settings-qa";
export const FALLBACK_SETTINGS_NATIVE_OWNER = "@atools/fallback-settings-native-fixture";

const WORKSPACE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
const MAX_PROVENANCE_BYTES = 256 * 1024;
const MAX_RESOURCE_PATH_BYTES = 512;
const MAX_SOURCE_PATH_BYTES = 4096;
const MAX_PATH_DEPTH = 8;
const MAX_SOURCE_FILES = 512;
const MAX_SOURCE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_RESOURCE_FILES = 64;
const MAX_RESOURCE_FILE_BYTES = 1024 * 1024;
const MAX_RESOURCE_BYTES = 2 * 1024 * 1024;
const PROVENANCE_KEYS = ["schemaVersion", "owner", "sources", "sourceSha256", "resources", "resourceSha256", "resourceBytes", "resourceCount"];
const RECORD_KEYS = ["path", "sha256", "bytes"];
const REQUIRED_SOURCE_PATHS = [
  "package.json", "pnpm-lock.yaml", "scripts/build-fallback-settings-native.mjs",
  "svelte.config.js", "tests/components/fallback-settings-native.html",
  "tests/components/fallbackSettingsNativeFixture.ts", "tests/components/fallbackSettingsNativeReadiness.ts",
  "tsconfig.json", "vite.config.ts",
];

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value)) === JSON.stringify(keys);
}

function safeRelativePath(value, maximumBytes = MAX_RESOURCE_PATH_BYTES) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > maximumBytes
      || value.startsWith("/") || /[\\%?#:\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= MAX_PATH_DEPTH && parts.every(part => part !== "" && part !== "." && part !== "..");
}

function sortedUnique(records) {
  return Array.isArray(records) && records.length > 0
    && records.every((record, index) => index === 0 || records[index - 1].path < record.path)
    && new Set(records.map(record => record.path)).size === records.length;
}

async function canonicalWorkspace(root) {
  if (typeof root !== "string" || !isAbsolute(root) || resolve(root) !== root) fail("Fallback source root is not canonical");
  const info = await lstat(root, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory() || await realpath(root) !== root) fail("Fallback source root is not a real workspace");
  return root;
}

async function readNoFollow(path, maximumBytes) {
  const handle = await open(path, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) fail("Fallback source file exceeds its bound");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.byteLength) !== before.size || !sameIdentity(before, after)
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      fail("Fallback source file changed while being read");
    }
    return { bytes, stat: after };
  } finally {
    await handle.close();
  }
}

async function readWorkspaceFile(root, relativePath, maxBytes) {
  if (!safeRelativePath(relativePath, MAX_SOURCE_PATH_BYTES)) fail("Fallback source path is unsafe");
  const parts = relativePath.split("/");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = await lstat(parent, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(parent) !== parent) {
      fail("Fallback source path contains a symlink or non-directory");
    }
  }
  const path = join(root, ...parts);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || await realpath(path) !== path) {
    fail("Fallback source path is not a regular canonical file");
  }
  const read = await readNoFollow(path, maxBytes);
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(info, read.stat) || info.size !== read.stat.size || info.mtimeNs !== read.stat.mtimeNs) {
    fail("Fallback source path changed during verification");
  }
  if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(info, after)
      || info.size !== after.size || info.mtimeNs !== after.mtimeNs || await realpath(path) !== path) {
    fail("Fallback source path changed during verification");
  }
  return read.bytes;
}

async function readDistFile(distRoot, relativePath, maxBytes) {
  if (!safeRelativePath(relativePath)) fail("Fallback resource path is unsafe");
  const parts = relativePath.split("/");
  let parent = distRoot;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const info = await lstat(parent, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(parent) !== parent) {
      fail("Fallback resource path contains a symlink or non-directory");
    }
  }
  const path = join(distRoot, ...parts);
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || await realpath(path) !== path) {
    fail("Fallback resource is not a regular canonical file");
  }
  const read = await readNoFollow(path, maxBytes);
  const after = await lstat(path, { bigint: true });
  if (!sameIdentity(info, read.stat) || info.size !== read.stat.size || info.mtimeNs !== read.stat.mtimeNs) {
    fail("Fallback resource changed during verification");
  }
  if (after.isSymbolicLink() || !after.isFile() || !sameIdentity(info, after)
      || info.size !== after.size || info.mtimeNs !== after.mtimeNs || await realpath(path) !== path) {
    fail("Fallback resource changed during verification");
  }
  return read.bytes;
}

async function listDistFiles(distRoot) {
  const files = [];
  const directories = [];
  let entriesSeen = 0;
  async function visit(directory, relativeDirectory, depth) {
    const info = await lstat(directory, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(directory) !== directory) {
      fail("Fallback dist contains a symlink or non-directory path");
    }
    directories.push(relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > MAX_RESOURCE_FILES + MAX_PATH_DEPTH + 4) fail("Fallback dist has too many entries");
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!safeRelativePath(path, MAX_RESOURCE_PATH_BYTES)) fail("Fallback dist path is unsafe");
      const absolute = join(directory, entry.name);
      const entryInfo = await lstat(absolute, { bigint: true });
      if (entryInfo.isSymbolicLink()) fail("Fallback dist symlinks are forbidden");
      if (entryInfo.isDirectory()) {
        if (path !== "assets" && !path.startsWith("assets/")) fail("Only the fallback assets tree may contain directories");
        await visit(absolute, path, depth + 1);
        continue;
      }
      if (!entryInfo.isFile()) fail("Fallback dist contains an unsupported entry");
      if (path !== "index.html" && path !== "build-provenance.json" && !path.startsWith("assets/")) {
        fail("Fallback dist contains an unapproved top-level file");
      }
      if (path !== "build-provenance.json") files.push({ path, bytes: Number(entryInfo.size) });
    }
  }
  await visit(distRoot, "", 0);
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  directories.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (directories.some(path => path !== "" && path !== "assets" && !path.startsWith("assets/"))) {
    fail("Fallback dist has a directory outside assets");
  }
  return files;
}

function validateRecords(records, kind) {
  if (!Array.isArray(records) || records.length < 1
      || records.length > (kind === "sources" ? MAX_SOURCE_FILES : MAX_RESOURCE_FILES)
      || !sortedUnique(records)) fail(`Fallback ${kind} list is missing, unbounded, or unsorted`);
  let totalBytes = 0;
  for (const record of records) {
    if (!exactKeys(record, RECORD_KEYS)
        || !safeRelativePath(record.path, kind === "sources" ? MAX_SOURCE_PATH_BYTES : MAX_RESOURCE_PATH_BYTES)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 0
        || !/^[0-9a-f]{64}$/.test(record.sha256 ?? "")) fail(`Fallback ${kind} record is invalid`);
    if (kind === "resources") {
      if (record.path !== "index.html" && !record.path.startsWith("assets/")) fail("Fallback resource path is outside the served namespace");
      if (record.bytes > MAX_RESOURCE_FILE_BYTES) fail("Fallback resource exceeds the per-file limit");
    } else {
      if (record.bytes > MAX_SOURCE_FILE_BYTES) fail("Fallback source exceeds the per-file limit");
    }
    totalBytes += record.bytes;
    const limit = kind === "sources" ? MAX_SOURCE_BYTES : MAX_RESOURCE_BYTES;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limit) fail(`Fallback ${kind} exceeds its total byte limit`);
  }
  if (kind === "resources" && !records.some(record => record.path === "index.html")) fail("Fallback dist has no index.html");
  return totalBytes;
}

function summary(provenanceBytes, provenance, sourceBytes, resourceBytes) {
  return {
    owner: provenance.owner,
    provenanceSha256: sha256(provenanceBytes),
    sourceSha256: provenance.sourceSha256,
    sourceCount: provenance.sources.length,
    sourceBytes,
    resourceSha256: provenance.resourceSha256,
    resourceCount: provenance.resourceCount,
    resourceBytes,
  };
}

/** Reads only the fixed, build-owned QA dist and independently verifies its provenance and bytes. */
export async function captureFallbackSettingsNativeSources(root = WORKSPACE_ROOT) {
  const workspace = await canonicalWorkspace(root);
  const distRoot = join(workspace, FALLBACK_SETTINGS_NATIVE_DIST);
  if (await realpath(distRoot) !== distRoot) fail("Fallback dist must be the fixed canonical output path");
  const distInfo = await lstat(distRoot, { bigint: true });
  if (distInfo.isSymbolicLink() || !distInfo.isDirectory()) fail("Fallback dist is not a real directory");
  const provenancePath = join(distRoot, "build-provenance.json");
  const provenanceRead = await readNoFollow(provenancePath, MAX_PROVENANCE_BYTES);
  let provenance;
  try { provenance = JSON.parse(provenanceRead.bytes.toString("utf8")); }
  catch { fail("Fallback build provenance is not valid JSON"); }
  if (!exactKeys(provenance, PROVENANCE_KEYS) || provenance.schemaVersion !== 1
      || provenance.owner !== FALLBACK_SETTINGS_NATIVE_OWNER) fail("Fallback build provenance identity is invalid");

  const sourceBytes = validateRecords(provenance.sources, "sources");
  const sourcePaths = new Set(provenance.sources.map(source => source.path));
  if (!REQUIRED_SOURCE_PATHS.every(path => sourcePaths.has(path))) {
    fail("Fallback provenance omits a required entry or build input");
  }
  const resourceBytes = validateRecords(provenance.resources, "resources");
  if (provenance.resourceBytes !== resourceBytes || provenance.resourceCount !== provenance.resources.length
      || provenance.sourceSha256 !== sha256(JSON.stringify(provenance.sources))
      || provenance.resourceSha256 !== sha256(JSON.stringify(provenance.resources))) {
    fail("Fallback build provenance totals or digests do not match the declared lists");
  }
  const actualFiles = await listDistFiles(distRoot);
  if (JSON.stringify(actualFiles.map(({ path, bytes }) => ({ path, bytes })))
      !== JSON.stringify(provenance.resources.map(({ path, bytes }) => ({ path, bytes })))) {
    fail("Fallback dist files differ from the declared resource list");
  }

  const actualSources = [];
  for (const source of provenance.sources) {
    const bytes = await readWorkspaceFile(workspace, source.path, MAX_SOURCE_FILE_BYTES);
    const actual = { path: source.path, sha256: sha256(bytes), bytes: bytes.byteLength };
    if (actual.sha256 !== source.sha256 || actual.bytes !== source.bytes) fail("Fallback source differs from build provenance");
    actualSources.push(actual);
  }
  const actualResources = [];
  for (const resource of provenance.resources) {
    const bytes = await readDistFile(distRoot, resource.path, MAX_RESOURCE_FILE_BYTES);
    const actual = { path: resource.path, sha256: sha256(bytes), bytes: bytes.byteLength };
    if (actual.sha256 !== resource.sha256 || actual.bytes !== resource.bytes) fail("Fallback resource differs from build provenance");
    actualResources.push(actual);
  }
  const provenanceAfter = await readNoFollow(provenancePath, MAX_PROVENANCE_BYTES);
  if (!sameIdentity(provenanceRead.stat, provenanceAfter.stat) || !provenanceRead.bytes.equals(provenanceAfter.bytes)) {
    fail("Fallback build provenance changed while validating resources");
  }
  const distFilesAfter = await listDistFiles(distRoot);
  if (JSON.stringify(distFilesAfter.map(({ path, bytes }) => ({ path, bytes })))
      !== JSON.stringify(actualFiles.map(({ path, bytes }) => ({ path, bytes })))) {
    fail("Fallback dist files changed while validating resources");
  }
  return {
    root: workspace,
    distRoot,
    provenance,
    provenanceBytes: provenanceRead.bytes,
    sources: actualSources,
    resources: actualResources,
    summary: summary(provenanceRead.bytes, provenance, sourceBytes, resourceBytes),
  };
}

export async function assertFallbackSettingsNativeSourcesUnchanged(snapshot) {
  if (!snapshot || typeof snapshot.root !== "string" || !isAbsolute(snapshot.root)) {
    fail("Fallback source snapshot is invalid");
  }
  const current = await captureFallbackSettingsNativeSources(snapshot.root);
  if (JSON.stringify(current.summary) !== JSON.stringify(snapshot.summary)
      || !current.provenanceBytes.equals(snapshot.provenanceBytes)
      || JSON.stringify(current.sources) !== JSON.stringify(snapshot.sources)
      || JSON.stringify(current.resources) !== JSON.stringify(snapshot.resources)) {
    fail("Fallback source, provenance, or emitted resources changed during Native acceptance");
  }
  return current;
}

async function ensurePrivateDirectory(path) {
  try { await mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory() || Number(info.mode & 0o777n) !== 0o700
      || await realpath(path) !== path) fail("Fallback app resource directory is not private and canonical");
}

async function writeStagedFile(target, bytes) {
  await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  await chmod(target, 0o600);
  const info = await lstat(target, { bigint: true });
  if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n || Number(info.mode & 0o777n) !== 0o600) {
    fail("Fallback staged resource has invalid ownership metadata");
  }
}

/** Copies the validated emitted files into the owned app bundle and verifies every staged byte. */
export async function stageFallbackSettingsNativeResources(snapshot, appBundlePath) {
  if (!snapshot || typeof snapshot.root !== "string" || typeof appBundlePath !== "string"
      || !isAbsolute(appBundlePath) || resolve(appBundlePath) !== appBundlePath) {
    fail("Fallback staging inputs are invalid");
  }
  const current = await assertFallbackSettingsNativeSourcesUnchanged(snapshot);
  const contents = join(appBundlePath, "Contents");
  const resourcesDirectory = join(contents, "Resources");
  const bundleInfo = await lstat(appBundlePath, { bigint: true });
  const resourcesInfo = await lstat(resourcesDirectory, { bigint: true });
  if (bundleInfo.isSymbolicLink() || !bundleInfo.isDirectory() || resourcesInfo.isSymbolicLink()
      || !resourcesInfo.isDirectory() || await realpath(appBundlePath) !== appBundlePath
      || await realpath(resourcesDirectory) !== resourcesDirectory
      || Number(bundleInfo.mode & 0o777n) !== 0o700 || Number(resourcesInfo.mode & 0o777n) !== 0o700) {
    fail("Fallback app bundle is not private and canonical");
  }

  const targetRoot = join(resourcesDirectory, "atools-fallback-settings-qa");
  try {
    await mkdir(targetRoot, { mode: 0o700 });
    await ensurePrivateDirectory(targetRoot);
    for (const resource of current.resources) {
      const sourceBytes = await readDistFile(current.distRoot, resource.path, MAX_RESOURCE_FILE_BYTES);
      const target = join(targetRoot, ...resource.path.split("/"));
      const targetDirectory = dirname(target);
      const relativeParent = relative(targetRoot, targetDirectory);
      let cursor = targetRoot;
      for (const part of relativeParent ? relativeParent.split(sep) : []) {
        cursor = join(cursor, part);
        await ensurePrivateDirectory(cursor);
      }
      await writeStagedFile(target, sourceBytes);
    }
    await writeStagedFile(join(targetRoot, "build-provenance.json"), current.provenanceBytes);
    const stagedResources = [];
    for (const resource of current.resources) {
      const bytes = await readDistFile(targetRoot, resource.path, MAX_RESOURCE_FILE_BYTES);
      const actual = { path: resource.path, sha256: sha256(bytes), bytes: bytes.byteLength };
      if (actual.sha256 !== resource.sha256 || actual.bytes !== resource.bytes) fail("Staged fallback resource failed readback");
      stagedResources.push(actual);
    }
    const stagedMetadata = await readNoFollow(join(targetRoot, "build-provenance.json"), MAX_PROVENANCE_BYTES);
    if (!stagedMetadata.bytes.equals(current.provenanceBytes)) fail("Staged fallback provenance failed readback");
    return {
      staged: true,
      resourcePath: FALLBACK_SETTINGS_NATIVE_RESOURCE_PATH,
      resourceCount: stagedResources.length,
      resourceBytes: stagedResources.reduce((total, item) => total + item.bytes, 0),
      provenanceSha256: sha256(stagedMetadata.bytes),
      sourceSha256: current.summary.sourceSha256,
      resourceSha256: sha256(JSON.stringify(stagedResources)),
    };
  } catch (error) {
    await rm(targetRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function summarizeFallbackSettingsNativeSources(snapshot) {
  if (!snapshot?.summary) return null;
  return { ...snapshot.summary };
}
