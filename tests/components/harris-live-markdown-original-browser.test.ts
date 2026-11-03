// @vitest-environment node
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import { startOriginalPluginNodeSession as startLiveMarkdownNodeSession } from "../fixtures/original-plugin-node/node-session.mjs";
import { copyReadOnlyLiveMarkdownPackage, assertLiveMarkdownSourceUnchanged, restoreOwnedCopyDirectoriesWritable } from "../fixtures/live-markdown/original-package";
import { prepareLiveMarkdownRuntime, type LiveMarkdownRuntime } from "../fixtures/live-markdown/runtime-fixture";
import { createLiveMarkdownDocument, type LiveMarkdownEntryRoute } from "../fixtures/live-markdown/document-fixture";
import { createLiveMarkdownNetworkReport, attachLiveMarkdownPage, type LiveMarkdownNetworkReport } from "../fixtures/live-markdown/page-fixture";
import { closePasteCdp, launchPasteBrowserSession } from "../fixtures/paste-browser/chrome-session";
import { assertBrowserPageReport, assertNodeFallbackBoundary, assertOpenDialog, openFileThroughUi,
  readAutoSaveThroughUi, saveAsThroughUi, saveFromToolbar, setAutoSaveThroughUi, sourceText, switchView,
  takeScreenshot, verifyNativeFallbackPorts, waitForEditor, waitForExactFile } from "../fixtures/live-markdown/ui-actions";

const pluginsRoot = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const sourceRoot = join(pluginsRoot, "live-markdown", "dist");
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const requestedRoute = process.env.ATOOLS_LIVE_MARKDOWN_BROWSER_ROUTE ?? "files";
const route: LiveMarkdownEntryRoute = requestedRoute === "menu-open" ? "menu-open" : "files";
const menuOpenRoute = route === "menu-open";
const optIn = process.env.ATOOLS_LIVE_MARKDOWN_BROWSER_ACCEPTANCE === "1"
  && existsSync(join(sourceRoot, "plugin.json")) && existsSync(productNode);
const origin = "https://live-markdown.fixture.invalid";
const outputRoot = resolve(process.cwd(), "output/playwright/live-markdown-original");
const initialText = "# Original Live Markdown file\n\nOpened through the original Harris Live Markdown UI route.\n";
const firstEdit = "# Live Markdown acceptance\n\nTyped into the original live editor.\n";
const localConflictEdit = "# Local buffer after external write\n\nKeep this text available.\n";
const externalEdit = "# External writer\n\nThese bytes must stay on the original path.\n";
const postSaveAsEdit = "# Saved as a new file\n\nContinue editing through the original UI.\n";

type ChromeSession = Awaited<ReturnType<typeof launchPasteBrowserSession>>;
type LiveRuntime = Awaited<ReturnType<typeof prepareLiveMarkdownRuntime>>;
type BrowserPage = { id: string; page: any; controls: ReturnType<typeof attachLiveMarkdownPage> };

