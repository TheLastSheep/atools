import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  link,
  open,
  readdir,
  realpath,
  rmdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const FIXTURE_OWNER = "@atools/fallback-settings-native-fixture";
export const OUTPUT_RELATIVE = "output/fallback-settings-native-dist";
export const BASE_PATH = "/fallback-settings/";
export const RESOURCE_LIMITS = Object.freeze({
  files: 64,
  fileBytes: 1024 * 1024,
  totalBytes: 2 * 1024 * 1024,
});
export const SOURCE_LIMITS = Object.freeze({
  files: 512,
  pathBytes: 4096,
  pathDepth: 8,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  metadataBytes: 256 * 1024,
});

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const ENTRY_PATH = resolve(REPOSITORY_ROOT, "tests/components/fallback-settings-native.html");
const SOURCE_ROOT = resolve(REPOSITORY_ROOT, "src");
const SOURCE_CANDIDATE_LIMITS = Object.freeze({ files: 4096, totalBytes: 48 * 1024 * 1024 });
const REQUIRED_SOURCE_PATHS = [
  "tests/components/fallback-settings-native.html",
  "tests/components/fallbackSettingsNativeFixture.ts",
  "tests/components/fallbackSettingsNativeReadiness.ts",
  "scripts/build-fallback-settings-native.mjs",
  "vite.config.ts",
  "svelte.config.js",
  "tsconfig.json",
  "package.json",
  "pnpm-lock.yaml",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function comparePath(left, right) {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function checkedEntries(entries, label, limits = SOURCE_LIMITS) {
  if (!Array.isArray(entries)) throw new Error(`${label} must be an array`);
  const normalized = entries.map(entry => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || typeof entry.path !== "string" || !entry.path || entry.path.includes("\\")
      || isAbsolute(entry.path) || entry.path.split("/").some(part => !part || part === "." || part === "..")
      || Buffer.byteLength(entry.path, "utf8") > limits.pathBytes
      || entry.path.split("/").length > limits.pathDepth
      || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
      || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`${label} contains an invalid entry`);
    }
    return { path: entry.path, sha256: entry.sha256, bytes: entry.bytes };
  }).sort(comparePath);
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index - 1].path === normalized[index].path) {
      throw new Error(`${label} contains a duplicate path`);
    }
  }
  return normalized;
}

function assertSourceBudget(sources) {
  if (sources.length > SOURCE_LIMITS.files) throw new Error("Fallback settings source count is outside its limit");
  let totalBytes = 0;
  for (const source of sources) {
    if (source.bytes > SOURCE_LIMITS.fileBytes) throw new Error("Fallback settings source exceeds the file limit");
    totalBytes += source.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SOURCE_LIMITS.totalBytes) {
      throw new Error("Fallback settings sources exceed the total limit");
    }
  }
  return totalBytes;
}

function assertMetadataBudget(provenance) {
  const bytes = Buffer.byteLength(`${JSON.stringify(provenance, null, 2)}\n`, "utf8");
  if (bytes > SOURCE_LIMITS.metadataBytes) throw new Error("Fallback settings provenance exceeds the metadata limit");
}

export function manifestDigest(entries) {
  return sha256(JSON.stringify(entries));
}

export function assertResourceBudget(resources, limits = RESOURCE_LIMITS) {
  if (!Array.isArray(resources) || resources.length === 0 || resources.length > limits.files) {
    throw new Error("Fallback settings resource count is outside its limit");
  }
  let totalBytes = 0;
  for (const resource of resources) {
    if (resource.bytes > limits.fileBytes) throw new Error("Fallback settings resource exceeds the file limit");
    totalBytes += resource.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.totalBytes) {
      throw new Error("Fallback settings resources exceed the total limit");
    }
  }
  return totalBytes;
}

export function createProvenance(sources, resources) {
  const sortedSources = checkedEntries(sources, "sources");
  assertSourceBudget(sortedSources);
  const sortedResources = checkedEntries(resources, "resources");
  const resourceBytes = assertResourceBudget(sortedResources);
  if (!sortedResources.some(resource => resource.path === "index.html")) {
    throw new Error("Fallback settings output is missing index.html");
  }
  if (sortedResources.some(resource => resource.path !== "index.html" && !resource.path.startsWith("assets/"))) {
    throw new Error("Fallback settings output contains a resource outside assets/");
  }
  const provenance = {
    schemaVersion: 1,
    owner: FIXTURE_OWNER,
    sources: sortedSources,
    sourceSha256: manifestDigest(sortedSources),
    resources: sortedResources,
    resourceSha256: manifestDigest(sortedResources),
    resourceBytes,
    resourceCount: sortedResources.length,
  };
  assertMetadataBudget(provenance);
  return provenance;
}

