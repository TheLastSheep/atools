import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { buildPluginOpenOutcomeFixture, previewPluginOpenOutcomeFixture } from "./lib/plugin-open-outcome-preview.mjs";

const root = new URL("../", import.meta.url);
const origin = "http://127.0.0.1:1458";
const fixtureUrl = `${origin}/tests/components/plugin-open-outcome-browser.html`;
const runId = randomUUID();
const output = new URL(`output/launcher-ui-2026-10-15/plugin-open-outcome-${runId}/`, root);
const sourceFiles = [
  "src/App.svelte", "src/components/SettingsPanel.svelte", "src/components/PluginPanel.svelte",
  "src/components/PluginOpenStatus.svelte", "src/styles/settings-responsive.css",
  "src/components/PluginNavigationBar.svelte", "src/lib/pluginOpen.ts", "src/lib/pluginCodeLifecycle.ts",
  "src/lib/types.ts", "src/lib/pluginBrowserWindowBridge.ts", "src/styles/global.css",
  "scripts/lib/plugin-bridge-fixture.mjs", "scripts/lib/plugin-open-outcome-preview.mjs", "scripts/lib/static-browser-fixture.mjs", "tests/components/pluginOpenOutcomeBrowserFixture.ts",
  "tests/components/plugin-open-outcome-browser.html", "scripts/test-plugin-open-outcome-browser.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
];
const checks = [], screenshots = [], requests = [], navigations = [], consoleIssues = [], expectedActivationLogs = [], layoutChecks = [];
const searchTrace = [];
const cleanupEvidence = { cdp: "not_started", chrome: "not_started", vitePreview: "not_started", fixtureBuild: "not_started" };
let server, chrome, page, fixtureBuildDir, stage = "setup", sourceHashesAtStart, report, compiledFixture;
let topNavigationCount = 0;

