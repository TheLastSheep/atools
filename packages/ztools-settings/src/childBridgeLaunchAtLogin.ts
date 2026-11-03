import type { SettingsReadyReply } from './childBridgeTypes'
import {
  SettingsBridgeDisposedError,
  SettingsBridgeError,
  SettingsBridgeProtocolError,
  nativeErrorCode
} from './childBridgeProtocol'
import { normalizeSettingsNativeFailure } from './childBridgeNativeErrors'
import type {
  LaunchAtLoginInspection,
  LaunchAtLoginResolutionRequest
} from './launchAtLoginContract'
import {
  LAUNCH_AT_LOGIN_CONFLICT_CODE as CONFLICT,
  LAUNCH_AT_LOGIN_UNAVAILABLE_CODE as UNAVAILABLE,
  LAUNCH_AT_LOGIN_UNSUPPORTED_CODE as UNSUPPORTED,
  LAUNCH_AT_LOGIN_APPROVAL_REQUIRED_CODE as APPROVAL_REQUIRED,
  LAUNCH_AT_LOGIN_LEGACY_CODE as LEGACY_CONFIGURATION,
  LAUNCH_AT_LOGIN_RECOVERY_FAILED_CODE as RECOVERY_FAILED,
  LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE,
  LAUNCH_AT_LOGIN_ERROR_MESSAGES,
  LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE,
  parseLaunchAtLoginEnabled,
  parseLaunchAtLoginInspection,
  parseLaunchAtLoginResolution
} from './launchAtLoginContract'

export interface SettingsChildLaunchAtLoginBridge {
  getLaunchAtLogin(): Promise<boolean>
  setLaunchAtLogin(value: unknown): Promise<void>
  inspectLegacyLaunchAtLogin(): Promise<LaunchAtLoginInspection>
  resolveLegacyLaunchAtLogin(value: unknown): Promise<{ enabled: boolean }>
}

export interface SettingsChildLaunchAtLoginBridgeOptions {
  getReady: () => Promise<SettingsReadyReply>
  invokeNative: (
    operation: 'setLaunchAtLogin' | 'readLaunchAtLogin' | 'inspectLegacyLaunchAtLogin' | 'resolveLegacyLaunchAtLogin',
    payload: Record<string, unknown>
  ) => Promise<unknown>
  runSerialized<T>(run: () => Promise<T>): Promise<T>
  isLive: () => boolean
  reportError: (message: string) => void
  rejectUnsupported: (notify?: boolean) => never
}

