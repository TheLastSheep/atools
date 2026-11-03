import { constants } from "node:fs";
import { open, lstat, realpath, readFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";

const registryUrl = new URL("../../tests/fixtures/converted-source-cases.json", import.meta.url);
const MAX_MANIFEST_BYTES = 64 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const taskSequence = ["inspect_ztools_source_dependencies", "fetch_ztools_source_dependencies",
  "prepare_ztools_source_dependencies", "inspect_ztools_source_dependencies",
  "inspect_ztools_source_build", "convert_ztools_plugin"];
const sourceCases = {
  "converted-my-calculator-source": { id: "my-calculator", version: "1.0.1", title: "计算器", searchQuery: "calc",
    runtime: "node", featureCode: "calculator", dataAccess: false, pathAccess: "standard",
    verifyDataPersistence: false,
    frameOperations: "tests/components/nativeOriginalCalculatorFrameOperations.js", sourceCaseId: "fixed-head-my-calculator",
    artifactKind: "converted_ui_handoff_v1", handoffStatus: "ready_for_native_ui_fixture", nativeUiConsumerSupported: true },
  "converted-tetris-source": { id: "tetris", version: "1.0.0", title: "俄罗斯方块", searchQuery: "tetris",
    runtime: "web", producerRuntime: "web", featureCode: "tetris", dataAccess: true, pathAccess: "none",
    verifyDataPersistence: false,
    frameOperations: "tests/components/nativeTetrisFrameOperations.js", sourceCaseId: "fixed-head-tetris",
    artifactKind: "converted_source_evidence", handoffStatus: "conversion_evidence_only", nativeUiConsumerSupported: false },
  "converted-todo-neo-source": { id: "todo-neo", version: "0.0.1", title: "Todo", searchQuery: "ToDo 待办",
    runtime: "web", featureCode: "todo", dataAccess: true, pathAccess: "none",
    verifyDataPersistence: true,
    producerRuntime: "node",
    frameOperations: "tests/components/nativePublishedTodoFrameOperations.js", sourceCaseId: "fixed-head-todo-neo",
    artifactKind: "converted_source_evidence", handoffStatus: "conversion_evidence_only", nativeUiConsumerSupported: false },
  "converted-deepread-source": { id: "deepread", version: "1.1.2", title: "DeepRead 深读", searchQuery: "DeepRead",
    runtime: "web", producerRuntime: "node", featureCode: "deepread", dataAccess: true, pathAccess: "none", dialogAccess: "open",
    verifyDataPersistence: true,
    frameOperations: "tests/components/nativePublishedDeepReadFrameOperations.js", sourceCaseId: "fixed-head-deepread-public",
    artifactKind: "converted_source_evidence", handoffStatus: "conversion_evidence_only", nativeUiConsumerSupported: false,
    selectedPublicManifestSha256: "1ad7c1b5ddd7ce687878d8aca0da319d9f75ef6d77e101ed8a706d6a1d268192" },
};
const requiredSourceCases = ["converted-my-calculator-source", "converted-tetris-source"];
const profileKeys = ["caseId", "id", "version", "sourceKind", "directorySha256", "fileCount", "featureCode", "searchQuery",
  "title", "runtime", "dataAccess", "pathAccess", "verifyDataPersistence", "frameOperations"];
const pinKeys = ["archiveBytes", "artifactFileName", "artifactKind", "dependencySetIdSha256", "dependencyTreeBytes",
  "dependencyTreeEntries", "dependencyTreeFiles", "dependencyTreeSha256", "handoffStatus", "installedPackageTreeSha256",
  "manifestSha256", "nativeUiConsumerSupported", "nodeBinaryBytes", "nodeBinarySha256", "packageCount", "planSha256",
  "pluginMain", "pluginPreload", "preparedFileCount", "preparedManifestSha256", "skippedOptionalCount", "sourceBytes",
  "sourceCaseId", "sourceFileCount", "sourceInventorySha256", "sourceManifestSha256", "sourceRevision",
  "toolchainFingerprintSha256", "treeBytes", "treeEntries", "treeFiles", "unpackedBytes", "upstreamHead", "fetchedArchiveCount"];
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const record = value => !!value && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => record(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const stable = value => Array.isArray(value) ? value.map(stable) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const sameJson = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
const elapsed = value => Number.isSafeInteger(value) && value >= 0 && value <= 120000;

export async function readConvertedSourceProfile(caseId) {
  const registry = JSON.parse(await readFile(registryUrl, "utf8"));
  if (registry.schemaVersion !== 2 || !Array.isArray(registry.cases) || !record(registry.handoffs)
    || registry.cases.length !== Object.keys(registry.handoffs).length
    || !requiredSourceCases.every(id => registry.cases.some(item => item.caseId === id))
    || registry.cases.some(item => !Object.hasOwn(sourceCases, item.caseId))
    || JSON.stringify(registry.cases.map(item => item.caseId).sort()) !== JSON.stringify(Object.keys(registry.handoffs).sort())) {
    throw Error("Converted source fixture registry is invalid");
  }
  const profiles = registry.cases.filter(item => item.caseId === caseId);
  if (profiles.length !== 1 || !Object.hasOwn(registry.handoffs, caseId)) throw Error("Unknown converted source case");
  const profile = profiles[0], handoff = registry.handoffs[caseId];
  assertConvertedSourceProfile(profile, handoff, caseId);
  return { profile: Object.freeze(profile), handoff: Object.freeze(handoff) };
}

export function assertConvertedSourceProfile(profile, handoff, caseId) {
  const expectedProfileKeys = caseId === "converted-deepread-source" ? [...profileKeys, "dialogAccess"] : profileKeys;
  const expectedPinKeys = caseId === "converted-deepread-source" ? [...pinKeys, "selectedPublicManifestSha256"] : pinKeys;
  const expected = sourceCases[caseId];
  if (!exactKeys(profile, expectedProfileKeys) || !exactKeys(handoff, expectedPinKeys)
    || !expected || profile.sourceKind !== "converted_handoff_directory" || profile.id !== expected.id || profile.version !== expected.version
    || profile.directorySha256 !== handoff.installedPackageTreeSha256 || profile.fileCount !== handoff.treeFiles
    || !HASH.test(handoff.manifestSha256) || !HASH.test(profile.directorySha256)
    || profile.title !== expected.title || profile.searchQuery !== expected.searchQuery
    || profile.runtime !== expected.runtime || profile.featureCode !== expected.featureCode
    || profile.dataAccess !== expected.dataAccess || profile.pathAccess !== expected.pathAccess
    || profile.dialogAccess !== expected.dialogAccess
    || profile.verifyDataPersistence !== expected.verifyDataPersistence
    || profile.frameOperations !== expected.frameOperations || handoff.sourceCaseId !== expected.sourceCaseId
    || handoff.artifactKind !== expected.artifactKind || handoff.handoffStatus !== expected.handoffStatus
    || handoff.nativeUiConsumerSupported !== expected.nativeUiConsumerSupported
    || caseId === "converted-deepread-source" && (handoff.selectedPublicManifestSha256 !== expected.selectedPublicManifestSha256
      || !HASH.test(handoff.selectedPublicManifestSha256))) {
    throw Error("Converted source profile differs from its handoff pins");
  }
  return profile;
}

export async function readConvertedSourceHandoff(manifestPath, expectedSha256, profile, pinned) {
  if (typeof manifestPath !== "string" || !manifestPath.startsWith("/private/tmp/")
    || resolve(manifestPath) !== manifestPath || basename(manifestPath) !== pinned.artifactFileName
    || !HASH.test(expectedSha256) || expectedSha256 !== pinned.manifestSha256
    || profile.sourceKind !== "converted_handoff_directory") {
    throw Error("Converted handoff identity or path is not the registered fixture");
  }
  const parent = dirname(manifestPath);
  let parentInfo, parentReal;
  try { parentInfo = await lstat(parent); parentReal = await realpath(parent); }
  catch { throw Error("Converted handoff parent is unavailable"); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentReal !== parent
    || !basename(parent).startsWith("atools-batch235-")) {
    throw Error("Converted handoff parent is not the owned retained fixture directory");
  }
  const noFollow = constants.O_NOFOLLOW;
  if (!Number.isInteger(noFollow)) throw Error("No-follow handoff reads are unavailable");
  let handle;
  try { handle = await open(manifestPath, constants.O_RDONLY | noFollow); }
  catch { throw Error("Converted handoff manifest is unavailable for a no-follow read"); }
  let bytes;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_MANIFEST_BYTES))
      throw Error("Converted handoff manifest exceeds its regular-file byte bound");
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES + 1);
    let used = 0;
    while (used < buffer.length) {
      const read = await handle.read(buffer, used, buffer.length - used, null);
      if (read.bytesRead === 0) break;
      used += read.bytesRead;
    }
    if (used > MAX_MANIFEST_BYTES) throw Error("Converted handoff manifest exceeds its byte bound");
    bytes = buffer.subarray(0, used);
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || BigInt(used) !== after.size) {
      throw Error("Converted handoff changed while it was read");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Converted handoff manifest exceeds")) throw error;
    throw Error("Converted handoff manifest could not be read safely");
  } finally { await handle.close(); }
  const actualSha = sha256(bytes);
  if (actualSha !== expectedSha256) throw Error("Converted handoff raw SHA-256 does not match the explicit pin");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let document;
  try { document = JSON.parse(text); } catch { throw Error("Converted handoff manifest is invalid JSON"); }
  const identity = validateConvertedHandoffDocument(document, manifestPath, profile, pinned);
  return { manifestPath, manifestSha256: actualSha, identity };
}

