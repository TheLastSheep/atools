import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPluginPanelNativeFixture, createPanelFixtureEnvironment, runPluginPanelNativeFixture, repositoryRoot, treeHash } from "./probe-plugin-panel-native.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { createWebStorageFixturePackages } from "./lib/native-web-storage-package.mjs";

export async function validateWebStorageOutcome(value){
  assert.equal(value?.passed,true,"Actual opaque PluginPanel Web Storage scenario failed");
  assert.equal(value.dataset?.kind,"synthetic-search-metadata-plus-generated-packages");
  assert.equal(value.dataset.originalPlugins,0);assert.equal(value.dataset.originalFeatures,0);
  assert.equal(value.dataset.generatedPlugins,2);assert.equal(value.dataset.generatedFeatures,2);
  assert.equal(value.dataset.syntheticFeatures,1200);assert.equal(value.dataset.totalFeatures,1202);
  for(const key of ["temporaryDataRemoved","allTaskRunsTerminal","dataRuntimeDrained","webStorageEventStoreDrained",
    "dialogRuntimeDrained","pathRuntimeDrained","originalSourcesUnchanged"])
    assert.equal(value[key],true,key);
  assert.equal(value.pageDocumentMode,false);assert.equal(value.pageDocumentsAfterCleanup,0);
  assert.equal(value.resourceLeasesAfterCleanup,0);assert.equal(value.taskRuns>0,true);
  const checks=value.observations;
  assert.equal(checks.originalClassChecks.themeApplied,true);assert.equal(checks.originalClassChecks.radioChecked,true);
  assert.equal(checks.originalClassChecks.sidebarCollapsed,true);assert.equal(checks.originalClassChecks.sidebarStored,true);
  assert.equal(checks.peerStorageEvent.present,true);assert.equal(checks.peerStorageEvent.keyMatches,true);
  assert.equal(checks.peerStorageEvent.oldMatches,true);assert.equal(checks.peerStorageEvent.newMatches,true);
  assert.equal(checks.peerStorageEvent.urlMatches,true);assert.equal(checks.peerStorageEvent.storageAreaMatches,true);
  assert.equal(checks.persistence.themeApplied,true);
  assert.equal(checks.persistence.sidebarRestored,true);assert.equal(checks.persistence.iconRestored,true);
  assert.equal(checks.persistedKeys.theme,true);assert.equal(checks.persistedKeys.sidebar,true);assert.equal(checks.persistedKeys.namespace,true);
  assert.equal(checks.reopenAfterB.theme,true);assert.equal(checks.reopenAfterB.sidebar,true);assert.equal(checks.reopenAfterB.namespace,true);
  assert.equal(checks.sameValueEventWindow.quietWindowMs,250);assert.equal(checks.sameValueEventWindow.targetEvents,0);
  assert.equal(checks.sameValueEventWindow.nativeEventsBefore,checks.sameValueEventWindow.nativeEventsAfter);
  assert.equal(checks.sameValueEventWindow.nativeBytesBefore,checks.sameValueEventWindow.nativeBytesAfter);
  assert.equal(checks.sameValueEventWindow.evictionsBefore,checks.sameValueEventWindow.evictionsAfter);
  assert.equal(checks.activeSessionCounts.dataSessions,2);
  assert.equal(checks.activeSessionCounts.webStorageEventEmitMismatches,0);
  assert.equal(checks.boundedEnumeration.syntheticKeys,128);assert.equal(checks.boundedEnumeration.enumeratedSyntheticKeys,128);
  assert.ok(checks.boundedEnumeration.entriesCalls>=1&&checks.boundedEnumeration.entriesCalls<=64);
  assert.ok(Number.isFinite(checks.boundedEnumeration.elapsedMs));
  assert.equal(value.dataRuntimeAfterCleanup.webStorageEvents,0);assert.equal(value.dataRuntimeAfterCleanup.webStorageEventBytes,0);
  assert.equal(value.reviewedOriginalClassesOnly,true);
  return {checks:Object.keys(value.checks).length,originalClasses:["ThemeManager","UIManager"],opaqueOrigin:true,
    storageValuesAndUrlsInReport:false,fullPluginAccepted:false};
}

