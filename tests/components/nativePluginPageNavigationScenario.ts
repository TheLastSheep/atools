import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";

type Runtime=Record<string,number|boolean>;
type WorkerPolicyProbe={kind:string;available:boolean;attempted:boolean;status:string;scriptExecuted:boolean;
  violations:Array<{effectiveDirective:string;blockedUriKind:string}>;cleanup:{complete:boolean}};
type WorkerPolicy={probes:WorkerPolicyProbe[];observationWindowMs:number;serviceWorkerRegistrationAttempted:boolean;networkRequested:boolean};
type FrameState={title:string;href:string;syntheticReady:boolean;syntheticDataRoundtrip:boolean;noTauri:boolean;
  transportPresent:boolean;nestedBlankProof:{created:boolean;documentWriteRead:boolean;href:string}|null;workerPolicy:WorkerPolicy|null};
type FrameObservation={state:FrameState;eventOrigin:string};
type NavigationEvent={sequence:number;requestedKind:string;targetRequestKind:string;targetIsMainFrame:boolean;
  targetOriginMatches:boolean;matchedPageDocumentId:string|null;activeBefore:boolean;revoked:boolean;beforeDelegateForward:boolean};
type NavigationSnapshot={enabled:boolean;installed:boolean;policy:"observe"|"revoke";events:NavigationEvent[];droppedEvents:number};
const OPERATIONS=["nav-replace","nav-reload","nav-meta","nav-self-blank","nav-history"] as const;
const REQUESTED_KIND={"nav-replace":"raw-asset","nav-reload":"bootstrap","nav-meta":"raw-asset","nav-self-blank":"about-blank","nav-history":"raw-asset"};
const pause=(ms=40)=>new Promise(resolve=>setTimeout(resolve,ms));
async function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>{
  return new Promise((resolve,reject)=>{const deadline=setTimeout(()=>reject(Error("Native navigation IPC deadline: "+command)),10000);
    rawInvoke<T>(command,args).then(value=>{clearTimeout(deadline);resolve(value);},error=>{clearTimeout(deadline);reject(error);});});
}
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>>{
  const deadline=performance.now()+12000;
  while(performance.now()<deadline){const value=await read();if(value)return value as NonNullable<T>;await pause();}
  throw Error(message);
}
const runtime=()=>invoke<Runtime>("native_panel_runtime_state");
const snapshot=()=>invoke<NavigationSnapshot>("native_page_navigation_snapshot");
const frame=()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
const permission=()=>document.querySelector<HTMLElement>(".plugin-permission-dialog");
const launcher=()=>document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]');
function noUnusedRuntime(value:Runtime){
  return value.sessions===0&&value.openings===0&&!value.transport&&value.hostSessions===0&&value.hostIntents===0
    &&value.hostInvocations===0&&!value.hostTransport&&value.resourceLeases===0&&value.activePathSnapshots===0
    &&value.activePathIntents===0&&value.activePathPreparations===0&&value.pathSnapshotBytes===0
    &&value.dialogSessions===0&&value.dialogIntents===0&&value.dialogInvocations===0&&value.dialogPreparations===0
    &&value.nativeDialogs===0&&!value.dialogTransport;
}
function fullyDrained(value:Runtime){return noUnusedRuntime(value)&&value.pending===0&&value.pageDocuments===0
  &&value.dataSessions===0&&value.dataIntents===0&&value.dataInvocations===0&&value.dataPreparations===0&&!value.dataTransport;}
function documentIdentity(node:HTMLIFrameElement){
  const src=node.getAttribute("src")||"";
  const matched=src.match(/^(atools-page:\/\/([a-f0-9]{32})\.localhost)\/[a-f0-9]{32}\/bootstrap\.html$/);
  if(!matched||node.srcdoc!==""||node.getAttribute("sandbox")!=="allow-scripts allow-same-origin")
    throw Error("Synthetic plugin is not in the actual native document-mode iframe");
  return {src,origin:matched[1],pageDocumentSimpleId:matched[2]};
}
const sameDocument=(event:NavigationEvent,simpleId:string)=>event.matchedPageDocumentId?.replaceAll("-","")===simpleId;