export function validateConvertedHandoffDocument(value, manifestPath, profile, pinned) {
  if (pinned.artifactKind === "converted_source_evidence") return validateSourceEvidence(value, manifestPath, profile, pinned);
  if (pinned.artifactKind !== "converted_ui_handoff_v1") throw Error("Unknown converted artifact kind");
  const topKeys = ["activeTaskRunCount", "allLeasesInactive", "appDataRoot", "businessUsabilityVerified", "conversion",
    "dependencies", "expectedSequence", "fixtureRoot", "handoffStatus", "installationTaskRun", "installedPackage",
    "installedPackagePath", "pendingPermissionRequestCount", "schemaVersion", "source", "sourceFilesUnchanged",
    "taskRunCount", "taskRuns", "taskRunsTerminal"];
  if (!exactKeys(value, topKeys) || value.schemaVersion !== 1 || value.handoffStatus !== "ready_for_native_ui_fixture"
    || value.businessUsabilityVerified !== false || value.sourceFilesUnchanged !== true || value.taskRunsTerminal !== true
    || value.allLeasesInactive !== true || value.activeTaskRunCount !== 0 || value.pendingPermissionRequestCount !== 0
    || value.taskRunCount !== 7 || !Array.isArray(value.expectedSequence) || value.expectedSequence.length !== taskSequence.length
    || value.expectedSequence.some((tool, index) => tool !== taskSequence[index])) {
    throw Error("Converted handoff is not a bounded successful pipeline receipt");
  }
  const fixtureRoot = value.fixtureRoot;
  if (typeof fixtureRoot !== "string" || !fixtureRoot.startsWith("/private/tmp/atools-batch235-")
    || resolve(fixtureRoot) !== fixtureRoot || dirname(manifestPath) !== fixtureRoot
    || value.appDataRoot !== resolve(fixtureRoot, "app-data")
    || value.installedPackagePath !== resolve(fixtureRoot, "app-data/plugins", profile.id)) {
    throw Error("Converted handoff roots do not match the retained manifest location");
  }
  const source = value.source, dependency = value.dependencies, installed = value.installedPackage;
  if (!exactKeys(source, ["bytes", "fileCount", "inventorySha256", "manifestSha256", "path", "sourceRevision", "upstreamHead"])
    || source.upstreamHead !== pinned.upstreamHead || source.manifestSha256 !== pinned.sourceManifestSha256
    || source.inventorySha256 !== pinned.sourceInventorySha256 || source.sourceRevision !== pinned.sourceRevision
    || source.fileCount !== pinned.sourceFileCount || source.bytes !== pinned.sourceBytes
    || source.path !== "/private/tmp/atools-batch107-root/my-calculator-head-v1"
    || !exactKeys(dependency, ["dependencySetIdSha256", "nodeBinaryBytes", "nodeBinarySha256", "packageCount",
      "toolchainFingerprintSha256", "treeBytes", "treeEntries", "treeFiles", "treeSha256"])
    || dependency.dependencySetIdSha256 !== pinned.dependencySetIdSha256
    || dependency.treeSha256 !== pinned.dependencyTreeSha256 || dependency.treeBytes !== pinned.dependencyTreeBytes
    || dependency.nodeBinarySha256 !== pinned.nodeBinarySha256 || dependency.nodeBinaryBytes !== pinned.nodeBinaryBytes
    || dependency.toolchainFingerprintSha256 !== pinned.toolchainFingerprintSha256
    || dependency.packageCount !== pinned.packageCount || dependency.treeEntries !== pinned.dependencyTreeEntries
    || dependency.treeFiles !== pinned.dependencyTreeFiles
    || !exactKeys(installed, ["pluginId", "treeBytes", "treeEntries", "treeFiles", "treeSha256", "version"])
    || installed.pluginId !== profile.id || installed.version !== profile.version
    || installed.treeSha256 !== pinned.installedPackageTreeSha256 || installed.treeSha256 !== profile.directorySha256
    || installed.treeEntries !== pinned.treeEntries || installed.treeFiles !== pinned.treeFiles
    || installed.treeBytes !== pinned.treeBytes) {
    throw Error("Converted handoff source, dependency, or installed tree identity differs from the pin");
  }
  if (!exactKeys(value.conversion, ["capabilityId", "output", "status", "taskRunId"])
    || value.conversion.capabilityId !== "convert_ztools_plugin" || value.conversion.status !== "succeeded"
    || !validRunId(value.conversion.taskRunId) || !record(value.conversion.output)) {
    throw Error("Converted handoff lacks the successful conversion TaskRun summary");
  }
  const converted = value.conversion.output;
  if (converted.installed !== true || converted.pluginId !== profile.id || converted.sourceRevision !== pinned.sourceRevision
    || converted.dependencySetIdSha256 !== pinned.dependencySetIdSha256
    || converted.dependencyTreeSha256 !== pinned.dependencyTreeSha256
    || converted.toolchainFingerprintSha256 !== pinned.toolchainFingerprintSha256
    || converted.businessOperationVerified !== false || converted.dependencyClosureVerified !== false
    || !Array.isArray(converted.buildSteps) || converted.buildSteps.length !== 2
    || converted.buildSteps[0]?.kind !== "typecheck" || converted.buildSteps[1]?.kind !== "viteBuild") {
    throw Error("Converted handoff build or conversion identities are incomplete");
  }
  if (!Array.isArray(value.taskRuns) || value.taskRuns.length !== taskSequence.length) throw Error("Converted handoff TaskRun inventory is malformed");
  const taskIds = new Set();
  for (let index = 0; index < taskSequence.length; index++) {
    const run = value.taskRuns[index];
    if (!exactKeys(run, ["capabilityId", "output", "status", "taskRunId"]) || run.capabilityId !== taskSequence[index]
      || run.status !== "succeeded" || !validRunId(run.taskRunId) || taskIds.has(run.taskRunId)) throw Error("Converted handoff TaskRun inventory is malformed");
    taskIds.add(run.taskRunId);
  }
  if (value.conversion.taskRunId !== value.taskRuns[5].taskRunId) throw Error("Conversion TaskRun identity is inconsistent");
  if (!exactKeys(value.installationTaskRun, ["capabilityId", "clientId", "initiatorType", "status", "taskRunId"])
    || value.installationTaskRun.capabilityId !== "atools-ui.plugin.import"
    || value.installationTaskRun.clientId !== "atools-ui" || value.installationTaskRun.initiatorType !== "human"
    || value.installationTaskRun.status !== "succeeded" || !validRunId(value.installationTaskRun.taskRunId)
    || taskIds.has(value.installationTaskRun.taskRunId)) {
    throw Error("Converted handoff installation record is malformed");
  }
  return Object.freeze({ manifestSha256: pinned.manifestSha256, sourceRevision: pinned.sourceRevision,
    dependencySetIdSha256: pinned.dependencySetIdSha256, dependencyTreeSha256: pinned.dependencyTreeSha256,
    dependencyTreeBytes: pinned.dependencyTreeBytes, installedPackageTreeSha256: pinned.installedPackageTreeSha256,
    treeEntries: pinned.treeEntries, treeFiles: pinned.treeFiles, treeBytes: pinned.treeBytes,
    conversionSourceProvenanceUnchanged: true, businessUsabilityVerified: false });
}

