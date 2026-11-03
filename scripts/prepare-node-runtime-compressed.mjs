#!/usr/bin/env node
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupPreparedCompressedNodePayload, prepareCompressedNodePayload, readRegularBounded, verifyCompressedNodePayload } from "./lib/node-runtime-compressed-payload.mjs";

function parseArgs(argv) {
  const allowed = new Set(["--target", "--archive", "--output-parent", "--identity", "--team-id"]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index], value = argv[index + 1];
    if (!allowed.has(key) || !value || value.startsWith("--") || values.has(key)) throw new Error("Invalid command arguments");
    values.set(key, value);
  }
  for (const key of allowed) if (!values.has(key)) throw new Error("Missing required command argument");
  return {
    target: values.get("--target"),
    archive: values.get("--archive"),
    outputParent: values.get("--output-parent"),
    identity: values.get("--identity"),
    expectedTeamId: values.get("--team-id"),
  };
}

async function main(argv) {
  if (process.platform !== "darwin") throw new Error("This command requires macOS codesign");
  const options = parseArgs(argv);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pinBytes = await readRegularBounded(resolve(repoRoot, "resources/node-runtime/pin.json"), 16 * 1024);
  const pin = JSON.parse(pinBytes.toString("utf8"));
  const pinSha256 = createHash("sha256").update(pinBytes).digest("hex");
  const prepared = await prepareCompressedNodePayload({
    pin,
    pinSha256,
    target: options.target,
    archive: options.archive,
    outputParent: options.outputParent,
    identity: options.identity,
    expectedTeamId: options.expectedTeamId,
  });
  let verified;
  try {
    verified = await verifyCompressedNodePayload({ pin, pinSha256, target: options.target, packageDirectory: prepared.outputDirectory, expectedTeamId: options.expectedTeamId });
  } catch (error) {
    await cleanupPreparedCompressedNodePayload(prepared);
    throw error;
  }
  process.stdout.write(`${JSON.stringify({ passed: verified.passed, outputDirectory: prepared.outputDirectory, metadata: prepared.metadata, verification: verified }, null, 2)}\n`);
}

main(process.argv.slice(2)).catch(() => {
  process.stderr.write("Compressed Node payload preparation failed; no signature or release acceptance is implied.\n");
  process.exitCode = 1;
});
