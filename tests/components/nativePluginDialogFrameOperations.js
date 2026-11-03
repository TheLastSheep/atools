// Dedicated fixture observer. No plugin/system API replacement; console.error is passively observed and fully forwarded.
(() => {
  if(window===window.top)return;
  const observerKey="__ATOOLS_NATIVE_DIALOG_FIXTURE_OBSERVER__";
  const previous=Object.getOwnPropertyDescriptor(window,observerKey)?.value;
  if(previous?.kind==="atools-native-dialog-observer"&&typeof previous.dispose==="function")previous.dispose();
  const token="__ATOOLS_PANEL_TOKEN__",errors=[],consoleErrors=[];
  let consoleErrorCount=0,consoleErrorObserverInstalled=false,disposed=false;
  let originalConsoleError,observedConsoleError;
  const boundedDiagnosticValue=value=>{
    let text;
    try {
      if(typeof value==="string")text=value.slice(0,4096);
      else {
        const tag=Object.prototype.toString.call(value);
        if(value instanceof Error||tag==="[object Error]") {
          const name=value.name,message=value.message;
          text=`${typeof name==="string"?name.slice(0,128):"Error"}: ${typeof message==="string"?message.slice(0,4096):"[non-string error message]"}`;
        } else text=tag;
      }
    } catch {text="[unreadable diagnostic argument]";}
    if(!token||token.length>256)return "[diagnostic hidden: invalid fixture token]";
    return text.slice(0,4096).split(token).join("[redacted-fixture-token]")
      .replace(/(?:https?:\/\/127\.0\.0\.1:\d+)?\/(?:node|host|data|dialog)\/[a-f0-9]{64}/gi,"[redacted-local-endpoint]").slice(0,280);
  };
  try {
    originalConsoleError=console.error;
    observedConsoleError=function observedNativeDialogConsoleError(...args){
      try {
        if(!disposed) {
          consoleErrorCount++;
          consoleErrors.push(args.slice(0,3).map(boundedDiagnosticValue));
          if(consoleErrors.length>12)consoleErrors.shift();
        }
      } catch { /* Observation must never suppress the original console call. */ }
      return Reflect.apply(originalConsoleError,this,args);
    };
    console.error=observedConsoleError;
    consoleErrorObserverInstalled=console.error===observedConsoleError;
  } catch { /* A read-only console remains unchanged and is diagnosed in state. */ }
  const rememberError=value=>{errors.push(boundedDiagnosticValue(value));if(errors.length>12)errors.shift();};
  function handleWindowError(event){if(!disposed)rememberError(event.message);}
  function handleUnhandledRejection(event){if(!disposed)rememberError(event.reason);}
  const state=()=>({title:document.title,tree:document.querySelector(".CodeMirror")?.CodeMirror?.getValue()||"",
    exportModalOpen:document.querySelector("#exportModal")?.classList.contains("show")===true,
    exporting:document.querySelector("#confirmExport")?.classList.contains("loading")===true,
    previewText:document.querySelector("#exportPreview")?.textContent||"",scale:document.querySelector("#exportScale")?.value,
    errors:[...errors],consoleErrors:consoleErrors.map(row=>[...row]),consoleErrorCount,consoleErrorObserverInstalled,
    noTauri:!("__TAURI_INTERNALS__" in window)&&!("__TAURI__" in window),sourceOrigin:location.origin,sourceOpaque:location.origin==="null",
    localCanvasLibrary:typeof window.html2canvas==="function",visibilityState:document.visibilityState,documentHasFocus:document.hasFocus()});
  async function handleProbeMessage(event){
    const message=event.data;
    if(disposed||event.source!==window.parent||message?.token!==token||message?.kind!=="atools-dialog-probe")return;
    let error="";
    try {
      if(message.operation==="click") {
        if(!["#selectFolder","#exportImage","#confirmExport"].includes(message.selector))throw Error("Unreviewed original UI action");
        const target=document.querySelector(message.selector);
        if(!(target instanceof HTMLButtonElement))throw Error("Missing original dialog button");
        target.click();
      } else if(message.operation!=="state")throw Error("Unreviewed dialog fixture operation");
      await new Promise(resolve=>setTimeout(resolve,25));
    } catch(failure){error=boundedDiagnosticValue(failure);}
    if(disposed)return;
    window.parent.postMessage({kind:"atools-dialog-probe-result",token,id:message.id,error,state:state()},"*");
  }
  function dispose(){
    if(disposed)return;
    disposed=true;
    window.removeEventListener("error",handleWindowError);
    window.removeEventListener("unhandledrejection",handleUnhandledRejection);
    window.removeEventListener("message",handleProbeMessage);
    try {if(console.error===observedConsoleError)console.error=originalConsoleError;} catch { /* Preserve a later plugin console implementation. */ }
    if(Object.getOwnPropertyDescriptor(window,observerKey)?.value===observer)delete window[observerKey];
  }
  const observer=Object.freeze({kind:"atools-native-dialog-observer",dispose});
  Object.defineProperty(window,observerKey,{value:observer,configurable:true});
  window.addEventListener("error",handleWindowError);
  window.addEventListener("unhandledrejection",handleUnhandledRejection);
  window.addEventListener("message",handleProbeMessage);
})();
