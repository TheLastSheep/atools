import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { afterEach, expect, it, vi } from 'vitest';
import { patchUpdater, UPDATER_PATCH } from '../src/sourceCompatibility.mjs';
import { renderSafeMarkdown } from '../src/safeMarkdown';
import { installUpdaterHost, getUpdaterAppearance } from '../src/hostBridge';
import { bindUpdaterUi, openUpdaterLink, startUpdaterDrag } from '../src/uiProjection';
import type { Snapshot } from '../src/protocol';
const upstream = createRequire('/Users/harris/Desktop/ZTools/package.json');
const compiler = createRequire(upstream.resolve('vue/package.json'))('@vue/compiler-sfc');
const vue = upstream('vue');
const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length)
    cleanups.pop()!(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const id = '1'.repeat(32), candidateId = '2'.repeat(32);
const snapshot = (sequence = 1): Snapshot => ({ version: 1, sequence, phase: 'available', checked: true, operationId: null,
    candidate: { candidateId, currentVersion: '3.0.0', version: '3.0.1', date: null,
        body: '# Changes\n\n**safe** [release](https://Example.com/release?a=1&b=2) <img src="https://bad.invalid/x" onerror="alert(1)">' },
    progress: { downloaded: 0, total: null }, error: null });
function mountOriginal(initial = snapshot(), ownerId = id) {
    const original = readFileSync('/Users/harris/Desktop/ZTools/' + UPDATER_PATCH.path, 'utf8');
    const patched = patchUpdater(original), before = compiler.parse(original).descriptor, after = compiler.parse(patched).descriptor;
    expect(after.template.content).toBe(before.template.content);
    expect(after.styles.map((s: {
        content: string;
    }) => s.content)).toEqual(before.styles.map((s: {
        content: string;
    }) => s.content));
    const script = compiler.compileScript(after, { id: 'r78-original-updater', inlineTemplate: true });
    const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = { exports: {} as {
            default?: unknown;
        } };
    new Function('require', 'module', 'exports', code)((name: string) => {
        if (name === 'vue')
            return vue;
        if (name === '@atools-updater/safeMarkdown')
            return { renderSafeMarkdown };
        if (name === '@atools-updater/hostBridge') return { getUpdaterAppearance };
        if (name === '@atools-updater/uiProjection')
            return { bindUpdaterUi, openUpdaterLink, startUpdaterDrag };
        if (name === '../../assets/logo.png')
            return { __esModule: true, default: 'original-logo.png' };
        throw Error('Unexpected original updater dependency ' + name);
    }, module, module.exports);
    const removeTheme = vi.fn(), addTheme = vi.fn();
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: addTheme, removeEventListener: removeTheme }));
    const w = window as unknown as Record<string, unknown>;
    w.__ATOOLS_UPDATER_WINDOW_ID__ = ownerId;
    let state = initial, event: (value: unknown) => void = () => { };
    let appearanceEvent: (value: unknown) => void = () => {};
    let appearance = { windowId: ownerId, sequence: 1, platform: 'win32', material: 'acrylic', nativeMaterial: 'none', materialApplied: true, theme: 'system', effectiveTheme: 'light', opacity: 0.9 as number | null, opacityApplied: true, acrylicOpacity: {light:57,dark:42}, error:null as {code:string;message:string}|null };
    const stopAppearance=vi.fn();
    const stop = vi.fn(), invoke = vi.fn(async (_command: string, args: {
        request: Record<string, unknown>;
    }): Promise<unknown> => {
        if (args.request.op === 'appearance') return appearance;
        if (args.request.op === 'drag') return { started: true };
        if (args.request.op === 'close')
            return { closed: true };
        if (args.request.op === 'open-link')
            return { opened: true };
        return state;
    });
    const dispose = installUpdaterHost(window, { invoke, listen: async (cb) => { event = cb; return stop; }, listenAppearance: async cb => {appearanceEvent=cb;return stopAppearance;} });
    const root = document.createElement('div');
    document.body.append(root);
    const app = vue.createApp(module.exports.default);
    app.mount(root);
    let dead = false;
    const unmount = () => { if (!dead) {
        dead = true;
        app.unmount();
        root.remove();
        dispose();
    } };
    cleanups.push(unmount);
    return { root, invoke, stop, stopAppearance, removeTheme, unmount,
        emitAppearance: async (next: typeof appearance) => {appearance=next;appearanceEvent(next);await vue.nextTick()},
        appearance: () => appearance,
        ready: () => vi.waitFor(() => expect(root.querySelector('.title')?.textContent).toContain(initial.candidate!.version)),
        emit: async (next: Snapshot) => { state = next; event({ windowId: ownerId, snapshot: next }); await vue.nextTick(); } };
}
it('actual original updater renders sanitized notes and uses owned open-link rather than document navigation', async () => {
    const f = mountOriginal();
    await f.ready();
    expect(f.root.querySelector('.changelog strong')?.textContent).toBe('safe');
    expect(f.root.querySelector('.changelog img')).toBeNull();
    const link = f.root.querySelector<HTMLAnchorElement>('.changelog a')!, event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith('renderer_updater_window', { request: { op: 'open-link', windowId: id, candidateId, href: 'https://example.com/release?a=1&b=2' } }));
    f.unmount();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(f.removeTheme).toHaveBeenCalledTimes(1);
});
it('original Enter confirms bound candidate once; busy disables Escape and action errors remain visible', async () => {
    const f = mountOriginal();
    await f.ready();
    let reject!: (error: Error) => void;
    f.invoke.mockImplementationOnce(async () => new Promise((_resolve, fail) => { reject = fail; }));
    const root = f.root.querySelector('.update-window')!;
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vue.nextTick();
    expect(f.invoke.mock.calls.at(-1)?.[1]).toEqual({ request: { op: 'start', windowId: id, candidateId } });
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(f.invoke.mock.calls.filter(c => c[1].request.op === 'close')).toHaveLength(0);
    expect(f.root.querySelector<HTMLButtonElement>('.btn.confirm')?.disabled).toBe(true);
    reject(Error('native refused'));
    await vi.waitFor(() => expect(f.root.querySelector('.update-status')?.textContent).toContain('更新失败'));
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(f.stop).toHaveBeenCalledTimes(1));
});
it('authoritative no-candidate clears previous confirmation; verified-download and restart/unknown labels stay truthful', async () => {
    const f = mountOriginal();
    await f.ready();
    await f.emit({ ...snapshot(2), phase: 'downloaded' });
    expect(f.root.querySelector('.btn.confirm')?.textContent).toBe('立即安装');
    await f.emit({ ...snapshot(3), phase: 'restart-pending', error: { code: 'restart_pending', message: '重启失败' } });
    expect(f.root.querySelector('.btn.confirm')?.textContent).toBe('重试重启');
    expect(f.root.querySelector('.update-status')?.textContent).toContain('只会重新启动');
    await f.emit({ ...snapshot(4), phase: 'install-unknown', error: { code: 'install_unknown', message: 'unknown' } });
    expect(f.root.querySelector('.btn.confirm')?.textContent).toBe('确认重试安装');
    expect(f.root.querySelector('.update-status')?.textContent).toContain('可能已改变');
    await f.emit({ ...snapshot(5), phase: 'not-available', candidate: null });
    expect(f.root.querySelector<HTMLButtonElement>('.btn.confirm')?.disabled).toBe(true);
});

