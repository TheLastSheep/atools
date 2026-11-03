import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";

const projectRoot = resolve(process.env.ATOOLS_FILE_DROP_PROJECT_ROOT || fileURLToPath(new URL("..", import.meta.url)));
const runId = randomUUID();
const output = process.env.ATOOLS_FILE_DROP_BROWSER_OUTPUT || `/private/tmp/atools-batch1438-file-drop-browser-${runId}`;
const paths = [
  "src/lib/types.ts", "src/lib/pluginPanelBridgeCompiler.ts", "src/lib/pluginBridgeTransportBinding.ts", "src/lib/pluginFrameTransport.ts",
  "src/lib/pluginFragmentHistory.ts", "src/lib/pluginLifecycleBridge.ts", "src/lib/pluginMainPushBridge.ts",
  "src/lib/pluginMainPushBudget.ts", "src/lib/pluginMainPushPresentation.ts", "src/lib/pluginFeatureExportsBridge.ts",
  "src/lib/pluginSubInputBridge.ts", "src/lib/pluginBrowserWorkerBridge.ts", "src/lib/pluginBrowserWindowBridge.ts",
  "src/lib/pluginBrowserWindowGeometry.ts", "src/lib/hostClipboardBridge.ts", "src/lib/pluginDisplayBridge.ts",
  "src/lib/pluginDataBridge.ts", "src/lib/pluginPathsBridge.ts", "src/lib/pluginNativeDialogBridge.ts",
  "src/lib/pluginSecretStorageBridge.ts", "src/lib/pluginDesktopSmokeBridgeSource.ts",
  "src/lib/pluginHostedIpcBridge.ts", "src/lib/pluginPanelFileDropHost.ts", "src/lib/pluginPanelFileDropReceiver.ts",
  "src/lib/pluginFileDropPacket.ts", "src/lib/pluginFileDropGeometry.ts", "src/lib/pluginFileIdentity.ts",
  "src/lib/pluginFrameDocumentIdentity.ts", "src/lib/pluginHostedIpcRouter.ts", "src/lib/pluginElectronAdapter.ts",
  "src/lib/pluginElectronWebFrame.ts", "src/lib/browserBuffer.ts", "src/lib/pluginUtoolsBridgeSource.ts",
  "src/lib/pluginNativeImage.ts", "src/lib/pluginNativeImageFactories.ts", "src/lib/pluginNativeImageTransformProvider.ts",
  "src/lib/pluginNativeImagePath.ts",
  "src/lib/pluginUtoolsBridgeSource/frame-permissions.ts", "src/lib/pluginUtoolsBridgeSource/child-window-rpc.ts",
  "src/lib/pluginUtoolsBridgeSource/native-call-and-node-shims.ts",
  "src/lib/pluginUtoolsBridgeSource/browser-window-state-and-events.ts", "src/lib/pluginUtoolsBridgeSource/browser-window-state-api.ts",
  "src/lib/pluginUtoolsBridgeSource/web-contents-navigation-and-state.ts", "src/lib/pluginUtoolsBridgeSource/web-contents-page-and-binary-api.ts",
  "src/lib/pluginUtoolsBridgeSource/runtime-resource-url-and-css-rewrite.ts", "src/lib/pluginUtoolsBridgeSource/runtime-resource-dom-installation.ts",
  "src/lib/pluginUtoolsBridgeSource/attachments-and-db-storage.ts", "src/lib/pluginUtoolsBridgeSource/utools-api-and-dynamic-features.ts",
  "src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts",
  "tests/components/plugin-file-drop-browser.html", "tests/components/pluginFileDropBrowserFixture.ts",
  "scripts/test-plugin-file-drop-browser.mjs", "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/static-browser-fixture.mjs", "scripts/lib/launcher-menu-browser-runtime.mjs",
  "scripts/lib/owned-vite-server.mjs", "scripts/lib/owned-vite-cli-process.mjs",
  "scripts/lib/owned-vite-cli-worker.mjs", "vite.config.ts", "package.json", "pnpm-lock.yaml",
].sort();
const checks = [], requests = [], navigations = [], consoleIssues = [], screenshots = [];
const cleanup = { fixture: "not_started", cdp: "not_started", chrome: "not_started", preview: "not_started", build: "not_started" };
let buildDirectory, compiled, server, chrome, page, report, stage = "setup", sourceHashesAtStart;

