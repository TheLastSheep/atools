import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsInternalApi } from '../../packages/ztools-settings/src/childBridgeApi'
import type { SettingsBridgeTarget, SettingsNativeInvoke } from '../../packages/ztools-settings/src/childBridgeTypes'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}

function createBridge(invoke: SettingsNativeInvoke) {
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: () => {} })
  bridge.attach(target)
  return { bridge, internal: (target.ztools as { internal: SettingsInternalApi }).internal }
}

function settingsPage(pinned: unknown[], offset = 0) {
  const text = JSON.stringify({
    'disable-commands': [],
    'pinned-commands': pinned,
    'super-panel-pinned': [],
    'global-shortcuts': [],
    'app-shortcuts': []
  })
  const bytes = new TextEncoder().encode(text)
  const chunk = bytes.subarray(offset)
  let binary = ''
  for (const byte of chunk) binary += String.fromCharCode(byte)
  return {
    version: 1,
    kind: 'commandSettings',
    token: '11111111-1111-4111-8111-111111111111',
    offset,
    nextOffset: bytes.byteLength,
    totalBytes: bytes.byteLength,
    data: btoa(binary)
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function appCommand(path = '/Applications/Example.app', name = 'Example') {
  return { type: 'direct', subType: 'app', path, name, icon: 'opaque://icon' }
}

describe('ztools settings child search pins', () => {
  it('maps a direct application to the fixed Native payload and returns void after its receipt', async () => {
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    let pinned: unknown[] = []
    let revision = 0
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'mutateSearchPin') {
        revision += 1
        if (payload.operation === 'pin') pinned = [payload.app]
        else pinned = []
        return { version: 1, revision }
      }
      if (operation === 'readCommandSettings') return settingsPage(pinned)
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)

    await expect(internal.pinApp({
      ...appCommand(),
      icon: 'opaque://icon',
      unknownCommandMetadata: { retainedAtInput: true }
    })).resolves.toBeUndefined()
    await expect(internal.dbGet('pinned-commands')).resolves.toEqual([
      { path: '/Applications/Example.app', name: 'Example' }
    ])
    await expect(internal.unpinApp('/Applications/Example.app', undefined, 'Example'))
      .resolves.toBeUndefined()
    await expect(internal.dbGet('pinned-commands')).resolves.toEqual([])

    expect(calls.filter(({ operation }) => operation === 'mutateSearchPin')).toEqual([
      { operation: 'mutateSearchPin', payload: {
        operation: 'pin', app: { path: '/Applications/Example.app', name: 'Example' }
      } },
      { operation: 'mutateSearchPin', payload: {
        operation: 'unpin', path: '/Applications/Example.app', name: 'Example'
      } }
    ])
    bridge.dispose()
  })

  it('accepts the Core UTF-8 path/name limits and maps a missing unpin name to null', async () => {
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'mutateSearchPin') return { version: 1, revision: 0 }
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    const path = `/${'p'.repeat(16 * 1024 - 1)}`
    const name = 'n'.repeat(4096)

    await expect(internal.pinApp(appCommand(path, name))).resolves.toBeUndefined()
    await expect(internal.unpinApp(path)).resolves.toBeUndefined()
    expect(calls[0].payload).toEqual({ operation: 'pin', app: { path, name } })
    expect(calls[1].payload).toEqual({ operation: 'unpin', path, name: null })
    bridge.dispose()
  })

  it('rejects plugin commands, feature unpins, empty identities, and over-limit UTF-8 before Native', async () => {
    const invoke = vi.fn<SettingsNativeInvoke>(async () => ({ version: 1, revision: 1 }))
    const { bridge, internal } = createBridge(invoke)

    await expect(internal.pinApp({ ...appCommand(), type: 'plugin', featureCode: 'feature' }))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.pinApp({ ...appCommand(), subType: 'local-shortcut' }))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.pinApp(appCommand('', 'Example')))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.pinApp(appCommand('/Applications/Example.app', '界'.repeat(1366))))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.pinApp(appCommand(`/${'界'.repeat(5462)}`, 'Example')))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.unpinApp('/Applications/Example.app', 'feature-code', 'Example'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.unpinApp('/Applications/Example.app', undefined, ''))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(invoke).not.toHaveBeenCalled()
    bridge.dispose()
  })

  it('rejects malformed and unsafe revision receipts instead of claiming success', async () => {
    const invalidReplies = [
      { version: 1, revision: 1, changed: true },
      { version: 1, revision: Number.MAX_SAFE_INTEGER + 1 },
      { version: 1, revision: -1 },
      { version: 1, revision: 1.5 },
      { version: 2, revision: 1 }
    ]
    for (const reply of invalidReplies) {
      const invoke: SettingsNativeInvoke = async () => reply
      const { bridge, internal } = createBridge(invoke)
      await expect(internal.pinApp(appCommand()))
        .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
      bridge.dispose()
    }
  })

  it('rejects unknown commit outcomes without retrying or resolving void', async () => {
    const invoke = vi.fn<SettingsNativeInvoke>(async () => { throw new Error('reply lost') })
    const { bridge, internal } = createBridge(invoke)
    await expect(internal.pinApp(appCommand()))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_NATIVE' })
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][0]).toBe('mutateSearchPin')
    bridge.dispose()
  })

  it('preserves the fixed unknown-commit message through full bridge normalization and invalidates reads', async () => {
    const oldPage = deferred<unknown>()
    let reads = 0
    const invoke = vi.fn<SettingsNativeInvoke>(async (operation) => {
      if (operation === 'readCommandSettings') {
        reads += 1
        return reads === 1 ? oldPage.promise : settingsPage([])
      }
      if (operation === 'mutateSearchPin') {
        throw Object.assign(new Error('raw native detail'), {
          code: 'SETTINGS_SEARCH_PIN_COMMIT_UNKNOWN'
        })
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    const { bridge, internal } = createBridge(invoke)
    const oldRead = internal.dbGet('pinned-commands')
    const oldReadResult = expect(oldRead).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })

    await expect(internal.pinApp(appCommand())).rejects.toMatchObject({
      code: 'SETTINGS_SEARCH_PIN_COMMIT_UNKNOWN',
      message: '结果未知，请重新读取确认。'
    })
    expect(invoke.mock.calls.filter(([operation]) => operation === 'mutateSearchPin')).toHaveLength(1)
    oldPage.resolve(settingsPage([]))
    await oldReadResult
    await expect(internal.dbGet('pinned-commands')).resolves.toEqual([])
    expect(reads).toBe(2)
    expect(invoke.mock.calls.some(([, payload]) => JSON.stringify(payload).includes('raw native detail')))
      .toBe(false)
    bridge.dispose()
  })

  it('allows only one mutation at a time', async () => {
    const response = deferred<unknown>()
    const calls: string[] = []
    const invoke: SettingsNativeInvoke = async (operation) => {
      calls.push(operation)
      if (operation === 'mutateSearchPin') return response.promise
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    const first = internal.pinApp(appCommand())

    await expect(internal.unpinApp('/Applications/Example.app', undefined, 'Example'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_SEARCH_PIN_IN_FLIGHT' })
    expect(calls).toEqual(['mutateSearchPin'])
    response.resolve({ version: 1, revision: 1 })
    await expect(first).resolves.toBeUndefined()
    bridge.dispose()
  })

  it('does not resolve a mutation whose reply arrives after bridge disposal', async () => {
    const response = deferred<unknown>()
    const invoke: SettingsNativeInvoke = async () => response.promise
    const { bridge, internal } = createBridge(invoke)
    const pending = internal.pinApp(appCommand())
    bridge.dispose()

    await expect(pending).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    response.resolve({ version: 1, revision: 1 })
    await Promise.resolve()
  })

  it('invalidates old and in-write command settings reads before allowing a fresh pinned read', async () => {
    const beforePage = deferred<unknown>()
    const duringPage = deferred<unknown>()
    const mutationReply = deferred<unknown>()
    let pinned: unknown[] = []
    let reads = 0
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      if (operation === 'readCommandSettings') {
        reads += 1
        if (reads === 1) return beforePage.promise
        if (reads === 2) return duringPage.promise
        return settingsPage(pinned)
      }
      if (operation === 'mutateSearchPin') {
        pinned = [payload.app]
        return mutationReply.promise
      }
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    const oldRead = internal.dbGet('pinned-commands')
    const oldReadResult = expect(oldRead).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    const mutation = internal.pinApp(appCommand())
    const duringRead = internal.dbGet('pinned-commands')
    const duringReadResult = expect(duringRead).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(reads).toBe(2)

    mutationReply.resolve({ version: 1, revision: 1 })
    await expect(mutation).resolves.toBeUndefined()
    beforePage.resolve(settingsPage([]))
    duringPage.resolve(settingsPage([]))
    await Promise.all([oldReadResult, duringReadResult])
    await expect(internal.dbGet('pinned-commands')).resolves.toEqual([
      { path: '/Applications/Example.app', name: 'Example' }
    ])
    expect(reads).toBe(3)
    bridge.dispose()
  })

  it('invalidates a pending read after an unknown commit result', async () => {
    const oldPage = deferred<unknown>()
    const mutationReply = deferred<unknown>()
    let pinned: unknown[] = []
    let reads = 0
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      if (operation === 'readCommandSettings') {
        reads += 1
        return reads === 1 ? oldPage.promise : settingsPage(pinned)
      }
      if (operation === 'mutateSearchPin') {
        pinned = [payload.app]
        return mutationReply.promise
      }
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, internal } = createBridge(invoke)
    const oldRead = internal.dbGet('pinned-commands')
    const oldReadResult = expect(oldRead).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    const mutation = internal.pinApp(appCommand())
    mutationReply.reject(new Error('commit reply unknown'))
    await expect(mutation).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_NATIVE' })
    oldPage.resolve(settingsPage([]))
    await oldReadResult
    await expect(internal.dbGet('pinned-commands')).resolves.toEqual([
      { path: '/Applications/Example.app', name: 'Example' }
    ])
    expect(reads).toBe(2)
    bridge.dispose()
  })
})
