import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import {
  createSettingsChildInputBridge,
  type SettingsChildInputBridgeOptions
} from '../../packages/ztools-settings/src/childBridgeInput'
import type { SettingsBridgeTarget, SettingsNativeInvoke } from '../../packages/ztools-settings/src/childBridgeTypes'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}

function createBridge(invokeOverride?: SettingsNativeInvoke) {
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
  const errors: string[] = []
  let revision = 0
  const invoke: SettingsNativeInvoke = async (operation, payload, sessionId) => {
    calls.push({ operation, payload: structuredClone(payload) })
    if (invokeOverride) return invokeOverride(operation, payload, sessionId)
    if (operation === 'updateSubInput') {
      revision += 1
      return {
        version: 1,
        generation: payload.generation,
        revision,
        valueVersion: payload.action === 'value' ? revision : 0,
        applied: true
      }
    }
    if (operation === 'close') return { version: 1, sessionId, closed: true }
    throw new Error(`unexpected operation ${operation}`)
  }
  const target = new EventTarget() as SettingsBridgeTarget
  target.__ATOOLS_SETTINGS_VIEW_CONFIG__ = CONFIG
  const bridge = createSettingsChildBridge({
    config: CONFIG,
    invoke,
    reportError: (message) => errors.push(message)
  })
  bridge.attach(target)
  return { bridge, target, api: target.ztools as SettingsZToolsApi, calls, errors }
}

function createInputBridge(
  invokeOverride?: SettingsChildInputBridgeOptions['invokeNative'],
  previousHook?: SettingsBridgeTarget['__ATOOLS_SETTINGS_DELIVER_INPUT__']
) {
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
  const errors: string[] = []
  let revision = 0
  const target = new EventTarget() as SettingsBridgeTarget
  target.__ATOOLS_SETTINGS_DELIVER_INPUT__ = previousHook
  const bridge = createSettingsChildInputBridge({
    config: CONFIG,
    invokeNative: async (operation, payload) => {
      calls.push({ operation, payload: structuredClone(payload) })
      if (invokeOverride) return invokeOverride(operation, payload)
      revision += 1
      return {
        version: 1,
        generation: payload.generation,
        revision,
        valueVersion: 0,
        applied: true
      }
    },
    isLive: () => true,
    reportError: (message) => errors.push(message)
  })
  bridge.attach(target)
  return { bridge, target, calls, errors }
}

