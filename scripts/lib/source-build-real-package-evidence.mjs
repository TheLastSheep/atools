import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const excludedDirectories = new Set([".git", ".npm-cache", "dist", "node_modules", "release"]);
const hashBytes = bytes => createHash("sha256").update(bytes).digest("hex");
const MAX_SOURCE_FILES = 128;
const MAX_SOURCE_BYTES = 1024 * 1024;
const MAX_SOURCE_FILE_BYTES = 512 * 1024;

export async function sourcePackageManifest(root) {
  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), rel = relative(root, path);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(path);
      } else if (entry.isFile()) {
        const metadata = await lstat(path);
        if (metadata.size > MAX_SOURCE_FILE_BYTES || files.length >= MAX_SOURCE_FILES) {
          throw Error("Pinned source package exceeds its file or size budget");
        }
        const bytes = await readFile(path);
        totalBytes += bytes.length;
        if (totalBytes > MAX_SOURCE_BYTES) {
          throw Error("Pinned source package exceeds its total byte budget");
        }
        files.push({ path: rel.split(sep).join("/"), bytes: bytes.length, sha256: hashBytes(bytes) });
      } else {
        throw Error("Pinned source package contains an unsupported source entry");
      }
    }
  }
  await visit(root);
  const canonical = JSON.stringify(files);
  return { fileCount: files.length, bytes: totalBytes,
    manifestSha256: hashBytes(Buffer.from(canonical)), entries: files };
}

export async function fixtureSourceTreeHash(root) {
  const hash = createHash("sha256");
  let fileCount = 0, totalBytes = 0;
  async function visit(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name), rel = relative(root, path);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await visit(path);
      } else if (entry.isFile()) {
        const bytes = await readFile(path);
        fileCount += 1; totalBytes += bytes.length;
        if (fileCount > 1024 || totalBytes > 8 * 1024 * 1024) throw Error("Fixture tree exceeds its bounded evidence budget");
        hash.update(rel.split(sep).join("/")); hash.update("\0file\0");
        hash.update(String(bytes.length)); hash.update("\0"); hash.update(bytes);
      } else if ((await lstat(path)).isSymbolicLink()) {
        throw Error("Fixture source tree contains a symlink outside excluded dependency/output directories");
      } else {
        throw Error("Fixture source tree contains an unsupported entry");
      }
    }
  }
  await visit(root);
  return hash.digest("hex");
}
