export const BUILTIN_SHORTCUT_SETTINGS_PATH = 'internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue'

export const builtinShortcutChanges = [
  {
    id: 'builtin-shortcut-failure-restores-confirmed-projection',
    kind: 'builtin-shortcuts',
    before: `    console.error('更新内置快捷键开关失败:', err)
    error(\`更新失败: \${err?.message || '未知错误'}\`)`,
    after: `    console.error('更新内置快捷键开关失败:', err)
    error(\`更新失败: \${err?.message || '未知错误'}\`)
    await loadBuiltInShortcutSettings()`
  },
  {
    id: 'builtin-shortcut-only-supported-single-key-intent',
    kind: 'builtin-shortcuts',
    before: `    const settings = (await window.ztools.internal.dbGet('settings-general')) || {}
    const nextConfig = {
      ...DEFAULT_BUILTIN_SHORTCUTS_ENABLED,
      ...(settings.builtinAppShortcutsEnabled || {}),
      [key]: enabled
    }
    settings.builtinAppShortcutsEnabled = nextConfig
    await window.ztools.internal.dbPut('settings-general', settings)`,
    after: `    if (key !== 'search' && key !== 'esc' && key !== 'closePlugin') throw new Error('此设置暂不支持修改。')
    await window.ztools.internal.dbPut('settings-general', {
      builtinAppShortcutsEnabled: { [key]: enabled }
    })
    const nextConfig = { ...builtInShortcutsEnabled.value, [key]: enabled }`
  },
  {
    id: 'builtin-shortcut-checkbox-restores-confirmed-state',
    kind: 'builtin-shortcuts',
    before: `  void handleToggleBuiltInShortcut(key, target.checked)`,
    after: `  void handleToggleBuiltInShortcut(key, target.checked).finally(() => {
    target.checked = builtInShortcutsEnabled.value[key]
  })`
  }
]
