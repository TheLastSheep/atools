import { describe, expect, it, vi } from 'vitest'
import { createSettingsAppShortcutRecordingController } from '../../packages/ztools-settings/src/childBridgeAppShortcutRecording'
import type { SettingsBridgeTarget } from '../../packages/ztools-settings/src/childBridgeTypes'
const sessionId = 'session', token = 'a'.repeat(32)
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason?: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const ack = (generation: number, active: boolean, drained: boolean, value: string | null = token) => ({ version: 1, sessionId, generation, token: value, active, drained })
function fixture(invokeNative: any) {
  const target = new EventTarget() as SettingsBridgeTarget
  Object.defineProperty(target, 'location', { value: { hash: '#/shortcuts' } })
  const controller = createSettingsAppShortcutRecordingController({ sessionId, isLive: () => true, invokeNative, reportDraining: () => {} })
  controller.attach(target)
  const send = (value: Record<string, unknown>) => target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__?.({ version: 1, sessionId, generation: 1, token, ...value })
  return { controller, send, target }
}
describe('app shortcut recording protocol', () => {
  it('buffers early notice and validates token, then waits for drained notice with one stop RPC', async () => {
    const start = deferred<unknown>(), stop = deferred<unknown>()
    const invoke = vi.fn((op: string) => op.startsWith('start') ? start.promise : stop.promise)
    const f = fixture(invoke), received = vi.fn(), oldStopped = vi.fn(), newStopped = vi.fn(); f.controller.onRecorded(received); f.controller.onStopped(oldStopped)
    const starting = f.controller.start()
    f.send({ status: 'recorded', shortcut: 'Ctrl+A' })
    start.resolve(ack(1, true, false)); expect(await starting).toEqual({ success: true }); expect(received).toHaveBeenCalledWith('Ctrl+A')
    const stopping = f.controller.stop(), again = f.controller.stop(); f.controller.onStopped(newStopped); expect(again).toBe(stopping)
    let done = false; void stopping.then(() => { done = true })
    stop.resolve(ack(1, false, false)); await Promise.resolve(); await Promise.resolve(); expect(done).toBe(false)
    f.send({ status: 'stopped', reason: 'cancelled', drained: true, token: 'b'.repeat(32) }); await Promise.resolve(); expect(done).toBe(false)
    f.send({ status: 'stopped', reason: 'cancelled', drained: true }); await stopping
    expect(done).toBe(true); expect(oldStopped).not.toHaveBeenCalled(); expect(newStopped).not.toHaveBeenCalled(); expect(invoke).toHaveBeenCalledTimes(2)
    f.controller.dispose()
  })
  it('stop racing start waits for both acknowledgements and failure stays sticky', async () => {
    const start = deferred<unknown>(), stop = deferred<unknown>()
    const invoke = vi.fn((op: string) => op.startsWith('start') ? start.promise : stop.promise)
    const f = fixture(invoke); const starting = f.controller.start(); const stopping = f.controller.stop()
    stop.resolve(ack(1, false, true, null)); start.reject(Error('cancelled'))
    expect((await starting).success).toBe(false); await stopping
    expect(invoke).toHaveBeenCalledTimes(2); f.controller.dispose()
    const g = fixture(vi.fn((op: string) => op.startsWith('start') ? Promise.resolve(ack(1, true, false)) : Promise.reject(Error('failed'))))
    await g.controller.start(); const failed = g.controller.stop(); await expect(failed).rejects.toThrow(); expect(g.controller.stop()).toBe(failed); g.controller.dispose()
  })
})
it('bounds UTF-8 before encoding and isolates invalid packets', async () => {
  for (const [shortcut, accepted] of [['x'.repeat(256), true], ['é'.repeat(129), false], ['x'.repeat(1000000), false]] as const) {
    const f = fixture(vi.fn((op: string) => Promise.resolve(ack(1, op.startsWith('start'), !op.startsWith('start')))))
    const received = vi.fn(); f.controller.onRecorded(received); await f.controller.start()
    expect(() => f.send({ status: 'recorded', shortcut })).not.toThrow()
    expect(received).toHaveBeenCalledTimes(accepted ? 1 : 0); await f.controller.stop(); f.controller.dispose()
  }
  const f = fixture(vi.fn((op: string) => Promise.resolve(ack(1, op.startsWith('start'), !op.startsWith('start')))))
  const received = vi.fn(); f.controller.onRecorded(received); await f.controller.start()
  const throwing = new Proxy({}, { get() { throw Error('bad packet') }, ownKeys() { throw Error('bad packet') } })
  // Exercise the actual fixed receiver, not object spread in the fixture sender.
  expect(() => f.target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__?.(throwing)).not.toThrow()
  expect(received).not.toHaveBeenCalled(); await f.controller.stop(); f.controller.dispose()
})
