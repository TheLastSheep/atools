// @vitest-environment node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createFixtureEnvironment } from "../../scripts/lib/legacy-node-environment.mjs";
import { startOriginalPluginNodeSession } from "../fixtures/original-plugin-node/node-session.mjs";
import { assertFormatConverterSourceUnchanged, copyReadOnlyFormatConverterPackage, restoreOwnedCopyDirectoriesWritable } from "../fixtures/format-converter/original-package";
import { createFormatConverterDocument } from "../fixtures/format-converter/document-fixture";
import { assertOfficeCliCalls, assertOfficeCliClosed, copyPinnedOfficeCli, expectedCsvFromMatrix,
  OFFICECLI_SOURCE, readOfficeCliRuntimeUi } from "../fixtures/format-converter/office-browser-fixture";
import { writeOfficeInputs } from "../fixtures/format-converter/office-inputs";
import { readOutputEvidence, recordOutputEvidence, summarizeOutputValidation, type OutputMismatch } from "../fixtures/format-converter/output-evidence";
import { prepareFormatConverterRuntime, type FormatConverterRuntime } from "../fixtures/format-converter/runtime-fixture";
import { assertPartialJobContains, chooseInputsThroughUi,
  retryFailedItemsThroughUi, selectOutputDirectoryThroughUi, selectTargetThroughUi, startConversionThroughUi,
  waitForFormatConverterMount } from "../fixtures/format-converter/ui-actions";
import { attachLiveMarkdownPage, createLiveMarkdownNetworkReport, type LiveMarkdownNetworkReport } from "../fixtures/live-markdown/page-fixture";
import { closePasteCdp, launchPasteBrowserSession } from "../fixtures/paste-browser/chrome-session";

const pluginsRoot = resolve(process.env.ATOOLS_HARRIS_PLUGIN_SOURCE || "/Users/harris/Desktop/ZTools-plugins/plugins");
const sourceRoot = join(pluginsRoot, "format-converter", "dist");
const productNode = resolve(process.cwd(), "src-tauri/binaries/node-aarch64-apple-darwin");
const origin = "https://format-converter-office.fixture.invalid";
const outputRoot = resolve(process.cwd(), "output/playwright/format-converter-office");
const missingPrerequisites = [
  ...(process.env.ATOOLS_FORMAT_CONVERTER_OFFICE_BROWSER_ACCEPTANCE === "1" ? [] : ["ATOOLS_FORMAT_CONVERTER_OFFICE_BROWSER_ACCEPTANCE=1 not set"]),
  ...(existsSync(join(sourceRoot, "plugin.json")) ? [] : [`original dist missing: ${sourceRoot}/plugin.json`]),
  ...(existsSync(productNode) ? [] : [`product Node missing: ${productNode}`]),
  ...(existsSync(OFFICECLI_SOURCE) ? [] : [`pinned OfficeCLI prerequisite missing: ${OFFICECLI_SOURCE}`]),
];
const optIn = missingPrerequisites.length === 0;

type BrowserSession = Awaited<ReturnType<typeof launchPasteBrowserSession>>;
type NodeSession = Awaited<ReturnType<typeof startOriginalPluginNodeSession>>;
type TargetEvent = { targetId: string; type: string; url: string; openerId?: string; canAccessOpener?: boolean; eventKind?: string };

