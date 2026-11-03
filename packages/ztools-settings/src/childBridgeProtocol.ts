import type {
  AutoPasteOption,
  GeneralPatchReply,
  SettingsGeneralAppEntry,
  SettingsGeneralProjection,
  SettingsPlatform,
  SettingsReadyReply,
  SettingsTheme,
  SettingsViewConfig
} from './childBridgeTypes'
import {
  isJsonWithinByteBudget,
  isPlainDataRecord as isRecord
} from './childBridgeJsonBudget'
import { isBuiltinShortcutProjection } from './childBridgeBuiltinShortcuts'

export { isRecord }

export const GENERAL_PROJECTION_KEYS = [
  'opacity',
  'windowDefaultHeight',
  'hotkey',
  'placeholder',
  'avatar',
  'autoPaste',
  'autoClear',
  'autoBackToSearch',
  'windowPositionStrategy',
  'showRecentInSearch',
  'showMatchRecommendation',
  'localAppSearch',
  'recentRows',
  'pinnedRows',
  'searchMode',
  'tabKeyFunction',
  'tabTargetCommand',
  'spaceOpenCommand',
  'floatingBallDoubleClickCommand',
  'floatingBallEnabled',
  'floatingBallLetter',
  'superPanelEnabled',
  'superPanelMouseButton',
  'superPanelLongPressMs',
  'superPanelBlockedApps',
  'wakeupBlacklist',
  'superPanelTranslateEnabled',
  'theme',
  'primaryColor',
  'customColor',
  'showTrayIcon',
  'windowMaterial',
  'acrylicLightOpacity',
  'acrylicDarkOpacity',
  'devToolsMode',
  'disableGpuAcceleration',
  'customInternalApiPluginNames',
  'proxyEnabled',
  'proxyUrl',
  'autoCheckUpdate',
  'clipboardRetentionDays',
  'terminal',
  'terminalCustomCommand',
  'builtinAppShortcutsEnabled'
] as const

const EDITABLE_GENERAL_FIELD_INDEXES = [3, 27, 28, 29, 6, 9, 12, 13, 14, 10, 15, 16, 17, 11, 0, 30, 2, 8, 40, 7, 5, 43, 1, 39] as const
export type EditableGeneralFieldAtPosition<Position extends number> =
  typeof GENERAL_PROJECTION_KEYS[
    (typeof EDITABLE_GENERAL_FIELD_INDEXES)[Position & keyof typeof EDITABLE_GENERAL_FIELD_INDEXES]
  ]
export const EDITABLE_GENERAL_FIELDS = EDITABLE_GENERAL_FIELD_INDEXES.map(
  (index) => GENERAL_PROJECTION_KEYS[index]
) as SettingsReadyReply['capabilities']['editableGeneralFields']

export const MAX_GENERAL_VALUE_BYTES = 80 * 1024
export const MAX_OPERATION_PAYLOAD_BYTES = 32 * 1024
export const MAX_NATIVE_RESPONSE_BYTES = 96 * 1024
export const MAX_GENERAL_COLLECTION_ITEMS = 16_384
export const MAX_READONLY_STRING_BYTES = 64 * 1024
export const MAX_PLACEHOLDER_WRITE_BYTES = 512
export const MAX_PENDING_GENERAL_WRITES = 32
export const MAX_EVENT_CALLBACKS = 32
export const SETTINGS_UNSUPPORTED_MESSAGE = '此设置暂不支持修改。'
export const SETTINGS_REOPEN_MESSAGE = '设置已变化，请关闭并重新打开。'
export const SETTINGS_HOST_FAILURE_MESSAGE = '设置连接失败，请重新打开。'
export const OPACITY_RECOVERY_FAILED_CODE = 'SETTINGS_OPACITY_RECOVERY_FAILED'
export const OPACITY_RECOVERY_FAILED_MESSAGE = '窗口透明度恢复失败，请重新打开设置确认。'
export const NATIVE_RECOVERY_FAILED_CODE = 'SETTINGS_NATIVE_RECOVERY_FAILED'
export const NATIVE_RECOVERY_FAILED_MESSAGE = '原生设置恢复失败，请重启应用后确认。'
export const HOTKEY_REJECTED_CODE = 'SETTINGS_HOTKEY_REJECTED'
export const HOTKEY_REJECTED_MESSAGE = '快捷键设置失败，请尝试其他组合。'
export const HOTKEY_LISTEN_PERMISSION_REQUIRED_CODE = 'SETTINGS_HOTKEY_LISTEN_PERMISSION_REQUIRED'
export const HOTKEY_LISTEN_PERMISSION_REQUIRED_MESSAGE = '双击修饰键需要输入监听权限，请在系统设置中授权后重试。'
export const HOTKEY_DOUBLE_TAP_UNSUPPORTED_CODE = 'SETTINGS_HOTKEY_DOUBLE_TAP_UNSUPPORTED'
export const HOTKEY_DOUBLE_TAP_UNSUPPORTED_MESSAGE = '当前系统暂不支持双击修饰键，请使用普通组合键。'
export const HOTKEY_OUTCOME_UNKNOWN_CODE = 'SETTINGS_HOTKEY_OUTCOME_UNKNOWN'
export const HOTKEY_OUTCOME_UNKNOWN_MESSAGE = '快捷键状态未知，请重启应用后确认。'
export const HOTKEY_RECORDING_UNAVAILABLE_MESSAGE = '原生快捷键录制暂不可用，请直接按下组合键。'

