import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";
import { materializePinnedHeadPackage, readPinnedHeadPackage } from "./head-local-package-fixture.mjs";

export const IMAGE_STITCH_HEAD_COMMIT = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
export const IMAGE_STITCH_HEAD_TREE = "629b6c70b86f28d8f775ced7202bfc2de9b244d5";
export const IMAGE_STITCH_HEAD_CASE_ID = "local-image-stitch-head";
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMODULE = "ZTools-plugins", REPO_PACKAGE_PATH = "plugins/image-stitch";
const DIRECTORY_SHA256 = "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee";
const FILES = Object.freeze({
  "app.js": { bytes: 22658, sha256: "37105dde6dad683d2c4b211ccf51392f5f148c6c8bb02e20c3a264464133384c" },
  "index.html": { bytes: 6021, sha256: "adcf0f4c9ef0edaa0af82e32de69bfdd78177a762703639a43a49cb25b62555a" },
  "logo.svg": { bytes: 563, sha256: "0cb4b56c26c417e89f44fcb4929dcb0e826ede43dd74650b8f1aff6e83870d1e" },
  "plugin.json": { bytes: 1020, sha256: "5ad33e18647fd550be3169eca955aa87b2c1f5fb330cbefaac1a94acfdb6e66b" },
  "style.css": { bytes: 12200, sha256: "9a63b48da340825c643f3bc5aee935e33171221089563ca28f871c6db8996093" },
});

function exactManifest(manifest) {
  const features = manifest?.features;
  const files = features?.[1]?.cmds?.[0];
  return manifest?.name === "image-stitch" && manifest.version === "1.0.0"
    && manifest.title === "图片拼接" && manifest.main === "index.html"
    && manifest.preload === undefined && Array.isArray(features) && features.length === 3
    && features[0]?.code === "image-stitch" && JSON.stringify(features[0].cmds) === JSON.stringify(["图片拼接", "拼图", "image stitch"])
    && features[1]?.code === "image-stitch-files" && files?.type === "files"
    && files.fileType === "file" && files.minLength === 1 && files.maxLength === 99
    && files.match === "/\\.(png|jpe?g|gif|bmp|webp|svg)$/i"
    && features[2]?.code === "image-stitch-img";
}

export function readHeadImageStitchPackage(repositoryRoot = REPO_ROOT) {
  const source = readPinnedHeadPackage({ repositoryRoot, submodule: SUBMODULE,
    commit: IMAGE_STITCH_HEAD_COMMIT, packagePath: REPO_PACKAGE_PATH, packageTree: IMAGE_STITCH_HEAD_TREE,
    directorySha256: DIRECTORY_SHA256, files: FILES, directories: [] });
  const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
  if (!exactManifest(manifest)) throw Error("Image Stitch HEAD manifest differs from the registered original feature contract");
  return source;
}

function assertProfile(profile) {
  if (profile?.caseId !== IMAGE_STITCH_HEAD_CASE_ID || profile.sourceCommit !== IMAGE_STITCH_HEAD_COMMIT
    || profile.sourceTree !== IMAGE_STITCH_HEAD_TREE || profile.directorySha256 !== DIRECTORY_SHA256
    || profile.id !== "image-stitch" || profile.version !== "1.0.0" || profile.fileCount !== 5
    || profile.runtime !== "web" || profile.featureCode !== "image-stitch-files"
    || profile.dataAccess !== true || profile.dialogAccess !== "open_and_save" || profile.pathAccess !== "none") {
    throw Error("Image Stitch profile is not the exact registered HEAD revision");
  }
}

export async function prepareHeadImageStitchFixture(profile, { temporaryParent = "/private/tmp", repositoryRoot = REPO_ROOT } = {}) {
  assertProfile(profile);
  const source = readHeadImageStitchPackage(repositoryRoot);
  const staged = await materializePinnedHeadPackage(source, { temporaryParent,
    prefix: "atools-local-plugin-fixture-", packageName: "plugin" });
  try {
    const witness = summarizeLocalTree(staged.files, new Set(source.witness.directories));
    const after = readHeadImageStitchPackage(repositoryRoot);
    if (after.commit !== source.commit || after.tree !== source.tree
      || witness.directorySha256 !== DIRECTORY_SHA256 || witness.fileCount !== profile.fileCount) {
      throw Error("Image Stitch HEAD source or copied fixture changed during materialization");
    }
    const review = { schemaVersion: 1, sourceKind: "local_full_directory", status: profile.sourceReviewStatus,
      profile: { caseId: profile.caseId, id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
        directorySha256: profile.directorySha256, fileCount: profile.fileCount },
      fixture: { id: profile.id, version: profile.version, sourceKind: profile.sourceKind, directorySha256: witness.directorySha256,
        fileCount: witness.fileCount, ownedRoot: staged.ownedRoot, sourceRoot: `git:${source.commit}:${SUBMODULE}/${REPO_PACKAGE_PATH}`,
        pluginRoot: staged.packageRoot, files: witness.files, directories: witness.directories,
        sourceRevision: { repository: SUBMODULE, commit: source.commit, tree: source.tree, packagePath: REPO_PACKAGE_PATH } },
      sourceInspection: { revision: source.commit, tree: source.tree,
        reviewScope: "Exact Image Stitch package blobs read from registered Git HEAD; dirty worktree files are not used.",
        boundary: "Source provenance only; no installation or plugin execution is implied." },
      verificationBoundary: "Copied package checked against registered Git blob list and local tree digest; runtime acceptance is separate." };
    const sourceReviewJSON = path.join(staged.ownedRoot, "source-review.json");
    await writeFile(sourceReviewJSON, `${JSON.stringify(review, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { profile, fixture: { ownedRoot: staged.ownedRoot, pluginRoot: staged.packageRoot, sourceRoot: review.fixture.sourceRoot,
      sourceReviewJSON, id: profile.id, version: profile.version, sourceKind: profile.sourceKind,
      directorySha256: witness.directorySha256, fileCount: witness.fileCount, files: witness.files, directories: witness.directories },
      review, cleanup: staged.cleanup };
  } catch (error) { await staged.cleanup(); throw error; }
}

export async function verifyHeadImageStitchFixture(fixture, profile, { repositoryRoot = REPO_ROOT } = {}) {
  assertProfile(profile);
  const source = readHeadImageStitchPackage(repositoryRoot);
  if (source.commit !== profile.sourceCommit || source.tree !== profile.sourceTree
    || fixture?.id !== profile.id || fixture?.version !== profile.version || fixture?.directorySha256 !== DIRECTORY_SHA256
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-local-plugin-fixture-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "plugin")) {
    throw Error("Image Stitch fixture identity differs from its pinned revision");
  }
  const copied = await scanLocalDirectory(fixture.pluginRoot);
  const witness = summarizeLocalTree(copied.files, copied.directories);
  const exact = witness.directorySha256 === DIRECTORY_SHA256
    && JSON.stringify(witness.files) === JSON.stringify(source.witness.files)
    && JSON.stringify(witness.directories) === JSON.stringify(source.witness.directories);
  if (!exact) throw Error("Image Stitch fixture differs from the registered HEAD blobs");
  return { verification: { sourceBytesUnchanged: true, fixtureBytesMatchPinnedSource: true,
    sourceKind: "local_full_directory", sourceCommit: source.commit, sourceTree: source.tree,
    directorySha256: witness.directorySha256, fileCount: witness.fileCount, unchangedFileCount: witness.fileCount,
    expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    files: witness.files, directories: witness.directories, pluginCodeExecutedByVerification: false }, files: copied.files };
}
