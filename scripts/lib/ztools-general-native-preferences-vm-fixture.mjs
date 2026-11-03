import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'

export const preferenceFields = [
  'showRecentInSearch', 'recentRows', 'pinnedRows', 'searchMode',
  'showMatchRecommendation', 'tabKeyFunction', 'tabTargetCommand', 'spaceOpenCommand'
]

const definition = {
  showRecentInSearch: ['checkbox', '搜索框显示最近使用'],
  recentRows: ['dropdown', '最近使用显示行数'],
  pinnedRows: ['dropdown', '固定栏显示行数'],
  searchMode: ['dropdown', '搜索框模式'],
  showMatchRecommendation: ['checkbox', '匹配推荐'],
  tabKeyFunction: ['dropdown', 'Tab 功能'],
  tabTargetCommand: ['text', 'Tab 键目标指令'],
  spaceOpenCommand: ['checkbox', '空格打开指令']
}

export class FixtureEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
  }
}

class FixtureControl {
  constructor(field, model) {
    this.field = field
    this.model = model
    this.isConnected = true
    this.disabled = false
    this.listeners = new Map()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event) {
    if (event.type === 'input' && definition[this.field][0] === 'text' && this.model.pendingText !== null) {
      this.model.commit(this.field, this.model.pendingText)
      this.model.pendingText = null
    }
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event)
    return true
  }

  click() {
    this.dispatchEvent(new FixtureEvent('click'))
    if (definition[this.field][0] === 'checkbox') {
      this.model.commit(this.field, !this.checked)
      this.dispatchEvent(new FixtureEvent('input'))
      this.dispatchEvent(new FixtureEvent('change'))
    } else if (definition[this.field][0] === 'dropdown') {
      this.model.openDropdown(this.field)
    }
  }

  get checked() {
    return this.model.general[this.field]
  }

  querySelector(selector) {
    if (selector === '.dropdown-value' && definition[this.field][0] === 'dropdown') {
      return { textContent: this.model.labelFor(this.field, this.model.general[this.field]) }
    }
    return null
  }

  closest(selector) {
    if (selector !== '.dropdown' || definition[this.field][0] !== 'dropdown') return null
    return {
      querySelectorAll: (query) => query === '.dropdown-menu .dropdown-item'
        ? this.model.document.dropdownItems(this.field)
        : []
    }
  }

  focus() {}

  blur() {
    this.dispatchEvent(new FixtureEvent('blur'))
  }

  get value() {
    return this.model.general[this.field]
  }

  set value(value) {
    this.model.pendingText = value
  }
}

class FixtureInput extends FixtureControl {}

Object.defineProperty(FixtureInput.prototype, 'value', {
  configurable: true,
  get() { return this.model.general[this.field] },
  set(value) { this.model.pendingText = value }
})

class SettingsDom {
  constructor(model) {
    this.model = model
    this.hiddenFields = new Set(model.options.hiddenFields)
    this.activeElement = null
    this.controls = Object.fromEntries(preferenceFields.map((field) => [
      field,
      definition[field][0] === 'text'
        ? new FixtureInput(field, model)
        : new FixtureControl(field, model)
    ]))
  }

  visible(field) {
    if (this.hiddenFields.has(field)) return false
    if (field === 'recentRows') return this.model.general.searchMode === 'aggregate' && this.model.general.showRecentInSearch
    if (field === 'pinnedRows') return this.model.general.searchMode === 'aggregate'
    if (field === 'tabTargetCommand') return this.model.general.tabKeyFunction === 'target-command'
    return true
  }

  querySelectorAll(selector) {
    if (selector === '.setting-label') {
      return preferenceFields.filter((field) => this.visible(field)).map((field) => {
        const container = {
          parentElement: null,
          querySelector: (controlSelector) => {
            const kind = definition[field][0]
            const expected = kind === 'checkbox' ? 'input[type="checkbox"]'
              : kind === 'dropdown' ? '.dropdown-trigger' : 'input[type="text"]'
            return controlSelector === expected && this.visible(field) ? this.controls[field] : null
          }
        }
        return {
          parentElement: container,
          querySelector: (nested) => nested === 'span' ? { textContent: definition[field][1] } : null,
          closest: (name) => name === '.setting-item' ? container : null
        }
      })
    }
    if (selector === '.dropdown-menu .dropdown-item') return this.dropdownItems(this.model.activeDropdown)
    return []
  }

