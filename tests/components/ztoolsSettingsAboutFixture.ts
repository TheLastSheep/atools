import { vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import { EDITABLE_GENERAL_FIELDS } from '../../packages/ztools-settings/src/childBridgeProtocol'
import type { SettingsBridgeTarget, SettingsNativeInvoke, SettingsReadyReply } from '../../packages/ztools-settings/src/childBridgeTypes'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import { CONFIG, GENERAL } from './ztoolsSettingsHotkeyBridgeFixture'

export function aboutFixture() {
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
  let revision = 1
  let value = structuredClone(GENERAL)
  let hold: { operation: string; wait: Promise<void> } | undefined
  let nextError: unknown
  let replyOverride: unknown
  let runtimeApplied = true, notificationDelivered = true
  const reportError = vi.fn()
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (hold?.operation === operation) { const current = hold; hold = undefined; await current.wait }
    if (nextError) { const error = nextError; nextError = undefined; throw error }
    if (replyOverride !== undefined) { const reply = replyOverride; replyOverride = undefined; return reply }
    if (operation === 'ready') return {
      version: 1, sessionId: CONFIG.sessionId, bundleRevision: CONFIG.bundleRevision, platform: 'darwin',
      general: { revision: `rev-${revision}`, value: structuredClone(value) },
      runtime: { currentShortcut: value.hotkey, launchAtLogin: false, launchAtLoginAvailable: true,
        opacity: value.opacity, theme: 'system', themeApplied: true, opacityApplied: true },
      capabilities: { editableGeneralFields: [...EDITABLE_GENERAL_FIELDS] }, action: { code: 'main', type: 'text', payload: '' },
    } satisfies SettingsReadyReply
    if (operation === 'getAppVersion') return { appVersion: '0.9.79' }
    if (operation === 'checkAppUpdate') return { success: true, hasUpdate: false, status: 'not-available' }
    if (operation === 'setAutoCheckUpdate') {
      if (payload.revision !== `rev-${revision}`) throw { code: 'SETTINGS_REVISION_CONFLICT' }
      value = { ...value, autoCheckUpdate: payload.enabled as boolean }; revision += 1
      return { revision: `rev-${revision}`, value: structuredClone(value), notificationDelivered, runtimeApplied,
        runtimeError: runtimeApplied ? null : { code: 'SETTINGS_UPDATER_PROVIDER_DISABLED', message: '更新提供方不可用。' } }
    }
    throw new Error(`Unexpected About operation ${operation}`)
  }
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError })
  const target = new EventTarget() as SettingsBridgeTarget
  bridge.attach(target)
  const api = target.ztools as SettingsZToolsApi
  return {
    bridge, target, api, calls, reportError, committed: () => value,
    fail(error: unknown) { nextError = error }, reply(raw: unknown) { replyOverride = raw },
    partial(runtime = false, notify = true) { runtimeApplied = runtime; notificationDelivered = notify },
    hold(operation: string) { let release!: () => void; const wait = new Promise<void>(done => { release = done }); hold = { operation, wait }; return release },
  }
}