it('original titlebar left-primary pointer requests only owned Native drag and excludes interactive controls', async () => {
  const f = mountOriginal(); await f.ready(); const header = f.root.querySelector('.header.window-drag-region')!;
  const pointer = (target: Element, button = 0) => { const event = new Event('pointerdown', {bubbles:true,cancelable:true}); Object.defineProperties(event,{button:{value:button},isPrimary:{value:true}}); target.dispatchEvent(event); return event; };
  expect(pointer(header).defaultPrevented).toBe(true);
  await vi.waitFor(() => expect(f.invoke).toHaveBeenCalledWith('renderer_updater_window',{request:{op:'drag',windowId:id}}));
  const count = f.invoke.mock.calls.length; const button = document.createElement('button'); header.appendChild(button);
  expect(pointer(button).defaultPrevented).toBe(false); pointer(header,2);
  expect(f.invoke.mock.calls.length).toBe(count); f.unmount(); pointer(header); expect(f.invoke.mock.calls.length).toBe(count);
});

it('revoked candidate is visibly not updateable and closeable; reopening binds new candidate and rejects old window events', async () => {
  const old = mountOriginal(); await old.ready();
  await old.emit({...snapshot(2),phase:'not-available',candidate:null});
  expect(old.root.querySelector('.title')?.textContent).toBe('当前没有可用更新');
  expect(old.root.querySelector('.update-status')?.textContent).toContain('没有可用更新');
  expect(old.root.querySelector<HTMLButtonElement>('.btn.confirm')?.disabled).toBe(true);
  expect(old.root.querySelector<HTMLButtonElement>('.btn.cancel')?.disabled).toBe(false);
  old.unmount();
  const newId='4'.repeat(32), nextCandidate='5'.repeat(32), next={...snapshot(3),candidate:{...snapshot().candidate!,candidateId:nextCandidate,version:'3.0.2'}};
  const fresh=mountOriginal(next,newId); await fresh.ready();
  await old.emit({...snapshot(100),candidate:{...snapshot().candidate!,version:'old-stale'}});
  expect(fresh.root.querySelector('.title')?.textContent).toContain('3.0.2');
  fresh.root.querySelector('.update-window')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await vi.waitFor(()=>expect(fresh.invoke).toHaveBeenCalledWith('renderer_updater_window',{request:{op:'start',windowId:newId,candidateId:nextCandidate}}));
});

