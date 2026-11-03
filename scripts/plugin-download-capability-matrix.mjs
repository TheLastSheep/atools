import { builtinModules } from "node:module";
import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, extname, join, relative, resolve, sep } from "node:path";

const BUILTINS = new Set(builtinModules.map((value) => value.replace(/^node:/, "")));
const MANIFEST_CANDIDATES = ["plugin.json", "public/plugin.json", "dist/plugin.json", "src/plugin.json", "app/plugin.json", "plugin/plugin.json"];
const TEXT_EXTENSIONS = new Set([".js", ".cjs", ".mjs", ".jsx", ".ts", ".tsx", ".html", ".htm", ".css", ".json", ".vue"]);
const DEFAULT_LIMITS = { files: 600, bytes: 2 * 1024 * 1024, entries: 1800,
  totalFiles: 30000, totalBytes: 128 * 1024 * 1024, totalEntries: 60000,
  totalManifestBytes: 16 * 1024 * 1024 };

function string(value) { return typeof value === "string" ? value.trim() : ""; }
function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}
function localSpecifier(value) { return value.startsWith("./") || value.startsWith("../") || value.startsWith("/"); }
function inside(root, file) {
  const path = relative(root, file);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}
function validCount(value) {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const number = Number(value.trim());
    return Number.isSafeInteger(number) ? number : null;
  }
  return null;
}
function mergeMarketRecord(prior, row, category) {
  const rawCount = row.downloadCount;
  const count = rawCount === undefined || rawCount === null ? null : validCount(rawCount);
  const badCount = rawCount !== undefined && rawCount !== null && count === null;
  prior.countInputs.push({ count, badCount, missing: rawCount === undefined || rawCount === null });
  if (category && !prior.categories.includes(category)) prior.categories.push(category);
  if (row.title && !prior.title) prior.title = string(row.title);
  if (row.size !== undefined && prior.size === null && Number.isSafeInteger(Number(row.size))) prior.size = Number(row.size);
  prior.sources.add(category ? "categories" : "latest");
}

function normalizeCatalog(catalog) {
  const byIdentity = new Map();
  const add = (row, category) => {
    if (!row || typeof row !== "object") return;
    const name = string(row.name);
    if (!name) return;
    const version = string(row.version);
    const key = `${name}\u0000${version}`;
    let prior = byIdentity.get(key);
    if (!prior) {
      prior = { name, version, title: string(row.title), size: null, categories: [], sources: new Set(), countInputs: [] };
      byIdentity.set(key, prior);
    }
    mergeMarketRecord(prior, row, category);
  };
  for (const category of Array.isArray(catalog?.categories) ? catalog.categories : []) {
    const title = string(category?.title);
    for (const row of Array.isArray(category?.plugins) ? category.plugins : []) add(row, title);
  }
  for (const row of Array.isArray(catalog?.latest) ? catalog.latest : []) add(row, "");
  const rows = [...byIdentity.values()].map((row) => {
    const counts = row.countInputs.filter((item) => item.count !== null).map((item) => item.count);
    const hasInvalid = row.countInputs.some((item) => item.badCount);
    const conflicting = new Set(counts).size > 1;
    let downloadCount = null;
    let countStatus = "missing";
    if (hasInvalid) countStatus = "invalid";
    else if (conflicting) countStatus = "conflicting_duplicate_values";
    else if (counts.length) { downloadCount = counts[0]; countStatus = "known"; }
    return { name: row.name, version: row.version, title: row.title || row.name, size: row.size,
      categories: row.categories.sort(), sources: [...row.sources].sort(), downloadCount, countStatus };
  });
  return rows.sort((a, b) => (b.downloadCount ?? -1) - (a.downloadCount ?? -1)
    || a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

async function readJson(path, maxBytes = 1024 * 1024) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) throw new Error(`JSON file is not a bounded regular file: ${path}`);
  return JSON.parse(await readFile(path, "utf8"));
}

