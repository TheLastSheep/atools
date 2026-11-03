import assert from "node:assert/strict";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { markerMatches } from "./ztools-renderer-native-runtime.mjs";
import { settingsRegistrationFinalRowsValid } from "./ztools-launch-return-settings-registration.mjs";

const FILENAMES = ["data.db", "data.db-wal", "data.db-shm"];
const ROWS_KEY = "ztools-renderer:local-shortcuts";
const REVISION_KEY = "ztools-renderer:local-shortcuts-revision";

async function privateDirectory(path) {
  const info = await lstat(path, { bigint: true });
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077n) === 0n
    && await realpath(path) === path && Number(info.uid) === process.getuid(), "SQLite owner directory is not trusted");
  return `${info.dev}:${info.ino}`;
}

async function readOwnedDatabaseFile(path, required) {
  const info = await lstat(path, { bigint: true }).catch(error => {
    if (!required && error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return null;
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1n && Number(info.uid) === process.getuid()
    && info.size <= 32n * 1024n * 1024n && await realpath(path) === path, "SQLite source is not a bounded owned regular file");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat({ bigint: true });
    assert.ok(before.isFile() && before.dev === info.dev && before.ino === info.ino && before.size === info.size,
      "SQLite source changed before reading");
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    assert.ok(before.dev === after.dev && before.ino === after.ino && before.size === after.size
      && before.mtimeNs === after.mtimeNs && BigInt(bytes.byteLength) === after.size, "SQLite source changed while reading");
    return { bytes, fingerprint: { sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength, device: String(after.dev), inode: String(after.ino), mtimeNs: String(after.mtimeNs) } };
  } finally { await handle.close(); }
}

async function captureDatabaseFiles(directory) {
  const result = [];
  for (const name of FILENAMES) {
    const file = await readOwnedDatabaseFile(join(directory, name), name === "data.db");
    result.push({ name, file });
  }
  const journal = await lstat(join(directory, "data.db-journal")).catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  assert.equal(journal, null, "SQLite source has an unfinished rollback journal");
  return result;
}

function summaries(files) {
  return files.map(({ name, file }) => ({ name, ...(file ? { exists: true, ...file.fingerprint } : { exists: false }) }));
}

/** Copies the terminal owned DB with O_NOFOLLOW, then queries only that private evidence copy. */
export async function inspectLaunchReturnSettingsSqlite({ fixtureRoot, runDirectory, runId, hostPid, marker, hostProcessTerminal }) {
  const result = { valid: false, revision: null, rows: null, integrity: null, sourceFiles: null,
    sourceStable: false, snapshotPath: null, errors: [] };
  try {
    assert.equal(hostProcessTerminal, true, "SQLite inspection requires a terminal host process");
    assert.ok(/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(runId) && fixtureRoot === `/private/tmp/atools-renderer-launch-return-${runId}`,
      "SQLite fixture root must match this run exactly");
    assert.ok(markerMatches(marker, fixtureRoot, hostPid) && marker.identifier === `dev.atools.renderer-smoke.${runId}`
      && Object.keys(marker).length === 4, "SQLite fixture owner marker does not match this run");
    const owner = await privateDirectory(fixtureRoot);
    const appData = join(fixtureRoot, "app-data");
    const dataOwner = await privateDirectory(appData);
    await privateDirectory(runDirectory);
    const before = await captureDatabaseFiles(appData);
    const snapshotDirectory = join(runDirectory, "registration-sqlite");
    await mkdir(snapshotDirectory, { mode: 0o700 });
    await privateDirectory(snapshotDirectory);
    for (const { name, file } of before) {
      if (file) await writeFile(join(snapshotDirectory, name), file.bytes, { flag: "wx", mode: 0o600 });
    }
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(snapshotDirectory, "data.db"), { readOnly: true });
    try {
      database.exec("PRAGMA query_only=ON");
      const integrity = database.prepare("PRAGMA integrity_check(1)").get();
      assert.deepEqual(Object.values(integrity), ["ok"], "SQLite evidence integrity check failed");
      result.integrity = "ok";
      const rows = database.prepare("SELECT key, value FROM settings WHERE key IN (?, ?) ORDER BY key").all(ROWS_KEY, REVISION_KEY);
      assert.equal(rows.length, 2, "SQLite evidence must contain both local-shortcut settings");
      const values = new Map(rows.map(row => [row.key, row.value]));
      assert.equal(values.get(REVISION_KEY), "8", "SQLite local-shortcut revision must be exactly 8");
      const raw = values.get(ROWS_KEY);
      assert.ok(typeof raw === "string" && Buffer.byteLength(raw) <= 512 * 1024, "SQLite local-shortcut rows exceed their bound");
      result.rows = JSON.parse(raw);
      assert.equal(settingsRegistrationFinalRowsValid(result.rows, fixtureRoot), true,
        "SQLite final rows must be exactly the two owned apps without aliases");
      result.revision = 8;
    } finally { database.close(); }
    const after = await captureDatabaseFiles(appData);
    assert.deepEqual(summaries(after), summaries(before), "SQLite source changed during independent inspection");
    assert.equal(await privateDirectory(fixtureRoot), owner, "SQLite fixture owner changed during inspection");
    assert.equal(await privateDirectory(appData), dataOwner, "SQLite app-data owner changed during inspection");
    result.sourceFiles = summaries(before);
    result.sourceStable = true;
    result.snapshotPath = relative(runDirectory, join(snapshotDirectory, "data.db")).split("\\").join("/");
    result.valid = true;
  } catch (error) {
    result.errors.push(String(error?.message || "SQLite evidence unavailable").slice(0, 300));
  }
  return result;
}
