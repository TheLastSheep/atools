import { describe, expect, it } from 'vitest'
import { createHotkeyBridge, GENERAL } from './ztoolsSettingsHotkeyBridgeFixture'
import type { SettingsGeneralProjection } from '../../packages/ztools-settings/src/childBridgeTypes'

describe('Settings default content height confirmation', () => {
  it.each([200, 200.5, 2001])('confirms a changed height %s using exactly the existing save patch', async height => {
    const f = createHotkeyBridge(true)
    const current = await f.internal.dbGet('settings-general') as SettingsGeneralProjection
    await f.internal.dbPut('settings-general', { ...current, windowDefaultHeight: height })
    await f.internal.setWindowDefaultHeight(height)
    expect(f.calls.filter(call => call.operation === 'patchGeneral').map(call => call.payload.changes)).toEqual([{ windowDefaultHeight: height }])
    f.bridge.dispose()
  })

  it('requires an explicit height patch when the 541 projection has no commit proof, then reuses the proof', async () => {
    const f = createHotkeyBridge(true, GENERAL.hotkey, { defaultHeight: 541 })
    const current = await f.internal.dbGet('settings-general') as SettingsGeneralProjection
    await f.internal.dbPut('settings-general', current)
    expect(f.calls.filter(call => call.operation === 'patchGeneral')).toHaveLength(0)
    await f.internal.setWindowDefaultHeight(541)
    await f.internal.setWindowDefaultHeight(541)
    await f.internal.dbPut('settings-general', { ...current, placeholder: 'new placeholder' })
    await f.internal.setWindowDefaultHeight(541)
    expect(f.calls.filter(call => call.operation === 'patchGeneral').map(call => call.payload.changes)).toEqual([
      { windowDefaultHeight: 541 }, { placeholder: 'new placeholder' }
    ])
    f.bridge.dispose()
  })

  it.each([199, NaN, Infinity, -Infinity, '541', null])('rejects invalid direct height %s without IPC', async value => {
    const f = createHotkeyBridge(true)
    await expect(f.internal.setWindowDefaultHeight(value as number)).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    expect(f.calls).toEqual([])
    f.bridge.dispose()
  })

  it('checks a delayed setter against the latest queued confirmed height rather than overwriting it', async () => {
    const f = createHotkeyBridge(true)
    const initial = await f.internal.dbGet('settings-general') as SettingsGeneralProjection
    const held = f.holdNextPatch()
    const first = f.internal.dbPut('settings-general', { ...initial, windowDefaultHeight: 600 })
    await held.started
    const latest = f.internal.dbPut('settings-general', { ...initial, windowDefaultHeight: 700 })
    const stale = f.internal.setWindowDefaultHeight(600)
    const rejected = expect(stale).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    held.release(); await Promise.all([first, latest, rejected])
    expect((await f.internal.dbGet('settings-general') as SettingsGeneralProjection).windowDefaultHeight).toBe(700)
    expect(f.calls.filter(call => call.operation === 'patchGeneral')).toHaveLength(2)
    f.bridge.dispose()
  })

  it('rejects failed force commits and does not share a receipt with a new session', async () => {
    const first = createHotkeyBridge(true, GENERAL.hotkey, { defaultHeight: 541 })
    first.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(first.internal.setWindowDefaultHeight(541)).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    first.bridge.dispose()
    await expect(first.internal.setWindowDefaultHeight(541)).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    const next = createHotkeyBridge(true, GENERAL.hotkey, { defaultHeight: 541 })
    await next.internal.setWindowDefaultHeight(541)
    expect(next.calls.filter(call => call.operation === 'patchGeneral')).toHaveLength(1)
    next.bridge.dispose()
  })
})
