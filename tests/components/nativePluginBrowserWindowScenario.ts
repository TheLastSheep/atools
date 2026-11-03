import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { normalizeDesktopBrowserWindowProbeContract } from "../../src/lib/desktopBrowserWindowIsolationProbe";
type Runtime=Record<string,number|boolean>;
type Observation={state:{noTauri:boolean;sourceOpaque:boolean;errors:string[];destroyed:boolean|null;documentHidden:boolean;visibilityState:string};result:any};
type FixtureDiagnostic={step:string;errorClass:string;knownErrorCode:string};
const diagnosticSteps=new Set(["handle-create","handle-validation","ready","preload-execution","handshake","dom-click","dom-click-arm","dom-click-trigger","close","scenario-check"]);
const diagnosticClasses=new Set(["TypeError","ReferenceError","RangeError","Error","StringThrown","NullThrown","NonErrorThrown"]);
const diagnosticCodes=new Set(["ORIGINAL_MENU_CREATE_FAILED","ORIGINAL_MENU_HANDLE_INVALID","ORIGINAL_MENU_READY_REJECTED",
  "ORIGINAL_MENU_PRELOAD_EXECUTION_FAILED","ORIGINAL_MENU_HANDSHAKE_MISSING","ORIGINAL_MENU_DOM_CLICK_FAILED",
  "ORIGINAL_MENU_DOM_CLICK_ARM_FAILED","ORIGINAL_MENU_DOM_CLICK_TRIGGER_FAILED","ORIGINAL_MENU_CLOSE_UNCONFIRMED","SCENARIO_ASSERTION_FAILED",
  "GEOMETRY_CREATE_FAILED","GEOMETRY_READY_REJECTED","GEOMETRY_SYNCHRONOUS_CONTRACT_FAILED","GEOMETRY_MOVE_UNCONFIRMED","GEOMETRY_RESIZE_UNCONFIRMED","GEOMETRY_NESTED_REJECTED"]);
