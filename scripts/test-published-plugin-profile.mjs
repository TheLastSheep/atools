import assert from "node:assert/strict";
import { resolve } from "node:path";
import { readPublishedPluginProfile, assertReviewedFixture, assertNativeReportIdentity, profilePackageDigest,
  publishedAcceptancePassed } from "./lib/published-plugin-profile.mjs";
import { assertConvertedSourceProfile, readConvertedSourceProfile } from "./lib/converted-source-handoff.mjs";
import { observePublishedNativeProcess } from "./lib/published-plugin-native-process.mjs";

const profile = await readPublishedPluginProfile("regex-editor");
assert.equal(profile.runtime, "node"); assert.equal(profile.fileCount, 7);
assert.equal(profile.dataAccess, false);
assert.equal(profile.pathAccess, "standard");
const todo = await readPublishedPluginProfile("todo-neo");
assert.equal(todo.runtime, "web"); assert.equal(todo.dataAccess, true); assert.equal(todo.fileCount, 8);
assert.equal((await readPublishedPluginProfile("color-helper")).dataAccess, true);
assert.equal((await readPublishedPluginProfile("com-ztools-timestamp")).dataAccess, false);
const convertedCalculator = await readPublishedPluginProfile("converted-my-calculator-source");
assert.equal(convertedCalculator.id, "my-calculator");
assert.equal(convertedCalculator.runtime, "node");
const convertedTetris = await readPublishedPluginProfile("converted-tetris-source");
assert.equal(convertedTetris.id, "tetris");
assert.equal(convertedTetris.version, "1.0.0");
assert.equal(convertedTetris.title, "俄罗斯方块");
assert.equal(convertedTetris.searchQuery, "tetris");
assert.equal(convertedTetris.runtime, "web");
assert.equal(convertedTetris.dataAccess, true);
assert.equal(convertedTetris.pathAccess, "none");
assert.equal(profilePackageDigest(convertedTetris), convertedTetris.directorySha256);
const convertedTodo = await readPublishedPluginProfile("converted-todo-neo-source");
assert.equal(convertedTodo.id, "todo-neo");
assert.equal(convertedTodo.version, "0.0.1");
assert.equal(convertedTodo.title, "Todo");
assert.equal(convertedTodo.searchQuery, "ToDo 待办");
assert.equal(convertedTodo.runtime, "web");
assert.equal(convertedTodo.dataAccess, true);
assert.equal(convertedTodo.verifyDataPersistence, true);
assert.equal(convertedTodo.pathAccess, "none");
assert.equal(profilePackageDigest(convertedTodo), "203ea9df26e6be26c4844930b14a6413e59113f5ab571e814d3b96d76de0789f");
const convertedDeepRead = await readPublishedPluginProfile("converted-deepread-source");
assert.equal(convertedDeepRead.id, "deepread"); assert.equal(convertedDeepRead.version, "1.1.2");
assert.equal(convertedDeepRead.runtime, "web"); assert.equal(convertedDeepRead.featureCode, "deepread");
assert.equal(convertedDeepRead.pathAccess, "none"); assert.equal(convertedDeepRead.dialogAccess, "open");
assert.equal(convertedDeepRead.verifyDataPersistence, true);
assert.equal(profilePackageDigest(convertedDeepRead), "1808f26053a91d4fafd38d145fbc9adb827848b44832ef1c0cb18c3e2f005298");
const { profile: deepReadProfile, handoff: deepReadHandoff } = await readConvertedSourceProfile("converted-deepread-source");
for (const changed of [
  { ...deepReadProfile, dialogAccess: "save" },
  { ...deepReadProfile, pathAccess: "standard" },
  Object.fromEntries(Object.entries(deepReadProfile).filter(([key]) => key !== "dialogAccess")),
  { ...deepReadProfile, unexpectedProfileKey: true },
]) {
  assert.throws(() => assertConvertedSourceProfile(changed, deepReadHandoff, deepReadProfile.caseId), /differs from its handoff pins/);
}
const { profile: calculatorProfile, handoff: calculatorHandoff } = await readConvertedSourceProfile("converted-my-calculator-source");
assert.equal(Object.hasOwn(calculatorProfile, "dialogAccess"), false);
assert.throws(() => assertConvertedSourceProfile({ ...calculatorProfile, dialogAccess: "open" }, calculatorHandoff,
  calculatorProfile.caseId), /differs from its handoff pins/);
