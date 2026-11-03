import { expect, it, vi } from 'vitest'
import { originalHotkeyComponent } from './ztoolsSettingsHotkeyRecordingComponentFixture'
it('original Shortcuts input does not install DOM recording after native start fails', async () => {
  const original = (window as any).ztools, hash = window.location.hash
  history.replaceState(null, '', '#/shortcuts')
  const changed = vi.fn(), stop = vi.fn(async () => {})
  ;(window as any).ztools = { internal: { startHotkeyRecording: async () => ({ success: false }), stopHotkeyRecording: stop } }
  const { component, runtime } = originalHotkeyComponent()
  const el = document.createElement('div'); document.body.append(el)
  const app = runtime.createApp(component, { modelValue: '', onChange: changed }); app.mount(el)
  try {
    ;(el.querySelector('.hotkey-input') as HTMLElement).click()
    await Promise.resolve(); await Promise.resolve(); await runtime.nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, bubbles: true }))
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', ctrlKey: true, bubbles: true }))
    await runtime.nextTick()
    expect(changed).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1)
    expect(el.textContent).not.toContain('请按下快捷键')
  } finally { app.unmount(); el.remove(); (window as any).ztools = original; history.replaceState(null, '', hash || '#/') }
})