async function hashSources() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async file => [
    file, createHash("sha256").update(await readFile(resolve(process.cwd(), file))).digest("hex"),
  ])));
}
async function cdp(method, params = {}) {
  return page.send(method, params, { timeoutMs: 12000 });
}
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
async function click(selectorExpression) {
  const point = await evaluate(`(()=>{const e=${selectorExpression};if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,disabled:e.disabled===true,hit:document.elementFromPoint(x,y)===e||e.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point, `Missing click target: ${selectorExpression}`);
  assert.equal(point.disabled, false, `Disabled target: ${selectorExpression}`);
  assert.ok(point.width > 0 && point.height > 0 && point.left >= 0 && point.top >= 0 && point.right <= point.viewportWidth && point.bottom <= point.viewportHeight,
    `Target outside viewport: ${JSON.stringify(point)}`);
  assert.equal(point.hit, true, `Target obscured: ${selectorExpression}`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  await delay(80);
}
async function clickButton(text, parent = "document") {
  await click(`${parent}.querySelectorAll ? Array.from(${parent}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)}) : null`);
}
async function screenshot(name) {
  await cdp("Page.bringToFront");
  await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))),new Promise(resolve=>setTimeout(resolve,1500))])");
  await delay(80);
  const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(shot.data, "base64");
  const file = `${name}-${runId}.png`;
  await writeFile(new URL(file, output), bytes);
  const evidence = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), capturedAt: new Date().toISOString() };
  screenshots.push(evidence);
  return evidence;
}
async function key(keyValue, code, virtualKey) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: keyValue, code, windowsVirtualKeyCode: virtualKey });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: keyValue, code, windowsVirtualKeyCode: virtualKey });
  await delay(80);
}
async function captureSearchState(label) {
  const state = await evaluate(`(()=>{const input=document.querySelector('[role=combobox]'),active=document.activeElement,rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'}},value=input?.value||'';return {url:location.pathname,searchInput:{present:Boolean(input),value:value==='设置'?'设置':value?'<other-nonempty>':'',expanded:input?.getAttribute('aria-expanded')||null,visible:rect(input),focused:active===input},activeElement:active?{tag:active.tagName,role:active.getAttribute('role'),ariaLabel:active.getAttribute('aria-label'),placeholder:active.getAttribute('placeholder'),className:typeof active.className==='string'?active.className:''}:null,selectedOptions:Array.from(document.querySelectorAll('[role=option][aria-selected=true]')).map(e=>e.textContent.trim().slice(0,60)),visibleOptions:Array.from(document.querySelectorAll('[role=option]')).slice(0,8).map(e=>e.textContent.trim().slice(0,60)),homeSurface:Boolean(document.querySelector('.search-surface')),settingsSurface:Boolean(document.querySelector('.settings-panel')),settingsHeading:document.querySelector('.settings-panel h3')?.textContent||null,shellContent:{present:Boolean(document.querySelector('.shell-content')),children:document.querySelector('.shell-content')?.children.length||0}}})()`);
  searchTrace.push({ label, state });
  return state;
}
async function openSettings(timeoutMs = 12000) {
  await captureSearchState("before-settings-search");
  await click("document.querySelector('[role=combobox]')");
  await captureSearchState("after-search-focus");
  await cdp("Input.insertText", { text: "设置" });
  await captureSearchState("after-search-input");
  await waitFor("Array.from(document.querySelectorAll('[role=option][aria-selected=true]')).some(e=>e.textContent.includes('设置'))", timeoutMs);
  await captureSearchState("settings-option-selected");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('.settings-panel h3')?.textContent==='通用设置概览'", timeoutMs);
}
async function installAndEnable(title) {
  await clickButton("已安装插件", "document.querySelector('.settings-sidebar')");
  await waitFor("document.querySelector('.settings-content')?.innerText.includes('插件库存概览')");
  await clickButton("安装插件", "document.querySelector('.settings-content')");
  await waitFor("window.pluginOpenOutcomeFixture.calls.some(c=>c.command==='install_plugin')");
  await waitFor(`Array.from(document.querySelectorAll('.plugin-inventory-row')).some(row=>row.innerText.includes(${JSON.stringify(title)})&&Array.from(row.querySelectorAll('button')).some(b=>b.textContent.trim()==='已停用'))`);
  await clickButton("已停用", `Array.from(document.querySelectorAll('.plugin-inventory-row')).find(row=>row.innerText.includes(${JSON.stringify(title)}))`);
  await waitFor("Array.from(document.querySelectorAll('[role=dialog]')).some(dialog=>dialog.querySelector('#settings-confirm-title')?.textContent.trim()==='授权启用插件')");
  await clickButton("授权启用", "document.querySelector('[role=dialog]')");
  await waitFor(`Array.from(document.querySelectorAll('.plugin-inventory-row')).some(row=>row.innerText.includes(${JSON.stringify(title)})&&Array.from(row.querySelectorAll('button')).some(b=>b.textContent.trim()==='已启用'))`);
  await waitFor("Array.from(document.querySelectorAll('.action-status button')).some(b=>b.textContent.trim()==='立即打开')");
}
async function viewport(width, height) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await waitFor(`innerWidth===${width}&&innerHeight===${height}`);
  await delay(160);
}
async function prepareStatusCapture(width) {
  await evaluate("document.querySelector('[data-plugin-open-status]')?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })");
  await delay(120);
  const layout = await evaluate(`(()=>{const nav=document.querySelector('.settings-sidebar'),content=document.querySelector('.settings-content'),status=document.querySelector('[data-plugin-open-status]'),button=status?.querySelector('button'),openMessage=status?.querySelector('.open-message'),box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}},buttonStyle=button?getComputedStyle(button):null,overflow=[['settings-panel',document.querySelector('.settings-panel')],['settings-sidebar',nav],['settings-content',content],['content-panel',document.querySelector('.content-panel')],['action-status',status]].filter(([,e])=>e&&e.scrollWidth>e.clientWidth+1).map(([name])=>name);return {viewportWidth:innerWidth,settingsContent:box(content),nav:box(nav),navHasHorizontalOverflow:Boolean(nav&&nav.scrollWidth>nav.clientWidth+1),status:box(status),statusFullyVisible:Boolean(status&&status.getBoundingClientRect().top>=0&&status.getBoundingClientRect().bottom<=innerHeight),openMessageText:openMessage?.textContent.trim()||null,button:button?{text:button.textContent.trim(),width:box(button)?.width,height:box(button)?.height,whiteSpace:buttonStyle?.whiteSpace,disabled:button.disabled,singleLine:Boolean(button.scrollHeight<=button.clientHeight+1)}:null,globalActivationAlerts:document.querySelectorAll('.plugin-activation-error[role=alert]').length,horizontalOverflow:overflow}})()`);
  assert.ok(layout.settingsContent?.width >= (width <= 640 ? 350 : 0), `Settings content too narrow: ${JSON.stringify(layout)}`);
  assert.equal(layout.statusFullyVisible, true, `Plugin open status was not fully scrolled into view: ${JSON.stringify(layout)}`);
  assert.equal(layout.globalActivationAlerts, 0, "Controller-owned failure must not render a duplicate launcher alert");
  assert.ok(layout.button, `Expected the recent-install open action: ${JSON.stringify(layout)}`);
  assert.equal(layout.button.whiteSpace, "nowrap");
  assert.equal(layout.button.singleLine, true, `Plugin open action wrapped: ${JSON.stringify(layout)}`);
  if (width <= 640) {
    assert.ok(layout.navHasHorizontalOverflow, `Compact navigation should own horizontal scrolling: ${JSON.stringify(layout)}`);
    assert.deepEqual(layout.horizontalOverflow, ["settings-sidebar"], `Only the compact navigation may overflow horizontally: ${JSON.stringify(layout)}`);
  }
  return layout;
}

