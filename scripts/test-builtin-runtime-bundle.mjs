import assert from "node:assert/strict";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertBundleTreeMatchesManifest,
  assertManifestMatchesPlan,
  assessAppBundleBudget,
  composeNodeRuntimeBundleOverlay,
} from "./lib/builtin-runtime-bundle.mjs";
import { appBundleBytes } from "./lib/app-bundle-size.mjs";
import { inspectBuiltinTree } from "./lib/builtin-runtime-staging.mjs";

const TARGET = "aarch64-apple-darwin";
const STAGE_ID = "test-run";
const BASE_KEY = "../resources/plugins/builtin/";
const STAGE_KEY = `../target/builtin-runtime-staging/${STAGE_ID}/${TARGET}/`;
const MANIFEST_KEY = `../target/builtin-runtime-staging/${STAGE_ID}/${TARGET}.manifest.json`;

function applyMergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return structuredClone(patch);
  const output = target && typeof target === "object" && !Array.isArray(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete output[key];
    else output[key] = applyMergePatch(output[key], value);
  }
  return output;
}

function fixturePlan() {
  return {
    source: { sha256: "a".repeat(64), fileCount: 1, bytes: 3 },
    stagedTreeSha256: "b".repeat(64),
    stagedEntries: [{ path: "sample.txt", kind: "file", bytes: 3, sha256: "c".repeat(64), mode: 0o644 }],
    stagedBytes: 3,
    bytesSaved: 0,
    excluded: [],
    decisions: [],
  };
}

function manifestFor(plan) {
  return {
    schemaVersion: 1,
    sourceRoot: "resources/plugins/builtin",
    sourceManifestSha256: plan.source.sha256,
    stagedManifestSha256: plan.stagedTreeSha256,
    sourceFiles: plan.source.fileCount,
    stagedFiles: plan.stagedEntries.length,
    sourceBytes: plan.source.bytes,
    stagedBytes: plan.stagedBytes,
    bytesSaved: plan.bytesSaved,
    sourceUnchanged: true,
    target: { platform: "darwin", arch: "arm64" },
    rulesApplied: true,
    excluded: plan.excluded,
    decisions: plan.decisions,
    entries: plan.stagedEntries,
  };
}

