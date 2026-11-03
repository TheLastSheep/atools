import type {
  SettingsCommandCatalog,
  SettingsCommandDataKind,
  SettingsCommandDataPage,
  SettingsNativeInvoke
} from '../../packages/ztools-settings/src/childBridgeTypes'

const MAX_REQUEST_BYTES = 32 * 1024
const MAX_RESPONSE_BYTES = 64 * 1024
const MAX_READ_CHUNK_BYTES = 32 * 1024
const MAX_WRITE_CHUNK_BYTES = 16 * 1024
const MAX_ALIAS_PROJECTION_BYTES = 512 * 1024
const MAX_COMMAND_BYTES = 8 * 1024 * 1024
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

interface DataSnapshot {
  kind: SettingsCommandDataKind
  sessionId: string
  bytes: Uint8Array
}

interface AliasBase {
  sessionId: string
  revision: number
}

interface StagedWrite {
  token: string
  baseToken: string
  sessionId: string
  totalBytes: number
  bytes: number[]
}

export interface SettingsAliasNativeTransportFixtureOptions {
  commands?: SettingsCommandCatalog
  /** Synthetic normalized renderer projection, not raw Core storage. */
  aliases?: unknown
  aliasStoragePresent?: boolean
  pageBytes?: number
  notificationDelivered?: boolean
  interruptCommitAfterPersist?: boolean
}

/**
 * Synthetic child RPC transport for bridge tests only. It models paging, chunk framing,
 * revision tokens, and the explicit missing/empty no-op fact. It is not a Core/Native
 * implementation or runtime evidence and intentionally does not emulate semantic merge.
 */
export class SettingsAliasNativeTransportFixture {
  readonly calls: Array<{ operation: string; payload: Record<string, unknown>; sessionId: string }> = []
  private readonly commands: SettingsCommandCatalog
  private readonly pageBytes: number
  private readonly notificationDelivered: boolean
  private readonly interruptCommitAfterPersist: boolean
  private aliasValue: unknown
  private aliasStoragePresent: boolean
  private aliasRevision = 0
  private sequence = 0
  private readonly snapshots = new Map<string, DataSnapshot>()
  private readonly snapshotByKind = new Map<SettingsCommandDataKind, string>()
  private readonly aliasBases = new Map<string, AliasBase>()
  private currentAliasBase: string | null = null
  private stagedWrite: StagedWrite | null = null

  constructor(options: SettingsAliasNativeTransportFixtureOptions = {}) {
    this.commands = cloneJson(options.commands ?? createFixtureCommandCatalog())
    this.aliasStoragePresent = options.aliasStoragePresent ?? Object.hasOwn(options, 'aliases')
    this.aliasValue = cloneJson(Object.hasOwn(options, 'aliases') ? options.aliases : null)
    if ((this.aliasStoragePresent && this.aliasValue === null) ||
      (!this.aliasStoragePresent && this.aliasValue !== null)) {
      throw new Error('Synthetic fixture only allows null for a missing alias fact')
    }
    this.pageBytes = options.pageBytes ?? MAX_READ_CHUNK_BYTES
    this.notificationDelivered = options.notificationDelivered ?? true
    this.interruptCommitAfterPersist = options.interruptCommitAfterPersist ?? false
    if (!Number.isSafeInteger(this.pageBytes) || this.pageBytes < 1 || this.pageBytes > MAX_READ_CHUNK_BYTES) {
      throw new Error('Invalid fixture page size')
    }
  }

