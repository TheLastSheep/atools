import { parseAboutAutoReply, type AboutAutoCheckReply } from './childBridgeAboutUpdate'
import type {
  SettingsGeneralProjection,
  SettingsReadyReply,
  SettingsShortcutUpdateReply
} from './childBridgeTypes'
import {
  EDITABLE_GENERAL_FIELDS,
  HOTKEY_OUTCOME_UNKNOWN_CODE,
  HOTKEY_OUTCOME_UNKNOWN_MESSAGE,
  HostUnsupportedError,
  MAX_PLACEHOLDER_WRITE_BYTES,
  MAX_PENDING_GENERAL_WRITES,
  NATIVE_RECOVERY_FAILED_CODE,
  NATIVE_RECOVERY_FAILED_MESSAGE,
  OPACITY_RECOVERY_FAILED_CODE,
  OPACITY_RECOVERY_FAILED_MESSAGE,
  SettingsBridgeDisposedError,
  SettingsBridgeError,
  SettingsBridgeProtocolError,
  SETTINGS_REOPEN_MESSAGE,
  boundedUtf8String,
  cloneJson,
  isRecord,
  nativeErrorCode,
  normalizeGeneralInput,
  validatePatchReply
} from './childBridgeProtocol'
import { createSettingsChildSerialQueue } from './childBridgeSerialQueue'
import { knownHotkeyRejectionMessage } from './childBridgeNativeErrors'
import { parseBuiltinShortcutWrite, type SettingsBuiltinShortcutPatch } from './childBridgeBuiltinShortcuts'
import { assertDefaultHeight, createDefaultHeightReceipt } from './childBridgeDefaultHeight'

type GeneralWriteIntent =
  | { kind: 'projection'; value: SettingsGeneralProjection }
  | { kind: 'opacity'; value: number }
  | { kind: 'shortcut'; value: string }
  | { kind: 'height-confirm'; value: number }
  | { kind: 'builtin-shortcut'; patch: SettingsBuiltinShortcutPatch }
  | { kind: 'runtime-task'; run: () => Promise<unknown> }

interface GeneralWriteRequest {
  intent: GeneralWriteIntent
  hotkeyIntentGeneration: number
  resolve: (value?: unknown) => void
  reject: (error: unknown) => void
}

export interface SettingsChildGeneralBridge {
  dbGet(key: unknown): Promise<SettingsGeneralProjection>
  dbPut(key: unknown, value: unknown): Promise<void>
  setOpacity(value: number): Promise<void>
  setWindowDefaultHeight(value: unknown): Promise<void>
  runSerializedSettingsOperation<T>(run: () => Promise<T>): Promise<T>
  updateShortcut(value: unknown): Promise<SettingsShortcutUpdateReply>
  invalidateTrayConfirmation(value?: unknown): void
  hasConfirmedWrite(revision: string): boolean
  hasConfirmedTrayWrite(revision: string, value: boolean): boolean
  setAutoCheckUpdate(enabled: unknown): Promise<AboutAutoCheckReply>
  dispose(): void
}

export interface SettingsChildGeneralBridgeOptions {
  getReady: () => Promise<SettingsReadyReply>
  invokeAutoCheck?: (revision: string, enabled: boolean) => Promise<unknown>
  invokePatch: (revision: string, changes: Record<string, unknown>) => Promise<unknown>
  defaultAvatar?: string
  isLive: () => boolean
  reportError: (message: string) => void
  rejectUnsupported: (notify: boolean) => never
}

