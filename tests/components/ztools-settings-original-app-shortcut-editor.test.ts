import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { appGlobalShortcutPatches } from '../../packages/ztools-settings/src/compatibility-patches/app-global-shortcuts.mjs'
const root = '/Users/harris/Desktop/ZTools'
const vue = createRequire(`${root}/package.json`)('vue') as any
const dep = createRequire(`${root}/node_modules/.pnpm/package.json`)
const compiler = createRequire(dep.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc') as any
let dispose = () => {}
afterEach(() => { dispose(); vi.restoreAllMocks() })
it('actual editor keeps the selected app identity despite duplicate names and requires authority for a legacy row', async () => {
  const patch = appGlobalShortcutPatches[0], original = readFileSync(`${root}/${patch.path}`, 'utf8')
  expect(createHash('sha256').update(original).digest('hex')).toBe(patch.beforeSha256)
  let source = original
  for (const change of patch.changes) { expect(source.split(change.before)).toHaveLength(2); source = source.replace(change.before, change.after) }
  const before = compiler.parse(original).descriptor, after = compiler.parse(source).descriptor
  expect(after.template.content).toBe(before.template.content)
  expect(after.styles.map((x: any) => x.content)).toEqual(before.styles.map((x: any) => x.content))
  const compiled = compiler.compileScript(after, { id: 'r80-editor', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const component = { exports: {} as any }
  const HotkeyInput = { props: ['modelValue'], emits: ['update:modelValue'], setup(props: any, { emit }: any) { return () => vue.h('input', { value: props.modelValue, onInput: (event: any) => emit('update:modelValue', event.target.value) }) } }
  const Selector = { props: ['options'], emits: ['select'], setup(props: any, { emit }: any) { return () => vue.h('div', props.options.map((item: any) => vue.h('button', { class: 'target', onClick: () => emit('select', item) }, item.path))) } }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === '@/components/common/Toast') return { useToast: () => ({ warning: vi.fn() }) }
    if (name === '@/components') return { HotkeyInput, DetailPanel: { setup(_props: any, { slots }: any) { return () => vue.h('div', slots.default?.()) } } }
    if (name.endsWith('/CommandTargetSelector.vue')) return { default: Selector }
    if (name.endsWith('/ShortcutsSetting')) return { normalizeShortcutTargetValue: (x: string) => x, buildShortcutTargetCandidates: (x: any) => [x.value] }
    throw Error(name)
  }, component, component.exports)
  let releaseStop!: () => void
  const stop = new Promise<void>(resolve => { releaseStop = resolve })
  const previous = (window as any).ztools; (window as any).ztools = { internal: { getPlatform: () => 'darwin', stopHotkeyRecording: () => stop } }
  const options = ['/A.app', '/B.app'].map((path, i) => ({ commandId: String(i), type: 'direct', subType: 'app', path, value: 'Same', cmdName: 'Same' }))
  const saved = vi.fn(), el = document.createElement('div'); document.body.append(el)
  const app = vue.createApp(component.exports.default, { editingShortcut: { id: 'old', target: 'Same', shortcut: 'Alt+A', enabled: true }, targetOptions: options, onSave: saved }); app.mount(el)
  dispose = () => { app.unmount(); el.remove(); (window as any).ztools = previous }
  const save = Array.from(el.querySelectorAll('button')).find(button => button.textContent?.trim() === '确定') as HTMLButtonElement
  if (!save) throw new Error(el.innerHTML)
  expect(save.disabled).toBe(true)
  ;(el.querySelectorAll('button.target')[1] as HTMLButtonElement).click(); await vue.nextTick()
  expect(save.disabled).toBe(false); save.click(); await Promise.resolve(); expect(saved).not.toHaveBeenCalled()
  releaseStop(); await Promise.resolve(); await vue.nextTick()
  expect(saved).toHaveBeenCalledWith('Alt+A', 'Same', false, options[1])
})
