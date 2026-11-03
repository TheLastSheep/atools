import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";
import { readPinnedHeadPackage, materializePinnedHeadPackage } from "./head-local-package-fixture.mjs";

export const HEAD_COMMIT = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
export const HEAD_TREE = "81da0c4397c3190c9ed9d88e49f3b974b4fa32a4";
export const HEAD_CASE_ID = "local-calculation-paper-head";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMODULE = "ZTools-plugins";
const FILES = Object.freeze({
  "index.html": "d776b6d7eb19b9cecf2319ce529a2d17dbf8c0a03de954bb1f18b6197ef7add0",
  "index.js": "f501c6389c211754cf459253c9e6f9d204b44d59cc65b08b29e30665a535a54a",
  "index.js.LICENSE.txt": "e44b4c05c3a9b854798417b52c3aa9fbe7a369bd7675aad15b972880465c7f7f",
  "logo.png": "390aaa92636d3b3811341f418ca05497bc8751f6df760fa64c3aa5de6c5f3353",
  "plugin.json": "a7930841e09ec6fe459f3e63d95008063d476aaa4eb08211e820bece0fd5c123",
  "res/average.svg": "25e66a14d6abdd20a9d985d303a58a97bc0d90a8da5d576ce0818cafe4d1b243",
  "res/equals.svg": "27c10c9ddda215cc69cb35383fffb63d37720bc34db9999fbe3a41bc14fecf01",
  "res/sum.svg": "e222dbfe0231b0b1907a80d59a9830a5782a7029d14578c2bd4fb18b23c521db",
});
export function readHeadCalculationPaper(repositoryRoot = REPO_ROOT) {
  const source = readPinnedHeadPackage({ repositoryRoot, submodule: SUBMODULE, commit: HEAD_COMMIT,
    packagePath: "plugins/calculation-paper", packageTree: HEAD_TREE,
    directorySha256: "56de9c81fed8f4db2c4b90583ca8c56ab0f22e67b5e8edf3153a6b8e992397ba",
    files: FILES, directories: ["res"] });
  const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
  if (manifest.name !== "calculation-paper" || manifest.version !== "1.4.2"
    || !manifest.features?.some(feature => feature.code === "calc")) throw Error("Calculation Paper HEAD manifest identity differs from reviewed profile");
  return source;
}

function sourceReview(profile, sourceRoot, ownedRoot, witness, identity) {
  return {
    schemaVersion: 1, sourceKind: "local_full_directory", status: profile.sourceReviewStatus,
    profile: { caseId: profile.caseId, id: profile.id, version: profile.version,
      sourceKind: profile.sourceKind, directorySha256: profile.directorySha256, fileCount: profile.fileCount },
    fixture: { id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, ownedRoot, sourceRoot,
      pluginRoot: path.join(ownedRoot, "plugin"), files: witness.files, directories: witness.directories,
      sourceRevision: { repository: "ZTools-plugins", commit: identity.commit, tree: identity.tree, packagePath: "plugins/calculation-paper" } },
    sourceInspection: { revision: identity.commit, tree: identity.tree,
      reviewScope: "Exact Calculation Paper package blobs read from the registered Git HEAD; current dirty working files are not used.",
      boundary: "Source provenance only; no installation or plugin execution is implied." },
    verificationBoundary: "The copied package is checked against the registered Git HEAD blob list and local tree digest; this is not runtime acceptance.",
  };
}

export async function prepareHeadCalculationPaperFixture(profile, { temporaryParent = "/private/tmp", repositoryRoot = REPO_ROOT } = {}) {
  if (profile?.caseId !== HEAD_CASE_ID || profile?.sourceCommit !== HEAD_COMMIT || profile?.sourceTree !== HEAD_TREE
    || profile?.directorySha256 !== "56de9c81fed8f4db2c4b90583ca8c56ab0f22e67b5e8edf3153a6b8e992397ba") {
    throw Error("Calculation Paper HEAD profile is not the exact registered revision");
  }
  const source = readHeadCalculationPaper(repositoryRoot);
  const identity = { commit: source.commit, tree: source.tree };
  const staged = await materializePinnedHeadPackage(source, { temporaryParent, prefix: "atools-local-plugin-fixture-", packageName: "plugin" });
  const { ownedRoot, packageRoot: pluginRoot, files } = staged;
  try {
    const copied = { files, directories: new Set(source.witness.directories) }, witness = summarizeLocalTree(copied.files, copied.directories);
    const sourceAfter = readHeadCalculationPaper(repositoryRoot);
    if (sourceAfter.commit !== identity.commit || sourceAfter.tree !== identity.tree || witness.directorySha256 !== profile.directorySha256) {
      throw Error("Calculation Paper HEAD source or copied fixture changed during materialization");
    }
    const review = sourceReview(profile, `git:${identity.commit}:${SUBMODULE}/plugins/calculation-paper`, ownedRoot, witness, identity);
    const sourceReviewJSON = path.join(ownedRoot, "source-review.json");
    await writeFile(sourceReviewJSON, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { profile, fixture: { ownedRoot, pluginRoot, sourceRoot: review.fixture.sourceRoot, sourceReviewJSON,
      id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, files: witness.files, directories: witness.directories },
      review, cleanup: staged.cleanup };
  } catch (error) { await staged.cleanup(); throw error; }
}

export async function verifyHeadCalculationPaperFixture(fixture, profile, { repositoryRoot = REPO_ROOT } = {}) {
  const source = readHeadCalculationPaper(repositoryRoot);
  if (profile?.caseId !== HEAD_CASE_ID || source.commit !== profile.sourceCommit || source.tree !== profile.sourceTree
    || fixture?.directorySha256 !== profile.directorySha256 || !path.basename(fixture.ownedRoot || "").startsWith("atools-local-plugin-fixture-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "plugin")) throw Error("Calculation Paper HEAD fixture identity does not match its pinned revision");
  const copied = await scanLocalDirectory(fixture.pluginRoot), witness = summarizeLocalTree(copied.files, copied.directories);
  const exact = witness.directorySha256 === profile.directorySha256 && JSON.stringify(witness.files) === JSON.stringify(source.witness.files)
    && JSON.stringify(witness.directories) === JSON.stringify(source.witness.directories);
  if (!exact) throw Error("Calculation Paper fixture bytes differ from the registered HEAD blobs");
  return { verification: { sourceBytesUnchanged: true, fixtureBytesMatchPinnedSource: true, sourceKind: "local_full_directory",
      sourceCommit: source.commit, sourceTree: source.tree, directorySha256: witness.directorySha256,
      fileCount: witness.fileCount, unchangedFileCount: witness.fileCount,
      expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
      files: witness.files, directories: witness.directories, pluginCodeExecutedByVerification: false }, files: copied.files };
}
