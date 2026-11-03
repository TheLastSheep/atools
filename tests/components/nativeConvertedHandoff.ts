import type { PublishedPluginProfile } from "./nativePublishedPluginCommon";
import registry from "../fixtures/converted-source-cases.json";

type ConvertedSourcePin = {
  manifestSha256: string; artifactFileName: string; artifactKind: string; sourceCaseId: string;
  handoffStatus: string; nativeUiConsumerSupported: boolean; upstreamHead: string;
  sourceManifestSha256: string; sourceInventorySha256: string; sourceRevision: string;
  sourceFileCount: number; sourceBytes: number; dependencySetIdSha256: string; nodeBinarySha256: string;
  nodeBinaryBytes: number; toolchainFingerprintSha256: string; packageCount: number;
  dependencyTreeSha256: string; dependencyTreeBytes: number; dependencyTreeEntries: number; dependencyTreeFiles: number;
  installedPackageTreeSha256: string; treeEntries: number; treeFiles: number; treeBytes: number;
  selectedPublicManifestSha256?: string;
};
export type ConvertedHandoffEvidence = {
  caseId: string; sourceCaseId: string; artifactKind: string; handoffStatus: string;
  nativeUiConsumerSupported: boolean; manifestSha256: string;
  source: { sourceRevision: string; manifestSha256: string; fileCount: number; bytes: number; inventorySha256: string };
  sourceRevision: string; dependencySetIdSha256: string; dependencyTreeSha256: string; dependencyTreeBytes: number;
  installedPackageTreeSha256: string; treeEntries: number; treeFiles: number; treeBytes: number;
  conversionSourceProvenanceUnchanged: true; businessUsabilityVerified: false;
};
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function exactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function pinsFor(profile: PublishedPluginProfile): ConvertedSourcePin {
  const pins = (registry.handoffs as Record<string, ConvertedSourcePin>)[profile.caseId];
  if (!pins || !["converted-my-calculator-source", "converted-tetris-source", "converted-todo-neo-source", "converted-deepread-source"].includes(profile.caseId))
    throw Error("Unknown converted source profile");
  return pins;
}

export function verifyConvertedHandoffEvidence(value: unknown, profile: PublishedPluginProfile,
  packageSha256: string): ConvertedHandoffEvidence {
  const keys = ["caseId", "sourceCaseId", "artifactKind", "handoffStatus", "nativeUiConsumerSupported", "manifestSha256", "source",
    "sourceRevision", "dependencySetIdSha256", "dependencyTreeSha256", "dependencyTreeBytes", "installedPackageTreeSha256",
    "treeEntries", "treeFiles", "treeBytes", "conversionSourceProvenanceUnchanged", "businessUsabilityVerified"];
  if (!object(value) || !exactKeys(value, keys) || !object(value.source)
    || !exactKeys(value.source, ["sourceRevision", "manifestSha256", "fileCount", "bytes", "inventorySha256"])) {
    throw Error("Converted handoff evidence has an unexpected shape");
  }
  const pin = pinsFor(profile), source = value.source;
  const hashes = [value.manifestSha256, source.sourceRevision, source.manifestSha256, source.inventorySha256,
    value.sourceRevision, value.dependencySetIdSha256, value.dependencyTreeSha256,
    value.installedPackageTreeSha256, packageSha256];
  if (!hashes.every(digest) || value.caseId !== profile.caseId || value.sourceCaseId !== pin.sourceCaseId
    || value.artifactKind !== pin.artifactKind || value.handoffStatus !== pin.handoffStatus
    || value.nativeUiConsumerSupported !== pin.nativeUiConsumerSupported
    || value.conversionSourceProvenanceUnchanged !== true || value.businessUsabilityVerified !== false
    || profile.sourceKind !== "converted_handoff_directory" || profile.directorySha256 !== pin.installedPackageTreeSha256
    || value.manifestSha256 !== pin.manifestSha256
    || source.sourceRevision !== pin.sourceRevision || source.manifestSha256 !== pin.sourceManifestSha256
    || source.inventorySha256 !== pin.sourceInventorySha256 || source.fileCount !== pin.sourceFileCount || source.bytes !== pin.sourceBytes
    || value.dependencySetIdSha256 !== pin.dependencySetIdSha256 || value.dependencyTreeSha256 !== pin.dependencyTreeSha256
    || value.dependencyTreeBytes !== pin.dependencyTreeBytes || value.installedPackageTreeSha256 !== pin.installedPackageTreeSha256
    || value.treeEntries !== pin.treeEntries || value.treeFiles !== pin.treeFiles || value.treeBytes !== pin.treeBytes
    || value.sourceRevision !== source.sourceRevision || value.installedPackageTreeSha256 !== profile.directorySha256
    || packageSha256 !== profile.directorySha256
    || ![source.fileCount, source.bytes, value.dependencyTreeBytes, value.treeEntries, value.treeFiles, value.treeBytes]
      .every(number => Number.isSafeInteger(number) && number > 0)
    || value.treeFiles !== profile.fileCount || value.treeEntries < value.treeFiles) {
    throw Error("Converted handoff evidence does not match the fixed source and installed-tree identity");
  }
  return value as ConvertedHandoffEvidence;
}

export type ConvertedImportSummary = {
  status: "imported" | "verified"; pluginId: string; version: string; packageSha256: string;
  treeEntries: number; treeFiles: number; treeBytes: number;
  conversionSourceProvenanceUnchanged: true; importSourceTreeUnchanged: true;
  installedTargetMatchesHandoff: true; businessUsabilityVerified: false;
};

export function verifyConvertedImportResult(value: unknown, profile: PublishedPluginProfile,
  handoff: ConvertedHandoffEvidence, expectedStatus: "imported" | "verified"): ConvertedImportSummary {
  const keys = ["status", "pluginId", "version", "packageSha256", "treeEntries", "treeFiles", "treeBytes",
    "conversionSourceProvenanceUnchanged", "importSourceTreeUnchanged", "installedTargetMatchesHandoff", "businessUsabilityVerified"];
  if (!object(value) || !exactKeys(value, keys) || value.status !== expectedStatus
    || value.pluginId !== profile.id || value.version !== profile.version
    || value.packageSha256 !== handoff.installedPackageTreeSha256 || value.treeEntries !== handoff.treeEntries
    || value.treeFiles !== handoff.treeFiles || value.treeBytes !== handoff.treeBytes
    || value.conversionSourceProvenanceUnchanged !== true || value.importSourceTreeUnchanged !== true
    || value.installedTargetMatchesHandoff !== true || value.businessUsabilityVerified !== false) {
    throw Error("Native converted-package import did not return the pinned installed-tree summary");
  }
  return value as ConvertedImportSummary;
}
