import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const directory=new URL("../tests/fixtures/plugin-origin-smoke/",import.meta.url);
const inline=html=>[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join("\n");
const parentSource=inline(await readFile(new URL("parent.html",directory),"utf8"));
const childSource=inline(await readFile(new URL("child.html",directory),"utf8"));
for(const [name,source] of [["parent",parentSource],["child",childSource]]) {
  new vm.Script(source.replace("__ATOOLS_ORIGIN_CONFIG__","{}"),{filename:name+".html inline"});
}
const CHECKS=["originsNonOpaqueAndDistinct","originsMatchExpected","parentDomDenied","siblingDomDenied","noChildTauri",
  "nestedCloneWorks","html2canvasRendered","foreignWindowProxyStable","foreignOriginChanged","foreignRejectedByOldIdentity","parentPositiveControlWorks"];
const IDS=["a1","a2","b1"],ORIGINS=IDS.map(id=>"atools-origin://"+id),PARENT="atools-origin://parenthost";

/** Synthetic browser objects test the fixture's aggregation, never real origin enforcement, canvas pixels or native IPC. */
async function parentCase({origins=ORIGINS,expectedOrigins=ORIGINS,parentOrigin=PARENT,parentExpectedOrigin=PARENT,
  parentReadableChild,childReadableParent,storageAvailable=true,unknownSource=false}={}) {
  const runId="offline-aggregation-only",nonce="never-send-this-parent-nonce-to-children";
  const config={runId,reportNonce:nonce,parentExpectedOrigin,frames:IDS.map((id,index)=>({id,host:id,
    url:"atools-origin://"+id+"/index.html",expectedOrigin:expectedOrigins[index]}))};
  const nativeReports=[],nativeCalls=[],controls=[],documentReads=[],listeners=new Map();
  const deny={outcome:"denied",error:{name:"SyntheticSecurityError",message:"Mock observation, not real browser enforcement"}};
  const emit=(frame,phase,result,origin=origins[IDS.indexOf(frame.name)])=>listeners.get("message")({source:frame.contentWindow,origin,
    data:{kind:"atools-origin-probe",runId,id:frame.name,phase,result}});
  const initial=id=>({id,locationOrigin:origins[IDS.indexOf(id)],parentDocument:id===childReadableParent?{outcome:"accessible"}:deny,
    parentSecret:deny,parentReportNonce:deny,topDocument:deny,siblings:[{outcome:"denied"},{outcome:"denied"}],
    main:{noTauri:true},nestedBlank:{readWrite:true,noTauri:{noTauri:true}},storageWrite:{available:storageAvailable,value:"owned-by-"+id+":"+runId},
    canvas:{status:"rendered",actualWidth:128,actualHeight:48,pngBase64:"synthetic-not-a-real-PNG",pngBytes:20}});
  const document={querySelector:selector=>selector==="#status"?{set textContent(_value){}}:{append:frame=>queueMicrotask(()=>{
    if(unknownSource)listeners.get("message")({source:{unregistered:true},origin:origins[0],
      data:{kind:"atools-origin-probe",runId,id:"a1",phase:"initial",result:{forged:true}}});
    emit(frame,"initial",initial(frame.name));frame.loaded?.();
  })},createElement:()=>{
    const source={postMessage(message){
      controls.push(message);
      if(message.operation==="read-storage")emit(frame,"storage",{available:storageAvailable,reads:IDS.map(id=>({id,
        value:id===frame.name?"owned-by-"+id+":"+runId:null}))});
      else if(message.operation==="cleanup-storage")emit(frame,"cleanup",{removed:true,ownRead:null});
    }};
    Object.defineProperty(source,"document",{get(){
      documentReads.push(frame.name);
      if(frame.name===parentReadableChild)return {documentElement:{nodeName:"HTML"}};
      const error=new Error("Synthetic parent-to-child access rejection");error.name="SyntheticSecurityError";throw error;
    }});
    const frame={name:"",contentWindow:source,setAttribute(){},addEventListener(kind,callback){if(kind==="load")frame.loaded=callback;},
      set src(value){frame.url=value;if(value.endsWith("/foreign.html"))queueMicrotask(()=>{
        emit(frame,"foreign",{locationOrigin:origins[2],main:{noTauri:true}},origins[2]);frame.loaded?.();
      });}};
    return frame;
  }};
  const window={addEventListener:(kind,callback)=>listeners.set(kind,callback),__TAURI_INTERNALS__:{invoke:async(command,args)=>{
    nativeCalls.push(command);
    if(command==="poc_benign_counter"){assert.deepEqual(JSON.parse(JSON.stringify(args)),{caseId:"parent-positive"});return 1;}
    assert.equal(command,"origin_probe_report");nativeReports.push(args);
  }}};
  vm.runInNewContext(parentSource.replace("__ATOOLS_ORIGIN_CONFIG__",JSON.stringify(config)),{window,document,
    location:{origin:parentOrigin,host:"parenthost"},performance,setTimeout,clearTimeout,TextEncoder,URL,Uint32Array,
    crypto:{getRandomValues:array=>{array.fill(7);return array;}},queueMicrotask});
  const end=Date.now()+1500;
  while(nativeReports.length===0&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(nativeReports.length,1,"Fixture must report once through the trusted native API");
  assert.deepEqual(nativeCalls,["poc_benign_counter","origin_probe_report"]);
  const report=JSON.parse(JSON.stringify(nativeReports[0].report));
  assert.equal(nativeReports[0].nonce,nonce);assert.equal(report.productionReady,false);
  assert.deepEqual(Object.keys(report.checks).sort(),[...CHECKS].sort());
  assert.equal(Object.values(report.checks).every(value=>typeof value==="boolean"),true);
  assert.equal(controls.some(message=>JSON.stringify(message).includes(nonce)),false);
  assert.deepEqual(documentReads,IDS,"Parent must actually attempt every child's current document after initial results");
  assert.equal(report.foreignNavigation.windowProxyUnchanged,true);
  assert.equal(report.loads.every(load=>load.registryRebound===false),true);
  return report;
}

const positive=await parentCase({unknownSource:true});
assert.equal(Object.values(positive.checks).every(value=>value===true),true);
assert.equal(positive.classifications.parentAndChildLocationOrigins.length,4);
assert.equal(positive.messages.some(message=>message.sourceId===null&&message.acceptedByIdentityOrigin===false),true);
assert.equal(positive.children.some(child=>child.initial.forged),false,"An unknown source cannot occupy a configured child's result");
assert.equal(positive.parent.childDocumentReads.every(read=>read.outcome==="denied"),true);

const nullParent=await parentCase({parentOrigin:"null"});
assert.equal(nullParent.checks.originsNonOpaqueAndDistinct,false);assert.equal(nullParent.checks.originsMatchExpected,false);
const sharedParent=await parentCase({parentOrigin:ORIGINS[0],parentExpectedOrigin:ORIGINS[0]});
assert.equal(sharedParent.checks.originsNonOpaqueAndDistinct,false);assert.equal(sharedParent.checks.originsMatchExpected,true);
const mismatchedParent=await parentCase({parentOrigin:"atools-origin://unexpected-parent"});
assert.equal(mismatchedParent.checks.originsNonOpaqueAndDistinct,true);assert.equal(mismatchedParent.checks.originsMatchExpected,false);
const readableChild=await parentCase({parentReadableChild:"a2"});
assert.equal(readableChild.checks.parentDomDenied,false);
assert.equal(readableChild.children.find(child=>child.id==="a2").parentReadChildDocument.outcome,"accessible");
const readableParent=await parentCase({childReadableParent:"a1"});assert.equal(readableParent.checks.parentDomDenied,false);
const opaque=await parentCase({origins:["null","null","null"],expectedOrigins:["null","null","null"],parentOrigin:"null",parentExpectedOrigin:"null"});
assert.equal(opaque.checks.originsNonOpaqueAndDistinct,false);assert.equal(opaque.foreignNavigation.oldRegistryAccepted,true);
assert.equal(opaque.checks.foreignOriginChanged,false);assert.equal(opaque.checks.foreignRejectedByOldIdentity,false);
assert.equal(opaque.classifications.originBoundaryCandidate,false);
const mismatch=await parentCase({origins:["null","null","null"]});assert.equal(mismatch.checks.originsMatchExpected,false);
assert.equal(mismatch.children.every(child=>child.registryAccepted===false),true);
const noStorage=await parentCase({storageAvailable:false});assert.equal(noStorage.classifications.storage,"unavailable-or-incomplete");

const rawBody=childSource.slice(childSource.indexOf("function rawIpc()"),childSource.indexOf("async function nestedBlank()"));
const sent=[];
const raw=vm.runInNewContext("("+rawBody+")()",{config:{id:"a1"},window:{webkit:{messageHandlers:{ipc:{
  postMessage:value=>sent.push(JSON.parse(value)),
}}}},errorInfo:error=>({message:String(error)})});
assert.equal(raw.channelPresent,true);assert.equal(sent.length,2);
assert.deepEqual(sent.map(value=>value.payload.caseId),["a1-wrong-key","a1-missing-key"]);
assert.equal(sent[0].__TAURI_INVOKE_KEY__,"poc-invalid-invoke-key");assert.equal(Object.hasOwn(sent[1],"__TAURI_INVOKE_KEY__"),false);
assert.equal(sent.every(value=>value.cmd==="poc_benign_counter"&&value.callback===2147483001&&value.error===2147483002
  &&value.options.customProtocolIpcBlocked===true),true);
console.log("Plugin origin fixture offline checks passed: syntax; exact 11 bools; parent+three-child origins; real read-attempt branches in both directions; null/shared/mismatch failures; source identity; nonce containment; foreign proxy predicate; unavailable storage; exact wrong/missing-key packet shapes. Synthetic aggregation only, no GUI/native IPC/original canvas rendering.");
