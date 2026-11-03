import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { parsePageNavigationProbeOptions, createPageNavigationSyntheticPlugins, validatePageNavigationOutcome, validateWorkerPolicyEvidence } from "./probe-plugin-page-navigation-native.mjs";

const source=await readFile(new URL("../tests/components/nativePluginPageNavigationFrameProbe.js",import.meta.url),"utf8");
const origin="atools-page://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.localhost",rawAsset=origin+"/assets/revoked.html";
function probe(){
  const replies=[],posts=[],navigations=[],timers=[],listeners=new Set(),parent={postMessage:value=>replies.push(value)};
  const location={href:origin+"/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/bootstrap.html",
    replace:url=>navigations.push(["replace",url]),reload:()=>navigations.push(["reload",location.href])};
  const document={title:"合成导航探针",documentElement:{dataset:{syntheticReady:"true",syntheticDataRoundtrip:"true"}},
    head:{append:meta=>navigations.push(["meta",meta.httpEquiv,meta.content])},createElement:()=>({})};
  const window={top:{},parent,addEventListener:(name,handler)=>{assert.equal(name,"message");listeners.add(handler);},
    removeEventListener:(name,handler)=>{assert.equal(name,"message");listeners.delete(handler);},
    open:(url,target)=>navigations.push(["open",url,target]),
    __ATOOLS_FRAME_TRANSPORT__:{post:value=>{posts.push(value);return true;}}};
  const context=vm.createContext({window,parent,document,location,history:{replaceState:(_state,_unused,url)=>{
    navigations.push(["history",url]);location.href=new URL(url,location.href).href;}},
    URL,Map,Error,Object,setTimeout:handler=>{timers.push(handler);return timers.length;}});
  const reinstall=()=>{vm.runInContext(source,context);assert.equal(listeners.size,1,"Explicit reinjection installs exactly one live handler");};
  reinstall();reinstall();
  return {replies,posts,navigations,timers,reinstall,listeners,
    documentOpenClearsListeners(){listeners.clear();},
    send:async(operation,id="case")=>{for(const handler of [...listeners])await handler({source:parent,
      data:{kind:"atools-page-navigation-probe",token:"__ATOOLS_PANEL_TOKEN__",id,operation}});}};
}

let fixture=probe();await fixture.send("pending-permission");
fixture.documentOpenClearsListeners();fixture.reinstall();
await fixture.send("pending-permission");await fixture.send("pending-permission","second-permission");
assert.equal(fixture.posts.length,1,"Reinjection and repeated requests do not replay the real permission transport");
assert.deepEqual(JSON.parse(JSON.stringify(fixture.posts[0])),{__atools_permission_request__:true,reqId:6001,
  permission:"clipboard.write",pluginId:"file-tree",featureCode:"page-navigation"});
const expected={"nav-replace":[["replace",rawAsset]],"nav-reload":[["reload",origin+"/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/bootstrap.html"]],
  "nav-meta":[["meta","refresh","0;url="+rawAsset]],"nav-self-blank":[["open","about:blank","_self"]],
  "nav-history":[["history","/logical-route?padding="+"x".repeat(10000)],["replace",rawAsset]]};
for(const [operation,actions] of Object.entries(expected)){
  fixture=probe();await fixture.send(operation);
  fixture.documentOpenClearsListeners();fixture.reinstall();
  await fixture.send(operation);assert.equal(fixture.timers.length,1,"A repeated request ID must not schedule navigation twice after document.open");
  fixture.timers[0]();assert.deepEqual(fixture.navigations,actions,"The actual browser API receives the reviewed URL kind: "+operation);
  assert.equal(fixture.posts.length,0,"A navigation action must not request any additional host capability");
  if(operation==="nav-history"){
    const longHistory=fixture.navigations[0][1];
    assert.ok(longHistory.length>8192,"The executed history path exceeds the native full-URL observation budget");
    assert.match(longHistory,/^\/logical-route\?padding=x{10000}$/u,"The real history call receives exactly the reviewed private padding");
    assert.deepEqual(fixture.navigations[1],["replace",rawAsset],"A long logical route still navigates to the fixed raw-asset origin");
  }
  await fixture.send("nav-replace","second-navigation");assert.match(fixture.replies.at(-1).error,/already triggered/);
  assert.equal(fixture.timers.length,1);
}
fixture=probe();await fixture.send("nav-unreviewed");assert.match(fixture.replies.at(-1).error,/Unreviewed/);assert.equal(fixture.timers.length,0);

