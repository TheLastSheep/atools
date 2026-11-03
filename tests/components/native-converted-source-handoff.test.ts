import { describe, expect, it } from "vitest";
import registry from "../fixtures/converted-source-cases.json";
import { verifyConvertedHandoffEvidence, verifyConvertedImportResult } from "./nativeConvertedHandoff";
import archiveRegistry from "../fixtures/local-original-archive-cases.json";
import { verifyFixtureProfile } from "./nativePublishedPluginCommon";
import type { PublishedFixture, PublishedPluginProfile } from "./nativePublishedPluginCommon";

const profile = registry.cases[0] as PublishedPluginProfile;
const sha = registry.handoffs[profile.caseId as keyof typeof registry.handoffs];
const evidence = (profileValue = profile, pins = sha) => ({ caseId: profileValue.caseId,
  sourceCaseId: pins.sourceCaseId, artifactKind: pins.artifactKind, handoffStatus: pins.handoffStatus,
  nativeUiConsumerSupported: pins.nativeUiConsumerSupported, manifestSha256: pins.manifestSha256,
  source: { sourceRevision: pins.sourceRevision, manifestSha256: pins.sourceManifestSha256,
    fileCount: pins.sourceFileCount, bytes: pins.sourceBytes, inventorySha256: pins.sourceInventorySha256 },
  sourceRevision: pins.sourceRevision, dependencySetIdSha256: pins.dependencySetIdSha256,
  dependencyTreeSha256: pins.dependencyTreeSha256, dependencyTreeBytes: pins.dependencyTreeBytes,
  installedPackageTreeSha256: pins.installedPackageTreeSha256, treeEntries: pins.treeEntries,
  treeFiles: pins.treeFiles, treeBytes: pins.treeBytes, businessUsabilityVerified: false as const,
  conversionSourceProvenanceUnchanged: true as const });

