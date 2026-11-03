import { describe, expect, it, vi } from 'vitest'
import { createAppGlobalShortcutsController, validateAppReceipt, validateAppSnapshot } from '../../packages/ztools-settings/src/appGlobalShortcutsController'

const revision = 'a'.repeat(32)
const target = { kind: 'app' as const, path: '/Applications/A.app', name: 'A' }
const snapshot = { version: 1, revision, rows: [{ id: 'old', target: 'legacy' }], bindings: [], runtime: [] }
const receipt = { version: 1, persisted: true, changed: true, runtimeApplied: true, notificationDelivered: false, error: null, snapshot }

describe('app global shortcuts wire', () => {
  it('rejects unknown fields and malformed authority', () => {
    expect(() => validateAppSnapshot({ ...snapshot, extra: true })).toThrow()
    expect(() => validateAppSnapshot({ ...snapshot, rows: [{ id: 'x', extra: 3 }] })).toThrow()
    expect(() => validateAppSnapshot({ ...snapshot, rows: [{ id: 3 }] })).toThrow()
    expect(validateAppSnapshot({ ...snapshot, rows: [{}] }).rows).toEqual([{}])
    expect(() => validateAppSnapshot({ ...snapshot, bindings: [{ rowId: 'x', shortcut: 'Alt+A', enabled: true, target: { ...target, extra: 1 } }] })).toThrow()
    expect(() => validateAppReceipt({ ...receipt, error: { code: 'X', message: 'x', extra: 1 } })).toThrow()
  })
  it('sends one mutation with the observed revision and preserves notification failure', async () => {
    const invoke = vi.fn().mockResolvedValueOnce(snapshot).mockResolvedValueOnce(receipt)
    const controller = createAppGlobalShortcutsController({ invoke, isLive: () => true })
    await controller.read()
    const mutation = { kind: 'create' as const, shortcut: 'Alt+A', target, enabled: true, autoCopy: false as const }
    expect(await controller.mutate(mutation)).toEqual(receipt)
    expect(invoke).toHaveBeenNthCalledWith(2, 'mutateAppGlobalShortcut', { revision, mutation })
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('invalidates baseline on rejection and ignores a late read', async () => {
    let complete!: (value: unknown) => void
    const invoke = vi.fn().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('conflict'))
      .mockImplementationOnce(() => new Promise(resolve => { complete = resolve }))
    const controller = createAppGlobalShortcutsController({ invoke, isLive: () => true })
    await controller.read()
    await expect(controller.mutate({ kind: 'remove', rowId: 'x' })).rejects.toThrow('conflict')
    await expect(controller.mutate({ kind: 'remove', rowId: 'x' })).rejects.toThrow()
    const pending = controller.read()
    controller.invalidate()
    complete(snapshot)
    await expect(pending).rejects.toThrow()
  })
})

import { createAppShortcutIntentController } from '../../packages/ztools-settings/src/appShortcutIntent'
it('accepts only fresh exact intents from the current session and stops after disposal', () => {
  const accept = vi.fn()
  const sessionId = 'b'.repeat(32)
  const controller = createAppShortcutIntentController(sessionId, accept)
  const packet = { version: 1, id: 'c'.repeat(32), sessionId, sequence: 1, target }
  expect(controller.deliver({ ...packet, extra: true })).toBe(false)
  expect(controller.deliver({ ...packet, sessionId: 'd'.repeat(32) })).toBe(false)
  expect(controller.deliver(packet)).toBe(true)
  expect(controller.deliver(packet)).toBe(false)
  expect(controller.deliver({ ...packet, id: 'e'.repeat(32), sequence: 0 })).toBe(false)
  controller.dispose()
  expect(controller.deliver({ ...packet, id: 'e'.repeat(32), sequence: 2 })).toBe(false)
  expect(accept).toHaveBeenCalledTimes(1)
})

import { aboutFixture } from './ztoolsSettingsAboutFixture'
it('actual Child facade gates the route, sends closed payloads and invalidates on exit', async () => {
  const fixture = aboutFixture()
  const target = fixture.target as any
  target.location = { hash: '#/generalSetting' }
  const api = fixture.api.internal as any
  await expect(api.readAppGlobalShortcuts()).rejects.toThrow()
  target.location.hash = '#/shortcuts'
  const snap = { version: 1, revision, rows: [], bindings: [], runtime: [] }
  fixture.reply(snap)
  await expect(api.readAppGlobalShortcuts()).resolves.toEqual(snap)
  expect(fixture.calls.at(-1)).toEqual({ operation: 'readAppGlobalShortcuts', payload: {} })
  fixture.reply({ ...receipt, snapshot: snap })
  const mutation = { kind: 'create', shortcut: 'Alt+A', target: { kind: 'app', path: '/A.app', name: 'A' }, enabled: true, autoCopy: false }
  await api.mutateAppGlobalShortcut(mutation)
  expect(fixture.calls.at(-1)).toEqual({ operation: 'mutateAppGlobalShortcut', payload: { revision, mutation } })
  target.location.hash = '#/generalSetting'; target.dispatchEvent(new Event('hashchange'))
  target.location.hash = '#/shortcuts'
  await expect(api.mutateAppGlobalShortcut(mutation)).rejects.toThrow()
  fixture.bridge.dispose()
})

import { createSettingsHotkeyRecordingController } from '../../packages/ztools-settings/src/childBridgeHotkeyRecording'
it('Shortcuts DOM recording falls back without entering General native recording scope', async () => {
  const target = new EventTarget() as any; target.location = { hash: '#/shortcuts' }
  const invokeNative = vi.fn()
  const recorder = createSettingsHotkeyRecordingController({ sessionId: 'a'.repeat(32), platform: 'darwin', isLive: () => true, invokeNative })
  recorder.attach(target)
  await expect(recorder.start()).resolves.toMatchObject({ success: false })
  await recorder.stop(); expect(invokeNative).not.toHaveBeenCalled()
  recorder.dispose()
})

import { installAppShortcutIntentReceiver } from '../../packages/ztools-settings/src/appShortcutIntent'
it('installs the fixed receiver synchronously and removes it on pagehide', () => {
  const host = new EventTarget() as any, received = vi.fn()
  host.addEventListener('atools-app-shortcuts-intent', received)
  const stop = installAppShortcutIntentReceiver(host, 'b'.repeat(32))
  const old = host.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__
  const packet = { version: 1, id: 'c'.repeat(32), sessionId: 'b'.repeat(32), sequence: 1, target }
  expect(old(packet)).toBe(true); expect(old(packet)).toBe(false); expect(received).toHaveBeenCalledOnce()
  host.dispatchEvent(new Event('pagehide')); expect(host.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__).toBeUndefined()
  expect(old({ ...packet, id: 'd'.repeat(32), sequence: 2 })).toBe(false)
  stop()
})

it('handles more than 256 ordered intents with O(1) state, rejects stale completion, and observes ACK errors', async () => {
  const received = vi.fn(), ack = vi.fn(async () => { throw new Error('offline') })
  const sessionId = 'b'.repeat(32), controller = createAppShortcutIntentController(sessionId, received, ack)
  const packet = (sequence: number) => ({ version: 1, id: sequence.toString(16).padStart(32, '0'), sessionId, sequence, target })
  for (let n = 1; n <= 300; n++) {
    expect(controller.deliver(packet(n))).toBe(true)
    expect(controller.complete(packet(n).id, n, true)).toBe(true)
  }
  expect(controller.deliver(packet(302))).toBe(true)
  expect(controller.deliver(packet(301))).toBe(false)
  expect(controller.complete(packet(301).id, 301, true)).toBe(false)
  expect(controller.complete(packet(302).id, 302, true)).toBe(true)
  await Promise.resolve(); await Promise.resolve()
  expect(received).toHaveBeenCalledTimes(301)
  expect(ack).toHaveBeenCalledWith({ id: packet(301).id, sequence: 301, accepted: false })
  controller.dispose()
})
it('supersedes a pending intent, never accepts its old completion, and rejects pending on close', async () => {
  const ack = vi.fn(async (_arg: { id: string; sequence: number; accepted: boolean }) => ({ acknowledged: true }))
  const sessionId = 'b'.repeat(32), controller = createAppShortcutIntentController(sessionId, () => {}, ack)
  const packet = (sequence: number) => ({ version: 1, id: sequence.toString(16).padStart(32, '0'), sessionId, sequence, target })
  controller.deliver(packet(1)); controller.deliver(packet(2))
  expect(controller.complete(packet(1).id, 1, true)).toBe(false)
  controller.dispose(); expect(controller.complete(packet(2).id, 2, true)).toBe(false)
  await Promise.resolve(); expect(ack.mock.calls.map(([arg]) => arg)).toEqual([
    { id: packet(1).id, sequence: 1, accepted: false }, { id: packet(2).id, sequence: 2, accepted: false }
  ])
})