async function main(){
  if(process.platform!=="darwin")throw Error("Web Storage native acceptance is macOS-only");
  if(process.argv.length>3)throw Error("Usage: probe-plugin-web-storage-native.mjs [fresh-output.json]");
  const output=resolve(process.argv[2]||join(repositoryRoot,"output/legacy-node-2026-10-16/native-web-storage-contract.json"));
  await mkdir(dirname(output),{recursive:true});assert.equal(await stat(output).catch(()=>null),null,"Preserve earlier evidence");
  const scratch=await mkdtemp("/private/tmp/atools-web-storage-build-");
  const report={schemaVersion:1,runId:randomUUID(),status:"running",createdAt:new Date().toISOString(),
    scope:"Real App/PluginPanel opaque localStorage bridge using two generated pure-Web packages and two hash-pinned original classes",
    boundaries:["Only the unchanged original ThemeManager and UIManager class source bytes are embedded in A",
      "No complete original plugin, preload, Node, clipboard, OS picker, AppleScript or external network access; local private-loopback data transport remains part of the real bridge",
      "Storage values and actual document URLs are only compared in-memory; report contains metadata booleans only",
      "Any key-count measurement applies only to the explicitly recorded fixture size, not the 4096-key maximum"]};
  let environment,fixture,packages,failure;
  try {
    report.sourceBinding={before:await capturePanelSources(repositoryRoot)};
    environment=await createPanelFixtureEnvironment(repositoryRoot);report.environment=environment.evidence;
    environment.env.ATOOLS_WEB_STORAGE_ACCEPTANCE="true";
    packages=await createWebStorageFixturePackages(repositoryRoot,environment.root);report.originalClasses=packages.originalClasses;
    report.packagesBefore=Object.fromEntries(await Promise.all(packages.packageIds.map(async id=>[id,await treeHash(join(packages.directory,id))])));
    fixture=await buildPluginPanelNativeFixture(repositoryRoot,scratch,{scenario:"web-storage",pluginSourcesRoot:packages.directory});
    report.sourceBinding.artifactsBefore=await capturePanelArtifacts(fixture);
    try {report.outcome=await runPluginPanelNativeFixture(fixture,{output:join(environment.root,"native-report.json"),
      fixtureRoot:join(environment.root,"native-fixture"),env:environment.env,stdio:"ignore",timeoutMs:240000});}
    catch(error){report.outcome=error.panelReport??null;throw error;}
    report.validation=await validateWebStorageOutcome(report.outcome);report.status="pass";
  } catch(error){failure=error;report.status="failed";report.error=String(error instanceof Error?error.message:error);}
  finally {
    try {
      report.sourceBinding??={};report.sourceBinding.after=await capturePanelSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged=fingerprintsEqual(report.sourceBinding.before,report.sourceBinding.after);
      if(fixture){report.sourceBinding.artifactsAfter=await capturePanelArtifacts(fixture);report.sourceBinding.artifactsUnchanged=fingerprintsEqual(report.sourceBinding.artifactsBefore,report.sourceBinding.artifactsAfter);}
      if(packages){report.packagesAfter=Object.fromEntries(await Promise.all(packages.packageIds.map(async id=>[id,await treeHash(join(packages.directory,id))])));report.packagesUnchanged=fingerprintsEqual(report.packagesBefore,report.packagesAfter);}
      if(!report.sourceBinding.sourcesUnchanged||!report.sourceBinding.artifactsUnchanged||!report.packagesUnchanged)report.status="failed";
    } catch(error){report.status="failed";report.sourceError=String(error);}
    if(environment)try{report.environmentCleanup=await environment.cleanup();}catch(error){report.status="failed";report.cleanupError=String(error);}
    try{await rm(scratch,{recursive:true,force:true});report.buildScratchRemoved=true;}
    catch(error){report.status="failed";report.buildScratchRemoved=false;report.scratchCleanupError=String(error);}
    if(report.environmentCleanup?.isolatedEnvironmentRemoved!==true)report.status="failed";
    report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  }
  console.log(JSON.stringify({output,status:report.status,runId:report.runId}));
  if(failure||report.status!=="pass")throw failure||Error("Native Web Storage contract failed; retained report");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
