import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

import { classifyTestScripts } from "./test-tiers.mjs";

const tier = process.argv[2];
if (tier !== "fast" && tier !== "browser") {
  console.error("Usage: node scripts/run-test-tier.mjs <fast|browser>");
  process.exit(2);
}

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const scripts = classifyTestScripts(packageJson.scripts)[tier];

console.log(`[test:${tier}] ${scripts.length} focused scripts`);
for (const [index, script] of scripts.entries()) {
  console.log(`[test:${tier}] ${index + 1}/${scripts.length} ${script}`);
  const result = spawnSync("pnpm", ["run", script], {
    cwd: root.pathname,
    env: { ...process.env, ATOOLS_TEST_TIER: tier },
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:${tier}] failed to start ${script}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`[test:${tier}] ${script} exited with ${result.status ?? "signal"}`);
    process.exit(result.status || 1);
  }
}
console.log(`[test:${tier}] passed ${scripts.length}/${scripts.length}`);
