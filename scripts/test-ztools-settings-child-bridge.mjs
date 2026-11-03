import assert from 'node:assert/strict'
import {
  cleanup,
  config,
  countCalls,
  createGeneral,
  createHarness,
  createReady,
  createSettingsChildBridge,
  deferred,
  expectCode
} from './ztools-settings-child-bridge-test-helpers.mjs'
import {
  testSearchAndKeyboardPreferencesKeepStrictReadonlyAndNotificationBoundaries,
  testSearchAndKeyboardPreferencesPatchAndConfirmCallbacks
} from './ztools-settings-child-bridge-preferences-tests.mjs'

async function testReadyIsSharedAndGettersUseTheOpeningSnapshot() {
  const gate = deferred()
  const harness = createHarness({ invokeOverride: ({ operation }) => {
    if (operation === 'ready') return gate.promise
    throw new Error('unexpected call')
  } })
  const enter = []
  harness.target.ztools.onPluginEnter((action) => enter.push(action))
  harness.target.utools.onPluginEnter((action) => enter.push(action))
  const first = harness.target.ztools.internal.dbGet('settings-general')
  const second = harness.target.ztools.internal.dbGet('settings-general')
  const shortcut = harness.target.ztools.internal.getCurrentShortcut()
  const launchAtLogin = harness.target.ztools.internal.getLaunchAtLogin()
  assert.equal(harness.target.ztools.isMacOS(), true)
  assert.equal(harness.target.ztools.internal.getPlatform(), 'darwin')
  await Promise.resolve()
  assert.equal(countCalls(harness.calls, 'ready'), 1)
  assert.equal(countCalls(harness.calls, 'readGeneral'), 0)
  gate.resolve(createReady())
  const [firstValue, secondValue, shortcutValue, launchValue] = await Promise.all([
    first, second, shortcut, launchAtLogin
  ])
  assert.equal(firstValue.placeholder, secondValue.placeholder)
  assert.notEqual(firstValue, secondValue)
  assert.equal(shortcutValue, 'Option+Z')
  assert.equal(launchValue, true)
  assert.deepEqual(enter, [
    { code: 'main', type: 'text', payload: '' },
    { code: 'main', type: 'text', payload: '' }
  ])
  firstValue.placeholder = 'caller mutation'
  assert.equal((await harness.target.ztools.internal.dbGet('settings-general')).placeholder,
    '搜索应用和指令 / 粘贴文件或图片')
  assert.equal(countCalls(harness.calls, 'ready'), 1)
  harness.bridge.dispose()
}

