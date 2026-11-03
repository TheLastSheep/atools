// @vitest-environment node
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { expect, it } from "vitest";
import { createPluginRuntimePreload } from "../../src/lib/pluginRuntimePreload";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import { createPasteStartupWorker, createReadOnlyBuiltPackage, sourceDigestsUnchanged } from "../fixtures/paste-startup/frame-fixture";
import { createPasteStartupDocument } from "../fixtures/paste-startup/document-fixture";
import { copyPinnedPasteBrowserAssets } from "../fixtures/paste-browser/original-assets";
import { closePasteCdp, launchPasteBrowserSession } from "../fixtures/paste-browser/chrome-session";
import { attachPasteEditorPage, pasteEditorFixedInput, pasteEditorUrl, type PasteEditorNetworkReport } from "../fixtures/paste-browser/page-fixture";
import { pasteNativeNotificationPortScript } from "../fixtures/paste-browser/native-notification-port";
import { clearStartupSeedsInOwnedWorker } from "../fixtures/paste-browser/sqlite-reopen-worker";

const pluginSource = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const sourceRoot = resolve(pluginSource, "pasteboard-pro", "dist", "ztools");
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const optIn = process.env.ATOOLS_PASTE_BROWSER_ACCEPTANCE === "1"
  && existsSync(resolve(sourceRoot, "preload.js")) && existsSync(productNode);
const outputRoot = resolve(process.cwd(), "output/playwright/paste-original-editor");
const input = pasteEditorFixedInput();

type FixtureWorker = Awaited<ReturnType<typeof createPasteStartupWorker>>;
type Runtime = ReturnType<typeof createPluginRuntimePreload>;