const originalCalculator = await readPublishedPluginProfile("local-my-calculator-zpx");
assert.equal(originalCalculator.sourceKind, "local_original_archive");
assert.equal(originalCalculator.archiveExtension, "zpx");
assert.equal(originalCalculator.fileCount, 8);
assert.equal(originalCalculator.pathAccess, "standard");
assert.equal(originalCalculator.sourceReview, "output/legacy-node-2026-10-17/local-my-calculator-zpx-source-review-v2.json");
assert.equal(originalCalculator.archiveSha256, "af29034f61199203a4e3161b3e119cd9bca4d544ae7e23127b4e04e7e407b1cd");
const imageStitch = await readPublishedPluginProfile("local-image-stitch-head");
assert.equal(imageStitch.sourceCommit, "2d47bd91011b6be872eef1d7c56b4c6b57a93b3d");
assert.equal(imageStitch.sourceTree, "629b6c70b86f28d8f775ced7202bfc2de9b244d5");
assert.equal(profilePackageDigest(imageStitch), "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee");
assert.equal(imageStitch.dialogAccess, "open_and_save");
for (const caseId of ["todo-neo", "color-helper", "com-ztools-timestamp"]) assert.equal((await readPublishedPluginProfile(caseId)).pathAccess, "none");
await assert.rejects(readPublishedPluginProfile("unregistered-package"), /Unknown or unpinned/);
const fixture = { id: profile.id, version: profile.version, archiveSha256: profile.archiveSha256,
  pluginRoot: "/private/tmp/exact-reviewed-root", files: Array.from({ length: profile.fileCount }, () => ({})) };
assert.doesNotThrow(() => assertReviewedFixture(profile, fixture, fixture.pluginRoot, profile.archiveSha256));
for (const changed of [{ id: "other" }, { version: "9.0.0" }, { archiveSha256: "0".repeat(64) }, { files: [] }]) {
  assert.throws(() => assertReviewedFixture(profile, { ...fixture, ...changed }, fixture.pluginRoot, profile.archiveSha256), /not the registered/);
}
assert.throws(() => assertReviewedFixture(profile, fixture, fixture.pluginRoot + "-other", profile.archiveSha256), /not the registered/);
const originalRoot = "/private/tmp/atools-published-plugin-fixture-unit";
const originalFixture = { id: originalCalculator.id, version: originalCalculator.version, sourceKind: originalCalculator.sourceKind,
  archiveSha256: originalCalculator.archiveSha256, archivePath: resolve(originalRoot, "source.zpx"),
  packageImportPath: resolve(originalRoot, "source.zpx"), originalSourcePath: resolve(new URL("../", import.meta.url).pathname, originalCalculator.sourcePath),
  ownedRoot: originalRoot, pluginRoot: resolve(originalRoot, "plugin"), files: Array.from({ length: 8 }, () => ({})) };
assert.doesNotThrow(() => assertReviewedFixture(originalCalculator, originalFixture, originalFixture.pluginRoot, originalCalculator.archiveSha256));
assert.throws(() => assertReviewedFixture(originalCalculator, { ...originalFixture, packageImportPath: originalFixture.pluginRoot },
  originalFixture.pluginRoot, originalCalculator.archiveSha256), /not the registered/);
