import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { parseSettingsJson } from '../../packages/ztools-renderer/src/mappers'
import { createZtoolsRendererHostAdapter } from '../../packages/ztools-renderer/src/hostAdapter'
import { applyReviewedRendererCompatibilityPatch } from '../../packages/ztools-renderer/upstream-compatibility-patches.mjs'
import { withRendererStartupPreferences } from '../../packages/ztools-renderer/src/startupPreferenceEvents'
import type { StartupReadModel } from '../../packages/ztools-renderer/src/startupReadModel'
import { createRendererGeneralPreferenceEvents } from '../../packages/ztools-renderer/src/generalPreferenceEvents'
import type { RendererHostListener, ZToolsRendererTransport } from '../../packages/ztools-renderer/src/types'

const pinned = createRequire('/Users/harris/Desktop/ZTools/package.json'), vue = pinned('vue'), pinia = pinned('pinia')
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })
function transport() {
  const handlers = new Map<string, RendererHostListener>()
  const listen = vi.fn(async (event: string, callback: RendererHostListener) => { handlers.set(event, callback); return () => { handlers.delete(event) } })
  const invoke = vi.fn(async (command: string): Promise<unknown> => command === 'get_ztools_renderer_settings' ? { 'settings-general': JSON.stringify({ autoCheckUpdate: false }) } : [])
  return { transport: { listen, invoke } as ZToolsRendererTransport, handlers, listen, invoke,
    emit(value: unknown) { handlers.get('atools://renderer-general-settings')?.({ version: 1, raw: JSON.stringify(value) }) } }
}
it('projects startup bool and maps/replays committed bare booleans through the single General source', async () => {
  expect(parseSettingsJson(JSON.stringify({ autoCheckUpdate: false }))).toMatchObject({ autoCheckUpdate: false })
  expect(() => parseSettingsJson(JSON.stringify({ autoCheckUpdate: 'false' }))).toThrow()
  const f = transport(), adapter = createZtoolsRendererHostAdapter({ transport: f.transport })
  const seen: boolean[] = []; adapter.api.onAutoCheckUpdateChanged(value => seen.push(value))
  await vi.waitFor(() => expect(f.handlers.has('atools://renderer-general-settings')).toBe(true))
  f.emit({ autoCheckUpdate: false }); f.emit({ autoCheckUpdate: 'false' }); f.emit({ autoCheckUpdate: true })
  expect(seen).toEqual([false, true])
  const late = vi.fn(); adapter.api.onAutoCheckUpdateChanged(late); expect(late).toHaveBeenCalledWith(true)
  expect(f.listen.mock.calls.filter(c => c[0] === 'atools://renderer-general-settings')).toHaveLength(1)
  expect(adapter.capabilities().events.onAutoCheckUpdateChanged).toBe('limited')
  adapter.dispose(); expect(f.handlers.size).toBe(0)
})
it('does not synthesize preference changes for unrelated General commits', async () => {
  const f = transport(), events = createRendererGeneralPreferenceEvents(f.transport), callback = vi.fn()
  events.subscribe('onAutoCheckUpdateChanged', callback); await events.ready()
  events.autoCheckBaseline(true)
  f.emit({ placeholder: 'Search', autoCheckUpdate: true }); expect(callback).not.toHaveBeenCalled()
  f.emit({ autoCheckUpdate: false }); f.emit({ placeholder: 'Other', autoCheckUpdate: false })
  expect(callback.mock.calls).toEqual([[false]]); events.dispose()
})
it('uses original Main prompt gate, clears dismiss on reenable, and rejects late startup read without masking manual popup', async () => {
  const original = readFileSync('/Users/harris/Desktop/ZTools/src/renderer/src/stores/windowStore.ts', 'utf8')
  const source = applyReviewedRendererCompatibilityPatch('src/renderer/src/stores/windowStore.ts', original)!.code
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} as any }, autoListeners: Array<(enabled: boolean) => void> = []
  let complete!: (value: unknown) => void
  const pending = new Promise(resolve => { complete = resolve })
  const showUpdateWindow = vi.fn(async () => ({ success: true }))
  const api = { dbGet: vi.fn(() => pending), onUpdateBuiltinAppShortcutsEnabled: () => () => {},
    updater: { getDownloadStatus: vi.fn(async () => ({ hasUpdate: true, version: '2.0' })), showUpdateWindow },
    onAutoCheckUpdateChanged(callback: (enabled: boolean) => void) { autoListeners.push(callback); return () => {} } }
  const previous = (window as any).ztools; (window as any).ztools = api
  vi.stubGlobal('matchMedia', () => ({ addEventListener() {}, matches: false }))
  pinia.setActivePinia(pinia.createPinia())
  new Function('require', 'module', 'exports', compiled)((name: string) => {
    if (name === 'vue') return vue; if (name === 'pinia') return pinia
    if (name === '../assets/image/default.png') return { default: '' }
    throw new Error(name)
  }, module, module.exports)
  const store = module.exports.useWindowStore()
  // Invoke the actual original App subscription statement, rather than a new prompt controller.
  const app = readFileSync('/Users/harris/Desktop/ZTools/src/renderer/src/App.vue', 'utf8')
  const statement = app.match(/removeAutoCheckUpdateChangedListener = window.ztools.onAutoCheckUpdateChanged\(\(enabled\) => \{[\s\S]*?\n  \}\)/)![0]
  new Function('window', 'windowStore', `let removeAutoCheckUpdateChangedListener; ${statement}; return removeAutoCheckUpdateChangedListener`)(window, store)
  const loading = store.loadSettings(); autoListeners[0](false); complete({ autoCheckUpdate: true }); await loading
  expect(store.autoCheckUpdateEnabled).toBe(false)
  store.setAvailableUpdateInfo({ hasUpdate: true, version: '2.0', changelog: '' })
  expect(store.shouldShowUpdateNotification).toBe(false)
  autoListeners[0](true); expect(store.shouldShowUpdateNotification).toBe(true)
  store.dismissUpdateNotification(); expect(store.shouldShowUpdateNotification).toBe(false)
  autoListeners[0](false); autoListeners[0](true); expect(store.shouldShowUpdateNotification).toBe(true)
  autoListeners[0](false); await api.updater.showUpdateWindow(); expect(showUpdateWindow).toHaveBeenCalledTimes(1)
  expect(store.availableUpdateInfo.hasUpdate).toBe(true)
  store.$dispose(); (window as any).ztools = previous
})

