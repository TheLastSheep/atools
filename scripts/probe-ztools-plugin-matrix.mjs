#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createWebKitRunner, loadHostFactories, startNodeFixture } from "./lib/legacy-node-webkit-fixture.mjs";
import { inlineOriginalPage, matrixFrameHtml } from "./lib/ztools-matrix-frame.mjs";
import { webCases } from "./fixtures/ztools-matrix-web.mjs";
import { preloadCases } from "./fixtures/ztools-matrix-preload.mjs";
import { findOriginalManifest, inventoryOriginalPlugins } from "./lib/ztools-matrix-inventory.mjs";
import { offlineWebCases } from "./fixtures/ztools-matrix-offline-web.mjs";
import { offlineNodeCases } from "./fixtures/ztools-matrix-offline-node.mjs";
import { desktopBusinessCases } from "./fixtures/ztools-matrix-desktop-business.mjs";
import { assessFixtureExecution, isReviewedMemoryProbe } from "./lib/ztools-matrix-safety.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageInfo = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const baselineCases = [...webCases, ...preloadCases];
const expandedCases = [...offlineWebCases, ...offlineNodeCases.map(row => ({ ...row, assertion: "business_function" })), ...desktopBusinessCases];
const catalog = [...baselineCases, ...expandedCases];
const options = { output: join(root, "output/legacy-node-2026-10-15/original-plugin-matrix-reviewed-only.json") };
for (let i = 2; i < process.argv.length; i++) {
  const argument = process.argv[i];
  if (argument === "--output" && process.argv[i + 1]) options.output = resolve(process.argv[++i]);
  else if (argument === "--plugins" && process.argv[i + 1]) options.plugins = process.argv[++i].split(",");
  else if (argument === "--discover") options.discover = true;
  else if (argument === "--batch" && process.argv[i + 1]) options.batch = process.argv[++i];
  else if (argument === "--list") { console.log(JSON.stringify(catalog.map(({ id, category, ui }) => ({ id, category, ui })), null, 2)); process.exit(0); }
  else if (argument === "--help") { console.log("Usage: node scripts/probe-ztools-plugin-matrix.mjs [--plugins id,id] [--batch expanded|all] [--discover] [--output report.json] [--list]\nExecution is frozen except the pinned Snipaste in-memory PNG parser. Unreviewed entries are recorded not_exercised before preload or page execution."); process.exit(0); }
  else throw new Error(`Unknown argument: ${argument}`);
}
let selected = options.plugins ? options.plugins.map(id => {
  if (options.discover) return { id };
  const probe = catalog.find(item => item.id === id); assert(probe, `Unknown matrix plugin ${id}`); return probe;
}) : options.batch === "expanded" ? expandedCases : options.batch === "all" ? catalog : baselineCases;
if (options.discover) {
  const inventory = await inventoryOriginalPlugins(join(root, "ZTools-plugins/plugins"));
  const existing = new Set(catalog.map(row => row.id));
  selected = (options.plugins ? selected : inventory.rows.filter(row => row.status === "released_entry" && !existing.has(row.id))).map(({ id }) => ({
    id, ui: true, discovery: true, category: "diagnostic-surface-only", async probe(ctx) {
      const state = window.__matrix;
      const globals = Object.keys(window).filter(key => !state.baselineGlobals.includes(key));
      const surface = {};
      for (const key of globals) {
        if (key.startsWith("__") || key === "webkit") continue;
        try {
          const value = window[key];
          surface[key] = typeof value === "function" ? "function" : value && typeof value === "object" ? Object.keys(value).slice(0, 40) : typeof value;
        } catch (error) { surface[key] = String(error); }
      }
      ctx.recordSurface({ globals: surface, text: document.body.innerText.slice(0, 1600),
        inputs: [...document.querySelectorAll("input,textarea,select")].slice(0, 20).map(el => ({ tag: el.tagName, id: el.id, type: el.type, placeholder: el.placeholder })),
        buttons: [...document.querySelectorAll("button")].slice(0, 20).map(el => ({ id: el.id, text: el.innerText.slice(0, 60), title: el.title })) });
    },
  }));
}
assert(!options.output.startsWith(join(root, "ZTools-plugins") + "/"), "Report cannot overwrite original plugins");
const scratch = await mkdtemp("/private/tmp/atools-plugin-matrix-");
const text = "站酷工具 🧰 中文 Base64";
const report = {
  schema_version: 1, generatedAt: new Date().toISOString(), selected: selected.map(item => item.id), rows: [],
  scope: {
    inventory: "Representative selected original plugin directories from the 180-directory audit; no extrapolation to all 180.",
    execution: "Original preload/CJS and selected original UI business code in native non-persistent opaque WKWebView; current preparePluginPreload and nodeModuleBridgeScript with real Node primitives through temporary Node HTTP fixture.",
    uiTransport: "Existing local released scripts are inlined at the end of original DOM. Static ESM imports are read-only bundled into the temporary frame; this does not prove the product asset resolver or production CSP.",
    visual: "Linked styles, images and fonts are not exercised; no screenshot, layout or visual fidelity acceptance is claimed.",
    host: "Real local callback/tool registration and immutable current project package name/version plus actual process.platform metadata are provided. Other host APIs are absent and recorded; no blanket success mocks, fabricated DB, clipboard, dialogs or external services. Metadata does not establish the complete product host.",
    offline: "WebKit CSP and a Node JS policy reject external requests, but native descendants can bypass that policy. Fixtures are not OS sandboxes. A prior TinyRDM diagnostic caused a real preferences-directory/native-listener side effect; see tinyrdm-probe-incident.json. This stage now refuses unreviewed entries before preload/page execution.",
    environment: "Each Node and native WK invocation gets private temporary HOME/XDG/APPDATA/TMP directories and an explicit non-credential environment whitelist. This does not constrain hardcoded absolute paths or native networking.",
    sourceHashes: "OriginalSourcesUnchanged checks the observed source bytes only, not mode/xattr, user files, external connections or complete filesystem read-only behavior.",
    acceptance: "No product Rust HTTP, Tauri authorization UX, full original UI workflows or ecosystem-wide compatibility acceptance is claimed.",
    timings: "Single operation samples, including synchronous bridge round trips; unrelated to Rust matcher latency budgets.",
    exitCode: "Zero means the matrix completed and recorded outcomes; consult per-case business status rather than assuming every selected plugin passed.",
  },
};

