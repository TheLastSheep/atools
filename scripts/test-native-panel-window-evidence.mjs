import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, parsePanelBenchmarkOptions, validatePanelWindowEvidence } from "./benchmark-plugin-panel-native.mjs";
import { deriveEscapeTimelineMetrics, ESCAPE_TIMING_SCHEMA } from "./lib/native-panel-escape-timeline.mjs";

assert.equal(parsePanelBenchmarkOptions([]).windowMode,"observe");
assert.deepEqual(parsePanelBenchmarkOptions(["--foreground","/private/tmp/panel-proof.json"]),
  {output:resolve("/private/tmp/panel-proof.json"),windowMode:"foreground"});
assert.equal(parsePanelBenchmarkOptions(["--foreground"]).output.endsWith("-foreground.json"),true);
for(const args of [["--foreground","--foreground"],["--unknown"],["a.json","b.json"]])assert.throws(()=>parsePanelBenchmarkOptions(args));

function fixture(mode="foreground") {
  const native={mode,nativeVisible:true,nativeFocused:true,appActive:true,appHidden:false,frontmostIsSelf:true};
  const samples=["before","after"].map(when=>({stage:"iframe-escape",when,native:{...native},parentVisibility:"visible",parentDocumentHasFocus:true}));
  const escapePhases={mode,complete:true,timingSchema:ESCAPE_TIMING_SCHEMA,bridgeMessageCount:1,bridgeMessageMs:7,totalMs:26,acknowledgementMs:1.5,
    panelRemovedObservedMs:9,focusRestoredObservedMs:10,parentStartedEpochMs:1000,
    frameTraces:["frame-received","before-keydown","after-keydown"].map((phase,index)=>({phase,
      frameMonotonicMs:index+1,frameTimeOriginMs:500,epochMs:501+index,parentObservedMs:index+1,probeRequestId:1})),
    frameVisibilityState:"visible",frameDocumentHasFocus:true,parentVisibilityBefore:"visible",parentDocumentHasFocusBefore:true,parentDocumentHasFocus:true};
  Object.assign(escapePhases,deriveEscapeTimelineMetrics(escapePhases));
  return {nativeWindowEvents:{mode,events:[]},observations:{windowEvidence:{mode,samples},performance:{windowMode:mode,escapePhases}}};
}
assert.equal(validatePanelWindowEvidence(fixture(),"foreground").samples.length,2);
for(const mutate of [
  value=>value.observations.windowEvidence.samples[0].native.frontmostIsSelf=false,
  value=>value.observations.windowEvidence.samples[1].native.nativeVisible=false,
  value=>delete value.observations.windowEvidence.samples[0].native.appActive,
  value=>value.observations.windowEvidence.samples[0].parentVisibility="hidden",
  value=>value.observations.performance.escapePhases.frameDocumentHasFocus=false,
  value=>delete value.observations.performance.escapePhases.requestToFrameReceiptTraceObservedMs,
  value=>value.observations.performance.escapePhases.afterKeydownTraceToBridgeObservedMs=-1,
  value=>value.observations.performance.escapePhases.frameTraces[1].phase="frame-received",
  value=>value.observations.performance.escapePhases.frameTraces.pop(),
  value=>value.observations.performance.escapePhases.frameTraces[2].parentObservedMs=8,
  value=>value.observations.performance.escapePhases.frameTraces[1].frameMonotonicMs=0,
  value=>value.observations.performance.escapePhases.frameTraces[2].probeRequestId=2,
  value=>value.observations.performance.escapePhases.acknowledgementMs=.5,
  value=>value.observations.performance.escapePhases.complete=false,
  value=>value.observations.performance.escapePhases.bridgeMessageCount=2,
  value=>value.observations.windowEvidence.samples.pop(),
  value=>value.nativeWindowEvents.mode="observe",
]) {
  const invalid=fixture();mutate(invalid);assert.throws(()=>validatePanelWindowEvidence(invalid,"foreground"));
}
const observed=fixture("observe");
for(const sample of observed.observations.windowEvidence.samples){sample.native.nativeFocused=false;sample.native.frontmostIsSelf=false;sample.parentVisibility="hidden";sample.parentDocumentHasFocus=false;}
observed.observations.performance.escapePhases.frameVisibilityState="hidden";
observed.observations.performance.escapePhases.frameDocumentHasFocus=false;
assert.doesNotThrow(()=>validatePanelWindowEvidence(observed,"observe"));

// A startup failure still gets an honest partial summary; missing durations stay null.
for(const partial of [{observations:{windowEvidence:{}}},{observations:{performance:{windowMode:"foreground"}}}]) {
  const summary=describe([partial]);
  assert.equal(summary.firstSearchAfterLauncherReadyMs.sampleCount,0);
  assert.equal(summary.firstSearchAfterLauncherReadyMs.p50,null);
  assert.equal(summary.escapePipeline.afterKeydownTraceToBridgeObservedMs.p95,null);
}
console.log("Native panel window guards passed: explicit mode, OS foreground proof, strict parent-clock Escape FIFO, retained observe boundary, partial failures stay null");
