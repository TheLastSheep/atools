import { safeHref } from './safeMarkdown'
import { exact, parseSnapshot, validId, type Snapshot, type Transport } from './protocol'
export type Channel =
  | 'update-info'
  | 'update-download-start'
  | 'update-download-progress'
  | 'update-downloaded'
  | 'update-download-failed'
const channels = new Set<Channel>([
  'update-info',
  'update-download-start',
  'update-download-progress',
  'update-downloaded',
  'update-download-failed'
])
export interface Projection {
  snapshot: Snapshot | null
  error: string
}
/** One popup owner, one listener, sequence-ordered snapshots; no page-supplied package data. */
export function createUpdaterBridge(windowId: string, transport: Transport) {
  if (!validId(windowId)) throw new Error('更新窗口身份无效。')
  const listeners = new Map<Channel, Set<(value?: unknown) => void>>()
  const projections = new Set<(value: Projection) => void>()
  let current: Snapshot | null = null,
    dead = false,
    unlisten: (() => void) | null = null
  let startPromise: Promise<void> | null = null,
    inFlight = false
  const stopListener = () => {
    try {
      unlisten?.()
    } catch {}
    unlisten = null
  }
  const emit = (channel: Channel, value?: unknown) => {
    for (const fn of [...(listeners.get(channel) ?? [])])
      try {
        fn(value)
      } catch {}
  }
  const publish = (error = '') => {
    for (const fn of [...projections])
      try {
        fn({ snapshot: current, error })
      } catch {}
  }
  function accept(raw: unknown): void {
    const next = parseSnapshot(raw)
    if (dead || (current && next.sequence <= current.sequence)) return
    current = next
    if (next.candidate)
      emit('update-info', {
        version: next.candidate.version,
        changelog: next.candidate.body ?? '',
        manualDownloadRequired: false,
        downloadStatus: { status: next.phase }
      })
    if (next.phase === 'downloading') {
      emit('update-download-start')
      const total = next.progress.total ?? 0
      emit('update-download-progress', {
        transferred: next.progress.downloaded,
        total,
        percent: total > 0 ? Math.min(100, (100 * next.progress.downloaded) / total) : 0
      })
    } else if (next.phase === 'downloaded') emit('update-downloaded')
    else if (next.error) emit('update-download-failed', { error: next.error.message })
    publish()
  }
  function ready(): Promise<void> {
    if (dead) return Promise.reject(new Error('更新窗口已关闭。'))
    if (startPromise) return startPromise
    startPromise = (async () => {
      const stop = await transport.listen((payload) => {
        if (dead) return
        try {
          if (exact(payload, ['windowId', 'snapshot']) && payload.windowId === windowId)
            accept(payload.snapshot)
        } catch {
          publish('更新窗口状态无效。')
        }
      })
      if (dead) {
        try {
          stop()
        } catch {}
        return
      }
      unlisten = stop
      accept(
        await transport.invoke('renderer_updater_window', { request: { op: 'ready', windowId } })
      )
    })().catch(() => {
      if (!dead) {
        publish('更新信息读取失败，请关闭窗口后重试。')
        stopListener()
        unlisten = null
        startPromise = null
      }
    })
    return startPromise
  }
  async function action(op: 'start' | 'install-downloaded'): Promise<{
    success: boolean
    error?: string
  }> {
    const candidateId = current?.candidate?.candidateId
    if (dead || !candidateId || inFlight)
      return { success: false, error: '更新状态已变化，请重试。' }
    inFlight = true
    const baseSequence = current?.sequence
    try {
      const raw = await transport.invoke('renderer_updater_window', {
        request: { op, windowId, candidateId }
      })
      if (dead) return { success: false, error: '更新窗口已关闭。' }
      const value = parseSnapshot(raw)
      accept(value)
      const authoritative = current
      // A late completion cannot outrank a newer event, even for the same candidate.
      if (
        dead ||
        authoritative?.candidate?.candidateId !== candidateId ||
        value.candidate?.candidateId !== candidateId ||
        value.sequence !== authoritative.sequence ||
        JSON.stringify(value) !== JSON.stringify(authoritative)
      )
        return {
          success: false,
          error: authoritative?.error?.message ?? '更新状态已变化，请重试。'
        }
      if (authoritative.error || authoritative.phase !== 'restarting')
        return { success: false, error: authoritative.error?.message ?? '更新状态已变化，请重试。' }
      return { success: true }
    } catch {
      const changed =
        dead ||
        current?.sequence !== baseSequence ||
        current?.candidate?.candidateId !== candidateId
      return {
        success: false,
        error: changed
          ? (current?.error?.message ?? '更新状态已变化，请重试。')
          : '更新失败，请重试。'
      }
    } finally {
      inFlight = false
    }
  }
  async function close(): Promise<boolean> {
    if (dead) return false
    try {
      const result = await transport.invoke('renderer_updater_window', {
        request: { op: 'close', windowId }
      })
      if (!exact(result, ['closed']) || result.closed !== true) throw new Error('close rejected')
      dispose()
      return true
    } catch {
      if (!dead) publish('当前无法关闭更新窗口，请稍后重试。')
      return false
    }
  }
  async function drag(): Promise<void> {
    if (dead) return
    try {
      const reply = await transport.invoke('renderer_updater_window', {
        request: { op: 'drag', windowId }
      })
      if (!exact(reply, ['started']) || reply.started !== true) throw new Error('drag rejected')
    } catch {
      if (!dead) publish('窗口拖动失败，请重试。')
    }
  }
  async function openLink(href: string): Promise<void> {
    const candidateId = current?.candidate?.candidateId,
      safe = safeHref(href)
    if (dead || !candidateId || !safe) return
    try {
      const reply = await transport.invoke('renderer_updater_window', {
        request: { op: 'open-link', windowId, candidateId, href: safe }
      })
      if (!exact(reply, ['opened']) || reply.opened !== true) throw new Error('open rejected')
    } catch {
      if (!dead) publish('链接打开失败，请重试。')
    }
  }
  function dispose(): void {
    if (!dead) {
      dead = true
      stopListener()
      unlisten = null
      listeners.clear()
      projections.clear()
    }
  }
  return {
    ready,
    close,
    openLink,
    drag,
    start: () => action('start'),
    installDownloaded: () => action('install-downloaded'),
    on(channel: string, callback: (value?: unknown) => void): () => void {
      if (!channels.has(channel as Channel) || dead) return () => {}
      const key = channel as Channel,
        set = listeners.get(key) ?? new Set()
      set.add(callback)
      listeners.set(key, set)
      return () => {
        set.delete(callback)
      }
    },
    subscribe(callback: (value: Projection) => void): () => void {
      if (dead) return () => {}
      projections.add(callback)
      try {
        callback({ snapshot: current, error: '' })
      } catch {}
      return () => {
        projections.delete(callback)
      }
    },
    dispose
  }
}
export type UpdaterBridge = ReturnType<typeof createUpdaterBridge>
