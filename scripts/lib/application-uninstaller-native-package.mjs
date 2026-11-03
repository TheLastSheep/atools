import { cp, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative, sep } from "node:path";
import { sourcePackageManifest } from "./source-build-real-package-evidence.mjs";

const EXPECTED = { name: "application-uninstaller", version: "0.1.0", files: 38, bytes: 274615,
  manifestSha256: "b955c979112b6a0078a4bb3f5f8a6738600b18a66d285a6dcb2770515073344b" };
const excluded = new Set([".git", ".npm-cache", "dist", "release"]);

export async function copyApplicationPackageTree(sourceRoot, target) {
  await cp(sourceRoot, target, { recursive: true, verbatimSymlinks: true, filter(path) {
    const rel = relative(sourceRoot, path);
    if (!rel) return true;
    const segments = rel.split(sep);
    if (segments[0] === "node_modules") return true;
    return !segments.some(segment => excluded.has(segment));
  } });
}
export async function prepareApplicationUninstallerPackage({ cohort, sourceRoot, repoRoot }) {
  if (typeof repoRoot !== "string" || !repoRoot) throw Error("Repository root is required for source identity verification");
  const localPackagePath = join(repoRoot, "ZTools-plugins", "plugins", "application-uninstaller");
  const source = await sourcePackageManifest(sourceRoot);
  if (source.fileCount !== EXPECTED.files || source.bytes !== EXPECTED.bytes
    || source.manifestSha256 !== EXPECTED.manifestSha256) {
    throw Error("Pinned application-uninstaller source tree changed");
  }
  const localPackage = await sourcePackageManifest(localPackagePath);
  if (JSON.stringify(source.entries) !== JSON.stringify(localPackage.entries)) {
    throw Error("Private package copy no longer matches the local untracked package source");
  }
  const manifest = JSON.parse(await readFile(join(sourceRoot, "plugin.json"), "utf8"));
  const packageJson = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(sourceRoot, "package-lock.json"), "utf8"));
  if (manifest.name !== EXPECTED.name || manifest.version !== EXPECTED.version
    || packageJson.name !== manifest.name || packageJson.version !== manifest.version
    || lock.name !== manifest.name || lock.version !== manifest.version) {
    throw Error("Pinned package, manifest, and lock identities disagree");
  }

  const paths = ["baseline-publish", "success", "cancel", "invalid"];
  for (const name of paths) await mkdir(join(cohort, name), { recursive: false, mode: 0o700 });
  const target = join(cohort, "success");
  await rm(target, { recursive: true, force: true });
  await copyApplicationPackageTree(sourceRoot, target);
  const targetSources = await sourcePackageManifest(target);
  if (JSON.stringify(source.entries) !== JSON.stringify(targetSources.entries)
    || source.bytes !== targetSources.bytes || source.manifestSha256 !== targetSources.manifestSha256) {
    throw Error("Real source copy differs from the pinned package tree");
  }
  const deps = await lstat(join(target, "node_modules"));
  if (deps.isSymbolicLink() || !deps.isDirectory()) throw Error("Package-owned installed dependencies are required");
  for (const name of excluded) {
    if (await lstat(join(target, name)).then(() => true, () => false)) {
      throw Error("Generated output or package-manager cache entered the source fixture");
    }
  }
  return {
    profile: "application-uninstaller",
    provenance: "Local untracked package copy; source-tree identity checked against this checkout's untracked package, not asserted as upstream-tracked",
    sourceIdentity: { name: manifest.name, version: manifest.version },
    sourceTree: { files: source.fileCount, bytes: source.bytes, manifestSha256: source.manifestSha256,
      sourceManifestSha256MatchedPinned: true,
      historicalTreeReferenceSha256: "4476f5fcd706285f2d409b0cbd84ad2ce4d733e3ea99bb29ce139fb2417477df" },
    fixturePath: target,
    dependencies: { directoryIsPackageOwned: true, symlinkRoot: false,
      packageLockSha256: createHash("sha256").update(await readFile(join(target, "package-lock.json"))).digest("hex") },
    excludedGeneratedDirectories: [...excluded],
    excludedFromSourceManifest: ["node_modules", ...excluded],
  };
}
