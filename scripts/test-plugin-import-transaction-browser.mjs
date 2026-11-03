import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { verifyImportSourceChoices } from "./lib/plugin-import-source-browser.mjs";
import { verifySourceManifestChoices } from "./lib/plugin-source-manifest-browser.mjs";

const runId = randomUUID();
const runRoot = new URL(`../output/playwright/import-source-choice-2026-10-17/${runId}/`, import.meta.url);
const sourceFiles = [
  "src/App.svelte", "src/components/SystemPanel.svelte", "src/components/SettingsPanel.svelte", "src/components/SearchBar.svelte",
  "src/components/ZToolsImportPanel.svelte", "src/components/ZToolsImportCandidateRow.svelte", "src/components/ZToolsImportResults.svelte",
  "src/components/SourceBuildManifestChoices.svelte", "src/components/ZToolsSourceBuildStatus.svelte",
  "src/components/ZToolsSourceDependencyStatus.svelte",
  "src/lib/ztoolsImportController.ts", "src/lib/ztoolsImportView.ts", "src/lib/pluginOpen.ts", "src/lib/pluginMarketNavigation.ts",
  "src/lib/uiState.ts", "src/styles/global.css", "tests/components/plugin-import-transaction-browser.html",
  "src/lib/types.ts", "src/lib/pluginTypes.ts", "src/lib/ztoolsImportSelection.ts",
  "tests/components/pluginImportTransactionBrowserFixture.ts", "scripts/test-plugin-import-transaction-browser.mjs",
  "scripts/lib/static-browser-fixture.mjs", "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
  "scripts/lib/plugin-import-source-browser.mjs", "scripts/lib/plugin-source-manifest-browser.mjs",
  "src/lib/pluginSourceBuildManifest.ts", "src/lib/pluginSourceBuildProtocol.ts", "src/lib/pluginSourceBuildController.ts",
  "src/lib/pluginSourceBuildServices.ts", "src/lib/pluginSourceBuildBlockerText.ts", "src/lib/pluginSourceDependencySession.ts",
];
const port = 1463;
const origin = `http://127.0.0.1:${port}`;
const checks = [], screenshots = [], requests = [], navigations = [], consoleIssues = [];
const cleanupEvidence = { app: "not_started", cdp: "not_started", chrome: "not_started", preview: "not_started", build: "not_started" };
let sourceHashesAtStart, compiledFixture, server, chrome, page, buildDir, report, settingsShot, sourceChoiceEvidence;
let sourceManifestEvidence, stage = "setup";
let expectedFixtureConsoleIssues = [], expectedFixtureConsoleIssueIndexes = [];
let activationConsoleStart = null;

function consoleEvidence() {
  const expectedIndexes = new Set(expectedFixtureConsoleIssueIndexes);
  return {
    consoleIssues,
    expectedFixtureConsoleIssues,
    unexpectedConsoleIssues: consoleIssues.filter((_, index) => !expectedIndexes.has(index)),
  };
}

