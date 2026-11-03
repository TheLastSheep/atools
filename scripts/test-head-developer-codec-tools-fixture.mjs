import assert from "node:assert/strict";
import test from "node:test";
import { HEAD_DEVELOPER_CODEC_TOOLS_COMMIT, HEAD_DEVELOPER_CODEC_TOOLS_DIRECTORY_SHA256,
  HEAD_DEVELOPER_CODEC_TOOLS_TREE, readHeadDeveloperCodecToolsPackage, readHeadDeveloperCodecToolsProfile }
  from "./lib/head-developer-codec-tools-fixture.mjs";

test("Developer Codec Tools fixture binds the exact original HEAD profile and controls", async () => {
  const { profile } = await readHeadDeveloperCodecToolsProfile();
  const source = await readHeadDeveloperCodecToolsPackage();
  assert.equal(profile.id, "developer-codec-tools");
  assert.equal(profile.version, "0.1.0");
  assert.equal(profile.featureCode, "codec-tools");
  assert.equal(source.commit, HEAD_DEVELOPER_CODEC_TOOLS_COMMIT);
  assert.equal(source.tree, HEAD_DEVELOPER_CODEC_TOOLS_TREE);
  assert.equal(source.witness.directorySha256, HEAD_DEVELOPER_CODEC_TOOLS_DIRECTORY_SHA256);
  assert.equal(source.files.size, 15);
  assert.equal(source.files.get("plugin.json").length, 771);
  assert.equal(source.manifest.preload, undefined);
  assert.ok(source.files.get("app.js").toString("utf8").includes("runCurrentOperation"));
  assert.ok(source.files.get("codec.js").toString("utf8").includes("base64Decode"));
});
