import { constants, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { access, lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, relative, sep } from "node:path";

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function workspacePath(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join("/");
}

async function collectRegularFiles(directory, includeFile) {
  const found = [];
  async function walk(current) {
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Native source tree contains a non-directory path");
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Native source tree contains a symbolic link");
      if (entry.isDirectory() && ["target", "output"].includes(entry.name)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && includeFile(path)) found.push(path);
      else if (!entry.isFile()) throw new Error("Native source tree contains a non-regular entry");
    }
  }
  await walk(directory);
  return found;
}

async function addExistingFile(root, relativePath, output) {
  let parent = root;
  for (const component of relativePath.split("/").slice(0, -1)) {
    parent = join(parent, component);
    const parentInfo = await lstat(parent).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!parentInfo) return;
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) throw new Error("Native build input path contains a symbolic link");
  }
  const absolutePath = join(parent, relativePath.split("/").at(-1));
  const info = await lstat(absolutePath).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Native build input is not a regular file");
  output.push(absolutePath);
}

async function nativeInputFiles(root) {
  const files = [];
  files.push(...await collectRegularFiles(join(root, "src-tauri/src"), () => true));
  files.push(...await collectRegularFiles(join(root, "src-tauri/capabilities"), () => true));
  files.push(...await collectRegularFiles(join(root, "src-tauri/icons"), () => true));
  files.push(...await collectRegularFiles(join(root, "crates"), path => [".rs", ".toml"].includes(extname(path))));

  for (const path of [
    "Cargo.toml",
    "Cargo.lock",
    "src-tauri/build.rs",
    "src-tauri/Cargo.toml",
    "src-tauri/examples/ztools_renderer_desktop_smoke.rs",
    "src-tauri/examples/atools_owned_launch_probe.rs",
    "src-tauri/Entitlements.plist",
    ".cargo/config.toml",
    "rust-toolchain.toml",
  ]) await addExistingFile(root, path, files);

  const tauriRoot = join(root, "src-tauri");
  const tauriRootInfo = await lstat(tauriRoot);
  if (!tauriRootInfo.isDirectory() || tauriRootInfo.isSymbolicLink()) throw new Error("Tauri source root must be a real directory");
  for (const entry of await readdir(tauriRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("tauri.") || !entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Tauri config must be a regular file");
    files.push(join(tauriRoot, entry.name));
  }

  const unique = [...new Set(files)].sort((left, right) => workspacePath(root, left).localeCompare(workspacePath(root, right)));
  if (!unique.includes(join(root, "src-tauri/examples/ztools_renderer_desktop_smoke.rs"))) {
    throw new Error("The native renderer example source is missing");
  }
  if (unique.some(path => workspacePath(root, path).split("/").some(part => part === "target" || part === "output"))) {
    throw new Error("Native source closure must exclude output and target trees");
  }
  return unique;
}

async function fingerprintFile(path, relativePath, digest) {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("Native source input changed to a non-file");
    const fileDigest = createHash("sha256");
    digest.update(relativePath).update("\0");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      fileDigest.update(chunk);
      digest.update(chunk);
      bytes += chunk.byteLength;
    }
    digest.update("\0");
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new Error("Native source input changed while it was fingerprinted");
    }
    return { path: relativePath, sha256: fileDigest.digest("hex"), bytes };
  } finally {
    await handle.close();
  }
}

export async function fingerprintNativeExecutable(requestedPath) {
  if (typeof requestedPath !== "string" || !isAbsolute(requestedPath)) throw new Error("Native binary path must be absolute");
  const binaryPath = await realpath(requestedPath);
  const before = await stat(binaryPath, { bigint: true });
  if (!before.isFile()) throw new Error("Native binary must be a regular file");
  await access(binaryPath, constants.R_OK | constants.X_OK);
  if ((before.mode & 0o111n) === 0n) throw new Error("Native binary is not executable");
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(binaryPath)) digest.update(chunk);
  const after = await stat(binaryPath, { bigint: true });
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
    throw new Error("Native binary changed while its fingerprint was read");
  }
  return {
    path: binaryPath,
    sha256: digest.digest("hex"),
    sizeBytes: String(after.size),
    mtimeNs: String(after.mtimeNs),
    device: String(after.dev),
    inode: String(after.ino),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function summarizeNativeBuildReceipt(fileSnapshot) {
  const receipt = fileSnapshot?.value;
  if (!fileSnapshot?.exists || !receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    return {
      exists: fileSnapshot?.exists ?? false,
      validShape: false,
      schemaVersion: null,
      binarySha256: null,
      nativeSourcesSha256: null,
      nativeSourcesFileCount: null,
      nativeSourcesStable: false,
      contentSha256: null,
      exception: fileSnapshot?.exception ?? null,
    };
  }
  const canonical = JSON.stringify(canonicalJson(receipt));
  return {
    exists: true,
    validShape: true,
    schemaVersion: receipt.schemaVersion ?? null,
    binarySha256: receipt.binary?.sha256 ?? null,
    nativeSourcesSha256: receipt.nativeSources?.sha256 ?? null,
    nativeSourcesFileCount: receipt.nativeSources?.fileCount ?? null,
    nativeSourcesStable: receipt.nativeSources?.stable === true,
    contentSha256: createHash("sha256").update(canonical).digest("hex"),
    exception: null,
  };
}

export function validateNativeBuildReceipt(fileSnapshot, nativeSources, binarySha256) {
  const summary = summarizeNativeBuildReceipt(fileSnapshot);
  const errors = [];
  if (!summary.exists || !summary.validShape) errors.push("build-receipt-missing-or-invalid");
  if (summary.schemaVersion !== 1) errors.push("build-receipt-schema-version-mismatch");
  if (summary.binarySha256 !== binarySha256) errors.push("build-receipt-binary-sha-mismatch");
  if (summary.nativeSourcesSha256 !== nativeSources?.sha256
      || summary.nativeSourcesFileCount !== nativeSources?.fileCount) errors.push("build-receipt-native-source-mismatch");
  if (summary.nativeSourcesStable !== true) errors.push("build-receipt-native-sources-not-stable");
  return { valid: errors.length === 0, errors, summary };
}

/** Stable hash of the native build inputs. Only paths, hashes, byte counts, and the aggregate digest leave this function. */
export async function captureNativeSourceSnapshot(root) {
  if (typeof root !== "string" || !isAbsolute(root)) throw new Error("Workspace root must be absolute");
  const absoluteRoot = root.replace(/\/$/, "");
  const rootInfo = await lstat(absoluteRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Workspace root must be a real directory");
  const paths = await nativeInputFiles(absoluteRoot);
  const digest = createHash("sha256");
  const files = [];
  let totalBytes = 0;
  for (const path of paths) {
    const entry = await fingerprintFile(path, workspacePath(absoluteRoot, path), digest);
    files.push(entry);
    totalBytes += entry.bytes;
  }
  return { sha256: digest.digest("hex"), fileCount: files.length, totalBytes, files };
}

