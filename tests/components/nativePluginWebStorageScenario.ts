import { mount, unmount } from "svelte";
import PluginPanel from "../../src/components/PluginPanel.svelte";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";
import type { FeatureAction } from "../../src/lib/types";
import { invoke as rawInvoke } from "@tauri-apps/api/core";

type Runtime=Record<string,number|boolean>;
type FrameReply={state:{opaque:boolean;noTauri:boolean;ready:boolean;eventCount:number;errors:number};result:Record<string,boolean|number>;error:string};
const delay=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
async function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>{
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Native Web Storage IPC deadline: "+command)),12000);
    rawInvoke<T>(command,args).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>>{
  const deadline=performance.now()+18000;
  while(performance.now()<deadline){const value=await read();if(value)return value as NonNullable<T>;await delay();}
  throw Error(message);
}
function drained(value:Runtime){return ["sessions","openings","pending","hostSessions","hostIntents","hostInvocations","resourceLeases",
  "dataSessions","dataIntents","dataInvocations","dataPreparations","webStorageEvents","webStorageEventBytes","activePathSnapshots",
  "activePathIntents","activePathPreparations","pathSnapshotBytes","dialogSessions","dialogIntents","dialogInvocations","dialogPreparations",
  "nativeDialogs","pageDocuments"].every(key=>value[key]===0)
  &&["transport","hostTransport","dataTransport","dialogTransport"].every(key=>value[key]===false);}
const mainFrame=()=>document.querySelector<HTMLIFrameElement>('#app iframe[title="Plugin"]');
const search=()=>document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]');

