import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createNodePageFixturePackages } from "./lib/native-node-page-package.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { repositoryRoot, buildPluginPanelNativeFixture, createPanelFixtureEnvironment, runPluginPanelNativeFixture, treeHash } from "./probe-plugin-panel-native.mjs";

export function validateNodePageOutcome(value) {
  assert.equal(value?.passed, true, "Actual page-only Node acceptance failed");
  assert.equal(value.dataset?.kind, "synthetic-search-metadata-plus-generated-packages");
  for (const key of ["originalPlugins", "originalFeatures"]) assert.equal(value.dataset[key], 0);
  for (const key of ["generatedPlugins", "generatedFeatures"]) assert.equal(value.dataset[key], 2);
  assert.equal(value.dataset.syntheticFeatures, 1200);
  for (const key of ["temporaryDataRemoved", "allTaskRunsTerminal", "dataRuntimeDrained", "dialogRuntimeDrained", "pathRuntimeDrained", "generatedPackagesUnchanged", "reviewedOriginalUiAssetsOnly"]) assert.equal(value[key], true, key);
  assert.equal(value.pageDocumentMode, false); assert.equal(value.pageDocumentsAfterCleanup, 0);
  assert.equal(value.resourceLeasesAfterCleanup, 0); assert.ok(value.taskRuns > 0);
  assert.equal(value.observations?.nodeProcessObserved, true);
  const image = value.observations?.savedImage;
  assert.equal(image?.exists, true); assert.equal(image.width, 4); assert.equal(image.height, 6);
  assert.equal(image.privatePathsAbsentFromTaskRuns, true);
  assert.ok(image.byteCount > 0 && /^[a-f0-9]{64}$/.test(image.sha256));
  assert.ok(Object.keys(value.checks).length >= 20);
  return { checks: Object.keys(value.checks).length, generatedPackages: 2, completeOriginalPackages: 0,
    originalUiAssetExecution: true, osPicker: false, physicalProcessPerformance: false };
}

export async function runNativeNodePageAcceptance({ output: requestedOutput, stdio = "ignore" } = {}) {
  assert.equal(process.platform, "darwin", "Native acceptance is macOS-only");
  const output = resolve(requestedOutput || join(repositoryRoot, "output/legacy-node-2026-10-16/native-plugin-page-node.json"));
  await mkdir(dirname(output), { recursive: true });
  assert.equal(await stat(output).catch(() => null), null, "Preserve earlier evidence; choose a fresh output");
  const scratch = await mkdtemp("/private/tmp/atools-node-page-build-");
  const report = { schemaVersion: 1, runId: randomUUID(), status: "running", createdAt: new Date().toISOString(),
    scope: "Real App/opaque PluginPanel; generated no-preload packages containing complete hash-pinned original UI assets",
    boundaries: ["Generated manifests are not complete original packages", "Original image save functions use a fixed fixture picker target and recording-only reveal/notification adapters; actual Node write and Rust PNG decode",
      "No OS picker, clipboard operation, AppleScript, installed application replacement or full-process performance claim"] };
  let isolated, generated, fixture, failure;
  const packages = async () => Object.fromEntries(await Promise.all(generated.packageIds.map(async id => [id, await treeHash(join(generated.directory, id))])));
  try {
    report.sourceBinding = { before: await capturePanelSources(repositoryRoot) };
    isolated = await createPanelFixtureEnvironment(repositoryRoot); report.environment = isolated.evidence;
    const fixtureRoot = join(isolated.root, "native-fixture");
    const nodePagePaths = { outputPath: join(fixtureRoot, "node-page-output.png") };
    generated = await createNodePageFixturePackages(repositoryRoot, isolated.root, nodePagePaths);
    report.reviewedOriginalUiAssetHashes = generated.copiedHashes;
    report.saveFunctionCopiedExactly = generated.exactSaveFunctions; report.packagesBefore = await packages();
    fixture = await buildPluginPanelNativeFixture(repositoryRoot, scratch, { scenario: "node-page",
      pluginSourcesRoot: generated.directory, nodePagePaths });
    report.sourceBinding.artifactsBefore = await capturePanelArtifacts(fixture);
    isolated.env.ATOOLS_NODE_PAGE_ACCEPTANCE = "true";
    try { report.outcome = await runPluginPanelNativeFixture(fixture, { output: join(isolated.root, "native-report.json"), fixtureRoot, env: isolated.env, stdio, timeoutMs: 270000 }); }
    catch (error) { report.outcome = error.panelReport ?? null; throw error; }
    report.validation = validateNodePageOutcome(report.outcome); report.status = "pass";
  } catch (error) {
    failure = error; report.status = "failed"; report.error = String(error instanceof Error ? error.message : error);
  } finally {
    try {
      report.sourceBinding ??= {}; report.sourceBinding.after = await capturePanelSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged = fingerprintsEqual(report.sourceBinding.before, report.sourceBinding.after);
      if (fixture) { report.sourceBinding.artifactsAfter = await capturePanelArtifacts(fixture); report.sourceBinding.artifactsUnchanged = fingerprintsEqual(report.sourceBinding.artifactsBefore, report.sourceBinding.artifactsAfter); }
      if (generated) { report.packagesAfter = await packages(); report.packagesUnchanged = fingerprintsEqual(report.packagesBefore, report.packagesAfter); }
      if (!report.sourceBinding.sourcesUnchanged || !report.sourceBinding.artifactsUnchanged || !report.packagesUnchanged) report.status = "failed";
    } catch (error) { report.status = "failed"; report.sourceError = String(error); }
    if (isolated) try { report.environmentCleanup = await isolated.cleanup(); } catch (error) { report.status = "failed"; report.cleanupError = String(error); }
    try { await rm(scratch, { recursive: true, force: true }); report.buildScratchRemoved = true; }
    catch (error) { report.status = "failed"; report.scratchCleanupError = String(error); }
    if (report.environmentCleanup?.isolatedEnvironmentRemoved !== true) report.status = "failed";
    report.finishedAt = new Date().toISOString(); await writeFile(output, JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  }
  console.log(JSON.stringify({ output, runId: report.runId, status: report.status }));
  if (failure || report.status !== "pass") throw failure || Error("Native page Node acceptance failed; retained report");
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try { await runNativeNodePageAcceptance({ output: process.argv[2] }); }
  catch { process.exitCode = 1; }
}
