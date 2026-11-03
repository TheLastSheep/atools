import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { appGlobalShortcutEntryChange } from '../../packages/ztools-settings/src/compatibility-patches/app-global-shortcuts.mjs'

it('the pinned entry routes only to Shortcuts and reports navigation failure, never early success', async () => {
  const original = readFileSync('/Users/harris/Desktop/ZTools/internal-plugins/setting/src/main.ts', 'utf8')
  expect(createHash('sha256').update(original).digest('hex')).toBe('bf94ee1f636d7e0643dd14fe9a13a0797138c8a7b022f0d482a96d6e7f82a8fb')
  expect(original.split(appGlobalShortcutEntryChange.before)).toHaveLength(2)
  const fragment = appGlobalShortcutEntryChange.after.replace('const app = createApp(App)', '')
  const js = ts.transpileModule(fragment, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const host = new EventTarget() as any, complete = vi.fn(), replace = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ type: 4 }).mockRejectedValueOnce(new Error('route'))
  host.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__ = complete
  new Function('window', 'router', js)(host, { replace })
  const intent = { id: 'c'.repeat(32), sequence: 1, target: { kind: 'app', path: '/B.app', name: 'B' } }
  host.dispatchEvent(new CustomEvent('atools-app-shortcuts-intent', { detail: intent }))
  await Promise.resolve(); await Promise.resolve()
  expect(replace).toHaveBeenCalledWith({ name: 'Shortcuts', query: { _t: '1' }, state: { appShortcutIntent: intent } })
  expect(complete).not.toHaveBeenCalled()
  host.dispatchEvent(new CustomEvent('atools-app-shortcuts-intent', { detail: { ...intent, sequence: 2 } }))
  host.dispatchEvent(new CustomEvent('atools-app-shortcuts-intent', { detail: { ...intent, sequence: 3 } }))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  await vi.waitFor(() => expect(complete.mock.calls).toEqual([[intent.id, 2, false], [intent.id, 3, false]]))
})