const SAFE_KEY = /^[A-Za-z0-9._:-]{1,128}$/
const platforms = new Set<SettingsPlatform>(['darwin', 'win32', 'linux'])
const themes = new Set<SettingsTheme>(['system', 'light', 'dark'])
const colors = new Set(['green', 'blue', 'purple', 'orange', 'red', 'pink', 'custom'])
const autos = new Set(['immediately', '1m', '2m', '3m', '5m', '10m', 'never'])
const autoPastes = new Set(['off', '1s', '3s', '5s', '10s'])
const autoBackToSearches = new Set(['immediately', '30s', '1m', '3m', '5m', '10m', 'never'])
const windowPositions = new Set(['remember', 'cursor', 'primary', 'lastActive'])
const mouseButtons = new Set(['middle', 'right', 'back', 'forward'])
const devToolsModes = new Set(['right', 'bottom', 'undocked', 'detach'])
const searchModes = new Set(['aggregate', 'list'])
const tabKeyFunctions = new Set(['navigate', 'target-command'])
const windowMaterials = new Set(['mica', 'acrylic', 'none'])
const BOOLEAN_FIELDS = [9, 10, 11, 17, 19, 21, 26, 30, 35, 37, 39]
const INTEGER_FIELDS: ReadonlyArray<readonly [number, number, number]> = [
  [12, 0, 20], [13, 0, 20], [23, 0, 10000], [32, 0, 100], [33, 0, 100], [40, 1, 3650]
]
const ENUM_FIELDS: ReadonlyArray<readonly [number, ReadonlySet<string>]> = [
  [5, autoPastes], [6, autos], [7, autoBackToSearches], [8, windowPositions], [14, searchModes],
  [15, tabKeyFunctions], [22, mouseButtons], [27, themes], [28, colors], [31, windowMaterials], [34, devToolsModes]
]
const STRING_FIELDS: ReadonlyArray<readonly [number, number, boolean, boolean]> = [
  [2, 256, true, false], [3, MAX_READONLY_STRING_BYTES, true, false], [16, MAX_READONLY_STRING_BYTES, true, false],
  [18, MAX_READONLY_STRING_BYTES, true, false], [20, 16, true, false], [29, 7, false, false], [41, 256, true, false]
]
const EMPTY_STRING_FIELDS = [38, 42]

export function isAutoPasteOption(value: unknown): value is AutoPasteOption {
  return typeof value === 'string' && autoPastes.has(value)
}

export class SettingsBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'SettingsBridgeError'
  }
}

export class HostUnsupportedError extends SettingsBridgeError {
  constructor(message = SETTINGS_UNSUPPORTED_MESSAGE) {
    super('ERR_ATOOLS_SETTINGS_UNSUPPORTED', message)
    this.name = 'HostUnsupportedError'
  }
}

export class SettingsBridgeDisposedError extends SettingsBridgeError {
  constructor() {
    super('ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED', '设置会话已结束。')
    this.name = 'SettingsBridgeDisposedError'
  }
}

export class SettingsBridgeProtocolError extends SettingsBridgeError {
  constructor() {
    super('ERR_ATOOLS_SETTINGS_PROTOCOL', '设置数据无效，请重开页面。')
    this.name = 'SettingsBridgeProtocolError'
  }
}

export function validateSettingsViewConfig(value: unknown): SettingsViewConfig {
  if (!isExactRecord(value, ['version', 'sessionId', 'bundleRevision', 'platform'])) {
    throw new SettingsBridgeProtocolError()
  }
  if (
    value.version !== 1 ||
    typeof value.sessionId !== 'string' || !/^[0-9a-f]{32}$/.test(value.sessionId) ||
    typeof value.bundleRevision !== 'string' || !/^[0-9a-f]{64}$/.test(value.bundleRevision) ||
    typeof value.platform !== 'string' || !platforms.has(value.platform as SettingsPlatform)
  ) {
    throw new SettingsBridgeProtocolError()
  }
  return {
    version: 1,
    sessionId: value.sessionId,
    bundleRevision: value.bundleRevision,
    platform: value.platform as SettingsPlatform
  }
}

