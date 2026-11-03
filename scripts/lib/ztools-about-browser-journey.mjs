import assert from 'node:assert/strict'
import { MAIN_FACTS, CHILD_FACTS, assertMainPreference, assertSettledAuto, assertAutoOutcome } from './ztools-about-browser-observation.mjs'

export function createAboutBrowserJourney(context, runtime, fixture) {
  const { report, mainPage, childPage, childDriver, currentDocument, server, setStage, timeline } = context
  const { evaluate, waitFor } = runtime
  const info = report.builtinShortcuts
  const checkbox = `document.querySelector('#auto-check-update')`
  const button = `document.querySelector('.check-update-btn')`
  const toggle = `document.querySelector('label.toggle')`
  const calls = op => fixture.snapshot().calls.filter(c => c.operation === op)
  async function key(key, code, modifiers = 0) {
    await mainPage.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers })
    await mainPage.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers })
  }
  async function open() {
    await mainPage.send('Page.bringToFront'); await evaluate(mainPage, "document.querySelector('.search-input').focus()")
    runtime.setOpenedBy('R79-original-Main-CmdComma'); await key(',', 'Comma', 4)
    await waitFor(childPage, "window.__ATOOLS_ABOUT_CHILD__ && document.querySelector('.menu-item')", 'Settings Child ready')
    await childPage.send('Page.bringToFront'); await childDriver.clickText('关于', '.menu-item', 'original About sidebar')
    await waitFor(childPage, `${checkbox} && ${button} && document.querySelector('.about-version')?.textContent === 'v0.9.79'`, 'original About version')
    const count = calls('getAppVersion').length
    assert.equal(count, info.sessions.length + 1, 'one successful version request per session')
    assert.equal(calls('getAppVersion').at(-1)?.status, 'resolved')
    assert.equal(await evaluate(childPage, 'window.ztools.internal.getAppVersion()'), '0.9.79')
    assert.equal(calls('getAppVersion').length, count, 'successful version cached within session')
    info.sessions.push(runtime.activeSession.sessionId); timeline.opened()
  }
  async function close({ pending = false } = {}) {
    if (!pending) await waitFor(childPage, 'window.__ATOOLS_ABOUT_CHILD__.pendingCount() === 0', 'About requests settled')
    const sessionId = runtime.activeSession.sessionId
    timeline.closing(); await evaluate(childPage, 'window.ztools.outPlugin()')
    await waitFor(mainPage, "!document.querySelector('.app-container__plugin')", 'Main returns to search')
    assert.equal(runtime.activeSession, null)
    await childPage.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: runtime.childInjectionId }); runtime.clearChildInjection()
    const loaded = childPage.waitForEvent('Page.loadEventFired', 10000)
    await childPage.send('Page.navigate', { url: server.retiredUrl }); await loaded
    await waitFor(childPage, "document.querySelector('main[data-atools-retired-target]') && !window.ztools", 'retired document')
    timeline.closed(); info.closed.push({ sessionId, pending })
  }
  async function flip(enabled, mode = 'resolved') {
    const beforeRevision = fixture.read().revision, beforeCount = calls('setAutoCheckUpdate').length
    const confirmed = fixture.snapshot().raw.autoCheckUpdate
    assert.equal(await evaluate(childPage, `${checkbox}.checked`), confirmed); assert.notEqual(enabled, confirmed)
    await evaluate(childPage, `${toggle}.scrollIntoView({block:'center'})`)
    await childDriver.clickElement(toggle, 'original auto update toggle')
    for (let i=0; i<250 && (calls('setAutoCheckUpdate').length === beforeCount || calls('setAutoCheckUpdate').at(-1)?.status === 'pending'); i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls('setAutoCheckUpdate').length, beforeCount + 1)
    const call = calls('setAutoCheckUpdate').at(-1)
    const expected = mode === 'rejected' ? confirmed : enabled
    if (mode === 'rejected') await toast('自动检查设置未确认')
    await waitFor(childPage, `${checkbox}.checked === ${expected}`, 'confirmed auto outcome')
    report.aboutOutcomeFacts ??= []; report.aboutOutcomeFacts.push({ stage:mode === 'rejected' ? 'conflict-settled' : 'saved-settled', child:await evaluate(childPage, CHILD_FACTS), storedAuto:fixture.snapshot().raw.autoCheckUpdate })
    assertSettledAuto(call, { enabled, beforeRevision, expectedStatus: mode })
    assertAutoOutcome({outcome:mode === 'rejected' ? 'rejected' : call.receipt.runtimeApplied ? 'committed' : 'partial', intent:enabled, confirmed, stored:fixture.snapshot().raw.autoCheckUpdate, checkbox:await evaluate(childPage, `${checkbox}.checked`)})
    return call
  }
  async function toast(text) { await waitFor(childPage, `document.body.innerText.includes(${JSON.stringify(text)})`, `toast ${text}`) }
  return { async run() {
    setStage('r79-main-original-notice')
    await waitFor(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().activeListenersByEvent['renderer-updater-main-state'] === 1", 'updater event subscription')
    await evaluate(mainPage, 'window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.emitAboutUpdate()')
    await waitFor(mainPage, "!!document.querySelector('.update-notification')", 'original automatic notice')
    await runtime.captureScreenshot(mainPage, 'r79-main-notice', currentDocument.main)
    await open(); await runtime.captureScreenshot(childPage, 'r79-about-version', currentDocument.child)
    await evaluate(childPage, `${button}.scrollIntoView({block:'center'})`)
    fixture.holdNext('checkAppUpdate'); await childDriver.clickElement(button, 'manual check')
    await waitFor(childPage, `${button}.disabled`, 'manual check disabled')
    const point = await evaluate(childPage, `(() => { const r=${button}.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2} })()`)
    await childPage.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 })
    await childPage.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 })
    for (let i=0; i<200 && !fixture.isHeld; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(fixture.isHeld, true); assert.equal(calls('checkAppUpdate').length, 1)
    fixture.release(); await toast('当前已是最新版本')
    fixture.checkMode('error'); await childDriver.clickElement(button, 'manual error')
    await toast('检查更新失败'); await waitFor(childPage, `!${button}.disabled`, 'manual error recovery')
    fixture.checkMode('update'); await childDriver.clickElement(button, 'manual update')
    await waitFor(childPage, `!${button}.disabled`, 'manual update done'); assert.equal(fixture.snapshot().showIntents, 1)
    setStage('r79-auto-false-plugin'); await flip(false)
    await waitFor(mainPage, `(${MAIN_FACTS}).auto === false`, 'Main false General event')
    assertMainPreference(await evaluate(mainPage, MAIN_FACTS), {enabled:false,pluginActive:true,candidateVersion:'1.0.0'})
    await close(); setStage('r79-auto-false-search')
    await waitFor(mainPage, `(${MAIN_FACTS}).pluginActive === false`, 'Main plugin closed')
    assertMainPreference(await evaluate(mainPage, MAIN_FACTS), {enabled:false,pluginActive:false,candidateVersion:'1.0.0'})
    await open(); assert.equal(await evaluate(childPage, `${checkbox}.checked`), false)
    setStage('r79-auto-true-plugin'); await flip(true)
    await waitFor(mainPage, `(${MAIN_FACTS}).auto === true`, 'Main true General event')
    assertMainPreference(await evaluate(mainPage, MAIN_FACTS), {enabled:true,pluginActive:true,candidateVersion:'1.0.0'})
    await close(); setStage('r79-auto-true-search')
    await waitFor(mainPage, `(${MAIN_FACTS}).pluginActive === false && (${MAIN_FACTS}).noticeVisible`, 'restored notice with no plugin')
    assertMainPreference(await evaluate(mainPage, MAIN_FACTS), {enabled:true,pluginActive:false,candidateVersion:'1.0.0'})
    assert.equal(calls('setAutoCheckUpdate').length, 2); assert.equal(calls('patchGeneral').length, 0)
    assert.deepEqual(fixture.snapshot().raw.future, { keep: 'opaque' })
    await open(); assert.equal(await evaluate(childPage, `${checkbox}.checked`), true)
    setStage('r79-auto-conflict'); const eventCount = await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().deliveredEvents['atools://renderer-general-settings']")
    fixture.autoMode('conflict'); const conflict = await flip(false, 'rejected'); assert.equal(conflict.code, 'SETTINGS_REVISION_CONFLICT')
    assert.equal(fixture.snapshot().raw.autoCheckUpdate, true)
    assert.equal(await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().deliveredEvents['atools://renderer-general-settings']"), eventCount)
    assertMainPreference(await evaluate(mainPage, MAIN_FACTS), {enabled:true,pluginActive:true,candidateVersion:'1.0.0'})
    const afterConflict = calls('setAutoCheckUpdate').length
    await evaluate(childPage, `${toggle}.scrollIntoView({block:'center'})`); await childDriver.clickElement(toggle, 'blocked old conflict intent')
    await waitFor(childPage, `${checkbox}.checked === true`, 'blocked intent restores confirmed truth')
    assert.equal(calls('setAutoCheckUpdate').length, afterConflict, 'no stale CAS after conflict')
    assert.equal(await evaluate(mainPage, "window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().deliveredEvents['atools://renderer-general-settings']"), eventCount)
    assert.equal(fixture.snapshot().raw.autoCheckUpdate, true)
    await runtime.captureScreenshot(childPage, 'r79-about-conflict', currentDocument.child)
    await close(); await open(); setStage('r79-auto-saved-runtime-failure'); fixture.autoMode('runtime'); const partial = await flip(false); await toast('设置已保存')
    report.aboutOutcomeFacts.push({ stage:'partial-warning', child:await evaluate(childPage, CHILD_FACTS), storedAuto:fixture.snapshot().raw.autoCheckUpdate })
    assert.equal(partial.receipt.runtimeApplied, false); assert.equal(partial.receipt.notificationDelivered, true)
    await waitFor(mainPage, `(${MAIN_FACTS}).auto === false`, 'Main partial General event')
    assertMainPreference(await evaluate(mainPage, MAIN_FACTS), {enabled:false,pluginActive:true,candidateVersion:'1.0.0'})
    assert.equal(fixture.snapshot().raw.autoCheckUpdate, false); assert.equal(await evaluate(childPage, `${checkbox}.checked`), false)
    await runtime.captureScreenshot(childPage, 'r79-about-saved-warning', currentDocument.child)
    await close(); await open(); assert.equal(await evaluate(childPage, `${checkbox}.checked`), false)
    setStage('r79-old-session-late-check')
    await evaluate(childPage, `${button}.scrollIntoView({block:'center'})`)
    fixture.holdNext('checkAppUpdate'); await childDriver.clickElement(button, 'held old check')
    await waitFor(childPage, `${button}.disabled`, 'held check started');
    for (let i=0; i<200 && !fixture.isHeld; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(fixture.isHeld, true); const old = runtime.activeSession.sessionId
    await close({ pending: true }); await open(); assert.notEqual(runtime.activeSession.sessionId, old)
    fixture.release();
    for (let i=0; i<200 && calls('checkAppUpdate').at(-1)?.status === 'pending'; i++) await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls('checkAppUpdate').at(-1)?.code, 'ERR_ATOOLS_SETTINGS_SESSION')
    await waitFor(childPage, `!${button}.disabled`, 'new session remains usable')
    assert.ok(!await evaluate(childPage, "document.body.innerText.includes('当前已是最新版本')"))
    await close(); await evaluate(mainPage, 'window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.dispose()')
    await waitFor(mainPage, 'window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__.snapshot().activeListeners === 0', 'listeners disposed')
    assert.equal(report.screenshots.length, 4); assert.equal(new Set(info.sessions).size, info.sessions.length)
    assert.deepEqual(fixture.snapshot().raw.future, { keep: 'opaque' })
    info.finalFixture = fixture.snapshot(); info.syntheticTransport = true; info.nativeGuiRun = false
    report.checks.push('Original About and Main notice exercised against scoped synthetic transport; old session rejected.')
  } }
}
