import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { MessageChannel } from "node:worker_threads";

const directory=new URL("../tests/fixtures/plugin-bootstrap-smoke/",import.meta.url),sources={};
for(const name of ["parent","bootstrap","payload","opaque"]) {
  const html=await readFile(new URL(name+".html",directory),"utf8");
  assert.ok(Buffer.byteLength(html)<128*1024);
  sources[name]=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match=>match[1]).join("\n");
  assert.equal(sources[name].split("__ATOOLS_BOOTSTRAP_CONFIG__").length,2);
  new vm.Script(sources[name].replace("__ATOOLS_BOOTSTRAP_CONFIG__","{}"),{filename:name+" inline"});
}
const instantiate=(name,config)=>sources[name].replace("__ATOOLS_BOOTSTRAP_CONFIG__",JSON.stringify(config).replaceAll("<","\\u003c"));
const begin=sources.parent.indexOf("function createIdentityGate("),end=sources.parent.indexOf("/* GATE-END */");
assert.ok(begin>=0&&end>begin);
const createGate=vm.runInNewContext("("+sources.parent.slice(begin,end).trim()+")");
const RUN="offline-bootstrap-only",PARENT="atools-origin://parent",A="atools-origin://a",B="atools-origin://b";
const normalize=value=>JSON.parse(JSON.stringify(value));
const channels=[];
function channel(){const value=new MessageChannel();channels.push(value);value.port1.unref();value.port2.unref();return value;}
async function until(read,label){const end=Date.now()+1200;while(Date.now()<end){const result=read();if(result)return result;await new Promise(resolve=>setTimeout(resolve,2));}throw Error(label);}
const settle=()=>new Promise(resolve=>setTimeout(resolve,15));

function bootstrapFixture() {
  const messages=[],writes=[],listeners=new Map(),timers=new Map();let timerId=0;
  const parent={postMessage:(data,origin)=>messages.push({data,origin})};
  const window={parent,addEventListener:(kind,callback)=>listeners.set(kind,callback)};
  const context=vm.createContext({window,crypto:{getRandomValues:array=>{array.fill(7);return array;}},Uint8Array,TextEncoder,
    setTimeout:callback=>{timers.set(++timerId,callback);return timerId;},clearTimeout:id=>timers.delete(id),
    document:{open(){},write:html=>writes.push(html),close(){}}});
  vm.runInContext(instantiate("bootstrap",{runId:RUN,id:"a",parentOrigin:PARENT}),context);
  const hello=messages[0].data;
  function offer(ports,changes={},eventChanges={}) {
    listeners.get("message")({source:parent,origin:PARENT,ports,data:{kind:"atools-bootstrap-offer",runId:RUN,id:"a",docNonce:hello.docNonce,generation:1,...changes},...eventChanges});
  }
  return {window,parent,messages,writes,timers,hello,offer};
}

