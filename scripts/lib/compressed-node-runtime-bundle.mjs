import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const CONFIG_PROFILE = "src-tauri/tauri.node-runtime-compressed.conf.json";
const RESOURCE_DESTINATION = "node-runtime/compressed/";
const METADATA_DESTINATION = "compressed-runtime.json";
const LICENSE_DESTINATION = "NODE-LICENSE";

const failure = code => Object.assign(new Error(code), { code });
const sameKeys = (value, expected) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");

function checkedTarget(target) {
  if (target !== "aarch64-apple-darwin" && target !== "x86_64-apple-darwin") throw failure("COMPRESSED_RUNTIME_TARGET_INVALID");
  return target;
}

function checkedStageId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value)) throw failure("COMPRESSED_RUNTIME_STAGE_ID_INVALID");
  return value;
}

function checkedProfile(profile, expectedMinimumMacOS) {
  if (!sameKeys(profile, ["bundle"]) || !sameKeys(profile.bundle, ["macOS"])
    || !sameKeys(profile.bundle.macOS, ["minimumSystemVersion"])
    || typeof expectedMinimumMacOS !== "string" || profile.bundle.macOS.minimumSystemVersion !== expectedMinimumMacOS) {
    throw failure("COMPRESSED_RUNTIME_PROFILE_INVALID");
  }
}

function expectedBuiltinResources(stageId, target) {
  return {
    "../resources/plugins/builtin/": null,
    [`../target/builtin-runtime-staging/${stageId}/${target}/`]: "plugins/builtin",
    [`../target/builtin-runtime-staging/${stageId}/${target}.manifest.json`]: "builtin-runtime-stage/manifest-v1.json",
    "binaries/node-runtime-metadata/": "runtime",
  };
}

function assertBuiltinOverlay(overlay, stageId, target, minimumMacOS) {
  if (!sameKeys(overlay, ["bundle"]) || !sameKeys(overlay.bundle, ["externalBin", "resources", "macOS"])) {
    throw failure("COMPRESSED_RUNTIME_BUILTIN_OVERLAY_INVALID");
  }
  if (JSON.stringify(overlay.bundle.externalBin) !== JSON.stringify(["binaries/node"]) || overlay.bundle.macOS?.minimumSystemVersion !== minimumMacOS) {
    throw failure("COMPRESSED_RUNTIME_BUILTIN_OVERLAY_INVALID");
  }
  const expected = expectedBuiltinResources(stageId, target);
  if (!sameKeys(overlay.bundle.resources, Object.keys(expected))) throw failure("COMPRESSED_RUNTIME_BUILTIN_OVERLAY_INVALID");
  for (const [source, destination] of Object.entries(expected)) {
    if (overlay.bundle.resources[source] !== destination) throw failure("COMPRESSED_RUNTIME_BUILTIN_OVERLAY_INVALID");
  }
  return expected;
}

async function assertPayloadDirectory({ repoRoot, target, stageId, payloadDirectory }) {
  checkedTarget(target);
  checkedStageId(stageId);
  if (typeof payloadDirectory !== "string" || !path.isAbsolute(payloadDirectory)) throw failure("COMPRESSED_RUNTIME_PAYLOAD_PATH_INVALID");
  const repository = path.resolve(repoRoot);
  const targetRoot = path.join(repository, "target");
  const payloadRoot = path.join(targetRoot, "node-runtime-compressed", stageId, target);
  const absolute = path.resolve(payloadDirectory);
  const relative = path.relative(payloadRoot, absolute);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !/^\.atools-node-payload-[a-zA-Z0-9_-]+$/u.test(relative)) {
    throw failure("COMPRESSED_RUNTIME_PAYLOAD_PATH_INVALID");
  }
  const repoCanonical = await realpath(repository);
  const targetCanonical = await realpath(targetRoot);
  const payloadCanonical = await realpath(absolute);
  const info = await lstat(absolute);
  if (repoCanonical !== repository || targetCanonical !== targetRoot || payloadCanonical !== absolute || !info.isDirectory() || info.isSymbolicLink()) {
    throw failure("COMPRESSED_RUNTIME_PAYLOAD_PATH_UNSAFE");
  }
  return path.relative(path.join(repository, "src-tauri"), absolute).split(path.sep).join("/");
}

export async function createCompressedNodeRuntimeBundleOverlay({
  repoRoot,
  target,
  stageId,
  payloadDirectory,
  compressedProfile,
  minimumMacOS,
  builtinOverlay,
}) {
  const checked = checkedTarget(target);
  const runId = checkedStageId(stageId);
  checkedProfile(compressedProfile, minimumMacOS);
  const bundledResources = assertBuiltinOverlay(builtinOverlay, runId, checked, minimumMacOS);
  const relativePayload = await assertPayloadDirectory({ repoRoot, target: checked, stageId: runId, payloadDirectory });
  const resources = Object.fromEntries(Object.entries(bundledResources).filter(([source]) => source !== "binaries/node-runtime-metadata/"));
  resources[`${relativePayload}/`] = RESOURCE_DESTINATION;
  if (Object.keys(resources).length !== 4 || Object.values(resources).filter(value => value === RESOURCE_DESTINATION).length !== 1) {
    throw failure("COMPRESSED_RUNTIME_RESOURCE_COLLISION");
  }
  return {
    bundle: {
      resources,
      macOS: { minimumSystemVersion: minimumMacOS },
    },
  };
}

export function compressedRuntimeResourceContract() {
  return {
    directory: RESOURCE_DESTINATION,
    metadata: METADATA_DESTINATION,
    license: LICENSE_DESTINATION,
    filenames: ["node-${target}.gz", METADATA_DESTINATION, LICENSE_DESTINATION],
    profilePath: CONFIG_PROFILE,
  };
}
