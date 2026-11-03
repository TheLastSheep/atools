import { routeSettingsRecording } from './childBridgeRecordingRouter'
import { createSettingsAppShortcutRecordingController } from './childBridgeAppShortcutRecording'
import { createAppGlobalShortcutsController } from './appGlobalShortcutsController'
import { createSettingsAboutUpdate } from './childBridgeAboutUpdate'
import type {
  SettingsBridgeTarget,
  SettingsChildBridgeOptions,
  SettingsNativeInvoke,
  SettingsReadyReply,
  SettingsTheme,
  SettingsViewAction
} from './childBridgeTypes'
import { createSettingsChildInternalFacade } from './childBridgeInternalFacade'
import {
  HostUnsupportedError,
  MAX_EVENT_CALLBACKS,
  MAX_OPERATION_PAYLOAD_BYTES,
  MAX_READONLY_STRING_BYTES,
  SETTINGS_HOST_FAILURE_MESSAGE,
  SETTINGS_UNSUPPORTED_MESSAGE,
  SettingsBridgeDisposedError,
  SettingsBridgeError,
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  boundedUtf8String,
  cloneJson,
  isExactRecord,
  isAutoPasteOption,
  validateReadyReply,
  validateSettingsViewConfig,
  validateTheme
} from './childBridgeProtocol'
import { normalizeSettingsNativeFailure } from './childBridgeNativeErrors'
import { createSettingsChildLaunchAtLoginBridge } from './childBridgeLaunchAtLogin'
import { createSettingsChildGeneralBridge } from './childBridgeGeneral'
import { createSettingsChildCommandDataBridge } from './childBridgeCommandData'
import {
  createSettingsChildCommandSettingsBridge,
  MAX_DISABLED_COMMANDS_WRITE_PAYLOAD_BYTES
} from './childBridgeCommandSettings'
import { createSettingsChildSearchPinsBridge } from './childBridgeSearchPins'
import { createSettingsChildAliasesBridge } from './childBridgeAliases'
import { createSettingsChildInputBridge } from './childBridgeInput'
import { createSettingsChildLocalShortcutsBridge } from './childBridgeLocalShortcuts'
import { createSettingsHotkeyRecordingController } from './childBridgeHotkeyRecording'
import { createSettingsChildLocalDropController } from './childBridgeLocalDrop'
import { createLaunchAtLoginControllerForHost } from './launchAtLoginController'
import {
  createSettingsZToolsApi,
  type SettingsEventCallback as EventCallback,
  type SettingsZToolsApi
} from './childBridgeApi'

export interface SettingsChildBridge {
  attach(target: SettingsBridgeTarget): void
  dispose(): void
}

const CLOSE_REASONS = new Set(['child-out', 'escape'])
const THEME_ACK_MESSAGE = '主题未确认，请重试。'
const OPACITY_ACK_MESSAGE = '透明度未确认，请重试。'
const TRAY_ACK_MESSAGE = '托盘图标状态未确认，请重试。'
const WRITE_ACK_MESSAGE = '设置未获宿主确认，请重新保存。'

