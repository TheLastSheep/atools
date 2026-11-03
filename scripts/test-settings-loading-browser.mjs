import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { CdpClient } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { selectVitePort } from "./lib/owned-vite-server.mjs";
import { isOwnedResourceClean, launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";
import { createSettingsLoadingScenarios } from "./lib/settings-loading-browser-scenarios.mjs";

const baselineMode = process.env.ATOOLS_SETTINGS_LOADING_BASELINE === "1";
const currentMode = process.env.ATOOLS_SETTINGS_LOADING_BROWSER_ACCEPTANCE === "1";
if (!baselineMode && !currentMode) {
  console.log("Settings browser checks are opt-in; set ATOOLS_SETTINGS_LOADING_BROWSER_ACCEPTANCE=1 for current acceptance or ATOOLS_SETTINGS_LOADING_BASELINE=1 for the frozen risk reproduction.");
  process.exit(0);
}
assert.notEqual(baselineMode, currentMode, "Select exactly one of current acceptance or frozen baseline reproduction mode");

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = resolve(root, "src-tauri/binaries/node-aarch64-apple-darwin");
assert.equal(process.versions.node, "22.23.3", "Browser acceptance must use the pinned product Node runtime");
assert.equal(await realpath(process.execPath), await realpath(productNode), "Run this acceptance with the pinned product Node binary");

const runId = randomUUID();
const fixtureHtml = "tests/components/settings-loading-browser.html";
const outputDir = resolve(root, baselineMode
  ? `output/ztools-settings-inventory-2026-10-25/baseline-browser-${runId}`
  : `output/settings-session-refactor-2026-10-26/browser-${runId}`);
const currentSourceFiles = [
  "src/components/SystemPanel.svelte", "src/components/SettingsEditingGate.svelte", "src/components/SettingsPanel.svelte",
  "src/lib/settings.ts", "src/lib/settingsStorage.ts", "src/lib/settingsEditingSession.ts", "src/lib/settingsReadSession.ts",
  "src/lib/settingsEditingLifecycle.ts", "src/lib/settingsNativeTransaction.ts", "src/lib/generalSettingsStore.ts",
  "src/lib/settingsSaveCoordinator.ts", "src/lib/settingsPages.ts", "src/styles/settings-responsive.css", "src/styles/global.css",
  fixtureHtml, "tests/components/settingsLoadingBrowserFixture.ts", "scripts/lib/settings-loading-browser-scenarios.mjs",
  "scripts/test-settings-loading-browser.mjs", "scripts/lib/static-browser-fixture.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs", "scripts/chrome-cdp-smoke-utils.mjs",
];
const baselineSourceBindings = [
  { modulePath: "src/components/SystemPanel.svelte", snapshotPath: "output/ztools-settings-inventory-2026-10-25/baseline-source/src/components/SystemPanel.svelte", sha256: "29cd039ee65e265231830167d0967c897b66d71cf85df6fd989b0f138c96ceb5" },
  { modulePath: "src/lib/settings.ts", snapshotPath: "output/ztools-settings-inventory-2026-10-25/baseline-source/src/lib/settings.ts", sha256: "adb0caa2ce105e74eb503d0c8ef3ef848b34999ac6a3ea4a2a7e2837a6326d28" },
  { modulePath: "src/lib/settingsSaveCoordinator.ts", snapshotPath: "output/ztools-settings-inventory-2026-10-25/baseline-source/src/lib/settingsSaveCoordinator.ts", sha256: "92a26afdfa87943bc1d37cfea43cdc80f2acd2fb597548f33eb0a8441d2a7ff3" },
];
const sourceFiles = baselineMode
  ? [...currentSourceFiles, ...baselineSourceBindings.map(binding => binding.snapshotPath)]
  : currentSourceFiles;
const cleanup = {
  fixtureApp: "not_started", pageTarget: "not_created", pageCdp: "not_created", browserCdp: "not_created",
  chrome: { processState: "not_spawned", profileState: "not_created" }, vitePreview: "not_started", fixtureBuild: "not_created", errors: [],
};
const network = { requests: [], externalAttempts: [], blockedExternalAttempts: [] };
const consoleIssues = [];
const pendingFetchHandlers = new Set();
let stage = "setup";
let sourceHashesAtStart;
let fixtureBuildDir;
let baselineBuild;
let effectiveBaselineBindings = [];
let server;
let chrome;
let browserCdp;
let page;
let targetId;
let origin;
let scenario;
let fixtureSnapshot;
let failureDiagnostics;
let result;
let failure;
let report;

function delay(ms) { return new Promise(resolvePromise => setTimeout(resolvePromise, ms)); }

function errorText(error, depth = 0) {
  if (depth >= 4 || !error) return String(error);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const causes = [];
  if (error instanceof AggregateError) causes.push(...error.errors);
  if (error.cause) causes.push(error.cause);
  return causes.length ? `${message}; causes: ${causes.map(item => errorText(item, depth + 1)).join(" | ")}` : message;
}

async function hashSources() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
    file, createHash("sha256").update(await readFile(resolve(root, file))).digest("hex"),
  ])));
}

