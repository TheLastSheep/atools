import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";

type Runtime = { sessions:number; openings:number; pending:number; transport:boolean; resourceLeases:number };
type Capability = {node:string;data?:string;dialogOpen?:string;dialogSave?:string};
type Fixture = { token:string; capabilities:Record<string,Capability>; nodePageOutputPath:string };
type Reply = { ready?:boolean; opaque?:boolean; noTauri?:boolean; nodeRequire?:boolean; fsWriteAvailable?:boolean;
  bufferAvailable?:boolean; processObserved?:boolean; nodeRuntimeAccess?:boolean; width?:number; height?:number; redAt1x1?:number[]; whiteAt1x2?:number[]; whiteAt2x1?:number[];
  blueAt1x3?:number[]; blueAt1x1?:number[]; redAt3x1?:number[]; blueAt4x1?:number[]; whiteAt3x1?:number[];
  hasNativeFilePath?:boolean; cleared?:boolean; encoded?:string; decoded?:string; errorClass?:boolean;
  dialogCount?:number; canceled?:boolean; revealCount?:number; successNotification?:boolean; revealMatched?:boolean };
const NODE_SCOPES=["file_read","file_write","network","shell","clipboard_read","clipboard_write","screenshot","browser_context","plugin_data","system_settings"];
const pause=(ms=30)=>new Promise(resolve=>setTimeout(resolve,ms));
const checks:Record<string,boolean>={}, observations:Record<string,unknown>={};
function check(value:unknown,label:string):asserts value { if(!value)throw Error(label);checks[label]=true; }
async function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>{
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Native page probe deadline: "+command)),5000);
    rawInvoke<T>(command,args).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>>{
  const end=performance.now()+12000;while(performance.now()<end){const value=await read();if(value)return value as NonNullable<T>;await pause();}throw Error(message);
}
const runtime=()=>invoke<Runtime>("native_panel_runtime_state");
const search=()=>document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]')||document.querySelector<HTMLInputElement>(".search-input");
async function approveImagePrerequisites(capability:Capability) {
  for(const [suffix,tool,scope] of [["请求访问自己的数据",capability.data,"plugin_data"],
    ["请求打开文件选择窗口",capability.dialogOpen,"file_read"],
    ["请求选择文件保存位置",capability.dialogSave,"file_write"]]) {
    check(!!tool,"Fixture supplies exact image UI prerequisite capability: "+scope);
    await approveNativePanelPermission({title:"Node 页面验收 A "+suffix,tool:tool!,
      scopes:[scope!],label:"image-ui-prerequisite-"+scope,invoke,until,check});
  }
  const current=await invoke<{sessions:number;nativeDialogs:number}>("native_panel_runtime_state");
  check(current.sessions===0&&current.nativeDialogs===0,"Image UI prerequisite grants start no Node process or operating-system picker");
}
function findFrame(){return document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');}
async function request(token:string,operation:string):Promise<Reply>{
  const source=findFrame()?.contentWindow;if(!source)throw Error("Opaque PluginPanel frame unavailable: "+operation);
  const id="node-page-"+crypto.randomUUID();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{window.removeEventListener("message",receive);reject(Error("Frame operation timed out: "+operation));},8000);
    function receive(event:MessageEvent){if(event.source!==source||event.origin!=="null"||event.data?.kind!=="atools-node-page-result"||event.data.token!==token||event.data.id!==id)return;
      clearTimeout(timer);window.removeEventListener("message",receive);if(event.data.error)reject(Error(String(event.data.error)));else resolve(event.data.result);}
    window.addEventListener("message",receive);source.postMessage({kind:"atools-node-page-probe",token,id,operation},"*");
  });
}
function typeSearch(query:string){const input=search();if(!input)throw Error("Production launcher input missing");input.focus();input.value=query;input.dispatchEvent(new Event("input",{bubbles:true}));return input;}
async function open(id:"file-tree"|"char-transform",query:string,tool:string,approveNode:boolean,prerequisites?:Capability){
  const input=typeSearch(query);
  await until(()=>document.querySelector(`[role="option"][aria-selected="true"][data-plugin-id="${id}"]`),"Generated package did not appear in actual App catalog");
  input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
  if(prerequisites)await approveImagePrerequisites(prerequisites);
  const title=id==="file-tree"?"Node 页面验收 A":"纯编码页面验收 B";
  if(approveNode){
    const dialog=()=>document.querySelector<HTMLElement>("[data-permission-dialog]");
    await until(()=>dialog()?.querySelector("h2")?.textContent?.trim()===title+" 请求访问本机","Exact Node permission did not appear");
    const pending=await invoke<Array<{tool_name:string;client_id:string;scopes:string[]}>>("list_pending_agent_requests");
    const scopes=(value:string[])=>[...value].sort().join("|");
    check(pending.length===1&&pending[0].tool_name===tool&&pending[0].client_id==="atools-ui"&&scopes(pending[0].scopes)===scopes(NODE_SCOPES),"Node prompt matches the exact legacy capability and all ten original scopes");
    const before=await runtime();check(before.sessions===0&&before.transport===false,"Node session is absent before explicit user authorization");
    await approveNativePanelPermission({title:title+" 请求访问本机",tool,scopes:NODE_SCOPES,label:id,invoke,until,check});
  }
  await until(()=>!document.querySelector("[data-permission-dialog]"),"Permission prompt did not close");
  const frame=await until(findFrame,"Production PluginPanel did not render");
  check(frame.getAttribute("sandbox")==="allow-scripts allow-popups"&&!!frame.srcdoc&&!frame.getAttribute("src"),"Package runs in actual default opaque PluginPanel");
  return frame;
}
async function denyNode(title:string,tool:string){
  const dialog=()=>document.querySelector<HTMLElement>("[data-permission-dialog]");
  await until(()=>dialog()?.querySelector("h2")?.textContent?.trim()===title+" 请求访问本机","Denied Node request missing");
  const pending=await invoke<Array<{tool_name:string;client_id:string;scopes:string[]}>>("list_pending_agent_requests");
  check(pending.length===1&&pending[0].tool_name===tool&&pending[0].client_id==="atools-ui"
    &&[...pending[0].scopes].sort().join("|")===[...NODE_SCOPES].sort().join("|"),"Denied request is the exact one-time Node capability");
  dialog()?.querySelector<HTMLButtonElement>("[data-permission-deny]")?.click();
  await until(async()=>!(await invoke<Array<{tool_name:string}>>("list_pending_agent_requests")).some(item=>item.tool_name===tool),"Node denial did not resolve");
}
async function closePanel(){
  document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')?.click();
  return until(async()=>{const state=await runtime();return !findFrame()&&state.sessions===0&&state.openings===0&&state.pending===0&&!state.transport&&state.resourceLeases===0?state:null;},"Closing the plugin left Node session or transport active");
}

