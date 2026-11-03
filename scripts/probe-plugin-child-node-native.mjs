import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChildNodeFixturePackages, originalChildPreload, reviewedOriginalChildPreload } from "./lib/native-child-node-package.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintFile, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { repositoryRoot, buildPluginPanelNativeFixture, createPanelFixtureEnvironment, runPluginPanelNativeFixture, treeHash } from "./probe-plugin-panel-native.mjs";

export const childNodeFixtureSourceFiles = Object.freeze([
  "scripts/lib/native-child-node-package.mjs", "scripts/probe-plugin-child-node-native.mjs",
  "scripts/lib/native-child-node-package.test.mjs", "tests/components/native-child-node-fixture.test.ts",
  "tests/components/nativePluginChildNodeSmoke.ts", "tests/components/nativePluginChildNodeScenario.ts",
  "tests/components/nativePluginChildNodeFrameProbe.js", "src-tauri/src/legacy_runtime/desktop_smoke_child_node_privacy.rs",
  originalChildPreload.source,
]);
const selectedSources = root => Promise.all(childNodeFixtureSourceFiles.map(async path => [path, await fingerprintFile(join(root, path))])).then(Object.fromEntries);
const runtimeIsEmpty = value => value && ["sessions", "openings", "nodeIntents", "nodeInvocations", "pending", "resourceLeases", "pageDocuments", "hostSessions", "hostIntents", "hostInvocations",
  "dataSessions", "dataIntents", "dataInvocations", "dataPreparations", "webStorageEvents", "webStorageEventBytes",
  "activePathSnapshots", "activePathIntents", "activePathPreparations", "pathSnapshotBytes", "dialogSessions", "dialogIntents",
  "dialogInvocations", "dialogPreparations", "nativeDialogs"].every(key => value[key] === 0)
  && ["transport", "hostTransport", "dataTransport", "dialogTransport"].every(key => value[key] === false);

