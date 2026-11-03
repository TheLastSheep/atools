import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  FixtureModel,
  frozenPiniaStore,
  installChildProbe,
  installMainProbe,
  preferenceFields
} from './lib/ztools-general-native-preferences-vm-fixture.mjs'

const journeyRoot = new URL('../src-tauri/src/renderer_desktop_smoke/settings_journey/', import.meta.url)
const preferencesSource = await readFile(new URL('preferences-probe.js', journeyRoot), 'utf8')
const mainSource = await readFile(new URL('main-probe.js', journeyRoot), 'utf8')
const edits = [
  ['searchMode', 'aggregate'], ['showRecentInSearch', true],
  ['pinnedRows', 3], ['recentRows', 3],
  ['showMatchRecommendation', false], ['tabKeyFunction', 'target-command'],
  ['tabTargetCommand', 'ATools-native-target'], ['spaceOpenCommand', true]
]
const initial = {
  showRecentInSearch: false, recentRows: 2, pinnedRows: 2,
  searchMode: 'list', showMatchRecommendation: true,
  tabKeyFunction: 'navigate', tabTargetCommand: 'x'.repeat(2049),
  spaceOpenCommand: false, windowDefaultHeight: 2001,
  aiApiKey: 'private-fixture-secret'
}

async function testChildControlEditsRejectionsAndReopen() {
  const model = new FixtureModel(initial)
  const { window, reports, patches } = installChildProbe(preferencesSource, model)
  const probe = window.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__
  assert.ok(probe)

  for (const [field, target] of edits) await probe.edit('fixture-token', 1, field, target)
  const editReports = reports.filter(({ operation }) => operation === 'childPreferenceEdit')
  assert.equal(editReports.length, preferenceFields.length)
  assert.deepEqual(editReports.map(({ evidence }) => evidence.field).sort(), [...preferenceFields].sort())
  for (const { evidence } of editReports) {
    const target = edits.find(([field]) => field === evidence.field)[1]
    assert.equal(evidence.controlFound, true, evidence.field)
    assert.equal(evidence.actionObserved, true, evidence.field)
    assert.equal(evidence.valueChanged, true, evidence.field)
    assert.equal(evidence.matchesTarget, true, evidence.field)
    assert.equal(evidence.nativeReadbackMatches, true, evidence.field)
    assert.equal(evidence.revisionAdvanced, true, evidence.field)
    assert.equal(evidence.uiValue, target, evidence.field)
    assert.equal(evidence.stage, 'complete', evidence.field)
  }
  assert.deepEqual(
    Object.fromEntries(preferenceFields.map((field) => [field, model.general[field]])),
    Object.fromEntries(edits)
  )

  const beforeReject = structuredClone(model.general)
  const beforeRevision = model.revision
  await probe.rejectReadonly('fixture-token', 1)
  assert.deepEqual(model.general, beforeReject)
  assert.equal(model.revision, beforeRevision)
  await probe.rejectInvalid('fixture-token', 1)
  assert.deepEqual(model.general, beforeReject)
  assert.equal(model.revision, beforeRevision)
  assert.deepEqual(patches, [
    { windowDefaultHeight: 2002 },
    { recentRows: '3' }
  ])
  const rejections = reports.filter(({ operation }) => operation.startsWith('childPreferenceReject'))
  assert.equal(rejections.length, 2)
  for (const { evidence } of rejections) {
    assert.equal(evidence.errorCode, 'SETTINGS_INVALID_ARGUMENT')
    assert.equal(evidence.revisionBefore, `rev-${beforeRevision}`)
    assert.equal(evidence.revisionAfter, `rev-${beforeRevision}`)
    assert.equal(evidence.projectionUnchanged, true)
    assert.equal(evidence.readSucceeded, true)
  }

  await probe.inspectReopened('fixture-token', 2)
  const reopened = reports.find(({ operation }) => operation === 'childPreferencesReopen')?.evidence
  assert.ok(reopened)
  assert.equal(reopened.nativeReadSucceeded, true)
  for (const field of preferenceFields) {
    assert.equal(reopened.controlFound[field], true, field)
    assert.equal(reopened.controlValues[field], model.general[field], field)
    assert.equal(reopened.nativeValues[field], model.general[field], field)
  }
  const serialized = JSON.stringify(reports)
  assert.equal(serialized.includes('private-fixture-secret'), false)
  assert.equal(serialized.includes('windowDefaultHeight'), false)
}

