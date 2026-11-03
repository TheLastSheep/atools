import { invoke as rawInvoke } from "@tauri-apps/api/core";

function invoke<T>(command:string,args?:Record<string,unknown>):Promise<T>{
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Navigation IPC deadline: "+command)),10000);
    rawInvoke<T>(command,args).then(value=>{clearTimeout(timer);resolve(value);},error=>{clearTimeout(timer);reject(error);});});
}
const pause=(ms=50)=>new Promise(resolve=>setTimeout(resolve,ms));
const checks:Record<string,boolean>={};const observations:Record<string,unknown>={};
function check(value:unknown,label:string):asserts value{if(!value)throw Error(label);checks[label]=true;}
async function until<T>(read:()=>T|Promise<T>,label:string):Promise<NonNullable<T>>{
  const end=performance.now()+10000;while(performance.now()<end){const value=await read();if(value)return value as NonNullable<T>;await pause();}throw Error(label);
}
type Fixture={token:string;sourcePath:string;pluginId:string;featureCode:string};
type RuntimeState={legacySessions:number;legacyOpenings:number;legacyTransport:boolean;hostSessions:number;hostIntents:number;hostInvocations:number;hostTransport:boolean};
function launcherInput(){return document.querySelector<HTMLInputElement>(".search-input");}
function navInput(){return document.querySelector<HTMLInputElement>('input[aria-label="插件搜索"]');}
function activePlugin(){return Boolean(document.querySelector(".plugin-panel"));}
function search(text:string){const input=launcherInput();check(input,"Production launcher input is mounted");input!.focus();input!.value=text;input!.dispatchEvent(new Event("input",{bubbles:true}));}
function selectedFeature(){return [...document.querySelectorAll<HTMLElement>('[role="option"][aria-selected="true"]')].find(node=>node.textContent?.includes("导航探针"));}
async function openPlugin(){
  search("navigation probe");await until(selectedFeature,"Actual search catalog finds imported synthetic plugin");
  launcherInput()!.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));
  await until(activePlugin,"Actual PluginPanel opens for synthetic feature");
  await until(()=>document.querySelector(".plugin-title")?.textContent?.includes("导航探针"),"PluginPanel renders synthetic plugin title");
  await until(()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),"Synthetic plugin iframe loads");
  await until(()=>observedPluginReady,"Generated plugin posts its ready probe");
}
let observedPluginReady=false;
let frameRequestSequence=0;
function listenMessages(handler:(event:MessageEvent)=>void){window.addEventListener("message",handler);return()=>window.removeEventListener("message",handler);}
async function frameRequest(token:string,operation:string,extra:Record<string,unknown>={}){
  const frame=await until(()=>document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),"Plugin iframe missing for probe");
  const id="navigation-probe-"+(++frameRequestSequence);
  const result=new Promise<{error:string;state:unknown}>((resolve,reject)=>{
    const timer=setTimeout(()=>{window.removeEventListener("message",onMessage);reject(Error("Iframe navigation probe timed out: "+operation));},5000);
    function onMessage(event:MessageEvent){if(event.source!==frame.contentWindow||event.data?.kind!=="atools-navigation-probe-result"||event.data.token!==token||event.data.id!==id)return;
      clearTimeout(timer);window.removeEventListener("message",onMessage);resolve({error:String(event.data.error||""),state:event.data.state});}
    window.addEventListener("message",onMessage);
  });
  frame.contentWindow!.postMessage({kind:"atools-navigation-probe",token,id,operation,...extra},"*");
  const value=await result;check(!value.error,"Iframe probe operation succeeds: "+operation);return value.state;
}
async function runtimeState(){return invoke<RuntimeState>("native_navigation_runtime_state");}
async function waitLauncherFocus(){await until(()=>!activePlugin()&&document.activeElement===launcherInput(),"Return navigation restores launcher search focus");}
function keydown(target:HTMLElement,key:string,extra:KeyboardEventInit={}){const event=new KeyboardEvent("keydown",{key,bubbles:true,cancelable:true,...extra});target.dispatchEvent(event);return event;}
async function clickFrame(token:string,id:string){await frameRequest(token,"click",{button:id});}
async function waitNav(){return until(navInput,"Plugin search input was not shown by setSubInput");}

