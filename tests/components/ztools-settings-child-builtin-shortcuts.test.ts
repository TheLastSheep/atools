import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
import { HostUnsupportedError, validateGeneralProjection } from '../../packages/ztools-settings/src/childBridgeProtocol'
import { builtinSettingsFixture, GENERAL } from './ztoolsSettingsBuiltinShortcutsFixture'
import { createHotkeyBridge } from './ztoolsSettingsHotkeyBridgeFixture'

function originalHandlers(fixture: ReturnType<typeof builtinSettingsFixture>) {
  const path = 'internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue'
  let source = readFileSync(`/Users/harris/Desktop/ZTools/${path}`, 'utf8')
  const patch = settingsSourceCompatibilityPatches.find((entry: any) => entry.path === path)!
  expect(createHash('sha256').update(source).digest('hex')).toBe(patch.beforeSha256)
  const originalTemplate = source.slice(source.indexOf('<template>'))
  for (const change of patch.changes) {
    expect(source.split(change.before)).toHaveLength(2)
    source = source.replace(change.before, change.after)
  }
  expect(source.slice(source.indexOf('<template>'))).toBe(originalTemplate)
  const script = source.slice(source.indexOf('>') + 1, source.indexOf('</script>'))
  const ast = ts.createSourceFile('shortcuts.ts', script, ts.ScriptTarget.ES2022, true)
  const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node) &&
    ['loadBuiltInShortcutSettings', 'handleToggleBuiltInShortcut', 'handleBuiltInToggleChange'].includes(node.name?.text ?? ''))
  expect(selected).toHaveLength(3)
  const compiled = ts.transpileModule(selected.map((node) => node.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS }
  }).outputText
  const enabled = { value: { search: true, esc: true, closePlugin: true, killPlugin: true } }
  const success = vi.fn()
  const error = vi.fn()
  const handlers = new Function('window', 'builtInShortcutsEnabled', 'DEFAULT_BUILTIN_SHORTCUTS_ENABLED', 'success', 'error', 'console',
    `${compiled}\nreturn { handleToggleBuiltInShortcut, handleBuiltInToggleChange, loadBuiltInShortcutSettings }`)(
    { ztools: { internal: fixture.bridge } }, enabled, { ...enabled.value }, success, error, { error: vi.fn() })
  return { handlers, enabled, success, error }
}

