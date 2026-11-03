import assert from "node:assert/strict";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { candidateRules, expectedSourceTreeSha256 } from "./builtin-runtime-rules.mjs";
import { inspectBuiltinTree, planBuiltinRuntimeStage, sha256Bytes } from "./builtin-runtime-staging.mjs";

const BASE_BUILTIN_KEY = "../resources/plugins/builtin/";
const BUNDLE_DESTINATION = "plugins/builtin";
const MANIFEST_DESTINATION = "builtin-runtime-stage/manifest-v1.json";
const METADATA_KEY = "binaries/node-runtime-metadata/";
const METADATA_DESTINATION = "runtime";
const MAX_STAGE_MANIFEST_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const failure = code => Object.assign(new Error(code), { code });

export function createNodeRuntimeBenchmarkConfig(canonicalOverlay) {
  assertNodeRuntimeOverlay(canonicalOverlay);
  const config = structuredClone(canonicalOverlay);
  config.bundle = { ...config.bundle, createUpdaterArtifacts: false };
  const preserved = structuredClone(config);
  delete preserved.bundle.createUpdaterArtifacts;
  assert.deepEqual(preserved, canonicalOverlay);
  return config;
}

function assertNodeRuntimeOverlay(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !sameKeys(value, ["bundle"])) throw failure("BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID");
  if (!value.bundle || typeof value.bundle !== "object" || Array.isArray(value.bundle)
    || !sameKeys(value.bundle, ["externalBin", "resources", "macOS"])) throw failure("BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID");
  assert.deepEqual(value.bundle?.externalBin, ["binaries/node"]);
  if (!value.bundle.resources || typeof value.bundle.resources !== "object" || Array.isArray(value.bundle.resources)
    || !sameKeys(value.bundle.resources, [METADATA_KEY])) throw failure("BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID");
  assert.equal(value.bundle?.resources?.[METADATA_KEY], METADATA_DESTINATION);
  if (!value.bundle.macOS || typeof value.bundle.macOS !== "object" || Array.isArray(value.bundle.macOS)
    || !sameKeys(value.bundle.macOS, ["minimumSystemVersion"])) throw failure("BUILTIN_BUNDLE_OVERLAY_KEYS_INVALID");
  assert.equal(value.bundle?.macOS?.minimumSystemVersion, "11.0");
}

function sameKeys(value, expected) {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function targetProfile(target) {
  if (target === "aarch64-apple-darwin") return { platform: "darwin", arch: "arm64" };
  if (target === "x86_64-apple-darwin") return { platform: "darwin", arch: "x64" };
  throw failure("BUILTIN_BUNDLE_TARGET_UNSUPPORTED");
}

function stageRunId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value)) throw failure("BUILTIN_BUNDLE_STAGE_ID_INVALID");
  return value;
}

function safeRelative(value) {
  if (typeof value !== "string" || !value || path.posix.isAbsolute(value) || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value) || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw failure("BUILTIN_BUNDLE_PATH_UNSAFE");
  }
  return value;
}

async function assertOwnedPath(root, relative, expectedKind) {
  safeRelative(relative);
  const rootPath = path.resolve(root);
  if (await realpath(rootPath) !== rootPath) throw failure("BUILTIN_BUNDLE_ROOT_UNSAFE");
  let current = rootPath;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || await realpath(current) !== current) throw failure("BUILTIN_BUNDLE_SYMLINK_REJECTED");
    if (index < parts.length - 1 && !info.isDirectory()) throw failure("BUILTIN_BUNDLE_PARENT_INVALID");
    if (index === parts.length - 1 && expectedKind === "directory" && !info.isDirectory()) throw failure("BUILTIN_BUNDLE_DIRECTORY_REQUIRED");
    if (index === parts.length - 1 && expectedKind === "file" && !info.isFile()) throw failure("BUILTIN_BUNDLE_FILE_REQUIRED");
  }
  return current;
}

async function readBoundedRegular(root, relative, maxBytes) {
  const filePath = await assertOwnedPath(root, relative, "file");
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw failure("BUILTIN_BUNDLE_MANIFEST_INVALID");
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw failure("BUILTIN_BUNDLE_MANIFEST_CHANGED");
    const chunks = [];
    let total = 0;
    let position = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, maxBytes - total + 1));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maxBytes) throw failure("BUILTIN_BUNDLE_MANIFEST_TOO_LARGE");
      chunks.push(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat();
    const entryAfter = await lstat(filePath);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || entryAfter.dev !== before.dev || entryAfter.ino !== before.ino || total !== before.size) throw failure("BUILTIN_BUNDLE_MANIFEST_CHANGED");
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeJson(value[key])]));
}

