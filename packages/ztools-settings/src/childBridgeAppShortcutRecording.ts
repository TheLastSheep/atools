import type { SettingsBridgeTarget, SettingsShortcutUpdateReply } from './childBridgeTypes'
import { HOTKEY_RECORDING_UNAVAILABLE_MESSAGE, SettingsBridgeProtocolError, isExactRecord, boundedUtf8String } from './childBridgeProtocol'

type Reason = 'timeout' | 'cancelled' | 'unavailable'
type Notice = { version: 1; sessionId: string; generation: number; token: string; status: 'recorded'; shortcut: string } |
  { version: 1; sessionId: string; generation: number; token: string; status: 'stopped'; reason: Reason; drained: boolean }
type Callback<T> = (value: T) => void
interface Options {
  sessionId: string
  isLive: () => boolean
  reportDraining: () => void
  invokeNative: (operation: 'startAppShortcutRecording' | 'stopAppShortcutRecording', payload: Record<string, unknown>) => Promise<unknown>
}
interface Run {
  generation: number; token: string | null; receiving: boolean; buffered: Notice | null
  start: Promise<SettingsShortcutUpdateReply>; stop: Promise<void> | null
  resolveDrain: (() => void) | null; rejectDrain: ((reason: unknown) => void) | null
  drained: boolean; consumed: boolean; receivers: Callback<string>[]; stoppedReceivers: Callback<Reason>[]
}
const tokenValid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{32}$/.test(value)
export function createSettingsAppShortcutRecordingController(options: Options) {
  let target: SettingsBridgeTarget | null = null
  let previous: SettingsBridgeTarget['__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__']
  let generation = 0, disposed = false
  let run: Run | null = null
  const recorded = new Set<Callback<string>>(), stopped = new Set<Callback<Reason>>()
  const live = () => !disposed && !!target && options.isLive()
  const unavailable = (): SettingsShortcutUpdateReply => ({ success: false, error: HOTKEY_RECORDING_UNAVAILABLE_MESSAGE })
  function subscribe<T>(set: Set<Callback<T>>, callback: unknown): () => void {
    if (typeof callback !== 'function' || set.size >= 16) throw new SettingsBridgeProtocolError()
    if (disposed) return () => {}
    const cb = callback as Callback<T>; set.add(cb); return () => { set.delete(cb) }
  }
  function ack(raw: unknown, current: Run) {
    if (!isExactRecord(raw, ['version', 'sessionId', 'generation', 'token', 'active', 'drained']) ||
      raw.version !== 1 || raw.sessionId !== options.sessionId || raw.generation !== current.generation ||
      !(raw.token === null || tokenValid(raw.token)) || typeof raw.active !== 'boolean' || typeof raw.drained !== 'boolean' ||
      (raw.active && (raw.drained || raw.token === null))) throw new SettingsBridgeProtocolError()
    return raw as { token: string | null; active: boolean; drained: boolean }
  }
  function deliver(raw: unknown): void {
    const current = run
    if (!current || disposed) return
    try {
    const status = (raw as { status?: unknown } | null)?.status
    const keys = status === 'recorded' ? ['version', 'sessionId', 'generation', 'token', 'status', 'shortcut'] :
      ['version', 'sessionId', 'generation', 'token', 'status', 'reason', 'drained']
    if (!isExactRecord(raw, keys) || raw.version !== 1 || raw.sessionId !== options.sessionId ||
      raw.generation !== current.generation || !tokenValid(raw.token)) return
    if (status === 'recorded') {
      if (!boundedUtf8String(raw.shortcut, 256) || !raw.shortcut) return
    } else if (status !== 'stopped' || !['timeout', 'cancelled', 'unavailable'].includes(raw.reason as string) || typeof raw.drained !== 'boolean') return
    const notice = raw as Notice
    if (!current.token) { if (!current.buffered) current.buffered = notice; return }
    if (notice.token !== current.token) return
    if (notice.status === 'recorded') {
      if (!current.receiving) return
      current.receiving = false
      current.consumed = true
      for (const cb of current.receivers) if (recorded.has(cb)) { try { cb(notice.shortcut) } catch {} }
    } else {
      const notify = current.receiving
      current.receiving = false
      if (notice.drained) { current.drained = true; current.resolveDrain?.(); current.resolveDrain = null; current.rejectDrain = null }
      if (notify) for (const cb of current.stoppedReceivers) if (stopped.has(cb)) { try { cb(notice.reason) } catch {} }
    }
    } catch {}
  }
  function start(): Promise<SettingsShortcutUpdateReply> {
    if (!live() || run || generation >= Number.MAX_SAFE_INTEGER || !/^#\/shortcuts(?:[?#]|$)/i.test(target?.location?.hash ?? '')) return Promise.resolve(unavailable())
    const current: Run = { generation: ++generation, token: null, receiving: true, buffered: null, start: Promise.resolve(unavailable()), stop: null, resolveDrain: null, rejectDrain: null, drained: false, consumed: false, receivers: [...recorded], stoppedReceivers: [...stopped] }
    run = current
    current.start = (async () => {
      try {
        const result = ack(await options.invokeNative('startAppShortcutRecording', { generation: current.generation }), current)
        if (!result.active || !result.token) throw new SettingsBridgeProtocolError()
        if (current.token && current.token !== result.token) throw new SettingsBridgeProtocolError()
        current.token = result.token
        const buffered = current.buffered; current.buffered = null
        if (buffered) deliver(buffered)
        if (live() && run === current && (!current.stop || current.consumed)) return { success: true }
      } catch {}
      current.receiving = false
      return unavailable()
    })()
    return current.start
  }
  function stop(): Promise<void> {
    const current = run
    if (!current) return Promise.resolve()
    current.receiving = false; current.receivers = []
    if (current.stop) return current.stop
    current.stop = (async () => {
      const result = ack(await options.invokeNative('stopAppShortcutRecording', { generation: current.generation }), current)
      if (result.active || (current.token && result.token !== current.token)) throw new SettingsBridgeProtocolError()
      if (result.token) current.token = result.token
      await current.start
      if (result.token !== current.token) throw new SettingsBridgeProtocolError()
      if (!result.drained && !current.drained) {
        try { options.reportDraining() } catch {}
        await new Promise<void>((resolve, reject) => { current.resolveDrain = resolve; current.rejectDrain = reject })
      }
      if (run === current) run = null
    })()
    return current.stop
  }
  function cancel() { const current = run; const notify = current?.receiving; void stop().catch(() => {}); if (notify) for (const cb of current.stoppedReceivers) if (stopped.has(cb)) { try { cb('cancelled') } catch {} } }
  function attach(next: SettingsBridgeTarget) {
    if (target || disposed) throw new SettingsBridgeProtocolError()
    target = next; previous = next.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__
    next.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__ = deliver
    next.addEventListener('hashchange', cancel)
  }
  function dispose() {
    if (disposed) return
    void stop().catch(() => {})
    disposed = true
    if (target) { target.removeEventListener('hashchange', cancel); if (target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__ === deliver) target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__ = previous }
    target = null; recorded.clear(); stopped.clear()
  }
  return { attach, start, stop, onRecorded: (cb: unknown) => subscribe(recorded, cb), onStopped: (cb: unknown) => subscribe(stopped, cb), dispose }
}