it.skipIf(!optIn)(`runs original Format Converter Office UI with pinned real OfficeCLI (skip prerequisites: ${missingPrerequisites.join("; ") || "none"})`, async () => {
  const runId = `${new Date().toISOString().replace(/[:.]/gu, "-")}-${randomUUID().slice(0, 8)}`;
  const report: Record<string, any> = {
    runId, startedAt: new Date().toISOString(), status: "setup", sourceRoot,
    scope: "Opt-in standalone original-plugin Office UI fixture using hash-pinned dist, production preload bridge, one real product Node sidecar and a copied SHA-pinned OfficeCLI helper.",
    overallCompatibilityClaim: false,
    boundaries: {
      webView: "Headless Chrome DOM interaction is a Tauri WebView stand-in, not WKWebView acceptance",
      native: "Rust TaskRun permissions, native dialogs, accessibility, clipboard, hidden-window scheduling and production background policy are not exercised",
      document: "Only tiny synthetic OOXML inputs are read; no user documents are opened",
      helper: "Node sidecar child-process calls remain denied by default; a narrow host fixture allows only the pinned OfficeCLI --version and fixed-input view text commands; no install command or unrelated process is accepted",
      helperEnvironment: "Private fixture environment, scratch-root PATH and scratch-root working directory are used; telemetry confirms only direct-child close. The helper subprocess itself is not claimed to be OS-sandboxed and detached descendants are not tracked",
      helperProcessLifecycle: "Only direct OfficeCLI ChildProcess exit and stdio close are confirmed; detached descendants are outside this fixture's lifecycle evidence",
      dialogs: "Original UI picker calls are answered by fixed local Node fixture ports; no OS picker or TaskRun permission is invoked",
      browser: "Private Chrome profile and fixture-origin loopbackNetwork grant only; no global browser security flags or ambient credentials",
      runtimeUiPath: "Original UI shows OfficeCLI readiness/version but has no path field; actual binary path and SHA are verified from independent helper telemetry",
    },
    browserOrigin: { origin, permission: "loopbackNetwork for this fixture origin and this private Chrome instance only" },
    fixturePermissions: ["data", "dialog"],
    documentPolicy: "Fixture HTML uses CSP sandbox allow-scripts allow-same-origin allow-forms; popups omitted; browser downloads denied",
    packageHashes: {}, graphReads: {}, outputs: [], screenshots: [], browser: {}, cleanup: { errors: [], resources: [] },
  };
  let isolation: Awaited<ReturnType<typeof createFixtureEnvironment>> | undefined;
  let packageCopy: Awaited<ReturnType<typeof copyReadOnlyFormatConverterPackage>> | undefined;
  let session: NodeSession | undefined;
  let prepared: Awaited<ReturnType<typeof prepareFormatConverterRuntime>> | undefined;
  let browser: BrowserSession | undefined;
  let openedPage: { targetId: string; page: any } | undefined;
  let controls: ReturnType<typeof attachLiveMarkdownPage> | undefined;
  const targetEvents: TargetEvent[] = [];
  const destroyedTargets: string[] = [];
  let scratchRoot = "";
  let pluginDataRoot = "";
  let inputDirectory = "";
  let outputDirectory = "";
  let officeInputs: Awaited<ReturnType<typeof writeOfficeInputs>> | undefined;
  let pinnedOfficeCli: Awaited<ReturnType<typeof copyPinnedOfficeCli>> | undefined;
  let failure: unknown;
  const outputMismatches: OutputMismatch[] = [];
  let allOutputRoutesAttempted = false;
  let cleanupIncomplete = false;
  let runtimeClosed = false;
  let nodeStopped = false;
  let nodeSessionStartAttempted = false;
  let runtimePreparationAttempted = false;

  try {
    await mkdir(outputRoot, { recursive: true });
    isolation = await createFixtureEnvironment();
    scratchRoot = join(isolation.env.XDG_DATA_HOME, "format-converter-office");
    pluginDataRoot = join(scratchRoot, "plugin-data");
    await Promise.all([
      mkdir(scratchRoot, { recursive: true, mode: 0o700 }),
      mkdir(pluginDataRoot, { recursive: true, mode: 0o700 }),
    ]);
    scratchRoot = await realpath(scratchRoot);
    pluginDataRoot = await realpath(pluginDataRoot);
    const documentsRoot = join(pluginDataRoot, "documents");
    inputDirectory = join(documentsRoot, "input");
    outputDirectory = join(documentsRoot, "output");
    await Promise.all([
      mkdir(inputDirectory, { recursive: true, mode: 0o700 }),
      mkdir(outputDirectory, { recursive: true, mode: 0o700 }),
    ]);
    inputDirectory = await realpath(inputDirectory);
    outputDirectory = await realpath(outputDirectory);
    officeInputs = await writeOfficeInputs(inputDirectory);
    const inputPaths = [officeInputs.docxPath, officeInputs.xlsxPath, officeInputs.brokenDocxPath];
    for (const path of inputPaths) assert.equal(await realpath(path), path, `Office input must be a canonical non-symlink path: ${path}`);

    pinnedOfficeCli = await copyPinnedOfficeCli(scratchRoot, { ...isolation.env });
    const privateBinaryStat = await lstat(pinnedOfficeCli.binaryPath);
    assert.ok(privateBinaryStat.isFile() && !privateBinaryStat.isSymbolicLink());
    assert.equal(privateBinaryStat.mode & 0o777, 0o700, "Private OfficeCLI copy must be executable only by the fixture owner");
    report.workspace = { inputDirectory, outputDirectory, scratchRoot, pluginDataRoot,
      officeCliPath: pinnedOfficeCli.binaryPath, officeCliSha256: pinnedOfficeCli.sha256,
      officeCliBytes: pinnedOfficeCli.bytes, inputNames: inputPaths.map(path => basename(path)), officeInputSha256: officeInputs.sha256,
      chromeProfile: "separate private profile created by launchPasteBrowserSession" };

    packageCopy = await copyReadOnlyFormatConverterPackage(pluginsRoot, scratchRoot);
    report.packageHashes = packageCopy.builtHashes;
    const pluginManifest = JSON.parse(await readFile(join(packageCopy.pluginRoot, "plugin.json"), "utf8"));
    assert.deepEqual({ author: pluginManifest.author, name: pluginManifest.name, version: pluginManifest.version,
      main: pluginManifest.main, preload: pluginManifest.preload }, {
      author: "harris", name: "format-converter", version: "0.1.0", main: "index.html", preload: "preload/services.cjs",
    });
    report.packageIdentity = { author: pluginManifest.author, name: pluginManifest.name, version: pluginManifest.version,
      main: pluginManifest.main, preload: pluginManifest.preload };

    nodeSessionStartAttempted = true;
    session = await startOriginalPluginNodeSession({ pluginId: "format-converter", root: process.cwd(),
      pluginRoot: packageCopy.pluginRoot, preloadPath: packageCopy.preloadPath, scratchRoot, pluginDataRoot,
      fixtureEnv: pinnedOfficeCli.fixtureEnv, origin, saveAsPath: join(scratchRoot, "unused-save-target"),
      openFilePath: officeInputs.docxPath,
      openDirectoryPath: outputDirectory, inputSelections: [[officeInputs.docxPath, officeInputs.brokenDocxPath], [officeInputs.xlsxPath]],
      officeCli: { binaryPath: pinnedOfficeCli.binaryPath, sha256: pinnedOfficeCli.sha256, inputPaths } });
    assert.equal(session.initialization.nodeVersion, "22.23.3");
    report.nodeSession = { initialization: session.initialization, endpointTokens: "not included in report" };

    runtimePreparationAttempted = true;
    prepared = await prepareFormatConverterRuntime(session, packageCopy);
    report.runtime = { moduleCount: prepared.moduleCount, graphReads: prepared.reads };

    browser = await launchPasteBrowserSession({ tempRoot: scratchRoot, env: isolation.env, targetEvents, destroyedTargets, fixtureOrigin: origin });
    report.browser = { ...browser.lifecycle, version: await browser.browser.send("Browser.getVersion", {}, { timeoutMs: 5000 }) };
    const child = await browser.openChild();
    openedPage = { targetId: child.target.targetId, page: child.page };
    const document = createFormatConverterDocument({ packageCopy, preloadScript: prepared.preloadScript, session,
      pluginDataRoot, initialInputPath: officeInputs.docxPath, browserWindowId: `format-converter-office-${runId}`, webContentsId: 8201 });
    const network: LiveMarkdownNetworkReport = createLiveMarkdownNetworkReport();
    controls = attachLiveMarkdownPage(child.page, { origin, pluginRoot: packageCopy.pluginRoot,
      injectedHtml: document.html, endpoints: session.endpoints, report: network, assetPins: packageCopy.assetPins,
      navigationDiagnosticScreenshotPath: join(outputRoot, `${runId}-navigation-failure.png`) });
    report.browserPageId = child.target.targetId;
    report.feature = { pluginId: "format-converter", featureCode: "format-converter", entryType: "files",
      payload: [{ name: basename(officeInputs.docxPath), isFile: true, isDirectory: false }], entryMode: "activate" };
    report.network = network;
    await controls.enableInterception();
    await controls.navigate();
    const runtimeStatusText = await waitForFormatConverterMount(controls, basename(officeInputs.docxPath));
    const runtimeUi = await readOfficeCliRuntimeUi(controls);
    report.runtimeUi = { stripText: runtimeStatusText, officeCli: runtimeUi };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-officecli-runtime.png`)));
    await controls.evaluate("window.scrollTo(0,0)");

    await selectOutputDirectoryThroughUi(controls, outputDirectory);
    await chooseInputsThroughUi(controls, [basename(officeInputs.docxPath), basename(officeInputs.brokenDocxPath)]);
    await selectTargetThroughUi(controls, "纯文本");
    const partialJob = await startConversionThroughUi(controls, "partial");
    const partialEvidence = await assertPartialJobContains(controls, basename(officeInputs.brokenDocxPath));
    const docxOutput = join(outputDirectory, "harris-office.txt");
    const brokenOutput = join(outputDirectory, "broken-retry.txt");
    assert.equal(existsSync(brokenOutput), false, "A failed malformed Office input must not publish partial output");
    const initialDocxOutput = await readOutputEvidence(docxOutput, officeInputs.expectedDocxText,
      "DOCX → plain text before failed item retry");
    recordOutputEvidence(report, outputMismatches, initialDocxOutput);
    report.partialDocxJob = { visibleStatus: partialJob.status, displayedJobId: partialEvidence.displayedJobId,
      failedInput: basename(officeInputs.brokenDocxPath), visibleErrors: partialEvidence.visibleErrors,
      failedOutputAbsent: true, successfulItemOutputMatched: initialDocxOutput.matches };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-partial-docx-job.png`)));

    await writeFile(officeInputs.retry.path, officeInputs.retry.bytes, { mode: 0o600 });
    assert.equal(officeInputs.retry.path, officeInputs.brokenDocxPath, "Retry fixture bytes must replace the exact failed path");
    assert.equal(officeInputs.sha256.brokenDocx !== officeInputs.retry.sha256, true);
    assert.equal(createHash("sha256").update(await readFile(officeInputs.retry.path)).digest("hex"), officeInputs.retry.sha256,
      "Retry bytes must be durable at the same input path before the UI retry action");
    report.retryFixtureRepair = { sameInputPath: basename(officeInputs.retry.path),
      beforeSha256: officeInputs.sha256.brokenDocx, afterSha256: officeInputs.retry.sha256,
      bytes: officeInputs.retry.bytes.length, repairedAfterVisibleFailure: true };
    const retriedJob = await retryFailedItemsThroughUi(controls);
    assert.equal(retriedJob.displayedJobId, partialEvidence.displayedJobId,
      "Retry must retain the original displayed job ID");
    const repeatedDocxOutput = await readOutputEvidence(docxOutput, officeInputs.expectedDocxText,
      "DOCX → plain text previously successful item after UI retry");
    const retriedDocxOutput = await readOutputEvidence(brokenOutput, officeInputs.expectedDocxText,
      "DOCX → plain text original UI retry");
    recordOutputEvidence(report, outputMismatches, repeatedDocxOutput);
    recordOutputEvidence(report, outputMismatches, retriedDocxOutput);
    report.retryJob = { visibleStatus: retriedJob.status, sameDisplayedJobVerified: true,
      displayedJobId: retriedJob.displayedJobId, outputPath: basename(brokenOutput),
      repairedItemOutputMatched: retriedDocxOutput.matches, previousItemOutputMatched: repeatedDocxOutput.matches };
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-docx-retry-complete.png`)));

    await chooseInputsThroughUi(controls, [basename(officeInputs.xlsxPath)]);
    await selectTargetThroughUi(controls, "CSV");
    const csvJob = await startConversionThroughUi(controls, "succeeded");
    const expectedCsv = expectedCsvFromMatrix(officeInputs.expectedXlsxMatrix);
    const csvOutput = join(outputDirectory, "harris-office.csv");
    const xlsxCsvOutput = await readOutputEvidence(csvOutput, expectedCsv, "XLSX → CSV original UI conversion");
    recordOutputEvidence(report, outputMismatches, xlsxCsvOutput);
    report.xlsxCsv = { visibleStatus: csvJob.status, expectedMatrix: officeInputs.expectedXlsxMatrix,
      expectedCsv, exactOutput: xlsxCsvOutput.matches };
    allOutputRoutesAttempted = true;
    report.uiWorkflow = { partialDocxRouteCompleted: true, partialJobStatus: partialJob.status,
      retryRouteCompleted: true, retryJobStatus: retriedJob.status,
      sameDisplayedJobVerified: retriedJob.displayedJobId === partialEvidence.displayedJobId,
      xlsxCsvRouteCompleted: true, xlsxJobStatus: csvJob.status };
    report.businessOutputValidation = summarizeOutputValidation(report.outputs, outputMismatches, allOutputRoutesAttempted);
    report.screenshots.push(await controls.screenshot(join(outputRoot, `${runId}-xlsx-csv-success.png`)));

    const nodeSnapshot = session.snapshot();
    const helperProcesses = assertOfficeCliCalls(nodeSnapshot, pinnedOfficeCli, 4);
    report.nodeSnapshot = summarizeNodeSnapshot(nodeSnapshot);
    report.officeCli = { binaryPath: helperProcesses.binaryPath, sha256: helperProcesses.sha256,
      versionCalls: helperProcesses.versionCalls, viewCalls: helperProcesses.viewCalls,
      environmentPolicy: helperProcesses.environmentPolicy, errors: helperProcesses.errors,
      childLifecycleScope: helperProcesses.childLifecycleScope,
      denials: helperProcesses.denials, killRequests: helperProcesses.killRequests,
      nonzeroExits: helperProcesses.nonzeroExits, events: helperProcesses.events,
      pids: helperProcesses.pids, closeConfirmedBeforeNodeStop: helperProcesses.closeConfirmed };
    assertDialogSequence(nodeSnapshot.dialogs ?? [], outputDirectory,
      [[officeInputs.docxPath, officeInputs.brokenDocxPath], [officeInputs.xlsxPath]]);
    report.dialogSequence = summarizeDialogs(nodeSnapshot.dialogs ?? []);
    assert.strictEqual(nodeSnapshot.denials?.externalNetwork ?? 0, 0, "Original plugin must not attempt external network access");
    expect(network.editorDocuments).toBe(1);
    expect(network.denied).toEqual([]);
    expect(network.failures).toEqual([]);
    expect(network.javascriptErrors).toEqual([]);
    expect(network.dialogs).toEqual([]);
    expect(network.pinsServed.map(item => item.path)).toEqual(expect.arrayContaining([
      "assets/index-CEGGIQwF.js", "assets/index-DfgUdfcR.css", "assets/logo-Bsd9tgVr.svg",
    ]));
    expect(network.pinsServed.every(item => Object.hasOwn(packageCopy!.assetPins, item.path))).toBe(true);
    assertUnexpectedBrowserPages(browser, openedPage.targetId, targetEvents, report);
    if (outputMismatches.length > 0) {
      throw new AggregateError(outputMismatches.map(item => new Error(String(item.message))),
        "Original Format Converter UI completed all routes, but one or more outputs differ from frozen expectations");
    }
    report.status = "passed-ui-office-browser-fixture-assertions";
  } catch (error) {
    failure = error;
    report.status = "failed-ui-office-browser-fixture-assertions";
    report.failure = describeError(error);
    if (hasUnconfirmedCleanup(error)) cleanupIncomplete = true;
    const chromeLifecycle = findChromeLifecycle(error);
    if (chromeLifecycle) {
      report.failedChromeLifecycle = chromeLifecycle;
      if (!["exited", "not_spawned"].includes(String(chromeLifecycle.processState))
        || String(chromeLifecycle.profileState) !== "removed") cleanupIncomplete = true;
    }
  } finally {
    if (controls) {
      try { await controls.settleRequests(); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (openedPage && browser) {
      try {
        const close = await browser.browser.send("Target.closeTarget", { targetId: openedPage.targetId }, { timeoutMs: 5000 });
        if (close.success !== true) throw new Error("Owned Format Converter office page target did not confirm close");
        const deadline = Date.now() + 5000;
        while (!destroyedTargets.includes(openedPage.targetId) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
        if (!destroyedTargets.includes(openedPage.targetId)) throw new Error("Owned Format Converter office page destroy event was not observed");
        report.cleanup.resources.push({ name: "editorPage", targetDestroyed: true });
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    } else report.cleanup.resources.push({ name: "editorPage", state: "not_started" });
    if (openedPage) {
      try { report.cleanup.resources.push({ name: "editorPageCdp", ...(await closePasteCdp(openedPage.page)) }); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    } else report.cleanup.resources.push({ name: "editorPageCdp", state: "not_started" });
    if (prepared && !runtimeClosed) {
      runtimeClosed = await closeRuntime(prepared.runtime, report);
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
      try {
        const finalSnapshot = session.snapshot();
        report.nodeSnapshotAfterClose = summarizeNodeSnapshot(finalSnapshot);
        const closedHelpers = assertOfficeCliClosed(finalSnapshot);
        report.officeCli = { ...report.officeCli, started: closedHelpers.started, exited: closedHelpers.exited,
          closed: closedHelpers.closed, active: closedHelpers.active, closeConfirmed: closedHelpers.closeConfirmed,
          childLifecycleScope: closedHelpers.childLifecycleScope,
          finalEvents: closedHelpers.events, pids: closedHelpers.pids };
      } catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    if (packageCopy) {
      try { await assertFormatConverterSourceUnchanged(packageCopy.sourceDigests); report.sourceUnchanged = true; }
      catch (error) { report.sourceUnchanged = false; report.sourceVerificationError = describeError(error); }
    }
    if (packageCopy && !cleanupIncomplete) {
      try { report.packageCopyPermissionsRestored = await restoreOwnedCopyDirectoriesWritable(packageCopy); }
      catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    }
    report.businessOutputValidation ??= summarizeOutputValidation(report.outputs, outputMismatches, allOutputRoutesAttempted);
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
    if (report.status === "passed-ui-office-browser-fixture-assertions" && report.cleanupIncomplete) report.status = "failed-resource-cleanup";
    if (report.sourceUnchanged === false && report.status === "passed-ui-office-browser-fixture-assertions") report.status = "failed-source-invariant";
    report.finishedAt = new Date().toISOString();
    try { await writeFile(join(outputRoot, `${runId}-report.json`), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 }); }
    catch (error) { cleanupIncomplete = true; report.cleanup.errors.push(describeError(error)); }
    report.reportPath = join(outputRoot, `${runId}-report.json`);
  }
  if (failure) throw new Error(`Format Converter original Office browser fixture failed; report ${report.reportPath}`, { cause: failure });
  expect(report.status).toBe("passed-ui-office-browser-fixture-assertions");
  expect(report.sourceUnchanged).toBe(true);
  expect(report.cleanupIncomplete).toBe(false);
  expect(report.cleanup.errors).toEqual([]);
}, 180_000);

function assertDialogSequence(dialogs: Array<Record<string, any>>, outputDirectory: string, selections: string[][]) {
  const openCalls = dialogs.filter(item => item.method === "showOpenDialog");
  expect(openCalls).toHaveLength(3);
  expect(openCalls[0]).toMatchObject({ options: { title: "选择转换输出目录", properties: ["openDirectory", "createDirectory"] }, resultPaths: [outputDirectory] });
  expect(openCalls[1]).toMatchObject({ options: { title: "选择要转换的文件", properties: ["openFile", "multiSelections"] }, resultPaths: selections[0] });
  expect(openCalls[2]).toMatchObject({ options: { title: "选择要转换的文件", properties: ["openFile", "multiSelections"] }, resultPaths: selections[1] });
  expect(openCalls[1].options.filters?.[0]).toMatchObject({ name: "支持的格式" });
  expect(openCalls[1].options.filters[0].extensions).toEqual(expect.arrayContaining(["docx", "xlsx"]));
  expect(dialogs.filter(item => item.method === "showSaveDialog")).toEqual([]);
}

function summarizeDialogs(dialogs: Array<Record<string, any>>) {
  return dialogs.map(item => ({ method: item.method, title: item.options?.title,
    properties: item.options?.properties, filters: item.options?.filters,
    resultNames: (item.resultPaths ?? []).map((path: string) => basename(path)) }));
}

function summarizeNodeSnapshot(snapshot: Record<string, any>) {
  const moduleList = Array.isArray(snapshot.nodeModules) ? snapshot.nodeModules : [];
  return { pluginId: snapshot.pluginId, nodeVersion: snapshot.nodeVersion, nodePid: snapshot.nodePid,
    nodeRuntimeMs: snapshot.nodeRuntimeMs, requests: snapshot.requests, rpcRequests: snapshot.rpcRequests,
    methods: snapshot.methods, rpcMethods: snapshot.rpcMethods, denials: snapshot.denials,
    nodeModuleCount: moduleList.length, nodeModules: moduleList.slice(0, 100), nodeExitEventObserved: snapshot.nodeExitEventObserved,
    listenerClosed: snapshot.listenerClosed, databaseClosed: snapshot.databaseClosed,
    activeSocketCount: snapshot.activeSocketCount, pendingRpcCount: snapshot.pendingRpcCount,
    stderrTail: redact(typeof snapshot.stderrTail === "string" ? snapshot.stderrTail : ""),
    helperProcesses: snapshot.helperProcesses };
}

async function closeRuntime(runtime: FormatConverterRuntime, report: Record<string, any>) {
  try { await runtime.closeStrict(); report.cleanup.resources.push({ name: "runtime", state: "closed" }); return true; }
  catch (error) { report.cleanup.errors.push(describeError(error)); report.cleanup.resources.push({ name: "runtime", state: "close_unconfirmed" }); return false; }
}

async function stopNodeSession(session: NodeSession, report: Record<string, any>) {
  try {
    const result = await session.stop();
    report.cleanup.resources.push({ name: "nodeSession", result });
    report.nodeSessionExit = { code: result.nodeExit?.code, signal: result.nodeExit?.signal,
      exitEventObserved: result.nodeExitEventObserved, listenerClosed: result.listenerClosed, databaseClosed: result.databaseClosed };
    return result.nodeExitEventObserved === true && result.listenerClosed === true && result.databaseClosed === true
      && (result.nodeExit?.code === 0 || result.nodeExit?.code === 143 || ["SIGTERM", "SIGKILL"].includes(result.nodeExit?.signal));
  } catch (error) {
    report.cleanup.errors.push(describeError(error));
    report.cleanup.resources.push({ name: "nodeSession", state: "stop_unconfirmed" });
    return false;
  }
}

function assertUnexpectedBrowserPages(browser: BrowserSession, pageTargetId: string, events: TargetEvent[], report: Record<string, any>) {
  const known = new Set([...browser.baselinePageTargetIds, browser.harnessTargetId, pageTargetId]);
  const unexpected = events.filter(event => event.eventKind === "created" && event.type === "page" && !known.has(event.targetId));
  const internalHelp = unexpected.filter(event => event.url === "chrome://help/" && !event.openerId && event.canAccessOpener === false);
  const unclassified = unexpected.filter(event => !internalHelp.includes(event));
  report.unexpectedCreatedPages = unexpected.map(event => ({ targetId: event.targetId, url: event.url,
    openerId: event.openerId, canAccessOpener: event.canAccessOpener }));
  report.browserInternalPages = internalHelp.map(event => ({ targetId: event.targetId, url: event.url,
    classification: "exact known Chrome internal help page with no opener" }));
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
