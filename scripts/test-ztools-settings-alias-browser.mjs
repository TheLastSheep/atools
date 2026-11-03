#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { CdpClient, createPageWebSocketUrl } from "./chrome-cdp-smoke-utils.mjs";
import { isOwnedResourceClean, launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";
import { selectVitePort } from "./lib/owned-vite-server.mjs";
import { previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import {
  captureSettingsAliasIdentity,
  compileSettingsAliasTransport,
  createSettingsAliasBootstrap,
  createSettingsAliasSeed,
  preflightSettingsAliasIdentity,
} from "./lib/ztools-settings-alias-browser-fixture.mjs";
import { createSettingsAliasBrowserDriver } from "./lib/ztools-settings-alias-browser-driver.mjs";

const root = resolve(fileURLToPath(new URL("../", import.meta.url)));
const settingsRoot = join(root, "packages/ztools-settings");
const distRoot = join(settingsRoot, "dist");
const scriptPath = fileURLToPath(import.meta.url);
const fixturePath = join(root, "tests/components/ztoolsSettingsAliasNativeTransportFixture.ts");
const fixtureSupportPath = join(root, "scripts/lib/ztools-settings-alias-browser-fixture.mjs");
const driverPath = join(root, "scripts/lib/ztools-settings-alias-browser-driver.mjs");
const runId = randomUUID();
const outputDir = join(root, "output/playwright/ztools-settings-alias-browser", runId);
const host = "127.0.0.1";
const inspectOnly = process.argv.slice(2).includes("--inspect");
assert.deepEqual(process.argv.slice(2).filter((arg) => arg !== "--inspect"), [], "Only --inspect is supported");

const APP_NAME = "ATools Alias Browser Target";
const APP_PATH = "/Applications/current.app";
const CREATED_ALIAS = `ATools alias ${runId.slice(0, 8)}`;
const EDITED_ALIAS = `ATools alias edited ${runId.slice(0, 8)}`;
const CAS_ALIAS = `ATools alias CAS probe ${runId.slice(0, 8)}`;
const APP_COMMAND_ID = `direct:app:${APP_PATH}`;
const MISSING_APP_ID = "direct:app:/Applications/removed.app";
const MISSING_PLUGIN_ID = "missing-plugin:feature:old-command:text";
const CURRENT_DOCUMENT_URL = () => `${origin}/index.html#/shortcuts`;

let port = 0;
let origin = "";
let server;
let chrome;
let browserCdp;
let page;
let failure;
let stage = "preflight";
let currentDocument = "not-navigated";
let driver;
let bootstrapSource;
let fixtureBundle;
let initialAliases;
let identityBefore;
let identityAfter;
let injectionId;
const pendingRequests = new Set();
const report = {
  schemaVersion: 1,
  runId,
  mode: inspectOnly ? "inspect" : "acceptance",
  status: "not_started",
  syntheticBoundary: {
    transport: "SettingsAliasNativeTransportFixture compiled from tests/components/ztoolsSettingsAliasNativeTransportFixture.ts",
    sqlite: false,
    rustOrNativeRuntime: false,
    persistence: "the runner captures fixture map before reload and re-injects it into a fresh document",
    general: { autoPaste: "off", reason: "the frozen child schema accepts off, not never; this is the no-auto-paste value" },
    catalogIcons: "empty icon values for all 1024 synthetic rows; no icon fetches are modeled",
    theme: "dark",
    clipboardOrOsAction: false,
  },
  sourceIdentity: { before: null, after: null, stable: null },
  fixtureCatalog: { expectedCommands: 1024, expectedRegexCommands: 1, expectedPlugins: 1 },
  documents: [],
  calls: { byOperation: {}, maximumPayloadBytes: 0, maximumReplyBytes: 0 },
  screenshots: [],
  domDiagnostics: [],
  aliasSlicePassed: false,
  unsupportedBlockers: [],
  otherConsoleBlockers: [],
  console: { runtimeExceptions: [], errors: [], warnings: [], expectedUnsupported: [], expectedAliasConflict: [], unexpectedErrors: [] },
  network: { requests: [], blocked: [], externalAttempts: [], pending: 0 },
  cleanup: {
    preview: "not_started",
    chrome: { processState: "not_spawned", profileState: "not_created" },
    browserCdp: "not_created",
    pageCdp: "not_created",
    errors: [],
  },
  checks: [],
  error: null,
};

const evaluate = (...args) => driver.evaluate(...args);
const waitFor = (...args) => driver.waitFor(...args);
const visibleDomSnapshot = (...args) => driver.visibleDomSnapshot(...args);
const clickElement = (...args) => driver.clickElement(...args);
const clickText = (...args) => driver.clickText(...args);
const fillInput = (...args) => driver.fillInput(...args);
const navigate = (...args) => driver.navigate(...args);
const captureScreenshot = (...args) => driver.captureScreenshot(...args);
const collectFixtureDocument = async (...args) => {
  const snapshot = await driver.collectFixtureDocument(...args);
  finalizeFixtureCallTotals();
  return snapshot;
};
const onPageDiagnostics = (...args) => driver.onPageDiagnostics(...args);

async function addInjection(aliases, documentKey) {
  bootstrapSource = createSettingsAliasBootstrap({ fixtureBundle, aliases, documentKey, runId, appName: APP_NAME, appPath: APP_PATH });
  const result = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: bootstrapSource });
  injectionId = result.identifier;
  assert.ok(injectionId, "CDP should register the owned synthetic child transport injection");
}

