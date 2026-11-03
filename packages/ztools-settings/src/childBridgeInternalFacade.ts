import type { createAppGlobalShortcutsController } from './appGlobalShortcutsController'
import type { createSettingsAboutUpdate } from './childBridgeAboutUpdate'
import type { SettingsHotkeyRecordingController } from './childBridgeHotkeyRecording'
import type { SettingsShortcutUpdateReply } from './childBridgeTypes'
import type { SettingsInternalApi } from './childBridgeApi'
import type { SettingsChildGeneralBridge } from './childBridgeGeneral'
import type { SettingsChildCommandDataBridge } from './childBridgeCommandData'
import type {
  SettingsChildCommandSettingsBridge,
  SettingsCommandSettingKey
} from './childBridgeCommandSettings'
import type { EditableGeneralFieldAtPosition } from './childBridgeProtocol'
import type { SettingsChildAliasesBridge } from './childBridgeAliases'
import type { SettingsChildSearchPinsBridge } from './childBridgeSearchPins'
import type { SettingsChildLocalShortcuts } from './childBridgeLocalShortcuts'
import type {
  LaunchAtLoginInspection,
  LaunchAtLoginResolutionRequest
} from './launchAtLoginController'
import {
  EDITABLE_GENERAL_FIELDS,
  isExactRecord,
  SettingsBridgeProtocolError
} from './childBridgeProtocol'

export interface SettingsChildInternalFacadeOptions {
  aboutUpdate: ReturnType<typeof createSettingsAboutUpdate>
  appGlobalShortcuts: ReturnType<typeof createAppGlobalShortcutsController>
  platform: string
  commandData: SettingsChildCommandDataBridge
  commandSettings: SettingsChildCommandSettingsBridge
  general: SettingsChildGeneralBridge
  aliases: SettingsChildAliasesBridge
  searchPins: SettingsChildSearchPinsBridge
  localShortcuts: SettingsChildLocalShortcuts
  getCurrentShortcut: () => Promise<string>
  getLaunchAtLogin: () => Promise<boolean>
  setLaunchAtLogin: (enabled: boolean) => Promise<void>
  inspectLegacyLaunchAtLogin: () => Promise<LaunchAtLoginInspection>
  resolveLegacyLaunchAtLogin: (request: LaunchAtLoginResolutionRequest) => Promise<{ enabled: boolean }>
  updateGeneralPreference: (field: SettingsChildInternalFacadeEditableField) => (value: unknown) => Promise<void>
  setTheme: (value: unknown) => Promise<void>
  setWindowOpacity: (value: unknown) => Promise<void>
  setTrayIconVisible: (value: unknown) => Promise<void>
  updateShortcut: (value: unknown) => Promise<SettingsShortcutUpdateReply>
  hotkeyRecording: SettingsHotkeyRecordingController
  updatePrimaryColor: (primaryColor: unknown, customColor: unknown) => Promise<void>
  onNativeLocalDrop: (callback: unknown) => () => void
  outPlugin: () => Promise<void>
}

type SettingsChildInternalFacadeEditableField = typeof EDITABLE_GENERAL_FIELDS[number]
const GENERAL_UPDATE_FIELD_POSITIONS = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 17, 19, 20] as const
type GeneralUpdateField = EditableGeneralFieldAtPosition<(typeof GENERAL_UPDATE_FIELD_POSITIONS)[number]>
type GeneralUpdateMethodName<Field extends string> = Field extends 'showMatchRecommendation'
  ? 'updateMatchRecommendation'
  : Field extends 'tabTargetCommand'
    ? 'updateTabTarget'
    : `update${Capitalize<Field>}`
type GeneralUpdateMethodNames = GeneralUpdateMethodName<GeneralUpdateField>
type GeneralUpdateMethods = Pick<SettingsInternalApi, GeneralUpdateMethodNames>

