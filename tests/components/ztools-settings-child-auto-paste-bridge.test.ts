import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import { EDITABLE_GENERAL_FIELDS } from '../../packages/ztools-settings/src/childBridgeProtocol'
import type {
  SettingsBridgeTarget,
  SettingsGeneralProjection,
  SettingsNativeInvoke,
  SettingsReadyReply,
  SettingsViewConfig
} from '../../packages/ztools-settings/src/childBridgeTypes'

const CONFIG: SettingsViewConfig = {
  version: 1,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin'
}

const GENERAL: SettingsGeneralProjection = {
  opacity: 0.8,
  windowDefaultHeight: 500,
  hotkey: 'Alt+Space',
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
  floatingBallLetter: '',
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

function createBridge(notificationDelivered = true) {
  const calls: NativeCall[] = []
  let revisionNumber = 1
  let revision = 'rev-1'
  let value = structuredClone(GENERAL)
  let patchFailure: unknown = null
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'ready') return {
      version: 1,
      sessionId: CONFIG.sessionId,
      bundleRevision: CONFIG.bundleRevision,
      platform: CONFIG.platform,
      general: { revision, value: structuredClone(value) },
      runtime: {
        currentShortcut: 'Alt+Space',
        launchAtLogin: false,
        launchAtLoginAvailable: true,
        opacity: value.opacity,
        theme: 'system',
        themeApplied: true,
        opacityApplied: true
      },
      capabilities: { editableGeneralFields: [...EDITABLE_GENERAL_FIELDS] },
      action: { code: 'main', type: 'text', payload: '' }
    } satisfies SettingsReadyReply
    if (operation === 'patchGeneral') {
      if (patchFailure !== null) {
        const failure = patchFailure
        patchFailure = null
        throw failure
      }
      value = { ...value, ...(payload.changes as Partial<SettingsGeneralProjection>) }
      revisionNumber += 1
      revision = `rev-${revisionNumber}`
      return { revision, value: structuredClone(value), notificationDelivered }
    }
    throw new Error(`Unexpected operation ${operation}`)
  }
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: vi.fn() })
  bridge.attach(target)
  return {
    bridge,
    calls,
    internal: (target.ztools as SettingsZToolsApi).internal,
    failNextPatch(error: unknown) { patchFailure = error }
  }
}

describe('ztools settings child autoPaste bridge', () => {
  it('saves all five settings and confirms the original save without an extra patch', async () => {
    const { bridge, calls, internal } = createBridge()
    const changes = ['3s', '1s', '5s', '10s', 'off', '3s', 'off'] as const

    for (const autoPaste of changes) {
      await internal.dbPut('settings-general', { ...GENERAL, autoPaste })
      await expect(internal.updateAutoPaste(autoPaste)).resolves.toBeUndefined()
    }

    expect(calls.map(({ operation }) => operation)).toEqual([
      'ready', ...changes.map(() => 'patchGeneral')
    ])
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')
      .map(({ payload }) => payload.changes)).toEqual(changes.map((autoPaste) => ({ autoPaste })))
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ autoPaste: 'off' })
    bridge.dispose()
  })

  it('rejects invalid, unconfirmed, mismatched, failed, and closed-session saves', async () => {
    const undelivered = createBridge(false)
    await expect(undelivered.internal.updateAutoPaste('3s'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED' })
    await expect(Reflect.apply(undelivered.internal.updateAutoPaste, undelivered.internal, ['2s']))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(undelivered.internal.dbPut('settings-general', { ...GENERAL, autoPaste: '2s' }))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await undelivered.internal.dbPut('settings-general', { ...GENERAL, autoPaste: '3s' })
    await expect(undelivered.internal.updateAutoPaste('1s'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED' })
    await expect(undelivered.internal.updateAutoPaste('3s'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED' })
    expect(undelivered.calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    undelivered.bridge.dispose()

    const failed = createBridge()
    failed.failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(failed.internal.dbPut('settings-general', { ...GENERAL, autoPaste: '3s' }))
      .rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(failed.internal.updateAutoPaste('3s'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED' })
    expect(failed.calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    failed.bridge.dispose()

    const closed = createBridge()
    await closed.internal.dbPut('settings-general', { ...GENERAL, autoPaste: '3s' })
    await closed.internal.updateAutoPaste('3s')
    closed.bridge.dispose()
    await expect(closed.internal.updateAutoPaste('off'))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    expect(closed.calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
  })
})
