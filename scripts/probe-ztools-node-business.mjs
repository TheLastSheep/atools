#!/usr/bin/env node
// Real untouched plugin business functions through the current WebKit/Node factories.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWebKitRunner, loadHostFactories, startNodeFixture } from "./lib/legacy-node-webkit-fixture.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const options = { output: join(root, "output/legacy-node-2026-10-15/original-plugin-business-result.json"), iterations: 5 };
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--output" && args[i + 1]) options.output = resolve(args[++i]);
  else if (args[i] === "--iterations" && args[i + 1]) options.iterations = Number(args[++i]);
  else if (args[i] === "--help") {
    console.log("Usage: node scripts/probe-ztools-node-business.mjs [--output report.json] [--iterations 1..30]");
    process.exit(0);
  } else throw new Error(`Unknown argument: ${args[i]}`);
}
assert(Number.isInteger(options.iterations) && options.iterations >= 1 && options.iterations <= 30);
assert(!options.output.startsWith(join(root, "ZTools-plugins") + "/"), "Output must not modify plugin sources");
const scratch = await mkdtemp("/private/tmp/atools-original-plugin-");
const text = "站酷工具 🧰 中文 Base64";
const files = ["char-transform/preload.js", "char-transform/lib/char-transform.cjs", "file-tree/preload.js"];
const runtimeFiles = ["src/lib/nodeModuleBridge.ts", "src/lib/nodeModuleValues.ts", "src/lib/nodeModuleTransport.ts",
  "src/lib/pluginPreload.ts", "crates/atools-plugin/src/legacy_node/codec.cjs", "crates/atools-plugin/src/legacy_node/bootstrap.cjs"];
async function sourceHashes() {
  return Object.fromEntries(await Promise.all(files.map(async file => [file,
    createHash("sha256").update(await readFile(join(root, "ZTools-plugins/plugins", file))).digest("hex")])));
}
async function runtimeSourceHashes() {
  return Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file,
    createHash("sha256").update(await readFile(join(root, file))).digest("hex")])));
}
const report = {
  schema_version: 1, startedAt: new Date().toISOString(),
  scope: "Untouched original char-transform CJS/preload and file-tree preload execute locally in opaque non-persistent WKWebView frames. Current preparePluginPreload + nodeModuleBridgeScript (same runtime as makeNodeModuleRequire) forward real Node primitives through a temporary Node HTTP fixture. No product Rust HTTP, capability approval, TaskRun, or complete Tauri gate acceptance is claimed.",
  timingDefinitions: {
    nodeStartupMs: "Fresh Node spawn to initialize response, excluding HTTP/WebKit/preload preparation.",
    preloadPreparationMs: "Current bounded CJS source-graph preparation, no plugin execution.",
    cold: "First business invocation after preload/module initialization in a fresh session.",
    warm: "Repeated invocations within the same session; all HTTP RPCs remain measured.",
    limits: "Small synthetic fixture only; no p95 acceptance, RSS, UI responsiveness or ecosystem-wide success claim.",
  }, plugins: [],
};

