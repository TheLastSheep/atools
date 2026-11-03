import { expect, it } from "vitest";
import registry from "../fixtures/published-plugin-cases.json";
import convertedRegistry from "../fixtures/converted-source-cases.json";
import { IMAGE_STITCH_PROFILE, isExactImageStitchProfile } from "./nativePublishedImageStitchContract";
import { blockingPublishedDiagnostics, publishedPathsReady, publishedWebRuntimeReady, runtimeDrained, verifyFixtureProfile, verifyPublishedFrameIsolation } from "./nativePublishedPluginCommon";
import type { PublishedFixture, PublishedPluginProfile, RuntimeState } from "./nativePublishedPluginCommon";

function isPublishedPluginProfile(value: unknown): value is PublishedPluginProfile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!("caseId" in value) || typeof value.caseId !== "string"
    || !("id" in value) || typeof value.id !== "string"
    || !("version" in value) || typeof value.version !== "string"
    || !("fileCount" in value) || typeof value.fileCount !== "number" || !Number.isSafeInteger(value.fileCount)
    || !("featureCode" in value) || typeof value.featureCode !== "string"
    || !("searchQuery" in value) || typeof value.searchQuery !== "string"
    || !("title" in value) || typeof value.title !== "string"
    || !("runtime" in value) || (value.runtime !== "web" && value.runtime !== "node")
    || !("dataAccess" in value) || typeof value.dataAccess !== "boolean"
    || !("pathAccess" in value) || (value.pathAccess !== "none" && value.pathAccess !== "standard")
    || !("frameOperations" in value) || typeof value.frameOperations !== "string") return false;
  if ("sourceKind" in value && value.sourceKind !== "local_full_directory"
    && value.sourceKind !== "local_original_archive" && value.sourceKind !== "converted_handoff_directory") return false;
  if ("verifyDataPersistence" in value && typeof value.verifyDataPersistence !== "boolean") return false;
  if ("dialogAccess" in value && value.dialogAccess !== "none" && value.dialogAccess !== "open" && value.dialogAccess !== "save"
    && (value.dialogAccess !== "open_and_save" || !isExactImageStitchProfile(value))) return false;
  if ("archiveSha256" in value && typeof value.archiveSha256 !== "string") return false;
  if ("directorySha256" in value && typeof value.directorySha256 !== "string") return false;
  if ("sourceCommit" in value && typeof value.sourceCommit !== "string") return false;
  if ("sourceTree" in value && typeof value.sourceTree !== "string") return false;
  if ("sourceReview" in value && typeof value.sourceReview !== "string") return false;
  if ("sourceReviewStatus" in value && typeof value.sourceReviewStatus !== "string") return false;
  return true;
}

