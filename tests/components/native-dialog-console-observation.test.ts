import { readFileSync } from "node:fs";
import vm from "node:vm";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";

const source=readFileSync(resolve("tests/components/nativePluginDialogFrameOperations.js"),"utf8");
function fixture(original: (...args:unknown[])=>unknown,readOnly=false,origin="null") {
  const listeners=new Map<string,Set<(event:unknown)=>unknown>>(),messages:Array<{state:Record<string,unknown>}>=[];
  const buttons=new Map<string,HTMLButtonElement>();
  const parent={postMessage:(message:{state:Record<string,unknown>})=>messages.push(message)};
  const console_={error:original};
  if(readOnly)Object.defineProperty(console_,"error",{value:original,writable:false});
  const window_={top:{},parent,addEventListener:(kind:string,callback:(event:unknown)=>unknown)=>{
    if(!listeners.has(kind))listeners.set(kind,new Set());listeners.get(kind)!.add(callback);
  },removeEventListener:(kind:string,callback:(event:unknown)=>unknown)=>listeners.get(kind)?.delete(callback)};
  const context=vm.createContext({window:window_,console:console_,Error,Reflect,HTMLButtonElement,location:{origin},
    document:{title:"Synthetic console observer only",querySelector:(selector:string)=>buttons.get(selector)??null,visibilityState:"hidden",hasFocus:()=>false},
    setTimeout:(callback:()=>void)=>callback()});
  const install=()=>vm.runInContext(source,context);install();
  const emit=(kind:string,event:unknown)=>Promise.all([...listeners.get(kind)??[]].map(callback=>callback(event)));
  const send=(data:Record<string,unknown>)=>emit("message",{source:parent,
    data:{kind:"atools-dialog-probe",token:"__ATOOLS_PANEL_TOKEN__",id:1,...data}});
  return {console_,window_,messages,install,emit,wipeListeners:()=>listeners.clear(),
    listenerCount:(kind:string)=>listeners.get(kind)?.size??0,
    dispose:()=>Object.getOwnPropertyDescriptor(window_,"__ATOOLS_NATIVE_DIALOG_FIXTURE_OBSERVER__")!.value.dispose(),
    addOriginalButton:(selector:string,click:()=>void)=>{
      const button=document.createElement("button");button.addEventListener("click",click);buttons.set(selector,button);return button;
    },click:(selector:string)=>send({operation:"click",selector}),state:async()=>{
    await send({operation:"state"});
    return JSON.parse(JSON.stringify(messages.at(-1)!.state));
  }};
}

it("fully forwards the original receiver, every argument, return and exception while recording exact Error messages",async()=>{
  const returnValue={unchanged:true},original=vi.fn(function(this:unknown,..._args:unknown[]){return returnValue;});
  const observed=fixture(original),receiver={privateSyntheticReceiver:true};
  const error=new Error("exact synthetic html2canvas failure"),args=["导出图片失败:",error,{object:true},"fourth original argument"];
  expect(Reflect.apply(observed.console_.error,receiver,args)).toBe(returnValue);
  expect(original).toHaveBeenCalledTimes(1);expect(original.mock.contexts[0]).toBe(receiver);
  expect(original.mock.calls[0]).toEqual(args);expect(original.mock.calls[0][1]).toBe(error);
  expect(await observed.state()).toMatchObject({consoleErrorObserverInstalled:true,consoleErrorCount:1,
    consoleErrors:[["导出图片失败:","Error: exact synthetic html2canvas failure","[object Object]"]]});
  const thrown=new Error("original console exception"),throwing=fixture(()=>{throw thrown;});
  expect(()=>throwing.console_.error("record before original throws")).toThrow(thrown);
  expect(await throwing.state()).toMatchObject({consoleErrorCount:1,consoleErrors:[["record before original throws"]]});
  const otherRealm=vm.runInNewContext('new TypeError("exact other-realm observed failure")');
  observed.console_.error(otherRealm);
  expect((await observed.state()).consoleErrors.at(-1)).toEqual(["TypeError: exact other-realm observed failure"]);
});

it("keeps only latest 12 calls, first 3 arguments and 280 characters without changing forwarding",async()=>{
  const original=vi.fn(),observed=fixture(original);
  for(let index=0;index<20;index++)observed.console_.error(String(index),"x".repeat(400),"third","unrecorded fourth");
  const state=await observed.state();
  expect(original).toHaveBeenCalledTimes(20);expect(original.mock.calls.every(call=>call.length===4)).toBe(true);
  expect(state.consoleErrorCount).toBe(20);expect(state.consoleErrors).toHaveLength(12);
  expect(state.consoleErrors[0][0]).toBe("8");expect(state.consoleErrors.at(-1)[0]).toBe("19");
  expect(state.consoleErrors.every((row:string[])=>row.length===3&&row.every(value=>value.length<=280))).toBe(true);
  state.consoleErrors[0][0]="mutated snapshot";expect((await observed.state()).consoleErrors[0][0]).toBe("8");
});

it("redacts fixture credentials and survives observation serialization failures without altering original calls",async()=>{
  const original=vi.fn(),observed=fixture(original);
  const endpoint=["node","host","data","dialog"].map(kind=>"http://127.0.0.1:12345/"+kind+"/"+"a".repeat(64)).join(" ");
  observed.console_.error("__ATOOLS_PANEL_TOKEN__ "+endpoint);
  const unreadable={get [Symbol.toStringTag](){throw Error("synthetic getter failure");}};
  observed.console_.error(unreadable);
  const state=await observed.state();
  expect(state.consoleErrors).toEqual([["[redacted-fixture-token] "+Array(4).fill("[redacted-local-endpoint]").join(" ")],["[unreadable diagnostic argument]"]]);
  expect(original.mock.calls[0][0]).toBe("__ATOOLS_PANEL_TOKEN__ "+endpoint);
  expect(original.mock.calls[1][0]).toBe(unreadable);
});

