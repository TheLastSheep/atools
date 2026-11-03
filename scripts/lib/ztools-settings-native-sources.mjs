import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { captureHostBridgeSources } from "../../packages/ztools-settings/src/host-bridge-build.mjs";
import { frozenSettingsResourceBudget } from "./ztools-settings-resource-budget.mjs";
import { assertCurrentSettingsBuildInputs } from "./ztools-settings-current-build-inputs.mjs";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const PINNED_SOURCE_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const STRICT_ARTIFACT_OWNER = "@atools/ztools-settings-source-build";
const STRICT_STATUS = "strict/typecheck-passed";
const MAX_PROVENANCE_BYTES = 256 * 1024;
const MAX_EMITTED_RESOURCES = 64;
const MAX_DIST_ENTRIES = 128;
const MAX_DIST_FILES = MAX_EMITTED_RESOURCES + 4;
const MAX_DIST_BYTES = 2 * 1024 * 1024;
const MAX_SOURCE_FILES = 128;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_PATH_DEPTH = 8;
const DIST_METADATA = [
  "ZTools-LICENSE",
  "upstream-package.json",
  "source-manifest.json",
  "build-provenance.json",
];

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function posix(value) {
  return value.split(sep).join("/");
}

function isInside(parent, child) {
  const value = relative(parent, child);
  return value === "" || (!value.startsWith(`..${sep}`) && value !== ".." && !isAbsolute(value));
}

function safeRelativePath(value) {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > MAX_PATH_BYTES
      || value.startsWith("/") || /[\\%?#:\u0000-\u001f\u007f]/.test(value)) return false;
  const parts = value.split("/");
  return parts.length <= MAX_PATH_DEPTH
    && parts.every(part => part && part !== "." && part !== "..");
}

async function canonicalDirectory(path, expectedPath = null) {
  if (typeof path !== "string" || !isAbsolute(path)) fail("Settings source path must be absolute");
  const absolute = resolve(path);
  let canonical;
  try { canonical = await realpath(absolute); }
  catch { fail("Settings source directory is unavailable"); }
  if (canonical !== absolute || (expectedPath && canonical !== expectedPath)) {
    fail("Settings source directory must be canonical and fixed");
  }
  const info = await lstat(canonical);
  if (info.isSymbolicLink() || !info.isDirectory()) fail("Settings source directory must be a real directory");
  return canonical;
}

async function readNoFollow(path, maxBytes) {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxBytes)) fail("Settings source file exceeds its bound");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (BigInt(bytes.byteLength) !== before.size || before.dev !== after.dev || before.ino !== after.ino
        || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      fail("Settings source file changed while being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function assertPrivateDirectory(path, create = false) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0
      || await realpath(path) !== path) {
    fail("Settings staging directory is not private and canonical");
  }
}

async function walkTree(root, { maxEntries, maxFiles, maxBytes }) {
  const files = [];
  const directories = [];
  let entriesVisited = 0;
  let totalBytes = 0;

  async function visit(directory, relativeDirectory, depth) {
    const directoryInfo = await lstat(directory);
    if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()
        || await realpath(directory) !== directory) {
      fail("Settings tree contains a symbolic or non-directory path");
    }
    directories.push(relativeDirectory);
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      entriesVisited += 1;
      if (entriesVisited > maxEntries) fail("Settings tree contains too many entries");
      const path = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (!safeRelativePath(path)) fail("Settings tree contains an unsafe path");
      const absolutePath = join(directory, entry.name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) fail("Settings tree symlinks are not allowed");
      if (info.isDirectory()) {
        if (depth + 1 > MAX_PATH_DEPTH) fail("Settings tree is too deep");
        await visit(absolutePath, path, depth + 1);
        continue;
      }
      if (!info.isFile()) fail("Settings tree contains an unsupported entry");
      if (files.length >= maxFiles) fail("Settings tree contains too many files");
      totalBytes += info.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxBytes) fail("Settings tree exceeds its byte bound");
      files.push({ path, absolutePath, bytes: info.size });
    }
  }

  await visit(root, "", 0);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  directories.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { files, directories, totalBytes };
}

