import { describe, expect, it, vi } from 'vitest'
import { EDITABLE_GENERAL_FIELDS, isRecord } from '../../packages/ztools-settings/src/childBridgeProtocol'
import type { SettingsBridgeTarget, SettingsViewConfig } from '../../packages/ztools-settings/src/childBridgeTypes'
import { CONFIG, createBridge } from './ztoolsSettingsChildLaunchAtLoginBridgeFixture'

describe('ztools Settings Child launch-at-login bridge', () => {
  it('confirms a same-value request with native CAS instead of trusting the bootstrap cache', async () => {
    const bridge = createBridge(true, {
      setNative: async (payload, state) => {
        expect(payload).toEqual({ enabled: false, expected: false })
        state.setEnabled(true)
        throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
      }
    })

    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
    await expect(bridge.internal.setLaunchAtLogin(false)).rejects.toMatchObject({
      code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
    })
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(true)
    expect(bridge.calls.filter(({ operation }) => operation === 'readLaunchAtLogin'))
      .toEqual([{ operation: 'readLaunchAtLogin', payload: {} }])
    expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin').map(({ payload }) => payload))
      .toEqual([{ enabled: false, expected: false }])
    bridge.bridge.dispose()
  })

  it('recovers a null runtime cache through one fresh Native read without rereading confirmed values', async () => {
    const bridge = createBridge(true, {
      setNative: async (_payload, state) => {
        state.setEnabled(true)
        throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
      }
    })

    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
    await expect(bridge.internal.setLaunchAtLogin(true)).rejects.toMatchObject({
      code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
    })
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(true)
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(true)
    expect(bridge.calls.filter(({ operation }) => operation === 'readLaunchAtLogin'))
      .toEqual([{ operation: 'readLaunchAtLogin', payload: {} }])
    bridge.bridge.dispose()
  })

  it('keeps an invalid fresh Native read unknown and never accepts its value', async () => {
    for (const reply of [{ enabled: true, extra: false }, { enabled: 'true' }, null]) {
      const bridge = createBridge(true, {
        initialEnabled: null,
        readNative: async () => reply
      })
      await expect(bridge.internal.getLaunchAtLogin()).rejects.toMatchObject({
        code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
      })
      await expect(bridge.internal.setLaunchAtLogin(false)).rejects.toMatchObject({
        code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
      })
      expect(bridge.calls.filter(({ operation }) => operation === 'readLaunchAtLogin')).toHaveLength(1)
      expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(0)
      bridge.bridge.dispose()
    }
  })

  it('uses the global host factory used by patched General with exact Native reply objects', async () => {
    const bridge = createBridge()
    const factory = bridge.target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__
    expect(factory).toBeTypeOf('function')
    const controller = factory!(bridge.internal)

    await expect(controller.start()).resolves.toBe(true)
    expect(controller.state().enabled).toBe(false)
    await expect(controller.setEnabled(true)).resolves.toBe(true)
    expect(controller.state().enabled).toBe(true)
    await expect(controller.setEnabled(false)).resolves.toBe(true)
    expect(controller.state().enabled).toBe(false)
    expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin').map(({ payload }) => payload))
      .toEqual([{ enabled: true, expected: false }, { enabled: false, expected: true }])
    expect(bridge.calls.filter(({ operation }) => operation === 'readLaunchAtLogin')).toHaveLength(0)
    controller.dispose()
    bridge.bridge.dispose()

    const legacy = createBridge(true, {
      initialEnabled: null,
      inspectLegacy: async () => ({ modernEnabled: false, revision: 'c'.repeat(64) }),
      resolveLegacy: async (_request, state) => {
        state.setEnabled(true)
        return { enabled: true }
      }
    })
    const legacyController = legacy.target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__!(
      legacy.internal
    )
    await expect(legacyController.start()).resolves.toBe(true)
    expect(legacyController.state().phase).toBe('legacy')
    await expect(legacyController.resolveLegacy('migrate')).resolves.toBe(true)
    expect(legacyController.state()).toMatchObject({ phase: 'ready', enabled: true })
    expect(legacy.calls.filter(({ operation }) => operation === 'inspectLegacyLaunchAtLogin'))
      .toEqual([{ operation: 'inspectLegacyLaunchAtLogin', payload: {} }])
    legacyController.dispose()
    legacy.bridge.dispose()
  })

  it('uses actual runtime state as CAS baseline and accepts only a matching readback', async () => {
    const { bridge, calls, internal, target } = createBridge()

    await expect(internal.getLaunchAtLogin()).resolves.toBe(false)
    await expect(internal.setLaunchAtLogin(true)).resolves.toBeUndefined()
    await expect(internal.getLaunchAtLogin()).resolves.toBe(true)
    await expect(internal.setLaunchAtLogin(false)).resolves.toBeUndefined()

    expect(calls.filter(({ operation }) => operation === 'setLaunchAtLogin').map(({ payload }) => payload))
      .toEqual([{ enabled: true, expected: false }, { enabled: false, expected: true }])
    expect(calls.filter(({ operation }) => operation === 'ready')).toHaveLength(1)
    expect(calls.filter(({ operation }) => operation === 'inspectLegacyLaunchAtLogin')).toHaveLength(0)
    expect(typeof target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__).toBe('function')
    bridge.dispose()
    expect(target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__).toBeUndefined()
  })

  it('rejects malformed values before native IPC', async () => {
    const { bridge, calls, internal } = createBridge()
    await expect(internal.setLaunchAtLogin('true' as unknown as boolean)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    expect(calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(0)
    bridge.dispose()
  })

  it('treats unavailable bootstrap state and CAS conflicts as unknown, never as a cached false', async () => {
    const unavailable = createBridge(false)
    await expect(unavailable.internal.getLaunchAtLogin()).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED'
    })
    await expect(unavailable.internal.setLaunchAtLogin(true)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED'
    })
    expect(unavailable.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(0)
    unavailable.bridge.dispose()

    const conflict = createBridge()
    conflict.setConflict(true)
    await expect(conflict.internal.setLaunchAtLogin(true)).rejects.toMatchObject({
      code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
    })
    await expect(conflict.internal.getLaunchAtLogin()).resolves.toBe(false)
    expect(conflict.reportError).toHaveBeenCalled()
    conflict.bridge.dispose()
  })

  it('accepts available-but-unknown runtime state only through validated legacy inspection', async () => {
    const inspection = { modernEnabled: false, revision: 'a'.repeat(64) }
    const bridge = createBridge(true, {
      initialEnabled: null,
      inspectLegacy: async () => inspection,
      resolveLegacy: async (payload, state) => {
        expect(payload).toEqual({
          choice: 'migrate', expectedModern: false, revision: inspection.revision
        })
        state.setEnabled(true)
        return { enabled: true }
      }
    })

    await expect(bridge.internal.getLaunchAtLogin()).rejects.toMatchObject({
      code: 'SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION'
    })
    await expect(bridge.internal.inspectLegacyLaunchAtLogin()).resolves.toEqual(inspection)
    await expect(bridge.internal.resolveLegacyLaunchAtLogin({
      choice: 'migrate', expectedModern: false, revision: inspection.revision
    })).resolves.toEqual({ enabled: true })
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(true)
    expect(bridge.calls.filter(({ operation }) => operation === 'inspectLegacyLaunchAtLogin'))
      .toEqual([{ operation: 'inspectLegacyLaunchAtLogin', payload: {} }])
    expect(bridge.calls.filter(({ operation }) => operation === 'resolveLegacyLaunchAtLogin'))
      .toEqual([{
        operation: 'resolveLegacyLaunchAtLogin',
        payload: { choice: 'migrate', expectedModern: false, revision: inspection.revision }
      }])
    bridge.bridge.dispose()
  })

  it('accepts null only when launch-at-login is available and rejects a value marked unavailable', async () => {
    const availableUnknown = createBridge(true, {
      initialEnabled: null,
      inspectLegacy: async () => ({ modernEnabled: false, revision: 'd'.repeat(64) })
    })
    await expect(availableUnknown.internal.inspectLegacyLaunchAtLogin()).resolves.toEqual({
      modernEnabled: false, revision: 'd'.repeat(64)
    })
    availableUnknown.bridge.dispose()

    const unavailableValue = createBridge(false, {
      readyAvailable: false,
      readyLaunchAtLogin: false
    })
    await expect(unavailableValue.internal.getLaunchAtLogin()).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    unavailableValue.bridge.dispose()
  })

  it('rejects malformed inspection and resolution values before mutating cached OS state', async () => {
    const bridge = createBridge(true, {
      initialEnabled: null,
      inspectLegacy: async () => ({ modernEnabled: false, revision: 'A'.repeat(64) }),
      resolveLegacy: async () => ({ enabled: true, extra: false })
    })
    await expect(bridge.internal.inspectLegacyLaunchAtLogin()).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    await expect(bridge.internal.resolveLegacyLaunchAtLogin({
      choice: 'delete', expectedModern: false, revision: 'a'.repeat(64)
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(bridge.calls.filter(({ operation }) => operation === 'resolveLegacyLaunchAtLogin')).toHaveLength(0)
    await expect(bridge.internal.resolveLegacyLaunchAtLogin({
      choice: 'turnOff', expectedModern: false, revision: 'a'.repeat(64)
    })).rejects.toMatchObject({ code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' })
    await expect(bridge.internal.getLaunchAtLogin()).rejects.toMatchObject({
      code: 'SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION'
    })
    bridge.bridge.dispose()
  })

  it('rejects unknown or extra receipt fields and fences the session as unknown', async () => {
    for (const reply of [{ enabled: 'true' }, { enabled: true, extra: false }, {}]) {
      const bridge = createBridge(true, { setNative: async () => reply })
      await expect(bridge.internal.setLaunchAtLogin(true)).rejects.toMatchObject({
        code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
      })
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
      await expect(bridge.internal.setLaunchAtLogin(false)).rejects.toMatchObject({
        code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT'
      })
      expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(2)
      expect(bridge.reportError).toHaveBeenCalled()
      bridge.bridge.dispose()
    }
  })

  it('serializes concurrent checkbox writes and uses the last confirmed state as expected', async () => {
    const gate: { releaseFirst?: () => void } = {}
    let firstWrite = true
    const bridge = createBridge(true, {
      setNative: async (payload, state) => {
        if (payload.expected !== state.getEnabled()) {
          throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
        }
        state.setEnabled(payload.enabled as boolean)
        if (firstWrite) {
          firstWrite = false
          await new Promise<void>((resolve) => { gate.releaseFirst = resolve })
        }
        return { enabled: state.getEnabled() }
      }
    })
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
    const first = bridge.internal.setLaunchAtLogin(true)
    const second = bridge.internal.setLaunchAtLogin(false)
    await vi.waitFor(() => {
      expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(1)
    })
    gate.releaseFirst?.()
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined])
    expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin').map(({ payload }) => payload))
      .toEqual([{ enabled: true, expected: false }, { enabled: false, expected: true }])
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
    bridge.bridge.dispose()
  })

  it('serializes launch-at-login mutations with other General runtime writes', async () => {
    const gate: { release?: (value: unknown) => void } = {}
    const bridge = createBridge(true, {
      setNative: async (payload, state) => new Promise((resolve) => {
        gate.release = (value) => {
          state.setEnabled(payload.enabled as boolean)
          resolve(value)
        }
      })
    })
    const launchWrite = bridge.internal.setLaunchAtLogin(true)
    await vi.waitFor(() => {
      expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(1)
    })

    const opacityWrite = bridge.internal.setWindowOpacity(0.75)
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)

    gate.release?.({ enabled: true })
    await Promise.all([launchWrite, opacityWrite])
    expect(bridge.calls.map(({ operation }) => operation).filter((operation) =>
      operation === 'setLaunchAtLogin' || operation === 'patchGeneral'
    )).toEqual(['setLaunchAtLogin', 'patchGeneral'])
    bridge.bridge.dispose()
  })

  it('serializes legacy resolution with ordinary launch-item writes and uses its confirmed readback', async () => {
    let release!: (value: unknown) => void
    const calls: Array<Record<string, unknown>> = []
    const bridge = createBridge(true, {
      initialEnabled: null,
      resolveLegacy: async (payload, state) => {
        calls.push({ operation: 'resolve', payload })
        return await new Promise((resolve) => {
          release = (value) => {
            if (isRecord(value) && typeof value.enabled === 'boolean') state.setEnabled(value.enabled)
            resolve(value)
          }
        })
      },
      setNative: async (payload, state) => {
        calls.push({ operation: 'set', payload })
        if (payload.expected !== state.getEnabled()) throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
        state.setEnabled(payload.enabled as boolean)
        return { enabled: state.getEnabled() }
      }
    })
    const resolution = bridge.internal.resolveLegacyLaunchAtLogin({
      choice: 'turnOff', expectedModern: false, revision: 'e'.repeat(64)
    })
    const followingWrite = bridge.internal.setLaunchAtLogin(true)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(calls[0].operation).toBe('resolve')

    release({ enabled: false })
    await expect(Promise.all([resolution, followingWrite])).resolves.toEqual([
      { enabled: false }, undefined
    ])
    expect(calls.map((call) => call.operation)).toEqual(['resolve', 'set'])
    expect(calls[1].payload).toEqual({ enabled: true, expected: false })
    bridge.bridge.dispose()
  })

  it.each([
    [
      'SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED',
      '请在系统设置中允许开机启动。'
    ],
    [
      'SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION',
      '发现旧启动项，请关闭或迁移。'
    ]
  ])('keeps the checkbox mutation rejected on known no-commit failure %s', async (code, message) => {
    const bridge = createBridge(true, {
      setNative: async () => { throw { code } }
    })
    const checkedBefore = await bridge.internal.getLaunchAtLogin()
    let checked = true
    await expect(bridge.internal.setLaunchAtLogin(checked)).rejects.toMatchObject({
      code
    })
    checked = checkedBefore
    expect(checked).toBe(false)
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
    expect(bridge.reportError).toHaveBeenCalledWith(message)
    bridge.bridge.dispose()
  })

  it.each([
    ['SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED', 'approval'],
    ['SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION', 'legacy']
  ] as const)('freshly reads after a known rejection before retrying: %s', async (code, outcome) => {
    const inspection = { modernEnabled: false, revision: 'f'.repeat(64) }
    const bridge = createBridge(true, {
      initialEnabled: false,
      setNative: async () => { throw { code } },
      readNative: async () => {
        if (outcome === 'legacy') throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION' }
        return { enabled: true }
      },
      inspectLegacy: async () => inspection
    })
    const controller = bridge.target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__!(bridge.internal)

    await expect(controller.start()).resolves.toBe(true)
    expect(controller.state()).toMatchObject({ phase: 'ready', enabled: false })
    await expect(controller.setEnabled(true)).resolves.toBe(false)
    expect(controller.state()).toMatchObject({ phase: 'error', enabled: null })
    await expect(controller.refresh()).resolves.toBe(true)

    expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin'))
      .toEqual([{ operation: 'setLaunchAtLogin', payload: { enabled: true, expected: false } }])
    expect(bridge.calls.filter(({ operation }) => operation === 'readLaunchAtLogin'))
      .toEqual([{ operation: 'readLaunchAtLogin', payload: {} }])
    if (outcome === 'legacy') {
      expect(controller.state()).toMatchObject({ phase: 'legacy', enabled: null, legacy: inspection })
      expect(bridge.calls.filter(({ operation }) => operation === 'inspectLegacyLaunchAtLogin'))
        .toEqual([{ operation: 'inspectLegacyLaunchAtLogin', payload: {} }])
    } else {
      expect(controller.state()).toMatchObject({ phase: 'ready', enabled: true })
      expect(bridge.calls.filter(({ operation }) => operation === 'inspectLegacyLaunchAtLogin')).toHaveLength(0)
    }
    controller.dispose()
    bridge.bridge.dispose()
  })

  it.each([
    'SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE',
    'SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED'
  ])('requires reopen when native status cannot be confirmed: %s', async (code) => {
    const bridge = createBridge(true, {
      setNative: async () => { throw { code } },
      readNative: async () => { throw { code } }
    })
    await expect(bridge.internal.setLaunchAtLogin(true)).rejects.toMatchObject({ code })
    await expect(bridge.internal.getLaunchAtLogin()).rejects.toMatchObject({
      code
    })
    expect(bridge.reportError).toHaveBeenCalled()
    bridge.bridge.dispose()
  })

  it('cancels an old document write so a late receipt cannot change a reopened session', async () => {
    const gate: { release?: (value: unknown) => void } = {}
    let externalState = false
    const target = new EventTarget() as SettingsBridgeTarget
    const old = createBridge(true, {
      target,
      config: CONFIG,
      initialEnabled: externalState,
      setNative: async (payload, state) => {
        if (payload.expected !== state.getEnabled()) {
          throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
        }
        externalState = payload.enabled as boolean
        state.setEnabled(externalState)
        return new Promise((resolve) => { gate.release = resolve })
      }
    })
    await expect(old.internal.getLaunchAtLogin()).resolves.toBe(false)
    const pending = old.internal.setLaunchAtLogin(true)
    await vi.waitFor(() => {
      expect(old.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(1)
    })
    old.bridge.dispose()

    const nextConfig = { ...CONFIG, sessionId: 'b'.repeat(32) }
    const reopened = createBridge(true, { target, config: nextConfig, initialEnabled: externalState })
    await expect(pending).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    gate.release?.({ enabled: true })
    await expect(reopened.internal.getLaunchAtLogin()).resolves.toBe(true)
    expect(reopened.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(0)
    old.bridge.dispose()
    reopened.bridge.dispose()
  })

  it('bounds in-flight changes and rejects queued calls when the document closes', async () => {
    const gate: { release?: (value: unknown) => void } = {}
    const bridge = createBridge(true, {
      setNative: async (payload) => new Promise((resolve) => {
        void payload
        gate.release = resolve
      })
    })
    await expect(bridge.internal.getLaunchAtLogin()).resolves.toBe(false)
    const pending = [bridge.internal.setLaunchAtLogin(true)]
    await vi.waitFor(() => {
      expect(bridge.calls.filter(({ operation }) => operation === 'setLaunchAtLogin')).toHaveLength(1)
    })
    for (let index = 0; index < 31; index += 1) {
      pending.push(bridge.internal.setLaunchAtLogin(index % 2 === 0))
    }
    await expect(bridge.internal.setLaunchAtLogin(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_QUEUE_FULL'
    })
    bridge.bridge.dispose()
    const outcomes = await Promise.allSettled(pending)
    expect(outcomes).toHaveLength(32)
    expect(outcomes.every((outcome) => outcome.status === 'rejected')).toBe(true)
    gate.release?.({ enabled: true })
  })
})
