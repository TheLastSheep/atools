import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCompressedNodeRuntimeBundleOverlay, compressedRuntimeResourceContract } from "./lib/compressed-node-runtime-bundle.mjs";

const TARGET = "aarch64-apple-darwin";
const STAGE = "12345-2";
const profile = { bundle: { macOS: { minimumSystemVersion: "11.0" } } };
assert.deepEqual(JSON.parse(await readFile(new URL("../src-tauri/tauri.node-runtime-compressed.conf.json", import.meta.url), "utf8")), profile);
const builtinOverlay = {
  bundle: {
    externalBin: ["binaries/node"],
    resources: {
      "../resources/plugins/builtin/": null,
      [`../target/builtin-runtime-staging/${STAGE}/${TARGET}/`]: "plugins/builtin",
      [`../target/builtin-runtime-staging/${STAGE}/${TARGET}.manifest.json`]: "builtin-runtime-stage/manifest-v1.json",
      "binaries/node-runtime-metadata/": "runtime",
    },
    macOS: { minimumSystemVersion: "11.0" },
  },
};

function overlayFor(target) {
  return {
    bundle: {
      externalBin: ["binaries/node"],
      resources: {
        "../resources/plugins/builtin/": null,
        [`../target/builtin-runtime-staging/${STAGE}/${target}/`]: "plugins/builtin",
        [`../target/builtin-runtime-staging/${STAGE}/${target}.manifest.json`]: "builtin-runtime-stage/manifest-v1.json",
        "binaries/node-runtime-metadata/": "runtime",
      },
      macOS: { minimumSystemVersion: "11.0" },
    },
  };
}

const root = await realpath(await mkdtemp(join(tmpdir(), "atools-compressed-bundle-config-")));
try {
  const payloadDirectory = join(root, "target/node-runtime-compressed", STAGE, TARGET, ".atools-node-payload-test-id");
  await mkdir(payloadDirectory, { recursive: true });
  const config = await createCompressedNodeRuntimeBundleOverlay({
    repoRoot: root,
    target: TARGET,
    stageId: STAGE,
    payloadDirectory,
    compressedProfile: profile,
    minimumMacOS: "11.0",
    builtinOverlay,
  });
  assert.deepEqual(Object.keys(config), ["bundle"]);
  assert.deepEqual(Object.keys(config.bundle), ["resources", "macOS"]);
  assert.equal(config.bundle.macOS.minimumSystemVersion, "11.0");
  assert.equal(config.bundle.externalBin, undefined);
  assert.equal(config.bundle.resources["binaries/node-runtime-metadata/"], undefined);
  assert.equal(config.bundle.resources[`${relativePayload(root, payloadDirectory)}/`], "node-runtime/compressed/");
  assert.equal(Object.keys(config.bundle.resources).length, 4);
  assert.deepEqual(compressedRuntimeResourceContract(), {
    directory: "node-runtime/compressed/",
    metadata: "compressed-runtime.json",
    license: "NODE-LICENSE",
    filenames: ["node-${target}.gz", "compressed-runtime.json", "NODE-LICENSE"],
    profilePath: "src-tauri/tauri.node-runtime-compressed.conf.json",
  });

  await assert.rejects(() => createCompressedNodeRuntimeBundleOverlay({
    repoRoot: root, target: "x86_64-apple-darwin", stageId: STAGE, payloadDirectory,
    compressedProfile: profile, minimumMacOS: "11.0", builtinOverlay: overlayFor("x86_64-apple-darwin"),
  }), /COMPRESSED_RUNTIME_PAYLOAD_PATH_INVALID|COMPRESSED_RUNTIME_PAYLOAD_PATH_UNSAFE/);
  await assert.rejects(() => createCompressedNodeRuntimeBundleOverlay({
    repoRoot: root, target: TARGET, stageId: STAGE, payloadDirectory,
    compressedProfile: { bundle: { macOS: { minimumSystemVersion: "10.15" } } }, minimumMacOS: "11.0", builtinOverlay,
  }), /COMPRESSED_RUNTIME_PROFILE_INVALID/);
  const wrongBuiltin = structuredClone(builtinOverlay);
  wrongBuiltin.bundle.externalBin = [];
  await assert.rejects(() => createCompressedNodeRuntimeBundleOverlay({
    repoRoot: root, target: TARGET, stageId: STAGE, payloadDirectory,
    compressedProfile: profile, minimumMacOS: "11.0", builtinOverlay: wrongBuiltin,
  }), /COMPRESSED_RUNTIME_BUILTIN_OVERLAY_INVALID/);
  const mismatchedTarget = structuredClone(builtinOverlay);
  mismatchedTarget.bundle.resources[`../target/builtin-runtime-staging/${STAGE}/${TARGET}/`] = "other";
  await assert.rejects(() => createCompressedNodeRuntimeBundleOverlay({
    repoRoot: root, target: TARGET, stageId: STAGE, payloadDirectory,
    compressedProfile: profile, minimumMacOS: "11.0", builtinOverlay: mismatchedTarget,
  }), /COMPRESSED_RUNTIME_BUILTIN_OVERLAY_INVALID/);
} finally {
  await rm(root, { recursive: true, force: true });
}

function relativePayload(repoRoot, payloadDirectory) {
  return `../${join("target/node-runtime-compressed", STAGE, TARGET, ".atools-node-payload-test-id")}`;
}
