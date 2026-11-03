import { createRequire } from 'node:module'
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { createMainFileDrop } from '../../packages/ztools-renderer/src/mainFileDrop'
import { patchMainDrop, MAIN_DROP_PATCH } from '../../packages/ztools-renderer/src/mainDropCompatibility.mjs'
import { decorateMainFileDropBootstrap } from '../../scripts/lib/ztools-main-file-drop-browser-fixture.mjs'

const upstream = '/Users/harris/Desktop/ZTools'
const pinned = createRequire(`${upstream}/package.json`), packages = createRequire(`${upstream}/node_modules/.pnpm/package.json`)
const compiler = createRequire(packages.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc')
const vue = pinned('vue') as any
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const files = [{ path: '/private/tmp/r77/a.txt', name: 'a.txt', isDirectory: false },
  { path: '/private/tmp/r77/folder', name: 'folder', isDirectory: true }]

/** Compile and mount the entire pinned SearchBox, preserving actual template/style bytes. */
function mountSearch() {
  const original = readFileSync(`${upstream}/${MAIN_DROP_PATCH.path}`, 'utf8')
  expect(createHash('sha256').update(original).digest('hex')).toBe(MAIN_DROP_PATCH.beforeSha256)
  const source = process.env.ATOOLS_R77_UNPATCHED === '1' ? original : patchMainDrop(original)
  const before = compiler.parse(original).descriptor, after = compiler.parse(source).descriptor
  expect(after.template.content).toBe(before.template.content)
  expect(after.styles.map((s: any) => s.content)).toEqual(before.styles.map((s: any) => s.content))
  const compiled = compiler.compileScript(after, { id: 'r77-original-drop', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText
  const store = vue.reactive({ currentPlugin: null, placeholder: 'Search', subInputPlaceholder: '', subInputVisible: false,
    avatar: '', pluginLoading: false, tabKeyFunction: 'navigate', tabTargetCommand: '', shouldShowUpdateNotification: false,
    aiRequestStatus: 'idle', setAiRequestStatus() {}, dismissUpdateNotification() {} })
  const module = { exports: {} as any }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === '@shared/pluginSettings') return { normalizeConfigList: () => [] }
    if (name === '../../stores/windowStore') return { DEFAULT_AVATAR: '', useWindowStore: () => store }
    if (name === '../common/AdaptiveIcon.vue' || name === './UpdateIcon.vue') return { __esModule: true, default: { render: () => null } }
    throw new Error(`Unexpected original SearchBox dependency: ${name}`)
  }, module, module.exports)
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, width: 800, height: 80 } as DOMRect)
  const w = window as any, previousApi = w.ztools, previousTransport = w.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__
  const transport = { invoke: vi.fn(async (_command: string, _args?: Record<string, unknown>) => null), listen: vi.fn(async () => () => {}) }
  w.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__ = transport
  new Function('window', 'crypto', 'structuredClone', decorateMainFileDropBootstrap(''))(window, webcrypto, structuredClone)
  const native = w.__ATOOLS_MAIN_DROP_FIXTURE__
  const controller = createMainFileDrop(transport as any, (command, args) => transport.invoke(command, args))
  const fallback = vi.fn(() => '/not-native')
  w.ztools = { onNativeMainFileDrop: controller.bind, onContextMenuCommand: () => () => {}, dbGet: async () => null,
    getPathForFile: fallback, checkFilePaths: fallback, getPlatform: () => 'darwin' }
  const state = vue.reactive({ query: 'keep query', pastedFiles: null as any, currentView: 'search', pastedText: null, pastedImage: null })
  const root = document.createElement('div'); document.body.append(root)
  const emits: any[] = []
  const app = vue.createApp({ render: () => vue.h(module.exports.default, {
    modelValue: state.query, pastedFiles: state.pastedFiles, pastedText: state.pastedText,
    pastedImage: state.pastedImage, currentView: state.currentView,
    'onUpdate:modelValue': (v: string) => { emits.push(['query', v]); state.query = v },
    'onUpdate:pastedFiles': (v: unknown) => { emits.push(['files', v]); state.pastedFiles = v },
  }) }); app.mount(root)
  let dead = false
  const unmount = () => { if (!dead) { dead = true; app.unmount(); root.remove() } }
  disposers.push(() => { unmount(); controller.dispose(); w.ztools = previousApi; w.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__ = previousTransport; delete w.__ATOOLS_MAIN_DROP_FIXTURE__ })
  const ready = () => vi.waitFor(() => expect(native.snapshot().lease).toMatch(/^[0-9a-f]{32}$/))
  return { root, state, native, emits, fallback, unmount, ready, controller,
    nativeSettingsOpen: () => transport.invoke('open_renderer_settings') }
}

