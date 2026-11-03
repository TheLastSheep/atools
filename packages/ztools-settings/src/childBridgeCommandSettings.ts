import type {
  SettingsCommandDataKind,
  SettingsCommandSettingsProjection,
  SettingsDisabledCommandsWriteReply,
  SettingsNativeInvoke
} from './childBridgeTypes'
import {
  SettingsBridgeError,
  SettingsBridgeDisposedError,
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  cloneJson,
  isExactRecord,
  isRecord
} from './childBridgeProtocol'
import { readSettingsDataDocument } from './childBridgeCommandData'

export const MAX_COMMAND_SETTINGS_BYTES = 1024 * 1024
const MAX_COMMAND_SETTINGS_ROWS = 4096
export const MAX_DISABLED_COMMAND_ID_BYTES = 16_448
export const MAX_DISABLED_COMMANDS_VALUE_BYTES = 128 * 1024
export const MAX_DISABLED_COMMANDS_WRITE_PAYLOAD_BYTES = MAX_DISABLED_COMMANDS_VALUE_BYTES + 256
const COMMAND_SETTING_KEYS = [
  'disable-commands',
  'pinned-commands',
  'super-panel-pinned',
  'global-shortcuts',
  'app-shortcuts'
] as const

export type SettingsCommandSettingKey = typeof COMMAND_SETTING_KEYS[number]

export interface SettingsChildCommandSettingsBridge {
  readCommandSettings(): Promise<SettingsCommandSettingsProjection>
  hasKey(key: unknown): key is SettingsCommandSettingKey
  dbGet(key: SettingsCommandSettingKey): Promise<unknown>
  dbPutDisabledCommands(value: unknown): Promise<void>
  notifyDisabledCommandsChanged(): Promise<{ success: true }>
  getSuperPanelPinned(): Promise<unknown[]>
  invalidateReads(): void
  dispose(): void
}

export interface SettingsChildCommandSettingsBridgeOptions {
  invokeNative: (operation: Parameters<SettingsNativeInvoke>[0], payload: Record<string, unknown>) => Promise<unknown>
  isLive: () => boolean
  reportError: (message: string) => void
}

