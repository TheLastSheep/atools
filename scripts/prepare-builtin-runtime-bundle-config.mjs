import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createNodeRuntimeBundleConfig, readRuntimeOverlay } from "./lib/builtin-runtime-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const options = { target: null, stageId: null, benchmark: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--benchmark") { options.benchmark = true; continue; }
    if (["--target", "--stage-id"].includes(flag) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
      const key = flag === "--target" ? "target" : "stageId";
      options[key] = argv[++index];
      continue;
    }
    throw new Error("BUILTIN_BUNDLE_ARGUMENT_INVALID");
  }
  if (!options.target || !options.stageId) throw new Error("BUILTIN_BUNDLE_TARGET_REQUIRED");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const canonicalOverlay = await readRuntimeOverlay(repoRoot);
  const config = await createNodeRuntimeBundleConfig({ repoRoot, target: options.target, stageId: options.stageId, canonicalOverlay, benchmark: options.benchmark });
  process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : "BUILTIN_BUNDLE_CONFIG_FAILED";
    process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
    process.exitCode = 1;
  });
}
