import {
  HOTKEY_DOUBLE_TAP_UNSUPPORTED_CODE,
  HOTKEY_DOUBLE_TAP_UNSUPPORTED_MESSAGE,
  HOTKEY_LISTEN_PERMISSION_REQUIRED_CODE,
  HOTKEY_LISTEN_PERMISSION_REQUIRED_MESSAGE,
  HOTKEY_OUTCOME_UNKNOWN_CODE,
  HOTKEY_OUTCOME_UNKNOWN_MESSAGE,
  HOTKEY_REJECTED_CODE,
  HOTKEY_REJECTED_MESSAGE,
  NATIVE_RECOVERY_FAILED_CODE,
  NATIVE_RECOVERY_FAILED_MESSAGE,
  OPACITY_RECOVERY_FAILED_CODE,
  OPACITY_RECOVERY_FAILED_MESSAGE,
  SETTINGS_HOST_FAILURE_MESSAGE,
  SETTINGS_REOPEN_MESSAGE,
  SettingsBridgeError,
  HostUnsupportedError,
  nativeErrorCode
} from './childBridgeProtocol'
import {
  LAUNCH_AT_LOGIN_UNSUPPORTED_CODE,
  launchAtLoginErrorMessage
} from './launchAtLoginContract'

const knownHotkeyRejections: Record<string, string> = {
  [HOTKEY_REJECTED_CODE]: HOTKEY_REJECTED_MESSAGE,
  [HOTKEY_LISTEN_PERMISSION_REQUIRED_CODE]: HOTKEY_LISTEN_PERMISSION_REQUIRED_MESSAGE,
  [HOTKEY_DOUBLE_TAP_UNSUPPORTED_CODE]: HOTKEY_DOUBLE_TAP_UNSUPPORTED_MESSAGE
}

export function knownHotkeyRejectionMessage(code: string | null): string | undefined {
  return code && Object.hasOwn(knownHotkeyRejections, code) ? knownHotkeyRejections[code] : undefined
}

const fixedNativeMessages: Record<string, string> = {
  SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED: '当前系统暂不支持关闭快捷键设置。',
  SETTINGS_CLOSE_SHORTCUT_REJECTED: '关闭快捷键设置失败，请重试。',
  ...knownHotkeyRejections,
  [OPACITY_RECOVERY_FAILED_CODE]: OPACITY_RECOVERY_FAILED_MESSAGE,
  [NATIVE_RECOVERY_FAILED_CODE]: NATIVE_RECOVERY_FAILED_MESSAGE,
  [HOTKEY_OUTCOME_UNKNOWN_CODE]: HOTKEY_OUTCOME_UNKNOWN_MESSAGE,
  SETTINGS_ALIAS_BASE_NOT_READ: '请先重新读取指令别名。',
  SETTINGS_ALIAS_REVISION_CONFLICT: SETTINGS_REOPEN_MESSAGE,
  SETTINGS_ALIAS_TOKEN_INVALID: SETTINGS_REOPEN_MESSAGE,
  SETTINGS_ALIAS_WRITE_IN_FLIGHT: '别名保存正在进行，请稍后重试。',
  SETTINGS_ALIAS_COMMIT_INTERRUPTED: '别名保存回执未知，请重新读取后确认结果。',
  SETTINGS_SEARCH_PIN_COMMIT_UNKNOWN: '结果未知，请重新读取确认。',
  SETTINGS_DISABLED_COMMANDS_BASE_INVALID: '请先重新读取禁用指令状态。',
  SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT: '禁用指令数据已变化，请重新读取后重试。',
  SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN: '禁用指令写入回执未知，请重新读取后确认结果。',
  SETTINGS_DISABLED_COMMANDS_FAILED: '禁用指令保存失败，请重试。',
}

export function normalizeSettingsNativeFailure(error: unknown, operation: string): Error {
  if (error instanceof SettingsBridgeError) {
    const hotkeyMessage = knownHotkeyRejectionMessage(error.code)
    if (hotkeyMessage) return new SettingsBridgeError(error.code, hotkeyMessage)
    if (error.code === OPACITY_RECOVERY_FAILED_CODE) {
      return new SettingsBridgeError(OPACITY_RECOVERY_FAILED_CODE, OPACITY_RECOVERY_FAILED_MESSAGE)
    }
    if (error.code === NATIVE_RECOVERY_FAILED_CODE) {
      return new SettingsBridgeError(NATIVE_RECOVERY_FAILED_CODE, NATIVE_RECOVERY_FAILED_MESSAGE)
    }
    if (error instanceof HostUnsupportedError) return error
    const launchAtLoginMessage = launchAtLoginErrorMessage(error.code)
    if (launchAtLoginMessage && error.code !== LAUNCH_AT_LOGIN_UNSUPPORTED_CODE) {
      return new SettingsBridgeError(error.code, launchAtLoginMessage)
    }
    return error
  }
  const code = nativeErrorCode(error)
  if (code === 'SETTINGS_REVISION_CONFLICT') {
    return new SettingsBridgeError(code, SETTINGS_REOPEN_MESSAGE)
  }
  if (code === LAUNCH_AT_LOGIN_UNSUPPORTED_CODE) {
    return new HostUnsupportedError(launchAtLoginErrorMessage(code))
  }
  if (code && Object.hasOwn(fixedNativeMessages, code)) {
    return new SettingsBridgeError(code, fixedNativeMessages[code])
  }
  if (code === 'ERR_ATOOLS_SETTINGS_UNSUPPORTED') return new HostUnsupportedError()
  const launchAtLoginMessage = code && launchAtLoginErrorMessage(code)
  if (code && launchAtLoginMessage) return new SettingsBridgeError(code, launchAtLoginMessage)
  if (operation === 'ready') return new SettingsBridgeError('ERR_ATOOLS_SETTINGS_READY', SETTINGS_HOST_FAILURE_MESSAGE)
  if (operation === 'setTheme') return new SettingsBridgeError('ERR_ATOOLS_SETTINGS_THEME', '主题未确认，请重试。')
  if (operation === 'setWindowOpacity') {
    return new SettingsBridgeError('ERR_ATOOLS_SETTINGS_OPACITY', '透明度未确认，请重试。')
  }
  if (operation === 'close') return new SettingsBridgeError('ERR_ATOOLS_SETTINGS_CLOSE', '无法关闭窗口，请重试。')
  return new SettingsBridgeError('ERR_ATOOLS_SETTINGS_NATIVE', '设置操作失败，请重试。')
}
