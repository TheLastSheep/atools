#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, createPageWebSocketUrl } from "./chrome-cdp-smoke-utils.mjs";
import { isOwnedResourceClean, launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";
import {
  captureZtoolsSettingsInputIdentity,
  validateZtoolsSettingsInputIdentity,
} from "./lib/ztools-settings-input-browser-identity.mjs";
import { RETIRED_TARGET_PATH, startZtoolsSettingsInputStaticServer } from "./lib/ztools-settings-input-browser-server.mjs";
import { classifySettingsInputSlice } from "./lib/ztools-settings-input-browser-acceptance.mjs";
import {
  createMainSettingsInputBootstrap,
} from "./lib/ztools-settings-input-browser-fixture.mjs";
import { RENDERER_GENERAL_SETTINGS_SOURCE_SHA256, compileSettingsAliasTransport } from "./lib/ztools-settings-alias-browser-fixture.mjs";
import { createSettingsAliasBrowserDriver } from "./lib/ztools-settings-alias-browser-driver.mjs";
import { createSettingsInputBrowserRuntime } from "./lib/ztools-settings-input-browser-runtime.mjs";
import { createSettingsInputBrowserScenarios } from "./lib/ztools-settings-input-browser-scenarios.mjs";
import { createLocalLaunchBrowserNativeFixture, decorateMainLocalLaunchBootstrap } from "./lib/ztools-local-launch-browser-fixture.mjs";
import { createLocalLaunchBrowserJourney } from "./lib/ztools-local-launch-browser-journey.mjs";
import { createBuiltinShortcutsBrowserFixture } from "./lib/ztools-builtin-shortcuts-browser-fixture.mjs";
import { createBuiltinShortcutsBrowserJourney } from "./lib/ztools-builtin-shortcuts-browser-journey.mjs";

import { assertMainFileDropFormalReceipt, assertParsedGeneralSourceDigest, CORE_GENERAL_SOURCE_PATH, MAIN_DROP_RECEIPT_PATH, decorateMainFileDropBootstrap } from "./lib/ztools-main-file-drop-browser-fixture.mjs";
import { createMainFileDropBrowserJourney } from "./lib/ztools-main-file-drop-browser-journey.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const productNode = join(root, "src-tauri/binaries/node-aarch64-apple-darwin");
const rendererRoot = join(root, "packages/ztools-renderer");
const settingsRoot = join(root, "packages/ztools-settings");
const rendererDist = join(rendererRoot, "dist");
const settingsDist = join(settingsRoot, "dist");
const fixturePath = join(root, "tests/components/ztoolsSettingsAliasNativeTransportFixture.ts");
const runId = randomUUID();
const outputDir = join(root, "output/playwright/ztools-settings-input-browser", runId);
const inspectOnly = process.argv.slice(2).includes("--inspect");
const localLaunchEnabled = process.argv.slice(2).includes("--local-launch");
const mainFileDropEnabled = process.argv.slice(2).includes("--main-file-drop");
const builtinShortcutsEnabled = process.argv.slice(2).includes("--builtin-shortcuts");
assert.deepEqual(process.argv.slice(2).filter((arg) => !["--inspect", "--local-launch", "--builtin-shortcuts", "--main-file-drop"].includes(arg)), [], "Unknown browser journey argument");
assert.ok(!builtinShortcutsEnabled || !inspectOnly && !localLaunchEnabled, "Builtin shortcut journey runs independently");
assert.ok(!mainFileDropEnabled || !inspectOnly && !localLaunchEnabled && !builtinShortcutsEnabled, "Main drop journey runs independently");
const localLaunchFixture = localLaunchEnabled ? createLocalLaunchBrowserNativeFixture() : null;
const builtinShortcuts = builtinShortcutsEnabled ? createBuiltinShortcutsBrowserFixture() : null;

const MAIN_BINDING = "__atoolsSettingsInputRpc";
const CHILD_BINDING = "__atoolsSettingsChildRpc";
const APP_NAME = "ATools Settings Input Fixture App";
const APP_PATH = "/Applications/atools-settings-input-fixture.app";
const APP_COMMAND_ID = `direct:app:${APP_PATH}`;
const CREATED_ALIAS = `ATools input alias ${runId.slice(0, 8)}`;
const CONFLICT_ALIAS = `ATools input conflict ${runId.slice(0, 8)}`;
const PLUGIN_LOGO = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/jG0AAAAASUVORK5CYII=";
const AUTHORED_FILES = [
  CORE_GENERAL_SOURCE_PATH,
  "scripts/test-ztools-settings-input-browser.mjs",
  "scripts/lib/ztools-settings-input-browser-identity.mjs",
  "scripts/lib/ztools-settings-input-browser-server.mjs",
  "scripts/lib/ztools-settings-input-browser-acceptance.mjs",
  "scripts/lib/ztools-settings-input-browser-fixture.mjs",
  "scripts/lib/ztools-settings-input-browser-runtime.mjs",
  "scripts/lib/ztools-settings-input-browser-scenarios.mjs",
  "scripts/lib/ztools-local-launch-browser-fixture.mjs",
  "scripts/lib/ztools-local-launch-browser-journey.mjs",
  "scripts/lib/ztools-main-file-drop-browser-fixture.mjs",
  "scripts/lib/ztools-main-file-drop-browser-fixture.test.mjs",
  "scripts/lib/ztools-main-file-drop-browser-journey.mjs",
  "tests/components/ztools-renderer-original-main-file-drop.test.ts",
  "packages/ztools-renderer/src/mainFileDrop.ts",
  "packages/ztools-renderer/src/mainDropCompatibility.mjs",
  "scripts/lib/ztools-builtin-shortcuts-browser-fixture.mjs",
  "scripts/lib/ztools-builtin-shortcuts-browser-fixture.test.mjs",
  "scripts/lib/ztools-builtin-shortcuts-browser-journey.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs",
  "scripts/lib/ztools-settings-alias-browser-fixture.mjs",
  "scripts/lib/ztools-settings-alias-browser-driver.mjs",
  "scripts/lib/ztools-renderer-app-state-browser-fixture.mjs",
  "tests/fixtures/ztools-renderer-host/fixture-transport.mjs",
  "tests/components/ztoolsSettingsAliasNativeTransportFixture.ts",
  "packages/ztools-renderer/build.mjs",
  "packages/ztools-renderer/upstream-compatibility-patches.mjs",
  "packages/ztools-renderer/src/builtinShortcutsCompatibility.mjs",
  "packages/ztools-renderer/post-minifier.mjs",
  "packages/ztools-renderer/package.json",
  "packages/ztools-renderer/package-lock.json",
  "packages/ztools-renderer/source-manifest.json",
  "packages/ztools-settings/build.mjs",
  "packages/ztools-settings/source-manifest.json",
  "packages/ztools-settings/src/host-bridge-build.mjs",
];
const report = {
  schemaVersion: 1,
  runId,
  mode: inspectOnly ? "inspect" : "acceptance",
  localLaunchEnabled,
  builtinShortcutsEnabled,
  mainFileDropEnabled,
  mainFileDrop: {},
  builtinShortcuts: { sessions: [], closed: [], saves: [], rejections: [], keyboard: [] },
  status: "not_started",
  workspace: { root, path: null, branch: null, head: null },
  runtime: { nodeVersion: process.versions.node, execPath: process.execPath, productNode },
  parsedGeneralSource: { importTimeSha256: RENDERER_GENERAL_SETTINGS_SOURCE_SHA256, before: null, after: null },
  sourceIdentity: { before: null, after: null, stable: null, preflightErrors: [], runtimeClosures: null },
  artifacts: { rendererDist, settingsDist, outputDir },
  documents: [],
  sessions: [],
  nativeInput: { calls: [], deliveries: [], staleEcho: null, maxPayloadBytes: 0, maxReplyBytes: 0 },
  rendererFixture: { calls: [], settingsBatch: null, snapshot: null, input: null, inputSnapshots: [] },
  childFixture: { compile: null, commandSettings: [], snapshots: [] },
  screenshots: [],
  domDiagnostics: [],
  console: { exceptions: [], errors: [], warnings: [], unhandled: [], expectedAliasConflict: [], expectedBuiltinFailures: [], blockers: [] },
  network: { requests: [], denied: [], externalAttempts: [], failures: [], pending: 0, server: null },
  adapterCapabilities: { methods: { "updater.getDownloadStatus": null } },
  knownUnsupported: [],
  inputSlicePassed: false,
  inputSliceBlockers: [],
  inputFailureDiagnostics: null,
  cleanup: {
    server: "not_started",
    chrome: { processState: "not_spawned", profileState: "not_created" },
    mainCdp: "not_created",
    childCdp: "not_created",
    bindings: { main: "not_added", child: "not_added" },
    pendingRequests: 0,
    errors: [],
  },
  checks: [],
  limitations: [
    "The Native and Core behavior is represented by this runner's synthetic transport; this is not Rust, SQLite, Tauri, or OS focus evidence.",
    "Page.bringToFront isolates the two owned headless Chrome targets; it does not prove desktop window focus.",
  ],
  error: null,
};

const authoredFiles = [...AUTHORED_FILES, ...(mainFileDropEnabled ? [MAIN_DROP_RECEIPT_PATH] : [])].map((path) => join(root, path));
const pendingNetwork = new Set();
const pendingNative = new Set();
let server;
let chrome;
let mainPage;
let childPage;
let mainInjectionId;
let childDriver;
let fixtureBundle;
let runtime;
let scenarios;
let currentDocument = { main: "not-navigated", child: "not-navigated" };
let sourceValidation;
let failure;
let stage = "preflight";
const pageWhitelist = new Set();
let acceptanceCompleted = false;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function cleanup(label, operation) {
  try {
    await operation();
    return true;
  } catch (error) {
    report.cleanup.errors.push(`${label}: ${errorText(error)}`);
    return false;
  }
}

try {
  await mkdir(outputDir, { recursive: true });
  report.workspace.path = await realpath(root);
  report.workspace.branch = execFileSync("git", ["-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim();
  report.workspace.head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  assert.equal(report.workspace.path, "/Users/harris/Desktop/atools", "Run in the frozen ATools worktree");
  assert.equal(report.workspace.branch, "codex/atools-ztools-parity", "Run on the frozen development branch");
  assert.equal(report.workspace.head, "c34789c0e3d19b3bf7c05d396540d891ff126abc", "Run against the frozen R27 base commit");
  assert.equal(process.versions.node, "22.23.3", "Run with the pinned ATools product Node v22.23.3");
  assert.equal(await realpath(process.execPath), await realpath(productNode), "Run with the bundled product Node executable");
  const formalReceipt = mainFileDropEnabled ? await readFile(join(root, MAIN_DROP_RECEIPT_PATH)) : null;
  report.sourceIdentity.before = await captureZtoolsSettingsInputIdentity({ root, authoredFiles });
  report.parsedGeneralSource.before = assertParsedGeneralSourceDigest(report.sourceIdentity.before, RENDERER_GENERAL_SETTINGS_SOURCE_SHA256);
  if (formalReceipt) {
    report.mainFileDrop.formalBefore = assertMainFileDropFormalReceipt(formalReceipt, report.sourceIdentity.before.renderer.dist);
    assertMainFileDropFormalReceipt(await readFile(join(root, MAIN_DROP_RECEIPT_PATH)), report.sourceIdentity.before.renderer.dist);
  }
  sourceValidation = await validateZtoolsSettingsInputIdentity({ root, identity: report.sourceIdentity.before });
  report.sourceIdentity.runtimeClosures = sourceValidation.runtimeClosures;
  report.sourceIdentity.preflightErrors = sourceValidation.errors;
  if (sourceValidation.errors.length) throw new Error(`Preflight source/provenance/dist mismatch: ${sourceValidation.errors.join("; ")}`);

  const fixtureCompile = await compileSettingsAliasTransport({ settingsRoot, fixturePath });
  fixtureBundle = fixtureCompile;
  report.childFixture.compile = { source: fixturePath, sha256: fixtureBundle.sha256, bytes: Buffer.byteLength(fixtureBundle.source) };
  const paths = sourceValidation.servedPaths;
  for (const prefix of ["main", "setting"]) {
    for (const path of paths[prefix]) pageWhitelist.add(`/${prefix}/${path}`);
  }
  pageWhitelist.add("/favicon.ico");
  pageWhitelist.add(RETIRED_TARGET_PATH);
  server = await startZtoolsSettingsInputStaticServer({
    distRoots: { main: rendererDist, setting: settingsDist }, servedPaths: paths,
  });
  report.cleanup.server = { state: "listening", origin: server.origin, port: server.port };
  report.artifacts.origin = server.origin;

  chrome = await launchOwnedChrome();
  report.cleanup.chrome = { ...chrome.lifecycle };
  mainPage = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  childPage = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  report.cleanup.mainCdp = "connected";
  report.cleanup.childCdp = "connected";
  runtime = createSettingsInputBrowserRuntime({
    report, currentDocument, pendingNetwork, pendingNative, pageWhitelist, server, mainPage, childPage,
    outputDir, runId, fixtureBundle, APP_NAME, APP_PATH, APP_COMMAND_ID, PLUGIN_LOGO, localLaunch: localLaunchFixture, builtinShortcuts,
  });
  await runtime.setupPage(mainPage, "main", MAIN_BINDING, runtime.handleMainCommand);
  await runtime.setupPage(childPage, "child", CHILD_BINDING, async message => {
    if (!builtinShortcuts || message.kind !== "r69-builtin-shortcuts") return runtime.handleChildOperation(message);
    const envelope = await builtinShortcuts.handle(message, { sessionId: runtime.activeSession?.sessionId,
      publish: raw => runtime.evaluate(mainPage, `window.__ATOOLS_BUILTIN_SHORTCUTS_MAIN__.accept(${JSON.stringify(raw)})`) });
    await runtime.evaluate(childPage, `window.__ATOOLS_BUILTIN_SHORTCUTS_CHILD__.resolve(${JSON.stringify(message.id)},${JSON.stringify(envelope)})`);
  });
  const mainSource = createMainSettingsInputBootstrap();
  const mainBootstrap = await mainPage.send("Page.addScriptToEvaluateOnNewDocument", {
    source: mainFileDropEnabled ? decorateMainFileDropBootstrap(mainSource) : builtinShortcuts ? builtinShortcuts.decorateMain(mainSource) : localLaunchEnabled ? decorateMainLocalLaunchBootstrap(mainSource) : mainSource,
  });
  mainInjectionId = mainBootstrap.identifier;
  assert.ok(mainInjectionId);
  const mainLoad = mainPage.waitForEvent("Page.loadEventFired", 20000);
  currentDocument.main = "main-startup";
  await mainPage.send("Page.navigate", { url: `${server.origin}/main/index.html?color=green&scheme=dark&autoClear=never` });
  if (builtinShortcuts) {
    await runtime.waitFor(mainPage, "window.__ATOOLS_BUILTIN_SHORTCUTS_MAIN__?.snapshot().held && window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot().activeListenersByEvent['atools://renderer-general-settings'] === 1", "held original Main startup with one General listener");
    builtinShortcuts.replaceRaw({ ...builtinShortcuts.snapshot().raw, search: false, esc: false });
    await runtime.evaluate(mainPage, `window.__ATOOLS_BUILTIN_SHORTCUTS_MAIN__.accept(${JSON.stringify(JSON.stringify({ builtinAppShortcutsEnabled: { search: false, esc: false } }))})`);
    assert.equal(await runtime.evaluate(mainPage, "window.__ATOOLS_BUILTIN_SHORTCUTS_MAIN__.releaseStartup()"), true);
    report.builtinShortcuts.startupRace = { delayedRead: { search: true, esc: true }, earlyEvent: { search: false, esc: false } };
  }
  await mainLoad;
  await runtime.waitFor(mainPage,
    `document.querySelector('.search-input') && window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.snapshot?.() && window.__ATOOLS_SETTINGS_INPUT_TESTING__`,
    "original Main renderer startup");
  await runtime.waitFor(mainPage,
    `window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot?.().settingsBatchLoads===1 && window.__ATOOLS_ZTOOLS_RENDERER_FIXTURE__?.snapshot?.().calls.some(call=>call.command==='list_plugins')`,
    "Main original startup snapshots");

  childDriver = createSettingsAliasBrowserDriver({
    pageProvider: () => childPage,
    outputDir,
    originProvider: () => server.origin,
    allowedDistPaths: pageWhitelist,
    report: { domDiagnostics: report.domDiagnostics },
    documentProvider: { get: () => currentDocument.child, set: (value) => { currentDocument.child = value; } },
    pendingRequests: new Set(),
  });

  runtime.setChildDriver(childDriver);
  stage = "browser-pages-ready";
  if (mainFileDropEnabled) {
    stage = "original-main-file-drop-journey";
    await createMainFileDropBrowserJourney({ report, mainPage, childPage, currentDocument, server }, runtime).run();
  } else if (builtinShortcuts) {
    stage = "original-builtin-shortcuts-journey";
    await createBuiltinShortcutsBrowserJourney({ report, mainPage, childPage, childDriver, currentDocument, server }, runtime, builtinShortcuts).run();
  } else if (inspectOnly) {
    scenarios = createSettingsInputBrowserScenarios({ report, mainPage, childPage, currentDocument, outputDir, runId, APP_NAME, APP_PATH, APP_COMMAND_ID, CREATED_ALIAS, CONFLICT_ALIAS, childDriver, server }, runtime);
    await scenarios.runInspect();
    report.status = "inspected";
  } else {
    scenarios = createSettingsInputBrowserScenarios({ report, mainPage, childPage, currentDocument, outputDir, runId, APP_NAME, APP_PATH, APP_COMMAND_ID, CREATED_ALIAS, CONFLICT_ALIAS, childDriver, server }, runtime);
    await scenarios.runAcceptance();
    if (localLaunchFixture) {
      stage = "original-local-launch-journey";
      try {
        await createLocalLaunchBrowserJourney({ report, mainPage, childPage, childDriver, currentDocument, server }, runtime, localLaunchFixture).run();
      } catch (error) {
        for (const [page, name] of [[mainPage, "main"], [childPage, "child"]]) {
          await runtime.snapshotPage(page, name, "local-launch-failure").catch(() => {});
          await runtime.captureScreenshot(page, `${name}-local-launch-failure`, currentDocument[name]).catch(() => {});
        }
        throw error;
      }
    }
  }
  await runtime.settleNetwork();
  report.adapterCapabilities.methods["updater.getDownloadStatus"] = await runtime.evaluate(mainPage,
    `window.__ATOOLS_ZTOOLS_HOST_ADAPTER__?.capabilities?.()?.methods?.["updater.getDownloadStatus"] ?? null`);
  acceptanceCompleted = !inspectOnly && report.checks.length > 0;
  if (acceptanceCompleted) stage = "original-input-journey-complete";
} catch (error) {
  failure = error;
} finally {
  if (mainPage && mainInjectionId) await cleanup("remove Main injection", () => mainPage.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: mainInjectionId }));
  if (childPage && runtime?.childInjectionId) await cleanup("remove Child injection", () => childPage.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: runtime.childInjectionId }));
  if (mainPage && report.cleanup.bindings.main === "added") {
    if (await cleanup("remove Main binding", () => mainPage.send("Runtime.removeBinding", { name: MAIN_BINDING }))) {
      report.cleanup.bindings.main = "removed";
    }
  }
  if (childPage && report.cleanup.bindings.child === "added") {
    if (await cleanup("remove Child binding", () => childPage.send("Runtime.removeBinding", { name: CHILD_BINDING }))) {
      report.cleanup.bindings.child = "removed";
    }
  }
  await (runtime ? runtime.settleNetwork(3000) : Promise.resolve()).catch((error) => report.cleanup.errors.push(`settle network: ${errorText(error)}`));
  if (pendingNative.size) await Promise.allSettled([...pendingNative]);
  report.cleanup.pendingRequests = pendingNative.size + pendingNetwork.size;
  report.network.pending = pendingNetwork.size;
  report.network.server = server?.state ? { ...server.state } : null;
  if (mainPage) {
    if (await cleanup("close Main CDP", () => mainPage.close())) report.cleanup.mainCdp = "closed";
  }
  if (childPage) {
    if (await cleanup("close Child CDP", () => childPage.close())) report.cleanup.childCdp = "closed";
  }
  if (chrome) {
    await cleanup("close owned Chrome and profile", async () => {
      await chrome.close();
      report.cleanup.chrome = { ...chrome.lifecycle };
    });
    report.cleanup.chrome = { ...chrome.lifecycle };
  }
  if (server) {
    await cleanup("close static server", async () => {
      await server.close();
      report.cleanup.server = "closed";
    });
    report.network.server = { ...server.state };
  }
  try {
    const receiptBeforeFinalCapture = mainFileDropEnabled ? await readFile(join(root, MAIN_DROP_RECEIPT_PATH)) : null;
    report.sourceIdentity.after = await captureZtoolsSettingsInputIdentity({ root, authoredFiles });
    report.parsedGeneralSource.after = assertParsedGeneralSourceDigest(report.sourceIdentity.after, RENDERER_GENERAL_SETTINGS_SOURCE_SHA256);
    if (receiptBeforeFinalCapture) {
      assertMainFileDropFormalReceipt(receiptBeforeFinalCapture, report.sourceIdentity.after.renderer.dist);
      report.mainFileDrop.formalAfter = assertMainFileDropFormalReceipt(await readFile(join(root, MAIN_DROP_RECEIPT_PATH)), report.sourceIdentity.after.renderer.dist);
    }
    report.sourceIdentity.stable = JSON.stringify(report.sourceIdentity.before) === JSON.stringify(report.sourceIdentity.after);
  } catch (error) {
    report.cleanup.errors.push(`final identity: ${errorText(error)}`);
  }
  const expectedBuiltinErrors = new Set(report.console.expectedBuiltinFailures);
  const unsupported = [...report.console.errors, ...report.console.warnings, ...report.console.unhandled].filter(entry => !expectedBuiltinErrors.has(entry))
    .filter((entry) => /unsupported|不支持|未支持|ERR_ATOOLS_SETTINGS_UNSUPPORTED/i.test(JSON.stringify(entry)));
  const expectedAliasErrors = new Set(report.console.expectedAliasConflict);
  const unexpectedConsoleErrors = report.console.errors.filter((entry) => !expectedAliasErrors.has(entry) && !expectedBuiltinErrors.has(entry));
  report.console.blockers = [
    ...report.console.exceptions.map((entry) => ({ source: "exception", ...entry })),
    ...report.console.unhandled.map((entry) => ({ source: "unhandled", ...entry })),
    ...unsupported.map((entry) => ({ source: "unsupported", ...entry })),
    ...unexpectedConsoleErrors.map((entry) => ({ source: "console-error", ...entry })),
  ];
  const resourcesClean = isOwnedResourceClean(report.cleanup.mainCdp) && isOwnedResourceClean(report.cleanup.childCdp) &&
    isOwnedResourceClean(report.cleanup.bindings.main) && isOwnedResourceClean(report.cleanup.bindings.child) &&
    (report.cleanup.server === "closed" || report.cleanup.server === "not_started") && isOwnedResourceClean(report.cleanup.chrome.processState) &&
    isOwnedResourceClean(report.cleanup.chrome.profileState) && report.cleanup.pendingRequests === 0;
  const inputSlice = classifySettingsInputSlice({
    mode: report.mode,
    acceptanceCompleted,
    checksCount: report.checks.length,
    sourceStable: report.sourceIdentity.stable,
    resourcesClean,
    cleanupErrorCount: report.cleanup.errors.length,
    updaterCapability: report.adapterCapabilities.methods["updater.getDownloadStatus"],
    consoleDiagnostics: { ...report.console, errors: report.console.errors.filter(entry => !expectedBuiltinErrors.has(entry)) },
    network: report.network,
    serverRejected: report.network.server?.rejected,
  });
  report.knownUnsupported = inputSlice.knownUnsupported;
  report.inputSlicePassed = inputSlice.passed;
  report.inputSliceBlockers = inputSlice.blockers;
  if (failure) {
    report.error = errorText(failure);
    report.stage = stage;
    report.status = stage === "preflight" ? "not_started" : "partial";
  } else if ((!inspectOnly && !report.inputSlicePassed) || !report.sourceIdentity.stable || !resourcesClean || report.cleanup.errors.length || report.console.blockers.length || report.network.externalAttempts.length ||
      report.network.denied.length || report.network.failures.length) {
    report.status = inspectOnly ? "inspected_with_blockers" : "partial";
    report.stage = stage;
  } else if (inspectOnly) {
    report.status = "inspected";
    report.stage = "inspect-complete";
  } else {
    report.status = "passed";
    report.stage = "acceptance-complete";
  }
  report.resourcesClean = resourcesClean;
  try { await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`); }
  catch (error) { report.error = `${report.error ? `${report.error}; ` : ""}report write failed: ${errorText(error)}`; report.status = "partial"; }
}

console.log(JSON.stringify({
  outputDir,
  status: report.status,
  stage: report.stage || stage,
  checks: report.checks.length,
  screenshots: report.screenshots.length,
  preflightErrors: report.sourceIdentity.preflightErrors.length,
  cleanup: report.resourcesClean === true,
}, null, 2));
if (!["passed", "inspected"].includes(report.status)) process.exitCode = 1;

