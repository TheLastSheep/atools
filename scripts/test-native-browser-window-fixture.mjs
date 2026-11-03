import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { createBrowserWindowFixturePackages, tipsWindowSha256, browserWindowIsolationContract, contextMenuSources, reviewedContextMenu } from "./lib/native-browser-window-package.mjs";
import { repositoryRoot, buildPluginPanelNativeFixture } from "./probe-plugin-panel-native.mjs";
import { validateBrowserWindowOutcome } from "./probe-plugin-browser-window-native.mjs";

const directory=await mkdtemp("/private/tmp/atools-browser-contract-offline-");
try {
  const prepared=await createBrowserWindowFixturePackages(repositoryRoot,directory);
  const manifest=JSON.parse(await readFile(join(prepared.directory,"file-tree/plugin.json"),"utf8"));
  assert.equal(manifest.preload,undefined);assert.deepEqual(manifest.permissions,["browserWindow"]);
  assert.equal(manifest.syntheticFixture.originalPackage,false);
  const html=await readFile(join(prepared.directory,"file-tree/index.html"),"utf8");
  const inline=html.match(/<script>([\s\S]*?)<\/script>/)?.[1];assert(inline,"Generated script missing");
  const scriptScope=()=>({window:{require:()=>({ipcRenderer:{}})},console:{log(){}}});
  const initialized=scriptScope();runInNewContext(inline,initialized,{timeout:1000});
  for(const key of ["__AToolsOriginalGeometryInfo","__AToolsOriginalGeometryMove","__AToolsOriginalGeometryResize"])
    assert.equal(typeof initialized.window[key],"function","Whole generated script initializes original function declaration: "+key);
  assert.equal(typeof initialized.window.__AToolsWindowGeometryFixture?.run,"function");
  assert.equal(typeof initialized.window.__AToolsWindowGeometryFixture?.state,"function");
  assert.equal(prepared.originalGeometry.files.length,2);
  const joinedWithoutTerminator=inline.replace('})();\n// Installed only in generated private BrowserWindow acceptance packages.','})()\n// Installed only in generated private BrowserWindow acceptance packages.');
  assert.notEqual(joinedWithoutTerminator,inline,"Regression mutation must remove the real script boundary terminator");
  assert.throws(()=>runInNewContext(joinedWithoutTerminator,scriptScope(),{timeout:1000}),error=>error.name==="TypeError");
  const source=html.slice(html.indexOf("class TipsWindow {"),html.indexOf("\nwindow.__AToolsReviewedTipsWindow"));
  assert.equal(createHash("sha256").update(source).digest("hex"),tipsWindowSha256,"Exact reviewed complete original class bytes are preserved");
  assert(html.includes("synchronousHandleChecked"));assert(html.includes("readyCallbackCount"));
  assert(!html.includes("createBrowserWindow ="),"Fixture must not replace the production create API");
  assert(html.includes('ipcRenderer.once(${JSON.stringify(clickChannel)},function(event,marker)'));
  assert(html.includes('if(event.senderId!==${JSON.stringify(parentId)}||marker!==${JSON.stringify(clickMarker)})return;'));
  const armAckIndex=html.indexOf('if(ack!==clickMarker)throw Error("OriginalMenuClickArmAckInvalid")');
  const triggerIndex=html.indexOf('ipc().sendTo(childId,clickChannel,clickMarker)');
  assert(armAckIndex>=0&&triggerIndex>armAckIndex,"Click trigger follows the real arming RPC ACK");
  assert(!html.includes('()=>handle.webContents.executeJavaScript("document.getElementById(\'hidePile\').click();true")'),
    "Fixture must not await a self-closing click RPC");
  for(const pin of contextMenuSources){
    const copied=await readFile(join(prepared.directory,"file-tree",pin.path));
    assert.equal(createHash("sha256").update(copied).digest("hex"),pin.sha256,"Complete original menu dependency bytes preserved: "+pin.path);
  }
  const menuClass=html.slice(html.indexOf("// 上下文菜单类"),html.indexOf("\nwindow.__AToolsReviewedContextMenuWindow"));
  assert.equal(createHash("sha256").update(menuClass).digest("hex"),contextMenuSources[0].sha256);
  assert.equal(prepared.originalContextMenu.files.length,4);assert.equal(prepared.originalContextMenu.queryConfigurationVerified,false);
  const changedRoot=join(directory,"changed-source"),changedPath=join(changedRoot,"ZTools-plugins/plugins/pomodoro-timer");
  const {mkdir,writeFile}=await import("node:fs/promises");await mkdir(join(changedPath,"page/index/js"),{recursive:true});
  await writeFile(join(changedPath,contextMenuSources[0].path),"altered");
  await assert.rejects(reviewedContextMenu(changedRoot),/Reviewed ContextMenu source changed/);
  const target=await readFile(join(prepared.directory,"file-tree/page/Tips/successTips.html"),"utf8");
  assert(!target.includes("<script"));
  await assert.rejects(buildPluginPanelNativeFixture(repositoryRoot,directory,{scenario:"browser-window",pageDocument:true,dialogAcceptance:true,pluginSourcesRoot:prepared.directory}),/generated opaque/);
  await assert.rejects(buildPluginPanelNativeFixture(repositoryRoot,directory,{scenario:"browser-window"}),/generated opaque/);
  await assert.rejects(validateBrowserWindowOutcome({passed:false}),/failed/);
  const contract=await browserWindowIsolationContract(repositoryRoot);
  const value={passed:true,pageDocumentMode:false,reviewedOriginalPartsOnly:true,reviewedOriginalContextMenuFiles:true,pageDocumentsAfterCleanup:0,resourceLeasesAfterCleanup:0,checks:{},
    observations:{originalTipsWindow:{result:{synchronousHandle:true,originalGetStatusFalse:true,ready:true}},originalTipsWindowClose:{result:{classClearedHandle:true}},
      pendingClose:{result:{notDestroyedBeforeClose:true,wasPendingOnClose:true,destroyedAfterClose:true,readyRejected:true,callbackCount:0,actualClose:true}},
      nested:{immediate:true,readyCallbackCount:1,actualClose:true,destroyed:true},
      hostedIpcBasic:{parentId:1,childId:2,receivedParentPacket:{senderId:1,args:[{senderId:-55,value:42},"second",7]},receivedChildPacket:{senderId:2,payload:{childId:2,senderId:-77,args:[{senderId:-55,value:42},"second",7]}},positiveDistinctIds:true,childIdentityMatches:true,returnWasVoid:true,parentToChildSenderAuthentic:true,childToParentSenderAuthentic:true,allArgumentsPreserved:true,childOpaque:true,childNoTauri:true,onceCount:1,offCount:0,removedCount:0},
      hostedIpcSiblingNested:{mainId:1,firstId:3,secondId:4,nestedId:5,receivedSiblingPacket:{senderId:3,args:["from-sibling",{senderId:-99}]},receivedNestedPacket:{senderId:5,payload:{value:73}},positiveDistinctIds:true,siblingSenderAuthentic:true,nestedCreatorMatches:true,nestedIdentityMatches:true,nestedToMainSenderAuthentic:true},
      hostedIpcLifecycle:{oldId:6,newId:7,reloadedPackets:[{senderId:6,value:"fresh-document"}],reloadIdStable:true,reloadReplacedDocument:true,oldListenersNotCopied:true,freshSenderAuthentic:true,closedHandleDestroyed:true,newIdentityDistinct:true,closedTargetDeliveries:0},
      originalContextMenu:{parentId:1,childId:8,positiveDistinctIds:true,childIdentityMatches:true,handshakeParentMatches:true,originalChildPreloadExecuted:true,classClearedHandle:true,actualChildDestroyed:true,childOpaque:true,childNoTauri:true,originalToggleCalls:[false],originalDomMenuText:"隐藏番茄堆",queryConfigurationVerified:false},
      isolation:{synchronousHandleChecked:true,readyCallbackCount:1,probes:contract.DESKTOP_BROWSER_WINDOW_ISOLATION_CHECK_IDS.map(id=>({id,passed:true}))}}};
  const rttMarker="atools-hosted-ipc-rtt-v1";
  const initialBounds={x:24,y:24,width:460,height:220},movedBounds={x:36,y:31,width:460,height:220},resizedBounds={x:36,y:31,width:420,height:180};
  value.observations.windowGeometry={synchronous:true,defensiveCopies:true,eventSawConfirmedState:true,initial:initialBounds,
    info:{size:{w:460,h:220},pos:{x:24,y:24}},getters:[[460,220],[460,220],[24,24],[100,80],[1000,800]],
    moveExpected:movedBounds,afterMove:movedBounds,eventSnapshot:movedBounds,resizeExpected:resizedBounds,afterResize:resizedBounds,
    afterInfo:{size:{w:420,h:180},pos:{x:36,y:31}},nested:{synchronous:true,finite:true,updated:true}};
  value.observations.windowGeometryActualBounds=resizedBounds;
  value.observations.windowGeometryClose={closed:true,destroyed:true};
  value.observations.hostedIpcBasic.roundTripMeasurement={schemaVersion:1,iterations:20,serial:true,descriptiveOnly:true,
    requestChannel:"atools:fixture:hosted-ipc:rtt-request",ackChannel:"atools:fixture:hosted-ipc:rtt-ack",payloadTemplate:{fixture:rttMarker,value:42},
    clock:"main-frame performance.now",start:"Immediately before public ipcRenderer.sendTo",end:"Matching authenticated child ack listener callback",ackDeadlineMs:10000,
    visibility:{documentHidden:true,visibilityState:"hidden"},samples:Array.from({length:20},(_,sequence)=>({sequence,senderId:2,elapsedMs:sequence,
      requestPayloadUtf8Bytes:JSON.stringify({fixture:rttMarker,sequence,value:42}).length}))};
  for(const key of ["temporaryDataRemoved","allTaskRunsTerminal","dataRuntimeDrained","pathRuntimeDrained","dialogRuntimeDrained","originalSourcesUnchanged"])value[key]=true;
  const accepted=await validateBrowserWindowOutcome(value);
  for(const mutate of [g=>delete g.windowGeometry,g=>g.windowGeometry.synchronous=false,
    g=>g.windowGeometry.afterMove.x=NaN,g=>g.windowGeometry.getters[0]={},g=>g.windowGeometry.info.size.w=null,
    g=>g.windowGeometry.eventSnapshot={x:0,y:0,width:1,height:1},g=>g.windowGeometryActualBounds={...g.windowGeometryActualBounds,width:g.windowGeometryActualBounds.width+1},
    g=>g.windowGeometry.nested.updated=false,g=>g.windowGeometryClose.closed=false]){
    const forged=structuredClone(value);mutate(forged.observations);await assert.rejects(validateBrowserWindowOutcome(forged));
  }
  assert.deepEqual(accepted.roundTripMeasurement,{n:20,p50Ms:9,p95Ms:18,maxMs:19,method:"nearest-rank",descriptiveOnly:true,
    visibility:{documentHidden:true,visibilityState:"hidden"},clock:"main-frame performance.now",
    scope:"Public sendTo main -> hosted child -> authenticated ack; current opaque frame; excludes physical input, paint and independent native floating windows"});
  // Synthetic elapsed values validate statistics and rejection only; they are never reported as native speed.
  for(const mutate of [measurement=>measurement.samples.pop(),measurement=>measurement.samples[1].sequence=0,
    measurement=>measurement.samples[1].senderId=99,measurement=>measurement.samples[1].elapsedMs=NaN,
    measurement=>measurement.samples[1].elapsedMs=Infinity,measurement=>measurement.samples[1].elapsedMs=-1,
    measurement=>measurement.samples[1].elapsedMs="1",measurement=>measurement.samples[1].requestPayloadUtf8Bytes++,
    measurement=>measurement.visibility.documentHidden=false,measurement=>measurement.end="20ms polling",
    measurement=>measurement.serial=false,measurement=>measurement.iterations=19]){
    const forged=structuredClone(value);mutate(forged.observations.hostedIpcBasic.roundTripMeasurement);
    await assert.rejects(validateBrowserWindowOutcome(forged));
  }
  const absentMeasurement=structuredClone(value);delete absentMeasurement.observations.hostedIpcBasic.roundTripMeasurement;
  await assert.rejects(validateBrowserWindowOutcome(absentMeasurement));
  for(const ids of [Array(9).fill("forged"),[...contract.DESKTOP_BROWSER_WINDOW_ISOLATION_CHECK_IDS].reverse()]){
    const forged=structuredClone(value);forged.observations.isolation.probes=ids.map(id=>({id,passed:true}));
    await assert.rejects(validateBrowserWindowOutcome(forged),/Exact isolation IDs/);
  }
  for(const [section,field] of [["hostedIpcBasic","childToParentSenderAuthentic"],["hostedIpcSiblingNested","siblingSenderAuthentic"],["hostedIpcLifecycle","reloadReplacedDocument"],["originalContextMenu","originalChildPreloadExecuted"]]){
    const forged=structuredClone(value);forged.observations[section][field]=false;
    await assert.rejects(validateBrowserWindowOutcome(forged));
  }
  for(const mutate of [record=>record.observations.hostedIpcBasic.parentId=-1,record=>record.observations.hostedIpcSiblingNested.secondId=record.observations.hostedIpcSiblingNested.firstId,
    record=>record.observations.hostedIpcBasic.receivedChildPacket.senderId=-77,record=>record.observations.hostedIpcLifecycle.reloadedPackets.push({senderId:6,value:"stale-listener"})]){
    const forged=structuredClone(value);mutate(forged);await assert.rejects(validateBrowserWindowOutcome(forged));
  }
  const missing=structuredClone(value);delete missing.observations.originalContextMenu;await assert.rejects(validateBrowserWindowOutcome(missing));
  const scenario=await readFile(join(repositoryRoot,"tests/components/nativePluginBrowserWindowScenario.ts"),"utf8");
  const frame=await readFile(join(repositoryRoot,"tests/components/nativePluginBrowserWindowFrameProbe.js"),"utf8");
  assert(scenario.includes('event.source!==source||event.origin!=="null"'));
  assert(frame.includes('event.source!==window.parent'));
  assert(frame.includes('responses.size>=32'));
  assert(frame.includes('await handle.ready'));assert(frame.includes('await tips.close()'));
  assert(!frame.includes("eval("));assert(!frame.includes("new Function"));
  console.log("Native browser fixture offline: complete generated script initialization and missing-terminator rejection; pinned original function declarations; strict geometry/IPC/menu validation and source/token routing. No browser, GUI or original business method executed.");
} finally {await rm(directory,{recursive:true,force:true});}
