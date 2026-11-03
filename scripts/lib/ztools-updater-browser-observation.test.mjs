import assert from 'node:assert/strict';
import test from 'node:test';
import { installUpdaterKeyObserver, readUpdaterBrowserFacts, recordUpdaterJsDiagnostic } from './ztools-updater-browser-observation.mjs';

function ownedDocument() {
  const root = { tagName: 'DIV', textContent: 'owned'.repeat(1000), getAttribute: () => 'update-window', closest: () => null };
  const handlers = new Set();
  const document = { activeElement: root, visibilityState: 'visible', hasFocus: () => true,
    querySelector: selector => selector === '.update-window' ? root : null, querySelectorAll: () => [],
    addEventListener(type, callback, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true); handlers.add(callback); },
    removeEventListener(type, callback, capture) { assert.equal(type, 'keydown'); assert.equal(capture, true); handlers.delete(callback); } };
  return { owner: { document }, handlers, root };
}
test('scoped key observation is passive, bounded, labels the capture-microtask sample and removes its exact listener', async () => {
  const { owner, handlers, root } = ownedDocument();
  assert.deepEqual(installUpdaterKeyObserver(owner), { active: true, records: [] });
  assert.equal(handlers.size, 1);
  assert.throws(() => installUpdaterKeyObserver(owner), /already active/);
  const event = { target: root, key: 'Enter', code: 'Enter', isTrusted: true, repeat: false,
    isComposing: false, keyCode: 13, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
    defaultPrevented: false, preventDefault() { assert.fail('Observer must not change default handling'); } };
  for (let i = 0; i < 20; i++) for (const callback of handlers) callback(event);
  assert.equal(event.defaultPrevented, false);
  event.defaultPrevented = true; await Promise.resolve();
  const observed = owner.__UPDATER_BROWSER_KEY_OBSERVER__.stop();
  assert.equal(observed.active, false); assert.equal(observed.records.length, 8); assert.equal(handlers.size, 0);
  assert.equal(observed.records[0].target.root, true); assert.equal(observed.records[0].isTrusted, true);
  assert.equal(observed.records[0].samplingStage, 'capture-microtask');
  assert.equal(observed.records[0].defaultPreventedObserved, true);
  assert.equal(Object.hasOwn(observed.records[0], 'defaultPrevented'), false);
  assert.deepEqual(owner.__UPDATER_BROWSER_KEY_OBSERVER__.stop(), observed);
});
test('failure facts are bounded and stop the observer without altering focus or fixture state', () => {
  const { owner, handlers, root } = ownedDocument();
  const state = { version: 1, sequence: 1, phase: 'available', operationId: null,
    candidate: { candidateId: '2'.repeat(32), currentVersion: '1', version: '2', body: 'x'.repeat(10000) },
    progress: { downloaded: 0, total: null }, error: { code: 'test', message: 'm'.repeat(1000) } };
  const fixture = { state, pending: 0, calls: Array.from({ length: 70 }, () => ({ command: 'renderer_updater_window',
    args: { request: { op: 'open-link', href: 'h'.repeat(1000) } } })) };
  owner.__UPDATER_BROWSER_FIXTURE__ = { snapshot: () => fixture };
  installUpdaterKeyObserver(owner);
  const facts = readUpdaterBrowserFacts(owner, true);
  assert.equal(handlers.size, 0); assert.equal(owner.document.activeElement, root);
  assert.equal(facts.focus.root, true); assert.equal(facts.pending, 0); assert.equal(facts.callCount, 70);
  assert.equal(facts.calls.length, 40); assert.equal(facts.calls[0].request.href.length, 200);
  assert.equal(facts.bodyText.length, 2000); assert.equal(facts.state.candidate.bodyBytes, 10000);
  assert.equal(facts.state.error.message.length, 256); assert.equal(facts.keys.active, false);
  assert.equal(state.candidate.body.length, 10000); assert.equal(fixture.calls.length, 70);
});
test('owned-page JS diagnostics distinguish exception/error/warning, ignore ordinary logs and bound storage', () => {
  const report = { console: [] };
  recordUpdaterJsDiagnostic(report, 'console-api', { type: 'log', args: [{ value: 'ordinary' }] });
  recordUpdaterJsDiagnostic(report, 'network', { type: 'error', text: 'oracle resource status' });
  assert.deepEqual(report.console, []);
  recordUpdaterJsDiagnostic(report, 'console-api', { type: 'error', args: [{ value: 'caught failure' }] });
  recordUpdaterJsDiagnostic(report, 'console-api', { type: 'warning', args: [{ value: 'fixed warning' }] });
  recordUpdaterJsDiagnostic(report, 'exception', { exceptionDetails: { exception: { description: 'uncaught' } } });
  assert.deepEqual(report.console.map(item => [item.kind, item.level, item.expected]),
    [['console-api', 'error', false], ['console-api', 'warning', false], ['exception', 'error', false]]);
  assert.ok(report.console.every(item => item.source === 'owned-updater-headless-fixture'));
  for (let i = 0; i < 100; i++) recordUpdaterJsDiagnostic(report, 'console-api', { type: 'error', args: [{ value: 'x'.repeat(10000) }] });
  assert.equal(report.console.length, 64); assert.equal(report.consoleOverflow, 39);
  assert.ok(report.console.every(item => item.message.length <= 1024));
});
