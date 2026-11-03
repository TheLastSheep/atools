import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appBundleBytes } from "./lib/app-bundle-size.mjs";
import { verifyPackagedBuiltinRuntime } from "./lib/builtin-runtime-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_APP_BYTES = 100 * 1024 * 1024;

function parseArgs(argv) {
  const options = { app: null, target: null, enforceBudget: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--enforce-100mib") { options.enforceBudget = true; continue; }
    if (!["--app", "--target"].includes(flag) || !argv[index + 1] || argv[index + 1].startsWith("--")) {
      throw new Error("BUILTIN_BUNDLE_ARGUMENT_INVALID");
    }
    const value = argv[++index];
    if (flag === "--app") {
      if (!isAbsolute(value)) throw new Error("BUILTIN_BUNDLE_APP_PATH_REQUIRED");
      options.app = value;
    } else options.target = value;
  }
  if (!options.app || !options.target) throw new Error("BUILTIN_BUNDLE_ARGUMENT_REQUIRED");
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await verifyPackagedBuiltinRuntime({
    appPath: options.app,
    repoRoot,
    target: options.target,
    maxAppBytes: options.enforceBudget ? MAX_APP_BYTES : null,
    measureApp: appBundleBytes,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : "BUILTIN_BUNDLE_VERIFY_FAILED";
    process.stderr.write(`${JSON.stringify({ passed: false, code })}\n`);
    process.exitCode = 1;
  });
}
