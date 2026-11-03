#!/usr/bin/env node
import { createHash } from "node:crypto";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cleanupPreparedCompressedNodePayload,
  prepareCompressedNodePayload,
  readRegularBounded,
  verifyCompressedNodePayload,
} from "./lib/node-runtime-compressed-payload.mjs";
import { verifiedNodeArchive } from "./lib/node-runtime-archive.mjs";
import { createNodeRuntimeBundleConfig, readRuntimeOverlay } from "./lib/builtin-runtime-bundle.mjs";
import { createCompressedNodeRuntimeBundleOverlay } from "./lib/compressed-node-runtime-bundle.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const result = { target: null, stageId: null, archive: null, cacheDir: join(repoRoot, "target/node-runtime-cache"), offline: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--offline") {
      if (seen.has(flag)) throw new Error("COMPRESSED_RUNTIME_ARGUMENT_DUPLICATE");
      seen.add(flag);
      result.offline = true;
      continue;
    }
    if (!["--target", "--stage-id", "--archive", "--cache-dir"].includes(flag)) throw new Error("COMPRESSED_RUNTIME_ARGUMENT_INVALID");
    if (seen.has(flag)) throw new Error("COMPRESSED_RUNTIME_ARGUMENT_DUPLICATE");
    seen.add(flag);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error("COMPRESSED_RUNTIME_ARGUMENT_VALUE_REQUIRED");
    if (flag === "--target") result.target = value;
    else if (flag === "--stage-id") result.stageId = value;
    else if (flag === "--archive") result.archive = value;
    else result.cacheDir = value;
  }
  if (!result.target || !result.stageId || (result.archive && !isAbsolute(result.archive)) || !isAbsolute(result.cacheDir)) {
    throw new Error("COMPRESSED_RUNTIME_ARGUMENT_REQUIRED");
  }
  if (!["aarch64-apple-darwin", "x86_64-apple-darwin"].includes(result.target)
    || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(result.stageId)) throw new Error("COMPRESSED_RUNTIME_TARGET_OR_STAGE_INVALID");
  return result;
}

async function secureStageParent(stageId, target) {
  const targetRoot = join(repoRoot, "target");
  if (await realpath(targetRoot) !== targetRoot || !(await lstat(targetRoot)).isDirectory()) throw new Error("COMPRESSED_RUNTIME_TARGET_ROOT_UNSAFE");
  let current = targetRoot;
  for (const part of ["node-runtime-compressed", stageId, target]) {
    current = join(current, part);
    const existing = await lstat(current).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!existing) await mkdir(current, { mode: 0o700 });
    const after = await lstat(current);
    if (!after.isDirectory() || after.isSymbolicLink() || await realpath(current) !== current) throw new Error("COMPRESSED_RUNTIME_STAGE_PATH_UNSAFE");
  }
  return current;
}

async function main() {
  if (process.platform !== "darwin") throw new Error("COMPRESSED_RUNTIME_REQUIRES_MACOS_CODESIGN");
  const options = parseArgs(process.argv.slice(2));
  const expectedTeamId = process.env.APPLE_TEAM_ID;
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!expectedTeamId || !identity) throw new Error("COMPRESSED_RUNTIME_SIGNING_IDENTITY_REQUIRED");

  const pinBytes = await readRegularBounded(join(repoRoot, "resources/node-runtime/pin.json"), 16 * 1024);
  const pin = JSON.parse(pinBytes.toString("utf8"));
  const pinSha256 = createHash("sha256").update(pinBytes).digest("hex");
  const archive = await verifiedNodeArchive({
    pin,
    target: options.target,
    cacheDir: options.cacheDir,
    archive: options.archive,
    offline: options.offline,
  });
  const outputParent = await secureStageParent(options.stageId, options.target);
  let prepared;
  try {
    prepared = await prepareCompressedNodePayload({
      pin,
      pinSha256,
      target: options.target,
      archive,
      outputParent,
      identity,
      expectedTeamId,
    });
    await verifyCompressedNodePayload({
      pin,
      pinSha256,
      target: options.target,
      packageDirectory: prepared.outputDirectory,
      expectedTeamId,
    });
    const canonicalOverlay = await readRuntimeOverlay(repoRoot);
    const builtinOverlay = await createNodeRuntimeBundleConfig({
      repoRoot,
      target: options.target,
      stageId: options.stageId,
      canonicalOverlay,
    });
    const compressedProfile = JSON.parse((await readRegularBounded(
      join(repoRoot, "src-tauri/tauri.node-runtime-compressed.conf.json"), 16 * 1024,
    )).toString("utf8"));
    const config = await createCompressedNodeRuntimeBundleOverlay({
      repoRoot,
      target: options.target,
      stageId: options.stageId,
      payloadDirectory: prepared.outputDirectory,
      compressedProfile,
      minimumMacOS: pin.minimumMacOS,
      builtinOverlay,
    });
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
    prepared = null;
  } finally {
    if (prepared) await cleanupPreparedCompressedNodePayload(prepared);
  }
}

main().catch(error => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]{1,64}$/u.test(error.code)
    ? error.code : "COMPRESSED_RUNTIME_PREPARATION_FAILED";
  process.stderr.write(`${JSON.stringify({ status: "failed", code })}\n`);
  process.exitCode = 1;
});
