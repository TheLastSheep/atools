import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_CMD_TYPES = new Set(["regex", "over", "img", "files", "window"]);

async function fileExists(path) {
  try {
    const stat = await import("node:fs/promises").then((fs) => fs.stat(path));
    return stat.isFile();
  } catch {
    return false;
  }
}

async function collectPluginManifestPaths(root, out = []) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && entry.name === "plugin.json")) {
    out.push(join(root, "plugin.json"));
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    await collectPluginManifestPaths(join(root, entry.name), out);
  }
  return out;
}

function stringOrEmpty(value) {
  return typeof value === "string" ? value.trim() : "";
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function featureList(manifest) {
  return Array.isArray(manifest?.features) ? manifest.features.filter((item) => item && typeof item === "object") : [];
}

function commandList(feature) {
  return Array.isArray(feature?.cmds) ? feature.cmds : [];
}

function commandType(cmd) {
  if (typeof cmd === "string") return "text";
  if (!cmd || typeof cmd !== "object" || Array.isArray(cmd)) return "invalid";
  return stringOrEmpty(cmd.type) || "invalid";
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

async function pluginCompatibilityFromManifest(manifestPath) {
  const pluginDir = dirname(manifestPath);
  const text = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(text);
  const name = stringOrEmpty(manifest.name) || stringOrEmpty(manifest.title) || dirname(pluginDir).split("/").pop() || "unknown-plugin";
  const title = stringOrEmpty(manifest.title) || stringOrEmpty(manifest.pluginName) || name;
  const version = stringOrEmpty(manifest.version);
  const main = stringOrEmpty(manifest.main);
  const preload = stringOrEmpty(manifest.preload);
  const logo = stringOrEmpty(manifest.logo);
  const platforms = stringList(manifest.platform);
  const features = featureList(manifest);
  const commands = features.flatMap((feature) => commandList(feature));
  const unsupportedCmdTypes = uniqueSorted(commands
    .map(commandType)
    .filter((type) => type !== "text" && !SUPPORTED_CMD_TYPES.has(type)));
  const mainExists = main ? await fileExists(join(pluginDir, main)) : false;
  const preloadExists = preload ? await fileExists(join(pluginDir, preload)) : true;
  const logoExists = logo ? await fileExists(join(pluginDir, logo)) : true;
  const platformSupported = platforms.length === 0 || platforms.includes("darwin") || platforms.includes("macos");
  const warnings = [];
  const errors = [];

  if (!platformSupported) warnings.push("Platform does not include darwin");
  if (main && !mainExists) errors.push(`Missing main file: ${main}`);
  if (!preloadExists) warnings.push(`Missing preload file: ${preload}`);
  if (!logoExists) warnings.push(`Missing logo file: ${logo}`);
  if (unsupportedCmdTypes.length > 0) warnings.push(`Unsupported command types: ${unsupportedCmdTypes.join(", ")}`);

  return {
    name,
    title,
    version,
    path: pluginDir,
    main,
    main_exists: mainExists,
    headless: !main,
    preload,
    preload_exists: preloadExists,
    logo,
    logo_exists: logoExists,
    platform_supported: platformSupported,
    feature_count: features.length,
    command_count: commands.length,
    feature_codes: features.map((feature) => stringOrEmpty(feature.code)).filter(Boolean),
    unsupported_cmd_types: unsupportedCmdTypes,
    warnings,
    errors,
    status: errors.length > 0 ? "error" : warnings.length > 0 ? "warning" : "compatible",
  };
}

function duplicateFeatureCodes(plugins) {
  const owners = new Map();
  for (const plugin of plugins) {
    for (const code of plugin.feature_codes) {
      const list = owners.get(code) || [];
      list.push(plugin.name);
      owners.set(code, list);
    }
  }
  return [...owners.entries()]
    .filter(([, pluginsForCode]) => new Set(pluginsForCode).size > 1)
    .map(([code, pluginsForCode]) => ({ code, plugins: uniqueSorted(pluginsForCode) }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function unsupportedTypeCounts(plugins) {
  const counts = {};
  for (const plugin of plugins) {
    for (const type of plugin.unsupported_cmd_types) {
      counts[type] = (counts[type] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

export async function buildZToolsPluginCompatibilityReport(source, options = {}) {
  const root = resolve(source);
  const manifestPaths = await collectPluginManifestPaths(root);
  const plugins = [];
  for (const manifestPath of manifestPaths) {
    try {
      plugins.push(await pluginCompatibilityFromManifest(manifestPath));
    } catch (error) {
      const pluginDir = dirname(manifestPath);
      plugins.push({
        name: pluginDir.split("/").pop() || "unknown-plugin",
        title: pluginDir.split("/").pop() || "unknown-plugin",
        version: "",
        path: pluginDir,
        main: "",
        main_exists: false,
        preload: "",
        preload_exists: true,
        logo: "",
        logo_exists: true,
        platform_supported: true,
        feature_count: 0,
        command_count: 0,
        feature_codes: [],
        unsupported_cmd_types: [],
        warnings: [],
        errors: [`Manifest parse failed: ${error instanceof Error ? error.message : String(error)}`],
        status: "error",
      });
    }
  }
  plugins.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));

  const duplicates = duplicateFeatureCodes(plugins);
  return {
    generated_at: options.generatedAt || new Date().toISOString(),
    source: root,
    summary: {
      scanned_plugins: plugins.length,
      compatible_plugins: plugins.filter((plugin) => plugin.status === "compatible").length,
      warning_plugins: plugins.filter((plugin) => plugin.status === "warning").length,
      error_plugins: plugins.filter((plugin) => plugin.status === "error").length,
      feature_count: plugins.reduce((sum, plugin) => sum + plugin.feature_count, 0),
      command_count: plugins.reduce((sum, plugin) => sum + plugin.command_count, 0),
      main_missing: plugins.filter((plugin) => !plugin.main_exists).length,
      preload_missing: plugins.filter((plugin) => plugin.preload && !plugin.preload_exists).length,
      logo_missing: plugins.filter((plugin) => plugin.logo && !plugin.logo_exists).length,
      platform_unsupported: plugins.filter((plugin) => !plugin.platform_supported).length,
      unsupported_cmd_plugins: plugins.filter((plugin) => plugin.unsupported_cmd_types.length > 0).length,
      duplicate_feature_codes: duplicates.length,
    },
    unsupported_cmd_types: unsupportedTypeCounts(plugins),
    duplicate_feature_codes: duplicates,
    plugins,
  };
}

export async function writeZToolsPluginCompatibilityReport(report, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

function parseArgs(args) {
  const options = {
    source: process.env.ZTOOLS_PLUGIN_COMPAT_SOURCE || "../ZTools-plugins/plugins",
    output: "",
    json: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--source") {
      options.source = args[index + 1] || options.source;
      index += 1;
    } else if (arg === "--output") {
      options.output = args[index + 1] || "";
      index += 1;
    } else if (arg === "--json") {
      options.json = true;
    }
  }
  return options;
}

function printHumanSummary(report) {
  const summary = report.summary;
  console.log(`ZTools compatibility source: ${report.source}`);
  console.log(`Plugins: ${summary.scanned_plugins} scanned, ${summary.compatible_plugins} compatible, ${summary.warning_plugins} warning, ${summary.error_plugins} error`);
  console.log(`Features: ${summary.feature_count}; commands: ${summary.command_count}`);
  console.log(`Missing main/preload/logo: ${summary.main_missing}/${summary.preload_missing}/${summary.logo_missing}`);
  console.log(`Unsupported cmd plugins: ${summary.unsupported_cmd_plugins}; duplicate feature codes: ${summary.duplicate_feature_codes}`);
  if (Object.keys(report.unsupported_cmd_types).length > 0) {
    console.log(`Unsupported cmd types: ${Object.entries(report.unsupported_cmd_types).map(([type, count]) => `${type}:${count}`).join(", ")}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  const report = await buildZToolsPluginCompatibilityReport(args.source);
  if (args.output) {
    await writeZToolsPluginCompatibilityReport(report, args.output);
  }
  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHumanSummary(report);
  }
}
