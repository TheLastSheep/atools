import { createUpdaterAppearance, type UpdaterAppearance } from './appearance'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createUpdaterBridge, type UpdaterBridge } from './bridge'
import { validId, type Transport } from './protocol'
interface HostWindow {
  __ATOOLS_UPDATER_WINDOW_ID__?: unknown
  electron?: unknown
  ztools?: unknown
}
export interface UpdaterHostTransport extends Transport {
  listenAppearance(callback: (payload: unknown) => void): Promise<() => void>
}
let activeAppearance: UpdaterAppearance | null = null
export function getUpdaterAppearance(): UpdaterAppearance {
  if (!activeAppearance) throw Error('更新窗口材质桥接不可用。')
  return activeAppearance
}
let active: UpdaterBridge | null = null
let stopHost: (() => void) | null = null
export function disposeUpdaterHost(): void {
  stopHost?.()
}
export function getUpdaterBridge(): UpdaterBridge {
  if (!active) throw new Error('更新窗口桥接不可用。')
  return active
}
export function installUpdaterHost(owner: Window, transport?: UpdaterHostTransport): () => void {
  if (active) throw new Error('更新窗口桥接已安装。')
  const host = owner as unknown as HostWindow,
    windowId = host.__ATOOLS_UPDATER_WINDOW_ID__
  if (!validId(windowId)) throw new Error('更新窗口身份无效。')
  const wire: UpdaterHostTransport = transport ?? {
    invoke: (command, args) => invoke(command, args),
    listen: (callback) =>
      listen('renderer-updater-state', (event) => callback(event.payload), {
        target: { kind: 'Webview', label: `renderer-updater-${windowId}` }
      }),
    listenAppearance: (callback: (payload: unknown) => void) =>
      listen('renderer-updater-appearance', (event) => callback(event.payload), {
        target: { kind: 'Webview', label: `renderer-updater-${windowId}` }
      })
  }
  const bridge = createUpdaterBridge(windowId, wire)
  const appearance = createUpdaterAppearance(windowId, {
    invoke: (command, args) => wire.invoke(command, args),
    listen: (callback) => wire.listenAppearance(callback)
  })
  activeAppearance = appearance
  const previous = { electron: host.electron, ztools: host.ztools }
  active = bridge
  const electron = {
    ipcRenderer: {
      on: (channel: string, callback: (payload?: unknown) => void) => bridge.on(channel, callback),
      send(channel: string) {
        if (channel === 'updater:window-ready') void bridge.ready()
        else if (channel === 'updater:close-window')
          void bridge.close().then((closed) => {
            if (closed) dispose()
          })
        else throw new Error('更新窗口操作不可用。')
      }
    }
  }
  const ztools = {
    getWindowMaterial: appearance.getWindowMaterial,
    onUpdateWindowMaterial: appearance.onMaterial,
    onUpdateAcrylicOpacity: appearance.onOpacity,
    updater: { startUpdate: bridge.start, installDownloadedUpdate: bridge.installDownloaded }
  }
  host.electron = electron
  host.ztools = ztools
  let dead = false
  function dispose(): void {
    if (dead) return
    dead = true
    bridge.dispose()
    appearance.dispose()
    if (activeAppearance === appearance) activeAppearance = null
    owner.removeEventListener('pagehide', dispose)
    if (host.electron === electron) host.electron = previous.electron
    if (host.ztools === ztools) host.ztools = previous.ztools
    if (active === bridge) active = null
    if (stopHost === dispose) stopHost = null
  }
  stopHost = dispose
  owner.addEventListener('pagehide', dispose, { once: true })
  return dispose
}
