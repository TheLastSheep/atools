import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { installAppShortcutIntentReceiver } from '../../packages/ztools-settings/src/appShortcutIntent'
it('the actual host entry installs receiver before attach and sends the exact ACK operation', async () => {
  const source = readFileSync('packages/ztools-settings/src/hostBridgeEntry.ts', 'utf8')
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const host = new EventTarget() as any, invoke = vi.fn(async () => ({ acknowledged: true }))
  const sessionId = 'b'.repeat(32); host.__ATOOLS_SETTINGS_VIEW_CONFIG__ = { sessionId }; host.__TAURI__ = { core: { invoke } }
  let out!: () => void
  const bridge = { attach(target: any) { expect(typeof target.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__).toBe('function'); target.ztools = { onPluginOut(cb: () => void) { out = cb } } } }
  const module = { exports: {} }
  new Function('require', 'module', 'exports', 'window', js)((name: string) => {
    if (name === './appShortcutIntent') return { installAppShortcutIntentReceiver }
    if (name === '@/components/common/Toast/Toast') return { useToast: () => ({ error: vi.fn() }) }
    if (name === '@/constants') return { DEFAULT_AVATAR: '' }
    if (name === './childBridge') return { createSettingsChildBridge: () => bridge }
    if (name === './childBridgeProtocol') return { SETTINGS_HOST_FAILURE_MESSAGE: 'error' }
    throw Error(name)
  }, module, module.exports, host)
  const packet = { version: 1, id: 'c'.repeat(32), sessionId, sequence: 1, target: { kind: 'app', path: '/A.app', name: 'A' } }
  expect(host.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__(packet)).toBe(true)
  expect(host.__ATOOLS_SETTINGS_COMPLETE_APP_SHORTCUT_INTENT__(packet.id, 1, true)).toBe(true)
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('call_renderer_settings', { sessionId, operation: 'ackAppShortcutIntent', payload: { id: packet.id, sequence: 1, accepted: true } }))
  out(); expect(host.__ATOOLS_SETTINGS_DELIVER_APP_SHORTCUT_INTENT__).toBeUndefined()
})