export async function runNativePluginWebStorageScenario(){
  const checks:Record<string,boolean>={},observations:Record<string,unknown>={};
  let token="",sequence=0,phase="setup",peerHost:HTMLElement|null=null,peerInstance:ReturnType<typeof mount>|null=null;
  function setPhase(value:string){phase=value.slice(0,256);}
  function check(ok:unknown,label:string){if(!ok){setPhase(phase+":assert:"+label);throw Error(label);}checks[label]=true;}
  const frameOf=(host:ParentNode)=>host.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  async function request(host:ParentNode,operation:string,expected?:string):Promise<FrameReply>{
    setPhase(phase.split("/")[0]+"/"+operation);
    const source=frameOf(host)?.contentWindow,id="web-storage-"+(++sequence);
    if(!source)throw Error("Actual PluginPanel iframe unavailable");
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{window.removeEventListener("message",receive);reject(Error("Web Storage frame probe deadline: "+operation));},10000);
      function receive(event:MessageEvent){
        if(event.source!==source||event.origin!=="null"||event.data?.kind!=="atools-web-storage-result"
          ||event.data.token!==token||event.data.id!==id)return;
        clearTimeout(timer);window.removeEventListener("message",receive);
        if(event.data.error)reject(Error("Web Storage probe failed: "+operation));
        else if(event.data.state?.errors!==0)reject(Error("Frame reported runtime errors"));
        else resolve(event.data as FrameReply);
      }
      window.addEventListener("message",receive);
      source.postMessage({kind:"atools-web-storage-probe",token,id,operation,expected},"*");
    });
  }
  async function approve(tool:string,title:string,label:string){
    await approveNativePanelPermission({title,tool,scopes:["plugin_data"],label,invoke,until,check:(ok,message)=>check(ok,message)});
  }
  async function openBySearch(code:"web-storage-a"|"web-storage-b",query:string,tool:string,title:string){
    phase=code+":search";
    const input=await until(search,"Actual App search input missing");
    input.focus();input.value=query;input.dispatchEvent(new Event("input",{bubbles:true}));
    const pluginId=code.endsWith("a")?"file-tree":"char-transform";
    await until(()=>document.querySelector(`[role="option"][aria-selected="true"][data-plugin-id="${pluginId}"]`),"Real catalog did not select the Web Storage fixture");
    phase=code+":enter";input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
    phase=code+":one-time-permission";
    await approve(tool,title,code);
    phase=code+":real-plugin-panel";
    const panel=await until(()=>mainFrame(),"Actual App did not render PluginPanel after permission");
    await until(async()=>{try{return (await request(document,"state")).state.ready?true:null;}catch{return null;}},"Opaque PluginPanel fixture did not become ready");
    return panel;
  }
  async function closePeer(){
    if(peerInstance){await unmount(peerInstance);peerInstance=null;}
    peerHost?.remove();peerHost=null;
  }
  async function closeMain(){
    await closePeer();document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')?.click();
    return until(async()=>{const value=await invoke<Runtime>("native_panel_runtime_state");return !mainFrame()&&drained(value)?value:null;},"Plugin close left storage sessions or event metadata active");
  }
  try {
    phase="fixture-metadata";check(location.href==="atools-panel://localhost/","Parent stays on the isolated fixed fixture URL");
    const fixture=await invoke<{token:string;webStorageDataTools:{fileTree:string;charTransform:string}}>("native_panel_fixture");token=fixture.token;
    check(!!fixture.webStorageDataTools?.fileTree&&!!fixture.webStorageDataTools?.charTransform,"Fixture supplies exact generated data capability identities");
    check(drained(await invoke<Runtime>("native_panel_runtime_state")),"Launcher starts without runtime sessions, events or native dialogs");

    phase="open-a-main";const main=await openBySearch("web-storage-a","synthetic web storage A",fixture.webStorageDataTools.fileTree,"本地存储验收 A 请求访问自己的数据");
    check(!!main.srcdoc&&!main.getAttribute("src")&&main.getAttribute("sandbox")==="allow-scripts allow-popups","A runs in the actual default opaque PluginPanel iframe");
    const initial=await request(document,"state");check(initial.state.opaque&&initial.state.noTauri&&initial.state.ready&&initial.state.eventCount===0,
      "A frame is opaque with no Tauri internals and no prior-session storage events");

    phase="activate-peer";const action=await invoke<FeatureAction>("activate_feature",{code:"web-storage-a",payload:null,expectedPluginId:"file-tree"});
    check(action.plugin_id==="file-tree"&&action.feature_code==="web-storage-a","Peer action comes from real activate_feature for the same generated plugin");
    peerHost=document.createElement("div");peerHost.id="native-web-storage-peer";
    Object.assign(peerHost.style,{position:"fixed",left:"12px",top:"12px",width:"640px",height:"360px",zIndex:"2147483000",background:"white"});
    document.body.append(peerHost);
    let peerReady=false;
    peerInstance=mount(PluginPanel,{target:peerHost,props:{action,onclose:()=>{},onescape:()=>{},onredirect:async()=>false,
      onsettingsredirect:()=>false,onready:()=>{peerReady=true;}}});
    phase="approve-peer-one-time-data-session";
    await approve(fixture.webStorageDataTools.fileTree,"本地存储验收 A 请求访问自己的数据","peer-file-tree");
    phase="wait-peer-frame";
    const peer=await until(()=>frameOf(peerHost!),"Second actual PluginPanel did not mount");
    await until(()=>peerReady||peer.contentWindow!==null,"Peer PluginPanel did not initialize");
    const peerState=await until(async()=>{try{const state=(await request(peerHost!,"state")).state;return state.ready?state:null;}catch{return null;}},
      "Peer opaque fixture did not become ready");
    check(peerState.opaque&&peerState.noTauri&&peerState.eventCount===0,"Peer begins as a fresh opaque session with no stale event replay");
    check(peer.getAttribute("sandbox")==="allow-scripts allow-popups","Peer is another real opaque-origin production PluginPanel");

    setPhase("run-original-theme-and-ui");const theme=await request(document,"theme-ui");observations.originalClassChecks=theme.result;
    check(theme.result.themeApplied&&theme.result.radioChecked&&theme.result.sidebarCollapsed&&theme.result.sidebarStored,
      "Unchanged original ThemeManager applies dark and UIManager toggles the real sidebar button");
    const seed=await request(document,"seed");check(seed.result.seeded,"A stores synthetic event and namespace probes");
    setPhase("wait-for-five-seed-events");
    const seededEvents=await until(async()=>{
      const state=(await request(peerHost!,"state")).state;
      return state.eventCount===5&&state.errors===0?state:null;
    },"Peer did not receive the five theme, UI and seed events");
    check(seededEvents.eventCount===5&&seededEvents.errors===0,"Peer receives all five initial synthetic storage events without frame errors");
    const drainedSeedEvents=await request(peerHost,"drain-events");
    check(drainedSeedEvents.result.count===5,"Exactly five initial events are drained before the targeted update");
    const update=await request(document,"writer-update");check(update.result.selfEventCount===0,"Storage writer receives no storage event for its own mutation");
    setPhase("wait-for-target-peer-event");
    const event=await until(async()=>{
      const reply=await request(peerHost!,"event-peek");
      return reply.result.present?reply:null;
    },"Peer did not receive the targeted cross-document storage event");
    observations.peerStorageEvent=event.result;
    check(event.result.present&&event.result.keyMatches&&event.result.oldMatches&&event.result.newMatches
      &&event.result.urlMatches&&event.result.storageAreaMatches,"Peer gets exact synthetic key/old/new, matching frame URL and its Storage object");
    const consumed=await request(peerHost,"event-consume");check(consumed.result.consumed,"Targeted peer event is consumed before the same-value check");
    const eventBeforeSame=await invoke<Runtime>("native_panel_runtime_state");
    const same=await request(document,"same-value");
    const eventAfterSame=await invoke<Runtime>("native_panel_runtime_state");
    await delay(250);
    const afterSame=await request(peerHost,"event-count");
    observations.sameValueEventWindow={quietWindowMs:250,targetEvents:afterSame.result.targetCount,
      nativeEventsBefore:eventBeforeSame.webStorageEvents,nativeEventsAfter:eventAfterSame.webStorageEvents,
      nativeBytesBefore:eventBeforeSame.webStorageEventBytes,nativeBytesAfter:eventAfterSame.webStorageEventBytes,
      evictionsBefore:eventBeforeSame.webStorageEventEvictions,evictionsAfter:eventAfterSame.webStorageEventEvictions};
    check(same.result.selfEventCount===0&&afterSame.result.targetCount===0
      &&eventAfterSame.webStorageEvents===eventBeforeSame.webStorageEvents
      &&eventAfterSame.webStorageEventBytes===eventBeforeSame.webStorageEventBytes
      &&eventAfterSame.webStorageEventEvictions===eventBeforeSame.webStorageEventEvictions,
      "Same-value write creates no additional native event record or peer event during the bounded observation window");
    const ns=await request(document,"namespace","A");check(ns.result.localMatches&&ns.result.localStillMatches&&ns.result.dbSeparated,
      "SQLite localStorage namespace stays separate from legacy dbStorage for identical key text");
    const utf16=await request(document,"utf16");check(utf16.result.roundtrip,"UTF-16 lone surrogate key and value round-trip without normalization");
    phase="quota-and-128-key-enumeration";
    const quota=await request(document,"quota");check(quota.result.quota&&quota.result.oldPreserved,"Quota failure preserves the previous stored value");
    const perf=await request(document,"measure-128");observations.boundedEnumeration=perf.result;
    check(perf.result.syntheticKeys===128&&perf.result.enumeratedSyntheticKeys===128&&perf.result.entriesCalls>=1&&perf.result.entriesCalls<=64
      &&Number.isFinite(perf.result.elapsedMs),"128 synthetic keys enumerate through the actual Storage proxy with bounded elapsed-time evidence");
    const active=await invoke<Runtime>("native_panel_runtime_state");
    check(active.webStorageEventEmitMismatches===0,"Native storage event relay reports no target/session mismatches");
    check(active.dataSessions===2&&active.dataTransport===true,"Only the two explicit A document sessions are open");
    observations.activeSessionCounts={dataSessions:active.dataSessions,webStorageEvents:active.webStorageEvents,
      webStorageEventBytes:active.webStorageEventBytes,webStorageEventEmitMismatches:active.webStorageEventEmitMismatches};

    await closePeer();
    const mainClosed=await closeMain();
    check(drained(mainClosed),"Closing peer and main drains runtime sessions and private event store");
    setPhase("reopen-a-restore-original-classes");
    await openBySearch("web-storage-a","synthetic web storage A",fixture.webStorageDataTools.fileTree,"本地存储验收 A 请求访问自己的数据");
    const reopenedState=await request(document,"state");
    check(reopenedState.state.eventCount===0,"A reopens with no historical storage event replay");
    const persist=await request(document,"restore-classes");observations.persistence=persist.result;
    check(persist.result.themeApplied&&persist.result.sidebarRestored&&persist.result.iconRestored
      &&persist.result.themeInstance&&persist.result.uiInstance,"Recreated original ThemeManager and UIManager restore persisted dark theme and collapsed sidebar");
    const persistKeys=await request(document,"persist");
    check(persistKeys.result.theme&&persistKeys.result.sidebar&&persistKeys.result.namespace,"A data remains persisted after real plugin reopen");
    observations.persistedKeys=persistKeys.result;
    await closeMain();
    phase="open-b-and-check-isolation";
    const second=await openBySearch("web-storage-b","synthetic web storage B",fixture.webStorageDataTools.charTransform,"本地存储验收 B 请求访问自己的数据");
    check(!!second,"Real search and Enter opens B as a distinct plugin identity");
    const bState=await request(document,"state");check(bState.state.opaque&&bState.state.noTauri,"B also uses the default opaque production frame");
    const bNamespace=await request(document,"namespace","B");
    check(bNamespace.result.localMatches&&bNamespace.result.localStillMatches&&bNamespace.result.dbSeparated,"B cannot observe A's file-tree localStorage namespace");
    await request(document,"write-b");await closeMain();
    phase="reopen-a-after-b";
    await openBySearch("web-storage-a","synthetic web storage A",fixture.webStorageDataTools.fileTree,"本地存储验收 A 请求访问自己的数据");
    const aPersist=await request(document,"restore-classes");check(aPersist.result.themeApplied&&aPersist.result.sidebarRestored&&aPersist.result.iconRestored,
      "Opening B does not overwrite A's original-class state");
    const aKeys=await request(document,"persist");check(aKeys.result.namespace&&aKeys.result.theme&&aKeys.result.sidebar,
      "A namespace remains unchanged after B writes its own localStorage");
    observations.reopenAfterB={...aPersist.result,...aKeys.result};
    setPhase("final-cleanup");await closeMain();
    check(location.href==="atools-panel://localhost/","All storage sessions return to the fixed native parent URL");
    return {passed:true,checks,observations,scope:{syntheticPackagesOnly:true,reviewedOriginalClassesOnly:true,
      originalPluginExecuted:false,nodeStarted:false,clipboardOperationsPerformed:false,nativePickersOpened:false,appleScriptUsed:false,
      externalNetworkRequested:false,privateLoopbackDataTransport:true,
      originalClasses:["ThemeManager","UIManager"],eventValuesAndUrlsLogged:false}};
  } catch(error){
    observations.failureRuntime=await invoke<Runtime>("native_panel_runtime_state").catch(()=>null);
    observations.failureHasOnlyMetadata=true;
    await closeMain().catch(()=>{});
    return {passed:false,checks,observations,phase,error:String(error instanceof Error?error.name:"FixtureError")};
  }
}
