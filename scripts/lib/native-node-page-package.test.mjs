import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot } from "../probe-plugin-panel-native.mjs";
import { createNodePageFixturePackages, reviewedNodePageSources } from "./native-node-page-package.mjs";

test("page-only Node packages pin complete original UI inputs and isolate fixture save code", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "atools-node-page-package-test-"));
  try {
    const result = await createNodePageFixturePackages(repositoryRoot, scratch, {
      outputPath: join(scratch, "private", "node-page-output.png"),
    });
    assert.deepEqual(result.packageIds, ["file-tree", "char-transform"]);
    assert.equal(result.originalsRemainUnmodified, true);
    assert.equal(result.exactSaveFunctions, true);
    for (const [key, info] of Object.entries(reviewedNodePageSources)) {
      const id = key === "imageStitch" ? "file-tree" : "char-transform";
      const originalRoot = join(repositoryRoot, "ZTools-plugins/plugins", info.id);
      const generatedRoot = join(result.directory, id);
      for (const [file, digest] of Object.entries(info.files)) {
        assert.equal(result.copiedHashes[info.id][file], digest);
        assert.deepEqual(await readFile(join(generatedRoot, file)), await readFile(join(originalRoot, file)));
      }
      const manifest = JSON.parse(await readFile(join(generatedRoot, "plugin.json"), "utf8"));
      assert.equal(manifest.name, id);
      assert.equal(manifest.version, "0.0.0-synthetic");
      assert.equal(manifest.syntheticFixture.originalPackage, false);
      assert.equal("preload" in manifest, false);
    }
    const image = await readFile(join(result.directory, "file-tree", "fixture-save.js"), "utf8");
    const originalApp = await readFile(join(repositoryRoot, "ZTools-plugins/plugins/image-stitch/app.js"), "utf8");
    const exactFunctions = originalApp.slice(originalApp.indexOf("  function getOutputMimeType() {"), originalApp.indexOf("  function copyToClipboard() {"));
    assert.ok(image.includes(exactFunctions));
    assert.match(image, /writeFileSync\(result, Buffer\.from\(base64, 'base64'\)\)/);
    assert.match(image, /cancelNext: true/);
    assert.match(image, /shellShowItemInFolder = function/);
    const codec = await readFile(join(result.directory, "char-transform", "app.js"), "utf8");
    assert.doesNotMatch(codec, /require\s*\(/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