export function createSettingsChildLaunchAtLoginBridge(
  options: SettingsChildLaunchAtLoginBridgeOptions
): SettingsChildLaunchAtLoginBridge {
  function report(message: string): void {
    if (!options.isLive()) return
    try {
      options.reportError(message)
    } catch {}
  }

  function assertLive(): void {
    if (!options.isLive()) throw new SettingsBridgeDisposedError()
  }

  function withReady<T>(operation: (ready: SettingsReadyReply) => Promise<T>): Promise<T> {
    return options.runSerialized(async () => {
      const ready = await options.getReady()
      assertLive()
      if (!ready.runtime.launchAtLoginAvailable) return options.rejectUnsupported(true)
      return operation(ready)
    })
  }

  function unknownState(notify = true): never {
    const error = new SettingsBridgeError(CONFLICT, LAUNCH_AT_LOGIN_ERROR_MESSAGES[CONFLICT])
    if (notify) report(error.message)
    throw error
  }

  function validateResolution(value: unknown): LaunchAtLoginResolutionRequest {
    const request = parseLaunchAtLoginResolution(value)
    if (!request) throw new SettingsBridgeProtocolError()
    return request
  }

  function parseInspection(value: unknown): LaunchAtLoginInspection {
    const inspection = parseLaunchAtLoginInspection(value)
    if (!inspection) throw new SettingsBridgeProtocolError()
    return inspection
  }

  function rejectUnknownOutcome(error: unknown, ready: SettingsReadyReply): never {
    if (error instanceof SettingsBridgeDisposedError || !options.isLive()) {
      throw error instanceof SettingsBridgeDisposedError ? error : new SettingsBridgeDisposedError()
    }
    const code = nativeErrorCode(error)
    if (code === APPROVAL_REQUIRED || code === LEGACY_CONFIGURATION) {
      ready.runtime.launchAtLogin = null
      const knownRejection = normalizeSettingsNativeFailure(error, 'setLaunchAtLogin')
      report(knownRejection.message)
      throw knownRejection
    }
    if (code === UNSUPPORTED || code === LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE) {
      ready.runtime.launchAtLoginAvailable = false
      ready.runtime.launchAtLogin = null
      const unsupported = normalizeSettingsNativeFailure(error, 'setLaunchAtLogin')
      report(unsupported.message)
      throw unsupported
    }

    ready.runtime.launchAtLogin = null
    const normalized = normalizeSettingsNativeFailure(error, 'setLaunchAtLogin')
    const confirmedFailure = code === CONFLICT || code === UNAVAILABLE || code === RECOVERY_FAILED
      ? normalized
      : new SettingsBridgeError(CONFLICT, LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE)
    report(confirmedFailure.message)
    throw confirmedFailure
  }

  function getLaunchAtLogin(): Promise<boolean> {
    return withReady(async (ready) => {
      if (typeof ready.runtime.launchAtLogin !== 'boolean') {
        let raw: unknown
        try {
          raw = await options.invokeNative('readLaunchAtLogin', {})
        } catch (error) {
          if (error instanceof SettingsBridgeDisposedError || !options.isLive()) {
            throw error instanceof SettingsBridgeDisposedError ? error : new SettingsBridgeDisposedError()
          }
          const code = nativeErrorCode(error)
          ready.runtime.launchAtLogin = null
          if (code === UNSUPPORTED || code === LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE) {
            ready.runtime.launchAtLoginAvailable = false
            return options.rejectUnsupported(false)
          }
          throw normalizeSettingsNativeFailure(error, 'readLaunchAtLogin')
        }
        assertLive()
        const enabled = parseLaunchAtLoginEnabled(raw)
        if (enabled === null) {
          ready.runtime.launchAtLogin = null
          return unknownState(false)
        }
        ready.runtime.launchAtLogin = enabled
      }
      return ready.runtime.launchAtLogin
    })
  }

  async function setLaunchAtLogin(value: unknown): Promise<void> {
    if (typeof value !== 'boolean') {
      report(LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE)
      throw new SettingsBridgeProtocolError()
    }
    await withReady(async (ready) => {
      const expected = ready.runtime.launchAtLogin
      if (typeof expected !== 'boolean') return unknownState()

      let raw: unknown
      try {
        raw = await options.invokeNative('setLaunchAtLogin', { enabled: value, expected })
      } catch (error) {
        return rejectUnknownOutcome(error, ready)
      }
      assertLive()
      if (parseLaunchAtLoginEnabled(raw) !== value) {
        return rejectUnknownOutcome(new SettingsBridgeProtocolError(), ready)
      }
      ready.runtime.launchAtLogin = value
    })
  }

  function inspectLegacyLaunchAtLogin(): Promise<LaunchAtLoginInspection> {
    return withReady(async () => {
      try {
        const raw = await options.invokeNative('inspectLegacyLaunchAtLogin', {})
        assertLive()
        return parseInspection(raw)
      } catch (error) {
        if (error instanceof SettingsBridgeDisposedError || !options.isLive()) {
          throw error instanceof SettingsBridgeDisposedError ? error : new SettingsBridgeDisposedError()
        }
        const normalized = normalizeSettingsNativeFailure(error, 'inspectLegacyLaunchAtLogin')
        report(normalized.message)
        throw normalized
      }
    })
  }

  async function resolveLegacyLaunchAtLogin(value: unknown): Promise<{ enabled: boolean }> {
    let request: LaunchAtLoginResolutionRequest
    try {
      request = validateResolution(value)
    } catch {
      report(LAUNCH_AT_LOGIN_UNCONFIRMED_MESSAGE)
      throw new SettingsBridgeProtocolError()
    }
    return withReady(async (ready) => {
      let raw: unknown
      try {
        raw = await options.invokeNative('resolveLegacyLaunchAtLogin', request)
      } catch (error) {
        return rejectUnknownOutcome(error, ready)
      }
      assertLive()
      const expectedEnabled = request.choice === 'migrate'
      const enabled = parseLaunchAtLoginEnabled(raw)
      if (enabled !== expectedEnabled) {
        return rejectUnknownOutcome(new SettingsBridgeProtocolError(), ready)
      }
      ready.runtime.launchAtLogin = enabled
      return { enabled }
    })
  }

  return { getLaunchAtLogin, setLaunchAtLogin, inspectLegacyLaunchAtLogin, resolveLegacyLaunchAtLogin }
}
