import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { CdpClient } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { selectVitePort } from "./lib/owned-vite-server.mjs";
import { isOwnedResourceClean, launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";
import { launcherFrontendSourceFiles } from "./lib/launcher-source-binding.mjs";
import { createHomeExpansionScenarios } from "./lib/home-expansion-browser-scenarios.mjs";
import { createHomeCardsScenarios } from "./lib/home-cards-browser-scenarios.mjs";

const expansionMode = process.env.ATOOLS_HOME_EXPANSION_BROWSER_ACCEPTANCE === "1";
const cardsMode = process.env.ATOOLS_HOME_CARDS_BROWSER_ACCEPTANCE === "1";
assert.equal(expansionMode && cardsMode, false, "Select only one Home browser acceptance mode per run");
const mode = cardsMode ? "home-cards" : "home-expansion";
const fixtureHtml = cardsMode ? "tests/components/home-cards-browser.html" : "tests/components/home-expansion-browser.html";
const fixtureName = cardsMode ? "homeCardsFixture" : "homeExpansionFixture";
if (!expansionMode && !cardsMode) {
  console.log("Home browser acceptance is opt-in; set ATOOLS_HOME_EXPANSION_BROWSER_ACCEPTANCE=1 or ATOOLS_HOME_CARDS_BROWSER_ACCEPTANCE=1.");
  process.exit(0);
}

const runId = randomUUID();
const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = resolve(root, "src-tauri/binaries/node-aarch64-apple-darwin");
assert.equal(process.versions.node, "22.23.3", "Browser acceptance must use the pinned product Node runtime");
assert.equal(await realpath(process.execPath), await realpath(productNode), "Run this acceptance with the pinned product Node binary");
const outputDir = cardsMode
  ? resolve(root, `output/ztools-home-cards-2026-10-25/browser-${runId}`)
  : resolve(root, `output/ztools-launcher-parity-2026-10-25/browser-${runId}`);
const expansionSourceFiles = [
  ...launcherFrontendSourceFiles,
  "src/lib/launcherHomeController.ts", "src/lib/launcherSurfacePresentation.svelte.ts",
  "src/lib/launcherKeyboardController.ts", "src/lib/homeSurface.ts", "src/lib/homeNavigation.ts",
  "src/components/HomePanel.svelte", "src/components/SearchBar.svelte", "src/components/ResultsList.svelte",
  "src/components/HomeSectionHeader.svelte", "src/components/HomeCommandHint.svelte", "src/components/HomeEmptyState.svelte",
  "src/components/ResultTypeIcon.svelte", "src/components/LauncherPrimarySurface.svelte", "src/components/LauncherResultsSurface.svelte",
  "src/lib/homeCommandHintText.ts", "src/lib/homeCommandHintState.ts", "src/lib/resultIcons.ts", "src/lib/keyboardTarget.ts",
  "src/styles/global.css", "tests/components/home-expansion-browser.html",
  "tests/components/homeExpansionBrowserFixture.ts", "scripts/lib/home-expansion-browser-scenarios.mjs",
  "scripts/test-home-expansion-browser.mjs", "scripts/lib/static-browser-fixture.mjs",
  "scripts/lib/owned-vite-server.mjs", "scripts/lib/launcher-menu-browser-runtime.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs",
];
const cardsSourceFiles = [
  ...launcherFrontendSourceFiles,
  "src/components/HomeCommandTile.svelte", "src/components/HomeSectionHeader.svelte", "src/components/HomeCommandHint.svelte",
  "src/components/LauncherResultsSurface.svelte", "src/lib/launcherKeyboardHost.ts", "src/lib/launcherWindowLayout.ts",
  "src/components/WindowResizeNotice.svelte", "src/lib/launcherWindowResize.svelte.ts",
  "src/lib/launcherSurfacePresentation.svelte.ts", "src/lib/homeSurface.ts", "src/lib/homeNavigation.ts",
  "src/lib/commandHistory.ts", "src/lib/launcherPins.ts", "src/lib/launcherNavigationController.ts",
  "src/lib/homeCommandHintText.ts", "src/lib/homeCommandHintState.ts", "src/lib/resultIcons.ts",
  "tests/components/home-cards-browser.html", "tests/components/homeCardsBrowserFixture.ts",
  "scripts/lib/home-cards-browser-scenarios.mjs", "scripts/test-home-expansion-browser.mjs",
  "scripts/lib/static-browser-fixture.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs", "scripts/chrome-cdp-smoke-utils.mjs",
  "../ZTools-plugins/plugins/address-parser/plugin.json", "../ZTools-plugins/plugins/address-parser/logo.svg",
  "../ZTools-plugins/plugins/live-markdown/plugin.json",
];
const sourceFiles = [...new Set(cardsMode ? cardsSourceFiles : expansionSourceFiles)].sort();
const addressManifestRelative = "../ZTools-plugins/plugins/address-parser/plugin.json";
const addressLogoRelative = "../ZTools-plugins/plugins/address-parser/logo.svg";
const markdownManifestRelative = "../ZTools-plugins/plugins/live-markdown/plugin.json";
const cleanup = {
  fixtureApp: "not_started",
  pageTarget: "not_created",
  pageCdp: "not_created",
  browserCdp: "not_created",
  chrome: { processState: "not_spawned", profileState: "not_created" },
  vitePreview: "not_started",
  fixtureBuild: "not_created",
  errors: [],
};
const network = { requests: [], externalAttempts: [], blockedExternalAttempts: [] };
const consoleIssues = [];
let stage = "setup";
let server;
let chrome;
let browserCdp;
let page;
let targetId;
let fixtureBuildDir;
let origin;
let sourceHashesAtStart;
let scenario;
let fixtureSnapshot;
let failureDiagnostics;
let originalPluginEvidence = null;
let failure;
let report;
const pendingFetchHandlers = new Set();

function delay(ms) { return new Promise(resolveDelay => setTimeout(resolveDelay, ms)); }

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

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

async function prepareHomeCardsPluginEvidence(distDir) {
  const addressManifestPath = resolve(root, addressManifestRelative);
  const addressLogoPath = resolve(root, addressLogoRelative);
  const markdownManifestPath = resolve(root, markdownManifestRelative);
  const addressManifest = JSON.parse(await readFile(addressManifestPath, "utf8"));
  const markdownManifest = JSON.parse(await readFile(markdownManifestPath, "utf8"));
  const addressFeature = addressManifest.features?.find(feature => feature.code === "address-parser");
  const markdownFeature = markdownManifest.features?.find(feature => feature.code === "typora-workbench");
  assert.deepEqual({ name: addressManifest.name, title: addressManifest.title, author: addressManifest.author,
    version: addressManifest.version, code: addressFeature?.code, explain: addressFeature?.explain, logo: addressManifest.logo }, {
    name: "address-parser", title: "收货地址智能解析", author: "harris", version: "0.1.0",
    code: "address-parser", explain: "收货地址智能解析", logo: "logo.svg",
  }, "Address Parser fixture metadata must match the current read-only source manifest");
  assert.deepEqual({ name: markdownManifest.name, title: markdownManifest.title, author: markdownManifest.author,
    version: markdownManifest.version, code: markdownFeature?.code, explain: markdownFeature?.explain }, {
    name: "live-markdown", title: "Live Markdown", author: "harris", version: "0.1.0",
    code: "typora-workbench", explain: "打开 Live Markdown 实时预览编辑器（支持大纲、文件树、数学公式、Mermaid 图表与多排版主题）",
  }, "Live Markdown fixture text must match the current read-only source manifest");
  const logoBytes = await readFile(addressLogoPath);
  const copiedLogoPath = join(distDir, "fixture-assets", "address-parser.svg");
  await mkdir(join(distDir, "fixture-assets"), { recursive: true });
  await writeFile(copiedLogoPath, logoBytes);
  const logoHash = sha256(logoBytes);
  assert.equal(sha256(await readFile(copiedLogoPath)), logoHash, "Fixture logo bytes must match the original source logo");
  return {
    sourcePaths: { addressManifest: addressManifestRelative, addressLogo: addressLogoRelative, liveMarkdownManifest: markdownManifestRelative },
    fixtureMetadata: {
      addressParser: { name: addressManifest.name, title: addressManifest.title, author: addressManifest.author,
        version: addressManifest.version, code: addressFeature.code, explain: addressFeature.explain, logo: addressManifest.logo },
      liveMarkdown: { name: markdownManifest.name, title: markdownManifest.title, author: markdownManifest.author,
        version: markdownManifest.version, code: markdownFeature.code, explain: markdownFeature.explain },
    },
    copiedLogo: { path: "fixture-assets/address-parser.svg", sha256: logoHash, bytes: logoBytes.length },
  };
}

async function waitForPageTarget(targetId, timeoutMs = 5000) {
  const browserUrl = new URL(chrome.webSocketUrl);
  const origin = `http://${browserUrl.hostname}:${browserUrl.port}`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${origin}/json/list`, { signal: AbortSignal.timeout(1500) });
    assert.equal(response.ok, true, "Owned Chrome DevTools page inventory must be readable");
    const targets = await response.json();
    const target = targets.find(candidate => candidate.id === targetId && candidate.type === "page");
    if (target?.webSocketDebuggerUrl) return target;
    await delay(30);
  }
  assert.fail(`Owned Chrome page target ${targetId} did not publish its CDP endpoint`);
}

async function settlePageRequests() {
  const deadline = Date.now() + 5000;
  let previousCount = -1;
  let stableSamples = 0;
  while (Date.now() < deadline) {
    await Promise.all([...pendingFetchHandlers]);
    const count = network.requests.length;
    if (count === previousCount && pendingFetchHandlers.size === 0) stableSamples += 1;
    else stableSamples = 0;
    if (stableSamples >= 3) return;
    previousCount = count;
    await delay(80);
  }
  assert.fail(`Page requests did not settle: ${JSON.stringify({ count: network.requests.length, pending: pendingFetchHandlers.size })}`);
}

async function close(label, operation) {
  try { await operation(); }
  catch (error) { cleanup.errors.push(`${label}: ${errorText(error)}`); }
}

async function saveReport() {
  report = {
    runId,
    passed: !failure && cleanup.errors.length === 0,
    stage,
    mode,
    scope: cardsMode
      ? "Real ATools App in an isolated headless Chromium page using fixed local Tauri IPC data. Validates Home command card geometry, text wrapping/accessibility, keyboard navigation, hint, action menu and one history removal. Original Harris plugin metadata and logo are read-only evidence only; no original plugin is launched, no native window, plugin activation, system clipboard, or external plugin service is exercised."
      : "Real ATools App in an isolated headless Chromium page using only fixed local Tauri IPC data. Validates Home fixed/recent expansion, keyboard selection, and search input selection guards; plugin activation is a controlled rejecting fixture. No native window, plugin launch, system clipboard, or external plugin service is exercised.",
    runtime: { nodeVersion: process.versions.node, execPath: process.execPath },
    viewportCases: cardsMode
      ? [800, 420].flatMap(width => ["light", "dark"].map(theme => ({ width, height: 600, theme }))).concat([{ width: 800, height: 300, theme: "light" }])
      : [800, 420].flatMap(width => ["light", "dark"].map(theme => ({ width, height: 600, theme }))),
    sourceFilesSha256: sourceHashesAtStart ?? {},
    sourceFilesSha256AtEnd: {},
    sourceHashStable: false,
    cleanup,
    network,
    consoleIssues,
    fixtureSnapshot,
    originalPluginEvidence: originalPluginEvidence ? {
      ...originalPluginEvidence,
      sha256AtStart: Object.fromEntries(originalPluginEvidence.sourcePaths && Object.entries(originalPluginEvidence.sourcePaths)
        .map(([key, path]) => [key, sourceHashesAtStart?.[path] ?? null])),
      sha256AtEnd: {},
    } : null,
    failureDiagnostics: failureDiagnostics ?? null,
    checks: scenario?.getSnapshot().checks ?? [],
    screenshots: scenario?.getSnapshot().screenshots ?? [],
    fixtureResets: scenario?.getSnapshot().fixtureResets ?? [],
  };
  report.sourceFilesSha256AtEnd = await hashSources().catch(error => {
    cleanup.errors.push(`source hash finalization: ${errorText(error)}`);
    return {};
  });
  if (report.originalPluginEvidence) {
    report.originalPluginEvidence.sha256AtEnd = Object.fromEntries(Object.entries(report.originalPluginEvidence.sourcePaths)
      .map(([key, path]) => [key, report.sourceFilesSha256AtEnd[path] ?? null]));
  }
  report.sourceHashStable = Object.keys(report.sourceFilesSha256).length > 0
    && JSON.stringify(report.sourceFilesSha256) === JSON.stringify(report.sourceFilesSha256AtEnd);
  if (!report.sourceHashStable) cleanup.errors.push("Source files changed during browser acceptance");
  if (failure) report.error = errorText(failure);
  if (cleanup.errors.length) report.passed = false;
  if (!report.passed) {
    failure ||= new Error(report.error || cleanup.errors.join("; ") || "Browser acceptance failed");
    report.error ||= errorText(failure);
  }
  await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
}

try {
  await mkdir(outputDir, { recursive: true });
  sourceHashesAtStart = await hashSources();
  fixtureBuildDir = await mkdtemp(join(tmpdir(), `atools-home-expansion-${runId}-`));
  stage = "build-static-fixture";
  const distDir = join(fixtureBuildDir, "dist");
  const compiled = await buildStaticBrowserFixture({
    projectRoot: root,
    entryHtml: fixtureHtml,
    outDir: distDir,
  });
  if (cardsMode) originalPluginEvidence = await prepareHomeCardsPluginEvidence(distDir);
  cleanup.fixtureBuild = "built";
  const port = await selectVitePort("127.0.0.1", 0);
  server = await previewStaticBrowserFixture({ projectRoot: root, outDir: distDir, host: "127.0.0.1", port });
  const address = server.httpServer?.address?.();
  assert.ok(server.httpServer?.listening && address && typeof address === "object", "Static preview must own its bound listener");
  assert.equal(address.address, "127.0.0.1", "Static preview must bind only loopback");
  assert.equal(address.port, port, "Static preview must keep the independently selected strict port");
  origin = `http://127.0.0.1:${port}`;
  cleanup.vitePreview = { state: "listening", origin, pid: process.pid, address };

  stage = "launch-owned-chrome";
  chrome = await launchOwnedChrome();
  cleanup.chrome = { ...chrome.lifecycle };
  browserCdp = await CdpClient.connect(chrome.webSocketUrl);
  cleanup.browserCdp = "connected";
  const created = await browserCdp.send("Target.createTarget", { url: "about:blank", background: false }, { timeoutMs: 5000 });
  targetId = created.targetId;
  assert.ok(targetId, "Owned Chrome must create a page target for this acceptance run");
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
    try {
      if (new URL(event.request.url).origin !== origin) network.externalAttempts.push(event.request.url);
    } catch { network.externalAttempts.push(event.request.url); }
  });
  page.on("Fetch.requestPaused", event => {
    const operation = (async () => {
      let local = false;
      try { local = new URL(event.request.url).origin === origin; } catch { local = false; }
      if (local) await page.send("Fetch.continueRequest", { requestId: event.requestId }, { timeoutMs: 5000 });
      else {
        network.externalAttempts.push(event.request.url);
        network.blockedExternalAttempts.push(event.request.url);
        await page.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }, { timeoutMs: 5000 });
      }
    })().catch(error => { consoleIssues.push(`Fetch interception: ${errorText(error)}`); })
      .finally(() => pendingFetchHandlers.delete(operation));
    pendingFetchHandlers.add(operation);
  });
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "Runtime exception"));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (["error", "assert", "warning"].includes(type)) consoleIssues.push(`${type}: ${args.map(arg => arg.value ?? arg.description ?? arg.type).join(" ")}`);
  });

  stage = "navigate-fixture";
  cleanup.fixtureApp = "mounting";
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url: `${origin}/${fixtureHtml}` });
  await loaded;
  scenario = cardsMode
    ? createHomeCardsScenarios({ page, outputDir, runId, delay })
    : createHomeExpansionScenarios({ page, outputDir, runId, delay });
  await scenario.waitFor(`window.${fixtureName} && document.querySelector('.home-panel') && document.querySelector('[data-atools-search-input]')`);
  cleanup.fixtureApp = "mounted";

  if (cardsMode) {
    stage = "home-cards-matrix-and-interactions";
    const fixtureMetadata = await scenario.evaluate("window.homeCardsFixture.metadata");
    assert.deepEqual(fixtureMetadata, originalPluginEvidence.fixtureMetadata, "Fixture strings must match the current read-only Harris manifests");
    assert.equal(compiled.outputFiles.includes(fixtureHtml), true, "Static build must include the selected cards fixture entry");
    await scenario.run();
    await settlePageRequests();
  } else {
    stage = "home-expansion-and-search-selection";
    for (const width of [800, 420]) {
      for (const theme of ["light", "dark"]) await scenario.runLayoutCase(width, theme);
    }
    await scenario.runSearchSelectionCase();
    await settlePageRequests();
    assert.equal(compiled.outputFiles.includes(fixtureHtml), true);
  }
  fixtureSnapshot = await scenario.evaluate(`window.${fixtureName}.snapshot()`);
  assert.deepEqual(fixtureSnapshot.unexpectedCommands, [], "Fixture should reject any unplanned native command");
  assert.deepEqual(fixtureSnapshot.activationCalls, [], "Acceptance keyboard flow must not activate fixture plugins");
  assert.equal(fixtureSnapshot.listenerCount > 0, true, "Mounted App should register its controlled event listeners before cleanup");
  if (cardsMode) {
    const eventListens = fixtureSnapshot.eventCalls.filter(({ command }) => command === "plugin:event|listen");
    assert.ok(eventListens.length > 0, "The App must register real Tauri event listeners in the fixture");
    for (const call of eventListens) {
      assert.deepEqual(call.args?.target, { kind: "Any" }, "Tauri listen should use the SDK default event target");
      assert.equal(typeof call.args?.event, "string");
      assert.equal(Number.isSafeInteger(call.args?.handler), true);
    }
    const getSettingsCalls = fixtureSnapshot.calls.filter(({ command }) => command === "get_setting");
    assert.ok(getSettingsCalls.some(call => JSON.stringify(call.args) === JSON.stringify({ key: "settings-general" })),
      "Settings must load through the controlled get_setting IPC instead of only localStorage fallback");
  }
  if (!cardsMode) assert.deepEqual(
    fixtureSnapshot.calls.filter(({ command }) => command === "search_plugin_main_push_candidates"),
    [{ command: "search_plugin_main_push_candidates", args: { query: "fixture-query", fixedContent: false } }],
    "The fixture should make exactly one controlled main-push candidate lookup",
  );
  assert.deepEqual(network.externalAttempts, [], "Only the owned local Vite origin may be requested by the fixture page");
  assert.deepEqual(consoleIssues, [], "Browser acceptance must not produce console errors or runtime exceptions");
  stage = "acceptance-passed";
} catch (error) {
  failure = error;
  stage = `failed:${stage}`;
  if (!report) report = { runId, passed: false, stage, error: errorText(error) };
  if (scenario && page) {
    try {
      failureDiagnostics = await scenario.captureDiagnostics(2500);
    } catch (diagnosticError) {
      failureDiagnostics = { captured: false, error: errorText(diagnosticError) };
    }
  }
} finally {
  if (page && ["mounting", "mounted"].includes(cleanup.fixtureApp)) {
    await close("fixture App unmount", async () => {
      const response = await page.send("Runtime.evaluate", {
        expression: `window.${fixtureName} ? window.${fixtureName}.disposeFixture() : null`,
        awaitPromise: true,
        returnByValue: true,
      }, { timeoutMs: 5000 });
      assert.ok(!response.exceptionDetails, response.exceptionDetails?.text || "Fixture unmount threw");
      const result = response.result.value;
      assert.ok(result, "Fixture must be present to confirm App unmount and listener cleanup");
      assert.equal(result.appUnmounted, true);
      assert.equal(result.listenersRemoved, true);
      assert.equal(result.remainingEventListeners, 0);
      if (cardsMode) assert.equal(result.hintRemoved, true, "Unmounting the Home card fixture must remove its open tooltip hint");
      cleanup.fixtureApp = "unmounted";
    });
    if (cleanup.errors.some(error => error.startsWith("fixture App unmount:"))) cleanup.fixtureApp = "failed";
  }
  await Promise.all([...pendingFetchHandlers]);
  if (page) await close("page CDP", async () => { await page.close(); cleanup.pageCdp = "closed"; });
  if (browserCdp && targetId) await close("owned page target", async () => {
    const closed = await browserCdp.send("Target.closeTarget", { targetId }, { timeoutMs: 5000 });
    assert.equal(closed.success, true, "Owned Chrome page target must confirm closure");
    cleanup.pageTarget = "closed";
  });
  if (browserCdp) await close("browser CDP", async () => { await browserCdp.close(); cleanup.browserCdp = "closed"; });
  if (chrome) await close("owned Chrome", async () => { cleanup.chrome = { ...await chrome.close() }; });
  if (server) await close("static Vite preview", async () => {
    await server.close();
    assert.equal(server.httpServer?.listening, false, "Static preview listener must be closed");
    cleanup.vitePreview = { ...cleanup.vitePreview, state: "closed" };
  });
  if (fixtureBuildDir) await close("static build directory", async () => {
    await rm(fixtureBuildDir, { recursive: true, force: true });
    try { await access(fixtureBuildDir); throw new Error("Fixture build directory still exists after removal"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    cleanup.fixtureBuild = "removed";
  });
  cleanup.allOwnedResourcesClean = cleanup.errors.length === 0
    && ["unmounted", "not_started"].includes(cleanup.fixtureApp)
    && ["closed", "not_created"].includes(cleanup.pageTarget)
    && ["closed", "not_created"].includes(cleanup.pageCdp)
    && ["closed", "not_created"].includes(cleanup.browserCdp)
    && isOwnedResourceClean(cleanup.chrome.processState) && isOwnedResourceClean(cleanup.chrome.profileState)
    && ["closed", "not_started"].includes(cleanup.vitePreview.state ?? cleanup.vitePreview)
    && ["removed", "not_created"].includes(cleanup.fixtureBuild);
  if (!cleanup.allOwnedResourcesClean) {
    cleanup.errors.push("One or more owned resources did not confirm cleanup");
    failure ||= new Error("Owned browser fixture cleanup was incomplete");
  }
  try { await saveReport(); }
  catch (error) {
    const reportingFailure = `Acceptance report could not be saved: ${errorText(error)}`;
    console.error(reportingFailure);
    if (failure) console.error(`Original acceptance failure remains: ${errorText(failure)}`);
    else failure = error;
  }
}

if (failure) throw failure;
console.log(JSON.stringify({ runId, passed: report?.passed, stage, report: join(outputDir, "report.json"), cleanup: cleanup.allOwnedResourcesClean }));