async function buildFrozenBaselineFixture(outDir) {
  const sourceByModule = new Map();
  effectiveBaselineBindings = [];
  for (const binding of baselineSourceBindings) {
    const bytes = await readFile(resolve(root, binding.snapshotPath));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256, binding.sha256, `Frozen baseline snapshot changed: ${binding.snapshotPath}`);
    sourceByModule.set(binding.modulePath, bytes.toString("utf8"));
    effectiveBaselineBindings.push({ ...binding, compiledSnapshotSha256: sha256 });
  }

  const loadedBindings = new Set();
  const baselineSourcePlugin = {
    name: "settings-loading-frozen-baseline-source",
    enforce: "pre",
    config(config) {
      config.plugins = [baselineSourcePlugin, ...(config.plugins ?? []).filter(plugin => plugin !== baselineSourcePlugin)];
    },
    load(id) {
      if (id.includes("?")) return null;
      const sourceId = id;
      if (!sourceId.startsWith(`${root}/`)) return null;
      const modulePath = relative(root, sourceId).split(sep).join("/");
      const source = sourceByModule.get(modulePath);
      if (source === undefined) return null;
      loadedBindings.add(modulePath);
      return source;
    },
  };
  const absoluteEntry = resolve(root, fixtureHtml);
  const entryOutput = relative(root, absoluteEntry).split(sep).join("/");
  const built = await build({
    configFile: resolve(root, "vite.config.ts"),
    root,
    mode: "test",
    plugins: [baselineSourcePlugin],
    build: { outDir: resolve(outDir), emptyOutDir: true, rollupOptions: { input: absoluteEntry } },
  });
  const outputs = (Array.isArray(built) ? built : [built]).flatMap(bundle => bundle.output);
  const htmlOutput = outputs.find(output => output.type === "asset" && output.fileName === entryOutput);
  assert.ok(htmlOutput, `Frozen baseline build must emit ${entryOutput}`);
  assert.deepEqual([...loadedBindings].sort(), [...sourceByModule.keys()].sort(), "Every pinned baseline source must be consumed by Vite and Svelte compilation");
  return { htmlFile: htmlOutput.fileName, chunkCount: outputs.filter(output => output.type === "chunk").length, assetCount: outputs.filter(output => output.type === "asset").length };
}

async function waitForPageTarget(id, timeoutMs = 5000) {
  const browserUrl = new URL(chrome.webSocketUrl);
  const originForDevtools = `http://${browserUrl.hostname}:${browserUrl.port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${originForDevtools}/json/list`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.ok, true, "Owned Chrome DevTools page inventory must be readable");
    const target = (await response.json()).find(candidate => candidate.id === id && candidate.type === "page");
    if (target?.webSocketDebuggerUrl) return target;
    await delay(35);
  }
  assert.fail(`Owned Chrome page target ${id} did not publish its CDP endpoint`);
}

async function settlePageRequests() {
  const deadline = Date.now() + 5000;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    await Promise.all([...pendingFetchHandlers]);
    if (network.requests.length === previous && pendingFetchHandlers.size === 0) stable += 1;
    else stable = 0;
    if (stable >= 3) return;
    previous = network.requests.length;
    await delay(80);
  }
  assert.fail(`Settings fixture requests did not settle: ${JSON.stringify({ requests: network.requests.length, pending: pendingFetchHandlers.size })}`);
}

