// @vitest-environment node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import { startOriginalPluginNodeSession } from "../fixtures/original-plugin-node/node-session.mjs";
import { copyReadOnlyFormatConverterPackage, assertFormatConverterSourceUnchanged, restoreOwnedCopyDirectoriesWritable } from "../fixtures/format-converter/original-package";
import { prepareFormatConverterRuntime, type FormatConverterRuntime } from "../fixtures/format-converter/runtime-fixture";
import { createFormatConverterDocument } from "../fixtures/format-converter/document-fixture";
import { openInputPickerThroughUi, waitForFormatConverterMount, selectTargetThroughUi, selectOutputDirectoryThroughUi,
  chooseInputsThroughUi, assertEmptyFileErrorThroughUi, startConversionThroughUi, assertPartialJobContains,
  retryFailedItemsThroughUi } from "../fixtures/format-converter/ui-actions";
import { attachLiveMarkdownPage, createLiveMarkdownNetworkReport, type LiveMarkdownNetworkReport } from "../fixtures/live-markdown/page-fixture";
import { closePasteCdp, launchPasteBrowserSession } from "../fixtures/paste-browser/chrome-session";

const pluginsRoot = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const sourceRoot = join(pluginsRoot, "format-converter", "dist");
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const origin = "https://format-converter.fixture.invalid";
const outputRoot = resolve(process.cwd(), "output/playwright/format-converter-original");
const optIn = process.env.ATOOLS_FORMAT_CONVERTER_BROWSER_ACCEPTANCE === "1"
  && existsSync(join(sourceRoot, "plugin.json")) && existsSync(productNode);
const quotedCsv = 'name,note\n"Ada, Inc.","line 1\nline 2 with ""quote"""';
const expectedQuotedJson = '[\n  {\n    "name": "Ada, Inc.",\n    "note": "line 1\\nline 2 with \\"quote\\""\n  }\n]';
const objectsJson = '[\n  {"name":"A","score":3},\n  {"name":"B","extra":true}\n]\n';
const expectedObjectsCsv = "name,score,extra\nA,3,\nB,,true";
const fixedBrokenJson = '[{"name":"Fixed","score":9}]';
const expectedBrokenCsv = "name,score\nFixed,9";
const expectedPlainJson = '[\n  {\n    "value": "A"\n  },\n  {\n    "value": "B"\n  }\n]';

type BrowserSession = Awaited<ReturnType<typeof launchPasteBrowserSession>>;
type NodeSession = Awaited<ReturnType<typeof startOriginalPluginNodeSession>>;
type TargetEvent = { targetId: string; type: string; url: string; openerId?: string; canAccessOpener?: boolean; eventKind?: string };
type BrowserPage = { targetId: string; page: any; controls: ReturnType<typeof attachLiveMarkdownPage> };