try {
  const source={},nonce="a".repeat(32),hello={kind:"atools-bootstrap-hello",runId:RUN,id:"a",docNonce:nonce};
  const event={source,origin:A,data:hello};
  for(const changed of [{source:{}},{origin:B},{data:{...hello,runId:"other"}},{data:{...hello,id:"b"}},
    {data:{...hello,docNonce:"wrong"}}]) {
    const gate=createGate({runId:RUN,id:"a",expectedOrigin:A,source});
    assert.equal(gate.hello({...event,...changed}),false);assert.equal(gate.snapshot().phase,"awaiting-hello");
  }
  const gate=createGate({runId:RUN,id:"a",expectedOrigin:A,source});assert.equal(gate.hello(event),true);
  assert.equal(gate.hello(event),false,"A duplicate hello must never replace the captured nonce");
  let closed=0;gate.attachPort({close:()=>closed++});
  const ack={kind:"atools-bootstrap-ack",...gate.binding()};
  for(const changed of [{docNonce:"b".repeat(32)},{generation:0},{generation:2},{runId:"other"},{id:"b"},{kind:"wrong"}])assert.equal(gate.ack({...ack,...changed}),false);
  assert.equal(gate.ack(ack),true);assert.equal(gate.ack(ack),false);assert.equal(gate.snapshot().deliveries,1);
  const payload={kind:"atools-bootstrap-result",...gate.binding(),result:{}};
  assert.equal(gate.payload({source,origin:A,data:{...payload,docNonce:"b".repeat(32)}}),false);
  assert.equal(gate.payload({source,origin:A,data:{...payload,generation:2}}),false);
  assert.equal(gate.payload({source,origin:B,data:payload}),false);
  assert.equal(gate.payload({source:{},origin:A,data:payload}),false);
  assert.equal(gate.payload({source,origin:A,data:payload}),true);assert.equal(gate.payload({source,origin:A,data:payload}),false);
  assert.equal(gate.invalidate(),true);assert.equal(closed,1);
  assert.equal(gate.ack(ack),false);assert.equal(gate.payload({source,origin:A,data:payload}),false);assert.equal(gate.hello(event),false);

  const bootstrap=bootstrapFixture(),wire=channel();
  const actualGate=createGate({runId:RUN,id:"a",expectedOrigin:A,source:bootstrap.window});
  assert.equal(actualGate.hello({source:bootstrap.window,origin:A,data:bootstrap.hello}),true);
  actualGate.attachPort(wire.port1);
  const secretHtml="<p>synthetic endpoint and marker bytes travel only on this port</p>";
  let ackCount=0;
  wire.port1.onmessage=received=>{
    if(actualGate.ack(received.data)){ackCount++;wire.port1.postMessage({kind:"atools-bootstrap-payload-html",...actualGate.binding(),html:secretHtml});}
  };wire.port1.start();bootstrap.offer([wire.port2]);
  await until(()=>bootstrap.writes.length===1,"Actual MessageChannel handshake did not deliver");
  assert.equal(ackCount,1);assert.equal(bootstrap.writes[0],secretHtml);
  assert.deepEqual(Object.keys(bootstrap.window.__ATOOLS_BOOTSTRAP_HANDOFF__).sort(),["docNonce","generation","id","runId"]);
  assert.equal(Object.isFrozen(bootstrap.window.__ATOOLS_BOOTSTRAP_HANDOFF__),true);
  assert.equal(bootstrap.messages.some(message=>JSON.stringify(message).includes(secretHtml)),false,"HTML must never enter a window offer/hello message");

  for(const changes of [{data:{docNonce:"bad"}},{data:{generation:0}},{data:{runId:"other"}},{data:{id:"b"}},
    {event:{origin:B}},{event:{source:{}}},{ports:0},{ports:2}]) {
    const rejected=bootstrapFixture(),wires=[channel(),channel()],portCount=changes.ports??1,acks=[];
    for(const value of wires){value.port1.onmessage=event_=>acks.push(event_.data);value.port1.start();}
    rejected.offer(wires.slice(0,portCount).map(value=>value.port2),changes.data,changes.event);
    await settle();assert.equal(acks.length,0);assert.equal(rejected.writes.length,0);
  }
  const expired=bootstrapFixture();for(const callback of [...expired.timers.values()])callback();
  const expiredWire=channel(),expiredAcks=[];expiredWire.port1.onmessage=event_=>expiredAcks.push(event_.data);expiredWire.port1.start();
  expired.offer([expiredWire.port2]);await settle();assert.equal(expired.writes.length,0);assert.equal(expiredAcks.length,0);
  const raced=bootstrapFixture(),raceWire=channel(),raceGate=createGate({runId:RUN,id:"a",expectedOrigin:A,source:raced.window});
  raceGate.hello({source:raced.window,origin:A,data:raced.hello});raceGate.attachPort(raceWire.port1);
  raceWire.port1.onmessage=event_=>{if(raceGate.ack(event_.data))raceWire.port1.postMessage({kind:"atools-bootstrap-payload-html",...raceGate.binding(),html:"must-not-deliver"});};
  raceWire.port1.start();raced.offer([raceWire.port2]);raceGate.invalidate();await settle();
  assert.equal(raced.writes.length,0,"An ack queued before generation invalidation must not deliver HTML");
  assert.equal(raceGate.snapshot().deliveries,0);
  for(const [changes,errorCode] of [[{docNonce:"wrong"},"BOOTSTRAP_PORT_BINDING_REJECTED"],
    [{html:"é".repeat(64*1024+1)},"BOOTSTRAP_HTML_BUDGET_REJECTED"]]) {
    const rejected=bootstrapFixture(),wire_=channel();
    wire_.port1.onmessage=received=>wire_.port1.postMessage({...received.data,
      kind:"atools-bootstrap-payload-html",html:"small synthetic HTML",...changes});
    wire_.port1.start();rejected.offer([wire_.port2]);
    await until(()=>rejected.messages.some(message=>message.data.code===errorCode),"Bootstrap did not report its bounded static rejection");
    assert.equal(rejected.writes.length,0);assert.equal(rejected.timers.size,0);
    wire_.port1.postMessage({kind:"atools-bootstrap-payload-html",runId:RUN,id:"a",docNonce:rejected.hello.docNonce,
      generation:1,html:"must not recover after a rejected payload"});
    await settle();assert.equal(rejected.writes.length,0,"A fatal binding/budget error must remain closed to later valid HTML");
  }

  async function payloadCase(mode="ok",foreignMode="error") {
    const posts=[],requests=[],marker={textContent:""};
    const config={runId:RUN,id:"a",parentOrigin:PARENT,expectedOrigin:A,endpoint:"http://127.0.0.1:1234/host/"+"a".repeat(64),
      foreignEndpoint:"http://127.0.0.1:1234/host/"+"b".repeat(64),marker:"synthetic-private-marker"};
    class Xhr {
      status=0;responseText="";headers={};
      open(method,endpoint,async_){this.method=method;this.endpoint=endpoint;this.async_=async_;}
      setRequestHeader(name,value){this.headers[name]=value;}
      send(body){const data=JSON.parse(body);requests.push({async:this.async_,headers:this.headers,endpoint:this.endpoint,...data});
        const complete=()=>{
          if(data.phase==="foreign"){this.status=0;if(foreignMode==="timeout")this.ontimeout?.();else this.onerror?.();return;}
          this.status=200;const result={id:data.id,phase:data.phase};
          this.responseText=mode==="invalidJson"?"{":JSON.stringify(mode==="naked"?result:{ok:mode!=="okFalse",result:mode==="wrongResult"?{id:"b",phase:data.phase}:result});
          this.onload?.();
        };
        if(this.async_)queueMicrotask(complete);else complete();
      }
    }
    const binding={runId:RUN,id:"a",docNonce:"c".repeat(32),generation:1};
    const window={__ATOOLS_BOOTSTRAP_HANDOFF__:binding,parent:{postMessage:data=>posts.push(data)}};
    vm.runInNewContext(instantiate("payload",config),{window,document:{querySelector:()=>marker},location:{origin:A},XMLHttpRequest:Xhr,
      setTimeout,clearTimeout,queueMicrotask});
    await until(()=>posts.length===3,"Payload did not send its two binding negatives and actual result");
    assert.notEqual(posts[0].docNonce,binding.docNonce);assert.equal(posts[1].generation,2);assert.equal(posts[2].docNonce,binding.docNonce);
    const accepting=createGate({runId:RUN,id:"a",expectedOrigin:A,source:window});
    accepting.hello({source:window,origin:A,data:{kind:"atools-bootstrap-hello",...binding}});accepting.attachPort({close(){}});
    accepting.ack({kind:"atools-bootstrap-ack",...binding});
    assert.deepEqual(posts.map(data=>accepting.payload({source:window,origin:A,data})),[false,false,true]);
    assert.deepEqual(requests.map(request=>[request.phase,request.async,request.headers["Content-Type"]]),[
      ["sync",false,"text/plain"],["async",true,"application/json"],["foreign",true,"text/plain"]]);
    const result=normalize(posts[2].result);
    assert.equal(JSON.stringify(result).includes(config.endpoint),false);assert.equal(JSON.stringify(result).includes(config.marker),false);
    return result;
  }
  const goodPayload=await payloadCase();assert.equal(goodPayload.syncOk,true);assert.equal(goodPayload.asyncOk,true);assert.equal(goodPayload.foreignDenied,true);
  assert.equal(goodPayload.markerReceived,true);assert.equal(goodPayload.noTauri,true);
  for(const mode of ["naked","okFalse","wrongResult","invalidJson"]){const bad=await payloadCase(mode);assert.equal(bad.syncOk,false);assert.equal(bad.asyncOk,false);}
  assert.equal((await payloadCase("ok","timeout")).foreignDenied,false,"A timeout is never evidence that Origin gating rejected a request");
  console.log("Bootstrap fixture offline checks passed: four inline scripts parse; real MessageChannel ack/HTML handoff; wrong source/origin/nonce/generation/port-count rejection; duplicate/stale gate and queued-ack invalidation races; actual payload emits two rejected binding messages then one accepted result; real BridgeServer envelope, sync/plain and async/JSON semantics, timeout is not denial. No GUI, native HTTP or production execution.");
} finally {
  for(const wire of channels){wire.port1.close();wire.port2.close();}
}