it.skipIf(!optIn)(`runs the hash-pinned Harris Live Markdown 0.1.0 ${requestedRoute} route through save conflict, Save As and a fresh Node session`, async () => {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report: Record<string, any> = {
    runId, startedAt: new Date().toISOString(), status: "setup", sourceRoot,
    scope: "Opt-in route-scoped headless Chrome/CDP fixture; original Live Markdown 0.1.0 dist/preload stays read-only; no GUI, user browser, OS clipboard, native file dialog or external network.",
    route: { requested: requestedRoute, selected: route, overallCompatibilityClaim: false,
      note: "This report covers only the selected original entry route; it does not replace or erase evidence from the other route.",
      sourceClickCpuProfileEnabled: process.env.ATOOLS_LIVE_MARKDOWN_PROFILE_SOURCE_CLICK === "1" },
    boundaries: {
      webView: "headless Chrome popup target is a WKWebView stand-in, not Tauri acceptance",
      runtime: "production createPluginRuntimePreload and createPluginBridgeDocument; real product Node 22.23.3 per document",
      files: "temporary files under createFixtureEnvironment HOME/XDG data roots only",
      pluginData: "fixture SQLite through production PluginData bridge; same SQLite path reused after first Node exits",
      dialog: "production nativeDialogBridge reaches controlled save/open picker ports; not macOS dialog/TaskRun permission",
      nativeText: "Node bridge fallback reports handled:false; only Node 22 performs real filesystem operations",
      window: "browserWindow hosted metadata and a script-opened Chrome target; not the native ATools window",
      chrome: "Chrome uses the OS HOME field only with a private user-data-dir; no ambient credentials are inherited",
    },
    browserOrigin: { origin, permission: "loopbackNetwork only for this fixture origin and private Chrome instance" },
    feature: { pluginId: "live-markdown", featureCode: "typora-workbench",
      entryType: menuOpenRoute ? "text" : "files", payloadType: menuOpenRoute ? "null" : "MediaFile[]" },
    initialConditions: { autoSave: "disabled through original UI (File > Preferences > Editor) before edits",
      secondDocument: "the original localStorage preferences fallback key is removed before mount so reopened preference evidence comes from the shared PluginData SQLite bridge",
      inputWorkspace: "only input.md and save-as.md under PluginData/documents; package copy, Chrome profile and fallback probes are outside this workspace" },
    documentPolicy: "fixture-injected Content-Security-Policy sandbox allow-scripts allow-same-origin allow-forms; popups omitted; browser downloads denied",
    packageHashes: {}, graphReads: {}, browser: {}, documents: [], cleanup: { errors: [], resources: [] },
  };
  let isolation: Awaited<ReturnType<typeof createFixtureEnvironment>> | undefined;
  let packageCopy: Awaited<ReturnType<typeof copyReadOnlyLiveMarkdownPackage>> | undefined;
  let firstSession: Awaited<ReturnType<typeof startLiveMarkdownNodeSession>> | undefined;
  let secondSession: Awaited<ReturnType<typeof startLiveMarkdownNodeSession>> | undefined;
  let firstRuntime: LiveRuntime | undefined;
  let secondRuntime: LiveRuntime | undefined;
  let browser: ChromeSession | undefined;
  const pages: BrowserPage[] = [];
  const targetEvents: Array<{ targetId: string; type: string; url: string; openerId?: string; canAccessOpener?: boolean; eventKind?: string }> = [];
  const destroyedTargets: string[] = [];
  let scratchRoot = "";
  let pluginDataRoot = "";
  let originalPath = "";
  let saveAsPath = "";
  let resourceCleanupIncomplete = false;
  let firstRuntimeClosed = false;
  let firstSessionStopped = false;
  let secondRuntimeClosed = false;
  let secondSessionStopped = false;
  try {
    expect(["files", "menu-open"]).toContain(requestedRoute);
    await mkdir(outputRoot, { recursive: true });
    isolation = await createFixtureEnvironment();
    scratchRoot = join(isolation.env.XDG_DATA_HOME, "live-markdown");
    pluginDataRoot = join(scratchRoot, "plugin-data");
    await mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
    const pluginDataRealRoot = await realpath(pluginDataRoot);
    const documentsRoot = join(pluginDataRealRoot, "documents");
    await mkdir(documentsRoot, { recursive: true, mode: 0o700 });
    packageCopy = await copyReadOnlyLiveMarkdownPackage(pluginsRoot, scratchRoot);
    report.packageHashes = packageCopy.builtHashes;
    originalPath = join(documentsRoot, "input.md");
    saveAsPath = join(documentsRoot, "save-as.md");
    await writeFile(originalPath, initialText, { flag: "wx", mode: 0o600 });

    firstSession = await startLiveMarkdownNodeSession({ pluginId: "live-markdown", root: process.cwd(), pluginRoot: packageCopy.pluginRoot,
      preloadPath: packageCopy.preloadPath, scratchRoot, pluginDataRoot: pluginDataRealRoot,
      fixtureEnv: isolation.env, origin, saveAsPath, openFilePath: menuOpenRoute ? originalPath : undefined });
    expect(firstSession.initialization.nodeVersion).toBe("22.23.3");
    report.firstNode = firstSession.initialization;
    firstRuntime = await prepareLiveMarkdownRuntime(firstSession, packageCopy);
    report.firstRuntime = { ownerId: firstRuntime.ownerId, sessionId: firstRuntime.sessionId,
      preloadModuleCount: firstRuntime.moduleCount, graphReads: firstRuntime.reads };
    report.graphReads.first = firstRuntime.reads;

    browser = await launchPasteBrowserSession({ tempRoot: scratchRoot, env: isolation.env, targetEvents,
      destroyedTargets, fixtureOrigin: origin });
    const browserVersion = await browser.browser.send("Browser.getVersion", {}, { timeoutMs: 5000 });
    report.browser = { ...browser.lifecycle, version: browserVersion };
    const first = await openLiveMarkdownDocument(browser, packageCopy, firstRuntime, firstSession, pluginDataRealRoot,
      originalPath, "live-markdown-first-document", 1701, report, "first", pages);
    if (menuOpenRoute) {
      await openFileThroughUi(first.controls);
      const openDialog = assertOpenDialog(firstSession.snapshot().dialogs ?? [], originalPath);
      report.firstOpenDialog = openDialog;
    }
    const firstEntry = await waitForEditor(first.controls);
    assertBrowserPageReport(first.controls.report);
    await switchView(first.controls, "source");
    const initialFileContent = await sourceText(first.controls);
    expect(initialFileContent).toBe(initialText);
    await switchView(first.controls, "live");
    report.documents.push({ name: "first", targetId: first.id, url: origin, openedPath: originalPath,
      entryAccepted: true, openedContent: initialFileContent, windowMetadata: firstEntry.windowMetadata,
      rejectedIpc: firstEntry.rejectedIpc, fixtureMetadataAvailable: firstEntry.fixtureMetadataAvailable,
      heightDeliveryVerified: false, heightNotificationObservedCount: firstEntry.heightNotificationObservedCount });
    report.initialScreenshot = await takeScreenshot(first.controls, outputRoot, `${runId}-initial.png`);

    await setAutoSaveThroughUi(first.controls, false);
    await first.controls.replaceContentEditable("#write .cm-content[contenteditable=true]", firstEdit);
    await switchView(first.controls, "source");
    expect(await sourceText(first.controls)).toBe(firstEdit);
    await switchView(first.controls, "live");
    await saveFromToolbar(first.controls);
    await waitForExactFile(originalPath, firstEdit);
    report.firstSave = { path: originalPath, exactContentVerified: true, fileBytes: Buffer.byteLength(firstEdit), node: firstSession.snapshot() };
    report.afterFirstSaveScreenshot = await takeScreenshot(first.controls, outputRoot, `${runId}-first-save.png`);

    await first.controls.replaceContentEditable("#write .cm-content[contenteditable=true]", localConflictEdit);
    await switchView(first.controls, "source");
    expect(await sourceText(first.controls)).toBe(localConflictEdit);
    await switchView(first.controls, "live");
    await writeFile(originalPath, externalEdit, { mode: 0o600 });
    await saveFromToolbar(first.controls);
    await first.controls.wait(`document.querySelector('.ty-footer-toast')?.innerText.includes('文件已在外部修改，已取消保存以保护外部内容')`, "original visible conflict toast", 4000);
    report.conflictToastObserved = true;
    report.conflictScreenshot = await takeScreenshot(first.controls, outputRoot, `${runId}-conflict.png`);
    expect(await readFile(originalPath, "utf8")).toBe(externalEdit);
    await switchView(first.controls, "source");
    expect(await sourceText(first.controls)).toBe(localConflictEdit);
    report.conflict = { visibleToast: report.conflictToastObserved, screenshot: report.conflictScreenshot,
      localBufferRetained: true, originalFileStayedExternal: true, localText: localConflictEdit, externalText: externalEdit };

    await saveAsThroughUi(first.controls);
    await waitForExactFile(saveAsPath, localConflictEdit);
    expect(await readFile(originalPath, "utf8")).toBe(externalEdit);
    const firstSessionSnapshot = firstSession.snapshot();
    const dialog = firstSessionSnapshot.dialogs?.find((value: Record<string, any>) => value.method === "showSaveDialog");
    expect(dialog?.options).toMatchObject({ title: "保存 Markdown 文档", defaultPath: originalPath,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }, { name: "HTML", extensions: ["html"] }] });
    report.saveAs = { path: saveAsPath, exactContentVerified: true, originalPathUnchanged: true,
      controlledDialog: dialog ?? null, node: firstSessionSnapshot };
    await switchView(first.controls, "live");
    await first.controls.replaceContentEditable("#write .cm-content[contenteditable=true]", postSaveAsEdit);
    await switchView(first.controls, "source");
    expect(await sourceText(first.controls)).toBe(postSaveAsEdit);
    await switchView(first.controls, "live");
    await saveFromToolbar(first.controls);
    await waitForExactFile(saveAsPath, postSaveAsEdit);
    expect(await readFile(originalPath, "utf8")).toBe(externalEdit);
    report.continuedSave = { exactContentVerified: true, saveAsPath, originalPathUnchanged: true };
    report.afterSaveAsScreenshot = await takeScreenshot(first.controls, outputRoot, `${runId}-save-as.png`);
    report.firstNativeFallbackProbe = await verifyNativeFallbackPorts(first.controls, originalPath,
      join(scratchRoot, "first-node-fallback-probe.md"), externalEdit);
    expect(await readFile(join(scratchRoot, "first-node-fallback-probe.md"), "utf8")).toBe(externalEdit);
    await assertNodeFallbackBoundary(firstSession.snapshot());

    await closeDocumentTarget(browser, first, destroyedTargets);
    await firstRuntime.runtime.closeStrict();
    firstRuntimeClosed = true;
    const firstNodeStop = await firstSession.stop();
    firstSessionStopped = true;
    report.firstDocumentClose = { targetDestroyed: destroyedTargets.includes(first.id), runtimeClosed: true,
      nodeStop: firstNodeStop, nodeSnapshot: firstSession.snapshot() };
    expect(firstNodeStop.nodeExitEventObserved).toBe(true);
    expect(firstNodeStop.nodeExit?.code === 0 || ["SIGTERM", "SIGKILL"].includes(firstNodeStop.nodeExit?.signal)).toBe(true);
    expect(firstNodeStop.listenerClosed).toBe(true);
    expect(firstNodeStop.databaseClosed).toBe(true);

    secondSession = await startLiveMarkdownNodeSession({ pluginId: "live-markdown", root: process.cwd(), pluginRoot: packageCopy.pluginRoot,
      preloadPath: packageCopy.preloadPath, scratchRoot, pluginDataRoot: pluginDataRealRoot,
      fixtureEnv: isolation.env, origin, saveAsPath, openFilePath: menuOpenRoute ? saveAsPath : undefined });
    expect(secondSession.initialization.nodeVersion).toBe("22.23.3");
    secondRuntime = await prepareLiveMarkdownRuntime(secondSession, packageCopy);
    expect(secondRuntime.ownerId).not.toBe(firstRuntime.ownerId);
    expect(secondRuntime.sessionId).not.toBe(firstRuntime.sessionId);
    expect(secondSession.endpoints.node).not.toBe(firstSession.endpoints.node);
    report.secondNode = secondSession.initialization;
    report.secondRuntime = { ownerId: secondRuntime.ownerId, sessionId: secondRuntime.sessionId,
      preloadModuleCount: secondRuntime.moduleCount, graphReads: secondRuntime.reads };
    report.graphReads.second = secondRuntime.reads;
    const second = await openLiveMarkdownDocument(browser, packageCopy, secondRuntime, secondSession, pluginDataRealRoot,
      saveAsPath, "live-markdown-second-document", 1702, report, "second", pages, { clearLocalPreferenceFallback: true });
    if (menuOpenRoute) {
      await openFileThroughUi(second.controls);
      report.secondOpenDialog = assertOpenDialog(secondSession.snapshot().dialogs ?? [], saveAsPath);
    }
    const secondEntry = await waitForEditor(second.controls);
    assertBrowserPageReport(second.controls.report);
    await switchView(second.controls, "source");
    const reopenedContent = await sourceText(second.controls);
    expect(reopenedContent).toBe(postSaveAsEdit);
    report.documents.push({ name: "second", targetId: second.id, url: origin, openedPath: saveAsPath,
      entryAccepted: true, openedContent: reopenedContent, windowMetadata: secondEntry.windowMetadata,
      rejectedIpc: secondEntry.rejectedIpc, fixtureMetadataAvailable: secondEntry.fixtureMetadataAvailable,
      heightDeliveryVerified: false, heightNotificationObservedCount: secondEntry.heightNotificationObservedCount });
    await switchView(second.controls, "live");
    const autoSaveAfterReopen = await readAutoSaveThroughUi(second.controls);
    expect(autoSaveAfterReopen).toBe(false);
    report.secondDocumentReadback = { exactContentVerified: true, path: saveAsPath,
      sameSqliteRoot: pluginDataRealRoot, preferenceAutoSaveReopened: autoSaveAfterReopen,
      windowMetadata: secondEntry.windowMetadata,
      freshOwner: secondRuntime.ownerId !== firstRuntime.ownerId, freshSession: secondRuntime.sessionId !== firstRuntime.sessionId,
      freshNodeEndpoint: secondSession.endpoints.node !== firstSession.endpoints.node };
    report.secondScreenshot = await takeScreenshot(second.controls, outputRoot, `${runId}-fresh-session.png`);
    report.secondNativeFallbackProbe = await verifyNativeFallbackPorts(second.controls, saveAsPath,
      join(scratchRoot, "second-node-fallback-probe.md"), postSaveAsEdit);
    expect(await readFile(join(scratchRoot, "second-node-fallback-probe.md"), "utf8")).toBe(postSaveAsEdit);
    await assertNodeFallbackBoundary(secondSession.snapshot());
    await closeDocumentTarget(browser, second, destroyedTargets);
    await secondRuntime.runtime.closeStrict();
    secondRuntimeClosed = true;
    const secondNodeStop = await secondSession.stop();
    secondSessionStopped = true;
    report.secondDocumentClose = { targetDestroyed: destroyedTargets.includes(second.id), runtimeClosed: true,
      nodeStop: secondNodeStop, nodeSnapshot: secondSession.snapshot() };
    expect(secondNodeStop.nodeExitEventObserved).toBe(true);
    expect(secondNodeStop.nodeExit?.code === 0 || ["SIGTERM", "SIGKILL"].includes(secondNodeStop.nodeExit?.signal)).toBe(true);
    expect(secondNodeStop.listenerClosed).toBe(true);
    expect(secondNodeStop.databaseClosed).toBe(true);
    report.targetEvents = targetEvents;
    report.destroyedTargets = destroyedTargets;
    const knownPages = new Set([browser.harnessTargetId, ...browser.baselinePageTargetIds, ...pages.map(page => page.id)]);
    report.unexpectedCreatedPages = targetEvents.filter(event => event.eventKind === "created" && event.type === "page" && !knownPages.has(event.targetId));
    const isKnownChromeInternalHelpPage = (event: { url: string; openerId?: string; canAccessOpener?: boolean }) => event.url === "chrome://help/"
      && !event.openerId && event.canAccessOpener === false;
    report.browserInternalPages = report.unexpectedCreatedPages.filter(isKnownChromeInternalHelpPage);
    report.browserInternalPageBoundary = "Only exact chrome://help/ targets without openerId and with canAccessOpener=false are classified here; origin and Chrome-internal target behavior are not verified, and this is not a browser-wide network-isolation claim.";
    report.unclassifiedUnexpectedCreatedPages = report.unexpectedCreatedPages.filter((event: Record<string, unknown>) => !isKnownChromeInternalHelpPage(event));
    expect(report.unclassifiedUnexpectedCreatedPages).toEqual([]);
    report.status = menuOpenRoute ? "passed-menu-open-route-fixture-assertions" : "passed-files-route-fixture-assertions";
  } catch (error) {
    report.status = "failed";
    report.failure = describeError(error);
    report.failureNodeStats = {
      first: firstSession ? boundedNodeSnapshot(firstSession) : { state: "not_started" },
      second: secondSession ? boundedNodeSnapshot(secondSession) : { state: "not_started" },
    };
    if (hasUnconfirmedCleanup(error)) resourceCleanupIncomplete = true;
    const chromeLifecycle = (error as { atoolsChromeLifecycle?: unknown })?.atoolsChromeLifecycle;
    if (chromeLifecycle) {
      report.failedChromeLifecycle = chromeLifecycle;
      if ((chromeLifecycle as Record<string, unknown>).processState === "exit_unconfirmed") resourceCleanupIncomplete = true;
    }
  } finally {
    if (browser) {
      try {
        const browserClose = await browser.close();
        report.browser = { ...report.browser, ...browserClose };
        if (browserClose.processState !== "exited" || browserClose.profileState !== "removed") resourceCleanupIncomplete = true;
      }
      catch (error) { resourceCleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (secondRuntime && !secondRuntimeClosed) resourceCleanupIncomplete = !(await closeRuntime(secondRuntime, report, "secondRuntime")) || resourceCleanupIncomplete;
    if (firstRuntime && !firstRuntimeClosed) resourceCleanupIncomplete = !(await closeRuntime(firstRuntime, report, "firstRuntime")) || resourceCleanupIncomplete;
    if (secondSession && !secondSessionStopped) resourceCleanupIncomplete = !(await stopNodeSession(secondSession, report, "secondNode")) || resourceCleanupIncomplete;
    if (firstSession && !firstSessionStopped) resourceCleanupIncomplete = !(await stopNodeSession(firstSession, report, "firstNode")) || resourceCleanupIncomplete;
    report.finalNodeStats = {
      first: firstSession ? boundedNodeSnapshot(firstSession) : { state: "not_started" },
      second: secondSession ? boundedNodeSnapshot(secondSession) : { state: "not_started" },
    };
    for (const page of pages) {
      try { await closePasteCdp(page.page); }
      catch (error) { resourceCleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (packageCopy) {
      try { await assertLiveMarkdownSourceUnchanged(packageCopy.sourceDigests); report.sourceUnchanged = true; }
      catch (error) { resourceCleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (packageCopy && !resourceCleanupIncomplete) {
      try { report.packageCopyPermissionsRestored = await restoreOwnedCopyDirectoriesWritable(packageCopy); }
      catch (error) { resourceCleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (isolation) {
      if (resourceCleanupIncomplete) {
        report.fixtureEnvironmentRemoved = false;
        report.fixtureEnvironmentState = "preserved_for_unconfirmed_resource_exit";
      } else {
        try { await isolation.cleanup(); report.fixtureEnvironmentRemoved = true; }
        catch (error) { resourceCleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
      }
    }
    if (report.cleanup.errors.length > 0) resourceCleanupIncomplete = true;
    report.cleanupIncomplete = resourceCleanupIncomplete;
    report.finishedAt = new Date().toISOString();
    try {
      await writeFile(join(outputRoot, `${runId}-report.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
      report.reportPath = join(outputRoot, `${runId}-report.json`);
    } catch (error) { report.cleanup.errors.push(describeError(error)); }
    if (report.status !== (menuOpenRoute ? "passed-menu-open-route-fixture-assertions" : "passed-files-route-fixture-assertions")
      || resourceCleanupIncomplete || report.cleanup.errors.length > 0
      || report.firstDocumentClose && !nodeStopConfirmed(report.firstDocumentClose.nodeStop)
      || report.secondDocumentClose && !nodeStopConfirmed(report.secondDocumentClose.nodeStop)
      || report.browser?.processState && (report.browser.processState !== "exited" || report.browser.profileState !== "removed")) {
      throw new Error(`Live Markdown original browser fixture failed; report ${join(outputRoot, `${runId}-report.json`)}`, { cause: report.failure });
    }
  }
}, 180_000);

async function openLiveMarkdownDocument(browser: ChromeSession, packageCopy: NonNullable<Awaited<ReturnType<typeof copyReadOnlyLiveMarkdownPackage>>>,
  runtime: LiveRuntime, session: Awaited<ReturnType<typeof startLiveMarkdownNodeSession>>, pluginDataPath: string,
  documentPath: string, browserWindowId: string, webContentsId: number, report: Record<string, any>, label: string,
  pages: BrowserPage[], setup: { clearLocalPreferenceFallback?: boolean } = {}): Promise<BrowserPage> {
  const document = createLiveMarkdownDocument({ pluginRoot: packageCopy.pluginRoot, indexHtml: packageCopy.indexHtml,
    route, preloadScript: runtime.preloadScript, endpoints: session.endpoints, pluginDataPath, documentPath,
    browserWindowId, webContentsId });
  const child = await browser.openChild();
  if (setup.clearLocalPreferenceFallback) {
    const source = `if(location.origin===${JSON.stringify(origin)})localStorage.removeItem('typora_ztools_preferences_v1');`;
    await child.page.send("Page.addScriptToEvaluateOnNewDocument", { source }, { timeoutMs: 5000 });
    report.localPreferenceFallbackClearedFor = label;
  }
  const network: LiveMarkdownNetworkReport = createLiveMarkdownNetworkReport();
  const controls = attachLiveMarkdownPage(child.page, { origin, pluginRoot: packageCopy.pluginRoot,
    injectedHtml: document.html, endpoints: session.endpoints, report: network,
    navigationDiagnosticScreenshotPath: join(outputRoot, `${String(report.runId)}-${label}-navigation-failure.png`),
    cpuProfilePath: label === "first" && process.env.ATOOLS_LIVE_MARKDOWN_PROFILE_SOURCE_CLICK === "1"
      ? join(outputRoot, `${String(report.runId)}-source-click.cpuprofile`) : undefined });
  report[`${label}Network`] = network;
  const openedPage = { id: child.target.targetId, page: child.page, controls };
  pages.push(openedPage);
  await controls.enableInterception();
  await controls.navigate();
  return openedPage;
}

function boundedNodeSnapshot(session: Awaited<ReturnType<typeof startLiveMarkdownNodeSession>>) {
  try {
    const snapshot = session.snapshot();
    const dialogs = Array.isArray(snapshot.dialogs) ? snapshot.dialogs : [];
    const nodeModules = Array.isArray(snapshot.nodeModules) ? snapshot.nodeModules : [];
    return { ...snapshot,
      dialogs: { count: dialogs.length, entries: dialogs.slice(0, 10), truncated: dialogs.length > 10 },
      nodeModules: { count: nodeModules.length, entries: nodeModules.slice(0, 100), truncated: nodeModules.length > 100 } };
  } catch (error) {
    return { state: "snapshot_failed", failure: describeError(error) };
  }
}

async function closeDocumentTarget(browser: ChromeSession, page: BrowserPage, destroyedTargets: string[]) {
  await page.controls.settleRequests();
  const result = await browser.browser.send("Target.closeTarget", { targetId: page.id }, { timeoutMs: 5000 });
  expect(result.success).toBe(true);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !destroyedTargets.includes(page.id)) await new Promise(resolve => setTimeout(resolve, 20));
  expect(destroyedTargets).toContain(page.id);
}

async function closeRuntime(runtime: LiveRuntime, report: Record<string, any>, name: string) {
  try { await runtime.runtime.closeStrict(); report.cleanup.resources.push({ name, state: "closed" }); return true; }
  catch (error) { report.cleanup.errors.push(describeError(error)); report.cleanup.resources.push({ name, state: "close_unconfirmed" }); return false; }
}

async function stopNodeSession(session: Awaited<ReturnType<typeof startLiveMarkdownNodeSession>>, report: Record<string, any>, name: string) {
  try { const result = await session.stop(); report.cleanup.resources.push({ name, result }); return true; }
  catch (error) { report.cleanup.errors.push(describeError(error)); report.cleanup.resources.push({ name, state: "stop_unconfirmed" }); return false; }
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const result: Record<string, unknown> = { name: value.name, message: redact(value.message), stack: redact(value.stack ?? "") };
  if (depth < 4 && value.cause !== undefined) result.cause = describeError(value.cause, depth + 1);
  if (depth < 4 && value instanceof AggregateError) result.errors = [...value.errors].map(item => describeError(item, depth + 1));
  return result;
}

function redact(value: string) {
  return value.replace(/(\/(?:node|data|host|secrets|dialog)\/)[a-f0-9]{64}(?=\/|[?#\s]|$)/giu, "$1<redacted>")
    .replace(/\b[a-f0-9]{64}\b/giu, "<redacted>");
}

function nodeStopConfirmed(value: Record<string, any>) {
  return value.nodeExitEventObserved === true
    && (value.nodeExit?.code === 0 || ["SIGTERM", "SIGKILL"].includes(value.nodeExit?.signal))
    && value.listenerClosed === true && value.databaseClosed === true;
}

function hasUnconfirmedCleanup(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/cleanup (?:could not be confirmed|was not confirmed|did not complete)|exit_unconfirmed|exit was not observed/iu.test(error.message)) return true;
  return error instanceof AggregateError && [...error.errors].some(hasUnconfirmedCleanup);
}