async function runInspect() {
  stage = "inspect-original-allCommands-dom";
  await navigate(`${origin}/index.html#/allCommands`, "inspect-allCommands");
  await waitFor(`document.querySelector(".sources-panel")`);
  const dom = await visibleDomSnapshot("allCommands baseline before interaction");
  await captureScreenshot("baseline-allCommands");
  report.checks.push("Inspect-only mode captured the original allCommands DOM/text and screenshot; it did not mutate aliases");
  return dom;
}

async function openAppAliasMenu() {
  const rowExpr = `Array.from(document.querySelectorAll(".card.command-card")).find(row => row.title === ${JSON.stringify(APP_PATH)} && row.innerText.includes(${JSON.stringify(APP_NAME)}))`;
  const menuButtonExpr = `${rowExpr}?.querySelector(".tag-dropdown .tag-wrapper > .card-more-btn")`;
  await waitFor(`(() => {
    const button = ${menuButtonExpr};
    const rect = button?.getBoundingClientRect();
    return !!button && !!rect && rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
  })()`);
  await clickElement(menuButtonExpr, "the visible original app-row TagDropdown trigger");
  await waitFor(`Array.from(document.querySelectorAll(".dropdown-menu .dropdown-item .item-label")).some(label => label.textContent.trim() === "自定义别名")`);
  await clickText("自定义别名", ".dropdown-menu .dropdown-item", "original TagDropdown custom-alias item");
  await waitFor(`document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`);
  await waitFor(`document.querySelector(".alias-dialog-container .target-card")?.innerText.includes(${JSON.stringify(APP_NAME)})`);
}

async function saveAliasDialog(alias, replace) {
  const input = `document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`;
  await fillInput(input, alias, replace, "original alias dialog input");
  await clickText("保存", ".alias-dialog-container .dialog-footer button", "original alias dialog save button");
}

async function waitAliasRow(alias, shouldExist = true) {
  await waitFor(`Array.from(document.querySelectorAll(".alias-table-row")).some(row => row.innerText.includes(${JSON.stringify(alias)})) === ${shouldExist}`);
}

function aliasRowExpression(alias) {
  return `Array.from(document.querySelectorAll(".alias-table-row")).find(row => row.innerText.includes(${JSON.stringify(alias)}))`;
}

function finalizeFixtureCallTotals() {
  const lastSnapshotByDocument = new Map();
  for (const document of report.documents) lastSnapshotByDocument.set(document.documentKey, document);
  report.calls.byOperation = {};
  report.calls.maximumPayloadBytes = 0;
  report.calls.maximumReplyBytes = 0;
  for (const snapshot of lastSnapshotByDocument.values()) {
    for (const [operation, count] of Object.entries(snapshot.operationCounts)) {
      report.calls.byOperation[operation] = (report.calls.byOperation[operation] || 0) + count;
    }
    report.calls.maximumPayloadBytes = Math.max(report.calls.maximumPayloadBytes, snapshot.maximumPayloadBytes);
    report.calls.maximumReplyBytes = Math.max(report.calls.maximumReplyBytes, snapshot.maximumReplyBytes);
  }
}