export function createSettingsChildBridge(options: SettingsChildBridgeOptions): SettingsChildBridge {
  if (options.defaultAvatar !== undefined &&
    !boundedUtf8String(options.defaultAvatar, MAX_READONLY_STRING_BYTES)) throw new SettingsBridgeProtocolError()
  const config = validateSettingsViewConfig(options.config)
  const invoke = options.invoke
  const scheduleMicrotask = options.scheduleMicrotask ?? ((callback) => queueMicrotask(callback))
  const enterCallbacks = new Set<EventCallback<SettingsViewAction>>()
  const enteredCallbacks = new Set<EventCallback<SettingsViewAction>>()
  const outCallbacks = new Set<EventCallback<void>>()
  const pendingInvocations = new Set<(error: unknown) => void>()
  let target: SettingsBridgeTarget | null = null
  let api: SettingsZToolsApi | null = null
  let previousZtools: unknown
  let previousUtools: unknown
  let previousDeliverOut: SettingsBridgeTarget['__ATOOLS_SETTINGS_DELIVER_OUT__']
  let previousLaunchAtLoginController: SettingsBridgeTarget['__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__']
  let readyPromise: Promise<SettingsReadyReply> | null = null
  let readySnapshot: SettingsReadyReply | null = null
  let readyAction: SettingsViewAction | null = null
  let outDelivered = false
  let disposed = false
  let confirmedTheme: SettingsTheme | null = null

  const handleKeydown: EventListener = (rawEvent) => {
    const event = rawEvent as KeyboardEvent
    if (event.key !== 'Escape' || event.isComposing || event.defaultPrevented) return
    void requestClose('escape').catch(() => {})
  }
  const handlePagehide: EventListener = () => dispose()

  function isLive(): boolean {
    if (disposed || !target) return false
    const injected = target.__ATOOLS_SETTINGS_VIEW_CONFIG__
    if (injected === undefined) return true
    try {
      const current = validateSettingsViewConfig(injected)
      const matches = current.sessionId === config.sessionId &&
        current.bundleRevision === config.bundleRevision && current.platform === config.platform
      if (!matches) dispose()
      return matches
    } catch {
      dispose()
      return false
    }
  }

  function requireLive(): void {
    if (!isLive()) throw new SettingsBridgeDisposedError()
  }

  function report(message: string): void {
    if (!isLive()) return
    try {
      options.reportError(message)
    } catch {}
  }

  function invokeNative(operation: Parameters<SettingsNativeInvoke>[0], payload: Record<string, unknown>): Promise<unknown> {
    requireLive()
    const maxPayloadBytes = operation === 'writeDisabledCommands'
      ? MAX_DISABLED_COMMANDS_WRITE_PAYLOAD_BYTES
      : MAX_OPERATION_PAYLOAD_BYTES
    assertJsonByteBudget(payload, maxPayloadBytes)
    const safePayload = cloneJson(payload) as Record<string, unknown>
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (callback: (value: any) => void, value: unknown) => {
        if (settled) return
        settled = true
        pendingInvocations.delete(cancel)
        callback(value)
      }
      const cancel = (error: unknown) => finish(reject, error)
      pendingInvocations.add(cancel)
      let result: Promise<unknown>
      try {
        result = Promise.resolve(invoke(operation, safePayload, config.sessionId))
      } catch (error) {
        result = Promise.reject(error)
      }
      result.then((value) => {
        if (!isLive()) {
          finish(reject, new SettingsBridgeDisposedError())
          return
        }
        finish(resolve, value)
      }, (error) => {
        finish(reject, normalizeSettingsNativeFailure(error, operation))
      })
    })
  }

  function dispatchEnter(): void {
    if (!readyAction || !isLive()) return
    const action = cloneJson(readyAction)
    for (const callback of enterCallbacks) {
      if (enteredCallbacks.has(callback)) continue
      enteredCallbacks.add(callback)
      try {
        callback(cloneJson(action))
      } catch {}
    }
  }

  function dispatchOut(): void {
    if (outDelivered) return
    outDelivered = true
    for (const callback of outCallbacks) {
      try {
        callback()
      } catch {}
    }
  }

  function ensureReady(): Promise<SettingsReadyReply> {
    requireLive()
    if (readySnapshot) return Promise.resolve(readySnapshot)
    if (readyPromise) return readyPromise
    readyPromise = invokeNative('ready', {}).then((raw) => {
      const ready = validateReadyReply(raw, config, options.defaultAvatar)
      if (!isLive()) throw new SettingsBridgeDisposedError()
      readySnapshot = ready
      readyAction = cloneJson(ready.action)
      confirmedTheme = ready.runtime.themeApplied ? ready.runtime.theme : null
      dispatchEnter()
      return ready
    }).catch((error) => {
      const normalized = normalizeSettingsNativeFailure(error, 'ready')
      report(SETTINGS_HOST_FAILURE_MESSAGE)
      readyPromise = null
      throw normalized
    })
    return readyPromise
  }

  function unsupported(notify = true): never {
    const error = new HostUnsupportedError()
    if (notify) report(SETTINGS_UNSUPPORTED_MESSAGE)
    throw error
  }

  function unsupportedAsync(): Promise<never> {
    try {
      unsupported(true)
    } catch (error) {
      return Promise.reject(error)
    }
  }

  const generalBridge = createSettingsChildGeneralBridge({
    getReady: ensureReady,
    defaultAvatar: options.defaultAvatar,
    invokeAutoCheck: (revision, enabled) => invokeNative('setAutoCheckUpdate', { revision, enabled }),
    invokePatch: (revision, changes) => invokeNative('patchGeneral', { revision, changes }),
    isLive,
    reportError: report,
    rejectUnsupported: unsupported
  })
  const launchAtLogin = createSettingsChildLaunchAtLoginBridge({
    getReady: ensureReady,
    invokeNative: (operation, payload) => invokeNative(operation, payload),
    runSerialized: generalBridge.runSerializedSettingsOperation,
    isLive,
    reportError: report,
    rejectUnsupported: unsupported
  })

  const commandDataBridge = createSettingsChildCommandDataBridge({ invokeNative, isLive })
  const commandSettingsBridge = createSettingsChildCommandSettingsBridge({ invokeNative, isLive, reportError: report })
  const searchPinsBridge = createSettingsChildSearchPinsBridge({
    invokeNative,
    isLive,
    invalidateReads: commandSettingsBridge.invalidateReads
  })
  const aliasesBridge = createSettingsChildAliasesBridge({
    invokeNative,
    isLive,
    getBaseToken: commandDataBridge.getAliasBaseToken,
    acceptBaseToken: commandDataBridge.acceptAliasBaseToken,
    clearBaseToken: commandDataBridge.clearAliasBaseToken
  })
  const inputBridge = createSettingsChildInputBridge({ config, invokeNative, isLive, reportError: report })
  const localShortcutsBridge = createSettingsChildLocalShortcutsBridge({
    invokeNative,
    isLive
  })
  const hotkeyRecording = createSettingsHotkeyRecordingController({ sessionId: config.sessionId, platform: config.platform, isLive, invokeNative })
  const appRecording = createSettingsAppShortcutRecordingController({ sessionId: config.sessionId, isLive, invokeNative, reportDraining: () => report('请释放按键以完成快捷键录制。') })
  const routedRecording = routeSettingsRecording(hotkeyRecording, appRecording, () => target?.location?.hash ?? '')
  const localDropBridge = createSettingsChildLocalDropController({
    sessionId: config.sessionId,
    isLive,
    getHash: () => target?.location?.hash ?? ''
  })

  function callbackSet<T>(set: Set<EventCallback<T>>, callback: unknown): void {
    if (typeof callback !== 'function') throw new SettingsBridgeProtocolError()
    const typed = callback as EventCallback<T>
    if (set.has(typed)) return
    if (set.size >= MAX_EVENT_CALLBACKS) throw new SettingsBridgeError(
      'ERR_ATOOLS_SETTINGS_CALLBACK_LIMIT',
      '监听数量已达上限。'
    )
    set.add(typed)
    if (set === enterCallbacks && readyAction) dispatchEnter()
  }

  async function requireWriteReceipt(
    message: string,
    matches: (ready: SettingsReadyReply) => boolean,
    hasReceipt: (ready: SettingsReadyReply) => boolean = (ready) =>
      generalBridge.hasConfirmedWrite(ready.general.revision)
  ): Promise<void> {
    const ready = await ensureReady()
    requireLive()
    if (matches(ready) && hasReceipt(ready)) return
    const error = new SettingsBridgeError('ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED', message)
    report(message)
    throw error
  }

  function updateGeneralPreference(field: SettingsReadyReply['capabilities']['editableGeneralFields'][number]) {
    return (value: unknown) => {
      if (field === 'localAppSearch' && typeof value !== 'boolean') {
        return Promise.reject(new SettingsBridgeProtocolError())
      }
      if (field === 'autoPaste' && !isAutoPasteOption(value)) {
        return Promise.reject(new SettingsBridgeProtocolError())
      }
      return requireWriteReceipt(WRITE_ACK_MESSAGE,
        (ready) => ready.general.value[field] === value)
    }
  }

  async function setRuntimeTheme(value: SettingsTheme, ready: SettingsReadyReply): Promise<void> {
    try {
      const raw = await invokeNative('setTheme', { theme: value })
      if (!isExactRecord(raw, ['theme', 'themeApplied']) ||
        raw.theme !== value || raw.themeApplied !== true) throw new SettingsBridgeProtocolError()
      confirmedTheme = value
      ready.runtime.theme = value
      ready.runtime.themeApplied = true
    } catch (error) {
      const normalized = normalizeSettingsNativeFailure(error, 'setTheme')
      report(THEME_ACK_MESSAGE)
      throw normalized
    }
  }

  async function updatePrimaryColor(primaryColor: unknown, customColor: unknown): Promise<void> {
    await requireWriteReceipt(
      WRITE_ACK_MESSAGE,
      (ready) => ready.general.value.primaryColor === primaryColor &&
        ready.general.value.customColor === customColor
    )
  }

  async function setTheme(value: unknown): Promise<void> {
    let requested: SettingsTheme
    try {
      requested = validateTheme(value)
    } catch {
      report(THEME_ACK_MESSAGE)
      throw new SettingsBridgeProtocolError()
    }
    const ready = await ensureReady()
    if (confirmedTheme === requested) return
    await setRuntimeTheme(requested, ready)
  }

  async function setWindowOpacity(value: unknown): Promise<void> {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.3 || value > 1) {
      report(OPACITY_ACK_MESSAGE)
      throw new SettingsBridgeProtocolError()
    }
    const ready = await ensureReady()
    if (config.platform !== 'darwin' || ready.runtime.opacityApplied !== true) return unsupported(true)
    await generalBridge.setOpacity(value)
  }

  async function setTrayIconVisible(value: unknown): Promise<void> {
    if (typeof value !== 'boolean') {
      report(TRAY_ACK_MESSAGE)
      throw new SettingsBridgeProtocolError()
    }
    await requireWriteReceipt(
      TRAY_ACK_MESSAGE,
      (ready) => ready.general.value.showTrayIcon === value,
      (ready) => generalBridge.hasConfirmedTrayWrite(ready.general.revision, value)
    )
  }

  async function requestClose(reason: 'child-out' | 'escape'): Promise<void> {
    if (!CLOSE_REASONS.has(reason)) throw new SettingsBridgeProtocolError()
    inputBridge.stop()
    void routedRecording.stop().catch(() => {})
    try {
      const raw = await invokeNative('close', { reason })
      if (!isExactRecord(raw, ['version', 'sessionId', 'closed']) ||
        raw.version !== 1 || raw.sessionId !== config.sessionId || raw.closed !== true) {
        throw new SettingsBridgeProtocolError()
      }
    } catch (error) {
      const normalized = normalizeSettingsNativeFailure(error, 'close')
      report(normalized.message)
      throw normalized
    }
  }

  function outPlugin(): Promise<void> {
    inputBridge.stop()
    dispatchOut()
    return requestClose('child-out')
  }

  async function deliverOut(): Promise<{ acknowledged: true }> {
    inputBridge.stop()
    void routedRecording.stop().catch(() => {})
    dispatchOut()
    try {
      const raw = await invokeNative('outAcknowledged', {})
      if (!isExactRecord(raw, ['acknowledged']) || raw.acknowledged !== true) {
        throw new SettingsBridgeProtocolError()
      }
      return { acknowledged: true }
    } catch (error) {
      const normalized = normalizeSettingsNativeFailure(error, 'outAcknowledged')
      throw normalized
    }
  }

  const aboutUpdate = createSettingsAboutUpdate({ invoke: invokeNative, isLive })
  const appGlobalShortcuts = createAppGlobalShortcutsController({ invoke: invokeNative,
    isLive: () => isLive() && /^#\/shortcuts(?:[?#]|$)/i.test(target?.location?.hash ?? '') })
  const invalidateAppShortcuts = () => { if (!/^#\/shortcuts(?:[?#]|$)/i.test(target?.location?.hash ?? '')) appGlobalShortcuts.invalidate() }

  function makeInternalApi() {
    return createSettingsChildInternalFacade({
      platform: config.platform,
      aboutUpdate, appGlobalShortcuts,
      commandData: commandDataBridge,
      commandSettings: commandSettingsBridge,
      general: generalBridge,
      aliases: aliasesBridge,
      searchPins: searchPinsBridge,
      localShortcuts: localShortcutsBridge,
      getCurrentShortcut: async () => (await ensureReady()).runtime.currentShortcut,
      getLaunchAtLogin: launchAtLogin.getLaunchAtLogin,
      setLaunchAtLogin: launchAtLogin.setLaunchAtLogin,
      inspectLegacyLaunchAtLogin: launchAtLogin.inspectLegacyLaunchAtLogin,
      resolveLegacyLaunchAtLogin: launchAtLogin.resolveLegacyLaunchAtLogin,
      updateGeneralPreference,
      setTheme,
      setWindowOpacity,
      setTrayIconVisible,
      updateShortcut: generalBridge.updateShortcut,
      hotkeyRecording: routedRecording,
      updatePrimaryColor,
      onNativeLocalDrop: (callback: unknown) => localDropBridge.subscribe(callback),
      outPlugin
    })
  }

  function makeApi(): SettingsZToolsApi {
    return createSettingsZToolsApi({
      platform: config.platform,
      onPluginEnter: (callback) => {
        callbackSet(enterCallbacks, callback)
        if (!readyAction) scheduleMicrotask(() => { void ensureReady().catch(() => {}) })
      },
      onPluginOut: (callback) => callbackSet(outCallbacks, callback),
      outPlugin,
      input: inputBridge,
      internal: makeInternalApi(),
      unsupported: unsupportedAsync
    })
  }
  function attach(nextTarget: SettingsBridgeTarget): void {
    if (disposed || target) throw new SettingsBridgeError(
      'ERR_ATOOLS_SETTINGS_BRIDGE_ATTACHED',
      '设置桥接已初始化。'
    )
    target = nextTarget
    previousZtools = nextTarget.ztools
    previousUtools = nextTarget.utools
    previousDeliverOut = nextTarget.__ATOOLS_SETTINGS_DELIVER_OUT__
    previousLaunchAtLoginController = nextTarget.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__
    inputBridge.attach(nextTarget)
    localDropBridge.attach(nextTarget)
    hotkeyRecording.attach(nextTarget)
    appRecording.attach(nextTarget)
    api = makeApi()
    nextTarget.ztools = api
    nextTarget.utools = api
    nextTarget.__ATOOLS_SETTINGS_DELIVER_OUT__ = deliverOut
    nextTarget.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__ = createLaunchAtLoginControllerForHost
    nextTarget.addEventListener('hashchange', invalidateAppShortcuts)
    nextTarget.addEventListener('keydown', handleKeydown)
    nextTarget.addEventListener('pagehide', handlePagehide, { once: true })
  }

  function dispose(): void {
    if (disposed) return
    appRecording.dispose()
    hotkeyRecording.dispose()
    disposed = true
    generalBridge.dispose()
    commandDataBridge.dispose()
    commandSettingsBridge.dispose()
    searchPinsBridge.dispose()
    localShortcutsBridge.dispose()
    aliasesBridge.dispose()
    inputBridge.dispose()
    localDropBridge.dispose()
    for (const cancel of [...pendingInvocations]) cancel(new SettingsBridgeDisposedError())
    pendingInvocations.clear()
    if (target) {
      target.removeEventListener('hashchange', invalidateAppShortcuts)
      target.removeEventListener('keydown', handleKeydown)
      target.removeEventListener('pagehide', handlePagehide)
      if (target.ztools === api) target.ztools = previousZtools
      if (target.utools === api) target.utools = previousUtools
      if (target.__ATOOLS_SETTINGS_DELIVER_OUT__ === deliverOut) {
        target.__ATOOLS_SETTINGS_DELIVER_OUT__ = previousDeliverOut
      }
      if (target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__ === createLaunchAtLoginControllerForHost) {
        target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__ = previousLaunchAtLoginController
      }
    }
    enterCallbacks.clear()
    enteredCallbacks.clear()
    outCallbacks.clear()
  }

  return { attach, dispose }
}