it.skipIf(!optIn)("runs the hash-pinned Harris Format Converter 0.1.0 UI through file errors, partial retry and exact conversions", async () => {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report: Record<string, any> = {
    runId, startedAt: new Date().toISOString(), status: "setup", sourceRoot,
    scope: "Opt-in standalone original-plugin UI fixture using hash-pinned Format Converter dist, production preload compiler/bridge, Node 22.23.3 and a private headless Chrome profile.",
    overallCompatibilityClaim: false,
    boundaries: {
      webView: "Headless Chrome DOM interaction is a Tauri WebView stand-in, not WKWebView acceptance",
      runtime: "Unmodified production createPluginRuntimePreload and createPluginBridgeDocument; one actual product Node session",
      files: "Only fixed temporary input/output files under createFixtureEnvironment HOME/XDG data roots",
      dialog: "Original showOpenDialog calls use strict fixed-result fixture ports; no macOS picker or native TaskRun permission",
      process: "Node child-process API is denied by the fixture policy; no CLI installation, revealPath, shell or external network action is requested",
      browser: "Private Chrome profile and fixture-origin loopbackNetwork grant only; no global web-security flags or ambient credentials",
      native: "Rust TaskRun, native OS dialog, production background scheduling and native window behavior are not exercised",
      backgroundRunning: "Manifest flag is recorded; hidden-WebContents/background scheduling semantics are not simulated or verified by this foreground UI route",
    },
    browserOrigin: { origin, permission: "loopbackNetwork for this fixture origin and this private Chrome instance only" },
    fixturePermissions: ["data", "dialog"],
    documentPolicy: "Fixture response applies CSP sandbox allow-scripts allow-same-origin allow-forms; popups omitted; browser downloads denied",
    packageHashes: {}, graphReads: {}, outputs: [], dialogSequence: [], browser: {}, cleanup: { errors: [], resources: [] },
  };
  let isolation: Awaited<ReturnType<typeof createFixtureEnvironment>> | undefined;
  let packageCopy: Awaited<ReturnType<typeof copyReadOnlyFormatConverterPackage>> | undefined;
  let session: NodeSession | undefined;
  let prepared: Awaited<ReturnType<typeof prepareFormatConverterRuntime>> | undefined;
  let browser: BrowserSession | undefined;
  let openedPage: { targetId: string; page: any } | undefined;
  let page: BrowserPage | undefined;
  const targetEvents: TargetEvent[] = [];
  const destroyedTargets: string[] = [];
  let scratchRoot = "";
  let pluginDataRoot = "";
  let inputDirectory = "";
  let outputDirectory = "";
  let quotedPath = "";
  let emptyCsvPath = "";
  let objectsPath = "";
  let brokenPath = "";
  let emptyTextPath = "";
  let plainPath = "";
  let failure: unknown;
  let cleanupIncomplete = false;
  let runtimeClosed = false;
  let nodeStopped = false;
  let nodeSessionStartAttempted = false;
  let runtimePreparationAttempted = false;

  try {
    await mkdir(outputRoot, { recursive: true });
    isolation = await createFixtureEnvironment();
    scratchRoot = join(isolation.env.XDG_DATA_HOME, "format-converter");
    pluginDataRoot = join(scratchRoot, "plugin-data");
    await mkdir(pluginDataRoot, { recursive: true, mode: 0o700 });
    pluginDataRoot = await realpath(pluginDataRoot);
    const documentsRoot = join(pluginDataRoot, "documents");
    inputDirectory = join(documentsRoot, "input");
    outputDirectory = join(documentsRoot, "output");
    await Promise.all([mkdir(inputDirectory, { recursive: true, mode: 0o700 }), mkdir(outputDirectory, { recursive: true, mode: 0o700 })]);
    quotedPath = join(inputDirectory, "quoted.csv");
    emptyCsvPath = join(inputDirectory, "empty.csv");
    objectsPath = join(inputDirectory, "objects.json");
    brokenPath = join(inputDirectory, "broken.json");
    emptyTextPath = join(inputDirectory, "empty.txt");
    plainPath = join(inputDirectory, "plain.txt");
    await Promise.all([
      writeFile(quotedPath, quotedCsv, { flag: "wx", mode: 0o600 }),
      writeFile(emptyCsvPath, "", { flag: "wx", mode: 0o600 }),
      writeFile(objectsPath, objectsJson, { flag: "wx", mode: 0o600 }),
      writeFile(brokenPath, '{"name":', { flag: "wx", mode: 0o600 }),
      writeFile(emptyTextPath, "", { flag: "wx", mode: 0o600 }),
      writeFile(plainPath, "A\nB", { flag: "wx", mode: 0o600 }),
    ]);
    report.workspace = { inputDirectory, outputDirectory, packageCopy: join(scratchRoot, "format-converter-dist"),
      chromeProfile: "separate private profile created by launchPasteBrowserSession" };

    packageCopy = await copyReadOnlyFormatConverterPackage(pluginsRoot, scratchRoot);
    report.packageHashes = packageCopy.builtHashes;
    const pluginManifest = JSON.parse(await readFile(join(packageCopy.pluginRoot, "plugin.json"), "utf8"));
    report.packageIdentity = { author: "harris", name: "format-converter", version: "0.1.0",
      main: "index.html", preload: "preload/services.cjs", backgroundRunningManifestFlag: pluginManifest.pluginSetting?.backgroundRunning === true,
      dependencyScope: "Only original iconv-lite 0.6.3 + safer-buffer 2.1.2 runtime closure copied; no full node_modules" };
    report.backgroundRunning = { manifestFlag: pluginManifest.pluginSetting?.backgroundRunning === true,
      semanticsVerified: false, note: "Foreground script-opened page does not test ZTools hidden-WebContents scheduling semantics" };
    const inputSelections = [[emptyCsvPath], [quotedPath], [objectsPath, brokenPath], [emptyTextPath], [plainPath]];
    nodeSessionStartAttempted = true;
    session = await startOriginalPluginNodeSession({ pluginId: "format-converter", root: process.cwd(),
      pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath, scratchRoot,
      pluginDataRoot, fixtureEnv: isolation.env, origin, saveAsPath: join(scratchRoot, "unused-save-target"),
      openDirectoryPath: outputDirectory, inputSelections });
    expect(session.initialization.nodeVersion).toBe("22.23.3");
    report.nodeSession = { initialization: session.initialization, endpointTokens: "not included in report" };
    runtimePreparationAttempted = true;
    prepared = await prepareFormatConverterRuntime(session, packageCopy);
    report.runtime = { ownerId: prepared.ownerId, sessionId: prepared.sessionId, commands: prepared.commands.map(item => item.command), moduleCount: prepared.moduleCount };
    report.graphReads = prepared.reads;

    browser = await launchPasteBrowserSession({ tempRoot: scratchRoot, env: isolation.env, targetEvents, destroyedTargets, fixtureOrigin: origin });
    report.browser = { ...browser.lifecycle,
      version: await browser.browser.send("Browser.getVersion", {}, { timeoutMs: 5000 }) };
    const child = await browser.openChild();
    openedPage = { targetId: child.target.targetId, page: child.page };
    const document = createFormatConverterDocument({ packageCopy, preloadScript: prepared.preloadScript, session,
      pluginDataRoot, initialInputPath: quotedPath, browserWindowId: `format-converter-${runId}`, webContentsId: 8101 });
    const network: LiveMarkdownNetworkReport = createLiveMarkdownNetworkReport();
    const controls = attachLiveMarkdownPage(child.page, { origin, pluginRoot: packageCopy.pluginRoot,
      injectedHtml: document.html, endpoints: session.endpoints, report: network, assetPins: packageCopy.assetPins,
      navigationDiagnosticScreenshotPath: join(outputRoot, `${runId}-navigation-failure.png`) });
    page = { targetId: child.target.targetId, page: child.page, controls };
    report.browserPageId = page.targetId;
    report.feature = { pluginId: "format-converter", featureCode: "format-converter", entryType: "files",
      payload: [{ name: "quoted.csv", isFile: true, isDirectory: false }], entryMode: "activate" };
    report.network = network;
    await controls.enableInterception();
    await controls.navigate();
    report.runtimeStatusText = await waitForFormatConverterMount(controls, "quoted.csv");
    report.screenshots = [];

    await openInputPickerThroughUi(controls);
    const emptyCsvError = await assertEmptyFileErrorThroughUi(controls, "empty.csv");
    report.emptyCsvFailure = { visible: true, message: emptyCsvError };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-empty-csv-error.png`)));
    await selectOutputDirectoryThroughUi(controls, outputDirectory);
    await chooseInputsThroughUi(controls, ["quoted.csv"]);
    report.emptyCsvRecovery = { selectedNames: ["quoted.csv"], originalInputUiRecovered: true,
      actualConversionFollows: "quoted.json exact bytes are asserted below" };

    await selectTargetThroughUi(controls, "JSON");
    const initialJob = await startConversionThroughUi(controls, "succeeded");
    const quotedOutput = join(outputDirectory, "quoted.json");
    assert.equal(await readFile(quotedOutput, "utf8"), expectedQuotedJson);
    report.outputs.push(await outputEvidence(quotedOutput, expectedQuotedJson, "CSV → pretty JSON with quoted comma/newline/doubled quote"));
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-quoted-json-success.png`)));
    report.initialConversionUi = initialJob;

    await chooseInputsThroughUi(controls, ["objects.json", "broken.json"]);
    await selectTargetThroughUi(controls, "CSV");
    const partialJob = await startConversionThroughUi(controls, "partial");
    const partialEvidence = await assertPartialJobContains(controls, "broken.json");
    assert.equal(await readFile(join(outputDirectory, "objects.csv"), "utf8"), expectedObjectsCsv);
    expect(existsSync(join(outputDirectory, "broken.csv"))).toBe(false);
    report.outputs.push(await outputEvidence(join(outputDirectory, "objects.csv"), expectedObjectsCsv, "JSON → CSV completed item before retry"));
    report.partialJob = { visibleStatus: partialJob.status, containsBrokenInput: partialJob.text.includes("broken.json"),
      displayedJobId: partialEvidence.displayedJobId,
      visibleErrors: partialEvidence.visibleErrors, failedOutputAbsent: true };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-partial-json-job.png`)));

    await writeFile(brokenPath, fixedBrokenJson, { mode: 0o600 });
    report.retryFixtureRepair = { sameInputPath: "broken.json", repairedByHarnessAfterVisibleFailure: true,
      changedBytes: Buffer.byteLength(fixedBrokenJson) };
    const retriedJob = await retryFailedItemsThroughUi(controls);
    expect(retriedJob.displayedJobId).toBe(partialEvidence.displayedJobId);
    assert.equal(await readFile(join(outputDirectory, "objects.csv"), "utf8"), expectedObjectsCsv);
    assert.equal(await readFile(join(outputDirectory, "broken.csv"), "utf8"), expectedBrokenCsv);
    report.outputs.push(await outputEvidence(join(outputDirectory, "broken.csv"), expectedBrokenCsv, "JSON → CSV original UI retry result"));
    report.retry = { visibleStatus: retriedJob.status, uiAction: "重试失败项", sameDisplayedJobVerified: true,
      displayedJobId: retriedJob.displayedJobId, identityScope: "Only the first 8 characters displayed by the original UI were compared" };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-retry-complete.png`)));

    await openInputPickerThroughUi(controls);
    const emptyTextError = await assertEmptyFileErrorThroughUi(controls, "empty.txt");
    report.emptyTextFailure = { visible: true, message: emptyTextError };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-empty-text-error.png`)));
    await chooseInputsThroughUi(controls, ["plain.txt"]);
    await selectTargetThroughUi(controls, "JSON");
    const plainJob = await startConversionThroughUi(controls, "succeeded");
    const plainOutput = join(outputDirectory, "plain.json");
    assert.equal(await readFile(plainOutput, "utf8"), expectedPlainJson);
    report.outputs.push(await outputEvidence(plainOutput, expectedPlainJson, "plain text → two-record pretty JSON"));
    report.plainTextRecovery = { selectedNames: ["plain.txt"], visibleStatus: plainJob.status, exactOutput: true };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-plain-json-success.png`)));

    const rawNodeSnapshot = session.snapshot();
    report.nodeSnapshot = summarizeNodeSnapshot(rawNodeSnapshot);
    assertDialogSequence(rawNodeSnapshot.dialogs ?? [], outputDirectory,
      [[emptyCsvPath], [quotedPath], [objectsPath, brokenPath], [emptyTextPath], [plainPath]]);
    report.dialogSequence = summarizeDialogs(rawNodeSnapshot.dialogs ?? []);
    expect(network.editorDocuments).toBe(1);
    expect(network.denied).toEqual([]);
    expect(network.failures).toEqual([]);
    expect(network.javascriptErrors).toEqual([]);
    expect(network.dialogs).toEqual([]);
    expect(network.pinsServed.map(item => item.path)).toEqual(expect.arrayContaining([
      "assets/index-CEGGIQwF.js", "assets/index-DfgUdfcR.css", "assets/logo-Bsd9tgVr.svg",
    ]));
    expect(network.pinsServed.every(item => Object.hasOwn(packageCopy!.assetPins, item.path))).toBe(true);
    assertUnexpectedBrowserPages(browser, page, targetEvents, report);
    report.status = "passed-ui-browser-fixture-assertions";
  } catch (error) {
    failure = error;
    report.status = "failed-ui-browser-fixture-assertions";
    report.failure = describeError(error);
    if (hasUnconfirmedCleanup(error)) cleanupIncomplete = true;
    const chromeLifecycle = findChromeLifecycle(error);
    if (chromeLifecycle) {
      report.failedChromeLifecycle = chromeLifecycle;
      if (!(["exited", "not_spawned"].includes(String(chromeLifecycle.processState))
        && String(chromeLifecycle.profileState) === "removed")) cleanupIncomplete = true;
    }
  } finally {
    if (page && browser) {
      try { await page.controls.settleRequests(); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (openedPage && browser) {
      try {
        const close = await browser.browser.send("Target.closeTarget", { targetId: openedPage.targetId }, { timeoutMs: 5000 });
        if (close.success !== true) throw new Error("Owned Format Converter Chrome target did not confirm close");
        const deadline = Date.now() + 5000;
        while (!destroyedTargets.includes(openedPage.targetId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        if (!destroyedTargets.includes(openedPage.targetId)) throw new Error("Owned Format Converter page target destroy event was not observed");
        report.cleanup.resources.push({ name: "editorPage", targetDestroyed: true });
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    } else report.cleanup.resources.push({ name: "editorPage", state: "not_started" });
    if (openedPage) {
      try { report.cleanup.resources.push({ name: "editorPageCdp", ...(await closePasteCdp(openedPage.page)) }); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    } else report.cleanup.resources.push({ name: "editorPageCdp", state: "not_started" });
    if (prepared && !runtimeClosed) {
      runtimeClosed = await closeRuntime(prepared.runtime, report);
      report.runtime.commandsAfterClose = prepared.commands.map(item => item.command);
      cleanupIncomplete = !runtimeClosed || cleanupIncomplete;
    } else if (!prepared) report.cleanup.resources.push({ name: "runtime", state: runtimePreparationAttempted
      ? "prepare_failed; production runtime helper owns its catch cleanup" : "not_started" });
    if (session && !nodeStopped) {
      nodeStopped = await stopNodeSession(session, report);
      cleanupIncomplete = !nodeStopped || cleanupIncomplete;
    } else if (!session) report.cleanup.resources.push({ name: "nodeSession", state: nodeSessionStartAttempted
      ? "startup_did_not_return; original Node session helper owns catch cleanup" : "not_started" });
    if (browser) {
      try {
        const closed = await browser.close();
        report.browser = { ...report.browser, ...closed };
        if (closed.processState !== "exited" || closed.profileState !== "removed") cleanupIncomplete = true;
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    } else report.cleanup.resources.push({ name: "chrome", state: "not_started" });
    if (session) {
      try { report.nodeSnapshotAfterClose = summarizeNodeSnapshot(session.snapshot()); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (packageCopy) {
      try { await assertFormatConverterSourceUnchanged(packageCopy.sourceDigests); report.sourceUnchanged = true; }
      catch (error) { report.sourceUnchanged = false; report.sourceVerificationError = describeError(error); }
    }
    if (packageCopy && !cleanupIncomplete) {
      try { report.packageCopyPermissionsRestored = await restoreOwnedCopyDirectoriesWritable(packageCopy); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (isolation) {
      if (cleanupIncomplete) {
        report.fixtureEnvironmentRemoved = false;
        report.fixtureEnvironmentState = "preserved_for_unconfirmed_resource_exit";
      } else {
        try { await isolation.cleanup(); report.fixtureEnvironmentRemoved = true; }
        catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
      }
    }
    report.cleanupIncomplete = cleanupIncomplete || report.cleanup.errors.length > 0;
    if (report.status === "passed-ui-browser-fixture-assertions" && report.cleanupIncomplete) report.status = "failed-resource-cleanup";
    if (report.sourceUnchanged === false && report.status === "passed-ui-browser-fixture-assertions") report.status = "failed-source-invariant";
    report.finishedAt = new Date().toISOString();
    try { await writeFile(join(outputRoot, `${runId}-report.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    report.reportPath = join(outputRoot, `${runId}-report.json`);
  }
  if (failure) throw new Error(`Format Converter original browser fixture failed; report ${report.reportPath}`, { cause: failure });
  expect(report.status).toBe("passed-ui-browser-fixture-assertions");
  expect(report.sourceUnchanged).toBe(true);
  expect(report.cleanupIncomplete).toBe(false);
  expect(report.cleanup.errors).toEqual([]);
}, 180_000);

async function outputEvidence(path: string, expected: string, operation: string) {
  const actual = await readFile(path);
  assert.equal(actual.toString("utf8"), expected);
  return { name: basename(path), bytes: actual.length, sha256: createHash("sha256").update(actual).digest("hex"), operation };
}

function assertDialogSequence(dialogs: Array<Record<string, any>>, outputDirectory: string, fileSelections: string[][]) {
  const openCalls = dialogs.filter(item => item.method === "showOpenDialog");
  expect(openCalls).toHaveLength(6);
  expect(openCalls[0]).toMatchObject({ options: { title: "选择要转换的文件", properties: ["openFile", "multiSelections"] }, resultPaths: fileSelections[0] });
  expect(openCalls[1]).toMatchObject({ options: { title: "选择转换输出目录", properties: ["openDirectory", "createDirectory"] }, resultPaths: [outputDirectory] });
  expect(openCalls[0].options.filters?.[0]).toMatchObject({ name: "支持的格式" });
  expect(openCalls[0].options.filters[0].extensions).toEqual(expect.arrayContaining(["csv", "json", "txt"]));
  for (let index = 1; index < fileSelections.length; index++) {
    expect(openCalls[index + 1]).toMatchObject({
      options: { title: "选择要转换的文件", properties: ["openFile", "multiSelections"] },
      resultPaths: fileSelections[index],
    });
  }
  expect(dialogs.filter(item => item.method === "showSaveDialog")).toEqual([]);
}

function summarizeDialogs(dialogs: Array<Record<string, any>>) {
  return dialogs.map(item => ({ method: item.method, title: item.options?.title,
    properties: item.options?.properties, filters: item.options?.filters,
    resultNames: (item.resultPaths ?? []).map((path: string) => path.split("/").at(-1)) }));
}

function summarizeNodeSnapshot(snapshot: Record<string, any>) {
  const moduleList = Array.isArray(snapshot.nodeModules) ? snapshot.nodeModules : [];
  const methods = snapshot.methods && typeof snapshot.methods === "object" ? snapshot.methods : {};
  const rpcMethods = snapshot.rpcMethods && typeof snapshot.rpcMethods === "object" ? snapshot.rpcMethods : {};
  return { pluginId: snapshot.pluginId, nodeVersion: snapshot.nodeVersion, nodePid: snapshot.nodePid,
    nodeRuntimeMs: snapshot.nodeRuntimeMs, requests: snapshot.requests, rpcRequests: snapshot.rpcRequests,
    methods, rpcMethods, nodeModuleCount: moduleList.length, nodeModules: moduleList.slice(0, 100),
    denials: snapshot.denials, nodeExitEventObserved: snapshot.nodeExitEventObserved,
    listenerClosed: snapshot.listenerClosed, databaseClosed: snapshot.databaseClosed,
    activeSocketCount: snapshot.activeSocketCount, pendingRpcCount: snapshot.pendingRpcCount,
    dialogCount: Array.isArray(snapshot.dialogs) ? snapshot.dialogs.length : 0 };
}

async function closeRuntime(runtime: FormatConverterRuntime, report: Record<string, any>) {
  try { await runtime.closeStrict(); report.cleanup.resources.push({ name: "runtime", state: "closed" }); return true; }
  catch (error) { report.cleanup.errors.push(describeError(error)); report.cleanup.resources.push({ name: "runtime", state: "close_unconfirmed" }); return false; }
}

async function stopNodeSession(session: NodeSession, report: Record<string, any>) {
  try {
    const result = await session.stop();
    report.cleanup.resources.push({ name: "nodeSession", result });
    return result.nodeExitEventObserved === true && result.listenerClosed === true && result.databaseClosed === true
      && (result.nodeExit?.code === 0 || ["SIGTERM", "SIGKILL"].includes(result.nodeExit?.signal));
  } catch (error) {
    report.cleanup.errors.push(describeError(error));
    report.cleanup.resources.push({ name: "nodeSession", state: "stop_unconfirmed" });
    return false;
  }
}

function assertUnexpectedBrowserPages(browser: BrowserSession, page: BrowserPage, events: TargetEvent[], report: Record<string, any>) {
  const known = new Set([...browser.baselinePageTargetIds, browser.harnessTargetId, page.targetId]);
  const unexpected = events.filter(event => event.eventKind === "created" && event.type === "page" && !known.has(event.targetId));
  const internalHelp = unexpected.filter(event => event.url === "chrome://help/" && !event.openerId && event.canAccessOpener === false);
  const unclassified = unexpected.filter(event => !internalHelp.includes(event));
  report.unexpectedCreatedPages = unexpected.map(event => ({ targetId: event.targetId, url: event.url,
    openerId: event.openerId, canAccessOpener: event.canAccessOpener }));
  report.browserInternalPages = internalHelp.map(event => ({ targetId: event.targetId,
    url: event.url, classification: "exact known Chrome internal help page with no opener" }));
  report.unclassifiedUnexpectedCreatedPages = unclassified.map(event => ({ targetId: event.targetId, url: event.url,
    openerId: event.openerId, canAccessOpener: event.canAccessOpener }));
  expect(unclassified).toEqual([]);
}

function describeError(error: unknown, depth = 0): Record<string, unknown> {
  const value = error instanceof Error ? error : new Error(String(error));
  const result: Record<string, unknown> = { name: value.name, message: redact(value.message) };
  if (depth < 3 && value.cause !== undefined) result.cause = describeError(value.cause, depth + 1);
  if (depth < 3 && value instanceof AggregateError) result.errors = [...value.errors].map(item => describeError(item, depth + 1));
  return result;
}

function redact(value: string) {
  return value.replace(/(\/(?:node|data|host|secrets|dialog)\/)[a-f0-9]{64}(?=\/|[?#\s]|$)/giu, "$1<redacted>")
    .replace(/\b[a-f0-9]{64}\b/giu, "<redacted>");
}

function hasUnconfirmedCleanup(error: unknown, depth = 0): boolean {
  if (!(error instanceof Error) || depth > 4) return false;
  if (String((error as Error & { code?: string }).code ?? "").includes("UNCONFIRMED")) return true;
  if (/cleanup (?:could not be confirmed|was not confirmed|did not complete)|exit_unconfirmed|exit was not observed|NODE_EXIT_UNCONFIRMED/iu.test(error.message)) return true;
  if (error.cause !== undefined && hasUnconfirmedCleanup(error.cause, depth + 1)) return true;
  return error instanceof AggregateError && [...error.errors].some(item => hasUnconfirmedCleanup(item, depth + 1));
}

function findChromeLifecycle(error: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!(error instanceof Error) || depth > 4) return undefined;
  const direct = (error as Error & { atoolsChromeLifecycle?: Record<string, unknown> }).atoolsChromeLifecycle;
  if (direct) return direct;
  const cause = error.cause === undefined ? undefined : findChromeLifecycle(error.cause, depth + 1);
  if (cause) return cause;
  if (error instanceof AggregateError) {
    for (const item of error.errors) {
      const nested = findChromeLifecycle(item, depth + 1);
      if (nested) return nested;
    }
  }
  return undefined;
}
