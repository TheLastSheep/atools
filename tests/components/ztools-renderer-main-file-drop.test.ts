import { afterEach, expect, it, vi } from 'vitest';
import { createMainFileDrop, type MainFileDropNotice } from '../../packages/ztools-renderer/src/mainFileDrop';
import type { ZToolsRendererTransport } from '../../packages/ztools-renderer/src/types';

const contextId = 'a'.repeat(32), leaseId = 'b'.repeat(32);
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const observers: Array<() => void> = [];
class Observer { constructor(callback: () => void) { observers.push(callback); } observe() {} disconnect() {} }
afterEach(() => { vi.unstubAllGlobals(); observers.length = 0; });
function fixture(onNotice?: (notice: MainFileDropNotice) => void) {
  vi.stubGlobal('ResizeObserver', Observer);
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({ x:10,y:20,width:300,height:50,top:20,left:10,right:310,bottom:70,toJSON() {} });
  let deliver: (value: unknown) => void = () => {}; const calls: unknown[] = []; const unlisten = vi.fn();
  const transport: ZToolsRendererTransport = { invoke: vi.fn(), async listen(event, callback) { expect(event).toBe('renderer-main-file-drop'); deliver = callback; return unlisten; } };
  const invoke = vi.fn(async (_command, args) => { calls.push(args); const request = args.request; return request.op === 'context' ? {contextId} : {leaseId: request.target ? leaseId : null}; });
  const notices: unknown[] = []; const owner = createMainFileDrop(transport, invoke);
  const binding = owner.bind(element, notice => { notices.push(notice); onNotice?.(notice); });
  return { binding, owner, calls, notices, deliver: (v:unknown) => deliver(v), unlisten };
}
it('registers only after listener and routes owned exact drop despite a newer hover leave', async () => {
  const f = fixture(); f.binding.setActive(true); await flush();
  expect(f.calls).toEqual([{request:{op:'context'}}, {request:{op:'set',contextId,leaseId:null,target:{x:10,y:20,width:300,height:50}}}]);
  f.deliver({version:1,leaseId,sequence:3,phase:'hover',hovered:false});
  f.deliver({version:1,leaseId,sequence:2,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]});
  f.deliver({version:1,leaseId:'c'.repeat(32),sequence:4,phase:'drop',files:[]});
  expect(f.notices).toEqual([{phase:'hover',hovered:false},{phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]}]);
  f.binding.dispose(); await flush(); expect(f.unlisten).toHaveBeenCalledOnce();
  expect(f.calls.at(-1)).toEqual({request:{op:'set',contextId,leaseId,target:null}});
});
it('drops late old lease events and obtains a fresh context after leaving Search', async () => {
  const f = fixture(); f.binding.setActive(true); await flush(); f.binding.setActive(false); await flush();
  f.deliver({version:1,leaseId,sequence:1,phase:'hover',hovered:true});
  f.binding.setActive(true); await flush();
  expect(f.calls.filter((x:any) => x.request.op === 'context')).toHaveLength(2);
  expect(f.notices).toEqual([{phase:'hover',hovered:false}]); f.owner.dispose(); await flush();
});
it('revokes a lease returned after unmount before unlistening', async () => {
  vi.stubGlobal('ResizeObserver', Observer);
  const element = document.createElement('div');
  element.getBoundingClientRect = () => ({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  let resolveSet!: (value: unknown) => void; const calls: any[] = []; const unlisten = vi.fn();
  const transport: ZToolsRendererTransport = {invoke:vi.fn(), async listen() { return unlisten; }};
  const invoke = vi.fn(async (_command, args) => {
    const request = args.request; calls.push(request);
    if (request.op === 'context') return {contextId};
    if (request.target) return new Promise(resolve => { resolveSet = resolve; });
    return {leaseId:null};
  });
  const owner = createMainFileDrop(transport, invoke), binding = owner.bind(element, () => {});
  binding.setActive(true); await flush(); binding.dispose();
  expect(unlisten).not.toHaveBeenCalled(); resolveSet({leaseId}); await flush();
  expect(calls.at(-1)).toEqual({op:'set',contextId,leaseId,target:null});
  expect(unlisten).toHaveBeenCalledOnce();
});
it('rejects malformed, duplicate and oversized file notices without changing the consumer', async () => {
  const f = fixture(); f.binding.setActive(true); await flush();
  const file = {path:'/tmp/a',name:'a',isDirectory:false};
  for (const files of [[], [file,file], [{...file, extra:true}], [{...file,path:'relative'}], [{...file,name:'x'.repeat(1025)}]])
    f.deliver({version:1,leaseId,sequence:1,phase:'drop',files});
  expect(f.notices).toEqual([]); f.owner.dispose(); await flush();
});
it('preserves legal Unix newline, C0 and DEL file metadata through HostAdapter updateLaunchContext', async () => {
  const { createZtoolsRendererHostAdapter } = await import('../../packages/ztools-renderer/src/hostAdapter');
  const files=[
    {path:'/tmp/plain.txt',name:'plain.txt',isDirectory:false},
    {path:'/tmp/new\nline.txt',name:'new\nline.txt',isDirectory:false},
    {path:'/tmp/control\u0001file.txt',name:'control\u0002file.txt',isDirectory:false},
    {path:'/tmp/delete\u007fdir',name:'delete\u007fname',isDirectory:true},
  ];
  const host=createZtoolsRendererHostAdapter({transport:{invoke:vi.fn(),async listen(){return ()=>{};}}});
  let accepted=false;
  const f=fixture(notice=>{
    if(notice.phase!=='drop')return;
    try { host.api.updateLaunchContext({searchQuery:'',pastedImage:null,pastedFiles:notice.files,pastedText:null}); accepted=true; }
    catch { accepted=false; }
  });
  f.binding.setActive(true); await flush();
  f.deliver({version:1,leaseId,sequence:1,phase:'drop',files});
  expect(f.notices).toEqual([{phase:'drop',files}]); expect(accepted).toBe(true);
  expect(host.snapshot()).toMatchObject({launchContextSet:true});
  f.owner.dispose(); host.dispose(); await flush();
});
it('rejects NUL and over-encoded notices without invoking untrusted accessors or toJSON', async () => {
  const f=fixture(); f.binding.setActive(true); await flush();
  f.deliver({version:1,leaseId,sequence:1,phase:'drop',files:[{path:'/tmp/nul\u0000path',name:'nul',isDirectory:false}]});
  f.deliver({version:1,leaseId,sequence:2,phase:'drop',files:[{path:'/tmp/nul-name',name:'nul\u0000name',isDirectory:false}]});
  const oversized=Array.from({length:64},(_,index)=>({path:`/tmp/${String(index).padStart(2,'0')}${'"'.repeat(1017)}`,name:'"'.repeat(1024),isDirectory:false}));
  f.deliver({version:1,leaseId,sequence:3,phase:'drop',files:oversized});
  let getterCalls=0, toJSONCalls=0;
  const getterNotice={version:1,leaseId,sequence:4,phase:'drop',files:[{name:'a',isDirectory:false}]};
  Object.defineProperty(getterNotice.files[0],'path',{enumerable:true,get(){getterCalls++;return '/tmp/a';}});
  f.deliver(getterNotice);
  const toJSONNotice={version:1,leaseId,sequence:5,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]};
  Object.defineProperty(toJSONNotice,'toJSON',{enumerable:true,value(){toJSONCalls++;return {};}});
  f.deliver(toJSONNotice);
  expect(f.notices).toHaveLength(0); expect(getterCalls).toBe(0); expect(toJSONCalls).toBe(0);
  f.owner.dispose(); await flush();
});
it('does not register a target when the listener fails', async () => {
  vi.stubGlobal('ResizeObserver', Observer); const invoke = vi.fn();
  const transport: ZToolsRendererTransport = {invoke:vi.fn(), async listen(){ throw Error('failed'); }};
  const owner = createMainFileDrop(transport, invoke), binding = owner.bind(document.createElement('div'), () => {});
  binding.setActive(true); await flush(); expect(invoke).not.toHaveBeenCalled(); owner.dispose(); await flush();
});
it('buffers a bounded owned event received before the target ACK and checks its returned lease', async () => {
  vi.stubGlobal('ResizeObserver', Observer); const element = document.createElement('div');
  element.getBoundingClientRect = () => ({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  let deliver: (value:unknown)=>void = () => {}; let resolveSet!: (value:unknown)=>void;
  const transport: ZToolsRendererTransport = {invoke:vi.fn(), async listen(_event, cb){deliver=cb; return () => {};}};
  const invoke = vi.fn(async (_command,args) => args.request.op === 'context' ? {contextId} : args.request.target ? new Promise(resolve => {resolveSet=resolve;}) : {leaseId:null});
  const notices:unknown[] = [], owner = createMainFileDrop(transport,invoke), binding=owner.bind(element,n=>notices.push(n));
  binding.setActive(true); await flush();
  deliver({version:1,leaseId,sequence:2,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]});
  deliver({version:1,leaseId,sequence:3,phase:'hover',hovered:false});
  expect(notices).toEqual([]); resolveSet({leaseId}); await flush();
  expect(notices).toEqual([{phase:'hover',hovered:false},{phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]}]);
  owner.dispose(); await flush();
});
it('delivers a buffered same-lease drop when resize dirties the initial create before its ACK', async () => {
  vi.stubGlobal('ResizeObserver', Observer); const element = document.createElement('div'); let width = 100;
  element.getBoundingClientRect = () => ({x:0,y:0,width,height:30,top:0,left:0,right:width,bottom:30,toJSON(){}});
  let emit:(value:unknown)=>void=()=>{}, finishCreate!:(value:unknown)=>void;
  const requests:any[]=[], notices:unknown[]=[];
  const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(_event,callback){emit=callback;return ()=>{};}};
  const invoke=vi.fn(async (_command,args)=>{
    const request=args.request; requests.push(request);
    if(request.op==='context')return {contextId};
    if(request.target && request.leaseId===null)return new Promise(resolve=>{finishCreate=resolve;});
    return {leaseId:request.target?leaseId:null};
  });
  const owner=createMainFileDrop(transport,invoke), binding=owner.bind(element,notice=>notices.push(notice));
  binding.setActive(true); await flush();
  expect(requests).toEqual([
    {op:'context'},
    {op:'set',contextId,leaseId:null,target:{x:0,y:0,width:100,height:30}},
  ]);
  const drop={version:1,leaseId,sequence:1,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]};
  emit(drop); expect(notices).toEqual([]);
  width=120; observers[0](); await flush();
  expect(requests.filter(request=>request.op==='set' && request.target)).toHaveLength(1);

  finishCreate({leaseId}); await flush();
  expect(requests.filter(request=>request.op==='set' && request.target).map(request=>request.target.width)).toEqual([100,120]);
  expect(notices).toEqual([{phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]}]);
  owner.dispose(); await flush();
});
it('serializes replacement component registration behind the previous owned revoke', async () => {
  vi.stubGlobal('ResizeObserver', Observer); const element = document.createElement('div');
  element.getBoundingClientRect = () => ({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  let finishRevoke!: (value: unknown)=>void; const calls:any[]=[];
  const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(){return ()=>{};}};
  const invoke=vi.fn(async (_command,args)=> { const r=args.request; calls.push(r); if(r.op==='context') return {contextId}; if(r.target) return {leaseId}; return new Promise(resolve => {finishRevoke=resolve;}); });
  const owner=createMainFileDrop(transport,invoke), first=owner.bind(element,()=>{}); first.setActive(true); await flush();
  const second=owner.bind(element,()=>{}); second.setActive(true); await flush();
  expect(calls.filter(r=>r.op==='context')).toHaveLength(1); finishRevoke({leaseId:null}); await flush();
  expect(calls.filter(r=>r.op==='context')).toHaveLength(2); second.dispose(); await flush(); finishRevoke({leaseId:null}); await flush();
});
it('host adapter disposal still revokes the owned late ACK using its narrow transport', async () => {
  const { createZtoolsRendererHostAdapter } = await import('../../packages/ztools-renderer/src/hostAdapter');
  vi.stubGlobal('ResizeObserver', Observer); const element = document.createElement('div');
  element.getBoundingClientRect = () => ({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  let finish!: (value:unknown)=>void; const calls:any[]=[];
  const transport:ZToolsRendererTransport={ async listen(){return ()=>{};}, async invoke(_command,args){const r=args?.request as any;calls.push(r);if(r.op==='context')return {contextId};if(r.target)return new Promise(resolve=>{finish=resolve;});return {leaseId:null};} };
  const host=createZtoolsRendererHostAdapter({transport}); const binding=host.api.onNativeMainFileDrop(element,()=>{});
  binding.setActive(true); await flush(); host.dispose(); finish({leaseId}); await flush();
  expect(calls.at(-1)).toEqual({op:'set',contextId,leaseId,target:null});
});
it('coalesces a resize while an update is in flight and sends the latest rectangle', async () => {
  vi.stubGlobal('ResizeObserver', Observer); const element = document.createElement('div'); let width=100;
  element.getBoundingClientRect = () => ({x:0,y:0,width,height:30,top:0,left:0,right:width,bottom:30,toJSON(){}});
  let finish!: (value:unknown)=>void; const calls:any[]=[];
  const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(){return ()=>{};}};
  const invoke=vi.fn(async (_command,args)=> { const r=args.request; calls.push(r); if(r.op==='context')return {contextId}; if(r.target && r.leaseId) return new Promise(resolve=>{finish=resolve;}); return {leaseId:r.target ? leaseId : null}; });
  const owner=createMainFileDrop(transport,invoke), binding=owner.bind(element,()=>{}); binding.setActive(true); await flush();
  width=110; observers[0](); await flush(); width=120; observers[0](); width=130; observers[0]();
  expect(calls.filter(r=>r.op==='set' && r.target)).toHaveLength(2); finish({leaseId}); await flush();
  expect(calls.filter(r=>r.op==='set' && r.target).map(r=>r.target.width)).toEqual([100,110,130]);
  finish({leaseId}); await flush(); binding.dispose(); await flush();
});
it('rejects out of order drop results without treating hover sequence as content order', async () => {
  const f=fixture(); f.binding.setActive(true); await flush();
  const drop=(sequence:number,name:string)=>({version:1,leaseId,sequence,phase:'drop',files:[{path:`/tmp/${name}`,name,isDirectory:false}]});
  f.deliver(drop(5,'new')); f.deliver({version:1,leaseId,sequence:8,phase:'hover',hovered:true}); f.deliver(drop(4,'old'));
  expect(f.notices).toEqual([{phase:'drop',files:[{path:'/tmp/new',name:'new',isDirectory:false}]},{phase:'hover',hovered:true}]);
  f.owner.dispose(); await flush();
});
it('preserves an already accepted drop while a same-lease rectangle update is pending', async () => {
  vi.stubGlobal('ResizeObserver', Observer); const element=document.createElement('div'); let width=100;
  element.getBoundingClientRect=()=>({x:0,y:0,width,height:30,top:0,left:0,right:width,bottom:30,toJSON(){}});
  let emit:(v:unknown)=>void=()=>{}, finish!:(v:unknown)=>void; const notices:unknown[]=[];
  const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(_event,cb){emit=cb;return ()=>{};}};
  const invoke=vi.fn(async (_command,args)=>{const r=args.request;if(r.op==='context')return {contextId};if(r.target && r.leaseId)return new Promise(resolve=>{finish=resolve;});return {leaseId:r.target?leaseId:null};});
  const owner=createMainFileDrop(transport,invoke), binding=owner.bind(element,n=>notices.push(n)); binding.setActive(true);await flush();
  width=120;observers[0]();await flush(); emit({version:1,leaseId,sequence:1,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]});
  expect(notices).toEqual([{phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]}]); finish({leaseId});await flush();owner.dispose();await flush();
});
it('opening Settings immediately fences an already queued Main drop and failed open restores Search', async () => {
  const { createZtoolsRendererHostAdapter } = await import('../../packages/ztools-renderer/src/hostAdapter');
  vi.stubGlobal('ResizeObserver', Observer); const element=document.createElement('div');
  element.getBoundingClientRect=()=>({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  const callbacks=new Map<string,(v:unknown)=>void>();let failOpen!:(e:unknown)=>void;const calls:any[]=[];
  const transport:ZToolsRendererTransport={async listen(name,cb){callbacks.set(name,cb);return ()=>{};},async invoke(command,args){calls.push({command,args});if(command==='open_renderer_settings')return new Promise((_resolve,reject)=>{failOpen=reject;});if(command==='set_renderer_main_drop_target'){const r=args?.request as any;return r.op==='context'?{contextId}:{leaseId:r.target?leaseId:null};}throw Error('unexpected');}};
  const host=createZtoolsRendererHostAdapter({transport}), notices:unknown[]=[];const binding=host.api.onNativeMainFileDrop(element,n=>notices.push(n));binding.setActive(true);await flush();
  host.api.openSettings();callbacks.get('renderer-main-file-drop')?.({version:1,leaseId,sequence:1,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]});
  expect(notices.some((x:any)=>x.phase==='drop')).toBe(false);await flush();failOpen(Error('failed'));await flush();
  expect(calls.filter(x=>x.args?.request?.op==='context')).toHaveLength(2);host.dispose();await flush();
});
it('hide immediately fences queued events, failed hide recovers, but stale failure cannot undo newer show', async () => {
  const { createZtoolsRendererHostAdapter } = await import('../../packages/ztools-renderer/src/hostAdapter');
  vi.stubGlobal('ResizeObserver', Observer);const element=document.createElement('div');element.getBoundingClientRect=()=>({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  const callbacks=new Map<string,(v:unknown)=>void>();let failHide!:(e:unknown)=>void;
  const transport:ZToolsRendererTransport={async listen(name,cb){callbacks.set(name,cb);return ()=>{};},async invoke(command,args){if(command==='hide_main_window')return new Promise((_r,reject)=>{failHide=reject;});if(command==='set_renderer_main_drop_target'){const r=args?.request as any;return r.op==='context'?{contextId}:{leaseId:r.target?leaseId:null};}throw Error('unexpected');}};
  const host=createZtoolsRendererHostAdapter({transport}), notices:unknown[]=[];const binding=host.api.onNativeMainFileDrop(element,n=>notices.push(n));binding.setActive(true);const off=host.api.onFocusSearch(()=>{});await flush();
  host.api.hideWindow();callbacks.get('renderer-main-file-drop')?.({version:1,leaseId,sequence:1,phase:'drop',files:[{path:'/tmp/a',name:'a',isDirectory:false}]});expect(notices.some((x:any)=>x.phase==='drop')).toBe(false);
  await flush(); callbacks.get('tauri://focus')?.(undefined);failHide(Error('late'));await flush();
  callbacks.get('renderer-main-file-drop')?.({version:1,leaseId,sequence:2,phase:'hover',hovered:true});expect(notices.at(-1)).toEqual({phase:'hover',hovered:true});off();host.dispose();await flush();
});
it('a failed hide restores Search without a focus event, but failure after unmount cannot revive it', async () => {
  const { createZtoolsRendererHostAdapter }=await import('../../packages/ztools-renderer/src/hostAdapter');
  vi.stubGlobal('ResizeObserver',Observer);const element=document.createElement('div');element.getBoundingClientRect=()=>({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  let fail!:(e:unknown)=>void; const calls:any[]=[];
  const transport:ZToolsRendererTransport={async listen(){return ()=>{};},async invoke(cmd,args){if(cmd==='hide_main_window')return new Promise((_r,reject)=>{fail=reject;});if(cmd==='set_renderer_main_drop_target'){const r=args?.request as any;calls.push(r);return r.op==='context'?{contextId}:{leaseId:r.target?leaseId:null};}throw Error('unexpected');}};
  const host=createZtoolsRendererHostAdapter({transport}), binding=host.api.onNativeMainFileDrop(element,()=>{});binding.setActive(true);await flush();host.api.hideWindow();await flush();fail(Error('failed'));await flush();
  expect(calls.filter(r=>r.op==='context')).toHaveLength(2);
  host.api.hideWindow();await flush();binding.dispose();fail(Error('late'));await flush();expect(calls.filter(r=>r.op==='context')).toHaveLength(2);host.dispose();
});
it('recovers only after the trusted context confirms the old lease was rotated', async () => {
  vi.stubGlobal('ResizeObserver',Observer);const element=document.createElement('div');element.getBoundingClientRect=()=>({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  let nativeContext=contextId;const newContext='d'.repeat(32),calls:any[]=[];
  const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(){return ()=>{};}};
  const invoke=vi.fn(async (_cmd,args)=>{const r=args.request;calls.push(r);if(r.op==='context')return {contextId:nativeContext};if(r.contextId!==nativeContext)throw Error('old context');return {leaseId:r.target?leaseId:null};});
  const owner=createMainFileDrop(transport,invoke),binding=owner.bind(element,()=>{});binding.setActive(true);await flush();nativeContext=newContext;binding.setActive(false);await flush();binding.setActive(true);await flush();
  expect(calls.some(r=>r.op==='set' && r.contextId===newContext && r.target)).toBe(true);owner.dispose();await flush();
});
it('an ambiguous create failure never retries or reports old lease cleanup while context is unchanged', async () => {
  vi.stubGlobal('ResizeObserver',Observer);const element=document.createElement('div');element.getBoundingClientRect=()=>({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  const calls:any[]=[];const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(){return ()=>{};}};
  const invoke=vi.fn(async (_cmd,args)=>{const r=args.request;calls.push(r);if(r.op==='context')return {contextId};if(r.target)throw Error('unknown commit');return {leaseId:null};});
  const owner=createMainFileDrop(transport,invoke),first=owner.bind(element,()=>{});first.setActive(true);await flush();observers[0]();await flush();
  expect(calls.filter(r=>r.op==='set'&&r.target)).toHaveLength(1);
  first.dispose();await flush();const second=owner.bind(element,()=>{});second.setActive(true);await flush();
  expect(calls.filter(r=>r.op==='set'&&r.target)).toHaveLength(1);owner.dispose();await flush();
});
it('isolates consumer callback exceptions from fencing and owned cleanup', async () => {
  vi.stubGlobal('ResizeObserver',Observer);const element=document.createElement('div');element.getBoundingClientRect=()=>({x:0,y:0,width:100,height:30,top:0,left:0,right:100,bottom:30,toJSON(){}});
  const calls:any[]=[];const transport:ZToolsRendererTransport={invoke:vi.fn(),async listen(){return ()=>{};}};
  const invoke=vi.fn(async (_cmd,args)=>{const r=args.request;calls.push(r);return r.op==='context'?{contextId}:{leaseId:r.target?leaseId:null};});
  const owner=createMainFileDrop(transport,invoke),binding=owner.bind(element,()=>{throw Error('consumer');});binding.setActive(true);await flush();
  expect(()=>binding.setActive(false)).not.toThrow();await flush();expect(calls.at(-1)).toEqual({op:'set',contextId,leaseId,target:null});owner.dispose();await flush();
});