async function hashSources() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
    file, createHash("sha256").update(await readFile(resolve(process.cwd(), file))).digest("hex"),
  ])));
}
async function cdp(method, params = {}) { return page.send(method, params, { timeoutMs: 12000 }); }
async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text);
  return response.result.value;
}
async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await evaluate(expression);
    if (value) return value;
    await delay(35);
  }
  assert.fail(`Timed out waiting for ${expression}`);
}
async function key(keyValue, code, virtualKey, modifiers = 0) {
  const params = { key: keyValue, code, windowsVirtualKeyCode: virtualKey, modifiers };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await delay(70);
}
async function typeIntoSearch(text) {
  await evaluate("document.querySelector('[data-atools-search-input]')?.focus()");
  await key("a", "KeyA", 65, 2);
  await cdp("Input.insertText", { text });
}
async function click(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,disabled:e.disabled===true,hit:document.elementFromPoint(x,y)===e||e.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point, `Missing click target ${selector}`);
  assert.equal(point.disabled, false, `Disabled click target ${selector}`);
  assert.ok(point.width > 0 && point.height > 0 && point.left >= 0 && point.top >= 0 && point.right <= point.viewportWidth && point.bottom <= point.viewportHeight, JSON.stringify(point));
  assert.equal(point.hit, true, `Click point covered for ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  await delay(80);
}
async function clickButton(label) {
  const selector = `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim()===${JSON.stringify(label)})`;
  const point = await evaluate(`(()=>{const e=${selector};if(!e)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,disabled:e.disabled,rect:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}}})()`);
  assert.ok(point, `Missing button: ${label}`); assert.equal(point.disabled, false, `Disabled button: ${label}`);
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  await delay(80);
}
async function wheel(selector, deltaY) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight}})()`);
  assert.ok(point, `Missing wheel target ${selector}`);
  assert.ok(point.width > 0 && point.height > 0 && point.left >= 0 && point.top >= 0 && point.right <= point.viewportWidth && point.bottom <= point.viewportHeight, JSON.stringify(point));
  await cdp("Input.dispatchMouseEvent", { type: "mouseWheel", x: point.x, y: point.y, deltaX: 0, deltaY });
  await delay(90);
}
async function setViewport(width, height, theme) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await waitFor(`innerWidth===${width}&&innerHeight===${height}`);
  await delay(120);
}
async function geometry(label) {
  return evaluate(`(()=>{const root=document.documentElement,body=document.body,panel=document.querySelector('.import-panel'),input=document.querySelector('[data-atools-search-input]');return {label:${JSON.stringify(label)},viewport:{width:innerWidth,height:innerHeight},documentWidth:root.scrollWidth,bodyWidth:body.scrollWidth,hasXOverflow:root.scrollWidth>innerWidth||body.scrollWidth>innerWidth,searchFocused:document.activeElement===input,focusedRole:document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,hasPanel:Boolean(panel),panelBusy:panel?.getAttribute('aria-busy')||null,status:document.querySelector('.busy-line,[role=status]')?.textContent?.trim()||null}})()`);
}
async function screenshot(label) {
  await cdp("Page.bringToFront");
  await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,1200))])");
  const capture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(capture.data, "base64");
  const file = `${label}-${runId}.png`;
  await writeFile(new URL(file, runRoot), bytes);
  const result = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  screenshots.push(result);
  return result;
}
async function enterImportFromSettings() {
  await click('button[aria-label="打开设置"]');
  await waitFor("document.querySelector('.settings-panel')");
  const settingsShot = await screenshot("settings-before-import-800-light");
  await click('button[aria-label="回到主搜索"]');
  await waitFor("document.querySelector('[data-atools-search-input]')");
  await typeIntoSearch("导入 ZTools 插件");
  await waitFor("document.querySelector('.result-row[data-result-code=\"system:import\"]')");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('.import-panel')");
  return settingsShot;
}
async function importCalls() { return evaluate("window.pluginImportTransactionFixture.calls.filter(call=>call.command==='import_ztools_plugins')"); }
async function callCount(command) { return evaluate(`window.pluginImportTransactionFixture.calls.filter(call=>call.command===${JSON.stringify(command)}).length`); }
async function assertNoOverflow(label) {
  const state = await geometry(label);
  assert.equal(state.hasXOverflow, false, `${label}: horizontal overflow ${JSON.stringify(state)}`);
  return state;
}
async function assertReportState(label, actionText, statusSelector) {
  await evaluate("document.querySelector('.report')?.scrollIntoView({block:'nearest',inline:'nearest'})");
  await delay(90);
  const layout = await assertNoOverflow(label);
  const state = await evaluate(`(()=>{const report=document.querySelector('.report'),button=Array.from(report?.querySelectorAll('button')||[]).find(item=>item.textContent.trim()===${JSON.stringify(actionText)}),status=document.querySelector(${JSON.stringify(statusSelector)}),rect=element=>{if(!element)return null;const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,visible:r.width>0&&r.height>0&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight}};return {report:rect(report),button:rect(button),status:rect(status),statusText:status?.textContent?.trim()||''}})()`);
  assert.ok(state.report?.visible, `${label}: report outside viewport ${JSON.stringify(state)}`);
  assert.ok(state.button?.visible, `${label}: action ${actionText} outside viewport ${JSON.stringify(state)}`);
  if (statusSelector) assert.ok(state.status?.visible, `${label}: status outside viewport ${JSON.stringify(state)}`);
  return { ...layout, reportAction: actionText, reportStatus: state.statusText, reportBounds: state.report, actionBounds: state.button };
}
async function assertBusyControlsDisabled() {
  const state = await evaluate(`(()=>{const panel=document.querySelector('.import-panel');return {buttons:Array.from(panel.querySelectorAll('button')).map(button=>({label:button.textContent.trim(),disabled:button.disabled})),checks:Array.from(panel.querySelectorAll('input[type=checkbox]')).map(input=>input.disabled),live:panel.querySelector('[role=status]')?.textContent?.trim()||''}})()`);
  assert.ok(state.buttons.length >= 3, JSON.stringify(state));
  assert.ok(state.buttons.every(button => button.disabled), JSON.stringify(state.buttons));
  assert.ok(state.checks.every(Boolean), JSON.stringify(state.checks));
  assert.ok(state.live.length > 0, "Busy state must be announced");
  return state;
}
async function fixture(expression) { return evaluate(`window.pluginImportTransactionFixture.${expression}`); }

