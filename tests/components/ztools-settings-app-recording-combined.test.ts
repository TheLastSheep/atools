import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { appGlobalShortcutPatches } from '../../packages/ztools-settings/src/compatibility-patches/app-global-shortcuts.mjs'
import { routeSettingsRecording } from '../../packages/ztools-settings/src/childBridgeRecordingRouter'
import { createSettingsAppShortcutRecordingController } from '../../packages/ztools-settings/src/childBridgeAppShortcutRecording'
import type { SettingsBridgeTarget } from '../../packages/ztools-settings/src/childBridgeTypes'
import { originalHotkeyComponent } from './ztoolsSettingsHotkeyRecordingComponentFixture'
const upstream = '/Users/harris/Desktop/ZTools'
const vue = createRequire(`${upstream}/package.json`)('vue') as any
const deps = createRequire(`${upstream}/node_modules/.pnpm/package.json`)
const compiler = createRequire(deps.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc') as any
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const sessionId = 'session', token = 'a'.repeat(32)
const ack = (active: boolean, drained: boolean) => ({ version: 1, sessionId, generation: 1, token, active, drained })
function editor(HotkeyInput: any) {
  const patch = appGlobalShortcutPatches[0]; let source = readFileSync(`${upstream}/${patch.path}`, 'utf8')
  for (const change of patch.changes) { expect(source.split(change.before)).toHaveLength(2); source = source.replace(change.before, change.after) }
  const compiled = compiler.compileScript(compiler.parse(source).descriptor, { id: 'r80-combined', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const component = { exports: {} as any }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === '@/components/common/Toast') return { useToast: () => ({ warning: vi.fn() }) }
    if (name === '@/components') return { HotkeyInput, DetailPanel: { setup(_: any, { slots }: any) { return () => vue.h('div', slots.default?.()) } } }
    if (name.endsWith('/CommandTargetSelector.vue')) return { default: { setup() { return () => vue.h('div') } } }
    if (name.endsWith('/ShortcutsSetting')) return { normalizeShortcutTargetValue: (x: string) => x, buildShortcutTargetCandidates: (x: any) => [x.value] }
    throw Error(name)
  }, component, component.exports)
  return component.exports.default
}
async function fixture(early = false, failStart = false) {
  const old = (window as any).ztools, hash = window.location.hash; history.replaceState(null, '', '#/shortcuts')
  const start = deferred<unknown>(), stop = deferred<unknown>(), draining = vi.fn(), saved = vi.fn()
  const invoke = vi.fn((op: string) => op.startsWith('start') ? start.promise : stop.promise)
  const controller = createSettingsAppShortcutRecordingController({ sessionId, isLive: () => true, invokeNative: invoke, reportDraining: draining })
  controller.attach(window as unknown as SettingsBridgeTarget)
  const general = { attach() {}, start: async () => ({ success: false }), stop: async () => {}, onRecorded: () => () => {}, onStopped: () => () => {}, dispose() {} }
  const routed = routeSettingsRecording(general, controller, () => window.location.hash)
  ;(window as any).ztools = { internal: { getPlatform: () => 'darwin', startHotkeyRecording: routed.start, stopHotkeyRecording: routed.stop, onHotkeyRecorded: routed.onRecorded, onHotkeyRecordingStopped: routed.onStopped } }
  const component = editor(originalHotkeyComponent().component), el = document.createElement('div'); document.body.append(el)
  const options = [{ commandId: '1', type: 'direct', subType: 'app', path: '/A.app', value: 'A', cmdName: 'A' }]
  const app = vue.createApp(component, { editingShortcut: { id: 'old', target: 'A', shortcut: 'Ctrl+Z', enabled: true, appTarget: { kind: 'app', path: '/A.app', name: 'A' } }, targetOptions: options, onSave: saved }); app.mount(el)
  const send = (value: Record<string, unknown>) => (window as unknown as SettingsBridgeTarget).__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_RECORDING__?.({ version: 1, sessionId, generation: 1, token, ...value })
  const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); await vue.nextTick() }
  ;(el.querySelector('.hotkey-input') as HTMLElement).click()
  if (early) send({ status: 'recorded', shortcut: 'Ctrl+A' })
  if (failStart) start.reject(Error('unavailable')); else start.resolve(ack(true, false)); await flush()
  return { stop, draining, saved, invoke, send, flush, el, dispose() { app.unmount(); controller.dispose(); el.remove(); (window as any).ztools = old; history.replaceState(null, '', hash || '#/') } }
}
it('real HotkeyInput and Editor wait through held drain and save exactly once', async () => {
  const f = await fixture()
  try {
    f.send({ status: 'recorded', shortcut: 'Ctrl+A' }); await f.flush()
    f.stop.resolve(ack(false, false)); await f.flush(); expect(f.draining).toHaveBeenCalledTimes(1)
    const save = Array.from(f.el.querySelectorAll('button')).find(button => button.textContent?.trim() === '确定') as HTMLButtonElement
    save.click(); await f.flush(); expect(f.saved).not.toHaveBeenCalled()
    f.send({ status: 'stopped', reason: 'cancelled', drained: true }); await f.flush()
    expect(f.saved).toHaveBeenCalledTimes(1); expect(f.saved.mock.calls[0][0]).toBe('Ctrl+A')
    f.send({ status: 'stopped', reason: 'cancelled', drained: true }); await f.flush(); expect(f.saved).toHaveBeenCalledTimes(1)
    expect(f.invoke).toHaveBeenCalledTimes(2)
  } finally { f.dispose() }
})
it('pre-ack recorded is consumed once without falsely failing start', async () => {
  const f = await fixture(true)
  try {
    f.stop.resolve(ack(false, true)); await f.flush()
    const save = Array.from(f.el.querySelectorAll('button')).find(button => button.textContent?.trim() === '确定') as HTMLButtonElement
    save.click(); await f.flush(); expect(f.saved).toHaveBeenCalledTimes(1); expect(f.saved.mock.calls[0][0]).toBe('Ctrl+A')
    expect(f.invoke).toHaveBeenCalledTimes(2)
  } finally { f.dispose() }
})

it('failed stop blocks both candidate and editor save and ignores late notice', async () => {
  const f = await fixture()
  try {
    f.send({ status: 'recorded', shortcut: 'Ctrl+A' }); await f.flush(); f.stop.reject(Error('stop failed')); await f.flush()
    const save = Array.from(f.el.querySelectorAll('button')).find(button => button.textContent?.trim() === '确定') as HTMLButtonElement
    save.click(); await f.flush(); f.send({ status: 'stopped', reason: 'cancelled', drained: true }); await f.flush()
    expect(f.saved).not.toHaveBeenCalled(); expect(f.invoke).toHaveBeenCalledTimes(2)
  } finally { f.dispose() }
})
it('failed native start forbids DOM fallback and late candidates', async () => {
  const f = await fixture(false, true)
  try {
    f.stop.resolve({ ...ack(false, true), token: null }); await f.flush()
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', ctrlKey: true }))
    f.send({ status: 'recorded', shortcut: 'Ctrl+A' }); await f.flush()
    expect(f.el.textContent).toContain('Ctrl+Z'); expect(f.saved).not.toHaveBeenCalled()
    expect(f.invoke).toHaveBeenCalledTimes(2)
  } finally { f.dispose() }
})