async function hashSources() {
  return Object.fromEntries(await Promise.all(paths.map(async path => [
    path, createHash("sha256").update(await readFile(resolve(projectRoot, path))).digest("hex"),
  ])));
}
async function cdp(method, params = {}) { return page.send(method, params, { timeoutMs: 15_000 }); }
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) { const value = await evaluate(expression); if (value) return value; await delay(35); }
  assert.fail(`Timed out waiting for ${expression}`);
}
async function screenshot(name) {
  const result = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(result.data, "base64"), file = `${name}-${runId}.png`;
  await writeFile(join(output, file), bytes, { flag: "wx" });
  screenshots.push({ file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
function expectedGetterPaths(path) {
  return { ztools1: { ok: true, path }, ztools2: { ok: true, path },
    electron1: { ok: true, path }, electron2: { ok: true, path } };
}
function assertDropPayload(drop) {
  assert.deepEqual(drop.types, ["dragenter", "dragover", "drop"]);
  assert.deepEqual(drop.dragSamples.map(sample => sample.type), ["dragenter", "dragover", "drop"]);
  assert.ok(drop.dragSamples.every(sample => !sample.isTrusted && sample.dragEventRealm && sample.dataTransferRealm
    && sample.sameTransfer && sample.sameFiles), "Each drag event must use one frame-realm transfer with stable exact File identities");
  assert.equal(drop.isTrusted, false, "Synthetic browser events must not be labeled trusted");
  assert.deepEqual([drop.fileRealm, drop.dataTransferRealm, drop.dragEventRealm], [true, true, true]);
  assert.equal(drop.sameFileAcrossEvents, true);
  assert.deepEqual(drop.files, [
    { name: "fixture-alpha.txt", type: "text/plain", lastModified: 1_700_000_001, fileRealm: true,
      bytes: [97, 108, 112, 104, 97], paths: expectedGetterPaths("/fixture/approved/alpha.txt") },
    { name: "fixture-beta.bin", type: "application/octet-stream", lastModified: 1_700_000_002, fileRealm: true,
      bytes: [98, 101, 116, 97, 33], paths: expectedGetterPaths("/fixture/approved/beta.bin") },
  ], "Both approved File payloads must preserve exact bytes and resolve their own approved paths through both getters");
}

await mkdir(output, { recursive: false });
try {
  sourceHashesAtStart = await hashSources();
  await writeFile(join(output, "source-before.json"), JSON.stringify(sourceHashesAtStart, null, 2) + "\n", { flag: "wx" });
  buildDirectory = await mkdtemp(join(tmpdir(), `atools-file-drop-browser-${runId}-`));
  stage = "static-build";
  compiled = await buildStaticBrowserFixture({ projectRoot, entryHtml: "tests/components/plugin-file-drop-browser.html", outDir: join(buildDirectory, "dist") });
  assert.equal(compiled.htmlFile, "tests/components/plugin-file-drop-browser.html");
  const bundleText = (await Promise.all(compiled.outputFiles.filter(file => file.endsWith(".html") || file.endsWith(".js"))
    .map(file => readFile(join(buildDirectory, "dist", file), "utf8")))).join("\n");
  assert.equal(bundleText.includes("@vite/client"), false, "Static fixture cannot include Vite dev client/HMR");
  assert.equal(bundleText.includes("import.meta.hot"), false, "Static fixture cannot include HMR hooks");
  server = await previewStaticBrowserFixture({ projectRoot, outDir: join(buildDirectory, "dist"), host: "127.0.0.1", port: 0 });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object", "Owned preview must bind its local socket");
  const origin = `http://127.0.0.1:${address.port}`;
  chrome = await launchOwnedChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", event => { if (["error", "warning", "assert"].includes(event.type)) consoleIssues.push(`${event.type}:${formatConsoleArgs(event.args)}`); });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  page.on("Page.frameNavigated", event => { if (!event.frame.parentId) navigations.push(event.frame.url); });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
  const pageUrl = `${origin}/tests/components/plugin-file-drop-browser.html`, loaded = page.waitForEvent("Page.loadEventFired", 15_000);
  stage = "navigate-fixture";
  await cdp("Page.navigate", { url: pageUrl }); await loaded;
  await waitFor("window.pluginFileDropBrowserFixture && document.querySelector('#plugin-frame')");
  stage = "real-sandbox-drop";
  const first = await evaluate("window.pluginFileDropBrowserFixture.drop(0)");
  assert.equal(await evaluate("document.querySelector('#plugin-frame').sandbox.contains('allow-scripts')"), true);
  assertDropPayload(first);
  assert.deepEqual(first.paths, {
    ztools1: { ok: true, path: "/fixture/approved/alpha.txt" }, ztools2: { ok: true, path: "/fixture/approved/alpha.txt" },
    electron1: { ok: true, path: "/fixture/approved/alpha.txt" }, electron2: { ok: true, path: "/fixture/approved/alpha.txt" },
  }, "Both production getters must synchronously resolve the exact same File identity repeatedly");
  for (const value of [first.clone, first.newFile, first.spoof]) {
    for (const getter of Object.values(value)) {
      assert.equal(getter.ok, false, "Clone/new/spoof objects must not inherit native file identity");
      assert.match(getter.code, /ERR_ATOOLS_FILE_PATH_UNAVAILABLE/);
    }
  }
  assert.equal(first.sameFileAcrossEvents, true, "All three events must carry the same exact File object");
  assert.deepEqual(await evaluate("window.pluginFileDropBrowserFixture.transferDetached"), [true], "Transferred packet must detach before other lease scenarios");
  await screenshot("opaque-frame-drop");
  checks.push("The actual compiled host/receiver bridge delivered a bounded ATFD ArrayBuffer into a sandbox=allow-scripts-only iframe; frame-realm dragenter→dragover→drop preserved both exact File objects/bytes and each shared ztools/Electron getter resolved its own approved path");

  stage = "native-invalidation";
  const invalidated = await evaluate("window.pluginFileDropBrowserFixture.invalidate()");
  assert.ok(Object.values(invalidated.paths).every(value => value.ok === false), "Plugin invalidation must revoke path metadata immediately");
  assert.ok(Object.values(invalidated.paths).every(value => /ERR_ATOOLS_FILE_PATH_UNAVAILABLE/.test(value.code)));
  assert.equal(await evaluate("window.pluginFileDropBrowserFixture.waitForCloseCount(1)"), 1, "Invalidation must close its native owner");
  checks.push("The actual host invalidation event revoked the exact-file identity and closed its native owner");

  stage = "lease-expiry";
  const expired = await evaluate("window.pluginFileDropBrowserFixture.expire()");
  assertDropPayload(expired.data);
  assert.ok(Object.values(expired.data.paths).every(value => value.ok === true), "Second short-lived lease must resolve before expiry");
  assert.ok(Object.values(expired.query.paths).every(value => value.ok === false), "Expired lease must stop resolving the exact File");
  await evaluate("window.pluginFileDropBrowserFixture.waitForCloseCount(2)");
  checks.push("A separate short-lived receiver lease resolved before expiry and was unavailable after the real lease deadline");

  stage = "synthetic-pagehide-handler";
  const third = await evaluate("window.pluginFileDropBrowserFixture.drop(2)");
  assertDropPayload(third);
  const syntheticPagehide = await evaluate("window.pluginFileDropBrowserFixture.syntheticPagehide()");
  assert.equal(syntheticPagehide.kind, "synthetic-pagehide-event");
  assert.equal(syntheticPagehide.eventType, "pagehide");
  assert.equal(syntheticPagehide.pageTransitionEvent, true);
  assert.equal(syntheticPagehide.isTrusted, false, "The receiver pagehide handler proof is explicitly synthetic");
  const afterSyntheticPagehide = await evaluate("window.pluginFileDropBrowserFixture.probe('after-synthetic-pagehide')");
  assert.ok(Object.values(afterSyntheticPagehide.paths).every(value => value.ok === false),
    "The still-live receiver probe must confirm its old File identity was revoked by the real receiver handler");
  stage = "replacement-handshake";
  const replacementDocument = await evaluate("window.pluginFileDropBrowserFixture.replaceFrameDocument()");
  assert.equal(replacementDocument.kind, "replacement-document-open");
  assert.ok(replacementDocument.loadCount >= 2, "The parent must observe the replacement iframe load");
  assert.ok(replacementDocument.bridgeOpenCount >= 2, "The replacement document must complete the production lifecycle handshake");
  assert.equal(replacementDocument.replacementNonceRotated, true, "The replacement lifecycle must use a new document nonce");
  await evaluate("window.pluginFileDropBrowserFixture.waitForCloseCount(3)");
  const final = await evaluate("window.pluginFileDropBrowserFixture.close()");
  assert.equal(final.nativeListeners, 0, "Owner close must remove both native event subscriptions");
  assert.equal(final.frameRemoved, true);
  assert.deepEqual(final.deliveredBuffersDetached, [true, true, true], "Every delivered native ArrayBuffer must detach after transfer");
  assert.equal(final.closeCalls, 3, "Plugin invalidation, lease expiry, and replacement-document invalidation each close their native owner once");
  assert.ok(final.nativeMethods.every(method => ["prepare_plugin_file_drop", "get_task_run", "get_plugin_file_drop_delivery", "close_plugin_file_drop", "discard_plugin_file_drop_intent"].includes(method)),
    "The native double must reject any undocumented host operation");
  assert.ok(final.receiverMessages.length > 0 && final.receiverMessages.every(message => message.origin === "null"), "All fixture receiver messages must come from the opaque sandbox origin");
  checks.push("The synthetic receiver pagehide event revoked old File metadata while its probe stayed live; a separately observed replacement load/open handshake invalidated the host lease and closed the native owner");

  const sourceHashesAtEnd = await hashSources();
  assert.deepEqual(sourceHashesAtEnd, sourceHashesAtStart, "Pinned source or fixture bytes changed during the run");
  assert.deepEqual(consoleIssues, []);
  assert.ok(requests.length > 0 && requests.every(url => new URL(url).origin === origin), "Only the static loopback preview server may receive requests");
  assert.deepEqual(navigations, [pageUrl], "Only one top-level fixture navigation is expected");
  report = { runId, passed: true, stage, scope: "Real Chromium DOM using the actual serialized ATools bridge, receiver, identity registry, Electron adapter, host and router with a bounded synthetic native IPC double. PageTransitionEvent proof is synthetic; replacement lifecycle/load is separately observed. Not Tauri raw IPC/native TaskRun/OS physical drag/two original plugins.", checks, compiled, screenshots, requests, navigations, consoleIssues, sourceHashesAtStart, sourceHashesAtEnd, final };
} catch (error) {
  let lifecycleDiagnostics = null;
  if (page) {
    try {
      const result = await page.send("Runtime.evaluate", {
        expression: "window.pluginFileDropBrowserFixture?.lifecycleDiagnostics ?? null", awaitPromise: true, returnByValue: true,
      }, { timeoutMs: 1_000 });
      if (!result.exceptionDetails) lifecycleDiagnostics = result.result.value;
    }
    catch { /* Preserve the original failure if the fixture world is no longer available. */ }
  }
  report = { runId, passed: false, stage, error: error instanceof Error ? error.stack || error.message : String(error),
    lifecycleDiagnostics, checks, compiled, screenshots, requests, navigations, consoleIssues, sourceHashesAtStart };
  process.exitCode = 1;
} finally {
  cleanup.fixture = page ? await evaluate("window.pluginFileDropBrowserFixture?.close().then(()=>true)").then(value => value ? "fulfilled" : "not_ready", () => "not_ready") : "not_started";
  cleanup.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.chrome = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.preview = server ? await Promise.resolve(server.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.build = buildDirectory ? await rm(buildDirectory, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanup).includes("failed")) { process.exitCode = 1; report ??= { passed: false, stage, error: "Runner exited before report creation" }; report.passed = false; report.cleanupError = "Owned resource cleanup did not complete"; }
  report ??= { passed: false, stage, error: "Runner exited before report creation" };
  report.cleanup = cleanup;
  await writeFile(join(output, "browser-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
if (report.passed) console.log(JSON.stringify({ passed: true, checks: checks.length, output }));
