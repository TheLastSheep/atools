import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { createPanelWindowEvidence, type PanelWindowMode } from "./nativePanelWindowEvidence";
import { measureNativePanelEscape } from "./nativePanelEscapeMeasurement";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";

function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T> {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error("Native IPC deadline: "+command)),4000);
    rawInvoke<T>(command,args).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});
  });
}

type FrameState = { title:string;text:string;results:Array<{label:string;value:string}>;tree:string;errors:string[];noTauri:boolean;sourceOpaque:boolean;moduleEntry:boolean;styles:number;bodyWidth:number;viewportWidth:number;documentHasFocus:boolean;visibilityState:string;activeElementTag:string };
type RuntimeState = { sessions:number;openings:number;pending:number;transport:boolean;hostSessions:number;hostIntents:number;hostInvocations:number;hostTransport:boolean;resourceLeases:number;dataSessions:number;dataIntents:number;dataInvocations:number;dataPreparations:number;dataTransport:boolean;pathRuntimeAvailable:boolean;activePathSnapshots:number;activePathIntents:number;activePathPreparations:number;pathSnapshotBytes:number;
  dialogSessions:number;dialogIntents:number;dialogInvocations:number;dialogPreparations:number;nativeDialogs:number;dialogTransport:boolean };
const dataDrained = (state: RuntimeState) => state.dataSessions === 0 && state.dataIntents === 0 && state.dataInvocations === 0 && state.dataPreparations === 0 && !state.dataTransport;
const pathsDrained = (state: RuntimeState) => state.pathRuntimeAvailable === true && state.activePathSnapshots === 0
  && state.activePathIntents === 0 && state.activePathPreparations === 0 && state.pathSnapshotBytes === 0;
const dialogsDrained = (state: RuntimeState) => state.dialogSessions === 0 && state.dialogIntents === 0 && state.dialogInvocations === 0
  && state.dialogPreparations === 0 && state.nativeDialogs === 0 && state.dialogTransport === false;