async function runtimeSnapshot() {
  const snapshot = join(scratch, "runtime-snapshot"); report.hostSourceHashes = {};
  report.fixtureSourceHashes = {};
  const fixtureFiles = ["scripts/probe-ztools-plugin-matrix.mjs", "scripts/lib/legacy-node-webkit-fixture.mjs", "scripts/lib/legacy-node-environment.mjs", "scripts/lib/native-smoke-descendants.mjs", "scripts/lib/ztools-matrix-frame.mjs", "scripts/lib/ztools-matrix-inventory.mjs", "scripts/lib/ztools-matrix-offline-policy.mjs", "scripts/lib/ztools-matrix-safety.mjs",
    "scripts/fixtures/legacy-node-webkit.swift", "scripts/fixtures/ztools-matrix-web.mjs", "scripts/fixtures/ztools-matrix-preload.mjs", "scripts/fixtures/ztools-matrix-offline-web.mjs", "scripts/fixtures/ztools-matrix-offline-node.mjs", "scripts/fixtures/ztools-matrix-desktop-business.mjs"];
  for (const file of fixtureFiles) report.fixtureSourceHashes[file] = digest(await readFile(join(root, file), "utf8"));
  const files = ["src/lib/nodeModuleBridge.ts", "src/lib/nodeModuleValues.ts", "src/lib/nodeBufferNumbers.ts", "src/lib/nodeModuleTransport.ts", "src/lib/pluginSourceAnalysis.ts", "src/lib/pluginModuleImports.ts", "src/lib/pluginPreload.ts", "src/lib/pluginElectronAdapter.ts",
    "crates/atools-plugin/src/legacy_node/codec.cjs", "crates/atools-plugin/src/legacy_node/bootstrap.cjs"];
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8"); report.hostSourceHashes[file] = digest(source);
    await mkdir(dirname(join(snapshot, file)), { recursive: true }); await writeFile(join(snapshot, file), source);
  }
  return snapshot;
}