async function testReadonlyUnknownAndSecretChangesNeverReachNative() {
  const harness = createHarness()
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  await expectCode(harness.target.ztools.internal.dbGet('aiApiKey'), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')

  await harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    opacity: 0.7
  })
  assert.deepEqual(harness.calls.find((call) => call.operation === 'patchGeneral').payload.changes,
    { opacity: 0.7 })
  await expectCode(harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    aiApiKey: 'must-not-leak'
  }), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
  await expectCode(harness.target.ztools.internal.dbPut('settings-secret', { token: 'must-not-leak' }),
    'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
  await assert.rejects(harness.target.ztools.internal.setWindowMaterial('mica'),
    (error) => error?.code === 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  assert.equal(JSON.stringify(harness.calls).includes('must-not-leak'), false)
  assert.equal(JSON.stringify(harness.errors).includes('must-not-leak'), false)
  assert.ok(harness.errors.includes('此设置暂不支持修改。'))
  harness.bridge.dispose()
}

async function testEditableFieldsArePatchedAsAConfirmedDirtySubset() {
  const harness = createHarness()
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  const next = {
    ...initial,
    placeholder: 'Search projects',
    theme: 'dark',
    primaryColor: 'custom',
    customColor: '#123456',
    autoClear: 'never',
    avatar: undefined
  }
  await harness.target.ztools.internal.dbPut('settings-general', next)
  const patchCall = harness.calls.find((call) => call.operation === 'patchGeneral')
  assert.deepEqual(Object.keys(patchCall.payload.changes).sort(), [
    'autoClear', 'customColor', 'placeholder', 'primaryColor', 'theme'
  ])
  assert.equal(patchCall.payload.changes.placeholder, 'Search projects')
  assert.equal(Object.hasOwn(patchCall.payload.changes, 'avatar'), false)
  assert.deepEqual(await harness.target.ztools.internal.dbGet('settings-general'), {
    ...initial,
    placeholder: 'Search projects',
    theme: 'dark',
    primaryColor: 'custom',
    customColor: '#123456',
    autoClear: 'never'
  })
  await harness.target.ztools.internal.updatePlaceholder('Search projects')
  await harness.target.ztools.internal.updateAutoClear('never')
  await harness.target.ztools.internal.updatePrimaryColor('custom', '#123456')
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  assert.equal(countCalls(harness.calls, 'setTheme'), 0)
  harness.bridge.dispose()
}

async function testPinnedDefaultAvatarNormalizesButCustomAvatarIsPreserved() {
  const defaultAvatar = 'asset://settings/default-avatar.png'
  const legacy = createHarness({
    initial: createReady({ general: createGeneral({ avatar: defaultAvatar }) }),
    defaultAvatar
  })
  const initial = await legacy.target.ztools.internal.dbGet('settings-general')
  assert.equal(initial.avatar, null)
  await legacy.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    avatar: defaultAvatar,
    placeholder: 'legacy default avatar save'
  })
  const legacyPatch = legacy.calls.find((call) => call.operation === 'patchGeneral')
  assert.deepEqual(Object.keys(legacyPatch.payload.changes), ['placeholder'])
  assert.equal((await legacy.target.ztools.internal.dbGet('settings-general')).avatar, null)
  legacy.bridge.dispose()

  const customAvatar = 'data:image/png;base64,custom-user-avatar'
  const custom = createHarness({
    initial: createReady({ general: createGeneral({ avatar: customAvatar }) }),
    defaultAvatar
  })
  const customForm = await custom.target.ztools.internal.dbGet('settings-general')
  await custom.target.ztools.internal.dbPut('settings-general', {
    ...customForm,
    placeholder: 'keep custom avatar'
  })
  assert.equal((await custom.target.ztools.internal.dbGet('settings-general')).avatar, customAvatar)
  await expectCode(custom.target.ztools.internal.dbPut('settings-general', {
    ...customForm,
    avatar: `${defaultAvatar}?variant=2`
  }), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
  assert.equal(countCalls(custom.calls, 'patchGeneral'), 1)
  assert.deepEqual(Object.keys(custom.calls.find((call) => call.operation === 'patchGeneral').payload.changes),
    ['placeholder'])
  custom.bridge.dispose()
}

async function testGeneralProjectionAcceptsNativeRangesAndKeepsStrictBudgets() {
  const legacyGeneral = createGeneral({
    windowDefaultHeight: 2001,
    tabTargetCommand: 'x'.repeat(2049),
    superPanelBlockedApps: Array.from({ length: 129 }, (_, index) => ({ app: `blocked-${index}` })),
    customInternalApiPluginNames: Array.from({ length: 129 }, (_, index) => `plugin-${index}`)
  })
  const legacy = createHarness({ initial: createReady({ general: legacyGeneral }) })
  const accepted = await legacy.target.ztools.internal.dbGet('settings-general')
  assert.equal(accepted.windowDefaultHeight, 2001)
  assert.equal(accepted.tabTargetCommand.length, 2049)
  assert.equal(accepted.superPanelBlockedApps.length, 129)
  assert.equal(accepted.customInternalApiPluginNames.length, 129)
  legacy.bridge.dispose()

  const largeGeneral = createGeneral({
    tabTargetCommand: 'x'.repeat(40_000),
    floatingBallDoubleClickCommand: 'y'.repeat(20_000)
  })
  const large = createHarness({ initial: createReady({ general: largeGeneral }) })
  const largeForm = await large.target.ztools.internal.dbGet('settings-general')
  await large.target.ztools.internal.dbPut('settings-general', {
    ...largeForm,
    placeholder: 'large acknowledged projection'
  })
  assert.equal(countCalls(large.calls, 'patchGeneral'), 1)
  assert.equal((await large.target.ztools.internal.dbGet('settings-general')).placeholder,
    'large acknowledged projection')
  large.bridge.dispose()

  const rejectsProjection = async (general) => {
    const harness = createHarness({ initial: createReady({ general }) })
    await expectCode(harness.target.ztools.internal.dbGet('settings-general'),
      'ERR_ATOOLS_SETTINGS_PROTOCOL')
    harness.bridge.dispose()
  }
  await rejectsProjection(createGeneral({ windowDefaultHeight: 199.99 }))
  await rejectsProjection(createGeneral({ tabTargetCommand: 'x'.repeat(65_537) }))
  await rejectsProjection(createGeneral({
    tabTargetCommand: 'x'.repeat(45_000),
    floatingBallDoubleClickCommand: 'y'.repeat(40_000)
  }))
  await rejectsProjection(createGeneral({
    superPanelBlockedApps: Array.from({ length: 16_385 }, (_, index) => ({ app: `app-${index}` }))
  }))
  await rejectsProjection(createGeneral({
    customInternalApiPluginNames: Array.from({ length: 16_385 }, (_, index) => `plugin-${index}`)
  }))
}

