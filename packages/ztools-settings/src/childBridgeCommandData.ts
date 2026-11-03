import type {
  SettingsCommandCatalog,
  SettingsCommandDataKind,
  SettingsCommandDataPage,
  SettingsNativeInvoke
} from './childBridgeTypes'
import {
  SettingsBridgeDisposedError,
  SettingsBridgeProtocolError,
  assertJsonByteBudget,
  cloneJson,
  isExactRecord,
  isRecord
} from './childBridgeProtocol'

export const MAX_COMMAND_CATALOG_BYTES = 8 * 1024 * 1024
export const MAX_ALIAS_PROJECTION_BYTES = 512 * 1024
const MAX_DATA_PAGE_BYTES = 32 * 1024
const MAX_DATA_PAGE_REPLY_BYTES = 64 * 1024
const MAX_COMMAND_ROWS = 16_384
const MAX_PLUGIN_ROWS = 2_048
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface SettingsChildCommandDataBridge {
  getCommands(): Promise<SettingsCommandCatalog>
  readAliases(): Promise<unknown>
  getAliasBaseToken(): string | null
  acceptAliasBaseToken(token: string): void
  clearAliasBaseToken(): void
  dispose(): void
}

export interface SettingsChildCommandDataBridgeOptions {
  invokeNative: (operation: Parameters<SettingsNativeInvoke>[0], payload: Record<string, unknown>) => Promise<unknown>
  isLive: () => boolean
}

export interface SettingsDataDocumentReaderOptions {
  invokeNative: SettingsChildCommandDataBridgeOptions['invokeNative']
  isLive: () => boolean
}

export async function readSettingsDataDocument(
  options: SettingsDataDocumentReaderOptions,
  kind: SettingsCommandDataKind,
  maxBytes: number
): Promise<{ text: string; token: string }> {
  if (!options.isLive()) throw new SettingsBridgeDisposedError()
  const firstOperation = kind === 'commands' ? 'readCommands'
    : kind === 'aliases' ? 'readAliases' : 'readCommandSettings'
  let page = validateDataPage(await options.invokeNative(firstOperation, {}), kind, 0, maxBytes)
  const token = page.token
  const totalBytes = page.totalBytes
  const chunks: Uint8Array[] = []
  let accumulatedBytes = 0

  while (true) {
    if (!options.isLive()) throw new SettingsBridgeDisposedError()
    if (page.token !== token || page.totalBytes !== totalBytes || page.offset !== accumulatedBytes) {
      throw new SettingsBridgeProtocolError()
    }
    const bytes = decodeBase64(page.data)
    if (bytes.byteLength > MAX_DATA_PAGE_BYTES ||
      page.nextOffset !== page.offset + bytes.byteLength ||
      page.nextOffset > totalBytes) {
      throw new SettingsBridgeProtocolError()
    }
    accumulatedBytes += bytes.byteLength
    if (accumulatedBytes > maxBytes || accumulatedBytes !== page.nextOffset) {
      throw new SettingsBridgeProtocolError()
    }
    chunks.push(bytes)
    if (page.nextOffset === totalBytes) break
    if (page.nextOffset <= page.offset || accumulatedBytes >= totalBytes) {
      throw new SettingsBridgeProtocolError()
    }
    page = validateDataPage(await options.invokeNative('readCommandDataPage', {
      kind,
      token,
      offset: accumulatedBytes
    }), kind, accumulatedBytes, maxBytes)
  }

  if (accumulatedBytes !== totalBytes) throw new SettingsBridgeProtocolError()
  const joined = new Uint8Array(totalBytes)
  let cursor = 0
  for (const chunk of chunks) {
    joined.set(chunk, cursor)
    cursor += chunk.byteLength
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(joined), token }
  } catch {
    throw new SettingsBridgeProtocolError()
  }
}

