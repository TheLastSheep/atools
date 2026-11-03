import { expect, it, vi } from 'vitest'
import { createRendererContextMenu, type RendererContextMenuItem } from '../../packages/ztools-renderer/src/contextMenu'
import { createRendererAppLaunchTargets } from '../../packages/ztools-renderer/src/appLaunchTargets'

it('permits only exact app shortcut children under More and emits shown command once', async () => {
  let deliver!: (v: unknown) => void
  const show = vi.fn(async () => undefined)
  const menu = createRendererContextMenu({ transport: { listen: async (_name, cb) => { deliver = cb; return () => {} } }, show })
  const callback = vi.fn(); menu.subscribe(callback)
  await Promise.resolve(); await Promise.resolve()
  const id = 'add-global-shortcut:' + JSON.stringify({ path: '/A.app', name: 'A', subType: 'app' })
  const bad = 'add-global-shortcut:' + JSON.stringify({ path: '/B.app', name: 'A', subType: 'local-shortcut' })
  await menu.showContextMenu([{ label: '更多', submenu: [{ id, label: '设置全局快捷键' }, { id: bad, label: 'bad' }] }])
  expect(show).toHaveBeenCalledWith([{ label: '更多', submenu: [{ id, label: '设置全局快捷键', enabled: true }] }])
  deliver(bad); deliver(id); deliver(id)
  expect(callback).toHaveBeenCalledTimes(1); expect(callback).toHaveBeenCalledWith(id)
  menu.dispose()
})
it('routes the exact app intent through catalog authority without launching plugins', async () => {
  const open = vi.fn(async () => undefined), launch = vi.fn(async () => undefined)
  const rejectUnsupported = vi.fn(async () => { throw Error('unsupported') })
  const client = createRendererAppLaunchTargets({
    resolveApp: async path => path === '/A.app' ? { path, name: 'A' } : undefined,
    getLocalShortcuts: async () => [], launch, openAppShortcuts: open,
    revealApp: async () => undefined, revealLocal: async () => undefined,
    rejectUnsupported, ensureActive() {}
  })
  const app = { path: '/A.app', name: 'A', subType: 'app' }
  await client.launch({ type: 'plugin', name: '快捷键', path: '/setting', cmdType: 'text', featureCode: 'ui.router?router=Shortcuts', param: { payload: app } })
  expect(open).toHaveBeenCalledWith(app); expect(launch).not.toHaveBeenCalled()
  await expect(client.launch({ type: 'plugin', featureCode: 'other', param: { payload: app } })).rejects.toThrow()
  await expect(client.launch({ type: 'plugin', name: '快捷键', path: '/setting', cmdType: 'text', featureCode: 'ui.router?router=Shortcuts', param: { payload: { ...app, path: '/missing' } } })).rejects.toThrow()
})
it('accepts bounded long app ids while retaining independent path and name limits', async () => {
  const show = vi.fn(async (_items: RendererContextMenuItem[]) => undefined)
  const menu = createRendererContextMenu({ transport: { listen: async () => () => {} }, show })
  const item = (path: string, name: string) => ({ label: '更多', submenu: [{ id: 'add-global-shortcut:' + JSON.stringify({ path, name, subType: 'app' }), label: '快捷键' }] })
  await menu.showContextMenu([item('/' + 'a'.repeat(16000), 'n'.repeat(2000))])
  expect(show.mock.calls[0][0][0]).toHaveProperty('submenu')
  await menu.showContextMenu([item('/' + '\\'.repeat(9000), '"quoted"')])
  expect(show.mock.calls[1][0][0]).toHaveProperty('submenu')
  await menu.showContextMenu([item('/' + 'a'.repeat(16384), 'n')])
  expect(show.mock.calls[2][0][0]).toMatchObject({ enabled: false })
  menu.dispose()
})