function fixture() {
  const profile = registry.cases[0];
  return { token: "owned-token", pluginRoot: "/private/tmp/reviewed", assetProbePath: "/private/tmp/probe.js",
    runId: "current-run", packageSha256: profile.archiveSha256, profile } as PublishedFixture;
}
it("accepts the Rust profile independently of JSON key ordering", () => {
  const value = fixture(); value.profile = Object.fromEntries(Object.entries(value.profile).reverse()) as unknown as PublishedFixture["profile"];
  expect(verifyFixtureProfile(value)).toEqual(fixture().profile);
});
it.each(["caseId", "version", "archiveSha256", "runtime", "dataAccess", "pathAccess", "featureCode", "searchQuery", "frameOperations"])("rejects altered %s before package operations", key => {
  const value = fixture(); value.profile = { ...value.profile, [key]: "unregistered" };
  expect(() => verifyFixtureProfile(value)).toThrow(/unknown profile/);
});
it("permits exactly one bounded standard path snapshot only for its pinned profile", () => {
  expect(registry.cases.filter(item => item.pathAccess === "standard").map(item => item.caseId)).toEqual(["regex-editor"]);
  const value = { pathRuntimeAvailable: true, activePathSnapshots: 1, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 120 } as RuntimeState;
  expect(publishedPathsReady(value, "standard")).toBe(true);
  expect(publishedPathsReady(value, "none")).toBe(false);
  for (const changed of [{ pathRuntimeAvailable: false }, { activePathSnapshots: 0 }, { activePathSnapshots: 2 },
    { activePathIntents: 1 }, { activePathPreparations: 1 }, { pathSnapshotBytes: 0 }, { pathSnapshotBytes: 128 * 1024 + 1 }]) {
    expect(publishedPathsReady({ ...value, ...changed }, "standard")).toBe(false);
  }
  expect(publishedPathsReady({ ...value, activePathSnapshots: 0, pathSnapshotBytes: 0 }, "none")).toBe(true);
});
it("pins DeepRead to open-dialog permission and no standard-path snapshot", () => {
  const profile = convertedRegistry.cases.find(item => item.caseId === "converted-deepread-source")!;
  if (!isPublishedPluginProfile(profile)) throw Error("Converted DeepRead fixture registration has an invalid profile shape");
  const pins = convertedRegistry.handoffs[profile.caseId as keyof typeof convertedRegistry.handoffs];
  expect(profile).toMatchObject({ pathAccess: "none", dialogAccess: "open", dataAccess: true, runtime: "web" });
  const convertedHandoff = { caseId: profile.caseId, sourceCaseId: pins.sourceCaseId, artifactKind: pins.artifactKind,
    handoffStatus: pins.handoffStatus, nativeUiConsumerSupported: pins.nativeUiConsumerSupported,
    manifestSha256: pins.manifestSha256,
    source: { sourceRevision: pins.sourceRevision, manifestSha256: pins.sourceManifestSha256,
      fileCount: pins.sourceFileCount, bytes: pins.sourceBytes, inventorySha256: pins.sourceInventorySha256 },
    sourceRevision: pins.sourceRevision, dependencySetIdSha256: pins.dependencySetIdSha256,
    dependencyTreeSha256: pins.dependencyTreeSha256, dependencyTreeBytes: pins.dependencyTreeBytes,
    installedPackageTreeSha256: pins.installedPackageTreeSha256, treeEntries: pins.treeEntries,
    treeFiles: pins.treeFiles, treeBytes: pins.treeBytes,
    conversionSourceProvenanceUnchanged: true as const, businessUsabilityVerified: false as const };
  const fixture: PublishedFixture = { token: "fixed-token", runId: "fixed-run", packageSha256: profile.directorySha256!,
    profile, workerContractOnly: false, nativeUiInput: false, convertedHandoff };
  expect(verifyFixtureProfile(fixture)).toEqual(profile);
  expect(verifyFixtureProfile({ ...fixture, deepReadTextEncoding: "utf8-bom" })).toEqual(profile);
  expect(() => verifyFixtureProfile({ ...fixture, deepReadTextEncoding: "ascii" } as unknown as PublishedFixture)).toThrow();
  expect(() => verifyFixtureProfile({ ...fixture, deepReadTextEncoding: "utf8-bom", unexpectedEncodingMetadata: true } as PublishedFixture)).toThrow();
});
it("accepts combined open/save metadata only for the exact pinned Web Image Stitch fixture", () => {
  expect(isPublishedPluginProfile(IMAGE_STITCH_PROFILE)).toBe(true);
  expect(isExactImageStitchProfile(IMAGE_STITCH_PROFILE)).toBe(true);
  expect(isExactImageStitchProfile({ ...IMAGE_STITCH_PROFILE, sourceTree: "0".repeat(40) })).toBe(false);
  expect(isExactImageStitchProfile({ ...IMAGE_STITCH_PROFILE, id: "another-plugin" })).toBe(false);
  expect(isExactImageStitchProfile({ ...IMAGE_STITCH_PROFILE, runtime: "node" })).toBe(false);
  expect(verifyFixtureProfile({ token: "token", pluginRoot: "/private/tmp/image-stitch", assetProbePath: "/private/tmp/probe.js",
    runId: "run", packageSha256: IMAGE_STITCH_PROFILE.directorySha256!, profile: IMAGE_STITCH_PROFILE })).toEqual(IMAGE_STITCH_PROFILE);
  expect(() => verifyFixtureProfile({ token: "token", pluginRoot: "/private/tmp/image-stitch", assetProbePath: "/private/tmp/probe.js",
    runId: "run", packageSha256: IMAGE_STITCH_PROFILE.directorySha256!,
    profile: { ...IMAGE_STITCH_PROFILE, sourceTree: "0".repeat(40) } })).toThrow(/unknown profile/);
});
it("rejects DeepRead encoding metadata on other registered fixture DTOs", () => {
  expect(() => verifyFixtureProfile({ ...fixture(), deepReadTextEncoding: "utf8-bom" } as PublishedFixture)).toThrow();
});
it("pins Todo as a Web preload with actual data access independently of Node runtime", () => {
  const profile = registry.cases.find(item => item.caseId === "todo-neo")!;
  expect(profile).toMatchObject({ id: "todo-neo", version: "0.0.1", runtime: "web", dataAccess: true, fileCount: 8 });
  expect(verifyFixtureProfile({ ...fixture(), profile, packageSha256: profile.archiveSha256 } as PublishedFixture)).toEqual(profile);
  const empty: RuntimeState = { resourceLeases: 1, legacySessions: 0, legacyOpenings: 0, legacyTransport: false, pendingRequests: 0,
    hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
    dataSessions: 0, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: false,
    pathRuntimeAvailable: true, activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
    dialogSessions: 0, dialogIntents: 0, dialogInvocations: 0, dialogPreparations: 0, nativeDialogs: 0, dialogTransport: false,
    displayRuntimeAvailable: true, displaySessions: 0, displayIntents: 0, displayInvocations: 0 };
  const approved = { ...empty, dataSessions: 1, dataTransport: true };
  expect(publishedWebRuntimeReady(empty, false)).toBe(true);
  expect(publishedWebRuntimeReady(approved, true)).toBe(true);
  expect(publishedWebRuntimeReady(empty, true)).toBe(false);
  expect(publishedWebRuntimeReady(approved, false)).toBe(false);
  for (const changed of [{ legacySessions: 1 }, { legacyTransport: true }, { dataSessions: 2 }, { dataPreparations: 1 },
    { dataInvocations: 1 }, { dataIntents: 1 }, { hostSessions: 1 }, { pendingRequests: 1 }]) {
    expect(publishedWebRuntimeReady({ ...approved, ...changed }, true)).toBe(false);
  }
  expect(runtimeDrained(approved)).toBe(false);
});
it("rejects missing run identity and package digest", () => {
  expect(() => verifyFixtureProfile({ ...fixture(), runId: "" })).toThrow(/run identity/);
  expect(() => verifyFixtureProfile({ ...fixture(), packageSha256: "0".repeat(64) })).toThrow(/SHA/);
});
it("requires all runtime counters to drain, including opening and pending permission requests", () => {
  const empty: RuntimeState = { resourceLeases: 0, legacySessions: 0, legacyOpenings: 0, legacyTransport: false, pendingRequests: 0,
    hostSessions: 0, hostIntents: 0, hostInvocations: 0, hostTransport: false,
    dataSessions: 0, dataIntents: 0, dataInvocations: 0, dataPreparations: 0, dataTransport: false,
    pathRuntimeAvailable: true, activePathSnapshots: 0, activePathIntents: 0, activePathPreparations: 0, pathSnapshotBytes: 0,
    dialogSessions: 0, dialogIntents: 0, dialogInvocations: 0, dialogPreparations: 0, nativeDialogs: 0, dialogTransport: false,
    displayRuntimeAvailable: true, displaySessions: 0, displayIntents: 0, displayInvocations: 0 };
  expect(runtimeDrained(empty)).toBe(true);
  for (const [key, value] of Object.entries(empty)) {
    if (key === "displayRuntimeAvailable") continue;
    expect(runtimeDrained({ ...empty, [key]: typeof value === "boolean" ? !value : 1 })).toBe(false);
  }
});
it("gates runtime errors, rejected promises, CSP and console errors while retaining warnings as diagnostics", () => {
  const events = ["securitypolicyviolation", "resource-load-error", "uncaught-error", "unhandled-rejection", "console-error", "console-warning"];
  expect(blockingPublishedDiagnostics(events.map(event => ({ event }))).map(item => item.event)).toEqual(events.slice(0, 5));
});
it("rejects same-origin sandbox or exposed parent/Tauri state", () => {
  const frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts allow-popups");
  const state = { origin: "null", parentDocumentAccessBlocked: true, tauriInternalsType: "undefined", globalTauriType: "undefined" };
  const check = (ok: unknown, label: string) => { if (!ok) throw Error(label); };
  expect(verifyPublishedFrameIsolation(frame, state, check).sandbox).toEqual(["allow-scripts", "allow-popups"]);
  for (const changed of [{ origin: "atools-published://localhost" }, { parentDocumentAccessBlocked: false },
    { tauriInternalsType: "object" }, { globalTauriType: "object" }]) {
    expect(() => verifyPublishedFrameIsolation(frame, { ...state, ...changed }, check)).toThrow();
  }
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
  expect(() => verifyPublishedFrameIsolation(frame, state, check)).toThrow(/opaque sandbox/);
});
