import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { retireMainDropChild, captureMainDropFailure, waitForMainDropSettingsReady } from './ztools-main-file-drop-browser-journey.mjs';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';
import { assertMainFileDropFormalReceipt, assertParsedGeneralSourceDigest, CORE_GENERAL_SOURCE_PATH, MAIN_DROP_RECEIPT_PATH, decorateMainFileDropBootstrap } from './ztools-main-file-drop-browser-fixture.mjs';
function fixture() {
  const delegated = [];
  const transport = { invoke: async (...args) => { delegated.push(args); return 'delegated'; }, listen: async () => () => {} };
  const window = { __ATOOLS_ZTOOLS_RENDERER_TRANSPORT__: transport };
  const source = decorateMainFileDropBootstrap('');
  const testedSource = process.env.ATOOLS_R77_RELAX_CONTEXT === '1' ? source.replace('r.contextId !== context', 'false') : source;
  vm.runInNewContext(testedSource, { window, crypto: webcrypto, structuredClone });
  return { transport, delegated, api: window.__ATOOLS_MAIN_DROP_FIXTURE__ };
}
const set = (contextId, leaseId = null, target = { x: 1, y: 2, width: 300, height: 60 }) => ({ request: { op: 'set', contextId, leaseId, target } });
test('strict synthetic context/set/disable and unrelated command delegation', async () => {
  const f = fixture();
  const c = await f.transport.invoke('set_renderer_main_drop_target', { request: { op: 'context' } });
  const lease = await f.transport.invoke('set_renderer_main_drop_target', set(c.contextId));
  assert.match(lease.leaseId, /^[0-9a-f]{32}$/);
  await assert.rejects(f.transport.invoke('set_renderer_main_drop_target', set('other', lease.leaseId)));
  await assert.rejects(f.transport.invoke('set_renderer_main_drop_target', { request: { operation: 'context' } }));
  await f.transport.invoke('set_renderer_main_drop_target', set(c.contextId, lease.leaseId, null));
  assert.equal(f.api.snapshot().lease, null);
  assert.equal(await f.transport.invoke('get_apps'), 'delegated');
});
test('event delivery preserves deliberately out-of-order sequence/old lease; subscription cleanup is idempotent', async () => {
  const f = fixture(), received = [];
  const stop = await f.transport.listen('renderer-main-file-drop', value => received.push(value));
  f.api.emit('hover', { hovered: true }, 10, 'old'); f.api.emit('drop', { files: [] }, 4, 'old');
  assert.deepEqual(received.map(x => x.sequence), [10, 4]);
  stop(); stop(); assert.equal(f.api.raw({}), 0);
  assert.equal(f.api.snapshot().unlistens, 1);
});
test('held registration/rejection and Settings context rotation remain observable', async () => {
  const f = fixture(), c = await f.transport.invoke('set_renderer_main_drop_target', { request: { op: 'context' } });
  f.api.hold(true); const pending = f.transport.invoke('set_renderer_main_drop_target', set(c.contextId));
  assert.equal(f.api.snapshot().pending, 1); f.api.failNext(); f.api.release(); await assert.rejects(pending);
  f.api.hold(false); const lease = await f.transport.invoke('set_renderer_main_drop_target', set(c.contextId));
  await f.transport.invoke('open_renderer_settings');
  assert.equal(f.api.snapshot().context, null);
  await assert.rejects(f.transport.invoke('set_renderer_main_drop_target', set(c.contextId, lease.leaseId, null)));
});

