import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setupNativeRendererSourceLock, snapshotNativeRendererSources } from "./lib/ztools-renderer-native-source-snapshots.mjs";

test("native renderer source snapshots bind runner/package/dist inputs and report a missing upstream", async t => {
  const root = await mkdtemp(join(tmpdir(), "atools-renderer-source-snapshot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = join(root, "packages/ztools-renderer");
  const distRoot = join(packageRoot, "dist");
  const fixture = join(root, "scripts/fixture.mjs");
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await mkdir(distRoot, { recursive: true });
  await mkdir(dirname(fixture), { recursive: true });
  await writeFile(fixture, "runner source");
  await writeFile(join(packageRoot, "source-manifest.json"), JSON.stringify({ build: {
    hostAdapterSourceExtensions: [".ts", ".mjs"], hostBuildHelperModules: ["compatibility.mjs"],
  } }));
  await writeFile(join(packageRoot, "compatibility.mjs"), "root helper");
  await writeFile(join(packageRoot, "src/host.ts"), "adapter source");
  await writeFile(join(distRoot, "index.html"), "renderer dist");

  const { sourceLock, snapshot } = await setupNativeRendererSourceLock({
    root,
    upstreamPath: null,
    packageRoot,
    distRoot,
    fixtureFiles: ["scripts/fixture.mjs"],
  });
  assert.ok(snapshot.packageFiles["scripts/fixture.mjs"]);
  assert.ok(snapshot.distFiles["packages/ztools-renderer/dist/index.html"]);
  assert.deepEqual(snapshot.errors, [{ area: "upstream", name: "MissingInput", code: null,
    message: "Set ATOOLS_ZTOOLS_SOURCE to the pinned clean ZTools checkout" }]);

  const before = await snapshotNativeRendererSources(sourceLock, null);
  await writeFile(fixture, "runner source changed");
  const after = await snapshotNativeRendererSources(sourceLock, null);
  assert.notDeepEqual(before.packageFiles, after.packageFiles);
  assert.deepEqual(after.errors, []);
});
