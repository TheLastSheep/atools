import assert from 'node:assert/strict';

/** Wait for the real shared open RPC, loaded lifecycle and current Child input owner. */
export async function waitForMainDropSettingsReady(mainPage, childPage, runtime) {
  const session = runtime.activeSession;
  assert.ok(session && /^[0-9a-f]{32}$/.test(session.sessionId), 'Current Settings session missing');
  await runtime.waitFor(mainPage, `(() => { const s=window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.().settingsView;
    return s?.activePhase==='loaded' && s.pendingOpen===false && s.listenerState==='listening'; })()`, 'Settings loaded and open RPC acknowledged');
  await runtime.waitFor(childPage, `window.__ATOOLS_SETTINGS_INPUT_CHILD__?.snapshot().config.sessionId===${JSON.stringify(session.sessionId)} && window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot().pendingCount===0`, 'current Child input operations settled');
  assert.equal(runtime.activeSession, session, 'Settings owner changed during opening');
  const nativeInput = session.state.snapshot();
  assert.equal(nativeInput.sessionId, session.sessionId);
  assert.equal(nativeInput.visible, true, 'Current SubInput owner not registered');
  assert.equal(nativeInput.closed, false, 'Settings closed before opening completed');
  assert.ok(typeof session.openedAt === 'string' && Number.isFinite(Date.parse(session.openedAt)), 'Settings loaded timestamp missing');
  const main = await runtime.evaluate(mainPage, 'window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.snapshot().settingsView');
  assert.equal(main.activePhase, 'loaded'); assert.equal(main.pendingOpen, false); assert.equal(main.listenerState, 'listening');
  for (const field of ['openFailures','closeFailures','invalidPayloads','registrationErrors','lateListenerUnlistens','cleanupErrors']) assert.equal(main[field], 0, field);
  const rpc = await runtime.evaluate(mainPage, 'window.__ATOOLS_SETTINGS_INPUT_TESTING__.snapshot()');
  assert.equal(rpc.unresolved, 0, 'Main open transport reply still pending');
  assert.ok(rpc.requests.some(call => call.command === 'open_renderer_settings'), 'Public Main open RPC not observed');
  return { sessionId: session.sessionId, openedAt: session.openedAt, main,
    subInput: { sessionId: nativeInput.sessionId, visible: nativeInput.visible, closed: nativeInput.closed,
      generation: nativeInput.generation, revision: nativeInput.revision }, mainRpcUnresolved: rpc.unresolved };
}

/** Retire only the current owned Child after its genuine close receipt. */
export async function retireMainDropChild(context, runtime) {
  const { childPage, mainPage, server } = context;
  await runtime.waitFor(mainPage, "!document.querySelector('.app-container__plugin')", 'original App returned from Settings');
  assert.equal(runtime.activeSession, null, 'Previous Settings session has not closed');
  const closed = runtime.lastClosedSession;
  assert.ok(closed?.sessionId && closed.closedAt && closed.state.snapshot().closed, 'Closed session receipt missing');
  await runtime.waitFor(childPage, 'window.__ATOOLS_SETTINGS_INPUT_CHILD__.snapshot().pendingCount===0', 'closed Child operations settled');
  assert.ok(runtime.childInjectionId, 'Owned Child injection missing before retirement');
  await childPage.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: runtime.childInjectionId });
  runtime.clearChildInjection();
  const loaded = childPage.waitForEvent('Page.loadEventFired', 10000);
  await childPage.send('Page.navigate', { url: server.retiredUrl });
  await loaded;
  await runtime.waitFor(childPage, "document.querySelector('main[data-atools-retired-target]') && !window.ztools && !window.__ATOOLS_SETTINGS_INPUT_CHILD__", 'retired Child with bridge globals removed');
  return { sessionId: closed.sessionId, closedAt: closed.closedAt, documentRetired: true };
}

