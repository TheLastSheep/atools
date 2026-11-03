import { SettingsBridgeProtocolError, isExactRecord, isRecord } from './childBridgeProtocol'

export interface AppTarget { kind: 'app'; path: string; name: string }
export interface AppBinding { rowId: string; target: AppTarget; shortcut: string; enabled: boolean }
export interface AppSnapshot {
  version: 1
  revision: string
  rows: Record<string, unknown>[]
  bindings: AppBinding[]
  runtime: { rowId: string; state: 'registered' | 'disabled' | 'missing' | 'conflict' | 'unavailable'; error: string | null }[]
}
export type AppMutation =
  | { kind: 'create'; shortcut: string; target: AppTarget; enabled: boolean; autoCopy: false }
  | { kind: 'update' | 'adopt'; rowId: string; shortcut: string; target: AppTarget; enabled: boolean; autoCopy: false }
  | { kind: 'remove'; rowId: string }
  | { kind: 'setEnabled'; rowId: string; enabled: boolean }
export interface AppReceipt {
  version: 1
  persisted: boolean | null
  changed: boolean | null
  runtimeApplied: boolean | null
  notificationDelivered: boolean | null
  error: { code: string; message: string } | null
  snapshot: AppSnapshot | null
}
const hex = /^[0-9a-f]{32}$/
const states = new Set(['registered', 'disabled', 'missing', 'conflict', 'unavailable'])
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && !v.includes('\0')
const rowStrings = new Set(['id', 'shortcut', 'target', 'configKey'])
const rowBooleans = new Set(['enabled', 'autoCopy', 'configurable', 'preScreenshotOptimization'])
const projectedRow = (row: unknown) => isRecord(row) && Object.entries(row).every(([key, value]) =>
  rowStrings.has(key) ? typeof value === 'string' : rowBooleans.has(key) && typeof value === 'boolean')
const byteLength = (value: string) => new TextEncoder().encode(value).length
const nullableBool = (v: unknown) => v === null || typeof v === 'boolean'
function target(value: unknown): value is AppTarget {
  return isExactRecord(value, ['kind', 'path', 'name']) && value.kind === 'app' && text(value.path) && text(value.name) && byteLength(value.path) <= 16 * 1024 && byteLength(value.name) <= 4 * 1024
}
export function validateAppMutation(raw: unknown): AppMutation {
  if (!isRecord(raw) || typeof raw.kind !== 'string') throw new SettingsBridgeProtocolError()
  if (raw.kind === 'remove') {
    if (!isExactRecord(raw, ['kind', 'rowId']) || !text(raw.rowId)) throw new SettingsBridgeProtocolError()
  } else if (raw.kind === 'setEnabled') {
    if (!isExactRecord(raw, ['kind', 'rowId', 'enabled']) || !text(raw.rowId) || typeof raw.enabled !== 'boolean') throw new SettingsBridgeProtocolError()
  } else if (raw.kind === 'create' || raw.kind === 'update' || raw.kind === 'adopt') {
    const keys = ['kind', 'shortcut', 'target', 'enabled', 'autoCopy']
    if (raw.kind !== 'create') keys.push('rowId')
    if (!isExactRecord(raw, keys) || !text(raw.shortcut) || !target(raw.target) || typeof raw.enabled !== 'boolean' ||
      raw.autoCopy !== false || (raw.kind !== 'create' && !text(raw.rowId))) throw new SettingsBridgeProtocolError()
  } else throw new SettingsBridgeProtocolError()
  return structuredClone(raw) as unknown as AppMutation
}
export function validateAppSnapshot(raw: unknown): AppSnapshot {
  if (!isExactRecord(raw, ['version', 'revision', 'rows', 'bindings', 'runtime']) || raw.version !== 1 ||
    typeof raw.revision !== 'string' || !hex.test(raw.revision) || !Array.isArray(raw.rows) || raw.rows.length > 4096 ||
    !raw.rows.every(projectedRow) || !Array.isArray(raw.bindings) || raw.bindings.length > 64 || !Array.isArray(raw.runtime) || raw.runtime.length > 64)
    throw new SettingsBridgeProtocolError()
  const ids = new Set<string>()
  for (const binding of raw.bindings) {
    if (!isExactRecord(binding, ['rowId', 'target', 'shortcut', 'enabled']) || !text(binding.rowId) || ids.has(binding.rowId) ||
      !target(binding.target) || !text(binding.shortcut) || typeof binding.enabled !== 'boolean') throw new SettingsBridgeProtocolError()
    ids.add(binding.rowId)
  }
  const runtimeIds = new Set<string>()
  for (const entry of raw.runtime) {
    if (!isExactRecord(entry, ['rowId', 'state', 'error']) || !text(entry.rowId) || runtimeIds.has(entry.rowId) ||
      !ids.has(entry.rowId) || typeof entry.state !== 'string' || !states.has(entry.state) ||
      !(entry.error === null || typeof entry.error === 'string')) throw new SettingsBridgeProtocolError()
    runtimeIds.add(entry.rowId)
  }
  return structuredClone(raw) as unknown as AppSnapshot
}
export function validateAppReceipt(raw: unknown): AppReceipt {
  if (!isExactRecord(raw, ['version', 'persisted', 'changed', 'runtimeApplied', 'notificationDelivered', 'error', 'snapshot']) ||
    raw.version !== 1 || !nullableBool(raw.persisted) || !nullableBool(raw.changed) || !nullableBool(raw.runtimeApplied) ||
    !nullableBool(raw.notificationDelivered) || !(raw.error === null || (isExactRecord(raw.error, ['code', 'message']) &&
      text(raw.error.code) && typeof raw.error.message === 'string'))) throw new SettingsBridgeProtocolError()
  return { ...raw, snapshot: raw.snapshot === null ? null : validateAppSnapshot(raw.snapshot) } as AppReceipt
}
export function createAppGlobalShortcutsController(options: {
  invoke(operation: 'readAppGlobalShortcuts' | 'mutateAppGlobalShortcut', payload: Record<string, unknown>): Promise<unknown>
  isLive(): boolean
}) {
  let snapshot: AppSnapshot | null = null
  let busy = false
  let epoch = 0
  function invalidate() { snapshot = null; epoch++ }
  async function read(): Promise<AppSnapshot> {
    if (!options.isLive() || busy) throw new SettingsBridgeProtocolError()
    const current = ++epoch
    const result = validateAppSnapshot(await options.invoke('readAppGlobalShortcuts', {}))
    if (!options.isLive() || epoch !== current) throw new SettingsBridgeProtocolError()
    snapshot = result
    return structuredClone(result)
  }
  async function mutate(mutation: AppMutation): Promise<AppReceipt> {
    if (!options.isLive() || busy || !snapshot) throw new SettingsBridgeProtocolError()
    const safeMutation = validateAppMutation(mutation)
    busy = true
    const current = ++epoch
    const revision = snapshot.revision
    snapshot = null
    try {
      const result = validateAppReceipt(await options.invoke('mutateAppGlobalShortcut', { revision, mutation: safeMutation }))
      if (!options.isLive() || current !== epoch) throw new SettingsBridgeProtocolError()
      snapshot = result.error || result.persisted === null ? null : result.snapshot
      return result
    } finally { busy = false }
  }
  return { read, mutate, invalidate }
}