/** This function is serialized and runs entirely inside the opaque plugin frame. */
async function businessProbe(config) {
  const result = { passed: false, cases: [], clientOrigin: location.origin };
  const events = window.__probeEvents;
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  const methods = list => Object.fromEntries([...new Set(list.map(event => event.method))]
    .map(method => [method, list.filter(event => event.method === method).length]));
  async function measure(name, fn, phase = "cold") {
    const before = events.length, started = performance.now();
    const value = await fn();
    const durationMs = performance.now() - started;
    const requests = events.slice(before);
    result.cases.push({ name, phase, durationMs, requests: requests.length, methods: methods(requests),
      callbackArguments: requests.reduce((sum, event) => sum + event.callbacks, 0), value });
    return value;
  }
  try {
    try { void parent.document.body; result.parentDocumentBlocked = false; }
    catch { result.parentDocumentBlocked = true; }
    check(result.parentDocumentBlocked, "Parent document must remain inaccessible");
    check(!window.__probeError, window.__probeError);
    result.initializationRequests = events.length;
    if (config.kind === "char-transform") {
      const api = window.charTransformApi;
      check(api?.modes.includes("md5") && api.modes.includes("base64"), "Original preload API did not initialize");
      const first = await measure("original-md5", () => api.transform(config.text, "md5"));
      check(first === config.md5, "Original MD5 differs");
      for (let i = 0; i < config.iterations; i++) {
        const hash = await measure("original-md5", () => api.transform(config.text, "md5"), "warm");
        check(hash === config.md5, "Warm original MD5 differs");
      }
      const encoded = await measure("original-ChineseBase64encode", () => api.transform(config.text, "base64"));
      check(encoded === config.base64, "Original Chinese Base64 encoding differs");
      const decoded = await measure("original-ChineseBase64decode", () => api.transform(config.base64, "base64decode"));
      check(decoded === config.text, "Original Chinese Base64 decoding differs");
      let rejected = false;
      try { api.transform("bad=base64!", "base64decode"); } catch { rejected = true; }
      check(rejected, "Original invalid Base64 validation must throw");
      result.originalInvalidBase64Rejected = true;
    } else {
      const api = window.services, ignored = [];
      check(typeof api?.scanDirectory === "function", "Original file-tree preload API did not initialize");
      const shouldIgnore = name => { ignored.push(name); return name === "ignore.txt" || name === "ignored-dir"; };
      for (let i = 0; i <= config.iterations; i++) {
        const tree = await measure("original-scanDirectory-with-local-closure", () => api.scanDirectory(config.scanDir, false, shouldIgnore), i ? "warm" : "cold");
        check(JSON.stringify(tree) === JSON.stringify(config.expectedTree), "Original directory tree differs: " + JSON.stringify(tree));
      }
      check(ignored.includes("ignore.txt") && ignored.includes("ignored-dir"), "Local closure predicate did not execute");
      check(result.cases.every(item => item.callbackArguments === 0), "Directory predicate was incorrectly sent to Node");
      result.localPredicateCalls = ignored.length;
      const callbackFileText = await measure("fs.readFile-local-async-callback", async () => {
        let callback;
        try {
          return await new Promise((resolve, reject) => {
            callback = (error, value) => error ? reject(error) : resolve(value);
            window.__atoolsNodeModuleRequire("fs").readFile(config.asyncFile, "utf8", callback);
          });
        } finally { window.__atoolsNodeModuleRequire.releaseCallbacks(callback); }
      });
      check(callbackFileText === config.text, "Async Node callback changed file text");
      const promiseFileText = await measure("fs.promises.readFile", () => window.__atoolsNodeModuleRequire("fs/promises").readFile(config.asyncFile, "utf8"));
      check(promiseFileText === config.text, "Node Promise changed file text");
    }
    window.__atoolsNodeModuleRequire.close();
    await new Promise(resolve => setTimeout(resolve, 60));
    result.totalRequests = events.length;
    result.totalMethods = methods(events);
    result.passed = true;
  } catch (error) { result.error = String(error?.stack || error); }
  parent.postMessage({ type: "business-result", result }, "*");
}

function frameHtml(bridge, preload, config) {
  const instrumentation = `
window.__probeEvents = [];
window.addEventListener('error', event => { window.__probeError = String(event.error?.stack || event.message); });
window.utools = {};
function record(body, async) {
  try { const request = JSON.parse(body); window.__probeEvents.push({ method: request.method, async,
    callbacks: (body.match(/"kind":"callback"/g) || []).length }); } catch {}
}
const originalOpen = XMLHttpRequest.prototype.open, originalSend = XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open = function(method, url, async = true) { this.__probeAsync = async; return originalOpen.apply(this, arguments); };
XMLHttpRequest.prototype.send = function(body) { record(body, this.__probeAsync); return originalSend.apply(this, arguments); };
const originalFetch = window.fetch;
window.fetch = function(url, options) { record(options?.body, true); return originalFetch.apply(this, arguments); };
`;
  const initialization = `window.__atoolsNodeModuleRequire = ${bridge};
window.require = window.__atoolsNodeModuleRequire;
window.process = window.require('process');
window.Buffer = window.require('buffer').Buffer;
if (!window.setImmediate) window.setImmediate = function(fn) { return setTimeout(fn, 0); };
if (!window.clearImmediate) window.clearImmediate = clearTimeout;
`;
  const script = source => `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`;
  return `<!doctype html><meta charset="utf-8">${script(instrumentation)}${script(initialization)}${preload}${script(`(${businessProbe.toString()})(${JSON.stringify(config)})`)}`;
}

function summarize(plugin) {
  const grouped = {};
  for (const item of plugin.webKit.cases || []) {
    const key = `${item.name}:${item.phase}`;
    (grouped[key] ??= []).push(item.durationMs);
  }
  return Object.fromEntries(Object.entries(grouped).map(([name, samples]) => [name, {
    samples: samples.length, minMs: Math.min(...samples), maxMs: Math.max(...samples),
    meanMs: samples.reduce((sum, value) => sum + value, 0) / samples.length,
  }]));
}

