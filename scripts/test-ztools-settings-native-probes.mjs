import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

import {
  cleanup,
  config,
  createGeneral,
  createHarness,
  createReady
} from './ztools-settings-child-bridge-test-helpers.mjs'

const probeSource = await readFile(
  new URL('../src-tauri/src/renderer_desktop_smoke/settings_journey/child-probe.js', import.meta.url),
  'utf8'
)
const probeToken = 'fixture-only-settings-probe-token'
const initialPlaceholder = 'atools-native-settings-initial'
const fixedPlaceholder = 'atools-native-settings-fixed'
const secretSentinels = [
  'ATools-Fake-AI-Secret-Do-Not-Expose',
  'ATools-Fake-WebDAV-Password-Do-Not-Expose',
  'ATools-Fake-Unknown-Nested-Secret-Do-Not-Expose',
  'ATools-Fake-Proxy-URL-Do-Not-Expose',
  'ATools-Fake-Terminal-Command-Do-Not-Expose'
]

async function testSettingsChildNativeReadinessAndSaveProbe() {
  let general = createGeneral({ placeholder: initialPlaceholder })
  let revision = 'rev-1'
  let readyCalls = 0
  let forceNarrowReadMismatch = false
  const runtimeCalls = []
  const nativeCalls = []
  const probeReports = []
  const coreAclError = [
    'window.is_visible not allowed on window "main", webview "ztools-settings-' +
      config.sessionId + '", URL: local',
    'allowed on: [webviews: "main", "settings", URL: local]',
    'referenced by: capability: default, permission: allow-is-visible'
  ].join('\n\n')
  let coreError = coreAclError
  const privateRawFixture = JSON.stringify({
    aiApiKey: secretSentinels[0],
    webdavPassword: secretSentinels[1],
    unknown: { nested: secretSentinels[2] },
    proxyUrl: secretSentinels[3],
    terminalCustomCommand: secretSentinels[4]
  })
  const readyReply = () => createReady({
    revision,
    general: structuredClone(general)
  })
  const harness = createHarness({
    initial: readyReply(),
    invokeOverride: ({ operation, payload }) => {
      if (operation === 'ready') {
        readyCalls += 1
        return readyReply()
      }
      if (operation === 'patchGeneral') {
        assert.equal(payload.revision, revision)
        general = { ...general, ...structuredClone(payload.changes) }
        revision = 'rev-' + (Number(revision.slice(4)) + 1)
        return {
          revision,
          value: structuredClone(general),
          notificationDelivered: true
        }
      }
      if (operation === 'setTheme') return { theme: payload.theme, themeApplied: true }
      if (operation === 'setWindowOpacity') {
        return { opacity: payload.opacity, opacityApplied: true }
      }
      throw new Error('unexpected child bridge operation: ' + operation)
    }
  })

  const internal = harness.target.ztools.internal
  for (const name of [
    'getPlatform',
    'getCurrentShortcut',
    'getLaunchAtLogin',
    'dbGet',
    'setTheme',
    'setWindowOpacity'
  ]) {
    const original = internal[name].bind(internal)
    internal[name] = (...args) => {
      runtimeCalls.push({ name, args })
      return original(...args)
    }
  }

  let input
  const document = {
    querySelector(selector) {
      if (selector === '.content-panel:not([aria-busy="true"])') return {}
      if (selector === '.content-panel .setting-group') return {}
      if (selector === 'input.input[placeholder="输入提示文字"]') return input
      return null
    }
  }
  const window = harness.target
  window.__TAURI_INTERNALS__ = {
    async invoke(command, args) {
      if (command === 'settings_journey_probe') {
        probeReports.push(structuredClone(args))
        return undefined
      }
      if (command !== 'call_renderer_settings') throw new Error('unexpected native command')
      nativeCalls.push(args.operation)
      if (args.operation === 'ready') throw new Error('probe must not repeat native ready')
      if (args.operation !== 'readGeneral') throw new Error('unexpected native settings operation')
      if (args.sessionId !== config.sessionId) {
        throw {
          code: 'SETTINGS_CALLER_REJECTED',
          message: 'Settings view caller is not the active child'
        }
      }
      const value = structuredClone(general)
      if (forceNarrowReadMismatch) value.placeholder = 'fixture-narrow-read-mismatch'
      return { revision, value }
    }
  }
  window.__TAURI__ = {
    core: {
      async invoke(command, args) {
        if (command === 'settings_journey_probe') {
          probeReports.push(structuredClone(args))
          return undefined
        }
        if (command === 'get_setting') {
          throw {
            code: 'CHILD_WEBVIEW_APP_COMMAND_DENIED',
            message: 'Child WebViews cannot invoke application commands'
          }
        }
        if (command === 'plugin:window|is_visible') {
          throw coreError
        }
        throw new Error('unexpected app command')
      }
    }
  }
  window.crypto = { randomUUID: () => 'fixture-document-identity' }
  window.top = window
  window.frameElement = null
  window.document = document
  const originalRawValue = general.placeholder

  class FixtureInput {
    constructor() {
      this._value = originalRawValue
      this.isConnected = true
    }

    get value() {
      return this._value
    }

    set value(value) {
      this._value = value
    }

    dispatchEvent(event) {
      if (event.type === 'input') {
        const next = { ...general, placeholder: this.value }
        void window.ztools.internal.dbPut('settings-general', next)
      }
      return true
    }

    focus() {}
    blur() {}
  }
  class FixtureInputEvent {
    constructor(type, init = {}) {
      this.type = type
      Object.assign(this, init)
    }
  }
  input = new FixtureInput()

  runInNewContext(probeSource, {
    window,
    document,
    HTMLInputElement: FixtureInput,
    InputEvent: FixtureInputEvent,
    fetch: async () => ({ status: 404 }),
    setTimeout
  })

  try {
    await window.__ATOOLS_SETTINGS_JOURNEY_CHILD__.inspect(
      'childInitial',
      1,
      probeToken,
      initialPlaceholder,
      null
    )
    assert.equal(probeReports.length, 1)
    const initial = probeReports[0].evidence
    assert.equal(initial.domMounted, true)
    assert.equal(initial.placeholderMatches, true)
    assert.equal(initial.platform, 'darwin')
    assert.equal(initial.nativeReady, true)
    assert.equal(initial.launchAtLoginAvailable, true)
    assert.equal(initial.opacityApplied, true)
    assert.equal(initial.themeApplied, true)
    assert.equal(initial.projectionFieldCount, 43)
    assert.equal(initial.readGeneralSucceeded, true)
    assert.equal(initial.secretsAbsent, true)
    assert.equal(initial.coreDenied, true)
    assert.equal(initial.coreDenialDiagnostic, coreAclError)
    assert.ok(runtimeCalls.some(({ name }) => name === 'getPlatform'))
    assert.ok(runtimeCalls.some(({ name }) => name === 'getCurrentShortcut'))
    assert.ok(runtimeCalls.some(({ name }) => name === 'getLaunchAtLogin'))
    assert.ok(runtimeCalls.some(({ name }) => name === 'dbGet'))
    assert.ok(runtimeCalls.some(({ name }) => name === 'setTheme'))
    assert.ok(runtimeCalls.some(({ name }) => name === 'setWindowOpacity'))
    assert.equal(readyCalls, 1)
    assert.equal(nativeCalls.includes('ready'), false)
    assert.ok(nativeCalls.includes('readGeneral'))

    await window.__ATOOLS_SETTINGS_JOURNEY_CHILD__.save(probeToken, 1)
    assert.equal(probeReports.length, 2)
    assert.equal(input.value, fixedPlaceholder)
    assert.equal(general.placeholder, fixedPlaceholder)
    assert.equal(probeReports[1].operation, 'childSave')
    assert.deepEqual(probeReports[1].evidence, {
      inputChanged: true,
      saveAcknowledged: true,
      projectionPersisted: true,
      projectionFieldCount: 43
    })

    forceNarrowReadMismatch = true
    coreError = { message: 'private object details must not be copied' }
    await window.__ATOOLS_SETTINGS_JOURNEY_CHILD__.inspect(
      'childReopen',
      2,
      probeToken,
      fixedPlaceholder,
      'old-settings-session'
    )
    assert.equal(probeReports.length, 3)
    assert.equal(probeReports[2].evidence.nativeReady, false)
    assert.equal(probeReports[2].evidence.readGeneralSucceeded, false)
    assert.equal(probeReports[2].evidence.projectionFieldCount, 0)
    assert.equal(probeReports[2].evidence.staleSessionRejected, true)
    assert.equal(probeReports[2].evidence.coreDenied, false)
    assert.equal(probeReports[2].evidence.coreDenialDiagnostic, '[non-string:object]')

    forceNarrowReadMismatch = false
    coreError = 'é'.repeat(2500)
    await window.__ATOOLS_SETTINGS_JOURNEY_CHILD__.inspect(
      'childReopen',
      2,
      probeToken,
      fixedPlaceholder,
      'old-settings-session'
    )
    const boundedDiagnostic = probeReports[3].evidence.coreDenialDiagnostic
    assert.equal(probeReports[3].evidence.coreDenied, false)
    assert.ok(Buffer.byteLength(boundedDiagnostic, 'utf8') <= 4096)
    assert.equal(boundedDiagnostic, 'é'.repeat(2048))

    const rejectedCoreErrors = [
      coreAclError.replace('permission: allow-is-visible', 'permission: core:window:allow-is-visible'),
      coreAclError.replace('permission: allow-is-visible', 'permission: allow-open-devtools'),
      'Command plugin:window|is_visible not found'
    ]
    for (const [index, error] of rejectedCoreErrors.entries()) {
      coreError = error
      await window.__ATOOLS_SETTINGS_JOURNEY_CHILD__.inspect(
        'childReopen',
        2,
        probeToken,
        fixedPlaceholder,
        'old-settings-session'
      )
      assert.equal(probeReports[4 + index].evidence.coreDenied, false)
    }

    const safeReports = JSON.stringify(probeReports)
    for (const secret of secretSentinels) assert.equal(safeReports.includes(secret), false)
    assert.equal(safeReports.includes(privateRawFixture), false)
    assert.equal(Object.hasOwn(initial, 'value'), false)
    assert.equal(Object.hasOwn(initial, 'raw'), false)
  } finally {
    harness.bridge.dispose()
  }
}

try {
  await testSettingsChildNativeReadinessAndSaveProbe()
  console.log('ZTools settings Native child probes passed')
} finally {
  await cleanup()
}