async function walkFiles(root, limits, budget) {
  const files = new Map();
  let entriesSeen = 0;
  let bytesSeen = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length && !truncated) {
    const directory = stack.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      entriesSeen += 1;
      budget.entries += 1;
      if (entriesSeen > limits.entries || budget.entries > limits.totalEntries) { truncated = true; break; }
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const full = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (!entry.isFile()) continue;
      let info;
      try { info = await lstat(full); } catch { continue; }
      if (info.isSymbolicLink() || !info.isFile()) continue;
      const rel = relative(root, full).split(sep).join("/");
      const extension = extname(entry.name).toLowerCase();
      const nativeBinary = entry.name.endsWith(".node");
      const textFile = TEXT_EXTENSIONS.has(extension) || entry.name === "package.json";
      if (!nativeBinary && !textFile) continue;
      if (files.size >= limits.files || bytesSeen + info.size > limits.bytes
        || budget.files >= limits.totalFiles || budget.bytes + info.size > limits.totalBytes) { truncated = true; break; }
      bytesSeen += info.size;
      budget.bytes += info.size;
      budget.files += 1;
      if (nativeBinary) {
        files.set(rel, { kind: "native", bytes: info.size });
        continue;
      }
      try { files.set(rel, { kind: "text", text: await readFile(full, "utf8"), bytes: info.size }); }
      catch { files.set(rel, { kind: "unreadable", bytes: info.size }); }
    }
  }
  return { files, truncated, entriesSeen, bytesSeen };
}

async function findManifests(root, limits, budget) {
  const manifests = [];
  let entriesSeen = 0;
  let truncated = false;
  const stack = [root];
  while (stack.length && !truncated) {
    const directory = stack.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (let index = 0; index < entries.length; index += 1) {
      budget.entries += 1;
      if (budget.entries > limits.totalEntries) { truncated = true; break; }
    }
    if (truncated) break;
    const byName = new Map(entries.filter((e) => e.isFile()).map((e) => [e.name, e]));
    const candidate = MANIFEST_CANDIDATES.find((name) => byName.has(name));
    if (candidate) { manifests.push(join(directory, candidate)); continue; }
    for (const entry of entries) {
      entriesSeen += 1;
      if (entriesSeen > limits.entries) { truncated = true; break; }
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(join(directory, entry.name));
    }
  }
  return { manifests, truncated };
}