it('original material/opacity APIs consume one real appearance projection, reject stale events and clean all listeners/styles', async () => {
  const prior = document.documentElement.className; document.documentElement.classList.add('os-windows');
  cleanups.push(()=>{document.documentElement.className=prior;document.documentElement.removeAttribute('data-material')});
  const f=mountOriginal(); await f.ready();
  await vi.waitFor(()=>expect(document.documentElement.getAttribute('data-material')).toBe('acrylic'));
  expect(f.invoke.mock.calls.filter(c=>c[1].request.op==='appearance')).toHaveLength(1);
  expect(document.getElementById('acrylic-overlay-style')?.textContent).toContain('57%');
  await f.emitAppearance({...f.appearance(),sequence:2,acrylicOpacity:{light:66,dark:33}});
  expect(document.getElementById('acrylic-overlay-style')?.textContent).toContain('66%');
  await f.emitAppearance({...f.appearance(),sequence:1,acrylicOpacity:{light:9,dark:9}});
  expect(document.getElementById('acrylic-overlay-style')?.textContent).toContain('66%');
  await f.emitAppearance({...f.appearance(),sequence:3,material:'none',materialApplied:false,error:{code:'unsupported_material',message:'当前材质不可用'}});
  expect(document.documentElement.getAttribute('data-material')).toBe('none'); expect(document.getElementById('acrylic-overlay-style')).toBeNull();
  expect(getUpdaterAppearance().snapshot()?.materialApplied).toBe(false);
  f.unmount(); expect(f.stopAppearance).toHaveBeenCalledTimes(1); expect(f.removeTheme).toHaveBeenCalledTimes(1);
});

it('pagehide clears original media/material/update/DOM resources even before Vue unmount', async () => {
  const f=mountOriginal();await f.ready();
  window.dispatchEvent(new Event('pagehide'));
  expect(f.stop).toHaveBeenCalledTimes(1);expect(f.stopAppearance).toHaveBeenCalledTimes(1);expect(f.removeTheme).toHaveBeenCalledTimes(1);
  f.unmount();expect(f.stop).toHaveBeenCalledTimes(1);expect(f.stopAppearance).toHaveBeenCalledTimes(1);
});

it('late prior action failure cannot overwrite a newer candidate presentation', async () => {
  const f=mountOriginal();await f.ready();let fail!:(error:Error)=>void;
  f.invoke.mockImplementationOnce(async()=>new Promise((_resolve,reject)=>{fail=reject}));
  f.root.querySelector('.update-window')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await f.emit({...snapshot(5),candidate:{...snapshot().candidate!,candidateId:'6'.repeat(32),version:'3.0.2'}});
  fail(Error('old reply'));await vi.waitFor(()=>expect(f.root.querySelector<HTMLButtonElement>('.btn.confirm')?.disabled).toBe(false));
  expect(f.root.querySelector('.title')?.textContent).toContain('3.0.2');expect(f.root.querySelector('.update-status')).toBeNull();
});

