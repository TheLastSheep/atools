import { installAppShortcutIntentReceiver } from './appShortcutIntent'
import { useToast } from '@/components/common/Toast/Toast'
import { DEFAULT_AVATAR } from '@/constants'
import { createSettingsChildBridge } from './childBridge'
import { SETTINGS_HOST_FAILURE_MESSAGE } from './childBridgeProtocol'
import type { SettingsBridgeTarget } from './childBridgeTypes'

const toast = useToast()
const hostWindow = window as unknown as SettingsBridgeTarget
const nativeCore = hostWindow.__TAURI__?.core

if (!nativeCore || typeof nativeCore.invoke !== 'function') {
  toast.error(SETTINGS_HOST_FAILURE_MESSAGE)
  throw new Error('Settings child bridge is unavailable.')
}

try {
  const config = hostWindow.__ATOOLS_SETTINGS_VIEW_CONFIG__ as { sessionId?: unknown }
  if (typeof config?.sessionId !== 'string') throw new Error('Invalid session')
  const disposeIntent = installAppShortcutIntentReceiver(window, config.sessionId, async payload => {
    const reply = await nativeCore.invoke!('call_renderer_settings', { sessionId: config.sessionId, operation: 'ackAppShortcutIntent', payload })
    if (!reply || typeof reply !== 'object' || Object.keys(reply).length !== 1 || (reply as { acknowledged?: unknown }).acknowledged !== true)
      throw new Error('Settings intent acknowledgement failed')
  })
  const bridge = createSettingsChildBridge({
    config: hostWindow.__ATOOLS_SETTINGS_VIEW_CONFIG__,
    defaultAvatar: DEFAULT_AVATAR,
    invoke: async (operation, payload, sessionId) => {
      return nativeCore.invoke!('call_renderer_settings', { sessionId, operation, payload })
    },
    reportError: (message) => toast.error(message)
  })
  bridge.attach(hostWindow)
  ;(hostWindow.ztools as { onPluginOut(callback: () => void): void }).onPluginOut(disposeIntent)
} catch {
  toast.error(SETTINGS_HOST_FAILURE_MESSAGE)
  throw new Error('Settings child bridge configuration is invalid.')
}