function delivery(generation: number, revision: number, text = '输入') {
  return {
    version: 1,
    sessionId: CONFIG.sessionId,
    bundleRevision: CONFIG.bundleRevision,
    generation,
    revision,
    text
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

describe('ztools settings child SubInput bridge', () => {
  it('serializes operations and counts the in-flight request toward the 32 item admission limit', async () => {
    const gate = deferred<unknown>()
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload: structuredClone(payload) })
      if (operation !== 'updateSubInput') throw new Error(`unexpected operation ${operation}`)
      if (calls.length === 1) return gate.promise
      return {
        version: 1,
        generation: payload.generation,
        revision: payload.sequence,
        valueVersion: 0,
        applied: true
      }
    }
    const { bridge, api, errors } = createBridge(invoke)
    const configured = api.setSubInput(() => {}, '', undefined)
    const admitted = Array.from({ length: 31 }, () => api.subInputFocus())
    expect(admitted.every(Boolean)).toBe(true)
    expect(api.subInputSelect()).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0].payload).toEqual({
      action: 'set', generation: 1, sequence: 1, placeholder: '搜索', focus: true
    })
    gate.resolve({
      version: 1, generation: 1, revision: 1, valueVersion: 0, applied: true
    })
    await expect(configured).resolves.toBe(true)
    await vi.waitFor(() => expect(calls).toHaveLength(32))
    expect(calls.map(({ payload }) => payload.sequence)).toEqual(
      Array.from({ length: 32 }, (_, index) => index + 1)
    )
    expect(calls.slice(1).every(({ payload }) => payload.action === 'focus')).toBe(true)
    expect(errors).toContain('输入框操作较多，请稍后重试。')
    bridge.dispose()
  })

  it('uses one callback owner and rejects stale generation, revision, and session deliveries', async () => {
    const { bridge, target, api } = createBridge()
    const first = vi.fn()
    const second = vi.fn()
    await expect(api.setSubInput(first, '第一项', false)).resolves.toBe(true)
    const deliver = target.__ATOOLS_SETTINGS_DELIVER_INPUT__!
    expect(deliver(delivery(1, 1, 'native current value'))).toBe(true)
    expect(deliver(delivery(1, 1, 'duplicate revision'))).toBe(false)
    expect(first).toHaveBeenCalledWith({ text: 'native current value' })

    await expect(api.setSubInput(second, '第二项', false)).resolves.toBe(true)
    expect(deliver(delivery(1, 3, 'stale generation'))).toBe(false)
    expect(deliver(delivery(2, 1, 'stale revision'))).toBe(false)
    const wrongSession = { ...delivery(2, 3), sessionId: 'c'.repeat(32) }
    expect(deliver(wrongSession)).toBe(false)
    expect(deliver(delivery(2, 3, 'current owner'))).toBe(true)
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledWith({ text: 'current owner' })

    const removing = api.removeSubInput()
    expect(deliver(delivery(2, 4, 'after remove'))).toBe(false)
    await expect(removing).resolves.toBe(true)
    expect(api.subInputFocus()).toBe(false)
    bridge.dispose()
  })

  it('accepts the first echo at the Native acknowledgement revision and rejects its duplicate', async () => {
    const { bridge, target, api } = createBridge(async (operation, payload) => {
      if (operation !== 'updateSubInput') throw new Error(`unexpected operation ${operation}`)
      return {
        version: 1,
        generation: payload.generation,
        revision: 17,
        valueVersion: 0,
        applied: true
      }
    })
    const callback = vi.fn()
    await expect(api.setSubInput(callback, '搜索', false)).resolves.toBe(true)
    const echo = delivery(1, 17, 'Main echo')

    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__!(echo)).toBe(true)
    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__!(echo)).toBe(false)
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith({ text: 'Main echo' })
    bridge.dispose()
  })

  it('preserves Promise<boolean> results, validates UTF-8 limits, and feeds values to the current callback', async () => {
    const { bridge, target, api, calls, errors } = createBridge()
    const callback = vi.fn()
    await expect(api.setSubInput(callback, '搜索项目', true)).resolves.toBe(true)
    await expect(api.setSubInputValue('项目')).resolves.toBe(true)
    expect(calls.at(-1)?.payload).toEqual({
      action: 'value', generation: 1, sequence: 2, value: '项目'
    })
    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__!(delivery(1, 3, '项目'))).toBe(true)
    expect(callback).toHaveBeenCalledWith({ text: '项目' })
    await expect(api.setSubInputValue('字'.repeat(16 * 1024 + 1))).resolves.toBe(false)
    await expect(api.setSubInput(() => {}, '字'.repeat(257), true)).resolves.toBe(false)
    expect(errors.length).toBeGreaterThanOrEqual(2)
    bridge.dispose()
  })

  it('reports native failures and resolves API promises false without leaking a rejection', async () => {
    const invoke: SettingsNativeInvoke = async () => { throw { code: 'SETTINGS_INPUT_CLOSED', message: 'private' } }
    const { bridge, api, errors } = createBridge(invoke)
    await expect(api.setSubInput(() => {}, 'test', false)).resolves.toBe(false)
    await expect(api.removeSubInput()).resolves.toBe(false)
    expect(errors).toHaveLength(2)
    expect(errors.every((message) => message === '输入框状态未同步，请重试。')).toBe(true)
    bridge.dispose()
  })

  it('invalidates pending owners on dispose, drops late packets, and restores the previous private hook', async () => {
    const gate = deferred<unknown>()
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      if (operation === 'updateSubInput') return gate.promise
      throw new Error(`unexpected operation ${operation}`)
    }
    const target = new EventTarget() as SettingsBridgeTarget
    target.__ATOOLS_SETTINGS_VIEW_CONFIG__ = CONFIG
    const previousHook = vi.fn(() => true)
    target.__ATOOLS_SETTINGS_DELIVER_INPUT__ = previousHook
    const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: vi.fn() })
    bridge.attach(target)
    bridge.dispose()
    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__).toBe(previousHook)

    const second = createBridge(invoke)
    const callback = vi.fn()
    const pending = second.api.setSubInput(callback, 'pending', true)
    const deliveryHook = second.target.__ATOOLS_SETTINGS_DELIVER_INPUT__!
    second.bridge.dispose()
    await expect(pending).resolves.toBe(false)
    gate.resolve({ version: 1, generation: 1, revision: 1, valueVersion: 0, applied: true })
    expect(deliveryHook(delivery(1, 2))).toBe(false)
    expect(callback).not.toHaveBeenCalled()
  })

  it('stops local input before onPluginOut callbacks while close and out acknowledgement still run', async () => {
    const order: string[] = []
    const { bridge, target, api, calls, errors } = createBridge(async (operation, payload, sessionId) => {
      if (operation === 'updateSubInput') {
        order.push(`native:${payload.action}`)
        return {
          version: 1, generation: payload.generation, revision: payload.sequence,
          valueVersion: 0, applied: true
        }
      }
      if (operation === 'close') {
        order.push('native:close')
        return { version: 1, sessionId, closed: true }
      }
      if (operation === 'outAcknowledged') {
        order.push('native:outAcknowledged')
        return { acknowledged: true }
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    await api.setSubInput(() => {}, 'test', false)
    let outPromises: Promise<boolean>[] = []
    let outControls: boolean[] = []
    api.onPluginOut(() => {
      order.push('callback')
      outPromises = [
        api.setSubInput(() => {}, 'late', false),
        api.removeSubInput(),
        api.setSubInputValue('late')
      ]
      outControls = [api.subInputFocus(), api.subInputBlur(), api.subInputSelect()]
    })
    await api.outPlugin()
    await expect(Promise.all(outPromises)).resolves.toEqual([false, false, false])
    expect(outControls).toEqual([false, false, false])
    expect(order).toEqual(['native:set', 'callback', 'native:close'])
    expect(calls.filter(({ operation }) => operation === 'updateSubInput')).toHaveLength(1)
    expect(errors).toEqual([])

    await expect(target.__ATOOLS_SETTINGS_DELIVER_OUT__!()).resolves.toEqual({ acknowledged: true })
    expect(order).toEqual(['native:set', 'callback', 'native:close', 'native:outAcknowledged'])
    bridge.dispose()
  })

  it('stops input before Escape close, keeps it stopped after failure, and allows close retry', async () => {
    const firstClose = deferred<unknown>()
    let closeAttempts = 0
    const { bridge, target, api, calls, errors } = createBridge(async (operation, payload, sessionId) => {
      if (operation === 'updateSubInput') {
        return {
          version: 1, generation: payload.generation, revision: payload.sequence,
          valueVersion: 0, applied: true
        }
      }
      if (operation === 'close') {
        closeAttempts += 1
        if (closeAttempts === 1) return firstClose.promise
        return { version: 1, sessionId, closed: true }
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    await api.setSubInput(() => {}, 'test', false)

    const composingEscape = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true })
    const preventedEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    preventedEscape.preventDefault()
    target.dispatchEvent(composingEscape)
    target.dispatchEvent(preventedEscape)
    expect(closeAttempts).toBe(0)
    await expect(api.setSubInputValue('still live after ignored Escape')).resolves.toBe(true)
    expect(calls.filter(({ operation }) => operation === 'updateSubInput')).toHaveLength(2)

    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(closeAttempts).toBe(1)
    const whileClosing = [
      api.setSubInput(() => {}, 'late', false),
      api.removeSubInput(),
      api.setSubInputValue('late')
    ]
    expect([api.subInputFocus(), api.subInputBlur(), api.subInputSelect()]).toEqual([false, false, false])
    await expect(Promise.all(whileClosing)).resolves.toEqual([false, false, false])
    expect(calls.filter(({ operation }) => operation === 'updateSubInput')).toHaveLength(2)
    expect(calls.filter(({ operation }) => operation === 'close')).toHaveLength(1)

    firstClose.reject(new Error('native close unavailable'))
    await vi.waitFor(() => expect(errors).toEqual(['无法关闭窗口，请重试。']))
    await expect(api.setSubInput(() => {}, 'after failure', false)).resolves.toBe(false)
    await expect(api.removeSubInput()).resolves.toBe(false)
    expect(api.subInputFocus()).toBe(false)
    expect(calls.filter(({ operation }) => operation === 'updateSubInput')).toHaveLength(2)

    await api.outPlugin()
    expect(closeAttempts).toBe(2)
    expect(calls.filter(({ operation }) => operation === 'close')).toHaveLength(2)
    expect(calls.filter(({ operation }) => operation === 'updateSubInput')).toHaveLength(2)
    expect(errors).toEqual(['无法关闭窗口，请重试。'])
    bridge.dispose()
  })

  it('stops input before an external out callback and still completes out acknowledgement on a fresh bridge', async () => {
    const order: string[] = []
    const { bridge, target, api, calls, errors } = createBridge(async (operation, payload) => {
      if (operation === 'updateSubInput') {
        order.push(`native:${payload.action}`)
        return {
          version: 1, generation: payload.generation, revision: payload.sequence,
          valueVersion: 0, applied: true
        }
      }
      if (operation === 'outAcknowledged') {
        order.push('native:outAcknowledged')
        return { acknowledged: true }
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    await api.setSubInput(() => {}, 'test', false)

    let lateInput: Promise<boolean>[] = []
    let lateControls: boolean[] = []
    api.onPluginOut(() => {
      order.push('callback')
      lateInput = [
        api.setSubInput(() => {}, 'late', false),
        api.removeSubInput(),
        api.setSubInputValue('late')
      ]
      lateControls = [api.subInputFocus(), api.subInputBlur(), api.subInputSelect()]
    })
    await expect(target.__ATOOLS_SETTINGS_DELIVER_OUT__!()).resolves.toEqual({ acknowledged: true })
    await expect(Promise.all(lateInput)).resolves.toEqual([false, false, false])
    expect(lateControls).toEqual([false, false, false])
    expect(order).toEqual(['native:set', 'callback', 'native:outAcknowledged'])
    expect(calls.filter(({ operation }) => operation === 'updateSubInput')).toHaveLength(1)
    expect(calls.filter(({ operation }) => operation === 'outAcknowledged')).toHaveLength(1)
    expect(calls.filter(({ operation }) => operation === 'close')).toHaveLength(0)
    expect(errors).toEqual([])
    bridge.dispose()
  })

  it('stop terminally settles queued and in-flight input locally and ignores late replies and echoes', async () => {
    const gate = deferred<unknown>()
    const previousHook = vi.fn(() => true)
    const { bridge, target, calls, errors } = createInputBridge(
      async () => gate.promise,
      previousHook
    )
    const firstCallback = vi.fn()
    const queuedCallback = vi.fn()
    const deliveryHook = target.__ATOOLS_SETTINGS_DELIVER_INPUT__!
    const inFlight = bridge.setSubInput(firstCallback, 'first', false)
    const queuedValue = bridge.setSubInputValue('queued')
    const queuedSet = bridge.setSubInput(queuedCallback, 'next', false)
    const queuedControls = [bridge.subInputFocus(), bridge.subInputBlur(), bridge.subInputSelect()]

    expect(queuedControls).toEqual([true, true, true])
    expect(calls).toHaveLength(1)
    expect(calls[0].payload.action).toBe('set')

    bridge.stop()
    await expect(Promise.all([inFlight, queuedValue, queuedSet])).resolves.toEqual([false, false, false])
    expect(bridge.subInputFocus()).toBe(false)
    expect(bridge.subInputBlur()).toBe(false)
    expect(bridge.subInputSelect()).toBe(false)
    await expect(bridge.removeSubInput()).resolves.toBe(false)
    await expect(bridge.setSubInput()).resolves.toBe(false)
    await expect(bridge.setSubInputValue('after stop')).resolves.toBe(false)
    expect(calls).toHaveLength(1)
    expect(errors).toEqual([])
    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__).toBe(deliveryHook)
    expect(deliveryHook(delivery(2, 2, 'late echo'))).toBe(false)
    expect(firstCallback).not.toHaveBeenCalled()
    expect(queuedCallback).not.toHaveBeenCalled()

    gate.resolve({ version: 1, generation: 1, revision: 1, valueVersion: 0, applied: true })
    await gate.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toHaveLength(1)
    expect(errors).toEqual([])

    bridge.dispose()
    bridge.dispose()
    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__).toBe(previousHook)
    expect(deliveryHook(delivery(2, 3, 'post-dispose echo'))).toBe(false)
    expect(previousHook).not.toHaveBeenCalled()
  })

  it('stop remains terminal when the Child input was already invisible', async () => {
    const { bridge, calls, errors } = createInputBridge()
    await expect(bridge.setSubInput(() => {}, 'test', false)).resolves.toBe(true)
    await expect(bridge.removeSubInput()).resolves.toBe(true)
    expect(calls).toHaveLength(2)

    bridge.stop()
    await expect(bridge.setSubInput(() => {}, 'late', false)).resolves.toBe(false)
    await expect(bridge.removeSubInput()).resolves.toBe(false)
    await expect(bridge.setSubInputValue('late')).resolves.toBe(false)
    expect(bridge.subInputFocus()).toBe(false)
    expect(bridge.subInputBlur()).toBe(false)
    expect(bridge.subInputSelect()).toBe(false)
    expect(calls).toHaveLength(2)
    expect(errors).toEqual([])
    bridge.dispose()
  })

  it('does not submit focus when the attached settings session config changes', async () => {
    const { bridge, target, api, calls } = createBridge()
    await api.setSubInput(() => {}, 'test', false)
    const oldHook = vi.fn(() => true)
    target.__ATOOLS_SETTINGS_DELIVER_INPUT__ = oldHook
    target.__ATOOLS_SETTINGS_VIEW_CONFIG__ = { ...CONFIG, sessionId: 'c'.repeat(32) }
    expect(api.subInputFocus()).toBe(false)
    expect(target.__ATOOLS_SETTINGS_DELIVER_INPUT__).toBe(oldHook)
    expect(calls.filter(({ operation, payload }) => operation === 'updateSubInput' && payload.action === 'focus'))
      .toHaveLength(0)
    bridge.dispose()
  })
})
