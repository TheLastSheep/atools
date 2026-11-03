import type {
  SettingsAliasCommitReply,
  SettingsAliasUpdateReply,
  SettingsNativeInvoke
} from './childBridgeTypes'
import {
  SettingsBridgeError,
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  cloneJson,
  isExactRecord,
  isRecord
} from './childBridgeProtocol'
import { MAX_ALIAS_PROJECTION_BYTES } from './childBridgeCommandData'

const MAX_OPERATION_PAYLOAD_BYTES = 32 * 1024
const MAX_ALIAS_WRITE_CHUNK_BYTES = 16 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NATIVE_ALIAS_ERROR_CODES = new Set([
  'SETTINGS_ALIAS_BASE_NOT_READ',
  'SETTINGS_ALIAS_REVISION_CONFLICT',
  'SETTINGS_ALIAS_TOKEN_INVALID',
  'SETTINGS_ALIAS_WRITE_IN_FLIGHT',
  'SETTINGS_ALIAS_COMMIT_INTERRUPTED'
])

export interface SettingsChildAliasesBridge {
  updateCommandAliases(value: unknown): Promise<SettingsAliasUpdateReply>
  dispose(): void
}

export interface SettingsChildAliasesBridgeOptions {
  invokeNative: (operation: Parameters<SettingsNativeInvoke>[0], payload: Record<string, unknown>) => Promise<unknown>
  isLive: () => boolean
  getBaseToken: () => string | null
  acceptBaseToken: (token: string) => void
  clearBaseToken: () => void
}

export function createSettingsChildAliasesBridge(
  options: SettingsChildAliasesBridgeOptions
): SettingsChildAliasesBridge {
  let writeInFlight = false
  let disposed = false

  function updateCommandAliases(value: unknown): Promise<SettingsAliasUpdateReply> {
    if (disposed || !options.isLive()) {
      return Promise.reject(new SettingsBridgeError('ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED', '设置会话已结束。'))
    }
    if (writeInFlight) {
      return Promise.reject(new SettingsBridgeError(
        'ERR_ATOOLS_SETTINGS_ALIAS_WRITE_IN_FLIGHT',
        '别名保存正在进行，请稍后重试。'
      ))
    }

    const baseToken = options.getBaseToken()
    if (!baseToken) {
      return Promise.reject(new SettingsBridgeError(
        'ERR_ATOOLS_SETTINGS_ALIAS_BASE_NOT_READ',
        '请先重新读取指令别名。'
      ))
    }

    let stableValue: Record<string, unknown>
    let bytes: Uint8Array
    try {
      const candidate = cloneJson(value)
      if (!isRecord(candidate)) throw new SettingsBridgeProtocolError()
      assertJsonByteBudget(candidate, MAX_ALIAS_PROJECTION_BYTES)
      const serialized = JSON.stringify(candidate)
      if (typeof serialized !== 'string') throw new SettingsBridgeProtocolError()
      bytes = new TextEncoder().encode(serialized)
      if (bytes.byteLength > MAX_ALIAS_PROJECTION_BYTES) throw new SettingsBridgeProtocolError()
      stableValue = JSON.parse(serialized) as Record<string, unknown>
    } catch (error) {
      return Promise.reject(error instanceof SettingsBridgeError ? error : new SettingsBridgeProtocolError())
    }

    writeInFlight = true
    return performUpdate(baseToken, stableValue, bytes)
      .finally(() => { writeInFlight = false })
  }

  async function performUpdate(
    baseToken: string,
    value: Record<string, unknown>,
    bytes: Uint8Array
  ): Promise<SettingsAliasUpdateReply> {
    let writeToken: string | null = null
    let commitAttempted = false
    try {
      const inlinePayload = { baseToken, value }
      const inlinePayloadBytes = new TextEncoder().encode(JSON.stringify(inlinePayload)).byteLength
      let reply: unknown
      if (inlinePayloadBytes <= MAX_OPERATION_PAYLOAD_BYTES) {
        commitAttempted = true
        reply = await options.invokeNative('writeAliases', inlinePayload)
      } else {
        const started = validateWriteStarted(await options.invokeNative('beginAliasWrite', {
          baseToken,
          totalBytes: bytes.byteLength
        }))
        writeToken = started.writeToken
        let offset = 0
        while (offset < bytes.byteLength) {
          const end = Math.min(offset + MAX_ALIAS_WRITE_CHUNK_BYTES, bytes.byteLength)
          const data = encodeBase64(bytes.subarray(offset, end))
          const progress = validateWriteProgress(await options.invokeNative('appendAliasWrite', {
            writeToken,
            offset,
            data
          }), writeToken, end)
          offset = progress.offset
        }
        commitAttempted = true
        reply = await options.invokeNative('commitAliasWrite', { writeToken })
      }

      const committed = validateCommitReply(reply, baseToken)
      options.acceptBaseToken(committed.baseToken)
      return { success: true, notificationDelivered: committed.notificationDelivered }
    } catch (error) {
      options.clearBaseToken()
      if (writeToken && !commitAttempted && !disposed && options.isLive()) {
        try {
          const aborted = await options.invokeNative('abortAliasWrite', { writeToken })
          validateAbortReply(aborted)
        } catch {}
      }
      if (commitAttempted && !isKnownAliasFailure(error)) {
        throw new SettingsBridgeError(
          'ERR_ATOOLS_SETTINGS_ALIAS_COMMIT_UNKNOWN',
          '别名保存回执未知，请重新读取后确认结果。'
        )
      }
      throw error
    }
  }

  function dispose(): void {
    disposed = true
    options.clearBaseToken()
  }

  return { updateCommandAliases, dispose }
}

function validateWriteStarted(value: unknown): { writeToken: string } {
  if (!isExactRecord(value, ['writeToken', 'offset']) ||
    typeof value.writeToken !== 'string' || !UUID_PATTERN.test(value.writeToken) || value.offset !== 0) {
    throw new SettingsBridgeProtocolError()
  }
  assertJsonByteBudget(value, 64 * 1024)
  return { writeToken: value.writeToken }
}

function validateWriteProgress(value: unknown, expectedToken: string, expectedOffset: number): { offset: number } {
  if (!isExactRecord(value, ['writeToken', 'offset']) ||
    value.writeToken !== expectedToken || !Number.isSafeInteger(value.offset) || value.offset !== expectedOffset) {
    throw new SettingsBridgeProtocolError()
  }
  assertJsonByteBudget(value, 64 * 1024)
  return { offset: value.offset as number }
}

function validateCommitReply(value: unknown, previousBaseToken: string): SettingsAliasCommitReply {
  if (!isExactRecord(value, [
    'version', 'success', 'baseToken', 'notificationDelivered'
  ]) || value.version !== 1 || value.success !== true ||
    typeof value.baseToken !== 'string' || !UUID_PATTERN.test(value.baseToken) ||
    value.baseToken === previousBaseToken || typeof value.notificationDelivered !== 'boolean') {
    throw new SettingsBridgeProtocolError()
  }
  assertJsonByteBudget(value, 64 * 1024)
  return value as SettingsAliasCommitReply
}

function validateAbortReply(value: unknown): void {
  if (!isExactRecord(value, ['aborted']) || typeof value.aborted !== 'boolean') {
    throw new SettingsBridgeProtocolError()
  }
  assertJsonByteBudget(value, 64 * 1024)
}

function isKnownAliasFailure(error: unknown): boolean {
  return error instanceof SettingsBridgeError && NATIVE_ALIAS_ERROR_CODES.has(error.code)
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.byteLength; offset += 1) {
    binary += String.fromCharCode(bytes[offset])
  }
  return btoa(binary)
}