async function readRegularFile(path, root) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected a regular source/resource file: ${path}`);
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) throw new Error(`Source/resource changed type while opening: ${path}`);
    const bytes = await handle.readFile();
    const relativePath = relative(root, path);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`Source/resource escaped its root: ${path}`);
    }
    return { path: relativePath.split(sep).join("/"), sha256: sha256(bytes), bytes: bytes.length };
  } finally {
    await handle.close();
  }
}

async function walkRegularFiles(root, directory = root, entries = []) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Expected a non-symlink directory: ${directory}`);
  for (const name of (await readdir(directory)).sort()) {
    const path = join(directory, name);
    const child = await lstat(path);
    if (child.isSymbolicLink()) throw new Error(`Symlinks are not allowed in fixture sources/resources: ${path}`);
    if (child.isDirectory()) await walkRegularFiles(root, path, entries);
    else if (child.isFile()) entries.push(path);
    else throw new Error(`Unexpected filesystem entry in fixture source/resource tree: ${path}`);
  }
  return entries;
}

export async function readResourceManifest(outputRoot) {
  const rootInfo = await lstat(outputRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new Error("Fallback settings output root must be a non-symlink directory");
  }
  const files = await walkRegularFiles(outputRoot);
  const entries = [];
  for (const path of files) {
    const entry = await readRegularFile(path, outputRoot);
    if (entry.path !== "index.html" && !entry.path.startsWith("assets/")) {
      throw new Error(`Unexpected fallback settings output path: ${entry.path}`);
    }
    entries.push(entry);
  }
  const resources = checkedEntries(entries, "resources");
  assertResourceBudget(resources);
  if (!resources.some(resource => resource.path === "index.html")) {
    throw new Error("Fallback settings output is missing index.html");
  }
  return resources;
}

async function sourceCandidates() {
  const candidates = new Map();
  const paths = await walkRegularFiles(SOURCE_ROOT);
  for (const relativePath of REQUIRED_SOURCE_PATHS) {
    const path = resolve(REPOSITORY_ROOT, relativePath);
    if (!path.startsWith(`${REPOSITORY_ROOT}${sep}`)) throw new Error("Fixture source escaped the repository root");
    try {
      await lstat(path);
    } catch (error) {
      if (relativePath === "svelte.config.js" && error?.code === "ENOENT") continue;
      throw error;
    }
    paths.push(path);
  }
  const uniquePaths = [...new Set(paths)].sort();
  if (uniquePaths.length > SOURCE_CANDIDATE_LIMITS.files) throw new Error("Fixture source candidate count exceeded its limit");
  let totalBytes = 0;
  for (const path of uniquePaths) {
    const entry = await readRegularFile(path, REPOSITORY_ROOT);
    totalBytes += entry.bytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > SOURCE_CANDIDATE_LIMITS.totalBytes) {
      throw new Error("Fixture source candidates exceeded their byte limit");
    }
    candidates.set(entry.path, entry);
  }
  return candidates;
}

function makeSourceCollector(root) {
  const paths = new Set();
  function record(id) {
    if (typeof id !== "string" || id.startsWith("\0") || id.startsWith("virtual:")) return;
    let fileId = id.split("?")[0];
    if (fileId.startsWith("file:")) {
      try { fileId = fileURLToPath(fileId); } catch { return; }
    }
    if (!isAbsolute(fileId)) return;
    const absolute = resolve(fileId);
    const relativePath = relative(root, absolute);
    if (!relativePath || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) return;
    const parts = relativePath.split(sep);
    if (parts.includes("node_modules") || parts[0] === "output") return;
    paths.add(parts.join("/"));
  }
  return {
    paths,
    plugin: {
      name: "atools-fallback-settings-source-closure",
      enforce: "post",
      transform(_code, id) {
        record(id);
        return null;
      },
      generateBundle() {
        for (const id of this.getModuleIds()) record(id);
        for (const file of this.getWatchFiles()) record(file);
      },
    },
  };
}