function resolveManifestEntry(root, base, declared) {
  const value = string(declared);
  if (!value) return { path: null, status: "absent" };
  if (value.length > 2048 || value.includes("\\") || value.includes("\0")) return { path: null, status: "invalid" };
  if (/^(?:https?:)?\/\//i.test(value)) return { path: null, status: "external" };
  const resolved = resolve(base, value.replace(/^\//, ""));
  return inside(root, resolved) ? { path: resolved, status: "local" } : { path: null, status: "escaped" };
}
function rel(root, path) { return relative(root, path).split(sep).join("/"); }
function pluginDirectory(manifestPath, sourceRoot) {
  let directory = dirname(manifestPath);
  if (directory === sourceRoot) return directory;
  while (dirname(directory) !== sourceRoot && inside(sourceRoot, directory)) directory = dirname(directory);
  return directory;
}
function importSpecifiers(text, file) {
  const values = [];
  const extension = extname(file).toLowerCase();
  const scriptBodies = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)].map((match) => match[1]);
  const moduleText = extension === ".css" ? "" : extension === ".html" || extension === ".htm" ? scriptBodies.join("\n") : text;
  const modulePatterns = [
    /\b(?:import|export)\s+(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of modulePatterns) for (const match of moduleText.matchAll(pattern)) values.push({ specifier: match[1], kind: "module" });
  if (/\.html?$/i.test(file)) {
    for (const match of text.matchAll(/<(?:script|img|link|source|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)) values.push({ specifier: match[1], kind: "resource" });
  }
  if (/\.css$/i.test(file)) {
    for (const match of text.matchAll(/@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?/gi)) values.push({ specifier: match[1], kind: "resource" });
    for (const match of text.matchAll(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi)) values.push({ specifier: (match[2] ?? match[3]).trim(), kind: "resource" });
  }
  const calls = [...moduleText.matchAll(/\b(?:require|import)\s*\(([^)]*)\)/g)];
  const dynamic = calls.some((match) => !/^\s*(["'])[^"']*\1\s*$/.test(match[1]));
  const unique = new Map(values.map((item) => [`${item.kind}\u0000${item.specifier}`, item]));
  return { values: [...unique.values()], dynamic };
}
function staticImportClosure(root, entryPaths, files) {
  const visited = new Set();
  const queue = entryPaths.filter(Boolean).map((path) => rel(root, path));
  const externalUrls = new Set();
  const ignoredResourceUrls = new Set();
  const barePackages = new Set();
  const nodeBuiltins = new Set();
  const localMissing = new Set();
  let dynamicImportUnknown = false;
  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);
    const record = files.get(file);
    if (!record || record.kind !== "text") { localMissing.add(file); continue; }
    if (record.kind !== "text") continue;
    if (/\brequire\s*\(\s*["']electron["']\s*\)|\bfrom\s+["']electron["']|\bimport\s*\(\s*["']electron["']\s*\)/.test(record.text)) barePackages.add("electron");
    if (/\bwindow\s*\.\s*(?:ztools|utools)\b|\b(?:window\.)?ztools\s*\./i.test(record.text)) barePackages.add("__ztools_api__");
    const parsed = importSpecifiers(record.text, file);
    dynamicImportUnknown ||= parsed.dynamic;
    for (const { specifier, kind } of parsed.values) {
      if (kind === "resource" && /^(?:data|blob):/i.test(specifier)) { ignoredResourceUrls.add(specifier.slice(0, 32)); continue; }
      if (/^(?:https?:)?\/\//i.test(specifier)) { externalUrls.add(specifier); continue; }
      if (kind === "resource" || localSpecifier(specifier)) {
        const cleanSpecifier = specifier.replace(/[?#].*$/, "");
        if (!cleanSpecifier) continue;
        const base = cleanSpecifier.startsWith("/") ? "" : dirname(file);
        const target = resolve(root, base, cleanSpecifier.replace(/^\//, ""));
        if (!inside(root, target)) { localMissing.add(specifier); continue; }
        const targetRel = rel(root, target);
        const candidates = [targetRel, ...[".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx", ".json", ".html", ".css"].map((ext) => `${targetRel}${ext}`),
          ...["index.js", "index.ts", "index.tsx", "index.jsx", "index.mjs"].map((name) => `${targetRel.replace(/\/$/, "")}/${name}`)];
        const found = candidates.find((candidate) => files.has(candidate));
        if (found) queue.push(found); else localMissing.add(targetRel);
      } else if (BUILTINS.has(specifier.replace(/^node:/, ""))) {
        nodeBuiltins.add(specifier.replace(/^node:/, ""));
      } else {
        barePackages.add(packageName(specifier));
      }
    }
  }
  return { visited, externalUrls: [...externalUrls].sort(), ignoredResourceUrls: [...ignoredResourceUrls].sort(), barePackages: [...barePackages].sort(),
    nodeBuiltins: [...nodeBuiltins].sort(), localMissing: [...localMissing].sort(), dynamicImportUnknown };
}

function readDeclaredPackages(packageJson) {
  const map = (value) => value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort() : [];
  return { runtime: map(packageJson?.dependencies), development: map(packageJson?.devDependencies),
    optional: map(packageJson?.optionalDependencies), peer: map(packageJson?.peerDependencies) };
}
function ztoolsSurface(text) {
  return /\bwindow\s*\.\s*(?:ztools|utools)\b|\b(?:window\.)?(?:ztools|utools)\s*\./i.test(text);
}

async function inspectLocalPlugin(manifestPath, root, limits) {
  let manifest;
  try {
    const manifestInfo = await lstat(manifestPath);
    if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || manifestInfo.size > 512 * 1024
      || limits.__budget.manifestBytes + manifestInfo.size > limits.totalManifestBytes) {
      limits.__budget.truncated = true;
      return null;
    }
    limits.__budget.manifestBytes += manifestInfo.size;
    manifest = await readJson(manifestPath, 512 * 1024);
  } catch { limits.__budget.invalidManifests += 1; return null; }
  const name = string(manifest.name) || string(manifest.title);
  const version = string(manifest.version);
  if (!name) { limits.__budget.invalidManifests += 1; return null; }
  const pluginRoot = pluginDirectory(manifestPath, root);
  const filesResult = await walkFiles(pluginRoot, limits, limits.__budget);
  const base = dirname(manifestPath);
  const mainEntry = resolveManifestEntry(pluginRoot, base, manifest.main);
  const preloadEntry = resolveManifestEntry(pluginRoot, base, manifest.preload);
  const entryStatuses = { main: mainEntry.status, preload: preloadEntry.status };
  const invalidManifestEntry = Object.values(entryStatuses).some((status) => ["invalid", "escaped"].includes(status));
  const unavailableEntrySource = Object.values(entryStatuses).includes("external");
  const pkgPath = resolve(pluginRoot, "package.json");
  const packageRel = rel(pluginRoot, pkgPath);
  let packageJson = null;
  let packageMetadataStatus = "missing";
  const packageFile = filesResult.files.get(packageRel);
  if (packageFile?.kind === "text") {
    try { packageJson = JSON.parse(packageFile.text); packageMetadataStatus = "known"; }
    catch { packageMetadataStatus = "invalid"; }
  } else if (packageFile) packageMetadataStatus = "unreadable_or_truncated";
  const closure = staticImportClosure(pluginRoot, [mainEntry.path, preloadEntry.path], filesResult.files);
  const allCode = [...closure.visited].map((path) => filesResult.files.get(path)?.text || "").join("\n");
  const nativeFiles = [...filesResult.files.entries()].filter(([, value]) => value.kind === "native").map(([path]) => path);
  const declared = readDeclaredPackages(packageJson);
  const scriptEntries = packageJson?.scripts && typeof packageJson.scripts === "object"
    ? Object.entries(packageJson.scripts).map(([name, value]) => `${name}:${String(value)}`) : [];
  const buildScripts = scriptEntries.filter((value) => /^(?:build|prebuild):/.test(value));
  const nativeLifecycleScripts = scriptEntries.filter((value) => /^(?:prepare|install|postinstall):/.test(value));
  const sourceEntry = /\.(?:tsx?|jsx)$/.test(string(manifest.main)) || /(?:^|\/)src\/(?:main|index)\.[jt]sx?$/.test(string(manifest.main));
  const mainRel = mainEntry.path ? rel(pluginRoot, mainEntry.path) : "";
  const mainPresent = Boolean(mainRel && filesResult.files.has(mainRel));
  const buildOnly = sourceEntry || (!mainPresent && buildScripts.length > 0);
  const nativePackagePattern = /(?:node-gyp|prebuild-install|cmake-js|node-addon-api|^(?:sharp|canvas|sqlite3|better-sqlite3|node-sass|keytar|ffi-napi|serialport|robotjs)$)/i;
  const declaredAll = [...declared.runtime, ...declared.development, ...declared.optional, ...declared.peer];
  const nativeSignal = nativeFiles.length > 0 || /(?:node-gyp|prebuild-install|cmake-js|node-addon-api)/i.test([...buildScripts, ...nativeLifecycleScripts].join(" "))
    || ["node-gyp", "prebuild-install", "cmake-js", "node-addon-api"].some((name) => declared.runtime.includes(name) || declared.development.includes(name));
  const nativePackageSignal = declaredAll.some((name) => nativePackagePattern.test(name));
  const features = new Set();
  for (const builtin of closure.nodeBuiltins) features.add(`node_builtin:${builtin}`);
  if (closure.barePackages.includes("electron")) features.add("electron_api");
  if (ztoolsSurface(allCode)) features.add("ztools_api");
  if (closure.barePackages.some((pkg) => pkg !== "electron" && pkg !== "__ztools_api__")) features.add("external_package_import");
  if (declared.runtime.length) features.add("npm_runtime_declared");
  if (declared.development.length) features.add("npm_development_declared");
  if (packageMetadataStatus !== "known") features.add("dependency_metadata_unknown");
  if (nativeSignal || nativePackageSignal) features.add("native_addon_or_build_dependency");
  if (buildScripts.length) features.add("build_script_declared");
  if (buildOnly) features.add("build_only_or_source_entry");
  if (closure.dynamicImportUnknown || closure.localMissing.length || filesResult.truncated || invalidManifestEntry || unavailableEntrySource) features.add("static_scan_inconclusive");
  if (closure.externalUrls.length || unavailableEntrySource) features.add("external_url_resource");
  if (!string(manifest.preload)) features.add("no_declared_preload");
  return { name, version, manifestPath, features: [...features].sort(), nodeBuiltins: closure.nodeBuiltins,
    externalPackages: closure.barePackages.filter((value) => value !== "electron" && value !== "__ztools_api__"),
    declaredPackages: declared, packageMetadataStatus,
    sourceOrBuildSignal: { sourceEntry, mainPresent, buildOnly, buildScripts, nativeLifecycleScripts },
    nativeFiles, dynamicImportUnknown: closure.dynamicImportUnknown, missingLocalImports: closure.localMissing,
    externalUrls: closure.externalUrls, ignoredResourceUrls: closure.ignoredResourceUrls, entryStatuses, invalidManifestEntry,
    truncated: filesResult.truncated, scannedFiles: filesResult.files.size,
    scannedBytes: filesResult.bytesSeen, heuristicOnly: true };
}

function normalizeThreshold(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("threshold must be a non-negative safe integer");
  return n;
}

export async function buildPluginDownloadCapabilityMatrix({ catalogPath, pluginsRoot, threshold = 30, limits = DEFAULT_LIMITS }) {
  if (!catalogPath || !pluginsRoot) throw new Error("catalogPath and pluginsRoot are required");
  const cutoff = normalizeThreshold(threshold);
  const catalog = await readJson(resolve(catalogPath), 12 * 1024 * 1024);
  const catalogRows = normalizeCatalog(catalog);
  const root = resolve(pluginsRoot);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("pluginsRoot must be a real directory, not a symlink");
  const budget = { files: 0, bytes: 0, entries: 0, manifestBytes: 0, truncated: false, invalidManifests: 0 };
  const scanLimits = { ...limits, __budget: budget };
  const manifestResult = await findManifests(root, limits, budget);
  const localRows = [];
  for (const path of manifestResult.manifests) {
    const row = await inspectLocalPlugin(path, root, scanLimits);
    if (row) localRows.push(row);
  }
  const rows = [];
  for (const market of catalogRows) {
    let cohort = "unknown_download_count";
    if (market.countStatus === "known") cohort = market.downloadCount >= cutoff ? "eligible" : "excluded_below_threshold";
    const exact = market.version ? localRows.filter((row) => row.name === market.name && row.version === market.version) : [];
    const sameName = localRows.filter((row) => row.name === market.name);
    let localStatus = "not_scanned_for_cohort";
    let local = null;
    if (cohort === "eligible") {
      if (!market.version) localStatus = sameName.length ? "market_version_missing" : "missing";
      else if (exact.length > 1) localStatus = "ambiguous_exact_name_version";
      else if (exact.length === 1) { localStatus = "matched"; local = exact[0]; }
      else if (sameName.some((row) => !row.version)) localStatus = "local_version_missing";
      else localStatus = sameName.length ? "version_mismatch" : "missing";
    }
    rows.push({ ...market, cohort, localMatch: localStatus, capabilities: local?.features || [],
      details: local ? { nodeBuiltins: local.nodeBuiltins, externalPackages: local.externalPackages,
        runtimePackages: local.declaredPackages.runtime, developmentPackages: local.declaredPackages.development,
        optionalPackages: local.declaredPackages.optional, peerPackages: local.declaredPackages.peer,
        packageMetadataStatus: local.packageMetadataStatus,
        sourceOrBuildSignal: local.sourceOrBuildSignal, nativeFiles: local.nativeFiles,
        dynamicImportUnknown: local.dynamicImportUnknown, missingLocalImports: local.missingLocalImports,
        externalUrls: local.externalUrls, ignoredResourceUrls: local.ignoredResourceUrls, entryStatuses: local.entryStatuses,
        invalidManifestEntry: local.invalidManifestEntry,
        truncated: local.truncated, scannedFiles: local.scannedFiles,
        scannedBytes: local.scannedBytes, heuristicOnly: true } : null });
  }
  const eligible = rows.filter((row) => row.cohort === "eligible");
  const knownEligibleDownloadSum = eligible.reduce((sum, row) => sum + row.downloadCount, 0);
  const capabilities = new Map();
  for (const row of eligible) for (const capability of row.capabilities) {
    const current = capabilities.get(capability) || { capability, pluginCount: 0, downloadCountSum: 0, pluginNames: [] };
    current.pluginCount += 1;
    current.downloadCountSum += row.downloadCount;
    current.pluginNames.push(`${row.name}@${row.version}`);
    capabilities.set(capability, current);
  }
  const capabilitySummary = [...capabilities.values()].map((item) => ({ ...item,
    pluginNames: item.pluginNames.sort(),
    potentialDownloadCoverage: knownEligibleDownloadSum ? Number((item.downloadCountSum / knownEligibleDownloadSum).toFixed(6)) : 0,
    interpretation: "Potential weighted reach among observed eligible market counts; not compatibility or successful-use rate." }))
    .sort((a, b) => b.downloadCountSum - a.downloadCountSum || b.pluginCount - a.pluginCount || a.capability.localeCompare(b.capability));
  const matched = eligible.filter((row) => row.localMatch === "matched");
  const sourceFileScanTruncatedPlugins = localRows.filter((row) => row.truncated).length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: { catalogPath: resolve(catalogPath), pluginsRoot: root, marketShape: "categories plus latest, deduplicated by exact name+version" },
    threshold: cutoff,
    semantics: {
      noExecution: true,
      noDownloadOrInstall: true,
      identity: "Local plugins match only exact name+version; multiple exact matches are ambiguous.",
      unknownCounts: "Missing, invalid, or conflicting duplicate downloadCount values are kept in the unknown cohort, never converted to zero.",
      heuristic: "Static source/dependency evidence only; capability labels do not establish runtime support, readiness, compatibility, or user success.",
      scannerLimits: limits,
      sourceInventoryTruncated: manifestResult.truncated || budget.truncated || sourceFileScanTruncatedPlugins > 0,
      sourceFileScanTruncated: sourceFileScanTruncatedPlugins > 0,
      staticImportCaveat: "Only literal imports/requires and local HTML script sources are followed; dynamic import/require, missing local imports, unreadable files, aliases and bundler indirection are inconclusive."
    },
    summary: {
      catalogUniqueNameVersionRows: rows.length,
      categoryUniqueNames: new Set((catalog.categories || []).flatMap((category) => (category.plugins || []).map((item) => string(item.name)).filter(Boolean))).size,
      latestRawRows: Array.isArray(catalog.latest) ? catalog.latest.length : 0,
      eligible: eligible.length,
      excludedBelowThreshold: rows.filter((row) => row.cohort === "excluded_below_threshold").length,
      unknownDownloadCount: rows.filter((row) => row.cohort === "unknown_download_count").length,
      knownEligibleDownloadSum,
      eligibleLocalMatched: matched.length,
      eligibleMissingLocal: rows.filter((row) => row.cohort === "eligible" && row.localMatch === "missing").length,
      eligibleVersionMismatch: rows.filter((row) => row.localMatch === "version_mismatch").length,
      eligibleLocalVersionMissing: rows.filter((row) => row.localMatch === "local_version_missing").length,
      eligibleAmbiguous: rows.filter((row) => row.localMatch === "ambiguous_exact_name_version").length,
      eligibleUnmatchedDownloadSum: eligible.filter((row) => row.localMatch !== "matched").reduce((sum, row) => sum + row.downloadCount, 0),
      invalidLocalManifestCount: budget.invalidManifests,
      sourceFileScanTruncatedPlugins,
      sourceFileScanTruncated: sourceFileScanTruncatedPlugins > 0
    },
    capabilityPriority: capabilitySummary,
    plugins: rows
  };
}

export const defaultPluginMatrixLimits = { ...DEFAULT_LIMITS };
