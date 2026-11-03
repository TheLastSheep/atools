import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEAD_CASE_ID, HEAD_COMMIT, HEAD_TREE, prepareHeadCalculationPaperFixture,
  readHeadCalculationPaper, verifyHeadCalculationPaperFixture } from "./lib/head-calculation-paper-fixture.mjs";
import { readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";


const repoRoot = path.resolve(process.env.ATOOLS_REPOSITORY_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const profile = await readPublishedPluginProfile(HEAD_CASE_ID);
assert.equal(profile.title, "计算稿纸");
assert.equal(profile.sourceCommit, HEAD_COMMIT);
assert.equal(profile.sourceTree, HEAD_TREE);
assert.equal(profile.fileCount, 8);
const source = readHeadCalculationPaper(repoRoot);
assert.equal(source.commit, HEAD_COMMIT);
assert.equal(source.tree, HEAD_TREE);
assert.equal(source.witness.directorySha256, profile.directorySha256);
assert.equal(source.files.size, 8);
assert.equal(JSON.parse(source.files.get("plugin.json").toString("utf8")).version, "1.4.2");

const prepared = await prepareHeadCalculationPaperFixture(profile, { repositoryRoot: repoRoot });
try {
  assert.equal(prepared.fixture.directorySha256, profile.directorySha256);
  assert.equal(prepared.review.fixture.sourceRevision.commit, HEAD_COMMIT);
  const { verification, files } = await verifyHeadCalculationPaperFixture(prepared.fixture, profile, { repositoryRoot: repoRoot });
  assert.equal(verification.sourceBytesUnchanged, true);
  assert.equal(verification.pluginCodeExecutedByVerification, false);
  assert.equal(files.get("plugin.json").length, 1778);
  assert.equal(files.get("index.js").length, 1025290);
  const changed = path.join(prepared.fixture.pluginRoot, "index.html");
  await writeFile(changed, "tampered");
  await assert.rejects(verifyHeadCalculationPaperFixture(prepared.fixture, profile, { repositoryRoot: repoRoot }), /differ from the registered HEAD blobs/);
} finally { await prepared.cleanup(); }

const wrongRevision = { ...profile, sourceCommit: "0".repeat(40) };
await assert.rejects(prepareHeadCalculationPaperFixture(wrongRevision, { repositoryRoot: repoRoot }), /not the exact registered revision/);
console.log("head Calculation Paper immutable source fixture: PASS");
