import { afterEach, expect, it, vi } from "vitest";
import { measureNativePanelEscape } from "./nativePanelEscapeMeasurement";

afterEach(()=>{document.body.replaceChildren();vi.restoreAllMocks();});
const frameFocus={documentHasFocus:false,visibilityState:"hidden",activeElementTag:"TEXTAREA"};

for(const frameOriginOffset of [-500,500])it(`uses parent receipt times when the frame epoch differs by ${frameOriginOffset}ms`,async()=>{
  document.body.innerHTML='<input id="search"><section class="plugin-panel"><iframe title="Plugin"></iframe></section>';
  const input=document.querySelector<HTMLInputElement>("#search")!,frame=document.querySelector("iframe")!;
  let now=100,measurementId="";
  vi.spyOn(performance,"now").mockImplementation(()=>now);
  const observations:Record<string,unknown>={};
  const send=(phase:string,monotonicMs:number,parentMs:number)=>{
    now=100+parentMs;
    const frameTimeOriginMs=performance.timeOrigin+frameOriginOffset;
    window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,data:{kind:"atools-panel-escape-trace",token:"test",
      measurementId,id:7,trace:{phase,frameMonotonicMs:monotonicMs,frameTimeOriginMs,epochMs:frameTimeOriginMs+monotonicMs}}}));
  };
  const elapsed=await measureNativePanelEscape({token:"test",mode:"observe",observations,input:()=>input,
    request:async(operation,args)=>{
      expect(operation).toBe("escape");measurementId=String(args?.measurementId);
      send("frame-received",1,3);now=104;return frameFocus;
    },
    until:async<T>(read:()=>T|Promise<T>,message:string)=>{
      send("before-keydown",2,5);send("after-keydown",3,6);now=107;
      window.dispatchEvent(new MessageEvent("message",{source:frame.contentWindow,data:{__ipc_plugin_escape__:true}}));
      now=108;document.querySelector(".plugin-panel")!.remove();await Promise.resolve();
      now=109;input.focus();now=110;const value=await read();if(!value)throw Error(message);return value as NonNullable<T>;
    }});
  expect(elapsed).toBe(10);
  expect(observations.escapePhases).toMatchObject({complete:true,timingSchema:"parent-observed-traces-v2",
    requestToFrameReceiptTraceObservedMs:3,frameKeydownDispatchMs:1,afterKeydownTraceToBridgeObservedMs:1,
    bridgeToPanelRemovedObservedMs:1,bridgeToFocusRestoredObservedMs:2});
  const phases=observations.escapePhases as {frameTraces:Array<{epochMs:number;parentObservedMs:number}>;parentStartedEpochMs:number};
  expect(phases.frameTraces.map(trace=>trace.parentObservedMs)).toEqual([3,5,6]);
  expect(phases.frameTraces[0].epochMs-phases.parentStartedEpochMs).toBe(frameOriginOffset-99);
});
