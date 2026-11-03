import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";
import { materializePinnedHeadPackage, readPinnedHeadPackage } from "./head-local-package-fixture.mjs";

export const RANDOM_DATA_HEAD_COMMIT = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
export const RANDOM_DATA_HEAD_TREE = "113232c852e07d88dce1e6ba69f3be51ead0f154";
export const RANDOM_DATA_HEAD_CASE_ID = "local-random-data-head";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMODULE = "ZTools-plugins", REPO_PACKAGE_PATH = "plugins/random-data";
const DIRECTORY_SHA256 = "6c62e8d69ff009636fe948694554722556799b4c5721dc865caf637bbaf02c95";
const FILES = Object.freeze({
  ".gitignore": { bytes: 21, sha256: "ad4a605baef6f8dab78d26b0acd88cb195c55f82bba3c41be30b6200fa6093df" },
  "CHANGELOG.md": { bytes: 612, sha256: "694697aeab4831e20218412c05a0b89d5d48596dde729c560e5eecc6ebbd2a9f" },
  "README.md": { bytes: 807, sha256: "4bcbd570328bd057001196ccd7fc9f24b926008a3d4ff04604bcd803392f1608" },
  "index.html": { bytes: 40860, sha256: "492bffd5cfbb4559bae9645374a7346bc70d229adf1ec408d81a41dd5c52647a" },
  "logo.svg": { bytes: 316, sha256: "db6024867f728f8e4b15105bd5588b22dd0994894e5a8d479a250b0a1654507b" },
  "plugin.json": { bytes: 653, sha256: "b3baead7274dbcd6d6796ae06ff96f5b066e1076de7cc677a88c02a6f79d1ce8" },
  "preload.js": { bytes: 34044, sha256: "18b9caa4e0a13a48b321dc3d149c51acba69f272e3daf2f74101a7c0c7eced9a" },
});
const COMMANDS = ["随机数据设置", "数据指令设置", "rdsetting"];

function exactManifest(manifest) {
  const feature = manifest?.features?.[0];
  return manifest?.name === "random-data" && manifest.version === "1.2.0"
    && manifest.title === "随机数据" && manifest.main === "index.html" && manifest.preload === "preload.js"
    && manifest.logo === "logo.svg" && manifest.pluginSetting?.single === true
    && Array.isArray(manifest.features) && manifest.features.length === 1
    && feature.code === "randomDataSettings" && feature.explain === "打开随机数据设置"
    && feature.icon === "logo.svg" && JSON.stringify(feature.cmds) === JSON.stringify(COMMANDS);
}

export function readHeadRandomDataPackage(repositoryRoot = REPO_ROOT) {
  const source = readPinnedHeadPackage({ repositoryRoot, submodule: SUBMODULE,
    commit: RANDOM_DATA_HEAD_COMMIT, packagePath: REPO_PACKAGE_PATH, packageTree: RANDOM_DATA_HEAD_TREE,
    directorySha256: DIRECTORY_SHA256, files: FILES, directories: [] });
  const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
  if (!exactManifest(manifest)) throw Error("Random Data HEAD manifest differs from the registered original feature contract");
  return source;
}

function sourceReview(profile, ownedRoot, witness, source) {
  return {
    schemaVersion: 1, sourceKind: "local_full_directory", status: profile.sourceReviewStatus,
    profile: { caseId: profile.caseId, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: profile.directorySha256, fileCount: profile.fileCount },
    fixture: { id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, ownedRoot,
      sourceRoot: `git:${source.commit}:${SUBMODULE}/${REPO_PACKAGE_PATH}`,
      pluginRoot: path.join(ownedRoot, "plugin"), files: witness.files, directories: witness.directories,
      sourceRevision: { repository: SUBMODULE, commit: source.commit, tree: source.tree, packagePath: REPO_PACKAGE_PATH } },
    sourceInspection: { revision: source.commit, tree: source.tree,
      reviewScope: "Exact Random Data package blobs read from the registered Git HEAD; dirty worktree files are not used.",
      boundary: "Source provenance only; no installation or plugin execution is implied." },
    verificationBoundary: "The copied package is checked against the registered Git blob list and local tree digest; runtime acceptance is separate.",
  };
}