async function workerFixture({behavior="blocked",sharedAvailable=true,nativeAvailable=true,preservedNative=true}={}){
  const targets=[],workers=[],ports=[],activeUrls=new Map(),activeTimers=new Set(),scriptTexts=[],calls=[],errorsPrevented=[];
  class Target {
    listeners=new Map();
    constructor(){targets.push(this);}
    addEventListener(name,handler){if(!this.listeners.has(name))this.listeners.set(name,new Set());this.listeners.get(name).add(handler);}
    removeEventListener(name,handler){this.listeners.get(name)?.delete(handler);}
    dispatch(name,event){for(const handler of [...(this.listeners.get(name)||[])])handler(event);}
  }
  const document=Object.assign(new Target(),{title:"synthetic worker test",documentElement:{dataset:{}}});
  const parent={postMessage:value=>replies.push(value)},replies=[],window=Object.assign(new Target(),{top:{},parent});
  let urlSequence=0,timerSequence=0;
  class PrivateURL extends URL {
    static createObjectURL(blob){assert.ok(blob instanceof Blob);const url="blob:synthetic-private/"+(++urlSequence);activeUrls.set(url,blob);return url;}
    static revokeObjectURL(url){assert.ok(activeUrls.delete(url),"Each owned Blob URL is revoked once");}
  }
  function construct(kind,url){
    assert.ok(activeUrls.has(url));calls.push(kind);
    const policy=()=>document.dispatch("securitypolicyviolation",{effectiveDirective:"worker-src",blockedURI:url});
    if(behavior==="throwing"){queueMicrotask(policy);throw Object.assign(Error("Actual native constructor CSP refusal"),{name:"SecurityError"});}
    const worker=Object.assign(new Target(),{terminated:false,terminate(){this.terminated=true;}});workers.push({kind,worker});
    let receiver=worker;
    if(kind==="shared"){
      const port=Object.assign(new Target(),{closed:false,started:false,start(){this.started=true;},close(){this.closed=true;}});
      worker.port=port;ports.push(port);receiver=port;
    }
    queueMicrotask(async()=>{
      if(behavior==="blocked"){
        policy();worker.dispatch("error",{type:"error",error:{name:"SecurityError"},preventDefault(){errorsPrevented.push(worker);}});
      } else if(behavior==="executed"){
        const text=await activeUrls.get(url).text();scriptTexts.push(text);
        const self={postMessage:data=>receiver.dispatch("message",{data})};
        vm.runInNewContext(text,{self});
        if(kind==="shared")self.onconnect({ports:[{postMessage:self.postMessage}]});
      }
    });
    return worker;
  }
  function NativeWorker(url,options){return construct(options?.type==="module"?"module":"classic",url);}
  if(nativeAvailable){
    if(preservedNative){window.__atoolsNativeWorker=NativeWorker;window.Worker=function(){throw Error("Compatibility shim must not be called");};}
    else window.Worker=NativeWorker;
  }
  if(sharedAvailable)window.SharedWorker=function(url){return construct("shared",url);};
  const context=vm.createContext({window,parent,document,location:{href:origin+"/bootstrap.html"},URL:PrivateURL,Blob,Map,Error,Object,
    setTimeout:handler=>{const id=++timerSequence;activeTimers.add(id);setImmediate(handler);return id;},
    clearTimeout:id=>{assert.ok(activeTimers.delete(id),"Each worker timeout is cleared");}});
  vm.runInContext(source,context);
  const send=async id=>{for(const handler of [...window.listeners.get("message")])await handler({source:parent,
    data:{kind:"atools-page-navigation-probe",token:"__ATOOLS_PANEL_TOKEN__",id,operation:"worker-policy"}});};
  await Promise.all([send("worker-policy"),send("worker-policy"),send("worker-policy-concurrent-id")]);
  await send("worker-policy-second-id");
  assert.equal(replies.length,3,"An in-flight duplicate ID is ignored while different IDs share exactly one worker-policy operation");
  const result=JSON.parse(JSON.stringify(replies.at(-1).state.workerPolicy));
  assert.equal(activeUrls.size,0);assert.equal(activeTimers.size,0);
  for(const target of targets)for(const [name,handlers] of target.listeners)if(target!==window||name!=="message")assert.equal(handlers.size,0,"All owned policy, message and error listeners are removed");
  for(const {kind,worker} of workers)if(kind!=="shared")assert.equal(worker.terminated,true);
  for(const port of ports)assert.equal(port.closed,true);
  assert.equal(new Set(calls).size,calls.length,"Repeated worker-policy requests cannot construct duplicate workers");
  assert.ok(errorsPrevented.every(target=>workers.some(({worker})=>worker===target)),"Only errors from test-owned objects are prevented");
  return {result,calls,scriptTexts};
}
const blocked=await workerFixture(),positiveWorkerProof=blocked.result;
assert.equal(validateWorkerPolicyEvidence(positiveWorkerProof),true);assert.deepEqual(blocked.calls,["classic","module","shared"]);
for(const value of positiveWorkerProof.probes){assert.equal(value.status,"csp-blocked");assert.equal(value.cleanup.complete,true);}
const throwing=await workerFixture({behavior:"throwing"});assert.equal(validateWorkerPolicyEvidence(throwing.result),true);
assert.ok(throwing.result.probes.every(value=>value.constructionErrorName==="SecurityError"&&!value.workerCreated));
const fallback=await workerFixture({sharedAvailable:false,preservedNative:false});assert.equal(validateWorkerPolicyEvidence(fallback.result),true);
assert.equal(fallback.result.probes[2].status,"unavailable");assert.equal(fallback.result.probes[2].attempted,false);
const silent=await workerFixture({behavior:"silent"});assert.throws(()=>validateWorkerPolicyEvidence(silent.result),/actual worker-src/);
const executed=await workerFixture({behavior:"executed"});assert.equal(executed.scriptTexts.length,3);
assert.ok(executed.result.probes.every(value=>value.scriptExecuted));assert.throws(()=>validateWorkerPolicyEvidence(executed.result),/script executed/);
const absent=await workerFixture({nativeAvailable:false,sharedAvailable:false});assert.throws(()=>validateWorkerPolicyEvidence(absent.result),/actual worker-src/);