it('overlays early committed auto=false over late old startup and seeds no-change full events without a second listener', async () => {
  const f = transport(), events = createRendererGeneralPreferenceEvents(f.transport)
  let resolve!: (value: unknown) => void
  const pending = new Promise(done => { resolve = done })
  const model = withRendererStartupPreferences({ dbGet: () => pending, dispose() {} } as unknown as StartupReadModel, events)
  const callback = vi.fn(); events.subscribe('onAutoCheckUpdateChanged', callback); await events.ready()
  const read = model.dbGet('settings-general'); f.emit({ autoCheckUpdate: false }); resolve({ autoCheckUpdate: true })
  expect(await read).toMatchObject({ autoCheckUpdate: false })
  f.emit({ autoCheckUpdate: false, placeholder: 'unrelated full commit' }); expect(callback.mock.calls).toEqual([[false]])
  expect(f.listen).toHaveBeenCalledTimes(1); model.dispose(); events.dispose()
})

it('preserves absent General and caches a late-event overlay without mutating the snapshot', async () => {
  const f = transport(), events = createRendererGeneralPreferenceEvents(f.transport)
  let value: unknown = null
  const model = withRendererStartupPreferences({ dbGet: async () => value, dispose() {} } as unknown as StartupReadModel, events)
  events.subscribe('onAutoCheckUpdateChanged', () => {}); await events.ready()
  expect(await model.dbGet('settings-general')).toBeNull()
  value = { placeholder: 'Search' }; f.emit({ autoCheckUpdate: false })
  const first = await model.dbGet('settings-general'), second = await model.dbGet('settings-general')
  expect(first).toEqual({ placeholder: 'Search', autoCheckUpdate: false })
  expect(second).toBe(first); expect(value).toEqual({ placeholder: 'Search' })
  model.dispose(); events.dispose()
})