it("applies the same redaction and 12-entry bound to uncaught errors and rejections",async()=>{
  const observed=fixture(vi.fn());
  for(let index=0;index<20;index++) {
    const message=index+" __ATOOLS_PANEL_TOKEN__ /"+["node","host","data","dialog"][index%4]+"/"+"b".repeat(64)+" "+"x".repeat(400);
    observed.emit(index%2?"error":"unhandledrejection",index%2?{message}:{reason:new Error(message)});
  }
  const state=await observed.state();expect(state.errors).toHaveLength(12);
  expect(state.errors.every((value:string)=>value.length<=280&&value.includes("[redacted-fixture-token]")&&value.includes("[redacted-local-endpoint]"))).toBe(true);
  expect(JSON.stringify(state.errors)).not.toContain("b".repeat(64));
});

it("does not claim the observer installed when classic-script assignment silently fails",async()=>{
  const original=vi.fn(),observed=fixture(original,true);
  expect(observed.console_.error).toBe(original);observed.console_.error("unchanged original");
  expect(original).toHaveBeenCalledOnce();
  expect(await observed.state()).toMatchObject({consoleErrorObserverInstalled:false,consoleErrorCount:0,consoleErrors:[]});
});

it("bounds diagnostic processing of huge strings while forwarding every original byte",async()=>{
  const original=vi.fn(),observed=fixture(original),huge="x".repeat(5*1024*1024);
  const message="__ATOOLS_PANEL_TOKEN__ http://127.0.0.1:12345/data/"+"c".repeat(64)+" "+huge;
  const error=new Error(huge);observed.console_.error(message,error);
  expect(original.mock.calls[0][0]).toBe(message);expect(original.mock.calls[0][1]).toBe(error);
  const state=await observed.state();expect(state.consoleErrors[0].every((value:string)=>value.length<=280)).toBe(true);
  expect(state.consoleErrors[0][0]).toContain("[redacted-fixture-token] [redacted-local-endpoint]");
  expect(state.consoleErrors[0][1]).toBe("Error: "+"x".repeat(273));
});

it("reinstalls named listeners and console observer without duplicating an original button click or console call",async()=>{
  const original=vi.fn(function(this:unknown,..._args:unknown[]){return "original-result";}),observed=fixture(original);
  const click=vi.fn();observed.addOriginalButton("#selectFolder",click);
  observed.install();observed.install();
  for(const kind of ["error","unhandledrejection","message"])expect(observed.listenerCount(kind)).toBe(1);
  await observed.click("#selectFolder");expect(click).toHaveBeenCalledOnce();
  expect(observed.messages).toHaveLength(1);
  const receiver={exactReceiver:true},args=["first",new Error("exact installed observer"),"third","fourth"];
  expect(Reflect.apply(observed.console_.error,receiver,args)).toBe("original-result");
  expect(original).toHaveBeenCalledOnce();expect(original.mock.contexts[0]).toBe(receiver);expect(original.mock.calls[0]).toEqual(args);
  await observed.emit("error",{message:"one error"});await observed.emit("unhandledrejection",{reason:"one rejection"});
  expect(await observed.state()).toMatchObject({consoleErrorCount:1,errors:["one error","one rejection"]});
});

it("reinstalls safely after document.open clears listeners but retains the prior console wrapper",async()=>{
  const original=vi.fn(),observed=fixture(original,false,"atools-page://synthetic.localhost");
  const firstWrapper=observed.console_.error,click=vi.fn();observed.addOriginalButton("#confirmExport",click);
  observed.wipeListeners();observed.install();
  expect(observed.console_.error).not.toBe(firstWrapper);
  await observed.click("#confirmExport");expect(click).toHaveBeenCalledOnce();
  observed.console_.error("once after listener wipe");expect(original).toHaveBeenCalledOnce();
  expect(await observed.state()).toMatchObject({sourceOrigin:"atools-page://synthetic.localhost",sourceOpaque:false,
    noTauri:true,consoleErrorCount:1,consoleErrors:[["once after listener wipe"]]});
});

it("does not restore over a later plugin console implementation, including when reinstalling",async()=>{
  const original=vi.fn(),observed=fixture(original),pluginConsole=vi.fn(()=>"plugin-console-result");
  observed.console_.error=pluginConsole;
  observed.dispose();expect(observed.console_.error).toBe(pluginConsole);
  for(const kind of ["error","unhandledrejection","message"])expect(observed.listenerCount(kind)).toBe(0);
  observed.install();
  expect(observed.console_.error("through newly installed observer")).toBe("plugin-console-result");
  expect(pluginConsole).toHaveBeenCalledOnce();expect(original).not.toHaveBeenCalled();
  observed.dispose();expect(observed.console_.error).toBe(pluginConsole);
});

it("reports both Tauri globals and suppresses a stale response if disposed while its original click settles",async()=>{
  const observed=fixture(vi.fn()),click=vi.fn();observed.addOriginalButton("#exportImage",click);
  const pending=observed.click("#exportImage");observed.install();await pending;
  expect(click).toHaveBeenCalledOnce();expect(observed.messages).toHaveLength(0);
  expect(await observed.state()).toMatchObject({sourceOrigin:"null",sourceOpaque:true,noTauri:true});
  Object.assign(observed.window_,{__TAURI__:{}});expect((await observed.state()).noTauri).toBe(false);
  delete (observed.window_ as Record<string,unknown>).__TAURI__;
  Object.assign(observed.window_,{__TAURI_INTERNALS__:{}});expect((await observed.state()).noTauri).toBe(false);
});
