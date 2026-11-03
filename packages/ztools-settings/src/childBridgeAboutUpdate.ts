import {
  SettingsBridgeDisposedError, SettingsBridgeProtocolError, boundedUtf8String,
  hasExactKeys, validatePatchReply, assertJsonByteBudget, MAX_NATIVE_RESPONSE_BYTES,
} from './childBridgeProtocol'
import { isPlainDataRecord } from './childBridgeJsonBudget'
import type { SettingsGeneralProjection } from './childBridgeTypes'

export interface AboutCheckReply {
  success: true
  hasUpdate: boolean
  status: string
  updateInfo?: { version: string; changelog: string }
}
export interface AboutAutoCheckReply {
  revision: string
  value: SettingsGeneralProjection
  notificationDelivered: boolean
  runtimeApplied: boolean
  runtimeError: { code: string; message: string } | null
}
const recoveryPhases = new Set(['available', 'downloading', 'downloaded', 'installing', 'install-unknown', 'restart-pending', 'restarting', 'error'])
const runtimeCodes = new Set(['SETTINGS_UPDATER_RUNTIME_UNAVAILABLE', 'SETTINGS_UPDATER_PROVIDER_DISABLED', 'SETTINGS_UPDATER_PROVIDER_UNAVAILABLE', 'SETTINGS_UPDATER_RUNTIME_STOPPED'])
function exact(value: unknown, keys: string[]): value is Record<string, any> {
  return isPlainDataRecord(value) && Reflect.ownKeys(value).length === keys.length && hasExactKeys(value, keys)
}
function text(value: unknown, max: number): value is string {
  return boundedUtf8String(value, max) && !value.includes('\0') && !/[\ud800-\udfff]/u.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ''))
}
function fail(): never { throw new SettingsBridgeProtocolError() }
export function parseAboutCheckReply(raw: unknown): AboutCheckReply {
  if (!isPlainDataRecord(raw) || typeof raw.hasUpdate !== 'boolean' || !exact(raw,
    raw.hasUpdate ? ['success', 'hasUpdate', 'status', 'updateInfo'] : ['success', 'hasUpdate', 'status'])) return fail()
  if (raw.success !== true || typeof raw.status !== 'string') return fail()
  if (raw.hasUpdate) {
    if (!recoveryPhases.has(raw.status) || !exact(raw.updateInfo, ['version', 'changelog']) ||
      !text(raw.updateInfo.version, 128) || !raw.updateInfo.version || !text(raw.updateInfo.changelog, 48 * 1024)) return fail()
  } else if (raw.status !== 'not-available') return fail()
  if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > 64 * 1024) return fail()
  return structuredClone(raw) as AboutCheckReply
}
export function parseAboutAutoReply(raw: unknown, defaultAvatar?: string): AboutAutoCheckReply {
  if (!exact(raw, ['revision', 'value', 'notificationDelivered', 'runtimeApplied', 'runtimeError']) || typeof raw.runtimeApplied !== 'boolean') return fail()
  const patch = validatePatchReply({ revision: raw.revision, value: raw.value, notificationDelivered: raw.notificationDelivered }, defaultAvatar)
  const error = raw.runtimeError
  if (raw.runtimeApplied ? error !== null : (!exact(error, ['code', 'message']) ||
    typeof error.code !== 'string' || !runtimeCodes.has(error.code) || !text(error.message, 2048))) return fail()
  assertJsonByteBudget({ ...patch, runtimeApplied: raw.runtimeApplied, runtimeError: error }, MAX_NATIVE_RESPONSE_BYTES)
  return { ...patch, runtimeApplied: raw.runtimeApplied, runtimeError: error === null ? null : { code: error.code, message: error.message } }
}

/** One Child owns these requests; no timers, subscriptions, package paths or updater SDK. */
export function createSettingsAboutUpdate(options: { invoke: (operation: 'getAppVersion' | 'checkAppUpdate', payload: Record<string, unknown>) => Promise<unknown>; isLive: () => boolean }) {
  let version: string | undefined
  let versionRequest: Promise<string> | undefined
  let checkRequest: Promise<AboutCheckReply> | undefined
  const live = () => { if (!options.isLive()) throw new SettingsBridgeDisposedError() }
  return {
    getAppVersion(): Promise<string> {
      live()
      if (version !== undefined) return Promise.resolve(version)
      if (versionRequest) return versionRequest
      versionRequest = options.invoke('getAppVersion', {}).then(raw => {
        live()
        if (!exact(raw, ['appVersion']) || !text(raw.appVersion, 128) || !raw.appVersion) return fail()
        version = raw.appVersion
        return version
      }).finally(() => { versionRequest = undefined })
      return versionRequest
    },
    updaterCheckUpdate(): Promise<AboutCheckReply> {
      live()
      if (checkRequest) return checkRequest
      checkRequest = options.invoke('checkAppUpdate', {}).then(raw => { live(); return parseAboutCheckReply(raw) })
        .finally(() => { checkRequest = undefined })
      return checkRequest
    },
  }
}
