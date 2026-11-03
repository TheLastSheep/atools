import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { settingsSourceCompatibilityPatches } from '../../packages/ztools-settings/src/compatibility-patches/index.mjs'
import { aboutFixture } from './ztoolsSettingsAboutFixture'

const upstream = '/Users/harris/Desktop/ZTools'
const pinned = createRequire(`${upstream}/package.json`), deps = createRequire(`${upstream}/node_modules/.pnpm/package.json`)
const local = createRequire(`${process.cwd()}/packages/ztools-settings/package.json`)
const vue = local('vue') as any
const compiler = createRequire(deps.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc') as any
function component(path: string) {
  const original = readFileSync(`${upstream}/${path}`, 'utf8')
  const patch = settingsSourceCompatibilityPatches.find((p: any) => p.path === path)!
  expect(createHash('sha256').update(original).digest('hex')).toBe(patch.beforeSha256)
  let source = original
  for (const c of patch.changes) { expect(source.split(c.before)).toHaveLength(2); source = source.replace(c.before, c.after) }
  const a = compiler.parse(original).descriptor, b = compiler.parse(source).descriptor
  // General has earlier reviewed template patches; About itself remains byte-identical.
  if (path.includes('AboutSetting')) { expect(b.template.content).toBe(a.template.content); expect(b.styles.map((s: any) => s.content)).toEqual(a.styles.map((s: any) => s.content)) }
  const script = compiler.compileScript(b, { id: path.includes('About') ? 'r79-close-about' : 'r79-close-general', inlineTemplate: true })
  const code = ts.transpileModule(script.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText
  const module = { exports: {} as any }, stub = { render: () => null }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === 'vue-router') return { useRouter: () => ({ push() {} }) }
    if (name === '@/constants') return { DEFAULT_AVATAR: '/fixture-avatar.png', DEFAULT_PLACEHOLDER: 'Search' }
    if (name === '@/components') return { Dropdown: stub, HotkeyInput: stub, Slider: stub, useToast: () => ({ error() {}, success() {}, info() {}, confirm: async () => false }) }
    if (name === '@/utils') return { applyCustomColor() {}, applyPrimaryColor() {} }
    throw new Error(`unexpected SFC dependency: ${name}`)
  }, module, module.exports)
  return module.exports.default
}
it('closing an About conflict does not cause General to apply opacity', async () => {
  const f = aboutFixture(), originalMain = readFileSync(`${upstream}/internal-plugins/setting/src/main.ts`, 'utf8')
  const closePatch = settingsSourceCompatibilityPatches.find((p: any) => p.path.endsWith('/src/main.ts'))!
  expect(createHash('sha256').update(originalMain).digest('hex')).toBe(closePatch.beforeSha256)
  let patchedMain = originalMain
  for (const c of closePatch.changes) { expect(patchedMain.split(c.before)).toHaveLength(2); patchedMain = patchedMain.replace(c.before, c.after) }
  expect(patchedMain).toContain('ztools.onPluginEnter')
  const callback = patchedMain.match(/ztools\.onPluginOut\(\(\) => \{[\s\S]*?\n\}\)/)?.[0]
  expect(callback).toBeTruthy()
  const previous = (window as any).ztools; (window as any).ztools = f.api; vi.stubGlobal('ztools', f.api); (window as any).__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__ = f.target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const setter = vi.spyOn(f.api.internal, 'setWindowOpacity')
  const root = document.createElement('div'); document.body.append(root)
  const vueRouter = local('vue-router') as any
  const router = vueRouter.createRouter({ history: vueRouter.createMemoryHistory(), routes: [
    { path: '/', redirect: '/about' },
    { path: '/about', name: 'AboutSetting', component: component('internal-plugins/setting/src/views/AboutSetting/AboutSetting.vue') },
    { path: '/general', name: 'GeneralSetting', component: component('internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue') },
  ] })
  const replace = vi.spyOn(router, 'replace')
  const app = vue.createApp({ render: () => vue.h(vueRouter.RouterView) }); app.use(router)
  await router.push('/about'); await router.isReady(); app.mount(root)
  try {
    new Function('ztools', 'router', callback!)(f.api, router)
    await vi.waitFor(() => expect(root.querySelector('.about-version')?.textContent).toBe('v0.9.79'))
    f.fail({ code: 'SETTINGS_REVISION_CONFLICT' })
    const input = root.querySelector('#auto-check-update') as HTMLInputElement
    input.checked = false; input.dispatchEvent(new Event('change', { bubbles: true }))
    await vi.waitFor(() => expect(f.calls.some(c => c.operation === 'setAutoCheckUpdate')).toBe(true))
    await vi.waitFor(() => expect(input.checked).toBe(true))
    const close = f.api.outPlugin(); void close.catch(() => {})
    await vue.nextTick(); await vue.nextTick()
    expect(replace).not.toHaveBeenCalled()
    expect(router.currentRoute.value.name).toBe('AboutSetting')
    expect(setter).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(f.committed().autoCheckUpdate).toBe(true)
    expect(f.calls.filter(c => c.operation === 'close')).toHaveLength(1)
    const second = f.api.outPlugin(); void second.catch(() => {})
    await vue.nextTick(); expect(replace).not.toHaveBeenCalled()
    expect(f.calls.filter(c => c.operation === 'close')).toHaveLength(2)
    // A new session can still enter the original General page and apply its real initial opacity.
    app.unmount(); f.bridge.dispose()
    const fresh = aboutFixture(); (window as any).ztools = fresh.api
    ;(window as any).__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__ = fresh.target.__ATOOLS_SETTINGS_CREATE_LAUNCH_AT_LOGIN_CONTROLLER__
    const freshSetter = vi.spyOn(fresh.api.internal, 'setWindowOpacity')
    const next = vue.createApp(component('internal-plugins/setting/src/views/GeneralSetting/GeneralSetting.vue')); next.mount(root)
    await vi.waitFor(() => expect(freshSetter).toHaveBeenCalledWith(0.8))
    next.unmount(); fresh.bridge.dispose()
  } finally { app.unmount(); root.remove(); f.bridge.dispose(); (window as any).ztools = previous; vi.unstubAllGlobals() }
})

it('keeps Native-delivered out acknowledgement while the original callback does not remount General', async () => {
  const f = aboutFixture(), main = readFileSync(`${upstream}/internal-plugins/setting/src/main.ts`, 'utf8')
  const patch = settingsSourceCompatibilityPatches.find((p: any) => p.path.endsWith('/src/main.ts'))!
  expect(createHash('sha256').update(main).digest('hex')).toBe(patch.beforeSha256)
  const change = patch.changes[0]; expect(main.split(change.before)).toHaveLength(2)
  const callback = main.replace(change.before, change.after).match(/ztools\.onPluginOut\(\(\) => \{[\s\S]*?\n\}\)/)![0]
  const router = { currentRoute: { value: { name: 'AboutSetting' } }, replace: vi.fn() }
  try {
    new Function('ztools', 'router', callback)(f.api, router)
    const deliver = f.target.__ATOOLS_SETTINGS_DELIVER_OUT__!
    await expect(deliver()).rejects.toBeDefined() // The fixture does not supply a Native acknowledgement.
    expect(f.calls.filter(c => c.operation === 'outAcknowledged')).toHaveLength(1)
    expect(router.replace).not.toHaveBeenCalled()
  } finally { f.bridge.dispose() }
})