const operations=Object.keys(expected),kinds=["raw-asset","bootstrap","raw-asset","about-blank","raw-asset"];
function completeEvidence(){return {passed:true,policy:"revoke",pageDocumentMode:true,originalSourcesUnchanged:true,temporaryDataRemoved:true,
  pageDocumentsAfterCleanup:0,resourceLeasesAfterCleanup:0,dataRuntimeDrained:true,pathRuntimeDrained:true,dialogRuntimeDrained:true,
  allTaskRunsTerminal:true,nativeRevokeVerified:true,observations:{workerPolicy:{...JSON.parse(JSON.stringify(positiveWorkerProof)),eventOrigin:origin},cases:operations.map((operation,index)=>({operation,expectedRequestedKind:kinds[index],
    identity:{pageDocumentSimpleId:String(index).repeat(32),origin},initialFrame:{eventOrigin:origin,state:{syntheticDataRoundtrip:true,noTauri:true}},
    nestedBlank:{state:{nestedBlankProof:{documentWriteRead:true}}},pendingPermission:{permission:"clipboard.write",approved:false,systemApiInvoked:false},
    closedRuntime:{pageDocuments:0,dataSessions:0,dataTransport:false},previousSequence:0,
    nativeEvents:[{matchedPageDocumentId:String(index).repeat(32),requestedKind:kinds[index],sequence:1,activeBefore:true,revoked:true,beforeDelegateForward:true}]})),
    finalNativeSnapshot:{enabled:true,installed:true,policy:"revoke",droppedEvents:0}}};}
