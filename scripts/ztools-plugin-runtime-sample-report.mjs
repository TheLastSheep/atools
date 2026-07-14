import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildZToolsPluginCompatibilityReport } from "./ztools-plugin-compatibility-report.mjs";

const NODE_REQUIRE_MODULES = ["child_process", "crypto", "fs", "http", "https", "net", "os", "path", "stream", "tls", "zlib"];

async function fileExists(path) {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function isHtmlEntry(main) {
  const ext = extname(main || "").toLowerCase();
  return ext === ".html" || ext === ".htm";
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function cleanResourceReference(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/[#?].*$/, "");
}

function isExternalReference(value) {
  return /^https?:\/\//i.test(value) || /^\/\//.test(value);
}

function shouldIgnoreReference(value) {
  return (
    !value ||
    value.startsWith("#") ||
    /^(?:data|blob|about|javascript|mailto|tel):/i.test(value)
  );
}

function localDisplayPath(main, reference) {
  const cleaned = cleanResourceReference(reference);
  if (cleaned.startsWith("/")) return normalize(cleaned.slice(1));
  return normalize(join(dirname(main), cleaned));
}

function extractSrcsetReferences(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0])
    .filter(Boolean);
}

function extractHtmlResourceReferences(html) {
  const references = [];
  const attrPattern = /\b(?:src|href|poster|data)\s*=\s*(["'])(.*?)\1/gi;
  const srcsetPattern = /\bsrcset\s*=\s*(["'])(.*?)\1/gi;
  const cssUrlPattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  const cssImportPattern = /@import\s+(?:url\(\s*)?(["'])(.*?)\1/gi;

  for (const match of html.matchAll(attrPattern)) {
    references.push(match[2]);
  }
  for (const match of html.matchAll(srcsetPattern)) {
    references.push(...extractSrcsetReferences(match[2]));
  }
  for (const match of html.matchAll(cssUrlPattern)) {
    references.push(match[2]);
  }
  for (const match of html.matchAll(cssImportPattern)) {
    references.push(match[2]);
  }
  return uniqueSorted(references);
}

async function analyzeEntry(plugin) {
  const entry = {
    file: plugin.main,
    is_html: plugin.main_exists && isHtmlEntry(plugin.main),
    local_resources: [],
    missing_local_resources: [],
    external_resources: [],
  };

  if (!entry.is_html) return entry;

  const mainPath = join(plugin.path, plugin.main);
  const html = await readFile(mainPath, "utf8").catch(() => "");
  const references = extractHtmlResourceReferences(html);
  for (const reference of references) {
    if (shouldIgnoreReference(reference)) continue;
    if (isExternalReference(reference)) {
      entry.external_resources.push(reference);
      continue;
    }
    const displayPath = localDisplayPath(plugin.main, reference);
    entry.local_resources.push(displayPath);
    if (!(await fileExists(join(plugin.path, displayPath)))) {
      entry.missing_local_resources.push(displayPath);
    }
  }

  entry.local_resources = uniqueSorted(entry.local_resources);
  entry.missing_local_resources = uniqueSorted(entry.missing_local_resources);
  entry.external_resources = uniqueSorted(entry.external_resources);
  return entry;
}

function requiredNodeModules(preloadText) {
  return NODE_REQUIRE_MODULES.filter((moduleName) => {
    const pattern = new RegExp(`(?:require\\(\\s*["'](?:node:)?${moduleName}["']\\s*\\)|from\\s+["'](?:node:)?${moduleName}["'])`);
    return pattern.test(preloadText);
  });
}

async function analyzePreload(plugin) {
  const preload = {
    file: plugin.preload,
    declared: Boolean(plugin.preload),
    exists: plugin.preload ? plugin.preload_exists : false,
    uses_electron_require: false,
    uses_node_require: false,
    required_node_modules: [],
    uses_child_process: false,
    uses_fs: false,
  };

  if (!plugin.preload || !plugin.preload_exists) return preload;

  const text = await readFile(join(plugin.path, plugin.preload), "utf8").catch(() => "");
  preload.uses_electron_require = /require\(\s*["']electron["']\s*\)|from\s+["']electron["']/.test(text);
  preload.required_node_modules = requiredNodeModules(text);
  preload.uses_node_require = preload.required_node_modules.length > 0;
  preload.uses_child_process = preload.required_node_modules.includes("child_process");
  preload.uses_fs = preload.required_node_modules.includes("fs");
  return preload;
}

function compatibilityRuntimeWarnings(plugin) {
  return plugin.warnings.filter((warning) => {
    if (warning.startsWith("Missing logo file:")) return false;
    if (warning === "Platform does not include darwin") return false;
    return true;
  });
}

function buildRuntimeFindings(plugin, entry, preload) {
  const blockers = [...plugin.errors];
  const warnings = compatibilityRuntimeWarnings(plugin);

  if (!plugin.platform_supported) blockers.push("Platform does not include darwin");
  if (plugin.main_exists && !entry.is_html) blockers.push(`Main file is not HTML: ${plugin.main}`);
  if (preload.declared && !preload.exists) warnings.push(`Missing preload file: ${preload.file}`);
  if (entry.missing_local_resources.length > 0) {
    warnings.push(`Missing local entry resources: ${entry.missing_local_resources.join(", ")}`);
  }
  if (entry.external_resources.length > 0) {
    warnings.push(`External entry resources: ${entry.external_resources.join(", ")}`);
  }
  if (preload.uses_electron_require) warnings.push("Preload requires Electron module");
  if (preload.required_node_modules.length > 0) {
    warnings.push(`Preload requires Node modules: ${preload.required_node_modules.join(", ")}`);
  }

  return {
    blockers: uniqueSorted(blockers),
    warnings: uniqueSorted(warnings),
  };
}

function runtimeScore(entry, preload, blockers) {
  if (blockers.length > 0) return 0;
  let score = 100;
  score -= Math.min(entry.missing_local_resources.length * 20, 40);
  score -= Math.min(entry.external_resources.length * 10, 20);
  if (preload.declared && !preload.exists) score -= 15;
  if (preload.uses_electron_require) score -= 20;
  if (preload.uses_node_require) score -= 10;
  return Math.max(score, 0);
}

async function runtimePluginFromCompatibility(plugin) {
  const entry = await analyzeEntry(plugin);
  const preload = await analyzePreload(plugin);
  const { blockers, warnings } = buildRuntimeFindings(plugin, entry, preload);
  const runtimeStatus = blockers.length > 0 ? "blocked" : warnings.length > 0 ? "risk" : "ready";

  return {
    name: plugin.name,
    title: plugin.title,
    version: plugin.version,
    path: plugin.path,
    main: plugin.main,
    preload: plugin.preload,
    feature_count: plugin.feature_count,
    command_count: plugin.command_count,
    feature_codes: plugin.feature_codes,
    compatibility_status: plugin.status,
    launch_candidate: runtimeStatus !== "blocked",
    runtime_status: runtimeStatus,
    score: runtimeScore(entry, preload, blockers),
    entry,
    preload,
    warnings,
    blockers,
  };
}

function selectSampleCandidates(plugins, limit) {
  const statusRank = { ready: 0, risk: 1, blocked: 2 };
  return plugins
    .filter((plugin) => plugin.launch_candidate)
    .sort((a, b) => (
      statusRank[a.runtime_status] - statusRank[b.runtime_status]
      || b.score - a.score
      || b.feature_count - a.feature_count
      || a.name.localeCompare(b.name)
    ))
    .slice(0, limit);
}

function summarizePlugins(plugins, selectedSampleCount) {
  return {
    scanned_plugins: plugins.length,
    launchable_plugins: plugins.filter((plugin) => plugin.launch_candidate).length,
    ready_candidates: plugins.filter((plugin) => plugin.runtime_status === "ready").length,
    risk_candidates: plugins.filter((plugin) => plugin.runtime_status === "risk").length,
    blocked_plugins: plugins.filter((plugin) => plugin.runtime_status === "blocked").length,
    html_entry_plugins: plugins.filter((plugin) => plugin.entry.is_html).length,
    missing_local_resource_plugins: plugins.filter((plugin) => plugin.entry.missing_local_resources.length > 0).length,
    missing_local_resources: plugins.reduce((sum, plugin) => sum + plugin.entry.missing_local_resources.length, 0),
    external_resource_plugins: plugins.filter((plugin) => plugin.entry.external_resources.length > 0).length,
    preload_missing_plugins: plugins.filter((plugin) => plugin.preload.declared && !plugin.preload.exists).length,
    preload_node_risk_plugins: plugins.filter((plugin) => plugin.preload.uses_node_require).length,
    preload_electron_require_plugins: plugins.filter((plugin) => plugin.preload.uses_electron_require).length,
    selected_sample_count: selectedSampleCount,
  };
}

export async function buildZToolsPluginRuntimeSampleReport(source, options = {}) {
  const root = resolve(source);
  const compatibilityReport = await buildZToolsPluginCompatibilityReport(root, options);
  const plugins = [];
  for (const plugin of compatibilityReport.plugins) {
    plugins.push(await runtimePluginFromCompatibility(plugin));
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  const maxCandidates = Number(options.maxCandidates ?? 20);
  const sampleCandidates = selectSampleCandidates(plugins, maxCandidates);
  return {
    generated_at: options.generatedAt || new Date().toISOString(),
    source: root,
    summary: summarizePlugins(plugins, sampleCandidates.length),
    sample_candidates: sampleCandidates,
    plugins,
  };
}

export async function writeZToolsPluginRuntimeSampleReport(report, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    source: process.env.ZTOOLS_PLUGIN_RUNTIME_SOURCE || "../ZTools-plugins/plugins",
    output: "",
    json: false,
    maxCandidates: 20,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") {
      options.source = args[index + 1] || options.source;
      index += 1;
    } else if (arg === "--output") {
      options.output = args[index + 1] || "";
      index += 1;
    } else if (arg === "--limit" || arg === "--max-candidates") {
      options.maxCandidates = Number(args[index + 1] || options.maxCandidates);
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

function printHumanSummary(report) {
  const summary = report.summary;
  console.log(`ZTools runtime sample source: ${report.source}`);
  console.log(`Plugins: ${summary.scanned_plugins} scanned, ${summary.launchable_plugins} launchable, ${summary.blocked_plugins} blocked`);
  console.log(`Candidates: ${summary.ready_candidates} ready, ${summary.risk_candidates} risk, ${summary.selected_sample_count} selected`);
  console.log(`Entry risks: ${summary.missing_local_resource_plugins} plugins missing local resources (${summary.missing_local_resources} refs), ${summary.external_resource_plugins} plugins use external resources`);
  console.log(`Preload risks: ${summary.preload_missing_plugins} missing preload, ${summary.preload_electron_require_plugins} Electron require, ${summary.preload_node_risk_plugins} Node require`);
  if (report.sample_candidates.length > 0) {
    console.log(`Top samples: ${report.sample_candidates.map((plugin) => `${plugin.name}:${plugin.runtime_status}:${plugin.score}`).join(", ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildZToolsPluginRuntimeSampleReport(args.source, {
    maxCandidates: args.maxCandidates,
  });
  if (args.output) {
    await writeZToolsPluginRuntimeSampleReport(report, args.output);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanSummary(report);
  }
}
