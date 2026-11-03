import type { AboutCheckReply, AboutAutoCheckReply } from './childBridgeAboutUpdate'
import type {
  AutoPasteOption,
  SettingsAliasUpdateReply,
  SettingsCommandCatalog,
  SettingsPlatform,
  SettingsShortcutUpdateReply,
  SettingsViewAction
} from './childBridgeTypes'
import type { SettingsChildLocalShortcuts } from './childBridgeLocalShortcuts'
import type { HotkeyRecordingStopReason } from './childBridgeHotkeyRecording'
import type { SettingsNativeLocalDropCallback } from './childBridgeLocalDrop'

export type SettingsEventCallback<T> = (value: T) => void

export interface SettingsInternalApi {
  getAppVersion(): Promise<string>
  updaterCheckUpdate(): Promise<AboutCheckReply>
  updaterSetAutoCheck(enabled: boolean): Promise<AboutAutoCheckReply>
  getCommands: () => Promise<SettingsCommandCatalog>
  getSuperPanelPinned: () => Promise<unknown[]>
  dbGet: (key: unknown) => Promise<unknown>
  dbPut: (key: unknown, value: unknown) => Promise<void>
  notifyDisabledCommandsChanged: () => Promise<{ success: true }>
  getCurrentShortcut: () => Promise<string>
  getLaunchAtLogin: () => Promise<boolean>
  setLaunchAtLogin: (enabled: boolean) => Promise<void>
  inspectLegacyLaunchAtLogin: () => Promise<{ modernEnabled: boolean; revision: string }>
  resolveLegacyLaunchAtLogin: (request: {
    choice: 'turnOff' | 'migrate'
    expectedModern: boolean
    revision: string
  }) => Promise<{ enabled: boolean }>
  updateLocalAppSearch: (value: boolean) => Promise<void>
  updateAutoPaste: (value: AutoPasteOption) => Promise<void>
  updateWindowPositionStrategy: (value: 'remember' | 'cursor' | 'primary' | 'lastActive') => Promise<void>
  updateClipboardConfig: (value: unknown) => Promise<void>
  setWindowOpacity: (value: number) => Promise<void>
  setWindowDefaultHeight: (value: number) => Promise<void>
  setTrayIconVisible: (visible: boolean) => Promise<void>
  updateShortcut: (shortcut: string) => Promise<SettingsShortcutUpdateReply>
  startHotkeyRecording: () => Promise<SettingsShortcutUpdateReply>
  stopHotkeyRecording: () => Promise<void>
  onHotkeyRecorded: (callback: SettingsEventCallback<string>) => () => void
  onHotkeyRecordingStopped: (callback: SettingsEventCallback<HotkeyRecordingStopReason>) => () => void
  updateCommandAliases: (value: unknown) => Promise<SettingsAliasUpdateReply>
  pinApp: (command: unknown) => Promise<void>
  unpinApp: (path: string, featureCode?: string, name?: string) => Promise<void>
  localShortcuts: SettingsChildLocalShortcuts
  onNativeLocalDrop: (callback: SettingsNativeLocalDropCallback) => () => void
  [key: string]: unknown
}

export interface SettingsZToolsApi {
  isWindows: () => boolean
  isMacOS: () => boolean
  onPluginEnter: (callback: SettingsEventCallback<SettingsViewAction>) => void
  onPluginOut: (callback: SettingsEventCallback<void>) => void
  outPlugin: () => Promise<void>
  setSubInput: (
    onChange?: (payload: { text: string }) => unknown,
    placeholder?: string,
    isFocus?: boolean
  ) => Promise<boolean>
  removeSubInput: () => Promise<boolean>
  setSubInputValue: (text: string) => Promise<boolean>
  subInputFocus: () => boolean
  subInputBlur: () => boolean
  subInputSelect: () => boolean
  internal: SettingsInternalApi
  [key: string]: unknown
}

export interface SettingsZToolsApiOptions {
  platform: SettingsPlatform
  onPluginEnter: (callback: unknown) => void
  onPluginOut: (callback: unknown) => void
  outPlugin: () => Promise<void>
  input: Pick<SettingsZToolsApi,
    'setSubInput' | 'removeSubInput' | 'setSubInputValue' | 'subInputFocus' | 'subInputBlur' | 'subInputSelect'>
  internal: SettingsInternalApi
  unsupported: () => Promise<never>
}

export function createSettingsZToolsApi(options: SettingsZToolsApiOptions): SettingsZToolsApi {
  const getProperty = (source: object, property: string | symbol, receiver: unknown): unknown => {
    if (typeof property === 'symbol') return Reflect.get(source, property, receiver)
    if (property === 'then') return undefined
    if (Object.hasOwn(source, property)) return Reflect.get(source, property, receiver)
    return (..._args: unknown[]) => options.unsupported()
  }
  const internal = new Proxy(options.internal, { get: getProperty })
  const methods: Record<string, unknown> = {
    isWindows: () => options.platform === 'win32',
    isMacOS: () => options.platform === 'darwin',
    onPluginEnter: options.onPluginEnter,
    onPluginOut: options.onPluginOut,
    outPlugin: options.outPlugin,
    setSubInput: options.input.setSubInput,
    removeSubInput: options.input.removeSubInput,
    setSubInputValue: options.input.setSubInputValue,
    subInputFocus: options.input.subInputFocus,
    subInputBlur: options.input.subInputBlur,
    subInputSelect: options.input.subInputSelect,
    internal
  }
  return new Proxy<SettingsZToolsApi>(methods as SettingsZToolsApi, { get: getProperty })
}