assert.equal(validatePageNavigationOutcome(completeEvidence()).nativeRevokeVerified,true);
let missingWorkerEvidence=completeEvidence();delete missingWorkerEvidence.observations.workerPolicy;
assert.throws(()=>validatePageNavigationOutcome(missingWorkerEvidence),/worker policy evidence/);
missingWorkerEvidence=completeEvidence();missingWorkerEvidence.observations.workerPolicy.probes[0].scriptExecuted=true;
assert.throws(()=>validatePageNavigationOutcome(missingWorkerEvidence),/script executed/);
for(const index of operations.keys()){
  const evidence=completeEvidence();evidence.observations.cases[index].nativeEvents[0].requestedKind="wrong-kind";
  assert.throws(()=>validatePageNavigationOutcome(evidence),/revoke-before-delegate/,"Unrelated native navigation must not satisfy this case");
}
let evidence=completeEvidence();evidence.observations.cases[0].nativeEvents[0].beforeDelegateForward=false;
assert.throws(()=>validatePageNavigationOutcome(evidence),/revoke-before-delegate/);
evidence=completeEvidence();evidence.policy="observe";evidence.nativeRevokeVerified=false;evidence.observations.finalNativeSnapshot.policy="observe";
evidence.observations.cases.forEach(value=>value.nativeEvents=[]);
assert.equal(validatePageNavigationOutcome(evidence,{observeNavigation:true}).nativeRevokeVerified,false);
evidence.nativeRevokeVerified=true;assert.throws(()=>validatePageNavigationOutcome(evidence,{observeNavigation:true}),/disagrees/);
assert.throws(()=>validatePageNavigationOutcome({passed:true}));
assert.equal(parsePageNavigationProbeOptions([]).observeNavigation,false);
assert.equal(parsePageNavigationProbeOptions(["--observe-navigation"]).observeNavigation,true);
assert.throws(()=>parsePageNavigationProbeOptions(["--observe-navigation","--observe-navigation"]));
assert.throws(()=>parsePageNavigationProbeOptions(["--output","/tmp/same","--checkpoint","/tmp/same"]));
const root=await mkdtemp("/private/tmp/atools-page-navigation-unit-");
try {
  const plugins=await createPageNavigationSyntheticPlugins(root);
  for(const id of ["char-transform","file-tree"]){const manifest=JSON.parse(await readFile(join(plugins,id,"plugin.json"),"utf8"));
    assert.equal(manifest.preload,undefined);assert.equal(manifest.main,"index.html");assert.deepEqual(manifest.permissions,[]);
    assert.equal(manifest.syntheticFixture.originalPackageContent,false);}
  const html=await readFile(join(plugins,"file-tree/index.html"),"utf8");
  assert.match(html,/window\.ztools\.dbStorage\.setItem/);assert.match(html,/window\.ztools\.dbStorage\.getItem/);
  assert.doesNotMatch(html,/fetch\(|require\(|clipboard|showOpenDialog|showSaveDialog/);
} finally {await rm(root,{recursive:true,force:true});}
console.log("Offline page navigation fixture passed: document.open reinjection, exact navigation URLs, real CSP-event worker probe simulation, full owned-resource cleanup, execution/missing-event rejection, evidence kinds and synthetic packages. No native WebView or OS APIs executed.");