function assertProfile(profile) {
  if (profile?.caseId !== RANDOM_DATA_HEAD_CASE_ID || profile.sourceCommit !== RANDOM_DATA_HEAD_COMMIT
    || profile.sourceTree !== RANDOM_DATA_HEAD_TREE || profile.directorySha256 !== DIRECTORY_SHA256
    || profile.id !== "random-data" || profile.version !== "1.2.0" || profile.fileCount !== 7
    || profile.runtime !== "web" || profile.dataAccess !== true || profile.verifyDataPersistence !== true
    || profile.pathAccess !== "none" || profile.featureCode !== "randomDataSettings") {
    throw Error("Random Data profile is not the exact registered HEAD revision");
  }
}

export async function prepareHeadRandomDataFixture(profile, { temporaryParent = "/private/tmp", repositoryRoot = REPO_ROOT } = {}) {
  assertProfile(profile);
  const source = readHeadRandomDataPackage(repositoryRoot);
  const staged = await materializePinnedHeadPackage(source, { temporaryParent,
    prefix: "atools-local-plugin-fixture-", packageName: "plugin" });
  try {
    const witness = summarizeLocalTree(staged.files, new Set(source.witness.directories));
    const sourceAfter = readHeadRandomDataPackage(repositoryRoot);
    if (sourceAfter.commit !== source.commit || sourceAfter.tree !== source.tree
      || witness.directorySha256 !== DIRECTORY_SHA256 || witness.fileCount !== profile.fileCount) {
      throw Error("Random Data HEAD source or copied fixture changed during materialization");
    }
    const review = sourceReview(profile, staged.ownedRoot, witness, source);
    const sourceReviewJSON = path.join(staged.ownedRoot, "source-review.json");
    await writeFile(sourceReviewJSON, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { profile, fixture: { ownedRoot: staged.ownedRoot, pluginRoot: staged.packageRoot,
      sourceRoot: review.fixture.sourceRoot, sourceReviewJSON, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: witness.directorySha256, fileCount: witness.fileCount,
      files: witness.files, directories: witness.directories }, review, cleanup: staged.cleanup };
  } catch (error) { await staged.cleanup(); throw error; }
}

export async function verifyHeadRandomDataFixture(fixture, profile, { repositoryRoot = REPO_ROOT } = {}) {
  assertProfile(profile);
  const source = readHeadRandomDataPackage(repositoryRoot);
  if (source.commit !== profile.sourceCommit || source.tree !== profile.sourceTree
    || fixture?.id !== profile.id || fixture?.version !== profile.version
    || fixture?.directorySha256 !== DIRECTORY_SHA256
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-local-plugin-fixture-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "plugin")) {
    throw Error("Random Data fixture identity differs from its pinned revision");
  }
  const copied = await scanLocalDirectory(fixture.pluginRoot);
  const witness = summarizeLocalTree(copied.files, copied.directories);
  const exact = witness.directorySha256 === DIRECTORY_SHA256
    && JSON.stringify(witness.files) === JSON.stringify(source.witness.files)
    && JSON.stringify(witness.directories) === JSON.stringify(source.witness.directories);
  if (!exact) throw Error("Random Data fixture differs from the registered HEAD blobs");
  return { verification: { sourceBytesUnchanged: true, fixtureBytesMatchPinnedSource: true,
    sourceKind: "local_full_directory", sourceCommit: source.commit, sourceTree: source.tree,
    directorySha256: witness.directorySha256, fileCount: witness.fileCount, unchangedFileCount: witness.fileCount,
    expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    files: witness.files, directories: witness.directories, pluginCodeExecutedByVerification: false }, files: copied.files };
}