export function validateReadyReply(
  value: unknown,
  config: SettingsViewConfig,
  defaultAvatar?: string
): SettingsReadyReply {
  if (!isExactRecord(value, [
    'version', 'sessionId', 'bundleRevision', 'platform', 'general', 'runtime', 'capabilities', 'action'
  ])) {
    throw new SettingsBridgeProtocolError()
  }
  if (
    value.version !== 1 ||
    value.sessionId !== config.sessionId ||
    value.bundleRevision !== config.bundleRevision ||
    value.platform !== config.platform ||
    !isExactRecord(value.general, ['revision', 'value']) ||
    !isExactRecord(value.runtime, [
      'currentShortcut', 'launchAtLogin', 'launchAtLoginAvailable', 'opacity', 'theme', 'themeApplied', 'opacityApplied'
    ]) ||
    !isExactRecord(value.capabilities, ['editableGeneralFields']) ||
    !isExactRecord(value.action, ['code', 'type', 'payload'])
  ) {
    throw new SettingsBridgeProtocolError()
  }

  const revision = validateRevision(value.general.revision)
  const generalValue = validateGeneralProjection(value.general.value, defaultAvatar)
  const runtime = value.runtime
  const available = runtime.launchAtLoginAvailable
  const launchAtLogin = runtime.launchAtLogin
  if (
    typeof runtime.currentShortcut !== 'string' || runtime.currentShortcut.length > 256 ||
    typeof available !== 'boolean' ||
    (!available && launchAtLogin !== null) ||
    (launchAtLogin !== null && typeof launchAtLogin !== 'boolean') ||
    !isFiniteNumber(runtime.opacity) || runtime.opacity < 0 || runtime.opacity > 1 ||
    typeof runtime.theme !== 'string' || !themes.has(runtime.theme as SettingsTheme) ||
    typeof runtime.themeApplied !== 'boolean' || typeof runtime.opacityApplied !== 'boolean' ||
    !Array.isArray(value.capabilities.editableGeneralFields) ||
    !sameStringList(value.capabilities.editableGeneralFields, EDITABLE_GENERAL_FIELDS) ||
    value.action.code !== 'main' || value.action.type !== 'text' || value.action.payload !== ''
  ) {
    throw new SettingsBridgeProtocolError()
  }

  const ready: SettingsReadyReply = {
    version: 1,
    sessionId: config.sessionId,
    bundleRevision: config.bundleRevision,
    platform: config.platform,
    general: { revision, value: generalValue },
    runtime: {
      currentShortcut: runtime.currentShortcut,
      launchAtLogin: launchAtLogin as boolean | null,
      launchAtLoginAvailable: available,
      opacity: runtime.opacity,
      theme: runtime.theme as SettingsTheme,
      themeApplied: runtime.themeApplied,
      opacityApplied: runtime.opacityApplied
    },
    capabilities: { editableGeneralFields: [...EDITABLE_GENERAL_FIELDS] },
    action: { code: 'main', type: 'text', payload: '' }
  }
  assertJsonByteBudget(ready, MAX_NATIVE_RESPONSE_BYTES)
  return ready
}

export function normalizeGeneralInput(value: unknown, defaultAvatar?: string): SettingsGeneralProjection {
  if (!isRecord(value)) throw new SettingsBridgeProtocolError()
  const keys = Object.keys(value)
  if (keys.some((key) => !(GENERAL_PROJECTION_KEYS as readonly string[]).includes(key))) {
    throw new HostUnsupportedError()
  }
  const avatar = value.avatar
  return validateGeneralProjection({
    ...value,
    avatar: avatar === undefined || (typeof defaultAvatar === 'string' && avatar === defaultAvatar) ? null : avatar
  }, defaultAvatar)
}