async function testMissingControlAndDropdownOptionAreHonestFailures() {
  const conditionalSeed = { ...initial, searchMode: 'aggregate', showRecentInSearch: true }
  const missingControlModel = new FixtureModel(conditionalSeed, { hiddenFields: ['pinnedRows'] })
  const missingControl = installChildProbe(preferencesSource, missingControlModel, { fastFailureClock: true })
  await missingControl.window.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__.edit(
    'fixture-token', 1, 'pinnedRows', 3
  )
  const controlEvidence = missingControl.reports[0].evidence
  assert.equal(controlEvidence.field, 'pinnedRows')
  assert.equal(controlEvidence.controlFound, false)
  assert.equal(controlEvidence.actionObserved, false)
  assert.equal(controlEvidence.uiValue, null)
  assert.equal(controlEvidence.stage, 'control-missing')
  assert.equal(controlEvidence.matchesTarget, false)
  assert.equal(missingControlModel.general.pinnedRows, 2)

  const missingOptionModel = new FixtureModel(conditionalSeed, { omittedOptionLabels: ['3行'] })
  const missingOption = installChildProbe(preferencesSource, missingOptionModel, { fastFailureClock: true })
  await missingOption.window.__ATOOLS_SETTINGS_JOURNEY_PREFERENCES__.edit(
    'fixture-token', 1, 'pinnedRows', 3
  )
  const optionEvidence = missingOption.reports[0].evidence
  assert.equal(optionEvidence.field, 'pinnedRows')
  assert.equal(optionEvidence.controlFound, true)
  assert.equal(optionEvidence.actionObserved, false)
  assert.equal(optionEvidence.uiValue, 2)
  assert.equal(optionEvidence.stage, 'dropdown-option-missing')
  assert.equal(optionEvidence.matchesTarget, false)
  assert.equal(missingOptionModel.general.pinnedRows, 2)
}

function coldSeed() {
  return {
    placeholder: 'atools-native-settings-initial',
    theme: 'dark', primaryColor: 'blue', customColor: '#db2777',
    autoClear: 'fixture-auto-clear', showRecentInSearch: false,
    recentRows: 2, pinnedRows: 2, searchMode: 'list',
    showMatchRecommendation: true, tabKeyFunction: 'navigate',
    tabTargetCommand: 'x'.repeat(2049), spaceOpenCommand: false
  }
}