  readonly invoke: SettingsNativeInvoke = async (operation, payload, sessionId) => {
    this.assertPayload(payload)
    this.calls.push({ operation, payload: cloneJson(payload), sessionId })
    let reply: unknown
    switch (operation) {
      case 'readCommands':
        this.assertExactKeys(payload, [])
        reply = this.readDocument('commands', sessionId)
        break
      case 'readAliases':
        this.assertExactKeys(payload, [])
        reply = this.readDocument('aliases', sessionId)
        break
      case 'readCommandDataPage':
        this.assertExactKeys(payload, ['kind', 'token', 'offset'])
        reply = this.readPage(payload, sessionId)
        break
      case 'writeAliases':
        this.assertExactKeys(payload, ['baseToken', 'value'])
        reply = this.writeAliases(payload, sessionId)
        break
      case 'beginAliasWrite':
        this.assertExactKeys(payload, ['baseToken', 'totalBytes'])
        reply = this.beginAliasWrite(payload, sessionId)
        break
      case 'appendAliasWrite':
        this.assertExactKeys(payload, ['writeToken', 'offset', 'data'])
        reply = this.appendAliasWrite(payload, sessionId)
        break
      case 'commitAliasWrite':
        this.assertExactKeys(payload, ['writeToken'])
        reply = this.commitAliasWrite(payload, sessionId)
        break
      case 'abortAliasWrite':
        this.assertExactKeys(payload, ['writeToken'])
        reply = this.abortAliasWrite(payload, sessionId)
        break
      default:
        throw nativeError('ERR_ATOOLS_SETTINGS_UNSUPPORTED', 'Unsupported fixture operation')
    }
    this.assertResponse(reply)
    return cloneJson(reply)
  }

  get hasAliasStorageFact(): boolean {
    return this.aliasStoragePresent
  }

  getAliases(): unknown {
    return cloneJson(this.aliasValue)
  }

  replaceAliasesExternally(value: unknown, stored = true): void {
    if ((stored && value === null) || (!stored && value !== null)) {
      throw new Error('Synthetic fixture only allows null for a missing alias fact')
    }
    this.aliasValue = cloneJson(value)
    this.aliasStoragePresent = stored
    this.aliasRevision += 1
  }

  closeSession(sessionId: string): void {
    for (const [token, snapshot] of this.snapshots) {
      if (snapshot.sessionId === sessionId) this.snapshots.delete(token)
    }
    for (const [kind, token] of this.snapshotByKind) {
      if (!this.snapshots.has(token)) this.snapshotByKind.delete(kind)
    }
    for (const [token, base] of this.aliasBases) {
      if (base.sessionId === sessionId) this.aliasBases.delete(token)
    }
    if (this.currentAliasBase && !this.aliasBases.has(this.currentAliasBase)) this.currentAliasBase = null
    if (this.stagedWrite?.sessionId === sessionId) this.stagedWrite = null
  }

  private readDocument(kind: SettingsCommandDataKind, sessionId: string): SettingsCommandDataPage {
    const document = kind === 'commands' ? this.commands : this.aliasValue
    const bytes = encodeJson(document)
    const maxBytes = kind === 'commands' ? MAX_COMMAND_BYTES : MAX_ALIAS_PROJECTION_BYTES
    if (bytes.byteLength > maxBytes) throw nativeError('ERR_ATOOLS_SETTINGS_DATA_TOO_LARGE', 'Fixture data limit exceeded')
    if (kind === 'commands') {
      if (this.commands.commands.length + this.commands.regexCommands.length > 16_384 ||
        this.commands.plugins.length > 2_048) {
        throw nativeError('ERR_ATOOLS_SETTINGS_DATA_TOO_LARGE', 'Fixture catalog row limit exceeded')
      }
    }
    const previous = this.snapshotByKind.get(kind)
    if (previous) this.snapshots.delete(previous)
    const token = this.nextToken()
    this.snapshots.set(token, { kind, sessionId, bytes })
    this.snapshotByKind.set(kind, token)
    if (kind === 'aliases') {
      this.aliasBases.clear()
      this.currentAliasBase = token
      this.aliasBases.set(token, { sessionId, revision: this.aliasRevision })
    }
    return this.page(kind, token, 0, bytes)
  }