/** Capture actual private facts before cleanup; missing observations stay explicit. */
export async function captureMainDropFailure(context, runtime) {
  const facts = { sessionId: runtime.activeSession?.sessionId ?? null };
  for (const [key, page, expression] of [
    ['child', context.childPage, `(() => { const a=window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.(); const i=window.__ATOOLS_SETTINGS_INPUT_CHILD__?.snapshot?.(); return {url:location.href,hash:location.hash,readyCalls:a?.calls?.filter(c=>c.operation==='ready')??[],readyCallCount:a?.calls?.filter(c=>c.operation==='ready').length??null,config:i?.config??null,pendingCount:i?.pendingCount??null,sourcesPanel:!!document.querySelector('.sources-panel'),menuItems:Array.from(document.querySelectorAll('.menu-item')).map(e=>({text:e.textContent.trim(),active:e.classList.contains('active')}))}; })()`],
    ['main', context.mainPage, 'window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.().settingsView ?? null'],
  ]) {
    try { facts[key] = await runtime.evaluate(page, expression); }
    catch (error) { facts[key] = { observationError: String(error) }; }
  }
  return facts;
}

/** Runs the shipped original App/SearchBox; only the Native transport is synthetic. */
export function createMainFileDropBrowserJourney(context, runtime) {
  const { report, mainPage, childPage, currentDocument } = context;
  const { evaluate, waitFor, captureScreenshot } = runtime;
  const info = report.mainFileDrop;
  const api = 'window.__ATOOLS_MAIN_DROP_FIXTURE__';
  const snapshot = () => evaluate(mainPage, `({native:${api}.snapshot(),query:document.querySelector('.search-input')?.value,
    files:document.querySelector('.pasted-files')?.textContent.trim()||'',hover:!!document.querySelector('.drag-overlay')})`);
  const ready = () => waitFor(mainPage, `${api}.snapshot().lease && ${api}.snapshot().activeListeners===1`, 'one active original SearchBox drop lease');
  const emit = (phase, fields, seq, lease) => evaluate(mainPage, `${api}.emit(${JSON.stringify(phase)},${JSON.stringify(fields)},${seq},${lease ? JSON.stringify(lease) : 'undefined'})`);
  const check = (name, value) => { assert.equal(value, true, name); report.checks.push({ name, passed: true }); };
  async function query(text) {
    await evaluate(mainPage, `document.querySelector('.search-input').focus();document.querySelector('.search-input').select()`);
    await mainPage.send('Input.insertText', { text });
    await waitFor(mainPage, `document.querySelector('.search-input').value===${JSON.stringify(text)}`, 'original query input');
  }
  async function leaveSearch() {
    runtime.setOpenedBy('R77-public-Main-openSettings');
    await evaluate(mainPage, 'window.ztools.openSettings()');
    await waitFor(mainPage, `!${api}.snapshot().lease && !!document.querySelector('.app-container__plugin')`, 'Search deactivated by real App Settings flow');
    await waitFor(childPage, 'window.__ATOOLS_SETTINGS_INPUT_CHILD__ && document.querySelector(".menu-item")', 'original Settings Child DOM');
    const barrier = await waitForMainDropSettingsReady(mainPage, childPage, runtime);
    (info.settingsOpenBarriers ??= []).push(barrier);
  }
  async function backToSearch() {
    await evaluate(childPage, 'window.ztools.outPlugin()');
    const retired = await retireMainDropChild(context, runtime);
    (info.retiredSessions ??= []).push(retired);
  }
  return { async run() {
    try {
    await ready(); await query('R77 original query');
    info.transport = 'synthetic-native-targeted-event'; info.osDragDrop = 'unverified';
    info.before = await snapshot();
    await captureScreenshot(mainPage, 'main-r77-query', currentDocument.main);
    await emit('hover', { hovered: true }, 10);
    await waitFor(mainPage, '!!document.querySelector(".drag-overlay")', 'native hover original overlay');
    await captureScreenshot(mainPage, 'main-r77-hover', currentDocument.main);
    await emit('hover', { hovered: false }, 11);
    await waitFor(mainPage, '!document.querySelector(".drag-overlay")', 'leave clears original overlay');
    check('hover/leave consume original SearchBox overlay', true);
    await mainPage.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'f', code: 'KeyF', modifiers: 4 });
    await mainPage.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'f', code: 'KeyF', modifiers: 4 });
    await waitFor(mainPage, '!!document.querySelector(".pasted-text")', 'original App fixed-text before files');
    await query('files replace fixed text');
    const files = [{ path: '/private/tmp/r77-synthetic/file.txt', name: 'file.txt', isDirectory: false },
      { path: '/private/tmp/r77-synthetic/folder', name: 'folder', isDirectory: true }];
    await emit('drop', { files }, 2);
    await waitFor(mainPage, 'document.querySelector(".file-name")?.textContent==="file.txt" && document.querySelector(".file-count")?.textContent==="2" && document.querySelector(".search-input").value===""', 'real App file chips and cleared query');
    check('higher Leave does not swallow earlier accepted file result', true);
    check('original App watcher clears fixed-text when Native files arrive', await evaluate(mainPage, '!document.querySelector(".pasted-text")')); 
    await captureScreenshot(mainPage, 'main-r77-files', currentDocument.main);
    await query('R77 preserve after failure');
    await emit('error', { code: 'INVALID_BATCH' }, 3);
    await waitFor(mainPage, 'document.querySelector(".search-input").value==="R77 preserve after failure"', 'error retains query');
    await emit('drop', { files: [] }, 4); // malformed empty result must not clear input
    const failure = await snapshot(); check('error/empty metadata preserve query and files', failure.files.includes('file.txt') && failure.query === 'R77 preserve after failure');
    await captureScreenshot(mainPage, 'main-r77-error-preserved', currentDocument.main);
    await emit('hover', { hovered: true }, 20);
    await emit('drop', { files: [{ ...files[0], name: 'newest.txt' }] }, 8);
    await emit('drop', { files: [{ ...files[0], name: 'stale.txt' }] }, 7);
    await emit('error', { code: 'METADATA_FAILED' }, 9);
    await waitFor(mainPage, 'document.querySelector(".file-name")?.textContent==="newest.txt" && !!document.querySelector(".drag-overlay")', 'new hover survives old asynchronous result/error');
    check('separate hover/content order and stale drop rejection', true);
    await evaluate(mainPage, `(() => { const event=new Event('drop',{bubbles:true,cancelable:true});Object.defineProperty(event,'dataTransfer',{value:{files:[new File(['x'],'dom.txt')]}});document.querySelector('.search-box').dispatchEvent(event);return event.defaultPrevented; })()`);
    check('DOM drop cannot duplicate Native files', (await snapshot()).files.includes('newest.txt'));
    const old = await snapshot(); await leaveSearch();
    await emit('drop', { files }, 100, old.native.lease);
    check('Plugin route rejects previous lease', !(await snapshot()).files.includes('file.txt'));
    await backToSearch(); await ready(); const fresh = await snapshot();
    check('Search returns with a new context and lease', fresh.native.context !== old.native.context && fresh.native.lease !== old.native.lease);
    await query('R77 old lease ignored'); await emit('drop', { files }, 101, old.native.lease);
    check('late prior-context event preserves new Search query', (await snapshot()).query === 'R77 old lease ignored');
    // End with a genuinely pending registration, then dispose the real adapter before its ACK.
    await leaveSearch(); await evaluate(mainPage, `${api}.hold(true)`); await backToSearch();
    await waitFor(mainPage, `${api}.snapshot().pending===1`, 'held original Search registration');
    await evaluate(mainPage, `window.__ATOOLS_ZTOOLS_HOST_ADAPTER__.dispose();${api}.hold(false);${api}.release()`);
    await waitFor(mainPage, `${api}.snapshot().pending===0 && ${api}.snapshot().lease===null && ${api}.snapshot().activeListeners===0`, 'disposed target/listener with late ACK cleaned');
    info.after = await snapshot(); check('adapter disposal revokes late lease and listener', true);
    info.scenarios = ['hover-leave','files-directory-chips-query','error-empty-preservation','DOM-native-dedup',
      'independent-hover-content-order','Plugin-Search-context','late-event','pending-registration-disposal'];
    } catch (error) {
      info.failureFacts = await captureMainDropFailure(context, runtime);
      throw error;
    }
  } };
}
