// @vitest-environment node
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import { createPasteStartupWorker, createReadOnlyBuiltPackage, sourceDigestsUnchanged } from "../fixtures/paste-startup/frame-fixture";
import { createPasteStartupDocument } from "../fixtures/paste-startup/document-fixture";
import { copyPinnedPasteBrowserAssets } from "../fixtures/paste-browser/original-assets";
import { closePasteCdp, launchPasteBrowserSession } from "../fixtures/paste-browser/chrome-session";
import { attachPasteShelfPage, emptyPasteShelfNetworkReport, pastePrimaryUrl, pasteShelfUrl } from "../fixtures/paste-browser/shelf-page-fixture";
import { createPasteRuntimeSession, handoffPasteSeedToSecondSession, verifySharedPasteSeed } from "../fixtures/paste-browser/runtime-session";
import { runPasteShelfScenario } from "./harrisPasteOriginalShelfScenario";

const pluginSource = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const sourceRoot = resolve(pluginSource, "pasteboard-pro", "dist", "ztools");
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const optIn = process.env.ATOOLS_PASTE_SHELF_BROWSER_ACCEPTANCE === "1"
  && existsSync(resolve(sourceRoot, "preload.js")) && existsSync(productNode);
const outputRoot = resolve(process.cwd(), "output/playwright/paste-original-shelf");
const whatsNewKey = "pasteboard_pro_whats_new_release_1_3_0";

type FixtureWorker = Awaited<ReturnType<typeof createPasteStartupWorker>>;
type PackageCopy = Awaited<ReturnType<typeof createReadOnlyBuiltPackage>>;
type RuntimeSession = ReturnType<typeof createPasteRuntimeSession>;
type TargetEvent = { targetId: string; type: string; url: string; openerId?: string; eventKind?: string };
type RuntimeExceptionEvent = { exceptionDetails?: { exception?: { description?: string }; text?: string } };

function existingUserWhatsNewPreferenceScript() {
  return `<script data-atools-fixture-existing-user-preference>localStorage.setItem(${JSON.stringify(whatsNewKey)},"1.3.0")</script>`;
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const result: Record<string, unknown> = { name: value.name, message: value.message, stack: value.stack };
  if (depth < 4 && value.cause !== undefined) result.cause = describeError(value.cause, depth + 1);
  if (depth < 4 && value instanceof AggregateError) result.errors = [...value.errors].map(item => describeError(item, depth + 1));
  return result;
}

function summarizeNodeStats(stats: any) {
  const fixedIds = new Set(["pasteboard-pro:record:sha256:text-old:v1", "pasteboard-pro:record:sha256:files-item:v1", "pasteboard-pro:paste-stack"]);
  return {
    requests: stats.requests,
    methods: stats.methods,
    dataTrace: (stats.dataTrace ?? []).map((entry: any) => ({
      method: entry.method,
      argumentCount: entry.argumentCount,
      id: fixedIds.has(entry.id) ? entry.id : entry.id == null ? null : "<non-fixture-id>",
    })),
    nodeModules: stats.nodeModules,
    allowedMonitorSpawns: stats.allowedMonitorSpawns,
    deniedOsCommands: stats.deniedOsCommands,
    controlledHistoryReads: stats.historyReads,
    controlledTextWriteCount: stats.clipboardWrites?.length ?? 0,
    controlledTypedWriteCount: stats.typedClipboardWrites?.length ?? 0,
  };
}

