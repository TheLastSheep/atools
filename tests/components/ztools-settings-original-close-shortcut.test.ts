import { afterEach, describe, expect, it, vi } from 'vitest'
import { originalShortcutsFixture } from './ztoolsSettingsOriginalShortcutsFixture'
import { builtinSettingsFixture } from './ztoolsSettingsBuiltinShortcutsFixture'

let fixture: ReturnType<typeof originalShortcutsFixture> | undefined
afterEach(() => fixture?.dispose())
function toggle(input: HTMLInputElement, checked: boolean) {
  input.checked = checked
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('pinned original ShortcutsSetting closePlugin control', () => {
  it('saves one boolean from its actual DOM checkbox and restores it on reopening', async () => {
    fixture = originalShortcutsFixture(); await fixture.ready()
    expect(fixture.checkbox().checked).toBe(true)
    toggle(fixture.checkbox(), false)
    await vi.waitFor(() => expect(fixture!.success).toHaveBeenCalledTimes(1))
    expect(fixture.host.patches).toEqual([{ revision: 'revision-1', changes: { builtinAppShortcutsEnabled: { closePlugin: false } } }])
    expect(fixture.checkbox().checked).toBe(false)
    expect(fixture.host.committed().builtinAppShortcutsEnabled).toEqual({ search: true, esc: true, closePlugin: false })
    const saved = fixture.host.committed(); fixture.dispose()
    fixture = originalShortcutsFixture(builtinSettingsFixture(true, saved)); await fixture.ready()
    await vi.waitFor(() => expect(fixture!.checkbox().checked).toBe(false))
    expect(fixture.host.patches).toEqual([])
  })

  it('restores the actual checkbox after CAS failure and does not retry the stale session', async () => {
    const host = builtinSettingsFixture(); host.failCas()
    fixture = originalShortcutsFixture(host); await fixture.ready()
    toggle(fixture.checkbox(), false)
    await vi.waitFor(() => expect(fixture!.error).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(fixture!.checkbox().checked).toBe(true))
    expect(fixture.success).not.toHaveBeenCalled()
    expect(host.committed().builtinAppShortcutsEnabled.closePlugin).toBe(true)
    toggle(fixture.checkbox(), false)
    await vi.waitFor(() => expect(fixture!.error).toHaveBeenCalledTimes(2))
    expect(host.patches).toHaveLength(1)
  })

  it('keeps killPlugin unsupported in the original DOM', async () => {
    fixture = originalShortcutsFixture(); await fixture.ready()
    const kill = fixture.checkbox('终止当前插件运行')
    toggle(kill, false)
    await vi.waitFor(() => expect(fixture!.error).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(kill.checked).toBe(true))
    expect(fixture.host.patches).toEqual([])
    expect(fixture.success).not.toHaveBeenCalled()
  })

  it.each([
    ['SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED', '当前系统暂不支持关闭快捷键设置。'],
    ['SETTINGS_CLOSE_SHORTCUT_REJECTED', '关闭快捷键设置失败，请重试。']
  ])('shows Native %s, restores the checkbox and leaves search/esc usable', async (code, message) => {
    const host = builtinSettingsFixture(); host.failNative(code)
    fixture = originalShortcutsFixture(host); await fixture.ready()
    toggle(fixture.checkbox(), false)
    await vi.waitFor(() => expect(fixture!.error).toHaveBeenCalledWith(`更新失败: ${message}`))
    await vi.waitFor(() => expect(fixture!.checkbox().checked).toBe(true))
    expect(host.committed().builtinAppShortcutsEnabled.closePlugin).toBe(true)
    expect(fixture.success).not.toHaveBeenCalled()
    toggle(fixture.checkbox('固定搜索框的文本，进行二次筛选'), false)
    await vi.waitFor(() => expect(fixture!.success).toHaveBeenCalledTimes(1))
    toggle(fixture.checkbox('清空输入/退出插件/隐藏窗口'), false)
    await vi.waitFor(() => expect(fixture!.success).toHaveBeenCalledTimes(2))
    expect(host.committed().builtinAppShortcutsEnabled).toEqual({ search: false, esc: false, closePlugin: true })
    expect(host.patches.map(patch => patch.changes)).toEqual([
      { builtinAppShortcutsEnabled: { closePlugin: false } },
      { builtinAppShortcutsEnabled: { search: false } },
      { builtinAppShortcutsEnabled: { esc: false } }
    ])
  })
})