export function safeDiagnostic(value:unknown):FixtureDiagnostic|null{
  if(!value||typeof value!=="object")return null;
  const item=value as Partial<FixtureDiagnostic>;
  return typeof item.step==="string"&&diagnosticSteps.has(item.step)
    &&typeof item.errorClass==="string"&&diagnosticClasses.has(item.errorClass)
    &&typeof item.knownErrorCode==="string"&&diagnosticCodes.has(item.knownErrorCode)
    ?{step:item.step,errorClass:item.errorClass,knownErrorCode:item.knownErrorCode}:null;
}
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>>{
  const end=performance.now()+12000;
  while(performance.now()<end){const value=await read();if(value)return value as NonNullable<T>;await pause();}
  throw Error(message);
}
async function invoke<T>(command:string):Promise<T>{
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Fixture IPC deadline")),10000);
    rawInvoke<T>(command).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
function drained(value:Runtime){return ["sessions","openings","pending","hostSessions","hostIntents","hostInvocations",
  "resourceLeases","dataSessions","dataIntents","dataInvocations","dataPreparations","activePathSnapshots",
  "activePathIntents","activePathPreparations","pathSnapshotBytes","dialogSessions","dialogIntents",
  "dialogInvocations","dialogPreparations","nativeDialogs","pageDocuments"].every(key=>value[key]===0)
  &&["transport","hostTransport","dataTransport","dialogTransport"].every(key=>value[key]===false);}
export async function runNativePluginBrowserWindowScenario(){
  const checks:Record<string,boolean>={},observations:Record<string,unknown>={};
  let phase="setup",token="",sequence=0;
  const check=(value:unknown,label:string)=>{if(!value)throw Error(label);checks[label]=true;};
  const mainFrame=()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
  const children=()=>document.querySelectorAll(".plugin-browser-window").length;
  async function request(operation:string):Promise<Observation>{
    const source=mainFrame()?.contentWindow,id="browser-contract-"+(++sequence);
    if(!source)throw Error("Main plugin frame is missing");
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{window.removeEventListener("message",receive);reject(Error("Frame operation deadline: "+operation));},operation==="hosted-ipc-basic"?40000:10000);
      function receive(event:MessageEvent){
        if(event.source!==source||event.origin!=="null"||event.data?.kind!=="atools-browser-contract-result"
          ||event.data.token!==token||event.data.id!==id)return;
        clearTimeout(timer);window.removeEventListener("message",receive);
        if(event.data.error){
          const failure=Error("FrameOperationRejected") as Error&{fixtureDiagnostic?:FixtureDiagnostic};
          failure.fixtureDiagnostic=safeDiagnostic(event.data.diagnostic)||undefined;reject(failure);
        }else resolve(event.data);
      }
      window.addEventListener("message",receive);source.postMessage({kind:"atools-browser-contract-probe",token,id,operation},"*");
    });
  }
  async function closePlugin(){
    document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')?.click();
    return until(async()=>{const value=await invoke<Runtime>("native_panel_runtime_state");
      return !document.querySelector(".plugin-panel")&&children()===0&&drained(value)?value:null;},"Plugin close leaves owned resources");
  }
  try {
    const fixture=await invoke<{token:string}>("native_panel_fixture");token=fixture.token;
    check(location.href==="atools-panel://localhost/","Actual fixed native parent URL is retained");
    const input=await until(()=>document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]'),"Actual App search missing");
    check(drained(await invoke<Runtime>("native_panel_runtime_state")),"Launcher has no unused runtime or native picker");
    input.value="synthetic browser contract";input.dispatchEvent(new Event("input",{bubbles:true}));
    await until(()=>document.querySelector('[role="option"][aria-selected="true"][data-plugin-id="file-tree"]'),"Synthetic feature not selected");
    input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
    const node=await until(mainFrame,"Actual PluginPanel main frame missing");
    check(!!node.srcdoc&&!node.getAttribute("src")&&node.getAttribute("sandbox")==="allow-scripts allow-popups",
      "Ordinary opaque production frame is used without document-mode gates");
    const initial=await until(async()=>request("state").catch(()=>null),"Frame observer did not become ready");
    check(initial.state.sourceOpaque&&initial.state.noTauri,"Opaque main plugin has no Tauri internals");
    phase="original-window-geometry";
    const geometry=await request("geometry");observations.windowGeometry=geometry.result;
    check(geometry.result.synchronous&&geometry.result.defensiveCopies&&geometry.result.eventSawConfirmedState
      &&geometry.result.nested.synchronous&&geometry.result.nested.finite&&geometry.result.nested.updated,
      "Original typing and paintbrush geometry calls read actual host state synchronously, including nested creator updates");
    const actualWindow=document.querySelector<HTMLElement>(".plugin-browser-window");
    const actualBounds=actualWindow?{x:parseFloat(actualWindow.style.left),y:parseFloat(actualWindow.style.top),
      width:parseFloat(actualWindow.style.width),height:parseFloat(actualWindow.style.height)}:null;
    observations.windowGeometryActualBounds=actualBounds;
    check(JSON.stringify(actualBounds)===JSON.stringify(geometry.result.afterResize),
      "Confirmed geometry getters match the actual hosted window DOM bounds");
    observations.windowGeometryClose=(await request("geometry-close")).result;
    check((observations.windowGeometryClose as any).closed&&(observations.windowGeometryClose as any).destroyed&&children()===0,
      "Geometry fixture closes its actual hosted window without residual children");
    phase="original-class-create";
    const created=await request("tips-create");observations.originalTipsWindow=created;
    check(created.result.synchronousHandle&&created.result.originalGetStatusFalse&&created.result.ready&&created.result.hasHostId,
      "Unchanged original TipsWindow class stores an immediate handle and reaches actual child readiness");
    await until(()=>children()===1&&document.querySelector(".plugin-browser-window.alwaysOnTop"),"Original class load callback did not set actual hosted alwaysOnTop");
    check(true,"Original class ready callback changes actual hosted window state");
    check((await request("state")).state.destroyed===false,"Original class synchronous isDestroyed is false while active");
    phase="original-class-destroy";
    const closed=await request("tips-close");observations.originalTipsWindowClose=closed;
    await until(()=>children()===0,"Original destroy did not remove actual child");
    check(closed.result.classClearedHandle&&(await request("state")).state.destroyed===true,
      "Original class destroy clears its reference and actually closes the hosted child");
    phase="pending-close";
    const cancelled=await request("pending-close");observations.pendingClose=cancelled;
    await until(()=>children()===0,"Late create escaped pending close");
    check(cancelled.result.notDestroyedBeforeClose&&cancelled.result.wasPendingOnClose&&cancelled.result.destroyedAfterClose
      &&cancelled.result.readyRejected&&cancelled.result.callbackCount===0
      &&cancelled.result.actualClose,"Pending close suppresses callback, rejects readiness and closes the late actual child");
    phase="native-child-isolation";
    const isolation=await request("isolation");observations.isolation=isolation.result;
    check(isolation.result.expected&&isolation.result.reported&&normalizeDesktopBrowserWindowProbeContract(isolation.result.probes).passed
      &&isolation.result.synchronousHandleChecked&&isolation.result.readyCallbackCount===1,
      "Actual child proves opaque origins, DOM and Tauri denial, executeJavaScript, IPC relay, once readiness and close");
    check(children()===0,"Isolation probe closes its actual child");
    phase="nested-creator-readiness";
    const nested=await request("nested");observations.nested=nested.result;
    check(nested.result.immediate&&nested.result.readyCallbackCount===1&&nested.result.actualClose&&nested.result.destroyed,
      "Nested child creator receives its own actual readiness callback and closes the grandchild");
    check(children()===0,"Nested creator and grandchild both close their actual hosted windows");
    phase="hosted-ipc-parent-child";
    const basic=await request("hosted-ipc-basic");observations.hostedIpcBasic=basic.result;
    check(basic.result.positiveDistinctIds&&basic.result.childIdentityMatches&&basic.result.returnWasVoid
      &&basic.result.parentToChildSenderAuthentic&&basic.result.childToParentSenderAuthentic&&basic.result.allArgumentsPreserved,
      "Actual sendTo preserves all arguments and authentic host sender IDs across main and child");
    const measurement=basic.result.roundTripMeasurement,samples=measurement?.samples;
    check(measurement?.iterations===20&&measurement.serial===true&&measurement.descriptiveOnly===true&&Array.isArray(samples)&&samples.length===20
      &&new Set(samples.map((sample:any)=>sample.sequence)).size===20
      &&samples.every((sample:any,index:number)=>sample.sequence===index&&sample.senderId===basic.result.childId
        &&typeof sample.elapsedMs==="number"&&Number.isFinite(sample.elapsedMs)&&sample.elapsedMs>=0),
      "Twenty serial public IPC round trips retain unique sequence, exact child sender and finite callback-timed raw samples");
    check(basic.result.onceCount===1&&basic.result.offCount===0&&basic.result.removedCount===0,
      "Actual IPC once, off and removeAllListeners affect only their registered callbacks");
    check(basic.result.childOpaque&&basic.result.childNoTauri&&children()===0,
      "IPC child remains opaque without Tauri internals and closes after delivery");
    phase="hosted-ipc-sibling-nested";
    const siblings=await request("hosted-ipc-sibling-nested");observations.hostedIpcSiblingNested=siblings.result;
    check(siblings.result.positiveDistinctIds&&siblings.result.siblingSenderAuthentic&&siblings.result.nestedCreatorMatches
      &&siblings.result.nestedIdentityMatches&&siblings.result.nestedToMainSenderAuthentic&&children()===0,
      "Actual sibling and nested sendTo use distinct positive identities and authenticated senders");
    phase="hosted-ipc-confirmed-lifecycle";
    const lifecycle=await request("hosted-ipc-lifecycle");observations.hostedIpcLifecycle=lifecycle.result;
    check(lifecycle.result.reloadIdStable&&lifecycle.result.reloadReplacedDocument&&lifecycle.result.oldListenersNotCopied
      &&lifecycle.result.freshSenderAuthentic&&lifecycle.result.closedHandleDestroyed&&lifecycle.result.newIdentityDistinct
      &&lifecycle.result.closedTargetDeliveries===0&&children()===0,
      "Confirmed reload replaces listeners and confirmed closed identities cannot address a replacement child");
    phase="original-context-menu-calling-pattern";
    const menu=await request("original-context-menu");observations.originalContextMenu=menu.result;
    check(menu.result.positiveDistinctIds&&menu.result.childIdentityMatches&&menu.result.handshakeParentMatches
      &&menu.result.originalChildPreloadExecuted&&menu.result.childOpaque&&menu.result.childNoTauri,
      "Unchanged original menu class and real child preload complete the sendTo handshake");
    check(menu.result.originalDomMenuText.includes("隐藏番茄堆")&&JSON.stringify(menu.result.originalToggleCalls)==="[false]"
      &&menu.result.classClearedHandle&&menu.result.actualChildDestroyed&&children()===0,
      "Original menu DOM click reaches original parent handler, toggles the fixed setting and closes its actual child");
    const final=await request("state");check(final.state.errors.length===0,"Main frame has no unhandled runtime errors");
    observations.finalMainFrame=final;
    phase="output-during-create";
    observations.outputTransition=await request("out-while-creating");
    await until(()=>!mainFrame()&&document.querySelector(".plugin-output-layer .result-title")?.textContent==="合成子窗口输出完成",
      "Original output transition did not release the main iframe");
    await new Promise(resolve=>setTimeout(resolve,250));
    check(children()===0,"Output transition leaves no late-created hosted child after the main frame is removed");
    observations.finalRuntime=await closePlugin();
    check(drained(observations.finalRuntime as Runtime),"All fixture runtime resources drain after whole plugin close");
    return {passed:true,checks,observations,scope:{generatedPackage:true,reviewedOriginalPartsOnly:true,
      originalPackageExecuted:false,reviewedOriginalContextMenuFiles:true,nodeStarted:false,clipboardOperationsPerformed:false,nativePanelsOpened:false,
      queryConfigurationVerified:false,inFlightReloadRaceVerified:false,foregroundInteractionVerified:false,
      trueNativeFloatingWindow:false,documentMode:false}};
  } catch(error){
    const diagnostic=safeDiagnostic((error as Error&{fixtureDiagnostic?:unknown})?.fixtureDiagnostic)
      ||{step:"scenario-check",errorClass:error instanceof Error?"Error":"NonErrorThrown",
        knownErrorCode:"SCENARIO_ASSERTION_FAILED"};
    observations.failureDiagnostic=diagnostic;
    if(phase==="original-window-geometry"){
      observations.geometryFailureState=await request("geometry-state").then(value=>value.result).catch(()=>null);
      observations.geometryFailureDom={children:children(),permissionDialog:!!document.querySelector('[data-permission-dialog="true"]'),
        iframeCount:document.querySelectorAll(".plugin-browser-window iframe").length};
    }
    observations.failureRuntime=await invoke<Runtime>("native_panel_runtime_state").catch(()=>null);
    observations.afterFailureCleanup=await closePlugin().catch(()=>null);
    return {passed:false,checks,observations,phase,error:"FixtureScenarioFailure"};
  }
}
