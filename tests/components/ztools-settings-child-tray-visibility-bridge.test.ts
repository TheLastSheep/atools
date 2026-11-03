import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
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

const EDITABLE_FIELDS: SettingsReadyReply['capabilities']['editableGeneralFields'] = [
  'placeholder', 'theme', 'primaryColor', 'customColor', 'autoClear', 'showRecentInSearch',
  'recentRows', 'pinnedRows', 'searchMode', 'showMatchRecommendation', 'tabKeyFunction',
  'tabTargetCommand', 'spaceOpenCommand', 'localAppSearch', 'opacity', 'showTrayIcon', 'hotkey',
  'windowPositionStrategy', 'clipboardRetentionDays', 'autoBackToSearch', 'autoPaste', 'builtinAppShortcutsEnabled', 'windowDefaultHeight', 'autoCheckUpdate'
]

const INITIAL_GENERAL: SettingsGeneralProjection = {
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

function createBridge(notificationDelivered = true, nativeFields = EDITABLE_FIELDS) {
  const calls: NativeCall[] = []
  const errors: string[] = []
  let revision = 'rev-1'
  let revisionNumber = 1
  let value = structuredClone(INITIAL_GENERAL)
  let patchFailure: unknown = null
  let patchReply: unknown = null
  let heldPatch: { started: () => void; startedPromise: Promise<void>; release: () => void } | null = null
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'ready') return makeReady(revision, value, nativeFields)
    if (operation !== 'patchGeneral') throw new Error(`Unexpected native operation: ${operation}`)
    if (heldPatch) {
      const pending = heldPatch
      heldPatch = null
      pending.started()
      await pending.startedPromise
    }
    if (patchFailure !== null) {
      const failure = patchFailure
      patchFailure = null
      throw failure
    }
    const changes = payload.changes as Partial<SettingsGeneralProjection>
    revisionNumber += 1
    revision = `rev-${revisionNumber}`
    value = { ...value, ...changes }
    if (patchReply !== null) {
      const reply = patchReply
      patchReply = null
      return reply
    }
    return { revision, value: structuredClone(value), notificationDelivered }
  }
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: CONFIG, invoke, reportError: (message) => errors.push(message) })
  bridge.attach(target)
  return {
    bridge,
    calls,
    errors,
    internal: (target.ztools as SettingsZToolsApi).internal,
    failNextPatch(error: unknown) { patchFailure = error },
    returnNextPatch(reply: unknown) { patchReply = reply },
    holdNextPatch() {
      let started!: () => void
      let release!: () => void
      const startedPromise = new Promise<void>((resolve) => { started = resolve })
      const releasePromise = new Promise<void>((resolve) => { release = resolve })
      heldPatch = { started, startedPromise: releasePromise, release }
      return { started: startedPromise, release }
    }
  }
}

function makeReady(
  revision: string,
  value: SettingsGeneralProjection,
  nativeFields: SettingsReadyReply['capabilities']['editableGeneralFields']
): SettingsReadyReply {
  return {
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
    capabilities: { editableGeneralFields: [...nativeFields] },
    action: { code: 'main', type: 'text', payload: '' }
  }
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
    throw new Error('Core renderer General capability declaration has an invalid appended field suffix')
  }
  return fields
}

