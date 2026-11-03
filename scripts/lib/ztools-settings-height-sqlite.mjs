import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { OWNER_MARKER_NAME } from './ztools-renderer-native-runtime.mjs';
import { heightPaths } from './ztools-settings-height-report.mjs';
import { identity, sha } from './ztools-settings-height-sources.mjs';

export async function requireAbsent(path) {
  try { await lstat(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  throw new Error(`Path already exists: ${path}`);
}

export async function privateDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 });
  const info = await lstat(path, { bigint: true });
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === BigInt(process.getuid())
    && (info.mode & 0o777n) === 0o700n && await realpath(path) === path, 'Directory is not canonical/private/owned');
  return identity(info);
}

export async function readHeightFile(path, maxBytes = 64 * 1024 * 1024, privateMode = true, allowEmpty = false) {
  assert.equal(await realpath(dirname(path)), dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.nlink === 1n && before.uid === BigInt(process.getuid())
      && before.size >= (allowEmpty ? 0n : 1n) && before.size <= BigInt(maxBytes)
      && (!privateMode || (before.mode & 0o777n) === 0o600n), 'File is not bounded/private/owned');
    const bytes = await handle.readFile(), after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    assert.ok(!pathAfter.isSymbolicLink() && identity(before) === identity(pathAfter)
      && identity(after) === identity(before) && before.size === after.size && before.mtimeNs === after.mtimeNs
      && bytes.length === Number(before.size), 'File changed while being read');
    return { path, bytes, sha256: sha(bytes), sizeBytes: bytes.length, identity: identity(before) };
  } finally { await handle.close(); }
}

export async function inspectHeightOwner(paths, pid) {
  assert.deepEqual(paths, heightPaths(paths.runId));
  assert.ok(Number.isSafeInteger(pid) && pid > 0);
  const rootIdentity = await privateDirectory(paths.root);
  const marker = await readHeightFile(join(paths.root, OWNER_MARKER_NAME), 4096);
  assert.deepEqual(JSON.parse(marker.bytes), { schemaVersion: 1, pid, identifier: paths.identifier, root: paths.root });
  assert.equal(await privateDirectory(paths.root), rootIdentity, 'Owner directory was replaced');
  return { rootIdentity, markerIdentity: marker.identity, pid, root: paths.root, identifier: paths.identifier };
}

export async function observeHeightDatabase(path) {
  const before = await readHeightFile(path);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    const integrity = db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check);
    assert.deepEqual(integrity, ['ok'], 'SQLite integrity failed');
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('settings-general');
    assert.ok(row && typeof row.value === 'string', 'General row missing');
    assert.equal((await readHeightFile(path)).sha256, before.sha256);
    return { integrity: 'ok', rawGeneral: row.value };
  } finally { db.close(); }
}

/** Terminal-only raw preservation plus a complete SQLite backup, never a live-file copy. */
export async function preserveHeightDatabase({ paths, pid, runDirectory, processTerminal, processAlive }) {
  assert.equal(processTerminal, true); assert.equal(processAlive, false);
  const owner = await inspectHeightOwner(paths, pid);
  await privateDirectory(join(paths.root, 'app-data'));
  await privateDirectory(runDirectory);
  const archive = join(runDirectory, 'sqlite-terminal'); await privateDirectory(archive, true);
  const working = join(archive, 'sqlite-work'); await privateDirectory(working, true);
  const files = [];
  for (const suffix of ['', '-wal', '-shm']) {
    let file;
    try { file = await readHeightFile(paths.database + suffix, 64 * 1024 * 1024, false, Boolean(suffix)); }
    catch (error) { if (suffix && error.code === 'ENOENT') continue; throw error; }
    const target = join(archive, `data.db${suffix}`);
    await writeFile(target, file.bytes, { flag: 'wx', mode: 0o600 });
    await writeFile(join(working, `data.db${suffix}`), file.bytes, { flag: 'wx', mode: 0o600 });
    assert.equal((await readHeightFile(target, 64 * 1024 * 1024, true, Boolean(suffix))).sha256, file.sha256);
    files.push({ path: target, sourcePath: file.path, sha256: file.sha256, bytes: file.sizeBytes, sidecar: Boolean(suffix) });
  }
  const copied = join(working, 'data.db'), checkpointPath = join(archive, 'checkpoint.sqlite');
  await requireAbsent(checkpointPath);
  const db = new DatabaseSync(copied, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON');
    assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    await backup(db, checkpointPath);
  } finally { db.close(); }
  await chmod(checkpointPath, 0o600);
  const observation = await observeHeightDatabase(checkpointPath);
  for (const file of files) {
    assert.equal((await readHeightFile(file.sourcePath, 64 * 1024 * 1024, false, file.sidecar)).sha256, file.sha256, 'Terminal source DB drifted during backup');
    assert.equal((await readHeightFile(file.path, 64 * 1024 * 1024, true, file.sidecar)).sha256, file.sha256, 'Raw preserved DB copy changed');
  }
  assert.deepEqual(await inspectHeightOwner(paths, pid), owner);
  const checkpoint = await readHeightFile(checkpointPath);
  return { owner, files, observation, checkpoint: { path: checkpoint.path, sha256: checkpoint.sha256,
    bytes: checkpoint.sizeBytes, identity: checkpoint.identity }, complete: true };
}

export async function prepareHeightSeed(previous, paths, heightCase) {
  const predecessor = { b: 'a', c: 'b', d: 'c' }[heightCase];
  assert.ok(predecessor && previous?.heightCase === predecessor && previous.passed === true);
  assert.equal(previous.process?.terminalObserved, true); assert.equal(previous.process?.timedOut, false);
  assert.equal(previous.process?.exitCode, 0); assert.equal(previous.process?.signal, null);
  assert.equal(previous.processAlive, false); assert.equal(previous.database?.complete, true);
  const path = previous.database.checkpoint.path;
  assert.equal(path, join(previous.runDirectory, 'sqlite-terminal/checkpoint.sqlite'));
  const source = await readHeightFile(path);
  assert.equal(source.sha256, previous.database.checkpoint.sha256, 'Previous checkpoint hash changed');
  assert.equal(source.identity, previous.database.checkpoint.identity, 'Previous checkpoint inode changed');
  const observed = await observeHeightDatabase(path);
  assert.deepEqual(observed, previous.database.observation);
  assert.deepEqual(paths, heightPaths(paths.runId)); await requireAbsent(paths.root); await requireAbsent(paths.seed);
  await writeFile(paths.seed, source.bytes, { flag: 'wx', mode: 0o600 });
  const seed = await readHeightFile(paths.seed);
  assert.equal(seed.sha256, source.sha256);
  return { path: paths.seed, sha256: seed.sha256, bytes: seed.sizeBytes, identity: seed.identity,
    rawBefore: observed.rawGeneral, previousRunId: previous.runId };
}

export async function cleanupHeightSeed(seed) {
  if (seed === null) return { removed: false, notRequired: true };
  assert.match(seed.path, /^\/private\/tmp\/atools-renderer-smoke-[0-9a-f]{32}\.seed\.sqlite$/);
  const current = await readHeightFile(seed.path);
  assert.equal(current.identity, seed.identity); assert.equal(current.sha256, seed.sha256);
  await unlink(seed.path); await requireAbsent(seed.path);
  return { removed: true, notRequired: false };
}
