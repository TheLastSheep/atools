import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createFixtureEnvironment } from './lib/legacy-node-environment.mjs';
import { startBookmarkNodeFixture } from './lib/main-push-bookmark-node-fixture.mjs';

const environment = await createFixtureEnvironment(), sink = join(environment.root, 'sink.jsonl'), file = join(environment.root, 'fixed.json');
await writeFile(sink, ''); await writeFile(file, '{"fixed":true}');
let fixture, passed = false;
const value = value => ({ kind: 'value', value });
const array = items => ({ kind: 'array', items: items.map(value) });
const checks = [];
try {
  fixture = await startBookmarkNodeFixture(resolve('.'), environment, sink);
  assert.equal(fixture.initialize.protocolVersion, 1);
  const fs = await fixture.rpc('require', { specifier: 'fs' });
  const read = await fixture.rpc('get', { handleId: fs.handleId, property: 'readFileSync' });
  assert.deepEqual(await fixture.rpc('call', { handleId: read.handleId, args: [value(file), value('utf8')] }), value('{"fixed":true}'));
  await assert.rejects(fixture.rpc('call', { handleId: read.handleId, args: [value('/etc/passwd'), value('utf8')] }), /MAIN_PUSH_FIXTURE_FS_DENIED/);
  checks.push('Real codec handles read only a fixed isolated file and reject host filesystem');
  const exists = await fixture.rpc('get', { handleId: fs.handleId, property: 'existsSync' });
  assert.deepEqual(await fixture.rpc('call', { handleId: exists.handleId, args: [value('/Applications/Microsoft Edge.app')] }), value(true));
  await assert.rejects(fixture.rpc('call', { handleId: exists.handleId, args: [value('/Applications/Unreviewed.app')] }), /FS_DENIED/);
  checks.push('Exactly reviewed Chrome/Edge application-existence doubles do not query system paths');
  const cp = await fixture.rpc('require', { specifier: 'child_process' });
  const spawn = await fixture.rpc('get', { handleId: cp.handleId, property: 'spawn' });
  await fixture.rpc('call', { handleId: spawn.handleId, args: [value('open'), array(['-a', '/Applications/Microsoft Edge.app', 'https://fixture.invalid/edge/1']), { kind: 'object', properties: { detached: value(true) } }] });
  await assert.rejects(fixture.rpc('call', { handleId: spawn.handleId, args: [value('sh'), array(['-c', 'echo forbidden'])] }), /SPAWN_DENIED/);
  for (const module of ['net', 'http', 'https', 'dgram', 'dns', 'worker_threads', 'vm']) await assert.rejects(fixture.rpc('require', { specifier: module }), /MODULE_DENIED/);
  const actions = (await readFile(sink, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(actions.map(action => action.type), ['application-existence-double', 'spawn-sink']);
  checks.push('Original selection launch surface records a sink and denies arbitrary spawn or networking modules');
  passed = true;
} finally {
  const cleanup = fixture ? await fixture.stop() : null;
  const isolated = await environment.cleanup();
  assert.ok(cleanup?.listenerClosed && cleanup.nodeProcessStopped && cleanup.trackedProcessGroupCleanup && isolated.isolatedEnvironmentRemoved);
  console.log(JSON.stringify({ passed, checks, cleanup: { ...cleanup, ...isolated }, scope: 'Real Node transport plus explicit filesystem/application/spawn fixture doubles; no App, native permission, GUI or original bookmark callback acceptance' }));
}
