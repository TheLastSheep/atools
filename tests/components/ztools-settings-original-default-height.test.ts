import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultHeightComponentFixture } from './ztoolsSettingsDefaultHeightComponentFixture'
import type { SettingsGeneralProjection } from '../../packages/ztools-settings/src/childBridgeTypes'

let f: Awaited<ReturnType<typeof defaultHeightComponentFixture>> | undefined
afterEach(() => { f?.dispose(); f = undefined })
const patches = () => f!.host.calls.filter(call => call.operation === 'patchGeneral')
const confirmed = async () => (await f!.host.internal.dbGet('settings-general') as SettingsGeneralProjection).windowDefaultHeight

describe('actual pinned General default height controls', () => {
  it('saves fractional blur and 2001 Enter through one patch per change, with no resize RPC', async () => {
    f = await defaultHeightComponentFixture()
    f.inputDraft('200.5'); f.blur()
    await vi.waitFor(() => expect(f!.setter).toHaveResolvedTimes(1))
    expect(await confirmed()).toBe(200.5)
    expect(patches().map(call => call.payload.changes)).toEqual([{ windowDefaultHeight: 200.5 }])
    f.inputDraft('2001'); f.enter()
    await vi.waitFor(() => expect(f!.setter).toHaveResolvedTimes(2))
    expect(await confirmed()).toBe(2001)
    expect(patches().map(call => call.payload.changes)).toEqual([{ windowDefaultHeight: 200.5 }, { windowDefaultHeight: 2001 }])
    expect(f.host.calls.every(call => call.operation === 'ready' || call.operation === 'patchGeneral')).toBe(true)
  })

  it('persists an explicit reset541 even when the loaded projection is already541', async () => {
    f = await defaultHeightComponentFixture(541)
    f.inputDraft('700'); await f.reset()
    await vi.waitFor(() => expect(f!.setter).toHaveResolvedTimes(1))
    expect(patches().map(call => call.payload.changes)).toEqual([{ windowDefaultHeight: 541 }])
    expect(f.input.value).toBe('541')
  })

  it('restores confirmed height after save rejection and skips the setter', async () => {
    f = await defaultHeightComponentFixture()
    f.host.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })
    f.inputDraft('700'); f.blur()
    await vi.waitFor(() => expect(f!.input.value).toBe('500'))
    expect(f.setter).not.toHaveBeenCalled()
    expect(f.errors).toContain('设置保存失败，请重新打开设置页后重试')
  })

  it('rejects force-reset failure and reports it instead of treating it as a successful setter', async () => {
    f = await defaultHeightComponentFixture(541)
    f.host.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })
    f.inputDraft('700'); await f.reset()
    await vi.waitFor(() => expect(f!.errors).toContain('默认高度设置失败，请重试。'))
    expect(f.setter).toHaveBeenCalledTimes(1)
    expect(await confirmed()).toBe(541)
    expect(f.input.value).toBe('541')
  })

  it('does not overwrite a newer unsaved draft or show obsolete height-save feedback', async () => {
    f = await defaultHeightComponentFixture()
    const held = f.host.holdNextPatch()
    f.inputDraft('700'); const pending = f.commit(); await held.started
    f.inputDraft('800')
    f.host.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' }); held.release()
    await pending
    expect(f.input.value).toBe('800')
    expect(f.setter).not.toHaveBeenCalled()
    expect(f.errors).toEqual([])
  })

  it('ignores an old setter failure after a newer draft was typed', async () => {
    f = await defaultHeightComponentFixture(541)
    const held = f.host.holdNextPatch()
    f.inputDraft('700'); const pending = f.commitReset(); await held.started
    f.inputDraft('800')
    f.host.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' }); held.release()
    await pending
    expect(f.input.value).toBe('800')
    expect(f.errors).toEqual([])
  })

  it('does not let a disposed page failure change or notify a freshly opened General page', async () => {
    const old = await defaultHeightComponentFixture()
    const held = old.host.holdNextPatch()
    old.inputDraft('700'); const pending = old.commit(); await held.started
    old.dispose()
    f = await defaultHeightComponentFixture(600)
    old.host.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' }); held.release()
    await pending
    expect(old.setter).not.toHaveBeenCalled()
    expect(f.input.value).toBe('600')
    expect(f.errors).toEqual([])
    expect(old.errors).toEqual([])
  })
})