function digest(source) { return createHash("sha256").update(source).digest("hex"); }
function classify(row) {
  if (row.executionReview?.allowed === false) return "not_exercised";
  if (row.discovery) return "discovery_only";
  if (/exceeds fixture file budget/.test(row.infrastructureError || row.preparationError || "")) return "fixture_budget_blocked";
  if (row.infrastructureError) return "fixture_failed";
  const passed = row.frame?.cases?.filter(item => item.status === "business_passed").length || 0;
  if (passed) return row.frame.cases.every(item => item.status === "business_passed") ? "business_passed" : "business_partial";
  if (row.frame?.cases?.length && row.frame.cases.every(item => item.status === "validation_passed")) return "validation_only";
  if (row.frame?.cases?.length && row.frame.cases.every(item => item.status === "scope_blocked")) return "scope_blocked";
  const errors = [row.preparationError, ...(row.frame?.loadErrors || []).map(item => item.error),
    ...(row.frame?.hostFailures || []).map(item => item.error), ...(row.frame?.cases || []).map(item => item.error)].join("\n");
  if (/Cannot find module|MODULE_NOT_FOUND/.test(errors)) return "missing_dependencies";
  if (/excludes the current macOS platform/.test(errors)) return "platform_blocked";
  if (/ENTRY_REQUIRES_BUILD|ENOENT|No host-recognized original manifest/.test(errors)) return "entry_not_ready";
  if (/HOST_|ERR_ATOOLS_HOST_API|not a function|undefined.*object|undefined.*propert/i.test(errors)) return "api_service_blocked";
  if (/HAR_ANALYSIS_FAILED|CONTRACT_COMPARISON_FAILED|module script|import/i.test(errors)) return "runtime_module_blocked";
  if (row.frame?.preloadLoaded && !row.frame?.cases?.length) return "load_only";
  return "business_failed";
}