export async function runNativePluginNodePageScenario(){
  let token="",phase="setup";
  try{
    check(location.href==="atools-panel://localhost/","Native fixture remains on its isolated fixed URL");
    const fixture=await invoke<Fixture>("native_panel_fixture");token=fixture.token;
    check(!!fixture.capabilities["file-tree"].node&&!!fixture.capabilities["file-tree"].data&&!!fixture.nodePageOutputPath,"Fixture provides reviewed Node/data capabilities and fixed private mock output path");
    const before=await runtime();check(before.sessions===0&&!before.transport&&before.pending===0,"Launcher starts without a Node sidecar or pending permission");
    const usage=await invoke<{usage:string;requiresNode:boolean;entryMode:string}>("plugin_legacy_node_usage",{pluginId:"file-tree"});
    check(usage.usage==="detected"&&usage.requiresNode===true&&usage.entryMode==="page","Read-only usage probe detects page-only Node in A before preparation");
    phase="deny-a";const deniedSearch=typeSearch("synthetic node page image stitch");
    await until(()=>document.querySelector('[role="option"][aria-selected="true"][data-plugin-id="file-tree"]'),"A search result missing for deny path");
    deniedSearch.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
    await approveImagePrerequisites(fixture.capabilities["file-tree"]);
    await until(()=>document.querySelector("[data-permission-dialog]"),"A did not request Node authorization before deny path");
    await denyNode("Node 页面验收 A",fixture.capabilities["file-tree"].node);
    const denied=await runtime(),missing=await invoke<{exists:boolean}>("native_panel_node_page_evidence");
    check(denied.sessions===0&&!denied.transport&&missing.exists===false,"Deny starts no Node session, transport or output file");
    await closePanel();

    phase="allow-a";await open("file-tree","synthetic node page image stitch",fixture.capabilities["file-tree"].node,true,fixture.capabilities["file-tree"]);
    const a=await request(token,"state");
    check(a.ready&&a.opaque&&a.noTauri&&a.nodeRequire&&a.fsWriteAvailable&&a.bufferAvailable&&a.processObserved,"A executes require, Buffer, process and fs through the authorized page-only Node bridge in an opaque frame");
    observations.nodeProcessObserved=a.processObserved===true;
    const cancel=await request(token,"save-cancel");
    check(cancel.dialogCount===1&&cancel.canceled&&cancel.revealCount===0,"Original saveImage cancel path returns without native picker, reveal or file write");
    let vertical=await request(token,"image-vertical");
    check(vertical.width===4&&vertical.height===6&&JSON.stringify(vertical.redAt1x1)==="[255,0,0,255]"
      &&JSON.stringify(vertical.whiteAt1x2)==="[255,255,255,255]"&&JSON.stringify(vertical.blueAt1x3)==="[0,0,255,255]","Original image UI vertical drop preserves 4x6 red/white/blue pixel layout");
    const horizontal=await request(token,"image-horizontal");
    check(horizontal.width===6&&horizontal.height===4&&JSON.stringify(horizontal.redAt1x1)==="[255,0,0,255]"
      &&JSON.stringify(horizontal.whiteAt3x1)==="[255,255,255,255]"&&JSON.stringify(horizontal.blueAt4x1)==="[0,0,255,255]","Original image UI horizontal layout preserves red/white/blue pixels");
    const reversed=await request(token,"image-reverse");
    check(reversed.width===6&&reversed.height===4&&JSON.stringify(reversed.blueAt1x1)==="[0,0,255,255]"
      &&JSON.stringify(reversed.whiteAt2x1)==="[255,255,255,255]"&&JSON.stringify(reversed.redAt3x1)==="[255,0,0,255]","Original reverse button swaps dropped images and preserves expected pixels");
    const cleared=await request(token,"image-clear");check(cleared.cleared,"Original clear button removes dropped files and restores empty preview");
    // Restore the original-order image pair for the actual saveImage function test.
    vertical=await request(token,"image-vertical");check(vertical.width===4&&vertical.height===6,"Original UI can accept a fresh dropped pair after clear");
    const saved=await request(token,"save-write");
    check(saved.dialogCount===2&&saved.successNotification&&saved.revealMatched,"Original saveImage calls the fixed mock save target and recording-only notification/reveal adapters");
    const image=await invoke<Record<string,unknown>>("native_panel_node_page_evidence");
    check(image.exists===true&&image.width===4&&image.height===6&&image.privatePathsAbsentFromTaskRuns===true,"Rust independently decodes Node-written PNG, checks dimensions/pixels/hash and confirms the fixed output path is absent from durable TaskRuns");
    observations.savedImage=image;
    await closePanel();

    phase="open-b-no-node";
    const codecUsage=await invoke<{usage:string;requiresNode:boolean;entryMode:string}>("plugin_legacy_node_usage",{pluginId:"char-transform"});
    check(codecUsage.requiresNode===false,"Pure codec package has no Node requirement in the read-only usage probe");
    await open("char-transform","synthetic node page codec tools",fixture.capabilities["char-transform"].node,false);
    const b=await until(async()=>{const state=await request(token,"codec-state");return state.ready?state:null;},"Original codec module did not initialize its actual operation choices");
    check(b.noTauri&&!b.nodeRuntimeAccess,"B opens in opaque PluginPanel without an actual Node session bridge");
    const codec=await request(token,"codec-roundtrip");check(codec.decoded==="ATools 编码✓"&&typeof codec.encoded==="string"&&codec.encoded.length>0,"Original Base64 codec UI encodes and decodes Unicode text");
    const invalid=await request(token,"codec-invalid");check(invalid.errorClass===true,"Original codec UI visibly rejects malformed Base64 input");
    const bRuntime=await runtime();check(bRuntime.sessions===0&&!bRuntime.transport&&bRuntime.pending===0,"Pure codec UI completes with zero Node session, transport or permission requests");
    await closePanel();
    return {passed:true,checks,observations,scope:{generatedSyntheticPackages:true,originalUiAssetsByteIdentical:true,nodePageA:true,codecB:true,
      originalPackageExport:false,osPickerOpened:false,clipboardActions:false,appleScriptUsed:false,externalNetworkRequested:false}};
  }catch(error){
    observations.failureRuntime=await runtime().catch(()=>null);await closePanel().catch(()=>{});
    return {passed:false,checks,observations,phase,error:String(error instanceof Error?error.name:"FixtureError")};
  }
}