/** Independent Node-side checks reject narrow or older green reports. */
export function validateChildNodeOutcome(value) {
  assert.equal(value?.passed, true, "Actual child-only Node scenario failed");
  assert.equal(value.dataset?.kind, "synthetic-search-metadata-plus-generated-packages");
  for (const key of ["originalPlugins", "originalFeatures"]) assert.equal(value.dataset[key], 0);
  for (const key of ["generatedPlugins", "generatedFeatures"]) assert.equal(value.dataset[key], 2);
  assert.equal(value.dataset.syntheticFeatures, 1200);
  for (const key of ["temporaryDataRemoved", "allTaskRunsTerminal", "dataRuntimeDrained", "dialogRuntimeDrained", "pathRuntimeDrained",
    "generatedPackagesUnchanged", "reviewedOriginalChildPreloadOnly"]) assert.equal(value[key], true, key);
  assert.equal(value.pageDocumentMode, false); assert.equal(value.pageDocumentsAfterCleanup, 0); assert.equal(value.resourceLeasesAfterCleanup, 0);
  assert.equal(typeof value.scope, "string", "Native report keeps its descriptive scope string");
  assert.ok(value.scope.length > 0);
  const observations = value.observations;
  for (const label of ["deny", "fresh"]) {
    const before = observations?.["mainBeforeChild-" + label];
    for (const key of ["opaque", "noTauri", "parentPreloadExecuted", "parentElectronIpc", "mainReady"]) assert.equal(before?.state?.[key], true, key);
    assert.equal(before.state.mainNodeEnvironment, false); assert.deepEqual(before.state.children, []);
    for (const key of ["sessions", "openings", "pending"]) assert.equal(before.runtime[key], 0);
    assert.equal(before.runtime.transport, false);
  }
  for (const label of ["deny", "allow"]) {
    const prompt = observations?.["nodePrompt-" + label];
    assert.equal(prompt?.exactPending, true); assert.equal(prompt.childCount, 0);
    for (const key of ["sessions", "openings"]) assert.equal(prompt.runtime[key], 0);
    assert.equal(prompt.runtime.transport, false); assert.equal(prompt.runtime.pending, 1);
    assert.equal(prompt.state.children.length, 1); assert.equal(prompt.state.children[0].ready, false);
    assert.equal(prompt.state.children[0].readyCallbackCount, 0);
  }
  const denial = observations?.denial;
  for (const key of ["sessions", "openings", "pending"]) assert.equal(denial?.runtime?.[key], 0);
  assert.equal(denial.runtime.transport, false); assert.equal(denial.state.children[0].rejected, true);
  assert.equal(denial.state.children[0].ready, false); assert.equal(denial.state.children[0].readyCallbackCount, 0);
  assert.equal(runtimeIsEmpty(observations.afterDeniedPluginClose), true);
  const generated = observations?.generatedChild;
  for (const key of ["opaque", "noTauri", "actualNodeBridge", "sentinelMatches"]) assert.equal(generated?.[key], true, key);
  assert.ok(Number.isSafeInteger(generated.processId) && generated.processId > 0, "Actual selected-child Node PID");
  for (const label of ["generatedChild", "originalChild"]) {
    const runtime = observations[label].runtime;
    assert.equal(runtime.sessions, 1); assert.equal(runtime.openings, 0); assert.equal(runtime.pending, 0); assert.equal(runtime.transport, true);
    const close = observations[label + "Close"];
    assert.equal(close.actualClose, true); assert.equal(close.destroyed, true); assert.equal(close.readyCallbackCount, 1);
  }
  for (const key of ["opaque", "noTauri", "actualNodeBridge", "originalFunctionsReady", "originalFsAttachmentStored", "dictionaryRoundTrip", "metadataRoundTrip", "zoomRateInitialized"])
    assert.equal(observations.originalChild[key], true, key);
  for (const key of ["webFrameZoomAvailable", "documentZoomFactorRoundTrip", "computedDocumentZoomMatches", "documentZoomRestored", "parentDocumentZoomUnchanged"])
    assert.equal(observations.originalChild[key], true, key);
  assert.equal(runtimeIsEmpty(observations.finalRuntime), true);
  const privacy = observations.privacy;
  for (const key of ["complete", "privateFixtureContentsAbsent", "allTaskRunsTerminal"]) assert.equal(privacy?.[key], true, key);
  for (const key of ["taskRuns", "queryLimit", "scannedBytes", "maxBytes", "nodeTaskRuns", "nodeOpenTaskRuns", "nodeRequestTaskRuns"])
    assert.ok(Number.isSafeInteger(privacy[key]) && privacy[key] > 0, "Positive safe-integer privacy counter: " + key);
  assert.equal(privacy.queryLimit, 1000); assert.equal(privacy.maxBytes, 4 * 1024 * 1024);
  assert.ok(privacy.taskRuns < privacy.queryLimit && privacy.scannedBytes <= privacy.maxBytes);
  assert.equal(privacy.nodeOpenTaskRuns, 2); assert.deepEqual([...privacy.nodeOpenTaskRunStatuses].sort(), ["cancelled", "succeeded"]);
  assert.ok(privacy.nodeTaskRuns <= privacy.taskRuns && privacy.nodeTaskRuns === privacy.nodeOpenTaskRuns + privacy.nodeRequestTaskRuns);
  assert.ok(Object.keys(value.checks).length >= 20 && Object.values(value.checks).every(item => item === true));
  for (const key of ["generatedPackages", "completeOriginalChildPreloadOnly", "childDocumentCssZoomOnly"]) assert.equal(value.acceptanceScope?.[key], true, key);
  for (const key of ["completeOriginalPlugin", "documentMode", "trueNativeFloatingWindow", "physicalInput", "osPickerOpened", "clipboardActions", "externalNetworkRequested", "appleScriptUsed"])
    assert.equal(value.acceptanceScope?.[key], false, key);
  assert.equal(value.acceptanceScope?.nativeChromiumZoomParity, false);
  return { checks: Object.keys(value.checks).length, oneDeniedNodeTask: true, oneAllowedNodeTask: true,
    childOnlyActualFs: true, completeUnchangedOriginalChildPreload: true, generatedPackages: 2,
    completeOriginalPackages: 0, physicalInput: false, independentNativeWindows: false, childDocumentCssZoomOnly: true, nativeChromiumZoomParity: false };
}

