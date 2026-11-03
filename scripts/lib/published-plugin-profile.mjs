import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readLocalOriginalRegistry } from "./local-original-registry.mjs";
import { readConvertedSourceProfile } from "./converted-source-handoff.mjs";

const registryUrl = new URL("../../tests/fixtures/published-plugin-cases.json", import.meta.url);
const localArchiveRegistryUrl = new URL("../../tests/fixtures/local-original-archive-cases.json", import.meta.url);

export function profilePackageDigest(profile) {
  return ["local_full_directory", "converted_handoff_directory"].includes(profile.sourceKind)
    ? profile.directorySha256 : profile.archiveSha256;
}

export async function readPublishedPluginProfile(caseId = "regex-editor") {
  if (["converted-my-calculator-source", "converted-tetris-source", "converted-todo-neo-source", "converted-deepread-source"].includes(caseId)) return (await readConvertedSourceProfile(caseId)).profile;
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.cases)) throw Error("Invalid published fixture registry");
  const localRegistry = await readLocalOriginalRegistry();
  const archiveRegistry = JSON.parse(await readFile(localArchiveRegistryUrl, "utf8"));
  const profile = [...registry.cases, ...localRegistry.cases, ...archiveRegistry.cases].find(item => item.caseId === caseId);
  if (!profile || !/^[a-f0-9]{64}$/.test(profilePackageDigest(profile))
    || (profile.sourceKind !== undefined && !["local_full_directory", "local_original_archive"].includes(profile.sourceKind))
    || (profile.sourceKind === "local_full_directory" && (profile.archiveSha256 !== undefined
      || typeof profile.verifyDataPersistence !== "boolean" || (profile.verifyDataPersistence && profile.dataAccess !== true)
      || (!([undefined, "none", "save"].includes(profile.dialogAccess))
        && !(profile.caseId === "local-image-stitch-head" && profile.dialogAccess === "open_and_save"))))
    || (profile.sourceKind === "local_original_archive" && (profile.directorySha256 !== undefined || profile.archiveExtension !== "zpx" || profile.verifyDataPersistence !== false))
    || !Number.isInteger(profile.fileCount) || profile.fileCount < 1
    || !["web", "node"].includes(profile.runtime) || typeof profile.dataAccess !== "boolean"
    || !["none", "standard"].includes(profile.pathAccess) || !profile.id || !profile.version
    || !["prepared_for_parent_native_fixture_decision", "prepared_for_parent_native_fixture_decision_with_known_upstream_defect"].includes(profile.sourceReviewStatus)
    || !profile.featureCode || !profile.searchQuery || !profile.title
    || !/^tests\/components\/native(?:Published|Original)[A-Za-z]+FrameOperations\.js$/.test(profile.frameOperations)) {
    throw Error("Unknown or unpinned published plugin case: " + caseId);
  }
  return Object.freeze(profile);
}

export function assertReviewedFixture(profile, fixture, pluginRoot, expectedSha256) {
  if (profile.sourceKind === "converted_handoff_directory") throw Error("Converted handoffs use their dedicated pinned verifier");
  const fixtureDigest = profile.sourceKind === "local_full_directory" ? fixture?.directorySha256 : fixture?.archiveSha256;
  if (!fixture || expectedSha256 !== profilePackageDigest(profile) || fixtureDigest !== expectedSha256
    || (profile.sourceKind && fixture.sourceKind !== profile.sourceKind)
    || fixture.id !== profile.id || fixture.version !== profile.version
    || !Array.isArray(fixture.files) || fixture.files.length !== profile.fileCount
    || typeof fixture.pluginRoot !== "string" || pluginRoot !== resolve(fixture.pluginRoot)
    || profile.sourceKind === "local_original_archive" && (fixture.packageImportPath !== fixture.archivePath
      || fixture.archivePath !== resolve(fixture.ownedRoot, "source.zpx")
      || fixture.originalSourcePath !== resolve(new URL("../../", import.meta.url).pathname, profile.sourcePath))) {
    throw Error("Package root, identity, file count or archive SHA is not the registered reviewed fixture");
  }
}

export function assertNativeReportIdentity(report, profile, runId, executionMode) {
  const sameProfile = report?.profile && Object.keys(profile).length === Object.keys(report.profile).length
    && Object.entries(profile).every(([key, value]) => report.profile[key] === value);
  if (!report || report.runId !== runId || !sameProfile
    || report.packageSha256 !== profilePackageDigest(profile)
    || executionMode !== undefined && (!["original_ui", "original_worker_contract"].includes(executionMode)
      || report.executionMode !== executionMode)) {
    throw Error("Native result does not match this run and registered profile");
  }
}

export function publishedAcceptancePassed(report) {
  const converted = report.profile?.sourceKind === "converted_handoff_directory";
  const sourceVerified = converted
    ? report.handoffManifestPinUnchanged === true
      && report.convertedPackageTreeVerifiedBeforeExecution === true
      && report.conversionSourceProvenanceUnchanged === true
      && report.nativeReport?.preExecutionSourceVerification?.convertedPackageTreeVerifiedBeforeExecution === true
      && report.nativeReport?.preExecutionSourceVerification?.conversionSourceProvenanceUnchanged === true
      && report.nativeReport?.observations?.convertedTargetVerification?.imported?.importSourceTreeUnchanged === true
      && report.nativeReport?.observations?.convertedTargetVerification?.installedTargetMatchesHandoff === true
      && report.nativeReport?.observations?.postRunConvertedTargetVerification?.conversionSourceProvenanceUnchanged === true
      && report.nativeReport?.observations?.postRunConvertedTargetVerification?.importSourceTreeUnchanged === true
      && report.nativeReport?.observations?.postRunConvertedTargetVerification?.installedTargetMatchesHandoff === true
      && report.postRunConvertedTargetVerification?.conversionSourceProvenanceUnchanged === true
      && report.postRunConvertedTargetVerification?.importSourceTreeUnchanged === true
      && report.postRunConvertedTargetVerification?.installedTargetMatchesHandoff === true
    : report.preSpawnSourceVerification?.sourceBytesUnchanged === true
      && report.nativeReport?.preExecutionSourceVerification?.sourceBytesUnchanged === true
      && report.sourceBytesUnchanged === true;
  return report.buildOnly === false && report.nativeRuntimeExecuted === true && report.nativeAssertionsPassed === true
    && report.nativeProcess?.passed === true && report.reportFreshness?.identityValidated === true
    && sourceVerified && report.fixtureSourcesUnchanged === true
    && (report.schemaVersion < 3 || report.schemaVersion === undefined || report.fixtureArtifactsUnchanged === true)
    && report.cleanup?.isolatedEnvironmentRemoved === true && report.cleanup?.scratchRemoved === true
    && report.cleanup.errors.length === 0;
}