it('original SearchBox accepts Native files/directories, clears query, and prevents duplicate DOM file fallback', async () => {
  const f = mountSearch(); await f.ready()
  f.native.emit('hover', { hovered: true }); await vue.nextTick(); expect(f.root.querySelector('.drag-overlay')).not.toBeNull()
  f.native.emit('hover', { hovered: false }); f.native.emit('drop', { files }); await vue.nextTick()
  expect(f.state.query).toBe(''); expect(f.state.pastedFiles).toEqual(files)
  expect(f.root.querySelector('.file-name')?.textContent).toBe('a.txt')
  expect(f.root.querySelector('.file-count')?.textContent).toBe('2')
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['x'], 'browser.txt')] } })
  f.root.querySelector('.search-box')!.dispatchEvent(event)
  expect(event.defaultPrevented).toBe(true); expect(f.fallback).not.toHaveBeenCalled(); expect(f.emits).toHaveLength(2)
})
it('old result/error never clears a later hover and failures preserve original query/files', async () => {
  const f = mountSearch(); await f.ready()
  f.native.emit('hover', { hovered: true }, 20); f.native.emit('drop', { files }, 4); await vue.nextTick()
  expect(f.root.querySelector('.drag-overlay')).not.toBeNull(); expect(f.state.pastedFiles).toEqual(files)
  f.state.query = 'do not lose'; const count = f.emits.length
  f.native.emit('error', { code: 'METADATA_FAILED' }, 5); await vue.nextTick()
  expect(f.state.query).toBe('do not lose'); expect(f.state.pastedFiles).toEqual(files)
  expect(f.root.querySelector('.drag-overlay')).not.toBeNull(); expect(f.emits).toHaveLength(count)
  f.native.emit('drop', { files: [{ ...files[0], name: 'older' }] }, 3); await vue.nextTick()
  expect(f.state.pastedFiles).toEqual(files)
})
it('leaves Search, rejects old lease results, acquires fresh context and unmounts cleanly', async () => {
  const f = mountSearch(); await f.ready(); const old = f.native.snapshot().lease
  f.native.emit('hover', { hovered: true }); f.state.currentView = 'plugin'; await vue.nextTick()
  await vi.waitFor(() => expect(f.native.snapshot().lease).toBeNull())
  f.native.emit('drop', { files }, 50, old); await vue.nextTick(); expect(f.state.query).toBe('keep query')
  f.state.currentView = 'search'; await f.ready(); expect(f.native.snapshot().lease).not.toBe(old)
  f.unmount(); await vi.waitFor(() => { expect(f.native.snapshot().lease).toBeNull(); expect(f.native.snapshot().activeListeners).toBe(0) })
  f.native.emit('drop', { files }, 100, old); expect(f.emits).toEqual([])
})
it('pending registration cannot revive an unmounted original SearchBox', async () => {
  const f = mountSearch(); f.native.hold(true)
  await vi.waitFor(() => expect(f.native.snapshot().pending).toBe(1))
  f.unmount(); f.native.hold(false); f.native.release()
  await vi.waitFor(() => { expect(f.native.snapshot().lease).toBeNull(); expect(f.native.snapshot().activeListeners).toBe(0) })
  expect(f.emits).toEqual([])
})
it('registration rejection preserves inputs and permits an explicit resize retry', async () => {
  const f = mountSearch(); f.native.failNext()
  await vi.waitFor(() => { expect(f.native.snapshot().calls.length).toBeGreaterThan(0); expect(f.native.snapshot().lease).toBeNull() })
  expect(f.state.query).toBe('keep query'); expect(f.emits).toEqual([])
  window.dispatchEvent(new Event('resize')); await f.ready()
  f.native.emit('drop', { files }); await vue.nextTick(); expect(f.state.query).toBe('')
})
it('invalid metadata and foreign lease keep original files/query without clearing newer hover', async () => {
  const f = mountSearch(); await f.ready(); f.native.emit('drop', { files }); await vue.nextTick()
  f.state.query = 'preserve'; const count = f.emits.length
  f.native.emit('hover', { hovered: true }, 20)
  f.native.emit('drop', { files: [files[0], files[0]] }, 21)
  f.native.emit('drop', { files: [{ ...files[0], path: 'relative' }] }, 22)
  f.native.emit('drop', { files }, 23, 'other')
  f.native.emit('error', { code: 'INVALID_BATCH' }, 24)
  await vue.nextTick()
  expect(f.state.query).toBe('preserve'); expect(f.state.pastedFiles).toEqual(files)
  expect(f.emits).toHaveLength(count); expect(f.root.querySelector('.drag-overlay')).not.toBeNull()
})

it('Native Settings context rotation before Search deactivation cannot poison the returning widget', async () => {
  const f = mountSearch(); await f.ready(); const old = f.native.snapshot()
  await f.nativeSettingsOpen(); f.state.currentView = 'plugin'; await vue.nextTick()
  f.state.currentView = 'search'; await f.ready()
  expect(f.native.snapshot().context).not.toBe(old.context)
  expect(f.native.snapshot().lease).not.toBe(old.lease)
  f.native.emit('drop', { files }); await vue.nextTick(); expect(f.state.pastedFiles).toEqual(files)
})
