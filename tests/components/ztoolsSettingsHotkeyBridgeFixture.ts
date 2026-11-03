import { vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import type {
  SettingsBridgeTarget,
  SettingsGeneralProjection,
  SettingsNativeInvoke,
  SettingsReadyReply,
  SettingsViewConfig
} from '../../packages/ztools-settings/src/childBridgeTypes'

export const CONFIG: SettingsViewConfig = {
  version: 1,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin'
}

export const GENERAL: SettingsGeneralProjection = {
  opacity: 0.8,
  windowDefaultHeight: 500,
  hotkey: 'Option+Z',
  placeholder: 'Search',
  avatar: null,
  autoPaste: 'off',
  autoClear: 'never',
  autoBackToSearch: 'never',
  windowPositionStrategy: 'remember',
  showRecentInSearch: true,
  showMatchRecommendation: false,
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
  windowMaterial: 'mica',
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

interface NativeCall {
  operation: string
  payload: Record<string, unknown>
}

function readNativeEditableFields(): string[] {
  const source = readFileSync('crates/atools-core/src/db/renderer_general_settings.rs', 'utf8')
  const declaration = source.match(
    /pub const RENDERER_GENERAL_SETTINGS_FIELDS:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/
  )
  if (!declaration) throw new Error('Core renderer General capability declaration was not found')
  const fields = Array.from(declaration[2].matchAll(/"([^"\\]+)"/g), (match) => match[1])
  if (fields.length !== Number(declaration[1]) ||
      fields.slice(-8).join(',') !== 'hotkey,windowPositionStrategy,clipboardRetentionDays,autoBackToSearch,autoPaste,builtinAppShortcutsEnabled,windowDefaultHeight,autoCheckUpdate') {
    throw new Error('Core renderer General capability has an invalid appended field suffix')
  }
  return fields
}

export function createHotkeyBridge(
  notificationDelivered = false,
  initialHotkey = GENERAL.hotkey,
  options: { target?: SettingsBridgeTarget; defaultHeight?: number; recording?: (operation: string, payload: Record<string, unknown>) => Promise<unknown> } = {}
) {
  const calls: NativeCall[] = []
  const editableFields = readNativeEditableFields() as SettingsReadyReply['capabilities']['editableGeneralFields']
  let revision = 'rev-1'
  let revisionNumber = 1
  let value = { ...structuredClone(GENERAL), hotkey: initialHotkey, windowDefaultHeight: options.defaultHeight ?? GENERAL.windowDefaultHeight }
  let currentShortcut = initialHotkey
  let patchFailure: unknown = null
  let patchReply: unknown = null
  let rejectedShortcut: string | null = null
  let heldPatch: { started: () => void; release: Promise<void> } | null = null

  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'startHotkeyRecording' || operation === 'stopHotkeyRecording') {
      if (options.recording) return options.recording(operation, payload)
      throw new Error('Native recording unavailable')
    }
    if (operation === 'ready') {
      return {
        version: 1,
        sessionId: CONFIG.sessionId,
        bundleRevision: CONFIG.bundleRevision,
        platform: CONFIG.platform,
        general: { revision, value: structuredClone(value) },
        runtime: {
          currentShortcut,
          launchAtLogin: false,
          launchAtLoginAvailable: true,
          opacity: value.opacity,
          theme: value.theme,
          themeApplied: true,
          opacityApplied: true
        },
        capabilities: { editableGeneralFields: [...editableFields] },
        action: { code: 'main', type: 'text', payload: '' }
      }
    }
    if (operation !== 'patchGeneral') throw new Error(`Unexpected operation ${operation}`)

    if (heldPatch) {
      const pending = heldPatch
      heldPatch = null
      pending.started()
      await pending.release
    }
    if (patchFailure !== null) {
      const failure = patchFailure
      patchFailure = null
      throw failure
    }
    if (patchReply !== null) {
      const reply = patchReply
      patchReply = null
      return reply
    }

    const changes = payload.changes as Partial<SettingsGeneralProjection>
    if (typeof changes.hotkey === 'string' && changes.hotkey === rejectedShortcut) {
      rejectedShortcut = null
      throw { code: 'SETTINGS_HOTKEY_REJECTED', message: 'private detail' }
    }
    value = { ...value, ...changes, builtinAppShortcutsEnabled: {
      ...value.builtinAppShortcutsEnabled, ...changes.builtinAppShortcutsEnabled
    } }
    if (typeof changes.hotkey === 'string') currentShortcut = changes.hotkey
    revisionNumber += 1
    revision = `rev-${revisionNumber}`
    return { revision, value: structuredClone(value), notificationDelivered }
  }

  const target = options.target ?? new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: vi.fn() })
  bridge.attach(target)
  return {
    bridge,
    calls,
    internal: (target.ztools as SettingsZToolsApi).internal,
    failNextPatch(error: unknown) { patchFailure = error },
    replyNextPatch(reply: unknown) { patchReply = reply },
    rejectShortcut(value: string) { rejectedShortcut = value },
    holdNextPatch() {
      let started!: () => void
      let release!: () => void
      const releasePromise = new Promise<void>((resolve) => { release = resolve })
      heldPatch = { started: () => started(), release: releasePromise }
      return { started: new Promise<void>((resolve) => { started = resolve }), release }
    }
  }
}