describe('ztools settings child tray visibility bridge', () => {
  it('uses the actual appended Rust capability and patches tray visibility once before commit confirmation', async () => {
    const nativeFields = readNativeEditableFields()
    expect(nativeFields).toEqual([...EDITABLE_FIELDS])
    const { bridge, calls, internal } = createBridge(true, nativeFields as typeof EDITABLE_FIELDS)

    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await expect(internal.setTrayIconVisible(false)).resolves.toBeUndefined()

    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
    expect(calls[1].payload).toEqual({ revision: 'rev-1', changes: { showTrayIcon: false } })
    bridge.dispose()
  })

  it('confirms a committed tray patch when the single notification was not delivered', async () => {
    const { bridge, calls, internal } = createBridge(false)
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await expect(internal.setTrayIconVisible(false)).resolves.toBeUndefined()
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('preserves opacity runtime confirmation when tray visibility shares the General patch', async () => {
    const { bridge, calls, internal } = createBridge()
    await internal.dbPut('settings-general', {
      ...INITIAL_GENERAL,
      opacity: 0.65,
      showTrayIcon: false
    })
    await expect(internal.setTrayIconVisible(false)).resolves.toBeUndefined()
    await expect(internal.setWindowOpacity(0.65)).resolves.toBeUndefined()

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    expect(calls[1].payload).toEqual({
      revision: 'rev-1',
      changes: { opacity: 0.65, showTrayIcon: false }
    })
    bridge.dispose()
  })

  it('rejects direct, unmatched, and failed-save follow-up confirmation without reusing an old tray receipt', async () => {
    const { bridge, calls, internal, failNextPatch } = createBridge()
    await expect((internal as unknown as { updateShowTrayIcon: (value: boolean) => Promise<void> })
      .updateShowTrayIcon(false)).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    await expect(internal.setTrayIconVisible(true)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    await expect(internal.setTrayIconVisible(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    await expect(internal.setTrayIconVisible('false' as unknown as boolean)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })

    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await expect(internal.setTrayIconVisible(false)).resolves.toBeUndefined()
    failNextPatch({ code: 'ERR_ATOOLS_SETTINGS_NATIVE', message: 'private detail' })
    await expect(internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: true })).rejects.toBeDefined()
    // Original General catches the save error, then invokes this confirmation anyway.
    await expect(internal.setTrayIconVisible(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    expect(calls.some(({ operation }) => operation === 'setTrayIconVisible')).toBe(false)
    bridge.dispose()
  })

  it('does not confirm a tray write whose commit result is malformed or unknown', async () => {
    const { bridge, calls, internal, returnNextPatch } = createBridge()
    returnNextPatch({ revision: 'rev-1', value: { ...INITIAL_GENERAL, showTrayIcon: false }, notificationDelivered: true })
    await expect(internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    await expect(internal.setTrayIconVisible(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('rejects a concurrent early confirmation and accepts only after the queued patch commits', async () => {
    const { bridge, calls, internal, holdNextPatch } = createBridge()
    const gate = holdNextPatch()
    const save = internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await gate.started
    await expect(internal.setTrayIconVisible(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    gate.release()
    await save
    await expect(internal.setTrayIconVisible(false)).resolves.toBeUndefined()
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('sticks after an unknown native recovery and allows a fresh bridge without leaking native detail', async () => {
    const { bridge, calls, internal, errors, holdNextPatch, failNextPatch } = createBridge()
    const gate = holdNextPatch()
    const trayWrite = internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await gate.started
    const queuedWrite = internal.dbPut('settings-general', {
      ...INITIAL_GENERAL,
      placeholder: 'Must not be submitted'
    })
    failNextPatch({ code: 'SETTINGS_NATIVE_RECOVERY_FAILED', message: 'private tray rollback detail' })
    gate.release()

    const outcomes = await Promise.allSettled([trayWrite, queuedWrite])
    expect(outcomes[0]).toMatchObject({ status: 'rejected', reason: {
      code: 'SETTINGS_NATIVE_RECOVERY_FAILED',
      message: '原生设置恢复失败，请重启应用后确认。'
    } })
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: {
      code: 'SETTINGS_NATIVE_RECOVERY_FAILED'
    } })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    expect(JSON.stringify(errors)).not.toContain('private tray rollback detail')
    await expect(internal.setTrayIconVisible(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    bridge.dispose()

    const fresh = createBridge()
    await fresh.internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await expect(fresh.internal.setTrayIconVisible(false)).resolves.toBeUndefined()
    expect(fresh.calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    fresh.bridge.dispose()
  })

  it('does not let a close race confirm an in-flight tray write', async () => {
    const { bridge, calls, internal, holdNextPatch } = createBridge()
    const gate = holdNextPatch()
    const save = internal.dbPut('settings-general', { ...INITIAL_GENERAL, showTrayIcon: false })
    await gate.started
    bridge.dispose()
    await expect(save).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED' })
    gate.release()
    await expect(internal.setTrayIconVisible(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
  })
})