export function createSettingsChildCommandSettingsBridge(
  options: SettingsChildCommandSettingsBridgeOptions
): SettingsChildCommandSettingsBridge {
  type PendingRead = { epoch: symbol; promise: Promise<SettingsCommandSettingsProjection> }
  let pendingRead: PendingRead | null = null
  let readEpoch = Symbol()
  let disposed = false
  let commandSettingsBaseToken: string | null = null
  let commandSettingsBaseDisabledCommands: string[] | null = null
  let observedDisabledCommands: string[] | null | undefined
  let requiresExplicitDisabledCommandsRead = false
  let disabledCommandsWriteInFlight = false
  let lastDisabledCommandsReceipt: SettingsDisabledCommandsWriteReply | null = null

  function assertLive(): void {
    if (disposed || !options.isLive()) throw new SettingsBridgeDisposedError()
  }

  function hasKey(key: unknown): key is SettingsCommandSettingKey {
    return typeof key === 'string' && (COMMAND_SETTING_KEYS as readonly string[]).includes(key)
  }

  function readCommandSettings(): Promise<SettingsCommandSettingsProjection> {
    assertLive()
    const epoch = readEpoch
    if (pendingRead?.epoch === epoch) return pendingRead.promise.then(cloneFresh)
    const promise = loadSnapshot(epoch)
    const pending = { epoch, promise }
    pendingRead = pending
    void promise.then(() => clearPendingRead(pending), () => clearPendingRead(pending))
    return promise.then(cloneFresh)
  }

  async function loadSnapshot(epoch: symbol): Promise<SettingsCommandSettingsProjection> {
    const { text, token } = await readSettingsDataDocument({
      invokeNative: options.invokeNative,
      isLive: () => !disposed && options.isLive()
    }, 'commandSettings' satisfies SettingsCommandDataKind, MAX_COMMAND_SETTINGS_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SettingsBridgeProtocolError()
    }
    if (!isExactRecord(parsed, COMMAND_SETTING_KEYS)) {
      throw new SettingsBridgeProtocolError()
    }
    for (const key of COMMAND_SETTING_KEYS) {
      const rows = parsed[key]
      if (rows === null) continue
      if (!Array.isArray(rows) || rows.length > MAX_COMMAND_SETTINGS_ROWS) {
        throw new SettingsBridgeProtocolError()
      }
      if (key === 'disable-commands') {
        if (!rows.every((row) => typeof row === 'string')) throw new SettingsBridgeProtocolError()
        continue
      }
      if (!rows.every(isRecord)) throw new SettingsBridgeProtocolError()
      if (key === 'super-panel-pinned') {
        let expandedCount = 0
        for (const row of rows) {
          if (Boolean(row.isFolder) && Array.isArray(row.items)) {
            if (!row.items.every(isRecord)) throw new SettingsBridgeProtocolError()
            expandedCount += row.items.length
          } else {
            expandedCount += 1
          }
          if (expandedCount > MAX_COMMAND_SETTINGS_ROWS) throw new SettingsBridgeProtocolError()
        }
      }
    }
    assertJsonByteBudget(parsed, MAX_COMMAND_SETTINGS_BYTES)
    assertLive()
    if (epoch !== readEpoch) throw new SettingsBridgeProtocolError()
    commandSettingsBaseToken = token
    commandSettingsBaseDisabledCommands = cloneObservedDisabledCommands(parsed['disable-commands'])
    return parsed as SettingsCommandSettingsProjection
  }

  async function dbGet(key: SettingsCommandSettingKey): Promise<unknown> {
    const epoch = readEpoch
    const snapshot = await readCommandSettings()
    if (key === 'disable-commands') {
      assertLive()
      if (epoch !== readEpoch) throw new SettingsBridgeProtocolError()
      observedDisabledCommands = cloneObservedDisabledCommands(snapshot[key])
      requiresExplicitDisabledCommandsRead = false
    }
    return cloneJson(snapshot[key])
  }

  async function dbPutDisabledCommands(value: unknown): Promise<void> {
    assertLive()
    lastDisabledCommandsReceipt = null
    if (disabledCommandsWriteInFlight) {
      throw new SettingsBridgeError(
        'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_WRITE_IN_FLIGHT',
        '禁用指令保存正在进行，请稍后重试。'
      )
    }
    disabledCommandsWriteInFlight = true
    try {
      const safeValue = cloneDisabledCommands(value)
      if (requiresExplicitDisabledCommandsRead) throw disabledCommandsRevisionConflict()
      if (!commandSettingsBaseToken) await readCommandSettings()
      assertLive()
      const baseToken = commandSettingsBaseToken
      if (!baseToken) {
        throw new SettingsBridgeError(
          'SETTINGS_DISABLED_COMMANDS_BASE_INVALID',
          '请先重新读取禁用指令状态。'
        )
      }
      if (requiresExplicitDisabledCommandsRead ||
        (observedDisabledCommands !== undefined &&
          !sameDisabledCommands(observedDisabledCommands, commandSettingsBaseDisabledCommands))) {
        throw disabledCommandsRevisionConflict()
      }
      const reply = validateDisabledCommandsWriteReply(await options.invokeNative('writeDisabledCommands', {
        baseToken,
        value: safeValue
      }))
      assertLive()
      observedDisabledCommands = safeValue.slice()
      if (reply.changed && !reply.notificationDelivered) {
        throw new SettingsBridgeError(
          'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_REFRESH_UNCONFIRMED',
          '禁用指令已保存，但主窗口刷新未确认，请重新读取。'
        )
      }
      lastDisabledCommandsReceipt = reply
    } catch (error) {
      if (!(error instanceof SettingsBridgeDisposedError)) {
        const safeError = error instanceof SettingsBridgeError ? error : new SettingsBridgeProtocolError()
        if (requiresExplicitReadAfter(safeError)) requiresExplicitDisabledCommandsRead = true
        try {
          options.reportError(safeError.message)
        } catch {}
        throw safeError
      }
      throw error
    } finally {
      invalidateReads()
      disabledCommandsWriteInFlight = false
    }
  }

  async function notifyDisabledCommandsChanged(): Promise<{ success: true }> {
    assertLive()
    if (disabledCommandsWriteInFlight || !lastDisabledCommandsReceipt) {
      throw new SettingsBridgeError(
        'ERR_ATOOLS_SETTINGS_DISABLED_COMMANDS_RECEIPT_NOT_AVAILABLE',
        '没有可确认的禁用指令保存回执。'
      )
    }
    lastDisabledCommandsReceipt = null
    return { success: true }
  }

  async function getSuperPanelPinned(): Promise<unknown[]> {
    const rows = await dbGet('super-panel-pinned')
    if (rows === null) return []
    if (!Array.isArray(rows)) throw new SettingsBridgeProtocolError()

    const expanded: unknown[] = []
    for (const row of rows) {
      if (!isRecord(row)) throw new SettingsBridgeProtocolError()
      if (Boolean(row.isFolder) && Array.isArray(row.items)) {
        for (const item of row.items) {
          if (!isRecord(item)) throw new SettingsBridgeProtocolError()
          expanded.push(cloneJson(item))
          if (expanded.length > MAX_COMMAND_SETTINGS_ROWS) throw new SettingsBridgeProtocolError()
        }
      } else {
        expanded.push(cloneJson(row))
        if (expanded.length > MAX_COMMAND_SETTINGS_ROWS) throw new SettingsBridgeProtocolError()
      }
    }
    return expanded
  }

  function cloneFresh(value: SettingsCommandSettingsProjection): SettingsCommandSettingsProjection {
    assertLive()
    return cloneJson(value)
  }

  function clearPendingRead(expected: PendingRead): void {
    if (pendingRead === expected) pendingRead = null
  }

  function invalidateReads(): void {
    readEpoch = Symbol()
    pendingRead = null
    commandSettingsBaseToken = null
    commandSettingsBaseDisabledCommands = null
  }

  function dispose(): void {
    disposed = true
    invalidateReads()
    observedDisabledCommands = undefined
    requiresExplicitDisabledCommandsRead = false
    lastDisabledCommandsReceipt = null
  }

  return {
    readCommandSettings,
    hasKey,
    dbGet,
    dbPutDisabledCommands,
    notifyDisabledCommandsChanged,
    getSuperPanelPinned,
    invalidateReads,
    dispose
  }
}