async function waitUntil<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (ready(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}

it.skipIf(!optIn)("runs Harris Paste 1.3.1 original Shelf search, selection and preview through the original history API", async () => {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report: Record<string, any> = {
    runId, status: "setup", startedAt: new Date().toISOString(), sourceRoot,
    scope: "Opt-in private headless Chrome/CDP; fixed Harris Paste 1.3.1 browserWindow Shelf route, original main and Shelf role documents, two independent product Node 22.23.3 sessions over one temporary canonical SQLite plugin-data file.",
    boundaries: {
      shelfEntry: "Direct original ?shelf=1 URL as a browserWindow page stand-in; not proof of the full main-app entry or native window creation.",
      historyRelay: "Controlled exact history-query/result parent adapter calls the primary document's unchanged public searchHistoryPage; not native IPC, ipcRenderer handler, ShelfWindowManager, or native window creation.",
      nodeIsolation: "The two product Node sessions exist to preserve per-renderer callback routing in this fixture; this is not an assertion about production process topology or performance.",
      storageSeed: `Temporary browser localStorage is initialized to the original already-seen release preference ${whatsNewKey}=1.3.0; original initialization/focus logic remains enabled.`,
      clipboard: "The fixed route issues no clipboard output; only controlled fixture ports are available. System clipboard contents and OS-level access are not inspected by this test.",
      network: "Each original plugin page uses its own Node/data endpoints. Fetch allowlists apply to the two page targets; this does not claim browser-wide network isolation.",
    },
    browser: {}, pages: [], outputs: [], cleanup: { errors: [], resources: [] },
  };
  let isolation: Awaited<ReturnType<typeof createFixtureEnvironment>> | undefined;
  let packageCopy: PackageCopy | undefined;
  let primaryWorker: FixtureWorker | undefined;
  let shelfWorker: FixtureWorker | undefined;
  let primaryRuntime: RuntimeSession | undefined;
  let shelfRuntime: RuntimeSession | undefined;
  let browser: Awaited<ReturnType<typeof launchPasteBrowserSession>> | undefined;
  let primaryControls: ReturnType<typeof attachPasteShelfPage> | undefined;
  let shelfControls: ReturnType<typeof attachPasteShelfPage> | undefined;
  let shelfPage: any;
  let shelfTargetId = "";
  let pluginDataRealRoot = "";
  let scratchRoot = "";
  let outputReady = false;
  let cleanupIncomplete = false;
  let failure: unknown;
  let primaryWorkerStarted = false;
  let shelfWorkerStarted = false;
  let primaryRuntimeAttempted = false;
  let shelfRuntimeAttempted = false;
  let chromeStarted = false;
  let primaryWorkerStopped = false;
  let shelfWorkerStopped = false;
  let primaryRuntimeStopped = false;
  let shelfRuntimeStopped = false;
  let chromeStopped = false;
  const targetEvents: TargetEvent[] = [];
  const destroyedTargets: string[] = [];
  try {
    expect(resolve(process.execPath)).toBe(productNode);
    await mkdir(outputRoot, { recursive: true });
    outputReady = true;
    isolation = await createFixtureEnvironment();
    scratchRoot = resolve(isolation.root, "work");
    pluginDataRealRoot = resolve(scratchRoot, "plugin-data");
    await mkdir(pluginDataRealRoot, { recursive: true, mode: 0o700 });
    pluginDataRealRoot = await realpath(pluginDataRealRoot);
    packageCopy = await createReadOnlyBuiltPackage(pluginSource, scratchRoot);
    report.originalPackageHashes = packageCopy.builtHashes;
    report.browserAssetHashes = await copyPinnedPasteBrowserAssets(sourceRoot, packageCopy.pluginRoot, packageCopy.sourceDigests);
    const manifest = JSON.parse(await readFile(resolve(packageCopy.pluginRoot, "plugin.json"), "utf8"));
    report.originalPlugin = { name: manifest.name, author: manifest.author, version: manifest.version, preload: manifest.preload,
      totalPinnedArtifacts: Object.keys(packageCopy.builtHashes).length + Object.keys(report.browserAssetHashes).length };
    expect(report.originalPlugin).toMatchObject({ author: "harris", version: "1.3.1", preload: "preload.js", totalPinnedArtifacts: 10 });
    report.fixtureEnvironment = isolation.evidence;

    primaryWorkerStarted = true;
    primaryWorker = await createPasteStartupWorker({
      root: process.cwd(), scratchRoot, pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath,
      pluginDataRoot: pluginDataRealRoot, fixtureEnv: isolation.env, scenario: "text",
    });
    expect(primaryWorker.initialization.nodeVersion).toBe("22.23.3");
    primaryRuntime = createPasteRuntimeSession(primaryWorker, packageCopy, randomUUID());
    primaryRuntimeAttempted = true;
    const primaryPreloadScript = await primaryRuntime.prepare();

    const databasePath = resolve(scratchRoot, "pasteboard-pro.sqlite");
    const seedHandoff = await handoffPasteSeedToSecondSession(primaryWorker, databasePath);
    shelfWorkerStarted = true;
    shelfWorker = await createPasteStartupWorker({
      root: process.cwd(), scratchRoot, pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath,
      pluginDataRoot: pluginDataRealRoot, fixtureEnv: isolation.env, scenario: "text",
    });
    expect(shelfWorker.initialization.nodeVersion).toBe("22.23.3");
    shelfRuntime = createPasteRuntimeSession(shelfWorker, packageCopy, randomUUID());
    shelfRuntimeAttempted = true;
    const shelfPreloadScript = await shelfRuntime.prepare();

    const sharedPluginData = await verifySharedPasteSeed(primaryWorker, shelfWorker, databasePath);
    expect(sharedPluginData.databasePath).toBe(seedHandoff.databasePath);
    const endpointNames = ["node", "data", "history", "write", "contentWrite", "secret"] as const;
    expect(endpointNames.every(name => primaryWorker!.endpoints[name] !== shelfWorker!.endpoints[name])).toBe(true);
    expect(primaryWorker.initialization.pid === shelfWorker.initialization.pid).toBe(false);
    expect(primaryWorker.worker.threadId === shelfWorker.worker.threadId).toBe(false);
    expect(primaryRuntime.sessionId === shelfRuntime.sessionId).toBe(false);
    expect(primaryRuntime.ownerInstanceId === shelfRuntime.ownerInstanceId).toBe(false);
    report.nodeSessions = {
      primary: primaryRuntime.snapshot(),
      shelf: shelfRuntime.snapshot(),
      independentProcessIds: true,
      independentWorkerThreads: true,
      independentSessionIds: true,
      independentEndpointUrls: true,
    };
    report.sharedPluginData = {
      databasePath: sharedPluginData.databasePath,
      sameResolvedDatabasePath: true,
      seedHandoff: { removedFixedSeedIds: seedHandoff.removedIds, purpose: "second Worker seeds the same canonical SQLite file; fixture setup only" },
      verifiedRows: { primary: sharedPluginData.primaryRows, shelf: sharedPluginData.shelfRows },
      allWorkersReadyBeforePageNavigation: true,
    };

    chromeStarted = true;
    browser = await launchPasteBrowserSession({ tempRoot: scratchRoot, env: isolation.env, targetEvents, destroyedTargets });
    const browserVersion = await browser.browser.send("Browser.getVersion", {}, { timeoutMs: 5000 });
    report.browser = { ...browser.lifecycle, version: browserVersion, privateProfile: true };

    const primaryDocument = createPasteStartupDocument({
      pluginRoot: packageCopy.pluginRoot, indexHtml: packageCopy.indexHtml, preloadScript: primaryPreloadScript, endpoints: primaryWorker.endpoints,
      pluginDataPath: pluginDataRealRoot, windowType: "main", webContentsId: 1701,
      beforeBridgeScript: existingUserWhatsNewPreferenceScript(),
    });
    const browserWindowId = `fixture-paste-shelf-${randomUUID()}`;
    const shelfDocument = createPasteStartupDocument({
      pluginRoot: packageCopy.pluginRoot, indexHtml: packageCopy.indexHtml, preloadScript: shelfPreloadScript, endpoints: shelfWorker.endpoints,
      pluginDataPath: pluginDataRealRoot, windowType: "browserWindow", browserWindowId, webContentsId: 1702,
      beforeBridgeScript: existingUserWhatsNewPreferenceScript(),
    });
    const network = emptyPasteShelfNetworkReport();
    report.network = network;
    report.documents = {
      primary: { targetId: browser.harnessTargetId, windowType: "main", instanceId: primaryDocument.instanceId, webContentsId: 1701, url: pastePrimaryUrl() },
      shelf: { windowType: "browserWindow", browserWindowId, instanceId: shelfDocument.instanceId, webContentsId: 1702, url: pasteShelfUrl() },
    };
    const pageErrors: Array<{ role: string; exception: string }> = [];
    primaryControls = attachPasteShelfPage(browser.harness, {
      pluginRoot: packageCopy.pluginRoot, injectedHtml: primaryDocument.html, endpoints: primaryWorker.endpoints, report: network, role: "primary",
    });
    await primaryControls.enableInterception();
    const shelfChild = await browser.openChild();
    shelfTargetId = shelfChild.target.targetId;
    shelfPage = shelfChild.page;
    shelfPage.on("Runtime.exceptionThrown", (event: RuntimeExceptionEvent) => pageErrors.push({ role: "shelf", exception: event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "unknown exception" }));
    shelfControls = attachPasteShelfPage(shelfPage, {
      pluginRoot: packageCopy.pluginRoot, injectedHtml: shelfDocument.html, endpoints: shelfWorker.endpoints, report: network,
      role: "shelf", primaryPage: browser.harness,
    });
    await shelfControls.enableInterception();
    browser.harness.on("Runtime.exceptionThrown", (event: RuntimeExceptionEvent) => pageErrors.push({ role: "primary", exception: event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "unknown exception" }));

    // Open the controlled child while the primary target is still about:blank. Its
    // original document applies a sandbox CSP without allow-popups.
    await primaryControls.navigate();
    await primaryControls.waitFor("typeof window.pasteboardPro?.searchHistoryPage==='function'", "primary original history API ready");
    await shelfControls.navigate();
    await shelfControls.waitFor("document.querySelector('.shelf')&&document.querySelector('[data-pb-search]')", "original Shelf document ready");
    report.targetEvents = targetEvents;
    report.pageErrors = pageErrors;
    report.status = "original-shelf-rendered";

    await runPasteShelfScenario(shelfControls, outputRoot, runId, report);
    await Promise.all([primaryControls.settleRequests(), shelfControls.settleRequests()]);
    const primaryStats = await primaryWorker.request<any>("stats");
    const shelfStats = await shelfWorker.request<any>("stats");
    report.nodeStats = {
      primary: summarizeNodeStats(primaryStats),
      shelf: summarizeNodeStats(shelfStats),
    };
    expect(primaryStats.methods["data.db.allDocs"] ?? 0).toBeGreaterThan(0);
    for (const stats of [primaryStats, shelfStats]) {
      expect(stats.typedClipboardWrites).toEqual([]);
      expect(stats.clipboardWrites).toEqual([]);
      expect(stats.deniedOsCommands).toBe(0);
    }
    report.clipboardEvidence = {
      systemClipboard: "not accessed or measured by this controlled browser fixture",
      controlledHistoryReadCalls: (primaryStats.methods["host.history_read"] ?? 0) + (shelfStats.methods["host.history_read"] ?? 0),
      controlledTextWrites: primaryStats.clipboardWrites.length + shelfStats.clipboardWrites.length,
      controlledTypedWrites: primaryStats.typedClipboardWrites.length + shelfStats.typedClipboardWrites.length,
    };
    expect(pageErrors).toEqual([]);
    expect(network.denied ?? []).toEqual([]);
    expect(network.failures ?? []).toEqual([]);
    expect(network.historyRelay.parentIpcTested).toBe(false);
    expect(network.historyRelay.primaryDataSource).toBe("original-primary-preload-searchHistoryPage");
    expect(network.historyRelay.primaryDataMechanism).toBe("PluginData db.allDocs through original HistorySearchService");
    expect(network.historyRelay.rejectedNativeCalls).toEqual([]);
    const returnedQueries = network.historyRelay.requests.filter((entry: any) => entry.outcome === "returned");
    expect(network.historyRelay.hopCount).toBe(network.historyRelay.requests.length);
    expect(returnedQueries.length).toBeGreaterThanOrEqual(4);
    expect(returnedQueries).toContainEqual(expect.objectContaining({ queryLength: 7, itemCount: 1 }));
    expect(returnedQueries).toContainEqual(expect.objectContaining({ queryLength: report.noMatch.query.length, itemCount: 0 }));
    expect(returnedQueries).toContainEqual(expect.objectContaining({ queryLength: 0, itemCount: 2 }));
    expect(network.documents.map((document: any) => document.role).sort()).toEqual(["primary", "shelf"]);
    expect(network.pinsServed.map((pin: any) => pin.role).sort()).toEqual(["primary", "primary", "primary", "shelf", "shelf", "shelf"]);
    expect(network.pluginDataCalls).toContainEqual({ role: "primary", method: "db.allDocs" });
    const primaryMirrorReads = network.allowed.filter((entry: any) => entry.role === "primary" && entry.route === "history" && entry.method === "POST");
    const shelfHistoryReads = network.allowed.filter((entry: any) => entry.role === "shelf" && entry.route === "history" && entry.method === "POST");
    expect(shelfHistoryReads).toEqual([]);
    expect(primaryStats.methods["host.history_read"] ?? 0).toBe(primaryMirrorReads.length);
    expect(shelfStats.methods["host.history_read"] ?? 0).toBe(0);
    expect(network.historyMirrorCalls).toEqual(primaryMirrorReads.map(() => ({
      role: "primary", method: "POST", response: "controlled-empty-fixture",
    })));
    expect(network.allowed.filter((entry: any) => ["write", "contentWrite"].includes(entry.route))).toEqual([]);
    report.pageErrors = pageErrors;
    report.historyRouteEvidence = {
      relayMode: network.historyRelay.mode,
      parentIpcTested: network.historyRelay.parentIpcTested,
      calls: returnedQueries,
      nativeRejections: network.historyRelay.rejectedNativeCalls,
      source: network.historyRelay.primaryDataSource,
      backingMechanism: network.historyRelay.primaryDataMechanism,
      primaryDataCalls: network.pluginDataCalls.filter(call => call.role === "primary"),
      primaryMirrorReads: network.historyMirrorCalls,
      controlledEmptyMirrorIsNotQueryResult: true,
    };
    report.originalPreloadPorts = {
      primary: { safeStorageFixtureCalls: primaryRuntime.safeStorageFixtureCalls },
      shelf: { safeStorageFixtureCalls: shelfRuntime.safeStorageFixtureCalls },
    };
    report.primaryReadiness = { exposedUnchangedMethod: "window.pasteboardPro.searchHistoryPage", source: "original main-role preload" };
    report.status = "scenario-passed";
  } catch (error) {
    failure = error;
    report.status = "failed";
    report.error = describeError(error);
    if ((error as any)?.atoolsCleanupUnconfirmed) cleanupIncomplete = true;
    report.failureNodeStats = {};
    for (const [role, currentWorker] of [["primary", primaryWorker], ["shelf", shelfWorker]] as const) {
      if (!currentWorker) continue;
      try {
        const stats = await currentWorker.request<any>("stats", undefined, 1500);
        report.failureNodeStats[role] = {
          nodePid: currentWorker.initialization.pid,
          nodeVersion: currentWorker.initialization.nodeVersion,
          ...summarizeNodeStats(stats),
        };
      } catch (statsError) { report.failureNodeStats[`${role}Error`] = String(statsError); }
    }
    if (shelfControls && outputReady && shelfTargetId && !destroyedTargets.includes(shelfTargetId)) {
      try {
        const preferenceKey = JSON.stringify(whatsNewKey);
        report.failurePage = await shelfControls.evaluate(`(()=>{
          const api=window.pasteboardPro;
          const port=window.__atoolsPasteShelfFixturePort;
          let preference=null;try{preference=localStorage.getItem(${preferenceKey})}catch(error){preference='ERR:'+String(error)}
          return {
            url:location.href,search:location.search,readyState:document.readyState,title:document.title,
            visibilityState:document.visibilityState,hasFocus:document.hasFocus(),parentIsSelf:window.parent===window,
            activeElement:{tag:document.activeElement?.tagName??null,id:document.activeElement?.id??null,
              className:document.activeElement?.className??null,role:document.activeElement?.getAttribute?.('role')??null},
            pluginApi:{present:typeof api,searchHistoryPage:typeof api?.searchHistoryPage,
              getPasteStack:typeof api?.getPasteStack,getPlatformCapabilities:typeof api?.getPlatformCapabilities},
            bridge:{utools:typeof window.utools,ztools:typeof window.ztools,
              utoolsSendToParent:typeof window.utools?.sendToParent,ztoolsSendToParent:typeof window.ztools?.sendToParent,
              getWindowType:typeof window.utools?.getWindowType,
              windowType:typeof window.utools?.getWindowType==='function'?window.utools.getWindowType():null,
              fixturePort:typeof port,fixturePortFields:port&&typeof port==='object'?Object.keys(port).sort():[],
              fixturePortState:(()=>{const s=port?.state,l=s?.latest;return s?{
                totalMessageCount:s.totalMessageCount,nativeCallCount:s.nativeCallCount,
                selfSourceCount:s.selfSourceCount,foreignSourceCount:s.foreignSourceCount,
                latest:l?{source:l.source,method:l.method,channel:l.channel,argCount:l.argCount}:null
              }:null})(),
              relayBinding:typeof window.__atoolsPasteShelfHistoryRelay},
            bridgeSources:{ztoolsSendToParent:typeof window.ztools?.sendToParent==='function'
                ?window.ztools.sendToParent.toString().slice(0,1200):null,
              utoolsSendToParent:typeof window.utools?.sendToParent==='function'
                ?window.utools.sendToParent.toString().slice(0,1200):null,
              searchHistoryPage:typeof api?.searchHistoryPage==='function'?api.searchHistoryPage.toString().slice(0,1200):null},
            whatsNewPreference:{key:${preferenceKey},value:preference},
            shelfMounted:Boolean(document.querySelector('.shelf')),
            searchInput:{present:Boolean(document.querySelector('[data-pb-search]')),
              value:document.querySelector('[data-pb-search]')?.value??null},
            timelinePresent:Boolean(document.querySelector('[aria-label="剪贴板时间线"]')),
            ids:[...document.querySelectorAll('[data-pb-item-id]')].map(x=>x.getAttribute('data-pb-item-id')),
            bodyText:(document.body?.innerText||'').slice(0,2000)
          }
        })()`);
        report.diagnosticReadOnlyQueryProbe = {
          label: "post-failure diagnostic only; not UI success evidence",
          query: "Invoice",
          result: await shelfControls.evaluate(`(()=>{
            if(typeof window.pasteboardPro?.searchHistoryPage!=='function')return Promise.resolve({state:'unavailable'});
            let timer;
            const request=Promise.resolve().then(()=>window.pasteboardPro.searchHistoryPage({query:'Invoice',limit:1})).then(
              page=>({state:'resolved',itemIds:Array.isArray(page?.items)?page.items.slice(0,20).map(item=>String(item?.id??'')):[],
                total:Number.isFinite(page?.total)?page.total:null}),
              ()=>({state:'rejected'}));
            return Promise.race([request,new Promise(resolve=>{timer=setTimeout(()=>resolve({state:'pending'}),500)})])
              .finally(()=>clearTimeout(timer));
          })()`, true).catch(()=>({state:"rejected"})),
        };
        report.outputs.push({ name: "failure-page", ...await shelfControls.screenshot(resolve(outputRoot, `${runId}-failure-page.png`)) });
      } catch (captureError) { report.failurePageCaptureError = String(captureError); }
    }
  } finally {
    for (const [role, controls] of [["shelf", shelfControls], ["primary", primaryControls]] as const) {
      if (!controls) continue;
      try { await controls.settleRequests(); } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(`${role} pending requests: ${String(error)}`); }
      try { await controls.dispose(); } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(`${role} controller: ${String(error)}`); }
    }
    if (browser && shelfTargetId) {
      try {
        await browser.browser.send("Target.closeTarget", { targetId: shelfTargetId }, { timeoutMs: 5000 });
        await waitUntil(async () => destroyedTargets.includes(shelfTargetId), Boolean, "Shelf browser target destruction", 5000);
        report.cleanup.resources.push({ label: "Shelf browser target", state: "destroyed", targetId: shelfTargetId });
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(`Shelf browser target: ${String(error)}`); }
      try {
        const result = await closePasteCdp(shelfPage);
        if (!result.closed) throw new Error("Shelf CDP socket close was not confirmed");
        report.cleanup.resources.push({ label: "Shelf CDP", ...result });
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(`Shelf CDP: ${String(error)}`); }
    }
    for (const [role, session, attempted] of [
      ["shelf", shelfRuntime, shelfRuntimeAttempted],
      ["primary", primaryRuntime, primaryRuntimeAttempted],
    ] as const) {
      if (!attempted) continue;
      if (!session) {
        cleanupIncomplete = true;
        report.cleanup.errors.push(`${role} Node runtime preparation was attempted without an owned runtime handle`);
        continue;
      }
      try {
        const closed = await session.closeStrict();
        report.runtimeOwnerCloses ??= {};
        report.runtimeOwnerCloses[role] = closed;
        report.cleanup.resources.push({ label: `${role} original preload Node owner`, state: "closed", ownerCloseCount: session.nodeOwnerCloses });
        if (role === "primary") primaryRuntimeStopped = true;
        else shelfRuntimeStopped = true;
      } catch (error) {
        cleanupIncomplete = true;
        report.cleanup.errors.push(`${role} original preload Node owner: ${String(error)}`);
        failure ||= error;
      }
    }
    if (!primaryRuntimeAttempted) primaryRuntimeStopped = true;
    if (!shelfRuntimeAttempted) shelfRuntimeStopped = true;

    for (const [role, currentWorker, started] of [
      ["shelf", shelfWorker, shelfWorkerStarted],
      ["primary", primaryWorker, primaryWorkerStarted],
    ] as const) {
      if (!started) {
        if (role === "primary") primaryWorkerStopped = true;
        else shelfWorkerStopped = true;
        continue;
      }
      if (!currentWorker) {
        cleanupIncomplete = true;
        report.cleanup.errors.push(`${role} Worker startup was attempted but no owned Worker handle was returned`);
        continue;
      }
      try {
        const cleanup = await currentWorker.close();
        report.workerCleanup ??= {};
        report.workerCleanup[role] = cleanup;
        expect((cleanup.result as any)?.databaseClosed).toBe(true);
        expect(cleanup.workerExit.code).toBe(0);
        const nodePid = currentWorker.initialization.pid;
        let nodeStillRunning = true;
        try { process.kill(nodePid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") nodeStillRunning = false; else throw error; }
        expect(nodeStillRunning).toBe(false);
        report.cleanup.resources.push({ label: `${role} product Node and SQLite Worker`, state: "exited", workerExit: cleanup.workerExit, databaseClosed: true });
        report.cleanup.nodePidsAbsentAfterShutdown ??= {};
        report.cleanup.nodePidsAbsentAfterShutdown[role] = { pid: nodePid, confirmed: true };
        if (role === "primary") primaryWorkerStopped = true;
        else shelfWorkerStopped = true;
      } catch (error) {
        cleanupIncomplete = true;
        report.cleanup.errors.push(`${role} product Node/SQLite Worker: ${String(error)}`);
        failure ||= error;
      }
    }
    if (browser) {
      try {
        report.browser = { ...(report.browser ?? {}), ...await browser.close() };
        chromeStopped = true;
        const state = report.browser as Record<string, any>;
        if (state.processState !== "exited" || state.profileState !== "removed") throw new Error(`Chrome cleanup unconfirmed: ${state.processState}/${state.profileState}`);
        report.cleanup.resources.push({ label: "Private Chrome and profile", state: "exited_and_removed", browserPid: state.browserPid });
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(`Private Chrome: ${String(error)}`); failure ||= error; }
    } else if (chromeStarted) {
      cleanupIncomplete = true;
      report.cleanup.errors.push("Chrome startup was attempted but no owned Chrome handle was returned");
    }
    if (packageCopy) {
      for (const relative of ["assets", "chunks", ""]) await chmod(resolve(packageCopy.pluginRoot, relative), 0o700).catch(() => {});
    }
    if (!cleanupIncomplete) {
      if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(error => { cleanupIncomplete = true; report.cleanup.errors.push(`scratch removal: ${String(error)}`); });
      if (isolation) await isolation.cleanup().catch(error => { cleanupIncomplete = true; report.cleanup.errors.push(`fixture environment removal: ${String(error)}`); });
    }
    if (packageCopy) {
      try { await sourceDigestsUnchanged(packageCopy.sourceDigests); report.originalPackageUnchanged = true; }
      catch (error) { report.originalPackageUnchanged = false; report.cleanup.errors.push(`source pin recheck: ${String(error)}`); failure ||= error; }
    }
    report.cleanup.allOwnedResourcesClean = !cleanupIncomplete;
    if (cleanupIncomplete && isolation) report.cleanup.preservedFixtureRoot = isolation.root;
    const runtimeStopped = primaryRuntimeStopped && shelfRuntimeStopped;
    const workerStopped = primaryWorkerStopped && shelfWorkerStopped;
    report.cleanup.runtimeStopped = runtimeStopped;
    report.cleanup.workerStopped = workerStopped;
    report.cleanup.primaryRuntimeStopped = primaryRuntimeStopped;
    report.cleanup.shelfRuntimeStopped = shelfRuntimeStopped;
    report.cleanup.primaryWorkerStopped = primaryWorkerStopped;
    report.cleanup.shelfWorkerStopped = shelfWorkerStopped;
    report.cleanup.chromeStopped = chromeStopped;
    if (cleanupIncomplete || report.cleanup.errors.length > 0) {
      failure ||= new Error("Shelf acceptance cleanup was not fully confirmed");
      report.status = "cleanup-failed";
    }
    report.targetEvents = targetEvents;
    report.destroyedTargets = destroyedTargets;
    if (outputReady) {
      report.finishedAt = new Date().toISOString();
      report.reportPath = resolve(outputRoot, `${runId}-report.json`);
      await writeFile(report.reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    }
  }
  if (failure) throw failure;
  expect(report.status).toBe("scenario-passed");
  expect(report.cleanup.allOwnedResourcesClean).toBe(true);
  expect(report.cleanup.errors).toEqual([]);
  expect(report.cleanup.runtimeStopped).toBe(true);
  expect(report.cleanup.workerStopped).toBe(true);
  expect(report.cleanup.chromeStopped).toBe(true);
}, 120_000);