async function close(label, operation) {
  try { await operation(); }
  catch (error) { cleanup.errors.push(`${label}: ${errorText(error)}`); }
}

async function navigate(url) {
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url });
  await loaded;
}

async function saveReport() {
  let sourceHashesAtEnd = {};
  try { sourceHashesAtEnd = await hashSources(); }
  catch (error) { cleanup.errors.push(`source hash finalization: ${errorText(error)}`); }
  const sourceHashStable = Boolean(sourceHashesAtStart)
    && JSON.stringify(sourceHashesAtStart) === JSON.stringify(sourceHashesAtEnd);
  if (!sourceHashStable) cleanup.errors.push("Settings browser acceptance source files changed during the run");
  cleanup.allOwnedResourcesClean = cleanup.fixtureApp === "unmounted"
    && cleanup.pageTarget === "closed" && cleanup.pageCdp === "closed" && cleanup.browserCdp === "closed"
    && isOwnedResourceClean(cleanup.chrome.processState) && isOwnedResourceClean(cleanup.chrome.profileState)
    && cleanup.vitePreview === "closed" && cleanup.fixtureBuild === "removed" && cleanup.errors.length === 0;
  const clean = !failure && cleanup.allOwnedResourcesClean && sourceHashStable;
  const riskReproduced = baselineMode && result?.riskReproduced === true;
  report = {
    runId, mode: baselineMode ? "frozen-baseline-risk-reproduction" : "settings-loading-current",
    passed: baselineMode ? false : clean,
    acceptancePassed: baselineMode ? false : clean,
    riskReproduced,
    baselineRiskDemonstrationCompleted: baselineMode && clean && riskReproduced,
    stage, runtime: { nodeVersion: process.versions.node, execPath: process.execPath },
    resources: { runnerPid: process.pid, origin, fixtureBuildDir },
    scope: baselineMode
      ? "Historical SHA-pinned SystemPanel/settings/coordinator snapshots compiled with the current SettingsPanel and strict mocked IPC to reproduce the stale full-snapshot overwrite risk. This is not current-production acceptance. Network capture covers only this page's requests."
      : "Real SystemPanel -> SettingsEditingGate -> SettingsPanel in a private headless Chromium target with strict mocked Tauri IPC. Native settings reads/writes are controlled fixture calls; this is not native OS or Tauri window acceptance. Network capture covers only this page's requests.",
    unverified: ["Native select popup keyboard navigation was not tested; the one-setting edit uses a real CDP pointer click on the tray checkbox."],
    effectiveBaselineBindings: baselineMode ? effectiveBaselineBindings : [],
    baselineBuild,
    sourceFiles, sourceHashesAtStart: sourceHashesAtStart ?? {}, sourceHashesAtEnd, sourceHashStable,
    cleanup, network, consoleIssues, fixtureSnapshot, failureDiagnostics,
    result, checks: scenario?.getSnapshot().checks ?? [], screenshots: scenario?.getSnapshot().screenshots ?? [],
    error: failure ? errorText(failure) : cleanup.errors.length ? cleanup.errors.join("; ") : undefined,
  };
  try { await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { console.error(`Could not write settings browser report ${join(outputDir, "report.json")}: ${errorText(error)}`); failure ||= error; }
}

try {
  await mkdir(outputDir, { recursive: true });
  sourceHashesAtStart = await hashSources();
  stage = "build-static-fixture";
  fixtureBuildDir = await mkdtemp(join(tmpdir(), `atools-settings-loading-${runId}-`));
  const distDir = join(fixtureBuildDir, "dist");
  baselineBuild = baselineMode
    ? await buildFrozenBaselineFixture(distDir)
    : await buildStaticBrowserFixture({ projectRoot: root, entryHtml: fixtureHtml, outDir: distDir });
  cleanup.fixtureBuild = "built";
  const port = await selectVitePort("127.0.0.1", 0);
  server = await previewStaticBrowserFixture({ projectRoot: root, outDir: distDir, host: "127.0.0.1", port });
  const address = server.httpServer?.address?.();
  assert.ok(server.httpServer?.listening && address && typeof address === "object", "Static preview must retain its bound listener");
  assert.equal(address.address, "127.0.0.1", "Static preview must bind only loopback");
  assert.equal(address.port, port, "Static preview must retain its independently selected strict port");
  origin = `http://127.0.0.1:${port}`;
  cleanup.vitePreview = { state: "listening", origin, address };

  stage = "launch-owned-chrome";
  chrome = await launchOwnedChrome();
  cleanup.chrome = { ...chrome.lifecycle };
  browserCdp = await CdpClient.connect(chrome.webSocketUrl);
  cleanup.browserCdp = "connected";
  const created = await browserCdp.send("Target.createTarget", { url: "about:blank", background: false }, { timeoutMs: 5000 });
  targetId = created.targetId;
  assert.ok(targetId, "Owned Chrome must create one acceptance page target");
  cleanup.pageTarget = "created";
  const target = await waitForPageTarget(targetId);
  page = await CdpClient.connect(target.webSocketDebuggerUrl);
  cleanup.pageCdp = "connected";
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  page.on("Network.requestWillBeSent", event => {
    network.requests.push({ url: event.request.url, method: event.request.method });
  });
  page.on("Fetch.requestPaused", event => {
    const operation = (async () => {
      const requestOrigin = (() => { try { return new URL(event.request.url).origin; } catch { return null; } })();
      if (requestOrigin === origin) {
        await page.send("Fetch.continueRequest", { requestId: event.requestId }, { timeoutMs: 5000 });
      } else {
        network.externalAttempts.push(event.request.url);
        network.blockedExternalAttempts.push({ url: event.request.url, method: event.request.method });
        await page.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, { timeoutMs: 5000 });
      }
    })().catch(error => consoleIssues.push(`Fetch interception: ${errorText(error)}`))
      .finally(() => pendingFetchHandlers.delete(operation));
    pendingFetchHandlers.add(operation);
  });
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "Runtime exception"));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (["error", "assert", "warning"].includes(type)) consoleIssues.push(`${type}: ${args.map(arg => arg.value ?? arg.description ?? arg.type).join(" ")}`);
  });

  stage = "navigate-settings-fixture";
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url: `${origin}/${fixtureHtml}?baseline=${baselineMode ? "1" : "0"}` });
  await loaded;
  scenario = createSettingsLoadingScenarios({ page, outputDir, runId, delay });
  await scenario.waitFor("window.settingsLoadingFixture && document.querySelector('#settings-app')");
  stage = baselineMode ? "baseline-stale-overwrite-risk" : "strict-read-save-error-retry-and-unmount";
  result = baselineMode ? await scenario.runBaselineRiskReproduction() : await scenario.run();
  await settlePageRequests();
  fixtureSnapshot = await scenario.evaluate("window.settingsLoadingFixture.snapshot()");
  assert.deepEqual(fixtureSnapshot.unexpectedCalls, [], "Settings fixture must reject every unplanned IPC call");
  if (baselineMode) {
    assert.equal(fixtureSnapshot.readCalls.length, 1, "The historical settings panel should make one native settings read");
    assert.deepEqual(fixtureSnapshot.readCalls.map(read => read.status), ["resolved"]);
    assert.equal(fixtureSnapshot.settingsWrites.length, 1, "The risk reproduction should make exactly one settings write");
    assert.deepEqual(fixtureSnapshot.settingsWrites[0].value, fixtureSnapshot.expectedAfterStaleTrayChange);
    assert.deepEqual(result.overwrittenUntouchedFields.persisted, { theme: "light", recentRows: 1, pinnedRows: 1 });
    assert.deepEqual(result.overwrittenUntouchedFields.nativeReply, { theme: "dark", recentRows: 4, pinnedRows: 3 });
    assert.equal(fixtureSnapshot.nativeWrites.length, 6, "The baseline edit should issue one existing native preference batch");
  } else {
    assert.equal(fixtureSnapshot.readCalls.length, 5, "The route sessions should perform two session-open reads, one late read, and failure plus retry");
    assert.deepEqual(fixtureSnapshot.readCalls.map(read => read.status), ["resolved", "resolved", "resolved", "rejected", "resolved"]);
    assert.equal(fixtureSnapshot.settingsWrites.length, 1, "The only settings persistence must be the explicit tray toggle");
    assert.deepEqual(fixtureSnapshot.settingsWrites[0].value, fixtureSnapshot.expectedAfterTrayChange);
    assert.equal(fixtureSnapshot.settingsWrites[0].value.showTrayIcon, true);
    assert.equal(fixtureSnapshot.nativeWrites.length, 1, "The tray edit should use one atomic native settings command");
    assert.equal(fixtureSnapshot.nativeWrites[0].command, "save_general_settings");
    assert.equal(fixtureSnapshot.nativeWrites[0].args.applyNative, true);
    assert.equal(fixtureSnapshot.activeReadLease, null, "All settings editing read leases must close after unmount");
  }
  assert.deepEqual(network.externalAttempts, [], "The settings fixture page must not request external resources");
  assert.deepEqual(consoleIssues, [], "Settings acceptance must not produce browser console errors or warnings");
  stage = baselineMode ? "baseline-risk-reproduced" : "acceptance-passed";
} catch (error) {
  failure = error;
  stage = `failed:${stage}`;
  if (scenario && page) {
    try { failureDiagnostics = await scenario.captureDiagnostics(2500); }
    catch (diagnosticError) { failureDiagnostics = { captured: false, error: errorText(diagnosticError) }; }
  }
} finally {
  if (page) {
    await close("fixture application dispose", async () => {
      const state = await page.send("Runtime.evaluate", { expression: "window.settingsLoadingFixture?.disposeFixture?.()??null", awaitPromise: true, returnByValue: true }, { timeoutMs: 6000 });
      cleanup.fixtureApp = state.result.value?.appUnmounted ? "unmounted" : "unmount_unconfirmed";
      cleanup.fixtureDispose = state.result.value;
      assert.equal(cleanup.fixtureDispose?.activeReadLease, false, "Fixture cleanup must release the settings read lease");
      assert.equal(cleanup.fixtureDispose?.eventListenersRemaining, 0, "Fixture cleanup must remove settings event listeners");
      assert.equal(cleanup.fixtureDispose?.pendingReadsSettled, true, "Fixture cleanup must settle all pending mocked reads");
      const snapshot = await page.send("Runtime.evaluate", { expression: "window.settingsLoadingFixture?.snapshot?.()??null", returnByValue: true }, { timeoutMs: 4000 });
      fixtureSnapshot = snapshot.result.value;
    });
  }
  if (browserCdp && targetId) await close("page target close", async () => {
    const closed = await browserCdp.send("Target.closeTarget", { targetId }, { timeoutMs: 5000 });
    assert.equal(closed.success, true);
    cleanup.pageTarget = "closed";
  });
  if (page) await close("page CDP close", async () => { await page.close(); cleanup.pageCdp = "closed"; });
  if (browserCdp) await close("browser CDP close", async () => { await browserCdp.close(); cleanup.browserCdp = "closed"; });
  if (chrome) await close("owned Chrome close", async () => {
    await chrome.close();
    cleanup.chrome = { ...chrome.lifecycle };
  });
  if (server) await close("static preview close", async () => {
    await server.close();
    assert.equal(server.httpServer?.listening, false);
    cleanup.vitePreview = "closed";
  });
  if (fixtureBuildDir) await close("temporary fixture build remove", async () => {
    await rm(fixtureBuildDir, { recursive: true, force: true });
    try { await access(fixtureBuildDir); throw new Error("Temporary settings build remains after removal"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    cleanup.fixtureBuild = "removed";
  });
  await saveReport();
}

const baselineExpected = baselineMode && report?.baselineRiskDemonstrationCompleted === true;
if (failure || (baselineMode ? !baselineExpected : !report?.acceptancePassed)) {
  console.error(JSON.stringify({ runId, mode: report?.mode, passed: report?.passed, riskReproduced: report?.riskReproduced, acceptancePassed: report?.acceptancePassed, stage, error: failure ? errorText(failure) : report?.error, report: join(outputDir, "report.json"), cleanup }));
  process.exitCode = 1;
} else if (baselineMode) {
  console.log(JSON.stringify({ runId, mode: report.mode, riskReproduced: report.riskReproduced, acceptancePassed: report.acceptancePassed, report: join(outputDir, "report.json"), cleanup: cleanup.allOwnedResourcesClean }));
} else {
  console.log(JSON.stringify({ runId, mode: report.mode, passed: report.passed, stage, report: join(outputDir, "report.json"), cleanup: cleanup.allOwnedResourcesClean }));
}
