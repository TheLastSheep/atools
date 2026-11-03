import assert from 'node:assert/strict'
import {
  countCalls,
  createGeneral,
  createHarness,
  createReady,
  expectCode
} from './ztools-settings-child-bridge-test-helpers.mjs'

const preferences = [
  ['showRecentInSearch', 'updateShowRecentInSearch', false],
  ['recentRows', 'updateRecentRows', 3],
  ['pinnedRows', 'updatePinnedRows', 4],
  ['searchMode', 'updateSearchMode', 'list'],
  ['showMatchRecommendation', 'updateMatchRecommendation', false],
  ['tabKeyFunction', 'updateTabKeyFunction', 'target-command'],
  ['tabTargetCommand', 'updateTabTarget', 'open workspace'],
  ['spaceOpenCommand', 'updateSpaceOpenCommand', true]
]

export async function testSearchAndKeyboardPreferencesPatchAndConfirmCallbacks() {
  const harness = createHarness()
  try {
    const initial = await harness.target.ztools.internal.dbGet('settings-general')
    const next = {
      ...initial,
      placeholder: 'Search preferences',
      theme: 'dark',
      primaryColor: 'custom',
      customColor: '#123456',
      autoClear: 'never'
    }
    for (const [field, _method, value] of preferences) next[field] = value
    await harness.target.ztools.internal.dbPut('settings-general', next)
    const patch = harness.calls.find((call) => call.operation === 'patchGeneral')
    assert.deepEqual(Object.keys(patch.payload.changes), [
      'placeholder', 'autoClear', 'showRecentInSearch', 'showMatchRecommendation', 'recentRows',
      'pinnedRows', 'searchMode', 'tabKeyFunction', 'tabTargetCommand', 'spaceOpenCommand',
      'theme', 'primaryColor', 'customColor'
    ])
    for (const [field, method, value] of preferences) {
      await harness.target.ztools.internal[method](value)
      await expectCode(harness.target.ztools.internal[method](initial[field]),
        'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED')
    }
    await harness.target.ztools.internal.updatePlaceholder('Search preferences')
    await harness.target.ztools.internal.updateAutoClear('never')
    await harness.target.ztools.internal.updatePrimaryColor('custom', '#123456')
    assert.deepEqual(harness.calls.map((call) => call.operation), ['ready', 'patchGeneral'])
    assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
  } finally {
    harness.bridge.dispose()
  }
}

export async function testSearchAndKeyboardPreferencesKeepStrictReadonlyAndNotificationBoundaries() {
  const invalidChanges = [
    ['showRecentInSearch', 1],
    ['recentRows', 2.5],
    ['pinnedRows', 21],
    ['searchMode', 'recent'],
    ['showMatchRecommendation', 0],
    ['tabKeyFunction', 'execute'],
    ['tabTargetCommand', 'bad\u0000command'],
    ['spaceOpenCommand', 1]
  ]
  for (const [field, value] of invalidChanges) {
    const harness = createHarness()
    try {
      const initial = await harness.target.ztools.internal.dbGet('settings-general')
      await expectCode(harness.target.ztools.internal.dbPut('settings-general', {
        ...initial,
        [field]: value
      }), 'ERR_ATOOLS_SETTINGS_PROTOCOL')
      assert.equal(countCalls(harness.calls, 'patchGeneral'), 0)
    } finally {
      harness.bridge.dispose()
    }
  }

  const tray = createHarness()
  try {
    const initial = await tray.target.ztools.internal.dbGet('settings-general')
    await tray.target.ztools.internal.dbPut('settings-general', {
      ...initial,
      showTrayIcon: false
    })
    assert.equal(countCalls(tray.calls, 'patchGeneral'), 1)
    assert.deepEqual(tray.calls.find((call) => call.operation === 'patchGeneral').payload.changes,
      { showTrayIcon: false })
  } finally {
    tray.bridge.dispose()
  }

  for (const [field, method, value] of preferences) {
    const harness = createHarness({ invokeOverride: ({ operation, payload }) => {
      if (operation === 'ready') return createReady()
      if (operation === 'patchGeneral') return {
        revision: 'rev-2',
        value: { ...createGeneral(), ...payload.changes },
        notificationDelivered: false
      }
      throw new Error('unexpected call')
    } })
    try {
      const initial = await harness.target.ztools.internal.dbGet('settings-general')
      await harness.target.ztools.internal.dbPut('settings-general', { ...initial, [field]: value })
      await expectCode(harness.target.ztools.internal[method](value),
        'ERR_ATOOLS_SETTINGS_WRITE_NOT_CONFIRMED')
      assert.deepEqual(harness.calls.map((call) => call.operation), ['ready', 'patchGeneral'])
      assert.equal(countCalls(harness.calls, 'patchGeneral'), 1)
    } finally {
      harness.bridge.dispose()
    }
  }
}
