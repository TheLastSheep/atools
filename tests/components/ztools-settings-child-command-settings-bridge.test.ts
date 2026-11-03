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
const TOKEN = '11111111-1111-4111-8111-111111111111'
const CHUNK_BYTES = 10 * 1024

function page(text: string, kind: 'commandSettings', offset: number): Record<string, unknown> {
  const bytes = new TextEncoder().encode(text)
  const end = Math.min(offset + CHUNK_BYTES, bytes.byteLength)
  let binary = ''
  for (const byte of bytes.subarray(offset, end)) binary += String.fromCharCode(byte)
  return {
    version: 1,
    kind,
    token: TOKEN,
    offset,
    nextOffset: end,
    totalBytes: bytes.byteLength,
    data: btoa(binary)
  }
}

function createBridge(invoke: SettingsNativeInvoke) {
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: vi.fn() })
  bridge.attach(target)
  return { bridge, target, api: target.ztools as SettingsZToolsApi }
}

describe('ztools settings child command settings read model', () => {
  it('coalesces all five key reads, pages the complete snapshot, and returns fresh clones', async () => {
    const folder = {
      isFolder: true,
      id: 'folder-1',
      unknownFolderMetadata: { keep: true },
      items: [
        { id: 'app-1', path: '/Applications/One.app', unknownCommandField: ['keep'] },
        { isFolder: true, id: 'nested-folder', items: [{ id: 'nested-item' }], unknown: true }
      ]
    }
    const settings = {
      'disable-commands': ['app:/Applications/Disabled.app'],
      'pinned-commands': [{ id: 'pin-1', path: '/Applications/Pinned.app', unknown: { nested: true } }],
      'super-panel-pinned': [folder, { id: 'standalone', path: '/Applications/Other.app', opaque: 7 }],
      'global-shortcuts': Array.from({ length: 64 }, (_, index) => ({
        id: `shortcut-${index}`,
        accelerator: 'CommandOrControl+K',
        unknown: 'preserved'.repeat(20)
      })),
      'app-shortcuts': [{ id: 'app-shortcut', target: '/Applications/Editor.app', unknown: ['retained'] }]
    }
    const text = JSON.stringify(settings)
    const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
    let firstPageResolve!: (value: unknown) => void
    const firstPage = new Promise<unknown>((resolve) => { firstPageResolve = resolve })
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      calls.push({ operation, payload })
      if (operation === 'readCommandSettings') return firstPage
      if (operation === 'readCommandDataPage') {
        expect(payload).toEqual({ kind: 'commandSettings', token: TOKEN, offset: expect.any(Number) })
        return page(text, 'commandSettings', payload.offset as number)
      }
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, api } = createBridge(invoke)

    const first = api.internal.dbGet('pinned-commands')
    const second = api.internal.dbGet('global-shortcuts')
    const third = api.internal.dbGet('app-shortcuts')
    expect(calls.filter(({ operation }) => operation === 'readCommandSettings')).toHaveLength(1)
    firstPageResolve(page(text, 'commandSettings', 0))
    const [firstValue, secondValue, thirdValue] = await Promise.all([first, second, third]) as [
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>,
      Array<Record<string, unknown>>
    ]

    firstValue[0].unknown = 'caller mutation'
    expect(secondValue).toEqual(settings['global-shortcuts'])
    expect(thirdValue).toEqual(settings['app-shortcuts'])
    expect(calls.filter(({ operation }) => operation === 'readCommandDataPage').length).toBeGreaterThan(0)
    expect(calls.filter(({ operation }) => operation === 'readCommandDataPage')
      .map(({ payload }) => payload.offset)).toEqual(
      Array.from({ length: Math.ceil(new TextEncoder().encode(text).byteLength / CHUNK_BYTES) - 1 },
        (_, index) => (index + 1) * CHUNK_BYTES)
    )

    await expect(api.internal.dbGet('disable-commands')).resolves.toEqual(settings['disable-commands'])
    await expect(api.internal.getSuperPanelPinned()).resolves.toEqual([
      folder.items[0],
      folder.items[1],
      settings['super-panel-pinned'][1]
    ])
    bridge.dispose()
  })

  // Synthetic transport fixture: this verifies Child projection semantics, not Native/Core runtime behavior.
  it('uses JavaScript truthiness for one-level super-panel folder expansion', async () => {
    const truthyValues: unknown[] = [1, 'yes', [], {}]
    const folders = truthyValues.map((isFolder, index) => ({
      id: `folder-${index}`,
      isFolder,
      folderMetadata: { retain: index },
      items: [
        { id: `child-${index}`, unknown: { retain: true } },
        { id: `nested-${index}`, isFolder: 'nested', items: [{ id: `deep-${index}` }] }
      ]
    }))
    const falseyRows = [null, 0, ''].map((isFolder, index) => ({
      id: `falsey-${index}`,
      isFolder,
      items: [{ id: `not-expanded-${index}` }]
    }))
    const pinned = [...folders, ...falseyRows]
    const settings = {
      'disable-commands': [],
      'pinned-commands': [],
      'super-panel-pinned': pinned,
      'global-shortcuts': [],
      'app-shortcuts': []
    }
    const text = JSON.stringify(settings)
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      if (operation === 'readCommandSettings') return page(text, 'commandSettings', 0)
      if (operation === 'readCommandDataPage') return page(text, 'commandSettings', payload.offset as number)
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, api } = createBridge(invoke)

    await expect(api.internal.dbGet('super-panel-pinned')).resolves.toEqual(pinned)
    await expect(api.internal.getSuperPanelPinned()).resolves.toEqual([
      { id: 'child-0', unknown: { retain: true } },
      { id: 'nested-0', isFolder: 'nested', items: [{ id: 'deep-0' }] },
      { id: 'child-1', unknown: { retain: true } },
      { id: 'nested-1', isFolder: 'nested', items: [{ id: 'deep-1' }] },
      { id: 'child-2', unknown: { retain: true } },
      { id: 'nested-2', isFolder: 'nested', items: [{ id: 'deep-2' }] },
      { id: 'child-3', unknown: { retain: true } },
      { id: 'nested-3', isFolder: 'nested', items: [{ id: 'deep-3' }] },
      ...falseyRows
    ])
    bridge.dispose()
  })

  it('counts expanded truthy-folder children against the 4096 row limit', async () => {
    const createSettings = (childCount: number) => JSON.stringify({
      'disable-commands': [],
      'pinned-commands': [],
      'super-panel-pinned': [{
        id: 'folder',
        isFolder: 'yes',
        items: Array.from({ length: childCount }, (_, index) => ({ id: `child-${index}` }))
      }],
      'global-shortcuts': [],
      'app-shortcuts': []
    })
    const makeBridge = (text: string) => createBridge(async (operation, payload) => {
      if (operation === 'readCommandSettings') return page(text, 'commandSettings', 0)
      if (operation === 'readCommandDataPage') return page(text, 'commandSettings', payload.offset as number)
      throw new Error(`unexpected operation ${operation}`)
    })

    const withinLimit = makeBridge(createSettings(4096))
    await expect(withinLimit.api.internal.getSuperPanelPinned()).resolves.toHaveLength(4096)
    withinLimit.bridge.dispose()

    const overLimit = makeBridge(createSettings(4097))
    await expect(overLimit.api.internal.dbGet('super-panel-pinned')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    await expect(overLimit.api.internal.getSuperPanelPinned()).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    overLimit.bridge.dispose()
  })

  it('keeps confirmed missing keys null and rejects malformed or truncated snapshots', async () => {
    const missing = {
      'disable-commands': null,
      'pinned-commands': [],
      'super-panel-pinned': null,
      'global-shortcuts': [],
      'app-shortcuts': []
    }
    let text = JSON.stringify(missing)
    const invoke: SettingsNativeInvoke = async (operation, payload) => {
      if (operation === 'readCommandSettings') return page(text, 'commandSettings', 0)
      if (operation === 'readCommandDataPage') return page(text, 'commandSettings', payload.offset as number)
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, api } = createBridge(invoke)
    await expect(api.internal.dbGet('disable-commands')).resolves.toBeNull()
    await expect(api.internal.getSuperPanelPinned()).resolves.toEqual([])
    bridge.dispose()

    text = JSON.stringify({ ...missing, 'app-shortcuts': [null] })
    const malformed = createBridge(invoke)
    await expect(malformed.api.internal.dbGet('app-shortcuts')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    malformed.bridge.dispose()

    text = JSON.stringify({ ...missing, 'super-panel-pinned': [{ isFolder: true, items: [null] }] })
    const malformedFolder = createBridge(invoke)
    await expect(malformedFolder.api.internal.dbGet('super-panel-pinned')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    malformedFolder.bridge.dispose()

    const truncated = createBridge(async (operation) => {
      if (operation === 'readCommandSettings') {
        return { ...page(JSON.stringify(missing), 'commandSettings', 0), nextOffset: 0, data: '' }
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    await expect(truncated.api.internal.dbGet('app-shortcuts')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    truncated.bridge.dispose()

    const oversized = createBridge(async (operation) => {
      if (operation === 'readCommandSettings') {
        return { ...page(JSON.stringify(missing), 'commandSettings', 0), totalBytes: 1024 * 1024 + 1 }
      }
      throw new Error(`unexpected operation ${operation}`)
    })
    await expect(oversized.api.internal.dbGet('app-shortcuts')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    oversized.bridge.dispose()
  })

  it('coalesces a late read without returning partial data after disposal', async () => {
    const settings = {
      'disable-commands': [], 'pinned-commands': [], 'super-panel-pinned': [],
      'global-shortcuts': [], 'app-shortcuts': []
    }
    let resolvePage!: (value: unknown) => void
    const pendingPage = new Promise<unknown>((resolve) => { resolvePage = resolve })
    const invoke: SettingsNativeInvoke = async (operation) => {
      if (operation === 'readCommandSettings') return pendingPage
      throw new Error(`unexpected operation ${operation}`)
    }
    const { bridge, api } = createBridge(invoke)
    const first = api.internal.dbGet('disable-commands')
    const second = api.internal.dbGet('pinned-commands')
    bridge.dispose()
    resolvePage(page(JSON.stringify(settings), 'commandSettings', 0))
    await expect(first).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    await expect(second).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
  })
})