export function createSettingsChildCommandDataBridge(
  options: SettingsChildCommandDataBridgeOptions
): SettingsChildCommandDataBridge {
  let aliasBaseToken: string | null = null
  let aliasTokenGeneration = 0
  let pendingCommandsRead: Promise<SettingsCommandCatalog> | null = null
  let pendingAliasesRead: Promise<unknown> | null = null
  let disposed = false

  function assertLive(): void {
    if (disposed || !options.isLive()) throw new SettingsBridgeDisposedError()
  }

  const readDocument = (kind: SettingsCommandDataKind, maxBytes: number) => readSettingsDataDocument({
    invokeNative: options.invokeNative,
    isLive: () => !disposed && options.isLive()
  }, kind, maxBytes)

  function getCommands(): Promise<SettingsCommandCatalog> {
    assertLive()
    if (pendingCommandsRead) return pendingCommandsRead.then((value) => cloneFresh(value))
    const pending = loadCommands()
    pendingCommandsRead = pending
    void pending.then(clearPendingCommands, clearPendingCommands)
    return pending.then((value) => cloneFresh(value))
  }

  async function loadCommands(): Promise<SettingsCommandCatalog> {
    const { text } = await readDocument('commands', MAX_COMMAND_CATALOG_BYTES)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new SettingsBridgeProtocolError()
    }
    if (!isExactRecord(parsed, ['commands', 'regexCommands', 'plugins']) ||
      !Array.isArray(parsed.commands) || !Array.isArray(parsed.regexCommands) || !Array.isArray(parsed.plugins) ||
      parsed.commands.length + parsed.regexCommands.length > MAX_COMMAND_ROWS ||
      parsed.plugins.length > MAX_PLUGIN_ROWS) {
      throw new SettingsBridgeProtocolError()
    }
    assertLive()
    return parsed as SettingsCommandCatalog
  }

  function readAliases(): Promise<unknown> {
    assertLive()
    if (pendingAliasesRead) return pendingAliasesRead.then((value) => cloneFresh(value))
    const generationAtStart = invalidateAliasBase()
    const pending = loadAliases(generationAtStart)
    pendingAliasesRead = pending
    void pending.then(clearPendingAliases, clearPendingAliases)
    return pending.then((value) => cloneFresh(value))
  }

  async function loadAliases(generationAtStart: number): Promise<unknown> {
    const { text, token } = await readDocument('aliases', MAX_ALIAS_PROJECTION_BYTES)
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      throw new SettingsBridgeProtocolError()
    }
    if (value !== null && !isRecord(value)) throw new SettingsBridgeProtocolError()
    assertLive()
    if (aliasTokenGeneration === generationAtStart) acceptAliasBaseToken(token)
    return value
  }

  function clearPendingCommands(): void {
    pendingCommandsRead = null
  }

  function clearPendingAliases(): void {
    pendingAliasesRead = null
  }

  function cloneFresh<T>(value: T): T {
    assertLive()
    return cloneJson(value)
  }

  function invalidateAliasBase(): number {
    aliasTokenGeneration += 1
    aliasBaseToken = null
    return aliasTokenGeneration
  }

  function getAliasBaseToken(): string | null {
    return aliasBaseToken
  }

  function acceptAliasBaseToken(token: string): void {
    if (!UUID_PATTERN.test(token)) throw new SettingsBridgeProtocolError()
    aliasTokenGeneration += 1
    aliasBaseToken = token
  }

  function clearAliasBaseToken(): void {
    invalidateAliasBase()
  }

  function dispose(): void {
    disposed = true
    clearAliasBaseToken()
    pendingCommandsRead = null
    pendingAliasesRead = null
  }

  return { getCommands, readAliases, getAliasBaseToken, acceptAliasBaseToken, clearAliasBaseToken, dispose }
}

function validateDataPage(
  value: unknown,
  kind: SettingsCommandDataKind,
  requestedOffset: number,
  maxBytes: number
): SettingsCommandDataPage {
  if (!isExactRecord(value, [
    'version', 'kind', 'token', 'offset', 'nextOffset', 'totalBytes', 'data'
  ])) throw new SettingsBridgeProtocolError()
  assertJsonByteBudget(value, MAX_DATA_PAGE_REPLY_BYTES)
  if (
    value.version !== 1 || value.kind !== kind ||
    typeof value.token !== 'string' || !UUID_PATTERN.test(value.token) ||
    !Number.isSafeInteger(value.offset) || value.offset !== requestedOffset ||
    !Number.isSafeInteger(value.nextOffset) || value.nextOffset < 0 ||
    !Number.isSafeInteger(value.totalBytes) || value.totalBytes < 1 || value.totalBytes > maxBytes ||
    typeof value.data !== 'string'
  ) throw new SettingsBridgeProtocolError()
  return value as SettingsCommandDataPage
}

function decodeBase64(value: string): Uint8Array {
  if (value.length > Math.ceil(MAX_DATA_PAGE_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new SettingsBridgeProtocolError()
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw new SettingsBridgeProtocolError()
  }
  if (btoa(binary) !== value || binary.length > MAX_DATA_PAGE_BYTES) throw new SettingsBridgeProtocolError()
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}