export function validateGeneralProjection(
  value: unknown,
  defaultAvatar?: string
): SettingsGeneralProjection {
  if (!isExactRecord(value, GENERAL_PROJECTION_KEYS)) {
    throw new SettingsBridgeProtocolError()
  }
  const field = (index: number) => value[GENERAL_PROJECTION_KEYS[index]]
  if (!isFiniteNumber(field(0)) || field(0) < 0.3 || field(0) > 1 ||
    !isFiniteNumber(field(1)) || field(1) < 200 ||
    STRING_FIELDS.some(([index, limit, controls, nonempty]) => {
      const text = field(index)
      return !boundedUtf8String(text, limit) || (controls && hasControlCharacters(text)) ||
        (nonempty && text.length === 0) || (index === 29 && !/^#[0-9a-fA-F]{6}$/.test(text))
    }) ||
    (field(4) !== null && (!boundedUtf8String(field(4), MAX_READONLY_STRING_BYTES) ||
      hasControlCharacters(field(4)))) ||
    BOOLEAN_FIELDS.some((index) => typeof field(index) !== 'boolean') ||
    INTEGER_FIELDS.some(([index, min, max]) => !isIntegerInRange(field(index), min, max)) ||
    ENUM_FIELDS.some(([index, allowed]) => !isStringInSet(field(index), allowed)) ||
    EMPTY_STRING_FIELDS.some((index) => field(index) !== '') ||
    [24, 25].some((index) => !isAppList(field(index))) || !isPluginNameList(field(36)) ||
    !isBuiltinShortcutProjection(field(43))) {
    throw new SettingsBridgeProtocolError()
  }

  const normalized = cloneJson(value) as Record<string, unknown>
  if (typeof defaultAvatar === 'string' && normalized.avatar === defaultAvatar) normalized.avatar = null
  assertJsonByteBudget(normalized, MAX_GENERAL_VALUE_BYTES)
  return normalized as unknown as SettingsGeneralProjection
}

export function validatePatchReply(value: unknown, defaultAvatar?: string): GeneralPatchReply {
  if (!isExactRecord(value, ['revision', 'value', 'notificationDelivered'])) {
    throw new SettingsBridgeProtocolError()
  }
  if (typeof value.notificationDelivered !== 'boolean') throw new SettingsBridgeProtocolError()
  const reply = {
    revision: validateRevision(value.revision),
    value: validateGeneralProjection(value.value, defaultAvatar),
    notificationDelivered: value.notificationDelivered
  }
  assertJsonByteBudget(reply, MAX_NATIVE_RESPONSE_BYTES)
  return reply
}

export function validateTheme(value: unknown): SettingsTheme {
  if (typeof value !== 'string' || !themes.has(value as SettingsTheme)) {
    throw new SettingsBridgeProtocolError()
  }
  return value as SettingsTheme
}

export function nativeErrorCode(error: unknown): string | null {
  if (error === null || typeof error !== 'object') return null
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code')
  const code = descriptor && 'value' in descriptor ? descriptor.value : null
  return typeof code === 'string' && SAFE_KEY.test(code) ? code : null
}

export function cloneJson<T>(value: T): T {
  return structuredClone(value)
}

function isGeneralAppEntry(value: unknown): value is SettingsGeneralAppEntry {
  if (!isRecord(value)) return false
  const keys = Object.keys(value)
  if (
    keys.some((key) => key !== 'app' && key !== 'bundleId' && key !== 'label') ||
    !keys.includes('app') || !boundedUtf8String(value.app, 1024) || hasControlCharacters(value.app)
  ) return false
  return (value.bundleId === undefined ||
      (boundedUtf8String(value.bundleId, 1024) && !hasControlCharacters(value.bundleId))) &&
    (value.label === undefined ||
      (boundedUtf8String(value.label, 1024) && !hasControlCharacters(value.label)))
}

function isAppList(value: unknown): value is SettingsGeneralAppEntry[] {
  return Array.isArray(value) && value.length <= MAX_GENERAL_COLLECTION_ITEMS && value.every(isGeneralAppEntry)
}

function isPluginNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_GENERAL_COLLECTION_ITEMS && value.every((name) =>
    boundedUtf8String(name, 256) && !hasControlCharacters(name)
  )
}

function validateRevision(value: unknown): string {
  if (typeof value !== 'string' || value.length > 128 || !SAFE_KEY.test(value)) {
    throw new SettingsBridgeProtocolError()
  }
  return value
}

export function hasExactKeys(value: Record<string, any>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key))
}

export function isExactRecord(value: unknown, expected: readonly string[]): value is Record<string, any> {
  return isRecord(value) && hasExactKeys(value, expected)
}

function sameStringList(value: unknown[], expected: readonly string[]): boolean {
  return value.length === expected.length && value.every((field, index) => field === expected[index])
}

export function boundedUtf8String(value: unknown, maxBytes: number): value is string {
  if (typeof value !== 'string' || value.length > maxBytes) return false
  return new TextEncoder().encode(value).byteLength <= maxBytes
}

function hasControlCharacters(value: string): boolean {
  return /\p{Cc}/u.test(value)
}

function isStringInSet(value: unknown, allowed: ReadonlySet<string>): boolean {
  return typeof value === 'string' && allowed.has(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
}

export function assertJsonByteBudget(value: unknown, maxBytes: number): void {
  if (!isJsonWithinByteBudget(value, maxBytes)) throw new SettingsBridgeProtocolError()
}
