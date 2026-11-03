import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNodeRuntimeBenchmarkConfig, createNodeRuntimeBundleConfig, readRuntimeOverlay } from "./lib/builtin-runtime-bundle.mjs";

export { createNodeRuntimeBenchmarkConfig };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--target" || !args[1] || args[1].startsWith("--")
    || args[2] !== "--stage-id" || !args[3] || args[3].startsWith("--")) throw new Error("BUILTIN_BUNDLE_ARGUMENT_INVALID");
  const canonicalOverlay = await readRuntimeOverlay(repoRoot);
  const config = await createNodeRuntimeBundleConfig({ repoRoot, target: args[1], stageId: args[3], canonicalOverlay, benchmark: true });
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : "BUILTIN_BUNDLE_CONFIG_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
