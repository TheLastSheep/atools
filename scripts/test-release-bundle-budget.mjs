import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
import { verifyBundleBudget } from "./lib/release-bundle-budget.mjs";

const distDir = await mkdtemp(join(tmpdir(), "atools-release-budget-"));
const viteEntry = join(root, "node_modules", "vite", "bin", "vite.js");
const buildEnv = { ...process.env };
delete buildEnv.TAURI_ENV_DEBUG;
delete buildEnv.TAURI_ENV_PLATFORM;

try {
  const build = spawnSync(process.execPath, [viteEntry, "build", "--manifest", "--outDir", distDir], {
    cwd: root,
    env: buildEnv,
    encoding: "utf8",
  });
  assert.equal(
    build.status,
    0,
    `production Vite build failed:\n${build.stdout || ""}${build.stderr || ""}`,
  );
  console.log(JSON.stringify(await verifyBundleBudget(distDir)));
} finally {
  await rm(distDir, { recursive: true, force: true });
}
