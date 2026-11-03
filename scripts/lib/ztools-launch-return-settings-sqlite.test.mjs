import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { makeLaunchReturnSettingsRegistrationFixture } from "./ztools-launch-return-settings-fixtures.mjs";
import { inspectLaunchReturnSettingsSqlite } from "./ztools-launch-return-settings-sqlite.mjs";

async function fixture(t, { revision = "8", rowsMutation = null } = {}) {
  const runId = randomUUID().replaceAll("-", "");
  const fixtureRoot = `/private/tmp/atools-renderer-launch-return-${runId}`;
  const runDirectory = await mkdtemp("/private/tmp/atools-r68-sqlite-test-");
  await mkdir(fixtureRoot, { mode: 0o700 });
  await mkdir(join(fixtureRoot, "app-data"), { mode: 0o700 });
  t.after(async () => {
    await rm(fixtureRoot, { recursive: true, force: false });
    await rm(runDirectory, { recursive: true, force: false });
  });
  const { registrationSqlite } = makeLaunchReturnSettingsRegistrationFixture(fixtureRoot);
  const rows = registrationSqlite.rows;
  if (rowsMutation) rowsMutation(rows);
  const databasePath = join(fixtureRoot, "app-data/data.db");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = database.prepare("INSERT INTO settings(key,value) VALUES (?,?)");
    insert.run("ztools-renderer:local-shortcuts", JSON.stringify(rows));
    insert.run("ztools-renderer:local-shortcuts-revision", revision);
  } finally { database.close(); }
  const hostPid = 91234;
  return { fixtureRoot, runDirectory, runId, hostPid, databasePath, rows,
    marker: { schemaVersion: 1, pid: hostPid, identifier: `dev.atools.renderer-smoke.${runId}`, root: fixtureRoot },
    hostProcessTerminal: true };
}

test("independently queries a bounded NoFollow snapshot of the terminal owned SQLite database", async t => {
  const sample = await fixture(t);
  const before = createHash("sha256").update(await readFile(sample.databasePath)).digest("hex");
  const report = await inspectLaunchReturnSettingsSqlite(sample);
  assert.equal(report.valid, true, JSON.stringify(report.errors));
  assert.equal(report.revision, 8);
  assert.deepEqual(report.rows, sample.rows);
  assert.equal(report.integrity, "ok");
  assert.equal(report.sourceStable, true);
  assert.equal(report.snapshotPath, "registration-sqlite/data.db");
  assert.equal(createHash("sha256").update(await readFile(sample.databasePath)).digest("hex"), before);
  assert.notEqual((await lstat(sample.databasePath)).ino,
    (await lstat(join(sample.runDirectory, report.snapshotPath))).ino, "query uses an independent copy");
});

test("rejects wrong revisions, extra roles, aliases and altered owned app identities", async t => {
  for (const options of [
    { revision: "9" }, { revision: "08" },
    { rowsMutation: rows => { rows[0].alias = ""; } },
    { rowsMutation: rows => { rows[0].path = "/Applications/Safari.app"; } },
    { rowsMutation: rows => { rows[1].id = rows[0].id; } },
    { rowsMutation: rows => { rows[0].addedAt = Number.MAX_SAFE_INTEGER + 1; } },
    { rowsMutation: rows => { rows.push({ ...rows[0], type: "file" }); } },
  ]) {
    const sample = await fixture(t, options);
    assert.equal((await inspectLaunchReturnSettingsSqlite(sample)).valid, false);
  }
});

test("does not inspect unowned, live, symlinked or preexisting evidence targets", async t => {
  for (const mutate of [
    sample => { sample.hostProcessTerminal = false; },
    sample => { sample.marker.pid += 1; },
    sample => { sample.marker.extra = true; },
    sample => { sample.fixtureRoot += "/other"; },
  ]) {
    const sample = await fixture(t); mutate(sample);
    assert.equal((await inspectLaunchReturnSettingsSqlite(sample)).valid, false);
  }
  const linked = await fixture(t);
  const target = join(linked.runDirectory, "not-a-database");
  await writeFile(target, "untouched"); await unlink(linked.databasePath); await symlink(target, linked.databasePath);
  assert.equal((await inspectLaunchReturnSettingsSqlite(linked)).valid, false);
  assert.equal(await readFile(target, "utf8"), "untouched");
  const collided = await fixture(t);
  await mkdir(join(collided.runDirectory, "registration-sqlite"));
  await writeFile(join(collided.runDirectory, "registration-sqlite/sentinel"), "keep");
  assert.equal((await inspectLaunchReturnSettingsSqlite(collided)).valid, false);
  assert.equal(await readFile(join(collided.runDirectory, "registration-sqlite/sentinel"), "utf8"), "keep");
});
