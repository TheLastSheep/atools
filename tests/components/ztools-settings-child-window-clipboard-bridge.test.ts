import { describe, expect, it, vi } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import { EDITABLE_GENERAL_FIELDS } from '../../packages/ztools-settings/src/childBridgeProtocol'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import type {
  SettingsBridgeTarget,
  SettingsGeneralProjection,
  SettingsNativeInvoke,
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
  clipboardRetentionDays: 7,
  terminal: '',
  terminalCustomCommand: '',
  builtinAppShortcutsEnabled: { search: true, esc: true, closePlugin: true }
}

interface NativeCall {
  operation: string
  payload: Record<string, unknown>
}

type WindowClipboardApi = {
  updateWindowPositionStrategy: (value: unknown) => Promise<void>
  updateClipboardConfig: (value: unknown) => Promise<void>
}

function createBridge(notificationDelivered = true) {
  const calls: NativeCall[] = []
  let revision = 'rev-1'
  let revisionNumber = 1
  let value = structuredClone(GENERAL)
  let patchFailure: unknown = null
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'ready') {
      return {
        version: 1,
        sessionId: CONFIG.sessionId,
        bundleRevision: CONFIG.bundleRevision,
        platform: CONFIG.platform,
        general: { revision, value: structuredClone(value) },
        runtime: {
          currentShortcut: value.hotkey,
          launchAtLogin: false,
          launchAtLoginAvailable: true,
          opacity: value.opacity,
          theme: value.theme,
          themeApplied: true,
          opacityApplied: true
        },
        capabilities: { editableGeneralFields: [...EDITABLE_GENERAL_FIELDS] },
        action: { code: 'main', type: 'text', payload: '' }
      }
    }
    if (operation !== 'patchGeneral') throw new Error(`Unexpected operation ${operation}`)
    if (patchFailure !== null) {
      const failure = patchFailure
      patchFailure = null
      throw failure
    }
    const changes = payload.changes as Partial<SettingsGeneralProjection>
    revisionNumber += 1
    revision = `rev-${revisionNumber}`
    value = { ...value, ...changes }
    return { revision, value: structuredClone(value), notificationDelivered }
  }
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: vi.fn() })
  bridge.attach(target)
  const internal = (target.ztools as SettingsZToolsApi).internal
  return {
    bridge, calls, internal,
    api: internal as unknown as SettingsZToolsApi['internal'] & WindowClipboardApi,
    failNextPatch(error: unknown) { patchFailure = error }
  }
}

