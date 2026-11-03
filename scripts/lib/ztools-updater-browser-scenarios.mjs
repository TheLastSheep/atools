import assert from 'node:assert/strict';
import { beginUpdaterKeyObservation, readUpdaterFacts } from './ztools-updater-browser-observation.mjs';
import { readFixedUpdaterHeadingAlignment, assertFixedUpdaterHeadingAlignment } from './ztools-updater-browser-alignment.mjs';

export async function runUpdaterBrowserScenarios({ page, control, documentFor, screenshot, report, server }) {
  const id = '1'.repeat(32), candidateId = '2'.repeat(32), operationId = '3'.repeat(32);
  const evaluate = control.evaluate;
  const fixture = expression => evaluate(`window.__UPDATER_BROWSER_FIXTURE__.${expression}`);
  const state = () => fixture('snapshot()');
  const publish = patch => fixture(`publish(${JSON.stringify(patch)})`);
  const operations = async op => (await state()).calls.filter(c => c.args?.request?.op === op);
  const enabled = async value => control.wait(() => evaluate(`document.querySelector('.btn.confirm')?.disabled===${!value}`), 'confirmation availability');
  const text = () => evaluate(`document.querySelector('.update-window')?.innerText`);
  async function settleAction() { await control.wait(async () => (await state()).pending === 0, 'FakeNative action terminal'); await enabled(true); }
  async function pagehide() {
    await evaluate(`window.dispatchEvent(new Event('pagehide'))`);
    await control.wait(async () => {
      const snapshot = await state();
      return snapshot.nativeListeners === 0 && snapshot.callbacks === 0 && snapshot.pending === 0 &&
        Object.values(snapshot.ownedListeners).every(n => n === 0);
    }, 'Native/media/explicit DOM listener cleanup');
  }
  await documentFor(id, candidateId);
  await enabled(true);
  await screenshot('01-available');
  // Active network oracle control is outside the product notes; no execution/resource URL can hide behind a disabled loader.
  await evaluate(`(()=>{const image=document.createElement('img');image.id='oracle';image.src=${JSON.stringify(server.origin + '/tripwire/oracle')};document.body.append(image)})()`);
  await control.wait(() => server.state.tripwires.includes('/tripwire/oracle'), 'actual Chrome loopback resource positive control');
  await evaluate(`document.getElementById('oracle').remove()`);

  const beforeLink = (await operations('start')).length;
  // Tab targets the original safe note link; trusted Enter must route open-link without confirming installation.
  await control.key('Tab', 'Tab', 9);
  await control.wait(() => evaluate(`document.activeElement?.matches('.changelog a')`), 'original link keyboard focus');
  await control.key('Enter', 'Enter', 13);
  await control.wait(async () => (await operations('open-link')).length === 1, 'limited Native link intent');
  assert.equal((await operations('start')).length, beforeLink);
  assert.equal((await operations('open-link'))[0].args.request.href, 'https://example.com/release');
  // Trusted left pointer header requests owned drag only; original Cancel button is not a drag region.
  await control.click('.header');
  assert.equal((await operations('drag')).length, 1);

  // Explicit synthetic KeyboardEvents test composition/repeat flags not expressible as trusted CDP IME keydown.
  const startCount = (await operations('start')).length;
  await evaluate(`(()=>{const root=document.querySelector('.update-window');root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,isComposing:true}));root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,repeat:true}));})()`);
  assert.equal((await operations('start')).length, startCount, 'Composition/repeat cannot confirm');
  // Header pointerdown is a drag action and can cancel focus transfer. Confirm focus explicitly.
  await control.click('.header');
  if (!await evaluate(`document.activeElement===document.querySelector('.update-window')`)) {
    await control.wait(() => evaluate(`document.activeElement?.matches('.changelog a')`), 'bare Enter keyboard focus origin is the original link');
    await control.key('Tab', 'Tab', 9, 8);
  }
  await control.wait(() => evaluate(`document.hasFocus() && document.activeElement===document.querySelector('.update-window')`), 'bare Enter exact root focus before confirmation');
  const focusBeforeEnter = await readUpdaterFacts(control);
  assert.equal(focusBeforeEnter.focus.root, true); assert.equal(focusBeforeEnter.documentFocused, true);
  assert.equal(focusBeforeEnter.state.phase, 'available'); assert.equal(focusBeforeEnter.pending, 0);
  assert.equal(focusBeforeEnter.state.operationId, null);
  assert.deepEqual(focusBeforeEnter.state.candidate, { candidateId, version: '3.0.1', currentVersion: '3.0.0',
    bodyBytes: new TextEncoder().encode('# Release\n\n**Safe** [release](https://example.com/release)').length });
  report.bareEnter = { before: focusBeforeEnter };
  await beginUpdaterKeyObservation(control);
  let bareEnterFailure;
  try {
    await control.key('Enter', 'Enter', 13);
    await control.wait(async () => (await state()).pending === 1, 'bare Enter exact candidate confirmation');
  } catch (error) {
    bareEnterFailure = error; throw error;
  } finally {
    try { report.bareEnter.after = await readUpdaterFacts(control, true); }
    catch (diagnosticError) {
      report.bareEnter.observationError = diagnosticError.message;
      if (!bareEnterFailure) throw diagnosticError;
    }
  }
  const start = (await operations('start')).at(-1).args.request;
  assert.deepEqual(start, { op: 'start', windowId: id, candidateId });
  await publish({ phase: 'downloading', operationId, progress: { downloaded: 1048576, total: null } });
  assert.match(await text(), /1\.0 MB/);
  await publish({ phase: 'downloading', progress: { downloaded: 50, total: 100 } });
  assert.match(await text(), /50%/);
  await screenshot('02-downloading');
  const closes = (await operations('close')).length;
  await control.key('Escape', 'Escape', 27);
  assert.equal((await operations('close')).length, closes);
  await publish({ phase: 'downloaded', operationId });
  await enabled(false);
  assert.equal(await evaluate(`document.querySelector('.btn.cancel').disabled`), true, 'Active operation remains busy between download and install');
  await publish({ phase: 'installing', operationId });
  await enabled(false);
  await screenshot('03-installing');
  await publish({ phase: 'install-unknown', operationId: null, error: { code: 'install_unknown', message: '安装失败' } });
  await fixture('complete()'); await settleAction();
  assert.match(await text(), /可能已改变|安装失败/);
  await screenshot('04-error');
  await publish({ phase: 'downloaded', operationId: null, error: null });
  await enabled(true);
  assert.match(await text(), /立即安装/);
  await control.click('.btn.confirm');
  await control.wait(async () => (await state()).pending === 1, 'retained-download confirmation facade');
  assert.deepEqual((await operations('install-downloaded')).at(-1).args.request,
    { op: 'install-downloaded', windowId: id, candidateId });
  await publish({ phase: 'install-unknown', operationId: null, error: { code: 'install_unknown', message: 'fixture retry failure' } });
  await fixture('complete()'); await settleAction();
  // Actual bridge action result must reject an old same-candidate terminal reply after newer authoritative failure.
  await publish({ phase: 'available', error: null });
  await evaluate(`window.__UPDATER_ACTION_RESULT__=window.ztools.updater.startUpdate();void 0`);
  await control.wait(async () => (await state()).pending === 1, 'direct bridge stale-terminal probe');
  const newer = await publish({ phase: 'install-unknown', error: { code: 'install_unknown', message: 'newer failure' } });
  await fixture(`complete(${JSON.stringify({ ...newer, sequence: newer.sequence - 1, phase: 'restarting', error: null })})`);
  assert.equal((await evaluate(`window.__UPDATER_ACTION_RESULT__`)).success, false);
  assert.match(await text(), /可能已改变|newer failure/);

  const malicious = `<img src="${server.origin}/tripwire/img" onerror="window.__PWNED__=true"><iframe src="${server.origin}/tripwire/frame"></iframe>` +
    `<script src="${server.origin}/tripwire/script">window.__PWNED__=true</script><style>@import '${server.origin}/tripwire/css';</style>` +
    `<svg><image href="${server.origin}/tripwire/svg"/></svg><a href="javascript:alert(1)" onclick="window.__PWNED__=true">bad</a>`;
  await publish({ phase: 'available', error: null, candidate: { ...newer.candidate, body: malicious } });
  await control.wait(() => evaluate(`document.querySelector('.changelog')?.textContent.includes('bad')`), 'real sanitized malicious notes');
  assert.equal(await evaluate(`document.querySelector('.changelog script,.changelog img,.changelog iframe,.changelog svg,.changelog style,.changelog [onerror],.changelog [onclick]')`), null);
  assert.equal(await evaluate(`window.__PWNED__===undefined`), true);
  const table = '|' + 'x|'.repeat(200) + '\n|' + '-|'.repeat(200) + '\n' + '|a|\n'.repeat(200);
  await publish({ candidate: { ...newer.candidate, body: table } });
  await control.wait(() => evaluate(`document.querySelector('.changelog')?.textContent.includes('安全纯文本')`), 'small table amplification escaped fallback in Chrome');
  const semantic = '3. third\n4. fourth\n\n| Name | Value |\n| :--- | ---: |\n| A | **B** |\n\n- [x] done\n- [ ] pending';
  await publish({ candidate: { ...newer.candidate, body: semantic } });
  await control.wait(() => evaluate(`document.querySelector('.changelog ol')?.getAttribute('start')==='3'`), 'ordered list start preserved');
  report.markdownAlignment = await evaluate(`(${readFixedUpdaterHeadingAlignment.toString()})(document)`);
  assertFixedUpdaterHeadingAlignment(report.markdownAlignment);
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.changelog input')).map(e=>({type:e.type,disabled:e.disabled,checked:e.checked}))`),
    [{ type: 'checkbox', disabled: true, checked: true }, { type: 'checkbox', disabled: true, checked: false }]);
  assert.deepEqual(server.state.tripwires, ['/tripwire/oracle']);

  await fixture(`appearance({sequence:2,material:'acrylic',acrylicOpacity:{light:66,dark:33},materialApplied:false,opacityApplied:false})`);
  // Force platform class only in injected FakeNative-controlled observation; does not claim actual Windows effects.
  await evaluate(`document.documentElement.classList.add('os-windows')`);
  await fixture(`appearance({sequence:3,material:'acrylic',acrylicOpacity:{light:66,dark:33}})`);
  await control.wait(() => evaluate(`document.getElementById('acrylic-overlay-style')?.textContent.includes('66%')`), 'original appearance CSS projection');
  const light = await evaluate(`getComputedStyle(document.body,'::after').backgroundColor`);
  await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await control.wait(async () => (await evaluate(`getComputedStyle(document.body,'::after').backgroundColor`)) !== light, 'actual Chrome media consumption');
  report.appearance = { light, dark: await evaluate(`getComputedStyle(document.body,'::after').backgroundColor`), fakeNativeApplied: false };
  const material = (await state()).appearance.material;
  await fixture(`appearance({sequence:1,material:'none'})`);
  assert.equal(await evaluate(`document.documentElement.getAttribute('data-material')`), material);

  await publish({ phase: 'not-available', candidate: null, operationId: null });
  await enabled(false);
  assert.equal(await evaluate(`document.querySelector('.btn.cancel').disabled`), false);
  assert.equal(await evaluate(`document.querySelector('.title').textContent`), '当前没有可用更新');
  await screenshot('05-no-candidate');
  await control.click('.btn.cancel');
  assert.equal((await operations('drag')).length, 2, 'Interactive Cancel never triggers drag');
  await control.wait(async () => (await state()).nativeListeners === 0, 'Cancel Native/appearance cleanup');
  report.checks.push('original available/progress/downloaded-active/install/error/withdrawn states; bounded notes; keyboard/link/drag; appearance/media; Cancel cleanup');

  const freshId = '4'.repeat(32), freshCandidate = '5'.repeat(32);
  await documentFor(freshId, freshCandidate);
  const freshState = (await state()).state;
  await fixture(`emitSnapshot(${JSON.stringify({ ...freshState, sequence: 999, candidate: { ...freshState.candidate, version: 'old-window' } })},${JSON.stringify(id)})`);
  assert.match(await text(), /3\.0\.2/);
  assert.doesNotMatch(await text(), /old-window/);
  // Pending operation explicitly reaches a terminal reply after pagehide; late original action must not rewrite detached UI.
  await control.click('.btn.confirm');
  await control.wait(async () => (await state()).pending === 1, 'fresh candidate action');
  await evaluate(`window.dispatchEvent(new Event('pagehide'))`);
  const afterHide = await text();
  await fixture(`complete(${JSON.stringify({ ...freshState, sequence: 2, phase: 'error', error: { code: 'internal', message: 'late-after-pagehide' } })})`);
  await pagehide();
  assert.equal(await text(), afterHide);
  assert.deepEqual((await state()).errors, []);
  report.checks.push('fresh document/window/candidate; old-window event rejected; pending terminal after pagehide does not rewrite UI; zero Native/media/explicit DOM callbacks');
  await documentFor('6'.repeat(32), '7'.repeat(32));
  await control.key('Escape', 'Escape', 27);
  await control.wait(async () => (await state()).nativeListeners === 0, 'idle Escape closes the current popup');
  assert.equal((await operations('close')).length, 1);
  assert.equal((await operations('start')).length, 0);
  report.checks.push('idle trusted Escape closes without confirmation');
  // Separate available document: genuine keyboard focus, not a Cancel click or DOM focus shortcut.
  await documentFor('8'.repeat(32), '9'.repeat(32));
  assert.equal((await state()).pending, 0);
  assert.equal((await state()).state.phase, 'available');
  await control.key('Tab', 'Tab', 9);
  await control.wait(() => evaluate(`document.activeElement?.matches('.changelog a')`), 'Cancel document first original link focus');
  await control.key('Tab', 'Tab', 9);
  await control.wait(() => evaluate(`document.activeElement?.matches('.btn.cancel')`), 'original Cancel trusted Tab focus');
  const cancelEnterBefore = await readUpdaterFacts(control);
  assert.equal(cancelEnterBefore.documentFocused, true);
  assert.equal(cancelEnterBefore.focus.className, 'btn cancel');
  assert.equal(cancelEnterBefore.state.phase, 'available');
  assert.equal(cancelEnterBefore.pending, 0);
  report.cancelEnter = { before: cancelEnterBefore };
  await beginUpdaterKeyObservation(control);
  let cancelEnterFailure;
  try {
    await control.key('Enter', 'Enter', 13);
    await control.wait(async () => (await state()).nativeListeners === 0, 'Cancel focused Enter closes the current popup');
  } catch (error) {
    cancelEnterFailure = error;
    throw error;
  } finally {
    try { report.cancelEnter.after = await readUpdaterFacts(control, true); }
    catch (diagnosticError) {
      report.cancelEnter.observationError = diagnosticError.message;
      if (!cancelEnterFailure) throw diagnosticError;
    }
  }
  assert.equal((await operations('close')).length, 1);
  assert.equal((await operations('start')).length, 0);
  assert.equal((await operations('install-downloaded')).length, 0);
  assert.equal((await state()).pending, 0);
  report.checks.push('separate available document: trusted Tab-focus Cancel + CDP Enter closes exactly once with zero start/install');
}