export async function runBuiltinRuntimeBundleTests() {
  const base = {
    bundle: {
      createUpdaterArtifacts: true,
      resources: { [BASE_KEY]: "plugins/builtin", "../resources/other/": "other" },
      macOS: { minimumSystemVersion: "10.15", signingIdentity: null, entitlements: "./Entitlements.plist" },
    },
  };
  const nodeOverlay = {
    bundle: {
      externalBin: ["binaries/node"],
      resources: { "binaries/node-runtime-metadata/": "runtime" },
      macOS: { minimumSystemVersion: "11.0" },
    },
  };
  const releaseOverlay = composeNodeRuntimeBundleOverlay(nodeOverlay, TARGET, STAGE_ID);
  assert.equal(releaseOverlay.bundle.resources[BASE_KEY], null);
  assert.equal(releaseOverlay.bundle.resources[STAGE_KEY], "plugins/builtin");
  assert.equal(releaseOverlay.bundle.resources[MANIFEST_KEY], "builtin-runtime-stage/manifest-v1.json");
  const mergedRelease = applyMergePatch(base, releaseOverlay);
  assert.deepEqual(mergedRelease.bundle.resources, {
    "../resources/other/": "other",
    [STAGE_KEY]: "plugins/builtin",
    [MANIFEST_KEY]: "builtin-runtime-stage/manifest-v1.json",
    "binaries/node-runtime-metadata/": "runtime",
  });
  assert.deepEqual(mergedRelease.bundle.externalBin, ["binaries/node"]);
  assert.equal(mergedRelease.bundle.macOS.minimumSystemVersion, "11.0");
  assert.equal(mergedRelease.bundle.macOS.signingIdentity, null);
  assert.equal(mergedRelease.bundle.macOS.entitlements, "./Entitlements.plist");
  assert.equal(mergedRelease.bundle.createUpdaterArtifacts, true);

  const benchmarkOverlay = composeNodeRuntimeBundleOverlay(nodeOverlay, TARGET, STAGE_ID, true);
  const mergedBenchmark = applyMergePatch(base, benchmarkOverlay);
  assert.equal(mergedBenchmark.bundle.createUpdaterArtifacts, false);
  assert.deepEqual(mergedBenchmark.bundle.externalBin, ["binaries/node"]);
  assert.equal(mergedBenchmark.bundle.resources[BASE_KEY], undefined);
  const extraAbsoluteResource = structuredClone(nodeOverlay);
  extraAbsoluteResource.bundle.resources["/tmp/extra-resource"] = "extra-resource";
  assert.throws(() => composeNodeRuntimeBundleOverlay(extraAbsoluteResource, TARGET, STAGE_ID), /BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID/);
  const updaterOverride = structuredClone(nodeOverlay);
  updaterOverride.bundle.createUpdaterArtifacts = false;
  assert.throws(() => composeNodeRuntimeBundleOverlay(updaterOverride, TARGET, STAGE_ID), /BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID/);
  const signerOverride = structuredClone(nodeOverlay);
  signerOverride.bundle.macOS.signingIdentity = "adhoc";
  assert.throws(() => composeNodeRuntimeBundleOverlay(signerOverride, TARGET, STAGE_ID), /BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID/);
  const entitlementOverride = structuredClone(nodeOverlay);
  entitlementOverride.bundle.macOS.entitlements = "./other.plist";
  assert.throws(() => composeNodeRuntimeBundleOverlay(entitlementOverride, TARGET, STAGE_ID), /BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID/);
  const rootOverride = { ...structuredClone(nodeOverlay), plugins: { updater: null } };
  assert.throws(() => composeNodeRuntimeBundleOverlay(rootOverride, TARGET, STAGE_ID), /BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID/);
  assert.throws(() => composeNodeRuntimeBundleOverlay(nodeOverlay, "../../escape", STAGE_ID), /BUILTIN_BUNDLE_TARGET_UNSUPPORTED/);
  assert.throws(() => composeNodeRuntimeBundleOverlay(nodeOverlay, TARGET, "../escape"), /BUILTIN_BUNDLE_STAGE_ID_INVALID/);
  assert.throws(() => composeNodeRuntimeBundleOverlay({
    bundle: { ...nodeOverlay.bundle, resources: { ...nodeOverlay.bundle.resources, "../shared/": "builtin-runtime-stage" } },
  }, TARGET, STAGE_ID), /BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID/);
  const appLimit = 100 * 1024 * 1024;
  assert.deepEqual(assessAppBundleBudget(appLimit, appLimit), { passed: true, reason: null, appBytes: appLimit, maxAppBytes: appLimit });
  assert.deepEqual(assessAppBundleBudget(appLimit + 1, appLimit), {
    passed: false, reason: "APP_BUNDLE_SIZE_EXCEEDED", appBytes: appLimit + 1, maxAppBytes: appLimit,
  });

  const plan = fixturePlan();
  const manifest = manifestFor(plan);
  assertManifestMatchesPlan(manifest, plan, TARGET);
  assert.throws(() => assertManifestMatchesPlan({ ...manifest, target: { platform: "darwin", arch: "x64" } }, plan, TARGET), /BUILTIN_BUNDLE_MANIFEST_MISMATCH/);
  assert.throws(() => assertManifestMatchesPlan({ ...manifest, sourceUnchanged: false }, plan, TARGET), /BUILTIN_BUNDLE_MANIFEST_MISMATCH/);

  const root = realpathSync(mkdtempSync(join(tmpdir(), "atools-builtin-bundle-test-")));
  try {
    const tree = join(root, "tree");
    mkdirSync(tree);
    writeFileSync(join(tree, "sample.txt"), "abc");
    const expected = await inspectBuiltinTree(tree);
    await assertBundleTreeMatchesManifest(tree, expected.publicEntries, expected.sha256);

    rmSync(join(tree, "sample.txt"));
    await assert.rejects(() => assertBundleTreeMatchesManifest(tree, expected.publicEntries, expected.sha256));
    writeFileSync(join(tree, "sample.txt"), "abc");
    writeFileSync(join(tree, "extra.txt"), "x");
    await assert.rejects(() => assertBundleTreeMatchesManifest(tree, expected.publicEntries, expected.sha256));
    rmSync(join(tree, "extra.txt"));
    writeFileSync(join(tree, "sample.txt"), "changed");
    await assert.rejects(() => assertBundleTreeMatchesManifest(tree, expected.publicEntries, expected.sha256));
    rmSync(join(tree, "sample.txt"));
    symlinkSync("missing-target", join(tree, "sample.txt"));
    await assert.rejects(() => assertBundleTreeMatchesManifest(tree, expected.publicEntries, expected.sha256));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const sizeRoot = mkdtempSync(join(tmpdir(), "atools-app-size-test-"));
  try {
    writeFileSync(join(sizeRoot, "payload"), "abc");
    symlinkSync("payload", join(sizeRoot, "alias"));
    const expectedBytes = 3 + lstatSync(join(sizeRoot, "alias")).size;
    assert.equal(appBundleBytes(sizeRoot), expectedBytes);
    assert.equal(readdirSync(sizeRoot).length, 2);
  } finally {
    rmSync(sizeRoot, { recursive: true, force: true });
  }
}