try {
  await mkdir(runRoot, { recursive: true });
  sourceHashesAtStart = await hashSources();
  buildDir = await mkdtemp(join(tmpdir(), `atools-import-transaction-${runId}-`));
  compiledFixture = await buildStaticBrowserFixture({ projectRoot: process.cwd(), entryHtml: "tests/components/plugin-import-transaction-browser.html", outDir: join(buildDir, "dist") });
  const staticSource = (await Promise.all(compiledFixture.outputFiles.filter(file => file.endsWith(".html") || file.endsWith(".js")).map(file => readFile(join(buildDir, "dist", file), "utf8")))).join("\n");
  assert.equal(staticSource.includes("@vite/client"), false); assert.equal(staticSource.includes("import.meta.hot"), false);
  server = await previewStaticBrowserFixture({ projectRoot: process.cwd(), outDir: join(buildDir, "dist"), host: "127.0.0.1", port });
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (["error", "warning", "assert"].includes(type)) consoleIssues.push(`${type}:${formatConsoleArgs(args)}`);
  });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  page.on("Page.frameNavigated", event => { if (!event.frame.parentId) navigations.push(event.frame.url); });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: `${origin}/${compiledFixture.htmlFile}` });
  await loaded;
  await waitFor("window.pluginImportTransactionFixture && document.querySelector('[data-atools-search-input]')");
  checks.push("Static Vite build starts the actual App and real settings/import route; Tauri IPC is synthetic and unknown commands throw");

  stage = "navigate-through-settings-to-import";
  settingsShot = await enterImportFromSettings();
  await waitFor("window.pluginImportTransactionFixture.calls.some(call=>call.command==='scan_default_ztools_plugins'&&call.pendingKey==='initial-default-scan')");
  const initialBusy = await assertBusyControlsDisabled();
  await setViewport(420, 560, "light");
  const scanShot = await screenshot("initial-scan-pending-420-light");
  await fixture("resolveScan('initial-default-scan')");
  await waitFor("document.querySelectorAll('.candidate-row').length===3");
  const initialCandidates = await evaluate(`(()=>({rows:Array.from(document.querySelectorAll('.candidate-row')).map(row=>({title:row.querySelector('.candidate-title-line strong')?.textContent?.trim(),checked:row.querySelector('input')?.checked,disabled:row.querySelector('input')?.disabled})),focused:document.activeElement===document.querySelector('[data-atools-search-input]')}))()`);
  assert.deepEqual(initialCandidates.rows.map(row => row.checked), [false, true, true]);
  assert.equal(initialCandidates.focused, true);
  checks.push("Initial selection follows candidate selectability; the error-free requires_build candidate remains blocked and unchecked");

  stage = "directory-picker-and-rescan-interlock";
  await fixture("planDialog('held-directory-picker')");
  await fixture("planScan('scan_ztools_plugins','held-directory-scan')");
  await clickButton("选择目录");
  await waitFor("window.pluginImportTransactionFixture.calls.some(call=>call.command==='plugin:dialog|open'&&call.pendingKey==='held-directory-picker')");
  const pickerBusy = await assertBusyControlsDisabled();
  const pickerShot = await screenshot("directory-picker-pending-420-light");
  await fixture("resolveDialog('held-directory-picker','/fixture/selected-ztools-root')");
  await waitFor("window.pluginImportTransactionFixture.calls.some(call=>call.command==='scan_ztools_plugins'&&call.pendingKey==='held-directory-scan')");
  const rescanBusy = await assertBusyControlsDisabled();
  await setViewport(800, 600, "dark");
  await fixture("resolveScan('held-directory-scan')");
  await waitFor("document.querySelectorAll('.candidate-row').length===3 && !document.querySelector('.busy-line')");
  checks.push("A deferred native directory picker and its follow-up scan hold all import/select/scan controls busy; no cancellation is offered");

  stage = "partial-import-list-recovery";
  await fixture("queueImport({imported:['success-plugin'],skipped:[],failed:[{path:'/fixture/source/retry',error:'Synthetic recoverable source failure'}]})");
  await fixture("failNextListAfterNextImport()");
  await clickButton("导入 2 个插件");
  await waitFor("document.querySelector('.report') && document.querySelector('.refresh-error')");
  const afterPartial = await evaluate(`(()=>({report:document.querySelector('.report')?.innerText,selected:Array.from(document.querySelectorAll('.candidate-row input')).map(input=>input.checked),refresh:document.querySelector('.refresh-error')?.innerText,importCalls:window.pluginImportTransactionFixture.calls.filter(call=>call.command==='import_ztools_plugins')}))()`);
  assert.match(afterPartial.report, /成功 1 个，跳过 0 个，失败 1 个/);
  assert.deepEqual(afterPartial.selected, [false, false, true]);
  assert.deepEqual(afterPartial.importCalls[0].args.paths, ["/fixture/source/success", "/fixture/source/retry"]);
  assert.equal(afterPartial.importCalls[0].args.overwrite, true);
  const partialLayout = await assertReportState("partial-success-list-error-800x600-dark", "重新读取插件列表", ".refresh-error[role=status]");
  const listErrorShot = await screenshot("partial-success-list-failed-800-dark");
  await clickButton("重新读取插件列表");
  await waitFor("document.querySelector('.report-list .report-row.imported .report-actions button')?.textContent.includes('启用并打开')");
  assert.equal(await callCount("import_ztools_plugins"), 1);
  checks.push("The first import returns a successful sanitized ID plus one exact source-path failure; list_plugins failure keeps the report and list-only recovery performs no second import");

  stage = "enable-refresh-open-and-disabled-retry-action";
  await clickButton("启用并打开");
  await waitFor("document.querySelector('.refresh-error') && document.querySelector('.report-row.imported button')?.textContent.includes('重新读取并打开')");
  const stateAfterEnableReadFailure = await evaluate(`(()=>({toggleCalls:window.pluginImportTransactionFixture.calls.filter(call=>call.command==='toggle_plugin'),listCalls:window.pluginImportTransactionFixture.calls.filter(call=>call.command==='list_plugins').length,action:document.querySelector('.report-row.imported button')?.textContent?.trim(),copy:document.querySelector('.refresh-error')?.textContent?.trim()}))()`);
  assert.equal(stateAfterEnableReadFailure.toggleCalls.length, 1);
  assert.equal(stateAfterEnableReadFailure.action, "重新读取并打开");
  const enableLayout = await assertReportState("enable-read-error-800x600-dark", "重新读取并打开", ".refresh-error[role=status]");
  const enableErrorShot = await screenshot("enable-read-failed-no-retoggle-800-dark");
  await setViewport(420, 560, "dark");
  assert.deepEqual(consoleIssues, [], "No browser console issues occur before the intentionally failed open handshake");
  activationConsoleStart = consoleIssues.length;
  await clickButton("重新读取并打开");
  await waitFor("document.querySelector('.report-row.imported button')?.textContent.includes('立即打开') || document.querySelector('.report-row.imported button')?.textContent.includes('重试打开')");
  await waitFor("document.querySelector('.plugin-open-status,[role=status]')?.textContent.includes('插件未能打开') || document.querySelector('.report-row.imported button')?.textContent.includes('重试打开')");
  const openOutcome = await evaluate(`(()=>({toggleCount:window.pluginImportTransactionFixture.calls.filter(call=>call.command==='toggle_plugin').length,activationCalls:window.pluginImportTransactionFixture.calls.filter(call=>call.command==='activate_feature').length,report:document.querySelector('.report')?.innerText,openRetry:Array.from(document.querySelectorAll('.report-row.imported button')).some(button=>button.textContent.includes('重试打开')),failureCopy:document.querySelector('.report-row.imported [role=status]')?.textContent?.trim()||''}))()`);
  assert.equal(openOutcome.toggleCount, 1, "List-only recovery must not toggle the plugin again");
  assert.equal(openOutcome.activationCalls, 1, "Enabled plugin must use the App's PluginOpenController activation handshake");
  assert.match(openOutcome.report, /成功 1 个，跳过 0 个，失败 1 个/);
  const activationConsoleIssues = consoleIssues.slice(activationConsoleStart);
  assert.deepEqual(activationConsoleIssues, ["error:Plugin activation failed."], "Only the deliberate failed activation emits one expected fixture console error");
  expectedFixtureConsoleIssues = [{ stage, operation: "activate_feature", message: activationConsoleIssues[0] }];
  expectedFixtureConsoleIssueIndexes = [activationConsoleStart];
  const openLayout = await assertReportState("open-retry-status-420x560-dark", "重试打开", ".report-row.imported .report-actions [role=status]");
  const openOutcomeShot = await screenshot("plugin-open-handshake-failure-retry-420-dark");
  checks.push("After native enable succeeds, a failed listing offers only list reread; the confirmed enabled record enters the real App open handshake, and its failure remains retryable without repeating import or enable");

  stage = "retry-only-failed-source-path";
  await fixture("queueImport({imported:['retry-name'],skipped:[],failed:[]})");
  await setViewport(420, 560, "dark");
  await clickButton("重试失败 1 个");
  await waitFor("document.querySelector('.report')?.innerText.includes('成功 2 个，跳过 0 个，失败 0 个')");
  const callsAfterRetry = await importCalls();
  assert.equal(callsAfterRetry.length, 2);
  assert.deepEqual(callsAfterRetry[1].args.paths, ["/fixture/source/retry"]);
  assert.equal(callsAfterRetry[1].args.overwrite, true);
  assert.ok(callsAfterRetry[1].args.paths.includes("/fixture/source/retry"));
  assert.ok(!callsAfterRetry[1].args.paths.includes("/fixture/source/success"));
  const finalLayout = await assertReportState("final-report-420x560-dark", "重试打开", ".report-row.imported .report-actions");
  const finalReportShot = await screenshot("retry-failure-only-final-report-420-dark");
  checks.push("Retry submits exactly report.failed source paths; the prior successful source is absent from the retry call and remains in the cumulative truthful report");

  stage = "leave-and-ignore-late-scan";
  await fixture("planDialog('late-picker')");
  await fixture("planScan('scan_ztools_plugins','late-source-scan')");
  await clickButton("选择目录");
  await waitFor("window.pluginImportTransactionFixture.calls.some(call=>call.command==='plugin:dialog|open'&&call.pendingKey==='late-picker')");
  await fixture("resolveDialog('late-picker','/fixture/late-root')");
  await waitFor("window.pluginImportTransactionFixture.calls.some(call=>call.command==='scan_ztools_plugins'&&call.pendingKey==='late-source-scan')");
  await click('button[aria-label="打开设置"]');
  await waitFor("document.querySelector('.settings-panel')");
  await click('button[aria-label="回到主搜索"]');
  await waitFor("document.querySelector('[data-atools-search-input]')");
  await typeIntoSearch("导入 ZTools 插件");
  await waitFor("document.querySelector('.result-row[data-result-code=\"system:import\"]')");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('.import-panel') && window.pluginImportTransactionFixture.calls.filter(call=>call.command==='scan_default_ztools_plugins').length>=2");
  await waitFor("document.querySelectorAll('.candidate-row').length===3");
  await fixture("resolveScan('late-source-scan',[{path:'/fixture/late/must-not-appear',source_type:'directory',entry_readiness:'ready',name:'late-mutation',title:'迟到扫描不得写入新会话',version:'1',features_count:1,platform_supported:true,main_exists:true,preload_exists:false,logo_exists:false,unsupported_cmd_types:[],warnings:[],errors:[]}])");
  await delay(180);
  assert.equal(await evaluate("document.querySelector('.import-panel')?.innerText.includes('迟到扫描不得写入新会话')"), false);
  assert.equal(await evaluate("document.querySelectorAll('.candidate-row').length"), 3);
  await setViewport(800, 600, "light");
  const freshSession = await screenshot("fresh-session-after-late-scan-800-light");
  checks.push("Leaving unmounts the prior import session; its later scan response cannot replace candidates in the newly opened session");

  stage = "same-installation-key-source-choice";
  sourceChoiceEvidence = await verifyImportSourceChoices({ evaluate, waitFor, fixture, key, click, clickButton, setViewport, screenshot, assertNoOverflow, assertReportState, importCalls });
  checks.push("Same-host-key source/ZPX/ZIP candidates start unselected; natural browser Tab/Space switches exclusive sources, bulk selection preserves the chosen ZPX, exact synthetic IPC path and visible error recovery are checked at 900/420 widths");

  stage = "source-manifest-version-choice";
  sourceManifestEvidence = await verifySourceManifestChoices({ evaluate, waitFor, fixture, key, click, clickButton, wheel, setViewport, screenshot, assertNoOverflow });
  checks.push("Source-build precheck remains provisional; the real manifest choice UI exposes root/public identity versions at wide and narrow widths, natural Tab/Space preserves focus, and each selection is re-inspected before conversion becomes available");

  stage = "final-audit";
  await setViewport(800, 600, "light");
  const wideLayout = await assertNoOverflow("800x600-light-final");
  await setViewport(420, 560, "dark");
  const narrowLayout = await assertNoOverflow("420x560-dark-final");
  const external = requests.find(url => { try { return new URL(url).origin !== origin; } catch { return true; } });
  assert.equal(external, undefined, `Unexpected external request: ${external}`);
  assert.equal(requests.some(url => url.includes("@vite/client") || url.includes("import.meta.hot")), false);
  assert.deepEqual(await fixture("unexpectedCommands"), []);
  assert.deepEqual(navigations, [`${origin}/${compiledFixture.htmlFile}`]);
  const hashesAtEnd = await hashSources();
  assert.deepEqual(hashesAtEnd, sourceHashesAtStart);
  assert.ok(screenshots.length >= 15 && screenshots.length <= 19);
  const browserConsoleEvidence = consoleEvidence();
  assert.deepEqual(browserConsoleEvidence.unexpectedConsoleIssues, []);
  assert.deepEqual(browserConsoleEvidence.expectedFixtureConsoleIssues, [{ stage: "enable-refresh-open-and-disabled-retry-action", operation: "activate_feature", message: "error:Plugin activation failed." }]);
  report = {
    runId, passed: true, stage, scope: "Static production Vite build and preview of the real App/settings/SystemPanel/ZToolsImportPanel. Synthetic local IPC and candidate/inspection TaskRun records only; dialog paths and plugin operations are fixture-owned; no OS picker, conversion, installation, permission flow, network, installed app, or plugin source executes.",
    checks, compiledFixture, initialBusy, pickerBusy, rescanBusy, initialCandidates, afterPartial, stateAfterEnableReadFailure, openOutcome, calls: await fixture("calls"),
    wideLayout, narrowLayout, partialLayout, enableLayout, openLayout, finalLayout, sourceChoiceEvidence, sourceManifestEvidence, navigations, networkRequests: requests,
    ...browserConsoleEvidence, screenshots,
    sourceFilesSha256: sourceHashesAtStart, sourceFilesSha256AtEnd: hashesAtEnd, sourceHashStable: true,
    outcomes: { settingsShot, scanShot, pickerShot, listErrorShot, enableErrorShot, openOutcomeShot, finalReportShot, freshSession },
  };
} catch (error) {
  report = { runId, passed: false, stage, error: error instanceof Error ? error.stack || error.message : String(error), checks, compiledFixture, calls: await fixture("calls").catch(() => []), navigations, networkRequests: requests, ...consoleEvidence(), screenshots,
    sourceFilesSha256: sourceHashesAtStart ?? await hashSources().catch(() => ({})) };
  process.exitCode = 1;
} finally {
  cleanupEvidence.app = page ? await evaluate("window.pluginImportTransactionFixture?.dispose().then(()=>true)").then(value => value ? "fulfilled" : "failed", () => "not_ready") : "not_started";
  cleanupEvidence.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.chrome = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.preview = server ? await Promise.resolve(server.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.build = buildDir ? await rm(buildDir, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanupEvidence).includes("failed")) { process.exitCode = 1; report.passed = false; report.cleanupError = "Owned browser resource cleanup did not complete"; }
  report ??= { runId, passed: false, stage, error: "Runner stopped without report" };
  report.cleanupEvidence = cleanupEvidence;
  report.processExitEvidence = { runnerPid: process.pid, exitCode: process.exitCode ?? 0, externallyObserved: false };
  await writeFile(new URL("report.json", runRoot), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runId, passed: report.passed, stage, checks, screenshots, cleanupEvidence, report: new URL("report.json", runRoot).pathname }));
}
