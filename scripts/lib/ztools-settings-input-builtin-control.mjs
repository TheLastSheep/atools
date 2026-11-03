import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { open, mkdir, lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const TIMESTAMP_BUILTIN_RESOURCE_PATH = "plugins/builtin/timestamp";
export const TIMESTAMP_BUILTIN_SOURCE_FILES = Object.freeze([
  "resources/plugins/builtin/timestamp/index.html",
  "resources/plugins/builtin/timestamp/logo.svg",
  "resources/plugins/builtin/timestamp/plugin.json",
]);

const SOURCE_ROOT = join(resolve(fileURLToPath(new URL("../../", import.meta.url))),
  "resources/plugins/builtin/timestamp");
const FILE_NAMES = Object.freeze(TIMESTAMP_BUILTIN_SOURCE_FILES.map(path => path.split("/").at(-1)));
const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const PRIVATE_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

function fail(message) {
  throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fileIdentity(info) {
  return `${String(info.dev)}:${String(info.ino)}`;
}

function validateExpectedHashes(sourceHashes) {
  if (!isRecord(sourceHashes)) fail("Timestamp builtin source snapshot is missing");
  const expected = Object.create(null);
  for (let index = 0; index < TIMESTAMP_BUILTIN_SOURCE_FILES.length; index += 1) {
    const sourcePath = TIMESTAMP_BUILTIN_SOURCE_FILES[index];
    const descriptor = Object.getOwnPropertyDescriptor(sourceHashes, sourcePath);
    if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "string"
        || !/^[0-9a-f]{64}$/.test(descriptor.value)) {
      fail("Timestamp builtin source snapshot is incomplete");
    }
    expected[FILE_NAMES[index]] = descriptor.value;
  }
  return expected;
}

async function validateDirectory(path, privateDirectory) {
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()
      || (privateDirectory && Number(info.mode & 0o777n) !== PRIVATE_MODE)
      || await realpath(path) !== path) {
    fail("Timestamp builtin directory is not canonical and safe");
  }
  return info;
}

async function readNoFollow(path, expectedHash, expectedMode = null) {
  const before = await lstat(path, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n
      || before.size <= 0n || before.size > BigInt(MAX_FILE_BYTES)
      || (expectedMode !== null && Number(before.mode & 0o777n) !== expectedMode)) {
    fail("Timestamp builtin file is not a bounded unlinked regular file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || fileIdentity(before) !== fileIdentity(opened)) {
      fail("Timestamp builtin file changed while opening");
    }
    const bytes = await handle.readFile();
    const after = await lstat(path, { bigint: true });
    if (after.isSymbolicLink() || !after.isFile() || after.nlink !== 1n
        || fileIdentity(opened) !== fileIdentity(after) || bytes.byteLength !== Number(opened.size)
        || bytes.byteLength > MAX_FILE_BYTES || sha256(bytes) !== expectedHash) {
      fail("Timestamp builtin file differs from its captured source");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function cleanupCreated(files, directories) {
  for (const item of files.reverse()) {
    try {
      const current = await lstat(item.path, { bigint: true });
      if (!current.isSymbolicLink() && current.isFile() && current.nlink === 1n
          && fileIdentity(current) === item.identity) await unlink(item.path);
    } catch {}
  }
  for (const item of directories.reverse()) {
    try {
      const current = await lstat(item.path, { bigint: true });
      if (!current.isSymbolicLink() && current.isDirectory()
          && fileIdentity(current) === item.identity) await rmdir(item.path);
    } catch {}
  }
}

/** Fixed-root production entry point; the source hashes come from the runner's pre-captured fixture lock. */
export async function stageTimestampBuiltinControl({ appResourcesPath, sourceHashes }) {
  return stageBuiltinControlFiles({ sourceRoot: SOURCE_ROOT, appResourcesPath, sourceHashes });
}

/** Low-level bounded copier exposed for isolated filesystem tests; production uses the fixed-root entry point. */
export async function stageBuiltinControlFiles({ sourceRoot, appResourcesPath, sourceHashes }) {
  if (typeof sourceRoot !== "string" || !isAbsolute(sourceRoot) || normalize(sourceRoot) !== sourceRoot
      || typeof appResourcesPath !== "string" || !isAbsolute(appResourcesPath)
      || normalize(appResourcesPath) !== appResourcesPath) {
    fail("Timestamp builtin staging paths must be canonical absolute paths");
  }
  const expectedHashes = validateExpectedHashes(sourceHashes);
  const canonicalSource = await realpath(sourceRoot);
  if (canonicalSource !== sourceRoot) fail("Timestamp builtin source root must be canonical");
  await validateDirectory(canonicalSource, false);
  await validateDirectory(appResourcesPath, true);

  const entries = await readdir(canonicalSource, { withFileTypes: true });
  const names = entries.map(entry => entry.name).sort();
  if (names.length !== FILE_NAMES.length || names.some((name, index) => name !== [...FILE_NAMES].sort()[index])
      || entries.some(entry => !entry.isFile())) {
    fail("Timestamp builtin source file set is not exact");
  }

  const stagedSourceFiles = [];
  let totalBytes = 0;
  for (let index = 0; index < TIMESTAMP_BUILTIN_SOURCE_FILES.length; index += 1) {
    const name = FILE_NAMES[index];
    const bytes = await readNoFollow(join(canonicalSource, name), expectedHashes[name]);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_TOTAL_BYTES) fail("Timestamp builtin source exceeds its total byte limit");
    stagedSourceFiles.push({ path: name, bytes, sha256: expectedHashes[name] });
  }
  const afterReadNames = (await readdir(canonicalSource)).sort();
  if (afterReadNames.length !== names.length || afterReadNames.some((name, index) => name !== names[index])) {
    fail("Timestamp builtin source file set changed during capture");
  }

  const createdDirectories = [];
  const createdFiles = [];
  let complete = false;
  try {
    let directory = appResourcesPath;
    for (const segment of TIMESTAMP_BUILTIN_RESOURCE_PATH.split("/")) {
      directory = join(directory, segment);
      await mkdir(directory, { mode: PRIVATE_MODE });
      const info = await validateDirectory(directory, true);
      createdDirectories.push({ path: directory, identity: fileIdentity(info) });
    }

    const files = [];
    for (const source of stagedSourceFiles) {
      const targetPath = join(directory, source.path);
      const handle = await open(targetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        PRIVATE_FILE_MODE);
      try {
        const info = await handle.stat({ bigint: true });
        if (!info.isFile() || info.nlink !== 1n) fail("Staged timestamp file is not a new regular file");
        createdFiles.push({ path: targetPath, identity: fileIdentity(info) });
        await handle.writeFile(source.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const bytes = await readNoFollow(targetPath, source.sha256, PRIVATE_FILE_MODE);
      if (bytes.byteLength !== source.bytes.byteLength) fail("Staged timestamp file size changed");
      files.push({ path: source.path, bytes: bytes.byteLength, sha256: sha256(bytes) });
    }

    await validateDirectory(join(appResourcesPath, TIMESTAMP_BUILTIN_RESOURCE_PATH), true);
    complete = true;
    return {
      resourcePath: `Contents/Resources/${TIMESTAMP_BUILTIN_RESOURCE_PATH}`,
      fileCount: files.length,
      resourceBytes: totalBytes,
      files,
    };
  } finally {
    if (!complete) await cleanupCreated(createdFiles, createdDirectories);
  }
}
