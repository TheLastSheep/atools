import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, lstat, readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createBoundedCapture } from './ztools-renderer-native-runtime.mjs';
import { identity, manualPaths, readJson, sha } from './ztools-manual-native-evidence.mjs';

export function boundedLog(limit = 128 * 1024) {
  const capture = createBoundedCapture(limit), chunks = [];
  return { append(bytes) { const remaining = Math.max(0, limit - capture.metadata().capturedBytes);
    if (remaining > 0) chunks.push(Buffer.from(bytes).subarray(0, remaining)); capture.append(bytes); },
  bytes: () => Buffer.concat(chunks), metadata: () => capture.metadata() };
}

export async function runManualNativeChild(executable, args, { env, onStarted,
  timeoutMs = 615000, graceMs = 3000 } = {}) {
  const stdout = boundedLog(), stderr = boundedLog();
  const child = spawn(executable, args, { env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', bytes => stdout.append(bytes)); child.stderr.on('data', bytes => stderr.append(bytes));
  let timedOut = false, interrupted = false, spawnError = null, startError = null;
  const signals = [];
  let escalation;
  const terminate = reason => {
    if (reason === 'deadline') timedOut = true; else interrupted = true;
    signals.push({ signal: 'SIGTERM', accepted: child.kill('SIGTERM'), reason });
    if (!escalation) escalation = setTimeout(() => {
      signals.push({ signal: 'SIGKILL', accepted: child.kill('SIGKILL'), reason: 'supervisor-escalation' });
    }, graceMs);
  };
  const onInterrupt = () => terminate('runner-interrupt');
  process.on('SIGINT', onInterrupt); process.on('SIGTERM', onInterrupt);
  const timer = setTimeout(() => terminate('deadline'), timeoutMs);

  let started;
  child.once('spawn', () => { started = Promise.resolve().then(() => onStarted?.(child.pid))
    .catch(error => { startError = String(error); terminate('start-record-failed'); }); });
  const result = await new Promise(resolve => {
    child.once('error', error => { spawnError = String(error); });
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  clearTimeout(timer); clearTimeout(escalation);
  process.off('SIGINT', onInterrupt); process.off('SIGTERM', onInterrupt);
  await started;
  return { ...result, pid: child.pid ?? null, terminalObserved: true, timedOut, interrupted,
    spawnError, startError, signals, stdout, stderr };
}

export async function preserveManualDatabase(paths) {
  const source = join(paths.fixtureRoot, 'app-data/data.db');
  assert.equal(await realpath(paths.fixtureRoot), paths.fixtureRoot);
  assert.equal(await realpath(join(paths.fixtureRoot, 'app-data')), join(paths.fixtureRoot, 'app-data'));
  try { assert.equal(await realpath(source), source); }
  catch (error) { if (error.code === 'ENOENT') return { copied: [], observation: null, absenceConfirmed: true }; throw error; }
  const destination = join(paths.runDirectory, 'sqlite-final');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(destination, { mode: 0o700 });
  const copied = [];
  const fileHashes = [];
  for (const suffix of ['', '-wal', '-shm']) {
    try { const file = source + suffix; const info = await lstat(file);
      assert.ok(info.isFile() && !info.isSymbolicLink());
      const bytes = await readFile(file);
      const target = join(destination, 'data.db' + suffix);
      await cp(file, target, { force: false, errorOnExist: true });
      const copiedBytes = await readFile(target);
      assert.equal(sha(copiedBytes), sha(bytes), 'SQLite copy differs from terminal source');
      assert.equal(sha(await readFile(file)), sha(bytes), 'SQLite source changed while preserving');
      copied.push('data.db' + suffix); fileHashes.push({ file: 'data.db' + suffix, bytes: bytes.length, sha256: sha(bytes) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.ok(copied.includes('data.db'), 'SQLite DB disappeared during preservation');
  const python = `import sqlite3,json,sys\nc=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\nc.execute('PRAGMA query_only=ON')\nprint(json.dumps({'integrity':c.execute('PRAGMA integrity_check').fetchone()[0],'general':c.execute('SELECT value FROM settings WHERE key=?',('settings-general',)).fetchone()}))\nc.close()`;
  const child = spawn('python3', ['-c', python, join(destination, 'data.db')], { stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = boundedLog(), stderr = boundedLog();
  child.stdout.on('data', bytes => stdout.append(bytes)); child.stderr.on('data', bytes => stderr.append(bytes));
  const exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(exitCode, 0, stderr.bytes().toString());
  const observation = JSON.parse(stdout.bytes().toString());
  assert.equal(observation.integrity, 'ok', 'Preserved SQLite integrity must pass before root removal');
  return { copied, files: fileHashes, observation, absenceConfirmed: false };
}

/** Delete only terminal, exact-path, same-inode owned resources; preserve any mismatch. */
export async function cleanupManualOwned({ prepared, pid, terminalObserved, rootCleanupAllowed = false }) {
  const paths = manualPaths(prepared.runId);
  assert.equal(prepared.fixtureRoot, paths.fixtureRoot); assert.equal(prepared.bundlePath, paths.bundlePath);
  if (!terminalObserved) return { root: 'preserved-not-terminal', bundle: 'preserved-not-terminal' };
  const result = { root: 'preserved', bundle: 'preserved' };
  try {
    assert.equal(rootCleanupAllowed, true, 'database-not-preserved-root-retained');
    const rootInfo = await lstat(paths.fixtureRoot, { bigint: true });
    const markerPath = join(paths.fixtureRoot, '.atools-renderer-smoke-owner.json');
    const markerInfo = await lstat(markerPath, { bigint: true });
    assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink());
    assert.ok(markerInfo.isFile() && !markerInfo.isSymbolicLink());
    assert.equal(await realpath(paths.fixtureRoot), paths.fixtureRoot);
    const marker = await readJson(markerPath);
    assert.deepEqual({ schemaVersion: marker.schemaVersion, root: marker.root, pid: marker.pid, identifier: marker.identifier },
      { schemaVersion: 1, root: paths.fixtureRoot, pid, identifier: paths.identifier });
    assert.equal(identity(await lstat(paths.fixtureRoot, { bigint: true })), identity(rootInfo));
    assert.equal(identity(await lstat(markerPath, { bigint: true })), identity(markerInfo));
    await rm(paths.fixtureRoot, { recursive: true }); result.root = 'removed-owned';
  } catch (error) { result.root = error.code === 'ENOENT' ? 'absent' : `preserved:${error.message}`; }
  try {
    const info = await lstat(paths.bundlePath, { bigint: true });
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.equal(identity(info), prepared.bundleIdentity);
    assert.equal(await realpath(paths.bundlePath), paths.bundlePath);
    await rm(paths.bundlePath, { recursive: true }); result.bundle = 'removed-owned';
  } catch (error) { result.bundle = error.code === 'ENOENT' ? 'absent' : `preserved:${error.message}`; }
  return result;
}
