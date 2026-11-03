import { disposeUpdaterHost, getUpdaterBridge } from './hostBridge'
import type { Phase } from './protocol'
export interface UpdaterUiProjection {
  candidate: boolean
  busy: boolean
  phase: Phase
  status: 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
  error: string
}
export function bindUpdaterUi(callback: (state: UpdaterUiProjection) => void): () => void {
  const stop = getUpdaterBridge().subscribe(({ snapshot, error }) => {
    const phase = snapshot?.phase ?? 'idle'
    const noCandidate = !snapshot?.candidate || phase === 'checking'
    const status = noCandidate
      ? 'error'
      : phase === 'downloading' || phase === 'downloaded'
        ? phase
        : ['installing', 'restarting'].includes(phase)
          ? 'installing'
          : ['error', 'install-unknown', 'restart-pending'].includes(phase) || error
            ? 'error'
            : 'available'
    callback({
      busy: !!snapshot?.operationId,
      candidate: !!snapshot?.candidate && phase !== 'checking',
      phase,
      status,
      error:
        error ||
        (noCandidate
          ? phase === 'checking'
            ? '正在检查更新...'
            : phase === 'idle'
              ? '正在读取更新信息...'
              : '当前没有可用更新，可关闭此窗口。'
          : phase === 'install-unknown'
            ? '安装状态可能已改变，请确认后重试安装。'
            : phase === 'restart-pending'
              ? '更新已安装，重试只会重新启动。'
              : (snapshot?.error?.message ?? ''))
    })
  })
  return () => {
    stop()
    disposeUpdaterHost()
  }
}
export function openUpdaterLink(href: string): void {
  void getUpdaterBridge().openLink(href)
}

export function startUpdaterDrag(): void {
  void getUpdaterBridge().drag()
}
