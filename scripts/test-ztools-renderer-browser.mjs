import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs } from "./chrome-cdp-smoke-utils.mjs";
import { isOwnedResourceClean, launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";
import { previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { createZtoolsRendererBrowserSourceLock } from "./lib/ztools-renderer-browser-source-lock.mjs";
import { createZtoolsRendererBrowserInteractions } from "./lib/ztools-renderer-browser-interactions.mjs";
import { createZtoolsRendererClipboardBrowserJourney } from "./lib/ztools-renderer-clipboard-browser-journey.mjs";
import { rendererClipboardBrowserFixtureScript } from "./lib/ztools-renderer-clipboard-browser-fixture.mjs";
import { createRendererRecommendationBrowserJourney } from "./lib/ztools-renderer-recommendation-browser-journey.mjs";
import { createZtoolsRendererBrowserNetworkGuard } from "./lib/ztools-renderer-browser-network-guard.mjs";
import { createZtoolsRendererBrowserPage } from "./lib/ztools-renderer-browser-page.mjs";
import {
  FIXTURE_APP_NAME,
  FIXTURE_APP_ALIAS_NAME,
  FIXTURE_APP_PATH,
  FIXTURE_UPDATED_ALIAS_NAME,
  NAMESPACED_READ_KEYS,
  RENDERER_EVENT_NAMES,
  rendererFixtureTransportScript,
} from "../tests/fixtures/ztools-renderer-host/fixture-transport.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const upstream = process.env.ATOOLS_ZTOOLS_SOURCE?.trim() ? resolve(process.env.ATOOLS_ZTOOLS_SOURCE) : "";
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const packageRoot = join(root, "packages/ztools-renderer");
const distRoot = join(packageRoot, "dist");
const port = 1481;
const runId = randomUUID();
const origin = `http://127.0.0.1:${port}`;
const outputDir = join(root, "output/playwright/ztools-renderer-browser", `browser-${runId}`);
const fixtureFiles = [
  "scripts/test-ztools-renderer-browser.mjs",
  "scripts/lib/ztools-renderer-browser-source-lock.mjs",
  "scripts/lib/ztools-renderer-browser-interactions.mjs",
  "scripts/lib/ztools-renderer-clipboard-browser-journey.mjs",
  "scripts/lib/ztools-renderer-clipboard-browser-fixture.mjs",
  "scripts/lib/ztools-renderer-recommendation-browser-fixture.mjs",
  "scripts/lib/ztools-renderer-recommendation-browser-journey.mjs",
  "scripts/lib/ztools-renderer-app-state-browser.mjs",
  "scripts/lib/ztools-renderer-app-state-browser-fixture.mjs",
  "scripts/lib/ztools-renderer-browser-network-guard.mjs",
  "scripts/lib/ztools-renderer-browser-page.mjs",
  "tests/fixtures/ztools-renderer-host/fixture-transport.mjs",
  "packages/ztools-renderer/src/hostAdapter.ts",
  "packages/ztools-renderer/src/commandAliasEvents.ts",
  "packages/ztools-renderer/src/startupReadModel.ts",
  "packages/ztools-renderer/src/settingsSnapshot.ts",
  "packages/ztools-renderer/src/hostEventCatalog.ts",
  "packages/ztools-renderer/src/tauriTransport.ts",
  "packages/ztools-renderer/src/mappers.ts",
  "packages/ztools-renderer/src/types.ts",
  "packages/ztools-renderer/src/errors.ts",
  "packages/ztools-renderer/build.mjs",
  "packages/ztools-renderer/upstream-compatibility-patches.mjs",
  "packages/ztools-renderer/post-minifier.mjs",
  "packages/ztools-renderer/package.json",
  "packages/ztools-renderer/package-lock.json",
  "packages/ztools-renderer/output-transaction.mjs",
  "packages/ztools-renderer/source-manifest.json",
];
const {
  filesUnder,
  hashUpstreamTree,
  sourceHashes,
  readHostAdapterSources,
  distHashes,
} = createZtoolsRendererBrowserSourceLock({ root, upstream, packageRoot, distRoot, fixtureFiles });

const checks = [];
const screenshots = [];
const themeRuns = [];
const network = { requests: [], blocked: [], failed: [], pending: 0 };
const consoleDiagnostics = { runtimeExceptions: [], rawErrors: [], errors: [], expectedUnavailable: [], warnings: [] };
const cleanup = {
  preview: "not_started",
  chrome: { processState: "not_spawned", profileState: "not_created" },
  pageCdp: "not_created",
  browserCdp: "not_created",
  errors: [],
};
const pendingFetch = new Set();
const requestUrls = new Map();
let sourceHashesAtStart;
let sourceHashesAtEnd;
let sourceTreeAtStart;
let sourceTreeAtEnd;
let outputHashesAtStart;
let outputHashesAtEnd;
let provenance;
let hostAdapterSourceBindings;
let server;
let chrome;
let browserCdp;
let page;
let interactions;
let rendererPage;
let failure;
let stage = "preflight";
let report;
let runtimeResult;
let currentDocumentKey = "pre-navigation";
const focusRuns = [];

function errorText(error, depth = 0) {
  if (!error || depth >= 4) return String(error);
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const cause = error?.cause;
  return cause ? `${message}; caused by ${errorText(cause, depth + 1)}` : message;
}

function sha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

const networkGuard = createZtoolsRendererBrowserNetworkGuard({
  pageProvider: () => page,
  origin,
  distRoot,
  filesUnder,
  network,
  pendingFetch,
  cleanup,
  errorText,
});

async function evaluate(expression, timeoutMs = 10000) {
  const result = await page.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true, userGesture: false,
  }, { timeoutMs });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeoutMs = 16000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean((${expression}))`, 3000)) return;
    await delay(40);
  }
  assert.fail(`Timed out waiting for original renderer: ${expression}`);
}

async function settleRequests(timeoutMs = 7000) {
  const deadline = Date.now() + timeoutMs;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    if (pendingFetch.size) await Promise.all([...pendingFetch]);
    if (!pendingFetch.size && network.requests.length === previous) stable += 1;
    else stable = 0;
    if (stable >= 3) {
      network.pending = pendingFetch.size;
      return;
    }
    previous = network.requests.length;
    await delay(70);
  }
  network.pending = pendingFetch.size;
  assert.fail(`Owned renderer network did not settle: ${network.pending} paused requests remain`);
}

async function captureScreenshot(name) {
  const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, { timeoutMs: 10000 });
  const bytes = Buffer.from(result.data, "base64");
  const file = `${name}.png`;
  await writeFile(join(outputDir, file), bytes);
  screenshots.push({ file, sha256: sha(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}

async function recordThemeRun(run) {
  themeRuns.push({
    documentKey: run.documentKey,
    scheme: run.scheme,
    color: run.color,
    rendered: run.state,
    fixture: run.fixture,
    adapter: run.adapter,
  });
  await captureScreenshot(`${run.scheme}-${run.color}`);
  screenshots.at(-1).theme = {
    scheme: run.scheme,
    color: run.color,
    primary: run.state.primary,
    background: run.state.background,
  };
  checks.push(`Original Vue renderer mounted with its real ${run.scheme}/${run.color} theme and autoClear=${run.autoClear}; one batched settings read, one app/plugin list load, and ${RENDERER_EVENT_NAMES.length} shared native event listeners were observed`);
  return run;
}

function onPageDiagnostics() {
  page.on("Runtime.exceptionThrown", event => {
    const details = event.exceptionDetails || {};
    consoleDiagnostics.runtimeExceptions.push((details.exception?.description || details.text || "runtime exception").slice(0, 1000));
  });
  page.on("Runtime.consoleAPICalled", event => {
    if (!["error", "warning", "assert"].includes(event.type)) return;
    const text = `${event.type}:${formatConsoleArgs(event.args)}`;
    if (event.type === "error" || event.type === "assert") {
      const entry = { documentKey: currentDocumentKey, type: event.type, text };
      consoleDiagnostics.rawErrors.push(entry);
      const expectedUnavailable = event.type === "error"
        && text.includes("检查更新状态失败:")
        && text.includes("updater.getDownloadStatus()")
        && text.includes("ATools does not provide the ZTools method: updater.getDownloadStatus()");
      const target = expectedUnavailable ? consoleDiagnostics.expectedUnavailable : consoleDiagnostics.errors;
      target.push(entry);
      return;
    }
    consoleDiagnostics.warnings.push({ documentKey: currentDocumentKey, type: event.type, text });
  });
  page.on("Network.requestWillBeSent", event => {
    const summary = networkGuard.summarizeUrl(event.request.url);
    requestUrls.set(event.requestId, summary);
  });
  page.on("Network.loadingFailed", event => {
    const summary = requestUrls.get(event.requestId) || { origin: "<unknown>", path: "<unknown>", protocol: "<unknown>" };
    network.failed.push({ ...summary, errorText: String(event.errorText || "").slice(0, 200), blockedReason: event.blockedReason || null });
  });
}

function assertConsoleDiagnostics() {
  const counts = new Map();
  assert.deepEqual(consoleDiagnostics.expectedUnavailable, [],
    "The limited updater status capability must not emit the former updater-unavailable error");
  for (const entry of consoleDiagnostics.expectedUnavailable) {
    const adapter = [...themeRuns, ...focusRuns]
      .find(run => run.documentKey === entry.documentKey)?.adapter;
    assert.equal(adapter?.capabilities?.methods?.["updater.getDownloadStatus"], "unavailable", "Allowlisted updater error requires this document's capability to be unavailable");
    assert.ok(adapter?.snapshot?.unsupportedMethods?.includes("updater.getDownloadStatus()"), "Allowlisted updater error requires the adapter to record the unsupported call");
    counts.set(entry.documentKey, (counts.get(entry.documentKey) || 0) + 1);
  }
  assert.ok([...counts.values()].every(count => count <= 1), "Updater-unavailable diagnostic appeared more than once for a document");
  assert.deepEqual(consoleDiagnostics.errors, [], `Original renderer emitted unexpected console errors: ${JSON.stringify(consoleDiagnostics.errors)}`);
  assert.deepEqual(consoleDiagnostics.warnings, [], `Original renderer emitted console warnings: ${JSON.stringify(consoleDiagnostics.warnings)}`);
  assert.deepEqual(consoleDiagnostics.runtimeExceptions, [], `Original renderer raised uncaught runtime exceptions: ${JSON.stringify(consoleDiagnostics.runtimeExceptions)}`);
}

async function safeClose(label, operation) {
  try { await operation(); }
  catch (error) { cleanup.errors.push(`${label}: ${errorText(error)}`); return false; }
  return true;
}

try {
  assert.equal(process.versions.node, "22.23.3", "Run with the pinned ATools product Node 22.23.3");
  assert.equal(await realpath(process.execPath), await realpath(productNode), "Runner must use the product Node executable");
  await mkdir(outputDir, { recursive: true });
  assert.ok(upstream, "Set ATOOLS_ZTOOLS_SOURCE to the pinned ZTools checkout; the runner does not guess a source path");
  const manifest = JSON.parse(await readFile(join(packageRoot, "source-manifest.json"), "utf8"));
  provenance = JSON.parse(await readFile(join(distRoot, "build-provenance.json"), "utf8"));
  assert.equal(provenance.sourceCommit, manifest.source.commit, "Dist provenance must match the pinned ZTools source commit");
  hostAdapterSourceBindings = await readHostAdapterSources();
  assert.ok(Array.isArray(provenance.hostAdapterSources), "Dist provenance must bind the exact host-adapter source files");
  assert.deepEqual(hostAdapterSourceBindings, provenance.hostAdapterSources,
    "Current host-adapter source paths/SHA-256/byte sizes differ from the sources bound into this renderer build");
  sourceTreeAtStart = await hashUpstreamTree();
  assert.equal(sourceTreeAtStart.commit, manifest.source.commit, "Original ZTools source HEAD must match the pinned release");
  assert.equal(sourceTreeAtStart.dirty, "", "Original ZTools source checkout must remain clean");
  assert.equal(sourceTreeAtStart.sha256, provenance.sourceTreeSha256, "Current upstream source hash differs from the built renderer provenance");
  sourceHashesAtStart = await sourceHashes();
  outputHashesAtStart = await distHashes();
  assert.ok(outputHashesAtStart["packages/ztools-renderer/dist/index.html"], "Pinned renderer dist/index.html is missing");
  stage = "start-owned-static-preview";
  server = await previewStaticBrowserFixture({ projectRoot: root, outDir: distRoot, host: "127.0.0.1", port });
  const bound = server.httpServer?.address?.();
  assert.ok(server.httpServer?.listening && bound && typeof bound === "object");
  assert.equal(bound.address, "127.0.0.1");
  assert.equal(bound.port, port);
  cleanup.preview = { state: "listening", origin, port: bound.port };

  stage = "launch-private-chrome";
  chrome = await launchOwnedChrome();
  cleanup.chrome = { ...chrome.lifecycle };
  browserCdp = await CdpClient.connect(chrome.webSocketUrl);
  cleanup.browserCdp = "connected";
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  cleanup.pageCdp = "connected";
  rendererPage = createZtoolsRendererBrowserPage({
    page,
    evaluate,
    waitFor,
    settleRequests,
    origin,
    eventNames: RENDERER_EVENT_NAMES,
    namespacedReadKeys: NAMESPACED_READ_KEYS,
    fixtureAppPath: FIXTURE_APP_PATH,
    fixtureAppAliasName: FIXTURE_APP_ALIAS_NAME,
    setDocumentKey(documentKey) { currentDocumentKey = documentKey; },
  });
  interactions = createZtoolsRendererBrowserInteractions({
    page,
    evaluate,
    waitFor,
    delay,
    captureScreenshot,
    checks,
    fixtureAppName: FIXTURE_APP_NAME,
    fixtureAppAliasName: FIXTURE_APP_ALIAS_NAME,
    fixtureUpdatedAliasName: FIXTURE_UPDATED_ALIAS_NAME,
    fixtureAppPath: FIXTURE_APP_PATH,
    eventNames: RENDERER_EVENT_NAMES,
  });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  onPageDiagnostics();
  const allowedPaths = await networkGuard.allowedDistPaths();
  networkGuard.installFetchInterception(allowedPaths);
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: rendererFixtureTransportScript() });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: rendererClipboardBrowserFixtureScript() });

  stage = "original-vue-renderer-theme-matrix";
  await recordThemeRun(await rendererPage.navigateVariant({
    color: "green", scheme: "light", documentKey: `${themeRuns.length}:light-green`,
  }));
  await recordThemeRun(await rendererPage.navigateVariant({
    color: "blue", scheme: "light", documentKey: `${themeRuns.length}:light-blue`,
  }));
  await recordThemeRun(await rendererPage.navigateVariant({
    color: "green", scheme: "dark", documentKey: `${themeRuns.length}:dark-green`,
  }));
  const searchPage = await recordThemeRun(await rendererPage.navigateVariant({
    color: "blue", scheme: "dark", autoClear: "never", documentKey: `${themeRuns.length}:dark-blue`,
  }));
  assert.notEqual(searchPage.state.background, "", "Original theme background variable must be resolved");
  const backgroundFor = (scheme, color) => themeRuns.find(run => run.scheme === scheme && run.color === color)?.rendered.background;
  assert.equal(themeRuns.length, 4, "The original green/blue light/dark theme matrix must retain four variants");
  assert.equal(screenshots.filter(screenshot => screenshot.theme).length, 4,
    "Exactly four screenshots must represent the color/scheme theme matrix");
  assert.notEqual(backgroundFor("light", "green"), backgroundFor("dark", "green"), "Original light/dark CSS backgrounds must differ");
  assert.notEqual(backgroundFor("light", "blue"), backgroundFor("dark", "blue"), "Original blue light/dark CSS backgrounds must differ");
  const routes = await interactions.exerciseSearchAndWindowRoutes();
  const appState = await interactions.exerciseAppStateFlows();
  await captureScreenshot("dark-blue-history-pins");
  screenshots.at(-1).fixtureState = "one same-path app identity in Recent and one in Pinned";
  const focusImmediatePage = await rendererPage.navigateVariant({
    color: "blue", scheme: "dark", autoClear: "immediately", documentKey: "focus-immediately",
  });
  focusRuns.push({
    documentKey: focusImmediatePage.documentKey,
    scheme: focusImmediatePage.scheme,
    color: focusImmediatePage.color,
    autoClear: focusImmediatePage.autoClear,
    rendered: focusImmediatePage.state,
    fixture: focusImmediatePage.fixture,
    adapter: focusImmediatePage.adapter,
  });
  const immediateFocus = await interactions.exerciseFocusReturn("immediately");
  const focusPage = await rendererPage.navigateVariant({
    color: "blue", scheme: "dark", autoClear: "never", documentKey: "focus-never",
  });
  focusRuns.push({
    documentKey: focusPage.documentKey,
    scheme: focusPage.scheme,
    color: focusPage.color,
    autoClear: focusPage.autoClear,
    rendered: focusPage.state,
    fixture: focusPage.fixture,
    adapter: focusPage.adapter,
  });
  const neverFocus = await interactions.exerciseFocusReturn("never", true);
  checks.push("All six original Main documents consumed one limited updater status snapshot; idle/unchecked stayed distinct from an observed no-update result");
  assert.ok(screenshots.some(screenshot => screenshot.file === "dark-blue-search-selected.png"),
    "Keep the screenshot captured while the original search result is selected");
  stage = "original-vue-clipboard";
  const clipboard = await createZtoolsRendererClipboardBrowserJourney({
    page, evaluate, waitFor, settleRequests, origin, captureScreenshot, checks,
    setDocumentKey(documentKey) { currentDocumentKey = documentKey; },
  }).run();
  runtimeResult = { routes, appState, focusReturn: { immediately: immediateFocus, never: neverFocus }, clipboard };
  stage = "original-vue-recommendations";
  runtimeResult.recommendations = await createRendererRecommendationBrowserJourney({
    page, evaluate, waitFor, settleRequests, origin, captureScreenshot, checks, diagnostics: consoleDiagnostics,
    setDocumentKey(documentKey) { currentDocumentKey = documentKey; },
  }).run();
  await settleRequests();
  assert.deepEqual(network.blocked, [], "Original renderer must not attempt non-allowlisted or external network requests");
  assert.equal(network.pending, 0);
  assertConsoleDiagnostics();
  checks.push("Fetch interception allowed only the pinned dist files on the owned loopback origin and denied all other requests");
  checks.push(`The adapter snapshot records ${RENDERER_EVENT_NAMES.length} bounded native event channels; fixture receipts do not represent a real Tauri window or OS focus`);
  stage = "verified-original-renderer-flow";
} catch (error) {
  failure = error;
  if (stage === "original-vue-clipboard" && page) {
    try {
      runtimeResult = { clipboardFailure: await evaluate(`({
        syntheticOnly: true, fixture: window.__ATOOLS_ZTOOLS_RENDERER_CLIPBOARD_FIXTURE__?.snapshot(),
        query: document.querySelector('.search-input')?.value,
        textPreview: document.querySelector('.pasted-text .text-content')?.textContent,
        imageVisible: Boolean(document.querySelector('.pasted-image-thumbnail')),
        fileName: document.querySelector('.pasted-files .file-name')?.textContent
      })`) };
      await captureScreenshot("clipboard-failure");
    } catch (diagnosticError) { cleanup.errors.push(`clipboard failure diagnostics: ${errorText(diagnosticError)}`); }
  }
} finally {
  if (page && pendingFetch.size) await safeClose("settle paused page requests", () => settleRequests(2500));
  if (page) cleanup.pageCdp = await safeClose("page CDP close", () => page.close()) ? "closed" : "close_failed";
  else cleanup.pageCdp = "not_created";
  if (browserCdp) cleanup.browserCdp = await safeClose("browser CDP close", () => browserCdp.close()) ? "closed" : "close_failed";
  else cleanup.browserCdp = "not_created";
  if (chrome) {
    await safeClose("owned Chrome/profile close", async () => {
      try { await chrome.close(); }
      finally { cleanup.chrome = { ...chrome.lifecycle }; }
    });
    cleanup.chrome = { ...chrome.lifecycle };
  } else {
    cleanup.chrome.processState = "not_spawned";
    cleanup.chrome.profileState = "not_created";
  }
  if (server) {
    await safeClose("owned static preview close", async () => {
      await server.close();
      cleanup.preview = "closed";
    });
  } else cleanup.preview = "not_started";
  network.pending = pendingFetch.size;
  try { sourceTreeAtEnd = await hashUpstreamTree(); }
  catch (error) { cleanup.errors.push(`upstream source hash: ${errorText(error)}`); }
  try { sourceHashesAtEnd = await sourceHashes(); }
  catch (error) { cleanup.errors.push(`ATools source hash: ${errorText(error)}`); }
  try { outputHashesAtEnd = await distHashes(); }
  catch (error) { cleanup.errors.push(`renderer dist hash: ${errorText(error)}`); }
  const sourceTreeStable = Boolean(sourceTreeAtStart && sourceTreeAtEnd)
    && sourceTreeAtStart.sha256 === sourceTreeAtEnd.sha256
    && sourceTreeAtStart.commit === sourceTreeAtEnd.commit
    && sourceTreeAtEnd.dirty === "";
  const packageSourceStable = Boolean(sourceHashesAtStart && sourceHashesAtEnd)
    && JSON.stringify(sourceHashesAtStart) === JSON.stringify(sourceHashesAtEnd);
  const distStable = Boolean(outputHashesAtStart && outputHashesAtEnd)
    && JSON.stringify(outputHashesAtStart) === JSON.stringify(outputHashesAtEnd);
  cleanup.allOwnedResourcesClean = cleanup.preview === "closed"
    && cleanup.pageCdp === "closed" && cleanup.browserCdp === "closed"
    && isOwnedResourceClean(cleanup.chrome.processState) && isOwnedResourceClean(cleanup.chrome.profileState)
    && network.pending === 0 && cleanup.errors.length === 0;
  report = {
    runId,
    passed: !failure && cleanup.allOwnedResourcesClean && sourceTreeStable && packageSourceStable && distStable
      && JSON.stringify(hostAdapterSourceBindings) === JSON.stringify(provenance?.hostAdapterSources),
    stage,
    runtime: { nodeVersion: process.versions.node, execPath: process.execPath },
    resources: { runnerPid: process.pid, upstream, packageRoot, distRoot, origin, chromePid: chrome?.lifecycle?.pid ?? null },
    scope: "Pinned original ZTools Vue renderer in private headless Chrome using the typed ATools host adapter and a strict fixture port. One canonical catalog app plus path-keyed aliases exercise original recent/pin/context-menu flows and Main search refresh against synthetic receipts; the alias-change notification does not prove a Native commit. No TaskRun or real process is created. A CDP mouse drag is attempted for vuedraggable. Clipboard checks exercise original Vue paste consumers against fixed synthetic replies only; they do not prove Native/Rust/system clipboard behavior. This does not prove Tauri/Rust window behavior, OS app discovery/launch, plugin activation, or broad plugin compatibility.",
    fixtureBoundary: {
      appCatalog: [{ name: FIXTURE_APP_NAME, path: FIXTURE_APP_PATH, icon: null }],
      commandAliases: { [`direct:app:${FIXTURE_APP_PATH}`]: [{ alias: FIXTURE_APP_ALIAS_NAME }] },
      appLaunch: "launch_renderer_app validates the catalog identity; one controlled failure preserves pasted search state, a direct synthetic success clears pasted search state, and a typed-query ArrowDown/Enter success clears the query through the original UI; synthetic receipts emit null app-launched after app-state, with no TaskRun or process",
      toolBoundary: "shell_open, arbitrary agent tool names, and extra arguments are rejected",
      pluginInventory: "ordinary documents use an empty list; recommendation documents expose two fixed over-features as metadata only, without plugin activation",
      settingsGeneral: "one get_ztools_renderer_settings call returns controlled theme/autoClear settings with autoPaste=never; 11 namespaced keys are null, while command-aliases and command-usage-stats have fixed fixture values",
      updaterStatus: "each Main document reads one strict no-argument synthetic get_app_update_status snapshot: idle, update=null, checked=false, lastError=null; unchecked means no observed update, not confirmed latest; no update, network, or install action occurs",
      namespacedSettings: "the batched settings response contains all 13 namespaced keys (14 total including settings-general); command-aliases and command-usage-stats are non-null, while command-history and pinned-commands start null",
      searchPreferenceWrite: "two bounded writes preserve the exact canonical-app and configured-alias preferences as fixture intents only; no user database is written",
      nativeEvents: "one listener each for tauri://focus, atools://renderer-app-state, atools://renderer-app-launched, atools://renderer-context-menu, atools://renderer-apps-changed, atools://renderer-settings-view, atools://renderer-general-settings, and atools://renderer-command-aliases; events are synthetic and do not represent real native/OS focus, application activation, or alias commits",
      aliasRefresh: "the original Vue Main search is updated through a synthetic strict-null command-aliases event; the fixture does not prove a Native/Core commit",
      appState: "the in-page native stand-in versions command-history and pinned-commands snapshots, emits receipt events, and records one mutation per selected original context-menu command",
      recommendations: "two private Main documents exercise actual pin/move/unpin menus, stable plugin identity across changed fixture paths and deliberate failure rollback; synthetic CAS uses private-profile localStorage, not Rust/SQLite",
      focusLayout: "focus may trigger measured expand_window layout requests; the report captures their delta and bounded heights while requiring all other native command counts to stay stable",
      clipboard: "one additional original Vue document overrides only the fixture settings autoPaste value to 1s; fixed text, 1x1 PNG, and /fixture file replies exercise the original SearchBox and updateLaunchContext flow; Native/Rust/system clipboard remain untested",
      windowInfo: "native focus does not provide windowInfo; fixture does not call updateWindowInfo or invent an active-window context",
      externalNetwork: "Fetch interception blocks every origin except the owned loopback dist asset list",
    },
    provenance,
    hostAdapterSourceBindings: { current: hostAdapterSourceBindings ?? [], built: provenance?.hostAdapterSources ?? [] },
    sourceTreeAtStart,
    sourceTreeAtEnd,
    sourceTreeStable,
    sourceHashesAtStart: sourceHashesAtStart ?? {},
    sourceHashesAtEnd: sourceHashesAtEnd ?? {},
    packageSourceStable,
    distHashesAtStart: outputHashesAtStart ?? {},
    distHashesAtEnd: outputHashesAtEnd ?? {},
    distStable,
    checks,
    themeRuns,
    focusRuns,
    runtimeResult,
    screenshots,
    network,
    consoleDiagnostics,
    cleanup,
    error: failure ? errorText(failure) : cleanup.errors.length ? cleanup.errors.join("; ") : undefined,
  };
  try { await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { console.error(`Could not write renderer browser report: ${errorText(error)}`); failure ||= error; }
}

console.log(JSON.stringify({ outputDir, passed: report?.passed === true, stage, checks: checks.length, screenshots: screenshots.length, cleanup: cleanup.allOwnedResourcesClean }, null, 2));
if (!report?.passed) process.exitCode = 1;
