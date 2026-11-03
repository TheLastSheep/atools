import { expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsNativeLocalDropDto } from '../../packages/ztools-settings/src/childBridgeLocalDrop'
import type { SettingsBridgeTarget, SettingsNativeInvoke } from '../../packages/ztools-settings/src/childBridgeTypes'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}

function createTarget(hash = '#/localLaunch?_t=1'): SettingsBridgeTarget {
  const target = new EventTarget() as SettingsBridgeTarget
  target.location = { hash }
  return target
}

function nativeDeliver(target: SettingsBridgeTarget): (value: unknown) => void {
  const deliver = target.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__
  if (typeof deliver !== 'function') throw new Error('Native local-drop hook was not attached')
  return deliver
}

function onNativeLocalDrop(target: SettingsBridgeTarget): (callback: (value: SettingsNativeLocalDropDto) => void) => () => void {
  const internal = (target.ztools as { internal: Record<string, unknown> }).internal
  const subscribe = internal.onNativeLocalDrop
  if (typeof subscribe !== 'function') throw new Error('Native local-drop subscription is missing')
  return subscribe as (callback: (value: SettingsNativeLocalDropDto) => void) => () => void
}

function dto(overrides: Partial<SettingsNativeLocalDropDto> = {}): SettingsNativeLocalDropDto {
  return {
    version: 1,
    sessionId: CONFIG.sessionId,
    revision: 1,
    phase: 'result',
    added: 1,
    failed: 0,
    busy: false,
    rejected: false,
    ...overrides
  }
}

function createBridge() {
  const invoke = vi.fn(async () => ({})) as unknown as SettingsNativeInvoke
  return createSettingsChildBridge({ config: CONFIG, invoke, reportError: () => {} })
}

it('attaches the native hook, delivers the fixed DTO through internal registration, and restores the hook', () => {
  const target = createTarget()
  const previous = vi.fn()
  target.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__ = previous
  const bridge = createBridge()
  bridge.attach(target)
  const deliver = nativeDeliver(target)
  const callback = vi.fn()
  const unsubscribe = onNativeLocalDrop(target)(callback)
  const event = dto()

  deliver(event)
  expect(callback).toHaveBeenCalledTimes(1)
  expect(callback).toHaveBeenLastCalledWith(event)
  unsubscribe()
  unsubscribe()
  deliver(dto({ revision: 2 }))
  expect(callback).toHaveBeenCalledTimes(1)

  bridge.dispose()
  expect(target.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__).toBe(previous)
  deliver(dto({ revision: 3 }))
  expect(callback).toHaveBeenCalledTimes(1)
})

it('accepts only exact local-launch identities, clears with a derived leave, and never replays old notices', () => {
  const target = createTarget('#/localLaunch')
  const bridge = createBridge()
  bridge.attach(target)
  const deliver = nativeDeliver(target)
  const subscribe = onNativeLocalDrop(target)
  const inactive = vi.fn()
  const inactiveUnsubscribe = subscribe(inactive)
  deliver(dto())
  expect(inactive).toHaveBeenCalledTimes(1)

  let revision = 2
  for (const hash of [
    '#/localLaunch?_t=0', '#/localLaunch?_t=01', '#/localLaunch?_t=1.5',
    '#/localLaunch?_t=2&_t=3', '#/localLaunch?_t=2&extra=3',
    '#/localLaunch?%5Ft=2', '#/localLaunch?_t=%32', '#/localLaunch?_t=2&',
    '#/localLaunch?_t=9007199254740992', '#/localLaunch?_t=12345678901234567',
    '#/localLaunch/child?_t=4', '#/localLaunch#fragment', '#/localLaunch?'
  ]) {
    target.location!.hash = hash
    target.dispatchEvent(new Event('hashchange'))
    const rejectedRoute = vi.fn()
    const stop = subscribe(rejectedRoute)
    deliver(dto({ revision }))
    revision += 1
    expect(rejectedRoute).not.toHaveBeenCalled()
    stop()
  }

  target.location!.hash = '#/localLaunch?_t=9007199254740991'
  target.dispatchEvent(new Event('hashchange'))
  const first = vi.fn()
  const firstUnsubscribe = subscribe(first)
  expect(first).not.toHaveBeenCalled()
  const accepted = dto({ revision, added: 2, failed: 1 })
  deliver(accepted)
  expect(first).toHaveBeenCalledTimes(1)
  expect(first).toHaveBeenLastCalledWith(accepted)

  target.location!.hash = '#/search?_t=8'
  target.dispatchEvent(new Event('hashchange'))
  expect(first).toHaveBeenLastCalledWith({
    ...accepted, phase: 'leave', added: 0, failed: 0, busy: false, rejected: false
  })
  deliver(dto({ revision: revision + 1 }))
  expect(first).toHaveBeenCalledTimes(2)

  target.location!.hash = '#/localLaunch?_t=9'
  target.dispatchEvent(new Event('hashchange'))
  const second = vi.fn()
  const secondUnsubscribe = subscribe(second)
  firstUnsubscribe()
  inactiveUnsubscribe()
  deliver(dto({ revision: revision + 2 }))
  expect(second).toHaveBeenCalledTimes(1)
  expect(second).toHaveBeenLastCalledWith(dto({ revision: revision + 2 }))
  secondUnsubscribe()
  bridge.dispose()
})

it('rejects malformed, stale, wrong-session, and over-capacity deliveries without leaking callback errors', () => {
  const target = createTarget()
  const bridge = createBridge()
  bridge.attach(target)
  const deliver = nativeDeliver(target)
  const subscribe = onNativeLocalDrop(target)
  let callbackCalls = 0
  const throwingCallback = () => {
    callbackCalls += 1
    throw new Error('sensitive callback detail')
  }
  const unsubscribe = subscribe(throwingCallback)
  expect(() => subscribe(() => {})).toThrowError('监听数量已达上限。')

  const invalid: unknown[] = [
    { ...dto(), missing: undefined },
    Object.fromEntries(Object.entries(dto()).filter(([key]) => key !== 'failed')),
    dto({ version: 2 } as never),
    dto({ sessionId: 'different-session' }),
    dto({ revision: Number.MAX_SAFE_INTEGER + 1 }),
    dto({ phase: 'unknown' } as never),
    dto({ added: -1 }),
    dto({ added: 1.5 }),
    dto({ failed: 65 }),
    dto({ added: 40, failed: 25 }),
    dto({ busy: true, rejected: true }),
    dto({ busy: true, added: 1 }),
    dto({ phase: 'enter', rejected: true }),
    dto({ phase: 'leave', added: 1 })
  ]
  for (const value of invalid) deliver(value)
  const accessor = dto()
  Object.defineProperty(accessor, 'added', { enumerable: true, get: () => { throw new Error('secret') } })
  deliver(accessor)
  expect(callbackCalls).toBe(0)

  expect(() => deliver(dto())).not.toThrow()
  expect(() => deliver(dto({ revision: 2 }))).not.toThrow()
  deliver(dto({ revision: 2 }))
  deliver(dto({ revision: 1 }))
  expect(callbackCalls).toBe(2)
  unsubscribe()
  bridge.dispose()
})