  private readPage(payload: Record<string, unknown>, sessionId: string): SettingsCommandDataPage {
    const kind = payload.kind
    const token = payload.token
    const offset = payload.offset
    if ((kind !== 'commands' && kind !== 'aliases') || !isUuid(token) ||
      !Number.isSafeInteger(offset) || (offset as number) < 0) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Invalid page request')
    }
    const snapshot = this.snapshots.get(token)
    if (!snapshot || snapshot.kind !== kind || snapshot.sessionId !== sessionId) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Snapshot token is unavailable')
    }
    return this.page(kind, token, offset as number, snapshot.bytes)
  }

  private page(
    kind: SettingsCommandDataKind,
    token: string,
    offset: number,
    bytes: Uint8Array
  ): SettingsCommandDataPage {
    if (offset > bytes.byteLength) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Page offset is invalid')
    }
    const end = Math.min(offset + this.pageBytes, bytes.byteLength)
    return {
      version: 1,
      kind,
      token,
      offset,
      nextOffset: end,
      totalBytes: bytes.byteLength,
      data: encodeBase64(bytes.subarray(offset, end))
    }
  }

  private writeAliases(payload: Record<string, unknown>, sessionId: string): unknown {
    const bytes = encodeJson(payload.value)
    if (bytes.byteLength > MAX_ALIAS_PROJECTION_BYTES) {
      throw nativeError('ERR_ATOOLS_SETTINGS_DATA_TOO_LARGE', 'Alias projection limit exceeded')
    }
    return this.commitValue(payload.baseToken, payload.value, sessionId)
  }

  private beginAliasWrite(payload: Record<string, unknown>, sessionId: string): unknown {
    this.validateBaseToken(payload.baseToken, sessionId)
    const totalBytes = payload.totalBytes
    if (!Number.isSafeInteger(totalBytes) || (totalBytes as number) < 1 ||
      (totalBytes as number) > MAX_ALIAS_PROJECTION_BYTES) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Invalid staged alias size')
    }
    if (this.stagedWrite) throw nativeError('SETTINGS_ALIAS_WRITE_IN_FLIGHT', 'A staged write already exists')
    const writeToken = this.nextToken()
    this.stagedWrite = {
      token: writeToken,
      baseToken: payload.baseToken as string,
      sessionId,
      totalBytes: totalBytes as number,
      bytes: []
    }
    return { writeToken, offset: 0 }
  }

  private appendAliasWrite(payload: Record<string, unknown>, sessionId: string): unknown {
    const staged = this.stagedWrite
    const offset = payload.offset
    if (!staged || staged.token !== payload.writeToken || staged.sessionId !== sessionId ||
      !Number.isSafeInteger(offset) || offset !== staged.bytes.length || typeof payload.data !== 'string') {
      throw nativeError('SETTINGS_ALIAS_TOKEN_INVALID', 'Invalid staged write token or offset')
    }
    const bytes = decodeBase64(payload.data)
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_WRITE_CHUNK_BYTES ||
      staged.bytes.length + bytes.byteLength > staged.totalBytes) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Invalid staged chunk size')
    }
    staged.bytes.push(...bytes)
    return { writeToken: staged.token, offset: staged.bytes.length }
  }

  private commitAliasWrite(payload: Record<string, unknown>, sessionId: string): unknown {
    const staged = this.stagedWrite
    if (!staged || staged.token !== payload.writeToken || staged.sessionId !== sessionId ||
      staged.bytes.length !== staged.totalBytes) {
      throw nativeError('SETTINGS_ALIAS_TOKEN_INVALID', 'Staged write is incomplete')
    }
    let value: unknown
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(staged.bytes)))
    } catch {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Staged alias JSON is invalid')
    }
    if (!isRecord(value)) throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Alias projection must be a map')
    const { baseToken } = staged
    this.stagedWrite = null
    return this.commitValue(baseToken, value, sessionId)
  }

  private abortAliasWrite(payload: Record<string, unknown>, sessionId: string): unknown {
    const staged = this.stagedWrite
    const aborted = Boolean(staged && staged.token === payload.writeToken && staged.sessionId === sessionId)
    if (aborted) this.stagedWrite = null
    return { aborted }
  }

  private commitValue(baseToken: unknown, value: unknown, sessionId: string): unknown {
    this.validateBaseToken(baseToken, sessionId)
    if (!isRecord(value)) throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Alias projection must be a map')
    const candidateIsEmpty = Object.keys(value).length === 0
    const currentIsEmpty = (!this.aliasStoragePresent && this.aliasValue === null) ||
      (this.aliasStoragePresent && isRecord(this.aliasValue) && Object.keys(this.aliasValue).length === 0)
    const noOpMissingOrStoredEmpty = candidateIsEmpty && currentIsEmpty
    // Only this Core contract fact is modeled here; nonempty writes use direct fixture storage,
    // not the production semantic bucket merge.
    if (!noOpMissingOrStoredEmpty) {
      this.aliasValue = cloneJson(value)
      this.aliasStoragePresent = true
      this.aliasRevision += 1
    }
    this.aliasBases.clear()
    this.currentAliasBase = this.nextToken()
    this.aliasBases.set(this.currentAliasBase, { sessionId, revision: this.aliasRevision })
    const reply = {
      version: 1,
      success: true,
      baseToken: this.currentAliasBase,
      notificationDelivered: this.notificationDelivered
    }
    if (this.interruptCommitAfterPersist) {
      throw nativeError('SETTINGS_ALIAS_COMMIT_INTERRUPTED', 'Commit completed but the fixture dropped its reply')
    }
    return reply
  }

  private validateBaseToken(token: unknown, sessionId: string): void {
    if (typeof token !== 'string') throw nativeError('SETTINGS_ALIAS_BASE_NOT_READ', 'Alias baseline has not been read')
    const base = this.aliasBases.get(token)
    if (!base || token !== this.currentAliasBase || base.sessionId !== sessionId) {
      throw nativeError('SETTINGS_ALIAS_TOKEN_INVALID', 'Alias baseline token is invalid')
    }
    if (base.revision !== this.aliasRevision) {
      throw nativeError('SETTINGS_ALIAS_REVISION_CONFLICT', 'Aliases changed after the read')
    }
  }

  private assertPayload(payload: Record<string, unknown>): void {
    if (!isRecord(payload)) throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Payload must be a JSON object')
    if (encodeJson(payload).byteLength > MAX_REQUEST_BYTES) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Request exceeds 32 KiB')
    }
  }

  private assertResponse(value: unknown): void {
    if (encodeJson(value).byteLength > MAX_RESPONSE_BYTES) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Response exceeds 64 KiB')
    }
  }

  private assertExactKeys(value: Record<string, unknown>, expected: string[]): void {
    const keys = Object.keys(value)
    if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
      throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Unexpected operation payload fields')
    }
  }

  private nextToken(): string {
    this.sequence += 1
    const suffix = this.sequence.toString(16).padStart(12, '0')
    return `00000000-0000-4000-8000-${suffix}`
  }
}

