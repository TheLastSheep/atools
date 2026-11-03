import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsBridgeTarget, SettingsNativeInvoke } from '../../packages/ztools-settings/src/childBridgeTypes'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}
const BASE_TOKEN = '11111111-1111-4111-8111-111111111111'
const SECOND_TOKEN = '22222222-2222-4222-8222-222222222222'
const EXTERNAL_TOKEN = '33333333-3333-4333-8333-333333333333'
const DISABLED_COMMANDS = ['legacy:opaque-id', 'plugin-x:feature-y:command-z']
const WRITE_REPLY = { version: 1, success: true, changed: true, notificationDelivered: true }

type Call = { operation: string; payload: Record<string, unknown> }

function settingsSnapshot(disabledCommands: string[] | null = []): Record<string, unknown> {
  return {
    'disable-commands': disabledCommands,
    'pinned-commands': [],
    'super-panel-pinned': [],
    'global-shortcuts': [],
    'app-shortcuts': []
  }
}

function dataPage(text: string, offset: number, token = BASE_TOKEN): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text)
  const nextOffset = Math.min(offset + 12 * 1024, bytes.byteLength)
  let binary = ''
  for (const byte of bytes.subarray(offset, nextOffset)) binary += String.fromCharCode(byte)
  return {
    version: 1,
    kind: 'commandSettings',
    token,
    offset,
    nextOffset,
    totalBytes: bytes.byteLength,
    data: btoa(binary)
  }
}

interface HarnessOptions {
  disabledCommands?: string[] | null
  token?: string
  snapshot?: () => Record<string, unknown>
  currentToken?: () => string
  onRead?: () => unknown | Promise<unknown>
  onWrite?: (payload: Record<string, unknown>) => unknown | Promise<unknown>
}

function makeHarness(options: HarnessOptions = {}) {
  const calls: Call[] = []
  const text = () => JSON.stringify(options.snapshot?.() ?? settingsSnapshot(options.disabledCommands ?? []))
  const token = () => options.currentToken?.() ?? options.token ?? BASE_TOKEN
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'readCommandSettings') {
      return options.onRead ? options.onRead() : dataPage(text(), 0, token())
    }
    if (operation === 'readCommandDataPage') {
      return dataPage(text(), payload.offset as number, token())
    }
    if (operation === 'writeDisabledCommands') {
      return options.onWrite ? options.onWrite(payload) : WRITE_REPLY
    }
    if (operation === 'mutateSearchPin') return { version: 1, revision: 1 }
    throw new Error(`unexpected operation ${operation}`)
  }
  const { bridge, internal, reportError } = makeBridge(invoke)
  return { bridge, internal, reportError, calls }
}

function makeBridge(invoke: SettingsNativeInvoke) {
  const target = new EventTarget() as SettingsBridgeTarget
  const reportError = vi.fn()
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError })
  bridge.attach(target)
  return { bridge, internal: (target.ztools as SettingsZToolsApi).internal, reportError }
}

function notifyDisabledCommandsChanged(internal: SettingsZToolsApi['internal']): Promise<unknown> {
  return internal.notifyDisabledCommandsChanged()
}

