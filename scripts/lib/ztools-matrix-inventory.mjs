import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";

export const manifestCandidates = ["plugin.json", "public/plugin.json", "dist/plugin.json", "src/plugin.json", "app/plugin.json", "plugin/plugin.json"];

export async function findOriginalManifest(pluginDir, read = file => readFile(file, "utf8")) {
  for (const candidate of manifestCandidates) {
    try {
      const source = await read(resolve(pluginDir, candidate));
      return { manifest: JSON.parse(source), candidate, base: resolve(pluginDir, dirname(candidate)) };
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  throw new Error("No host-recognized original manifest");
}

/** Source inventory only; never launches, installs, bundles or builds a plugin. */
export async function inventoryOriginalPlugins(sourceRoot) {
  const rows = [];
  for (const folder of (await readdir(sourceRoot, { withFileTypes: true })).filter(item => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const pluginDir = await realpath(resolve(sourceRoot, folder.name));
    const row = { id: folder.name, sourceRoot: pluginDir, scripts: [], missingAssets: [], status: "unknown" };
    try {
      const { manifest, candidate, base } = await findOriginalManifest(pluginDir);
      Object.assign(row, { manifest: candidate, manifestBase: relative(pluginDir, base) || ".", main: manifest.main || null, preload: manifest.preload || null,
        macSupported: !manifest.platform?.length || manifest.platform.includes("darwin") });
      if (!row.macSupported) row.status = "platform_unsupported";
      else if (!manifest.main) row.status = "headless";
      else if (/^(?:https?:|\/\/)/.test(manifest.main)) row.status = "remote_entry";
      else {
        const entry = resolve(base, manifest.main.replace(/^\//, ""));
        if (!entry.startsWith(pluginDir + "/")) throw new Error("Original entry escapes plugin root");
        const html = await readFile(entry, "utf8");
        row.entryBytes = Buffer.byteLength(html);
        for (const match of html.matchAll(/<script\b([^>]*)>/gi)) {
          const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(match[1])?.[1];
          if (!src) continue;
          row.scripts.push(src);
          if (/^(?:https?:|\/\/)/.test(src)) continue;
          const file = src.startsWith("/") ? resolve(base, src.slice(1)) : resolve(dirname(entry), src);
          try { if (!(await stat(file)).isFile()) row.missingAssets.push(src); }
          catch (error) { if (error.code === "ENOENT") row.missingAssets.push(src); else throw error; }
        }
        const sourceEntry = row.scripts.some(src => /\.(?:tsx?|jsx)(?:$|[?#])/.test(src) || /(?:^|\/)src\/(?:main|index)\.[jt]sx?(?:$|[?#])/.test(src));
        row.status = sourceEntry ? "source_entry_requires_build" : row.missingAssets.length ? "released_asset_missing" : html.trim() ? "released_entry" : "empty_entry";
        if (row.preload) {
          try { if (!(await stat(resolve(base, row.preload))).isFile()) row.preloadMissing = true; }
          catch (error) { if (error.code === "ENOENT") row.preloadMissing = true; else throw error; }
          if (row.preloadMissing) row.status = "preload_missing";
        }
      }
    } catch (error) { row.error = String(error.message || error); row.status = error.code === "ENOENT" ? "entry_missing" : "inventory_error"; }
    rows.push(row);
  }
  return { schema_version: 1, generatedAt: new Date().toISOString(), source: sourceRoot,
    scope: "Pure read of host manifest candidates and actual referenced HTML script assets. source_entry_requires_build means original HTML points to TS/TSX/JSX or src/main/index; no source entry is built or executed. released_entry is an on-disk prerequisite, never a runtime success claim. Manifest-relative paths use the manifest directory. Inline ESM may import existing local sources and remains a separate product asset-loader acceptance gap.",
    summary: Object.fromEntries([...new Set(rows.map(row => row.status))].sort().map(status => [status, rows.filter(row => row.status === status).length])), rows };
}
