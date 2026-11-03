import { isExactRecord } from './childBridgeProtocol'
import type { AppTarget } from './appGlobalShortcutsController'

export interface AppShortcutIntent { version: 1; id: string; sessionId: string; sequence: number; target: AppTarget }
const hex = /^[0-9a-f]{32}$/
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && !value.includes('\0')
export function parseAppShortcutIntent(raw: unknown, sessionId: string): AppShortcutIntent | null {
  if (!isExactRecord(raw, ['version', 'id', 'sessionId', 'sequence', 'target']) || raw.version !== 1 ||
    typeof raw.id !== 'string' || !hex.test(raw.id) || raw.sessionId !== sessionId || !hex.test(sessionId) ||
    !Number.isSafeInteger(raw.sequence) || (raw.sequence as number) <= 0 ||
    !isExactRecord(raw.target, ['kind', 'path', 'name']) || raw.target.kind !== 'app' ||
    !text(raw.target.path) || !text(raw.target.name) || new TextEncoder().encode(raw.target.path).length > 16 * 1024 ||
    new TextEncoder().encode(raw.target.name).length > 4 * 1024) return null
  return structuredClone(raw) as unknown as AppShortcutIntent
}
type Ack = (packet: { id: string; sequence: number; accepted: boolean }) => Promise<unknown>
export function createAppShortcutIntentController(sessionId: string, onIntent: (intent: AppShortcutIntent) => void, ack: Ack = async () => {}) {
  let highestSequence = 0
  let lastId = ''
  let pending: AppShortcutIntent | null = null
  let disposed = false
  const send = (intent: AppShortcutIntent, accepted: boolean) => {
    void Promise.resolve().then(() => ack({ id: intent.id, sequence: intent.sequence, accepted })).catch(() => {})
  }
  function complete(id: string, sequence: number, accepted: boolean): boolean {
    if (disposed || !pending || pending.id !== id || pending.sequence !== sequence || typeof accepted !== 'boolean') return false
    const intent = pending; pending = null; send(intent, accepted); return true
  }
  return {
    deliver(raw: unknown): boolean {
      const intent = parseAppShortcutIntent(raw, sessionId)
      if (disposed || !intent) return false
      if (pending?.id === intent.id && pending.sequence === intent.sequence) return false
      if (intent.sequence <= highestSequence || intent.id === lastId) { send(intent, false); return false }
      if (pending) send(pending, false)
      highestSequence = intent.sequence; lastId = intent.id; pending = intent
      try { onIntent(intent) } catch { complete(intent.id, intent.sequence, false); return false }
      return true
    },
    complete,
    dispose(): void {
      if (disposed) return
      if (pending) send(pending, false)
      pending = null; disposed = true
    }
  }
}

type IntentReceiverTarget = EventTarget & {
  __ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__?: (packet: unknown) => boolean
  __ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__?: (id: string, sequence: number, accepted: boolean) => boolean
}
export function installAppShortcutIntentReceiver(target: IntentReceiverTarget, sessionId: string, ack: Ack = async () => {}): () => void {
  const previous = target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__
  const previousComplete = target.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__
  const controller = createAppShortcutIntentController(sessionId, packet => {
    target.dispatchEvent(new CustomEvent('atools-app-shortcuts-intent', { detail: packet }))
  }, ack)
  const receive = (packet: unknown) => controller.deliver(packet)
  const complete = (id: string, sequence: number, accepted: boolean) => controller.complete(id, sequence, accepted)
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    controller.dispose()
    target.removeEventListener('pagehide', dispose)
    if (target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__ === receive) target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__ = previous
    if (target.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__ === complete) target.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__ = previousComplete
  }
  target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__ = receive
  target.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__ = complete
  target.addEventListener('pagehide', dispose, { once: true })
  return dispose
}
