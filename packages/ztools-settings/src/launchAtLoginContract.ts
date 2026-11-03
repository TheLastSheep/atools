export type LaunchAtLoginChoice = 'turnOff' | 'migrate'

export type LaunchAtLoginInspection = Readonly<{
  modernEnabled: boolean
  revision: string
}>

export type LaunchAtLoginResolutionRequest = Readonly<{
  choice: LaunchAtLoginChoice
  expectedModern: boolean
  revision: string
}>

const LAUNCH_AT_LOGIN_CODE_PREFIX = 'SETTINGS_LAUNCH_AT_LOGIN_'
export const LAUNCH_AT_LOGIN_CONFLICT_CODE = LAUNCH_AT_LOGIN_CODE_PREFIX + 'CONFLICT'
export const LAUNCH_AT_LOGIN_UNAVAILABLE_CODE = LAUNCH_AT_LOGIN_CODE_PREFIX + 'UNAVAILABLE'
export const LAUNCH_AT_LOGIN_UNSUPPORTED_CODE = LAUNCH_AT_LOGIN_CODE_PREFIX + 'UNSUPPORTED'
export const LAUNCH_AT_LOGIN_APPROVAL_REQUIRED_CODE = LAUNCH_AT_LOGIN_CODE_PREFIX + 'APPROVAL_REQUIRED'
export const LAUNCH_AT_LOGIN_LEGACY_CODE = LAUNCH_AT_LOGIN_CODE_PREFIX + 'LEGACY_CONFIGURATION'
export const LAUNCH_AT_LOGIN_RECOVERY_FAILED_CODE = LAUNCH_AT_LOGIN_CODE_PREFIX + 'RECOVERY_FAILED'
export const LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE = 'ERR_ATOOLS_SETTINGS_UNSUPPORTED'

export const LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE = '启动项状态未知，请重新读取。'
const UNSUPPORTED_MESSAGE = '此平台不支持开机启动。'

export const LAUNCH_AT_LOGIN_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  [LAUNCH_AT_LOGIN_CONFLICT_CODE]: '启动项已变化，请重新读取。',
  [LAUNCH_AT_LOGIN_UNAVAILABLE_CODE]: LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE,
  [LAUNCH_AT_LOGIN_UNSUPPORTED_CODE]: UNSUPPORTED_MESSAGE,
  [LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE]: UNSUPPORTED_MESSAGE,
  [LAUNCH_AT_LOGIN_APPROVAL_REQUIRED_CODE]: '请在系统设置中允许开机启动。',
  [LAUNCH_AT_LOGIN_LEGACY_CODE]: '发现旧启动项，请关闭或迁移。',
  [LAUNCH_AT_LOGIN_RECOVERY_FAILED_CODE]: '恢复失败，请重新读取。',
}

export function launchAtLoginErrorMessage(code: string): string | undefined {
  return Object.hasOwn(LAUNCH_AT_LOGIN_ERROR_MESSAGES, code)
    ? LAUNCH_AT_LOGIN_ERROR_MESSAGES[code]
    : undefined
}

export function parseLaunchAtLoginEnabled(value: unknown): boolean | null {
  const record = exactDataRecord(value, ['enabled'])
  if (!record || typeof record.enabled !== 'boolean') return null
  return record.enabled
}

export function parseLaunchAtLoginInspection(value: unknown): LaunchAtLoginInspection | null {
  const record = exactDataRecord(value, ['modernEnabled', 'revision'])
  if (!record || typeof record.modernEnabled !== 'boolean'
    || typeof record.revision !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.revision)) return null
  return { modernEnabled: record.modernEnabled, revision: record.revision }
}

export function parseLaunchAtLoginResolution(value: unknown): LaunchAtLoginResolutionRequest | null {
  const record = exactDataRecord(value, ['choice', 'expectedModern', 'revision'])
  if (!record || (record.choice !== 'turnOff' && record.choice !== 'migrate')
    || typeof record.expectedModern !== 'boolean'
    || typeof record.revision !== 'string'
    || !/^[0-9a-f]{64}$/.test(record.revision)) return null
  return {
    choice: record.choice,
    expectedModern: record.expectedModern,
    revision: record.revision,
  }
}

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const ownKeys = Reflect.ownKeys(value)
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== 'string')) return null
    const record: Record<string, unknown> = Object.create(null)
    for (const key of keys) {
      if (!ownKeys.includes(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      record[key] = descriptor.value
    }
    return record
  } catch {
    return null
  }
}
