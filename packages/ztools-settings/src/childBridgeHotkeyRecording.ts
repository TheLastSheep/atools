import type { SettingsBridgeTarget, SettingsPlatform, SettingsShortcutUpdateReply } from './childBridgeTypes'
import { HOTKEY_RECORDING_UNAVAILABLE_MESSAGE, SettingsBridgeProtocolError, isExactRecord } from './childBridgeProtocol'

export type HotkeyRecordingStopReason = 'timeout' | 'cancelled' | 'unavailable'
type Callback<T> = (value: T) => void
interface Options {
  sessionId: string
  platform: SettingsPlatform
  isLive: () => boolean
  invokeNative: (operation: 'startHotkeyRecording' | 'stopHotkeyRecording', payload: Record<string, unknown>) => Promise<unknown>
}
export interface SettingsHotkeyRecordingController {
  attach(target: SettingsBridgeTarget): void
  start(): Promise<SettingsShortcutUpdateReply>
  stop(): Promise<void>
  onRecorded(callback: unknown): () => void
  onStopped(callback: unknown): () => void
  dispose(): void
}

export function createSettingsHotkeyRecordingController(options: Options): SettingsHotkeyRecordingController {
  let target: SettingsBridgeTarget | null = null
  let previous: SettingsBridgeTarget['__ATOOLS_SETTINGS_DELIVER_HOTKEY__']
  let generation = 0
  let active: number | null = null
  let needsStop: number | null = null
  let stopping: { generation: number; promise: Promise<void> } | null = null
  let disposed = false
  const recorded = new Set<Callback<string>>()
  const stopped = new Set<Callback<HotkeyRecordingStopReason>>()
  let receivers: Callback<string>[] = []
  const live = () => !disposed && target !== null && options.isLive()
  const unavailable = (): SettingsShortcutUpdateReply => ({ success: false, error: HOTKEY_RECORDING_UNAVAILABLE_MESSAGE })

  function subscribe<T>(set: Set<Callback<T>>, callback: unknown): () => void {
    if (typeof callback !== 'function' || set.size >= 16) throw new SettingsBridgeProtocolError()
    const typed = callback as Callback<T>
    if (disposed) return () => {}
    set.add(typed)
    return () => { set.delete(typed) }
  }
  function ack(raw: unknown, expected: number): boolean {
    if (!isExactRecord(raw, ['version', 'sessionId', 'generation', 'active', 'mode']) ||
      raw.version !== 1 || raw.sessionId !== options.sessionId || raw.generation !== expected ||
      typeof raw.active !== 'boolean' || (raw.active
        ? raw.mode !== 'borrowed-main' && raw.mode !== 'temporary' : raw.mode !== null)) throw new SettingsBridgeProtocolError()
    return raw.active
  }
  async function start(): Promise<SettingsShortcutUpdateReply> {
    if (!live() || generation >= Number.MAX_SAFE_INTEGER ||
      /^#\/shortcuts(?:[?#]|$)/i.test(target?.location?.hash ?? '')) return unavailable()
    const current = ++generation
    active = current
    needsStop = current
    receivers = [...recorded]
    try {
      const raw = await options.invokeNative('startHotkeyRecording', { generation: current })
      const enabled = ack(raw, current)
      if (!enabled && needsStop === current) needsStop = null
      if (!live() || active !== current) return unavailable()
      if (enabled) return { success: true }
    } catch {}
    if (active === current) active = null
    return unavailable()
  }
  function requestStop(current: number): Promise<void> {
    if (stopping?.generation === current) return stopping.promise
    const promise = (async () => {
      if (ack(await options.invokeNative('stopHotkeyRecording', { generation: current }), current)) throw new SettingsBridgeProtocolError()
      if (needsStop === current) needsStop = null
    })()
    const pending = { generation: current, promise }
    stopping = pending
    const clear = () => { if (stopping === pending) stopping = null }
    void promise.then(clear, clear)
    return promise
  }
  function stop(): Promise<void> {
    active = null
    receivers = []
    return live() && needsStop !== null ? requestStop(needsStop) : Promise.resolve()
  }
  function notifyStopped(reason: HotkeyRecordingStopReason): void {
    for (const callback of [...stopped]) {
      if (stopped.has(callback)) { try { callback(reason) } catch {} }
    }
  }
  function cancel(): void {
    if (!live()) return
    void stop().catch(() => {})
    notifyStopped('cancelled')
  }
  function deliver(raw: unknown): void {
    if (!live() || active === null) return
    try {
      const status = (raw as { status?: unknown } | null)?.status
      const keys = ['version', 'sessionId', 'generation', 'status', status === 'recorded' ? 'shortcut' : 'reason']
      if (!isExactRecord(raw, keys) || raw.version !== 1 || raw.sessionId !== options.sessionId || raw.generation !== active) return
      if (status === 'recorded') {
        const shortcut = options.platform === 'darwin' ? 'Option+Space' : 'Alt+Space'
        if (raw.shortcut !== shortcut) return
        const callbacks = receivers
        active = null
        needsStop = null
        receivers = []
        const current = generation
        for (const callback of callbacks) {
          if (generation !== current) break
          if (recorded.has(callback)) { try { callback(shortcut) } catch {} }
        }
      } else if (status === 'stopped' && ['timeout', 'cancelled', 'unavailable'].includes(raw.reason as string)) {
        active = null
        if (raw.reason !== 'unavailable') needsStop = null
        receivers = []
        notifyStopped(raw.reason as HotkeyRecordingStopReason)
      }
    } catch {}
  }
  function attach(next: SettingsBridgeTarget): void {
    if (target || disposed) throw new SettingsBridgeProtocolError()
    target = next
    previous = next.__ATOOLS_SETTINGS_DELIVER_HOTKEY__
    next.__ATOOLS_SETTINGS_DELIVER_HOTKEY__ = deliver
    next.addEventListener('hashchange', cancel)
  }
  function dispose(): void {
    if (disposed) return
    disposed = true
    active = null
    receivers = []
    if (target && needsStop !== null) void requestStop(needsStop).catch(() => {})
    notifyStopped('cancelled')
    if (target) {
      target.removeEventListener('hashchange', cancel)
      if (target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__ === deliver) target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__ = previous
    }
    target = null
    recorded.clear()
    stopped.clear()
  }
  return { attach, start, stop, onRecorded: callback => subscribe(recorded, callback),
    onStopped: callback => subscribe(stopped, callback), dispose }
}