async function testMainColdAndResultDrivenSearchModeObservation() {
  const seed = coldSeed()
  const seedPinia = frozenPiniaStore(seed)
  const cold = installMainProbe(mainSource, seedPinia.app)
  await cold.window.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observeColdStartup(1, seed)
  const coldEvidence = cold.reports[0].evidence
  assert.equal(coldEvidence.piniaAppFound, true)
  assert.equal(coldEvidence.windowStoreFound, true)
  assert.equal(coldEvidence.fieldCount, 13)
  assert.equal(coldEvidence.tabTargetCommandBytes, 2049)
  assert.equal(Object.keys(coldEvidence.fieldMatches).length, 13)
  assert.ok(Object.values(coldEvidence.fieldMatches).every(Boolean))
  assert.deepEqual(seedPinia.state, seed)
  assert.equal(Object.isFrozen(seedPinia.state), true)

  const committed = {
    ...seed, showRecentInSearch: true, recentRows: 3, pinnedRows: 3,
    searchMode: 'aggregate', showMatchRecommendation: false,
    tabKeyFunction: 'target-command', tabTargetCommand: 'ATools-native-target',
    spaceOpenCommand: true
  }
  const sentinelName = 'AToolsNativeResultSentinel'
  const sentinelPath = '/fixture/catalog/native-result-never-launched.app'
  const committedPinia = frozenPiniaStore(committed)
  const main = installMainProbe(mainSource, committedPinia.app, {
    catalog: [{ name: sentinelName, path: sentinelPath }]
  })
  const expected = Object.fromEntries(preferenceFields.map((field) => [field, committed[field]]))
  assert.equal(main.hasResult(), false)
  assert.equal(main.visibleElement(main.document.querySelector('.aggregate-view')), false)
  await main.window.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observePreferences(1, expected)
  const evidence = main.reports[0].evidence
  assert.equal(main.reports[0].operation, 'observePreferences')
  assert.deepEqual(evidence.values, expected)
  assert.deepEqual(evidence.searchModeStructure, {
    mode: 'aggregate', selector: '.aggregate-view', visible: true,
    rowCountClaimed: false, queryInjected: true, queryRestored: true,
    resultCount: 1, unavailableReason: 'none'
  })
  assert.deepEqual(main.model.inputEvents, 2)
  assert.deepEqual(main.model.inputValues, [sentinelName, ''])
  assert.equal(main.model.query, '')
  assert.equal(main.input.value, '')
  assert.equal(main.document.activeElement, main.input)
  assert.equal(main.hasResult(), false)
  assert.deepEqual(committedPinia.state, committed)
  assert.equal(Object.isFrozen(committedPinia.state), true)
  const serialized = JSON.stringify(main.reports)
  assert.equal(serialized.includes(sentinelName), false)
  assert.equal(serialized.includes(sentinelPath), false)

  const noCatalog = installMainProbe(mainSource, committedPinia.app, { catalog: [] })
  await noCatalog.window.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observePreferences(1, expected)
  assert.deepEqual(noCatalog.reports[0].evidence.searchModeStructure, {
    mode: 'aggregate', selector: '.aggregate-view', visible: false,
    rowCountClaimed: false, queryInjected: false, queryRestored: true,
    resultCount: 0, unavailableReason: 'catalog-empty'
  })

  const unavailableApi = installMainProbe(mainSource, committedPinia.app, {
    catalog: [{ name: sentinelName }], getAppsAvailable: false
  })
  await unavailableApi.window.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observePreferences(1, expected)
  assert.equal(
    unavailableApi.reports[0].evidence.searchModeStructure.unavailableReason,
    'api-unavailable'
  )
  assert.equal(unavailableApi.reports[0].evidence.searchModeStructure.visible, false)
  assert.equal(unavailableApi.reports[0].evidence.searchModeStructure.queryRestored, true)

  const malformedApi = installMainProbe(mainSource, committedPinia.app, {
    catalog: { name: sentinelName }
  })
  await malformedApi.window.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observePreferences(1, expected)
  assert.equal(
    malformedApi.reports[0].evidence.searchModeStructure.unavailableReason,
    'api-unavailable'
  )
  assert.equal(malformedApi.reports[0].evidence.searchModeStructure.queryInjected, false)

  const missingPinia = installMainProbe(mainSource, {}, { catalog: [] })
  await missingPinia.window.__ATOOLS_SETTINGS_JOURNEY_MAIN__.observePreferences(1, expected)
  assert.equal(missingPinia.reports[0].evidence.piniaAppFound, false)
  assert.equal(missingPinia.reports[0].evidence.windowStoreFound, false)
  assert.equal(missingPinia.reports[0].evidence.presentFields.length, 0)
  assert.equal(missingPinia.reports[0].evidence.searchModeStructure.verified, undefined)
}

await testChildControlEditsRejectionsAndReopen()
await testMissingControlAndDropdownOptionAreHonestFailures()
await testMainColdAndResultDrivenSearchModeObservation()
console.log('ZTools General Native preference probes passed')