function cloneObservedDisabledCommands(value: unknown): string[] | null {
  if (value === null) return null
  if (!Array.isArray(value)) throw new SettingsBridgeProtocolError()
  const safeValue: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const id: unknown = value[index]
    if (typeof id !== 'string') throw new SettingsBridgeProtocolError()
    safeValue.push(id)
  }
  return safeValue
}

function sameDisabledCommands(
  observed: string[] | null,
  current: string[] | null
): boolean {
  if (observed === null || current === null) return observed === current
  return observed.length === current.length && observed.every((id, index) => id === current[index])
}

function disabledCommandsRevisionConflict(): SettingsBridgeError {
  return new SettingsBridgeError(
    'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT',
    '禁用指令数据已变化，请重新读取后重试。'
  )
}

function requiresExplicitReadAfter(error: SettingsBridgeError): boolean {
  return error.code === 'SETTINGS_DISABLED_COMMANDS_REVISION_CONFLICT' ||
    error.code === 'SETTINGS_DISABLED_COMMANDS_COMMIT_UNKNOWN' ||
    error.code === 'SETTINGS_DISABLED_COMMANDS_BASE_INVALID'
}

function cloneDisabledCommands(value: unknown): string[] {
  let inputArray: unknown[]
  try {
    if (!Array.isArray(value)) throw new SettingsBridgeProtocolError()
    inputArray = value
  } catch {
    throw new SettingsBridgeProtocolError()
  }

  let count: number
  try {
    count = inputArray.length
  } catch {
    throw new SettingsBridgeProtocolError()
  }
  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COMMAND_SETTINGS_ROWS) {
    throw new SettingsBridgeProtocolError()
  }

  const encoder = new TextEncoder()
  const safeValue = new Array<string>(count)
  let cumulativeIdBytes = 0
  for (let index = 0; index < count; index += 1) {
    let id: unknown
    try {
      id = inputArray[index]
    } catch {
      throw new SettingsBridgeProtocolError()
    }
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_DISABLED_COMMAND_ID_BYTES) {
      throw new SettingsBridgeProtocolError()
    }
    const idBytes = encoder.encode(id).byteLength
    if (idBytes > MAX_DISABLED_COMMAND_ID_BYTES) throw new SettingsBridgeProtocolError()
    cumulativeIdBytes += idBytes
    if (cumulativeIdBytes > MAX_DISABLED_COMMANDS_VALUE_BYTES) throw new SettingsBridgeProtocolError()
    safeValue[index] = id
  }

  assertJsonByteBudget(safeValue, MAX_DISABLED_COMMANDS_VALUE_BYTES)
  return safeValue
}

function validateDisabledCommandsWriteReply(value: unknown): SettingsDisabledCommandsWriteReply {
  if (!isExactRecord(value, [
    'version', 'success', 'changed', 'notificationDelivered'
  ]) || value.version !== 1 || value.success !== true ||
    typeof value.changed !== 'boolean' || typeof value.notificationDelivered !== 'boolean') {
    throw new SettingsBridgeProtocolError()
  }
  return value as SettingsDisabledCommandsWriteReply
}
