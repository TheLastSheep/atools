#!/usr/bin/env node
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readRegularBounded, verifyCompressedNodePayload } from "./lib/node-runtime-compressed-payload.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INFO_PLIST_BYTES = 64 * 1024;
const RESOURCE_DIRECTORY = "Contents/Resources/node-runtime/compressed";
const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const values = new Map();
  let execute = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--execute" && !execute) { execute = true; continue; }
    const value = argv[index + 1];
    if (!["--app", "--target", "--team-id"].includes(flag) || !value || value.startsWith("--") || values.has(flag)) {
      throw new Error("COMPRESSED_RUNTIME_ARGUMENT_INVALID");
    }
    values.set(flag, value);
    index += 1;
  }
  const app = values.get("--app");
  const target = values.get("--target");
  const expectedTeamId = values.get("--team-id");
  if (!app || !target || !expectedTeamId || !/^[A-Z0-9]{10}$/u.test(expectedTeamId) || !app.startsWith("/")) {
    throw new Error("COMPRESSED_RUNTIME_ARGUMENT_REQUIRED");
  }
  return { app: resolve(app), target, expectedTeamId, execute };
}

async function absent(appRoot, relativePath) {
  try {
    const info = await lstat(join(appRoot, relativePath));
    if (info.isSymbolicLink()) throw new Error("COMPRESSED_RUNTIME_RAW_PROFILE_PRESENT");
    return false;
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
}

async function verifySignedAppTeam(appPath, expectedTeamId) {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const details = await execFileAsync("/usr/bin/codesign", ["--display", "--verbose=4", appPath], { timeout: 10000, maxBuffer: 1024 * 1024 });
  const text = `${details.stderr || ""}\n${details.stdout || ""}`;
  const teams = [...text.matchAll(/^TeamIdentifier=([^\r\n]+)$/gmu)].map(match => match[1]);
  const authorities = [...text.matchAll(/^Authority=(Developer ID Application: [^\r\n]+)$/gmu)].map(match => match[1]);
  if (teams.length !== 1 || teams[0] !== expectedTeamId || authorities.length !== 1
    || !authorities[0].endsWith(`(${expectedTeamId})`)) throw new Error("COMPRESSED_RUNTIME_APP_SIGNATURE_TEAM_MISMATCH");
}

async function main() {
  if (process.platform !== "darwin") throw new Error("COMPRESSED_RUNTIME_REQUIRES_MACOS_CODESIGN");
  const options = parseArgs(process.argv.slice(2));
  const pinBytes = await readRegularBounded(join(repoRoot, "resources/node-runtime/pin.json"), 16 * 1024);
  const pin = JSON.parse(pinBytes.toString("utf8"));
  const appInfo = await lstat(options.app);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink() || await realpath(options.app) !== options.app) {
    throw new Error("COMPRESSED_RUNTIME_APP_ROOT_UNSAFE");
  }
  await verifySignedAppTeam(options.app, options.expectedTeamId);
  if (!(await absent(options.app, "Contents/MacOS/node"))
    || !(await absent(options.app, "Contents/Resources/runtime"))) {
    throw new Error("COMPRESSED_RUNTIME_RAW_PROFILE_PRESENT");
  }
  const plist = await readRegularBounded(join(options.app, "Contents/Info.plist"), MAX_INFO_PLIST_BYTES);
  const minimum = /<key>LSMinimumSystemVersion<\/key>\s*<string>([^<]+)<\/string>/u.exec(plist.toString("utf8"))?.[1];
  if (minimum !== pin.minimumMacOS) throw new Error("COMPRESSED_RUNTIME_MINIMUM_OS_MISMATCH");
  const resourceDirectory = join(options.app, RESOURCE_DIRECTORY);
  if (await realpath(resourceDirectory) !== resourceDirectory) throw new Error("COMPRESSED_RUNTIME_RESOURCE_PATH_UNSAFE");
  const { createHash } = await import("node:crypto");
  const verification = await verifyCompressedNodePayload({
    pin,
    pinSha256: createHash("sha256").update(pinBytes).digest("hex"),
    target: options.target,
    packageDirectory: resourceDirectory,
    expectedTeamId: options.expectedTeamId,
    execute: options.execute,
  });
  process.stdout.write(`${JSON.stringify({
    passed: verification.passed,
    profile: "compressed-node-runtime",
    resourceDirectory: "node-runtime/compressed",
    target: verification.target,
    compressedBytes: verification.compressedBytes,
    signedBinaryBytes: verification.signedBinaryBytes,
    signedBinarySha256: verification.signedBinarySha256,
    metadataSha256: verification.metadataSha256,
    expectedTeamId: options.expectedTeamId,
    minimumMacOS: minimum,
    appSizeBudgetVerified: false,
    runtimeExecutionVerified: verification.runtimeExecutionVerified,
    runtime: verification.runtime,
  })}\n`);
}

main().catch(error => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
    ? error.code : "COMPRESSED_RUNTIME_BUNDLE_VERIFICATION_FAILED";
  process.stderr.write(`${JSON.stringify({ passed: false, code })}\n`);
  process.exitCode = 1;
});