function validateSourceEvidence(value, manifestPath, profile, pinned) {
  const sequence = taskSequence;
  const topKeys = ["activeTaskRunCount", "allLeasesInactive", "appDataRoot", "artifactKind", "businessUsabilityVerified",
    "conversion", "dependencies", "expectedSequence", "fixtureRoot", "handoffStatus", "installationTaskRun",
    "installedPackage", "installedPackagePath", "nativeUiConsumerSupported", "pendingPermissionRequestCount",
    "pluginIdentity", "schemaVersion", "source", "sourceCaseId", "sourceFilesUnchanged", "taskRunCount", "taskRuns", "taskRunsTerminal"];
  const root = dirname(manifestPath), appData = resolve(root, "app-data"), installedPath = resolve(appData, "plugins", profile.id);
  const expectedSourcePath = profile.caseId === "converted-tetris-source"
    ? "/private/tmp/atools-batch107-root/tetris-head-v1"
    : profile.caseId === "converted-todo-neo-source" ? "/private/tmp/atools-batch107-root/todo-neo-head-v1"
    : profile.caseId === "converted-deepread-source" ? "/private/tmp/atools-batch335-deepread-producer/source-fixed-head-v1" : null;
  if (!expectedSourcePath || !exactKeys(value, topKeys) || value.schemaVersion !== 1 || value.artifactKind !== pinned.artifactKind
    || value.sourceCaseId !== pinned.sourceCaseId || value.handoffStatus !== pinned.handoffStatus
    || value.nativeUiConsumerSupported !== false || pinned.nativeUiConsumerSupported !== false
    || value.businessUsabilityVerified !== false || value.sourceFilesUnchanged !== true || value.taskRunsTerminal !== true
    || value.pendingPermissionRequestCount !== 0 || value.activeTaskRunCount !== 0 || value.allLeasesInactive !== true
    || value.taskRunCount !== sequence.length + 1 || !Array.isArray(value.expectedSequence)
    || value.expectedSequence.length !== sequence.length || value.expectedSequence.some((item, i) => item !== sequence[i])
    || value.fixtureRoot !== root || value.appDataRoot !== appData || value.installedPackagePath !== installedPath) {
    throw Error("Converted source evidence is not a bounded successful conversion record");
  }
  const source = value.source, deps = value.dependencies, plugin = value.pluginIdentity, installed = value.installedPackage;
  if (!exactKeys(source, ["bytes", "fileCount", "inventorySha256", "manifestSha256", "path", "sourceRevision", "upstreamHead"])
    || source.path !== expectedSourcePath || source.upstreamHead !== pinned.upstreamHead
    || source.manifestSha256 !== pinned.sourceManifestSha256 || source.inventorySha256 !== pinned.sourceInventorySha256
    || source.sourceRevision !== pinned.sourceRevision || source.fileCount !== pinned.sourceFileCount || source.bytes !== pinned.sourceBytes
    || !exactKeys(deps, ["dependencySetIdSha256", "nodeBinaryBytes", "nodeBinarySha256", "packageCount", "toolchainFingerprintSha256", "treeBytes", "treeEntries", "treeFiles", "treeSha256"])
    || deps.dependencySetIdSha256 !== pinned.dependencySetIdSha256 || deps.nodeBinaryBytes !== pinned.nodeBinaryBytes
    || deps.nodeBinarySha256 !== pinned.nodeBinarySha256 || deps.packageCount !== pinned.packageCount
    || deps.toolchainFingerprintSha256 !== pinned.toolchainFingerprintSha256 || deps.treeSha256 !== pinned.dependencyTreeSha256
    || deps.treeBytes !== pinned.dependencyTreeBytes || deps.treeEntries !== pinned.dependencyTreeEntries || deps.treeFiles !== pinned.dependencyTreeFiles
    || !exactKeys(plugin, ["featureCode", "id", "main", "preload", "runtime", "version"])
    || plugin.id !== profile.id || plugin.version !== profile.version || plugin.main !== pinned.pluginMain
    || plugin.preload !== pinned.pluginPreload
    || plugin.runtime !== (sourceCases[profile.caseId]?.producerRuntime || profile.runtime)
    || plugin.featureCode !== profile.featureCode
    || !exactKeys(installed, ["pluginId", "treeBytes", "treeEntries", "treeFiles", "treeSha256", "version"])
    || installed.pluginId !== profile.id || installed.version !== profile.version
    || installed.treeSha256 !== pinned.installedPackageTreeSha256 || installed.treeSha256 !== profile.directorySha256
    || installed.treeBytes !== pinned.treeBytes || installed.treeEntries !== pinned.treeEntries || installed.treeFiles !== pinned.treeFiles) {
    throw Error("Converted source, dependency, or installed package identity does not match the pin");
  }
  if (!Array.isArray(value.taskRuns) || value.taskRuns.length !== sequence.length) throw Error("Invalid converted source task history");
  const ids = new Set();
  for (let index = 0; index < sequence.length; index++) {
    const run = value.taskRuns[index];
    if (!exactKeys(run, ["capabilityId", "output", "status", "taskRunId"]) || run.capabilityId !== sequence[index]
      || run.status !== "succeeded" || !validRunId(run.taskRunId) || ids.has(run.taskRunId)) throw Error("Invalid converted source TaskRun evidence");
    ids.add(run.taskRunId);
    validateSourceEvidenceOutput(index, run.output, pinned, source, deps, profile);
  }
  if (!exactKeys(value.installationTaskRun, ["capabilityId", "clientId", "initiatorType", "status", "taskRunId"])
    || value.installationTaskRun.capabilityId !== "atools-ui.plugin.import" || value.installationTaskRun.clientId !== "atools-ui"
    || value.installationTaskRun.initiatorType !== "human" || value.installationTaskRun.status !== "succeeded"
    || !validRunId(value.installationTaskRun.taskRunId) || ids.has(value.installationTaskRun.taskRunId)) throw Error("Invalid converted source import TaskRun evidence");
  const final = value.taskRuns[5], conversion = value.conversion;
  if (!exactKeys(conversion, ["capabilityId", "output", "status", "taskRunId"])
    || conversion.capabilityId !== final.capabilityId || conversion.status !== final.status
    || conversion.taskRunId !== final.taskRunId || !sameJson(conversion.output, final.output)) throw Error("Converted source conversion summary mismatch");
  return Object.freeze({ manifestSha256: pinned.manifestSha256, sourceRevision: pinned.sourceRevision,
    dependencySetIdSha256: pinned.dependencySetIdSha256, dependencyTreeSha256: pinned.dependencyTreeSha256,
    dependencyTreeBytes: pinned.dependencyTreeBytes, installedPackageTreeSha256: pinned.installedPackageTreeSha256,
    treeEntries: pinned.treeEntries, treeFiles: pinned.treeFiles, treeBytes: pinned.treeBytes,
    conversionSourceProvenanceUnchanged: true, businessUsabilityVerified: false });
}

