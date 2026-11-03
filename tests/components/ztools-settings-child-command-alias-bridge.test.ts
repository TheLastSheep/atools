import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type {
  SettingsBridgeTarget,
  SettingsCommandDataKind,
  SettingsNativeInvoke
} from '../../packages/ztools-settings/src/childBridgeTypes'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'

const BASE_TOKEN = '11111111-1111-4111-8111-111111111111'
const COMMAND_TOKEN = '22222222-2222-4222-8222-222222222222'
const WRITE_TOKEN = '33333333-3333-4333-8333-333333333333'
const NEXT_BASE_TOKEN = '44444444-4444-4444-8444-444444444444'
const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}

interface CallRecord {
  operation: string
  payload: Record<string, unknown>
}

function createBridge(invoke: SettingsNativeInvoke): {
  bridge: ReturnType<typeof createSettingsChildBridge>
  internal: SettingsZToolsApi['internal']
} {
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({
    config: CONFIG,
    invoke,
    reportError: vi.fn()
  })
  bridge.attach(target)
  return { bridge, internal: (target.ztools as SettingsZToolsApi).internal }
}

function makePage(
  text: string,
  kind: SettingsCommandDataKind,
  token: string,
  offset: number,
  chunkBytes = 12 * 1024
): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text)
  const end = Math.min(offset + chunkBytes, bytes.byteLength)
  const data = encodeBase64(bytes.subarray(offset, end))
  return {
    version: 1,
    kind,
    token,
    offset,
    nextOffset: end,
    totalBytes: bytes.byteLength,
    data
  }
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function commitReply(baseToken = NEXT_BASE_TOKEN, notificationDelivered = true) {
  return { version: 1, success: true, baseToken, notificationDelivered }
}

