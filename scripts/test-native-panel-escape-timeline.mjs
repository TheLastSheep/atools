import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { deriveEscapeTimelineMetrics, ESCAPE_TIMING_SCHEMA } from "./lib/native-panel-escape-timeline.mjs";

const source=await readFile(new URL("../tests/components/nativePluginFrameProbe.js",import.meta.url),"utf8");
const expected={requestToFrameReceiptTraceObservedMs:3,frameKeydownDispatchMs:2,
  afterKeydownTraceToBridgeObservedMs:4,bridgeToPanelRemovedObservedMs:2,bridgeToFocusRestoredObservedMs:3};
for(const frameTimeOriginMs of [100,2000000]) {
  const listeners=new Map(),messages=[],times=[5,6,8],dispatched=[];
  const parent={postMessage:message=>messages.push(message)};
  const document={title:"Synthetic frame",body:{innerText:"",scrollWidth:100},scripts:[],styleSheets:[],
    activeElement:{tagName:"TEXTAREA",dispatchEvent:event=>dispatched.push(event.key)},visibilityState:"visible",
    hasFocus:()=>true,querySelectorAll:()=>[],querySelector:()=>null};
  const window={top:{},parent,addEventListener:(kind,callback)=>listeners.set(kind,callback)};
  const context=vm.createContext({window,document,location:{origin:"null"},innerWidth:100,
    performance:{timeOrigin:frameTimeOriginMs,now:()=>times.shift()},
    KeyboardEvent:class {constructor(_name,options){Object.assign(this,options);this.defaultPrevented=false;}}});
  vm.runInContext(source,context);
  await listeners.get("message")({source:parent,data:{token:"__ATOOLS_PANEL_TOKEN__",kind:"atools-panel-probe",
    id:4,operation:"escape",measurementId:"synthetic-measurement"}});
  assert.deepEqual(dispatched,["Escape"]);
  assert.equal(messages[1].kind,"atools-panel-probe-result","Actual probe acknowledges before dispatch traces");
  const traces=messages.filter(message=>message.kind==="atools-panel-escape-trace");
  assert.deepEqual(traces.map(message=>message.measurementId),Array(3).fill("synthetic-measurement"));
  const timeline={timingSchema:ESCAPE_TIMING_SCHEMA,parentStartedEpochMs:1000000,bridgeMessageCount:1,
    acknowledgementMs:4,bridgeMessageMs:9,panelRemovedObservedMs:11,focusRestoredObservedMs:12,totalMs:26,
    frameTraces:traces.map((message,index)=>({...message.trace,probeRequestId:message.id,parentObservedMs:3+index}))};
  assert.deepEqual(deriveEscapeTimelineMetrics(timeline),expected,
    "Changing the frame clock origin must not change parent observations or frame-local dispatch duration");
  assert.equal(timeline.frameTraces[0].epochMs,frameTimeOriginMs+5,"Original frame epoch stays available for diagnosis");
  for(const mutate of [value=>value.frameTraces.pop(),value=>value.frameTraces.push({...value.frameTraces[2]}),
    value=>value.frameTraces.reverse(),value=>value.frameTraces[1].phase="frame-received",
    value=>value.frameTraces[0].parentObservedMs=-1,value=>value.frameTraces[2].parentObservedMs=10,
    value=>value.frameTraces[2].frameMonotonicMs=4,value=>value.frameTraces[1].probeRequestId=5,
    value=>delete value.frameTraces[1].frameMonotonicMs,value=>value.bridgeMessageCount=2,
    value=>value.focusRestoredObservedMs=10,value=>value.totalMs=11]) {
    const invalid=structuredClone(timeline);mutate(invalid);assert.throws(()=>deriveEscapeTimelineMetrics(invalid));
  }
}
console.log("Native Escape timeline passed: actual synthetic frame trace ordering, two clock origins, same-parent observations, local dispatch, missing/duplicate/order failures");
