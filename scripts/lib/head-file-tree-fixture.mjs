import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";
import { materializePinnedHeadPackage, readPinnedHeadPackage } from "./head-local-package-fixture.mjs";

export const HEAD_FILE_TREE_CASE_ID = "local-file-tree-head";
export const HEAD_FILE_TREE_COMMIT = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
export const HEAD_FILE_TREE_TREE = "94c40ccda8babdc2b1c900cdaa31eeda28b56b4a";
export const HEAD_FILE_TREE_DIRECTORY_SHA256 = "01f6804db14c5b7629674f6fb532cc59be65213e5ae14fab247ed8a51bd14a0a";
const REGISTRY_SHA256 = "f2ea75e34315265404b72759ae2a92050de0374aa954d19b617afe817b035e24";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMODULE = "ZTools-plugins";
const REGISTRY = path.resolve(REPO_ROOT, "tests/fixtures/head-file-tree-cases.json");

export async function readHeadFileTreeProfile() {
  const bytes = await readFile(REGISTRY);
  if (createHash("sha256").update(bytes).digest("hex") !== REGISTRY_SHA256) throw Error("FileTree HEAD fixture registry differs from its reviewed bytes");
  const registry = JSON.parse(bytes.toString("utf8"));
  if (registry.schemaVersion !== 1 || registry.repository !== "ZTools-plugins" || registry.commit !== HEAD_FILE_TREE_COMMIT
    || registry.packageTree !== HEAD_FILE_TREE_TREE || registry.directorySha256 !== HEAD_FILE_TREE_DIRECTORY_SHA256
    || registry.packagePath !== "plugins/file-tree" || registry.fileCount !== 12 || registry.directoryCount !== 0
    || registry.expandedBytes !== 460425 || !Array.isArray(registry.cases)) {
    throw Error("Invalid FileTree HEAD fixture registry");
  }
  const profile = registry.cases.find(item => item.caseId === HEAD_FILE_TREE_CASE_ID);
  if (!profile || profile.sourceCommit !== HEAD_FILE_TREE_COMMIT || profile.sourceTree !== HEAD_FILE_TREE_TREE
    || profile.directorySha256 !== HEAD_FILE_TREE_DIRECTORY_SHA256 || profile.id !== "file-tree" || profile.version !== "1.0.5" || profile.sourceCommit !== registry.commit
    || profile.sourceTree !== registry.packageTree || profile.directorySha256 !== registry.directorySha256
    || profile.fileCount !== registry.fileCount || profile.runtime !== "node" || profile.featureCode !== "file-tree"
    || profile.pathAccess !== "legacy-node-file-read" || profile.dataAccess !== false) {
    throw Error("FileTree HEAD profile differs from its pinned registry");
  }
  return { registry, profile };
}

export async function readHeadFileTree(repositoryRoot = REPO_ROOT) {
  const { registry } = await readHeadFileTreeProfile();
  const source = readPinnedHeadPackage({ repositoryRoot, submodule: SUBMODULE, commit: registry.commit,
    packagePath: registry.packagePath, packageTree: registry.packageTree, directorySha256: registry.directorySha256,
    files: registry.files, directories: [] });
  const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
  const features = manifest.features?.filter(item => item.code === "file-tree") ?? [];
  const feature = features[0];
  const filesCommands = feature?.cmds?.filter(item => item?.type === "files") ?? [];
  const filesCommand = filesCommands[0];
  if (manifest.name !== "file-tree" || manifest.version !== "1.0.5" || manifest.main !== "index.html"
    || manifest.preload !== "preload.js" || features.length !== 1 || filesCommands.length !== 1
    || filesCommand.fileType !== "directory" || filesCommand.minLength !== 1 || filesCommand.maxLength !== 1) {
    throw Error("FileTree HEAD manifest differs from the registered files-entry contract");
  }
  return source;
}

function sourceReview(profile, sourceRoot, ownedRoot, witness, identity) {
  return {
    schemaVersion: 1, sourceKind: "local_full_directory", status: profile.sourceReviewStatus,
    profile: { caseId: profile.caseId, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: profile.directorySha256, fileCount: profile.fileCount },
    fixture: { id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, ownedRoot, sourceRoot,
      pluginRoot: path.join(ownedRoot, "file-tree"), files: witness.files, directories: witness.directories,
      sourceRevision: { repository: "ZTools-plugins", commit: identity.commit, tree: identity.tree, packagePath: "plugins/file-tree" } },
    sourceInspection: { revision: identity.commit, tree: identity.tree,
      reviewScope: "Exact FileTree package blobs read from the registered ZTools-plugins Git HEAD; dirty working-tree files are not used.",
      boundary: "Source provenance only; it does not imply installation or plugin execution." },
    verificationBoundary: "The copied package is checked against the registered Git blob list and local tree digest; runtime acceptance is a separate fixture result.",
  };
}

export async function prepareHeadFileTreeFixture({ temporaryParent = "/private/tmp", repositoryRoot = REPO_ROOT } = {}) {
  const { profile } = await readHeadFileTreeProfile();
  const source = await readHeadFileTree(repositoryRoot);
  const staged = await materializePinnedHeadPackage(source, { temporaryParent,
    prefix: "atools-head-file-tree-", packageName: "file-tree" });
  try {
    const sourceAfter = await readHeadFileTree(repositoryRoot);
    if (sourceAfter.commit !== source.commit || sourceAfter.tree !== source.tree) throw Error("FileTree HEAD moved while staging the fixture");
    const review = sourceReview(profile, `git:${source.commit}:${SUBMODULE}/plugins/file-tree`, staged.ownedRoot, staged.witness, source);
    const sourceReviewJSON = path.join(staged.ownedRoot, "source-review.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(sourceReviewJSON, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { profile, fixture: { ownedRoot: staged.ownedRoot, pluginRoot: staged.packageRoot,
      pluginSourcesRoot: staged.ownedRoot, sourceRoot: review.fixture.sourceRoot, sourceReviewJSON,
      id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: staged.witness.directorySha256, fileCount: staged.witness.fileCount,
      files: staged.witness.files, directories: staged.witness.directories }, review, cleanup: staged.cleanup };
  } catch (error) { await staged.cleanup(); throw error; }
}

export async function verifyHeadFileTreeFixture(fixture, repositoryRoot = REPO_ROOT) {
  const { profile } = await readHeadFileTreeProfile();
  const source = await readHeadFileTree(repositoryRoot);
  if (fixture?.id !== profile.id || fixture?.version !== profile.version || fixture?.directorySha256 !== profile.directorySha256
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-head-file-tree-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "file-tree")) throw Error("FileTree HEAD fixture identity differs from its registered profile");
  const copied = await scanLocalDirectory(fixture.pluginRoot);
  const witness = summarizeLocalTree(copied.files, copied.directories);
  const exact = witness.directorySha256 === profile.directorySha256
    && JSON.stringify(witness.files) === JSON.stringify(source.witness.files)
    && JSON.stringify(witness.directories) === JSON.stringify(source.witness.directories);
  if (!exact) throw Error("FileTree fixture differs from the registered HEAD blobs");
  return { sourceCommit: source.commit, sourceTree: source.tree, directorySha256: witness.directorySha256,
    fileCount: witness.fileCount, expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    files: witness.files, fixtureBytesMatchPinnedSource: true };
}
