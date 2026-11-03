import registry from "../fixtures/local-original-archive-cases.json";
import type { PublishedFixture, PublishedPluginProfile } from "./nativePublishedPluginCommon";

type FileWitness = { path: string; bytes: number; sha256: string };
type InstalledEvidence = { pluginId: string; version: string; fileCount: number; exactPinnedFiles: boolean; files: FileWitness[] };

/** Both original forms must fail before either can overwrite the shared installation. */
export function verifyOriginalArchiveConflictReport(value: unknown, fixture: PublishedFixture): void {
  const paths = [fixture.pluginRoot, reviewedPackageImportPath(fixture)];
  const report = value as { imported?: unknown[]; skipped?: unknown[]; failed?: { path?: string; error?: string }[] } | null;
  if (fixture.profile.sourceKind !== "local_original_archive" || !report || !Array.isArray(report.imported)
    || report.imported.length !== 0 || !Array.isArray(report.skipped) || report.skipped.length !== 0
    || !Array.isArray(report.failed) || report.failed.length !== paths.length
    || new Set(report.failed.map(item => item?.path)).size !== paths.length
    || !paths.every(path => report.failed!.some(item => item?.path === path
      && typeof item.error === "string" && item.error.includes(fixture.profile.id) && item.error.includes("多个来源")))) {
    throw Error("Original archive batch conflict did not reject both exact sources before installation");
  }
}

/** Keep the retained original archive distinct from the extracted static-review directory. */
export function reviewedPackageImportPath(fixture: PublishedFixture): string {
  const root = fixture.pluginRoot;
  if (typeof root !== "string" || root.length === 0) {
    throw Error("Registered fixture omitted its package root");
  }
  if (fixture.profile.sourceKind !== "local_original_archive") {
    if (fixture.packageImportPath !== undefined && fixture.packageImportPath !== root) {
      throw Error("Directory fixture import path changed");
    }
    return root;
  }
  const archive = fixture.packageImportPath;
  if (!root.startsWith("/") || !root.endsWith("/plugin") || root.split("/").some(p => p === "." || p === "..")
    || typeof archive !== "string" || archive !== root.slice(0, -7) + "/source.zpx") {
    throw Error("Original ZPX import must use its retained archive, not the review directory");
  }
  return archive;
}

/** Native Rust reads actual installed bytes; this independently checks the registered witness. */
export function verifyOriginalArchiveInstalled(value: unknown, profile: PublishedPluginProfile): InstalledEvidence {
  const expectedProfile = registry.cases.find(p => p.caseId === profile.caseId);
  const witness = (registry.witnesses as Record<string, { files: FileWitness[] }>)[profile.caseId];
  if (!expectedProfile || profile.id !== expectedProfile.id || profile.version !== expectedProfile.version
    || profile.sourceKind !== "local_original_archive" || !witness || !value || typeof value !== "object") {
    throw Error("Unregistered original archive installation evidence");
  }
  const state = value as InstalledEvidence;
  if (state.pluginId !== profile.id || state.version !== profile.version || state.exactPinnedFiles !== true
    || state.fileCount !== witness.files.length || !Array.isArray(state.files) || state.files.length !== witness.files.length) {
    throw Error("Installed original archive identity or file count differs");
  }
  const byPath = new Map(state.files.map(f => [f?.path, f]));
  if (byPath.size !== witness.files.length || !witness.files.every(f => {
    const actual = byPath.get(f.path);
    return actual?.bytes === f.bytes && actual.sha256 === f.sha256;
  })) throw Error("Installed original archive bytes differ from the pinned files");
  return state;
}
