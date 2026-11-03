import { describe, expect, it, vi } from 'vitest'
import { aboutFixture } from './ztoolsSettingsAboutFixture'
import { parseAboutCheckReply, parseAboutAutoReply } from '../../packages/ztools-settings/src/childBridgeAboutUpdate'
import { GENERAL } from './ztoolsSettingsHotkeyBridgeFixture'

const update = { success: true, hasUpdate: true, status: 'available', updateInfo: { version: '1.0.0', changelog: 'notes' } }
describe('scoped Settings About updater facade', () => {
  it('loads version only on demand, shares in-flight reads and caches success per session', async () => {
    const f = aboutFixture(); expect(f.calls).toEqual([])
    f.fail({ code: 'NO_VERSION' }); await expect(f.api.internal.getAppVersion()).rejects.toThrow()
    const release = f.hold('getAppVersion')
    const first = f.api.internal.getAppVersion(), second = f.api.internal.getAppVersion()
    release(); expect(await first).toBe('0.9.79'); expect(await second).toBe('0.9.79')
    await f.api.internal.getAppVersion()
    expect(f.calls.filter(c => c.operation === 'getAppVersion')).toHaveLength(2)
    f.bridge.dispose(); expect(() => f.api.internal.getAppVersion()).toThrow()
  })
  it.each([{ appVersion: 'x', extra: true }, { appVersion: 'x\0' }, { appVersion: '\ud800' }, { appVersion: '界'.repeat(43) }])('rejects malformed version DTO %j', async raw => {
    const f = aboutFixture(); f.reply(raw)
    await expect(f.api.internal.getAppVersion()).rejects.toThrow()
    await expect(f.api.internal.getAppVersion()).resolves.toBe('0.9.79'); f.bridge.dispose()
  })
  it('single-flights manual calls, returns no-update/update accurately, recovers after rejection', async () => {
    const f = aboutFixture(), release = f.hold('checkAppUpdate')
    const first = f.api.internal.updaterCheckUpdate(), second = f.api.internal.updaterCheckUpdate()
    release(); expect(await first).toEqual({ success: true, hasUpdate: false, status: 'not-available' }); await second
    expect(f.calls.filter(c => c.operation === 'checkAppUpdate')).toHaveLength(1)
    f.reply(update); expect(await f.api.internal.updaterCheckUpdate()).toEqual(update)
    f.fail({ code: 'CHECK_FAILED' }); await expect(f.api.internal.updaterCheckUpdate()).rejects.toThrow()
    await expect(f.api.internal.updaterCheckUpdate()).resolves.toMatchObject({ hasUpdate: false })
    f.bridge.dispose()
  })
  it('serializes bool CAS against confirmed revisions, never dbPut/patchGeneral, rejects whole-form auto writes', async () => {
    const f = aboutFixture(); await f.api.internal.dbGet('settings-general')
    const release = f.hold('setAutoCheckUpdate')
    const first = f.api.internal.updaterSetAutoCheck(false)
    await vi.waitFor(() => expect(f.calls.at(-1)?.operation).toBe('setAutoCheckUpdate'))
    const second = f.api.internal.updaterSetAutoCheck(true); release(); await Promise.all([first, second])
    expect(f.calls.filter(c => c.operation === 'setAutoCheckUpdate').map(c => c.payload)).toEqual([
      { revision: 'rev-1', enabled: false }, { revision: 'rev-2', enabled: true },
    ])
    await expect(f.api.internal.dbPut('settings-general', { ...GENERAL, autoCheckUpdate: false })).rejects.toThrow()
    expect(f.calls.some(c => c.operation === 'patchGeneral')).toBe(false)
    f.partial(); const partial = await f.api.internal.updaterSetAutoCheck(false)
    expect(partial).toMatchObject({ runtimeApplied: false, value: { autoCheckUpdate: false } })
    expect(await f.api.internal.dbGet('settings-general')).toMatchObject({ autoCheckUpdate: false })
    f.bridge.dispose()
  })
  it('stops queued CAS intents on rejection and does not change baseline', async () => {
    const f = aboutFixture(); await f.api.internal.dbGet('settings-general'); f.fail({ code: 'SETTINGS_REVISION_CONFLICT' })
    const first = f.api.internal.updaterSetAutoCheck(false), second = f.api.internal.updaterSetAutoCheck(true)
    await expect(first).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(second).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    expect(f.calls.filter(c => c.operation === 'setAutoCheckUpdate')).toHaveLength(1)
    expect(await f.api.internal.dbGet('settings-general')).toMatchObject({ autoCheckUpdate: true }); f.bridge.dispose()
  })
  it.each(['getAppVersion', 'checkAppUpdate', 'setAutoCheckUpdate'])('rejects late %s after pagehide', async operation => {
    const f = aboutFixture(); await f.api.internal.dbGet('settings-general'); const release = f.hold(operation)
    const task = operation === 'getAppVersion' ? f.api.internal.getAppVersion() : operation === 'checkAppUpdate' ? f.api.internal.updaterCheckUpdate() : f.api.internal.updaterSetAutoCheck(false)
    await vi.waitFor(() => expect(f.calls.at(-1)?.operation).toBe(operation))
    const rejected = expect(task).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    f.target.dispatchEvent(new Event('pagehide')); release(); await rejected
    expect(f.target.ztools).toBeUndefined()
  })
  it('rejects wrong phases, extras, accessors, NUL, Unicode and encoded budgets', () => {
    for (const raw of [{ ...update, extra: true }, { ...update, status: 'checking' }, { success: true, hasUpdate: false, status: 'idle' },
      { ...update, updateInfo: { version: 'x\0', changelog: '' } }, { ...update, updateInfo: { version: '\ud800', changelog: '' } },
      { ...update, updateInfo: { version: 'x', changelog: '界'.repeat(17000) } }, { ...update, updateInfo: { version: 'x', changelog: '\u0001'.repeat(12000) } }]) expect(() => parseAboutCheckReply(raw)).toThrow()
    const getter = vi.fn(() => 'version'); expect(() => parseAboutCheckReply({ ...update, updateInfo: { get version() { return getter() }, changelog: '' } })).toThrow(); expect(getter).not.toHaveBeenCalled()
    expect(parseAboutCheckReply({ ...update, updateInfo: { version: '1', changelog: '😀' } })).toMatchObject({ hasUpdate: true })
    const toJSON = vi.fn()
    expect(() => parseAboutAutoReply({ revision: 'r', value: { ...GENERAL, toJSON }, notificationDelivered: true, runtimeApplied: true, runtimeError: null })).toThrow()
    expect(toJSON).not.toHaveBeenCalled()
    expect(() => parseAboutAutoReply({ revision: 'r', value: GENERAL, notificationDelivered: true, runtimeApplied: true,
      runtimeError: { code: 'SETTINGS_UPDATER_RUNTIME_STOPPED', message: 'stopped' } })).toThrow()
    for (const runtimeError of [null, { code: 'ARBITRARY', message: 'raw' }, { code: 'SETTINGS_UPDATER_RUNTIME_STOPPED', message: 'a'.repeat(2049) }]) {
      expect(() => parseAboutAutoReply({ revision: 'rev-2', value: GENERAL, notificationDelivered: true, runtimeApplied: false, runtimeError })).toThrow()
    }
  })
})
