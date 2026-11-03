import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error("Native mutation IPC deadline: "+command)),8000);
    rawInvoke<T>(command,args).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}
const pause=(ms=40)=>new Promise(resolve=>setTimeout(resolve,ms));
const checks:Record<string,boolean>={};
const observations:Record<string,unknown>={};
function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);checks[message]=true;}
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>> {
  const deadline=performance.now()+10000;
  while(performance.now()<deadline){const value=await read();if(value)return value as NonNullable<T>;await pause();}
  throw Error(message);
}
type Fixture={token:string;v1Path:string;v2Path:string;unrelatedPath:string;malformedPath:string;pluginId:string;featureCode:string};
type RuntimeState={legacySessions:number;openings:number;legacyTransport:boolean;hostSessions:number;hostIntents:number;hostInvocations:number;hostTransport:boolean;pluginEnabled:boolean;pluginVersion:string|null;installedPreload:string|null;oldPreloadPresent:boolean;v2PreloadPresent:boolean;taskRuns:number;allTaskRunsTerminal:boolean};
type PendingRequest={id:string;run_id?:string;runId?:string;client_id?:string;clientId?:string;tool_name?:string;toolName?:string};
type Grant={client_id?:string;clientId?:string;tool_name?:string;toolName?:string};
type TaskRun={id:string;status:string;output?:unknown;capability_id?:string;capabilityId?:string};
function searchInput(){return document.querySelector<HTMLInputElement>('input[aria-label="搜索命令"]')||document.querySelector<HTMLInputElement>(".search-input");}
function search(text:string){const input=searchInput();check(input,"Production launcher search input mounted");input!.focus();input!.value=text;input!.dispatchEvent(new Event("input",{bubbles:true}));}
function selected(id:string){return [...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')].find(node=>node.textContent?.includes(id));}
async function selectAndOpen(query:string,id:string){
  search(query);
  await until(()=>selected(id),"Production search did not select synthetic feature: "+query);
  searchInput()!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
  await until(()=>document.querySelector(".plugin-panel"),"Actual PluginPanel did not open");
  await until(()=>document.querySelector(".plugin-title")?.textContent?.includes("生命周期探针"),"Synthetic manifest title missing from PluginPanel");
  const dialog=await until(()=>document.querySelector<HTMLElement>("[data-permission-dialog]"),"Node authorization prompt was not shown");
  check(dialog.querySelector("h2")?.textContent?.includes("生命周期探针"),"Node authorization identifies the synthetic plugin");
  const allow=[...dialog.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.trim()==="允许一次");
  check(allow,"Actual one-time Node authorization control exists");allow!.click();
  await until(()=>!document.querySelector("[data-permission-dialog]"),"Node authorization did not finish");
  const frame=await until(()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),"Synthetic plugin iframe did not load");
  check(frame.getAttribute("sandbox")==="allow-scripts allow-popups","Production iframe sandbox applies to synthetic plugin");
}
async function state(){return invoke<RuntimeState>("native_mutation_state");}
async function waitSearchFocus(){await until(()=>!document.querySelector(".plugin-panel")&&document.activeElement===searchInput(),"Mutation event did not close panel and restore launcher focus");}
async function callTool(name:string){return invoke<Record<string,unknown>>("call_agent_tool",{name,arguments:{},clientId:"atools-ui",confirmed:false,runId:null});}
async function latestRun(capabilityId:string){return invoke<Record<string,unknown>|null>("native_mutation_latest_run",{capabilityId});}
async function pendingRequests(){return invoke<PendingRequest[]>("list_pending_agent_requests");}
async function grants(){return invoke<Grant[]>("list_agent_tool_grants");}
function requestClient(request:PendingRequest){return request.client_id??request.clientId??"";}
function requestTool(request:PendingRequest){return request.tool_name??request.toolName??"";}
function requestRun(request:PendingRequest){return request.run_id??request.runId??"";}
function grantClient(grant:Grant){return grant.client_id??grant.clientId??"";}
function grantTool(grant:Grant){return grant.tool_name??grant.toolName??"";}
async function taskRun(id:string){return invoke<TaskRun|null>("get_task_run",{id});}
async function taskRuns(){return invoke<TaskRun[]>("list_task_runs",{limit:1000});}
function decodedOutput(run:TaskRun|null):Record<string,unknown>|null {
  if(!run?.output)return null;
  if(typeof run.output==="string"){try{return JSON.parse(run.output) as Record<string,unknown>;}catch{return null;}}
  return typeof run.output==="object"&&!Array.isArray(run.output)?run.output as Record<string,unknown>:null;
}
async function requestEntry(clientId:string,toolName:string){
  return until(async()=>{
    const rows=await pendingRequests();
    return rows.find(item=>requestClient(item)===clientId&&requestTool(item)===toolName);
  },`Pending public approval missing for ${clientId}/${toolName}`);
}
function waitForVersion(){
  return new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>{window.removeEventListener("message",onMessage);reject(Error("Synthetic version marker timeout"));},8000);
    function onMessage(event:MessageEvent){const frame=document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');if(!frame?.contentWindow||event.source!==frame.contentWindow||event.data?.kind!=="mutation-version")return;clearTimeout(timer);window.removeEventListener("message",onMessage);resolve(String(event.data.version));}
    window.addEventListener("message",onMessage);
  });
}