const reordered = Object.fromEntries(Object.entries(profile).reverse());
assert.doesNotThrow(() => assertNativeReportIdentity({ runId: "current", profile: reordered, packageSha256: profile.archiveSha256 }, profile, "current"));
for (const mode of ["original_ui", "original_worker_contract"]) {
  const native = { runId: "current", profile: reordered, packageSha256: profile.archiveSha256, executionMode: mode };
  assert.doesNotThrow(() => assertNativeReportIdentity(native, profile, "current", mode));
  assert.throws(() => assertNativeReportIdentity(native, profile, "current", mode === "original_ui" ? "original_worker_contract" : "original_ui"), /does not match/);
}
assert.throws(() => assertNativeReportIdentity({ runId: "stale", profile, packageSha256: profile.archiveSha256 }, profile, "current"), /does not match/);
assert.throws(() => assertNativeReportIdentity({ runId: "current", profile: { ...profile, runtime: "web" }, packageSha256: profile.archiveSha256 }, profile, "current"), /does not match/);
const pass = { buildOnly: false, nativeRuntimeExecuted: true, nativeAssertionsPassed: true, nativeProcess: { passed: true },
  preSpawnSourceVerification: { sourceBytesUnchanged: true }, nativeReport: { preExecutionSourceVerification: { sourceBytesUnchanged: true } },
  reportFreshness: { identityValidated: true }, sourceBytesUnchanged: true, fixtureSourcesUnchanged: true,
  cleanup: { isolatedEnvironmentRemoved: true, scratchRemoved: true, errors: [] } };
assert.equal(publishedAcceptancePassed(pass), true);
for (const changed of [{ buildOnly: true }, { nativeAssertionsPassed: false }, { nativeProcess: { passed: false, exitCode: 17 } },
  { reportFreshness: { identityValidated: false } }, { sourceBytesUnchanged: false }, { fixtureSourcesUnchanged: false },
  { preSpawnSourceVerification: { sourceBytesUnchanged: false } }, { nativeReport: {} },
  { cleanup: { isolatedEnvironmentRemoved: true, scratchRemoved: true, errors: ["failure"] } },
  { cleanup: { isolatedEnvironmentRemoved: false, scratchRemoved: true, errors: [] } }]) {
  assert.equal(publishedAcceptancePassed({ ...pass, ...changed }), false);
}
// Synthetic processes only. Descendant inventory is deliberately outside this offline test.
const success = await observePublishedNativeProcess(process.execPath, ["-e", "process.exit(0)"], { trackDescendants: false, stdio: "ignore" });
const failure = await observePublishedNativeProcess(process.execPath, ["-e", "process.exit(17)"], { trackDescendants: false, stdio: "ignore" });
assert.equal(success.exitObserved, true); assert.equal(success.exitCode, 0); assert.equal(success.passed, true);
assert.equal(failure.exitObserved, true); assert.equal(failure.exitCode, 17); assert.equal(failure.passed, false);
if (process.platform !== "win32") {
  const sampled = await observePublishedNativeProcess(process.execPath,
    ["-e", "setTimeout(() => {}, 650)"], { trackDescendants: false, sampleResources: true, stdio: "ignore",
      resourceSamplerReadSnapshot: async ({ pid, expectedPgid, expectedExecutable }) => new Map([[pid, {
        pid, ppid: 1, pgid: expectedPgid, startedAt: "Tue Oct 13 12:00:00 2026", rssKiB: 64,
        cpuSeconds: 0.25, command: expectedExecutable,
      }]]) });
  assert.equal(sampled.passed, true);
  assert.equal(sampled.resourceSampling.requested, true);
  assert.equal(sampled.resourceSampling.processIdentity.pid, sampled.pid);
  assert.ok(sampled.resourceSampling.report.coverage.sampleCount >= 2);
  assert.equal(sampled.resourceSampling.report.coverage.launchedExecutableAssertion,
    sampled.resourceSampling.executableAssertion);

  const samplingFailure = await observePublishedNativeProcess(process.execPath,
    ["-e", "setTimeout(() => {}, 300)"], { trackDescendants: false, sampleResources: true,
      resourceSamplerReadSnapshot: async () => { throw new Error("fixture snapshot failure"); }, stdio: "ignore" });
  assert.equal(samplingFailure.exitCode, 0);
  assert.equal(samplingFailure.passed, false);
  assert.match(samplingFailure.resourceSampling.error, /fixture snapshot failure/);
}
console.log(JSON.stringify({ passed: true, scope: "profile/refusal/freshness gates, native process exits, and opt-in resource sampling success/failure; no plugin or GUI execution" }));
