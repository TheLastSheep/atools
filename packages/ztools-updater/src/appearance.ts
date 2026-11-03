import { exact, validId, type Transport } from './protocol'
export type Material = 'none' | 'acrylic' | 'mica' | 'tabbed'
export interface Appearance {
  windowId: string
  sequence: number
  platform: 'darwin' | 'win32' | 'linux'
  material: Material
  nativeMaterial: 'none' | 'fullscreen-ui'
  materialApplied: boolean
  theme: 'system' | 'light' | 'dark'
  effectiveTheme: 'light' | 'dark'
  opacity: number | null
  opacityApplied: boolean
  acrylicOpacity: { light: number; dark: number }
  error: { code: string; message: string } | null
}
export interface AppearanceTransport {
  invoke: Transport['invoke']
  listen(callback: (value: unknown) => void): Promise<() => void>
}
function finite(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}
export function parseAppearance(raw: unknown): Appearance {
  const reject = (): never => {
    throw Error('更新窗口材质状态无效。')
  }
  if (
    !exact(raw, [
      'windowId',
      'sequence',
      'platform',
      'material',
      'nativeMaterial',
      'materialApplied',
      'theme',
      'effectiveTheme',
      'opacity',
      'opacityApplied',
      'acrylicOpacity',
      'error'
    ]) ||
    !validId(raw.windowId) ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 0 ||
    !['darwin', 'win32', 'linux'].includes(raw.platform as string) ||
    !['none', 'acrylic', 'mica', 'tabbed'].includes(raw.material as string) ||
    !['none', 'fullscreen-ui'].includes(raw.nativeMaterial as string) ||
    typeof raw.materialApplied !== 'boolean' ||
    !['system', 'light', 'dark'].includes(raw.theme as string) ||
    !['light', 'dark'].includes(raw.effectiveTheme as string) ||
    !(raw.opacity === null || finite(raw.opacity, 0, 1)) ||
    (raw.opacityApplied === true && raw.opacity === null) ||
    typeof raw.opacityApplied !== 'boolean'
  )
    return reject()
  const acrylic = raw.acrylicOpacity,
    error = raw.error
  if (
    !exact(acrylic, ['light', 'dark']) ||
    !finite(acrylic.light, 0, 100) ||
    !finite(acrylic.dark, 0, 100) ||
    !Number.isInteger(acrylic.light) ||
    !Number.isInteger(acrylic.dark)
  )
    return reject()
  if (
    error !== null &&
    (!exact(error, ['code', 'message']) ||
      typeof error.code !== 'string' ||
      typeof error.message !== 'string' ||
      new TextEncoder().encode(error.code).length > 128 ||
      new TextEncoder().encode(error.message).length > 1024)
  )
    return reject()
  return {
    windowId: raw.windowId,
    sequence: raw.sequence as number,
    platform: raw.platform as Appearance['platform'],
    material: raw.material as Material,
    nativeMaterial: raw.nativeMaterial as Appearance['nativeMaterial'],
    materialApplied: raw.materialApplied,
    theme: raw.theme as Appearance['theme'],
    effectiveTheme: raw.effectiveTheme as Appearance['effectiveTheme'],
    opacity: raw.opacity,
    opacityApplied: raw.opacityApplied,
    acrylicOpacity: { light: acrylic.light, dark: acrylic.dark },
    error: error === null ? null : { code: error.code as string, message: error.message as string }
  }
}
/** Appearance has its own low-frequency stream; no update operation or fabricated material fallback. */
export function createUpdaterAppearance(windowId: string, transport: AppearanceTransport) {
  if (!validId(windowId)) throw Error('更新窗口身份无效。')
  const materials = new Set<(material: Material) => void>(),
    opacities = new Set<(value: { lightOpacity: number; darkOpacity: number }) => void>()
  const errors = new Set<(error: Appearance['error']) => void>()
  let current: Appearance | null = null,
    dead = false,
    unlisten: (() => void) | null = null,
    pending: Promise<void> | null = null
  const stopListener = () => {
    try {
      unlisten?.()
    } catch {}
    unlisten = null
  }
  const publish = () => {
    if (!current || dead) return
    for (const callback of materials)
      try {
        callback(current.material)
      } catch {}
    for (const callback of opacities)
      try {
        callback({
          lightOpacity: current.acrylicOpacity.light,
          darkOpacity: current.acrylicOpacity.dark
        })
      } catch {}
    for (const callback of errors) { try { callback(current.error) } catch {} }
  }
  function accept(value: unknown): void {
    const next = parseAppearance(value)
    if (dead || next.windowId !== windowId || (current && next.sequence <= current.sequence)) return
    current = next
    publish()
  }
  function ensure(): Promise<void> {
    if (dead) return Promise.reject(Error('更新窗口已关闭。'))
    if (pending) return pending
    pending = (async () => {
      const stop = await transport.listen((value) => {
        if (!dead) {
          try {
            accept(value)
          } catch {}
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
        await transport.invoke('renderer_updater_window', {
          request: { op: 'appearance', windowId }
        })
      )
      if (!current) throw Error('更新窗口材质读取失败。')
    })().catch(() => {
      stopListener()
      pending = null
      throw Error('更新窗口材质读取失败。')
    })
    return pending
  }
  return {
    async getWindowMaterial(): Promise<Material> {
      await ensure()
      if (dead || !current) throw Error('更新窗口材质不可用。')
      return current.material
    },
    onMaterial(callback: (material: Material) => void): () => void {
      if (dead) return () => {}
      materials.add(callback)
      if (current)
        try {
          callback(current.material)
        } catch {}
      return () => {
        materials.delete(callback)
      }
    },
    onOpacity(
      callback: (value: { lightOpacity: number; darkOpacity: number }) => void
    ): () => void {
      if (dead) return () => {}
      opacities.add(callback)
      if (current)
        try {
          callback({
            lightOpacity: current.acrylicOpacity.light,
            darkOpacity: current.acrylicOpacity.dark
          })
        } catch {}
      return () => {
        opacities.delete(callback)
      }
    },
    onError(callback: (error:Appearance['error'])=>void):()=>void { if(dead)return()=>{};errors.add(callback);if(current)try{callback(current.error)}catch{};return()=>{errors.delete(callback)} },
    snapshot: () => current,
    dispose() {
      if (!dead) {
        dead = true
        stopListener()
        materials.clear()
        opacities.clear()
      errors.clear()
      }
    }
  }
}
export type UpdaterAppearance = ReturnType<typeof createUpdaterAppearance>
