import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { approveNativePanelPermission } from "./nativePanelPermissionGate";
import { createPanelWindowEvidence } from "./nativePanelWindowEvidence";
type FrameState={title:string;tree:string;exportModalOpen:boolean;exporting:boolean;previewText:string;scale:string;errors:string[];
  consoleErrors:string[][];consoleErrorCount:number;consoleErrorObserverInstalled:boolean;
  noTauri:boolean;sourceOrigin:string;sourceOpaque:boolean;localCanvasLibrary:boolean};
type DialogRun={id:string;method:string;status:string;canceled:boolean;count:number;terminal:boolean};
type Evidence={readOnlyEvidence:boolean;privateMarkersAbsent:boolean;privateHomeGuard:boolean;
  selectionPrivacyVerified:boolean;
  privacyScan:{complete:boolean;truncated:boolean;queryLimitReached:boolean;matches:Array<{runId:string;capability:string;field:string;markers:Record<string,boolean>}>};
  dialogRequests:DialogRun[];selectionEvidence:Array<{method:string;canceled:boolean;count:number;acceptedPrivateTarget:boolean}>;
  runtime:Record<string,unknown>;png:{fileCount:number;pngSignature?:boolean;independentDecode?:boolean;boundedBytes?:boolean;actualBytes?:number;width?:number;height?:number}};
