/** Only script guards change: original prompt/manual-popup semantics remain in windowStore. */
export function patchAutoCheckPreference(source) {
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error('Auto-check store patch marker drifted')
    source = source.replace(before, after)
  }
  replace('  const autoCheckUpdateEnabled = ref(true)',
    '  const autoCheckUpdateEnabled = ref(true)\n  let autoCheckPreferenceGeneration = 0')
  replace('  function updateAutoCheckUpdateEnabled(enabled: boolean): void {',
    '  function updateAutoCheckUpdateEnabled(enabled: boolean): void {\n    autoCheckPreferenceGeneration += 1')
  replace("      const data = await window.ztools.dbGet('settings-general')",
    "      const autoCheckGenerationAtRead = autoCheckPreferenceGeneration\n      const data = await window.ztools.dbGet('settings-general')")
  replace('        if (data.autoCheckUpdate !== undefined) {',
    '        if (data.autoCheckUpdate !== undefined && autoCheckGenerationAtRead === autoCheckPreferenceGeneration) {')
  return source
}