describe('ztools settings child disabled-command write bridge', () => {
  it('routes original dbPut and notify calls through one CAS write and consumes its receipt once', async () => {
    const calls: Call[] = []
    const text = JSON.stringify(settingsSnapshot())
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readCommandSettings') return dataPage(text, 0)
      if (operation === 'writeDisabledCommands') {
        return WRITE_REPLY
      }
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, internal } = makeBridge(invoke)

    await internal.dbPut('disable-commands', DISABLED_COMMANDS)
    await expect(notifyDisabledCommandsChanged(internal)).resolves.toEqual({ success: true })

    expect(calls).toEqual([
      { operation: 'readCommandSettings', payload: {} },
      {
        operation: 'writeDisabledCommands',
        payload: { baseToken: BASE_TOKEN, value: DISABLED_COMMANDS }
      }
    ])
    await expect(notifyDisabledCommandsChanged(internal)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_RECEIPT_NOT_AVAILABLE'
    })
    bridge.dispose()
  })

  it('confirms a no-op save without requiring a native notification', async () => {
    const { bridge, internal, calls } = makeHarness({
      onWrite: () => ({ version: 1, success: true, changed: false, notificationDelivered: false })
    })

    await internal.dbPut('disable-commands', [])
    await expect(notifyDisabledCommandsChanged(internal)).resolves.toEqual({ success: true })
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    bridge.dispose()
  })

  it('reports a saved write whose main-window refresh was not confirmed and exposes no receipt', async () => {
    const { bridge, internal, reportError, calls } = makeHarness({
      onWrite: () => ({ version: 1, success: true, changed: true, notificationDelivered: false })
    })

    await expect(internal.dbPut('disable-commands', DISABLED_COMMANDS)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_REFRESH_UNCONFIRMED',
      message: expect.stringContaining('已保存')
    })
    expect(reportError).toHaveBeenCalledWith(expect.stringContaining('刷新未确认'))
    await expect(notifyDisabledCommandsChanged(internal)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_RECEIPT_NOT_AVAILABLE'
    })
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    bridge.dispose()
  })

  it('requires an explicit disabled-command read after a Native CAS conflict', async () => {
    let writeAttempts = 0
    const { bridge, internal, calls } = makeHarness({
      onWrite: () => {
        writeAttempts += 1
        if (writeAttempts === 1) throw { code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT' }
        return WRITE_REPLY
      }
    })

    await expect(internal.dbPut('disable-commands', DISABLED_COMMANDS)).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT'
    })
    await expect(internal.dbPut('disable-commands', DISABLED_COMMANDS)).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT'
    })
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    await internal.dbGet('disable-commands')
    await internal.dbPut('disable-commands', DISABLED_COMMANDS)
    expect(calls.filter(({ operation }) => operation === 'readCommandSettings')).toHaveLength(2)
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')
      .map(({ payload }) => payload.baseToken)).toEqual([BASE_TOKEN, BASE_TOKEN])
    bridge.dispose()
  })

  it('requires an explicit disabled-command read after an uncertain commit', async () => {
    let writeAttempts = 0
    const { bridge, internal, calls } = makeHarness({
      onWrite: () => {
        writeAttempts += 1
        if (writeAttempts === 1) throw { code: 'SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN' }
        return WRITE_REPLY
      }
    })

    await expect(internal.dbPut('disable-commands', DISABLED_COMMANDS)).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN',
      message: expect.stringContaining('回执未知')
    })
    await expect(internal.dbPut('disable-commands', DISABLED_COMMANDS)).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT'
    })
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    await internal.dbGet('disable-commands')
    await internal.dbPut('disable-commands', DISABLED_COMMANDS)
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(2)
    expect(calls.filter(({ operation }) => operation === 'readCommandSettings')).toHaveLength(2)
    bridge.dispose()
  })

  it('blocks an old UI list after another writer changes it and resumes after an explicit read', async () => {
    let stored = ['A']
    let token = BASE_TOKEN
    const { bridge, internal, calls } = makeHarness({
      snapshot: () => settingsSnapshot(stored),
      currentToken: () => token,
      onWrite: (payload) => {
        if (payload.baseToken !== token) throw { code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT' }
        stored = (payload.value as string[]).slice()
        token = SECOND_TOKEN
        return WRITE_REPLY
      }
    })

    await expect(internal.dbGet('disable-commands')).resolves.toEqual(['A'])
    await internal.dbPut('disable-commands', ['B'])
    stored = ['C']
    token = EXTERNAL_TOKEN

    await expect(internal.dbPut('disable-commands', ['D'])).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT'
    })
    await expect(internal.dbPut('disable-commands', ['E'])).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT'
    })
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    await expect(internal.dbGet('disable-commands')).resolves.toEqual(['C'])
    await internal.dbPut('disable-commands', ['D'])
    expect(calls.filter(({ operation }) => operation === 'readCommandSettings')).toHaveLength(3)

    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')
      .map(({ payload }) => ({ token: payload.baseToken, value: payload.value }))).toEqual([
      { token: BASE_TOKEN, value: ['B'] },
      { token: EXTERNAL_TOKEN, value: ['D'] }
    ])
    bridge.dispose()
  })

  it('preserves the observed list across pin invalidation instead of silently rebasing', async () => {
    let stored = ['A']
    let token = BASE_TOKEN
    const harness = makeHarness({
      snapshot: () => settingsSnapshot(stored),
      currentToken: () => token,
      onWrite: (payload) => {
        if (payload.baseToken !== token) throw { code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT' }
        stored = (payload.value as string[]).slice()
        token = SECOND_TOKEN
        return WRITE_REPLY
      }
    })

    await harness.internal.dbGet('disable-commands')
    await harness.internal.dbPut('disable-commands', ['B'])
    await harness.internal.pinApp({
      type: 'direct',
      subType: 'app',
      path: '/Applications/Test.app',
      name: 'Test'
    })
    stored = ['C']
    token = EXTERNAL_TOKEN

    await expect(harness.internal.dbPut('disable-commands', ['D'])).rejects.toMatchObject({
      code: 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT'
    })
    expect(harness.calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    harness.bridge.dispose()
  })

  it('invalidates the previous CAS token after an invalid write request', async () => {
    const { bridge, internal, calls } = makeHarness()
    await internal.dbGet('disable-commands')
    await expect(internal.dbPut('disable-commands', [''])).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    await internal.dbPut('disable-commands', DISABLED_COMMANDS)

    expect(calls.filter(({ operation }) => operation === 'readCommandSettings')).toHaveLength(2)
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    bridge.dispose()
  })

  it('clones the caller list before awaiting a read and serializes the original values', async () => {
    let resolveRead!: (value: unknown) => void
    const read = new Promise<unknown>((resolve) => { resolveRead = resolve })
    const { bridge, internal, calls } = makeHarness({ onRead: () => read })
    const callerValue = [...DISABLED_COMMANDS]

    const write = internal.dbPut('disable-commands', callerValue)
    callerValue[0] = 'mutated after dbPut'
    callerValue.push('added after dbPut')
    resolveRead(dataPage(JSON.stringify(settingsSnapshot()), 0))
    await write

    expect(calls.find(({ operation }) => operation === 'writeDisabledCommands')?.payload.value)
      .toEqual(DISABLED_COMMANDS)
    bridge.dispose()
  })

  it('allows one write at a time and rejects a second without another Native call', async () => {
    let resolveWrite!: (value: unknown) => void
    const pendingWrite = new Promise<unknown>((resolve) => { resolveWrite = resolve })
    const { bridge, internal, calls } = makeHarness({ onWrite: () => pendingWrite })
    await internal.dbGet('disable-commands')

    const first = internal.dbPut('disable-commands', DISABLED_COMMANDS)
    await expect(internal.dbPut('disable-commands', ['another'])).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_WRITE_IN_FLIGHT'
    })
    expect(calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(1)
    resolveWrite(WRITE_REPLY)
    await first
    bridge.dispose()
  })

  it('enforces row, UTF-8 identifier, and JSON value budgets without rewriting opaque IDs', async () => {
    const opaque = ['legacy:kept', 'plugin:kept', 'legacy:kept']
    const accepted = makeHarness()
    await accepted.internal.dbPut('disable-commands', opaque)
    expect(accepted.calls.find(({ operation }) => operation === 'writeDisabledCommands')?.payload.value)
      .toEqual(opaque)
    accepted.bridge.dispose()

    const countBoundary = makeHarness()
    await countBoundary.internal.dbPut('disable-commands', Array.from({ length: 4096 }, (_, index) => `id-${index}`))
    countBoundary.bridge.dispose()

    const tooMany = makeHarness()
    await expect(tooMany.internal.dbPut('disable-commands', Array.from({ length: 4097 }, (_, index) => `id-${index}`)))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(tooMany.calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(0)
    tooMany.bridge.dispose()

    const maxId = makeHarness()
    await maxId.internal.dbPut('disable-commands', ['😀'.repeat(4112)])
    maxId.bridge.dispose()

    const longId = makeHarness()
    await expect(longId.internal.dbPut('disable-commands', ['😀'.repeat(4113)]))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    longId.bridge.dispose()

    const maxBytesValue = [
      ...Array.from({ length: 7 }, () => 'a'.repeat(16_448)),
      'b'.repeat(15_911)
    ]
    expect(new TextEncoder().encode(JSON.stringify(maxBytesValue)).byteLength).toBe(128 * 1024)
    const maxBytes = makeHarness()
    await maxBytes.internal.dbPut('disable-commands', maxBytesValue)
    const payload = maxBytes.calls.find(({ operation }) => operation === 'writeDisabledCommands')?.payload
    expect(new TextEncoder().encode(JSON.stringify(payload)).byteLength).toBeLessThanOrEqual(128 * 1024 + 256)
    maxBytes.bridge.dispose()

    const overBytes = makeHarness()
    await expect(overBytes.internal.dbPut('disable-commands', [
      ...maxBytesValue.slice(0, -1),
      'b'.repeat(15_912)
    ])).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(overBytes.calls.filter(({ operation }) => operation === 'writeDisabledCommands')).toHaveLength(0)
    overBytes.bridge.dispose()
  })

  it('checks array shape and count before invoking caller toJSON and bounds cumulative UTF-8 bytes', async () => {
    const { bridge, internal, calls } = makeHarness()
    const nonArray = { toJSON: vi.fn(() => DISABLED_COMMANDS) }
    await expect(internal.dbPut('disable-commands', nonArray)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    expect(nonArray.toJSON).not.toHaveBeenCalled()

    const overCount = Array.from({ length: 4097 }, (_, index) => `id-${index}`)
    const overCountToJson = vi.fn(() => DISABLED_COMMANDS)
    Object.defineProperty(overCount, 'toJSON', { value: overCountToJson })
    await expect(internal.dbPut('disable-commands', overCount)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    expect(overCountToJson).not.toHaveBeenCalled()

    const overCumulativeBytes = Array.from({ length: 9 }, () => 'x'.repeat(16_000))
    await expect(internal.dbPut('disable-commands', overCumulativeBytes)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    expect(calls).toHaveLength(0)
    bridge.dispose()
  })

  it('copies primitive IDs and preserves exact special-character strings without consulting array toJSON', async () => {
    const { bridge, internal, calls } = makeHarness()
    const ids = ['quote:"', 'backslash:\\', 'line\nbreak', '汉字😀', 'nul:\u0000']
    const toJSON = vi.fn(() => ['changed by toJSON'])
    Object.defineProperty(ids, 'toJSON', { value: toJSON })

    await internal.dbPut('disable-commands', ids)

    expect(toJSON).not.toHaveBeenCalled()
    expect(calls.find(({ operation }) => operation === 'writeDisabledCommands')?.payload.value)
      .toEqual(['quote:"', 'backslash:\\', 'line\nbreak', '汉字😀', 'nul:\u0000'])
    bridge.dispose()
  })

  it('keeps other dbPut keys on the General bridge and rejects acknowledgement without a write', async () => {
    const { bridge, internal, calls } = makeHarness()

    await expect(notifyDisabledCommandsChanged(internal)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_RECEIPT_NOT_AVAILABLE'
    })
    await expect(internal.dbPut('pinned-commands', [])).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED'
    })
    expect(calls).toHaveLength(0)
    bridge.dispose()
  })

  it('invalidates an in-flight snapshot on pin changes and rejects writes after disposal', async () => {
    let resolveRead!: (value: unknown) => void
    const read = new Promise<unknown>((resolve) => { resolveRead = resolve })
    let readCount = 0
    const harness = makeHarness({
      onRead: () => {
        readCount += 1
        return readCount === 1
          ? read
          : dataPage(JSON.stringify(settingsSnapshot(['fresh-after-pin'])), 0, SECOND_TOKEN)
      }
    })

    const lateRead = harness.internal.dbGet('disable-commands')
    await harness.internal.pinApp({
      type: 'direct',
      subType: 'app',
      path: '/Applications/Test.app',
      name: 'Test'
    })
    resolveRead(dataPage(JSON.stringify(settingsSnapshot(['stale-before-pin'])), 0))
    await expect(lateRead).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(harness.internal.dbPut('disable-commands', DISABLED_COMMANDS)).resolves.toBeUndefined()
    expect(harness.calls.filter(({ operation }) => operation === 'readCommandSettings')).toHaveLength(2)
    expect(harness.calls.find(({ operation }) => operation === 'writeDisabledCommands')?.payload.baseToken)
      .toBe(SECOND_TOKEN)
    harness.bridge.dispose()

    const disposed = makeHarness({ onRead: () => new Promise(() => {}) })
    const afterClose = disposed.internal.dbPut('disable-commands', DISABLED_COMMANDS)
    disposed.bridge.dispose()
    await expect(afterClose).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
  })
})
