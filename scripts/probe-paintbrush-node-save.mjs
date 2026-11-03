#!/usr/bin/env node
// Headless Chromium + real Node sidecar bridge; this is not Rust permission or OS-picker acceptance.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, createPageWebSocketUrl, delay } from "./chrome-cdp-smoke-utils.mjs";
import { loadHostFactories, startNodeFixture } from "./lib/legacy-node-webkit-fixture.mjs";
import { PaintbrushProbeResourceJournal } from "./lib/paintbrush-probe-resource-journal.mjs";
import { observeOwnedProcessGroup } from "./lib/paintbrush-probe-resource-journal.mjs";
import { PaintbrushCdpStartupObserver } from "./lib/paintbrush-cdp-startup-observer.mjs";
import { createPaintbrushLoopbackFixture } from "./lib/paintbrush-loopback-fixture.mjs";
import { installExtraHostModuleSources, launchManagedChrome, loadHostClipboardFactory, makeValidPng, paintbrushChildHtml, sha256 } from "./lib/paintbrush-node-save-fixture.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_DIR = join(ROOT, "ZTools-plugins/plugins/clipboard-image-paintbrush");
const PRELOAD_PATH = join(PLUGIN_DIR, "preload.js");
const IMAGE_SIZES = { accepted505KiB: 505 * 1024, acceptedNearCap: 524220, rejectedOverCap: 525762 };
const TRACKED_SOURCES = [
  "scripts/lib/legacy-node-webkit-fixture.mjs", "scripts/lib/paintbrush-node-save-fixture.mjs",
  "scripts/lib/paintbrush-probe-resource-journal.mjs",
  "scripts/lib/paintbrush-cdp-startup-observer.mjs",
  "scripts/lib/paintbrush-loopback-fixture.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
  "ZTools-plugins/plugins/clipboard-image-paintbrush/plugin.json",
  "ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js",
  "src/lib/nodeModuleBridge.ts", "src/lib/nodeModuleTransport.ts", "src/lib/nodeModulePayloadBudget.ts",
  "src/lib/nodeModuleValues.ts", "src/lib/nodeModuleProtocol.ts", "src/lib/nodeBufferNumbers.ts", "src/lib/browserBuffer.ts", "src/lib/pluginPreload.ts",
  "src/lib/pluginSourceAnalysis.ts", "src/lib/pluginModuleImports.ts", "src/lib/pluginElectronAdapter.ts",
  "src/lib/pluginElectronWebFrame.ts", "src/lib/pluginNativeImage.ts", "src/lib/hostClipboardBridge.ts",
  "crates/atools-plugin/src/legacy_node/codec.cjs", "crates/atools-plugin/src/legacy_node/bootstrap.cjs",
  "scripts/lib/ztools-matrix-offline-policy.mjs", "scripts/lib/legacy-node-environment.mjs",
  "scripts/lib/native-smoke-descendants.mjs",
];
const args = process.argv.slice(2);
let explicitOutput = "";
let baselinePath = "", baselineSha256 = "";
for (let index = 0; index < args.length; index++) {
  if (args[index] === "--output" && args[index + 1]) explicitOutput = resolve(args[++index]);
  else if (args[index] === "--baseline" && args[index + 1]) baselinePath = resolve(args[++index]);
  else if (args[index] === "--baseline-sha256" && args[index + 1]) baselineSha256 = args[++index].toLowerCase();
  else if (args[index] === "--help") {
    console.log("Usage: node scripts/probe-paintbrush-node-save.mjs [--output report.json] [--baseline before.json --baseline-sha256 <sha256>]");
    process.exit(0);
  } else throw new Error(`Unknown argument: ${args[index]}`);
}
const runId = randomBytes(12).toString("hex");
const outputDir = explicitOutput ? dirname(explicitOutput) : join(ROOT, "output/plugin-input-2026-10-19/batch49-node-save", runId);
const reportPath = explicitOutput || join(outputDir, "report.json");
const journalPath = `${reportPath}.resources.json`;
const resourceJournal = new PaintbrushProbeResourceJournal(journalPath, runId);
const report = {
  schemaVersion: 1, runId, startedAt: new Date().toISOString(), passed: false,
  scope: "Unmodified clipboard-image-paintbrush preload runs in an opaque headless Chromium frame. Production Node module codec/bootstrap, production host clipboard bridge/Electron adapter, and production BrowserBuffer/Node module bridge are used with a real system Node child and real Node fs writes. A minimal local ZTools/electron listener shim supplies only fixture methods; image endpoint, save picker, notification, and hide-window behavior are explicit stubs. No Rust permission/TaskRun, packaged Node runtime, OS clipboard, native picker, or native app workflow is exercised.",
  limits: { acceptedPngMaxBytes: 512 * 1024, imageResponseMaxBytes: 700 * 1024, timeoutChanges: false,
    fixtureFiles: Object.fromEntries(Object.entries(IMAGE_SIZES).map(([name, bytes]) => [name, { bytes, validPng: true }])) },
  sourceHashesBefore: {}, sourceHashesAfter: {}, baselineBinding: { path: baselinePath || null, sha256: baselineSha256 || null, matched: null },
  resourceJournalPath: journalPath,
  setup: { loopbackPreflight: "not-run", childStartAttempted: false, nodeFixtureReady: false },
  runtimeIdentity: {}, browserNetwork: null, parentHttp: { healthCheck: null, server: null },
  hostClipboardFixture: { endpoint: "127.0.0.1 loopback, token redacted", requests: 0, preflights: 0 },
  cases: [], cleanup: { browserCdpClosed: false, browserCloseReturned: false, browserStop: null,
    browserGroupBeforeStop: null, browserGroupAfterStop: null, nodeFixtureStop: null,
    nodeGroupBeforeStop: null, nodeGroupAfterStop: null, clipboardListenerClosed: false,
    clipboardSocketsClosed: false, scratchRemoved: false, outputReportWritten: false },
};
let scratch = "", browser = null, page = null, nodeSession = null, imageServer = null, imageFixture = null;
let imageServerPort = 0;
let imageMetrics = null;
let fatal = null;
let browserStartupObserver = null;

