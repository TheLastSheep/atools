import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { OWNER_MARKER_NAME, cleanupOwnedFixtureRoot } from './ztools-renderer-native-runtime.mjs';
import { A_RAW, heightPaths } from './ztools-settings-height-report.mjs';
import { inspectHeightOwner, prepareHeightSeed, preserveHeightDatabase, readHeightFile } from './ztools-settings-height-sqlite.mjs';

async function fixture() {
  const paths = heightPaths(randomUUID().replaceAll('-', ''));
  await mkdir(paths.root, { mode: 0o700 }); await mkdir(join(paths.root, 'app-data'), { mode: 0o700 });
  const marker = { schemaVersion: 1, pid: process.pid, identifier: paths.identifier, root: paths.root };
  await writeFile(join(paths.root, OWNER_MARKER_NAME), JSON.stringify(marker), { mode: 0o600, flag: 'wx' });
  const db = new DatabaseSync(paths.database); db.exec('PRAGMA journal_mode=WAL; CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const raw = JSON.stringify({ ...JSON.parse(A_RAW), windowDefaultHeight: 200.5 });
  db.prepare('INSERT INTO settings VALUES (?,?)').run('settings-general', raw); db.close();
  const runDirectory = `${paths.root}.evidence`; await mkdir(runDirectory, { mode: 0o700 });
  return { paths, marker, runDirectory, raw, async close() {
    for (const path of [paths.root, paths.root + '.replaced', runDirectory, paths.seed]) await rm(path, { recursive: true, force: true });
  } };
}

test('terminal-only preservation keeps raw unknown fields and produces an integrity-checked next seed', async () => {
  const f = await fixture(), next = heightPaths(randomUUID().replaceAll('-', ''));
  try {
    await assert.rejects(() => preserveHeightDatabase({ paths: f.paths, pid: process.pid, runDirectory: f.runDirectory, processTerminal: false, processAlive: true }));
    const database = await preserveHeightDatabase({ paths: f.paths, pid: process.pid, runDirectory: f.runDirectory, processTerminal: true, processAlive: false });
    assert.equal(database.complete, true); assert.equal(database.observation.rawGeneral, f.raw);
    const previous = { passed: true, heightCase: 'a', runId: f.paths.runId, runDirectory: f.runDirectory,
      process: { terminalObserved: true, timedOut: false, exitCode: 0, signal: null }, processAlive: false, database };
    const seed = await prepareHeightSeed(previous, next, 'b');
    assert.equal(seed.sha256, database.checkpoint.sha256); assert.equal(seed.rawBefore, f.raw);
    assert.equal(Number((await lstat(seed.path)).mode & 0o777), 0o600);
    await rm(next.seed);
    for (const mutation of [p => { p.process.terminalObserved = false; }, p => { p.processAlive = true; }, p => { p.passed = false; }, p => { p.heightCase = 'c'; }, p => { p.database.checkpoint.sha256 = 'a'.repeat(64); }]) {
      const copy = structuredClone(previous); mutation(copy);
      await assert.rejects(() => prepareHeightSeed(copy, next, 'b'));
    }
  } finally { await rm(next.seed, { force: true }); await f.close(); }
});

test('same marker content in a replaced root inode cannot authorize deletion', async () => {
  const f = await fixture();
  try {
    const pin = await inspectHeightOwner(f.paths, process.pid);
    await rename(f.paths.root, f.paths.root + '.replaced'); await mkdir(f.paths.root, { mode: 0o700 });
    await writeFile(join(f.paths.root, OWNER_MARKER_NAME), JSON.stringify(f.marker), { mode: 0o600 });
    const result = await cleanupOwnedFixtureRoot({ root: f.paths.root, childPid: process.pid, processTerminal: true,
      expectedRootIdentity: pin.rootIdentity, expectedMarkerIdentity: pin.markerIdentity });
    assert.equal(result.reason, 'root_identity_changed'); assert.equal(result.rootAbsent, false);
    assert.ok((await lstat(f.paths.root)).isDirectory());
  } finally { await f.close(); }
});

test('same-content marker replacement is rejected, while omitted pins retain the legacy cleanup flow', async () => {
  const f = await fixture();
  try {
    const pin = await inspectHeightOwner(f.paths, process.pid), path = join(f.paths.root, OWNER_MARKER_NAME);
    await rename(path, path + '.old'); await writeFile(path, JSON.stringify(f.marker), { mode: 0o600 });
    const result = await cleanupOwnedFixtureRoot({ root: f.paths.root, childPid: process.pid, processTerminal: true,
      expectedRootIdentity: pin.rootIdentity, expectedMarkerIdentity: pin.markerIdentity });
    assert.equal(result.reason, 'marker_identity_changed');
    assert.equal((await cleanupOwnedFixtureRoot({ root: f.paths.root, childPid: process.pid, processTerminal: true })).rootAbsent, true);
  } finally { await f.close(); }
});

test('private file guard rejects symlinks/mode drift and corrupt databases cannot be called complete', async () => {
  const f = await fixture();
  try {
    const marker = join(f.paths.root, OWNER_MARKER_NAME); await chmod(marker, 0o644);
    await assert.rejects(() => readHeightFile(marker)); await chmod(marker, 0o600);
    const link = join(f.paths.root, 'marker-link'); await symlink(marker, link);
    await assert.rejects(() => readHeightFile(link));
    await writeFile(f.paths.database, 'not SQLite');
    await assert.rejects(() => preserveHeightDatabase({ paths: f.paths, pid: process.pid, runDirectory: f.runDirectory, processTerminal: true, processAlive: false }));
    assert.ok((await lstat(f.paths.root)).isDirectory());
  } finally { await f.close(); }
});
