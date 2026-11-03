import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import ts from '../packages/ztools-settings/node_modules/typescript/lib/typescript.js'

const root = new URL('../packages/ztools-settings/src/', import.meta.url)
const coreGeneralSource = await readFile(new URL('../crates/atools-core/src/db/renderer_general_settings.rs', import.meta.url), 'utf8')
const coreFields = coreGeneralSource.match(
  /pub const RENDERER_GENERAL_SETTINGS_FIELDS:\s*\[&str;\s*(\d+)\]\s*=\s*\[([\s\S]*?)\];/
)
if (!coreFields) throw new Error('Core renderer General capability declaration was not found')
const editableGeneralFields = Array.from(coreFields[2].matchAll(/"([^"\\]+)"/g), (match) => match[1])
const frozenGeneralFields = [
  'placeholder', 'theme', 'primaryColor', 'customColor', 'autoClear', 'showRecentInSearch',
  'recentRows', 'pinnedRows', 'searchMode', 'showMatchRecommendation', 'tabKeyFunction',
  'tabTargetCommand', 'spaceOpenCommand', 'localAppSearch', 'opacity', 'showTrayIcon', 'hotkey',
  'windowPositionStrategy', 'clipboardRetentionDays', 'autoBackToSearch',
  'autoPaste', 'builtinAppShortcutsEnabled', 'windowDefaultHeight', 'autoCheckUpdate'
]
if (Number(coreFields[1]) !== frozenGeneralFields.length || editableGeneralFields.length !== frozenGeneralFields.length ||
    editableGeneralFields.some((field, index) => field !== frozenGeneralFields[index])) {
  throw new Error('Core renderer General capability declaration has an invalid fixed append')
}
export const config = {
  version: 1,
  sessionId: '11111111111111111111111111111111',
  bundleRevision: 'a'.repeat(64),
  platform: 'darwin'
}

function compileTs(source, importRewrites = []) {
  let output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      verbatimModuleSyntax: true
    }
  }).outputText
  for (const [before, after] of importRewrites) output = output.replaceAll(before, after)
  return output
}

