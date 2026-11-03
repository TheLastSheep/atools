import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { vi } from 'vitest'
import { hotkeyRecordingPatches } from '../../packages/ztools-settings/src/compatibility-patches/hotkey-recording.mjs'
import { createHotkeyBridge } from './ztoolsSettingsHotkeyBridgeFixture'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
import type { SettingsInternalApi } from '../../packages/ztools-settings/src/childBridgeApi'
import type { SettingsBridgeTarget } from '../../packages/ztools-settings/src/childBridgeTypes'

const upstream = '/Users/harris/Desktop/ZTools'
const requirePinned = createRequire(`${upstream}/package.json`)
const requirePackages = createRequire(`${upstream}/node_modules/.pnpm/package.json`)
const { parse, compileScript } = createRequire(requirePackages.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc')
const runtime = requirePinned('vue') as Record<string, any>
export function originalHotkeyComponent() {
  const patch = hotkeyRecordingPatches[0]
  const original = readFileSync(`${upstream}/${patch.path}`, 'utf8')
  if (createHash('sha256').update(original).digest('hex') !== patch.beforeSha256) throw new Error('Pinned HotkeyInput source changed')
  let source = original
  for (const change of patch.changes) {
    if (source.split(change.before).length !== 2) throw new Error(`Patch marker drift ${change.id}`)
    source = source.replace(change.before, change.after)
  }
  const before = parse(original).descriptor, after = parse(source).descriptor
  if (before.template.content !== after.template.content || before.styles[0].content !== after.styles[0].content) {
    throw new Error('Original template/styles changed')
  }
  const compiled = compileScript(after, { id: 'r71-original-hotkey', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} as Record<string, any> }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return runtime
    if (name === '@/components/common/Toast') return { useToast: () => ({ warning: () => {} }) }
    throw new Error(`Unexpected original component dependency ${name}`)
  }, module, module.exports)
  return { component: module.exports.default, runtime }
}
export function recordingComponentFixture({ holdStart = false, failStart = false, failStops = 0, holdStop = false } = {}) {
  const sessionId = 'a'.repeat(32), target = window as unknown as SettingsBridgeTarget
  const calls: Array<{ operation: string; generation: number }> = []
  const pending: Array<() => void> = [], pendingStops: Array<() => void> = []
  const general = createHotkeyBridge(true, 'Option+Z', { target, recording: async (operation, payload) => {
      const generation = payload.generation as number
      calls.push({ operation, generation })
      if (operation === 'stopHotkeyRecording' && failStops-- > 0) throw new Error('Native retained lease cleanup failed')
      if (operation === 'startHotkeyRecording' && failStart) throw new Error('Native unavailable')
      const ack = { version: 1, sessionId, generation, active: operation === 'startHotkeyRecording',
        mode: operation === 'startHotkeyRecording' ? 'borrowed-main' : null }
      if (operation === 'stopHotkeyRecording' && holdStop) return new Promise(resolve => pendingStops.push(() => resolve(ack)))
      if (operation === 'startHotkeyRecording' && holdStart) return new Promise(resolve => pending.push(() => resolve(ack)))
      return ack
    } })
  const startPromises: Promise<unknown>[] = [], stopPromises: Promise<unknown>[] = []
  const nativeStop = general.internal.stopHotkeyRecording
  general.internal.stopHotkeyRecording = () => {
    const promise = nativeStop(); stopPromises.push(promise); return promise
  }
  const nativeStart = general.internal.startHotkeyRecording
  general.internal.startHotkeyRecording = () => {
    const promise = nativeStart(); startPromises.push(promise); return promise
  }
  const activeDomListeners = new Set<EventListenerOrEventListenerObject>()
  const originalAdd = document.addEventListener.bind(document), originalRemove = document.removeEventListener.bind(document)
  const addSpy = vi.spyOn(document, 'addEventListener').mockImplementation((type, listener, options) => {
    if (type === 'keydown') activeDomListeners.add(listener)
    originalAdd(type, listener, options)
  })
  const removeSpy = vi.spyOn(document, 'removeEventListener').mockImplementation((type, listener, options) => {
    if (type === 'keydown') activeDomListeners.delete(listener)
    originalRemove(type, listener, options)
  })
  const { component, runtime } = originalHotkeyComponent()
  const mounts: Array<{ app: { unmount(): void }; root: HTMLDivElement; vm: { stopRecording(): void } }> = []
  const mount = (change = (_value: string) => {}) => {
    const root = document.createElement('div'); document.body.append(root)
    const rawApp = runtime.createApp(component, { modelValue: 'Option+Z', platform: 'darwin', onChange: change })
    const vm = rawApp.mount(root)
    let mounted = true
    const app = { unmount() { if (mounted) { mounted = false; rawApp.unmount() } } }
    const item = { app, root, vm }; mounts.push(item); return item
  }
  const deliver = (generation: number, fields: Record<string, unknown> = {}) => {
    const dto = { version: 1, sessionId, generation, status: 'recorded', shortcut: 'Option+Space', ...fields }
    if (fields.status === 'stopped') delete (dto as Record<string, unknown>).shortcut
    target.__ATOOLS_SETTINGS_DELIVER_HOTKEY__?.(dto)
  }
  const key = (type: string, key: string, code: string, extra = {}) =>
    document.dispatchEvent(new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true, ...extra }))
  return { mount, calls, deliver, key, runtime, general, activeDomListeners, releaseStop: () => pendingStops.shift()?.(), release: () => pending.shift()?.(), async tick() { await Promise.all(startPromises); await Promise.allSettled(stopPromises); await runtime.nextTick() },
    dispose() { for (const item of mounts) { item.app.unmount(); item.root.remove() } general.bridge.dispose(); addSpy.mockRestore(); removeSpy.mockRestore() } }
}

export function originalGeneralHotkeyHandler(internal: SettingsInternalApi, runtime: Record<string, any>) {
  const patch = settingsSourceCompatibilityPatches.find((entry: any) => entry.path.endsWith('/GeneralSetting.vue'))!
  let source = readFileSync(`${upstream}/${patch.path}`, 'utf8')
  for (const change of patch.changes) {
    if (source.split(change.before).length !== 2) throw new Error(`General marker drift ${change.id}`)
    source = source.replace(change.before, change.after)
  }
  const script = parse(source).descriptor.scriptSetup.content
  const ast = ts.createSourceFile('general.ts', script, ts.ScriptTarget.ES2022, true)
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'handleHotkeyChange')!
  const compiled = ts.transpileModule(node.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const hotkey = runtime.ref('Option+Z'), errors: string[] = []
  const saveSettings = async () => {
    const current = await internal.dbGet('settings-general') as Record<string, unknown>
    await internal.dbPut('settings-general', { ...current, hotkey: hotkey.value })
  }
  const handler = new Function('window', 'hotkey', 'saveSettings', 'error', 'console', `${compiled};return handleHotkeyChange`)(
    { ztools: { internal } }, hotkey, saveSettings, (error: string) => errors.push(error), { log() {}, error() {} })
  return { hotkey, errors, change: (value: string) => { hotkey.value = value; return handler(value) } }
}