function assertCatalogPagination(snapshot, label) {
  assert.ok(snapshot.catalogReads.length > 0, `${label} should load the 1024-row fixture directory`);
  for (const read of snapshot.catalogReads) {
    assert.ok(read.pages.length > 1, `${label} directory read must cross page boundaries`);
    assert.equal(read.pages[0].offset, 0);
    for (let index = 1; index < read.pages.length; index += 1) {
      assert.equal(read.pages[index].offset, read.pages[index - 1].nextOffset, `${label} catalog pages must be contiguous`);
    }
    assert.equal(read.pages.at(-1).nextOffset, read.totalBytes, `${label} catalog read must reach the document end`);
  }
  assert.deepEqual(snapshot.expectedCatalogRows, { commands: 1024, regexCommands: 1, plugins: 1 });
}

async function deleteAlias(alias) {
  const row = aliasRowExpression(alias);
  await clickElement(`${row}?.querySelector('button[title="删除"]')`, `delete action for ${alias}`);
  const message = `确定要删除别名“${alias}”吗？`;
  const dialogExpr = `Array.from(document.querySelectorAll('.dialog-overlay > section.dialog-container[role="dialog"]'))
    .find(dialog => dialog.querySelector(".dialog-message")?.textContent.trim() === ${JSON.stringify(message)})`;
  await waitFor(`${dialogExpr}?.querySelector("footer button.btn-danger")`);
  await clickText("删除", "footer button.btn-danger", "original Custom ConfirmDialog delete button", dialogExpr);
  await waitAliasRow(alias, false);
}

async function captureAliasMap() {
  const value = await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.fixture?.getAliases?.() ?? null");
  assert.ok(value && typeof value === "object", "Synthetic alias fixture should expose its stored map for runner capture");
  return value;
}

async function reloadWithCapturedAliases(aliases, documentKey) {
  assert.ok(injectionId, "An owned synthetic transport injection must be active before reload");
  await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: injectionId });
  await addInjection(aliases, documentKey);
  await navigate(CURRENT_DOCUMENT_URL(), documentKey);
  await waitFor(`document.querySelectorAll("button.tab-btn").length >= 3`);
  await clickText("指令别名", "button.tab-btn", "original Shortcuts alias tab");
  await waitFor(`document.querySelector(".alias-table-row") || document.body.innerText.includes("暂无指令别名")`);
}

