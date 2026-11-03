import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createSettingsChildBridge } from '../../packages/ztools-settings/src/childBridge'
import type { SettingsZToolsApi } from '../../packages/ztools-settings/src/childBridgeApi'
import {
  HostUnsupportedError,
  normalizeGeneralInput,
  SettingsBridgeProtocolError
} from '../../packages/ztools-settings/src/childBridgeProtocol'
import type {
  SettingsBridgeTarget,
  SettingsGeneralProjection,
  SettingsNativeInvoke,
  SettingsPlatform,
  SettingsReadyReply,
  SettingsViewConfig
} from '../../packages/ztools-settings/src/childBridgeTypes'

const CONFIG = {
  version: 1 as const,
  sessionId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  bundleRevision: 'b'.repeat(64),
  platform: 'darwin' as const
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

function createBridge(
  notificationDelivered = true,
  runtimeOpacityApplied = true,
  platform: SettingsPlatform = CONFIG.platform,
  runtimeOpacity = INITIAL_GENERAL.opacity,
  initialGeneral: SettingsGeneralProjection = INITIAL_GENERAL,
  editableFields: SettingsReadyReply['capabilities']['editableGeneralFields'] = EDITABLE_FIELDS
) {
  const calls: NativeCall[] = []
  let revision = 'rev-1'
  let revisionNumber = 1
  let value = structuredClone(initialGeneral)
  let patchFailure: unknown = null
  let heldPatch: { started: () => void; startedPromise: Promise<void>; release: () => void } | null = null
  const bridgeConfig = { ...CONFIG, platform }
  const invoke: SettingsNativeInvoke = async (operation, payload) => {
    calls.push({ operation, payload })
    if (operation === 'ready') return makeReady(
      revision, value, bridgeConfig, runtimeOpacityApplied, runtimeOpacity, editableFields
    )
    if (operation === 'patchGeneral') {
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
      return { revision, value, notificationDelivered }
    }
    throw new Error(`Unexpected operation ${operation}`)
  }
  const target = new EventTarget() as SettingsBridgeTarget
  const bridge = createSettingsChildBridge({ config: bridgeConfig, invoke, reportError: vi.fn() })
  bridge.attach(target)
  return {
    bridge,
    calls,
    internal: (target.ztools as SettingsZToolsApi).internal,
    failNextPatch(error: unknown) { patchFailure = error },
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
  config: SettingsViewConfig = CONFIG,
  opacityApplied = true,
  runtimeOpacity = value.opacity,
  editableFields: SettingsReadyReply['capabilities']['editableGeneralFields'] = EDITABLE_FIELDS
): SettingsReadyReply {
  return {
    version: 1,
    sessionId: CONFIG.sessionId,
    bundleRevision: CONFIG.bundleRevision,
    platform: config.platform,
    general: { revision, value: structuredClone(value) },
    runtime: {
      currentShortcut: 'Alt+Space',
      launchAtLogin: false,
      launchAtLoginAvailable: true,
      opacity: runtimeOpacity,
      theme: 'system',
      themeApplied: true,
      opacityApplied
    },
    capabilities: { editableGeneralFields: [...editableFields] },
    action: { code: 'main', type: 'text', payload: '' }
  }
}

describe('ztools settings child General settings bridge', () => {
  it('accepts the actual Rust capability order through ready and supports opacity writes', async () => {
    const nativeFields = readNativeEditableFields()
    const { bridge, calls, internal } = createBridge(
      true,
      true,
      'darwin',
      INITIAL_GENERAL.opacity,
      INITIAL_GENERAL,
      nativeFields as SettingsReadyReply['capabilities']['editableGeneralFields']
    )

    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ theme: 'system' })
    await internal.setWindowOpacity(0.65)

    expect(nativeFields).toEqual([...EDITABLE_FIELDS])
    expect(calls[1].payload).toEqual({ revision: 'rev-1', changes: { opacity: 0.65 } })
    bridge.dispose()
  })

  it('saves localAppSearch through the full projection and confirms the existing notification once', async () => {
    const { bridge, calls, internal } = createBridge()
    const requested = { ...INITIAL_GENERAL, localAppSearch: false }

    await internal.dbPut('settings-general', requested)
    await expect(internal.updateLocalAppSearch(false)).resolves.toBeUndefined()

    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
    expect(calls[1].payload).toEqual({
      revision: 'rev-1',
      changes: { localAppSearch: false }
    })
    bridge.dispose()
  })

  it('persists autoBackToSearch through dbPut and confirms its same-value notification without another patch', async () => {
    const nativeFields = readNativeEditableFields()
    const { bridge, calls, internal } = createBridge(
      true,
      true,
      'darwin',
      INITIAL_GENERAL.opacity,
      INITIAL_GENERAL,
      nativeFields as SettingsReadyReply['capabilities']['editableGeneralFields']
    )

    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, autoBackToSearch: 'never' })
    await expect((internal as unknown as { updateAutoBackToSearch: (value: string) => Promise<void> })
      .updateAutoBackToSearch('never')).resolves.toBeUndefined()
    expect(calls.map(({ operation }) => operation)).toEqual(['ready'])

    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, autoBackToSearch: '3m' })
    await expect((internal as unknown as { updateAutoBackToSearch: (value: string) => Promise<void> })
      .updateAutoBackToSearch('3m')).resolves.toBeUndefined()
    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
    expect(calls[1].payload).toEqual({ revision: 'rev-1', changes: { autoBackToSearch: '3m' } })
    bridge.dispose()
  })

  it('keeps General undefined, unknown-key, and optional-avatar validation semantics', () => {
    expect(() => normalizeGeneralInput({ ...INITIAL_GENERAL, placeholder: undefined }))
      .toThrow(SettingsBridgeProtocolError)
    expect(() => normalizeGeneralInput({ ...INITIAL_GENERAL, unexpected: undefined }))
      .toThrow(HostUnsupportedError)
    expect(normalizeGeneralInput({ ...INITIAL_GENERAL, avatar: undefined }).avatar).toBeNull()
    expect(() => normalizeGeneralInput({ ...INITIAL_GENERAL, autoBackToSearch: '2d' }))
      .toThrow(SettingsBridgeProtocolError)
  })

  it('rejects receipt confirmation if dispose wins the awaiting microtask', async () => {
    const { bridge, calls, internal } = createBridge()
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, localAppSearch: false })
    await internal.updateLocalAppSearch(false)

    const confirmation = internal.updateLocalAppSearch(false)
    bridge.dispose()
    await expect(confirmation).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED'
    })
    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
  })

  it('rejects invalid and mismatched update values without native writes', async () => {
    const { bridge, calls, internal } = createBridge()
    await expect(internal.updateLocalAppSearch(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    await expect(internal.updateLocalAppSearch('false' as unknown as boolean)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, localAppSearch: false })
    await expect(internal.updateLocalAppSearch(true)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('rejects a saved value whose native notification was not delivered', async () => {
    const { bridge, calls, internal } = createBridge(false)
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, localAppSearch: false })
    await expect(internal.updateLocalAppSearch(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('does not reuse an old receipt after a CAS conflict', async () => {
    const { bridge, calls, internal, failNextPatch } = createBridge()
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, localAppSearch: false })
    await expect(internal.updateLocalAppSearch(false)).resolves.toBeUndefined()
    failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(internal.dbPut('settings-general', {
      ...INITIAL_GENERAL,
      localAppSearch: false,
      placeholder: 'Changed'
    })).rejects.toMatchObject({ code: 'SETTINGS_REVISION_CONFLICT' })
    await expect(internal.updateLocalAppSearch(false)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    bridge.dispose()
  })

  it('rejects readonly full-projection changes and calls after dispose', async () => {
    const { bridge, calls, internal } = createBridge()
    await expect(internal.dbPut('settings-general', {
      ...INITIAL_GENERAL,
      avatar: 'managed-fixture.png'
    })).rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
    await expect(internal.updateAutoPaste('1s')).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED'
    })
    await expect(internal.updateLocalAppSearch(true)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
  })

  it('persists opacity through one General patch and treats the original follow-up save as a no-op', async () => {
    const { bridge, calls, internal } = createBridge()

    await internal.setWindowOpacity(0.65)
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, opacity: 0.65 })
    await expect((internal as unknown as { updateOpacity: () => Promise<void> }).updateOpacity())
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })

    expect(calls.map(({ operation }) => operation)).toEqual(['ready', 'patchGeneral'])
    expect(calls[1].payload).toEqual({ revision: 'rev-1', changes: { opacity: 0.65 } })
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ opacity: 0.65 })
    bridge.dispose()
  })

  it('rejects opacity before writing when the runtime is unsupported', async () => {
    const { bridge, calls, internal } = createBridge(true, true, 'linux')
    await expect(internal.setWindowOpacity(0.65)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED'
    })
    expect(calls.map(({ operation }) => operation)).toEqual(['ready'])
    bridge.dispose()
  })

  it('rejects opacity before writing when the native window did not confirm opacity support', async () => {
    const { bridge, calls, internal } = createBridge(true, false)
    await expect(internal.setWindowOpacity(0.65)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED'
    })
    expect(calls.map(({ operation }) => operation)).toEqual(['ready'])
    bridge.dispose()
  })

  it('rejects opacity outside the native user-write range without a write', async () => {
    const { bridge, calls, internal } = createBridge()
    await expect(internal.setWindowOpacity(0.2)).rejects.toMatchObject({
      code: 'ERR_ATOOLS_SETTINGS_PROTOCOL'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('accepts the native opacity readback tolerance for an unchanged General value', async () => {
    const { bridge, calls, internal } = createBridge(
      true,
      true,
      'darwin',
      0.648,
      { ...INITIAL_GENERAL, opacity: 0.65 }
    )
    await expect(internal.setWindowOpacity(0.65)).resolves.toBeUndefined()
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('updates runtime opacity when a full General save changes the editable field', async () => {
    const { bridge, calls, internal } = createBridge()
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, opacity: 0.65 })
    await internal.setWindowOpacity(0.65)
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    expect(calls[1].payload.changes).toEqual({ opacity: 0.65 })
    bridge.dispose()
  })

  it('rejects a full General opacity write before Native when opacity support is unavailable', async () => {
    const { bridge, calls, internal } = createBridge(true, false)
    await expect(internal.dbPut('settings-general', { ...INITIAL_GENERAL, opacity: 0.65 }))
      .rejects.toMatchObject({ code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED' })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(0)
    bridge.dispose()
  })

  it('keeps a committed opacity when notification delivery is false without retrying', async () => {
    const { bridge, calls, internal } = createBridge(false)

    await expect(internal.setWindowOpacity(0.65)).resolves.toBeUndefined()
    await internal.dbPut('settings-general', { ...INITIAL_GENERAL, opacity: 0.65 })
    await internal.setWindowOpacity(0.65)

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ opacity: 0.65 })
    bridge.dispose()
  })

  it('does not update opacity projection after a failed patch and allows an explicit retry', async () => {
    const { bridge, calls, internal, failNextPatch } = createBridge()
    failNextPatch(new Error('temporary failure'))

    await expect(internal.setWindowOpacity(0.65)).rejects.toBeDefined()
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ opacity: 0.8 })
    await internal.setWindowOpacity(0.65)

    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(2)
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ opacity: 0.65 })
    bridge.dispose()
  })

  it('does not cache opacity after a revision conflict and requires the existing reopen boundary', async () => {
    const { bridge, calls, internal, failNextPatch } = createBridge()
    failNextPatch({ code: 'SETTINGS_REVISION_CONFLICT' })

    await expect(internal.setWindowOpacity(0.65)).rejects.toMatchObject({
      code: 'SETTINGS_REVISION_CONFLICT'
    })
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({ opacity: 0.8 })
    await expect(internal.setWindowOpacity(0.65)).rejects.toMatchObject({
      code: 'SETTINGS_REVISION_CONFLICT'
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    bridge.dispose()
  })

  it('sticks after an opacity recovery failure, blocks queued writes, and permits a fresh bridge', async () => {
    const { bridge, calls, internal, failNextPatch, holdNextPatch } = createBridge()
    const patchGate = holdNextPatch()
    const opacityWrite = internal.setWindowOpacity(0.65)
    await patchGate.started
    failNextPatch({ code: 'SETTINGS_OPACITY_RECOVERY_FAILED', message: 'private native detail' })
    const queuedGeneralWrite = internal.dbPut('settings-general', {
      ...INITIAL_GENERAL,
      placeholder: 'Must not be submitted'
    })
    patchGate.release()

    const outcomes = await Promise.allSettled([opacityWrite, queuedGeneralWrite])
    expect(outcomes[0]).toMatchObject({
      status: 'rejected',
      reason: {
        code: 'SETTINGS_OPACITY_RECOVERY_FAILED',
        message: '窗口透明度恢复失败，请重新打开设置确认。'
      }
    })
    expect(outcomes[1]).toMatchObject({
      status: 'rejected',
      reason: { code: 'SETTINGS_OPACITY_RECOVERY_FAILED' }
    })
    expect(calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({
      opacity: 0.8,
      placeholder: INITIAL_GENERAL.placeholder
    })
    bridge.dispose()

    const fresh = createBridge()
    await expect(fresh.internal.setWindowOpacity(0.65)).resolves.toBeUndefined()
    expect(fresh.calls.filter(({ operation }) => operation === 'patchGeneral')).toHaveLength(1)
    await expect(fresh.internal.dbGet('settings-general')).resolves.toMatchObject({ opacity: 0.65 })
    fresh.bridge.dispose()
  })

  it('merges queued opacity intent with the latest General projection at dequeue time', async () => {
    const { bridge, calls, internal, holdNextPatch } = createBridge()
    const patchGate = holdNextPatch()
    const pendingGeneralWrite = internal.dbPut('settings-general', {
      ...INITIAL_GENERAL,
      placeholder: 'Queued placeholder'
    })
    await patchGate.started
    const pendingOpacityWrite = internal.setWindowOpacity(0.65)
    patchGate.release()

    await Promise.all([pendingGeneralWrite, pendingOpacityWrite])

    const patches = calls.filter(({ operation }) => operation === 'patchGeneral')
    expect(patches).toHaveLength(2)
    expect(patches[0].payload.changes).toEqual({ placeholder: 'Queued placeholder' })
    expect(patches[1].payload.changes).toEqual({ opacity: 0.65 })
    await expect(internal.dbGet('settings-general')).resolves.toMatchObject({
      placeholder: 'Queued placeholder',
      opacity: 0.65
    })
    bridge.dispose()
  })
})

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
