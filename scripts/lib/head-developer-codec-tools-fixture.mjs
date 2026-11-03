import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { materializePinnedHeadPackage, readPinnedHeadPackage } from "./head-local-package-fixture.mjs";
import { scanLocalDirectory, summarizeLocalTree } from "./local-plugin-fixture.mjs";

export const HEAD_DEVELOPER_CODEC_TOOLS_CASE_ID = "local-developer-codec-tools-head";
export const HEAD_DEVELOPER_CODEC_TOOLS_COMMIT = "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d";
export const HEAD_DEVELOPER_CODEC_TOOLS_TREE = "f758b127a8af4e225d75cca1bc6d7c7b690b2008";
export const HEAD_DEVELOPER_CODEC_TOOLS_DIRECTORY_SHA256 = "676b43a647856c945633863bcdea514218115c55c69ae770682ac76d9a36894a";
const REGISTRY_SHA256 = "1103d1c712d243cdd61e92e970224a2e519b9ac8e9e2285bfa3bc7c4cda1e2d6";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SUBMODULE = "ZTools-plugins";
const REGISTRY_PATH = path.resolve(ROOT, "tests/fixtures/head-developer-codec-tools-cases.json");

export async function readHeadDeveloperCodecToolsProfile() {
  const bytes = await readFile(REGISTRY_PATH);
  if (createHash("sha256").update(bytes).digest("hex") !== REGISTRY_SHA256) throw Error("Developer codec HEAD registry differs from its reviewed bytes");
  const registry = JSON.parse(bytes.toString("utf8"));
  const profile = registry.cases?.find(item => item.caseId === HEAD_DEVELOPER_CODEC_TOOLS_CASE_ID);
  if (registry.schemaVersion !== 1 || registry.repository !== SUBMODULE || registry.commit !== HEAD_DEVELOPER_CODEC_TOOLS_COMMIT
    || registry.packagePath !== "plugins/developer-codec-tools" || registry.packageTree !== HEAD_DEVELOPER_CODEC_TOOLS_TREE
    || registry.directorySha256 !== HEAD_DEVELOPER_CODEC_TOOLS_DIRECTORY_SHA256 || registry.fileCount !== 15
    || registry.directoryCount !== 2 || registry.expandedBytes !== 59561 || !profile
    || profile.id !== "developer-codec-tools" || profile.version !== "0.1.0" || profile.featureCode !== "codec-tools"
    || profile.runtime !== "web" || profile.pathAccess !== "none" || profile.preload !== null || profile.main !== "index.html"
    || profile.sourceCommit !== registry.commit || profile.sourceTree !== registry.packageTree
    || profile.directorySha256 !== registry.directorySha256 || profile.fileCount !== registry.fileCount
    || JSON.stringify(profile.businessOperations) !== JSON.stringify(["base64-encode", "base64-decode"])) {
    throw Error("Developer codec HEAD profile differs from its registered contract");
  }
  return { registry, profile };
}

export async function readHeadDeveloperCodecToolsPackage(repositoryRoot = ROOT) {
  const { registry, profile } = await readHeadDeveloperCodecToolsProfile();
  const source = readPinnedHeadPackage({ repositoryRoot, submodule: SUBMODULE, commit: registry.commit,
    packagePath: registry.packagePath, packageTree: registry.packageTree, directorySha256: registry.directorySha256,
    files: registry.files, directories: registry.directories });
  const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
  const feature = manifest.features?.filter(item => item.code === profile.featureCode) ?? [];
  const html = source.files.get("index.html").toString("utf8");
  const app = source.files.get("app.js").toString("utf8");
  if (manifest.name !== profile.id || manifest.version !== profile.version || manifest.main !== profile.main
    || manifest.preload || feature.length !== 1 || !feature[0].cmds.includes("Base64")
    || !html.includes('<script type="module" src="./app.js"></script>')
    || !app.includes("op('base64-encode'") || !app.includes("op('base64-decode'")
    || !app.includes("els.run.addEventListener('click', runCurrentOperation)")
    || !app.includes("setStatus(error instanceof Error ? error.message : String(error), 'error')")) {
    throw Error("Developer codec HEAD package differs from its original UI/operation contract");
  }
  return { ...source, profile, manifest };
}

export async function prepareHeadDeveloperCodecToolsFixture({ temporaryParent = "/private/tmp", repositoryRoot = ROOT } = {}) {
  const source = await readHeadDeveloperCodecToolsPackage(repositoryRoot);
  const staged = await materializePinnedHeadPackage(source, { temporaryParent,
    prefix: "atools-head-developer-codec-tools-", packageName: "developer-codec-tools" });
  try {
    const sourceAfter = await readHeadDeveloperCodecToolsPackage(repositoryRoot);
    if (sourceAfter.commit !== source.commit || sourceAfter.tree !== source.tree) throw Error("Developer codec HEAD moved while staging its fixture");
    return { source, profile: source.profile, fixture: { ownedRoot: staged.ownedRoot, pluginRoot: staged.packageRoot,
      pluginSourcesRoot: staged.ownedRoot, id: source.profile.id, version: source.profile.version,
      sourceKind: source.profile.sourceKind, directorySha256: staged.witness.directorySha256,
      fileCount: staged.witness.fileCount, files: staged.witness.files, directories: staged.witness.directories }, cleanup: staged.cleanup };
  } catch (error) { await staged.cleanup(); throw error; }
}

export async function verifyHeadDeveloperCodecToolsFixture(fixture, repositoryRoot = ROOT) {
  const source = await readHeadDeveloperCodecToolsPackage(repositoryRoot);
  if (fixture?.id !== source.profile.id || fixture?.version !== source.profile.version
    || fixture?.directorySha256 !== HEAD_DEVELOPER_CODEC_TOOLS_DIRECTORY_SHA256
    || !path.basename(fixture.ownedRoot || "").startsWith("atools-head-developer-codec-tools-")
    || fixture.pluginRoot !== path.join(fixture.ownedRoot, "developer-codec-tools")) {
    throw Error("Developer codec HEAD fixture identity differs from its registered profile");
  }
  const copied = await scanLocalDirectory(fixture.pluginRoot);
  const witness = summarizeLocalTree(copied.files, copied.directories);
  if (witness.directorySha256 !== source.witness.directorySha256
    || JSON.stringify(witness.files) !== JSON.stringify(source.witness.files)
    || JSON.stringify(witness.directories) !== JSON.stringify(source.witness.directories)) {
    throw Error("Developer codec fixture differs from its pinned Git blobs");
  }
  return { sourceCommit: source.commit, sourceTree: source.tree, directorySha256: witness.directorySha256,
    fileCount: witness.fileCount, expandedBytes: [...copied.files.values()].reduce((sum, bytes) => sum + bytes.length, 0),
    fixtureBytesMatchPinnedSource: true, sourceRevisionFromGitHead: true };
}