export function createSettingsChildInternalFacade(
  options: SettingsChildInternalFacadeOptions
): SettingsInternalApi {
  const updateGeneralPreference = options.updateGeneralPreference
  const updateClipboardRetentionDays = updateGeneralPreference('clipboardRetentionDays')
  const generalUpdates = {} as GeneralUpdateMethods
  for (const index of GENERAL_UPDATE_FIELD_POSITIONS) {
    const field = EDITABLE_GENERAL_FIELDS[index]
    const update = index === 9 ? 'updateMatchRecommendation'
      : index === 11 ? 'updateTabTarget'
        : `update${field[0].toUpperCase()}${field.slice(1)}`
    generalUpdates[update as GeneralUpdateMethodNames] = updateGeneralPreference(field)
  }
  const internal: SettingsInternalApi = {
    ...generalUpdates,
    ...options.aboutUpdate,
    readAppGlobalShortcuts: options.appGlobalShortcuts.read,
    mutateAppGlobalShortcut: options.appGlobalShortcuts.mutate,
    updaterSetAutoCheck: options.general.setAutoCheckUpdate,
    getPlatform: () => options.platform,
    getCommands: options.commandData.getCommands,
    getSuperPanelPinned: () => options.commandSettings.getSuperPanelPinned(),
    getCurrentShortcut: options.getCurrentShortcut,
    getLaunchAtLogin: options.getLaunchAtLogin,
    setLaunchAtLogin: options.setLaunchAtLogin,
    inspectLegacyLaunchAtLogin: options.inspectLegacyLaunchAtLogin,
    resolveLegacyLaunchAtLogin: options.resolveLegacyLaunchAtLogin,
    dbGet,
    dbPut: (key: unknown, value: unknown) => key === 'disable-commands'
      ? options.commandSettings.dbPutDisabledCommands(value)
      : options.general.dbPut(key, value),
    notifyDisabledCommandsChanged: () => options.commandSettings.notifyDisabledCommandsChanged(),
    updateCommandAliases: options.aliases.updateCommandAliases,
    pinApp: options.searchPins.pinApp,
    unpinApp: options.searchPins.unpinApp,
    localShortcuts: {
      getAll: options.localShortcuts.getAll,
      add: options.localShortcuts.add,
      addByPath: options.localShortcuts.addByPath,
      delete: options.localShortcuts.delete,
      updateAlias: options.localShortcuts.updateAlias,
      open: options.localShortcuts.open,
      deleteWhenNotExist: options.localShortcuts.deleteWhenNotExist,
    },
    syncGetConfig: async () => ({
      success: false,
      error: '账户同步暂不可用。'
    }),
    setTheme: options.setTheme,
    setWindowOpacity: options.setWindowOpacity,
    setWindowDefaultHeight: options.general.setWindowDefaultHeight,
    setTrayIconVisible: options.setTrayIconVisible,
    updateShortcut: options.updateShortcut,
    startHotkeyRecording: options.hotkeyRecording.start,
    stopHotkeyRecording: options.hotkeyRecording.stop,
    onHotkeyRecorded: options.hotkeyRecording.onRecorded,
    onHotkeyRecordingStopped: options.hotkeyRecording.onStopped,
    updateClipboardConfig: async (value: unknown) =>
      updateClipboardRetentionDays(validateClipboardRetentionDays(value)),
    updatePrimaryColor: options.updatePrimaryColor,
    onNativeLocalDrop: options.onNativeLocalDrop,
    outPlugin: options.outPlugin
  }
  return internal

  function dbGet(key: unknown): Promise<unknown> {
    if (key === 'command-aliases') return options.commandData.readAliases()
    if (options.commandSettings.hasKey(key)) {
      return options.commandSettings.dbGet(key as SettingsCommandSettingKey)
    }
    return options.general.dbGet(key)
  }
}

function validateClipboardRetentionDays(value: unknown): number {
  let days: unknown
  try {
    if (!isExactRecord(value, ['retentionDays']) || Reflect.ownKeys(value).length !== 1) {
      throw new SettingsBridgeProtocolError()
    }
    days = Object.getOwnPropertyDescriptor(value, 'retentionDays')?.value
  } catch {
    throw new SettingsBridgeProtocolError()
  }
  if (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 3650) {
    throw new SettingsBridgeProtocolError()
  }
  return days as number
}
