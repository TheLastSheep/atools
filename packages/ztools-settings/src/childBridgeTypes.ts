import type {
  LaunchAtLoginController,
  LaunchAtLoginHostApi,
} from './launchAtLoginController'
import type { SettingsBuiltinAppShortcuts } from './childBridgeBuiltinShortcuts'

export type SettingsPlatform = 'darwin' | 'win32' | 'linux'
export type SettingsTheme = 'system' | 'light' | 'dark'
export type AutoPasteOption = 'off' | '1s' | '3s' | '5s' | '10s'
export type SettingsPrimaryColor = 'green' | 'blue' | 'purple' | 'orange' | 'red' | 'pink' | 'custom'
export type SettingsWindowPositionStrategy = 'remember' | 'cursor' | 'primary' | 'lastActive'

export interface SettingsViewConfig {
  version: 1
  sessionId: string
  bundleRevision: string
  platform: SettingsPlatform
}

export interface SettingsGeneralAppEntry {
  app: string
  bundleId?: string
  label?: string
}

/** The safe General form projection returned by the native settings session. */
export interface SettingsGeneralProjection {
  opacity: number
  windowDefaultHeight: number
  hotkey: string
  placeholder: string
  avatar: string | null
  autoPaste: AutoPasteOption
  autoClear: string
  autoBackToSearch: string
  windowPositionStrategy: SettingsWindowPositionStrategy
  showRecentInSearch: boolean
  showMatchRecommendation: boolean
  localAppSearch: boolean
  recentRows: number
  pinnedRows: number
  searchMode: 'aggregate' | 'list'
  tabKeyFunction: 'navigate' | 'target-command'
  tabTargetCommand: string
  spaceOpenCommand: boolean
  floatingBallDoubleClickCommand: string
  floatingBallEnabled: boolean
  floatingBallLetter: string
  superPanelEnabled: boolean
  superPanelMouseButton: string
  superPanelLongPressMs: number
  superPanelBlockedApps: SettingsGeneralAppEntry[]
  wakeupBlacklist: SettingsGeneralAppEntry[]
  superPanelTranslateEnabled: boolean
  theme: SettingsTheme
  primaryColor: SettingsPrimaryColor
  customColor: string
  showTrayIcon: boolean
  windowMaterial: 'mica' | 'acrylic' | 'none'
  acrylicLightOpacity: number
  acrylicDarkOpacity: number
  devToolsMode: string
  disableGpuAcceleration: boolean
  customInternalApiPluginNames: string[]
  proxyEnabled: boolean
  /** The host deliberately exposes an empty, readonly value. */
  proxyUrl: ''
  autoCheckUpdate: boolean
  clipboardRetentionDays: number
  terminal: string
  /** The host deliberately exposes an empty, readonly value. */
  terminalCustomCommand: ''
  builtinAppShortcutsEnabled: SettingsBuiltinAppShortcuts
}

export type SettingsShortcutUpdateReply =
  | { success: true }
  | { success: false; error: string }

export interface SettingsRuntimeProjection {
  currentShortcut: string
  launchAtLogin: boolean | null
  launchAtLoginAvailable: boolean
  opacity: number
  theme: SettingsTheme
  themeApplied: boolean
  opacityApplied: boolean
}

export interface SettingsViewAction {
  code: 'main'
  type: 'text'
  payload: ''
}

export interface SettingsReadyReply {
  version: 1
  sessionId: string
  bundleRevision: string
  platform: SettingsPlatform
  general: {
    revision: string
    value: SettingsGeneralProjection
  }
  runtime: SettingsRuntimeProjection
  capabilities: {
    editableGeneralFields: Array<
      | 'opacity'
      | 'placeholder'
      | 'theme'
      | 'primaryColor'
      | 'customColor'
      | 'autoClear'
      | 'showRecentInSearch'
      | 'recentRows'
      | 'pinnedRows'
      | 'searchMode'
      | 'showMatchRecommendation'
      | 'tabKeyFunction'
      | 'tabTargetCommand'
      | 'spaceOpenCommand'
      | 'localAppSearch'
      | 'showTrayIcon'
      | 'hotkey'
      | 'windowPositionStrategy'
      | 'clipboardRetentionDays'
      | 'autoBackToSearch'
      | 'autoPaste'
      | 'builtinAppShortcutsEnabled'
      | 'autoCheckUpdate'
      | 'windowDefaultHeight'
    >
  }
  action: SettingsViewAction
}

export interface GeneralPatchReply {
  revision: string
  value: SettingsGeneralProjection
  notificationDelivered: boolean
}

export type SettingsCommandDataKind = 'commands' | 'aliases' | 'commandSettings'