async function outputDirectory() {
  const parent = resolve(REPOSITORY_ROOT, "output");
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || await realpath(parent) !== parent) {
    throw new Error("Fallback settings output parent is not a real repository output directory");
  }
  const output = resolve(REPOSITORY_ROOT, OUTPUT_RELATIVE);
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(output) !== output) {
      throw new Error("Fallback settings output path must be a real directory, not a symlink");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return output;
}

async function assertOutputDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Fallback settings entry directory is not a real directory: ${path}`);
  }
}

export async function normalizeFixtureEntryHtml(outputRoot) {
  const root = resolve(outputRoot);
  await assertOutputDirectory(root);
  const generatedEntry = join(root, "tests", "components", "fallback-settings-native.html");
  await assertOutputDirectory(join(root, "tests"));
  await assertOutputDirectory(join(root, "tests", "components"));
  const entry = await readRegularFile(generatedEntry, root);
  if (entry.path !== "tests/components/fallback-settings-native.html") {
    throw new Error("Fallback settings build emitted an unexpected entry path");
  }
  const indexPath = join(root, "index.html");
  try {
    await lstat(indexPath);
    throw new Error("Fallback settings build already contains index.html");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await link(generatedEntry, indexPath);
  try {
    await unlink(generatedEntry);
  } catch (error) {
    await unlink(indexPath).catch(() => undefined);
    throw error;
  }
  for (const relativePath of ["tests/components", "tests"]) {
    const directory = join(root, relativePath);
    try {
      await assertOutputDirectory(directory);
      await rmdir(directory);
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" && error?.code !== "EEXIST") throw error;
    }
  }
}

async function buildFallbackSettings() {
  const output = await outputDirectory();
  const beforeCandidates = await sourceCandidates();
  const collector = makeSourceCollector(REPOSITORY_ROOT);
  const { build } = await import("vite");
  await build({
    configFile: resolve(REPOSITORY_ROOT, "vite.config.ts"),
    root: REPOSITORY_ROOT,
    base: BASE_PATH,
    publicDir: false,
    clearScreen: false,
    plugins: [collector.plugin],
    build: {
      outDir: output,
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: { input: { index: ENTRY_PATH } },
    },
  });
  await normalizeFixtureEntryHtml(output);

  const sourcePaths = [...new Set([
    ...REQUIRED_SOURCE_PATHS.filter(path => beforeCandidates.has(path)),
    ...collector.paths,
  ])].sort();
  if (sourcePaths.length > SOURCE_LIMITS.files) throw new Error("Fallback settings source closure exceeded its file limit");
  const sources = [];
  for (const path of sourcePaths) {
    const before = beforeCandidates.get(path);
    if (!before) throw new Error(`Vite used an unbounded or uncaptured repository source: ${path}`);
    const after = await readRegularFile(resolve(REPOSITORY_ROOT, path), REPOSITORY_ROOT);
    if (before.bytes !== after.bytes || before.sha256 !== after.sha256) {
      throw new Error(`Fixture source changed during its build: ${path}`);
    }
    sources.push(before);
  }

  const resources = await readResourceManifest(output);
  const provenance = createProvenance(sources, resources);
  const manifestPath = join(output, "build-provenance.json");
  const temporaryManifestPath = `${manifestPath}.tmp-${process.pid}`;
  await writeFile(temporaryManifestPath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: "wx" });
  await rename(temporaryManifestPath, manifestPath);
  return provenance;
}

async function removeOwnedOutput() {
  const output = resolve(REPOSITORY_ROOT, OUTPUT_RELATIVE);
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isDirectory() || await realpath(output) !== output) return;
    await rm(output, { recursive: true, force: true });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function runBuild() {
  try {
    return await buildFallbackSettings();
  } catch (error) {
    await removeOwnedOutput();
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = await runBuild();
    process.stdout.write(`${JSON.stringify({
      owner: result.owner,
      output: OUTPUT_RELATIVE,
      resourceCount: result.resourceCount,
      resourceBytes: result.resourceBytes,
      sourceCount: result.sources.length,
      sourceSha256: result.sourceSha256,
      resourceSha256: result.resourceSha256,
    })}\n`);
  } catch (error) {
    process.stderr.write(`fallback-settings-native build failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
