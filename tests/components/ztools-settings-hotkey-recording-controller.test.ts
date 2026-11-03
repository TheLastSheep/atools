import { describe, expect, it, vi } from 'vitest'
import { createSettingsHotkeyRecordingController } from '../../packages/ztools-settings/src/childBridgeHotkeyRecording'
import type { SettingsBridgeTarget } from '../../packages/ztools-settings/src/childBridgeTypes'

const sessionId = 'a'.repeat(32)
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const target = new EventTarget() as SettingsBridgeTarget
  let live = true
  const calls: Array<{ operation: string; generation: number }> = []
  let held: ReturnType<typeof deferred<unknown>> | null = null
  const invokeNative = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    const generation = payload.generation as number
    calls.push({ operation, generation })
    if (operation === 'startHotkeyRecording' && held) { const gate = held; held = null; return gate.promise }
    return { version: 1, sessionId, generation, active: operation === 'startHotkeyRecording',
      mode: operation === 'startHotkeyRecording' ? 'temporary' : null }
  })
  const controller = createSettingsHotkeyRecordingController({ sessionId, platform: 'darwin', isLive: () => live, invokeNative })
  controller.attach(target)
  const deliver = (generation: number, extra = {}) => target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__?.({
    version: 1, sessionId, generation, status: 'recorded', shortcut: 'Option+Space', ...extra
  })
  return { controller, target, calls, deliver, invokeNative, hold() { held = deferred(); return held }, close() { live = false } }
}

describe('native hotkey recording controller', () => {
  it('delivers a recording once, removes subscribers, and ignores previous session/generation', async () => {
    const f = fixture(), recorded = vi.fn()
    const unsubscribe = f.controller.onRecorded(recorded)
    await expect(f.controller.start()).resolves.toEqual({ success: true })
    f.deliver(1, { sessionId: 'other' }); f.deliver(2)
    expect(recorded).not.toHaveBeenCalled()
    f.deliver(1); f.deliver(1)
    expect(recorded).toHaveBeenCalledTimes(1)
    expect(recorded).toHaveBeenCalledWith('Option+Space')
    unsubscribe(); await f.controller.start(); f.deliver(2)
    expect(recorded).toHaveBeenCalledTimes(1)
  })
  it('consumes an early event before the pending start reply without reopening the generation', async () => {
    const f = fixture(), recorded = vi.fn(), gate = f.hold()
    f.controller.onRecorded(recorded)
    const start = f.controller.start()
    f.deliver(1)
    gate.resolve({ version: 1, sessionId, generation: 1, active: true, mode: 'borrowed-main' })
    await start
    f.deliver(1)
    expect(recorded).toHaveBeenCalledTimes(1)
  })
  it('sends a same-generation tombstone before start resolves and ignores its late delivery', async () => {
    const f = fixture(), recorded = vi.fn(), gate = f.hold()
    f.controller.onRecorded(recorded)
    const first = f.controller.start()
    await f.controller.stop()
    expect(f.calls).toEqual([{ operation: 'startHotkeyRecording', generation: 1 }, { operation: 'stopHotkeyRecording', generation: 1 }])
    gate.resolve({ version: 1, sessionId, generation: 1, active: true, mode: 'temporary' })
    await first
    await f.controller.start()
    f.deliver(1); expect(recorded).not.toHaveBeenCalled()
    f.deliver(2); expect(recorded).toHaveBeenCalledTimes(1)
  })
  it('ends on native timeout, removes subscriptions and restores the previous delivery hook', async () => {
    const f = fixture(), stopped = vi.fn(), recorded = vi.fn()
    const remove = f.controller.onStopped(stopped)
    f.controller.onRecorded(recorded)
    await f.controller.start()
    f.target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__?.({ version: 1, sessionId, generation: 1, status: 'stopped', reason: 'timeout' })
    f.deliver(1)
    expect(stopped).toHaveBeenCalledWith('timeout'); expect(recorded).not.toHaveBeenCalled()
    remove(); await f.controller.start(); f.target.dispatchEvent(new Event('hashchange'))
    expect(stopped).toHaveBeenCalledTimes(1)
    f.controller.dispose()
    expect(f.target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__).toBeUndefined()
  })
  it('rejects malformed acknowledgements and never forwards malformed shortcut or stopped events', async () => {
    const f = fixture(), recorded = vi.fn(), stopped = vi.fn()
    f.controller.onRecorded(recorded); f.controller.onStopped(stopped)
    await f.controller.start()
    f.deliver(1, { shortcut: 'Command+Q' }); f.deliver(1, { unknown: true })
    f.target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__?.({ version: 1, sessionId, generation: 1, status: 'stopped', reason: 'unknown' })
    expect(recorded).not.toHaveBeenCalled(); expect(stopped).not.toHaveBeenCalled()
    f.invokeNative.mockResolvedValueOnce({ version: 1, sessionId, generation: 2, active: false, mode: 'temporary' })
    await expect(f.controller.start()).resolves.toMatchObject({ success: false })
  })

  it('does not stop an already terminal lease, but retries a failed stop and coalesces duplicate requests', async () => {
    const f = fixture()
    await f.controller.start(); f.deliver(1)
    await f.controller.stop(); f.target.dispatchEvent(new Event('hashchange')); f.controller.dispose()
    expect(f.calls).toEqual([{ operation: 'startHotkeyRecording', generation: 1 }])
    const retry = fixture()
    await retry.controller.start()
    retry.invokeNative.mockRejectedValueOnce(new Error('cleanup failed'))
    await expect(retry.controller.stop()).rejects.toThrow('cleanup failed')
    await Promise.all([retry.controller.stop(), retry.controller.stop()])
    await retry.controller.stop(); retry.controller.dispose()
    expect(retry.calls.filter(call => call.operation === 'stopHotkeyRecording')).toHaveLength(1)
  })

  it('preserves an unavailable retained lease for same-generation stop retry without redelivering input', async () => {
    const f = fixture(), recorded = vi.fn(), stopped = vi.fn()
    f.controller.onRecorded(recorded); f.controller.onStopped(stopped)
    await f.controller.start()
    f.target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__?.({ version: 1, sessionId, generation: 1, status: 'stopped', reason: 'unavailable' })
    f.invokeNative.mockRejectedValueOnce(new Error('Unregister failed, lease retained'))
    await expect(f.controller.stop()).rejects.toThrow('lease retained')
    await f.controller.stop(); f.deliver(1)
    expect(recorded).not.toHaveBeenCalled(); expect(stopped).toHaveBeenCalledTimes(1)
    expect(f.invokeNative.mock.calls.filter(call => call[0] === 'stopHotkeyRecording')).toHaveLength(2)
    await f.controller.stop(); f.controller.dispose()
    expect(f.invokeNative.mock.calls.filter(call => call[0] === 'stopHotkeyRecording')).toHaveLength(2)
  })

})
