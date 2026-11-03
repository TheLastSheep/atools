import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";
import { MYBATIS_HEAD_CASE_ID, MYBATIS_HEAD_COMMIT, MYBATIS_HEAD_TREE,
  prepareHeadMybatisFixture, readHeadMybatisPackage, verifyHeadMybatisFixture } from "./lib/head-mybatis-fixture.mjs";

const profile = await readPublishedPluginProfile(MYBATIS_HEAD_CASE_ID);
assert.equal(profile.sourceCommit, MYBATIS_HEAD_COMMIT);
assert.equal(profile.sourceTree, MYBATIS_HEAD_TREE);
assert.equal(profile.fileCount, 5);
assert.equal(profile.runtime, "web");
const source = readHeadMybatisPackage();
assert.equal(source.commit, MYBATIS_HEAD_COMMIT);
assert.equal(source.tree, MYBATIS_HEAD_TREE);
assert.equal(source.files.size, 5);
const preload = source.files.get("preload.js").toString("utf8");
assert.match(preload, /window\.services\s*=/);
assert.doesNotMatch(preload, /\brequire\s*\(|\bnode:|\bchild_process\b|\bprocess\s*\.|ipcRenderer|require\s*\(\s*["']electron["']/);
const headManifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
assert.equal(headManifest.name, profile.id);
assert.equal(headManifest.version, "1.0.0");
assert.equal(headManifest.main, "index.html");
assert.equal(headManifest.preload, "preload.js");
assert.deepEqual(headManifest.features[0].cmds, ["sql", "mybatis", "sql格式化", "sql日志", "SQL日志格式化",
  { type: "over", label: "MyBatis SQL 日志格式化", minLength: 10, maxLength: 50000 }]);

const prepared = await prepareHeadMybatisFixture(profile, { temporaryParent: "/private/tmp" });
try {
  const result = await verifyHeadMybatisFixture(prepared.fixture, profile);
  assert.equal(result.verification.sourceBytesUnchanged, true);
  assert.equal(result.verification.fixtureBytesMatchPinnedSource, true);
  assert.equal(result.verification.pluginCodeExecutedByVerification, false);
  await writeFile(`${prepared.fixture.pluginRoot}/index.html`, "tampered");
  await assert.rejects(verifyHeadMybatisFixture(prepared.fixture, profile), /differs from the registered HEAD blobs/);
} finally { await prepared.cleanup(); }
const wrongCommit = { ...profile, sourceCommit: "0".repeat(40) };
await assert.rejects(prepareHeadMybatisFixture(wrongCommit, { temporaryParent: "/private/tmp" }), /not the exact registered HEAD revision/);
console.log("MyBatis SQL Formatter exact HEAD source fixture: PASS");