async function preparePasteRuntime(worker: FixtureWorker, packageCopy: Awaited<ReturnType<typeof createReadOnlyBuiltPackage>>, ownerId: string) {
  let sessionId = "";
  let nodeOwnerCloses = 0;
  let nodeStopResult: unknown;
  let safeStoragePermissionPortCalls = 0;
  const commands: Array<{ command: string; args: Record<string, unknown> }> = [];
  const invoke = async <T = unknown>(command: string, args: Record<string, unknown> = {}) => {
    commands.push({ command, args });
    if (command === "prepare_legacy_node") {
      assert.equal(args.pluginId, "pasteboard-pro");
      assert.equal(args.instanceId, ownerId);
      assert.match(String(args.instanceId), /^[0-9a-f-]{36}$/u);
      sessionId = randomUUID();
      return { sessionId } as T;
    }
    if (command === "get_legacy_node_session") {
      assert.equal(args.sessionId, sessionId);
      return { endpoint: worker.endpoints.node } as T;
    }
    if (command === "close_legacy_node") {
      assert.equal(args.pluginId, "pasteboard-pro");
      assert.equal(args.instanceId, ownerId);
      nodeOwnerCloses++;
      nodeStopResult = await worker.request("stopNode");
      return nodeStopResult as T;
    }
    throw new Error(`Unexpected production preload command: ${command}`);
  };
  const runtime = createPluginRuntimePreload(invoke, "pasteboard-pro", () => true, undefined, ownerId);
  const graphReads: string[] = [];
  const preloadScript = await runtime.prepare({
    pluginDir: packageCopy.pluginRoot,
    preloadPath: packageCopy.preloadPath,
    isCurrent: () => true,
    readTextFile: async path => {
      const actual = resolve(path);
      if (actual !== packageCopy.pluginRoot && !actual.startsWith(`${packageCopy.pluginRoot}${sep}`)) {
        throw new Error(`Production preload graph escaped immutable fixture copy: ${actual}`);
      }
      graphReads.push(actual);
      return readFile(actual, "utf8");
    },
    // Fixture port only; this is not a real permission decision or TaskRun.
    onSafeStorageRequired: async () => { safeStoragePermissionPortCalls++; },
  });
  expect(sessionId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(graphReads).toEqual([
    packageCopy.preloadPath,
    resolve(packageCopy.pluginRoot, "chunks/history-search-index-Bm2oYZYG.cjs"),
  ]);
  return { runtime, preloadScript, sessionId, nodeOwnerCloses: () => nodeOwnerCloses, nodeStopResult: () => nodeStopResult,
    safeStoragePermissionPortCalls: () => safeStoragePermissionPortCalls, commands };
}

async function observeSameDocumentNativePort(page: any, report: Record<string, any>, documentName: string) {
  const bindingName = "__atoolsFixtureNativeCallObserved";
  const received: unknown[] = [];
  report.nativeNotificationPort ??= {
    mode: "same-document self-postMessage observation/response fixture; does not prove opener delivery, cross-window delivery, or native window behavior",
    documents: {},
  };
  report.nativeNotificationPort.documents[documentName] = received;
  page.on("Runtime.bindingCalled", (event: any) => {
    if (event.name !== bindingName) return;
    try { received.push(JSON.parse(event.payload)); }
    catch (error) { report.nativeNotificationPort.bindingErrors = [...(report.nativeNotificationPort.bindingErrors ?? []), String(error)]; }
  });
  await page.send("Runtime.addBinding", { name: bindingName }, { timeoutMs: 5000 });
  return received;
}

async function permitExactHistoryChange(page: any, id: string) {
  const expression = `window.__pasteEditorNativePort.allowedRecordId=${JSON.stringify(id)};true`;
  const result = await page.send("Runtime.evaluate", { expression, returnByValue: true }, { timeoutMs: 5000 });
  assert.equal(result.result?.value, true);
}

async function waitUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${label}; last observation ${JSON.stringify(last)}`);
}

function emptyNetworkReport(): PasteEditorNetworkReport {
  return { allowed: [], denied: [], failures: [], pinsServed: [], editorDocuments: 0, recordWrites: [], dialogs: [] };
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const result: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
  if (depth < 4 && value.cause !== undefined) result.cause = describeError(value.cause, depth + 1);
  if (depth < 4 && value instanceof AggregateError) result.errors = [...value.errors].map(item => describeError(item, depth + 1));
  return result;
}

it.skipIf(!optIn)("runs Harris Paste 1.3.1 original standalone editor through failed save, retry and a fresh durable session", async () => {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report: Record<string, any> = {
    runId, status: "setup", startedAt: new Date().toISOString(), sourceRoot,
    scope: "Opt-in headless Chrome/CDP fixture; original Paste build remains read-only; no native GUI, user browser, system clipboard, global input hook or external network.",
    boundaries: { webView: "headless Chrome target as WKWebView stand-in", pluginData: "Task14 Worker HTTP port plus node:sqlite temporary database", permission: "controlled fixture port, not native permission or TaskRun", parentIPC: "same-document self-postMessage observation/response fixture port; not cross-window/native delivery", nativeWindow: "not verified; only browser document close is observed" },
    editorDocumentPolicy: "Content-Security-Policy: sandbox allow-scripts allow-same-origin allow-forms; allow-popups omitted",
    browser: {}, pages: [], outputs: [], cleanup: { errors: [], resources: [] },
  };
  let isolation: Awaited<ReturnType<typeof createFixtureEnvironment>> | undefined;
  let packageCopy: Awaited<ReturnType<typeof createReadOnlyBuiltPackage>> | undefined;
  let worker: FixtureWorker | undefined;
  let runtime: Runtime | undefined;
  let firstPrepared: Awaited<ReturnType<typeof preparePasteRuntime>> | undefined;
  let secondPrepared: Awaited<ReturnType<typeof preparePasteRuntime>> | undefined;
  let secondWorker: FixtureWorker | undefined;
  let secondRuntime: Runtime | undefined;
  let browser: Awaited<ReturnType<typeof launchPasteBrowserSession>> | undefined;
  const openPages: Array<{ targetId: string; page: any }> = [];
  let scratchRoot = "";
  let resourceCleanupIncomplete = false;
  const attempted = { firstWorker: false, firstRuntime: false, chrome: false, secondWorker: false, secondRuntime: false };
  const stopped = { firstWorker: false, firstRuntime: false, secondWorker: false, secondRuntime: false };
  const targetEvents: Array<{ targetId: string; type: string; url: string; openerId?: string; eventKind?: string }> = [];
  const destroyedTargets: string[] = [];
  let failure: unknown;
  let outputDirectoryCreated = false;
  let pageForFailure: { id: string; controls: ReturnType<typeof attachPasteEditorPage> } | undefined;
  try {
    await mkdir(outputRoot, { recursive: true });
    outputDirectoryCreated = true;
    isolation = await createFixtureEnvironment();
    scratchRoot = resolve(isolation.root, "work");
    const pluginDataRoot = resolve(scratchRoot, "plugin-data");
    await mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
    const pluginDataRealRoot = await realpath(pluginDataRoot);
    packageCopy = await createReadOnlyBuiltPackage(pluginSource, scratchRoot);
    report.originalPackageHashes = packageCopy.builtHashes;
    report.browserAssetHashes = await copyPinnedPasteBrowserAssets(sourceRoot, packageCopy.pluginRoot, packageCopy.sourceDigests);
    attempted.firstWorker = true;
    worker = await createPasteStartupWorker({
      root: process.cwd(), scratchRoot, pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath,
      pluginDataRoot: pluginDataRealRoot, fixtureEnv: isolation.env, scenario: "text",
    });
    expect(worker.initialization.nodeVersion).toBe("22.23.3");
    report.firstNode = { nodePid: worker.initialization.pid, nodeVersion: worker.initialization.nodeVersion, workerThreadId: worker.worker.threadId };
    attempted.firstRuntime = true;
    firstPrepared = await preparePasteRuntime(worker, packageCopy, randomUUID());
    runtime = firstPrepared.runtime;
    report.firstSessionId = firstPrepared.sessionId;
    report.ownerInstanceId = firstPrepared.commands.find(call => call.command === "prepare_legacy_node")?.args.instanceId;

    attempted.chrome = true;
    browser = await launchPasteBrowserSession({ tempRoot: scratchRoot, env: isolation.env, targetEvents, destroyedTargets });
    const browserVersion = await browser.browser.send("Browser.getVersion", {}, { timeoutMs: 5000 });
    report.browser = { ...browser.lifecycle, version: browserVersion, profilePrivate: true };
    report.targetEvents = targetEvents;
    report.destroyedTargets = destroyedTargets;
    const browserWindowId = `fixture-paste-editor-${randomUUID()}`;
    const endpoints = worker.endpoints;
    const firstDocument = createPasteStartupDocument({
      pluginRoot: packageCopy.pluginRoot, indexHtml: packageCopy.indexHtml, preloadScript: firstPrepared.preloadScript,
      endpoints, pluginDataPath: pluginDataRealRoot, windowType: "browserWindow", browserWindowId, webContentsId: 1501,
      beforeBridgeScript: pasteNativeNotificationPortScript(browserWindowId),
    });
    const firstWriteFailure = { pending: true };
    const firstNetwork = emptyNetworkReport();
    report.firstNetwork = firstNetwork;
    let firstPageId = "";
    const firstChild = await browser.openChild();
    firstPageId = firstChild.target.targetId;
    openPages.push({ targetId: firstPageId, page: firstChild.page });
    const firstNativeEvents = await observeSameDocumentNativePort(firstChild.page, report, "first");
    const firstPage = attachPasteEditorPage(firstChild.page, {
      pluginRoot: packageCopy.pluginRoot, injectedHtml: firstDocument.html, endpoints, report: firstNetwork, failOneNewRecordPut: firstWriteFailure,
      beforeSuccessfulRecordContinue: document => permitExactHistoryChange(firstChild.page, String(document._id)),
    });
    pageForFailure = { id: firstPageId, controls: firstPage };
    firstChild.page.on("Runtime.exceptionThrown", event => report.pages.push({ target: firstPageId, exception: event.exceptionDetails?.exception?.description || event.exceptionDetails?.text }));
    await firstPage.enableInterception();
    await firstPage.navigate();
    const initial = await firstPage.wait(`(()=>{const editor=document.querySelector('section.editor'),title=editor?.querySelector('input'),body=editor?.querySelector('textarea'),save=editor?.querySelector('button[type=submit]');return !!(editor&&title&&body&&save&&title.value===''&&body.value===''&&save.disabled)})()`, "empty original editor and disabled save");
    const initialLayout = await firstPage.evaluate(`(()=>{const e=document.querySelector('section.editor'),r=e.getBoundingClientRect(),t=e.querySelector('input').getBoundingClientRect(),b=e.querySelector('textarea').getBoundingClientRect(),s=e.querySelector('button[type=submit]').getBoundingClientRect();return {url:location.href,viewport:{width:innerWidth,height:innerHeight},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},editor:{x:r.x,y:r.y,width:r.width,height:r.height},title:{x:t.x,y:t.y,width:t.width,height:t.height},body:{x:b.x,y:b.y,width:b.width,height:b.height},save:{x:s.x,y:s.y,width:s.width,height:s.height,disabled:document.querySelector('button[type=submit]').disabled},text:document.body.innerText}})()`);
    const firstInitialShot = await firstPage.screenshot(resolve(outputRoot, `${runId}-initial.png`));
    report.outputs.push(firstInitialShot);
    report.initial = { emptySaveDisabled: initial, layout: initialLayout, screenshot: firstInitialShot };
    report.status = "editor-rendered";

    await firstPage.type("section.editor input", input.title);
    await firstPage.type("section.editor textarea", input.text);
    const filled = await firstPage.evaluate(`(()=>({title:document.querySelector('section.editor input').value,text:document.querySelector('section.editor textarea').value,saveDisabled:document.querySelector('section.editor button[type=submit]').disabled}))()`);
    expect(filled).toEqual({ title: input.title, text: input.text, saveDisabled: false });
    await firstPage.click("section.editor button[type=submit]");
    const injected = await waitUntil(async () => ({ attempt: firstNetwork.recordWrites.find(item => item.outcome === "injected_failure"), button: await firstPage.evaluate(`(()=>{const e=document.querySelector('section.editor');return e?{title:e.querySelector('input').value,text:e.querySelector('textarea').value,disabled:e.querySelector('button[type=submit]').disabled,saveText:e.querySelector('button[type=submit]').innerText}:null})()`) }), value => !!value.attempt && value.button?.disabled === false, "first targeted db.put rejection and retained editor inputs");
    const failedRecord = injected.attempt!;
    const noCommit = await worker.request<any>("getDoc", failedRecord.id);
    const failureDom = await firstPage.evaluate(`(()=>{const editor=document.querySelector('section.editor');const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.display!=='none'&&s.visibility!=='hidden'};const hostAlert=document.querySelector('[data-atools-data-operation-feedback]')?.shadowRoot?.querySelector('[role=alert]');const candidates=[...document.querySelectorAll('[role=alert],[aria-live],.status,.error,[data-error]'),...(hostAlert?[hostAlert]:[])].filter(visible).map(e=>e.innerText.trim()).filter(Boolean);return {hostFeedback:hostAlert&&visible(hostAlert)?hostAlert.querySelector('.message')?.textContent?.trim():null,title:editor?.querySelector('input')?.value,text:editor?.querySelector('textarea')?.value,saveDisabled:editor?.querySelector('button[type=submit]')?.disabled,saveText:editor?.querySelector('button[type=submit]')?.innerText,visibleMessages:candidates,bodyText:document.body.innerText}})()`);
    const failureShot = await firstPage.screenshot(resolve(outputRoot, `${runId}-save-failure.png`));
    report.outputs.push(failureShot);
    report.firstSaveFailure = { attemptedRecord: failedRecord, persistedRecordBeforeRetry: noCommit, dom: failureDom, screenshot: failureShot,
      visibleError: failureDom.visibleMessages.some((text: string) => /rejected|failure|failed|保存失败|保存错误|数据写入未完成/iu.test(text)) };
    expect(noCommit).toBeNull();
    expect(failureDom.title).toBe(input.title);
    expect(failureDom.text).toBe(input.text);
    expect(failureDom.saveDisabled).toBe(false);
    expect(failureDom.hostFeedback).toBe("ATools：数据写入未完成，请在插件中重试。");
    expect(firstNetwork.recordWrites.filter(item => item.outcome === "injected_failure")).toHaveLength(1);
    expect(firstWriteFailure.pending).toBe(false);

    await firstPage.click("section.editor button[type=submit]");
    const savedWrite = await waitUntil(async () => firstNetwork.recordWrites.find(item => item.outcome === "continued"), value => !!value, "explicit successful retry db.put");
    expect(savedWrite).toMatchObject({ title: input.title, text: input.text, outcome: "continued" });
    report.firstRetryWrite = { id: savedWrite!.id, itemId: savedWrite!.itemId, outcome: savedWrite!.outcome,
      sameDocumentNotificationReceiptsObservedSoFar: firstNativeEvents.length, crossWindowDelivery: "not tested" };
    await firstPage.settleRequests();
    await waitUntil(async () => destroyedTargets.includes(firstPageId), value => value, "original editor's actual document close", 10_000);
    report.firstDocumentClose = { targetId: firstPageId, destroyed: true,
      mechanism: "original Vue App called window.close(); observed Target.targetDestroyed; not a native OS window claim",
      sameDocumentNotificationReceiptsObservedAtClose: firstNativeEvents.length, crossWindowDelivery: "not tested" };
    const persisted = await worker.request<any>("getDoc", savedWrite!.id);
    expect(persisted).toMatchObject({
      _id: savedWrite!.id, type: "pasteboard-pro-record",
      record: { origin: { host: "sync" }, item: { id: savedWrite!.itemId, kind: "text", title: input.title, payload: { text: input.text } } },
    });
    report.retryPersisted = { confirmed: true, recordId: persisted._id, itemId: persisted.record.item.id,
      title: persisted.record.item.title, text: persisted.record.item.payload.text,
      sameDocumentNotificationReceiptsObserved: firstNativeEvents.length, crossWindowDelivery: "not tested" };
    report.firstSave = { failedRecordAbsent: noCommit === null, successfulRecordId: savedWrite!.id,
      durableRetryConfirmed: true, sqliteReopenVerified: false, dataTraceWritesForNewRecord: null,
      sameDocumentNotificationReceiptsObserved: firstNativeEvents.length, crossWindowDelivery: "not tested" };
    const firstStats = await worker.request<any>("stats");
    const newRecordWrites = firstStats.dataTrace.filter((entry: any) => entry.method === "db.put" && entry.id === savedWrite!.id);
    expect(newRecordWrites).toHaveLength(1);
    report.firstSave.dataTraceWritesForNewRecord = newRecordWrites.length;
    expect(firstNetwork.recordWrites).toEqual([
      expect.objectContaining({ outcome: "injected_failure", title: input.title, text: input.text }),
      expect.objectContaining({ outcome: "continued", title: input.title, text: input.text }),
    ]);
    if (firstNativeEvents.length > 0) {
      expect(firstNativeEvents).toEqual([{
        accepted: true, method: "sendToParent", hostedDocumentNonceValid: true,
        args: { channel: "pasteboard-pro:history-changed", args: [[savedWrite!.id]], windowType: "browserWindow", browserWindowId },
      }]);
    }
    report.status = "first-document-saved";
    await closePasteCdp(firstChild.page).catch(() => {});
    openPages.splice(openPages.findIndex(item => item.targetId === firstPageId), 1);

    await runtime.closeStrict();
    stopped.firstRuntime = true;
    report.firstNodeRuntimeStop = firstPrepared.nodeStopResult();
    const stoppedStats = await worker.request<any>("stats");
    expect(stoppedStats.nodeRuntimeMs).toBeGreaterThan(0);
    expect(stoppedStats.nodePid).toBeGreaterThan(0);
    let nodePidStillRunning = true;
    try { process.kill(stoppedStats.nodePid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") nodePidStillRunning = false; else throw error; }
    expect(nodePidStillRunning).toBe(false);
    const firstCleanup = await worker.close();
    stopped.firstWorker = true;
    report.firstWorkerCleanup = firstCleanup;
    expect((firstCleanup.result as any).databaseClosed).toBe(true);
    report.firstNodeSessionClose = { nodePid: stoppedStats.nodePid, nodeRuntimeMs: stoppedStats.nodeRuntimeMs, childExit: (firstCleanup.result as any).childExit, databaseClosed: true };

    const databasePath = resolve(scratchRoot, "pasteboard-pro.sqlite");
    const reseed = await clearStartupSeedsInOwnedWorker(databasePath, savedWrite!.id);
    expect(reseed.workerExitCode).toBe(0);
    report.sqliteBetweenSessions = { databasePath: "<fixture temp>/pasteboard-pro.sqlite", removedFixedSeedRows: reseed.removed,
      businessRecordPreservedByteForByte: reseed.preserved._id === savedWrite!.id, helperWorkerExitCode: reseed.workerExitCode };
    attempted.secondWorker = true;
    secondWorker = await createPasteStartupWorker({
      root: process.cwd(), scratchRoot, pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath,
      pluginDataRoot: pluginDataRealRoot, fixtureEnv: isolation.env, scenario: "text",
    });
    expect(secondWorker.initialization.nodeVersion).toBe("22.23.3");
    report.secondNode = { nodePid: secondWorker.initialization.pid, nodeVersion: secondWorker.initialization.nodeVersion, workerThreadId: secondWorker.worker.threadId };
    const secondOwnerId = randomUUID();
    attempted.secondRuntime = true;
    secondPrepared = await preparePasteRuntime(secondWorker, packageCopy, secondOwnerId);
    secondRuntime = secondPrepared.runtime;
    expect(secondPrepared.sessionId).not.toBe(firstPrepared.sessionId);
    const secondBrowserWindowId = `fixture-paste-editor-${randomUUID()}`;
    const secondDoc = createPasteStartupDocument({
      pluginRoot: packageCopy.pluginRoot, indexHtml: packageCopy.indexHtml, preloadScript: secondPrepared.preloadScript,
      endpoints: secondWorker.endpoints, pluginDataPath: pluginDataRealRoot, windowType: "browserWindow",
      browserWindowId: secondBrowserWindowId, webContentsId: 1502,
      beforeBridgeScript: pasteNativeNotificationPortScript(secondBrowserWindowId),
    });
    report.secondDocument = { instanceId: secondDoc.instanceId, ownerId: secondOwnerId, sessionId: secondPrepared.sessionId };
    const secondNetwork = emptyNetworkReport();
    report.secondNetwork = secondNetwork;
    const secondChild = await browser.openChild();
    const secondPageId = secondChild.target.targetId;
    openPages.push({ targetId: secondPageId, page: secondChild.page });
    const secondNativeEvents = await observeSameDocumentNativePort(secondChild.page, report, "second");
    const secondPage = attachPasteEditorPage(secondChild.page, {
      pluginRoot: packageCopy.pluginRoot, injectedHtml: secondDoc.html, endpoints: secondWorker.endpoints,
      report: secondNetwork, failOneNewRecordPut: { pending: false },
    });
    pageForFailure = { id: secondPageId, controls: secondPage };
    await secondPage.enableInterception();
    await secondPage.navigate();
    const roundTrip = await secondPage.evaluate(`window.pasteboardPro.getHistoryItem(${JSON.stringify(savedWrite!.itemId)})`, true);
    expect(roundTrip).toMatchObject({ id: savedWrite!.itemId, kind: "text", title: input.title, payload: { text: input.text } });
    report.firstSave.sqliteReopenVerified = true;
    report.secondDocument.readback = { via: "original window.pasteboardPro.getHistoryItem", itemId: roundTrip.id, title: roundTrip.title, body: roundTrip.payload.text };
    await secondPage.settleRequests();
    expect(secondNativeEvents).toEqual([]);
    expect(secondNetwork.denied).toEqual([]);
    await browser.browser.send("Target.closeTarget", { targetId: secondPageId }, { timeoutMs: 5000 });
    await waitUntil(async () => destroyedTargets.includes(secondPageId), value => value, "fresh editor document cleanup", 5000);
    await closePasteCdp(secondChild.page).catch(() => {});
    openPages.splice(openPages.findIndex(item => item.targetId === secondPageId), 1);
    await secondRuntime.closeStrict();
    stopped.secondRuntime = true;
    report.secondNodeRuntimeStop = secondPrepared.nodeStopResult();
    const secondCleanup = await secondWorker.close();
    stopped.secondWorker = true;
    report.secondWorkerCleanup = secondCleanup;
    expect((secondCleanup.result as any).databaseClosed).toBe(true);
    report.secondNodeSessionClose = { childExit: (secondCleanup.result as any).childExit, databaseClosed: true };

    report.firstNetwork = firstNetwork;
    report.secondNetwork = secondNetwork;
    report.targetEvents = targetEvents;
    report.destroyedTargets = destroyedTargets;
    const createdPages = new Map(targetEvents.filter(event => event.eventKind === "created" && event.type === "page").map(event => [event.targetId, event]));
    const ownedPopups = [...createdPages.values()].filter(event => event.openerId === browser!.harnessTargetId);
    expect(ownedPopups.map(event => event.targetId)).toEqual([firstPageId, secondPageId]);
    const knownStartupTargets = new Set([browser!.harnessTargetId, ...browser!.baselinePageTargetIds]);
    const expectedEditorTargets = new Set([firstPageId, secondPageId]);
    // Popup acceptance covers page targets only; non-page Chrome targets stay in raw diagnostics and remain unverified.
    report.browserInternalTargetScope = "Non-page TargetCreated events are retained in targetEvents; browser-internal worker/background target behavior is not verified by popup acceptance";
    const unexpectedCreatedPages = targetEvents.filter(event => event.eventKind === "created" && event.type === "page")
      .filter(event => !knownStartupTargets.has(event.targetId) && !expectedEditorTargets.has(event.targetId));
    expect(unexpectedCreatedPages).toEqual([]);
    expect(firstNetwork.denied).toEqual([]);
    expect(firstNetwork.failures).toEqual([]);
    expect(firstNetwork.editorDocuments).toBe(1);
    expect(secondNetwork.editorDocuments).toBe(1);
    expect(firstNetwork.pinsServed.map(pin => pin.path).sort()).toEqual(["assets/index-4mPfCjok.js", "assets/index-Cu7SjoI2.css", "logo.png"]);
    expect(firstNetwork.dialogs).toEqual([]);
    expect(firstPageFailureVisible(report.firstSaveFailure.visibleError)).toBe(true);
    expect(firstNetwork.recordWrites.map(attempt => attempt.outcome)).toEqual(["injected_failure", "continued"]);
    expect(browser.lifecycle.processState).toBe("running");
    report.status = "passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error = describeError(error);
    resourceCleanupIncomplete = /cleanup could not be confirmed/iu.test(error instanceof Error ? error.message : String(error));
    const uncertainCleanup = (error as any)?.atoolsCleanupUnconfirmed;
    if (uncertainCleanup) {
      resourceCleanupIncomplete = true;
      report.cleanup.unconfirmedResource = uncertainCleanup;
      report.cleanup.errors.push(`${uncertainCleanup.resource}: cleanup could not be confirmed`);
    } else if (resourceCleanupIncomplete && /Task14 manager rejected readiness/iu.test(error instanceof Error ? error.message : String(error))) {
      report.cleanup.uncertainOwnedWorkerStartup = "Task14 manager rejected readiness and explicitly reported unconfirmed cooperative cleanup";
    }
    const chromeLifecycle = (error as any)?.atoolsChromeLifecycle;
    if (chromeLifecycle) {
      report.browserLifecycleFailure = chromeLifecycle;
      if (chromeLifecycle.processState === "exit_unconfirmed") {
        resourceCleanupIncomplete = true;
        report.cleanup.errors.push(String(chromeLifecycle.cleanupFailure ?? "Owned Chrome process exit could not be confirmed"));
      }
    }
    const failurePageIsOpen = pageForFailure && openPages.some(page => page.targetId === pageForFailure!.id)
      && !destroyedTargets.includes(pageForFailure.id);
    if (pageForFailure && outputDirectoryCreated && failurePageIsOpen) {
      try {
        report.failurePage = await pageForFailure.controls.evaluate(`(()=>({url:location.href,readyState:document.readyState,title:document.title,bodyText:document.body?.innerText||'',editorCount:document.querySelectorAll('section.editor').length}))()`);
        const screenshot = await pageForFailure.controls.screenshot(resolve(outputRoot, `${runId}-failure-page.png`));
        report.outputs.push(screenshot);
        report.failurePage.screenshot = screenshot;
      } catch (captureError) { report.failurePageCaptureError = String(captureError); }
    } else if (pageForFailure && outputDirectoryCreated) {
      report.failurePageCaptureSkipped = "document_already_closed";
    }
  } finally {
    for (const { targetId, page } of openPages.splice(0)) {
      try { await browser?.browser.send("Target.closeTarget", { targetId }, { timeoutMs: 3000 }); } catch {}
      try { await closePasteCdp(page); } catch {}
    }
    const cleanupSteps = [
      { label: "first runtime", attempted: attempted.firstRuntime, exists: !!runtime, stopped: stopped.firstRuntime, close: async () => { if (runtime) await runtime.closeStrict(); report.firstNodeRuntimeStop = firstPrepared?.nodeStopResult(); } },
      { label: "first Worker", attempted: attempted.firstWorker, exists: !!worker, stopped: stopped.firstWorker, close: async () => { if (worker) report.firstWorkerCleanup = await worker.close(); } },
      { label: "second runtime", attempted: attempted.secondRuntime, exists: !!secondRuntime, stopped: stopped.secondRuntime, close: async () => { if (secondRuntime) await secondRuntime.closeStrict(); report.secondNodeRuntimeStop = secondPrepared?.nodeStopResult(); } },
      { label: "second Worker", attempted: attempted.secondWorker, exists: !!secondWorker, stopped: stopped.secondWorker, close: async () => { if (secondWorker) report.secondWorkerCleanup = await secondWorker.close(); } },
      { label: "Chrome", attempted: attempted.chrome, exists: !!browser, close: async () => { if (browser) report.browser = { ...(report.browser ?? {}), ...await browser.close() }; } },
    ];
    for (const step of cleanupSteps) {
      if (!step.attempted) { report.cleanup.resources.push({ label: step.label, state: "not_started" }); continue; }
      if ("stopped" in step && step.stopped) { report.cleanup.resources.push({ label: step.label, state: "stopped" }); continue; }
      if (!step.exists) {
        const state = resourceCleanupIncomplete ? "cleanup_unconfirmed" : "start_failed_without_returned_handle";
        report.cleanup.resources.push({ label: step.label, state });
        if (state === "cleanup_unconfirmed") report.cleanup.errors.push(`${step.label}: start attempted; no owned handle returned and cleanup is unconfirmed`);
        continue;
      }
      try { await step.close(); report.cleanup.resources.push({ label: step.label, state: "stopped" }); }
      catch (error) { resourceCleanupIncomplete = true; report.cleanup.errors.push(`${step.label}: ${String(error)}`); report.cleanup.resources.push({ label: step.label, state: "cleanup_unconfirmed" }); }
    }
    if (packageCopy) {
      await chmod(resolve(packageCopy.pluginRoot, "assets"), 0o700).catch(() => {});
      await chmod(resolve(packageCopy.pluginRoot, "chunks"), 0o700).catch(() => {});
      await chmod(packageCopy.pluginRoot, 0o700).catch(() => {});
    }
    if (!resourceCleanupIncomplete) {
      if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(error => { resourceCleanupIncomplete = true; report.cleanup.errors.push(`scratch removal: ${String(error)}`); });
      if (isolation) await isolation.cleanup().catch(error => { resourceCleanupIncomplete = true; report.cleanup.errors.push(`fixture environment removal: ${String(error)}`); });
    }
    if (packageCopy) {
      try { await sourceDigestsUnchanged(packageCopy.sourceDigests); report.originalPackageUnchanged = true; }
      catch (error) { report.originalPackageUnchanged = false; report.cleanup.errors.push(`source pin recheck: ${String(error)}`); failure ||= error; }
    }
    report.cleanup.allOwnedResourcesClean = !resourceCleanupIncomplete;
    if (resourceCleanupIncomplete && isolation) report.cleanup.preservedFixtureRoot = isolation.root;
    if (outputDirectoryCreated) {
      report.finishedAt = new Date().toISOString();
      report.reportPath = resolve(outputRoot, `${runId}-report.json`);
      await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
  }
  if (failure) throw failure;
  expect(report.status).toBe("passed");
}, 120_000);

function firstPageFailureVisible(value: unknown) { return value === true; }