try {
  report.originalSourceHashesBefore = await sourceHashes();
  report.runtimeSourceHashesBefore = await runtimeSourceHashes();
  const factories = await loadHostFactories(root, scratch);
  assert.equal(typeof factories.makeNodeModuleRequire, "function");
  const runner = await createWebKitRunner(root, scratch);
  report.swiftCompileMs = runner.compileMs;
  const scanDir = join(scratch, "scan-root"), asyncFile = join(scratch, "async.txt");
  await mkdir(join(scanDir, "folder"), { recursive: true });
  await mkdir(join(scanDir, "ignored-dir"));
  await Promise.all([writeFile(join(scanDir, "folder/inside.txt"), "inside"), writeFile(join(scanDir, "keep.txt"), "keep"),
    writeFile(join(scanDir, "ignore.txt"), "ignore"), writeFile(join(scanDir, ".hidden"), "hidden"), writeFile(asyncFile, text)]);
  const leaf = name => ({ name, comment: "", children: [] });
  const expectedTree = { ...leaf("scan-root"), children: [{ ...leaf("folder"), children: [leaf("inside.txt")] }, leaf("keep.txt")] };
  for (const kind of ["char-transform", "file-tree"]) {
    const pluginDir = join(root, "ZTools-plugins/plugins", kind), preloadPath = join(pluginDir, "preload.js");
    const externals = new Set(), reads = [];
    const prepareStarted = performance.now();
    const preload = await factories.preparePluginPreload({ pluginDir, preloadPath,
      readTextFile: async file => { reads.push(file.slice(pluginDir.length + 1)); return readFile(file, "utf8"); },
      onExternalRequire: specifier => externals.add(specifier) });
    const plugin = { id: kind, preloadPreparationMs: performance.now() - prepareStarted,
      sourceReads: reads, externalModules: [...externals] };
    report.plugins.push(plugin);
    const session = await startNodeFixture(root, pluginDir, preloadPath);
    try {
      plugin.nodeStartupMs = session.startupMs;
      plugin.nodeVersion = session.initialize.nodeVersion;
      plugin.webKit = await runner.runFrame(frameHtml(factories.nodeModuleBridgeScript({ endpoint: session.endpoint }), preload, {
        kind, text, iterations: options.iterations, md5: createHash("md5").update(text).digest("hex"),
        base64: Buffer.from(text).toString("base64"), scanDir, asyncFile, expectedTree,
      }), kind);
      plugin.transport = session.stats;
      plugin.timingSummary = summarize(plugin);
      assert.equal(plugin.webKit.passed, true, JSON.stringify(plugin.webKit));
      assert.equal(plugin.webKit.nativeNonPersistentDataStore, true);
      assert.equal(plugin.webKit.messageOrigin, "null");
      assert.equal(plugin.webKit.clientOrigin, "null");
      assert.equal(plugin.webKit.totalRequests, session.stats.requests);
    } finally { plugin.cleanup = await session.stop(); }
    assert.equal(plugin.cleanup.listenerClosed, true);
    assert.equal(plugin.cleanup.nodeProcessStopped, true);
  }
  report.originalSourceHashesAfter = await sourceHashes();
  report.runtimeSourceHashesAfter = await runtimeSourceHashes();
  assert.deepEqual(report.originalSourceHashesBefore, report.originalSourceHashesAfter);
  assert.deepEqual(report.runtimeSourceHashesBefore, report.runtimeSourceHashesAfter);
  report.runtimeSourcesUnchangedDuringProbe = true;
  report.originalSourcesUnchanged = true;
  report.passed = true;
} catch (error) { report.passed = false; report.error = String(error.stack || error); }
finally {
  await rm(scratch, { recursive: true, force: true });
  report.scratchRemoved = true;
  await mkdir(dirname(options.output), { recursive: true });
  await writeFile(options.output, JSON.stringify(report, null, 2) + "\n");
}
console.log(JSON.stringify({ passed: report.passed, output: options.output, plugins: report.plugins.map(plugin => ({
  id: plugin.id, nodeStartupMs: plugin.nodeStartupMs, requests: plugin.transport?.requests,
  timingSummary: plugin.timingSummary, cleanup: plugin.cleanup,
})), error: report.error }, null, 2));
if (!report.passed) process.exitCode = 1;
