import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const DEFAULT_MARKET_BASE = "https://z-tools.top/api/market";
const DEFAULT_DOWNLOAD_ROOT = "/tmp/atools-ztools-market-top30";
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 4096;

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      const result = {
        code: Number(code ?? -1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (result.code === 0) resolvePromise(result);
      else reject(new Error(`${command} exited ${result.code}: ${result.stderr.trim()}`));
    });
  });
}

async function fetchJson(url) {
  const response = await fetch(url, { headers: { "User-Agent": "ATools-compatibility-audit/3.0" } });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

function marketPlugins(data) {
  const byName = new Map();
  for (const category of Array.isArray(data?.categories) ? data.categories : []) {
    for (const plugin of Array.isArray(category?.plugins) ? category.plugins : []) {
      if (!plugin?.name) continue;
      byName.set(plugin.name, {
        ...plugin,
        categoryTitle: plugin.categoryTitle || category.title || "",
      });
    }
  }
  return [...byName.values()];
}

function rankedPlugins(data, limit) {
  return marketPlugins(data)
    .sort((left, right) => Number(right.downloadCount || 0) - Number(left.downloadCount || 0)
      || String(left.name).localeCompare(String(right.name)))
    .slice(0, limit);
}

function safeArchiveEntries(value) {
  const entries = value.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`archive contains ${entries.length} entries (max ${MAX_ARCHIVE_ENTRIES})`);
  }
  for (const entry of entries) {
    const parts = entry.replaceAll("\\", "/").split("/");
    if (entry.startsWith("/") || parts.includes("..")) {
      throw new Error(`unsafe archive path: ${entry}`);
    }
  }
  return entries;
}

async function findManifest(root, depth = 0) {
  if (depth > 8) return null;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && entry.name === "plugin.json")) {
    return join(root, "plugin.json");
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === "__MACOSX") continue;
    const found = await findManifest(join(root, entry.name), depth + 1);
    if (found) return found;
  }
  return null;
}

async function downloadAndExtract(plugin, options) {
  const resolver = new URL(`${options.marketBase}/plugins/download`);
  resolver.searchParams.set("name", plugin.name);
  const download = await fetchJson(resolver);
  const downloadUrl = String(download?.downloadUrl || "").trim();
  if (!downloadUrl.startsWith("https://")) throw new Error("market did not return an HTTPS ZIP URL");
  const response = await fetch(downloadUrl, { headers: { "User-Agent": "ATools-compatibility-audit/3.0" } });
  if (!response.ok) throw new Error(`package returned HTTP ${response.status}`);
  const declaredBytes = Number(response.headers.get("content-length") || 0);
  if (declaredBytes > MAX_ARCHIVE_BYTES) throw new Error(`package is ${declaredBytes} bytes (max ${MAX_ARCHIVE_BYTES})`);
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error(`package is ${archive.length} bytes (max ${MAX_ARCHIVE_BYTES})`);

  const pluginRoot = join(options.downloadRoot, plugin.name);
  const archivePath = join(options.downloadRoot, `${plugin.name}.zip`);
  await rm(pluginRoot, { recursive: true, force: true });
  await mkdir(pluginRoot, { recursive: true });
  await writeFile(archivePath, archive);
  const listing = await run("unzip", ["-Z1", archivePath]);
  const entries = safeArchiveEntries(listing.stdout);
  await run("unzip", ["-q", archivePath, "-d", pluginRoot]);
  const manifestPath = await findManifest(pluginRoot);
  if (!manifestPath) throw new Error("extracted package has no plugin.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sourcePath = dirname(manifestPath);
  const main = typeof manifest.main === "string" ? manifest.main.trim() : "";
  const preload = typeof manifest.preload === "string" ? manifest.preload.trim() : "";
  const mainExists = Boolean(main) && await stat(join(sourcePath, main)).then((value) => value.isFile()).catch(() => false);
  const preloadExists = !preload || await stat(join(sourcePath, preload)).then((value) => value.isFile()).catch(() => false);
  return {
    download_url: downloadUrl,
    zpx_download_url: String(download?.zpxDownloadUrl || ""),
    archive_path: archivePath,
    archive_bytes: archive.length,
    archive_sha256: createHash("sha256").update(archive).digest("hex"),
    archive_entries: entries.length,
    source_path: sourcePath,
    manifest_name: String(manifest?.name || ""),
    manifest_version: String(manifest?.version || ""),
    main,
    main_exists: mainExists,
    preload,
    preload_exists: preloadExists,
    feature_count: Array.isArray(manifest?.features) ? manifest.features.length : 0,
    headless: !main,
    package_ready: (!main || mainExists) && preloadExists,
  };
}

async function mapConcurrent(items, concurrency, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return output;
}

export async function buildZToolsMarketTopReport(options = {}) {
  const marketBase = String(options.marketBase || DEFAULT_MARKET_BASE).replace(/\/$/, "");
  const limit = Math.max(1, Math.min(100, Number(options.limit || 30)));
  const downloadRoot = resolve(options.downloadRoot || DEFAULT_DOWNLOAD_ROOT);
  const catalogUrl = `${marketBase}/plugins?limit=${limit}&platform=darwin`;
  const catalog = await fetchJson(catalogUrl);
  const ranked = rankedPlugins(catalog, limit);
  await mkdir(downloadRoot, { recursive: true });
  const plugins = await mapConcurrent(ranked, Number(options.concurrency || 4), async (plugin, index) => {
    const base = {
      rank: index + 1,
      name: String(plugin.name),
      title: String(plugin.title || plugin.name),
      version: String(plugin.version || ""),
      download_count: Number(plugin.downloadCount || 0),
      size: Number(plugin.size || 0),
      category: String(plugin.categoryTitle || ""),
      status: "pending",
      error: "",
    };
    if (options.download === false) return { ...base, status: "catalogued" };
    try {
      return { ...base, status: "package_ready", ...(await downloadAndExtract(plugin, { marketBase, downloadRoot })) };
    } catch (error) {
      return { ...base, status: "failed", error: error instanceof Error ? error.message : String(error) };
    }
  });
  const ready = plugins.filter((plugin) => plugin.package_ready).length;
  return {
    generated_at: new Date().toISOString(),
    market_base: marketBase,
    catalog_url: catalogUrl,
    ranking: "downloadCount desc, name asc",
    denominator: plugins.length,
    download_root: downloadRoot,
    summary: {
      package_ready: ready,
      failed: plugins.filter((plugin) => plugin.status === "failed").length,
      package_ready_rate: plugins.length ? Number((ready / plugins.length).toFixed(4)) : 0,
    },
    plugins,
  };
}

function parseArgs(args) {
  const options = { marketBase: DEFAULT_MARKET_BASE, downloadRoot: DEFAULT_DOWNLOAD_ROOT, limit: 30, concurrency: 4, output: "", download: true };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--market-base") options.marketBase = args[++index] || options.marketBase;
    else if (arg === "--download-root") options.downloadRoot = args[++index] || options.downloadRoot;
    else if (arg === "--limit") options.limit = Number(args[++index] || options.limit);
    else if (arg === "--concurrency") options.concurrency = Number(args[++index] || options.concurrency);
    else if (arg === "--output") options.output = args[++index] || "";
    else if (arg === "--no-download") options.download = false;
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const options = parseArgs(process.argv.slice(2));
  const report = await buildZToolsMarketTopReport(options);
  if (options.output) {
    await mkdir(dirname(resolve(options.output)), { recursive: true });
    await writeFile(resolve(options.output), `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`ZTools Top ${report.denominator}: ${report.summary.package_ready} packages ready, ${report.summary.failed} failed`);
}
