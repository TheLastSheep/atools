import assert from 'node:assert/strict'
import { createGeneral } from './ztools-settings-alias-browser-fixture.mjs'

const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const clone = v => structuredClone(v)
const failure = (code, message) => Object.assign(new Error(message), { code })

function installChild() {
  const original = window.__TAURI__.core.invoke
  const config = window.__ATOOLS_SETTINGS_VIEW_CONFIG__
  const pending = new Map(); let sequence = 0
  const request = (operation, payload) => new Promise((resolve, reject) => {
    const id = `about-${++sequence}`; pending.set(id, { resolve, reject })
    window.__atoolsSettingsChildRpc(JSON.stringify({ kind: 'r79-about', id, operation, payload, sessionId: config.sessionId }))
  })
  window.__ATOOLS_ABOUT_CHILD__ = {
    pendingCount: () => pending.size,
    resolve(id, envelope) {
      const item = pending.get(id); if (!item) return false
      pending.delete(id); envelope.ok ? item.resolve(envelope.value) : item.reject(Object.assign(new Error(envelope.message), { code: envelope.code }))
      return true
    },
  }
  window.__TAURI__.core.invoke = async (command, args) => {
    if (command !== 'call_renderer_settings') return original(command, args)
    if (args.operation === 'ready') { const ready = await original(command, args); ready.general = await request('readGeneral', {}); return ready }
    if (['readGeneral', 'getAppVersion', 'checkAppUpdate', 'setAutoCheckUpdate', 'patchGeneral'].includes(args.operation)) return request(args.operation, args.payload)
    return original(command, args)
  }
}

export function createAboutBrowserFixture() {
  let raw = { autoCheckUpdate: true, future: { keep: 'opaque' } }, revision = 1, nextCheck = 'none', nextAuto = 'ok'
  const calls = []; let showIntents = 0, holdOperation = null, held = null
  const read = () => ({ revision: revision.toString(16).padStart(32, "0"), value: { ...createGeneral(), autoCheckUpdate: raw.autoCheckUpdate } })
  return {
    read, snapshot: () => ({ raw: clone(raw), revision, calls: clone(calls), showIntents, held: held !== null }),
    decorateMain(source) {
      const anchor = '  Object.defineProperty(window, "__ATOOLS_ZTOOLS_RENDERER_FIXTURE__", {'
      assert.equal(source.split(anchor).length, 2)
      return source.replace(anchor, `  eventNames.add("renderer-updater-main-state");
  state.emittedEvents["renderer-updater-main-state"] = 0; state.deliveredEvents["renderer-updater-main-state"] = 0;
  fixture.emitAboutGeneral = raw => deliver("atools://renderer-general-settings", {version:1,raw});
  fixture.emitAboutUpdate = () => deliver("renderer-updater-main-state", {version:1,sequence:42,phase:"available",candidate:{candidateId:"a".repeat(32),currentVersion:"0.9.79",version:"1.0.0",date:null,body:"fixture"},checked:true,operationId:null,progress:{downloaded:0,total:null},error:null});
${anchor}`)
      + `
;(() => {
        const transport = window.__ATOOLS_ZTOOLS_RENDERER_TRANSPORT__; const invoke = transport.invoke.bind(transport);
        transport.invoke = (command, args) => {
          if (command !== "renderer_updater_main") return invoke(command, args);
          if (!args || !args.request || !["startup", "status"].includes(args.request.op) || Object.keys(args.request).length !== 1) throw new Error("Synthetic updater operation rejected");
          return Promise.resolve({version:1,sequence:1,phase:"idle",candidate:null,checked:false,operationId:null,progress:{downloaded:0,total:null},error:null});
        };
      })();`;
    },
    holdNext(operation) { assert.ok(!holdOperation && !held); holdOperation = operation },
    release() { assert.ok(held, 'no held operation'); held(); held = null },
    get isHeld() { return held !== null },
    checkMode(mode) { assert.ok(['none', 'error', 'update'].includes(mode)); nextCheck = mode },
    autoMode(mode) { assert.ok(['ok', 'conflict', 'runtime'].includes(mode)); nextAuto = mode },
    decorateChild(source) { return `${source}\n;(${installChild.toString()})();` },
    async handle(message, { sessionId, publish, isLive = () => true }) {
      const call = { operation: message.operation, payload: clone(message.payload), sessionId: message.sessionId, status: 'pending' }; calls.push(call)
      try {
        if (!sessionId || message.sessionId !== sessionId) throw failure('ERR_ATOOLS_SETTINGS_SESSION', 'Synthetic stale session')
        const { operation: op, payload: p } = message; let value
        if (holdOperation === op) { holdOperation = null; await new Promise(resolve => { held = resolve }); if (!isLive()) throw failure('ERR_ATOOLS_SETTINGS_SESSION', 'Synthetic stale session') }
        if (op === 'readGeneral' && exact(p, [])) value = read()
        else if (op === 'getAppVersion' && exact(p, [])) value = { appVersion: '0.9.79' }
        else if (op === 'checkAppUpdate' && exact(p, [])) {
          const mode = nextCheck; nextCheck = 'none'
          if (mode === 'error') throw failure('SETTINGS_UPDATER_CHECK_FAILED', 'Synthetic check failed')
          if (mode === 'update') { showIntents++; value = { success: true, hasUpdate: true, status: 'available', updateInfo: { version: '1.0.0', changelog: 'fixture' } } }
          else value = { success: true, hasUpdate: false, status: 'not-available' }
        } else if (op === 'setAutoCheckUpdate' && exact(p, ['revision', 'enabled']) && typeof p.enabled === 'boolean') {
          const mode = nextAuto; nextAuto = 'ok'
          if (mode === 'conflict' || p.revision !== read().revision) throw failure('SETTINGS_REVISION_CONFLICT', 'Synthetic conflict')
          raw = { ...raw, autoCheckUpdate: p.enabled }; revision++
          const delivered = await publish(JSON.stringify({ autoCheckUpdate: p.enabled }))
          call.delivery = { payload: p.enabled, count: delivered }
          value = { ...read(), notificationDelivered: true, runtimeApplied: mode !== 'runtime', runtimeError: mode === 'runtime' ? { code: 'SETTINGS_UPDATER_RUNTIME_UNAVAILABLE', message: 'Synthetic runtime unavailable' } : null }
          call.receipt = { revision: value.revision, enabled: value.value.autoCheckUpdate, runtimeApplied: value.runtimeApplied, notificationDelivered: value.notificationDelivered }
        } else throw failure('ERR_ATOOLS_SETTINGS_UNSUPPORTED', 'Synthetic operation outside About contract')
        call.status = 'resolved'; return { ok: true, value }
      } catch (error) { call.status = 'rejected'; call.code = error.code; return { ok: false, code: error.code || 'GENERAL_SETTINGS_PATCH_FAILED', message: error.message } }
    },
  }
}