export function createSettingsChildGeneralBridge(
  options: SettingsChildGeneralBridgeOptions
): SettingsChildGeneralBridge {
  const writeQueue = createSettingsChildSerialQueue<GeneralWriteRequest>(options.isLive, processWrite)
  let pendingWriteCount = 0
  let revisionConflict = false
  let recoveryFailure: { code: string; message: string } | null = null
  let hotkeyOutcomeUnknown = false
  let hotkeyIntentGeneration = 0
  let initialHotkeyBaseline: string | null = null
  const hotkeyIntentHistory: Array<{ generation: number; value: string }> = []
  let nativeMutationAttempted = false
  let lastReceipt: { revision: string; notificationDelivered: boolean } | null = null
  let lastTrayReceipt: { revision: string; value: boolean } | null = null
  const heightReceipt = createDefaultHeightReceipt()

  async function dbGet(key: unknown): Promise<SettingsGeneralProjection> {
    if (key !== 'settings-general') return options.rejectUnsupported(false)
    return cloneJson((await options.getReady()).general.value)
  }

  async function dbPut(key: unknown, value: unknown): Promise<void> {
    if (key !== 'settings-general') return options.rejectUnsupported(true)
    if (isRecord(value) && Object.keys(value).length === 1 && Object.hasOwn(value, 'builtinAppShortcutsEnabled')) {
      let patch: SettingsBuiltinShortcutPatch
      try {
        patch = parseBuiltinShortcutWrite(value)
      } catch (error) {
        reportWriteError(error)
      }
      return submitWrite({ kind: 'builtin-shortcut', patch })
    }
    invalidateTrayConfirmation(
      isRecord(value) && Object.hasOwn(value, 'showTrayIcon') ? value.showTrayIcon : undefined
    )
    let normalized: SettingsGeneralProjection
    try {
      normalized = normalizeGeneralInput(value, options.defaultAvatar)
    } catch (error) {
      reportWriteError(error)
    }
    await submitWrite({ kind: 'projection', value: normalized })
  }

  async function setOpacity(value: number): Promise<void> {
    if (!Number.isFinite(value) || value < 0.3 || value > 1) {
      throw new SettingsBridgeProtocolError()
    }
    await submitWrite({ kind: 'opacity', value })
  }

  async function updateShortcut(value: unknown): Promise<SettingsShortcutUpdateReply> {
    if (!boundedUtf8String(value, 256) || !value || value.trim() !== value || /\p{Cc}/u.test(value)) {
      throw new SettingsBridgeProtocolError()
    }
    try {
      await enqueueWrite({ kind: 'shortcut', value })
      return { success: true }
    } catch (error) {
      if (error instanceof SettingsBridgeDisposedError) throw error
      const rejectionMessage = knownHotkeyRejectionMessage(nativeErrorCode(error))
      if (rejectionMessage) return { success: false, error: rejectionMessage }
      return reportWriteError(error)
    }
  }

  async function setWindowDefaultHeight(value: unknown): Promise<void> {
    assertDefaultHeight(value)
    await submitWrite({ kind: 'height-confirm', value })
  }

  async function submitWrite(intent: GeneralWriteIntent): Promise<void> {
    try {
      await enqueueWrite(intent)
    } catch (error) {
      reportWriteError(error)
    }
  }

  function reportWriteError(error: unknown): never {
    if (error instanceof SettingsBridgeDisposedError) throw error
    const safeError = error instanceof SettingsBridgeError ? error : new SettingsBridgeProtocolError()
    options.reportError(safeError.message)
    throw safeError
  }

  function invalidateTrayConfirmation(value?: unknown): void {
    if (lastTrayReceipt && value === lastTrayReceipt.value) return
    lastTrayReceipt = null
  }

  function runSerializedSettingsOperation<T>(run: () => Promise<T>): Promise<T> {
    return enqueueWrite<T>({ kind: 'runtime-task', run })
  }

  function enqueueWrite<T = void>(intent: GeneralWriteIntent): Promise<T> {
    if (!options.isLive()) throw new SettingsBridgeDisposedError()
    if (pendingWriteCount >= MAX_PENDING_GENERAL_WRITES) {
      throw new SettingsBridgeError(
        'ERR_ATOOLS_SETTINGS_WRITE_QUEUE_FULL',
        '保存请求过多，请稍后重试。'
      )
    }
    if (intent.kind === 'shortcut') {
      hotkeyIntentGeneration += 1
      hotkeyIntentHistory.push({ generation: hotkeyIntentGeneration, value: intent.value })
      if (hotkeyIntentHistory.length > MAX_PENDING_GENERAL_WRITES) hotkeyIntentHistory.shift()
    }
    const submittedHotkeyIntentGeneration = hotkeyIntentGeneration
    pendingWriteCount += 1
    return new Promise<T>((resolve, reject) => {
      writeQueue.enqueue({
        intent,
        hotkeyIntentGeneration: submittedHotkeyIntentGeneration,
        resolve: (value) => resolve(value as T),
        reject
      })
    })
  }

  function projectionWithConfirmedHotkey(
    requested: SettingsGeneralProjection,
    submittedGeneration: number,
    current: SettingsGeneralProjection
  ): SettingsGeneralProjection {
    if (requested.hotkey === current.hotkey) return requested
    if (requested.hotkey === initialHotkeyBaseline) return { ...requested, hotkey: current.hotkey }
    const isExplicitEcho = hotkeyIntentHistory.some((intent) =>
      intent.value === requested.hotkey && intent.generation <= submittedGeneration
    )
    if (!isExplicitEcho) throw new HostUnsupportedError()
    return { ...requested, hotkey: current.hotkey }
  }

  function buildDirtyPatch(
    baseline: SettingsGeneralProjection,
    requested: SettingsGeneralProjection,
    builtinPatch?: SettingsBuiltinShortcutPatch
  ): Record<string, unknown> {
    const changes = Object.create(null) as Record<string, unknown>
    for (const field of Object.keys(baseline) as Array<keyof SettingsGeneralProjection>) {
      if (sameJsonValue(baseline[field], requested[field])) continue
      if (!(EDITABLE_GENERAL_FIELDS as readonly string[]).includes(field)) throw new HostUnsupportedError()
      if (field === 'autoCheckUpdate') throw new HostUnsupportedError()
      if (field === 'builtinAppShortcutsEnabled') {
        if (!builtinPatch) throw new HostUnsupportedError()
        changes[field] = { ...builtinPatch }
        continue
      }
      if (field === 'placeholder' && !boundedUtf8String(requested.placeholder, MAX_PLACEHOLDER_WRITE_BYTES)) {
        throw new SettingsBridgeError(
          'ERR_ATOOLS_SETTINGS_INVALID_VALUE',
          '提示文字最多512字节。'
        )
      }
      changes[field] = cloneJson(requested[field])
    }
    return changes
  }

  function assertPatchIsExpected(
    current: SettingsGeneralProjection,
    changes: Record<string, unknown>,
    returned: SettingsGeneralProjection
  ): void {
    const expected = { ...current, ...changes }
    if (isRecord(changes.builtinAppShortcutsEnabled)) {
      expected.builtinAppShortcutsEnabled = { ...current.builtinAppShortcutsEnabled, ...changes.builtinAppShortcutsEnabled }
    }
    if (!sameJsonValue(expected, returned)) {
      throw new SettingsBridgeProtocolError()
    }
  }

  async function performWrite(
    ready: SettingsReadyReply,
    value: SettingsGeneralProjection,
    committedOpacity?: number,
    forceHotkeyCommit = false,
    builtinPatch?: SettingsBuiltinShortcutPatch,
    forceHeightCommit = false
  ): Promise<void> {
    if (revisionConflict) throw new SettingsBridgeError('SETTINGS_REVISION_CONFLICT', SETTINGS_REOPEN_MESSAGE)
    if (hotkeyOutcomeUnknown) {
      throw new SettingsBridgeError(HOTKEY_OUTCOME_UNKNOWN_CODE, HOTKEY_OUTCOME_UNKNOWN_MESSAGE)
    }
    const changes = buildDirtyPatch(ready.general.value, value, builtinPatch)
    if (forceHotkeyCommit) changes.hotkey = value.hotkey
    if (forceHeightCommit) changes.windowDefaultHeight = value.windowDefaultHeight
    if (Object.keys(changes).length === 0) {
      if (committedOpacity !== undefined && Math.abs(ready.runtime.opacity - committedOpacity) > 0.005) {
        throw new SettingsBridgeProtocolError()
      }
      return
    }
    if (Object.hasOwn(changes, 'opacity') && !ready.runtime.opacityApplied) {
      throw new HostUnsupportedError('透明度暂不可用。')
    }

    const previousRevision = ready.general.revision
    let raw: unknown
    if (typeof changes.showTrayIcon === 'boolean') invalidateTrayConfirmation()
    nativeMutationAttempted = true
    lastReceipt = null
    try {
      raw = await options.invokePatch(previousRevision, changes)
    } catch (error) {
      heightReceipt.invalidate()
      const code = nativeErrorCode(error)
      if (code === 'SETTINGS_REVISION_CONFLICT') {
        revisionConflict = true
      } else {
        const recoveryCode = error instanceof SettingsBridgeError ? error.code : code
        if (recoveryCode === OPACITY_RECOVERY_FAILED_CODE) {
          recoveryFailure = { code: OPACITY_RECOVERY_FAILED_CODE, message: OPACITY_RECOVERY_FAILED_MESSAGE }
          throw new SettingsBridgeError(recoveryFailure.code, recoveryFailure.message)
        } else if (recoveryCode === NATIVE_RECOVERY_FAILED_CODE) {
          recoveryFailure = { code: NATIVE_RECOVERY_FAILED_CODE, message: NATIVE_RECOVERY_FAILED_MESSAGE }
          throw new SettingsBridgeError(recoveryFailure.code, recoveryFailure.message)
        } else if (typeof changes.hotkey === 'string' && !knownHotkeyRejectionMessage(code)) {
          hotkeyOutcomeUnknown = true
        }
      }
      throw error
    }

    let reply
    try {
      reply = validatePatchReply(raw, options.defaultAvatar)
      if (reply.revision === previousRevision) throw new SettingsBridgeProtocolError()
      assertPatchIsExpected(ready.general.value, changes, reply.value)
    } catch (error) {
      heightReceipt.invalidate()
      if (typeof changes.hotkey === 'string' && !(error instanceof SettingsBridgeDisposedError)) {
        hotkeyOutcomeUnknown = true
      }
      throw error
    }
    if (!options.isLive()) throw new SettingsBridgeDisposedError()
    heightReceipt.accept(previousRevision, reply.revision, reply.value.windowDefaultHeight,
      Object.hasOwn(changes, 'windowDefaultHeight'))
    ready.general = { revision: reply.revision, value: cloneJson(reply.value) }
    if (typeof changes.hotkey === 'string') ready.runtime.currentShortcut = changes.hotkey
    if (typeof changes.opacity === 'number') {
      ready.runtime.opacity = changes.opacity
      ready.runtime.opacityApplied = true
    }
    lastReceipt = { revision: reply.revision, notificationDelivered: reply.notificationDelivered }
    if (typeof changes.showTrayIcon === 'boolean') {
      lastTrayReceipt = { revision: reply.revision, value: changes.showTrayIcon }
    }
  }

  async function processWrite(request: GeneralWriteRequest): Promise<void> {
    try {
      if (request.intent.kind === 'runtime-task') {
        request.resolve(await request.intent.run())
        return
      }
      if (recoveryFailure) {
        throw new SettingsBridgeError(recoveryFailure.code, recoveryFailure.message)
      }
      if (hotkeyOutcomeUnknown) {
        throw new SettingsBridgeError(HOTKEY_OUTCOME_UNKNOWN_CODE, HOTKEY_OUTCOME_UNKNOWN_MESSAGE)
      }
      const ready = await options.getReady()
      if (initialHotkeyBaseline === null) initialHotkeyBaseline = ready.general.value.hotkey
      if (request.intent.kind === 'opacity') {
        if (!ready.runtime.opacityApplied) throw new HostUnsupportedError('透明度暂不可用。')
        const value = { ...ready.general.value, opacity: request.intent.value }
        await performWrite(ready, value, request.intent.value)
      } else if (request.intent.kind === 'shortcut') {
        const value = { ...ready.general.value, hotkey: request.intent.value }
        await performWrite(ready, value, undefined, true)
      } else if (request.intent.kind === 'height-confirm') {
        if (!options.isLive()) throw new SettingsBridgeDisposedError()
        if (revisionConflict) throw new SettingsBridgeError('SETTINGS_REVISION_CONFLICT', SETTINGS_REOPEN_MESSAGE)
        if (heightReceipt.needsCommit(ready.general.revision, ready.general.value.windowDefaultHeight, request.intent.value)) {
          await performWrite(ready, ready.general.value, undefined, false, undefined, true)
        }
      } else if (request.intent.kind === 'builtin-shortcut') {
        const previousRevision = ready.general.revision
        const value = {
          ...ready.general.value,
          builtinAppShortcutsEnabled: { ...ready.general.value.builtinAppShortcutsEnabled, ...request.intent.patch }
        }
        await performWrite(ready, value, undefined, false, request.intent.patch)
        if (ready.general.revision !== previousRevision && !lastReceipt?.notificationDelivered) {
          throw new SettingsBridgeError(
            'SETTINGS_BUILTIN_SHORTCUT_NOTIFICATION_UNCONFIRMED',
            '设置已保存，但主窗口更新未确认。'
          )
        }
      } else {
        const value = projectionWithConfirmedHotkey(
          request.intent.value,
          request.hotkeyIntentGeneration,
          ready.general.value
        )
        await performWrite(ready, value)
      }
      request.resolve()
    } catch (error) {
      request.reject(error)
    } finally {
      pendingWriteCount -= 1
    }
  }

  function setAutoCheckUpdate(enabled: unknown): Promise<AboutAutoCheckReply> {
    if (typeof enabled !== 'boolean') return Promise.reject(new SettingsBridgeProtocolError())
    return runSerializedSettingsOperation(async () => {
      if (recoveryFailure) throw new SettingsBridgeError(recoveryFailure.code, recoveryFailure.message)
      if (hotkeyOutcomeUnknown) throw new SettingsBridgeError(HOTKEY_OUTCOME_UNKNOWN_CODE, HOTKEY_OUTCOME_UNKNOWN_MESSAGE)
      if (revisionConflict) throw new SettingsBridgeError('SETTINGS_REVISION_CONFLICT', SETTINGS_REOPEN_MESSAGE)
      const ready = await options.getReady()
      if (!options.isLive()) throw new SettingsBridgeDisposedError()
      try {
        if (!options.invokeAutoCheck) throw new HostUnsupportedError()
        nativeMutationAttempted = true
        lastReceipt = null
        const raw = await options.invokeAutoCheck(ready.general.revision, enabled)
        if (!options.isLive()) throw new SettingsBridgeDisposedError()
        const reply = parseAboutAutoReply(raw, options.defaultAvatar)
        assertPatchIsExpected(ready.general.value, { autoCheckUpdate: enabled }, reply.value)
        ready.general = { revision: reply.revision, value: cloneJson(reply.value) }
        lastReceipt = { revision: reply.revision, notificationDelivered: reply.notificationDelivered }
        return reply
      } catch (error) {
        // An ambiguous/failed write requires reopening; never replay queued stale intents.
        revisionConflict = true
        throw error
      }
    })
  }

  function hasConfirmedWrite(revision: string): boolean {
    return !revisionConflict && !recoveryFailure && !hotkeyOutcomeUnknown &&
      (lastReceipt
        ? lastReceipt.notificationDelivered && lastReceipt.revision === revision
        : !nativeMutationAttempted)
  }

  function hasConfirmedTrayWrite(revision: string, value: boolean): boolean {
    return !revisionConflict && !recoveryFailure && !hotkeyOutcomeUnknown && lastTrayReceipt?.revision === revision &&
      lastTrayReceipt.value === value
  }

  function dispose(): void {
    heightReceipt.invalidate()
    for (const request of writeQueue.drain()) {
      pendingWriteCount -= 1
      request.reject(new SettingsBridgeDisposedError())
    }
  }

  return {
    dbGet, dbPut, setOpacity, setWindowDefaultHeight, runSerializedSettingsOperation, updateShortcut, invalidateTrayConfirmation,
    hasConfirmedWrite, hasConfirmedTrayWrite, setAutoCheckUpdate, dispose
  }
}

function sameJsonValue(left: unknown, right: unknown, depth = 0): boolean {
  if (left === right) return true
  if (depth > 8 || left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index], depth + 1))
  }
  if (!isRecord(left) || !isRecord(right)) return false
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) =>
    Object.hasOwn(right, key) && sameJsonValue(left[key], right[key], depth + 1)
  )
}
