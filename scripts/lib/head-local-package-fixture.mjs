import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";

function git(repositoryRoot, submodule, args) {
  try { return execFileSync("git", ["-C", path.join(repositoryRoot, submodule), ...args], {
    maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"],
  }); } catch { throw Error("Pinned plugin HEAD source is unavailable"); }
}

/** Read an exact, reviewed package from a pinned submodule commit, never from its working tree. */
export function readPinnedHeadPackage({ repositoryRoot, submodule, commit, packagePath, packageTree, directorySha256, files, directories = [] }) {
  const identity = () => {
    const actualCommit = git(repositoryRoot, submodule, ["rev-parse", "HEAD"]).toString("ascii").trim();
    const actualTree = git(repositoryRoot, submodule, ["rev-parse", `HEAD:${packagePath}`]).toString("ascii").trim();
    if (actualCommit !== commit || actualTree !== packageTree) throw Error("Plugin Git HEAD or package tree differs from the pinned revision");
    return { commit: actualCommit, tree: actualTree };
  };
  const before = identity();
  const rows = git(repositoryRoot, submodule, ["ls-tree", "-r", "-z", "--full-tree", commit, "--", packagePath])
    .toString("utf8").split("\0").filter(Boolean);
  const prefix = `${packagePath}/`;
  const objects = new Map();
  for (const row of rows) {
    const [metadata, repoPath] = row.split("\t");
    const [mode, kind, oid] = metadata.split(" ");
    const relative = repoPath?.startsWith(prefix) ? repoPath.slice(prefix.length) : "";
    const parts = relative.split("/");
    if (!relative || relative.startsWith("/") || parts.some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))
      || kind !== "blob" || !["100644", "100755"].includes(mode)
      || !Object.hasOwn(files, relative) || objects.has(relative)) throw Error("Pinned plugin contains an unregistered path or file type");
    const bytes = git(repositoryRoot, submodule, ["cat-file", "blob", oid]);
    const actual = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const expected = typeof files[relative] === "string" ? { sha256: files[relative] } : files[relative];
    if (actual.sha256 !== expected.sha256 || (expected.bytes !== undefined && actual.bytes !== expected.bytes)) throw Error("Pinned plugin Git blob differs from its registered bytes or SHA-256");
    objects.set(relative, bytes);
  }
  if (objects.size !== Object.keys(files).length) throw Error("Pinned plugin file set differs from its registered list");
  const witness = summarizeLocalTree(objects, new Set(directories));
  if (witness.directorySha256 !== directorySha256 || witness.fileCount !== Object.keys(files).length) throw Error("Pinned plugin directory digest differs from its registration");
  const after = identity();
  if (before.commit !== after.commit || before.tree !== after.tree) throw Error("Plugin Git HEAD moved while reading its source blobs");
  return { ...after, files: objects, witness };
}

/** Copy only a pinned blob map into a fresh private tree and prove the copied digest. */
export async function materializePinnedHeadPackage(source, { temporaryParent = "/private/tmp", prefix = "atools-local-plugin-fixture-", packageName = "plugin" } = {}) {
  const parent = await realpath(temporaryParent);
  const privateRoots = await Promise.all(["/private/tmp", tmpdir()].map(value => realpath(value)));
  const within = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
  };
  if (parent !== path.resolve(temporaryParent) || !privateRoots.some(base => within(base, parent))) {
    throw Error("HEAD fixture parent must be a canonical private temporary directory");
  }
  const ownedRoot = await mkdtemp(path.join(parent, prefix));
  await chmod(ownedRoot, 0o700);
  const packageRoot = path.join(ownedRoot, packageName);
  try {
    await mkdir(packageRoot, { recursive: false, mode: 0o700 });
    await chmod(packageRoot, 0o700);
    for (const relative of source.witness.directories) {
      const directory = path.join(packageRoot, ...relative.split("/"));
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    for (const [relative, bytes] of source.files) {
      const parts = relative.split("/");
      if (!relative || relative.startsWith("/") || parts.some(part => !part || part === "." || part === ".." || /[\u0000-\u001f\u007f]/.test(part))) {
        throw Error("Pinned plugin staging path is invalid");
      }
      const destination = path.join(packageRoot, ...parts);
      await writeFile(destination, bytes, { flag: "wx", mode: 0o600 });
      await chmod(destination, 0o600);
    }
    const copied = await scanLocalDirectory(packageRoot);
    const witness = summarizeLocalTree(copied.files, copied.directories);
    if (witness.directorySha256 !== source.witness.directorySha256
      || JSON.stringify(witness.files) !== JSON.stringify(source.witness.files)
      || JSON.stringify(witness.directories) !== JSON.stringify(source.witness.directories)) throw Error("Copied HEAD package differs from its pinned blob map");
    return { ownedRoot, packageRoot, files: copied.files, witness, cleanup: async () => rm(ownedRoot, { recursive: true, force: true }) };
  } catch (error) { await rm(ownedRoot, { recursive: true, force: true }); throw error; }
}
