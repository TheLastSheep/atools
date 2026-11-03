import type {
  SettingsNativeInvoke,
  SettingsSearchPinMutation,
  SettingsSearchPinMutationReply
} from './childBridgeTypes'
import {
  MAX_OPERATION_PAYLOAD_BYTES,
  SettingsBridgeDisposedError,
  SettingsBridgeError,
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  boundedUtf8String,
  isExactRecord,
  isRecord
} from './childBridgeProtocol'

const MAX_PATH_BYTES = 16 * 1024
const MAX_NAME_BYTES = 4096

export interface SettingsChildSearchPinsBridge {
  pinApp(command: unknown): Promise<void>
  unpinApp(path: unknown, featureCode?: unknown, name?: unknown): Promise<void>
  dispose(): void
}

export interface SettingsChildSearchPinsBridgeOptions {
  invokeNative: (
    operation: Parameters<SettingsNativeInvoke>[0],
    payload: Record<string, unknown>
  ) => Promise<unknown>
  isLive: () => boolean
  invalidateReads: () => void
}

export function createSettingsChildSearchPinsBridge(
  options: SettingsChildSearchPinsBridgeOptions
): SettingsChildSearchPinsBridge {
  let disposed = false
  let writeInFlight = false

  function assertLive(): void {
    if (disposed || !options.isLive()) throw new SettingsBridgeDisposedError()
  }

  async function pinApp(command: unknown): Promise<void> {
    assertLive()
    if (!isRecord(command) || command.type !== 'direct' || command.subType !== 'app') {
      throw new SettingsBridgeProtocolError()
    }
    await mutate({
      operation: 'pin',
      app: {
        path: requiredString(command.path, MAX_PATH_BYTES),
        name: requiredString(command.name, MAX_NAME_BYTES)
      }
    })
  }

  async function unpinApp(path: unknown, featureCode?: unknown, name?: unknown): Promise<void> {
    assertLive()
    if (featureCode !== undefined) throw new SettingsBridgeProtocolError()
    await mutate({
      operation: 'unpin',
      path: requiredString(path, MAX_PATH_BYTES),
      name: name === undefined || name === null ? null : requiredString(name, MAX_NAME_BYTES)
    })
  }

  async function mutate(payload: SettingsSearchPinMutation): Promise<void> {
    assertLive()
    if (writeInFlight) {
      throw new SettingsBridgeError(
        'ERR_ATOOLS_SETTINGS_SEARCH_PIN_IN_FLIGHT',
        '固定操作正在进行，请稍后重试。'
      )
    }
    const safePayload: Record<string, unknown> = { ...payload }
    assertJsonByteBudget(safePayload, MAX_OPERATION_PAYLOAD_BYTES)
    writeInFlight = true
    try {
      options.invalidateReads()
      const reply = await options.invokeNative('mutateSearchPin', safePayload)
      assertLive()
      validateMutationReply(reply)
    } finally {
      options.invalidateReads()
      writeInFlight = false
    }
  }

  function dispose(): void {
    disposed = true
  }

  return { pinApp, unpinApp, dispose }
}

function requiredString(value: unknown, maxBytes: number): string {
  if (!boundedUtf8String(value, maxBytes) || value.length === 0) {
    throw new SettingsBridgeProtocolError()
  }
  return value
}

function validateMutationReply(value: unknown): asserts value is SettingsSearchPinMutationReply {
  if (!isExactRecord(value, ['version', 'revision']) ||
    value.version !== 1 || typeof value.revision !== 'number' ||
    !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw new SettingsBridgeProtocolError()
  }
}
