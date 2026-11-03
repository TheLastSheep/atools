import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { prepareLoginPreviewDirectories } from "./ztools-settings-login-preview.mjs";

const runId = "a".repeat(32);
const outputRootName = "renderer-legacy-login-integration-2026-10-29";

async function privateRepo(t) {
  const sandbox = await realpath(await mkdtemp(join(tmpdir(), "settings-login-preview-")));
  const repositoryRoot = join(sandbox, "repo");
  await mkdir(repositoryRoot, { mode: 0o700 });
  t.after(() => rm(repositoryRoot, { recursive: true, force: true }));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  await writeFile(join(repositoryRoot, "package.json"), "{}\n", { mode: 0o600 });
  await mkdir(join(repositoryRoot, "output"), { mode: 0o700 });
  const target = join(sandbox, "outside-target");
  await mkdir(target, { mode: 0o700 });
  return { repositoryRoot, target, outputParent: join(repositoryRoot, "output") };
}

test("creates the run directory under the canonical fixed repository output root", async (t) => {
  const { repositoryRoot } = await privateRepo(t);
  const paths = await prepareLoginPreviewDirectories(repositoryRoot, runId);
  assert.equal(paths.outputRoot, join(repositoryRoot, "output", outputRootName));
  assert.equal(paths.outputDir, join(paths.outputRoot, `browser-${runId}`));
  assert.deepEqual(await readdir(paths.outputDir), []);
  assert.ok((await lstat(paths.outputDir)).isDirectory());
});

for (const location of ["output-parent", "output-root", "run-directory"]) {
  test(`rejects a symlinked ${location} without writing into its target`, async (t) => {
    const { repositoryRoot, target, outputParent } = await privateRepo(t);
    const outputRoot = join(outputParent, outputRootName);
    const runDirectory = join(outputRoot, `browser-${runId}`);
    if (location === "output-parent") {
      await rm(outputParent, { recursive: true });
      await symlink(target, outputParent, "dir");
    } else if (location === "output-root") {
      await symlink(target, outputRoot, "dir");
    } else {
      await mkdir(outputRoot, { mode: 0o700 });
      await symlink(target, runDirectory, "dir");
    }

    await assert.rejects(prepareLoginPreviewDirectories(repositoryRoot, runId));
    assert.deepEqual(await readdir(target), []);
  });
}
