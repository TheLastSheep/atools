// Only the isolated native acceptance fixture installs this observer.
(() => {
  if(window===window.top)return;
  const token="__ATOOLS_PANEL_TOKEN__",errors=[];
  let tips=null,handle=null;
  const recordError=error=>{if(errors.length<32)errors.push(String(error?.name||"RuntimeError").slice(0,64));};
  window.addEventListener("error",event=>recordError(event.error));
  window.addEventListener("unhandledrejection",event=>recordError(event.reason));
  function state(){return {noTauri:!("__TAURI_INTERNALS__" in window),sourceOpaque:location.origin==="null",
    errors:[...errors],handlePresent:!!handle,destroyed:handle?handle.isDestroyed():null,documentHidden:document.hidden,visibilityState:document.visibilityState};}
  const responses=new Map();
  window.addEventListener("message",async event=>{
    const message=event.data;
    if(event.source!==window.parent||message?.kind!=="atools-browser-contract-probe"||message.token!==token
      ||typeof message.id!=="string")return;
    if(responses.has(message.id)){const saved=responses.get(message.id);if(saved)window.parent.postMessage(saved,"*");return;}
    if(responses.size>=32)return;
    responses.set(message.id,null);
    let result=null,error="",diagnostic=null;
    try {
      if(message.operation==="geometry"){
        result=await window.__AToolsWindowGeometryFixture.run();
      } else if(message.operation==="geometry-state"){
        result=window.__AToolsWindowGeometryFixture.state();
      } else if(message.operation==="geometry-close"){
        result=await window.__AToolsWindowGeometryFixture.close();
      } else if(message.operation==="tips-create"){
        tips=new window.__AToolsReviewedTipsWindow();
        const creation=tips.create("atools-private-fixture");
        handle=tips.tipsWindow;
        const synchronous=!!handle&&typeof handle.show==="function"&&typeof handle.setSkipTaskbar==="function"
          &&typeof handle.setAlwaysOnTop==="function"&&typeof handle.setFullScreen==="function"
          &&typeof handle.destroy==="function"&&handle.isDestroyed()===false&&typeof handle.then!=="function";
        const originalGetStatusFalse=tips.getStatus()===false;
        if(!synchronous||!originalGetStatusFalse)throw Error("SynchronousHandleRequired");
        await creation;await handle.ready;
        result={synchronousHandle:true,originalGetStatusFalse,ready:true,hasHostId:typeof handle.id==="string"&&handle.id.length>0};
      } else if(message.operation==="tips-close"){
        if(!tips||!handle)throw Error("MissingTipsInstance");
        await tips.close();
        result={classClearedHandle:tips.tipsWindow===null,destroyed:handle.isDestroyed()};
      } else if(message.operation==="pending-close"){
        let callbackCount=0;
        const pending=window.utools.createBrowserWindow("page/Tips/successTips.html",{show:false},()=>callbackCount++);
        // Let the factory issue the actual create request before cancelling it;
        // no parent IPC task can respond during this frame's microtask turn.
        await Promise.resolve();
        const wasPendingOnClose=String(pending.id).startsWith("atools-pending-browser-window-");
        const notDestroyedBeforeClose=pending.isDestroyed()===false;
        const closing=pending.close();
        const readyRejected=await pending.ready.then(()=>false,()=>true);
        const closed=await closing;
        result={notDestroyedBeforeClose,wasPendingOnClose,destroyedAfterClose:pending.isDestroyed()===true,
          readyRejected,callbackCount,actualClose:closed?.closed===true};
      } else if(message.operation==="isolation"){
        result=await window.__AToolsBrowserWindowIsolation();
      } else if(message.operation==="nested"){
        const outer=window.utools.createBrowserWindow("page/Tips/successTips.html",{show:false});
        await outer.ready;
        let nested;
        try {
          nested=await outer.webContents.executeJavaScript(`(async()=>{
            let readyCallbackCount=0;
            const child=window.utools.createBrowserWindow('page/Tips/successTips.html',{show:false},()=>readyCallbackCount++);
            const immediate=typeof child.isDestroyed==='function'&&child.isDestroyed()===false;
            await child.ready;
            const closed=await child.close();
            return {immediate,readyCallbackCount,actualClose:closed&&closed.closed===true,destroyed:child.isDestroyed()};
          })()`);
        } finally {await outer.close();}
        result=nested;
      } else if(message.operation==="out-while-creating"){
        const pending=window.utools.createBrowserWindow("page/Tips/successTips.html",{show:false});
        void pending.ready.catch(()=>{});
        await Promise.resolve();
        result={createIssued:true};
        const response={kind:"atools-browser-contract-result",token,id:message.id,state:state(),result,error:""};
        responses.set(message.id,response);window.parent.postMessage(response,"*");
        window.utools.outPlugin([{title:"合成子窗口输出完成",data:"synthetic-output"}]);
        return;
      } else if(["hosted-ipc-basic","hosted-ipc-sibling-nested","hosted-ipc-lifecycle","original-context-menu"].includes(message.operation)){
        result=await window.__AToolsHostedIpcFixture.perform(message.operation);
      } else if(message.operation!=="state")throw Error("UnknownFixtureOperation");
    } catch(failure){
      const value=failure?.fixtureDiagnostic;
      if(value&&typeof value.step==="string"&&typeof value.errorClass==="string"&&typeof value.knownErrorCode==="string"){
        error="FixtureOperationFailure";
        diagnostic={step:value.step,errorClass:value.errorClass,knownErrorCode:value.knownErrorCode};
      }else error=String(failure?.name||"FixtureOperationError").slice(0,64);
    }
    const response={kind:"atools-browser-contract-result",token,id:message.id,state:state(),result,error,diagnostic};
    responses.set(message.id,response);window.parent.postMessage(response,"*");
  });
})();