async function runAcceptance() {
  stage = "original-allCommands-search-and-row-menu";
  await navigate(`${origin}/index.html#/allCommands`, "allCommands");
  await waitFor(`document.querySelector(".sources-panel")`);
  await visibleDomSnapshot("allCommands baseline before selecting the visible app row");
  await captureScreenshot("initial-allCommands");
  await openAppAliasMenu();
  await visibleDomSnapshot("custom alias dialog opened from the original visible app row menu");

  stage = "create-alias-through-original-dialog-save";
  const writesBeforeCreate = await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0");
  await saveAliasDialog(CREATED_ALIAS, false);
  await waitAliasRow(CREATED_ALIAS);
  await waitFor(`(window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0) > ${writesBeforeCreate}`);
  await captureScreenshot("created-alias");
  report.checks.push("A visible original app row opened the original custom-alias dialog; its save wrote through the synthetic child transport and the original alias list rendered the saved row");

  stage = "edit-alias-through-original-row-action";
  const createdRow = aliasRowExpression(CREATED_ALIAS);
  await clickElement(`${createdRow}?.querySelector('button[title="编辑"]')`, "edit action for the created alias row");
  await waitFor(`document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`);
  const writesBeforeEdit = await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0");
  await saveAliasDialog(EDITED_ALIAS, true);
  await waitAliasRow(EDITED_ALIAS);
  await waitAliasRow(CREATED_ALIAS, false);
  await waitFor(`(window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0) > ${writesBeforeEdit}`);
  await captureScreenshot("edited-alias");
  report.checks.push("The original alias-row edit dialog replaced the alias through the original save path");

  stage = "reload-and-verify-captured-fixture-map";
  const aliasesBeforeReload = await captureAliasMap();
  assert.ok(aliasesBeforeReload[APP_COMMAND_ID]?.some(entry => entry?.alias === EDITED_ALIAS));
  report.syntheticBoundary.persistenceFact = "captured the browser fixture alias map and re-injected it into a fresh document; not a SQLite or Native persistence check";
  await collectFixtureDocument("before-reload-after-edit");
  await reloadWithCapturedAliases(aliasesBeforeReload, "reload-after-edit");
  await waitAliasRow(EDITED_ALIAS);
  await waitFor(`document.body.innerText.includes("legacy orphan alias") && document.body.innerText.includes("uninstalled plugin alias")`);
  const legacyRows = await evaluate(`Array.from(document.querySelectorAll(".alias-table-row"))
    .filter(row => row.innerText.includes("legacy orphan alias") || row.innerText.includes("uninstalled plugin alias"))
    .map(row => row.innerText.replace(/\\s+/g, " ").trim())`);
  assert.equal(legacyRows.length, 2, "The original Shortcuts alias list should render both unknown-target legacy entries");
  assert.ok(legacyRows.every(text => text.includes("目标已失效")), "Unknown target rows should remain visible as missing targets");
  const reloadedSnapshot = await collectFixtureDocument("after-reload-after-edit");
  assertCatalogPagination(reloadedSnapshot, "post-reload");
  await visibleDomSnapshot("Shortcuts alias list after fixture-map reload");
  report.checks.push("The edited alias, legacy string[] alias, and missing-target alias survived runner-captured fixture-map reinjection; 1024 commands were paged to the final byte offset");

  stage = "delete-alias-through-original-confirmation";
  await deleteAlias(EDITED_ALIAS);
  await waitFor(`document.body.innerText.includes("legacy current alias")`);
  await collectFixtureDocument("after-delete");
  report.checks.push("The original alias row delete action required and passed the original confirmation dialog");

  stage = "cas-conflict-keeps-original-edit-input-and-reports-error";
  await waitAliasRow("legacy current alias");
  const legacyRow = aliasRowExpression("legacy current alias");
  await clickElement(`${legacyRow}?.querySelector('button[title="编辑"]')`, "edit action for the retained legacy alias");
  await waitFor(`document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`);
  const casInput = `document.querySelector('.alias-dialog-container input[placeholder="输入自定义别名"]')`;
  await fillInput(casInput, CAS_ALIAS, true, "alias edit input before synthetic CAS conflict");
  await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.triggerAliasConflict?.()");
  const writesBeforeConflict = await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0");
  await clickText("保存", ".alias-dialog-container .dialog-footer button", "alias save button for synthetic CAS conflict");
  await waitFor(`document.body.innerText.includes("保存指令别名失败") && (${casInput})?.value === ${JSON.stringify(CAS_ALIAS)}`);
  await waitFor(`(window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.().operationCounts?.writeAliases || 0) > ${writesBeforeConflict}`);
  const conflictSnapshot = await evaluate("window.__ATOOLS_SETTINGS_ALIAS_FIXTURE__?.snapshot?.() ?? null");
  const failedWrite = conflictSnapshot?.calls?.findLast(call => call.operation === "writeAliases");
  assert.equal(failedWrite?.status, "rejected", "Injected CAS conflict must not be reported as a successful write");
  assert.equal(failedWrite?.errorCode, "SETTINGS_ALIAS_REVISION_CONFLICT");
  const errorDom = await visibleDomSnapshot("original alias editor after synthetic CAS conflict");
  assert.ok(errorDom.bodyText.includes("保存指令别名失败"), "The original UI should show its save error toast");
  assert.equal(await evaluate(`${casInput}.value`), CAS_ALIAS, "The failed edit should retain the user's input");
  await captureScreenshot("cas-conflict-retained-input");
  await collectFixtureDocument("after-cas-conflict");
  report.checks.push("Synthetic revision conflict was rejected by the transport; the original UI kept the draft and showed its save-error toast");

  finalizeFixtureCallTotals();
  assert.ok(report.calls.maximumPayloadBytes <= 32 * 1024, "Every synthetic native operation payload must stay within 32 KiB");
  assert.ok(report.calls.maximumReplyBytes <= 64 * 1024, "Every synthetic native reply must stay within 64 KiB");
  assert.deepEqual(report.network.externalAttempts, [], "External network requests must be blocked and absent");
  report.aliasSlicePassed = true;
  report.checks.push("The alias DOM slice passed; host API and runtime blockers remain recorded separately from this slice");
}