describe('ztools settings child window strategy and clipboard retention bridge', () => {
  it('accepts fresh no-op saves and confirms matching General preferences without a fake patch receipt', async () => {
    const { bridge, calls, internal, api } = createBridge()
    await internal.dbPut('settings-general', { ...GENERAL })

    const outcomes = await Promise.allSettled([
      api.updateWindowPositionStrategy('remember'),
      api.updateClipboardConfig({ retentionDays: 7 })
    ])

    expect(outcomes.map(({ status }) => status)).toEqual(['fulfilled', 'fulfilled'])
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('does not let a thrown Native mutation become a clean-baseline no-op confirmation', async () => {
    const { bridge, calls, internal, api, failNextPatch } = createBridge()
    failNextPatch(new Error('unconfirmed Native mutation'))
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      windowPositionStrategy: 'cursor'
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_NATIVE' })

    await internal.dbPut('settings-general', { ...GENERAL })
    const outcomes = await Promise.allSettled([
      api.updateWindowPositionStrategy('remember'),
      api.updateClipboardConfig({ retentionDays: 7 })
    ])

    expect(outcomes.map(({ status }) => status)).toEqual(['rejected', 'rejected'])
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('does not reuse an earlier delivered receipt after a later Native mutation is unconfirmed', async () => {
    const { bridge, calls, internal, api, failNextPatch } = createBridge()
    await internal.dbPut('settings-general', { ...GENERAL, windowPositionStrategy: 'cursor' })
    failNextPatch(new Error('unconfirmed follow-up mutation'))
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      windowPositionStrategy: 'lastActive'
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_NATIVE' })

    await internal.dbPut('settings-general', { ...GENERAL, windowPositionStrategy: 'cursor' })
    await expect(api.updateWindowPositionStrategy('cursor')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    bridge.dispose()
  })

  it('keeps generic preference methods separate from special-purpose editors', () => {
    const { bridge, internal } = createBridge()
    for (const name of [
      'updatePlaceholder', 'updateAutoClear', 'updateShowRecentInSearch', 'updateRecentRows',
      'updatePinnedRows', 'updateSearchMode', 'updateMatchRecommendation', 'updateTabKeyFunction',
      'updateTabTarget', 'updateSpaceOpenCommand', 'updateLocalAppSearch', 'updateAutoPaste',
      'updateWindowPositionStrategy',
      'updateClipboardConfig', 'updatePrimaryColor'
    ]) expect(Object.hasOwn(internal, name)).toBe(true)
    expect([
      'updateOpacity', 'updateTheme', 'updateCustomColor', 'updateShowTrayIcon',
      'updateHotkey', 'updateClipboardRetentionDays'
    ].filter(name => Object.hasOwn(internal, name))).toEqual([])
    bridge.dispose()
  })

  it('persists both original General save intents once and acknowledges without another Native patch', async () => {
    const { bridge, calls, internal, api } = createBridge()
    const requested = {
      ...GENERAL,
      windowPositionStrategy: 'lastActive',
      clipboardRetentionDays: 180
    }

    await internal.dbPut('settings-general', requested)
    await api.updateWindowPositionStrategy('lastActive')
    await api.updateClipboardConfig({ retentionDays: 180 })

    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
    expect(calls[1].payload).toEqual({
      revision: 'rev-1',
      changes: { windowPositionStrategy: 'lastActive', clipboardRetentionDays: 180 }
    })
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({
      windowPositionStrategy: 'lastActive',
      clipboardRetentionDays: 180
    })
    bridge.dispose()
  })

  it('confirms reset-to-180 as a retention preference without clearing clipboard history', async () => {
    const { bridge, calls, internal, api } = createBridge()
    await internal.dbPut('settings-general', { ...GENERAL, clipboardRetentionDays: 180 })
    await api.updateClipboardConfig({ retentionDays: 180 })

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    expect(calls[1].payload.changes).toEqual({ clipboardRetentionDays: 180 })
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ clipboardRetentionDays: 180 })
    bridge.dispose()
  })

  it('rejects nonexact, accessor, readonly, and out-of-range clipboard configurations before Native', async () => {
    const { bridge, calls, api } = createBridge()
    let getterCalled = false
    const accessor = Object.defineProperty({}, 'retentionDays', {
      enumerable: true,
      get() { getterCalled = true; return 30 }
    })
    const extraSymbol = Symbol('extra')
    const invalid: unknown[] = [
      null,
      {},
      { retentionDays: 30, clearHistory: true },
      { retentionDays: 0 },
      { retentionDays: 3651 },
      { retentionDays: 3.5 },
      { retentionDays: '30' },
      { retentionDays: 30, [extraSymbol]: false },
      accessor
    ]
    for (const value of invalid) {
      await expect(api.updateClipboardConfig(value)).rejects.toMatchObject({
        code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
      })
    }
    expect(getterCalled).toBe(false)
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('rejects invalid persisted preference values and readonly General changes before Native', async () => {
    const { bridge, calls, internal } = createBridge()
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      windowPositionStrategy: 'unrecognized' as unknown as SettingsGeneralProjection['windowPositionStrategy']
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      clipboardRetentionDays: 0
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_PROTOCOL' })
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      avatar: 'managed-fixture.png',
      windowPositionStrategy: 'cursor',
      clipboardRetentionDays: 180
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('does not acknowledge a failed patch, then allows an explicit retry through the same queue', async () => {
    const { bridge, calls, internal, api, failNextPatch } = createBridge()
    const requested = { ...GENERAL, windowPositionStrategy: 'cursor', clipboardRetentionDays: 180 }
    failNextPatch(new Error('native failure'))
    await expect(internal.dbPut('settings-general', requested)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_NATIVE'
    })
    await expect(api.updateClipboardConfig({ retentionDays: 180 })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    await internal.dbPut('settings-general', requested)
    await api.updateWindowPositionStrategy('cursor')
    await api.updateClipboardConfig({ retentionDays: 180 })

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({
      windowPositionStrategy: 'cursor', clipboardRetentionDays: 180
    })
    bridge.dispose()
  })

  it('does not confirm failed or stale saves, and keeps the existing CAS and dispose boundaries', async () => {
    const { bridge, calls, internal, api, failNextPatch } = createBridge()
    failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      windowPositionStrategy: 'cursor',
      clipboardRetentionDays: 180
    })).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(api.updateWindowPositionStrategy('cursor')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    await expect(api.updateClipboardConfig({ retentionDays: 180 })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
    await expect(api.updateClipboardConfig({ retentionDays: 7 })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED'
    })
  })

  it('keeps new preference writes behind the existing explicit-hotkey ownership rule', async () => {
    const { bridge, calls, internal } = createBridge()
    await expect(internal.dbPut('settings-general', {
      ...GENERAL,
      hotkey: 'Control+Space',
      windowPositionStrategy: 'cursor',
      clipboardRetentionDays: 180
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('does not report a saved preference as confirmed when Native notification delivery failed', async () => {
    const { bridge, calls, internal, api } = createBridge(false)
    await internal.dbPut('settings-general', { ...GENERAL, windowPositionStrategy: 'cursor' })
    await expect(api.updateWindowPositionStrategy('cursor')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    await internal.dbPut('settings-general', { ...GENERAL, windowPositionStrategy: 'cursor' })
    await expect(api.updateWindowPositionStrategy('cursor')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })
})
