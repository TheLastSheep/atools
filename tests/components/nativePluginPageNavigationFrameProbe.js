// Synthetic fixture observer only. Browser, bridge, navigation and system APIs remain real.
(() => {
  if(window===window.top)return;
  const key="__ATOOLS_PAGE_NAVIGATION_FIXTURE_PROBE__";
  const previous=Object.getOwnPropertyDescriptor(window,key)?.value;
  if(previous?.kind==="synthetic-page-navigation-probe")previous.dispose();
  const memory=previous?.kind==="synthetic-page-navigation-probe"?previous.memory:
    {responses:new Map(),navigationStarted:false,permissionRequested:false,nestedBlankProof:null};
  const token="__ATOOLS_PANEL_TOKEN__",responses=memory.responses;
  let disposed=false;
  const state=()=>({title:document.title,href:location.href,syntheticReady:document.documentElement?.dataset.syntheticReady==="true",
    syntheticDataRoundtrip:document.documentElement?.dataset.syntheticDataRoundtrip==="true",
    noTauri:!("__TAURI_INTERNALS__" in window)&&!("__TAURI__" in window),
    transportPresent:typeof window.__ATOOLS_FRAME_TRANSPORT__?.post==="function",nestedBlankProof:memory.nestedBlankProof,
    workerPolicy:memory.workerPolicy||null});
  const respond=(message,error="")=>{
    const result={kind:"atools-page-navigation-probe-result",token,id:message.id,error,state:state()};
    responses.set(message.id,result);if(responses.size>32)responses.delete(responses.keys().next().value);
    parent.postMessage(result,"*");
  };
  async function nestedBlank(){
    if(memory.nestedBlankProof)return;
    const frame=document.createElement("iframe");frame.title="Synthetic nested about blank positive control";
    const loaded=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Nested about:blank deadline")),2000);
      frame.addEventListener("load",()=>{clearTimeout(timer);resolve();},{once:true});});
    frame.src="about:blank";document.body.append(frame);await loaded;
    const nested=frame.contentDocument;
    if(!nested?.body)throw Error("Nested about:blank document access unavailable");
    nested.body.textContent="synthetic nested blank control";
    memory.nestedBlankProof={created:true,documentWriteRead:nested.body.textContent==="synthetic nested blank control",
      href:frame.contentWindow.location.href};
    if(!memory.nestedBlankProof.documentWriteRead)throw Error("Nested about:blank roundtrip failed");
    frame.remove();
  }
  async function workerProbe(kind){
    const Constructor=kind==="shared"?window.SharedWorker:(window.__atoolsNativeWorker??window.Worker);
    const result={kind,available:typeof Constructor==="function",status:"unavailable",attempted:false,scriptExecuted:false,
      constructorSource:kind==="shared"?"window.SharedWorker":window.__atoolsNativeWorker?"window.__atoolsNativeWorker":"window.Worker",
      constructionErrorName:null,violations:[],errorEvents:[],workerCreated:false,portCreated:false,
      cleanup:{complete:false,policyListenerRemoved:false,timerCleared:false,objectUrlRevoked:false,workerTerminated:false,portClosed:false,listenersRemoved:false,errors:[]}};
    if(!result.available){result.cleanup.complete=true;return result;}
    const marker="atools-synthetic-worker-policy-executed-"+kind;
    let url,worker,port,timer,messageTarget;
    const listeners=[];
    const listen=(target,name,handler)=>{target.addEventListener(name,handler);listeners.push([target,name,handler]);};
    const onMessage=event=>{if(event.data===marker)result.scriptExecuted=true;};
    const onError=event=>{event.preventDefault();if(result.errorEvents.length<4)result.errorEvents.push(String(event.error?.name||event.type||"error").slice(0,80));};
    const onPolicy=event=>{
      if(event.effectiveDirective!=="worker-src"||result.violations.length>=4)return;
      const blocked=String(event.blockedURI||"");
      result.violations.push({effectiveDirective:event.effectiveDirective,blockedUriKind:blocked==="blob"||blocked.startsWith("blob:")?"blob":blocked?"other":"empty"});
    };
    try {
      listen(document,"securitypolicyviolation",onPolicy);
      const code=kind==="shared"?"self.onconnect=function(event){event.ports[0].postMessage("+JSON.stringify(marker)+");};":
        "self.postMessage("+JSON.stringify(marker)+");";
      url=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));result.attempted=true;
      try {
        worker=kind==="module"?new Constructor(url,{type:"module"}):new Constructor(url);
        result.workerCreated=true;listen(worker,"error",onError);
        port=kind==="shared"?worker.port:undefined;result.portCreated=Boolean(port);messageTarget=port||worker;
        listen(messageTarget,"message",onMessage);if(port)port.start();
      } catch(error){result.constructionErrorName=String(error?.name||"Error").slice(0,80);}
      await new Promise(resolve=>{timer=setTimeout(resolve,500);});
      result.status=result.scriptExecuted?"executed":result.violations.some(value=>value.effectiveDirective==="worker-src"&&value.blockedUriKind==="blob")?"csp-blocked":"unverified";
    } catch(error){result.status="probe-error";result.probeErrorName=String(error?.name||"Error").slice(0,80);}
    finally {
      const clean=(name,action)=>{try{action();result.cleanup[name]=true;}catch(error){result.cleanup.errors.push(name+":"+String(error?.name||"Error").slice(0,80));}};
      clean("listenersRemoved",()=>{let first;for(const [target,name,handler] of listeners){
        try{target.removeEventListener(name,handler);}catch(error){first??=error;}}
        if(first)throw first;});
      result.cleanup.policyListenerRemoved=result.cleanup.listenersRemoved;
      clean("timerCleared",()=>{if(timer!==undefined)clearTimeout(timer);});
      clean("workerTerminated",()=>{if(worker&&kind!=="shared")worker.terminate();});
      clean("portClosed",()=>{if(port)port.close();});
      clean("objectUrlRevoked",()=>{if(url)URL.revokeObjectURL(url);});
      result.cleanup.complete=result.cleanup.errors.length===0&&["policyListenerRemoved","timerCleared","objectUrlRevoked","workerTerminated","portClosed","listenersRemoved"].every(key=>result.cleanup[key]===true);
    }
    return result;
  }
  async function workerPolicy(){
    if(!memory.workerPolicyPromise)memory.workerPolicyPromise=(async()=>{
      const probes=[];for(const kind of ["classic","module","shared"])probes.push(await workerProbe(kind));
      memory.workerPolicy={probes,observationWindowMs:500,serviceWorkerRegistrationAttempted:false,networkRequested:false};
    })();
    await memory.workerPolicyPromise;
  }
  async function receive(event){
    const message=event.data;
    if(disposed||event.source!==parent||message?.kind!=="atools-page-navigation-probe"||message.token!==token
      ||typeof message.id!=="string"||message.id.length>100)return;
    if(responses.has(message.id)){const cached=responses.get(message.id);if(cached)parent.postMessage(cached,"*");return;}
    responses.set(message.id,null);
    let navigate;
    try {
      if(message.operation==="nested-blank")await nestedBlank();
      else if(message.operation==="worker-policy")await workerPolicy();
      else if(message.operation==="pending-permission") {
        if(!memory.permissionRequested){
          if(!window.__ATOOLS_FRAME_TRANSPORT__?.post({__atools_permission_request__:true,reqId:6001,
            permission:"clipboard.write",pluginId:"file-tree",featureCode:"page-navigation"}))throw Error("Real frame permission transport unavailable");
          memory.permissionRequested=true;
        }
      } else if(message.operation.startsWith("nav-")) {
        if(memory.navigationStarted)throw Error("Synthetic document navigation already triggered");
        const rawAsset=new URL("/assets/revoked.html",location.href).href;
        const operations={"nav-replace":()=>location.replace(rawAsset),"nav-reload":()=>location.reload(),
          "nav-meta":()=>{const meta=document.createElement("meta");meta.httpEquiv="refresh";meta.content="0;url="+rawAsset;document.head.append(meta);},
          "nav-self-blank":()=>window.open("about:blank","_self"),
          "nav-history":()=>{history.replaceState(null,"","/logical-route?padding="+"x".repeat(10000));location.replace(rawAsset);}};
        navigate=operations[message.operation];if(!navigate)throw Error("Unreviewed synthetic navigation operation");
        memory.navigationStarted=true;
      } else if(message.operation!=="state")throw Error("Unreviewed synthetic fixture operation");
      respond(message);if(navigate)setTimeout(navigate,40);
    } catch(error){respond(message,String(error?.message||error));}
  }
  window.addEventListener("message",receive);
  Object.defineProperty(window,key,{configurable:true,value:{kind:"synthetic-page-navigation-probe",memory,
    dispose(){if(disposed)return;disposed=true;window.removeEventListener("message",receive);}}});
})();