async function testLongStoredPlaceholderSurvivesOtherWritesButCannotBeWrittenLonger() {
  const longPlaceholder = 'p'.repeat(513)
  const harness = createHarness({
    initial: createReady({ general: createGeneral({ placeholder: longPlaceholder }) })
  })
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  assert.equal(initial.placeholder, longPlaceholder)
  await harness.target.ztools.internal.dbPut('settings-general', { ...initial, theme: 'dark' })
  assert.deepEqual(Object.keys(harness.calls.find((call) => call.operation === 'patchGeneral').payload.changes),
    ['theme'])
  assert.equal((await harness.target.ztools.internal.dbGet('settings-general')).placeholder, longPlaceholder)

  await expectCode(harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'n'.repeat(513)
  }), 'ERR_ATOOLS_SETTINGS_INVALID_VALUE')
  assert.ok(harness.errors.includes('提示文字最多512字节。'))
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  harness.bridge.dispose()
}

async function testSetterCannotTreatAMissedNotificationAsSuccess() {
  const harness = createHarness({ invokeOverride: ({ operation, payload }) => {
    if (operation === 'ready') return createReady()
    if (operation === 'patchGeneral') return {
      revision: 'rev-2',
      value: { ...createGeneral(), ...payload.changes },
      notificationDelivered: false
    }
    throw new Error('unexpected call')
  } })
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  await harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'Search after notification failure'
  })
  await expectCode(harness.target.ztools.internal.updatePlaceholder('Search after notification failure'),
    'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED')
  assert.ok(harness.errors.includes('设置未获宿主确认，请重新保存。'))
  assert.equal((await harness.target.ztools.internal.dbGet('settings-general')).placeholder,
    'Search after notification failure')
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  harness.bridge.dispose()
}

async function testCasConflictKeepsBaselineAndRequiresReopen() {
  const harness = createHarness({ invokeOverride: ({ operation }) => {
    if (operation === 'ready') return createReady()
    if (operation === 'patchGeneral') {
      throw { code: 'SETTINGS_REVISION_CONFLICT', message: 'private revision data' }
    }
    throw new Error('unexpected call')
  } })
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  await assert.rejects(harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'new value'
  }), (error) => error?.code === 'SETTINGS_REVISION_CONFLICT' &&
    error.message.includes('重新打开') && !error.message.includes('private'))
  assert.equal((await harness.target.ztools.internal.dbGet('settings-general')).placeholder, initial.placeholder)
  await assert.rejects(harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'another value'
  }), (error) => error?.code === 'SETTINGS_REVISION_CONFLICT')
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  harness.bridge.dispose()
}

async function testNativeShapeAndSecretsAreRejectedBeforeCacheUpdates() {
  const invalidConfig = { ...config, sessionId: 'not-a-session' }
  assert.throws(() => createSettingsChildBridge({
    config: invalidConfig,
    invoke: async () => createReady(),
    reportError: () => {}
  }), (error) => error?.code === 'ERR_ATOOLS_SETTINGS_PROTOCOL')

  const unsafeReady = createHarness({ invokeOverride: ({ operation }) => {
    if (operation !== 'ready') throw new Error('unexpected call')
    return createReady({ overrides: {
      general: {
        revision: 'rev-1',
        value: { ...createGeneral(), aiApiKey: 'native-secret' }
      }
    } })
  } })
  await expectCode(unsafeReady.target.ztools.internal.dbGet('settings-general'),
    'ERR_ATOOLS_SETTINGS_PROTOCOL')
  assert.equal(JSON.stringify(unsafeReady.errors).includes('native-secret'), false)
  unsafeReady.bridge.dispose()

  const unsafePatch = createHarness({ invokeOverride: ({ operation, payload }) => {
    if (operation === 'ready') return createReady()
    if (operation === 'patchGeneral') return {
      revision: 'rev-2',
      value: { ...createGeneral({ placeholder: payload.changes.placeholder }), privateToken: 'native-secret' },
      notificationDelivered: true
    }
    throw new Error('unexpected call')
  } })
  const initial = await unsafePatch.target.ztools.internal.dbGet('settings-general')
  await expectCode(unsafePatch.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'must not cache unsafe reply'
  }), 'ERR_ATOOLS_SETTINGS_PROTOCOL')
  assert.equal((await unsafePatch.target.ztools.internal.dbGet('settings-general')).placeholder,
    initial.placeholder)
  assert.equal(countCalls(unsafePatch.calls, 'patchGeneral'), 1)
  assert.equal(JSON.stringify(unsafePatch.errors).includes('native-secret'), false)
  unsafePatch.bridge.dispose()
}

