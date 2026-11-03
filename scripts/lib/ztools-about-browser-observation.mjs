import assert from 'node:assert/strict'

// The original Pinia store is defineStore('window'); dismissedUpdateVersion is private.
export const MAIN_FACTS = `(() => {
  const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia;
  const store = pinia?._s?.get('window');
  const node = document.querySelector('.update-notification'); const rect = node?.getBoundingClientRect();
  const style = node && getComputedStyle(node);
  return {storeAvailable:!!store, auto:typeof store?.autoCheckUpdateEnabled === 'boolean' ? store.autoCheckUpdateEnabled : null,
    candidate:store?.availableUpdateInfo ? {hasUpdate:store.availableUpdateInfo.hasUpdate === true,version:String(store.availableUpdateInfo.version ?? '').slice(0,128)} : null,
    dismissed:{available:false,reason:'original store does not expose dismissedUpdateVersion'},
    pluginActive:store ? !!store.currentPlugin : null, shouldShow:typeof store?.shouldShowUpdateNotification === 'boolean' ? store.shouldShowUpdateNotification : null,
    noticeExists:!!node, noticeVisible:!!node && !!rect && rect.width>0 && rect.height>0 && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)!==0,
    pluginView:!!document.querySelector('.app-container__plugin')};
})()`
export const CHILD_FACTS = `(() => ({route:location.hash.slice(0,80),version:(document.querySelector('.about-version')?.textContent??'').slice(0,140),
  checkbox:document.querySelector('#auto-check-update')?.checked ?? null,
  knownToasts:['当前已是最新版本','检查更新失败','自动检查设置未确认','设置已保存'].filter(x=>document.body?.innerText.includes(x)),
  pending:window.__ATOOLS_ABOUT_CHILD__?.pendingCount?.() ?? null}))()`
export function assertMainPreference(state, { enabled, pluginActive, candidateVersion }) {
  assert.equal(state.storeAvailable, true, 'actual original window Pinia store required')
  assert.equal(state.auto, enabled, 'Main confirmed auto preference')
  assert.equal(state.pluginActive, pluginActive, 'Main current plugin state')
  assert.equal(state.candidate?.hasUpdate, true, 'Main retained update candidate')
  assert.equal(state.candidate?.version, candidateVersion, 'Main retained same candidate version')
  if (!pluginActive) { assert.equal(state.noticeExists, enabled); assert.equal(state.noticeVisible, enabled); assert.equal(state.shouldShow, enabled) }
}
export function assertSettledAuto(call, { enabled, beforeRevision, expectedStatus = 'resolved' }) {
  assert.equal(call?.operation, 'setAutoCheckUpdate'); assert.equal(call.status, expectedStatus)
  assert.equal(call.payload?.enabled, enabled); assert.equal(call.payload?.revision, beforeRevision)
  if (expectedStatus === 'resolved') {
    assert.match(call.receipt?.revision ?? '', /^[0-9a-f]{32}$/)
    assert.notEqual(call.receipt.revision, beforeRevision)
    assert.equal(call.receipt.enabled, enabled); assert.equal(call.delivery?.payload, enabled)
    assert.ok(call.delivery.count >= 1, 'General bool must reach at least one Main listener')
  }
}
export function assertAutoOutcome({ outcome, intent, confirmed, stored, checkbox }) {
  assert.ok(['committed', 'rejected', 'partial'].includes(outcome), 'known CAS outcome required')
  assert.equal(typeof intent, 'boolean'); assert.equal(typeof confirmed, 'boolean')
  const expected = outcome === 'rejected' ? confirmed : intent
  assert.equal(stored, expected, 'synthetic saved truth')
  assert.equal(checkbox, expected, 'original checkbox follows saved/confirmed truth')
}
export function compactFixture(snapshot) {
  const recent = snapshot.calls.slice(-12).map(call => ({ operation:call.operation,status:call.status,code:call.code ?? null,
    enabled:typeof call.payload?.enabled === 'boolean' ? call.payload.enabled : null,
    receipt:call.receipt ?? null,delivery:call.delivery ?? null }))
  return {count:snapshot.calls.length,counts:Object.fromEntries([...new Set(snapshot.calls.map(c=>c.operation))].map(op=>[op,snapshot.calls.filter(c=>c.operation===op).length])),
    recent, pending:snapshot.calls.filter(c=>c.status==='pending').length, held:snapshot.held,showIntents:snapshot.showIntents,storedAuto:snapshot.raw.autoCheckUpdate}
}
export async function captureFailureFacts({ runtime, mainPage, childPage, fixture, pendingNative, stage }) {
  const facts = { stage, synthetic:true, main:null, child:null, about:compactFixture(fixture.snapshot()), nativePending:pendingNative.size, errors:[] }
  for (const [label,page,expression] of [['main',mainPage,MAIN_FACTS],['child',childPage,CHILD_FACTS]]) {
    if (!page || !runtime) continue
    try { facts[label] = await runtime.evaluate(page, expression, 2000) } catch { facts.errors.push(`${label} facts unavailable`) }
  }
  return facts
}
