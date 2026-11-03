import { vi } from 'vitest'
import { createSettingsChildGeneralBridge } from '../../packages/ztools-settings/src/childBridgeGeneral'
import { EDITABLE_GENERAL_FIELDS, SettingsBridgeError } from '../../packages/ztools-settings/src/childBridgeProtocol'
import { normalizeSettingsNativeFailure } from '../../packages/ztools-settings/src/childBridgeNativeErrors'
import type { SettingsGeneralProjection, SettingsReadyReply } from '../../packages/ztools-settings/src/childBridgeTypes'

export const GENERAL: SettingsGeneralProjection = {
  opacity: 0.8, windowDefaultHeight: 500, hotkey: 'Alt+Space', placeholder: 'Search', avatar: null,
  autoPaste: 'off', autoClear: 'never', autoBackToSearch: 'never', windowPositionStrategy: 'remember',
  showRecentInSearch: true, showMatchRecommendation: false, localAppSearch: true, recentRows: 5,
  pinnedRows: 5, searchMode: 'aggregate', tabKeyFunction: 'navigate', tabTargetCommand: '',
  spaceOpenCommand: false, floatingBallDoubleClickCommand: '', floatingBallEnabled: false,
  floatingBallLetter: '', superPanelEnabled: false, superPanelMouseButton: 'middle', superPanelLongPressMs: 500,
  superPanelBlockedApps: [], wakeupBlacklist: [], superPanelTranslateEnabled: false, theme: 'system',
  primaryColor: 'green', customColor: '#123456', showTrayIcon: true, windowMaterial: 'mica',
  acrylicLightOpacity: 80, acrylicDarkOpacity: 80, devToolsMode: 'right', disableGpuAcceleration: false,
  customInternalApiPluginNames: [], proxyEnabled: false, proxyUrl: '', autoCheckUpdate: true,
  clipboardRetentionDays: 30, terminal: '', terminalCustomCommand: '',
  builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true }
}

export function builtinSettingsFixture(notificationDelivered = true, initial: SettingsGeneralProjection = GENERAL) {
  const ready: SettingsReadyReply = {
    version: 1, sessionId: 'a'.repeat(32), bundleRevision: 'b'.repeat(64), platform: 'darwin',
    general: { revision: 'revision-1', value: structuredClone(initial) },
    runtime: { currentShortcut: GENERAL.hotkey, launchAtLogin: false, launchAtLoginAvailable: true,
      opacity: GENERAL.opacity, theme: 'system', themeApplied: true, opacityApplied: true },
    capabilities: { editableGeneralFields: [...EDITABLE_GENERAL_FIELDS] }, action: { code: 'main', type: 'text', payload: '' }
  }
  let failure: unknown
  let live = true
  let held: { start(): void; gate: Promise<void> } | undefined
  let committed = structuredClone(initial)
  const patches: Array<{ revision: string; changes: Record<string, unknown> }> = []
  const reportError = vi.fn()
  const bridge = createSettingsChildGeneralBridge({
    getReady: async () => ready, isLive: () => live, reportError,
    rejectUnsupported: () => { throw new Error('unsupported') },
    async invokePatch(revision, changes) {
      patches.push({ revision, changes })
      if (held) { const pending = held; held = undefined; pending.start(); await pending.gate }
      if (failure) { const error = failure; failure = undefined; throw error }
      const patch = changes.builtinAppShortcutsEnabled as Record<string, boolean>
      committed = { ...committed, builtinAppShortcutsEnabled: { ...committed.builtinAppShortcutsEnabled, ...patch } }
      return { revision: `revision-${patches.length + 1}`, value: structuredClone(committed), notificationDelivered }
    }
  })
  return {
    bridge, ready, patches, reportError, committed: () => committed,
    failCas() { failure = new SettingsBridgeError('SETTINGS_REVISION_CONFLICT', '设置已变化，请关闭并重新打开。') },
    failNative(code = 'SETTINGS_CLOSE_SHORTCUT_UNSUPPORTED') { failure = normalizeSettingsNativeFailure({ code, message: 'private native detail' }, 'patchGeneral') },
    close() { live = false; bridge.dispose() },
    hold() {
      let start!: () => void
      let release!: () => void
      const started = new Promise<void>((resolve) => { start = resolve })
      const gate = new Promise<void>((resolve) => { release = resolve })
      held = { start, gate }
      return { started, release }
    }
  }
}
