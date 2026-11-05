import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
const root = '/Users/harris/Desktop/ZTools', vue = createRequire(`${root}/package.json`)('vue') as any
const dep = createRequire(`${root}/node_modules/.pnpm/package.json`)
const compiler = createRequire(dep.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc') as any
let cleanup = () => {}
afterEach(() => { cleanup(); vi.restoreAllMocks() })
function fixture() {
  let jump!: (state: unknown) => void, release!: (value: unknown) => void
  const commands = new Promise(resolve => { release = resolve }), ack = vi.fn()
  const appTarget = { kind: 'app', path: '/B.app', name: 'Same' }
  const intent = { id: 'c'.repeat(32), sequence: 1, target: appTarget }
  const stub = { render: () => null }
  let editor: any, selector: any
  function compile(path: string, extra: (name: string) => unknown) {
    const patch = settingsSourceCompatibilityPatches.find((p: any) => p.path === path)!
    const original = readFileSync(`${root}/${path}`, 'utf8')
    expect(createHash('sha256').update(original).digest('hex')).toBe(patch.beforeSha256)
    let source = original
    for (const change of patch.changes) { expect(source.split(change.before)).toHaveLength(2); source = source.replace(change.before, change.after) }
    const before = compiler.parse(original).descriptor, after = compiler.parse(source).descriptor
    expect(after.template.content).toBe(before.template.content)
    expect(after.styles.map((x: any) => x.content)).toEqual(before.styles.map((x: any) => x.content))
    const compiled = compiler.compileScript(after, { id: path, inlineTemplate: true })
    const code = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
    const module = { exports: {} as any }
    new Function('require', 'module', 'exports', code)((name: string) => {
      if (name === 'vue') return vue
      return extra(name)
    }, module, module.exports)
    return module.exports.default
  }
  const helpers = { buildShortcutTargetValue: (x: any) => x.cmdName, buildShortcutTargetCandidates: (x: any) => [x.cmdName], normalizeShortcutTargetValue: (x: string) => x }
  selector = compile('internal-plugins/setting/src/views/ShortcutsSetting/components/CommandTargetSelector.vue', name => {
    if (name === '@/components') return { AdaptiveIcon: stub }
    if (name === '@/utils') return { weightedSearch: (items: unknown[]) => items }
    throw Error(name)
  })
  editor = compile('internal-plugins/setting/src/components/common/ShortcutEditor/ShortcutEditor.vue', name => {
    if (name === '@/components') return { HotkeyInput: stub, DetailPanel: { setup(_p: any, { slots }: any) { return () => vue.h('div', slots.default?.()) } } }
    if (name === '@/components/common/Toast') return { useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), confirm: async () => true }) }
    if (name.endsWith('/CommandTargetSelector.vue')) return { default: selector }
    if (name.endsWith('/ShortcutsSetting')) return helpers
    throw Error(name)
  })
  const component = compile('internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue', name => {
    if (name === '@/components') return { useToast: () => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), confirm: async () => true }), ShortcutEditor: editor, AdaptiveIcon: stub }
    if (name === '@/utils') return { weightedSearch: (items: unknown[]) => items }
    if (name === '@/composables') return { useJumpFunction: (callback: any) => { jump = callback }, useZtoolsSubInput: () => ({ value: vue.ref('') }) }
    if (name === '@shared/commandShared') return { COMMAND_ALIASES_KEY: 'command-aliases', DIRECT_APP_ALIAS_GROUP_KEY: 'apps', DIRECT_APP_ALIAS_GROUP_TITLE: 'apps', getCommandId: (x: any) => x.path, normalizeCommandAliases: () => ({}) }
    if (name === '@/views/ShortcutsSetting/ShortcutsSetting') return helpers
    if (name === './components/AliasMappingDialog.vue') return { default: stub }
    throw Error(name)
  })
  const previous = (window as any).ztools, oldAck = (window as any).__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__
  ;(window as any).__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__ = ack
  ;(window as any).ztools = { internal: { readAppGlobalShortcuts: async () => ({ version: 1, revision: 'a'.repeat(32), rows: [], bindings: [], runtime: [] }), dbGet: async () => null,
    getCommands: () => commands, getPlatform: () => 'darwin' } }
  const element = document.createElement('div'); document.body.append(element); const app = vue.createApp(component); app.mount(element)
  let live = true
  const unmount = () => { if (live) { live = false; app.unmount() } }
  cleanup = () => { unmount(); element.remove(); (window as any).ztools = previous; (window as any).__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__ = oldAck }
  return { element, intent, ack, unmount, jump: (value = intent) => jump({ appShortcutIntent: value }), release(paths: string[]) {
    release({ plugins: [], commands: paths.map(path => ({ type: 'direct', subType: 'app', path, name: 'Same' })) })
  } }
}
it('ACKs true only after original editor displays the exact selected path', async () => {
  const f = fixture(); f.jump(); await vue.nextTick(); expect(f.ack).not.toHaveBeenCalled()
  f.release(['/A.app', '/B.app'])
  await vi.waitFor(() => expect(f.ack).toHaveBeenCalledWith(f.intent.id, 1, true))
  expect(f.element.querySelector('.target-card-subtitle')?.textContent).toBe('/B.app')
})
it('ACKs false when the current catalog lacks the target', async () => {
  const f = fixture(); f.jump(); f.release(['/A.app'])
  await vi.waitFor(() => expect(f.ack).toHaveBeenCalledWith(f.intent.id, 1, false))
})
it('ACKs false on unmount and never ACKs true after late target loading', async () => {
  const f = fixture(); f.jump(); f.unmount(); expect(f.ack).toHaveBeenCalledWith(f.intent.id, 1, false)
  f.release(['/B.app']); await Promise.resolve(); await vue.nextTick()
  expect(f.ack).toHaveBeenCalledTimes(1)
})

it('only the latest intent is consumed when A and B arrive before catalog loading', async () => {
  const f = fixture(), newer = { id: 'd'.repeat(32), sequence: 2, target: { ...f.intent.target, path: '/A.app' } }
  f.jump(); f.jump(newer); f.release(['/A.app', '/B.app'])
  await vi.waitFor(() => expect(f.ack).toHaveBeenCalledWith(newer.id, 2, true))
  expect(f.ack).not.toHaveBeenCalledWith(f.intent.id, 1, true)
  expect(f.element.querySelector('.target-card-subtitle')?.textContent).toBe('/A.app')
})
it('closing the editor before catalog completion rejects immediately and cannot later ACK true', async () => {
  const f = fixture(); f.jump(); await vue.nextTick()
  const cancel = Array.from(f.element.querySelectorAll('.editor-footer button')).find(button => button.textContent?.trim() === '取消') as HTMLButtonElement
  cancel.click(); expect(f.ack).toHaveBeenCalledWith(f.intent.id, 1, false)
  f.release(['/B.app']); await Promise.resolve(); await vue.nextTick()
  expect(f.ack).toHaveBeenCalledTimes(1)
})