async function safeCleanup(label, operation) {
  try {
    await operation();
    return true;
  } catch (error) {
    report.cleanup.errors.push(`${label}: ${error.message || error}`);
    return false;
  }
}

try {
  await mkdir(outputDir, { recursive: true });
  report.outputDir = relative(root, outputDir).split(sep).join("/");
  const nodeVersion = process.versions.node;
  assert.equal(nodeVersion, "22.23.3", "Use src-tauri/binaries/node-aarch64-apple-darwin");

  stage = "capture-frozen-dist-and-source-identity";
  const authoredFiles = [scriptPath, driverPath, fixtureSupportPath, fixturePath];
  identityBefore = await captureSettingsAliasIdentity({ root, distRoot, authoredFiles });
  preflightSettingsAliasIdentity(identityBefore);
  initialAliases = createSettingsAliasSeed(APP_COMMAND_ID);
  const compiledFixture = await compileSettingsAliasTransport({ settingsRoot, fixturePath });
  fixtureBundle = compiledFixture.source;
  report.sourceIdentity.before = {
    bridge: identityBefore.bridge,
    provenanceSha256: identityBefore.provenanceSha256,
    manifestSha256: identityBefore.manifestSha256,
    dist: identityBefore.dist,
    sourceFiles: identityBefore.sourceFiles,
    compiledFixtureSha256: compiledFixture.sha256,
  };
  report.port = port = await selectVitePort(host, 0);
  origin = `http://${host}:${port}`;
  const allowedDistPaths = new Set(Object.keys(identityBefore.dist.files).map(path => `/${path}`));
  driver = createSettingsAliasBrowserDriver({
    pageProvider: () => page,
    outputDir,
    originProvider: () => origin,
    allowedDistPaths,
    report,
    documentProvider: { get: () => currentDocument, set: value => { currentDocument = value; } },
    pendingRequests,
  });

  stage = "start-owned-static-preview";
  server = await previewStaticBrowserFixture({ projectRoot: root, outDir: distRoot, host, port });
  const address = server.httpServer?.address?.();
  assert.ok(server.httpServer?.listening && address && typeof address === "object");
  assert.equal(address.address, host, "Settings dist preview must bind only the owned loopback address");
  assert.equal(address.port, port, "Settings dist preview must keep its selected unique port");
  report.cleanup.preview = "listening";

  stage = "start-private-headless-chrome";
  chrome = await launchOwnedChrome();
  report.cleanup.chrome = { ...chrome.lifecycle };
  browserCdp = await CdpClient.connect(chrome.webSocketUrl);
  report.cleanup.browserCdp = "connected";
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  report.cleanup.pageCdp = "connected";
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Network.enable");
  await page.send("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }] });
  onPageDiagnostics();
  await addInjection(initialAliases, "initial-document");

  if (inspectOnly) {
    await runInspect();
    const snapshot = await collectFixtureDocument("inspect-only");
    assertCatalogPagination(snapshot, "inspect-only");
    finalizeFixtureCallTotals();
    report.status = "inspect_only";
  } else {
    await runAcceptance();
    report.status = "passed";
    stage = "acceptance-passed";
  }
} catch (error) {
  failure = error;
  report.status = stage === "preflight" || stage === "capture-frozen-dist-and-source-identity" ? "not_started" : "failed";
  report.error = `${error?.name || "Error"}: ${error?.message || error}`;
  report.stage = stage;
  if (page) {
    await safeCleanup("failure DOM diagnostics", async () => { await visibleDomSnapshot(`failure at ${stage}`); });
    await safeCleanup("failure screenshot", async () => { await captureScreenshot("failure-state"); });
  }
} finally {
  if (pendingRequests.size) await safeCleanup("settle owned network requests", async () => { await Promise.allSettled([...pendingRequests]); });
  report.network.pending = pendingRequests.size;
  if (page) report.cleanup.pageCdp = await safeCleanup("page CDP close", async () => { await page.close(); }) ? "closed" : "close_failed";
  if (browserCdp) report.cleanup.browserCdp = await safeCleanup("browser CDP close", async () => { await browserCdp.close(); }) ? "closed" : "close_failed";
  if (chrome) {
    await safeCleanup("owned Chrome/profile close", async () => { await chrome.close(); });
    report.cleanup.chrome = { ...chrome.lifecycle };
  }
  if (server) {
    const closed = await safeCleanup("owned static preview close", async () => {
      await server.close();
      assert.equal(server.httpServer?.listening, false, "Owned preview listener remains open after close");
    });
    report.cleanup.preview = closed ? "closed" : "close_failed";
  }
  report.cleanup.allOwnedResourcesClean = isOwnedResourceClean(report.cleanup.preview)
    && isOwnedResourceClean(report.cleanup.chrome.processState)
    && isOwnedResourceClean(report.cleanup.chrome.profileState)
    && ["closed", "not_created"].includes(report.cleanup.browserCdp)
    && ["closed", "not_created"].includes(report.cleanup.pageCdp);
  if (driver) {
    const blockers = driver.collectConsoleBlockers();
    report.unsupportedBlockers = blockers.unsupported;
    report.otherConsoleBlockers = blockers.other;
    if (report.status === "passed" && (blockers.unsupported.length > 0 || blockers.other.length > 0)) {
      report.status = "partial";
      report.acceptanceLimitation = "The alias DOM slice passed, but the original settings UI also emitted unsupported host API/runtime diagnostics.";
    }
  }
  if (identityBefore) {
    try {
      identityAfter = await captureSettingsAliasIdentity({
        root, distRoot, authoredFiles: [scriptPath, driverPath, fixtureSupportPath, fixturePath],
      });
      report.sourceIdentity.after = {
        bridge: identityAfter.bridge,
        provenanceSha256: identityAfter.provenanceSha256,
        manifestSha256: identityAfter.manifestSha256,
        dist: identityAfter.dist,
        sourceFiles: identityAfter.sourceFiles,
      };
      report.sourceIdentity.stable = JSON.stringify(report.sourceIdentity.before.bridge) === JSON.stringify(report.sourceIdentity.after.bridge)
        && report.sourceIdentity.before.provenanceSha256 === report.sourceIdentity.after.provenanceSha256
        && report.sourceIdentity.before.manifestSha256 === report.sourceIdentity.after.manifestSha256
        && JSON.stringify(report.sourceIdentity.before.dist) === JSON.stringify(report.sourceIdentity.after.dist)
        && JSON.stringify(report.sourceIdentity.before.sourceFiles) === JSON.stringify(report.sourceIdentity.after.sourceFiles);
      assert.equal(report.sourceIdentity.stable, true, "Settings host bridge, provenance, dist, runner, and fixture must remain unchanged");
    } catch (error) {
      failure ??= error;
      report.status = "failed";
      report.error ||= `${error?.name || "Error"}: ${error?.message || error}`;
      report.stage ||= "verify-source-identity-at-end";
    }
  }
  await safeCleanup("write run report", async () => {
    report.stage ||= stage;
    await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  });
}

const result = {
  runId,
  status: report.status,
  stage: report.stage || stage,
  report: join(outputDir, "report.json"),
  screenshots: report.screenshots.map(item => item.file),
  aliasSlicePassed: report.aliasSlicePassed,
  unsupportedBlockers: report.unsupportedBlockers.length,
  cleanup: report.cleanup.allOwnedResourcesClean,
  error: report.error,
};
console.log(JSON.stringify(result));
if (failure || ["failed", "not_started", "partial"].includes(report.status)) process.exitCode = 1;
