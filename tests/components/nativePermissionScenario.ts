import { invoke } from "@tauri-apps/api/core";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import type { PendingAgentToolRequest, TaskRun } from "../../src/lib/types";

type Fixture={pluginId:string;pluginDir:string;preloadPath:string};
type Loader=ReturnType<typeof createPluginRuntimePreload>;
const delay=()=>new Promise(resolve=>setTimeout(resolve,25));

async function until<T>(read:()=>T|Promise<T>,message:string):Promise<NonNullable<T>> {
  const deadline=performance.now()+8000;
  while(performance.now()<deadline) { const value=await read(); if(value)return value as NonNullable<T>; await delay(); }
  throw new Error(message);
}
function check(ok:unknown,message:string):asserts ok { if(!ok)throw new Error(message); }
function dialog() {return document.querySelector<HTMLElement>("[data-permission-dialog]");}
function button(text:string) {
  const element=[...document.querySelectorAll<HTMLButtonElement>("[data-permission-dialog] button")].find(node=>node.textContent?.trim()===text);
  check(element,`Missing actual dialog action: ${text}`); return element;
}
async function pending() {
  return until(async()=>{
    const items=await invoke<PendingAgentToolRequest[]>("list_pending_agent_requests");
    return items.find(item=>item.tool_name.startsWith("legacy_node_"));
  },"Native permission event did not reach pending queue");
}

export async function runNativePermissionScenario() {
  const checks:Record<string,boolean>={}; const loaders:Loader[]=[];
  let frame:HTMLIFrameElement|undefined;
  try {
    const fixture=await invoke<Fixture>("native_permission_fixture");
    const search=document.getElementById("native-permission-search") as HTMLInputElement;
    const open=()=>{
      search.focus();
      const loader=createPluginRuntimePreload(invoke,fixture.pluginId,()=>true); loaders.push(loader);
      const preparation=loader.prepare({pluginDir:fixture.pluginDir,preloadPath:fixture.preloadPath,
        readTextFile:modulePath=>invoke<string>("read_plugin_preload_module",{pluginId:fixture.pluginId,modulePath})});
      // Rejection is asserted below; register now so cancellation cannot produce an unhandled rejection.
      void preparation.catch(()=>{});
      return {loader,preparation};
    };

    const first=open(); const original=await pending();
    await until(dialog,"Actual permission dialog did not render from native event");
    await until(()=>dialog()?.querySelector("h2")?.textContent?.includes(fixture.pluginId),"Native permission context did not resolve the requesting plugin");
    checks.pluginNameBoundToPendingRequest=true;
    checks.safeInitialFocus=Boolean(document.activeElement?.hasAttribute("data-permission-deny"));
    const before=await invoke<{sessions:number;pending:number}>("native_permission_runtime_state");
    checks.noNodeBeforeClick=before.sessions===0 && before.pending===1;
    button("允许一次").click();
    const script=await first.preparation;
    await until(()=>!dialog(),"Permission dialog did not dismiss after actual approval");
    const completed=await invoke<TaskRun>("get_task_run",{id:original.run_id});
    checks.resumedOriginalRun=completed.id===original.run_id && completed.status==="succeeded";
    checks.oneTimeGrantNotSaved=(await invoke<unknown[]>("list_agent_tool_grants")).length===0;
    checks.focusReturnedAfterApproval=document.activeElement===search;

    type Business={hash?:string;noTauri?:boolean;seen?:number[];dynamic?:string;error?:string;opaque?:boolean;
      runtime?:{version:string;executable:string;nestedNodeVersion:string}};
    const business=new Promise<Business>((resolve)=>{
      const deadline=setTimeout(()=>{window.removeEventListener("message",receive);resolve({error:"Native iframe business timeout"});},8000);
      const receive=(event:MessageEvent)=>{
        if(event.source!==frame?.contentWindow || event.data?.permissionBusiness!==true)return;
        clearTimeout(deadline);window.removeEventListener("message",receive);
        resolve({...event.data,opaque:event.origin==="null"});
      };
      window.addEventListener("message",receive);
    });
    frame=document.createElement("iframe");frame.sandbox.add("allow-scripts");
    frame.srcdoc=`<!doctype html><body><p>插件功能验证</p>${script}<script>(async()=>{try { parent.postMessage({permissionBusiness:true,hash:services.hash('abc'),seen:await services.collect(),dynamic:await services.dynamic(),runtime:{version:process.version,executable:process.execPath,nestedNodeVersion:require('node:child_process').execFileSync('node',['--version'],{encoding:'utf8'}).trim()},noTauri:typeof window.__TAURI_INTERNALS__==='undefined'},'*'); } catch(error) { parent.postMessage({permissionBusiness:true,error:String(error)},'*'); }})();</script></body>`;
    document.body.append(frame);
    const result=await business;
    check(!result.error,`Native preload business failed: ${result.error}`);
    checks.realPreloadHashAfterUiApproval=result.opaque===true && result.noTauri===true && result.hash==="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    checks.realLocalEsmClosureAfterUiApproval=JSON.stringify(result.seen)==="[7,11]";
    checks.realDynamicFileModuleAfterUiApproval=result.dynamic==="native-file-module";
    checks.nestedNodeResolvesSelectedRuntime=Boolean(result.runtime?.version && result.runtime.nestedNodeVersion===result.runtime.version);
    frame.remove(); await first.loader.close();

    const remember=open(); await pending(); await until(dialog,"Remember dialog missing");
    button("允许并记住").click(); await remember.preparation;
    await until(()=>!dialog(),"Remember dialog stayed open");
    const grants=await invoke<Array<{client_id:string;tool_name:string}>>("list_agent_tool_grants");
    checks.savedGrantBoundToTool=grants.length===1 && grants[0].client_id==="atools-ui" && grants[0].tool_name===original.tool_name;
    await remember.loader.close();
    const cached=open(); await cached.preparation;
    checks.savedGrantReopensWithoutDialog=!dialog(); await cached.loader.close();
    await invoke("revoke_agent_tool",{clientId:"atools-ui",toolName:original.tool_name});

    const denied=open(); const deniedRequest=await pending(); await until(dialog,"Deny dialog missing");
    dialog()!.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));
    let rejected=false;try{await denied.preparation;}catch{rejected=true;}
    await until(()=>!dialog(),"Escape did not dismiss denied request");
    const deniedRun=await invoke<TaskRun>("get_task_run",{id:deniedRequest.run_id});
    checks.escapeDeniesOriginalRun=rejected && deniedRun.status==="cancelled";
    checks.focusReturnedAfterDenial=document.activeElement===search;

    const closed=open(); const closedRequest=await pending(); await until(dialog,"Pending close dialog missing");
    await closed.loader.close(); await closed.preparation.catch(()=>{});
    await until(()=>!dialog(),"Backend cancellation left a stale dialog");
    const closedRun=await invoke<TaskRun>("get_task_run",{id:closedRequest.run_id});
    checks.backendCancellationReconcilesDialog=closedRun.status==="cancelled";
    const state=await invoke<{sessions:number;pending:number;openings:number;transport:boolean}>("native_permission_runtime_state");
    checks.allResourcesReleased=state.sessions===0 && state.pending===0 && state.openings===0 && !state.transport;
    check(Object.values(checks).every(Boolean),"One or more native permission UI checks failed");
    return {ok:true,checks,nodeRuntime:result.runtime};
  } catch(error) { return {ok:false,checks,error:error instanceof Error?error.message:String(error)}; }
  finally {frame?.remove();await Promise.all(loaders.map(loader=>loader.close()));}
}