it('actual caller never receives stale same-candidate success after current install-unknown', async()=>{
  const f=mountOriginal();await f.ready();let finish!:(value:unknown)=>void;
  f.invoke.mockImplementationOnce(async()=>new Promise(resolve=>{finish=resolve}));
  const api=(window as unknown as {ztools:{updater:{startUpdate:()=>Promise<{success:boolean;error?:string}>}}}).ztools.updater;
  const original=api.startUpdate, results:Array<{success:boolean;error?:string}>=[];
  vi.spyOn(api,'startUpdate').mockImplementation(async()=>{const result=await original();results.push(result);return result});
  f.root.querySelector('.update-window')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await f.emit({...snapshot(10),phase:'install-unknown',error:{code:'install_unknown',message:'actual unknown'}});
  finish({...snapshot(5),phase:'restarting'});await vi.waitFor(()=>expect(results).toHaveLength(1));
  expect(results[0].success).toBe(false);expect(f.root.querySelector('.btn.confirm')?.textContent).toBe('确认重试安装');
  expect(f.root.querySelector('.update-status')?.textContent).toContain('可能已改变');
});

it('same-candidate late rejection leaves newer restarting presentation authoritative', async()=>{
  const f=mountOriginal();await f.ready();let fail!:(error:Error)=>void;
  f.invoke.mockImplementationOnce(async()=>new Promise((_resolve,reject)=>{fail=reject}));
  f.root.querySelector('.update-window')!.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  await f.emit({...snapshot(10),phase:'restarting'});fail(Error('old failure'));
  await Promise.resolve();await vue.nextTick();
  expect(f.root.querySelector('.btn.confirm')?.textContent).toBe('正在重启...');
  expect(f.root.querySelector('.update-status')?.classList.contains('error')).toBe(false);
});

it('focused cancel/link Enter never calls installation; cancel retains its own click action',async()=>{
  const f=mountOriginal();await f.ready();
  const cancel=f.root.querySelector<HTMLButtonElement>('.btn.cancel')!,link=f.root.querySelector<HTMLAnchorElement>('.changelog a')!;
  cancel.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  link.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  expect(f.invoke.mock.calls.filter(c=>['start','install-downloaded'].includes(c[1].request.op as string))).toHaveLength(0);
  cancel.click();await vi.waitFor(()=>expect(f.invoke).toHaveBeenCalledWith('renderer_updater_window',{request:{op:'close',windowId:id}}));
});
it('root repeat/modified/composing Enter and composing Escape cannot confirm or close',async()=>{
  const f=mountOriginal();await f.ready();const root=f.root.querySelector('.update-window')!;
  for(const fields of [{key:'Enter',repeat:true},{key:'Enter',ctrlKey:true},{key:'Enter',isComposing:true},{key:'Escape',isComposing:true}])root.dispatchEvent(new KeyboardEvent('keydown',{...fields,bubbles:true,cancelable:true}));
  expect(f.invoke.mock.calls.filter(c=>['start','install-downloaded','close'].includes(c[1].request.op as string))).toHaveLength(0);
});
it('downloaded with an active operation remains busy on hydration until actual operation release',async()=>{
  const f=mountOriginal({...snapshot(),phase:'downloaded',operationId:'3'.repeat(32)});await f.ready();
  expect(f.root.querySelector<HTMLButtonElement>('.btn.cancel')?.disabled).toBe(true);expect(f.root.querySelector<HTMLButtonElement>('.btn.confirm')?.disabled).toBe(true);
  const root=f.root.querySelector('.update-window')!;root.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  expect(f.invoke.mock.calls.filter(c=>['close','start','install-downloaded'].includes(c[1].request.op as string))).toHaveLength(0);
  await f.emit({...snapshot(2),phase:'downloaded',operationId:null});
  expect(f.root.querySelector<HTMLButtonElement>('.btn.cancel')?.disabled).toBe(false);expect(f.root.querySelector<HTMLButtonElement>('.btn.confirm')?.disabled).toBe(false);
});

it('partial unknown Native alpha does not reject original known material/opacity callbacks',async()=>{
  const warn=vi.spyOn(console,'warn').mockImplementation(()=>{});
  const f=mountOriginal();await f.ready();
  await f.emitAppearance({...f.appearance(),sequence:4,opacity:null,opacityApplied:false,error:{code:'appearance_partial',message:'实际alpha未知'}});
  expect(document.documentElement.getAttribute('data-material')).toBe('acrylic');
  expect(await getUpdaterAppearance().getWindowMaterial()).toBe('acrylic');
  expect(getUpdaterAppearance().snapshot()?.opacity).toBeNull();expect(getUpdaterAppearance().snapshot()?.error?.code).toBe('appearance_partial');
  expect(warn).toHaveBeenCalledWith('更新窗口部分外观信息不可用。');
  expect(f.invoke.mock.calls.filter(c=>c[1].request.op==='appearance')).toHaveLength(1);
});