describe('original built-in shortcut settings save', () => {
  it('requires the complete native three-boolean projection and rejects private or unsupported keys', async () => {
    expect(validateGeneralProjection(GENERAL)).toEqual(GENERAL)
    for (const invalid of [undefined, { search: true }, { search: 1, esc: true }, { search: true, esc: true, killPlugin: false }]) {
      expect(() => validateGeneralProjection({ ...GENERAL, builtinAppShortcutsEnabled: invalid })).toThrow()
    }
    const fixture = builtinSettingsFixture()
    for (const key of ['killPlugin', 'unknown']) {
      await expect(fixture.bridge.dbPut('settings-general', { builtinAppShortcutsEnabled: { [key]: false } })).rejects.toBeInstanceOf(HostUnsupportedError)
    }
    await expect(fixture.bridge.dbPut('settings-general', { builtinAppShortcutsEnabled: { search: false, esc: false, closePlugin: true } })).rejects.toThrow()
    expect(fixture.patches).toEqual([])
  })

  it('serializes single-key writes against the latest confirmed revision without losing the other toggle', async () => {
    const fixture = builtinSettingsFixture()
    const held = fixture.hold()
    const first = fixture.bridge.dbPut('settings-general', { builtinAppShortcutsEnabled: { search: false } })
    await held.started
    const second = fixture.bridge.dbPut('settings-general', { builtinAppShortcutsEnabled: { closePlugin: false } })
    const third = fixture.bridge.dbPut('settings-general', { builtinAppShortcutsEnabled: { esc: false } })
    held.release()
    await Promise.all([first, second, third])
    expect(fixture.patches).toEqual([
      { revision: 'revision-1', changes: { builtinAppShortcutsEnabled: { search: false } } },
      { revision: 'revision-2', changes: { builtinAppShortcutsEnabled: { closePlugin: false } } },
      { revision: 'revision-3', changes: { builtinAppShortcutsEnabled: { esc: false } } }
    ])
    expect(fixture.committed().builtinAppShortcutsEnabled).toEqual({ search: false, esc: false, closePlugin: false })
    expect((await fixture.bridge.dbGet('settings-general')).builtinAppShortcutsEnabled).toEqual({ search: false, esc: false, closePlugin: false })
  })

  it.each([
    ['SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED', '当前系统暂不支持关闭快捷键设置。'],
    ['SETTINGS_CLOSE_SHORTCUT_REJECTED', '关闭快捷键设置失败，请重试。']
  ])('normalizes Native %s without changing confirmed values or blocking a later single-key write', async (code, message) => {
    const { bridge, internal, failNextPatch, calls } = createHotkeyBridge(true)
    failNextPatch({ code, message: 'private native detail' })
    await expect(internal.dbPut('settings-general', { builtinAppShortcutsEnabled: { closePlugin: false } })).rejects.toMatchObject({
      code, message
    })
    expect((await internal.dbGet('settings-general') as typeof GENERAL).builtinAppShortcutsEnabled.closePlugin).toBe(true)
    await internal.dbPut('settings-general', { builtinAppShortcutsEnabled: { search: false } })
    await internal.dbPut('settings-general', { builtinAppShortcutsEnabled: { closePlugin: false } })
    expect((await internal.dbGet('settings-general') as typeof GENERAL).builtinAppShortcutsEnabled).toEqual({ search: false, esc: true, closePlugin: false })
    expect(calls.filter(call => call.operation === 'patchGeneral')).toHaveLength(3)
    bridge.dispose()
  })

  it('restores original checkbox state after CAS failure and blocks retry in the stale session', async () => {
    const fixture = builtinSettingsFixture()
    const original = originalHandlers(fixture)
    fixture.failCas()
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.checked = false
    original.handlers.handleBuiltInToggleChange('closePlugin', { target: checkbox })
    await vi.waitFor(() => expect(checkbox.checked).toBe(true))
    expect(original.success).not.toHaveBeenCalled()
    expect(original.error).toHaveBeenCalledTimes(1)
    expect(fixture.committed().builtinAppShortcutsEnabled.closePlugin).toBe(true)
    await original.handlers.handleToggleBuiltInShortcut('esc', false)
    expect(fixture.patches).toHaveLength(1)
  })

  it('does not save or claim success for the original kill control', async () => {
    const fixture = builtinSettingsFixture()
    const original = originalHandlers(fixture)
    for (const key of ['killPlugin']) await original.handlers.handleToggleBuiltInShortcut(key, false)
    expect(fixture.patches).toEqual([])
    expect(original.success).not.toHaveBeenCalled()
    expect(original.error).toHaveBeenCalledTimes(1)
    expect(original.enabled.value).toMatchObject({ closePlugin: true, killPlugin: true })
  })

  it('retains a confirmed commit but reports an unconfirmed Main update without a success toast', async () => {
    const fixture = builtinSettingsFixture(false)
    const original = originalHandlers(fixture)
    await original.handlers.handleToggleBuiltInShortcut('closePlugin', false)
    expect(fixture.committed().builtinAppShortcutsEnabled.closePlugin).toBe(false)
    expect(original.enabled.value.closePlugin).toBe(false)
    expect(original.success).not.toHaveBeenCalled()
    expect(original.error).toHaveBeenLastCalledWith('更新失败: 设置已保存，但主窗口更新未确认。')
    expect(fixture.patches).toHaveLength(1)
    const reopened = builtinSettingsFixture(true, fixture.committed())
    const reloaded = originalHandlers(reopened)
    await reloaded.handlers.loadBuiltInShortcutSettings()
    expect(reloaded.enabled.value.closePlugin).toBe(false)
    expect(reopened.patches).toEqual([])
  })
})