async function actualArtifact() {
  const receipt = await readFile(MAIN_DROP_RECEIPT_PATH), declared = JSON.parse(receipt)['packages/ztools-renderer/dist'];
  const files = {};
  for (const path of Object.keys(declared.files)) {
    const bytes = await readFile(path);
    files[path.slice('packages/ztools-renderer/dist/'.length)] = { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  return { receipt, tree: { exists: true, files } };
}
test('formal receipt binds all twelve actual Main files and provenance', async () => {
  const f = await actualArtifact();
  assert.equal(assertMainFileDropFormalReceipt(f.receipt, f.tree).mainJavaScriptBytes, 609908);
});
for (const mutation of ['same-size-js-swap', 'provenance-swap', 'missing-file', 'extra-file', 'byte-count']) {
  test(`formal receipt rejects ${mutation} before browser acceptance`, async () => {
    const f = await actualArtifact(), files = f.tree.files;
    const js = Object.keys(files).find(p => p.endsWith('.js'));
    if (mutation === 'same-size-js-swap') files[js].sha256 = 'a'.repeat(64);
    if (mutation === 'provenance-swap') files['build-provenance.json'].sha256 = 'b'.repeat(64);
    if (mutation === 'missing-file') delete files[js];
    if (mutation === 'extra-file') files['extra.js'] = { bytes: 1, sha256: 'c'.repeat(64) };
    if (mutation === 'byte-count') files[js].bytes++;
    assert.throws(() => assertMainFileDropFormalReceipt(f.receipt, f.tree));
  });
}
test('receipt replacement is rejected even if its declared hashes are changed consistently', async () => {
  const f = await actualArtifact(), replacement = JSON.parse(f.receipt);
  const key = Object.keys(replacement['packages/ztools-renderer/dist'].files).find(p => p.endsWith('.js'));
  replacement['packages/ztools-renderer/dist'].files[key] = 'a'.repeat(64);
  f.tree.files[key.slice('packages/ztools-renderer/dist/'.length)].sha256 = 'a'.repeat(64);
  assert.throws(() => assertMainFileDropFormalReceipt(Buffer.from(JSON.stringify(replacement)), f.tree), /receipt changed/);
});

test('import-time General bytes must match before and after captured identities, even when snapshots match each other', () => {
  const imported = 'a'.repeat(64), identity = { authoredFiles: { [CORE_GENERAL_SOURCE_PATH]: { bytes: 100, sha256: imported } } };
  assert.equal(assertParsedGeneralSourceDigest(identity, imported).capturedSha256, imported);
  const drifted = structuredClone(identity); drifted.authoredFiles[CORE_GENERAL_SOURCE_PATH].sha256 = 'b'.repeat(64);
  for (const snapshotPhase of ['before', 'after']) assert.throws(() => assertParsedGeneralSourceDigest(drifted, imported), /parsed at module import/, snapshotPhase);
  assert.deepEqual(drifted, structuredClone(drifted)); // Stable run snapshots alone cannot prove imported bytes.
  assert.throws(() => assertParsedGeneralSourceDigest({ authoredFiles: {} }, imported), /missing/);
  assert.throws(() => assertParsedGeneralSourceDigest(identity, 'invalid'), /digest/);
});
test('actual shared fixture exported digest binds the same current Core bytes without a hardcoded Core hash', async () => {
  const { RENDERER_GENERAL_SETTINGS_SOURCE_SHA256 } = await import('./ztools-settings-alias-browser-fixture.mjs');
  const bytes = await readFile(CORE_GENERAL_SOURCE_PATH), current = createHash('sha256').update(bytes).digest('hex');
  const identity = { authoredFiles: { [CORE_GENERAL_SOURCE_PATH]: { bytes: bytes.length, sha256: current } } };
  assert.equal(assertParsedGeneralSourceDigest(identity, RENDERER_GENERAL_SETTINGS_SOURCE_SHA256).capturedSha256, current);
});

function openingBarrierFixture() {
  let resolveLoaded;
  const loaded = new Promise(resolve => { resolveLoaded = resolve; });
  const input = { sessionId: 'a'.repeat(32), visible: false, closed: false, generation: 0, revision: 0 };
  const session = { sessionId: input.sessionId, state: { snapshot: () => ({ ...input }) }, openedAt: undefined };
  const main = { activePhase: 'opened', pendingOpen: true, listenerState: 'listening', openFailures: 0,
    closeFailures: 0, invalidPayloads: 0, registrationErrors: 0, lateListenerUnlistens: 0, cleanupErrors: 0 };
  const rpc = { unresolved: 1, requests: [{ command: 'open_renderer_settings' }] };
  const steps = [];
  const runtime = { activeSession: session,
    async waitFor(_page, _expression, label) { steps.push(label); if (label === 'Settings loaded and open RPC acknowledged') await loaded; },
    async evaluate(_page, expression) { return expression.includes('HOST_ADAPTER') ? { ...main } : { ...rpc }; } };
  const acknowledge = () => { input.visible = true; input.generation = 1; input.revision = 2;
    session.openedAt = new Date().toISOString(); main.activePhase = 'loaded'; main.pendingOpen = false;
    rpc.unresolved = 0; resolveLoaded(); };
  return { runtime, session, main, rpc, input, steps, acknowledge };
}
test('visible menu alone cannot permit outPlugin before loaded, current SubInput and open RPC acknowledgement', async () => {
  const f = openingBarrierFixture(); let outRequested = false;
  const operation = waitForMainDropSettingsReady({}, {}, f.runtime).then(proof => { outRequested = true; return proof; });
  await Promise.resolve(); assert.equal(outRequested, false); assert.equal(f.rpc.unresolved, 1);
  f.acknowledge(); const proof = await operation;
  assert.equal(outRequested, true); assert.equal(proof.main.activePhase, 'loaded');
  assert.equal(proof.subInput.visible, true); assert.equal(proof.mainRpcUnresolved, 0);
  assert.deepEqual(f.steps, ['Settings loaded and open RPC acknowledged', 'current Child input operations settled']);
});
for (const fault of ['closed-input', 'changed-owner', 'pending-rpc']) test(`opening barrier rejects ${fault} without advancing to outPlugin`, async () => {
  const f = openingBarrierFixture(); let outRequested = false;
  const operation = waitForMainDropSettingsReady({}, {}, f.runtime).then(() => { outRequested = true; });
  f.acknowledge();
  if (fault === 'closed-input') { f.input.closed = true; f.input.visible = false; }
  if (fault === 'changed-owner') f.runtime.activeSession = { ...f.session };
  if (fault === 'pending-rpc') f.rpc.unresolved = 1;
  await assert.rejects(operation); assert.equal(outRequested, false);
});

function childRetirementDriver() {
  const calls = [], state = { url: 'http://owned/setting/index.html#/allCommands', resetPending: true, retired: false, globals: true };
  const childPage = { waitForEvent: async name => { calls.push(name); }, async send(command, args) {
    calls.push(command);
    if (command === 'Page.navigate') { state.url = args.url; state.retired = args.url === 'http://owned/retired'; state.globals = !state.retired; state.resetPending = false; }
  } };
  const runtime = { activeSession: null, lastClosedSession: { sessionId: 'old-session', closedAt: 'actual-close-time', state: { snapshot: () => ({ closed: true }) } }, childInjectionId: 'owned-injection',
    clearChildInjection() { this.childInjectionId = null; calls.push('clear-injection'); },
    async waitFor(_page, _expression, label) {
      calls.push(label);
      if (label === 'retired Child with bridge globals removed') assert.equal(state.retired && !state.globals, true);
    } };
  // Models the observed old SPA reset winning between same-document navigate and reload.
  function secondOpen() {
    const fullDocument = !state.url.startsWith('http://owned/setting/index.html');
    if (!fullDocument && state.resetPending) state.url = 'http://owned/setting/index.html#/general';
    else state.url = 'http://owned/setting/index.html#/allCommands';
    return { fullDocument, sourcesPanel: state.url.endsWith('#/allCommands'), newSession: 'new-owned-session' };
  }
  return { context: { childPage, mainPage: {}, server: { retiredUrl: 'http://owned/retired' } }, runtime, state, calls, secondOpen };
}
test('real retirement step prevents old route reset from winning the next full-document Settings open', async () => {
  const f = childRetirementDriver();
  if (process.env.ATOOLS_R77_OLD_CHILD_CLOSE === '1') {
    const before = await readFile('output/renderer-main-file-drop-r77-2026-11-02/browser/child-retirement/before/scripts/lib/ztools-main-file-drop-browser-journey.mjs', 'utf8');
    const body = before.match(/async function backToSearch\(\) \{([\s\S]*?)\n  \}/)[1];
    const close = new Function('evaluate', 'childPage', 'waitFor', 'mainPage', `return (async()=>{${body}})()`);
    await close(async () => true, f.context.childPage, f.runtime.waitFor, f.context.mainPage);
  } else await retireMainDropChild(f.context, f.runtime);
  const opened = f.secondOpen();
  assert.equal(opened.sourcesPanel, true, 'second real Settings route must remain allCommands');
  assert.equal(opened.fullDocument, true, 'new Child must start by full-document navigation');
  assert.equal(f.runtime.childInjectionId, null);
  assert.ok(f.calls.indexOf('Page.removeScriptToEvaluateOnNewDocument') < f.calls.indexOf('Page.navigate'));
});
test('unclosed session rejects retirement without touching owned document', async () => {
  const f = childRetirementDriver(); f.runtime.activeSession = { sessionId: 'still-open' };
  await assert.rejects(retireMainDropChild(f.context, f.runtime), /has not closed/);
  assert.equal(f.calls.includes('Page.navigate'), false);
});
test('failure observation preserves actual Child/Main values and explicit read errors', async () => {
  const main = { activePhase: 'opened', pendingOpen: true }, child = { hash: '#/general', readyCallCount: 1, sourcesPanel: false };
  const context = { childPage: {}, mainPage: {} }, runtime = { activeSession: { sessionId: 'actual-session' },
    evaluate: async page => page === context.childPage ? child : main };
  assert.deepEqual(await captureMainDropFailure(context, runtime), { sessionId: 'actual-session', child, main });
  runtime.evaluate = async () => { throw Error('read unavailable'); };
  assert.match((await captureMainDropFailure(context, runtime)).child.observationError, /read unavailable/);
});

test('failure probe executes against actual fixture globals and reads ready records, route markers and Main phase', async () => {
  const context = { childPage: {}, mainPage: {} };
  const readyCalls = [{ operation: 'ready', status: 'returned' }, { operation: 'read' }];
  const realms = new Map([
    [context.childPage, { location: { href: 'http://owned/setting/index.html#/general', hash: '#/general' },
      window: { __ATOOLS_SETTINGS_ALIAS_FIXTURE__: { snapshot: () => ({ calls: readyCalls }) },
        __ATOOLS_SETTINGS_INPUT_CHILD__: { snapshot: () => ({ config: { sessionId: 'actual-new' }, pendingCount: 0 }) } },
      document: { querySelector: () => null, querySelectorAll: () => [{ textContent: '常规设置', classList: { contains: () => true } }] } }],
    [context.mainPage, { window: { __ATOOLS_ZTOOLS_HOST_ADAPTER__: { snapshot: () => ({ settingsView: { activePhase: 'opened', pendingOpen: true } }) } } }],
  ]);
  const result = await captureMainDropFailure(context, { activeSession: { sessionId: 'actual-new' },
    evaluate: async (page, expression) => vm.runInNewContext(expression, realms.get(page)) });
  assert.equal(result.child.hash, '#/general'); assert.equal(result.child.readyCallCount, 1);
  assert.equal(result.child.readyCalls[0].status, 'returned'); assert.equal(result.child.config.sessionId, 'actual-new');
  assert.equal(result.child.sourcesPanel, false); assert.equal(result.child.menuItems[0].active, true);
  assert.equal(result.main.activePhase, 'opened'); assert.equal(result.main.pendingOpen, true);
});
