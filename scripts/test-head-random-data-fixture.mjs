import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";
import { RANDOM_DATA_HEAD_CASE_ID, RANDOM_DATA_HEAD_COMMIT, RANDOM_DATA_HEAD_TREE,
  prepareHeadRandomDataFixture, readHeadRandomDataPackage, verifyHeadRandomDataFixture } from "./lib/head-random-data-fixture.mjs";

const profile = await readPublishedPluginProfile(RANDOM_DATA_HEAD_CASE_ID);
assert.equal(profile.sourceCommit, RANDOM_DATA_HEAD_COMMIT);
assert.equal(profile.sourceTree, RANDOM_DATA_HEAD_TREE);
assert.equal(profile.directorySha256, "6c62e8d69ff009636fe948694554722556799b4c5721dc865caf637bbaf02c95");
assert.equal(profile.fileCount, 7);
assert.equal(profile.runtime, "web");
assert.equal(profile.dataAccess, true);
assert.equal(profile.verifyDataPersistence, true);

const source = readHeadRandomDataPackage();
assert.equal(source.commit, RANDOM_DATA_HEAD_COMMIT);
assert.equal(source.tree, RANDOM_DATA_HEAD_TREE);
assert.equal(source.files.size, 7);
const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
assert.equal(manifest.name, profile.id);
assert.equal(manifest.version, profile.version);
assert.equal(manifest.main, "index.html");
assert.equal(manifest.preload, "preload.js");
assert.equal(manifest.features.length, 1);
assert.equal(manifest.features[0].code, "randomDataSettings");
assert.deepEqual(manifest.features[0].cmds, ["随机数据设置", "数据指令设置", "rdsetting"]);
const preload = source.files.get("preload.js").toString("utf8");
assert.match(preload, /dbStorage\.getItem\(SETTINGS_STORAGE_KEY\)/);
assert.match(preload, /dbStorage\.setItem\(SETTINGS_STORAGE_KEY, settings\)/);
assert.match(preload, /window\.ztools\.setFeature/);
assert.match(preload, /window\.ztools\.removeFeature/);
assert.doesNotMatch(preload, /\brequire\s*\(|\bnode:|\bchild_process\b|\bprocess\s*\.|ipcRenderer|require\s*\(\s*["']electron["']/);

const prepared = await prepareHeadRandomDataFixture(profile, { temporaryParent: "/private/tmp" });
try {
  const result = await verifyHeadRandomDataFixture(prepared.fixture, profile);
  assert.equal(result.verification.sourceBytesUnchanged, true);
  assert.equal(result.verification.fixtureBytesMatchPinnedSource, true);
  assert.equal(result.verification.pluginCodeExecutedByVerification, false);
  await writeFile(`${prepared.fixture.pluginRoot}/logo.svg`, "tampered");
  await assert.rejects(verifyHeadRandomDataFixture(prepared.fixture, profile), /differs from the registered HEAD blobs/);
} finally { await prepared.cleanup(); }

await assert.rejects(prepareHeadRandomDataFixture({ ...profile, sourceTree: "0".repeat(40) }, { temporaryParent: "/private/tmp" }),
  /not the exact registered HEAD revision/);
console.log("Random Data exact HEAD source fixture: PASS");
