import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import { aboutUpdatePatches } from '../../packages/ztools-settings/src/compatibility-patches/about-update.mjs'
import { aboutFixture } from './ztoolsSettingsAboutFixture'

const pinned = createRequire('/Users/harris/Desktop/ZTools/package.json')
const vue = pinned('vue') as any
const dependencies = createRequire('/Users/harris/Desktop/ZTools/node_modules/.pnpm/package.json')
const compiler = createRequire(dependencies.resolve('@vue/compiler-sfc'))('@vue/compiler-sfc') as any
const disposers: Array<() => void> = []
afterEach(() => { while (disposers.length) disposers.pop()!(); vi.unstubAllGlobals() })
function mountAbout() {
  const fixture = aboutFixture(), patch = aboutUpdatePatches[0]
  const original = readFileSync(`/Users/harris/Desktop/ZTools/${patch.path}`, 'utf8')
  expect(createHash('sha256').update(original).digest('hex')).toBe(patch.beforeSha256)
  let source = original
  for (const change of patch.changes) { expect(source.split(change.before)).toHaveLength(2); source = source.replace(change.before, change.after) }
  const before = compiler.parse(original).descriptor, after = compiler.parse(source).descriptor
  expect(after.template.content).toBe(before.template.content)
  expect(after.styles.map((s: any) => s.content)).toEqual(before.styles.map((s: any) => s.content))
  const compiled = compiler.compileScript(after, { id: 'r79-about', inlineTemplate: true })
  const code = ts.transpileModule(compiled.content, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const info = vi.fn(), error = vi.fn(), module = { exports: {} as any }
  new Function('require', 'module', 'exports', code)((name: string) => {
    if (name === 'vue') return vue
    if (name === '@/components') return { useToast: () => ({ info, error }) }
    throw new Error(`Unexpected About dependency ${name}`)
  }, module, module.exports)
  vi.stubGlobal('ztools', fixture.api)
  const previous = (window as any).ztools; (window as any).ztools = fixture.api
  const element = document.createElement('div'); document.body.append(element)
  const app = vue.createApp(module.exports.default); app.mount(element)
  let mounted = true
  const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
  disposers.push(() => { unmount(); fixture.bridge.dispose(); element.remove(); (window as any).ztools = previous })
  const checkbox = element.querySelector('#auto-check-update') as HTMLInputElement
  const button = element.querySelector('.check-update-btn') as HTMLButtonElement
  return { ...fixture, element, checkbox, button, info, error, unmount,
    toggle(enabled: boolean) { checkbox.checked = enabled; checkbox.dispatchEvent(new Event('change', { bubbles: true })) } }
}
it('mounts the full original About, shows native version and recovers exact no-update/update/error UI', async () => {
  const f = mountAbout()
  await vi.waitFor(() => expect(f.element.querySelector('.about-version')?.textContent).toBe('v0.9.79'))
  const release = f.hold('checkAppUpdate'); f.button.click(); f.button.click()
  await vue.nextTick(); expect(f.button.disabled).toBe(true)
  expect(f.calls.filter(c => c.operation === 'checkAppUpdate')).toHaveLength(1)
  release(); await vi.waitFor(() => expect(f.info).toHaveBeenCalledWith('当前已是最新版本'))
  expect(f.button.disabled).toBe(false)
  f.reply({ success: true, hasUpdate: true, status: 'available', updateInfo: { version: '1.0', changelog: '' } })
  f.button.click(); await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'checkAppUpdate')).toHaveLength(2))
  await vi.waitFor(() => expect(f.button.disabled).toBe(false)); expect(f.info).toHaveBeenCalledTimes(1)
  f.fail({ code: 'CHECK_FAILED' }); f.button.click()
  await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1)); expect(f.button.disabled).toBe(false)
})
it('captures rapid toggles and preserves one CAS per intent with no dbPut or setter double-write', async () => {
  const f = mountAbout(); await vi.waitFor(() => expect(f.calls.some(c => c.operation === 'ready')).toBe(true)); await vue.nextTick()
  const release = f.hold('setAutoCheckUpdate'); f.toggle(false)
  await vi.waitFor(() => expect(f.calls.at(-1)?.operation).toBe('setAutoCheckUpdate'))
  f.toggle(true); f.toggle(false); release()
  await vi.waitFor(() => expect(f.calls.filter(c => c.operation === 'setAutoCheckUpdate')).toHaveLength(3))
  await vue.nextTick(); expect(f.checkbox.checked).toBe(false)
  expect(f.calls.filter(c => c.operation === 'setAutoCheckUpdate').map(c => c.payload)).toEqual([
    { revision: 'rev-1', enabled: false }, { revision: 'rev-2', enabled: true }, { revision: 'rev-3', enabled: false },
  ]); expect(f.error).not.toHaveBeenCalled(); expect(f.committed().autoCheckUpdate).toBe(false)
})
it.each(['SETTINGS_REVISION_CONFLICT', 'WRITE_FAILED'])('rolls back on %s and stops queued intents', async code => {
  const f = mountAbout(); await vi.waitFor(() => expect(f.element.querySelector('.about-version')?.textContent).toBe('v0.9.79')); await vue.nextTick()
  const release = f.hold('setAutoCheckUpdate'); f.fail({ code }); f.toggle(false)
  await vi.waitFor(() => expect(f.calls.at(-1)?.operation).toBe('setAutoCheckUpdate'))
  f.toggle(true); f.toggle(false); release()
  await vi.waitFor(() => expect(f.error).toHaveBeenCalledTimes(1)); await vue.nextTick()
  expect(f.checkbox.checked).toBe(true); expect(f.committed().autoCheckUpdate).toBe(true)
  expect(f.calls.filter(c => c.operation === 'setAutoCheckUpdate')).toHaveLength(1)
})
it.each([[false, true], [true, false]])('retains saved truth when runtime=%s notification=%s is partial', async (runtime, notification) => {
  const f = mountAbout(); await vi.waitFor(() => expect(f.element.querySelector('.about-version')?.textContent).toBe('v0.9.79')); f.partial(runtime, notification)
  f.toggle(false); await vi.waitFor(() => expect(f.error).toHaveBeenCalledWith(expect.stringContaining('设置已保存')))
  expect(f.committed().autoCheckUpdate).toBe(false); expect(f.checkbox.checked).toBe(false)
})
it('unmount suppresses late check toasts and component writes while bridge pagehide rejects old requests', async () => {
  const f = mountAbout(); await vi.waitFor(() => expect(f.element.querySelector('.about-version')?.textContent).toBe('v0.9.79'))
  const release = f.hold('checkAppUpdate'); f.button.click(); f.unmount()
  f.target.dispatchEvent(new Event('pagehide')); release(); await Promise.resolve(); await vue.nextTick()
  expect(f.info).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled()
})

it('does not toast or consume a saved late toggle after the original About unmounts', async () => {
  const f = mountAbout(); await vi.waitFor(() => expect(f.element.querySelector('.about-version')?.textContent).toBe('v0.9.79'))
  const release = f.hold('setAutoCheckUpdate'); f.partial(); f.toggle(false)
  await vi.waitFor(() => expect(f.calls.at(-1)?.operation).toBe('setAutoCheckUpdate'))
  f.unmount(); release(); await vi.waitFor(() => expect(f.committed().autoCheckUpdate).toBe(false))
  await vue.nextTick(); expect(f.info).not.toHaveBeenCalled(); expect(f.error).not.toHaveBeenCalled()
})
