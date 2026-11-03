import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { readPublishedPluginProfile } from "./lib/published-plugin-profile.mjs";
import { IMAGE_STITCH_HEAD_CASE_ID, IMAGE_STITCH_HEAD_COMMIT, IMAGE_STITCH_HEAD_TREE,
  prepareHeadImageStitchFixture, readHeadImageStitchPackage, verifyHeadImageStitchFixture } from "./lib/head-image-stitch-fixture.mjs";

const profile = await readPublishedPluginProfile(IMAGE_STITCH_HEAD_CASE_ID);
assert.equal(profile.sourceCommit, IMAGE_STITCH_HEAD_COMMIT);
assert.equal(profile.sourceTree, IMAGE_STITCH_HEAD_TREE);
assert.equal(profile.directorySha256, "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee");
assert.equal(profile.fileCount, 5);
assert.equal(profile.runtime, "web");
assert.equal(profile.dataAccess, true);
assert.equal(profile.dialogAccess, "open_and_save");
assert.equal(profile.featureCode, "image-stitch-files");

const source = readHeadImageStitchPackage();
assert.equal(source.commit, IMAGE_STITCH_HEAD_COMMIT);
assert.equal(source.tree, IMAGE_STITCH_HEAD_TREE);
assert.equal(source.files.size, 5);
const manifest = JSON.parse(source.files.get("plugin.json").toString("utf8"));
assert.equal(manifest.name, profile.id);
assert.equal(manifest.version, profile.version);
assert.equal(manifest.main, "index.html");
assert.equal(manifest.preload, undefined);
assert.deepEqual(manifest.features.map(feature => feature.code), ["image-stitch", "image-stitch-files", "image-stitch-img"]);
assert.deepEqual(manifest.features[1].cmds[0], { type: "files", label: "拼接图片", fileType: "file",
  match: "/\\.(png|jpe?g|gif|bmp|webp|svg)$/i", minLength: 1, maxLength: 99 });

const prepared = await prepareHeadImageStitchFixture(profile, { temporaryParent: "/private/tmp" });
try {
  assert.deepEqual(prepared.review.profile, {
    caseId: "local-image-stitch-head",
    id: "image-stitch",
    version: "1.0.0",
    sourceKind: "local_full_directory",
    directorySha256: "16538ea9ec960d82f54f94a3de6f7df1a9d65b86ca1e6b5470c6e9698d84cdee",
    fileCount: 5
  }, "the production review projection must match Rust's registered profile shape");
  const result = await verifyHeadImageStitchFixture(prepared.fixture, profile);
  assert.equal(result.verification.sourceBytesUnchanged, true);
  assert.equal(result.verification.fixtureBytesMatchPinnedSource, true);
  assert.equal(result.verification.pluginCodeExecutedByVerification, false);
  await writeFile(`${prepared.fixture.pluginRoot}/plugin.json`, "tampered");
  await assert.rejects(verifyHeadImageStitchFixture(prepared.fixture, profile), /differs from the registered HEAD blobs/);
} finally { await prepared.cleanup(); }

await assert.rejects(prepareHeadImageStitchFixture({ ...profile, sourceTree: "0".repeat(40) }, { temporaryParent: "/private/tmp" }),
  /exact registered HEAD revision/);
await assert.rejects(prepareHeadImageStitchFixture({ ...profile, dataAccess: false }, { temporaryParent: "/private/tmp" }),
  /exact registered HEAD revision/);
