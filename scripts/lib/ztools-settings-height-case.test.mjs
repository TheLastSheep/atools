import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmod, copyFile, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assertHeightProcessTerminal, buildHeightCaseArgs, launchHeightChild, runHeightCase } from './ztools-settings-height-case.mjs';
import { A_RAW, heightPaths } from './ztools-settings-height-report.mjs';
import { heightReportFixture, TEST_MAIN_SHA, TEST_SETTINGS_SHA } from './ztools-settings-height-fixtures.mjs';
import { identity, sha } from './ztools-settings-height-sources.mjs';
import { readHeightFile } from './ztools-settings-height-sqlite.mjs';
import { OWNER_MARKER_NAME } from './ztools-renderer-native-runtime.mjs';

async function simulation(heightCase = 'a', fault = null, previous = null) {
  const runId = randomUUID().replaceAll('-', ''), paths = heightPaths(runId), runDirectory = `${paths.root}.test-output`;
  await mkdir(runDirectory, { mode: 0o700 });
  const binary = join(runDirectory, 'inert-test-file'); await writeFile(binary, 'NOT AN APP\n', { mode: 0o700 });
  const pid = 12345678 + 'abcd'.indexOf(heightCase);
  const options = { runId, paths, heightCase, runDirectory, rendererDist: '/fixed/formal-main',
    executable: { path: binary, sha256: sha(await readFile(binary)) }, mainProvenanceSha256: TEST_MAIN_SHA,
    settingsSnapshot: { bundle: { provenanceSha256: TEST_SETTINGS_SHA } }, previous,
    checkSources: async phase => { if (fault === `source-${phase}`) throw new Error('source drift'); },
    dependencies: {
      async stage() {
        const bundlePath = join(runDirectory, 'case-never.app'); await mkdir(bundlePath, { mode: 0o700 });
        const executable = join(bundlePath, 'inert-copy'); await copyFile(binary, executable); await chmod(executable, 0o700);
        return { bundlePath, runDirectory, executable, identifier: paths.identifier,
          ownerIdentity: identity(await lstat(bundlePath, { bigint: true })), settingsBundle: { provenanceSha256: TEST_SETTINGS_SHA } };
      },
      async launch() {
        await mkdir(paths.root, { mode: 0o700 }); await mkdir(join(paths.root, 'app-data'), { mode: 0o700 });
        await writeFile(join(paths.root, OWNER_MARKER_NAME), JSON.stringify({ schemaVersion: 1,
          pid: fault === 'owner' ? pid + 1 : pid, identifier: paths.identifier, root: paths.root }), { flag: 'wx', mode: 0o600 });
        if (heightCase !== 'a') await copyFile(paths.seed, paths.database);
        const db = new DatabaseSync(paths.database);
        let rawBefore;
        if (heightCase === 'a') { db.exec('CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)'); db.prepare('INSERT INTO settings VALUES (?,?)').run('settings-general', A_RAW); }
        rawBefore = db.prepare('SELECT value FROM settings WHERE key=?').get('settings-general').value;
        const seed = heightCase === 'a' ? null : await readHeightFile(paths.seed);
        const { report } = heightReportFixture(runId, heightCase, seed ? { path: paths.seed, sha256: seed.sha256, bytes: seed.sizeBytes } : null, rawBefore);
        report.pid = pid;
        db.prepare('UPDATE settings SET value=? WHERE key=?').run(report.rawGeneral.after, 'settings-general'); db.close();
        if (fault === 'corrupt-db') await writeFile(paths.database, 'not SQLite');
        if (fault === 'unfinished') report.stagesCompleted.pop();
        if (fault === 'geometry') report.openings[0].child.sizePhysical.height = 1200;
        if (fault !== 'missing-report') await writeFile(paths.output, JSON.stringify(report), { flag: 'wx', mode: 0o600 });
        return { spawned: true, pid, exitCode: fault === 'nonzero' || fault === 'post-write175' ? 7 : 0, signal: null,
          terminalObserved: fault !== 'nonterminal', timedOut: fault === 'timeout', exception: null,
          supervisorDeadlineMs: 180000, supervisorElapsedMs: fault === 'wallclock' ? 180001 : 10 };
      }, alive: () => fault === 'alive',
    } };
  return { options, paths, async dispose() {
    for (const path of [paths.root, paths.seed, runDirectory]) await rm(path, { recursive: true, force: true });
  } };
}

test('simulated four-process chain uses distinct roots and terminal SQLite copies, no executable is run', async () => {
  const fixtures = [];
  try {
    let previous = null;
    for (const name of ['a', 'b', 'c', 'd']) {
      const f = await simulation(name, null, previous); fixtures.push(f);
      const result = await runHeightCase(f.options);
      assert.equal(result.passed, true, JSON.stringify(result.errors));
      if (previous) assert.equal(result.seed.rawBefore, previous.database.observation.rawGeneral);
      assert.equal(result.cleanup.root.rootAbsent, true); assert.equal(result.cleanup.bundle.bundleAbsent, true);
      previous = result;
    }
    assert.equal(new Set(fixtures.map(f => f.paths.root)).size, 4);
  } finally { for (const f of fixtures) await f.dispose(); }
});