async function runPlugin(descriptor, factories, runner, runtimeRoot) {
  const pluginDir = await realpath(join(root, "ZTools-plugins/plugins", descriptor.id));
  const row = { id: descriptor.id, category: descriptor.category, uiIncluded: descriptor.ui, ...(descriptor.discovery ? { discovery: true } : {}),
    beganAt: new Date().toISOString(),
    ...(descriptor.coverage ? { coverage: descriptor.coverage } : {}),
    assertionKind: descriptor.assertion || (descriptor.ui ? "ui_behavior" : "business_function"),
    originalSources: {}, dynamicImportSourceEvidence: [], missingDependencies: [] };
  const readTracked = async file => {
    const canonical = await realpath(file);
    assert(canonical.startsWith(pluginDir + "/"), "Source must remain inside its original plugin directory");
    const metadata = await stat(canonical);
    if (!metadata.isFile()) throw Object.assign(new Error("Original source is not a file"), { code: "EISDIR" });
    assert(metadata.size <= 8 * 1024 * 1024, "Original source exceeds fixture file budget");
    const source = await readFile(canonical, "utf8");
    const relativeFile = relative(pluginDir, canonical);
    if (!(relativeFile in row.originalSources)) source.split("\n").forEach((line, index) => {
      if (/\bimport\s*\(/.test(line)) row.dynamicImportSourceEvidence.push({ file: relativeFile, line: index + 1, expression: line.trim().slice(0, 240) });
    });
    row.originalSources[relativeFile] = digest(source);
    return source;
  };
  let session;
  try {
    row.executionReview = await assessFixtureExecution(descriptor, file => readTracked(join(pluginDir, file)));
    if (!row.executionReview.allowed) return row;
    const { manifest, candidate, base } = await findOriginalManifest(pluginDir, readTracked); row.manifest = candidate;
    assert(!manifest.platform?.length || manifest.platform.includes("darwin"), "Original plugin excludes the current macOS platform");
    assert(typeof manifest.main === "string" && !/^https?:/.test(manifest.main), "A released local UI entry is required");
    const entry = resolve(base, manifest.main.replace(/^\//, "")), originalHtml = await readTracked(entry);
    assert(!/<script[^>]*src=["']\/?(?:src\/main\.|main\.tsx)/i.test(originalHtml), "ENTRY_REQUIRES_BUILD: original page points to an unbuilt source entry");
    row.main = manifest.main; row.preload = manifest.preload || null;
    for (const file of descriptor.sourceFiles || []) await readTracked(resolve(pluginDir, file));
    const externals = new Set(); let computedImportsNeedNode = false;
    let preload = "";
    const prepareStarted = performance.now();
    if (manifest.preload) {
      preload = await factories.preparePluginPreload({ pluginDir, preloadPath: resolve(base, manifest.preload), readTextFile: readTracked,
        onExternalRequire: specifier => externals.add(specifier), onNodeModuleImportNeeded: () => { computedImportsNeedNode = true; } });
    }
    row.preloadPreparationMs = performance.now() - prepareStarted;
    row.externalModules = [...externals]; row.resolvedDependencyLocations = {};
    const resolver = createRequire(resolve(base, manifest.preload || "matrix-only.cjs"));
    for (const specifier of externals) {
      if (specifier === "electron") continue;
      try {
        const location = resolver.resolve(specifier);
        if (location !== specifier && !location.startsWith("node:")) row.resolvedDependencyLocations[specifier] = location;
      } catch { row.missingDependencies.push(specifier); }
    }
    const needsNode = computedImportsNeedNode || [...externals].some(specifier => specifier !== "electron");
    let bridge;
    if (needsNode) {
      session = await startNodeFixture(runtimeRoot, pluginDir, resolve(base, manifest.preload));
      row.nodeStartupMs = session.startupMs; row.nodeVersion = session.initialize.nodeVersion;
      row.fixtureEnvironment = session.isolation;
      bridge = factories.nodeModuleBridgeScript({ endpoint: session.endpoint });
    }
    let page = "<!doctype html><html><head></head><body></body></html>";
    if (descriptor.ui) {
      const prepared = await inlineOriginalPage(originalHtml, entry, pluginDir, readTracked);
      page = prepared.html; row.omittedExternalScripts = prepared.omittedAssets; row.inlineWarnings = prepared.warnings;
    }
    const config = {
      id: descriptor.id, ui: descriptor.ui, text, md5: createHash("md5").update(text).digest("hex"),
      hostMetadata: { name: packageInfo.productName || packageInfo.name, version: packageInfo.version, platform: process.platform },
      base64: Buffer.from(text).toString("base64"), hmac: createHmac("sha256", "fixture-secret").update(text).digest("hex"),
      scanDir: join(scratch, "scan-root"), inputFile: join(scratch, "input.txt"), outputFile: join(scratch, `${descriptor.id}.txt`),
      scratchDir: scratch,
      pngFile: join(scratch, "fixture.png"), pngBase64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    };
    config.pngDataUrl = "data:image/png;base64," + config.pngBase64;
    await writeFile(config.pngFile, Buffer.from(config.pngBase64, "base64"));
    row.frame = await runner.runFrame(matrixFrameHtml({ page, preload, bridge, config, probe: descriptor.probe,
      electronFactory: factories.createPluginElectronAdapter }), descriptor.id);
    assert.equal(row.frame.passed, true, JSON.stringify(row.frame));
    assert.equal(row.frame.nativeNonPersistentDataStore, true);
    assert.equal(row.frame.messageOrigin, "null");
    assert(descriptor.discovery || row.frame.cases.length >= 1, "Each selected plugin must attempt a real business assertion");
    if (session) row.transport = JSON.parse(JSON.stringify(session.stats));
  } catch (error) {
    const message = String(error.stack || error);
    if (/ENTRY_REQUIRES_BUILD|ENOENT|preload|manifest|platform|module|source/i.test(message)) row.preparationError = message;
    else row.infrastructureError = message;
  } finally {
    if (session) row.cleanup = await session.stop();
    else row.cleanup = { nodeNotStarted: true };
    row.originalSourcesUnchanged = true;
    for (const [file, hash] of Object.entries(row.originalSources)) {
      if (digest(await readFile(join(pluginDir, file), "utf8")) !== hash) row.originalSourcesUnchanged = false;
    }
    row.status = classify(row);
    row.finishedAt = new Date().toISOString();
  }
  return row;
}

try {
  const runtimeRoot = await runtimeSnapshot();
  let factories, runner;
  if (selected.some(isReviewedMemoryProbe)) {
    factories = await loadHostFactories(runtimeRoot, scratch); runner = await createWebKitRunner(root, scratch);
    report.swiftCompileMs = runner.compileMs;
  }
  await mkdir(join(scratch, "scan-root/folder"), { recursive: true });
  await Promise.all([writeFile(join(scratch, "scan-root/folder/inside.txt"), "inside"), writeFile(join(scratch, "scan-root/keep.txt"), "keep"),
    writeFile(join(scratch, "scan-root/ignore.txt"), "ignore"), writeFile(join(scratch, "scan-root/.hidden"), "hidden"), writeFile(join(scratch, "input.txt"), text)]);
  for (const descriptor of selected) {
    const row = await runPlugin(descriptor, factories, runner, runtimeRoot); report.rows.push(row);
    console.log(`${row.id}: ${row.status}; ${row.frame?.cases?.filter(item => item.status === "business_passed").length || 0}/${row.frame?.cases?.length || 0} business assertions passed`);
    // Preserve a useful partial report if another sample has an infrastructure failure.
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
  }
  const count = predicate => report.rows.filter(predicate).length;
  report.summary = { selected: selected.length, completed: report.rows.length,
    businessPassed: count(row => row.status === "business_passed"), businessPartial: count(row => row.status === "business_partial"),
    missingDependencies: count(row => row.status === "missing_dependencies"), apiServiceBlocked: count(row => row.status === "api_service_blocked"),
    runtimeModuleBlocked: count(row => row.status === "runtime_module_blocked"), loadOnly: count(row => row.status === "load_only"),
    platformBlocked: count(row => row.status === "platform_blocked"), entryNotReady: count(row => row.status === "entry_not_ready"),
    businessFailed: count(row => row.status === "business_failed"), fixtureFailed: count(row => row.status === "fixture_failed"),
    validationOnly: count(row => row.status === "validation_only"), scopeBlocked: count(row => row.status === "scope_blocked"), discoveryOnly: count(row => row.status === "discovery_only"),
    fixtureBudgetBlocked: count(row => row.status === "fixture_budget_blocked"),
    notExercised: count(row => row.status === "not_exercised"),
    dependencyResolutionMissing: count(row => row.missingDependencies.length > 0),
    pagesLoadedWithBusinessPassed: count(row => row.uiIncluded && row.status === "business_passed" && row.frame.loadErrors.length === 0),
    uiBehaviorPassed: count(row => row.assertionKind === "ui_behavior" && row.status === "business_passed" && row.frame.loadErrors.length === 0),
    sourceHashesUnchanged: report.rows.every(row => row.originalSourcesUnchanged),
    resourcesReleased: report.rows.every(row => row.cleanup.nodeNotStarted || row.cleanup.listenerClosed && row.cleanup.nodeProcessStopped && row.cleanup.isolatedEnvironmentRemoved),
  };
  report.completed = report.rows.length === selected.length && report.summary.fixtureFailed === 0;
  report.allSelectedBusinessPassed = report.summary.businessPassed === selected.length;
} catch (error) { report.completed = false; report.infrastructureError = String(error.stack || error); }
finally {
  await rm(scratch, { recursive: true, force: true }); report.scratchRemoved = true;
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ completed: report.completed, summary: report.summary, output: options.output, error: report.infrastructureError }, null, 2));
if (!report.completed || report.summary?.resourcesReleased === false || report.summary?.sourceHashesUnchanged === false) process.exitCode = 1;