  dropdownItems(field) {
    if (!field || this.model.activeDropdown !== field) return []
    return this.model.menuOptions(field)
      .filter((label) => !this.model.options.omittedOptionLabels.includes(label))
      .map((label) => {
        const listeners = new Set()
        return {
          querySelector: (nested) => nested === '.dropdown-item-label' ? { textContent: label } : null,
          addEventListener: (type, listener) => { if (type === 'click') listeners.add(listener) },
          removeEventListener: (type, listener) => { if (type === 'click') listeners.delete(listener) },
          click: () => {
            for (const listener of listeners) listener.call(this, new FixtureEvent('click'))
            this.model.commit(field, this.model.valueForLabel(field, label))
            this.model.activeDropdown = null
          }
        }
      })
  }
}

export class FixtureModel {
  constructor(seed, options = {}) {
    this.general = structuredClone(seed)
    this.options = {
      hiddenFields: options.hiddenFields ?? [],
      omittedOptionLabels: options.omittedOptionLabels ?? []
    }
    this.revision = 1
    this.activeDropdown = null
    this.pendingText = null
    this.document = new SettingsDom(this)
  }

  commit(field, value) {
    this.general = { ...this.general, [field]: value }
    this.revision += 1
  }

  openDropdown(field) {
    this.activeDropdown = field
  }

  labelFor(field, value) {
    if (field === 'searchMode') return value === 'aggregate' ? '聚合模式' : '列表模式'
    if (field === 'tabKeyFunction') return value === 'target-command' ? '目标指令' : '切换选中'
    if (field === 'recentRows' || field === 'pinnedRows') return `${value}行`
    return String(value)
  }

  menuOptions(field) {
    if (field === 'searchMode') return ['聚合模式', '列表模式']
    if (field === 'tabKeyFunction') return ['切换选中', '目标指令']
    return ['1行', '2行', '3行', '4行']
  }

  valueForLabel(field, label) {
    if (field === 'searchMode') return label === '聚合模式' ? 'aggregate' : 'list'
    if (field === 'tabKeyFunction') return label === '目标指令' ? 'target-command' : 'navigate'
    return Number(label.replace('行', ''))
  }
}

export function installChildProbe(source, model, { fastFailureClock = false } = {}) {
  const reports = []
  const patches = []
  const window = {
    __ATOOLS_SETTINGS_VIEW_CONFIG__: { sessionId: 'fixture-child-session' },
    __TAURI_INTERNALS__: {
      async invoke(command, args) {
        if (command === 'settings_journey_probe') {
          reports.push(structuredClone(args))
          return undefined
        }
        assertNativeCommand(command, args)
        if (args.operation === 'readGeneral') {
          return { revision: `rev-${model.revision}`, value: structuredClone(model.general) }
        }
        assert.equal(args.operation, 'patchGeneral')
        patches.push(structuredClone(args.payload.changes))
        const changes = args.payload.changes
        if (Object.hasOwn(changes, 'windowDefaultHeight') || typeof changes.recentRows === 'string') {
          throw Object.assign(new Error('fixture rejection'), { code: 'SETTINGS_INVALID_ARGUMENT' })
        }
        throw new Error('unexpected preference mutation bypassing the controls')
      }
    }
  }
  const document = model.document
  window.document = document
  let clockCalls = 0
  let clock = 0
  const timer = fastFailureClock
    ? (callback) => { queueMicrotask(callback); return 0 }
    : (callback, delay) => setTimeout(callback, delay)
  const date = fastFailureClock
    ? { now: () => { clockCalls += 1; clock += clockCalls <= 2 ? 1 : 10000; return clock } }
    : Date
  runInNewContext(source, {
    window,
    document,
    HTMLInputElement: FixtureInput,
    InputEvent: FixtureEvent,
    setTimeout: timer,
    Date: date
  })
  return { window, reports, patches }
}

