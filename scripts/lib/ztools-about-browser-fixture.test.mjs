import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createAboutBrowserFixture } from './ztools-about-browser-fixture.mjs'

test('About fake transport enforces sessions and closed DTOs, CAS and saved truth', async () => {
  const f = createAboutBrowserFixture(), notifications = []
  const call = (operation, payload, sessionId = 'session') => f.handle({ operation, payload, sessionId }, { sessionId: 'session', publish: async raw => notifications.push(JSON.parse(raw)) })
  assert.deepEqual((await call('getAppVersion', {})).value, { appVersion: '0.9.79' })
  assert.equal((await call('getAppVersion', { extra: true })).ok, false)
  assert.equal((await call('checkAppUpdate', {}, 'stale')).ok, false)
  f.checkMode('update'); assert.equal((await call('checkAppUpdate', {})).value.hasUpdate, true)
  assert.equal(f.snapshot().showIntents, 1)
  f.autoMode('runtime'); const result = await call('setAutoCheckUpdate', { revision: f.read().revision, enabled: false })
  assert.equal(result.value.runtimeApplied, false); assert.equal(result.value.value.autoCheckUpdate, false)
  assert.deepEqual(f.snapshot().raw.future, { keep: 'opaque' }); assert.deepEqual(notifications, [{ autoCheckUpdate: false }])
  f.autoMode('conflict'); const before = f.snapshot().raw
  assert.equal((await call('setAutoCheckUpdate', { revision: f.read().revision, enabled: true })).code, 'SETTINGS_REVISION_CONFLICT')
  assert.deepEqual(f.snapshot().raw, before)
  assert.equal((await call('patchGeneral', {})).ok, false)
})

test('held reply is rejected when its owning Child generation closes', async () => {
  const f = createAboutBrowserFixture(); let live = true
  f.holdNext('checkAppUpdate')
  const result = f.handle({ operation: 'checkAppUpdate', payload: {}, sessionId: 'old' }, { sessionId: 'old', isLive: () => live, publish: async () => {} })
  assert.equal(f.isHeld, true); live = false; f.release()
  assert.equal((await result).code, 'ERR_ATOOLS_SETTINGS_SESSION')
  assert.equal(f.snapshot().calls[0].status, 'rejected')
})

test('decorated Main and Child bootstrap are valid JavaScript', async () => {
  const { createMainSettingsInputBootstrap } = await import('./ztools-settings-input-browser-fixture.mjs')
  const f = createAboutBrowserFixture()
  assert.doesNotThrow(() => new Function(f.decorateMain(createMainSettingsInputBootstrap())))
  assert.doesNotThrow(() => new Function(f.decorateChild('void 0;')))
})
