export const BUILTIN_SHORTCUT_STORE_PATCH = Object.freeze({
  id: 'builtin-shortcuts-live-and-startup-generation',
  path: 'src/renderer/src/stores/windowStore.ts',
  beforeSha256: 'd6112ef179972751c0eeff79bf9777888bcc1f6f4db31bdb2453ad8670dafae4',
  afterSha256: 'f402deff8ae1389f2f77486c8445807f9faa714b5262ae75147e12e4887bda80'
})

export function patchBuiltinShortcutStore(source) {
  function replace(before, after) {
    if (source.split(before).length !== 2) throw new Error('Builtin shortcut store patch marker drifted')
    source = source.replace(before, after)
  }
  replace("import { computed, ref } from 'vue'", "import { computed, onScopeDispose, ref } from 'vue'")
  replace(
    '  const builtInEscShortcutEnabled = ref(true)',
    `  const builtInEscShortcutEnabled = ref(true)
  let builtinShortcutEventGeneration = 0
  const stopBuiltinShortcutUpdates = (window.ztools as unknown as {
    onUpdateBuiltinAppShortcutsEnabled(callback: (config: { search: boolean; esc: boolean }) => void): () => void
  }).onUpdateBuiltinAppShortcutsEnabled((config) => {
    builtinShortcutEventGeneration += 1
    updateBuiltInShortcutEnabled('search', config.search)
    updateBuiltInShortcutEnabled('esc', config.esc)
  })
  onScopeDispose(stopBuiltinShortcutUpdates)`
  )
  replace(
    "      const data = await window.ztools.dbGet('settings-general')",
    "      const builtinShortcutGenerationAtRead = builtinShortcutEventGeneration\n      const data = await window.ztools.dbGet('settings-general')"
  )
  replace(
    '        if (data.builtinAppShortcutsEnabled !== undefined) {',
    '        if (data.builtinAppShortcutsEnabled !== undefined && builtinShortcutGenerationAtRead === builtinShortcutEventGeneration) {'
  )
  return source
}
