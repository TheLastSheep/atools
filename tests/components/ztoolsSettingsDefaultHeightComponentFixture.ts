import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { vi } from 'vitest'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
import { createHotkeyBridge, GENERAL } from './ztoolsSettingsHotkeyBridgeFixture'
import type { SettingsBridgeTarget } from '../../packages/ztools-settings/src/childBridgeTypes'

const upstream = '/Users/harris/Desktop/ZTools'
const pinned = createRequire(`${upstream}/package.json`)
const packages = createRequire(`${upstream}/node_modules/.pnpm/package.json`)
const { parse, compileScript } = createRequire(packages.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc')
const vue = pinned('vue') as Record<string, any>

export async function defaultHeightComponentFixture(height = 500) {
  const path = 'internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue'
  const patch = settingsSourceCompatibilityPatches.find((item: any) => item.path === path)!
  const original = readFileSync(`${upstream}/${path}`, 'utf8')
  if (createHash('sha256').update(original).digest('hex') !== patch.beforeSha256) throw new Error('Pinned General source changed')
  let source = original
  let baseline = original
  for (const change of patch.changes) {
    if (source.split(change.before).length !== 2) throw new Error(`General marker drift: ${change.id}`)
    source = source.replace(change.before, change.after)
    if (change.kind !== 'default-height') baseline = baseline.replace(change.before, change.after)
  }
  const before = parse(baseline).descriptor, after = parse(source).descriptor
  if (before.template.content !== after.template.content || before.styles[0].content !== after.styles[0].content) {
    throw new Error('Original General template/styles changed')
  }
  // Test-only handles await the actual compiled async handlers without guessed flush counts.
  const exposed = source.replace('</script>', '\ndefineExpose({ handleWindowDefaultHeightChange, resetWindowDefaultHeight })\n</script>')
  const script = compileScript(parse(exposed).descriptor, { id: 'r75-general-height', inlineTemplate: true })
  const code = ts.transpileModule(script.content, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } }).outputText
  const errors: string[] = []
  const module = { exports: {} as Record<string, any> }
  const stub = { render: () => null }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === 'vue-router') return { useRouter: () => ({ push() {} }) }
    if (name === '@/constants') return { DEFAULT_AVATAR: '/fixture-avatar.png', DEFAULT_PLACEHOLDER: 'Search' }
    if (name === '@/components') return { Dropdown: stub, HotkeyInput: stub, Slider: stub,
      useToast: () => ({ error: (message: string) => errors.push(message), success() {}, info() {}, confirm: async () => false }) }
    if (name === '@/utils') return { applyCustomColor() {}, applyPrimaryColor() {} }
    throw new Error(`Unexpected General dependency: ${name}`)
  }, module, module.exports)
  const host = createHotkeyBridge(true, GENERAL.hotkey, { target: window as unknown as SettingsBridgeTarget, defaultHeight: height })
  const setter = vi.spyOn(host.internal, 'setWindowDefaultHeight')
  const root = document.createElement('div'); document.body.append(root)
  const app = vue.createApp(module.exports.default); const vm = app.mount(root)
  let row!: Element, input!: HTMLInputElement
  const dispose = () => { app.unmount(); root.remove(); host.bridge.dispose(); setter.mockRestore() }
  try {
    await vi.waitFor(() => {
      row = Array.from(root.querySelectorAll('.setting-item')).find(item => item.querySelector('.setting-label span')?.textContent === '插件默认高度')!
      if (!row) throw new Error('General height not rendered')
      input = row.querySelector('input') as HTMLInputElement
      if (input.value !== String(height)) throw new Error('General height not loaded')
    })
  } catch (error) { dispose(); throw error }
  return { host, root, input, errors, setter,
    inputDraft(value: string) { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })) },
    blur() { input.dispatchEvent(new Event('blur')) },
    enter() { input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true })) },
    async reset() { await vue.nextTick(); (row.querySelector('button[title="重置"]') as HTMLButtonElement).click() },
    async tick() { await vue.nextTick() },
    commit: () => vm.handleWindowDefaultHeightChange() as Promise<void>,
    commitReset: () => vm.resetWindowDefaultHeight() as Promise<void>,
    dispose
  }
}
