// Isolated acceptance code: only fixed public hosted-window and Electron APIs.
(() => {
  const page="page/Tips/successTips.html", prefix="atools:fixture:hosted-ipc:";
  const ipc=()=>window.require("electron").ipcRenderer;
  const identity=()=>window.ztools.getWebContentsId();
  const positive=value=>Number.isSafeInteger(value)&&value>0;
  const pause=()=>new Promise(resolve=>setTimeout(resolve,20));
  async function until(read,label){const deadline=performance.now()+5000;while(performance.now()<deadline){const value=await read();if(value)return value;await pause();}throw Error(label);}
  function childSetup(parentId){
    const api=window.require("electron").ipcRenderer, state={received:[],onceCount:0,offCount:0,removedCount:0};
    window.__atoolsHostedIpcObservation=state;
    api.on("atools:fixture:hosted-ipc:parent",(event,...args)=>{
      state.received.push({senderId:event.senderId,args});
      api.sendTo(parentId,"atools:fixture:hosted-ipc:reply",{childId:window.ztools.getWebContentsId(),senderId:-77,args});
    });
    api.on("atools:fixture:hosted-ipc:rtt-request",(event,payload)=>{
      if(event.senderId!==parentId||!payload||Object.keys(payload).sort().join(",")!=="fixture,sequence,value"
        ||payload.fixture!=="atools-hosted-ipc-rtt-v1"||!Number.isInteger(payload.sequence)||payload.sequence<0||payload.sequence>=20||payload.value!==42)return;
      api.sendTo(parentId,"atools:fixture:hosted-ipc:rtt-ack",payload);
    });
    api.once("atools:fixture:hosted-ipc:once",()=>state.onceCount++);
    const removed=()=>state.offCount++;api.on("atools:fixture:hosted-ipc:off",removed);api.off("atools:fixture:hosted-ipc:off",removed);
    api.on("atools:fixture:hosted-ipc:removed",()=>state.removedCount++);api.removeAllListeners("atools:fixture:hosted-ipc:removed");
    api.on("atools:fixture:hosted-ipc:barrier",()=>state.barrier=true);
    return {id:window.ztools.getWebContentsId(),origin:location.origin,noTauri:!("__TAURI_INTERNALS__" in window)};
  }
  async function measureRoundTrips(childId){
    const marker="atools-hosted-ipc-rtt-v1",samples=[],api=ipc();let pending=null;
    const listener=(event,payload)=>{
      const finishedAt=performance.now(),current=pending;if(!current)return;
      if(event.senderId!==childId||!payload||Object.keys(payload).sort().join(",")!=="fixture,sequence,value"
        ||payload.fixture!==marker||payload.sequence!==current.sequence||payload.value!==42){current.finish(Error("RoundTripAckIdentityMismatch"));return;}
      const elapsedMs=finishedAt-current.startedAt;
      if(!Number.isFinite(elapsedMs)||elapsedMs<0){current.finish(Error("RoundTripClockInvalid"));return;}
      current.finish(null,{sequence:payload.sequence,senderId:event.senderId,elapsedMs,requestPayloadUtf8Bytes:current.requestPayloadUtf8Bytes});
    };
    api.on(prefix+"rtt-ack",listener);
    try {
      for(let sequence=0;sequence<20;sequence++){
        const payload={fixture:marker,sequence,value:42};
        samples.push(await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>pending?.finish(Error("RoundTripAckDeadline")),10000);
          pending={sequence,requestPayloadUtf8Bytes:JSON.stringify(payload).length,startedAt:performance.now(),finish(error,value){
            clearTimeout(timer);pending=null;if(error)reject(error);else resolve(value);
          }};
          try {api.sendTo(childId,prefix+"rtt-request",payload);}catch(error){pending?.finish(error);}
        }));
      }
      return {schemaVersion:1,iterations:20,requestChannel:prefix+"rtt-request",ackChannel:prefix+"rtt-ack",payloadTemplate:{fixture:marker,value:42},
        samples,clock:"main-frame performance.now",start:"Immediately before public ipcRenderer.sendTo",end:"Matching authenticated child ack listener callback",
        visibility:{documentHidden:document.hidden,visibilityState:document.visibilityState},serial:true,ackDeadlineMs:10000,descriptiveOnly:true,
        scope:"Current opaque main frame public sendTo -> hosted child -> public sendTo ack; excludes physical input, paint and independent native floating windows"};
    } finally {if(pending)pending.finish(Error("RoundTripMeasurementDisposed"));api.off(prefix+"rtt-ack",listener);}
  }
  async function basic(){
    const parentId=identity(), handle=window.utools.createBrowserWindow(page,{show:false}), replies=[];
    const listener=(event,payload)=>replies.push({senderId:event.senderId,payload});ipc().on(prefix+"reply",listener);
    try {
      await handle.ready;const childId=handle.webContents.id;
      const child=await handle.webContents.executeJavaScript(`(${childSetup.toString()})(${JSON.stringify(parentId)})`);
      if(!positive(parentId)||!positive(childId)||parentId===childId||child.id!==childId)throw Error("Hosted identity mismatch");
      const returnWasVoid=ipc().sendTo(childId,prefix+"parent",{senderId:-55,value:42},"second",7)===undefined;
      for(const channel of ["once","once","off","removed","barrier"])ipc().sendTo(childId,prefix+channel);
      await until(()=>replies.length===1,"Child reply missing");
      const seen=await until(async()=>{const state=await handle.webContents.executeJavaScript("window.__atoolsHostedIpcObservation");return state.barrier?state:null;},"Listener barrier missing");
      const roundTripMeasurement=await measureRoundTrips(childId);
      return {parentId,childId,roundTripMeasurement,childIdentityMatches:child.id===childId,positiveDistinctIds:true,returnWasVoid,
        parentToChildSenderAuthentic:seen.received.length===1&&seen.received[0].senderId===parentId,
        childToParentSenderAuthentic:replies[0].senderId===childId&&replies[0].payload.senderId===-77,
        allArgumentsPreserved:JSON.stringify(seen.received[0].args)===JSON.stringify([{senderId:-55,value:42},"second",7]),
        receivedParentPacket:seen.received[0],receivedChildPacket:replies[0],onceCount:seen.onceCount,offCount:seen.offCount,removedCount:seen.removedCount,childOpaque:child.origin==="null",childNoTauri:child.noTauri};
    } finally {ipc().off(prefix+"reply",listener);await handle.close();}
  }
  async function siblingNested(){
    const first=window.utools.createBrowserWindow(page,{show:false}),second=window.utools.createBrowserWindow(page,{show:false});
    const replies=[],listener=(event,payload)=>replies.push({senderId:event.senderId,payload});ipc().on(prefix+"nested-reply",listener);
    try {
      await Promise.all([first.ready,second.ready]);const mainId=identity(),firstId=first.webContents.id,secondId=second.webContents.id;
      await second.webContents.executeJavaScript(`window.__atoolsSiblingPackets=[];window.require('electron').ipcRenderer.on('${prefix}sibling',(event,...args)=>window.__atoolsSiblingPackets.push({senderId:event.senderId,args}));true`);
      await first.webContents.executeJavaScript(`window.require('electron').ipcRenderer.sendTo(${secondId},'${prefix}sibling','from-sibling',{senderId:-99});true`);
      const sibling=await until(async()=>{const value=await second.webContents.executeJavaScript("window.__atoolsSiblingPackets");return value.length===1?value[0]:null;},"Sibling packet missing");
      const nested=await first.webContents.executeJavaScript(`(async()=>{const handle=window.utools.createBrowserWindow('${page}',{show:false});window.__atoolsNestedHandle=handle;await handle.ready;return {creatorId:window.ztools.getWebContentsId(),id:handle.webContents.id,actualId:await handle.webContents.executeJavaScript('window.ztools.getWebContentsId()')};})()`);
      await first.webContents.executeJavaScript(`window.__atoolsNestedHandle.webContents.executeJavaScript("window.require('electron').ipcRenderer.sendTo(${mainId},'${prefix}nested-reply',{value:73});true")`);
      await until(()=>replies.length===1,"Nested reply missing");
      await first.webContents.executeJavaScript("window.__atoolsNestedHandle.close()");
      return {mainId,firstId,secondId,nestedId:nested.id,positiveDistinctIds:[mainId,firstId,secondId,nested.id].every(positive)&&new Set([mainId,firstId,secondId,nested.id]).size===4,
        siblingSenderAuthentic:sibling.senderId===firstId&&sibling.args[1].senderId===-99&&sibling.args[0]==="from-sibling",
        nestedCreatorMatches:nested.creatorId===firstId,nestedIdentityMatches:nested.actualId===nested.id,
        nestedToMainSenderAuthentic:replies[0].senderId===nested.id&&replies[0].payload.value===73,receivedSiblingPacket:sibling,receivedNestedPacket:replies[0]};
    } finally {ipc().off(prefix+"nested-reply",listener);await Promise.all([first.close(),second.close()]);}
  }
  async function lifecycle(){
    const old=window.utools.createBrowserWindow(page,{show:false});let replacement;
    const seen=[],listener=(event,value)=>seen.push({senderId:event.senderId,value});ipc().on(prefix+"lifecycle",listener);
    try {
      await old.ready;const oldId=old.webContents.id,mainId=identity();
      await old.webContents.executeJavaScript(`window.__atoolsOldDocumentMarker=true;window.require('electron').ipcRenderer.on('${prefix}old-only',()=>window.require('electron').ipcRenderer.sendTo(${mainId},'${prefix}lifecycle','stale-listener'));true`);
      await old.reload();
      const afterReload=await old.webContents.executeJavaScript("({id:window.ztools.getWebContentsId(),oldMarker:window.__atoolsOldDocumentMarker===true})");
      await old.webContents.executeJavaScript(`window.require('electron').ipcRenderer.on('${prefix}fresh',()=>window.require('electron').ipcRenderer.sendTo(${mainId},'${prefix}lifecycle','fresh-document'));true`);
      ipc().sendTo(oldId,prefix+"old-only");ipc().sendTo(oldId,prefix+"fresh");
      await until(()=>seen.some(item=>item.value==="fresh-document"),"Reloaded document fresh delivery missing");
      await old.close();replacement=window.utools.createBrowserWindow(page,{show:false});await replacement.ready;
      const newId=replacement.webContents.id;
      await replacement.webContents.executeJavaScript(`window.__atoolsClosedTargetDeliveries=0;window.require('electron').ipcRenderer.on('${prefix}closed',()=>window.__atoolsClosedTargetDeliveries++);true`);
      ipc().sendTo(oldId,prefix+"closed");
      await pause();await pause();
      const closedTargetDeliveries=await replacement.webContents.executeJavaScript("window.__atoolsClosedTargetDeliveries");
      return {oldId,newId,reloadIdStable:afterReload.id===oldId,reloadReplacedDocument:afterReload.oldMarker===false,
        oldListenersNotCopied:seen.every(item=>item.value!=="stale-listener"),freshSenderAuthentic:seen.every(item=>item.senderId===oldId),
        closedHandleDestroyed:old.isDestroyed(),newIdentityDistinct:positive(newId)&&newId!==oldId,closedTargetDeliveries,reloadedPackets:seen,
        observationBoundary:"Messages issued after confirmed reload/close only; no deterministic in-flight navigation race asserted"};
    } finally {ipc().off(prefix+"lifecycle",listener);if(!old.isDestroyed())await old.close();if(replacement)await replacement.close();}
  }
  function errorClass(failure){
    if(failure instanceof TypeError)return "TypeError";
    if(failure instanceof ReferenceError)return "ReferenceError";
    if(failure instanceof RangeError)return "RangeError";
    if(failure instanceof Error)return "Error";
    try{if(Object.prototype.toString.call(failure)==="[object Error]")return "Error";}catch{}
    return typeof failure==="string"?"StringThrown":failure===null?"NullThrown":"NonErrorThrown";
  }
  async function menuStage(step,knownErrorCode,action){
    let timer;
    try{return await Promise.race([Promise.resolve().then(action),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(Error("OriginalMenuStageDeadline")),8000);
    })]);}
    catch(failure){
      throw Object.assign(new Error("OriginalMenuFixtureFailure"),{
        fixtureDiagnostic:{step,errorClass:errorClass(failure),knownErrorCode}
      });
    }finally{clearTimeout(timer);}
  }
  async function originalMenu(){
    let original,handle;
    await menuStage("handle-create","ORIGINAL_MENU_CREATE_FAILED",()=>{
      original=new window.__AToolsReviewedContextMenuWindow();window.__atoolsOriginalMenu=original;
      original.create(40,50);handle=original.contextmenuWindow;
    });
    await menuStage("handle-validation","ORIGINAL_MENU_HANDLE_INVALID",()=>{
      if(!handle||typeof handle.then==="function")throw Error("OriginalMenuHandleInvalid");
    });
    await menuStage("ready","ORIGINAL_MENU_READY_REJECTED",()=>handle.ready);
    const parentId=identity(),childId=handle.webContents.id;
    const child=await menuStage("preload-execution","ORIGINAL_MENU_PRELOAD_EXECUTION_FAILED",()=>until(async()=>
      handle.webContents.executeJavaScript(`({id:window.ztools.getWebContentsId(),hasOriginalPreload:typeof window.ipcRenderer?.sendTo==='function'&&Number.isFinite(window.startPluginTime),menuText:document.getElementById('hidePile')?.innerText||document.getElementById('hidePile')?.textContent,origin:location.origin,noTauri:!('__TAURI_INTERNALS__' in window),query:location.search})`)
        .then(value=>value.hasOriginalPreload?value:null),"Original menu preload missing"));
    const handshakeParentId=await menuStage("handshake","ORIGINAL_MENU_HANDSHAKE_MISSING",()=>until(async()=>
      handle.webContents.executeJavaScript("typeof indexPageId==='undefined'?null:indexPageId")
        .then(value=>value===parentId?value:null),"Original menu handshake missing"));
    const clickChannel=prefix+"original-menu-click",clickMarker="atools-original-menu-click-v1";
    await menuStage("dom-click-arm","ORIGINAL_MENU_DOM_CLICK_ARM_FAILED",async()=>{
      const ack=await handle.webContents.executeJavaScript(`(function(){
        window.require('electron').ipcRenderer.once(${JSON.stringify(clickChannel)},function(event,marker){
          if(event.senderId!==${JSON.stringify(parentId)}||marker!==${JSON.stringify(clickMarker)})return;
          document.getElementById('hidePile').click();
        });
        return ${JSON.stringify(clickMarker)};
      })()`);
      if(ack!==clickMarker)throw Error("OriginalMenuClickArmAckInvalid");
    });
    await menuStage("dom-click-trigger","ORIGINAL_MENU_DOM_CLICK_TRIGGER_FAILED",()=>{
      ipc().sendTo(childId,clickChannel,clickMarker);
    });
    await menuStage("close","ORIGINAL_MENU_CLOSE_UNCONFIRMED",()=>until(()=>{
      const toggles=window.__AToolsMenuFixtureState.toggles;
      if(toggles.length>1||(toggles.length===1&&toggles[0]!==false))throw Error("OriginalMenuToggleInvalid");
      return toggles.length===1&&original.contextmenuWindow===null&&handle.isDestroyed();
    },"Original menu handler did not close"));
    return {parentId,childId,childIdentityMatches:child.id===childId,positiveDistinctIds:positive(parentId)&&positive(childId)&&parentId!==childId,
      handshakeParentMatches:handshakeParentId===parentId,originalChildPreloadExecuted:child.hasOriginalPreload,
      originalDomMenuText:child.menuText,originalToggleCalls:[...window.__AToolsMenuFixtureState.toggles],classClearedHandle:original.contextmenuWindow===null,
      actualChildDestroyed:handle.isDestroyed(),childOpaque:child.origin==="null",childNoTauri:child.noTauri,
      queryConfigurationVerified:false,actualChildSearch:child.query};
  }
  window.__AToolsHostedIpcFixture={perform(operation){
    if(operation==="hosted-ipc-basic")return basic();
    if(operation==="hosted-ipc-sibling-nested")return siblingNested();
    if(operation==="hosted-ipc-lifecycle")return lifecycle();
    if(operation==="original-context-menu")return originalMenu();
    throw Error("UnapprovedHostedIpcOperation");
  }};
})();