/** The bounded five-key command settings snapshot captured by one native transaction. */
export interface SettingsCommandSettingsProjection {
  'disable-commands': unknown[] | null
  'pinned-commands': unknown[] | null
  'super-panel-pinned': unknown[] | null
  'global-shortcuts': unknown[] | null
  'app-shortcuts': unknown[] | null
}

export type SettingsSubInputAction = 'set' | 'remove' | 'value' | 'focus' | 'blur' | 'select'

export interface SettingsSubInputReply {
  version: 1
  generation: number
  revision: number
  valueVersion: number
  applied: boolean
}

export interface SettingsSubInputDelivery {
  version: 1
  sessionId: string
  bundleRevision: string
  generation: number
  revision: number
  text: string
}

/** The complete canonical command catalog returned by the bounded native snapshot. */
export interface SettingsCommandCatalog {
  commands: unknown[]
  regexCommands: unknown[]
  plugins: unknown[]
}

export interface SettingsCommandDataPage {
  version: 1
  kind: SettingsCommandDataKind
  token: string
  offset: number
  nextOffset: number
  totalBytes: number
  data: string
}

export interface SettingsAliasWriteStarted {
  writeToken: string
  offset: 0
}

export interface SettingsAliasWriteProgress {
  writeToken: string
  offset: number
}

export interface SettingsAliasCommitReply {
  version: 1
  success: true
  baseToken: string
  notificationDelivered: boolean
}

export interface SettingsAliasUpdateReply {
  success: true
  notificationDelivered: boolean
}

export interface SettingsDisabledCommandsWriteReply {
  version: 1
  success: true
  changed: boolean
  notificationDelivered: boolean
}

export interface SettingsSearchPinApp {
  path: string
  name: string
}

export type SettingsSearchPinMutation =
  | { operation: 'pin'; app: SettingsSearchPinApp }
  | { operation: 'unpin'; path: string; name: string | null }

export interface SettingsSearchPinMutationReply {
  version: 1
  revision: number
}

export type SettingsOperation =
  | 'readAppGlobalShortcuts'
  | 'mutateAppGlobalShortcut'
  | 'getAppVersion'
  | 'checkAppUpdate'
  | 'setAutoCheckUpdate'
  | 'startAppShortcutRecording'
  | 'stopAppShortcutRecording'
  | 'startHotkeyRecording'
  | 'stopHotkeyRecording'
  | 'ready'
  | 'readGeneral'
  | 'patchGeneral'
  | 'readCommands'
  | 'readAliases'
  | 'readCommandSettings'
  | 'readCommandDataPage'
  | 'writeAliases'
  | 'beginAliasWrite'
  | 'appendAliasWrite'
  | 'commitAliasWrite'
  | 'abortAliasWrite'
  | 'writeDisabledCommands'
  | 'updateSubInput'
  | 'mutateSearchPin'
  | 'readLocalShortcuts'
  | 'addLocalShortcut'
  | 'addLocalShortcutByPath'
  | 'deleteLocalShortcut'
  | 'updateLocalShortcutAlias'
  | 'openLocalShortcut'
  | 'deleteMissingLocalShortcuts'
  | 'setTheme'
  | 'setWindowOpacity'
  | 'setLaunchAtLogin'
  | 'readLaunchAtLogin'
  | 'inspectLegacyLaunchAtLogin'
  | 'resolveLegacyLaunchAtLogin'
  | 'close'
  | 'outAcknowledged'

export interface SettingsBridgeTarget extends EventTarget {
  ztools?: unknown
  utools?: unknown
  location?: { readonly hash: string }
  __ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__?: (
    api: LaunchAtLoginHostApi
  ) => LaunchAtLoginController
  __ATOOLS_SETTINGS_DELIVER_OUT__?: () => Promise<unknown>
  __ATOOLS_SETTINGS_DELIVER_INPUT__?: (packet: unknown) => boolean
  __ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__?: (value: unknown) => void
  __ATOOLS_SETTINGS_DELIVER_HOTKEY__?: (value: unknown) => void
  __ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__?: (value: unknown) => void
  __ATOOLS_SETTINGS_VIEW_CONFIG__?: unknown
  __TAURI__?: {
    core?: {
      invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>
    }
  }
}

declare global {
  interface Window {
    __ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__?: SettingsBridgeTarget['__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__']
  }
}

export type SettingsNativeInvoke = (
  operation: SettingsOperation,
  payload: Record<string, unknown>,
  sessionId: string
) => Promise<unknown>

export type SettingsReportError = (message: string) => void

export interface SettingsChildBridgeOptions {
  config: unknown
  invoke: SettingsNativeInvoke
  reportError: SettingsReportError
  defaultAvatar?: string
  scheduleMicrotask?: (callback: () => void) => void
}