try {
  await mkdir(output, { recursive: true });
  sourceHashesAtStart = await hashSources();
  fixtureBuildDir = await mkdtemp(join(tmpdir(), `atools-plugin-open-outcome-${runId}-`));
  stage = "build-static-fixture";
  compiledFixture = await buildPluginOpenOutcomeFixture({
    projectRoot: process.cwd(),
    entryHtml: "tests/components/plugin-open-outcome-browser.html",
    outDir: join(fixtureBuildDir, "dist"),
  });
  server = await previewPluginOpenOutcomeFixture({ projectRoot: process.cwd(), outDir: join(fixtureBuildDir, "dist"), host: "127.0.0.1", port: 1458 });
  chrome = await launchChrome();
  const pageUrl = await createPageWebSocketUrl(chrome.webSocketUrl);
  page = await CdpClient.connect(pageUrl);
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (!["error", "warning", "assert"].includes(type)) return;
    const entry = `${type}:${formatConsoleArgs(args)}`;
    if (type === "error" && entry === "error:Plugin activation failed.") expectedActivationLogs.push(entry);
    else consoleIssues.push(entry);
  });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  page.on("Page.frameNavigated", event => { if (!event.frame.parentId) { navigations.push(event.frame.url); topNavigationCount += 1; } });
  await viewport(800, 600);
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: fixtureUrl }); await loaded;
  await waitFor("window.pluginOpenOutcomeFixture && document.querySelector('[role=combobox]')");
  assert.equal(topNavigationCount, 1, "Built fixture must stay on its single initial navigation");
  assert.equal(await evaluate("Boolean(document.querySelector('.search-surface'))"), true, "Synthetic App must start on Home before the real search flow");
  checks.push(`Static Vite test-fixture bundle was built before preview (${compiledFixture.chunkCount} JS chunks, ${compiledFixture.assetCount} assets); the real App starts on Home after exactly one navigation, without dev optimizer or HMR`);
  stage = "settings-plugin-management-install-enable";
  await openSettings();
  await installAndEnable("打开失败后可重试");
  const firstId = await evaluate("window.pluginOpenOutcomeFixture.calls.find(c=>c.command==='install_plugin')?.args?.path");
  assert.equal(firstId, "/synthetic/plugins/plugin-open-outcome/plugin-1");
  checks.push("Actual App search opens Settings > installed-plugin management; the synthetic directory install and explicit authorization enable the plugin and reveal the recent-install action");

  stage = "first-open-pending-and-single-flight";
  await clickButton("立即打开", "document.querySelector('.action-status')");
  await waitFor("window.pluginOpenOutcomeFixture.pendingFirst===true");
  await viewport(800, 600);
  layoutChecks.push({ state: "pending", ...await prepareStatusCapture(800) });
  await screenshot("open-pending-800x600-light");
  const pendingText = await evaluate("document.querySelector('.action-status')?.innerText");
  assert.match(pendingText, /正在打开/);
  await viewport(420, 560);
  layoutChecks.push({ state: "pending", ...await prepareStatusCapture(420) });
  await screenshot("open-pending-420x560-light");
  const pendingClick = await evaluate(`(()=>{const row=document.querySelector('.action-status'),button=row?.querySelector('button');if(!button)return null;button.click();return {disabled:button.disabled,busy:button.getAttribute('aria-busy'),activationCalls:window.pluginOpenOutcomeFixture.calls.filter(c=>c.command==='activate_feature').length}})()`);
  assert.deepEqual(pendingClick, { disabled: true, busy: "true", activationCalls: 1 });
  await evaluate("window.pluginOpenOutcomeFixture.rejectFirst()");
  await waitFor("document.querySelector('.action-status .open-message[role=status]')?.textContent.includes('插件未能打开')");
  assert.equal(await evaluate("window.pluginOpenOutcomeFixture.calls.filter(c=>c.command==='activate_feature').length"), 1);
  checks.push("While activation is pending, the real button is disabled and a repeated DOM click issues no duplicate activation; the fixed synthetic rejection is then surfaced as a retryable status");

  stage = "first-open-failed-visible";
  await viewport(800, 600);
  layoutChecks.push({ state: "failed", ...await prepareStatusCapture(800) });
  await screenshot("open-failed-800x600-light");
  const failureState = await evaluate(`(()=>({status:document.querySelector('.action-status .open-message[role=status]')?.textContent,button:document.querySelector('.action-status button')?.textContent.trim(),disabled:document.querySelector('.action-status button')?.disabled,rawErrorVisible:document.querySelector('.action-status')?.innerText.includes('Synthetic activation rejection')}))()`);
  assert.deepEqual(failureState, { status: "插件未能打开，请检查插件状态后重试。", button: "重试打开", disabled: false, rawErrorVisible: false });
  await viewport(420, 560);
  layoutChecks.push({ state: "failed", ...await prepareStatusCapture(420) });
  await screenshot("open-failed-420x560-light");

  stage = "retry-commit-and-single-panel";
  await clickButton("重试打开", "document.querySelector('.action-status')");
  await waitFor("document.querySelector('iframe[title=\"Plugin\"]')");
  await waitFor("document.querySelector('[data-plugin-feature-code]')?.textContent==='fixture-open-feature'");
  const committed = await evaluate(`(()=>({count:document.querySelectorAll('iframe[title="Plugin"]').length,feature:document.querySelector('[data-plugin-feature-code]')?.textContent,activationCalls:window.pluginOpenOutcomeFixture.calls.filter(c=>c.command==='activate_feature').length,owner:window.pluginOpenOutcomeFixture.calls.filter(c=>c.command==='activate_feature').at(-1)?.args?.expectedPluginId,openButton:document.querySelector('.action-status button')?.textContent||null}))()`);
  assert.deepEqual(committed, { count: 1, feature: "fixture-open-feature", activationCalls: 2, owner: "fixture-open-retry", openButton: null });
  checks.push("The explicit retry reaches native activate_feature with the exact plugin owner; App commits one real PluginPanel and consumes the recent-open entry only after activation acceptance");

  stage = "leave-pending-and-ignore-late-result";
  await key("Escape", "Escape", 27);
  await waitFor("document.querySelector('[role=combobox]')");
  await openSettings();
  await installAndEnable("离开后取消挂载");
  await clickButton("立即打开", "document.querySelector('.action-status')");
  await waitFor("window.pluginOpenOutcomeFixture.pendingLeave===true");
  await click("document.querySelector('button[aria-label=\"关闭设置\"]')");
  await waitFor("!document.querySelector('.settings-panel')");
  await evaluate("window.pluginOpenOutcomeFixture.resolveLeave()");
  await delay(300);
  const lateResult = await evaluate(`({panelCount:document.querySelectorAll('iframe[title="Plugin"]').length,featureCode:document.querySelector('[data-plugin-feature-code]')?.textContent||null,activationCalls:window.pluginOpenOutcomeFixture.calls.filter(c=>c.command==='activate_feature').length,settingsVisible:Boolean(document.querySelector('.settings-panel'))})`);
  assert.deepEqual(lateResult, { panelCount: 0, featureCode: null, activationCalls: 3, settingsVisible: false });
  assert.equal(topNavigationCount, 1, "Static preview must not trigger a late navigation during the acceptance flow");
  checks.push("Leaving Settings while a second plugin activation is pending cancels the open; its later synthetic success cannot mount or replace the current App view");

  const external = requests.find(url => { try { return new URL(url).origin !== origin; } catch { return true; } });
  assert.equal(external, undefined, `External network request: ${external}`);
  assert.deepEqual(consoleIssues, []);
  assert.deepEqual(expectedActivationLogs, ["error:Plugin activation failed."], "Only the fixed, expected activation rejection may be logged");
  checks.push("The synthetic activation rejection emits only App's fixed generic log; no plugin payload, rejection body, warning, or unrelated runtime error reaches the page console");
  const unexpectedCommands = await evaluate("window.pluginOpenOutcomeFixture.unexpectedCommands");
  assert.deepEqual(unexpectedCommands, [], "Every native IPC command must be explicitly handled by the synthetic fixture");
  const sourceHashesAtEnd = await hashSources();
  assert.deepEqual(sourceHashesAtEnd, sourceHashesAtStart, "Fixture source changed during browser run");
  report = { runId, passed: true, stage, scope: "Real App and SettingsPanel rendered from a prebuilt local Vite test-fixture bundle in headless Chromium with synthetic Tauri IPC only. No external market, download, plugin package, Node sidecar, OS picker, or native host operation.", checks, compiledFixture, topNavigationCount, searchTrace, failureState, pendingClick, committed, lateResult, layoutChecks, networkRequests: requests, navigations, consoleIssues, expectedActivationLogs, unexpectedCommands, sourceFilesSha256: sourceHashesAtStart, sourceFilesSha256AtEnd: sourceHashesAtEnd, sourceHashStable: true, screenshots };
} catch (error) {
  const state = await evaluate(`(()=>{const input=document.querySelector('[role=combobox]'),active=document.activeElement,rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),visible:r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'&&getComputedStyle(e).display!=='none'}},value=input?.value||'';return {url:location.pathname,searchInput:{present:Boolean(input),value:value==='设置'?'设置':value?'<other-nonempty>':'',expanded:input?.getAttribute('aria-expanded')||null,visible:rect(input),focused:active===input},activeElement:active?{tag:active.tagName,role:active.getAttribute('role'),ariaLabel:active.getAttribute('aria-label'),placeholder:active.getAttribute('placeholder'),className:typeof active.className==='string'?active.className:''}:null,dialogs:Array.from(document.querySelectorAll('[role=dialog]')).map(e=>({labelledBy:e.getAttribute('aria-labelledby'),title:e.querySelector('h3')?.textContent.trim()||null,visible:rect(e),buttons:Array.from(e.querySelectorAll('button')).map(b=>b.textContent.trim())})),selectedOptions:Array.from(document.querySelectorAll('[role=option][aria-selected=true]')).map(e=>e.textContent.trim().slice(0,60)),visibleOptions:Array.from(document.querySelectorAll('[role=option]')).slice(0,8).map(e=>e.textContent.trim().slice(0,60)),homeSurface:Boolean(document.querySelector('.search-surface')),settingsSurface:Boolean(document.querySelector('.settings-panel')),settingsHeading:document.querySelector('.settings-panel h3')?.textContent||null,shellContent:{present:Boolean(document.querySelector('.shell-content')),children:document.querySelector('.shell-content')?.children.length||0},fixtureCalls:window.pluginOpenOutcomeFixture?.calls.map(c=>c.command)??[]}})()`).catch(() => ({ unavailable: true }));
  report = { runId, passed: false, stage, error: error instanceof Error ? error.message : String(error), checks, state, searchTrace, compiledFixture, layoutChecks, networkRequests: requests, navigations, consoleIssues, expectedActivationLogs, screenshots, sourceFilesSha256: sourceHashesAtStart ?? await hashSources().catch(() => ({})) };
  process.exitCode = 1;
} finally {
  cleanupEvidence.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.chrome = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.vitePreview = server ? await Promise.resolve(server.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanupEvidence.fixtureBuild = fixtureBuildDir ? await rm(fixtureBuildDir, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanupEvidence).includes("failed")) {
    process.exitCode = 1;
    report ??= { runId, stage, error: "Runner exited before report creation" };
    report.passed = false;
    report.cleanupError = "One or more owned browser resources did not confirm cleanup";
  }
  report ??= { runId, passed: false, stage, error: "Runner exited before report creation" };
  report.cleanupEvidence = cleanupEvidence;
  report.processExitEvidence = { runnerPid: process.pid, exitCode: process.exitCode ?? 0, externallyObserved: false };
  await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
  await writeFile(new URL(`report-${runId}.json`, output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runId, passed: report.passed, stage: report.stage, checks, screenshots, cleanupEvidence }));
}