const NODE_SCOPES=["file_read","file_write","network","shell","clipboard_read","clipboard_write","screenshot","browser_context","plugin_data","system_settings"];
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>> {
  const deadline=performance.now()+130000;
  while(performance.now()<deadline){const value=await read();if(value)return value as NonNullable<T>;await pause();}
  throw Error(message);
}
function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>{return rawInvoke<T>(command,args);}
const runtime=()=>invoke<Record<string,number|boolean>>("native_panel_runtime_state");
const checkpoint=(stage:string)=>invoke("native_panel_dialog_checkpoint",{stage});
const evidence=()=>invoke<Evidence>("native_panel_dialog_evidence");
export function assertOriginalExportDidNotCatchError(frame: Pick<FrameState,"exporting"|"consoleErrors"|"consoleErrorCount">,before:number) {
  if(frame.exporting===false&&frame.consoleErrorCount>before) {
    const observed=frame.consoleErrors.slice(-Math.min(12,frame.consoleErrorCount-before));
    throw Error("Observed original export console.error after #confirmExport: "+JSON.stringify(observed));
  }
}
export function nativeDialogFrameOrigin(frame:HTMLIFrameElement,pageDocumentMode:boolean) {
  const sandbox=frame.getAttribute("sandbox"),src=frame.getAttribute("src")||"";
  if(!pageDocumentMode) {
    if(sandbox!=="allow-scripts allow-popups"||!frame.srcdoc||src)throw Error("Original file-tree runs in the actual opaque production iframe");
    return "null";
  }
  const match=src.match(/^(atools-page:\/\/[a-f0-9]{32}\.localhost)\/[a-f0-9]{32}\/bootstrap\.html$/);
  if(sandbox!=="allow-scripts allow-same-origin"||frame.srcdoc!==""||!match)
    throw Error("Original file-tree document mode requires its exact native bootstrap URL, isolated origin and empty srcdoc");
  return match[1];
}
export async function runNativePluginDialogScenario(){
  const checks:Record<string,boolean>={},observations:Record<string,unknown>={};
  function check(value:unknown,message:string):asserts value {if(!value)throw Error(message);checks[message]=true;}
  let token="",sequence=0,lastFrameState:FrameState|undefined,pageDocumentMode=false,expectedFrameOrigin="null";
  const request=(operation:string,selector?:string)=>new Promise<FrameState>((resolve,reject)=>{
    const frame=document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),source=frame?.contentWindow,id=++sequence;
    if(!source){reject(Error("Original dialog iframe missing"));return;}
    const deadline=setTimeout(()=>{window.removeEventListener("message",receive);reject(Error("Original UI operation did not finish: "+operation));},operation==="state"?3000:130000);
    function receive(event:MessageEvent){
      if(event.source!==source||(pageDocumentMode&&event.origin!==expectedFrameOrigin)
        ||event.data?.token!==token||event.data?.id!==id||event.data?.kind!=="atools-dialog-probe-result")return;
      clearTimeout(deadline);window.removeEventListener("message",receive);
      lastFrameState=event.data.state;
      if(event.data.error)reject(Error(event.data.error));else resolve(event.data.state);
    }
    window.addEventListener("message",receive);source.postMessage({kind:"atools-dialog-probe",token,id,operation,selector},pageDocumentMode?expectedFrameOrigin:"*");
  });
  async function completedDialog(count:number,method:string,canceled:boolean,exportErrorCountBefore?:number){
    const proof=await until(async()=>{
      const value=await evidence();
      if(method==="showSaveDialog"&&exportErrorCountBefore!==undefined&&value.dialogRequests.length<count
        &&value.runtime.nativeDialogs===0&&value.runtime.dialogInvocations===0) {
        let frame:FrameState;
        try {frame=await request("state");}
        catch(error) {
          if(error instanceof Error&&error.message==="Original UI operation did not finish: state")return null;
          throw error;
        }
        assertOriginalExportDidNotCatchError(frame,exportErrorCountBefore);
      }
      return value.dialogRequests.length===count && value.dialogRequests.every(run=>run.terminal)
        && value.runtime.dialogInvocations===0 && value.runtime.nativeDialogs===0 ? value : null;
    },"Real native dialog TaskRun did not complete");
    check(proof.privacyScan.complete,"All-TaskRun privacy scan covers every returned field without hitting query or scan limits");
    check(proof.readOnlyEvidence&&proof.selectionPrivacyVerified&&proof.privateHomeGuard,"Real dialog selections and endpoints stay out of all TaskRun fields; exact installation metadata remains independently diagnosed");
    check(proof.selectionEvidence.length===count,"Each single UI action returned through the actual native adapter exactly once");
    const selected=proof.selectionEvidence.at(-1)!;
    check(selected.method===method&&selected.canceled===canceled&&selected.count===(canceled?0:1)&&selected.acceptedPrivateTarget,
      "Actual native result matches reviewed cancellation or private selection: "+count);
    const matching=proof.dialogRequests.filter(run=>run.method===method&&run.canceled===canceled&&run.count===(canceled?0:1)&&run.status==="succeeded");
    check(matching.length===1,"Exactly one durable successful metadata TaskRun proves this native outcome: "+count);
    return proof;
  }
  try {
    const base=await invoke<{token:string;windowMode:"foreground"|"observe";pageDocumentMode:boolean}>("native_panel_fixture");token=base.token;
    check(typeof base.pageDocumentMode==="boolean","Native fixture reports its actual page document mode");
    pageDocumentMode=base.pageDocumentMode;
    const fixture=await invoke<{privateHomeGuard:boolean;treeDirectory:string;savePath:string;capabilities:Record<string,string>}>("native_panel_dialog_fixture");
    check(fixture.privateHomeGuard,"Dedicated runner checked private HOME ownership before original plugin execution");
    const windows=createPanelWindowEvidence({mode:base.windowMode,invoke,until,check,observations});
    const input=await until(()=>document.querySelector<HTMLInputElement>('input[data-atools-search-input="true"]'),"Real launcher input missing");
    await windows.before("dialog-launcher");await checkpoint("authorizing");
    input.focus();input.value="目录树";input.dispatchEvent(new Event("input",{bubbles:true}));
    await until(()=>document.querySelector('[role="option"][aria-selected="true"][data-plugin-id="file-tree"]'),"Original file-tree search result missing");
    input.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
    const grant=async(title:string,key:string,scopes:string[])=>approveNativePanelPermission({title:"目录树生成器 "+title,
      tool:fixture.capabilities[key],scopes,label:key,invoke,until,check});
    await grant("请求访问自己的数据","data",["plugin_data"]);
    let state=await runtime();
    check(state.sessions===0&&state.dataSessions===1&&state.dialogSessions===0&&state.nativeDialogs===0,"Data authorization precedes Node and real native panels");
    await grant("请求打开文件选择窗口","dialogOpen",["file_read"]);
    state=await runtime();check(state.sessions===0&&state.dialogSessions===1&&state.nativeDialogs===0,"Open-picker grant starts only its scoped session");
    await grant("请求选择文件保存位置","dialogSave",["file_write"]);
    state=await runtime();check(state.sessions===0&&state.dialogSessions===2&&state.nativeDialogs===0&&state.hostSessions===0&&state.activePathSnapshots===0,
      "Save-picker grant precedes Node; unused clipboard/path capabilities have no session or snapshot");
    await grant("请求访问本机","node",NODE_SCOPES);
    const frame=await until(()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),"Original UI iframe missing");
    expectedFrameOrigin=nativeDialogFrameOrigin(frame,pageDocumentMode);
    check(true,pageDocumentMode?"Original file-tree runs through the native page bootstrap in the production load path":"Original file-tree runs in the actual opaque production iframe");
    const initial=await until(async()=>{try{const value=await request("state");return value.title==="目录树生成器"&&value.tree.includes("请选择文件夹")?value:null;}catch{return null;}},"Original file-tree UI failed to initialize");
    check(initial.noTauri&&initial.sourceOpaque===!pageDocumentMode&&initial.sourceOrigin===expectedFrameOrigin&&initial.localCanvasLibrary,
      "Original local libraries load in the observed expected origin without privileged frame internals");
    const loadedRuntime=await runtime();
    check(loadedRuntime.pageDocuments===(pageDocumentMode?1:0),"Loaded native document count matches the actual fixture mode");
    observations.frameDocument={pageDocumentMode,sandbox:frame.getAttribute("sandbox"),src:frame.getAttribute("src")||"",
      srcdocEmpty:frame.srcdoc==="",sourceOrigin:initial.sourceOrigin,sourceOpaque:initial.sourceOpaque,noTauri:initial.noTauri,
      pageDocuments:loadedRuntime.pageDocuments};
    check(initial.consoleErrorObserverInstalled,"Fixture observes bounded console errors while forwarding the original console.error call");
    observations.initial=initial;
    const prePicker=await evidence();observations.prePickerPrivacyEvidence=prePicker;
    check(prePicker.privacyScan.complete,"Pre-picker all-TaskRun privacy scan is complete");
    check(prePicker.selectionPrivacyVerified,"Pre-picker selection privacy excludes only exact reviewed activation installation metadata");
    await checkpoint("awaiting-open-cancel");
    const canceled=await request("click","#selectFolder");
    const openCancel=await completedDialog(1,"showOpenDialog",true);
    check(canceled.tree===initial.tree&&openCancel.png.fileCount===0,"Actual open cancellation leaves original tree and private output unchanged");
    observations.openCancel={frame:canceled,evidence:openCancel};
    await checkpoint("awaiting-open-select");await request("click","#selectFolder");
    const openSelected=await completedDialog(2,"showOpenDialog",false);
    const tree=await until(async()=>{const value=await request("state");return value.tree.includes("readme.txt")&&value.tree.includes("ignored.log")&&value.tree.includes("index.ts")?value:null;},"Selected private directory did not reach original result[0] scan and editor");
    check(tree.tree.includes("tree-data")&&tree.tree!==initial.tree,"Actual original folder button renders the selected synthetic directory");
    observations.openSelected={frame:tree,evidence:openSelected};
    const preview=await request("click","#exportImage");
    check(preview.exportModalOpen&&preview.previewText.includes("readme.txt")&&preview.scale==="1","Actual export button opens original preview at its unchanged 1x default");
    await checkpoint("awaiting-save-cancel");
    const cancelAttempt=await request("click","#confirmExport");
    assertOriginalExportDidNotCatchError(cancelAttempt,preview.consoleErrorCount);
    const saveCancel=await completedDialog(3,"showSaveDialog",true,preview.consoleErrorCount);
    const canceledSave=await until(async()=>{const value=await request("state");return !value.exporting?value:null;},"Original export did not settle after actual save cancellation");
    check(saveCancel.png.fileCount===0&&canceledSave.exportModalOpen&&canceledSave.tree===tree.tree,"Actual save cancellation writes no file and leaves original preview and tree");
    observations.saveCancel={frame:canceledSave,evidence:saveCancel};
    await checkpoint("awaiting-save-select");
    const saveAttempt=await request("click","#confirmExport");
    assertOriginalExportDidNotCatchError(saveAttempt,canceledSave.consoleErrorCount);
    await completedDialog(4,"showSaveDialog",false,canceledSave.consoleErrorCount);
    const exported=await until(async()=>{const value=await request("state");return !value.exporting&&!value.exportModalOpen?value:null;},"Original export UI did not settle after actual save selection");
    const final=await until(async()=>{const value=await evidence();return value.png.fileCount===1&&value.png.independentDecode===true?value:null;},"Original service did not write a valid private PNG after actual save selection");
    check(final.png.pngSignature&&final.png.independentDecode&&final.png.boundedBytes&&Number(final.png.actualBytes)>32
      &&Number(final.png.actualBytes)<=8*1024*1024&&Number(final.png.width)>0&&Number(final.png.height)>0,
      "Independent Rust decoder verifies actual original html2canvas PNG signature dimensions and bounded bytes");
    check(exported.tree===tree.tree&&exported.errors.length===0,"Original UI export preserves directory tree without uncaught errors");
    observations.exported={frame:exported,evidence:final};
    document.querySelector<HTMLButtonElement>(".back-btn")!.click();
    const closedRuntime=await until(async()=>{const value=await runtime();return value.sessions===0&&value.dialogSessions===0&&value.dialogIntents===0&&value.dialogInvocations===0
      &&value.dialogPreparations===0&&!value.dialogTransport&&value.nativeDialogs===0&&value.dataSessions===0&&!value.dataTransport
      &&value.resourceLeases===0&&value.pageDocuments===0&&!document.querySelector(".plugin-panel")?value:null;},"Closing original plugin left dialog/Node/data/page resources");
    observations.closedRuntime=closedRuntime;
    check(true,"Whole original plugin close drains native dialogs, scoped sessions, transport and iframe resources");
    await checkpoint("complete");return {passed:true,checks,observations};
  } catch(error){
    if(lastFrameState)observations.failureLastFrameState=lastFrameState;
    try{observations.failureEvidence=await evidence();await checkpoint("failed");}catch{}
    return {passed:false,checks,observations,error:String(error instanceof Error?error.message:error)};
  }
}