export async function runNativePluginNavigationScenario(){
  let phase="setup";
  const removeMessage=listenMessages(event=>{if(event.data?.kind==="navigation-plugin-ready"&&event.source===document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')?.contentWindow)observedPluginReady=true;});
  const callbacks:string[]=[];
  const onCallback=(event:MessageEvent)=>{if(event.data?.kind==="navigation-callback"&&event.source===document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]')?.contentWindow)callbacks.push(String(event.data.text));};
  window.addEventListener("message",onCallback);
  try{
    const fixture=await invoke<Fixture>("native_navigation_fixture");
    phase="wait-for-app-and-import";
    await until(launcherInput,"Production App search input did not mount");
    const imported=await invoke<{imported:string[];failed:unknown[];skipped:unknown[]}>("import_ztools_plugins",{paths:[fixture.sourcePath],overwrite:true});
    check(imported.imported.includes(fixture.pluginId)&&imported.failed.length===0&&imported.skipped.length===0,"Actual Rust importer installs only the generated pure-Web package");
    const initial=await runtimeState();check(initial.legacySessions===0&&initial.legacyOpenings===0&&!initial.legacyTransport,"Runtime manager is installed without starting a Node sidecar or listener");
    phase="open-plugin-and-verify-launcher-hide";await openPlugin();
    const activeRuntime=await runtimeState();
    check(activeRuntime.legacySessions===0&&activeRuntime.legacyOpenings===0&&!activeRuntime.legacyTransport,"Pure-Web plugin navigation remains Node-idle while its panel is active");
    check(!navInput(),"No plugin search field appears until setSubInput is called");
    check(!launcherInput(),"The real .search-input launcher field is hidden while the plugin owns navigation");
    check(document.querySelector('button[aria-label="返回搜索"]'),"Plugin navigation exposes an explicitly labelled return button");
    phase="default-set-subinput";await clickFrame(fixture.token,"show-subinput-default");
    const field=await waitNav();
    check(field.placeholder==="输入关键词","setSubInput(callback) without options renders the default placeholder");
    await until(()=>document.activeElement===field,"setSubInput(callback) defaults to visible and focused");
    check(document.activeElement===field,"Default setSubInput call leaves focus in the navigation input");
    check(document.querySelectorAll("input").length===1,"Plugin navigation shows only one input in the parent document");
    phase="set-value-callback";await clickFrame(fixture.token,"set-value");
    await until(()=>navInput()?.value==="select-me","setSubInputValue updates the host field");
    await until(()=>callbacks.filter(value=>value==="select-me").length===1,"setSubInputValue invokes the registered callback exactly once");
    check(callbacks.filter(value=>value==="select-me").length===1,"setSubInputValue notifies its callback exactly once");
    await pause(200);check(callbacks.filter(value=>value==="select-me").length===1,"setSubInputValue does not duplicate callback delivery");
    phase="select-blur-focus";await clickFrame(fixture.token,"select-subinput");
    await until(()=>document.activeElement===field&&field.selectionStart===0&&field.selectionEnd===field.value.length,"subInputSelect focuses and selects the entire query");
    await clickFrame(fixture.token,"blur-subinput");
    await until(()=>document.activeElement!==field,"subInputBlur releases focus from the host field");
    await clickFrame(fixture.token,"focus-subinput");
    await until(()=>document.activeElement===field,"subInputFocus restores focus to the host field");
    phase="typed-callback";const typed="typed-navigation-query";field.value=typed;field.dispatchEvent(new Event("input",{bubbles:true}));
    await until(()=>callbacks.filter(value=>value===typed).length===1,"Host typing reaches the setSubInput callback without onSubInput registration");
    await pause(200);check(callbacks.filter(value=>value===typed).length===1,"One typed value reaches the callback exactly once");
    phase="remove-subinput";await clickFrame(fixture.token,"remove-subinput");
    await until(()=>!navInput(),"removeSubInput removes the navigation field");
    await until(()=>document.activeElement===document.querySelector<HTMLIFrameElement>('iframe[title="Plugin"]'),"removeSubInput returns focus to the plugin iframe");
    phase="escape-disabled";await clickFrame(fixture.token,"show-subinput");
    const empty=await waitNav();await until(()=>document.activeElement===empty,"Recreated subinput gets its requested initial focus");
    check(empty.placeholder==="筛选条目","Explicit setSubInput placeholder is honored");
    empty.value="clear me";empty.dispatchEvent(new Event("input",{bubbles:true}));
    await until(()=>navInput()?.value==="clear me","Fixture input event reaches the plugin navigation value");
    const escapeEvent=keydown(empty,"Escape");await pause(100);
    await until(()=>activePlugin()&&navInput()?.value==="","Escape clears a nonempty plugin query before navigation (value="+String(navInput()?.value)+", defaultPrevented="+escapeEvent.defaultPrevented+", focused="+String(document.activeElement===empty)+")");
    const remainsAfterClear=activePlugin();keydown(navInput()!,"Escape");await pause(200);
    check(remainsAfterClear&&activePlugin(),"With pluginEscapeToSearch=false, empty-field Escape does not exit from the input");
    await frameRequest(fixture.token,"escape");await pause(200);
    check(activePlugin(),"With pluginEscapeToSearch=false, iframe Escape does not exit the plugin");
    document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')!.click();
    await waitLauncherFocus();check(!activePlugin(),"Explicit return exits even when pluginEscapeToSearch=false");
    const afterFirstClose=await runtimeState();
    check(afterFirstClose.legacySessions===0&&afterFirstClose.legacyOpenings===0&&!afterFirstClose.legacyTransport,"Explicit close leaves no legacy Node session/opening/listener");
    observations.escapeDisabled={nonemptyCleared:true,inputEmptyEscapeStayed:true,iframeEscapeStayed:true,explicitBackExited:true,afterClose:afterFirstClose};

    phase="escape-enabled";window.dispatchEvent(new CustomEvent("atools-settings-updated",{detail:{pluginEscapeToSearch:true}}));
    await openPlugin();await clickFrame(fixture.token,"show-subinput");
    const enabled=await waitNav();await until(()=>document.activeElement===enabled,"Enabled escape fixture has focused subinput");
    enabled.value="first escape";enabled.dispatchEvent(new Event("input",{bubbles:true}));
    await until(()=>navInput()?.value==="first escape","Enabled Escape fixture input event reaches navigation state");
    const enabledEscape=keydown(enabled,"Escape");await pause(100);
    await until(()=>activePlugin()&&navInput()?.value==="","Enabled Escape first clears the query (value="+String(navInput()?.value)+", defaultPrevented="+enabledEscape.defaultPrevented+", focused="+String(document.activeElement===enabled)+")");
    keydown(navInput()!,"Escape");await waitLauncherFocus();
    check(!activePlugin(),"With pluginEscapeToSearch=true, a second empty Escape returns to launcher search");
    observations.escapeEnabled={firstEscapeClears:true,secondEscapeReturns:true};

    phase="bare-backspace";await openPlugin();await clickFrame(fixture.token,"show-subinput");
    const backspace=await waitNav();await until(()=>document.activeElement===backspace,"Backspace fixture input is focused");
    keydown(backspace,"Backspace");await waitLauncherFocus();
    check(!activePlugin(),"Bare Backspace in an empty plugin search returns to launcher");

    phase="ime-composition";await openPlugin();await clickFrame(fixture.token,"show-subinput");
    const composing=await waitNav();await until(()=>document.activeElement===composing,"IME fixture input is focused");
    const callbackCountBeforeComposition=callbacks.length;
    composing.dispatchEvent(new CompositionEvent("compositionstart",{bubbles:true,data:"拼"}));
    composing.value="拼";composing.dispatchEvent(new InputEvent("input",{bubbles:true,data:"拼",inputType:"insertCompositionText",isComposing:true}));
    check(callbacks.length===callbackCountBeforeComposition,"IME intermediate input does not invoke the plugin callback");
    keydown(composing,"Enter",{isComposing:true,keyCode:229});
    keydown(composing,"ArrowDown",{isComposing:true,keyCode:229});
    composing.value="";composing.dispatchEvent(new InputEvent("input",{bubbles:true,data:"",inputType:"deleteContentBackward",isComposing:true}));
    keydown(composing,"Backspace",{isComposing:true,keyCode:229});
    composing.value="拼";composing.dispatchEvent(new InputEvent("input",{bubbles:true,data:"拼",inputType:"insertCompositionText",isComposing:true}));
    keydown(composing,"Escape",{isComposing:true,keyCode:229});await pause(200);
    check(activePlugin()&&navInput()?.value==="拼","IME composing Enter/Backspace/Arrow/Escape does not navigate or mutate the query");
    check(callbacks.length===callbackCountBeforeComposition,"IME navigation keys do not emit intermediate callback values");
    const composed="中文-final";composing.value=composed;
    composing.dispatchEvent(new CompositionEvent("compositionend",{bubbles:true,data:composed}));
    composing.dispatchEvent(new InputEvent("input",{bubbles:true,data:composed,inputType:"insertText",isComposing:false}));
    await until(()=>callbacks.filter(value=>value===composed).length===1,"IME composition commits its final input exactly once");
    check(callbacks.filter(value=>value===composed).length===1,"IME compositionend delivers the final value once");
    await pause(200);check(callbacks.filter(value=>value===composed).length===1,"Post-composition final input is not delivered twice");
    document.querySelector<HTMLButtonElement>('button[aria-label="返回搜索"]')!.click();await waitLauncherFocus();
    const final=await runtimeState();
    check(final.legacySessions===0&&final.legacyOpenings===0&&!final.legacyTransport,"Pure-Web plugin journey creates no Node session/opening/listener");
    check(final.hostSessions===0&&final.hostIntents===0&&final.hostInvocations===0&&!final.hostTransport,"Plugin navigation creates no host Node sessions, intents, invocations, or listener");
    observations.activeRuntimeState=activeRuntime;
    observations.finalRuntimeState=final;
    observations.callbacks=callbacks;
    return {passed:true,checks,observations,scope:{syntheticPureWebOnly:true,pluginPreload:null,backgroundServices:false,
      runtimeCounters:"ATools legacy/host manager counters only; no system-wide process inventory was collected"}};
  }catch(error){return {passed:false,checks,observations,phase,error:error instanceof Error?{name:error.name,message:error.message,stack:error.stack}:String(error),runtimeState:await runtimeState().catch(()=>null),hostText:document.body.innerText.slice(0,1800)};}
  finally{window.removeEventListener("message",onCallback);removeMessage();}
}
