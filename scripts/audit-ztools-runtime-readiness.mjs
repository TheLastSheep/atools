#!/usr/bin/env node
// Static inventory only: never imports, evaluates, installs, or builds a plugin.
import fs from "node:fs";
import path from "node:path";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";

const DEFAULT_SOURCE = fileURLToPath(new URL("../ZTools-plugins/plugins", import.meta.url));
const MANIFEST_CANDIDATES = [
  "plugin.json", "dist/plugin.json", "public/plugin.json",
  "app/plugin.json", "src/plugin.json", "plugin/plugin.json",
];
// These are the paths recognized by crates/atools-plugin/src/loader.rs.
const HOST_MANIFEST_CANDIDATES = [
  "plugin.json", "public/plugin.json", "dist/plugin.json",
  "src/plugin.json", "app/plugin.json", "plugin/plugin.json",
];
const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));
const NATIVE_PACKAGES = new Set([
  "sharp", "better-sqlite3", "sqlite3", "canvas", "ffi-napi",
  "node-pty", "keytar", "wallpaper-setter",
]);
const LIMITS = { filesPerPlugin: 2000, moduleDepth: 16, modules: 200, sourceBytes: 2_000_000 };

function sortedEntries(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function isFile(filename) {
  try { return fs.statSync(filename).isFile(); }
  catch { return false; }
}

function inside(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || (!relative.startsWith(`..${path.sep}`)
    && relative !== ".." && !path.isAbsolute(relative));
}

function pluginFiles(directory, files = []) {
  for (const entry of sortedEntries(directory)) {
    if (files.length >= LIMITS.filesPerPlugin) break;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const filename = path.join(directory, entry.name);
    // Dirent.isDirectory does not follow directory symlinks.
    if (entry.isDirectory()) pluginFiles(filename, files);
    else files.push(filename);
  }
  return files;
}

function resolveLocalModule(parent, request) {
  const target = path.resolve(path.dirname(parent), request);
  return [target, `${target}.js`, `${target}.cjs`, `${target}.json`,
    path.join(target, "index.js"), path.join(target, "index.cjs")].find(isFile);
}

function scanPreloadGraph(pluginDir, preload) {
  const physicalRoot = fs.realpathSync(pluginDir);
  const visited = new Set();
  const requires = new Set();
  const external = new Set();
  const missing = new Set();
  let nativeReference = false;
  let usesProcess = false;

  function visit(filename, depth = 0) {
    if (depth > LIMITS.moduleDepth || visited.size >= LIMITS.modules
      || visited.has(filename) || !inside(pluginDir, filename)
      || !inside(physicalRoot, fs.realpathSync(filename))
      || fs.statSync(filename).size > LIMITS.sourceBytes) return;
    visited.add(filename);
    const source = fs.readFileSync(filename, "utf8");
    nativeReference ||= /require\s*\([^;\n]{0,400}\.node['"`]/.test(source);
    usesProcess ||= /\bprocess\.|__dirname|__filename/.test(source);
    // A reproducible heuristic, not a JavaScript parser. See report.scope.
    for (const match of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const request = match[1];
      if (request.startsWith(".")) {
        const next = resolveLocalModule(filename, request);
        if (next) visit(next, depth + 1);
        else missing.add(request);
      } else if (request.startsWith("node:") || BUILTINS.has(request) || request === "electron") {
        requires.add(request);
      } else {
        external.add(request);
      }
    }
  }
  if (preload) visit(preload);
  return {
    requires: [...requires].sort(),
    externalRequires: [...external].sort(),
    localModuleCount: visited.size,
    missingRelativeModules: [...missing].sort(),
    nativeAddonReference: nativeReference,
    usesProcess,
  };
}

function tierFor(record) {
  if (!record.entryReady) return "entry_missing";
  if (!record.macSupported) return "platform_unsupported";
  if (record.nativeAddonReference || record.nativeAddonFiles.length
    || record.nativeDependencyPackages.length) return "native_addon_or_dependency";
  if (record.nodeRequired) return "node_preload";
  return record.preload ? "web_preload" : "web_only";
}

function inspectPlugin(root, id, inventory) {
  const pluginDir = path.join(root, id);
  const files = pluginFiles(pluginDir);
  const hostManifest = HOST_MANIFEST_CANDIDATES
    .map((relative) => path.join(pluginDir, relative)).find(isFile);
  if (hostManifest) inventory.hostManifestCandidates++;
  const manifestPath = MANIFEST_CANDIDATES
    .map((relative) => path.join(pluginDir, relative)).find(isFile)
    ?? files.find((filename) => path.basename(filename) === "plugin.json" && isFile(filename));
  if (!manifestPath) return { id, status: "missing_manifest" };
  if (!hostManifest) inventory.deepManifestFallbacks.push({ id, manifest: path.relative(root, manifestPath) });

  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const manifestDir = path.dirname(manifestPath);
    const mainRemote = /^https?:\/\//i.test(manifest.main || "");
    const main = manifest.main && [path.resolve(manifestDir, manifest.main),
      path.resolve(pluginDir, manifest.main)].find(isFile);
    // Preserve the original audit's root-first preload resolution.
    const preload = manifest.preload && [path.resolve(pluginDir, manifest.preload),
      path.resolve(manifestDir, manifest.preload)].find(isFile);
    const graph = scanPreloadGraph(pluginDir, preload);
    const nativeAddonFiles = files.filter((filename) => filename.endsWith(".node"))
      .map((filename) => path.relative(pluginDir, filename));
    const platforms = Array.isArray(manifest.platform) ? manifest.platform : [];
    const macSupported = platforms.length === 0
      || platforms.some((platform) => platform === "darwin" || platform === "macos");
    const nativeDependencyPackages = graph.externalRequires.filter((name) =>
      NATIVE_PACKAGES.has(name) || name.startsWith("@napi-rs/"));
    const record = {
      id,
      name: manifest.name,
      manifest: path.relative(root, manifestPath),
      main: manifest.main || null,
      mainExists: Boolean(main),
      mainRemote,
      headless: !manifest.main,
      preload: manifest.preload || null,
      preloadExists: Boolean(preload),
      macSupported,
      entryReady: (!manifest.main || mainRemote || Boolean(main)) && (!manifest.preload || Boolean(preload)),
      nodeRequired: graph.requires.length > 0 || graph.externalRequires.length > 0
        || graph.usesProcess || String(manifest.preload || "").endsWith(".cjs"),
      requires: graph.requires,
      externalRequires: graph.externalRequires,
      localModuleCount: graph.localModuleCount,
      missingRelativeModules: graph.missingRelativeModules,
      nativeAddonReference: graph.nativeAddonReference,
      nativeAddonFiles,
      nativeDependencyPackages,
    };
    record.tier = tierFor(record);
    return record;
  } catch (error) {
    inventory.invalidManifests++;
    return { id, status: "invalid_manifest", error: error.message };
  }
}

export function buildZToolsRuntimeReadinessReport(source = DEFAULT_SOURCE, options = {}) {
  const root = path.resolve(source);
  const inventory = { hostManifestCandidates: 0, deepManifestFallbacks: [], invalidManifests: 0 };
  const records = sortedEntries(root).filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => inspectPlugin(root, entry.name, inventory));
  const valid = records.filter((record) => !record.status);
  const count = (predicate) => valid.filter(predicate).length;
  const tiers = {};
  for (const record of valid) tiers[record.tier] = (tiers[record.tier] || 0) + 1;
  return {
    schema_version: 1,
    generatedAt: options.generatedAt || new Date().toISOString(),
    source: root,
    scope: [
      "One row per current immediate plugin directory; static requirements only, never launch success.",
      "The original 2026-10-15 snapshot has 179 host manifest candidates and 180 rows because ctool has only a deeper manifest; inventory records this distinction dynamically.",
      "Manifest selection prefers plugin.json, dist, public, app, src, plugin, then the first deterministic recursive fallback. This is discovery, not host installability.",
      "Entry readiness checks declared main/preload files only; missing main means headless, HTTP(S) main is accepted without fetching, and secondary UI assets are not validated.",
      "macSupported means platform is absent/empty or declares darwin/macos; it does not validate macOS runtime APIs or native ABI.",
      "Node requirement is a heuristic over local literal CommonJS requires, process/__dirname/__filename references, or a .cjs preload; comments/strings may overcount, computed imports/ESM/package dependencies may be missed.",
      `Graph limits: depth ${LIMITS.moduleDepth}, ${LIMITS.modules} source modules, ${LIMITS.sourceBytes} bytes per source, ${LIMITS.filesPerPlugin} enumerated files per plugin; hidden entries and node_modules are skipped, preload graph source symlinks outside the plugin are not read.`,
      "Local require resolution tries exact/.js/.cjs/.json/index.js/index.cjs only; it does not resolve package.json main or node_modules, execute preload, install dependencies, or build plugins.",
      "Native requirements combine literal require(... .node) calls, bundled .node filenames outside node_modules, and selected known native package names; this is a lower-bound inventory, not an ABI check.",
      "Exclusive tier priority is entry_missing, platform_unsupported, native_addon_or_dependency, node_preload, web_preload, web_only; requirements such as Node/native may overlap outside the tier totals.",
      "macEntryReadyWithoutAddon excludes detected native requirements only; missing relative modules, unsupported host APIs, network resources, and graph truncation can still prevent execution.",
    ].join(" "),
    inventory,
    summary: {
      pluginDirectories: records.length,
      recognizedPlugins: valid.length,
      missingManifest: records.filter((record) => record.status === "missing_manifest").length,
      entryReady: count((record) => record.entryReady),
      headless: count((record) => record.headless),
      macSupported: count((record) => record.macSupported),
      nodeRequiredTransitive: count((record) => record.nodeRequired),
      localModuleGraphs: count((record) => record.localModuleCount > 1),
      nativeAddonReference: count((record) => record.nativeAddonReference),
      withBundledAddonOutsideNodeModules: count((record) => record.nativeAddonFiles.length > 0),
      macEntryReadyWithoutAddon: count((record) => record.macSupported && record.entryReady
        && !record.nativeAddonReference && !record.nativeAddonFiles.length && !record.nativeDependencyPackages.length),
      tiers,
      nativeDependencyPackages: count((record) => record.nativeDependencyPackages.length > 0),
    },
    records,
  };
}

function main(args) {
  let source = DEFAULT_SOURCE;
  let output;
  let generatedAt;
  let json = false;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--help" || flag === "-h") {
      console.log("Usage: node scripts/audit-ztools-runtime-readiness.mjs [--source DIR] [--output FILE] [--generated-at ISO] [--json]");
      return;
    }
    if (flag === "--json") { json = true; continue; }
    if (!["--source", "--output", "--generated-at"].includes(flag)) throw new Error(`Unknown argument: ${flag}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}`);
    if (flag === "--source") source = value;
    else if (flag === "--output") output = value;
    else generatedAt = value;
  }
  const report = buildZToolsRuntimeReadinessReport(source, { generatedAt });
  if (output) {
    const destination = path.resolve(output);
    const parent = fs.realpathSync(path.dirname(destination));
    const realSource = fs.realpathSync(report.source);
    if (inside(realSource, parent) || (fs.existsSync(destination) && inside(realSource, fs.realpathSync(destination)))) {
      throw new Error("Report output must be outside the plugin source directory");
    }
    fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(JSON.stringify({ ...(output ? { output: path.resolve(output) } : {}), inventory: report.inventory, summary: report.summary }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
