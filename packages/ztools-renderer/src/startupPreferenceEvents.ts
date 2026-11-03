import { withBuiltinShortcutPreferences } from './builtinAppShortcuts'
import type { RendererGeneralPreferenceEvents } from './generalPreferenceEvents'
import type { StartupReadModel } from './startupReadModel'

/** Startup snapshots never replace committed preferences; repeated full snapshots are not user toggles. */
export function withRendererStartupPreferences(
  readModel: StartupReadModel,
  preferences: RendererGeneralPreferenceEvents,
): StartupReadModel {
  const model = withBuiltinShortcutPreferences(readModel, preferences)
  let cachedInput: unknown, cachedEnabled: boolean | undefined, cachedOutput: unknown
  return {
    ...model,
    async dbGet(key) {
      const value = await model.dbGet(key)
      if (key !== 'settings-general') return value
      const general = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : null
      const initial = typeof general?.autoCheckUpdate === 'boolean' ? general.autoCheckUpdate : true
      const enabled = preferences.autoCheckBaseline(initial)
      if (enabled === initial) return value
      if (cachedInput === value && cachedEnabled === enabled) return cachedOutput
      cachedInput = value; cachedEnabled = enabled
      cachedOutput = { ...general, autoCheckUpdate: enabled }
      return cachedOutput
    },
  }
}
