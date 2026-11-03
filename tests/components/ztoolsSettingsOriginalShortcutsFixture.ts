import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { vi } from 'vitest'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
import { builtinSettingsFixture } from './ztoolsSettingsBuiltinShortcutsFixture'

const upstream = '/Users/harris/Desktop/ZTools'
const requirePinned = createRequire(`${upstream}/package.json`)
const requirePackages = createRequire(`${upstream}/node_modules/.pnpm/package.json`)
const { parse, compileScript } = createRequire(requirePackages.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc')
const runtime = requirePinned('vue') as Record<string, any>

/** Mount the complete pinned SFC; only unrelated service/component imports are stubbed. */
export function originalShortcutsFixture(host = builtinSettingsFixture()) {
  const path = 'internal-plugins/setting/src/views/ShortcutsSetting/ShortcutsSetting.vue'
  const patch = settingsSourceCompatibilityPatches.find((entry: any) => entry.path === path)!
  const original = readFileSync(`${upstream}/${path}`, 'utf8')
  if (createHash('sha256').update(original).digest('hex') !== patch.beforeSha256) throw new Error('Pinned ShortcutsSetting source changed')
  let source = original
  for (const change of patch.changes) {
    if (source.split(change.before).length !== 2) throw new Error(`Patch marker drift ${change.id}`)
    source = source.replace(change.before, change.after)
  }
  const before = parse(original).descriptor, after = parse(source).descriptor
  if (before.template.content !== after.template.content ||
      JSON.stringify(before.styles.map((style: any) => style.content)) !== JSON.stringify(after.styles.map((style: any) => style.content))) {
    throw new Error('Original template/styles changed')
  }
  const compiled = compileScript(after, { id: 'r74-original-shortcuts', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true
  } }).outputText
  const success = vi.fn(), error = vi.fn(), warning = vi.fn()
  const stub = { render: () => null }
  const module = { exports: {} as Record<string, any> }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return runtime
    if (name === '@/components') return { useToast: () => ({ success, error, warning, confirm: async () => false }), ShortcutEditor: stub, AdaptiveIcon: stub }
    if (name === '@/utils') return { weightedSearch: (values: unknown[]) => values }
    if (name === '@/composables') return { useJumpFunction() {}, useZtoolsSubInput: () => ({ value: runtime.ref('') }) }
    if (name === '@shared/commandShared') return {
      COMMAND_ALIASES_KEY: 'command-aliases', DIRECT_APP_ALIAS_GROUP_KEY: 'apps',
      DIRECT_APP_ALIAS_GROUP_TITLE: 'apps', getCommandId: () => '', normalizeCommandAliases: () => ({})
    }
    if (name === '@/views/ShortcutsSetting/ShortcutsSetting') return { buildShortcutTargetValue: () => '' }
    if (name === './components/AliasMappingDialog.vue') return { default: stub }
    throw new Error(`Unexpected original ShortcutsSetting import ${name}`)
  }, module, module.exports)
  const previous = (window as any).ztools
  const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
  ;(window as any).ztools = { internal: {
    dbGet: (key: string) => key === 'settings-general' ? host.bridge.dbGet(key) : Promise.resolve([]),
    readAppGlobalShortcuts: async () => ({ version: 1, revision: 'a'.repeat(32), rows: [], bindings: [], runtime: [] }),
    dbPut: host.bridge.dbPut, getCommands: async () => ({ plugins: [], commands: [] })
  } }
  const root = document.createElement('div'); document.body.append(root)
  const app = runtime.createApp(module.exports.default); app.mount(root)
  const tab = Array.from(root.querySelectorAll('button')).find(button => button.textContent?.trim() === '应用快捷键')!
  tab.click()
  function checkbox(description = '关闭插件/隐藏窗口'): HTMLInputElement {
    const row = Array.from(root.querySelectorAll('.built-in')).find(row => row.querySelector('.shortcut-desc')?.textContent === description)
    if (!row) throw new Error(`Original row missing: ${description}; rendered text: ${root.textContent?.slice(0, 600)}`)
    return row.querySelector('input[type=checkbox]')!
  }
  return { root, host, checkbox, success, error, async ready() {
    await vi.waitFor(() => { if (!checkbox()) throw new Error('Checkbox not mounted') })
    await runtime.nextTick()
  }, dispose() { app.unmount(); root.remove(); (window as any).ztools = previous; platform.mockRestore(); host.close() } }
}
