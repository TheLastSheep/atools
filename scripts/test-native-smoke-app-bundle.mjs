import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageNativeSmokeApp } from "./lib/native-smoke-app-bundle.mjs";

const scratch = await mkdtemp("/private/tmp/atools-native-app-contract-");
try {
  const source = join(scratch, "reviewed-binary"), content = "synthetic bytes, never executed";
  await writeFile(source, content, { mode: 0o700 });
  const runId = "ac72f532-df11-4e91-8f16-b7e889352b12";
  const app = await stageNativeSmokeApp(source, scratch, runId);
  assert.equal(await readFile(app.executable, "utf8"), content);
  assert.equal(app.sourceExecutableSha256, app.stagedExecutableSha256);
  assert.equal(app.bundleId, "dev.atools.fixture.dialog.ac72f532df114e918f16b7e889352b12");
  assert.equal((await stat(app.executable)).mode & 0o777, 0o700);
  const plist = await readFile(app.plistPath, "utf8");
  assert.ok(plist.includes(`<string>${app.bundleId}</string>`));
  assert.ok(!plist.includes("dev.atools.desktop"));
  await assert.rejects(stageNativeSmokeApp(source, scratch, runId), /EEXIST/);
  await assert.rejects(stageNativeSmokeApp(source, scratch, "../../installed"), /UUID/);
  await symlink(source, join(scratch, "alias"));
  await assert.rejects(stageNativeSmokeApp(join(scratch, "alias"), scratch), /regular executable/);
  await chmod(scratch, 0o755);
  await assert.rejects(stageNativeSmokeApp(source, scratch), /private scratch/);
  await chmod(scratch, 0o700);
  console.log("Native fixture identity contract passed; only synthetic bytes copied, no software launched");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
