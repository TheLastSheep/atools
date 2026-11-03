import { HostUnsupportedError, isExactRecord, SettingsBridgeProtocolError } from './childBridgeProtocol'

export interface SettingsBuiltinAppShortcuts {
  search: boolean
  esc: boolean
  closePlugin: boolean
}

export type SettingsBuiltinShortcutPatch = { search: boolean } | { esc: boolean } | { closePlugin: boolean }

export function isBuiltinShortcutProjection(value: unknown): value is SettingsBuiltinAppShortcuts {
  return isExactRecord(value, ['search', 'esc', 'closePlugin']) &&
    typeof value.search === 'boolean' && typeof value.esc === 'boolean' && typeof value.closePlugin === 'boolean'
}

export function parseBuiltinShortcutWrite(value: unknown): SettingsBuiltinShortcutPatch {
  if (!isExactRecord(value, ['builtinAppShortcutsEnabled'])) throw new SettingsBridgeProtocolError()
  const patch = value.builtinAppShortcutsEnabled
  if (isExactRecord(patch, ['search']) && typeof patch.search === 'boolean') return { search: patch.search }
  if (isExactRecord(patch, ['esc']) && typeof patch.esc === 'boolean') return { esc: patch.esc }
  if (isExactRecord(patch, ['closePlugin']) && typeof patch.closePlugin === 'boolean') return { closePlugin: patch.closePlugin }
  throw new HostUnsupportedError()
}
