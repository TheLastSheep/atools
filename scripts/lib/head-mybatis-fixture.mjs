import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";
import { materializePinnedHeadPackage, readPinnedHeadPackage } from "./head-local-package-fixture.mjs";

export const MYBATIS_HEAD_COMMIT = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
export const MYBATIS_HEAD_TREE = "c456e308df68a1806772fb7f31edfa95d37f31e0";
export const MYBATIS_HEAD_CASE_ID = "local-mybatis-sql-formatter-head";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMODULE = "ZTools-plugins";
const DIRECTORY_SHA256 = "963a5779f37670bbc40a36574dee5a482e1d68f5727ae544c02772172f70b581";
const FILES = Object.freeze({
  ".gitignore": { bytes: 64, sha256: "252fb2915ca8cb3f2ab128d5dbf21342040f9d606d82b0d863d82558222507d7" },
  "index.html": { bytes: 9101, sha256: "b66a2942f0bca4d74fe379d9b73edfd2eec5a0573674cb882bebfda7653ccc32" },
  "logo.png": { bytes: 2139, sha256: "78326937b80626a93efe68ed2106dfd0e4d0eddaf29c930d4be0864513279a87" },
  "plugin.json": { bytes: 732, sha256: "757dca4b7e993cb2a7e6810a55c29242c31ecfe04d42f556d6b749039e782bf2" },
  "preload.js": { bytes: 4969, sha256: "9d9373e98b4b01db619c2ca77d0b43497466e569f7fefd96e0c44b61c0e79fd6" },
});
const COMMANDS = ["sql", "mybatis", "sql格式化", "sql日志", "SQL日志格式化",
  { type: "over", label: "MyBatis SQL 日志格式化", minLength: 10, maxLength: 50000 }];
const REPO_PACKAGE_PATH = "plugins/mybatis-sql-formatter";

export function readHeadMybatisPackage(repositoryRoot = REPO_ROOT) {
  const source = readPinnedHeadPackage({ repositoryRoot, submodule: SUBMODULE, commit: MYBATIS_HEAD_COMMIT,
    packagePath: REPO_PACKAGE_PATH, packageTree: MYBATIS_HEAD_TREE, directorySha256: DIRECTORY_SHA256,
    files: FILES, directories: [] });
  const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
  const features = manifest.features;
  if (manifest.name !== "mybatis-sql-formatter" || manifest.version !== "1.0.0" || manifest.main !== "index.html"
    || manifest.preload !== "preload.js" || !Array.isArray(features) || features.length !== 1
    || features[0].code !== "format-sql-log" || JSON.stringify(features[0].cmds) !== JSON.stringify(COMMANDS)) {
    throw Error("MyBatis SQL Formatter HEAD manifest differs from the registered original feature contract");
  }
  return source;
}

function sourceReview(profile, ownedRoot, witness, identity) {
  return {
    schemaVersion: 1, sourceKind: "local_full_directory", status: profile.sourceReviewStatus,
    profile: { caseId: profile.caseId, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: profile.directorySha256, fileCount: profile.fileCount },
    fixture: { id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, ownedRoot,
      sourceRoot: `git:${identity.commit}:${SUBMODULE}/${REPO_PACKAGE_PATH}`,
      pluginRoot: path.join(ownedRoot, "plugin"), files: witness.files, directories: witness.directories,
      sourceRevision: { repository: SUBMODULE, commit: identity.commit, tree: identity.tree, packagePath: REPO_PACKAGE_PATH } },
    sourceInspection: { revision: identity.commit, tree: identity.tree,
      reviewScope: "Exact MyBatis SQL Formatter package blobs read from the registered Git HEAD; dirty working-tree files are not used.",
      boundary: "Source provenance only; no installation or plugin execution is implied." },
    verificationBoundary: "The copied package is checked against the registered Git blob list and local tree digest; runtime acceptance is separate.",
  };
}

export async function prepareHeadMybatisFixture(profile, { temporaryParent = "/private/tmp", repositoryRoot = REPO_ROOT } = {}) {
  if (profile?.caseId !== MYBATIS_HEAD_CASE_ID || profile.sourceCommit !== MYBATIS_HEAD_COMMIT
    || profile.sourceTree !== MYBATIS_HEAD_TREE || profile.directorySha256 !== DIRECTORY_SHA256
    || profile.id !== "mybatis-sql-formatter" || profile.version !== "1.0.0" || profile.fileCount !== 5
    || profile.runtime !== "web" || profile.featureCode !== "format-sql-log") {
    throw Error("MyBatis SQL Formatter profile is not the exact registered HEAD revision");
  }
  const source = readHeadMybatisPackage(repositoryRoot);
  const staged = await materializePinnedHeadPackage(source, { temporaryParent,
    prefix: "atools-local-plugin-fixture-", packageName: "plugin" });
  try {
    const witness = summarizeLocalTree(staged.files, new Set(source.witness.directories));
    const sourceAfter = readHeadMybatisPackage(repositoryRoot);
    if (sourceAfter.commit !== source.commit || sourceAfter.tree !== source.tree
      || witness.directorySha256 !== DIRECTORY_SHA256 || witness.fileCount !== profile.fileCount) {
      throw Error("MyBatis SQL Formatter HEAD source or copied fixture changed during materialization");
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

export async function verifyHeadMybatisFixture(fixture, profile, { repositoryRoot = REPO_ROOT } = {}) {
  const source = readHeadMybatisPackage(repositoryRoot);
  if (profile?.caseId !== MYBATIS_HEAD_CASE_ID || source.commit !== profile.sourceCommit || source.tree !== profile.sourceTree
    || fixture?.id !== profile.id || fixture?.version !== profile.version || fixture?.directorySha256 !== DIRECTORY_SHA256
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-local-plugin-fixture-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "plugin")) {
    throw Error("MyBatis SQL Formatter fixture identity differs from its pinned revision");
  }
  const copied = await scanLocalDirectory(fixture.pluginRoot);
  const witness = summarizeLocalTree(copied.files, copied.directories);
  const exact = witness.directorySha256 === DIRECTORY_SHA256 && JSON.stringify(witness.files) === JSON.stringify(source.witness.files)
    && JSON.stringify(witness.directories) === JSON.stringify(source.witness.directories);
  if (!exact) throw Error("MyBatis SQL Formatter fixture differs from the registered HEAD blobs");
  return { verification: { sourceBytesUnchanged: true, fixtureBytesMatchPinnedSource: true,
    sourceKind: "local_full_directory", sourceCommit: source.commit, sourceTree: source.tree,
    directorySha256: witness.directorySha256, fileCount: witness.fileCount, unchangedFileCount: witness.fileCount,
    expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    files: witness.files, directories: witness.directories, pluginCodeExecutedByVerification: false }, files: copied.files };
}