type PerfSnapshot = { scope:string;pid:number;elapsedSinceSmokeStartMs:number;rssBytes:number;cpuPercentSincePreviousSample:number|null;cpuIntervalMs:number|null;excludes:string[] };
type CatalogDataset = {kind:string;syntheticPlugins:number;syntheticFeatures:number;originalPlugins:number;originalFeatures:number;totalFeatures:number;groups:Array<{pluginId:string;query:string;featureCount:number;originalQueryMatches:number;expectedQueryResults:number}>;scope:string};
export type NativeSearchSample = {query:string;featureId:string;pluginId:string;elapsedMs:number;resultCount:number;renderedRows:number};
const pause = (ms=25) => new Promise(resolve => setTimeout(resolve,ms));
const checks: Record<string,boolean> = {};
const observations: Record<string,unknown> = {};
let windowEvidence: ReturnType<typeof createPanelWindowEvidence> | undefined;
let capabilities: Record<string,{node:string;data?:string;dialogOpen?:string;dialogSave?:string}> = {};
const NODE_SCOPES=["file_read","file_write","network","shell","clipboard_read","clipboard_write","screenshot","browser_context","plugin_data","system_settings"];
function check(value:unknown,message:string):asserts value { if (!value) throw Error(message); checks[message]=true; }
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>> {
  const deadline=performance.now()+10000;
  while(performance.now()<deadline) {const value=await read();if(value)return value as NonNullable<T>;await pause();}
  throw Error(message);
}
function searchInput() { return document.querySelector<HTMLInputElement>('input[aria-label="搜索命令"]') || document.querySelector<HTMLInputElement>(".search-input"); }
function dialog() {return document.querySelector<HTMLElement>("[data-permission-dialog]");}
function search(query:string) {
  const input=searchInput();check(input,"Production search input mounted");
  input.focus();
  input.value=query;
  input.dispatchEvent(new Event("input",{bubbles:true}));
}
function selectedFeature(featureId:string) {
  return [...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')]
    .find(node=>node.dataset.pluginId===featureId);
}
export async function measureSearch(query:string,featureId:string,expectedCount?:number):Promise<NativeSearchSample> {
  check(!selectedFeature(featureId),"Search target is not stale from the previous query");
  await windowEvidence?.before("search-"+featureId);
  const started=performance.now();
  const result=new Promise<HTMLElement>((resolve,reject)=>{
    const observer=new MutationObserver(()=>{
      const option=selectedFeature(featureId);
      if(option && (expectedCount===undefined || option.getAttribute("aria-setsize")===String(expectedCount))){clearTimeout(deadline);observer.disconnect();resolve(option);}
    });
    const deadline=window.setTimeout(()=>{
      observer.disconnect();reject(Error("Timed search result missing: "+featureId+" for "+query));
    },10000);
    observer.observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:["aria-selected","data-plugin-id","aria-setsize"]});
    const alreadySelected=selectedFeature(featureId);
    if(alreadySelected && (expectedCount===undefined || alreadySelected.getAttribute("aria-setsize")===String(expectedCount))){clearTimeout(deadline);observer.disconnect();resolve(alreadySelected);}
  });
  search(query);
  const option=await result;
  const resultCount=Number(option.getAttribute("aria-setsize"));
  const rows=[...document.querySelectorAll<HTMLElement>('#launcher-results [role="option"]')];
  check(rows.length>0 && rows.length<=32,"Native launcher search keeps at most 32 rendered result rows");
  if(expectedCount!==undefined) {
    check(resultCount===expectedCount,"Search ARIA matches the exact synthetic plus original typed result count");
    check(rows.every(row=>row.dataset.pluginId===featureId),"Synthetic query renders only its newly selected owner");
  }
  const elapsedMs=performance.now()-started;
  await windowEvidence?.after("search-"+featureId);
  return {query,featureId,pluginId:featureId,elapsedMs,resultCount,renderedRows:rows.length};
}
const resourceSamples:Array<{stage:string;runtime:RuntimeState;host:PerfSnapshot}> = [];
const idleWindows:Array<{stage:string;runtime:RuntimeState;host:Record<string,unknown>}> = [];
async function recordResources(stage:string,frame?:FrameState) {
  await windowEvidence?.after(stage);
  await invoke("native_panel_perf_phase",{phase:"sample-"+stage});
  const host=await invoke<PerfSnapshot>("native_panel_perf_snapshot");
  const runtime=await invoke<RuntimeState>("native_panel_runtime_state");
  check(pathsDrained(runtime), "Original panel fixtures and launcher retain no unused path metadata snapshot or preparation");
  const active=/-(?:re)?opened$/.test(stage);
  if (active && stage.startsWith("file-tree")) check(runtime.dataSessions === 1 && runtime.dataTransport && runtime.dataIntents === 0 && runtime.dataPreparations === 0,
    "Original file-tree theme storage owns one approved data session only while open");
  else check(dataDrained(runtime), "Launcher, closed panels and conversion fixture own no plugin data session or listener");
  if (active && stage.startsWith("file-tree")) check(runtime.dialogSessions === 2 && runtime.dialogTransport
    && runtime.dialogIntents === 0 && runtime.dialogInvocations === 0 && runtime.dialogPreparations === 0 && runtime.nativeDialogs === 0,
    "Original file-tree retains two approved dialog directions without opening an unused native picker");
  else check(dialogsDrained(runtime), "Launcher, closed panels and conversion fixture own no dialog session or listener");
  if(active)check(frame && typeof frame.moduleEntry==="boolean","Active resource samples have an actual frame module-entry observation");
  check(runtime.resourceLeases===(frame?.moduleEntry ? 1 : 0),"Only active native module entries own one resource lease; launcher and closed frames own none");
  if(active)check(runtime.sessions>0 && runtime.transport,"Opened plugin owns a Node session and loopback transport");
  if(stage.includes("closed"))check(runtime.sessions===0 && !runtime.transport
    && runtime.hostSessions===0 && runtime.hostIntents===0 && runtime.hostInvocations===0 && !runtime.hostTransport && runtime.resourceLeases===0,
  "Closed plugin leaves no owned Node or host-clipboard listener state");
  resourceSamples.push({stage,runtime,host});
}
async function recordQuietIdleWindow(stage:string) {
  await windowEvidence?.before("quiet-"+stage);
  await invoke("native_panel_perf_phase",{phase:"quiet-idle-"+stage});
  const host=await invoke<Record<string,unknown>>("native_panel_perf_quiet_window");
  await windowEvidence?.after("quiet-"+stage);
  const runtime=await invoke<RuntimeState>("native_panel_runtime_state");
  check(pathsDrained(runtime), "Quiet launcher retains no path metadata snapshot, intent or preparation");
  check(dataDrained(runtime), "Quiet launcher owns no plugin data session, preparation or listener");
  check(dialogsDrained(runtime), "Quiet launcher owns no dialog session, preparation, native picker or listener");
  check(runtime.sessions===0 && runtime.openings===0 && runtime.pending===0 && !runtime.transport
    && runtime.hostSessions===0 && runtime.hostIntents===0 && runtime.hostInvocations===0 && !runtime.hostTransport && runtime.resourceLeases===0,
  "Quiet idle window has no Node or host-clipboard listener state");
  idleWindows.push({stage,runtime,host});
}
async function returnToSearch(action:()=>void,actionName:string) {
  await windowEvidence?.before("return-"+actionName);
  const started=performance.now();action();
  await until(()=>!document.querySelector(".plugin-panel") && document.activeElement===searchInput(),"Search did not regain focus after "+actionName);
  const elapsedMs=performance.now()-started;
  await windowEvidence?.after("return-"+actionName);
  await clean();
  (observations.performance as {focusRestore:Array<{action:string;elapsedMs:number}>}).focusRestore.push({action:actionName,elapsedMs});
}
async function open(query:string,pluginId="char-transform") {
  await windowEvidence?.before("open-"+pluginId);
  const displayName=pluginId==="char-transform"?"字符转换":"目录树生成器";
  const featureName=pluginId==="char-transform"?"字符格式转换工具":"生成目录树";
  search(query);
  const option=await until(()=>[...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')].find(node=>node.dataset.pluginId===pluginId),"Real selected search result missing: "+query);
  check(option.getAttribute("aria-selected")==="true","Search result virtually selected");
  check(option.querySelector(".result-title")?.textContent===featureName,"Original feature is displayed with its actual readable manifest feature name");
  searchInput()!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
  await until(()=>document.querySelector(".plugin-panel"),"Actual production PluginPanel missing");
  await until(()=>document.querySelector(".plugin-title")?.textContent===displayName,"Plugin title did not use actual Chinese manifest title");
  checks[pluginId+" Chinese manifest title visible"]=true;
  if (pluginId === "file-tree") {
    await until(() => dialog()?.querySelector("h2")?.textContent?.includes("请求访问自己的数据"), "Original tree theme storage did not request real data authorization");
    const beforeData = await invoke<RuntimeState>("native_panel_runtime_state");
    check(beforeData.sessions === 0 && beforeData.dataSessions === 0 && !beforeData.dataTransport && beforeData.pending === 1,
      "Tree data approval precedes its original page and Node startup");
    check(capabilities[pluginId]?.data,"Native fixture advertises the actual file-tree data capability");
    await approveNativePanelPermission({title:displayName+" 请求访问自己的数据",tool:capabilities[pluginId].data!,scopes:["plugin_data"],
      label:pluginId+" data",invoke,until,check});
    for (const [title, key, scope] of [["请求打开文件选择窗口","dialogOpen","file_read"],
      ["请求选择文件保存位置","dialogSave","file_write"]] as const) {
      check(capabilities[pluginId][key],"Fixture advertises the exact dialog capability: "+key);
      await approveNativePanelPermission({title:displayName+" "+title,tool:capabilities[pluginId][key]!,scopes:[scope],
        label:pluginId+" "+key,invoke,until,check});
    }
  }
  await until(()=>dialog()?.querySelector("h2")?.textContent?.trim()===displayName+" 请求访问本机","Exact Node authorization did not reach actual dialog");
  checks[pluginId+" authorization identifies actual plugin"]=true;
  const before=await invoke<RuntimeState>("native_panel_runtime_state");
  check(before.sessions===0 && before.pending===1,"No Node session before user permission");
  check(capabilities[pluginId]?.node,"Native fixture advertises the actual Node capability");
  await approveNativePanelPermission({title:displayName+" 请求访问本机",tool:capabilities[pluginId].node,scopes:NODE_SCOPES,
    label:pluginId+" Node",invoke,until,check});
  await until(()=>!dialog(),"Permission prompt did not complete");
  const frame=await until(()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),"Plugin iframe missing after authorization");
  check(frame.getAttribute("sandbox")==="allow-scripts allow-popups","Actual production iframe sandbox preserved");
  check(Boolean(frame.getAttribute("srcdoc")) && !frame.getAttribute("src"),"Original files loaded through production srcdoc preparation");
  return frame;
}
async function clean() {
  await until(async()=>{
    const state=await invoke<RuntimeState>("native_panel_runtime_state");
    return dataDrained(state) && dialogsDrained(state) && state.sessions===0 && state.openings===0 && state.pending===0 && !state.transport
      && state.hostSessions===0 && state.hostIntents===0 && state.hostInvocations===0 && !state.hostTransport && state.resourceLeases===0;
  },"Plugin return left Node or permission resources");
  check(!document.querySelector(".plugin-panel"),"Panel unmounted after return");
  check(document.activeElement===searchInput(),"Search focus restored after return");
}
export async function runNativePluginPanelScenario() {
  let token="",sequence=0;
  const frameRequest=(operation:string,args:Record<string,unknown>={})=>new Promise<FrameState>((resolve,reject)=>{
    const frame=document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]');
    if(!frame?.contentWindow){reject(Error("No active production iframe"));return;}
    const source=frame.contentWindow,id=++sequence;
    const timeout=setTimeout(()=>{window.removeEventListener("message",receive);reject(Error("Frame probe timeout: "+operation));},3000);
    function receive(event:MessageEvent) {
      if(event.source!==source || event.data?.token!==token || event.data?.id!==id || event.data?.kind!=="atools-panel-probe-result")return;
      clearTimeout(timeout);window.removeEventListener("message",receive);
      if(event.data.error)reject(Error(event.data.error));else resolve(event.data.state);
    }
    window.addEventListener("message",receive);source.postMessage({kind:"atools-panel-probe",token,id,operation,...args},"*");
  });
  // The iframe element precedes its all-frames initialization listener. Read-only
  // readiness probes can retry a lost first message; business actions never retry.
  const readyState=()=>frameRequest("state").catch(error=>{
    if(error instanceof Error && error.message==="Frame probe timeout: state")return null;
    throw error;
  });
  try {
    const fixture=await invoke<{token:string;treePath:string;dataset:CatalogDataset;windowMode:PanelWindowMode;capabilities:typeof capabilities}>("native_panel_fixture");token=fixture.token;
    capabilities=fixture.capabilities;
    check(fixture.windowMode==="observe" || fixture.windowMode==="foreground","Native fixture reports an explicit observed or foreground window mode");
    windowEvidence=createPanelWindowEvidence({mode:fixture.windowMode,invoke,until,check,observations});
    check(fixture.dataset.syntheticFeatures===1200 && fixture.dataset.syntheticPlugins===2
      && fixture.dataset.originalPlugins===2 && fixture.dataset.groups.length===2
      && fixture.dataset.groups.every(group=>group.featureCount===600 && Number.isInteger(group.originalQueryMatches)
        && group.originalQueryMatches>=0 && group.expectedQueryResults===600+group.originalQueryMatches),"Native fixture identifies 1200 synthetic metadata features and two original business plugins");
    await invoke("native_panel_perf_phase",{phase:"scenario-started"});
    observations.fixturePage={visibility:document.visibilityState,hasFocus:document.hasFocus(),backgroundThrottling:"disabled"};
    await until(searchInput,"Production launcher did not mount");
    await windowEvidence.before("launcher-ready");
    await invoke("native_panel_perf_phase",{phase:"launcher-input-mounted"});
    const launcherReady=await invoke<PerfSnapshot>("native_panel_perf_snapshot");
    await invoke("native_panel_perf_phase",{phase:"host-snapshot-ready"});
    const firstSearch=await measureSearch("字符转换","char-transform");
    await invoke("native_panel_perf_phase",{phase:"cold-search-rendered"});
    observations.performance={
      windowMode:fixture.windowMode,
      dataset:fixture.dataset,
      launcherReadyMs:launcherReady.elapsedSinceSmokeStartMs,
      firstSearchAfterLauncherReady:firstSearch,
      warmSearch:[] as NativeSearchSample[],
      focusRestore:[] as Array<{action:string;elapsedMs:number}>,
      resources:resourceSamples,
      quietIdleWindows:idleWindows,
      resourceScope:launcherReady.scope,
      resourceExcludes:launcherReady.excludes,
    };
    await recordResources("launcher-search-ready-before-plugins");
    const idle=await invoke<RuntimeState>("native_panel_runtime_state");
    check(idle.sessions===0 && !idle.transport,"Launcher idle has no Node session or listener");
    check(dataDrained(idle), "Launcher metadata creates no plugin data preparation, session or listener");
    check(idle.hostSessions===0 && idle.hostIntents===0 && !idle.hostTransport,"Launcher metadata has no clipboard permission session or listener");
    await recordQuietIdleWindow("launcher-ready");
    await open("字符转换");
    const charFrame=await until(async()=>{const state=await readyState();return state?.title==="字符转换" && state.results.length===13 ? state : null;},"Original released char-transform UI did not initialize");
    await recordResources("char-transform-opened",charFrame);
    const transformed=await frameRequest("input",{selector:"textarea.input-area",value:"abc"});
    check(transformed.results.some(row=>row.label.includes("MD5") && row.value==="900150983cd24fb0d6963f7d28e17f72"),"Original UI renders correct MD5 result");
    check(transformed.results.some(row=>row.label.includes("Base64 编码") && row.value==="YWJj"),"Original UI renders correct Base64 result");
    check(transformed.noTauri,"Sandbox does not expose Tauri internals");
    check(transformed.sourceOpaque,"Production plugin retains opaque origin");
    check(transformed.styles>0,"Original plugin stylesheet loaded");
    check(transformed.errors.length===0,"Original char-transform UI has no uncaught errors");
    observations.charTransform={results:transformed.results.length,styles:transformed.styles,errors:transformed.errors};
    await returnToSearch(()=>document.querySelector<HTMLButtonElement>(".back-btn")!.click(),"back-button");
    await recordResources("char-transform-closed");
    const warmSearch=(observations.performance as {warmSearch:NativeSearchSample[]}).warmSearch;
    for(let index=0;index<20;index++) {
      const group=fixture.dataset.groups[index%fixture.dataset.groups.length];
      warmSearch.push(await measureSearch(group.query,group.pluginId,group.expectedQueryResults));
    }
    await recordResources("catalog-synthetic-warm");
    await open("字符转换");
    const reopenedFrame=await until(async()=>{const state=await readyState();return state?.results.length===13 ? state : null;},"Original UI failed to reopen");
    await recordResources("char-transform-reopened",reopenedFrame);
    await windowEvidence.before("iframe-escape");
    const escapeElapsed=await measureNativePanelEscape({token,mode:fixture.windowMode,request:frameRequest,until,input:searchInput,
      observations:observations.performance as Record<string,unknown>});
    await windowEvidence.after("iframe-escape");
    await clean();
    (observations.performance as {focusRestore:Array<{action:string;elapsedMs:number}>}).focusRestore.push({action:"iframe-escape-probe",elapsedMs:escapeElapsed});
    await recordResources("char-transform-escape-closed");
    checks.iframeEscapeReturnsThroughProductionApp=true;
    await open("目录树","file-tree");
    const treeFrame=await until(async()=>{const state=await readyState();return state?.title==="目录树生成器" && state.tree.includes("请选择文件夹") ? state : null;},"Original released file-tree UI did not initialize");
    await recordResources("file-tree-opened",treeFrame);
    const tree=await frameRequest("files-enter",{path:fixture.treePath});
    check(tree.tree.includes("readme.txt") && tree.tree.includes("ignored.log") && tree.tree.includes("index.ts"),"Original file-enter UI renders real temporary directory");
    await frameRequest("input",{selector:"#ignorePatterns",value:"*.log"});
    const filtered=await frameRequest("click",{selector:"#updateIgnore"});
    check(filtered.tree.includes("readme.txt") && !filtered.tree.includes("ignored.log"),"Original ignore-field button filters directory UI");
    check(filtered.errors.length===0,"Original file-tree UI has no uncaught errors");
    observations.fileTree={tree:filtered.tree,errors:filtered.errors,styles:filtered.styles};
    await returnToSearch(()=>document.querySelector<HTMLButtonElement>(".back-btn")!.click(),"back-button");
    await recordResources("file-tree-closed-final");
    await recordQuietIdleWindow("final-close");
    return {passed:true,checks,observations};
  } catch(error) {
    let frame;
    try{frame=await frameRequest("state");}catch{}
    return {passed:false,checks,observations,error:String(error instanceof Error?error.message:error),frame,hostText:document.body.innerText.slice(0,3000)};
  }
}
