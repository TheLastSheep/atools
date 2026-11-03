import { appGlobalShortcutPatches, appGlobalShortcutSettingsChanges, appGlobalShortcutEntryChange } from './app-global-shortcuts.mjs'
import { aboutUpdatePatches } from './about-update.mjs'
import { childCloseLifecyclePatches } from './child-close-lifecycle.mjs'
import { hotkeyRecordingPatches } from './hotkey-recording.mjs'
import { asyncCaptchaPatches } from './async-captcha.mjs'
import { commandTypePatches } from './command-types.mjs'
import { generalSavePatches } from './general-save.mjs'
import { nativeLocalDropPatches } from './native-local-drop.mjs'
import { providerTypePatches } from './provider-types.mjs'
import { selectorTypePatches } from './selector-types.mjs'
import { BUILTIN_SHORTCUT_SETTINGS_PATH, builtinShortcutChanges } from './builtin-shortcuts.mjs'
import { defaultHeightChanges } from './default-height.mjs'

export const settingsSourceCompatibilityPatches = Object.freeze([
  ...aboutUpdatePatches,
  ...childCloseLifecyclePatches.map(patch => ({ ...patch, changes: [...patch.changes, appGlobalShortcutEntryChange] })),
  ...appGlobalShortcutPatches,
  ...hotkeyRecordingPatches,
  ...asyncCaptchaPatches,
  ...selectorTypePatches,
  ...commandTypePatches.map((patch) => patch.path === BUILTIN_SHORTCUT_SETTINGS_PATH
    ? { ...patch, changes: [...patch.changes, ...builtinShortcutChanges, ...appGlobalShortcutSettingsChanges] } : patch),
  ...providerTypePatches,
  ...generalSavePatches.map((patch) => patch.path.endsWith('/GeneralSetting.vue')
    ? { ...patch, changes: [...patch.changes, ...defaultHeightChanges] } : patch),
  ...nativeLocalDropPatches
])