async function testGeneralWriteQueueIsBoundedAndSerial() {
  const firstPatch = deferred()
  const harness = createHarness({ invokeOverride: async ({ operation, payload, calls }) => {
    if (operation === 'ready') return createReady()
    if (operation === 'patchGeneral' && countCalls(calls, 'patchGeneral') === 1) return firstPatch.promise
    if (operation === 'patchGeneral') {
      return {
        revision: `rev-${countCalls(calls, 'patchGeneral') + 1}`,
        value: { ...createGeneral(), ...payload.changes },
        notificationDelivered: true
      }
    }
    throw new Error('unexpected call')
  } })
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  const writes = [harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'value-0'
  })]
  while (countCalls(harness.calls, 'patchGeneral') === 0) await Promise.resolve()
  for (let index = 1; index < 32; index += 1) {
    writes.push(harness.target.ztools.internal.dbPut('settings-general', {
      ...initial,
      placeholder: `value-${index}`
    }))
  }
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  await expectCode(harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'overflow'
  }), 'ERR_ATOOLS_SETTINGS_WRITE_QUEUE_FULL')
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  firstPatch.resolve({
    revision: 'rev-2',
    value: { ...initial, placeholder: 'value-0' },
    notificationDelivered: true
  })
  await Promise.all(writes)
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 32)
  assert.equal(countCalls(harness.calls, 'patchGeneral'), 32)
  harness.bridge.dispose()
}

