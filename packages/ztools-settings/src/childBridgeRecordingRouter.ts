import type { SettingsHotkeyRecordingController } from './childBridgeHotkeyRecording'

export function routeSettingsRecording(general: SettingsHotkeyRecordingController, app: SettingsHotkeyRecordingController, hash: () => string): SettingsHotkeyRecordingController {
  return {
    attach: general.attach,
    start: () => /^#\/shortcuts(?:[?#]|$)/i.test(hash()) ? app.start() : general.start(),
    stop: async () => { await Promise.all([general.stop(), app.stop()]) },
    onRecorded: (callback: unknown) => { const a = general.onRecorded(callback), b = app.onRecorded(callback); return () => { a(); b() } },
    onStopped: (callback: unknown) => { const a = general.onStopped(callback), b = app.onStopped(callback); return () => { a(); b() } },
    dispose: general.dispose
  }
}
