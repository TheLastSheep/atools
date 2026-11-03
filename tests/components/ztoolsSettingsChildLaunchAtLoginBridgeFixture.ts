import { vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import { EDITABLE_GENERAL_FIELDS } from '../../packages/ztools-settings/src/childBridgeProtocol'
import type {
  SettingsGeneralProjection,
  SettingsNativeInvoke,
  SettingsBridgeTarget,
  SettingsReadyReply,
  SettingsViewConfig
} from '../../packages/ztools-settings/src/childBridgeTypes'

export const CONFIG: SettingsViewConfig = {
  version: 1,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin'
}

const GENERAL: SettingsGeneralProjection = {
  opacity: 1,
  windowDefaultHeight: 500,
  hotkey: 'Option+Z',
  placeholder: 'Search',
  avatar: null,
  autoPaste: 'off',
  autoClear: 'never',
  autoBackToSearch: 'never',
  windowPositionStrategy: 'remember',
  showRecentInSearch: true,
  showMatchRecommendation: true,
  localAppSearch: true,
  recentRows: 5,
  pinnedRows: 5,
  searchMode: 'aggregate',
  tabKeyFunction: 'navigate',
  tabTargetCommand: '',
  spaceOpenCommand: false,
  floatingBallDoubleClickCommand: '',
  floatingBallEnabled: false,
  floatingBallLetter: 'Z',
  superPanelEnabled: false,
  superPanelMouseButton: 'middle',
  superPanelLongPressMs: 500,
  superPanelBlockedApps: [],
  wakeupBlacklist: [],
  superPanelTranslateEnabled: false,
  theme: 'system',
  primaryColor: 'green',
  customColor: '#123456',
  showTrayIcon: true,
  windowMaterial: 'none',
  acrylicLightOpacity: 80,
  acrylicDarkOpacity: 80,
  devToolsMode: 'right',
  disableGpuAcceleration: false,
  customInternalApiPluginNames: [],
  proxyEnabled: false,
  proxyUrl: '',
  autoCheckUpdate: true,
  clipboardRetentionDays: 30,
  terminal: '',
  terminalCustomCommand: '',
  builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true }
}

export interface BridgeControls {
  config?: SettingsViewConfig
  target?: SettingsBridgeTarget
  initialEnabled?: boolean | null
  readyAvailable?: boolean
  readyLaunchAtLogin?: boolean | null
  readNative?: (
    payload: Record<string, unknown>,
    state: { getEnabled: () => boolean | null; setEnabled: (value: boolean) => void }
  ) => Promise<unknown>
  inspectLegacy?: () => Promise<unknown>
  resolveLegacy?: (
    payload: Record<string, unknown>,
    state: { getEnabled: () => boolean | null; setEnabled: (value: boolean) => void }
  ) => Promise<unknown>
  setNative?: (
    payload: Record<string, unknown>,
    state: { getEnabled: () => boolean | null; setEnabled: (value: boolean) => void }
  ) => Promise<unknown>
}

export function createBridge(available = true, controls: BridgeControls = {}) {
  const config = controls.config ?? CONFIG
  const target = controls.target ?? new EventTarget() as SettingsBridgeTarget
  target.__ATOOLS_SETTINGS_VIEW_CONFIG__ = config
  let enabled: boolean | null = controls.initialEnabled === undefined ? false : controls.initialEnabled
  let conflict = false
  const calls: Array<{ operation: string; payload: Record<string, unknown> }> = []
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'ready') {
      return {
        version: 1,
        sessionId: config.sessionId,
        bundleRevision: config.bundleRevision,
        platform: config.platform,
        general: { revision: 'rev-1', value: structuredClone(GENERAL) },
        runtime: {
          currentShortcut: GENERAL.hotkey,
          launchAtLogin: controls.readyLaunchAtLogin === undefined
            ? (available ? enabled : null)
            : controls.readyLaunchAtLogin,
          launchAtLoginAvailable: controls.readyAvailable ?? available,
          opacity: GENERAL.opacity,
          theme: GENERAL.theme,
          themeApplied: true,
          opacityApplied: true
        },
        capabilities: { editableGeneralFields: [...EDITABLE_GENERAL_FIELDS] },
        action: { code: 'main', type: 'text', payload: '' }
      } satisfies SettingsReadyReply
    }
    if (operation === 'patchGeneral') {
      return {
        revision: 'rev-2',
        value: { ...GENERAL, ...(payload.changes as Record<string, unknown>) },
        notificationDelivered: true
      }
    }
    if (operation === 'inspectLegacyLaunchAtLogin') {
      if (!controls.inspectLegacy) throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
      return controls.inspectLegacy()
    }
    if (operation === 'resolveLegacyLaunchAtLogin') {
      if (!controls.resolveLegacy) throw new Error('Unexpected legacy resolution')
      return controls.resolveLegacy(payload, {
        getEnabled: () => enabled,
        setEnabled: (value) => { enabled = value }
      })
    }
    if (operation === 'readLaunchAtLogin') {
      if (controls.readNative) {
        return controls.readNative(payload, {
          getEnabled: () => enabled,
          setEnabled: (value) => { enabled = value }
        })
      }
      if (enabled === null) throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_LEGACY_CONFIGURATION' }
      return { enabled }
    }
    if (operation !== 'setLaunchAtLogin') throw new Error(`Unexpected operation ${operation}`)
    if (controls.setNative) {
      return controls.setNative(payload, {
        getEnabled: () => enabled,
        setEnabled: (value) => { enabled = value }
      })
    }
    if (conflict || payload.expected !== enabled) throw { code: 'SETTINGS_LAUNCH_AT_LOGIN_CONFLICT' }
    enabled = payload.enabled as boolean
    return { enabled }
  }
  const reportError = vi.fn()
  const bridge = createSettingsChildBridge({ config, invoke, reportError })
  bridge.attach(target)
  return {
    bridge,
    calls,
    target,
    internal: (target as EventTarget & { ztools: SettingsZToolsApi }).ztools.internal,
    setConflict(value: boolean) { conflict = value },
    reportError
  }
}