function assertNativeCommand(command, args) {
  if (command !== 'call_renderer_settings') throw new Error('unexpected native command')
  assert.equal(args.sessionId, 'fixture-child-session')
}

export function frozenPiniaStore(values) {
  const state = Object.freeze(structuredClone(values))
  const store = Object.freeze({ $id: 'window', $state: state })
  const stores = new Map([['window', store]])
  return { state, store, stores, app: { config: { globalProperties: { $pinia: { _s: stores } } } } }
}

class MainSearchInput {
  constructor(model) {
    this.model = model
    this.listeners = new Map()
    this.isConnected = true
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatchEvent(event) {
    if (event.type === 'input') {
      this.model.query = this.model.value
      this.model.inputEvents += 1
      this.model.inputValues.push(this.model.value)
    }
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event)
    return true
  }

  focus() {
    this.model.document.activeElement = this
  }

  get value() { return this.model.value }

  set value(value) { this.model.value = value }
}

Object.defineProperty(MainSearchInput.prototype, 'value', {
  configurable: true,
  get() { return this.model.value },
  set(value) { this.model.value = value }
})

function visibleElement(element) {
  if (!element?.isConnected || element.getClientRects().length === 0) return false
  const bounds = element.getBoundingClientRect()
  return bounds.width > 0 && bounds.height > 0
}

export function installMainProbe(source, storeApp, { catalog = [], getAppsAvailable = true } = {}) {
  const reports = []
  const store = storeApp?.config?.globalProperties?.$pinia?._s?.get('window')
  const model = { value: '', query: '', inputEvents: 0, inputValues: [], activeElement: null, document: null }
  const document = {
    activeElement: null,
    hasFocus: () => true,
    querySelector(selector) {
      if (selector === '#app') return { __vue_app__: storeApp }
      if (selector === 'input.search-input') return input
      if (selector === '.aggregate-view' && store?.$state?.searchMode === 'aggregate') return aggregateView
      return null
    },
    querySelectorAll(selector) {
      if (selector !== '.aggregate-view .search-results .app-item' || !hasResult()) return []
      return [resultItem]
    }
  }
  model.document = document
  const input = new MainSearchInput(model)
  const hasResult = () => typeof model.query === 'string' && model.query.length > 0 &&
    catalog.some((item) => typeof item?.name === 'string' && item.name.toLocaleLowerCase() === model.query.toLocaleLowerCase())
  const resultItem = {
    isConnected: true,
    getClientRects: () => hasResult() ? [{ width: 80, height: 32 }] : [],
    getBoundingClientRect: () => hasResult() ? ({ width: 80, height: 32 }) : ({ width: 0, height: 0 })
  }
  const aggregateView = {
    isConnected: true,
    getClientRects: () => hasResult() ? [{ width: 800, height: 600 }] : [],
    getBoundingClientRect: () => hasResult() ? ({ width: 800, height: 600 }) : ({ width: 0, height: 0 })
  }
  const window = {
    __ATOOLS_SETTINGS_JOURNEY_TOKEN__: 'fixture-token',
    ztools: getAppsAvailable ? { getApps: async () => structuredClone(catalog) } : undefined,
    __TAURI__: {
      core: {
        async invoke(command, args) {
          assert.equal(command, 'settings_journey_probe')
          reports.push(structuredClone(args))
          return undefined
        }
      }
    }
  }
  let clock = 0
  runInNewContext(source, {
    window,
    document,
    TextEncoder,
    HTMLInputElement: MainSearchInput,
    InputEvent: FixtureEvent,
    setTimeout,
    clearTimeout,
    Date: { now: () => { clock += 7000; return clock } }
  })
  return { window, reports, input, document, model, visibleElement, hasResult }
}
