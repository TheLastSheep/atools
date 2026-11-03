import { expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsBridgeTarget, SettingsNativeInvoke } from '../../packages/ztools-settings/src/childBridgeTypes'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
}

it('exposes the original seven local-shortcut methods and routes their exact Native operations', async () => {
  const shortcut = {
    id: 'local-1', name: 'Example', path: '/tmp/Example.app', type: 'app', addedAt: 123,
    alias: 'Example alias', icon: 'ztools-icon://example', keywords: ['Example'],
    pinyin: 'example', pinyinAbbr: 'e'
  }
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
  const invoke = vi.fn(async (operation: string, payload: Record<string, unknown>) => {
    calls.push({ operation, payload })
    if (operation === 'readLocalShortcuts') return [shortcut]
    if (operation === 'deleteMissingLocalShortcuts') return { success: true, deletedCount: 0 }
    if (operation === 'addLocalShortcut' && payload.type === 'file') {
      return { success: false, error: '用户取消选择' }
    }
    return { success: true }
  }) as unknown as SettingsNativeInvoke
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: () => {} })
  bridge.attach(target)
  const localShortcuts = (target.ztools as any).internal.localShortcuts

  expect(Object.keys(localShortcuts).sort()).toEqual([
    'add', 'addByPath', 'delete', 'deleteWhenNotExist', 'getAll', 'open', 'updateAlias'
  ])
  await expect(localShortcuts.getAll()).resolves.toEqual([shortcut])
  await expect(localShortcuts.add('file')).resolves.toEqual({
    success: false, error: '用户取消选择'
  })
  await expect(localShortcuts.addByPath('/tmp/Example.app')).resolves.toEqual({ success: true })
  await expect(localShortcuts.delete('local-1')).resolves.toEqual({ success: true })
  await expect(localShortcuts.updateAlias('local-1', 'Alias')).resolves.toEqual({ success: true })
  await expect(localShortcuts.open('/tmp/Example.app')).resolves.toEqual({ success: true })
  await expect(localShortcuts.deleteWhenNotExist()).resolves.toEqual({ success: true, deletedCount: 0 })

  expect(calls).toEqual([
    { operation: 'readLocalShortcuts', payload: {} },
    { operation: 'addLocalShortcut', payload: { type: 'file' } },
    { operation: 'addLocalShortcutByPath', payload: { path: '/tmp/Example.app' } },
    { operation: 'deleteLocalShortcut', payload: { id: 'local-1' } },
    { operation: 'updateLocalShortcutAlias', payload: { id: 'local-1', alias: 'Alias' } },
    { operation: 'openLocalShortcut', payload: { path: '/tmp/Example.app' } },
    { operation: 'deleteMissingLocalShortcuts', payload: {} }
  ])
  bridge.dispose()
})

it('allows the dedicated 256 KiB getAll response and rejects empty identity fields', async () => {
  const largeRows = [0, 1].map((index) => ({
    id: `large-${index}`,
    name: `Large ${index}`,
    path: `/tmp/large-${index}`,
    type: 'file',
    addedAt: index,
    icon: 'x'.repeat(60 * 1024)
  }))
  const invoke = vi.fn(async (operation: string) => {
    if (operation === 'readLocalShortcuts') return largeRows
    return { success: true }
  }) as unknown as SettingsNativeInvoke
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: () => {} })
  bridge.attach(target)
  const localShortcuts = (target.ztools as any).internal.localShortcuts

  await expect(localShortcuts.getAll()).resolves.toHaveLength(2)
  expect(new TextEncoder().encode(JSON.stringify(largeRows)).byteLength).toBeGreaterThan(96 * 1024)
  await expect(localShortcuts.getAll()).resolves.toHaveLength(2)
  expect(invoke).toHaveBeenCalledTimes(2)

  const invalidInvoke = vi.fn(async () => [{
    id: '', name: 'Invalid', path: '/tmp/invalid', type: 'file', addedAt: 1
  }]) as unknown as SettingsNativeInvoke
  const invalidTarget = new EventTarget() as SettingsBridgeTarget
  const invalidBridge = createSettingsChildBridge({ config: CONFIG, invoke: invalidInvoke, reportError: () => {} })
  invalidBridge.attach(invalidTarget)
  await expect((invalidTarget.ztools as any).internal.localShortcuts.getAll()).rejects.toMatchObject({
    code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
  })

  bridge.dispose()
  invalidBridge.dispose()
})

it('stops queued work on child disposal and ignores a late Native reply', async () => {
  let resolveActive!: (value: unknown) => void
  const invoke = vi.fn(() => new Promise((resolve) => { resolveActive = resolve })) as unknown as SettingsNativeInvoke
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: () => {} })
  bridge.attach(target)
  const localShortcuts = (target.ztools as any).internal.localShortcuts
  const active = localShortcuts.open('/tmp/active')
  const queued = localShortcuts.open('/tmp/queued')
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  expect(invoke).toHaveBeenCalledTimes(1)

  bridge.dispose()
  await expect(active).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
  await expect(queued).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
  resolveActive({ success: true })
  await Promise.resolve()
  expect(invoke).toHaveBeenCalledTimes(1)
})
