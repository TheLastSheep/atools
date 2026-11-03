import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HEAD_FILE_TREE_CASE_ID, HEAD_FILE_TREE_COMMIT, HEAD_FILE_TREE_DIRECTORY_SHA256,
  HEAD_FILE_TREE_TREE, prepareHeadFileTreeFixture, readHeadFileTree, readHeadFileTreeProfile,
  verifyHeadFileTreeFixture } from "./lib/head-file-tree-fixture.mjs";

const repoRoot = path.resolve(process.env.ATOOLS_REPOSITORY_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const { registry, profile } = await readHeadFileTreeProfile();
assert.equal(profile.caseId, HEAD_FILE_TREE_CASE_ID);
assert.equal(registry.commit, HEAD_FILE_TREE_COMMIT);
assert.equal(registry.packageTree, HEAD_FILE_TREE_TREE);
assert.equal(profile.directorySha256, HEAD_FILE_TREE_DIRECTORY_SHA256);
assert.equal(registry.fileCount, 12);
const source = await readHeadFileTree(repoRoot);
assert.equal(source.commit, HEAD_FILE_TREE_COMMIT);
assert.equal(source.tree, HEAD_FILE_TREE_TREE);
assert.equal(source.files.size, 12);
assert.equal(JSON.parse(source.files.get("plugin.json").toString("utf8")).version, "1.0.5");

{
  const prepared = await prepareHeadFileTreeFixture({ repositoryRoot: repoRoot, temporaryParent: "/private/tmp" });
  try {
    const verified = await verifyHeadFileTreeFixture(prepared.fixture, repoRoot);
    assert.equal(verified.fixtureBytesMatchPinnedSource, true);
    assert.equal(verified.fileCount, 12);
    assert.equal(verified.expandedBytes, registry.expandedBytes);
    assert.equal(prepared.fixture.sourceRoot, `git:${HEAD_FILE_TREE_COMMIT}:ZTools-plugins/plugins/file-tree`);
    const changed = path.join(prepared.fixture.pluginRoot, "main.js");
    const original = await readFile(changed);
    await writeFile(changed, "tampered fixture copy");
    await assert.rejects(verifyHeadFileTreeFixture(prepared.fixture, repoRoot), /differs from the registered HEAD blobs/);
    await writeFile(changed, original);
    assert.equal((await verifyHeadFileTreeFixture(prepared.fixture, repoRoot)).fixtureBytesMatchPinnedSource, true);
  } finally { await prepared.cleanup(); }
}
console.log("pinned FileTree HEAD fixture read, copy, and tamper checks: PASS");