export async function runNativePluginMutationScenario(){
  const events:Array<{pluginId:string;reason:string}>=[];let unlisten:(()=>void)|undefined;
  try{
    const fixture=await invoke<Fixture>("native_mutation_fixture");
    unlisten=await listen<{pluginId:string;reason:string}>("plugin-code-changed",event=>events.push(event.payload));
    await until(searchInput,"Production launcher did not mount");
    // Use the actual import command for the initial synthetic source, and the real
    // install command for the unrelated package. Both are fixture-owned paths.
    const imported=await invoke<{imported:string[];failed:unknown[];skipped:unknown[]}>("import_ztools_plugins",{paths:[fixture.v1Path],overwrite:true});
    check(imported.imported.includes(fixture.pluginId)&&imported.failed.length===0,"Actual importer installs synthetic v1 package");
    await invoke("install_plugin",{path:fixture.unrelatedPath});
    await invoke("set_agent_tool_enabled",{name:"plugin_mutation_probe_probe",enabled:true});
    await invoke("set_agent_tool_enabled",{name:"plugin_mutation_unrelated_probe",enabled:true});
    await invoke("grant_agent_tool",{clientId:"atools-ui",toolName:"plugin_mutation_probe_probe"});
    await invoke("grant_agent_tool",{clientId:"atools-ui",toolName:"plugin_mutation_unrelated_probe"});
    const before=await callTool("plugin_mutation_probe_probe");
    check(before.version==="v1","Audited Agent tool resolves synthetic v1 output");
    const unrelated=await callTool("plugin_mutation_unrelated_probe");
    check(unrelated.version==="unrelated","Unrelated synthetic plugin remains callable");
    const beforeState=await state();
    check(beforeState.allTaskRunsTerminal,"Agent calls have terminal TaskRun records before update");
    observations.agentV1={version:before.version,runId:before.runId,status:before.status};
    observations.unrelatedBefore={version:unrelated.version,runId:unrelated.runId,status:unrelated.status};

    await selectAndOpen("lifecycle probe","生命周期探针");
    const active=await until(async()=>{const value=await state();return value.legacySessions>0&&value.legacyTransport?value:null;},"Active synthetic UI did not own a real legacy Node session");
    check(active.hostSessions===0&&active.hostIntents===0&&!active.hostTransport,"Synthetic journey starts without host clipboard session/listener");
    observations.activeBeforeUpdate={legacySessions:active.legacySessions,legacyTransport:active.legacyTransport};

    const pendingRequest=await rawInvoke("call_agent_tool",{name:"plugin_mutation_probe_probe",arguments:{},clientId:"mutation-review-agent",confirmed:false,runId:null})
      .then(()=>({rejected:false,error:""}),error=>({rejected:true,error:String(error)}));
    check(pendingRequest.rejected,"Unapproved public plugin tool call pauses for user approval");
    const pending=await requestEntry("mutation-review-agent","plugin_mutation_probe_probe");
    const pendingRunId=requestRun(pending);
    check(Boolean(pendingRunId),"Pending plugin-tool approval is bound to its TaskRun");
    const pendingRun=await until(async()=>{
      const run=await taskRun(pendingRunId);
      return run&&run.status==="awaiting_permission"?run:null;
    },"Pending public tool approval did not persist an awaiting-permission TaskRun");
    const pendingDialog=await until(()=>document.querySelector<HTMLElement>("[data-permission-dialog]"),"External agent approval did not reach the actual permission UI");
    check(pendingDialog.querySelector("h2")?.textContent?.includes("plugin_mutation_probe_probe"),"Pre-update permission dialog identifies the pending public plugin tool");
    observations.pendingBeforeUpdate={requestId:pending.id,runId:pendingRunId,status:pendingRun.status,clientId:requestClient(pending)};

    await invoke("native_mutation_hold_write_gate",{pluginId:fixture.pluginId});
    let cancelledQueueRun:TaskRun|undefined;
    try {
      cancelledQueueRun=await invoke<TaskRun>("start_agent_tool",{name:"plugin_mutation_probe_probe",arguments:{},clientId:"atools-ui",confirmed:true,retryOf:null});
      await pause(120);
      const waitingRun=await taskRun(cancelledQueueRun.id);
      check(waitingRun?.status==="created","Background public plugin TaskRun stays Created while the fixture holds its execution gate");
      const cancelled=await invoke<TaskRun>("cancel_task_run",{id:cancelledQueueRun.id});
      check(cancelled.status==="cancelled","Queued background plugin TaskRun can be cancelled before the gate opens");
    } finally {
      check(await invoke<boolean>("native_mutation_release_write_gate",{pluginId:fixture.pluginId}),"Cancellation fixture releases the plugin write gate");
    }
    await pause(120);
    const cancelledQueueTerminal=await taskRun(cancelledQueueRun!.id);
    check(cancelledQueueTerminal?.status==="cancelled","Cancelled queued task remains terminal when the executor resumes");
    check(!(await pendingRequests()).some(item=>requestRun(item)===cancelledQueueRun!.id),"Cancelled queued task cannot create a late approval request");
    check(decodedOutput(cancelledQueueTerminal)?.version===undefined,"Cancelled queued task produces no plugin output");
    observations.queuedCancellation={runId:cancelledQueueRun!.id,status:cancelledQueueTerminal?.status,outputProduced:decodedOutput(cancelledQueueTerminal)?.version!==undefined};

    await invoke("native_mutation_hold_write_gate",{pluginId:fixture.pluginId});
    const updatePromise=invoke("update_plugin_from_path",{pluginId:fixture.pluginId,path:fixture.v2Path});
    try {
      const queuedMutation=await until(async()=>{
        const run=await latestRun("atools-ui.plugin.update");
        return run?.status==="running"?run:null;
      },"Actual same-version update did not enter its audited write-gate phase");
      observations.queuedMutation={runId:queuedMutation.id,status:queuedMutation.status};
      const queuedRun=await invoke<TaskRun>("start_agent_tool",{name:"plugin_mutation_probe_probe",arguments:{},clientId:"atools-ui",confirmed:true,retryOf:null});
      check(queuedRun.status==="created","Confirmed public plugin TaskRun is persisted as Created while the update owns the earlier write-gate queue position");
      const queuedWhileWriterPending=await taskRun(queuedRun.id);
      check(queuedWhileWriterPending?.status==="created","Queued confirmed TaskRun remains unclaimed behind the already-queued update");
      check(await invoke<boolean>("native_mutation_release_write_gate",{pluginId:fixture.pluginId}),"Fixture releases the plugin write gate after update and confirmed task have queued");
      await updatePromise;
      await until(async()=>{
        const run=await taskRun(queuedRun.id);
        return run&&["failed","cancelled"].includes(run.status)?run:null;
      },"Pre-update queued public TaskRun did not terminate after the update");
      const queuedTerminal=await taskRun(queuedRun.id);
      check(["failed","cancelled"].includes(String(queuedTerminal?.status)),"Pre-update queued task is rejected after v2 replacement");
      check(decodedOutput(queuedTerminal)?.version===undefined,"Pre-update queued task cannot execute v2 business code");
      check(!(await pendingRequests()).some(item=>requestRun(item)===queuedRun.id),"Stale queued task cannot create a late approval request after update");
      observations.queuedTask={runId:queuedRun.id,status:queuedTerminal?.status,outputProduced:decodedOutput(queuedTerminal)?.version!==undefined};
    } finally {
      // Also release on any fixture assertion/IPC error so the runner cannot strand the update.
      await invoke<boolean>("native_mutation_release_write_gate",{pluginId:fixture.pluginId}).catch(()=>false);
    }
    await waitSearchFocus();
    const mutationEventsBeforeReturn=events.filter(event=>event.pluginId===fixture.pluginId).map(event=>event.reason);
    check(mutationEventsBeforeReturn.includes("reset"),"Mutation reset event closes active panel before package replacement completes");
    await updatePromise;
    await until(async()=>{const value=await state();return value.pluginVersion==="1.0.0"&&value.v2PreloadPresent?value:null;},"Same-version v2 package was not installed");
    await pause(500);
    check(!document.querySelector(".plugin-panel"),"Mutation does not automatically reexecute or reopen the updated plugin");
    check(document.body.innerText.includes("插件已更新，请从搜索重新打开。"),"Update notice remains visible after active plugin closes");
    const afterUpdate=await state();
    check(afterUpdate.legacySessions===0&&!afterUpdate.legacyTransport,"Update closes old legacy Node process and listener");
    check(afterUpdate.hostSessions===0&&afterUpdate.hostIntents===0&&afterUpdate.hostInvocations===0&&!afterUpdate.hostTransport,"Update leaves no host runtime session/listener state");
    check(!afterUpdate.oldPreloadPresent&&afterUpdate.v2PreloadPresent&&afterUpdate.installedPreload==="preload-v2.cjs","Same-version replacement removes v1 preload and selects v2 preload bytes");
    check(!(await pendingRequests()).some(item=>item.id===pending.id),"Updating code removes its stale pending public approval");
    const cancelledPending=await taskRun(pendingRunId);
    check(cancelledPending?.status==="cancelled","Updating code terminally cancels the pending approval TaskRun");
    await until(()=>!document.querySelector("[data-permission-dialog]"),"Mutation did not dismiss the invalidated approval prompt");
    check(!document.querySelector("[data-permission-dialog]"),"Mutation removes the stale request from the actual permission UI");
    const grantsAfterMutation=await grants();
    check(!grantsAfterMutation.some(grant=>grantTool(grant)==="plugin_mutation_probe_probe"),"Mutation revokes persistent grants for the updated plugin tool");
    check(grantsAfterMutation.some(grant=>grantClient(grant)==="atools-ui"&&grantTool(grant)==="plugin_mutation_unrelated_probe"),"Mutation preserves the unrelated plugin grant");
    const staleResume=await rawInvoke("call_agent_tool",{name:"plugin_mutation_probe_probe",arguments:{},clientId:"mutation-review-agent",confirmed:true,runId:pendingRunId})
      .then(value=>({rejected:false,value}),error=>({rejected:true,error:String(error)}));
    check(staleResume.rejected,"Stale approval confirmation cannot resume the pre-update public tool request");
    check((await taskRun(pendingRunId))?.status==="cancelled","Stale confirmation leaves the old TaskRun cancelled");
    check(!(await pendingRequests()).some(item=>requestRun(item)===pendingRunId),"Stale confirmation does not recreate an approval request");
    observations.staleApproval={requestId:pending.id,runId:pendingRunId,status:(await taskRun(pendingRunId))?.status,rejected:staleResume.rejected};
    observations.afterUpdate={preload:afterUpdate.installedPreload,oldPreloadPresent:afterUpdate.oldPreloadPresent,v2PreloadPresent:afterUpdate.v2PreloadPresent,legacySessions:afterUpdate.legacySessions};
    check(events.some(event=>event.pluginId===fixture.pluginId&&event.reason==="updated"),"Completed update emits final lifecycle event");

    const freshRequest=await rawInvoke("call_agent_tool",{name:"plugin_mutation_probe_probe",arguments:{},clientId:"atools-ui",confirmed:false,runId:null})
      .then(()=>({rejected:false,error:""}),error=>({rejected:true,error:String(error)}));
    check(freshRequest.rejected,"Updated plugin tool requires fresh consent after its grant is revoked");
    const freshPending=await requestEntry("atools-ui","plugin_mutation_probe_probe");
    const freshRunId=requestRun(freshPending);
    const freshDialog=await until(()=>document.querySelector<HTMLElement>("[data-permission-dialog]"),"Fresh updated-tool request did not reach the real permission UI");
    check(freshDialog.querySelector("h2")?.textContent?.includes("plugin_mutation_probe_probe"),"Fresh consent dialog identifies the updated plugin tool");
    const freshAllow=[...freshDialog.querySelectorAll<HTMLButtonElement>("button")].find(button=>button.textContent?.trim()==="允许一次");
    check(freshAllow,"Fresh tool approval uses the actual one-time consent control");
    freshAllow!.click();
    const approvedRun=await until(async()=>{
      const run=await taskRun(freshRunId);
      return run&&run.status==="succeeded"?run:null;
    },"Fresh one-time approval did not execute the updated plugin tool");
    const after=decodedOutput(approvedRun);
    check(after?.version==="v2","Freshly approved public Agent tool executes updated v2 bytes");
    check(!(await pendingRequests()).some(item=>item.id===freshPending.id),"Successful one-time approval removes its pending request");
    const grantsAfterFreshApproval=await grants();
    check(!grantsAfterFreshApproval.some(grant=>grantTool(grant)==="plugin_mutation_probe_probe"),"Allow once does not recreate a persistent grant for the updated plugin");
    check(grantsAfterFreshApproval.some(grant=>grantClient(grant)==="atools-ui"&&grantTool(grant)==="plugin_mutation_unrelated_probe"),"Unrelated plugin grant remains after fresh one-time approval");
    check(after.version==="v2","Audited Agent Node preload sees v2 and not a cached v1 export");
    const unrelatedAfter=await callTool("plugin_mutation_unrelated_probe");
    check(unrelatedAfter.version==="unrelated","Updating one plugin leaves unrelated plugin callable");
    observations.agentV2={version:after.version,runId:after.runId,status:after.status};
    observations.unrelatedAfter={version:unrelatedAfter.version,runId:unrelatedAfter.runId,status:unrelatedAfter.status};

    const shownVersionPromise=waitForVersion();
    await selectAndOpen("lifecycle probe","生命周期探针");
    const shownVersion=await shownVersionPromise;
    check(shownVersion==="v2","Explicit reopen renders the updated plugin UI");
    const malformed=await rawInvoke("install_plugin",{path:fixture.malformedPath}).then(()=>({rejected:false}),error=>({rejected:true,error:String(error)}));
    check(malformed.rejected,"Malformed package is rejected by real install command");
    const malformedState=await state();
    check(malformedState.pluginEnabled&&malformedState.pluginVersion==="1.0.0","Malformed same-id package does not replace installed metadata");
    observations.malformedInstall={rejected:malformed.rejected};

    await invoke("toggle_plugin",{pluginId:fixture.pluginId,enabled:false});
    const disabled=await state();check(!disabled.pluginEnabled,"Actual toggle command disables the package");
    const knownFeatureRunIds=new Set((await taskRuns()).map(run=>run.id));
    const activation=await rawInvoke("activate_feature",{code:fixture.featureCode,payload:null}).then(()=>({rejected:false,error:""}),error=>({rejected:true,error:String(error)}));
    check(activation.rejected,"Actual Rust activate_feature rejects cached code for a disabled plugin");
    const newFeatureRuns=(await taskRuns()).filter(run=>!knownFeatureRunIds.has(run.id)&&(run.capabilityId??run.capability_id)===`plugin.feature.${fixture.featureCode}`);
    check(newFeatureRuns.length===1,"Disabled activation creates exactly one new feature TaskRun");
    const featureRun=newFeatureRuns[0]??null;
    observations.disabledActivation={rejected:activation.rejected,error:activation.error,taskRuns:newFeatureRuns};
    check(featureRun?.status==="failed","Disabled activation writes a terminal failed TaskRun");
    const knownToolRunIds=new Set((await taskRuns()).map(run=>run.id));
    const toolFailure=await rawInvoke("call_agent_tool",{name:"plugin_mutation_probe_probe",arguments:{},clientId:"atools-ui",confirmed:false,runId:null}).then(()=>({rejected:false}),error=>({rejected:true,error:String(error)}));
    check(toolFailure.rejected,"Actual audited Agent tool rejects disabled cached plugin code");
    const newDeniedRuns=(await taskRuns()).filter(run=>!knownToolRunIds.has(run.id)&&(run.capabilityId??run.capability_id)==="plugin_mutation_probe_probe");
    check(newDeniedRuns.length===1,"Disabled Agent-tool call creates exactly one new TaskRun");
    const deniedRun=newDeniedRuns[0]??null;
    check(deniedRun!==null&&["cancelled","failed"].includes(deniedRun.status),"Disabled Agent-tool rejection retains a terminal TaskRun");
    const unrelatedFinal=await callTool("plugin_mutation_unrelated_probe");
    check(unrelatedFinal.version==="unrelated","Unrelated plugin continues after the other plugin is disabled");
    observations.disabled={activationRun:featureRun?.status,agentRun:deniedRun?.status};

    await invoke("uninstall_plugin",{pluginId:fixture.pluginId});
    const end=await state();check(end.legacySessions===0&&!end.legacyTransport&&end.hostSessions===0&&!end.hostTransport,"Final close/uninstall leaves no plugin or host listeners");
    check(end.allTaskRunsTerminal,"All final mutation and Agent TaskRuns reach terminal state");
    const snapshot={...end,legacySessionsAtFinalClose:end.legacySessions,events:events.filter(event=>event.pluginId===fixture.pluginId).map(event=>event.reason)};
    observations.final=snapshot;
    return {passed:true,checks,observations,scope:{syntheticPackagesOnly:true,manifestVersionUnchanged:"1.0.0",noAutomaticExecutionAfterUpdate:true,
      agentToolConsent:"fixture enables/grants the two synthetic tools in temporary SQLite; opening the plugin still uses the actual one-time Node permission UI",
      environmentIsolation:"native runner supplied private HOME/XDG/TMP and pinned Node 22; no ambient variables passed through"}};
  }catch(error){
    const current=await state().catch(()=>null);
    return {passed:false,checks,observations,error:String(error instanceof Error?error.stack:error),runtimeState:current,hostText:document.body.innerText.slice(0,2500)};
  }finally{unlisten?.();}
}
