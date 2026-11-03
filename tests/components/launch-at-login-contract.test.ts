import { describe, expect, it } from 'vitest'
import { normalizeSettingsNativeFailure } from '../../packages/ztools-settings/src/childBridgeNativeErrors'
import { SettingsBridgeError } from '../../packages/ztools-settings/src/childBridgeProtocol'
import {
  LAUNCH_AT_LOGIN_APPROVAL_REQUIRED_CODE,
  LAUNCH_AT_LOGIN_CONFLICT_CODE,
  LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE,
  LAUNCH_AT_LOGIN_LEGACY_CODE,
  LAUNCH_AT_LOGIN_RECOVERY_FAILED_CODE,
  LAUNCH_AT_LOGIN_UNAVAILABLE_CODE,
  LAUNCH_AT_LOGIN_UNSUPPORTED_CODE,
  launchAtLoginErrorMessage,
  parseLaunchAtLoginEnabled,
  parseLaunchAtLoginInspection,
  parseLaunchAtLoginResolution
} from '../../packages/ztools-settings/src/launchAtLoginContract'

describe('launch-at-login wire contract', () => {
  it('accepts only exact plain enumerable data receipts without evaluating getters', () => {
    expect(parseLaunchAtLoginEnabled({ enabled: true })).toBe(true)
    expect(parseLaunchAtLoginEnabled(Object.assign(Object.create(null), { enabled: false }))).toBe(false)
    expect(parseLaunchAtLoginEnabled([{ enabled: true }])).toBeNull()
    expect(parseLaunchAtLoginEnabled(Object.assign(Object.create({}), { enabled: true }))).toBeNull()
    expect(parseLaunchAtLoginEnabled({ enabled: true, extra: false })).toBeNull()
    expect(parseLaunchAtLoginEnabled({ enabled: true, [Symbol('extra')]: false })).toBeNull()

    let getterCalls = 0
    const accessor = Object.defineProperty({}, 'enabled', {
      enumerable: true,
      get() { getterCalls += 1; return true },
    })
    const hidden = Object.defineProperty({}, 'enabled', { enumerable: false, value: true })
    const throwingReflection = new Proxy({}, { ownKeys() { throw new Error('reflection failed') } })
    expect(parseLaunchAtLoginEnabled(accessor)).toBeNull()
    expect(parseLaunchAtLoginEnabled(hidden)).toBeNull()
    expect(parseLaunchAtLoginEnabled(throwingReflection)).toBeNull()
    expect(getterCalls).toBe(0)
  })

  it('validates legacy inspections and resolution payloads through the same exact-record rules', () => {
    const revision = 'a'.repeat(64)
    expect(parseLaunchAtLoginInspection({ modernEnabled: false, revision }))
      .toEqual({ modernEnabled: false, revision })
    expect(parseLaunchAtLoginInspection({ modernEnabled: false, revision: revision.toUpperCase() })).toBeNull()
    expect(parseLaunchAtLoginInspection({ modernEnabled: false, revision, [Symbol('extra')]: true })).toBeNull()

    const request = { choice: 'migrate', expectedModern: false, revision } as const
    expect(parseLaunchAtLoginResolution(request)).toEqual(request)
    expect(parseLaunchAtLoginResolution({ ...request, choice: 'delete' })).toBeNull()
    expect(parseLaunchAtLoginResolution({ ...request, extra: true })).toBeNull()
    expect(parseLaunchAtLoginResolution(Object.assign([request], {}))).toBeNull()
  })

  it('shares fixed Native messages with controller errors and retains unsupported classification', () => {
    expect([
      LAUNCH_AT_LOGIN_CONFLICT_CODE,
      LAUNCH_AT_LOGIN_UNAVAILABLE_CODE,
      LAUNCH_AT_LOGIN_UNSUPPORTED_CODE,
      LAUNCH_AT_LOGIN_APPROVAL_REQUIRED_CODE,
      LAUNCH_AT_LOGIN_LEGACY_CODE,
      LAUNCH_AT_LOGIN_RECOVERY_FAILED_CODE,
      LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE,
    ]).toEqual([
      'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT',
      'SETTINGS_LAUNCH_AT_LOGIN_UNAVAILABLE',
      'SETTINGS_LAUNCH_AT_LOGIN_UNSUPPORTED',
      'SETTINGS_LAUNCH_AT_LOGIN_APPROVAL_REQUIRED',
      'SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION',
      'SETTINGS_LAUNCH_AT_LOGIN_RECOVERY_FAILED',
      'ERR_ATOOLS_SETTINGS_UNSUPPORTED',
    ])
    for (const code of [
      LAUNCH_AT_LOGIN_CONFLICT_CODE,
      LAUNCH_AT_LOGIN_UNAVAILABLE_CODE,
      LAUNCH_AT_LOGIN_APPROVAL_REQUIRED_CODE,
      LAUNCH_AT_LOGIN_LEGACY_CODE,
      LAUNCH_AT_LOGIN_RECOVERY_FAILED_CODE,
    ]) {
      const message = launchAtLoginErrorMessage(code)!
      expect(normalizeSettingsNativeFailure({ code }, 'readLaunchAtLogin'))
        .toMatchObject({ code, message })
      expect(normalizeSettingsNativeFailure(new SettingsBridgeError(code, 'stale copy'), 'readLaunchAtLogin'))
        .toMatchObject({ code, message })
    }
    expect(launchAtLoginErrorMessage('constructor')).toBeUndefined()
    expect(launchAtLoginErrorMessage('toString')).toBeUndefined()
    expect(normalizeSettingsNativeFailure({ code: LAUNCH_AT_LOGIN_UNSUPPORTED_CODE }, 'readLaunchAtLogin'))
      .toMatchObject({ code: LAUNCH_AT_LOGIN_HOST_UNSUPPORTED_CODE })
  })
})