describe('ztools settings child command and alias bridge', () => {
  it('returns the complete canonical catalog across pages without alias expansion', async () => {
    const catalog = {
      commands: Array.from({ length: 1_200 }, (_, index) => ({
        name: `App ${index}`,
        path: `/Applications/app-${index}.app`,
        icon: `ztools-icon://app/${index}`,
        type: 'direct',
        subType: 'app'
      })),
      regexCommands: [{ name: 'Regex target', path: '/Plugins/p', matchCmd: { match: '^x', type: 'text' } }],
      plugins: [{
        name: 'installed-plugin',
        version: '1.0',
        features: [{ cmds: ['keep canonical feature metadata'] }],
        unknownMetadata: { retained: true }
      }]
    }
    const text = JSON.stringify(catalog)
    const calls: CallRecord[] = []
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readCommands') return makePage(text, 'commands', COMMAND_TOKEN, 0)
      if (operation === 'readCommandDataPage') {
        expect(payload.kind).toBe('commands')
        expect(payload.token).toBe(COMMAND_TOKEN)
        return makePage(text, 'commands', COMMAND_TOKEN, payload.offset as number)
      }
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)

    await expect(internal.getCommands()).resolves.toEqual(catalog)
    expect(calls[0].operation).toBe('readCommands')
    expect(calls.filter((call) => call.operation === 'readCommandDataPage').length).toBeGreaterThan(0)
    expect(calls.every((call) => call.payload.token !== undefined || call.operation !== 'readCommandDataPage'))
      .toBe(true)
    bridge.dispose()
  })

  it('preserves alias projection buckets while routing settings-general through General', async () => {
    const aliases = {
      'direct:app:/Applications/Same.app': [{ alias: 'legacy alias' }],
      'plugin-x:feature:command:text': [{ alias: 'plugin alias', icon: 'opaque://icon' }],
      'legacy:bucket': { unknown: ['metadata'] }
    }
    const calls: CallRecord[] = []
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return makePage(JSON.stringify(aliases), 'aliases', BASE_TOKEN, 0)
      if (operation === 'ready') return {}
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)

    await expect(internal.dbGet('command-aliases')).resolves.toEqual(aliases)
    await expect(internal.dbGet('settings-general')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    expect(calls.map((call) => call.operation)).toEqual(['readAliases', 'ready'])
    bridge.dispose()
  })

  it('coalesces concurrent alias reads into one snapshot and returns isolated clones', async () => {
    const calls: CallRecord[] = []
    const aliases = { 'direct:app:/Applications/App.app': ['saved'] }
    const page = makePage(JSON.stringify(aliases), 'aliases', BASE_TOKEN, 0)
    let resolveRead!: (value: unknown) => void
    const delayedRead = new Promise<unknown>((resolve) => { resolveRead = resolve })
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return delayedRead
      if (operation === 'writeAliases') return commitReply(NEXT_BASE_TOKEN)
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)

    const first = internal.dbGet('command-aliases')
    const second = internal.dbGet('command-aliases')
    expect(calls.filter((call) => call.operation === 'readAliases')).toHaveLength(1)
    resolveRead(page)
    const [firstValue, secondValue] = await Promise.all([first, second]) as [
      Record<string, unknown>, Record<string, unknown>
    ]
    ;(firstValue['direct:app:/Applications/App.app'] as string[])[0] = 'mutated by first caller'
    expect(secondValue).toEqual(aliases)
    await expect(internal.updateCommandAliases({ edited: [{ alias: 'new' }] })).resolves.toMatchObject({
      success: true
    })
    expect(calls.find((call) => call.operation === 'writeAliases')?.payload.baseToken).toBe(BASE_TOKEN)
    bridge.dispose()
  })

  it('coalesces catalog snapshots and rejects all waiters on dispose without applying a late page', async () => {
    const calls: CallRecord[] = []
    const catalog = { commands: [], regexCommands: [], plugins: [] }
    const page = makePage(JSON.stringify(catalog), 'commands', COMMAND_TOKEN, 0)
    let resolveRead!: (value: unknown) => void
    const delayedRead = new Promise<unknown>((resolve) => { resolveRead = resolve })
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readCommands') return delayedRead
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)

    const first = internal.getCommands()
    const second = internal.getCommands()
    expect(calls.filter((call) => call.operation === 'readCommands')).toHaveLength(1)
    bridge.dispose()
    resolveRead(page)
    await expect(first).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    await expect(second).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    expect(calls.filter((call) => call.operation === 'readCommandDataPage')).toHaveLength(0)
  })

  it('rejects a non-advancing/truncated page instead of returning partial commands', async () => {
    const invoke: SettingsNativeInvoke = async (operation) => {
      if (operation === 'readCommands') {
        return {
          version: 1,
          kind: 'commands',
          token: COMMAND_TOKEN,
          offset: 0,
          nextOffset: 0,
          totalBytes: 12,
          data: ''
        }
      }
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    await expect(internal.getCommands()).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    bridge.dispose()
  })

  it('clones small writes before the caller can mutate them and accepts a committed save without notification', async () => {
    const calls: CallRecord[] = []
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return makePage('{}', 'aliases', BASE_TOKEN, 0)
      if (operation === 'writeAliases') return commitReply(NEXT_BASE_TOKEN, false)
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    await internal.dbGet('command-aliases')
    const candidate = { 'direct:app:/Applications/App.app': [{ alias: 'before mutation', icon: 'x' }] }
    const save = internal.updateCommandAliases(candidate)
    candidate['direct:app:/Applications/App.app'][0].alias = 'after mutation'

    await expect(save).resolves.toEqual({ success: true, notificationDelivered: false })
    const write = calls.find((call) => call.operation === 'writeAliases')!
    expect((write.payload.value as typeof candidate)['direct:app:/Applications/App.app'][0].alias)
      .toBe('before mutation')
    expect(calls.filter((call) => call.operation === 'writeAliases')).toHaveLength(1)
    bridge.dispose()
  })

  it('rejects a second in-flight alias write and keeps a fixed base token', async () => {
    const calls: CallRecord[] = []
    let resolveWrite!: (value: unknown) => void
    const blockedWrite = new Promise<unknown>((resolve) => { resolveWrite = resolve })
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return makePage('{}', 'aliases', BASE_TOKEN, 0)
      if (operation === 'writeAliases') return blockedWrite
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    await internal.dbGet('command-aliases')

    const firstWrite = internal.updateCommandAliases({ one: [{ alias: '1' }] })
    await expect(internal.updateCommandAliases({ two: [{ alias: '2' }] })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_ALIAS_WRITE_IN_FLIGHT'
    })
    expect(calls.filter((call) => call.operation === 'writeAliases')).toHaveLength(1)
    expect(calls.find((call) => call.operation === 'writeAliases')?.payload.baseToken).toBe(BASE_TOKEN)
    resolveWrite(commitReply(NEXT_BASE_TOKEN))
    await expect(firstWrite).resolves.toEqual({ success: true, notificationDelivered: true })
    bridge.dispose()
  })

  it('stages large aliases as ordered base64 chunks and commits once', async () => {
    const calls: CallRecord[] = []
    const received: number[] = []
    const candidate = { 'direct:app:/Applications/Large.app': [{ alias: '大'.repeat(13_000) }] }
    const expected = new TextEncoder().encode(JSON.stringify(candidate))
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return makePage('{}', 'aliases', BASE_TOKEN, 0)
      if (operation === 'beginAliasWrite') {
        expect(payload.baseToken).toBe(BASE_TOKEN)
        expect(payload.totalBytes).toBe(expected.byteLength)
        return { writeToken: WRITE_TOKEN, offset: 0 }
      }
      if (operation === 'appendAliasWrite') {
        expect(payload.writeToken).toBe(WRITE_TOKEN)
        expect(Number.isSafeInteger(payload.offset)).toBe(true)
        const chunk = decodeBase64(payload.data as string)
        expect(chunk.byteLength).toBeLessThanOrEqual(16 * 1024)
        received.push(...chunk)
        return { writeToken: WRITE_TOKEN, offset: (payload.offset as number) + chunk.byteLength }
      }
      if (operation === 'commitAliasWrite') return commitReply(NEXT_BASE_TOKEN)
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    await internal.dbGet('command-aliases')

    await expect(internal.updateCommandAliases(candidate)).resolves.toEqual({
      success: true,
      notificationDelivered: true
    })
    expect(Array.from(received)).toEqual(Array.from(expected))
    const ops = calls.map((call) => call.operation)
    expect(ops[1]).toBe('beginAliasWrite')
    expect(ops.at(-1)).toBe('commitAliasWrite')
    expect(ops.filter((operation) => operation === 'appendAliasWrite').length).toBeGreaterThan(1)
    expect(ops.filter((operation) => operation === 'writeAliases')).toHaveLength(0)
    bridge.dispose()
  })

  it('clears the base after an unknown commit and never retries blindly', async () => {
    const calls: CallRecord[] = []
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return makePage('{}', 'aliases', BASE_TOKEN, 0)
      if (operation === 'writeAliases') throw { code: 'SETTINGS_ALIAS_COMMIT_INTERRUPTED' }
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    await internal.dbGet('command-aliases')

    await expect(internal.updateCommandAliases({ alias: [{ alias: 'value' }] })).rejects.toMatchObject({
      code: 'SETTINGS_ALIAS_COMMIT_INTERRUPTED'
    })
    await expect(internal.updateCommandAliases({ alias: [{ alias: 'value' }] })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_ALIAS_BASE_NOT_READ'
    })
    expect(calls.filter((call) => call.operation === 'writeAliases')).toHaveLength(1)
    bridge.dispose()
  })

  it('rejects a pending commit on dispose without treating it as rollback or retrying', async () => {
    const calls: CallRecord[] = []
    let resolveWrite!: (value: unknown) => void
    const blockedWrite = new Promise<unknown>((resolve) => { resolveWrite = resolve })
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readAliases') return makePage('{}', 'aliases', BASE_TOKEN, 0)
      if (operation === 'writeAliases') return blockedWrite
      throw new Error(`Unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    await internal.dbGet('command-aliases')
    const save = internal.updateCommandAliases({ key: [{ alias: 'value' }] })
    bridge.dispose()

    await expect(save).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_ALIAS_COMMIT_UNKNOWN' })
    resolveWrite(commitReply(NEXT_BASE_TOKEN))
    await Promise.resolve()
    expect(calls.filter((call) => call.operation === 'writeAliases')).toHaveLength(1)
  })
})