export function createFixtureCommandCatalog(count = 1_024): SettingsCommandCatalog {
  return {
    commands: Array.from({ length: count }, (_, index) => ({
      name: `Fixture application ${index}`,
      path: `/Applications/fixture-${index}.app`,
      icon: `ztools-icon://fixture/${index}`,
      type: 'direct',
      subType: 'app'
    })),
    regexCommands: [{ name: 'Fixture regex', matchCmd: { match: '^fixture', type: 'text' } }],
    plugins: [{
      id: 'registered-fixture-plugin',
      name: 'fixture-plugin',
      enabled: false,
      features: [{ code: 'fixture', cmds: ['preserved command metadata'] }],
      unknownMetadata: { retained: true }
    }]
  }
}

export function createLegacyMissingTargetAliases(): Record<string, unknown> {
  // This is the normalized renderer projection expected after Core reads legacy rows;
  // the transport fixture does not implement Core's legacy normalization.
  return {
    'direct:app:/Applications/removed.app': [{ alias: 'legacy orphan alias' }],
    'missing-plugin:feature:old-command:text': [{ alias: 'uninstalled plugin alias', icon: 'legacy://icon' }],
    'direct:app:/Applications/current.app': [{ alias: 'current app alias', icon: 'app://icon' }]
  }
}

function encodeJson(value: unknown): Uint8Array {
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Value is not JSON serializable')
  }
  if (typeof json !== 'string') throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Value is not JSON serializable')
  return new TextEncoder().encode(json)
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let index = 0; index < bytes.byteLength; index += 1) binary += String.fromCharCode(bytes[index])
  return btoa(binary)
}

function decodeBase64(value: string): Uint8Array {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Invalid base64')
  }
  let binary: string
  try {
    binary = atob(value)
  } catch {
    throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Invalid base64')
  }
  if (btoa(binary) !== value) throw nativeError('ERR_ATOOLS_SETTINGS_PROTOCOL', 'Noncanonical base64')
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function nativeError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}