for (const fault of ['owner', 'missing-report', 'nonzero', 'post-write175', 'timeout', 'wallclock', 'nonterminal', 'alive', 'unfinished', 'geometry', 'corrupt-db', 'source-after']) {
  test(`fails and preserves evidence/root on ${fault}`, async () => {
    const f = await simulation('a', fault);
    try {
      const result = await runHeightCase(f.options);
      assert.equal(result.passed, false); assert.equal(result.cleanup.allowed, false);
      assert.ok((await lstat(f.paths.root)).isDirectory());
      assert.ok(result.errors.length > 0);
      if (fault === 'post-write175' || fault === 'wallclock') {
        const raw = JSON.parse(await readFile(f.paths.output, 'utf8'));
        assert.equal(raw.status, 'passed'); assert.ok(raw.elapsedMs < 175000);
        assert.equal(result.cleanup.root, null, 'Prewritten passed JSON must not authorize cleanup');
      }
    } finally { await f.dispose(); }
  });
}

test('source drift before launch cannot create a native root', async () => {
  const f = await simulation('a', 'source-before');
  try {
    const result = await runHeightCase(f.options);
    assert.equal(result.passed, false); assert.equal(result.process, null);
    await assert.rejects(() => lstat(f.paths.root), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('only a closed journey/case argv can be built; terminal flag cannot conceal a live PID', () => {
  const paths = heightPaths(randomUUID().replaceAll('-', ''));
  const args = buildHeightCaseArgs(paths, '/formal/main', 'a');
  assert.deepEqual(args.slice(-4), ['--journey', 'settings-height', '--height-case', 'a']);
  assert.throws(() => buildHeightCaseArgs(paths, '/formal/main', 'eval'));
  assert.throws(() => assertHeightProcessTerminal({ spawned: true, terminalObserved: true, exitCode: 0,
    signal: null, pid: 1234, timedOut: false, exception: null }, true));
});

class FakeHeightChild extends EventEmitter {
  pid = 12345678;
  stdout = new PassThrough(); stderr = new PassThrough(); signals = [];
  kill(signal) { this.signals.push(signal); if (signal === 'SIGKILL') queueMicrotask(() => this.emit('close', null, signal)); return true; }
}

test('owned child supervisor times out, escalates and retains bounded raw logs without starting a process', async () => {
  const directory = `/private/tmp/atools-height-supervisor-${randomUUID()}`; await mkdir(directory, { mode: 0o700 });
  const child = new FakeHeightChild(), signalSource = new EventEmitter();
  try {
    const result = await launchHeightChild('/fixed/inert-executable', ['--journey', 'settings-height'], directory, {
      signalSource, timeoutMs: 5, termGraceMs: 1, killGraceMs: 10,
      spawnImpl() { queueMicrotask(() => { child.emit('spawn'); child.stdout.write(Buffer.alloc(70000, 65)); }); return child; },
    });
    assert.equal(result.timedOut, true); assert.equal(result.terminalObserved, true);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal((await readFile(join(directory, 'stdout.log'))).length, 65536);
    assert.equal(result.stdout.truncated, true); assert.equal(signalSource.listenerCount('SIGINT'), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('interruption kills only the live owned handle and is always a failed acceptance', async () => {
  const directory = `/private/tmp/atools-height-supervisor-${randomUUID()}`; await mkdir(directory, { mode: 0o700 });
  const child = new FakeHeightChild(), signalSource = new EventEmitter();
  try {
    const result = await launchHeightChild('/fixed/inert-executable', [], directory, { signalSource,
      timeoutMs: 100, interruptGraceMs: 1,
      spawnImpl() { queueMicrotask(() => { child.emit('spawn'); signalSource.emit('SIGINT'); }); return child; },
    });
    assert.equal(result.interrupted, true); assert.equal(result.terminalObserved, true);
    assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
    assert.throws(() => assertHeightProcessTerminal(result, false));
    assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed PID receipt cannot be hidden by a fast successful close', async () => {
  const directory = `/private/tmp/atools-height-supervisor-${randomUUID()}`; await mkdir(directory, { mode: 0o700 });
  await writeFile(join(directory, 'started.json'), '{}', { mode: 0o600 });
  const child = new FakeHeightChild();
  try {
    const result = await launchHeightChild('/fixed/inert-executable', [], directory, { signalSource: new EventEmitter(),
      spawnImpl() { queueMicrotask(() => { child.emit('spawn'); child.emit('close', 0, null); }); return child; },
    });
    assert.equal(result.exitCode, 0); assert.equal(result.startRecordFailed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
