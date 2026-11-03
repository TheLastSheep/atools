import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPluginDownloadCapabilityMatrix, defaultPluginMatrixLimits } from "../scripts/plugin-download-capability-matrix.mjs";

const root = await mkdtemp(join(tmpdir(), "atools-download-capability-matrix-"));
const catalogPath = join(root, "catalog.json");
const pluginsRoot = join(root, "plugins");
async function put(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, value);
}
async function plugin(folder, name, version, manifest, files = {}) {
  const dir = join(pluginsRoot, folder);
  await mkdir(dir, { recursive: true });
  await put(join(dir, "plugin.json"), JSON.stringify({ name, version, ...manifest }));
  for (const [path, value] of Object.entries(files)) await put(join(dir, path), value);
  return dir;
}

try {
  await mkdir(pluginsRoot, { recursive: true });
  await put(catalogPath, JSON.stringify({
    categories: [{ title: "fixture", plugins: [
      { name: "below", version: "1", downloadCount: 29 },
      { name: "matrix", version: "1", downloadCount: 30 },
      { name: "no-count", version: "1" },
      { name: "bad-count", version: "1", downloadCount: "unknown" },
      { name: "version-mismatch", version: "2", downloadCount: 40 },
      { name: "duplicate", version: "1", downloadCount: 50 },
      { name: "build-only", version: "1", downloadCount: 30 },
      { name: "escaped", version: "1", downloadCount: 31 },
    ] }],
    latest: [
      { name: "matrix", version: "1", downloadCount: 30 },
      { name: "latest-only", version: "1", downloadCount: 10 },
    ],
  }));

  const main = '<script src="main.js"></script><script src="index.js?build=1#entry"></script><link href="styles/site.css"><style>@import "inline.css?version=2#inline";</style>';
  const pre = 'require("node:fs"); require("electron"); require(moduleName); import "./local.js"; window.utools = {}';
  await plugin("below", "below", "1", { main: "index.html", preload: "preload.js" }, { "index.html": main, "preload.js": "" });
  await plugin("matrix", "matrix", "1", { main: "index.html", preload: "preload.js" }, {
    "index.html": main,
    "main.js": 'window.utools.showNotification("ok"); require("node:path")',
    "index.js": 'require("node:fs")',
    "preload.js": pre,
    "local.js": 'require("left-pad")',
    "styles/site.css": '@import "theme.css?version=1#theme"; .data { background: url(data:image/png;base64,AAAA) } .blob { background: url(blob:https://example.invalid/id) } .icon { background: url("icons/mark.svg?size=2#mark") }',
    "styles/theme.css": '@import "theme-helper.js"',
    "styles/theme-helper.js": 'require("node:crypto")',
    "styles/icons/mark.svg": '<svg />',
    "addon.node": "fixture native marker",
    "package.json": JSON.stringify({ dependencies: { "runtime-only": "1" }, devDependencies: { "dev-only": "1" } }),
    "node_modules/hidden/index.js": 'require("hidden-native")',
    ".ignored/hidden.js": 'require("hidden-dot")',
  });
  await plugin("version-mismatch", "version-mismatch", "1", { main: "index.html" }, { "index.html": main });
  await plugin("duplicate-a", "duplicate", "1", { main: "index.html" }, { "index.html": main });
  await plugin("duplicate-b", "duplicate", "1", { main: "index.html" }, { "index.html": main });
  await plugin("build-only", "build-only", "1", { main: "src/main.ts" }, { "src/main.ts": "export const source = true" });
  await plugin("escaped", "escaped", "1", { main: "../outside.html", preload: "../../outside-preload.js" });

  const report = await buildPluginDownloadCapabilityMatrix({ catalogPath, pluginsRoot, threshold: 30 });
  assert.equal(report.summary.catalogUniqueNameVersionRows, 9, "eight category rows plus one latest-only identity; repeated matrix is deduplicated");
  assert.equal(report.summary.eligible, 5);
  assert.equal(report.summary.excludedBelowThreshold, 2);
  assert.equal(report.summary.unknownDownloadCount, 2, "missing and invalid counts remain unknown, not zero");
  const byName = (name) => report.plugins.find((row) => row.name === name);
  assert.equal(byName("below").cohort, "excluded_below_threshold");
  assert.equal(byName("matrix").cohort, "eligible", "30 is inclusive");
  assert.equal(byName("no-count").cohort, "unknown_download_count");
  assert.equal(byName("bad-count").countStatus, "invalid");
  assert.equal(byName("version-mismatch").localMatch, "version_mismatch");
  assert.equal(byName("duplicate").localMatch, "ambiguous_exact_name_version");
  assert.equal(byName("latest-only").cohort, "excluded_below_threshold");
  assert.ok(byName("build-only").capabilities.includes("build_only_or_source_entry"));
  assert.equal(byName("escaped").localMatch, "matched");
  assert.deepEqual(byName("escaped").details.entryStatuses, { main: "escaped", preload: "escaped" });
  assert.equal(byName("escaped").details.invalidManifestEntry, true);
  assert.ok(byName("escaped").capabilities.includes("static_scan_inconclusive"), "escaped manifest entries are rejected and disclosed as inconclusive");

  const matched = byName("matrix");
  assert.equal(matched.localMatch, "matched");
  assert.ok(matched.capabilities.includes("node_builtin:fs"), "node:fs normalizes to the fs builtin capability");
  assert.ok(matched.capabilities.includes("node_builtin:path"), "bare HTML script src is followed as a local resource");
  assert.ok(matched.capabilities.includes("node_builtin:crypto"), "CSS @import and url resources resolve relative to their source file");
  assert.ok(matched.capabilities.includes("electron_api"));
  assert.ok(matched.capabilities.includes("ztools_api"));
  assert.ok(matched.capabilities.includes("external_package_import"));
  assert.ok(matched.capabilities.includes("static_scan_inconclusive"), "dynamic require is unknown rather than silently complete");
  assert.ok(matched.capabilities.includes("native_addon_or_build_dependency"), "native addon files are surfaced as an implementation capability");
  assert.ok(matched.details.externalPackages.includes("left-pad"), "relative local import is traversed and left-pad remains npm package import");
  assert.deepEqual(matched.details.externalPackages, ["left-pad"], "HTML/CSS resource paths and inline style imports are not mislabeled as npm packages; JS bare imports remain packages");
  assert.deepEqual(matched.details.ignoredResourceUrls, ["blob:https://example.invalid/id", "data:image/png;base64,AAAA"]);
  assert.deepEqual(matched.details.runtimePackages, ["runtime-only"]);
  assert.deepEqual(matched.details.developmentPackages, ["dev-only"]);
  assert.ok(!matched.details.runtimePackages.includes("dev-only"), "development declaration is not labeled runtime dependency");
  assert.ok(!matched.details.externalPackages.includes("hidden-native"), "node_modules is excluded from traversal");
  assert.ok(!matched.details.externalPackages.includes("hidden-dot"), "dot-directories are excluded from traversal");
  const fsCapability = report.capabilityPriority.find((item) => item.capability === "node_builtin:fs");
  assert.equal(fsCapability.pluginCount, 1);
  assert.equal(fsCapability.downloadCountSum, 30);
  assert.ok(fsCapability.potentialDownloadCoverage > 0 && fsCapability.potentialDownloadCoverage < 1);
  assert.ok(report.plugins.every((row) => !row.details || row.details.heuristicOnly));

  const perPluginLimits = { ...defaultPluginMatrixLimits, files: 4, bytes: 8, entries: 40,
    totalFiles: 500, totalBytes: 512 * 1024, totalEntries: 5000, totalManifestBytes: 1024 * 1024 };
  const perPluginBounded = await buildPluginDownloadCapabilityMatrix({ catalogPath, pluginsRoot, threshold: 30, limits: perPluginLimits });
  assert.equal(perPluginBounded.semantics.sourceInventoryTruncated, true, "per-plugin exhaustion reaches report-level truncation");
  assert.equal(perPluginBounded.summary.sourceFileScanTruncated, true);
  assert.ok(perPluginBounded.summary.sourceFileScanTruncatedPlugins > 0);
  const boundedMatrix = perPluginBounded.plugins.find((row) => row.name === "matrix");
  assert.equal(boundedMatrix.details.truncated, true);
  assert.ok(boundedMatrix.capabilities.includes("static_scan_inconclusive"));
  assert.ok(boundedMatrix.details.heuristicOnly, "bounded scan remains heuristic and does not claim compatibility");

  const globalLimits = { ...defaultPluginMatrixLimits, files: 500, bytes: 512 * 1024, entries: 5000,
    totalFiles: 2, totalBytes: 512 * 1024, totalEntries: 5000, totalManifestBytes: 1024 * 1024 };
  const globallyBounded = await buildPluginDownloadCapabilityMatrix({ catalogPath, pluginsRoot, threshold: 30, limits: globalLimits });
  assert.equal(globallyBounded.semantics.sourceInventoryTruncated, true, "global exhaustion reaches report-level truncation");
  assert.equal(globallyBounded.summary.sourceFileScanTruncated, true);
  assert.ok(globallyBounded.summary.sourceFileScanTruncatedPlugins > 0);
  assert.ok(globallyBounded.plugins.some((row) => row.details?.truncated), "global cap marks affected local scans incomplete");
  process.stdout.write("plugin-download-capability-matrix fixtures passed\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
