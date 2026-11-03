import { describe, expect, it } from 'vitest'
import type { SettingsGeneralProjection } from '../../packages/ztools-settings/src/childBridgeTypes'
import { createHotkeyBridge, GENERAL } from './ztoolsSettingsHotkeyBridgeFixture'

describe('ztools Settings Child main hotkey bridge', () => {
  it('commits through one General patch, advances both cached shortcut facts, and makes the old full save a no-op', async () => {
    const { bridge, calls, internal } = createHotkeyBridge(false)

    await expect(internal.updateShortcut('Command+Ctrl+Option+Shift+F10'))
      .resolves.toEqual({ success: true })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Command+Ctrl+Option+Shift+F10')
    const saved = await internal.dbGet('settings-general') as SettingsGeneralProjection
    expect(saved.hotkey).toBe('Command+Ctrl+Option+Shift+F10')
    await internal.dbPut('settings-general', saved)

    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
    expect(calls[1].payload).toEqual({ revision: 'rev-1', changes: { hotkey: 'Command+Ctrl+Option+Shift+F10' } })
    bridge.dispose()
  })

  it('forces one owned-registration check for an unchanged shortcut, then makes the following save a no-op', async () => {
    const { bridge, calls, internal } = createHotkeyBridge(false)

    await expect(internal.updateShortcut(GENERAL.hotkey)).resolves.toEqual({ success: true })
    const saved = await internal.dbGet('settings-general') as SettingsGeneralProjection
    await internal.dbPut('settings-general', saved)

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    expect(calls.find(({ operation }) => operation === 'patchGeneral')?.payload.changes)
      .toEqual({ hotkey: GENERAL.hotkey })
    bridge.dispose()
  })

  it('serializes shortcut intent after an in-flight General save and preserves that save', async () => {
    const { bridge, calls, internal, holdNextPatch } = createHotkeyBridge()
    const gate = holdNextPatch()
    const generalSave = internal.dbPut('settings-general', { ...GENERAL, placeholder: 'Queued search' })
    await gate.started
    const shortcutSave = internal.updateShortcut('Option+F10')
    gate.release()

    await Promise.all([generalSave, shortcutSave])
    const patches = calls.filter(({ operation }) => operation === 'patchGeneral')
    expect(patches).toHaveLength(2)
    expect(patches.map(({ payload }) => payload.changes)).toEqual([
      { placeholder: 'Queued search' },
      { hotkey: 'Option+F10' }
    ])
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({
      placeholder: 'Queued search',
      hotkey: 'Option+F10'
    })
    bridge.dispose()
  })

  it('rebases a preset-time General save from the initial hotkey while the new shortcut is pending', async () => {
    const { bridge, calls, internal, holdNextPatch } = createHotkeyBridge()
    const gate = holdNextPatch()
    const shortcut = internal.updateShortcut('Option+F10')
    await gate.started
    const generalSave = internal.dbPut('settings-general', {
      ...GENERAL,
      placeholder: 'Changed while shortcut registration is pending'
    })

    gate.release()
    await Promise.all([shortcut, generalSave])

    expect(calls.filter(({ operation }) => operation === 'patchGeneral').map(({ payload }) => payload.changes))
      .toEqual([
        { hotkey: 'Option+F10' },
        { placeholder: 'Changed while shortcut registration is pending' }
      ])
    await expect(internal.dbGet('settings-general')).resolves.toEqual({
      ...GENERAL,
      hotkey: 'Option+F10',
      placeholder: 'Changed while shortcut registration is pending'
    })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Option+F10')
    bridge.dispose()
  })

  it('does not retry a rejected newer shortcut from the earlier save projection', async () => {
    const { bridge, calls, internal, holdNextPatch, rejectShortcut } = createHotkeyBridge()
    const gate = holdNextPatch()
    const shortcutB = internal.updateShortcut('Option+F10')
    await gate.started
    rejectShortcut('Option+F11')
    const shortcutC = internal.updateShortcut('Option+F11')
    const staleSaveFromB = shortcutB.then(async reply => {
      expect(reply).toEqual({ success: true })
      await internal.dbPut('settings-general', { ...GENERAL, hotkey: 'Option+F11' })
    })

    gate.release()
    const [replyB, replyC] = await Promise.all([shortcutB, shortcutC])
    await staleSaveFromB

    expect(replyB).toEqual({ success: true })
    expect(replyC).toEqual({ success: false, error: '快捷键设置失败，请尝试其他组合。' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    await expect(internal.dbGet('settings-general')).resolves.toEqual({ ...GENERAL, hotkey: 'Option+F10' })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Option+F10')
    bridge.dispose()
  })

  it('saves unrelated stale projection fields while keeping the latest confirmed shortcut', async () => {
    const { bridge, calls, internal, holdNextPatch, rejectShortcut } = createHotkeyBridge()
    const gate = holdNextPatch()
    const shortcutB = internal.updateShortcut('Option+F10')
    await gate.started
    rejectShortcut('Option+F11')
    const shortcutC = internal.updateShortcut('Option+F11')
    const staleSaveFromB = shortcutB.then(async () => {
      await internal.dbPut('settings-general', {
        ...GENERAL,
        hotkey: 'Option+F11',
        placeholder: 'Updated while the shortcut changed'
      })
    })

    gate.release()
    const [, replyC] = await Promise.all([shortcutB, shortcutC])
    await staleSaveFromB

    expect(replyC).toEqual({ success: false, error: '快捷键设置失败，请尝试其他组合。' })
    const patches = calls.filter(({ operation }) => operation === 'patchGeneral')
    expect(patches.map(({ payload }) => payload.changes)).toEqual([
      { hotkey: 'Option+F10' },
      { hotkey: 'Option+F11' },
      { placeholder: 'Updated while the shortcut changed' }
    ])
    await expect(internal.dbGet('settings-general')).resolves.toEqual({
      ...GENERAL,
      hotkey: 'Option+F10',
      placeholder: 'Updated while the shortcut changed'
    })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Option+F10')
    bridge.dispose()
  })

  it('does not let an older full projection revert a newer successful shortcut', async () => {
    const { bridge, calls, internal } = createHotkeyBridge()

    await expect(internal.updateShortcut('Option+F10')).resolves.toEqual({ success: true })
    await expect(internal.updateShortcut('Option+F11')).resolves.toEqual({ success: true })
    await internal.dbPut('settings-general', { ...GENERAL, hotkey: 'Option+F10' })

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    await expect(internal.dbGet('settings-general')).resolves.toEqual({ ...GENERAL, hotkey: 'Option+F11' })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Option+F11')
    bridge.dispose()
  })

  it('rejects direct General hotkey changes without a matching explicit shortcut intent', async () => {
    const { bridge, calls, internal } = createHotkeyBridge()

    await expect(internal.dbPut('settings-general', { ...GENERAL, hotkey: 'Option+F12' }))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    await expect(internal.dbPut('settings-general', { ...GENERAL, hotkey: '' }))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    await expect(internal.getCurrentShortcut()).resolves.toBe(GENERAL.hotkey)
    bridge.dispose()
  })

  it('keeps a confirmed unregistered shortcut empty until the user explicitly registers one', async () => {
    const { bridge, calls, internal } = createHotkeyBridge(false, '')

    const initial = await internal.dbGet('settings-general') as SettingsGeneralProjection
    expect(initial.hotkey).toBe('')
    await expect(internal.getCurrentShortcut()).resolves.toBe('')
    await expect(internal.updateShortcut('')).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })

    await internal.dbPut('settings-general', { ...initial, placeholder: 'Recovery path' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral').map(({ payload }) => payload.changes))
      .toEqual([{ placeholder: 'Recovery path' }])
    await expect(internal.dbGet('settings-general')).resolves.toEqual({
      ...GENERAL,
      hotkey: '',
      placeholder: 'Recovery path'
    })

    await expect(internal.updateShortcut('Option+F10')).resolves.toEqual({ success: true })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Option+F10')
    expect(calls.filter(({ operation }) => operation === 'patchGeneral').map(({ payload }) => payload.changes))
      .toEqual([{ placeholder: 'Recovery path' }, { hotkey: 'Option+F10' }])
    bridge.dispose()
  })

  it('rejects malformed shortcut strings before opening a native write', async () => {
    const { bridge, calls, internal } = createHotkeyBridge()

    await expect(internal.updateShortcut('')).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.updateShortcut(`Option+${'x'.repeat(256)}`))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.updateShortcut('Option+\u0085'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(calls).toHaveLength(0)
    bridge.dispose()
  })

  it('returns a safe registration failure and leaves the current shortcut available for an explicit retry', async () => {
    const { bridge, calls, internal, failNextPatch } = createHotkeyBridge()
    failNextPatch({ code: 'SETTINGS_HOTKEY_REJECTED', message: 'private detail' })

    const failed = await internal.updateShortcut('Option+F10')
    expect(failed).toEqual({ success: false, error: '快捷键设置失败，请尝试其他组合。' })
    await expect(internal.getCurrentShortcut()).resolves.toBe(GENERAL.hotkey)
    await expect(internal.updateShortcut('Option+F10')).resolves.toEqual({ success: true })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    bridge.dispose()
  })

  it.each([
    ['SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED', '双击修饰键需要输入监听权限，请在系统设置中授权后重试。'],
    ['SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED', '当前系统暂不支持双击修饰键，请使用普通组合键。']
  ])('keeps the confirmed binding and permits retry after known no-change %s', async (code, message) => {
    const { bridge, calls, internal, failNextPatch } = createHotkeyBridge()
    failNextPatch({ code, message: 'private native detail' })

    await expect(internal.updateShortcut('Command+Command')).resolves.toEqual({ success: false, error: message })
    await expect(internal.getCurrentShortcut()).resolves.toBe(GENERAL.hotkey)
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ hotkey: GENERAL.hotkey })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)

    // A permission retry or a normal-key fallback uses the same unpoisoned session.
    await expect(internal.updateShortcut('Option+F10')).resolves.toEqual({ success: true })
    await expect(internal.getCurrentShortcut()).resolves.toBe('Option+F10')
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    bridge.dispose()
  })

  it('does not claim success after a revision conflict and does not send another write in the stale session', async () => {
    const { bridge, calls, internal, failNextPatch } = createHotkeyBridge()
    failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT', message: 'private detail' })

    await expect(internal.updateShortcut('Option+F10')).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(internal.updateShortcut('Option+F11')).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(internal.getCurrentShortcut()).resolves.toBe(GENERAL.hotkey)
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('sticks after an untrusted patch reply and prevents a later request from overwriting it', async () => {
    const { bridge, calls, internal, replyNextPatch } = createHotkeyBridge()
    replyNextPatch({ revision: 'rev-1', value: GENERAL, notificationDelivered: true })

    await expect(internal.updateShortcut('Option+F10')).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.updateShortcut('Option+F11')).rejects.toMatchObject({
      code: 'SETTINGS_HOTKEY_OUTCOME_UNKNOWN',
      message: '快捷键状态未知，请重启应用后确认。'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('maps an unknown native registration outcome to restart guidance and blocks another write', async () => {
    const { bridge, calls, internal, failNextPatch } = createHotkeyBridge()
    failNextPatch({ code: 'SETTINGS_HOTKEY_OUTCOME_UNKNOWN', message: 'private native detail' })

    const expected = {
      code: 'SETTINGS_HOTKEY_OUTCOME_UNKNOWN',
      message: '快捷键状态未知，请重启应用后确认。'
    }
    await expect(internal.updateShortcut('Option+F10')).rejects.toMatchObject(expected)
    await expect(internal.updateShortcut('Option+F11')).rejects.toMatchObject(expected)
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('rejects a pending hotkey request when disposal wins and keeps the cached old value', async () => {
    const { bridge, calls, internal, holdNextPatch } = createHotkeyBridge()
    const gate = holdNextPatch()
    const change = internal.updateShortcut('Option+F10')
    await gate.started
    bridge.dispose()
    gate.release()

    await expect(change).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
  })

  it('reports native global recording unavailable while keeping the DOM fallback contract', async () => {
    const { bridge, calls, internal } = createHotkeyBridge()

    await expect(internal.startHotkeyRecording()).resolves.toMatchObject({ success: false })
    expect(calls.filter(({ operation }) => operation === 'startHotkeyRecording')).toHaveLength(1)
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })
})
