import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
const root = '/Users/harris/Desktop/ZTools', vue = createRequire(`${root}/package.json`)('vue') as any
const dep = createRequire(`${root}/node_modules/.pnpm/package.json`)
const compiler = createRequire(dep.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc') as any
let dispose = () => {}
afterEach(() => { dispose(); vi.restoreAllMocks() })
it('actual Shortcuts caller submits one create mutation and waits for persisted receipt', async () => {
  const path = 'internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue'
  const patch = settingsSourceCompatibilityPatches.find((p: any) => p.path === path)!
  const original = readFileSync(`${root}/${path}`, 'utf8')
  expect(createHash('sha256').update(original).digest('hex')).toBe(patch.beforeSha256)
  let source = original
  for (const change of patch.changes) { expect(source.split(change.before)).toHaveLength(2); source = source.replace(change.before, change.after) }
  const before = compiler.parse(original).descriptor, after = compiler.parse(source).descriptor
  expect(after.template.content).toBe(before.template.content)
  expect(after.styles.map((x: any) => x.content)).toEqual(before.styles.map((x: any) => x.content))
  const compiled = compiler.compileScript(after, { id: 'r80-caller', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const selected = { commandId: '/B.app', type: 'direct', subType: 'app', path: '/B.app', cmdName: 'Same', value: 'Same' }
  const Editor = { emits: ['save'], setup(_p: any, { emit }: any) { return () => vue.h('button', { class: 'fixture-save', onClick: () => emit('save', 'Alt+A', 'Same', false, selected) }, 'Save') } }
  const success = vi.fn(), error = vi.fn(), warning = vi.fn(), module = { exports: {} as any }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === '@/components') return { useToast: () => ({ success, error, warning, confirm: async () => true }), ShortcutEditor: Editor, AdaptiveIcon: { render: () => null } }
    if (name === '@/utils') return { weightedSearch: (rows: unknown[]) => rows }
    if (name === '@/composables') return { useJumpFunction() {}, useZtoolsSubInput: () => ({ value: vue.ref('') }) }
    if (name === '@shared/commandShared') return { COMMAND_ALIASES_KEY: 'command-aliases', DIRECT_APP_ALIAS_GROUP_KEY: 'apps', DIRECT_APP_ALIAS_GROUP_TITLE: 'apps', getCommandId: (x: any) => x.path, normalizeCommandAliases: () => ({}) }
    if (name === '@/views/ShortcutsSetting/ShortcutsSetting') return { buildShortcutTargetValue: (x: any) => x.cmdName }
    if (name === './components/AliasMappingDialog.vue') return { default: { render: () => null } }
    throw Error(name)
  }, module, module.exports)
  const initial = { version: 1, revision: 'a'.repeat(32), rows: [], bindings: [], runtime: [] }
  let finish!: (x: unknown) => void
  const mutate = vi.fn(() => new Promise(resolve => { finish = resolve })), dbPut = vi.fn()
  const previous = (window as any).ztools
  ;(window as any).ztools = { internal: { readAppGlobalShortcuts: async () => initial, mutateAppGlobalShortcut: mutate, dbPut,
    dbGet: async () => null, getCommands: async () => ({ commands: [], plugins: [] }) } }
  const el = document.createElement('div'); document.body.append(el); const app = vue.createApp(module.exports.default); app.mount(el)
  dispose = () => { app.unmount(); el.remove(); (window as any).ztools = previous }
  await vi.waitFor(() => expect(el.textContent).toContain('添加快捷键'))
  const add = Array.from(el.querySelectorAll('button')).find(button => button.textContent?.includes('添加快捷键')) as HTMLButtonElement
  add.click(); await vue.nextTick(); (el.querySelector('.fixture-save') as HTMLButtonElement).click()
  ;(el.querySelector('.fixture-save') as HTMLButtonElement).click()
  expect(mutate).toHaveBeenCalledOnce(); expect(mutate).toHaveBeenCalledWith({ kind: 'create', shortcut: 'Alt+A', target: { kind: 'app', path: '/B.app', name: 'Same' }, enabled: true, autoCopy: false })
  expect(dbPut).not.toHaveBeenCalled(); expect(success).not.toHaveBeenCalled()
  finish({ version: 1, persisted: true, changed: true, runtimeApplied: true, notificationDelivered: false, error: { code: 'NOTIFY_FAILED', message: '通知失败' }, snapshot: initial })
  await vi.waitFor(() => expect(success).toHaveBeenCalledWith('快捷键添加成功!'))
  expect(warning).toHaveBeenCalledWith('通知失败'); expect(mutate).toHaveBeenCalledOnce()
})
