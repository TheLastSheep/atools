import { afterEach, expect, it, vi } from "vitest";
import { createPanelWindowEvidence, nativeForegroundConfirmed, type NativeWindowEvidence } from "./nativePanelWindowEvidence";

const native = (changes: Partial<NativeWindowEvidence> = {}): NativeWindowEvidence => ({mode:"foreground",nativeVisible:true,
  nativeFocused:true,appActive:true,appHidden:false,frontmostIsSelf:true,elapsedMs:1,...changes});
const check = (value: unknown, message: string) => { if(!value)throw Error(message); };
const once = async <T>(read: () => T | Promise<T>, message: string) => { const value=await read();if(!value)throw Error(message);return value as NonNullable<T>; };
afterEach(()=>{vi.restoreAllMocks();});

it("requires every native OS property independently of DOM focus",()=>{
  expect(nativeForegroundConfirmed(native())).toBe(true);
  for(const changes of [{nativeVisible:false},{nativeFocused:false},{appActive:false},{appHidden:true},{frontmostIsSelf:false}]) {
    expect(nativeForegroundConfirmed(native(changes))).toBe(false);
  }
});
it("observe mode and after-samples never request foreground restoration",async()=>{
  const calls: unknown[]=[];
  const invoke=async <T>(_command:string,args?:Record<string,unknown>)=>{calls.push(args);return native({mode:"observe",nativeFocused:false,frontmostIsSelf:false}) as T;};
  const evidence=createPanelWindowEvidence({mode:"observe",invoke,until:once,check,observations:{}});
  await evidence.before("search");await evidence.after("search");
  expect(calls).toEqual([{ensure:false},{ensure:false}]);
});
it("restores before timing then only observes after timing",async()=>{
  vi.spyOn(document,"hasFocus").mockReturnValue(true);vi.spyOn(document,"visibilityState","get").mockReturnValue("visible");
  const calls: unknown[]=[];
  const invoke=async <T>(_command:string,args?:Record<string,unknown>)=>{calls.push(args);return native() as T;};
  const evidence=createPanelWindowEvidence({mode:"foreground",invoke,until:once,check,observations:{}});
  await evidence.before("iframe-escape");await evidence.after("iframe-escape");
  expect(calls).toEqual([{ensure:true},{ensure:false},{ensure:false}]);
});
it("retains the last actual OS/DOM state when foreground never settles",async()=>{
  vi.spyOn(document,"hasFocus").mockReturnValue(true);vi.spyOn(document,"visibilityState","get").mockReturnValue("hidden");
  const observations: Record<string,unknown>={};
  const invoke=async <T>()=>native({nativeVisible:false,frontmostIsSelf:false}) as T;
  const evidence=createPanelWindowEvidence({mode:"foreground",invoke,until:once,check,observations});
  await expect(evidence.before("iframe-escape")).rejects.toThrow("did not settle");
  expect(observations.windowEvidence).toMatchObject({samples:[],attempts:[{stage:"iframe-escape",when:"before",restoreRequested:true,
    status:"failed",observationCount:2,last:{native:{nativeVisible:false,frontmostIsSelf:false},parentVisibility:"hidden",parentDocumentHasFocus:true}}]});
});
