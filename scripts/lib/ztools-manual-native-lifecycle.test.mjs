import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { boundedLog, cleanupManualOwned, runManualNativeChild } from './ztools-manual-native-lifecycle.mjs';
import { identity, manualPaths } from './ztools-manual-native-evidence.mjs';

const env = { ...process.env };
test('bounded logs preserve only the byte cap and expose truncation', () => {
  const log = boundedLog(4); log.append(Buffer.from('abc')); log.append(Buffer.from('def'));
  assert.equal(log.bytes().toString(), 'abcd');
  assert.equal(log.metadata().observedBytes, 6); assert.equal(log.metadata().truncated, true);
});
test('manual supervisor observes normal terminal exit without UI or external process control', async () => {
  let pid;
  const result = await runManualNativeChild(process.execPath, ['-e', "process.stdout.write('owned child')"],
    { env, onStarted: value => { pid = value; }, timeoutMs: 3000 });
  assert.equal(result.pid, pid); assert.equal(result.exitCode, 0); assert.equal(result.timedOut, false);
  assert.equal(result.stdout.bytes().toString(), 'owned child');
});
test('manual supervisor deadline terminates only its owned child handle', async () => {
  const result = await runManualNativeChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { env, timeoutMs: 50, graceMs: 100 });
  assert.equal(result.timedOut, true); assert.equal(result.terminalObserved, true);
  assert.ok(result.signals.some(entry => entry.signal === 'SIGTERM' && entry.accepted));
});
test('runner interruption records termination of its owned child without claiming normal exit', async () => {
  const result = await runManualNativeChild(process.execPath, ['-e', 'setInterval(()=>{},1000)'],
    { env, timeoutMs: 3000, graceMs: 100, onStarted: () => { setTimeout(() => process.emit('SIGTERM'), 40); } });
  assert.equal(result.interrupted, true); assert.equal(result.terminalObserved, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.signals.some(entry => entry.reason === 'runner-interrupt'));
});
test('cleanup preserves wrong owner and inode, then deletes only matching terminal owned resources', async t => {
  const paths = manualPaths(randomUUID().replaceAll('-', ''));
  await mkdir(paths.runDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.bundlePath, { mode: 0o700 }); await mkdir(paths.fixtureRoot, { mode: 0o700 });
  t.after(async () => { await rm(paths.runDirectory, { recursive: true, force: true });
    await rm(paths.fixtureRoot, { recursive: true, force: true }); });
  const prepared = { ...paths, runId: paths.identifier.split('.').at(-1), bundleIdentity: 'wrong-inode' };
  const markerPath = join(paths.fixtureRoot, '.atools-renderer-smoke-owner.json');
  await writeFile(markerPath, JSON.stringify({ schemaVersion: 1, root: paths.fixtureRoot, pid: process.pid + 1,
    identifier: paths.identifier }));
  const rejected = await cleanupManualOwned({ prepared, pid: process.pid, terminalObserved: true, rootCleanupAllowed: true });
  assert.match(rejected.root, /^preserved:/); assert.match(rejected.bundle, /^preserved:/);
  const marker = JSON.parse(await readFile(markerPath)); marker.pid = process.pid;
  await writeFile(markerPath, JSON.stringify(marker));
  prepared.bundleIdentity = identity(await lstat(paths.bundlePath, { bigint: true }));
  assert.deepEqual(await cleanupManualOwned({ prepared, pid: process.pid, terminalObserved: false }),
    { root: 'preserved-not-terminal', bundle: 'preserved-not-terminal' });
  const retained = await cleanupManualOwned({ prepared, pid: process.pid, terminalObserved: true });
  assert.match(retained.root, /database-not-preserved-root-retained/);
  assert.equal(retained.bundle, 'removed-owned');
  assert.ok((await lstat(paths.fixtureRoot)).isDirectory(), 'Failed DB preservation keeps the owned root');
  await mkdir(paths.bundlePath, { mode: 0o700 });
  prepared.bundleIdentity = identity(await lstat(paths.bundlePath, { bigint: true }));
  const accepted = await cleanupManualOwned({ prepared, pid: process.pid, terminalObserved: true, rootCleanupAllowed: true });
  assert.deepEqual(accepted, { root: 'removed-owned', bundle: 'removed-owned' });
});
