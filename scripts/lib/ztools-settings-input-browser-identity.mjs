import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";

import { captureHostBridgeSources } from "../../packages/ztools-settings/src/host-bridge-build.mjs";

const PINNED_ZTOOLS_COMMIT = "9b15fb1a2a9f3ec886016632761c7bb21e39557a";
const PINNED_ZTOOLS_ROOT = "/Users/harris/Desktop/ZTools";
const MAIN_SOURCE_ROOT = "packages/ztools-renderer/src";
const SETTINGS_SOURCE_ROOT = "packages/ztools-settings/src";
const NON_RUNTIME_DIST_FILES = new Set([
  "build-provenance.json", "source-manifest.json", "upstream-package.json", "ZTools-LICENSE",
  "plugin.json", "preload/package.json",
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashTree(root) {
  const files = {};
  let bytes = 0;
  let exists = true;

  async function walk(directory) {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink is not allowed in identity tree: ${absolute}`);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const content = await readFile(absolute);
        const path = relative(root, absolute).split(sep).join("/");
        files[path] = { bytes: content.byteLength, sha256: sha256(content) };
        bytes += content.byteLength;
      } else {
        throw new Error(`Unsupported identity entry: ${absolute}`);
      }
    }
  }

  try {
    await walk(root);
  } catch (error) {
    if (error?.code === "ENOENT") exists = false;
    else throw error;
  }
  const digest = createHash("sha256");
  for (const [path, file] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(path).update("\0").update(String(file.bytes)).update("\0").update(file.sha256).update("\0");
  }
  return { exists, count: Object.keys(files).length, bytes, sha256: digest.digest("hex"), files };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function hashTrackedInputs(root, paths) {
  const digest = createHash("sha256");
  let bytes = 0;
  const sorted = [...new Set(paths)].sort();
  for (const path of sorted) {
    const absolute = join(root, path);
    const metadata = await lstat(absolute);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`Pinned source input is not a regular file: ${path}`);
    const resolved = await realpath(absolute);
    const relativePath = relative(root, resolved);
    if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
      throw new Error(`Pinned source input escaped its checkout: ${path}`);
    }
    const content = await readFile(absolute);
    digest.update(path.split(sep).join("/")).update("\0").update(content).update("\0");
    bytes += content.byteLength;
  }
  return { sha256: digest.digest("hex"), files: sorted.length, bytes, paths: sorted };
}

async function capturePinnedUpstream() {
  const root = await realpath(PINNED_ZTOOLS_ROOT);
  if (root !== PINNED_ZTOOLS_ROOT || git(root, ["rev-parse", "--show-toplevel"]) !== root) {
    throw new Error("Pinned ZTools path must be the canonical repository root");
  }
  const commit = git(root, ["rev-parse", "HEAD"]);
  const dirty = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const rendererPaths = git(root, ["ls-files", "-z", "--", "src/renderer", "src/shared", "LICENSE", "package.json", "pnpm-lock.yaml"])
    .split("\0").filter(Boolean);
  const settingsPaths = git(root, ["ls-files", "-z", "--", "internal-plugins/setting", "src/shared", "package.json", "pnpm-lock.yaml", "LICENSE"])
    .split("\0").filter(Boolean);
  if (!rendererPaths.includes("src/renderer/index.html") || !rendererPaths.includes("src/renderer/src/main.ts")) {
    throw new Error("Pinned Main renderer tracked input set is incomplete");
  }
  if (!settingsPaths.includes("internal-plugins/setting/index.html") ||
      !settingsPaths.includes("internal-plugins/setting/package.json")) {
    throw new Error("Pinned Settings tracked input set is incomplete");
  }
  const renderer = await hashTrackedInputs(root, rendererPaths);
  const settings = await hashTrackedInputs(root, settingsPaths);
  return { root, commit, dirty, renderer, settings };
}

async function sourceTsFiles(root, sourceRoot, pathPrefix = sourceRoot, extensions = [".ts"]) {
  const tree = await hashTree(join(root, sourceRoot));
  return Object.entries(tree.files).filter(([path]) => extensions.some(extension => path.endsWith(extension)))
    .map(([path, file]) => ({ path: `${pathPrefix}/${path}`, ...file }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function exactFileList(files) {
  return files.map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
}

export async function captureZtoolsSettingsInputIdentity({ root, authoredFiles }) {
  const rendererDist = await hashTree(join(root, "packages/ztools-renderer/dist"));
  const settingsDist = await hashTree(join(root, "packages/ztools-settings/dist"));
  const rendererManifest = await readJson(join(root, "packages/ztools-renderer/source-manifest.json"));
  const settingsManifest = await readJson(join(root, "packages/ztools-settings/source-manifest.json"));
  let rendererProvenance = null;
  let settingsProvenance = null;
  let rendererProvenanceError = null;
  let settingsProvenanceError = null;
  try { rendererProvenance = await readJson(join(root, "packages/ztools-renderer/dist/build-provenance.json")); }
  catch (error) { rendererProvenanceError = String(error.message || error); }
  try { settingsProvenance = await readJson(join(root, "packages/ztools-settings/dist/build-provenance.json")); }
  catch (error) { settingsProvenanceError = String(error.message || error); }

  const rendererSources = await sourceTsFiles(root, MAIN_SOURCE_ROOT, "src", [".ts", ".mjs"]);
  const helperPath = "upstream-compatibility-patches.mjs";
  const helperBytes = await readFile(join(root, "packages/ztools-renderer", helperPath));
  rendererSources.push({ path: helperPath, bytes: helperBytes.byteLength, sha256: sha256(helperBytes) });
  rendererSources.sort((left, right) => left.path.localeCompare(right.path));
  const settingsBridge = await captureHostBridgeSources(root);
  const settingsSources = await sourceTsFiles(root, SETTINGS_SOURCE_ROOT);
  let upstream = null;
  let upstreamError = null;
  try { upstream = await capturePinnedUpstream(); }
  catch (error) { upstreamError = String(error.message || error); }
  const ownFiles = {};
  for (const path of authoredFiles) {
    const bytes = await readFile(path);
    ownFiles[relative(root, path).split(sep).join("/")] = { bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  return {
    renderer: {
      dist: rendererDist,
      manifestSha256: sha256(await readFile(join(root, "packages/ztools-renderer/source-manifest.json"))),
      provenance: rendererProvenance,
      provenanceError: rendererProvenanceError,
      manifest: rendererManifest,
      sources: { count: rendererSources.length, sha256: sha256(Buffer.from(JSON.stringify(rendererSources))), files: rendererSources },
    },
    settings: {
      dist: settingsDist,
      manifestSha256: sha256(await readFile(join(root, "packages/ztools-settings/source-manifest.json"))),
      provenance: settingsProvenance,
      provenanceError: settingsProvenanceError,
      manifest: settingsManifest,
      bridge: {
        count: settingsBridge.count,
        bytes: settingsBridge.bytes,
        sha256: settingsBridge.sha256,
        files: exactFileList(settingsBridge.files),
      },
      sources: { count: settingsSources.length, sha256: sha256(Buffer.from(JSON.stringify(settingsSources))), files: settingsSources },
    },
    upstream,
    upstreamError,
    authoredFiles: ownFiles,
  };
}

function canonicalFileSet(files) {
  if (!Array.isArray(files)) return null;
  const seen = new Set();
  const tuples = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || !file.path || seen.has(file.path) ||
        !Number.isSafeInteger(file.bytes) || file.bytes < 0 ||
        typeof file.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(file.sha256)) return null;
    seen.add(file.path);
    tuples.push([file.path, file.bytes, file.sha256]);
  }
  tuples.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return JSON.stringify(tuples);
}

function fileSetMatches(actual, declared) {
  const actualCanonical = canonicalFileSet(actual);
  const declaredCanonical = canonicalFileSet(declared);
  return actualCanonical !== null && declaredCanonical !== null && actualCanonical === declaredCanonical;
}

function assertFileSetMatcherBehavior() {
  const actual = [{ path: "src/a.ts", bytes: 1, sha256: "a".repeat(64) }];
  const upstreamOrder = [{ sha256: "a".repeat(64), path: "src/a.ts", bytes: 1 }];
  if (!fileSetMatches(actual, upstreamOrder) || fileSetMatches([...actual, ...actual], upstreamOrder)) {
    throw new Error("Source file-set comparison must ignore object key order and reject duplicate paths");
  }
}

function runtimeReferences(content, kind) {
  const values = [];
  if (kind === "html") {
    for (const match of content.matchAll(/(?:src|href)=["']([^"']+)["']/gi)) values.push(match[1]);
  } else if (kind === "javascript") {
    for (const match of content.matchAll(/\b(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']/g)) values.push(match[1]);
    for (const match of content.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) values.push(match[1]);
  } else if (kind === "css") {
    for (const match of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) values.push(match[1]);
  }
  return values.filter((value) => value && !value.startsWith("data:") && !value.startsWith("#"));
}

async function runtimeClosure(distRoot, tree) {
  const files = new Set(Object.keys(tree.files));
  const visited = new Set();
  const errors = [];
  const queue = ["index.html"];
  while (queue.length) {
    const current = queue.shift();
    if (visited.has(current)) continue;
    visited.add(current);
    if (!files.has(current)) {
      errors.push(`dist reference is missing: ${current}`);
      continue;
    }
    const extension = current.split(".").at(-1).toLowerCase();
    const kind = current === "index.html" ? "html" : extension === "js" ? "javascript" : extension === "css" ? "css" : "other";
    if (kind === "other") continue;
    const content = await readFile(join(distRoot, current), "utf8");
    for (const reference of runtimeReferences(content, kind)) {
      if (/^(?:https?:)?\/\//i.test(reference)) {
        errors.push(`external module/asset reference is not allowed: ${current} -> ${reference}`);
        continue;
      }
      const resolved = new URL(reference, `https://identity.invalid/${current}`).pathname.slice(1);
      if (resolved.startsWith("../") || resolved.includes("/../")) {
        errors.push(`dist reference escapes bundle root: ${current} -> ${reference}`);
      } else {
        queue.push(resolved);
      }
    }
  }
  return { count: visited.size, files: [...visited].sort(), errors };
}

export async function validateZtoolsSettingsInputIdentity({ root, identity }) {
  assertFileSetMatcherBehavior();
  const errors = [];
  const main = identity.renderer;
  const child = identity.settings;
  const mainProv = main.provenance;
  const childProv = child.provenance;
  const upstream = identity.upstream;
  if (!upstream) errors.push(identity.upstreamError || "Pinned ZTools upstream checkout is unavailable");
  else {
    if (upstream.root !== PINNED_ZTOOLS_ROOT || upstream.commit !== PINNED_ZTOOLS_COMMIT || upstream.dirty !== "") {
      errors.push("Pinned ZTools checkout is not at the exact clean source commit");
    }
    if (mainProv?.sourceTreeSha256 !== upstream.renderer.sha256 || mainProv?.sourceFiles !== upstream.renderer.files) {
      errors.push("Main renderer sourceTreeSha256 does not match recomputed pinned renderer inputs");
    }
    if (childProv?.source?.inputSha256 !== upstream.settings.sha256 || childProv?.source?.inputFiles !== upstream.settings.files ||
        childProv?.source?.inputBytes !== upstream.settings.bytes) {
      errors.push("Settings source input hash/count/bytes do not match recomputed pinned setting inputs");
    }
  }

  if (!main.dist.exists || !main.dist.files["index.html"]) errors.push("Main renderer dist/index.html is missing");
  if (!mainProv) errors.push(main.provenanceError || "Main renderer build provenance is missing");
  if (mainProv?.sourceCommit !== PINNED_ZTOOLS_COMMIT || main.manifest?.source?.commit !== PINNED_ZTOOLS_COMMIT) {
    errors.push("Main renderer provenance/source manifest is not pinned to the required ZTools commit");
  }
  if (JSON.stringify(main.manifest?.build?.hostAdapterSourceExtensions) !== JSON.stringify([".ts", ".mjs"])) {
    errors.push("Main source manifest must bind TypeScript adapters and JavaScript compatibility helpers");
  }
  if (JSON.stringify(main.manifest?.build?.hostBuildHelperModules) !== JSON.stringify(["upstream-compatibility-patches.mjs"])) {
    errors.push("Main source manifest must bind the reviewed root compatibility helper");
  }
  if (!fileSetMatches(main.sources.files, mainProv?.hostAdapterSources || [])) {
    errors.push("Main renderer dist hostAdapterSources do not match current package TypeScript/JavaScript sources");
  }
  if (!child.dist.exists || !child.dist.files["index.html"]) errors.push("Settings dist/index.html is missing");
  if (childProv?.status !== "strict/typecheck-passed" || childProv?.typecheckPassed !== true) {
    errors.push("Settings dist is not a successful strict/typecheck artifact");
  }
  if (childProv?.source?.commit !== PINNED_ZTOOLS_COMMIT || child.manifest?.source?.commit !== PINNED_ZTOOLS_COMMIT) {
    errors.push("Settings provenance/source manifest is not pinned to the required ZTools commit");
  }
  const declaredBridge = childProv?.build?.hostBridgeSources;
  if (!declaredBridge || declaredBridge.count !== child.bridge.count || declaredBridge.bytes !== child.bridge.bytes ||
      declaredBridge.sha256 !== child.bridge.sha256 || !fileSetMatches(child.bridge.files, declaredBridge.files || [])) {
    errors.push("Settings dist hostBridgeSources do not match current child bridge sources");
  }
  for (const required of ["childBridgeAliases.ts", "childBridgeCommandData.ts", "childBridgeCommandSettings.ts", "childBridgeInput.ts", "hostBridgeEntry.ts"]) {
    if (!declaredBridge?.runtimeImports?.some((path) => path.endsWith(`/${required}`))) {
      errors.push(`Settings dist runtime module closure is missing ${required}`);
    }
  }
  const runtimeClosures = {};
  for (const [label, directory, tree] of [
    ["Main renderer", join(root, "packages/ztools-renderer/dist"), main.dist],
    ["Settings", join(root, "packages/ztools-settings/dist"), child.dist],
  ]) {
    if (!tree.exists || !tree.files["index.html"]) continue;
    const closure = await runtimeClosure(directory, tree);
    if (closure.errors.length) errors.push(...closure.errors.map((error) => `${label} ${error}`));
    runtimeClosures[label] = closure;
  }
  const paths = {};
  for (const [prefix, tree] of [["main", main.dist], ["setting", child.dist]]) {
    paths[prefix] = Object.keys(tree.files).filter((path) => {
      if (NON_RUNTIME_DIST_FILES.has(path)) return false;
      return path === "index.html" || /\.(?:js|mjs|css|png|jpe?g|webp|svg|gif|ico|woff2?|ttf|wasm)$/i.test(path);
    }).sort();
  }
  return { errors, servedPaths: paths, runtimeClosures };
}