async function hashTreeFiles(files, perFileLimit) {
  const results = [];
  let totalBytes = 0;
  for (const file of files) {
    const bytes = await readNoFollow(file.absolutePath, Math.min(perFileLimit, file.bytes));
    if (bytes.byteLength !== file.bytes) fail("Settings source file size changed");
    totalBytes += bytes.byteLength;
    results.push({ path: file.path, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  return { files: results, totalBytes, sha256: digestFiles(results) };
}

function digestFiles(files) {
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file.path}\0${file.bytes}\0${file.sha256}\0`);
  return digest.digest("hex");
}

function assertHostBridgeRecord(record, actual) {
  if (!record || typeof record !== "object" || Array.isArray(record)
      || record.root !== actual.rootPath || record.count !== actual.count
      || record.bytes !== actual.bytes || record.sha256 !== actual.sha256
      || !Array.isArray(record.files) || !Array.isArray(record.runtimeImports)) {
    fail("Settings provenance host bridge source record is invalid");
  }
  const actualFiles = actual.files.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash }));
  if (JSON.stringify(record.files) !== JSON.stringify(actualFiles)) {
    fail("Settings provenance host bridge sources differ from current TypeScript files");
  }
  const allowed = new Set(actualFiles.map(file => file.path));
  if (record.runtimeImports.some(path => typeof path !== "string" || !allowed.has(path))) {
    fail("Settings provenance contains an unlisted host bridge runtime import");
  }
  if (new Set(record.runtimeImports).size !== record.runtimeImports.length
      || JSON.stringify(record.runtimeImports) !== JSON.stringify([...record.runtimeImports].sort())) {
    fail("Settings provenance host bridge runtime imports are not canonical");
  }
  const bridgeEntryPath = actualFiles.find(file => file.path.endsWith("/hostBridgeEntry.ts"))?.path;
  if (!bridgeEntryPath || !record.runtimeImports.includes(bridgeEntryPath)) {
    fail("Settings provenance does not bind the host bridge entry");
  }
}

function resourceMime(path) {
  const extension = extname(path).slice(1);
  return new Set(["html", "js", "css", "svg", "png", "json"]).has(extension) ? extension : null;
}

function validateResourceManifest(provenance, budgetPolicy) {
  const resources = provenance.emittedResources;
  if (!Array.isArray(resources) || resources.length < 3 || resources.length > MAX_EMITTED_RESOURCES
      || provenance.emittedResourceCount !== resources.length) {
    fail("Settings emitted resource count is invalid");
  }
  const seen = new Set();
  const specs = [];
  let totalBytes = 0;
  let hasIndex = false;
  let hasJavaScript = false;
  let hasCss = false;
  for (const resource of resources) {
    const { path, bytes, sha256: hash } = resource ?? {};
    if (!safeRelativePath(path) || DIST_METADATA.includes(path) || seen.has(path) || !resourceMime(path)) {
      fail("Settings emitted resource path is unsafe or duplicated");
    }
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash)) {
      fail("Settings emitted resource hash or size is invalid");
    }
    seen.add(path);
    totalBytes += bytes;
    if (!Number.isSafeInteger(totalBytes)
        || totalBytes > Math.min(budgetPolicy.maxBytes, budgetPolicy.baselineBytes + budgetPolicy.maxIncreaseBytes)) {
      fail("Settings emitted resources exceed the fixed byte budget");
    }
    hasIndex ||= path === "index.html";
    hasJavaScript ||= resourceMime(path) === "js";
    hasCss ||= resourceMime(path) === "css";
    specs.push({ path, bytes, sha256: hash });
  }
  if (!hasIndex || !hasJavaScript || !hasCss || provenance.emittedResourceTotalBytes !== totalBytes) {
    fail("Settings emitted resource total or required entry resources are invalid");
  }

  const budget = provenance.bundleBudget;
  const expectedIncrease = totalBytes - budgetPolicy.baselineBytes;
  if (!budget || budget.metric !== budgetPolicy.metric
      || budget.actualBytes !== totalBytes || budget.baselineBytes !== budgetPolicy.baselineBytes
      || budget.maxIncreaseBytes !== budgetPolicy.maxIncreaseBytes
      || budget.maxBytes !== budgetPolicy.maxBytes
      || budget.increaseBytes !== expectedIncrease || budget.passed !== true
      || expectedIncrease > budgetPolicy.maxIncreaseBytes
      || totalBytes > budgetPolicy.maxBytes
      || totalBytes > Math.min(budgetPolicy.maxBytes, budgetPolicy.baselineBytes + budgetPolicy.maxIncreaseBytes)) {
    fail("Settings bundle budget metadata does not match computed resource bytes");
  }
  return { specs, totalBytes, paths: seen };
}

async function inspectSettingsBundle(distRoot, actualHostSources, packageFiles) {
  const canonicalDist = await canonicalDirectory(distRoot);
  let sourceManifest;
  let provenanceBytes;
  let provenance;
  try {
    const manifestBytes = await readNoFollow(join(canonicalDist, "source-manifest.json"), MAX_PROVENANCE_BYTES);
    sourceManifest = JSON.parse(manifestBytes.toString("utf8"));
    provenanceBytes = await readNoFollow(join(canonicalDist, "build-provenance.json"), MAX_PROVENANCE_BYTES);
    provenance = JSON.parse(provenanceBytes.toString("utf8"));
  } catch {
    fail("Strict settings source manifest or build provenance is missing or invalid");
  }
  if (provenance?.schemaVersion !== 1 || provenance.artifactOwner !== STRICT_ARTIFACT_OWNER
      || provenance.status !== STRICT_STATUS || provenance.typecheckPassed !== true
      || provenance.source?.commit !== PINNED_SOURCE_COMMIT
      || provenance.source?.workingTreeClean !== true
      || provenance.build?.typecheckPassed !== true) {
    fail("Settings dist is not the pinned strict typechecked source build");
  }

  assertHostBridgeRecord(provenance.build.hostBridgeSources, actualHostSources);
  assertCurrentSettingsBuildInputs(sourceManifest, provenance, packageFiles);
  const budgetPolicy = frozenSettingsResourceBudget(sourceManifest, PINNED_SOURCE_COMMIT);
  const { specs, totalBytes, paths } = validateResourceManifest(provenance, budgetPolicy);
  const expected = new Set([...paths, ...DIST_METADATA]);
  const tree = await walkTree(canonicalDist, {
    maxEntries: MAX_DIST_ENTRIES,
    maxFiles: MAX_DIST_FILES,
    maxBytes: MAX_DIST_BYTES,
  });
  const actualPaths = new Set(tree.files.map(file => file.path));
  if (actualPaths.size !== expected.size || [...expected].some(path => !actualPaths.has(path))) {
    fail("Settings dist files do not exactly match the strict resource inventory and metadata");
  }
  for (const directory of tree.directories.filter(Boolean)) {
    if (![...expected].some(path => path.startsWith(`${directory}/`))) {
      fail("Settings dist contains an unlisted directory");
    }
  }

  const specByPath = new Map(specs.map(spec => [spec.path, spec]));
  const files = [];
  let verifiedResourceBytes = 0;
  let hasNonemptyIndex = false;
  let hasNonemptyJs = false;
  let hasNonemptyCss = false;
  for (const file of tree.files) {
    const spec = specByPath.get(file.path);
    const maxBytes = spec?.bytes ?? 512 * 1024;
    const bytes = await readNoFollow(file.absolutePath, maxBytes);
    const hash = sha256(bytes);
    if (bytes.byteLength !== file.bytes) fail("Settings dist file changed while being read");
    if (spec && (bytes.byteLength !== spec.bytes || hash !== spec.sha256)) {
      fail("Settings dist resource differs from strict build provenance");
    }
    if (spec) {
      verifiedResourceBytes += bytes.byteLength;
      hasNonemptyIndex ||= file.path === "index.html" && bytes.byteLength > 0;
      hasNonemptyJs ||= resourceMime(file.path) === "js" && bytes.byteLength > 0;
      hasNonemptyCss ||= resourceMime(file.path) === "css" && bytes.byteLength > 0;
    }
    files.push({ path: file.path, bytes: bytes.byteLength, sha256: hash });
  }
  if (verifiedResourceBytes !== totalBytes || !hasNonemptyIndex || !hasNonemptyJs || !hasNonemptyCss) {
    fail("Settings dist required resources are empty or exceed their declared total");
  }
  const fileBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    root: canonicalDist,
    files,
    fileCount: files.length,
    totalBytes: fileBytes,
    sha256: digestFiles(files),
    provenanceSha256: sha256(provenanceBytes),
    resourceCount: specs.length,
    resourceBytes: totalBytes,
    resourceFiles: files.filter(file => specByPath.has(file.path)),
    hostBridgeSources: actualHostSources,
  };
}

export async function captureSettingsNativeSources(repositoryRoot, { settingsDist } = {}) {
  try {
    return await captureSettingsNativeSourcesUnchecked(repositoryRoot, settingsDist);
  } catch (error) {
    if (typeof error?.message === "string" && error.message.startsWith("Settings ")) throw error;
    fail("Settings source validation failed");
  }
}

async function captureSettingsNativeSourcesUnchecked(repositoryRoot, settingsDist) {
  const root = await canonicalDirectory(repositoryRoot);
  const packageRoot = await canonicalDirectory(join(root, "packages/ztools-settings"));
  const expectedDist = join(packageRoot, "dist");
  const distPath = settingsDist ?? expectedDist;
  if (!isAbsolute(distPath) || resolve(distPath) !== expectedDist) {
    fail("Settings dist path must be the fixed package dist directory");
  }
  const distRoot = await canonicalDirectory(distPath, expectedDist);
  const sourceRoot = await canonicalDirectory(join(packageRoot, "src"));
  const sourceTree = await walkTree(sourceRoot, {
    maxEntries: 256,
    maxFiles: MAX_SOURCE_FILES,
    maxBytes: MAX_SOURCE_BYTES,
  });
  const sourceRecords = await hashTreeFiles(sourceTree.files, MAX_SOURCE_BYTES);
  const metadataFiles = [];
  for (const path of ["package.json", "package-lock.json", "build.mjs", "source-manifest.json"]) {
    const absolutePath = join(packageRoot, path);
    const info = await lstat(absolutePath);
    if (info.isSymbolicLink() || !info.isFile()) fail("Settings build input is not a regular file");
    metadataFiles.push({ path: `packages/ztools-settings/${path}`, absolutePath, bytes: info.size });
  }
  const metadataRecords = await hashTreeFiles(metadataFiles, 1024 * 1024);
  const packageFiles = [
    ...sourceRecords.files.map(file => ({ ...file, path: `packages/ztools-settings/src/${file.path}` })),
    ...metadataRecords.files,
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const packageBytes = packageFiles.reduce((sum, file) => sum + file.bytes, 0);
  const packageDigest = digestFiles(packageFiles);
  const hostBridgeSources = await captureHostBridgeSources(root);
  const bundle = await inspectSettingsBundle(distRoot, hostBridgeSources, packageFiles);
  const combined = [
    `package\0${packageDigest}\0`,
    `host-bridge\0${hostBridgeSources.sha256}\0`,
    `dist\0${bundle.sha256}\0`,
    `provenance\0${bundle.provenanceSha256}\0`,
  ].join("");
  return {
    repositoryRoot: root,
    packageRoot,
    distRoot,
    packageFiles,
    packageFileCount: packageFiles.length,
    packageBytes,
    packageSha256: packageDigest,
    hostBridgeSources,
    bundle,
    sha256: sha256(Buffer.from(combined)),
  };
}

export function summarizeSettingsNativeSources(snapshot) {
  if (!snapshot) return null;
  return {
    sha256: snapshot.sha256,
    packageFileCount: snapshot.packageFileCount,
    packageBytes: snapshot.packageBytes,
    packageSha256: snapshot.packageSha256,
    hostBridgeSourceCount: snapshot.hostBridgeSources.count,
    hostBridgeSourceBytes: snapshot.hostBridgeSources.bytes,
    hostBridgeSourcesSha256: snapshot.hostBridgeSources.sha256,
    distFileCount: snapshot.bundle.fileCount,
    distBytes: snapshot.bundle.totalBytes,
    distSha256: snapshot.bundle.sha256,
    provenanceSha256: snapshot.bundle.provenanceSha256,
    resourceCount: snapshot.bundle.resourceCount,
    resourceBytes: snapshot.bundle.resourceBytes,
  };
}

export function settingsNativeSourcesEqual(left, right) {
  return Boolean(left && right) && left.sha256 === right.sha256
    && left.packageSha256 === right.packageSha256
    && left.hostBridgeSources.sha256 === right.hostBridgeSources.sha256
    && left.bundle.sha256 === right.bundle.sha256
    && left.bundle.provenanceSha256 === right.bundle.provenanceSha256;
}

export async function assertSettingsNativeSourcesUnchanged(snapshot) {
  let current;
  try {
    current = await captureSettingsNativeSources(snapshot.repositoryRoot, { settingsDist: snapshot.distRoot });
  } catch {
    fail("Settings source or dist changed during native acceptance");
  }
  if (!settingsNativeSourcesEqual(snapshot, current)) fail("Settings source or dist changed during native acceptance");
  return current;
}

export async function stageSettingsNativeBundle({ snapshot, appBundlePath }) {
  try {
    return await stageSettingsNativeBundleUnchecked({ snapshot, appBundlePath });
  } catch (error) {
    if (typeof error?.message === "string"
        && (error.message.startsWith("Settings ") || error.message.startsWith("Native app resources"))) throw error;
    fail("Settings native resources could not be staged safely");
  }
}

async function stageSettingsNativeBundleUnchecked({ snapshot, appBundlePath }) {
  if (!snapshot || typeof appBundlePath !== "string" || !isAbsolute(appBundlePath)) {
    fail("Settings native staging requires a captured source and absolute app bundle");
  }
  await assertSettingsNativeSourcesUnchanged(snapshot);
  const resourcesRoot = join(appBundlePath, "Contents/Resources");
  const resourceInfo = await lstat(resourcesRoot);
  if (!resourceInfo.isDirectory() || resourceInfo.isSymbolicLink() || (resourceInfo.mode & 0o077) !== 0
      || await realpath(resourcesRoot) !== resourcesRoot) fail("Native app resources directory is not trusted");
  const targetRoot = join(resourcesRoot, "ztools-settings");
  await mkdir(targetRoot, { mode: 0o700 });
  await assertPrivateDirectory(targetRoot);
  for (const file of snapshot.bundle.files) {
    const sourcePath = join(snapshot.distRoot, ...file.path.split("/"));
    const bytes = await readNoFollow(sourcePath, file.bytes);
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      fail("Settings dist changed while staging the native app");
    }
    const targetPath = join(targetRoot, ...file.path.split("/"));
    let parentPath = targetRoot;
    for (const segment of file.path.split("/").slice(0, -1)) {
      parentPath = join(parentPath, segment);
      await assertPrivateDirectory(parentPath, true);
    }
    await writeFile(targetPath, bytes, { flag: "wx", mode: 0o600 });
    const targetInfo = await lstat(targetPath);
    if (!targetInfo.isFile() || targetInfo.isSymbolicLink() || (targetInfo.mode & 0o077) !== 0) {
      fail("Staged settings resource is not a private regular file");
    }
  }
  const current = await assertSettingsNativeSourcesUnchanged(snapshot);
  if (current.bundle.sha256 !== snapshot.bundle.sha256) fail("Settings dist changed during native staging");
  const stagedTree = await walkTree(targetRoot, {
    maxEntries: MAX_DIST_ENTRIES,
    maxFiles: MAX_DIST_FILES,
    maxBytes: MAX_DIST_BYTES,
  });
  const stagedFiles = await hashTreeFiles(stagedTree.files, MAX_DIST_BYTES);
  const expectedFiles = snapshot.bundle.files.map(({ path, bytes, sha256: hash }) => ({ path, bytes, sha256: hash }));
  if (stagedTree.totalBytes !== snapshot.bundle.totalBytes
      || JSON.stringify(stagedFiles.files) !== JSON.stringify(expectedFiles)) {
    fail("Staged settings bundle differs from the verified package dist");
  }
  return {
    resourcePath: "Contents/Resources/ztools-settings",
    resourceCount: snapshot.bundle.resourceCount,
    resourceBytes: snapshot.bundle.resourceBytes,
    fileCount: stagedFiles.files.length,
    distSha256: snapshot.bundle.sha256,
    provenanceSha256: snapshot.bundle.provenanceSha256,
  };
}