function assertDestinationSeparation(resourceMap) {
  const destinations = Object.entries(resourceMap).filter(([, target]) => target !== null).map(([source, target]) => {
    if (typeof target !== "string" || !target || path.posix.isAbsolute(target) || target.includes("\\")
      || /[\u0000-\u001f\u007f]/u.test(target) || target.split("/").some(part => !part || part === ".." || part === "." || part.includes(":"))) {
      throw failure("BUILTIN_BUNDLE_RESOURCE_DESTINATION_INVALID");
    }
    return { source, target: target.replace(/\/+$/u, "") };
  });
  for (let index = 0; index < destinations.length; index += 1) {
    for (let other = index + 1; other < destinations.length; other += 1) {
      const left = destinations[index].target;
      const right = destinations[other].target;
      if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`)) {
        throw failure("BUILTIN_BUNDLE_RESOURCE_DESTINATION_COLLISION");
      }
    }
  }
}

function expectedManifest(plan, target) {
  return {
    schemaVersion: 1,
    sourceRoot: "resources/plugins/builtin",
    sourceManifestSha256: plan.source.sha256,
    stagedManifestSha256: plan.stagedTreeSha256,
    sourceFiles: plan.source.fileCount,
    stagedFiles: plan.stagedEntries.filter(entry => entry.kind === "file").length,
    sourceBytes: plan.source.bytes,
    stagedBytes: plan.stagedBytes,
    bytesSaved: plan.bytesSaved,
    sourceUnchanged: true,
    target: targetProfile(target),
    rulesApplied: true,
    excluded: plan.excluded,
    decisions: plan.decisions,
    entries: plan.stagedEntries,
  };
}

export function assertManifestMatchesPlan(manifest, plan, target) {
  const expected = expectedManifest(plan, target);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || JSON.stringify(normalizeJson(manifest)) !== JSON.stringify(normalizeJson(expected))) {
    throw failure("BUILTIN_BUNDLE_MANIFEST_MISMATCH");
  }
  return expected;
}

export async function assertBundleTreeMatchesManifest(root, expectedEntries, expectedTreeSha256) {
  const tree = await inspectBuiltinTree(root);
  if (tree.sha256 !== expectedTreeSha256
    || JSON.stringify(normalizeJson(tree.publicEntries)) !== JSON.stringify(normalizeJson(expectedEntries))) {
    throw failure("BUILTIN_BUNDLE_TREE_MISMATCH");
  }
  return tree;
}

export function assessAppBundleBudget(appBytes, maxAppBytes = null) {
  if (!Number.isSafeInteger(appBytes) || appBytes < 1) throw failure("BUILTIN_BUNDLE_APP_SIZE_UNAVAILABLE");
  if (maxAppBytes !== null && (!Number.isSafeInteger(maxAppBytes) || maxAppBytes < 1)) throw failure("BUILTIN_BUNDLE_BUDGET_INVALID");
  const passed = maxAppBytes === null || appBytes <= maxAppBytes;
  return { passed, reason: passed ? null : "APP_BUNDLE_SIZE_EXCEEDED", appBytes, maxAppBytes };
}

async function currentPlan(repoRoot, target) {
  targetProfile(target);
  const root = path.resolve(repoRoot);
  if (await realpath(root) !== root) throw failure("BUILTIN_BUNDLE_CHECKOUT_UNSAFE");
  const sourceRoot = await assertOwnedPath(root, "resources/plugins/builtin", "directory");
  const plan = await planBuiltinRuntimeStage(sourceRoot, {
    candidateRules,
    target: targetProfile(target),
    applyCandidateRules: true,
    expectedSourceTreeSha256,
  });
  if (plan.source.sha256 !== expectedSourceTreeSha256) throw failure("BUILTIN_BUNDLE_SOURCE_PIN_MISMATCH");
  return { root, sourceRoot, plan };
}

async function readStageManifest(repoRoot, target, stageId, plan) {
  const runId = stageRunId(stageId);
  const stageRelative = `target/builtin-runtime-staging/${runId}/${target}`;
  const stageRoot = await assertOwnedPath(repoRoot, stageRelative, "directory");
  const manifestRelative = `${stageRelative}.manifest.json`;
  const manifestBytes = await readBoundedRegular(repoRoot, manifestRelative, MAX_STAGE_MANIFEST_BYTES);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw failure("BUILTIN_BUNDLE_MANIFEST_INVALID_JSON"); }
  assertManifestMatchesPlan(manifest, plan, target);
  await assertBundleTreeMatchesManifest(stageRoot, plan.stagedEntries, plan.stagedTreeSha256);
  return { manifest, manifestFileSha256: sha256Bytes(manifestBytes), stageRoot, manifestRelative };
}

export function composeNodeRuntimeBundleOverlay(canonicalOverlay, target, stageId, benchmark = false) {
  assertNodeRuntimeOverlay(canonicalOverlay);
  targetProfile(target);
  const runId = stageRunId(stageId);
  const overlay = benchmark ? createNodeRuntimeBenchmarkConfig(canonicalOverlay) : structuredClone(canonicalOverlay);
  const stageFromConfig = `../target/builtin-runtime-staging/${runId}/${target}`;
  const manifestFromConfig = `${stageFromConfig}.manifest.json`;
  overlay.bundle = {
    ...overlay.bundle,
    resources: {
      ...overlay.bundle.resources,
      [BASE_BUILTIN_KEY]: null,
      [`${stageFromConfig}/`]: BUNDLE_DESTINATION,
      [manifestFromConfig]: MANIFEST_DESTINATION,
    },
  };
  assertDestinationSeparation(overlay.bundle.resources);
  if (overlay.bundle.externalBin?.[0] !== "binaries/node" || overlay.bundle.resources[METADATA_KEY] !== METADATA_DESTINATION
    || overlay.bundle.macOS?.minimumSystemVersion !== "11.0") throw failure("BUILTIN_BUNDLE_NODE_CONFIG_CHANGED");
  return overlay;
}

export async function createNodeRuntimeBundleConfig({ repoRoot, target, stageId, canonicalOverlay, benchmark = false }) {
  assertNodeRuntimeOverlay(canonicalOverlay);
  const { root, plan } = await currentPlan(repoRoot, target);
  const runId = stageRunId(stageId);
  const staged = await readStageManifest(root, target, runId, plan);
  const base = JSON.parse((await readBoundedRegular(root, "src-tauri/tauri.conf.json", 1024 * 1024)).toString("utf8"));
  if (base.bundle?.resources?.[BASE_BUILTIN_KEY] !== BUNDLE_DESTINATION || base.bundle?.createUpdaterArtifacts !== true) {
    throw failure("BUILTIN_BUNDLE_BASE_CONFIG_CHANGED");
  }
  const configRoot = path.join(root, "src-tauri");
  const stageFromConfig = path.relative(configRoot, staged.stageRoot).split(path.sep).join("/");
  const manifestFromConfig = path.relative(configRoot, path.join(root, staged.manifestRelative)).split(path.sep).join("/");
  if (stageFromConfig !== `../target/builtin-runtime-staging/${runId}/${target}`
    || manifestFromConfig !== `../target/builtin-runtime-staging/${runId}/${target}.manifest.json`) {
    throw failure("BUILTIN_BUNDLE_RESOURCE_PATH_UNEXPECTED");
  }
  const overlay = composeNodeRuntimeBundleOverlay(canonicalOverlay, target, runId, benchmark);
  const effectiveResources = { ...base.bundle.resources };
  for (const [source, destination] of Object.entries(overlay.bundle.resources)) {
    if (destination === null) delete effectiveResources[source];
    else effectiveResources[source] = destination;
  }
  assertDestinationSeparation(effectiveResources);
  return overlay;
}

export async function verifyPackagedBuiltinRuntime({ appPath, repoRoot, target, maxAppBytes = null, measureApp = () => null }) {
  const { plan } = await currentPlan(repoRoot, target);
  const appRoot = path.resolve(appPath);
  if (await realpath(appRoot) !== appRoot) throw failure("BUILTIN_BUNDLE_APP_ROOT_UNSAFE");
  const appInfo = await lstat(appRoot);
  if (!appInfo.isDirectory() || appInfo.isSymbolicLink()) throw failure("BUILTIN_BUNDLE_APP_INVALID");
  const manifestBytes = await readBoundedRegular(appRoot, "Contents/Resources/builtin-runtime-stage/manifest-v1.json", MAX_STAGE_MANIFEST_BYTES);
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString("utf8")); }
  catch { throw failure("BUILTIN_BUNDLE_MANIFEST_INVALID_JSON"); }
  assertManifestMatchesPlan(manifest, plan, target);
  await assertBundleTreeMatchesManifest(path.join(appRoot, "Contents/Resources/plugins/builtin"), plan.stagedEntries, plan.stagedTreeSha256);
  const appBytes = measureApp(appRoot);
  const budget = assessAppBundleBudget(appBytes, maxAppBytes);
  return {
    passed: budget.passed,
    reason: budget.reason,
    target,
    stageManifestFileSha256: sha256Bytes(manifestBytes),
    sourceManifestSha256: manifest.sourceManifestSha256,
    stagedManifestSha256: manifest.stagedManifestSha256,
    sourceFiles: manifest.sourceFiles,
    stagedFiles: manifest.stagedFiles,
    sourceBytes: manifest.sourceBytes,
    stagedBytes: manifest.stagedBytes,
    appBytes: budget.appBytes,
    maxAppBytes: budget.maxAppBytes,
  };
}

export async function readRuntimeOverlay(repoRoot) {
  return JSON.parse((await readBoundedRegular(repoRoot, "src-tauri/tauri.node-runtime.conf.json", 64 * 1024)).toString("utf8"));
}
