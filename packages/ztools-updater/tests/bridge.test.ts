import { expect, it, vi } from 'vitest';
import { createUpdaterBridge } from '../src/bridge';
import { parseSnapshot, type Snapshot } from '../src/protocol';
const windowId = '1'.repeat(32), candidateId = '2'.repeat(32);
export const snapshot = (sequence = 1): Snapshot => ({ version: 1, sequence, phase: 'available', checked: true, operationId: null,
    candidate: { candidateId, currentVersion: '3.0.0', version: '3.0.1', date: null, body: '# Update' }, progress: { downloaded: 0, total: null }, error: null });
function fixture() {
    let event: (raw: unknown) => void = () => { }, reply: unknown = snapshot(), resolveListen: ((stop: ReturnType<typeof vi.fn>) => void) | null = null;
    const calls: unknown[] = [], stop = vi.fn();
    const transport = { listen: vi.fn(async (cb: (raw: unknown) => void) => { event = cb; return stop; }),
        invoke: vi.fn(async (_command: string, args: unknown) => { calls.push(args); return reply; }) };
    const bridge = createUpdaterBridge(windowId, transport);
    return { bridge, transport, calls, stop, emit: (value: Snapshot, id = windowId) => event({ windowId: id, snapshot: value }),
        reply: (value: unknown) => { reply = value; }, holdListen: () => {
            transport.listen.mockImplementationOnce(async (cb) => { event = cb; return new Promise(resolve => { resolveListen = resolve; }); });
        }, releaseListen: () => resolveListen?.(stop) };
}
it('subscribes before ready; early newer event beats older ready reply and old/foreign events', async () => {
    const f = fixture();
    f.holdListen();
    const values: unknown[] = [];
    f.bridge.subscribe(p => values.push(p.snapshot?.sequence));
    const ready = f.bridge.ready();
    f.emit(snapshot(3));
    f.emit(snapshot(9), 'f'.repeat(32));
    f.releaseListen();
    await ready;
    f.emit(snapshot(2));
    expect(values).toEqual([undefined, 3]);
    expect(f.calls).toEqual([{ request: { op: 'ready', windowId } }]);
    f.bridge.dispose();
    expect(f.stop).toHaveBeenCalledTimes(1);
});
it('unmount while listen is pending never sends ready and immediately removes late subscription', async () => {
    const f = fixture();
    f.holdListen();
    const ready = f.bridge.ready();
    f.bridge.dispose();
    f.releaseListen();
    await ready;
    expect(f.calls).toEqual([]);
    expect(f.stop).toHaveBeenCalledTimes(1);
});
it('actions bind displayed candidate, block double confirmation and reject late replies after dispose', async () => {
    const f = fixture();
    await f.bridge.ready();
    let resolve!: (v: unknown) => void;
    f.transport.invoke.mockImplementationOnce(async () => new Promise(r => { resolve = r; }));
    const action = f.bridge.start();
    expect(await f.bridge.start()).toMatchObject({ success: false });
    expect(f.transport.invoke.mock.calls.at(-1)?.[1]).toEqual({ request: { op: 'start', windowId, candidateId } });
    f.bridge.dispose();
    resolve(snapshot(2));
    expect(await action).toMatchObject({ success: false });
});
it('action errors and no candidate are not reported as successful work', async () => {
    const f = fixture();
    await f.bridge.ready();
    f.reply({ ...snapshot(2), phase: 'install-unknown', error: { code: 'install_unknown', message: '安装状态未知' } });
    expect(await f.bridge.installDownloaded()).toEqual({ success: false, error: '安装状态未知' });
    f.emit({ ...snapshot(3), candidate: null });
    expect(await f.bridge.start()).toMatchObject({ success: false });
    f.bridge.dispose();
});
it('strict snapshot parsing rejects getter/toJSON, unknown keys, unsafe integers and over-budget notes', () => {
    let touched = false;
    const bad = { ...snapshot(), get phase() { touched = true; return 'available'; } };
    expect(() => parseSnapshot(bad)).toThrow();
    expect(touched).toBe(false);
    for (const raw of [{ ...snapshot(), toJSON() { touched = true; } }, { ...snapshot(), sequence: 2 ** 54 },
        { ...snapshot(), candidate: { ...snapshot().candidate!, body: 'x'.repeat(49153) } }])
        expect(() => parseSnapshot(raw)).toThrow();
    expect(touched).toBe(false);
});

it('does not treat an accepted/in-progress response as completed, nor an old candidate response as current success', async () => {
  const f = fixture(); await f.bridge.ready(); f.reply({...snapshot(2),phase:'downloading'});
  expect(await f.bridge.start()).toMatchObject({success:false});
  let finish!: (value: unknown) => void;
  f.transport.invoke.mockImplementationOnce(async()=>new Promise(resolve=>{finish=resolve}));
  const action=f.bridge.start(); f.emit({...snapshot(4),candidate:{...snapshot().candidate!,candidateId:'3'.repeat(32)}});
  finish({...snapshot(3),phase:'restarting'}); expect(await action).toMatchObject({success:false}); f.bridge.dispose();
});
it('consumer callback and failed unsubscribe cannot prevent local disposal or permit later callbacks', async () => {
  const f=fixture(); expect(()=>f.bridge.subscribe(()=>{throw Error('consumer')})).not.toThrow();
  await f.bridge.ready(); f.stop.mockImplementation(()=>{throw Error('unlisten')});
  expect(()=>f.bridge.dispose()).not.toThrow(); expect(await f.bridge.start()).toMatchObject({success:false});
});

it('same-candidate old terminal success cannot outrank current install-unknown authority', async()=>{
  const f=fixture();await f.bridge.ready();let finish!:(value:unknown)=>void;
  f.transport.invoke.mockImplementationOnce(async()=>new Promise(resolve=>{finish=resolve}));
  const operation=f.bridge.start();f.emit({...snapshot(10),phase:'install-unknown',error:{code:'install_unknown',message:'actual install unknown'}});
  finish({...snapshot(5),phase:'restarting'});
  expect(await operation).toMatchObject({success:false,error:'actual install unknown'});f.bridge.dispose();
});
it('same-candidate old failure does not become the returned current error or replace current restarting state', async()=>{
  const f=fixture();await f.bridge.ready();let finish!:(value:unknown)=>void;
  f.transport.invoke.mockImplementationOnce(async()=>new Promise(resolve=>{finish=resolve}));
  const seen:string[]=[];f.bridge.subscribe(p=>{if(p.snapshot)seen.push(p.snapshot.phase)});
  const operation=f.bridge.start();f.emit({...snapshot(10),phase:'restarting'});
  finish({...snapshot(5),phase:'error',error:{code:'internal',message:'old failure'}});
  const result=await operation;expect(result.success).toBe(false);expect(result.error).not.toBe('old failure');expect(seen.at(-1)).toBe('restarting');f.bridge.dispose();
});