export async function runNativeChildNodeAcceptance({ output: requestedOutput, stdio = "ignore" } = {}) {
  assert.equal(process.platform, "darwin", "Native child-only Node acceptance is macOS-only");
  const output = resolve(requestedOutput || join(repositoryRoot, "output/legacy-node-2026-10-18/native-child-only-node.json"));
  await mkdir(dirname(output), { recursive: true });
  assert.equal(await stat(output).catch(() => null), null, "Preserve earlier evidence; choose a fresh output");
  const scratch = await mkdtemp("/private/tmp/atools-child-node-build-");
  const report = { schemaVersion: 1, runId: randomUUID(), status: "running", createdAt: new Date().toISOString(),
    scope: "Actual App/opaque PluginPanel; generated pure-Electron parent, selected Node child and complete unchanged original English child preload",
    boundaries: ["Generated manifest, parent and child HTML are not complete original plugins", "Only package-owned fixed sentinel and dictionary files are read; original child writes attachment and metadata through the actual authorized SQLite bridge",
      "webFrame zoom covers only the current child CSS document; it is not full native Chromium/Electron zoom parity",
      "Node process is authorized broadly and is not an OS filesystem/network sandbox; private fixture makes no external network call",
      "Hosted child iframes; no independent native windows, OS picker, clipboard, AppleScript, physical input or full-process performance claim"] };
  let isolated, generated, fixture, failure;
  const packages = async () => Object.fromEntries(await Promise.all(generated.packageIds.map(async id => [id, await treeHash(join(generated.directory, id))])));
  try {
    report.sourceBinding = { before: await capturePanelSources(repositoryRoot), childBefore: await selectedSources(repositoryRoot) };
    isolated = await createPanelFixtureEnvironment(repositoryRoot); report.environment = isolated.evidence;
    generated = await createChildNodeFixturePackages(repositoryRoot, isolated.root);
    report.originalChildPreload = generated.originalChildPreload; report.packagesBefore = await packages();
    fixture = await buildPluginPanelNativeFixture(repositoryRoot, scratch, { scenario: "child-node", pluginSourcesRoot: generated.directory });
    report.sourceBinding.artifactsBefore = await capturePanelArtifacts(fixture);
    isolated.env.ATOOLS_CHILD_NODE_ACCEPTANCE = "true";
    try { report.outcome = await runPluginPanelNativeFixture(fixture, { output: join(isolated.root, "native-report.json"),
      fixtureRoot: join(isolated.root, "native-fixture"), env: isolated.env, stdio,
      onProcessStarted: async ({ identity }) => { report.nativeProcessIdentity = identity; return { report: { identity, sharedRunnerTracksOwnedDescendants: true } }; } }); }
    catch (error) { report.outcome = error.panelReport ?? null; throw error; }
    report.validation = validateChildNodeOutcome(report.outcome); report.status = "pass";
  } catch (error) { failure = error; report.status = "failed"; report.error = String(error instanceof Error ? error.message : error); }
  finally {
    try {
      report.sourceBinding ??= {}; report.sourceBinding.after = await capturePanelSources(repositoryRoot); report.sourceBinding.childAfter = await selectedSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged = fingerprintsEqual(report.sourceBinding.before, report.sourceBinding.after)
        && fingerprintsEqual(report.sourceBinding.childBefore, report.sourceBinding.childAfter);
      if (fixture) { report.sourceBinding.artifactsAfter = await capturePanelArtifacts(fixture); report.sourceBinding.artifactsUnchanged = fingerprintsEqual(report.sourceBinding.artifactsBefore, report.sourceBinding.artifactsAfter); }
      if (generated) { report.packagesAfter = await packages(); report.packagesUnchanged = fingerprintsEqual(report.packagesBefore, report.packagesAfter);
        report.originalChildPreloadAfter = (await reviewedOriginalChildPreload(repositoryRoot)).sha256; }
      if (!report.sourceBinding.sourcesUnchanged || !report.sourceBinding.artifactsUnchanged || !report.packagesUnchanged) report.status = "failed";
    } catch (error) { report.status = "failed"; report.sourceError = String(error); }
    if (isolated) try { report.environmentCleanup = await isolated.cleanup(); } catch (error) { report.status = "failed"; report.cleanupError = String(error); }
    try { await rm(scratch, { recursive: true, force: true }); report.buildScratchRemoved = true; }
    catch (error) { report.status = "failed"; report.scratchCleanupError = String(error); }
    if (report.environmentCleanup?.isolatedEnvironmentRemoved !== true) report.status = "failed";
    report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ output, runId: report.runId, status: report.status }));
  if (failure || report.status !== "pass") throw failure || Error("Native child-only Node acceptance failed; retained report");
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length > 3) throw Error("Usage: probe-plugin-child-node-native.mjs [fresh-output.json]");
  try { await runNativeChildNodeAcceptance({ output: process.argv[2] }); } catch { process.exitCode = 1; }
}