function sourceDigest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function nodeRpcSnapshot() {
  return nodeSession ? { requests: nodeSession.stats.requests, methods: { ...nodeSession.stats.methods },
    preflights: nodeSession.stats.preflights, rejected: nodeSession.stats.rejected, origins: Object.keys(nodeSession.stats.origins) } : null;
}
async function snapshotSources() {
  const result = {};
  for (const name of TRACKED_SOURCES) {
    const content = await readFile(join(ROOT, name));
    result[name] = { bytes: content.length, sha256: sourceDigest(content) };
  }
  for (const name of ["scripts/probe-paintbrush-node-save.mjs"]) {
    const content = await readFile(join(ROOT, name));
    result[name] = { bytes: content.length, sha256: sourceDigest(content) };
  }
  return result;
}
function hashExecutable(path) {
  return readFile(path).then((bytes) => ({ bytes: bytes.length, sha256: sourceDigest(bytes) }));
}
function errorCode(error) { return String(error?.code || error?.name || "Error").slice(0, 80); }
function errorMessageSafe(error) {
  return String(error?.message || error || "unknown")
    .replace(/\/(host|node)\/[a-f0-9]{64}/gi, "/$1/[redacted]")
    .replace(/data:image\/png;base64,[A-Za-z0-9+/=]+/gi, "data:image/png;base64,[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[url]").slice(0, 240);
}
function scriptTag(source) { return `<script>${source.replace(/<\/script/gi, "<\\/script")}</script>`; }
async function ensureReportPath() {
  await mkdir(outputDir, { recursive: true });
  for (const path of [reportPath, journalPath]) await access(path).then(() => { throw new Error("Refusing to overwrite an existing probe artifact"); }, (error) => {
    if (error.code !== "ENOENT") throw error;
  });
}
async function preflightLoopback() {
  const probe = createServer();
  await new Promise((resolveListen, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolveListen);
  });
  await new Promise((resolveClose, reject) => probe.close((error) => error ? reject(error) : resolveClose()));
  return true;
}
async function confirmPortRefused(port) {
  const socket = createConnection({ host: "127.0.0.1", port });
  return new Promise((resolveResult) => {
    socket.once("connect", () => { socket.destroy(); resolveResult(false); });
    socket.once("error", (error) => resolveResult(error.code === "ECONNREFUSED"));
  });
}
async function confirmPathAbsent(path) {
  try { await access(path); return false; }
  catch (error) { return error.code === "ENOENT"; }
}
async function captureImage(dataUrl, label) {
  const expression = `fetch(${JSON.stringify(dataUrl)}).then(r=>r.blob()).then(blob=>createImageBitmap(blob)).then(image=>{const result={width:image.width,height:image.height};image.close();return result})`;
  const result = await evaluate(expression, true);
  assert.deepEqual(result, { width: 1, height: 1 }, `${label} must decode as a complete PNG in Chromium`);
  return result;
}
async function evaluate(expression, awaitPromise = false, timeoutMs = 15000) {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise, returnByValue: true, userGesture: false }, { timeoutMs });
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || "Chromium evaluation failed");
  return response.result?.value;
}
async function waitFor(readExpression, label, timeoutMs = 12000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await evaluate(readExpression, true);
    if (value) return value;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
function makeParentHtml(childHtml) {
  const encodedChild = JSON.stringify(childHtml).replace(/</g, "\\u003c");
  return `<!doctype html><meta charset="utf-8"><title>paintbrush fixture</title><div id="root"></div><script>
    window.__paintbrushResults=[];window.__paintbrushReady=[];window.__paintbrushDiagnostics=[];window.__paintbrushDiagnosticBytes=0;
    const root=document.getElementById('root');window.__paintbrushFrame=null;
    addEventListener('message',event=>{if(!window.__paintbrushFrame||event.source!==window.__paintbrushFrame.contentWindow)return;if(event.data?.type==='paintbrush-result')window.__paintbrushResults.push({...event.data,childOrigin:event.origin});if(event.data?.type==='paintbrush-ready')window.__paintbrushReady.push({...event.data,childOrigin:event.origin});if(event.data?.type==='paintbrush-diagnostic'&&window.__paintbrushDiagnostics.length<12){const item=event.data.event,size=new TextEncoder().encode(JSON.stringify(item)).byteLength;if(window.__paintbrushDiagnosticBytes+size<=2048){window.__paintbrushDiagnostics.push(item);window.__paintbrushDiagnosticBytes+=size}}});
    window.__mountPaintbrushFrame=()=>{if(window.__paintbrushFrame)return false;const frame=document.createElement('iframe');frame.setAttribute('sandbox','allow-scripts');frame.title='Original paintbrush preload fixture';frame.srcdoc=${encodedChild};root.appendChild(frame);window.__paintbrushFrame=frame;return true};
    window.__runPaintbrushCase=(id,scenario)=>window.__paintbrushFrame?.contentWindow.postMessage({type:'paintbrush-run',id,scenario},'*');
    window.__paintbrushParentReady=true;
  </script>`;
}
async function browserImageCheck(png, label) {
  const url = `data:image/png;base64,${png.toString("base64")}`;
  return { decoded: await captureImage(url, label), bytes: png.length, sha256: sha256(png) };
}
async function runCase(name, png, saveFile, cancel = false) {
  imageFixture.setImage(png);
  const browserPng = await browserImageCheck(png, name);
  const beforeImage = imageMetrics.imageRequests;
  const beforeRpc = { ...nodeSession.stats.methods };
  const id = `${name}-${randomBytes(4).toString("hex")}`;
  const scenario = { cancel, savePath: saveFile, downloads: dirname(saveFile) };
  await evaluate(`window.__runPaintbrushCase(${JSON.stringify(id)},${JSON.stringify(scenario)})`);
  await waitFor(`window.__paintbrushResults.find(item=>item.id===${JSON.stringify(id)})`, `${name} original save-clipboard completion`);
  const result = await evaluate(`window.__paintbrushResults.find(item=>item.id===${JSON.stringify(id)})`);
  const picker = result.pickerCalls;
  let file = null;
  try {
    const bytes = await readFile(saveFile);
    file = { exists: true, bytes: bytes.length, sha256: sha256(bytes), identical: bytes.equals(png), relativePath: relative(join(scratch, "downloads"), saveFile) };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    file = { exists: false, bytes: 0, sha256: null, identical: false, relativePath: relative(join(scratch, "downloads"), saveFile) };
  }
  const rpcDelta = Object.fromEntries(Object.entries(nodeSession.stats.methods).map(([method, count]) => [method, count - (beforeRpc[method] || 0)]).filter(([, count]) => count > 0));
  const outcome = { name, inputPng: browserPng, imageEndpointRequests: imageMetrics.imageRequests - beforeImage,
    pickerCalls: picker, notificationKinds: result.notifications, hideWindowStubCalls: result.hiddenCalls,
    originalHandlerInstalled: result.handlerInstalled, selectedExportOwner: result.chosenOwner,
    diagnostics: result.diagnostics, nodeRpcMethodDelta: rpcDelta, file,
    browserErrorCode: result.errorCode || "" };
  outcome.verified = false;
  report.cases.push(outcome);
  if (name === "accepted505KiB" || name === "acceptedNearCap") {
    assert.equal(imageMetrics.imageRequests - beforeImage, 1, "Each accepted save must issue one image read");
    assert.equal(picker, 1, "Each accepted save must reach one explicit fixture picker");
    assert.ok((rpcDelta.call || 0) >= 1, "Accepted save must use a remote Node call and create a file through the real Node fs path");
    assert.equal(file.exists, true); assert.equal(file.identical, true); assert.deepEqual(result.notifications, ["saved"]);
  } else if (name === "rejectedOverCap") {
    assert.equal(imageMetrics.imageRequests - beforeImage, 1); assert.equal(picker, 0, "Oversized image must be rejected before picker");
    assert.equal(file.exists, false); assert.deepEqual(result.notifications, ["no-image"]);
  } else {
    assert.equal(imageMetrics.imageRequests - beforeImage, 1); assert.equal(picker, 1, "Cancellation must reach one picker");
    assert.equal(file.exists, false); assert.equal(result.notifications.length, 0);
  }
  outcome.verified = true;
  return outcome;
}

async function main() {
  await ensureReportPath();
  report.sourceHashesBefore = await snapshotSources();
  assert.equal(Boolean(baselinePath), Boolean(baselineSha256), "--baseline and --baseline-sha256 must be supplied together");
  if (baselinePath) {
    assert.match(baselineSha256, /^[a-f0-9]{64}$/, "--baseline-sha256 must be a SHA-256 digest");
    const baselineBytes = await readFile(baselinePath);
    report.baselineBinding.fileSha256 = sourceDigest(baselineBytes);
    report.baselineBinding.matched = report.baselineBinding.fileSha256 === baselineSha256;
    const baseline = JSON.parse(baselineBytes.toString("utf8"));
    const changed = Object.keys(report.sourceHashesBefore).filter((name) => baseline.sources[name]
      && baseline.sources[name].sha256 !== report.sourceHashesBefore[name].sha256);
    report.baselineBinding.changedTrackedBaselineSources = changed;
    assert.equal(report.baselineBinding.matched, true, "Supplied baseline identity does not match its declared SHA");
    assert.equal(changed.length, 0, "A tracked source differs from the supplied before snapshot");
  }
  try {
    await resourceJournal.update("loopback-preflight-starting", { reportPath: basename(reportPath) });
    await preflightLoopback();
    report.setup.loopbackPreflight = "passed";
    await resourceJournal.update("loopback-preflight-passed");
  } catch (error) {
    report.setup.loopbackPreflight = "failed-before-child-start";
    report.setup.loopbackPreflightErrorCode = errorCode(error);
    throw error;
  }
  await resourceJournal.update("scratch-creating");
  scratch = await mkdtemp("/private/tmp/atools-b49-paintbrush-node-save-");
  await resourceJournal.update("scratch-created", { scratchPath: scratch });
  const downloads = join(scratch, "downloads"); await mkdir(downloads, { mode: 0o700 });
  const pngs = Object.fromEntries(Object.entries(IMAGE_SIZES).map(([name, size]) => [name, makeValidPng(size)]));
  report.limits.fixturePngs = Object.fromEntries(Object.entries(pngs).map(([name, png]) => [name, { bytes: png.length, sha256: sha256(png), width: 1, height: 1 }]));
  const nodeBinary = await hashExecutable(process.execPath);
  report.runtimeIdentity.node = { version: process.versions.node, executablePath: process.execPath, ...nodeBinary, runtimeKind: "system Node used by process.execPath; not packaged/pinned ATools runtime" };
  const extra = await installExtraHostModuleSources(ROOT, scratch);
  const factories = await loadHostFactories(ROOT, scratch);
  const clipboardModules = await loadHostClipboardFactory(scratch);
  const preloadTag = await factories.preparePluginPreload({ pluginDir: PLUGIN_DIR, preloadPath: PRELOAD_PATH,
    readTextFile: (path) => readFile(path, "utf8"), onExternalRequire() {} });
  report.preload = { originalPath: "ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js", originalBytes: Buffer.byteLength(await readFile(PRELOAD_PATH, "utf8")), originalSha256: report.sourceHashesBefore["ZTools-plugins/plugins/clipboard-image-paintbrush/preload.js"].sha256,
    featureSelection: "window.exports['save-clipboard'] first, then window.services fallback", externalNodeRequires: ["electron", "fs", "path", "os"] };
  await resourceJournal.update("image-listener-starting", { imageListener: { state: "starting", port: null } });
  imageFixture = createPaintbrushLoopbackFixture();
  imageServer = imageFixture.server;
  imageMetrics = imageFixture.metrics;
  const imageServerInfo = await imageFixture.listen();
  imageServerPort = imageServerInfo.port;
  await resourceJournal.update("image-listener-bound", { imageListener: { state: "listening", port: imageServerInfo.port } });
  const instanceId = randomBytes(12).toString("hex");
  const imageConfig = { instanceId, endpoints: { image: imageServerInfo.endpoint } };
  const clipboardTag = clipboardModules.hostClipboardBridgeScript(imageConfig);
  const electronTag = factories.pluginElectronAdapterScript();
  report.hostClipboardFixture.endpoint = `127.0.0.1:${imageServerInfo.port}/host/[redacted]`;
  report.fixtureFactories = { sourceModulesPreseeded: ["nodeModulePayloadBudget.ts", "browserBuffer.ts", "pluginElectronWebFrame.ts", "pluginNativeImage.ts", "hostClipboardBridge.ts"],
    sharedLoadHostFactoriesReused: true, productionHostClipboardBridge: true, productionElectronAdapter: true, productionNodeModuleBridge: true,
    preseedReason: "The existing shared loader predates these transitive imports; this script supplies the current production TS modules to its scratch host-modules directory before invoking it. No product helper was edited." };
  await resourceJournal.update("node-fixture-starting", { nodeFixture: { state: "starting", executablePath: process.execPath,
    pid: null, pgid: null, identity: null, startupIdentity: "unavailable-until-shared-fixture-initialize", environmentRoot: "not-exposed-by-shared-fixture" } });
  report.setup.childStartAttempted = true;
  nodeSession = await startNodeFixture(ROOT, PLUGIN_DIR, PRELOAD_PATH);
  report.setup.nodeFixtureReady = true;
  report.nodeFixture = { initialized: true, protocolVersion: nodeSession.initialize.protocolVersion, startupMs: nodeSession.startupMs,
    processId: nodeSession.initialize.pid, nodeVersion: nodeSession.initialize.nodeVersion, inheritedAmbientEnvironment: nodeSession.isolation.inheritedAmbientEnvironment,
    childCleanupScope: "Existing fixture tracks its exclusive child process group and observed descendants; not an OS sandbox or arbitrary reparenting guarantee." };
  report.cleanup.nodeGroupBeforeStop = await observeOwnedProcessGroup(nodeSession.initialize.pid, "before-stop");
  await resourceJournal.update("node-fixture-ready", { nodeFixture: { state: "ready", executablePath: process.execPath,
    pid: nodeSession.initialize.pid, pgid: report.cleanup.nodeGroupBeforeStop.pgid, identity: report.cleanup.nodeGroupBeforeStop.identity,
    startupIdentity: "observed-after-initialize", environmentRoot: "unknown-shared-fixture-does-not-expose-path" } });
  assert.equal(report.cleanup.nodeGroupBeforeStop.status, "observed", "Unable to independently observe the live Node fixture child");
  assert.equal(report.cleanup.nodeGroupBeforeStop.pgid, nodeSession.initialize.pid, "Node fixture must own its expected process group");
  const childHtml = paintbrushChildHtml({ preloadTag, clipboardTag, electronTag, nodeEndpoint: factories.nodeModuleBridgeScript({ endpoint: nodeSession.endpoint }) });
  await resourceJournal.update("chromium-starting", { chromium: { state: "starting", executablePath: null, pid: null, pgid: null, identity: null } });
  browser = await launchManagedChrome(scratch, errorMessageSafe, errorCode, async ({ pid, executable, environmentRoot }) => {
    await resourceJournal.update("chromium-process-started", { chromium: { state: "spawned", executablePath: executable,
      environmentRoot, pid, pgid: null, identity: null } });
    const identity = await observeOwnedProcessGroup(pid, "before-stop");
    await resourceJournal.update("chromium-process-identity-observed", { chromium: { state: identity.status === "observed" ? "spawned" : "identity-unknown",
      executablePath: executable, environmentRoot, pid, pgid: identity.pgid, identity: identity.identity } });
  });
  report.runtimeIdentity.chromiumExecutablePath = browser.executable;
  report.cleanup.browserGroupBeforeStop = await observeOwnedProcessGroup(browser.pid, "before-stop");
  await resourceJournal.update("chromium-ready", { chromium: { state: "ready", executablePath: browser.executable,
    pid: browser.pid, pgid: report.cleanup.browserGroupBeforeStop.pgid, identity: report.cleanup.browserGroupBeforeStop.identity,
    environmentRoot: browser.environmentRoot } });
  assert.equal(report.cleanup.browserGroupBeforeStop.status, "observed", "Unable to observe the live Chromium fixture child");
  assert.equal(report.cleanup.browserGroupBeforeStop.pgid, browser.pid, "Chromium fixture must own its expected process group");
  const pageWs = await createPageWebSocketUrl(browser.webSocketUrl);
  page = await CdpClient.connect(pageWs);
  browserStartupObserver = new PaintbrushCdpStartupObserver(page);
  await browserStartupObserver.enable();
  const version = await page.send("Browser.getVersion");
  report.runtimeIdentity.chromium = { product: version.product, protocolVersion: version.protocolVersion, userAgent: version.userAgent };
  const parentHtml = makeParentHtml(childHtml);
  imageFixture.setParentHtml(parentHtml);
  report.parentHealthCheck = await imageServerInfo.readParentHealth();
  assert.equal(report.parentHealthCheck.complete, true, "Direct Node loopback health GET must read the parent response");
  assert.equal(report.parentHealthCheck.statusCode, 200, "Direct Node loopback health GET must receive HTTP 200");
  assert.ok(report.parentHealthCheck.bodyBytes > 0 && /^[a-f0-9]{64}$/.test(report.parentHealthCheck.bodySha256),
    "Direct Node loopback health GET must record only body size and SHA-256");
  browserStartupObserver.setStage("parent-navigation");
  await resourceJournal.update("chromium-navigating");
  try { await browserStartupObserver.navigateAndAwaitLoad(imageServerInfo.parentUrl); }
  finally {
    report.browserNavigation = browserStartupObserver.navigation;
    report.browserDiagnostics = browserStartupObserver.snapshot();
    report.browserNetwork = browserStartupObserver.networkSnapshot();
    report.parentHttp = { healthCheck: report.parentHealthCheck, server: { ...imageMetrics } };
  }
  assert.equal(await evaluate("window.__paintbrushParentReady===true"), true, "Plain parent page must finish loading before iframe mount");
  assert.equal(imageMetrics.browserParentRequests, 1, "The fixture parent must be browser-served before the opaque child is mounted");
  browserStartupObserver.setStage("opaque-iframe-mount");
  await resourceJournal.update("opaque-child-mount-requested");
  assert.equal(await evaluate("window.__mountPaintbrushFrame()"), true, "Opaque child must mount once after parent load");
  await waitFor("window.__paintbrushReady?.length>0", "original preload readiness diagnostic");
  const ready = await evaluate("window.__paintbrushReady[0]");
  report.browserFixture = { parentLoadedBeforeIframe: true, iframeSandbox: ["allow-scripts"], clientOrigin: await evaluate("location.origin"),
    parentAccessBlocked: await evaluate("(()=>{try{void __paintbrushFrame.contentWindow.document.body;return false}catch{return true}})()"),
    originalPreloadInstalled: ready.ready === true, exportsHandler: ready.exportsHandler, servicesHandler: ready.servicesHandler,
    selectedExportOwner: ready.chosenOwner, childOrigin: ready.childOrigin, startupDiagnostics: ready.diagnostics };
  assert.equal(ready.ready, true, "Original save-clipboard handler must be installed");
  assert.equal(ready.chosenOwner, "exports", "Fixture must execute the original preload feature selected from window.exports");
  assert.equal(report.browserFixture.clientOrigin, `http://127.0.0.1:${imageServerInfo.port}`);
  assert.equal(report.browserFixture.childOrigin, "null"); assert.equal(report.browserFixture.parentAccessBlocked, true);
  await runCase("accepted505KiB", pngs.accepted505KiB, join(downloads, "saved-505.png"));
  await runCase("acceptedNearCap", pngs.acceptedNearCap, join(downloads, "saved-near-cap.png"));
  await runCase("rejectedOverCap", pngs.rejectedOverCap, join(downloads, "must-not-exist.png"));
  await runCase("pickerCancelled", pngs.accepted505KiB, join(downloads, "cancelled.png"), true);
  report.hostClipboardFixture.requests = imageMetrics.imageRequests;
  report.hostClipboardFixture.preflights = imageMetrics.imagePreflights;
  report.hostClipboardFixture.requestBodyBytes = imageMetrics.imageRequestBodyBytes;
  report.hostClipboardFixture.responseBytes = imageMetrics.imageResponseBytes;
  report.nodeRpc = nodeRpcSnapshot();
    report.passed = report.cases.length === 4 && report.cases.every((item) => item.verified === true && item.file &&
    ((item.name === "accepted505KiB" || item.name === "acceptedNearCap") ? item.file.identical : !item.file.exists));
}

await ensureReportPath().catch((error) => { fatal = error; });
try {
  if (!fatal) await main();
} catch (error) {
  fatal = error;
  if (error?.chromeStartupCleanup) report.cleanup.browserStartupCleanup = error.chromeStartupCleanup;
  report.failure = { code: errorCode(error), message: errorMessageSafe(error) };
  if (page) {
    try { report.browserStartupDiagnostics = await evaluate("({events:window.__paintbrushDiagnostics||[],bytes:window.__paintbrushDiagnosticBytes||0,dropped:window.__paintbrushDiagnosticDropped||0})", false, 700); }
    catch { report.browserStartupDiagnostics = { status: "unavailable" }; }
  }
  if (browserStartupObserver) report.browserDiagnostics = browserStartupObserver.snapshot();
  if (browserStartupObserver?.navigation) report.browserNavigation = browserStartupObserver.navigation;
} finally {
  if (imageMetrics) {
    report.hostClipboardFixture.requests = imageMetrics.imageRequests;
    report.hostClipboardFixture.preflights = imageMetrics.imagePreflights;
    report.hostClipboardFixture.requestBodyBytes = imageMetrics.imageRequestBodyBytes;
    report.hostClipboardFixture.responseBytes = imageMetrics.imageResponseBytes;
    report.parentHttp = { healthCheck: report.parentHealthCheck || null, server: { ...imageMetrics } };
  }
  if (browserStartupObserver) {
    report.browserDiagnostics = browserStartupObserver.snapshot();
    report.browserNetwork = browserStartupObserver.networkSnapshot();
    if (browserStartupObserver.navigation) report.browserNavigation = browserStartupObserver.navigation;
    if (imageMetrics) report.parentHttp = { healthCheck: report.parentHealthCheck || null, server: { ...imageMetrics } };
  }
  if (page) {
    try { await page.close(); report.cleanup.browserCdpClosed = true; }
    catch (error) { report.cleanup.browserCdpCloseError = errorCode(error); }
  }
  if (browser) {
    try {
      report.cleanup.browserStop = await browser.close();
      report.cleanup.browserCloseReturned = true;
    }
    catch (error) { report.cleanup.browserCloseError = errorCode(error); }
    report.cleanup.browserGroupAfterStop = await observeOwnedProcessGroup(browser.pid, "after-stop", report.cleanup.browserGroupBeforeStop?.identity ?? null);
  }
  if (nodeSession) {
    report.nodeRpc = nodeRpcSnapshot();
    try { report.cleanup.nodeFixtureStop = await nodeSession.stop(); }
    catch (error) { report.cleanup.nodeFixtureStop = { stopReturned: false, errorCode: errorCode(error) }; }
    report.cleanup.nodeGroupAfterStop = await observeOwnedProcessGroup(nodeSession.initialize.pid, "after-stop", report.cleanup.nodeGroupBeforeStop?.identity ?? null);
  }
  if (imageServer) {
    try {
      for (const socket of imageFixture.sockets) socket.destroy();
      report.cleanup.clipboardListenerClosed = await new Promise((resolveClose, reject) => imageServer.close((error) => error ? reject(error) : resolveClose(true)));
      report.cleanup.clipboardSocketsClosed = imageFixture.sockets.size === 0;
      report.cleanup.clipboardPortRefused = await confirmPortRefused(imageServerPort);
    } catch (error) { report.cleanup.clipboardListenerCloseError = errorCode(error); }
  }
  if (scratch) {
    try { await rm(scratch, { recursive: true, force: true }); report.cleanup.scratchRemoved = await confirmPathAbsent(scratch); }
    catch (error) { report.cleanup.scratchRemovalError = errorCode(error); }
  }
  try {
    report.sourceHashesAfter = await snapshotSources();
    report.sourceHashesUnchanged = JSON.stringify(report.sourceHashesBefore) === JSON.stringify(report.sourceHashesAfter);
  } catch (error) { report.sourceHashAfterError = errorCode(error); }
  report.cleanup.nodeOwnedGroupObservedEmpty = report.cleanup.nodeGroupAfterStop?.observedGroupEmpty === true;
  report.cleanup.nodeLeaderIdentityAbsent = report.cleanup.nodeGroupAfterStop?.leaderIdentityPresent === false;
  report.cleanup.browserOwnedGroupObservedEmpty = report.cleanup.browserGroupAfterStop?.observedGroupEmpty === true;
  report.cleanup.browserLeaderIdentityAbsent = report.cleanup.browserGroupAfterStop?.leaderIdentityPresent === false;
  report.passed = report.passed && report.sourceHashesUnchanged === true
    && report.cleanup.browserCdpClosed && report.cleanup.browserCloseReturned
    && report.cleanup.browserStop?.processCloseObserved === true
    && report.cleanup.browserStop?.isolatedEnvironmentRemoved === true
    && report.cleanup.browserOwnedGroupObservedEmpty && report.cleanup.browserLeaderIdentityAbsent
    && report.cleanup.nodeFixtureStop?.nodeProcessStopped === true
    && report.cleanup.nodeFixtureStop?.listenerClosed === true
    && report.cleanup.nodeFixtureStop?.isolatedEnvironmentRemoved === true
    && report.cleanup.nodeOwnedGroupObservedEmpty && report.cleanup.nodeLeaderIdentityAbsent
    && report.cleanup.clipboardListenerClosed && report.cleanup.clipboardSocketsClosed && report.cleanup.clipboardPortRefused
    && report.cleanup.scratchRemoved;
  try {
    await resourceJournal.update("cleanup-observed", {
      imageListener: { state: report.cleanup.clipboardListenerClosed && report.cleanup.clipboardPortRefused ? "closed-observed" : "cleanup-unknown", port: imageServerPort || null },
      nodeFixture: { ...resourceJournal.record.nodeFixture, state: report.cleanup.nodeFixtureStop?.nodeProcessStopped ? "stopped"
        : (nodeSession || report.setup.childStartAttempted ? "cleanup-unknown" : resourceJournal.record.nodeFixture.state) },
      chromium: { ...resourceJournal.record.chromium, state: report.cleanup.browserStop?.processCloseObserved ? "stopped"
        : (browser || resourceJournal.record.chromium.pid ? "cleanup-unknown" : resourceJournal.record.chromium.state) },
      observedCleanup: { nodeGroupEmpty: report.cleanup.nodeOwnedGroupObservedEmpty, nodeLeaderAbsent: report.cleanup.nodeLeaderIdentityAbsent,
        chromiumGroupEmpty: report.cleanup.browserOwnedGroupObservedEmpty, chromiumLeaderAbsent: report.cleanup.browserLeaderIdentityAbsent,
        clipboardListenerClosed: report.cleanup.clipboardListenerClosed, clipboardPortRefused: report.cleanup.clipboardPortRefused,
        scratchAbsent: report.cleanup.scratchRemoved },
    });
  } catch (error) { report.resourceJournalError = errorCode(error); report.passed = false; }
  report.finishedAt = new Date().toISOString();
  try {
    await mkdir(outputDir, { recursive: true });
    report.cleanup.outputReportWritten = true;
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  } catch (error) {
    report.cleanup.outputReportWritten = false;
    report.passed = false;
    await resourceJournal.update("report-write-failed", { observedCleanup: { ...resourceJournal.record.observedCleanup, reportWritten: false } }).catch(() => {});
    console.error(`Unable to write probe report: ${errorCode(error)} (${reportPath})`);
  }
}

console.log(JSON.stringify({ reportPath, passed: report.passed, failure: report.failure || null,
  cases: report.cases.map(({ name, file }) => ({ name, exists: file?.exists, bytes: file?.bytes, sha256: file?.sha256 })),
  cleanup: report.cleanup }, null, 2));
if (!report.passed) process.exitCode = 1;