const tempModules = await mkdtemp(join(tmpdir(), 'atools-settings-child-bridge-'))
const jsonBudgetSource = await readFile(new URL('childBridgeJsonBudget.ts', root), 'utf8')
const protocolSource = await readFile(new URL('childBridgeProtocol.ts', root), 'utf8')
const nativeErrorsSource = await readFile(new URL('childBridgeNativeErrors.ts', root), 'utf8')
const generalSource = await readFile(new URL('childBridgeGeneral.ts', root), 'utf8')
const serialQueueSource = await readFile(new URL('childBridgeSerialQueue.ts', root), 'utf8')
const apiSource = await readFile(new URL('childBridgeApi.ts', root), 'utf8')
const commandDataSource = await readFile(new URL('childBridgeCommandData.ts', root), 'utf8')
const commandSettingsSource = await readFile(new URL('childBridgeCommandSettings.ts', root), 'utf8')
const searchPinsSource = await readFile(new URL('childBridgeSearchPins.ts', root), 'utf8')
const aliasesSource = await readFile(new URL('childBridgeAliases.ts', root), 'utf8')
const inputSource = await readFile(new URL('childBridgeInput.ts', root), 'utf8')
const internalFacadeSource = await readFile(new URL('childBridgeInternalFacade.ts', root), 'utf8')
const bridgeSource = await readFile(new URL('childBridge.ts', root), 'utf8')
await writeFile(join(tempModules, 'childBridgeJsonBudget.mjs'), compileTs(jsonBudgetSource))
await writeFile(join(tempModules, 'childBridgeProtocol.mjs'), compileTs(protocolSource, [
  ["'./childBridgeJsonBudget'", "'./childBridgeJsonBudget.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeNativeErrors.mjs'), compileTs(nativeErrorsSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeGeneral.mjs'), compileTs(generalSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"],
  ["'./childBridgeSerialQueue'", "'./childBridgeSerialQueue.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeSerialQueue.mjs'), compileTs(serialQueueSource))
await writeFile(join(tempModules, 'childBridgeApi.mjs'), compileTs(apiSource))
await writeFile(join(tempModules, 'childBridgeCommandData.mjs'), compileTs(commandDataSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeCommandSettings.mjs'), compileTs(commandSettingsSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"],
  ["'./childBridgeCommandData'", "'./childBridgeCommandData.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeSearchPins.mjs'), compileTs(searchPinsSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeAliases.mjs'), compileTs(aliasesSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"],
  ["'./childBridgeCommandData'", "'./childBridgeCommandData.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeInput.mjs'), compileTs(inputSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"],
  ["'./childBridgeSerialQueue'", "'./childBridgeSerialQueue.mjs'"]
]))
await writeFile(join(tempModules, 'childBridgeInternalFacade.mjs'), compileTs(internalFacadeSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"]
]))
await writeFile(join(tempModules, 'childBridge.mjs'), compileTs(bridgeSource, [
  ["'./childBridgeProtocol'", "'./childBridgeProtocol.mjs'"],
  ["'./childBridgeNativeErrors'", "'./childBridgeNativeErrors.mjs'"],
  ["'./childBridgeGeneral'", "'./childBridgeGeneral.mjs'"],
  ["'./childBridgeCommandData'", "'./childBridgeCommandData.mjs'"],
  ["'./childBridgeCommandSettings'", "'./childBridgeCommandSettings.mjs'"],
  ["'./childBridgeSearchPins'", "'./childBridgeSearchPins.mjs'"],
  ["'./childBridgeAliases'", "'./childBridgeAliases.mjs'"],
  ["'./childBridgeInput'", "'./childBridgeInput.mjs'"],
  ["'./childBridgeInternalFacade'", "'./childBridgeInternalFacade.mjs'"],
  ["'./childBridgeApi'", "'./childBridgeApi.mjs'"]
]))
export const { createSettingsChildBridge } = await import(pathToFileURL(join(tempModules, 'childBridge.mjs')).href)

export function createGeneral(overrides = {}) {
  return {
    opacity: 1,
    windowDefaultHeight: 541,
    hotkey: 'Option+Z',
    placeholder: '搜索应用和指令 / 粘贴文件或图片',
    avatar: null,
    autoPaste: '3s',
    autoClear: 'immediately',
    autoBackToSearch: 'never',
    windowPositionStrategy: 'remember',
    showRecentInSearch: true,
    showMatchRecommendation: true,
    localAppSearch: true,
    recentRows: 2,
    pinnedRows: 2,
    searchMode: 'aggregate',
    tabKeyFunction: 'navigate',
    tabTargetCommand: '',
    spaceOpenCommand: false,
    floatingBallDoubleClickCommand: '',
    floatingBallEnabled: false,
    floatingBallLetter: 'Z',
    superPanelEnabled: false,
    superPanelMouseButton: 'middle',
    superPanelLongPressMs: 500,
    superPanelBlockedApps: [],
    wakeupBlacklist: [],
    superPanelTranslateEnabled: false,
    theme: 'system',
    primaryColor: 'green',
    customColor: '#db2777',
    showTrayIcon: true,
    windowMaterial: 'none',
    acrylicLightOpacity: 78,
    acrylicDarkOpacity: 50,
    devToolsMode: 'detach',
    disableGpuAcceleration: false,
    customInternalApiPluginNames: [],
    proxyEnabled: false,
    proxyUrl: '',
    autoCheckUpdate: true,
    clipboardRetentionDays: 180,
    terminal: 'default',
    terminalCustomCommand: '',
    ...overrides
  }
}

export function createReady({ general = createGeneral(), runtime = {}, revision = 'rev-1', overrides = {} } = {}) {
  return {
    version: 1,
    sessionId: config.sessionId,
    bundleRevision: config.bundleRevision,
    platform: config.platform,
    general: { revision, value: general },
    runtime: {
      currentShortcut: general.hotkey,
      launchAtLogin: true,
      launchAtLoginAvailable: true,
      opacity: general.opacity,
      theme: general.theme,
      themeApplied: true,
      opacityApplied: true,
      ...runtime
    },
    capabilities: {
      editableGeneralFields: [...editableGeneralFields]
    },
    action: { code: 'main', type: 'text', payload: '' },
    ...overrides
  }
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export function createHarness({
  initial,
  invokeOverride,
  reportError = () => {},
  defaultAvatar = 'asset://settings/default-avatar.png'
} = {}) {
  let ready = initial ?? createReady()
  let currentRevision = ready.general.revision
  let currentGeneral = structuredClone(ready.general.value)
  const calls = []
  const errors = []
  const nativeInvoke = async (operation, payload, sessionId) => {
    calls.push({ operation, payload: structuredClone(payload), sessionId })
    if (invokeOverride) return invokeOverride({ operation, payload, sessionId, calls })
    if (operation === 'ready') return structuredClone(ready)
    if (operation === 'patchGeneral') {
      if (payload.revision !== currentRevision) {
        throw { code: 'SETTINGS_REVISION_CONFLICT', message: 'private native detail' }
      }
      currentGeneral = { ...currentGeneral, ...structuredClone(payload.changes) }
      currentRevision = `rev-${Number(currentRevision.split('-')[1] ?? '1') + 1}`
      return {
        revision: currentRevision,
        value: structuredClone(currentGeneral),
        notificationDelivered: true
      }
    }
    if (operation === 'setTheme') return { theme: payload.theme, themeApplied: true }
    if (operation === 'setWindowOpacity') return { opacity: payload.opacity, opacityApplied: true }
    if (operation === 'close') return { version: 1, sessionId, closed: true }
    if (operation === 'outAcknowledged') return { acknowledged: true }
    throw new Error(`unexpected test operation: ${operation}`)
  }
  const bridge = createSettingsChildBridge({
    config,
    defaultAvatar,
    invoke: nativeInvoke,
    reportError: (message) => {
      errors.push(message)
      reportError(message)
    }
  })
  const target = new EventTarget()
  target.__ATOOLS_SETTINGS_VIEW_CONFIG__ = config
  bridge.attach(target)
  return { bridge, target, calls, errors }
}

export function countCalls(calls, operation) {
  return calls.filter((call) => call.operation === operation).length
}

export async function expectCode(promise, code) {
  await assert.rejects(promise, (error) => error?.code === code)
}

export async function cleanup() {
  await rm(tempModules, { recursive: true, force: true })
}