describe("converted source handoff DTO", () => {
  it("accepts only a path-free, source-bound installed-tree summary", () => {
    const value = evidence();
    expect(value.manifestSha256).not.toBe(value.source.manifestSha256);
    expect(verifyConvertedHandoffEvidence(value, profile, profile.directorySha256!)).toEqual(value);
    expect("manifestPath" in value).toBe(false);
    expect("taskRuns" in value).toBe(false);
  });
  it("accepts the exact converted fixture DTO while rejecting caller-added paths", () => {
    const fixture: PublishedFixture = { token: "fixed-token", runId: "fixed-run", packageSha256: profile.directorySha256!,
      profile, workerContractOnly: false, nativeUiInput: false, convertedHandoff: evidence() };
    expect(verifyFixtureProfile(fixture)).toEqual(profile);
    expect(verifyFixtureProfile({ ...fixture, requireForeground: true })).toEqual(profile);
    for (const invalid of [false, "true"]) {
      expect(() => verifyFixtureProfile({ ...fixture, requireForeground: invalid } as unknown as PublishedFixture)).toThrow();
    }
    expect(() => verifyFixtureProfile({ ...fixture, sourcePath: "/private/tmp/secret" } as PublishedFixture)).toThrow();
    expect(() => verifyFixtureProfile({ ...fixture,
      convertedHandoff: { ...evidence(), sourcePath: "/private/tmp/secret" } as PublishedFixture["convertedHandoff"] } as PublishedFixture)).toThrow();
  });
  it("accepts Tetris conversion evidence without promoting it to a supported consumer artifact", () => {
    const tetris = registry.cases[1] as PublishedPluginProfile;
    const pins = registry.handoffs[tetris.caseId as keyof typeof registry.handoffs];
    const value = evidence(tetris, pins);
    expect(verifyConvertedHandoffEvidence(value, tetris, tetris.directorySha256!)).toEqual(value);
    expect(pins.artifactKind).toBe("converted_source_evidence");
    expect(pins.handoffStatus).toBe("conversion_evidence_only");
    expect(pins.nativeUiConsumerSupported).toBe(false);
    const fixture: PublishedFixture = { token: "fixed-token", runId: "fixed-run", packageSha256: tetris.directorySha256!,
      profile: tetris, workerContractOnly: false, nativeUiInput: false, convertedHandoff: value };
    expect(verifyFixtureProfile(fixture)).toEqual(tetris);
    expect(() => verifyConvertedHandoffEvidence({ ...value, sourceCaseId: "converted-tetris-source" }, tetris, tetris.directorySha256!)).toThrow();
    expect(() => verifyConvertedHandoffEvidence(value, profile, profile.directorySha256!)).toThrow();
  });
  it("accepts the pinned Todo conversion evidence without claiming native or business readiness", () => {
    const todo = registry.cases[2] as PublishedPluginProfile;
    const pins = registry.handoffs[todo.caseId as keyof typeof registry.handoffs];
    expect(todo).toMatchObject({ id: "todo-neo", version: "0.0.1", runtime: "web", dataAccess: true,
      verifyDataPersistence: true, featureCode: "todo", searchQuery: "ToDo 待办" });
    const value = evidence(todo, pins);
    expect(verifyConvertedHandoffEvidence(value, todo, todo.directorySha256!)).toEqual(value);
    expect(pins.sourceCaseId).toBe("fixed-head-todo-neo");
    expect(pins.artifactKind).toBe("converted_source_evidence");
    expect(pins.handoffStatus).toBe("conversion_evidence_only");
    expect(pins.nativeUiConsumerSupported).toBe(false);
    expect(value.businessUsabilityVerified).toBe(false);
    expect(() => verifyConvertedHandoffEvidence({ ...value, sourceCaseId: "fixed-head-tetris" }, todo,
      todo.directorySha256!)).toThrow();
    expect(() => verifyConvertedHandoffEvidence({ ...value, businessUsabilityVerified: true }, todo,
      todo.directorySha256!)).toThrow();
  });
  it("accepts the fixed DeepRead evidence as conversion-only and keeps its web consumer profile separate", () => {
    const deepread = registry.cases[3] as PublishedPluginProfile;
    expect(deepread.caseId).toBe("converted-deepread-source");
    const pins = registry.handoffs["converted-deepread-source"];
    expect(deepread).toMatchObject({ id: "deepread", version: "1.1.2", runtime: "web", dataAccess: true,
      pathAccess: "none", dialogAccess: "open", verifyDataPersistence: true, featureCode: "deepread" });
    const value = evidence(deepread, pins);
    expect(verifyConvertedHandoffEvidence(value, deepread, deepread.directorySha256!)).toEqual(value);
    expect(pins.sourceCaseId).toBe("fixed-head-deepread-public");
    expect(pins.artifactKind).toBe("converted_source_evidence");
    expect(pins.handoffStatus).toBe("conversion_evidence_only");
    expect(pins.nativeUiConsumerSupported).toBe(false);
    expect(pins.selectedPublicManifestSha256).toBe("1ad7c1b5ddd7ce687878d8aca0da319d9f75ef6d77e101ed8a706d6a1d268192");
    expect(value.businessUsabilityVerified).toBe(false);
    expect(() => verifyConvertedHandoffEvidence({ ...value, nativeUiConsumerSupported: true }, deepread,
      deepread.directorySha256!)).toThrow();
    expect(() => verifyConvertedHandoffEvidence({ ...value, businessUsabilityVerified: true }, deepread,
      deepread.directorySha256!)).toThrow();
  });
  it("keeps the official archive case bound to its archive digest", () => {
    const archive = archiveRegistry.cases[0] as PublishedPluginProfile;
    expect(archive.archiveSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(() => verifyFixtureProfile({ token: "fixed-token", runId: "fixed-run",
      packageSha256: archive.archiveSha256!, profile: archive, pluginRoot: "/tmp/reviewed-package",
      assetProbePath: "/tmp/reviewed-package/index.html" } as PublishedFixture)).not.toThrow();
  });
  it("rejects identity drift and unknown path or TaskRun fields", () => {
    expect(() => verifyConvertedHandoffEvidence({ ...evidence(), sourceRevision: "f".repeat(64) }, profile,
      profile.directorySha256!)).toThrow();
    expect(() => verifyConvertedHandoffEvidence({ ...evidence(), manifestPath: "/private/tmp/secret" }, profile,
      profile.directorySha256!)).toThrow();
    expect(() => verifyConvertedHandoffEvidence({ ...evidence(), taskRuns: [{ id: "run-private" }] }, profile,
      profile.directorySha256!)).toThrow();
    expect(() => verifyConvertedHandoffEvidence({ ...evidence(), dependencyTreeBytes: sha.dependencyTreeBytes + 1 }, profile,
      profile.directorySha256!)).toThrow();
  });
  it("requires the host's exact imported and reverified tree result", () => {
    const handoff = verifyConvertedHandoffEvidence(evidence(), profile, profile.directorySha256!);
    const summary = { status: "imported", pluginId: profile.id, version: profile.version,
      packageSha256: profile.directorySha256, treeEntries: sha.treeEntries, treeFiles: sha.treeFiles, treeBytes: sha.treeBytes,
      conversionSourceProvenanceUnchanged: true, importSourceTreeUnchanged: true,
      installedTargetMatchesHandoff: true, businessUsabilityVerified: false };
    expect(verifyConvertedImportResult(summary, profile, handoff, "imported")).toEqual(summary);
    expect(() => verifyConvertedImportResult({ ...summary, packageSha256: "0".repeat(64) }, profile, handoff, "imported")).toThrow();
    expect(() => verifyConvertedImportResult({ ...summary, importSourceTreeUnchanged: false }, profile, handoff, "imported")).toThrow();
    expect(() => verifyConvertedImportResult({ ...summary, installedTargetMatchesHandoff: false }, profile, handoff, "imported")).toThrow();
    expect(() => verifyConvertedImportResult({ ...summary, path: "/private/tmp/private" }, profile, handoff, "imported")).toThrow();
    const verified = { ...summary, status: "verified" };
    expect(verifyConvertedImportResult(verified, profile, handoff, "verified")).toEqual(verified);
  });
});