async function testThemeOpacityAndAvailabilityRequireRealAcknowledgements() {
  const harness = createHarness({ initial: createReady({ runtime: {
    launchAtLogin: null,
    launchAtLoginAvailable: false,
    themeApplied: true,
    opacityApplied: true
  } }) })
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  await expectCode(harness.target.ztools.internal.getLaunchAtLogin(), 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
  assert.equal(await harness.target.ztools.internal.syncGetConfig().then((value) => value.success), false)
  await harness.target.ztools.internal.setTheme('system')
  await harness.target.ztools.internal.setTheme('dark')
  await harness.target.ztools.internal.setTheme('dark')
  await harness.target.ztools.internal.setWindowOpacity(1)
  await harness.target.ztools.internal.setWindowOpacity(0.7)
  await harness.target.ztools.internal.setWindowOpacity(0.7)
  assert.equal(countCalls(harness.calls, 'setTheme'), 1)
  assert.deepEqual(harness.calls.map(({ operation }) => operation).filter((operation) => operation === 'setWindowOpacity' || operation === 'patchGeneral'), ['patchGeneral'])
  assert.equal(countCalls(harness.calls, 'readGeneral'), 0)
  assert.equal((await harness.target.ztools.internal.dbGet('settings-general')).opacity, 0.7)
  assert.deepEqual((await harness.target.ztools.internal.dbGet('settings-general')).placeholder,
    initial.placeholder)
  assert.equal(JSON.stringify(harness.calls).includes('token'), false)
  harness.bridge.dispose()

  const failed = createHarness({ invokeOverride: ({ operation }) => {
    if (operation === 'ready') return createReady({ runtime: { themeApplied: false } })
    if (operation === 'setTheme') throw { code: 'ERR_ATOOLS_SETTINGS_UNSUPPORTED', message: 'raw' }
    throw new Error('unexpected call')
  } })
  await assert.rejects(failed.target.ztools.internal.setTheme('dark'),
    (error) => error?.code === 'ERR_ATOOLS_SETTINGS_UNSUPPORTED')
  assert.ok(failed.errors.includes('主题未确认，请重试。'))
  failed.bridge.dispose()
}

async function testOutIsDeliveredOnceBeforeCloseAndEscapeRespectsHandledEvents() {
  const harness = createHarness()
  const out = []
  harness.target.ztools.onPluginOut(() => out.push('out'))
  const handled = new Event('keydown', { cancelable: true })
  Object.defineProperties(handled, { key: { value: 'Escape' }, isComposing: { value: false } })
  handled.preventDefault()
  harness.target.dispatchEvent(handled)
  await Promise.resolve()
  assert.equal(countCalls(harness.calls, 'close'), 0)

  const composing = new Event('keydown', { cancelable: true })
  Object.defineProperties(composing, { key: { value: 'Escape' }, isComposing: { value: true } })
  harness.target.dispatchEvent(composing)
  await Promise.resolve()
  assert.equal(countCalls(harness.calls, 'close'), 0)

  await harness.target.ztools.outPlugin()
  assert.deepEqual(out, ['out'])
  assert.equal(countCalls(harness.calls, 'close'), 1)
  await harness.target.__ATOOLS_SETTINGS_DELIVER_OUT__()
  assert.deepEqual(out, ['out'])
  assert.equal(countCalls(harness.calls, 'outAcknowledged'), 1)
  harness.bridge.dispose()

  const escapeHarness = createHarness()
  const escape = new Event('keydown', { cancelable: true })
  Object.defineProperties(escape, { key: { value: 'Escape' }, isComposing: { value: false } })
  escapeHarness.target.dispatchEvent(escape)
  while (countCalls(escapeHarness.calls, 'close') === 0) await Promise.resolve()
  assert.equal(escapeHarness.calls.find((call) => call.operation === 'close').payload.reason, 'escape')
  await escapeHarness.target.__ATOOLS_SETTINGS_DELIVER_OUT__()
  assert.equal(countCalls(escapeHarness.calls, 'outAcknowledged'), 1)
  escapeHarness.bridge.dispose()
}

async function testHotkeyListenersAreLocalAndBounded() {
  const harness = createHarness()
  for (let index = 0; index < 32; index += 1) {
    harness.target.ztools.internal.onHotkeyRecorded(() => {})
  }
  assert.equal(harness.calls.length, 0)
  assert.throws(() => harness.target.ztools.internal.onHotkeyRecorded(() => {}),
    (error) => error?.code === 'ERR_ATOOLS_SETTINGS_CALLBACK_LIMIT')
  assert.equal(harness.calls.length, 0)
  harness.bridge.dispose()
}

async function testLateAcknowledgementsCannotUpdateDisposedSession() {
  const patchGate = deferred()
  const harness = createHarness({ invokeOverride: ({ operation }) => {
    if (operation === 'ready') return createReady()
    if (operation === 'patchGeneral') return patchGate.promise
    throw new Error('unexpected call')
  } })
  const initial = await harness.target.ztools.internal.dbGet('settings-general')
  const save = harness.target.ztools.internal.dbPut('settings-general', {
    ...initial,
    placeholder: 'late value'
  })
  while (countCalls(harness.calls, 'patchGeneral') === 0) await Promise.resolve()
  harness.target.dispatchEvent(new Event('pagehide'))
  await expectCode(save, 'ERR_ATOOLS_SETTINGS_BRIDGE_DISPOSED')
  patchGate.resolve({
    revision: 'rev-2',
    value: { ...initial, placeholder: 'late value' },
    notificationDelivered: true
  })
  const newSession = createHarness({ initial: createReady({
    general: createGeneral({ placeholder: 'new document' }),
    revision: 'rev-1'
  }) })
  assert.equal((await newSession.target.ztools.internal.dbGet('settings-general')).placeholder, 'new document')
  assert.equal(JSON.stringify(harness.errors).includes('late value'), false)
  assert.equal(countCalls(harness.calls, 'outAcknowledged'), 0)
  newSession.bridge.dispose()
}

const tests = [
  testReadyIsSharedAndGettersUseTheOpeningSnapshot,
  testReadonlyUnknownAndSecretChangesNeverReachNative,
  testEditableFieldsArePatchedAsAConfirmedDirtySubset,
  testSearchAndKeyboardPreferencesPatchAndConfirmCallbacks,
  testSearchAndKeyboardPreferencesKeepStrictReadonlyAndNotificationBoundaries,
  testPinnedDefaultAvatarNormalizesButCustomAvatarIsPreserved,
  testGeneralProjectionAcceptsNativeRangesAndKeepsStrictBudgets,
  testLongStoredPlaceholderSurvivesOtherWritesButCannotBeWrittenLonger,
  testSetterCannotTreatAMissedNotificationAsSuccess,
  testCasConflictKeepsBaselineAndRequiresReopen,
  testNativeShapeAndSecretsAreRejectedBeforeCacheUpdates,
  testGeneralWriteQueueIsBoundedAndSerial,
  testThemeOpacityAndAvailabilityRequireRealAcknowledgements,
  testOutIsDeliveredOnceBeforeCloseAndEscapeRespectsHandledEvents,
  testHotkeyListenersAreLocalAndBounded,
  testLateAcknowledgementsCannotUpdateDisposedSession
]

try {
  for (const test of tests) {
    await test()
    process.stdout.write(`PASS ${test.name}\n`)
  }
  process.stdout.write(`PASS ${tests.length} settings child bridge checks\n`)
} finally {
  await cleanup()
}
