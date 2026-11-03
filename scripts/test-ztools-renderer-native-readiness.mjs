import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../src-tauri/src/renderer_desktop_smoke/probe.js', import.meta.url), 'utf8')

async function observeReadiness(appListReads) {
  const eventSource = {
    subscribers: 1, listenerState: 'listening', deliveredEvents: 0,
    registrationErrors: 0, callbackErrors: 0, registrationsPending: 0,
    cleanupPending: 0, cleanupErrors: 0,
  }
  const nativeCalls = { get_ztools_renderer_settings: 1 }
  if (appListReads !== undefined) nativeCalls.list_launcher_apps = appListReads
  const snapshot = {
    disposed: false, outstandingNativeCalls: 0, nativeCalls,
    focusEvents: eventSource,
    appCatalog: { cachedApps: 0, readPending: false, eventSource },
    settingsSnapshot: { cached: 14, inFlight: false },
    appState: { historySubscribers: 1, pinnedSubscribers: 1, eventSource },
    contextMenu: { subscribers: 1, eventSource },
  }
  const messages = []
  let clock = 0
  await vm.runInNewContext(source, {
    document: { querySelector: () => ({}) },
    Date: { now: () => (clock += 13000) },
    window: {
      __ATOOLS_ZTOOLS_HOST_ADAPTER__: { snapshot: () => snapshot },
      __TAURI__: { core: { invoke: async (command, payload) => { messages.push({ command, payload }) } } },
    },
  })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].command, 'renderer_probe_ready')
  return messages[0].payload.evidence
}

test('completed settings IPC and installed listeners do not substitute for app-list reading', async () => {
  for (const count of [undefined, 0, -1, 1.5, '1']) {
    const evidence = await observeReadiness(count)
    assert.equal(evidence.nativeListenersListening, true)
    assert.equal(evidence.settingsCacheCount, 14)
    assert.equal(evidence.ready, false)
  }
})

test('an observed settled app-list read allows an empty application catalog', async () => {
  const evidence = await observeReadiness(1)
  assert.equal(evidence.appCatalogReadCount, 1)
  assert.equal(evidence.ready, true)
})
