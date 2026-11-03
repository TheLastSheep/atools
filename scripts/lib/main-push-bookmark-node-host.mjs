import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFixtureEnvironment } from './legacy-node-environment.mjs';
import { startBookmarkNodeFixture } from './main-push-bookmark-node-fixture.mjs';

function browserClient() {
  let sequence = 0; const pending = new Map();
  window.__mainPushNodeHostDeliver = response => {
    const item = pending.get(response.id); if (!item) return; pending.delete(response.id); clearTimeout(item.timer);
    if (response.error) item.reject(Error(response.error)); else item.resolve(response.result);
  };
  window.__mainPushNodeHostRequest = (command, args) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(Error('MainPush Node host request timeout')); }, 12000);
    pending.set(id, { resolve, reject, timer }); window.__mainPushNodeHostCall(JSON.stringify({ id, command, args }));
  });
}

export async function createMainPushBookmarkNodeHost(page, root, report) {
  const environment = await createFixtureEnvironment();
  const appData = join(environment.root, 'appdata'), sink = join(environment.root, 'recorded-actions.jsonl');
  await writeFile(sink, '');
  for (const [browser, folder, count] of [['Chrome', 'Google/Chrome', 4], ['Edge', 'Microsoft Edge', 4]]) {
    const directory = join(appData, folder, 'Default'); await mkdir(directory, { recursive: true });
    const children = Array.from({ length: count }, (_, index) => ({ type: 'url', date_added: String((browser === 'Chrome' ? 0 : 4) + index),
      name: `Fixed ${browser} ${index + 1}`, url: `https://fixture.invalid/${browser.toLowerCase()}/${index + 1}` }));
    await writeFile(join(directory, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { children }, other: { children: [] }, synced: { children: [] } } }));
  }
  const owners = new Map(), sessions = new Map(), openings = new Map(), operations = new Set(), stops = new Map(), endpoints = new Set();
  let closing = false;
  const evidence = report.nodeHost = { runtime: 'Real current Node codec/bootstrap and browser CJS prefetch; system Node',
    nativeAuthorization: 'Explicit fixture service double; no Rust permissions, TaskRun or native acceptance',
    isolation: environment.evidence, filesystem: 'Only fixed private fixture root; Chrome/Edge application existence is fixture true, never host filesystem',
    sideEffects: 'Fixed child_process open sink only; no subprocess, actual browser, clipboard or external networking',
    fixtureBookmarks: 8, calls: [], opened: [], stops: [], errors: [] };
  async function stop(owner, fixture) {
    if (stops.has(owner)) return stops.get(owner);
    const operation = (async () => { const cleanup = await fixture.stop(); evidence.stops.push({ owner, stats: structuredClone(fixture.stats), cleanup });
      assert.ok(cleanup.listenerClosed && cleanup.nodeProcessStopped && cleanup.trackedProcessGroupCleanup);
      owners.delete(owner); for (const [id, session] of sessions) if (session.owner === owner) sessions.delete(id);
    })(); stops.set(owner, operation); return operation;
  }
  async function request(command, args = {}) {
    evidence.calls.push({ command, ...(command === 'get_legacy_node_session' ? { sessionId: args.sessionId } : { args }) });
    if (command === 'fixture_config') return { appData, home: environment.env.HOME };
    if (command === 'get_legacy_node_session') { const entry = sessions.get(args.sessionId); assert.ok(entry && !closing); return { endpoint: entry.fixture.endpoint }; }
    assert.equal(args.pluginId, 'bookmarks'); assert.match(args.instanceId || '', /^[a-f0-9-]{36}$/); assert.equal(args.selectedPreload, undefined);
    if (command === 'prepare_legacy_node') {
      assert.equal(closing || owners.has(args.instanceId) || openings.has(args.instanceId), false);
      const opening = startBookmarkNodeFixture(root, environment, sink); openings.set(args.instanceId, opening);
      let fixture; try { fixture = await opening; } finally { openings.delete(args.instanceId); }
      owners.set(args.instanceId, fixture); const sessionId = randomUUID();
      sessions.set(sessionId, { owner: args.instanceId, fixture }); endpoints.add(fixture.endpoint);
      evidence.opened.push({ owner: args.instanceId, initialize: fixture.initialize, endpointOrigin: new URL(fixture.endpoint).origin });
      if (closing) { await stop(args.instanceId, fixture); throw Error('Fixture closed during Node prepare'); }
      return { sessionId };
    }
    assert.equal(command, 'close_legacy_node');
    if (openings.has(args.instanceId)) await openings.get(args.instanceId);
    if (owners.has(args.instanceId)) await stop(args.instanceId, owners.get(args.instanceId));
    return null;
  }
  page.on('Runtime.bindingCalled', event => {
    if (event.name !== '__mainPushNodeHostCall') return;
    const operation = (async () => {
      try {
        const input = JSON.parse(event.payload); assert.ok(Number.isSafeInteger(input.id)); let response;
        try { response = { id: input.id, result: await request(input.command, input.args) }; }
        catch (error) { response = { id: input.id, error: error.message }; }
        await page.send('Runtime.evaluate', { contextId: event.executionContextId, expression: `window.__mainPushNodeHostDeliver(${JSON.stringify(response)})` });
      } catch (error) { evidence.errors.push(error.message); }
    })(); operations.add(operation); void operation.finally(() => operations.delete(operation));
  });
  await page.send('Runtime.addBinding', { name: '__mainPushNodeHostCall' });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${browserClient.toString()})();` });
  return { endpoints, request, async sinks() { return (await readFile(sink, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); }, async close() {
    closing = true; await Promise.all([...operations]); await Promise.allSettled([...openings.values()]);
    for (const [owner, fixture] of [...owners]) await stop(owner, fixture);
    await Promise.all([...stops.values()]); const actions = await this.sinks(); const cleaned = await environment.cleanup();
    assert.deepEqual(evidence.errors, []);
    return { activeOwners: owners.size, activeSessions: sessions.size, pendingOperations: operations.size, actions, ...cleaned };
  } };
}