function validateSourceEvidenceOutput(index, output, pins, source, dependencies, profile) {
  const revision = pins.sourceRevision, set = pins.dependencySetIdSha256;
  if (index === 4) {
    const keys = profile.caseId === "converted-deepread-source"
      ? ["buildSteps", "manifestSelection", "manifestSha256", "pluginId", "sourceRevision", "status"]
      : ["buildSteps", "pluginId", "sourceRevision", "status"];
    if (!exactKeys(output, keys) || output.status !== "eligible"
      || output.pluginId !== profile.id || output.sourceRevision !== revision
      || profile.caseId === "converted-deepread-source" && (output.manifestSelection !== "public"
        || output.manifestSha256 !== pins.selectedPublicManifestSha256)
      || !sameJson(output.buildSteps, [{kind:"typecheck"},{kind:"viteBuild"}])) throw Error("Invalid converted source build inspection");
    return;
  }
  if (index === 5) {
    const keys = profile.caseId === "converted-deepread-source"
      ? ["buildSteps", "businessOperationVerified", "dependencyClosureVerified", "dependencySetIdSha256",
        "dependencyTreeSha256", "installed", "manifestSelection", "manifestSha256", "pluginId", "sourceRevision", "toolchainFingerprintSha256"]
      : ["buildSteps", "businessOperationVerified", "dependencyClosureVerified", "dependencySetIdSha256",
        "dependencyTreeSha256", "installed", "pluginId", "sourceRevision", "toolchainFingerprintSha256"];
    if (!exactKeys(output, keys)
      || output.pluginId !== profile.id || output.sourceRevision !== revision || output.dependencySetIdSha256 !== set
      || output.dependencyTreeSha256 !== dependencies.treeSha256 || output.toolchainFingerprintSha256 !== pins.toolchainFingerprintSha256
      || profile.caseId === "converted-deepread-source" && (output.manifestSelection !== "public"
        || output.manifestSha256 !== pins.selectedPublicManifestSha256)
      || output.businessOperationVerified !== false || output.dependencyClosureVerified !== false || output.installed !== true
      || !sameJson(output.buildSteps, [{kind:"typecheck"},{kind:"viteBuild"}])) throw Error("Invalid converted source conversion output");
    return;
  }
  const common = output.sourceRevision === revision && output.dependencySetIdSha256 === set
    && output.businessUsabilityVerified === false && output.lifecyclesSkipped === true;
  if (index === 0 || index === 3) {
    const prepared = index === 3;
    if (!exactKeys(output, ["archiveBytes", "businessUsabilityVerified", "cachedBytes", "dependencyClosureVerified", "dependencySetIdSha256",
      "dependencySetPrepared", "dependencyTreeBytes", "dependencyTreeSha256", "lifecyclesSkipped", "missingCount", "nodeBinaryBytes",
      "nodeBinarySha256", "packageCount", "planSha256", "skippedOptionalCount", "sourceRevision", "status", "target",
      "toolchainFingerprintSha256", "toolchainHashElapsedMs"]) || !common || output.status !== "eligible"
      || output.dependencyClosureVerified !== false || output.dependencySetPrepared !== prepared
      || output.packageCount !== pins.packageCount || output.planSha256 !== pins.planSha256
      || output.skippedOptionalCount !== pins.skippedOptionalCount || output.nodeBinaryBytes !== pins.nodeBinaryBytes
      || output.nodeBinarySha256 !== pins.nodeBinarySha256 || output.toolchainFingerprintSha256 !== pins.toolchainFingerprintSha256
      || output.missingCount !== (prepared ? 0 : pins.packageCount) || output.cachedBytes !== (prepared ? pins.archiveBytes : 0)
      || output.archiveBytes !== (prepared ? pins.archiveBytes : null) || !exactKeys(output.target, ["cpu", "os"])
      || output.target.os !== "darwin" || output.target.cpu !== "arm64" || !elapsed(output.toolchainHashElapsedMs) || (prepared && (output.dependencyTreeSha256 !== dependencies.treeSha256
        || output.dependencyTreeBytes !== dependencies.treeBytes)) || (!prepared && (output.dependencyTreeSha256 !== null || output.dependencyTreeBytes !== null)))
      throw Error("Invalid Tetris dependency inspection");
  } else if (index === 1) {
    if (!exactKeys(output, ["businessUsabilityVerified", "cachedArchiveCount", "dependencySetIdSha256", "dependencySetPrepared", "elapsedMs",
      "fetchedArchiveCount", "lifecyclesSkipped", "packageCount", "sourceRevision", "status", "verifiedArchiveBytes"])
      || !common || output.status !== "cached" || output.packageCount !== pins.packageCount || output.cachedArchiveCount !== 0
      || output.fetchedArchiveCount !== pins.fetchedArchiveCount || output.verifiedArchiveBytes !== pins.archiveBytes
      || output.dependencySetPrepared !== false || !elapsed(output.elapsedMs)) throw Error("Invalid Tetris fetch output");
  } else if (index === 2) {
    if (!exactKeys(output, ["archiveBytes", "businessUsabilityVerified", "dependencyClosureVerified", "dependencySetIdSha256", "fileCount",
      "manifestSha256", "nodeBinaryBytes", "nodeBinarySha256", "packageCount", "sourceRevision", "status", "toolchainFingerprintSha256",
      "toolchainHashElapsedMs", "treeBytes", "treeEntries", "treeFiles", "treeSha256", "unpackedBytes", "workerElapsedMs"])
      || output.status !== "prepared" || output.archiveBytes !== pins.archiveBytes || output.fileCount !== pins.preparedFileCount
      || output.unpackedBytes !== pins.unpackedBytes || output.manifestSha256 !== pins.preparedManifestSha256
      || output.sourceRevision !== revision || output.dependencySetIdSha256 !== set || output.packageCount !== pins.packageCount
      || output.nodeBinaryBytes !== pins.nodeBinaryBytes || output.nodeBinarySha256 !== pins.nodeBinarySha256
      || output.toolchainFingerprintSha256 !== pins.toolchainFingerprintSha256 || output.dependencyClosureVerified !== false
      || output.businessUsabilityVerified !== false || output.treeSha256 !== dependencies.treeSha256 || output.treeBytes !== dependencies.treeBytes
      || output.treeEntries !== dependencies.treeEntries || output.treeFiles !== dependencies.treeFiles
      || !elapsed(output.toolchainHashElapsedMs) || !elapsed(output.workerElapsedMs)) throw Error("Invalid Tetris prepare output");
  }
}

function validRunId(value) {
  return typeof value === "string" && /^run-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