export async function runNativePluginPageNavigationScenario(){
  const checks:Record<string,boolean>={},observations:Record<string,unknown>={cases:[]};
  const check=(value:unknown,label:string):void=>{if(!value)throw Error(label);checks[label]=true;};
  let token="",sequence=0,phase="setup",activeOrigin="",policy:"observe"|"revoke"|undefined;
  async function request(operation:string,timeout=3000,observeOpaqueTarget=false):Promise<FrameObservation>{
    const source=frame()?.contentWindow,id="page-navigation-"+(++sequence);
    if(!source)throw Error("Synthetic plugin iframe unavailable: "+operation);
    return new Promise((resolve,reject)=>{
      const deadline=setTimeout(()=>{window.removeEventListener("message",receive);reject(Error("Synthetic frame probe deadline: "+operation));},timeout);
      function receive(event:MessageEvent){
        if(event.source!==source||(event.origin!==activeOrigin&&!(observeOpaqueTarget&&event.origin==="null"))
          ||event.data?.kind!=="atools-page-navigation-probe-result"||event.data.token!==token||event.data.id!==id)return;
        clearTimeout(deadline);window.removeEventListener("message",receive);
        if(event.data.error)reject(Error(String(event.data.error)));else resolve({state:event.data.state,eventOrigin:event.origin});
      }
      window.addEventListener("message",receive);
      source.postMessage({kind:"atools-page-navigation-probe",token,id,operation},"*");
    });
  }
  async function closePlugin(){
    document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')?.click();
    return until(async()=>{const value=await runtime();return !document.querySelector(".plugin-panel")&&!permission()&&fullyDrained(value)?value:null;},
      "Whole synthetic plugin close did not drain documents, sessions, transports and permission UI");
  }
  try {
    check(location.href==="atools-panel://localhost/","Parent remains the fixed native atools-panel fixture URL");
    const fixture=await invoke<{token:string;pageDocumentMode:boolean;pageNavigationDataTool:string}>("native_panel_fixture");
    token=fixture.token;
    check(fixture.pageDocumentMode===true&&typeof fixture.pageNavigationDataTool==="string"&&fixture.pageNavigationDataTool.length>0,
      "Dedicated fixture enables real page documents and supplies the exact synthetic data capability");
    const hook=await snapshot();policy=hook.policy;
    check(hook.enabled&&["observe","revoke"].includes(policy)&&hook.droppedEvents===0,
      "Dedicated native navigation policy is enabled before plugin preparation");
    observations.initialNativeSnapshot=hook;
    await until(launcher,"Real App launcher search input missing");
    const initial=await runtime();check(fullyDrained(initial),"Synthetic launcher starts without Node, scoped sessions, documents or native dialogs");
    const identities=new Set<string>();
    for(const operation of OPERATIONS){
      phase=operation+":open";
      const input=await until(launcher,"Real launcher unavailable between independent cases");
      input.focus();input.value="synthetic page navigation";input.dispatchEvent(new Event("input",{bubbles:true}));
      await until(()=>document.querySelector('[role="option"][aria-selected="true"][data-plugin-id="file-tree"]'),"Real catalog did not select the synthetic navigation fixture");
      input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
      await approveNativePanelPermission({title:"合成导航探针 请求访问自己的数据",tool:fixture.pageNavigationDataTool,
        scopes:["plugin_data"],label:operation+" synthetic data",invoke,until,check});
      const node=await until(frame,"Actual production PluginPanel iframe missing");
      const identity=documentIdentity(node);
      activeOrigin=identity.origin;
      const installed=await snapshot();check(installed.installed&&installed.policy===policy,
        "Native navigation hook was installed before the actual page preparation: "+operation);
      check(!identities.has(identity.pageDocumentSimpleId),"Each navigation case owns a fresh native document: "+operation);
      identities.add(identity.pageDocumentSimpleId);
      const ready=await until(async()=>{try{const value=await request("state");return value.state.syntheticReady?value:null;}catch{return null;}},
        "Synthetic real dbStorage roundtrip did not become ready");
      check(ready.eventOrigin===identity.origin&&ready.state.syntheticDataRoundtrip&&ready.state.noTauri&&ready.state.transportPresent,
        "Synthetic payload runs real data storage inside its isolated native origin: "+operation);
      const active=await runtime();
      check(noUnusedRuntime(active)&&active.pageDocuments===1&&active.dataSessions===1&&active.dataTransport===true
        &&active.dataIntents===0&&active.dataInvocations===0&&active.dataPreparations===0,
        "Only one native document and approved data session are active: "+operation);
      if(operation===OPERATIONS[0]){
        phase="worker-src-policy";const worker=await request("worker-policy");
        observations.workerPolicy={...worker.state.workerPolicy,eventOrigin:worker.eventOrigin};
        const proof=worker.state.workerPolicy;
        check(worker.eventOrigin===identity.origin&&proof?.probes.length===3&&proof.observationWindowMs===500
          &&proof.serviceWorkerRegistrationAttempted===false&&proof.networkRequested===false,
          "Worker CSP probe uses only bounded private Blob scripts in the actual isolated document");
        for(const [index,kind] of ["classic","module","shared"].entries()){
          const value=proof!.probes[index];
          check(value.kind===kind&&value.cleanup.complete&&value.scriptExecuted===false,
            "Worker probe cleans every owned resource without executing its script: "+kind);
          if(kind==="shared"&&!value.available)check(value.status==="unavailable"&&!value.attempted,
            "Missing native SharedWorker is reported as unavailable without claiming CSP enforcement");
          else check(value.available&&value.attempted&&value.status==="csp-blocked"
            &&value.violations.some(event=>event.effectiveDirective==="worker-src"&&event.blockedUriKind==="blob"),
            "Actual worker-src violation proves private Blob worker blocking: "+kind);
        }
      }
      phase=operation+":nested-positive-control";
      const nested=await request("nested-blank");
      check(nested.eventOrigin===identity.origin&&nested.state.nestedBlankProof?.created
        &&nested.state.nestedBlankProof.documentWriteRead&&nested.state.nestedBlankProof.href==="about:blank",
        "Nested about:blank remains readable and writable: "+operation);
      const afterNested=await runtime();
      check(afterNested.pageDocuments===1&&afterNested.dataSessions===1&&afterNested.dataTransport===true,
        "Nested about:blank does not revoke its parent document or data session: "+operation);
      phase=operation+":pending-permission";await request("pending-permission");
      const pending=await until(permission,"Real frontend runtime permission dialog was not shown");
      check(pending.querySelector("code")?.textContent==="clipboard.write"&&pending.textContent?.includes("合成导航探针"),
        "A genuine unapproved clipboard.write dialog is pending before navigation: "+operation);
      check(noUnusedRuntime(await runtime()),"Pending runtime permission performs no clipboard, Node or OS dialog operation: "+operation);
      const before=await snapshot(),previousSequence=Math.max(0,...before.events.map(event=>event.sequence));
      phase=operation+":navigate";await request(operation);
      let after:NavigationSnapshot;
      if(policy==="revoke") {
        after=await until(async()=>{const value=await snapshot();return value.events.some(event=>event.sequence>previousSequence
          &&sameDocument(event,identity.pageDocumentSimpleId)&&event.requestedKind===REQUESTED_KIND[operation]
          &&event.activeBefore&&event.revoked&&event.beforeDelegateForward)?value:null;},
          "Navigation lacks matching synchronous native revoke-before-delegate evidence: "+operation);
        await until(async()=>{const value=await runtime();return fullyDrained(value)&&!permission()?value:null;},
          "Native revoke left a stale permission UI, document, data session or transport: "+operation);
      } else {await pause(300);after=await snapshot();}
      check(after.droppedEvents===0,"Native navigation event evidence remains complete: "+operation);
      const newFrameObservation=await request("state",350,true).catch(()=>null);
      if(newFrameObservation)check(newFrameObservation.state.noTauri,"Observed target frame has no privileged Tauri internals: "+operation);
      const afterNavigation=await runtime();
      const closed=await closePlugin();
      (observations.cases as unknown[]).push({operation,expectedRequestedKind:REQUESTED_KIND[operation],identity,initialFrame:ready,nestedBlank:nested,
        pendingPermission:{permission:"clipboard.write",approved:false,systemApiInvoked:false},previousSequence,
        nativeEvents:after.events.filter(event=>event.sequence>previousSequence),afterNavigation,newFrameObservation,
        targetOpaqueOriginObserved:newFrameObservation?.eventOrigin==="null",closedRuntime:closed});
      check(fullyDrained(closed),"Whole plugin close drains every fixture runtime resource: "+operation);
      check(location.href==="atools-panel://localhost/","Parent URL remains fixed after navigation case: "+operation);
    }
    observations.finalNativeSnapshot=await snapshot();observations.finalRuntime=await runtime();
    return {passed:true,checks,observations,policy,nativeRevokeVerified:policy==="revoke",scope:{syntheticPureWebOnly:true,
      originalPackagesExecuted:false,nodeStarted:false,nativePanelsOpened:false,clipboardOperationsPerformed:false,
      observeModeClaims:"Real native frame observations only; observe mode does not prove native revocation",
      navigationTargetReadinessRequired:false,parentUrl:"atools-panel://localhost/"}};
  } catch(error){
    observations.failureRuntime=await runtime().catch(()=>null);observations.failureNativeSnapshot=await snapshot().catch(()=>null);
    observations.failureHostText=document.body.innerText.slice(0,1600);
    await closePlugin().catch(()=>{});
    return {passed:false,checks,observations,policy,phase,error:String(error instanceof Error?error.message:error)};
  }
}
