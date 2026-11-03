import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { buildPluginPanelNativeFixture, createPanelFixtureEnvironment, runPluginPanelNativeFixture, repositoryRoot, treeHash } from "./probe-plugin-panel-native.mjs";
import { capturePanelSources, capturePanelArtifacts, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";
import { createBrowserWindowFixturePackages, browserWindowIsolationContract } from "./lib/native-browser-window-package.mjs";

export async function validateBrowserWindowOutcome(value){
  assert.equal(value?.passed,true,"Actual browser contract scenario failed");
  assert.equal(value.pageDocumentMode,false);assert.equal(value.reviewedOriginalPartsOnly,true);assert.equal(value.reviewedOriginalContextMenuFiles,true);
  for(const key of ["temporaryDataRemoved","allTaskRunsTerminal","dataRuntimeDrained","pathRuntimeDrained","dialogRuntimeDrained","originalSourcesUnchanged"])
    assert.equal(value[key],true,key);
  assert.equal(value.pageDocumentsAfterCleanup,0);assert.equal(value.resourceLeasesAfterCleanup,0);
  const observations=value.observations;
  const geometry=observations.windowGeometry;
  for(const key of ["synchronous","defensiveCopies","eventSawConfirmedState"])assert.equal(geometry?.[key],true,"Window geometry: "+key);
  for(const name of ["initial","moveExpected","afterMove","eventSnapshot","resizeExpected","afterResize"]){
    const bounds=geometry[name];assert(bounds&&[bounds.x,bounds.y,bounds.width,bounds.height].every(Number.isFinite)
      &&bounds.width>0&&bounds.height>0,"Finite geometry: "+name);
  }
  assert(Array.isArray(geometry.getters)&&geometry.getters.length===5);
  for(const tuple of geometry.getters)assert(Array.isArray(tuple)&&tuple.length===2&&tuple.every(Number.isFinite));
  assert.deepEqual(geometry.info,{size:{w:geometry.initial.width,h:geometry.initial.height},pos:{x:geometry.initial.x,y:geometry.initial.y}});
  assert.deepEqual(geometry.getters.slice(0,3),[[geometry.initial.width,geometry.initial.height],
    [geometry.initial.width,geometry.initial.height],[geometry.initial.x,geometry.initial.y]]);
  assert.deepEqual(geometry.moveExpected,{x:Math.round(geometry.initial.x+12),y:Math.round(geometry.initial.y+7),
    width:geometry.initial.width,height:geometry.initial.height});
  assert.deepEqual(geometry.resizeExpected,{x:geometry.afterMove.x,y:geometry.afterMove.y,width:420,height:180});
  assert.deepEqual(geometry.eventSnapshot,geometry.afterMove);
  assert.deepEqual(geometry.afterMove,geometry.moveExpected);assert.deepEqual(geometry.afterResize,geometry.resizeExpected);
  assert.deepEqual(observations.windowGeometryActualBounds,geometry.afterResize);
  assert.deepEqual(geometry.afterInfo,{size:{w:420,h:180},pos:{x:geometry.afterResize.x,y:geometry.afterResize.y}});
  assert.deepEqual(geometry.nested,{synchronous:true,finite:true,updated:true});
  assert.deepEqual(observations.windowGeometryClose,{closed:true,destroyed:true});
  assert.equal(observations.originalTipsWindow.result.synchronousHandle,true);
  assert.equal(observations.originalTipsWindow.result.originalGetStatusFalse,true);
  assert.equal(observations.originalTipsWindow.result.ready,true);
  assert.equal(observations.originalTipsWindowClose.result.classClearedHandle,true);
  assert.deepEqual(observations.pendingClose.result,{notDestroyedBeforeClose:true,wasPendingOnClose:true,
    destroyedAfterClose:true,readyRejected:true,callbackCount:0,actualClose:true});
  const isolation=observations.isolation;
  assert.equal(isolation.synchronousHandleChecked,true);assert.equal(isolation.readyCallbackCount,1);
  const contract=await browserWindowIsolationContract(repositoryRoot);
  assert.equal(contract.normalizeDesktopBrowserWindowProbeContract(isolation.probes).passed,true,"Exact isolation IDs, order and uniqueness must pass");
  assert.deepEqual(observations.nested,{immediate:true,readyCallbackCount:1,actualClose:true,destroyed:true});
  const positiveIds=values=>assert(values.every(id=>Number.isSafeInteger(id)&&id>0)&&new Set(values).size===values.length,"Positive distinct hosted identities");
  const basic=observations.hostedIpcBasic;positiveIds([basic?.parentId,basic?.childId]);
  for(const key of ["positiveDistinctIds","childIdentityMatches","returnWasVoid","parentToChildSenderAuthentic","childToParentSenderAuthentic","allArgumentsPreserved","childOpaque","childNoTauri"])assert.equal(basic?.[key],true,"Hosted basic: "+key);
  assert.equal(basic.onceCount,1);assert.equal(basic.offCount,0);assert.equal(basic.removedCount,0);
  const measurement=basic.roundTripMeasurement,marker="atools-hosted-ipc-rtt-v1";
  assert.equal(measurement?.schemaVersion,1);assert.equal(measurement.iterations,20);assert.equal(measurement.serial,true);assert.equal(measurement.descriptiveOnly,true);
  assert.equal(measurement.clock,"main-frame performance.now");assert.equal(measurement.start,"Immediately before public ipcRenderer.sendTo");
  assert.equal(measurement.end,"Matching authenticated child ack listener callback");assert.equal(measurement.ackDeadlineMs,10000);
  assert.equal(measurement.requestChannel,"atools:fixture:hosted-ipc:rtt-request");assert.equal(measurement.ackChannel,"atools:fixture:hosted-ipc:rtt-ack");
  assert.deepEqual(measurement.payloadTemplate,{fixture:marker,value:42});
  assert(["hidden","visible"].includes(measurement.visibility?.visibilityState));
  assert.equal(measurement.visibility.documentHidden,measurement.visibility.visibilityState==="hidden");
  assert(Array.isArray(measurement.samples)&&measurement.samples.length===20,"Exactly twenty raw callback-timed round trips");
  const elapsed=measurement.samples.map((sample,index)=>{
    assert.equal(sample.sequence,index,"Unique serial sequence");assert.equal(sample.senderId,basic.childId,"Exact round-trip child sender identity");
    assert(typeof sample.elapsedMs==="number"&&Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0,"Finite nonnegative round-trip sample");
    assert.equal(sample.requestPayloadUtf8Bytes,JSON.stringify({fixture:marker,sequence:index,value:42}).length,"Fixed ASCII JSON payload byte count");
    return sample.elapsedMs;
  }).sort((a,b)=>a-b);
  const roundTripMeasurement={n:20,p50Ms:elapsed[Math.ceil(elapsed.length*0.5)-1],p95Ms:elapsed[Math.ceil(elapsed.length*0.95)-1],maxMs:elapsed.at(-1),
    method:"nearest-rank",descriptiveOnly:true,visibility:measurement.visibility,clock:measurement.clock,
    scope:"Public sendTo main -> hosted child -> authenticated ack; current opaque frame; excludes physical input, paint and independent native floating windows"};
  assert.deepEqual(basic.receivedParentPacket,{senderId:basic.parentId,args:[{senderId:-55,value:42},"second",7]});
  assert.deepEqual(basic.receivedChildPacket,{senderId:basic.childId,payload:{childId:basic.childId,senderId:-77,args:[{senderId:-55,value:42},"second",7]}});
  const sibling=observations.hostedIpcSiblingNested;positiveIds([sibling?.mainId,sibling?.firstId,sibling?.secondId,sibling?.nestedId]);
  for(const key of ["positiveDistinctIds","siblingSenderAuthentic","nestedCreatorMatches","nestedIdentityMatches","nestedToMainSenderAuthentic"])assert.equal(sibling?.[key],true,"Hosted sibling/nested: "+key);
  assert.deepEqual(sibling.receivedSiblingPacket,{senderId:sibling.firstId,args:["from-sibling",{senderId:-99}]});
  assert.deepEqual(sibling.receivedNestedPacket,{senderId:sibling.nestedId,payload:{value:73}});
  const lifecycle=observations.hostedIpcLifecycle;positiveIds([lifecycle?.oldId,lifecycle?.newId]);
  for(const key of ["reloadIdStable","reloadReplacedDocument","oldListenersNotCopied","freshSenderAuthentic","closedHandleDestroyed","newIdentityDistinct"])assert.equal(lifecycle?.[key],true,"Hosted lifecycle: "+key);
  assert.equal(lifecycle.closedTargetDeliveries,0);assert.deepEqual(lifecycle.reloadedPackets,[{senderId:lifecycle.oldId,value:"fresh-document"}]);
  const menu=observations.originalContextMenu;positiveIds([menu?.parentId,menu?.childId]);
  for(const key of ["positiveDistinctIds","childIdentityMatches","handshakeParentMatches","originalChildPreloadExecuted","classClearedHandle","actualChildDestroyed","childOpaque","childNoTauri"])assert.equal(menu?.[key],true,"Original menu: "+key);
  assert.deepEqual(menu.originalToggleCalls,[false]);assert.match(menu.originalDomMenuText,/隐藏番茄堆/);
  assert.equal(menu.queryConfigurationVerified,false);
  return {checks:Object.keys(value.checks).length,isolationChecks:9,originalPartsOnly:true,originalContextMenuCallingPattern:true,wholePluginAccepted:false,inFlightReloadRaceVerified:false,roundTripMeasurement};
}

async function main(){
  if(process.platform!=="darwin")throw Error("Browser window native acceptance is macOS-only");
  if(process.argv.length>3)throw Error("Usage: probe-plugin-browser-window-native.mjs [fresh-output.json]");
  const output=resolve(process.argv[2]||join(repositoryRoot,"output/legacy-node-2026-10-15/native-browser-window-contract.json"));
  await mkdir(dirname(output),{recursive:true});assert.equal(await stat(output).catch(()=>null),null,"Preserve earlier evidence");
  const scratch=await mkdtemp("/private/tmp/atools-browser-window-build-");
  const report={schemaVersion:1,runId:randomUUID(),status:"running",createdAt:new Date().toISOString(),
    scope:"Real App/PluginPanel opaque hosted children, authenticated hosted IPC, fixed-hash original TipsWindow/ContextMenu classes and typing/paintbrush geometry function calling patterns",
    boundaries:["One exact pure Electron original child preload runs; no full original plugin, Node process, clipboard operation, system picker or AppleScript",
      "Complete original TipsWindow and ContextMenu classes and menu HTML/preload/CSS run unchanged with synthetic parent settings; this is not complete pomodoro compatibility",
      "Only exact original typing geometry declarations and paintbrush move/resize callbacks run; their complete preloads, business workflows and plugins are not accepted",
      "Opaque srcdoc query configuration, physical foreground input and deterministic in-flight reload races are outside this acceptance",
      "Child windows are isolated hosted iframes inside the launcher, not independent native floating windows",
      "Selected source/artifact binding is not a complete compiler closure; private environment is not an OS sandbox"]};
  let environment,fixture,packages,failure;
  try {
    report.sourceBinding={before:await capturePanelSources(repositoryRoot)};
    environment=await createPanelFixtureEnvironment(repositoryRoot);report.environment=environment.evidence;
    environment.env.ATOOLS_BROWSER_WINDOW_ACCEPTANCE="true";
    packages=await createBrowserWindowFixturePackages(repositoryRoot,environment.root);report.originalClass=packages.originalClass;report.originalContextMenu=packages.originalContextMenu;
    report.originalGeometry=packages.originalGeometry;
    report.packagesBefore=Object.fromEntries(await Promise.all(["char-transform","file-tree"].map(async id=>[id,await treeHash(join(packages.directory,id))])));
    fixture=await buildPluginPanelNativeFixture(repositoryRoot,scratch,{scenario:"browser-window",pluginSourcesRoot:packages.directory});
    report.sourceBinding.artifactsBefore=await capturePanelArtifacts(fixture);
    try {report.outcome=await runPluginPanelNativeFixture(fixture,{output:join(environment.root,"native-report.json"),fixtureRoot:join(environment.root,"native-fixture"),env:environment.env,stdio:"ignore",timeoutMs:100000});}
    catch(error){report.outcome=error.panelReport??null;throw error;}
    report.validation=await validateBrowserWindowOutcome(report.outcome);report.status="pass";
  } catch(error){failure=error;report.status="failed";report.error=String(error instanceof Error?error.message:error);}
  finally {
    try {
      report.sourceBinding??={};report.sourceBinding.after=await capturePanelSources(repositoryRoot);
      report.sourceBinding.sourcesUnchanged=fingerprintsEqual(report.sourceBinding.before,report.sourceBinding.after);
      if(fixture){report.sourceBinding.artifactsAfter=await capturePanelArtifacts(fixture);report.sourceBinding.artifactsUnchanged=fingerprintsEqual(report.sourceBinding.artifactsBefore,report.sourceBinding.artifactsAfter);}
      if(packages){report.packagesAfter=Object.fromEntries(await Promise.all(["char-transform","file-tree"].map(async id=>[id,await treeHash(join(packages.directory,id))])));report.packagesUnchanged=fingerprintsEqual(report.packagesBefore,report.packagesAfter);}
      if(!report.sourceBinding.sourcesUnchanged||!report.sourceBinding.artifactsUnchanged||!report.packagesUnchanged)report.status="failed";
    } catch(error){report.status="failed";report.sourceError=String(error);}
    if(environment)try{report.environmentCleanup=await environment.cleanup();}catch(error){report.status="failed";report.cleanupError=String(error);}
    try{await rm(scratch,{recursive:true,force:true});report.buildScratchRemoved=true;}
    catch(error){report.status="failed";report.buildScratchRemoved=false;report.scratchCleanupError=String(error);}
    if(report.environmentCleanup?.isolatedEnvironmentRemoved!==true)report.status="failed";
    report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2),{flag:"wx",mode:0o600});
  }
  console.log(JSON.stringify({output,status:report.status,runId:report.runId,hostedIpcRoundTrip:report.validation?.roundTripMeasurement}));
  if(failure||report.status!=="pass")throw failure||Error("Native browser contract failed; retained report");
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===resolve(process.argv[1]))await main();
