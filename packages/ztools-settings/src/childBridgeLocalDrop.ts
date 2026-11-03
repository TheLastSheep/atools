import type { SettingsBridgeTarget } from './childBridgeTypes'
import { SettingsBridgeError, SettingsBridgeProtocolError, assertJsonByteBudget } from './childBridgeProtocol'

export type SettingsNativeLocalDropPhase = 'enter' | 'leave' | 'result'

export interface SettingsNativeLocalDropDto {
  version: 1
  sessionId: string
  revision: number
  phase: SettingsNativeLocalDropPhase
  added: number
  failed: number
  busy: boolean
  rejected: boolean
}

export type SettingsNativeLocalDropCallback = (value: SettingsNativeLocalDropDto) => void

export interface SettingsChildLocalDropController {
  attach(target: SettingsBridgeTarget): void
  subscribe(callback: unknown): () => void
  dispose(): void
}

export interface SettingsChildLocalDropControllerOptions {
  sessionId: string
  isLive: () => boolean
  getHash?: () => string
}

const MAX_LOCAL_DROP_BYTES = 4 * 1024
const DTO_KEYS = [
  'version', 'sessionId', 'revision', 'phase', 'added', 'failed', 'busy', 'rejected'
] as const
const NOOP = () => {}

export function createSettingsChildLocalDropController(
  options: SettingsChildLocalDropControllerOptions
): SettingsChildLocalDropController {
  let target: SettingsBridgeTarget | null = null
  let previousDeliver: SettingsBridgeTarget['__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__']
  let subscriber: { callback: SettingsNativeLocalDropCallback; generation: number } | null = null
  let lastDelivered: SettingsNativeLocalDropDto | null = null
  let lastRevision = 0
  let generation = 0
  let disposed = false

  function currentHash(): string {
    try {
      return options.getHash?.() ?? target?.location?.hash ?? ''
    } catch {
      return ''
    }
  }

  function isLocalLaunchRoute(): boolean {
    const hash = currentHash()
    if (hash === '#/localLaunch') return true
    const match = /^#\/localLaunch\?_t=([1-9][0-9]{0,15})$/.exec(hash)
    return match !== null && Number.isSafeInteger(Number(match[1]))
  }

  function clearSubscription(notifyLeave: boolean): void {
    const current = subscriber
    subscriber = null
    generation += 1
    const previous = lastDelivered
    lastDelivered = null
    if (!notifyLeave || !current || !previous || previous.phase === 'leave' || !options.isLive()) return
    try {
      current.callback({ ...previous, phase: 'leave', added: 0, failed: 0, busy: false, rejected: false })
    } catch {}
  }

  function handleHashChange(): void {
    clearSubscription(true)
  }

  function readDto(value: unknown): SettingsNativeLocalDropDto | null {
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return null
      const keys = Reflect.ownKeys(value)
      if (keys.length !== DTO_KEYS.length || keys.some((key) =>
        typeof key !== 'string' || !(DTO_KEYS as readonly string[]).includes(key))) return null

      const record: Record<string, unknown> = {}
      for (const key of DTO_KEYS) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
        record[key] = descriptor.value
      }
      const dto = record as unknown as SettingsNativeLocalDropDto
      assertJsonByteBudget(dto, MAX_LOCAL_DROP_BYTES)
      if (dto.version !== 1 || dto.sessionId !== options.sessionId ||
        !Number.isSafeInteger(dto.revision) || dto.revision <= lastRevision ||
        !['enter', 'leave', 'result'].includes(dto.phase) ||
        !Number.isInteger(dto.added) || dto.added < 0 || dto.added > 64 ||
        !Number.isInteger(dto.failed) || dto.failed < 0 || dto.failed > 64 ||
        dto.added + dto.failed > 64 || typeof dto.busy !== 'boolean' ||
        typeof dto.rejected !== 'boolean' || (dto.busy && dto.rejected) ||
        ((dto.busy || dto.rejected) && (dto.added !== 0 || dto.failed !== 0)) ||
        ((dto.phase === 'enter' || dto.phase === 'leave') &&
          (dto.added !== 0 || dto.failed !== 0 || dto.busy || dto.rejected))) return null
      return { ...dto }
    } catch {
      return null
    }
  }

  function deliver(value: unknown): void {
    if (disposed || !target || !options.isLive()) return
    const dto = readDto(value)
    if (!dto) return
    lastRevision = dto.revision
    const current = subscriber
    if (!current || !isLocalLaunchRoute() || current.generation !== generation) return
    lastDelivered = dto
    try {
      current.callback({ ...dto })
    } catch {}
  }

  function attach(nextTarget: SettingsBridgeTarget): void {
    if (disposed || target) throw new SettingsBridgeError(
      'ERR_ATOOLS_SETTINGS_LOCAL_DROP_ATTACHED', '本地拖放桥接已初始化。'
    )
    target = nextTarget
    previousDeliver = nextTarget.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__
    nextTarget.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__ = deliver
    nextTarget.addEventListener('hashchange', handleHashChange)
  }

  function subscribe(callback: unknown): () => void {
    if (typeof callback !== 'function') throw new SettingsBridgeProtocolError()
    if (disposed || !target || !options.isLive() || !isLocalLaunchRoute()) return NOOP
    if (subscriber) throw new SettingsBridgeError(
      'ERR_ATOOLS_SETTINGS_CALLBACK_LIMIT', '监听数量已达上限。'
    )
    const token = ++generation
    lastDelivered = null
    subscriber = { callback: callback as SettingsNativeLocalDropCallback, generation: token }
    let active = true
    return () => {
      if (!active) return
      active = false
      if (subscriber?.generation === token) {
        subscriber = null
        generation += 1
      }
    }
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    subscriber = null
    lastDelivered = null
    generation += 1
    if (!target) return
    target.removeEventListener('hashchange', handleHashChange)
    if (target.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__ === deliver) {
      target.__ATOOLS_SETTINGS_DELIVER_LOCAL_DROP__ = previousDeliver
    }
    target = null
  }

  return { attach, subscribe, dispose }
}
