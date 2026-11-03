import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome, launchViteServer } from "./chrome-cdp-smoke-utils.mjs";

const origin = "http://127.0.0.1:1454";
const output = new URL("../output/launcher-ui-2026-10-15/", import.meta.url);
const fixtureUrl = `${origin}/tests/components/plugin-market-target-browser.html`;
let server, chrome, page;
let stage = "setup";
const checks = [], consoleIssues = [], requests = [], navigations = [];
const timedOutCommands = [];
const runId = new Date().toISOString().replaceAll(":", "-");
const progressName = `plugin-market-target-browser-progress-${runId}.jsonl`;
const progressPath = new URL(progressName, output);
const screenshots = [];
const sourceFiles = [
  "src/App.svelte",
  "src/components/SystemPanel.svelte",
  "src/components/SettingsPanel.svelte",
  "src/components/PluginMarketPanel.svelte",
  "src/components/PluginMarketTargetNotice.svelte",
  "src/components/PluginMarketSourceAction.svelte",
  "src/components/ZToolsImportPanel.svelte",
  "src/components/ZToolsImportCandidateRow.svelte",
  "src/lib/pluginMarketController.ts",
  "src/lib/pluginMarketInstallIntent.ts",
  "src/lib/settingsConfirmFocus.ts",
  "src/lib/modalFocusOwner.ts",
  "src/lib/permissionDialogFocus.ts",
  "src/lib/pluginMarketSession.ts",
  "src/lib/pluginMarketView.ts",
  "src/lib/pluginMarketStatus.ts",
  "src/lib/pluginMarketTarget.ts",
  "src/lib/ztoolsImportView.ts",
  "src/lib/pluginMarketNavigation.ts",
  "src/styles/global.css",
  "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs",
  "scripts/lib/owned-vite-cli-worker.mjs",
  "scripts/test-plugin-market-recovery-browser.mjs",
  "tests/components/pluginMarketRecoveryBrowserFixture.ts",
  "tests/components/plugin-market-target-browser.html",
];
async function sourceFilesSha256() {
  const hashes = {};
  for (const file of sourceFiles) {
    const bytes = await readFile(resolve(process.cwd(), file));
    hashes[file] = createHash("sha256").update(bytes).digest("hex");
  }
  return hashes;
}
const cleanupEvidence = { cdp: { attempted: false, status: "not_started" }, chrome: { status: "not_started" }, vite: { status: "not_started" } };
let successReport;
let failureReport;
let sourceHashesAtStart;
async function checkpoint(event, details = {}) {
  const entry = { timestamp: new Date().toISOString(), stage, event, details };
  console.log(JSON.stringify({ checkpoint: entry }));
  await appendFile(progressPath, JSON.stringify(entry) + "\n");
}
async function withDeadline(label, promise, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out during ${label} after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
async function withOwnedDeadline(label, promise, timeoutMs, cleanup) {
  const owned = Promise.resolve(promise);
  try { return await withDeadline(label, owned, timeoutMs); }
  catch (error) {
    owned.then(resource => cleanup(resource)).catch(() => {});
    throw error;
  }
}

async function cdp(method, params = {}, timeoutMs = 10000) {
  const phase = stage;
  await checkpoint("cdp-before", { phase, method, expression: method === "Runtime.evaluate" ? String(params.expression ?? "").slice(0, 160) : undefined });
  try {
    const result = await withDeadline(`CDP ${method} during ${phase}`, page.send(method, params, { timeoutMs }), timeoutMs + 250);
    await checkpoint("cdp-after", { phase, method });
    return result;
  } catch (error) {
    const details = { phase, method, error: error instanceof Error ? error.message : String(error), pendingCount: page?.pending?.size ?? null };
    if (String(details.error).includes("Timed out")) timedOutCommands.push({ ...details, expression: method === "Runtime.evaluate" ? String(params.expression ?? "").slice(0, 500) : undefined });
    await checkpoint("cdp-error", details);
    throw error;
  }
}

async function evaluate(expression, timeoutMs = 12000) {
  const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text);
  return response.result.value;
}
async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await evaluate(expression);
    if (result) return result;
    await delay(35);
  }
  assert.fail(`Timed out waiting for ${expression}`);
}
async function clickAt(selectorExpression) {
  const point = await evaluate(`(()=>{const e=${selectorExpression};if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect();const x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,viewportWidth:innerWidth,viewportHeight:innerHeight,disabled:e.disabled===true,hit:document.elementFromPoint(x,y)===e||e.contains(document.elementFromPoint(x,y))}})()`);
  assert.ok(point, `Missing click target: ${selectorExpression}`);
  assert.equal(point.disabled, false, `Click target is disabled: ${selectorExpression}`);
  assert.ok(point.width > 0 && point.height > 0 && point.left >= 0 && point.top >= 0 && point.right <= point.viewportWidth && point.bottom <= point.viewportHeight,
    `Click target is outside the viewport: ${JSON.stringify(point)}`);
  assert.equal(point.hit, true, `Click point is covered by another element: ${selectorExpression}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
  await delay(60);
}
async function clickButton(text) {
  await clickAt(`Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`);
}
async function screenshot(name) {
  const captureStartedAt = new Date().toISOString();
  const artifactName = name.replace(/\.png$/, `-${runId}.png`);
  await cdp("Page.bringToFront");
  const frameResult = await evaluate("Promise.race([new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve('raf')))),new Promise(resolve=>setTimeout(()=>resolve('raf-timeout'),1800))])", 2500)
    .catch(async error => { await checkpoint("raf-wait-fallback", { name, error: error instanceof Error ? error.message : String(error) }); return "evaluate-timeout"; });
  if (frameResult !== "raf") {
    await checkpoint("raf-wait-fallback", { name, result: frameResult, visibilityState: await evaluate("document.visibilityState").catch(() => "unavailable") });
    await delay(100);
  }
  await delay(120);
  let shot;
  try {
    shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 3500);
  } catch (error) {
    await checkpoint("screenshot-retry", { name: artifactName, firstAttempt: error instanceof Error ? error.message : String(error) });
    shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, 12000);
  }
  const bytes = Buffer.from(shot.data, "base64");
  const dimensions = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  await writeFile(new URL(artifactName, output), bytes);
  const evidence = { file: artifactName, captureStartedAt, capturedAt: new Date().toISOString(), bytes: bytes.length, dimensions };
  screenshots.push(evidence);
  await checkpoint("screenshot-saved", evidence);
  return evidence;
}
async function key(key, code, virtualKey) {
  const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
  if (key === " ") {
    await cdp("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: virtualKey });
    await cdp("Input.dispatchKeyEvent", { type: "char", key, code, windowsVirtualKeyCode: virtualKey, text, unmodifiedText: text });
  } else {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, text, unmodifiedText: text });
  }
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey });
  await delay(80);
}
async function searchForImport() {
  await evaluate("document.querySelector('[role=combobox]').focus()");
  await cdp("Input.insertText", { text: "导入 ZTools 插件" });
  await waitFor("Array.from(document.querySelectorAll('[role=option][aria-selected=true]')).some(e=>e.textContent.includes('导入 ZTools 插件'))");
  await key("Enter", "Enter", 13);
  const routeState = await evaluate("JSON.stringify({query:document.querySelector('[role=combobox]')?.value,system:document.querySelector('.system-panel')?.innerText.slice(0,700),candidate:document.querySelector('.candidate-row')?.innerText,recovery:document.querySelector('.market-recovery')?.innerText})");
  await checkpoint("launcher-option-selected", routeState);
  await waitFor("document.querySelector('.import-panel') && document.querySelector('.market-recovery')");
}
async function activateRecoveryWith(keyName) {
  const target = await evaluate("document.querySelector('.market-recovery')");
  assert.ok(target);
  await evaluate("document.querySelector('.market-recovery').focus()");
  assert.equal(await evaluate("document.activeElement===document.querySelector('.market-recovery')"), true);
  await evaluate(`(()=>{window.__marketRecoveryKeyEvents=[];for(const type of ['keydown','keyup','click'])for(const capture of [true,false])window.addEventListener(type,e=>{if(e.target?.closest?.('.market-recovery'))window.__marketRecoveryKeyEvents.push({type,phase:capture?'capture':'bubble',key:e.key,code:e.code,keyCode:e.keyCode,target:e.target?.tagName,active:document.activeElement?.className,hasFocus:document.hasFocus(),visibilityState:document.visibilityState,defaultPrevented:e.defaultPrevented})},capture)})()`);
  await key(keyName, keyName === "Enter" ? "Enter" : "Space", keyName === "Enter" ? 13 : 32);
  await checkpoint("recovery-native-events", await evaluate("JSON.stringify({events:window.__marketRecoveryKeyEvents,active:document.activeElement?.outerHTML?.slice(0,300),hasFocus:document.hasFocus(),visibilityState:document.visibilityState})"));
  await waitFor("document.querySelector('.recovery-card strong')?.textContent.includes('regex-editor')");
  await waitFor("document.querySelector('.plugin-market-catalog-list .plugin-row')");
}
async function marketGeometry() {
  return evaluate(`(()=>{
    const root=document.querySelector('.market-panel'),line=document.querySelector('.source-line'),sourceButton=line?.querySelector('button');
    const children=[...(root?.children||[])].filter(e=>getComputedStyle(e).display!=='none');
    const rects=children.map(e=>({name:e.className||e.tagName,r:e.getBoundingClientRect().toJSON()}));
    const overlaps=[];
    for(let i=0;i<children.length;i++)for(let j=i+1;j<children.length;j++){
      const a=children[i].getBoundingClientRect(),b=children[j].getBoundingClientRect();
      if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1)overlaps.push([rects[i].name,rects[j].name]);
    }
    const button=sourceButton?.getBoundingClientRect();
    return {viewport:{width:innerWidth,height:innerHeight},documentWidth:document.documentElement.scrollWidth,
      sourceButton:button?.toJSON(),sourceButtonFits:Boolean(button&&button.left>=0&&button.right<=innerWidth),overlaps,children:rects};
  })()`);
}
async function openTargetWithSpace() {
  await clickAt("document.querySelector('button.return-button[aria-label=\"回到主搜索\"]')");
  await waitFor("(()=>{const input=document.querySelector('[role=combobox]');return Boolean(input&&document.activeElement===input)})()");
  await searchForImport();
  await activateRecoveryWith(" ");
}

try {
  await mkdir(output, { recursive: true });
  await checkpoint("launch-vite-before");
  server = await withOwnedDeadline("launchViteServer", launchViteServer({ port: 1454, probeUrl: `${origin}/` }), 30000, resource => resource.close());
  await checkpoint("launch-vite-after");
  await checkpoint("launch-chrome-before");
  chrome = await withOwnedDeadline("launchChrome", launchChrome(), 15000, resource => resource.close());
  await checkpoint("launch-chrome-after");
  await checkpoint("create-page-websocket-before");
  const pageWebSocketUrl = await withDeadline("createPageWebSocketUrl", createPageWebSocketUrl(chrome.webSocketUrl), 8000);
  await checkpoint("create-page-websocket-after");
  page = await withOwnedDeadline("CdpClient.connect", CdpClient.connect(pageWebSocketUrl), 8000, resource => resource.close());
  await checkpoint("cdp-connected");
  stage = "enable-cdp-domains";
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (["error", "warning", "assert"].includes(type)) consoleIssues.push(`${type}:${formatConsoleArgs(args)}`); });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  page.on("Page.frameNavigated", event => { if (!event.frame.parentId) navigations.push(event.frame.url); });
  stage = "navigate-fixture";
  await cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: fixtureUrl }); await loaded;
  await waitFor("window.pluginMarketRecoveryFixture && document.querySelector('[role=combobox]')");
  await waitFor("document.querySelector('[role=combobox]')");
  sourceHashesAtStart = await sourceFilesSha256();
  stage = "open-importer";
  await searchForImport();
  await screenshot("plugin-market-target-import-800x600.png");
  const importGeometry = await evaluate(`(()=>{const rows=[...document.querySelectorAll('.candidate-row')],cta=document.querySelector('.market-recovery'),r=cta.getBoundingClientRect();return {rows:rows.length,cta:{x:r.x,y:r.y,width:r.width,height:r.height},viewport:{width:innerWidth,height:innerHeight},widthFits:document.documentElement.scrollWidth<=innerWidth}})()`);
  assert.equal(importGeometry.rows, 1); assert.ok(importGeometry.cta.height >= 32); assert.equal(importGeometry.widthFits, true);
  checks.push("Real App launcher search opens SystemPanel import and displays the synthetic requires_build candidate");

  stage = "official-market-enter-navigation";
  await activateRecoveryWith("Enter");
  const targetIds = await evaluate("Array.from(document.querySelectorAll('.plugin-market-catalog-list .plugin-row code')).map(e=>e.textContent.trim())");
  assert.deepEqual(targetIds, ["regex-editor"], "target filter must use exact market ID rather than the similar display title");
  const targetGeometry = await marketGeometry();
  assert.equal(targetGeometry.documentWidth <= 800, true); assert.equal(targetGeometry.sourceButtonFits, true); assert.deepEqual(targetGeometry.overlaps, []);
  await screenshot("plugin-market-target-result-800x600.png");
  const initialCounts = await evaluate(`(()=>{const calls=window.pluginMarketRecoveryFixture.calls,target=calls.find(c=>c.command==='fetch_official_plugin_target');return {target:calls.filter(c=>c.command==='fetch_official_plugin_target').length,targetPluginId:target?.args?.pluginId,catalog:calls.filter(c=>c.command==='fetch_plugin_market_catalog').length,resolver:calls.filter(c=>c.command==='resolve_plugin_market_download').length,install:calls.filter(c=>c.command==='install_plugin_from_market').length,source:document.querySelector('.source-line code')?.textContent.trim()}})()`);
  assert.deepEqual(initialCounts, { target: 1, targetPluginId: "regex-editor", catalog: 0, resolver: 0, install: 0, source: "https://z-tools.top/api/market" });
  checks.push("Enter activates the native CTA, fetches one exact official target by manifest ID without loading the aggregate catalog, and starts no package resolution or install");

  stage = "clear-target-and-search";
  await clickButton("查看官方目录");
  await waitFor("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length===2");
  const catalogAfterClear = await evaluate(`(()=>{const calls=window.pluginMarketRecoveryFixture.calls;return {target:calls.filter(c=>c.command==='fetch_official_plugin_target').length,catalog:calls.filter(c=>c.command==='fetch_plugin_market_catalog').length}})()`);
  assert.deepEqual(catalogAfterClear, { target: 1, catalog: 1 }, "aggregate official catalog is fetched only after the user clears the exact target");
  await evaluate(`(()=>{const e=document.querySelector('[aria-label="搜索本次目录"]');e.value='no matching synthetic item';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:e.value}));})()`);
  await waitFor("document.querySelector('.market-panel')?.innerText.includes('本次目录没有匹配的条目')");
  assert.equal(await evaluate("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length"), 0);
  checks.push("Clearing the target exposes the current official catalog and an empty search explains when nothing matches");
  await evaluate(`(()=>{const e=document.querySelector('[aria-label="搜索本次目录"]');e.value='';e.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'deleteContentBackward',data:null}));})()`);
  await waitFor("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length===2");
  stage = "restore-custom-market-source";
  await clickButton("恢复我的来源");
  await waitFor("document.querySelector('.source-line code')?.textContent.includes('fixture.invalid/custom-market')");
  await waitFor("document.querySelector('.plugin-market-catalog-list code')?.textContent==='custom-only'");
  const persistence = await evaluate(`(()=>({custom:JSON.parse(localStorage.getItem('atools:settings-general')).pluginMarketCustom,url:JSON.parse(localStorage.getItem('atools:settings-general')).pluginMarketUrl,persistCalls:window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='set_setting').map(c=>c.args?.value)}))()`);
  assert.equal(persistence.custom, true); assert.equal(persistence.url, "https://fixture.invalid/custom-market");
  assert.ok(persistence.persistCalls.every(value => { const parsed=JSON.parse(String(value)); return parsed.pluginMarketCustom===true&&parsed.pluginMarketUrl==="https://fixture.invalid/custom-market"; }));
  checks.push("Restoring the saved custom source returns the mock custom catalog without changing its persisted URL");

  await openTargetWithSpace();
  const compactGeometry = await evaluate(`(()=>{const row=document.querySelector('.plugin-market-catalog-list .plugin-row'),source=document.querySelector('.source-line'),buttons=[...document.querySelectorAll('.market-panel button')];return {width:document.documentElement.scrollWidth,viewport:innerWidth,rowCount:document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length,sourceButton:source?.querySelector('button')?.getBoundingClientRect().toJSON(),sourceFits:Boolean(source&&source.getBoundingClientRect().right<=innerWidth),buttonRects:buttons.map(b=>({text:b.textContent.trim(),rect:b.getBoundingClientRect().toJSON(),disabled:b.disabled}))}})()`);
  stage = "compact-market-viewport";
  await cdp("Emulation.setDeviceMetricsOverride", { width: 480, height: 400, deviceScaleFactor: 1, mobile: false });
  await cdp("Page.bringToFront");
  await waitFor("innerWidth===480");
  await delay(180);
  await screenshot("plugin-market-target-result-480x400.png");
  const smallGeometry = await marketGeometry();
  assert.equal(await evaluate("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length"), 1);
  assert.equal(smallGeometry.documentWidth <= 480, true, JSON.stringify(smallGeometry));
  assert.equal(smallGeometry.sourceButtonFits, true); assert.deepEqual(smallGeometry.overlaps, []);
  checks.push("Space activates the CTA through Chromium key input; the 480x400 market has no horizontal overflow or overlapping content and can scroll vertically");

  stage = "compact-open-market-source";
  await clickButton("打开来源");
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('已打开插件市场地址')");
  await evaluate("document.querySelector('.market-source-action')?.scrollIntoView({block:'center',inline:'nearest'})");
  const sourceOpen = await evaluate(`(()=>{const c=window.pluginMarketRecoveryFixture.calls.findLast(c=>c.command==='call_agent_tool'&&c.args?.name==='open_url'),action=document.querySelector('.market-source-action'),button=action?.querySelector('button'),status=action?.querySelector('[role=status]'),b=button?.getBoundingClientRect(),s=status?.getBoundingClientRect(),overlaps=Boolean(b&&s&&Math.min(b.right,s.right)-Math.max(b.left,s.left)>1&&Math.min(b.bottom,s.bottom)-Math.max(b.top,s.top)>1);return {url:c?.args?.arguments?.url,geometry:{width:document.documentElement.scrollWidth,viewport:innerWidth,height:innerHeight,button:b?.toJSON(),status:s?.toJSON(),buttonVisible:Boolean(b&&b.top>=0&&b.bottom<=innerHeight),statusVisible:Boolean(s&&s.top>=0&&s.bottom<=innerHeight),overlaps,horizontalOverflow:document.documentElement.scrollWidth>innerWidth}}})()`);
  assert.equal(sourceOpen.url, "https://z-tools.top/api/market");
  assert.equal(sourceOpen.geometry.horizontalOverflow, false);
  assert.equal(sourceOpen.geometry.buttonVisible, true);
  assert.equal(sourceOpen.geometry.statusVisible, true);
  assert.equal(sourceOpen.geometry.overlaps, false);
  assert.ok(sourceOpen.geometry.button.left >= 0 && sourceOpen.geometry.button.right <= sourceOpen.geometry.viewport);
  await screenshot("plugin-market-target-source-480x400.png");
  checks.push("The compact source action calls only the mocked open_url capability; after scrolling, its button and status are visible without overlap or horizontal overflow");

  stage = "target-unavailable-states";
  const targetCallsBeforeBranches = await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='fetch_official_plugin_target').length");
  const catalogCallsBeforeBranches = await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='fetch_plugin_market_catalog').length");
  await evaluate("window.pluginMarketRecoveryFixture.setTargetMode('not_found')");
  await clickButton("刷新发布信息");
  await waitFor("document.querySelector('[aria-label=\"未找到官方发布信息\"]')");
  assert.equal(await evaluate("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length"), 0);
  assert.equal(await evaluate("Boolean(document.querySelector('.plugin-market-catalog-list button.primary'))"), false);
  await evaluate("window.pluginMarketRecoveryFixture.setTargetMode('unsupported_platform')");
  await clickButton("刷新发布信息");
  await waitFor("document.querySelector('[aria-label=\"当前平台不支持\"]')");
  assert.equal(await evaluate("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length"), 0);
  assert.equal(await evaluate("Boolean(document.querySelector('.plugin-market-catalog-list button.primary'))"), false);
  await evaluate("window.pluginMarketRecoveryFixture.setTargetMode('error')");
  await clickButton("刷新发布信息");
  await waitFor("document.querySelector('[aria-label=\"官方发布信息查询失败\"]')");
  assert.equal(await evaluate("document.querySelectorAll('.plugin-market-catalog-list .plugin-row').length"), 0);
  assert.equal(await evaluate("Boolean(document.querySelector('.plugin-market-catalog-list button.primary'))"), false);
  await evaluate("window.pluginMarketRecoveryFixture.setTargetMode('available')");
  await clickButton("重新查询发布信息");
  await waitFor("document.querySelector('.plugin-market-catalog-list .plugin-row code')?.textContent==='regex-editor'");
  const targetBranchCounts = await evaluate(`(()=>{const calls=window.pluginMarketRecoveryFixture.calls;return {target:calls.filter(c=>c.command==='fetch_official_plugin_target').length,catalog:calls.filter(c=>c.command==='fetch_plugin_market_catalog').length,resolver:calls.filter(c=>c.command==='resolve_plugin_market_download').length,install:calls.filter(c=>c.command==='install_plugin_from_market').length}})()`);
  assert.equal(targetBranchCounts.target - targetCallsBeforeBranches, 4);
  assert.equal(targetBranchCounts.catalog, catalogCallsBeforeBranches, "unavailable/retry branches never load the aggregate catalog");
  assert.equal(targetBranchCounts.resolver, 0);
  assert.equal(targetBranchCounts.install, 0);
  checks.push("Not found, unsupported platform, and transient lookup error show distinct notices without install actions; retry recovers the exact target without aggregate catalog loading");

  const callsBeforeInstall = await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='resolve_plugin_market_download').length===0&&window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='install_plugin_from_market').length===0");
  assert.equal(callsBeforeInstall, true);
  stage = "install-confirmation-cancel";
  await clickButton("安装");
  await waitFor("document.querySelector('[role=dialog]')?.textContent.includes('未提供可验证')");
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='resolve_plugin_market_download').length"), 1);
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='install_plugin_from_market').length"), 0);
  await clickAt("document.querySelector('[role=dialog] button')");
  await waitFor("!document.querySelector('[role=dialog]')");
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='install_plugin_from_market').length"), 0);
  checks.push("The first install attempt reaches the real Settings confirmation dialog; canceling it sends no install IPC");

  stage = "install-confirmation-accept";
  await clickButton("安装");
  await waitFor("document.querySelector('[role=dialog]')?.textContent.includes('未提供可验证')");
  await clickAt("Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent.trim()==='安装')");
  await waitFor("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='install_plugin_from_market').length===1");
  const installCall = await evaluate(`window.pluginMarketRecoveryFixture.calls.find(c=>c.command==='install_plugin_from_market')`);
  assert.equal(installCall.args?.sourceKind, "ztools");
  assert.equal(installCall.args?.sourceUrl, "https://z-tools.top/api/market");
  assert.equal(installCall.args?.expectedVersion, "1.0.1");
  assert.equal(installCall.args?.confirmedUnsigned, true);
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='install_plugin_from_market').length"), 1);
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.some(c=>c.command==='toggle_plugin')"), false);
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='resolve_plugin_market_download').length"), 2);
  checks.push("The second confirmation sends one expected official unsigned install request and never enables the returned plugin");

  stage = "update-expected-version";
  await evaluate("window.pluginMarketRecoveryFixture.setInstalledVersion('1.0.0')");
  await clickButton("刷新发布信息");
  await waitFor("Array.from(document.querySelectorAll('.plugin-market-catalog-list button.primary')).some(button=>button.textContent.trim()==='更新')");
  await clickButton("更新");
  await waitFor("document.querySelector('[role=dialog]')?.textContent.includes('未提供可验证')");
  await clickAt("Array.from(document.querySelectorAll('[role=dialog] button')).find(e=>e.textContent.trim()==='更新')");
  await waitFor("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='update_plugin_from_market').length===1");
  const updateCall = await evaluate("window.pluginMarketRecoveryFixture.calls.find(c=>c.command==='update_plugin_from_market')");
  assert.equal(updateCall.args?.expectedVersion, "1.0.1");
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.filter(c=>c.command==='install_plugin_from_market').length"), 1);
  assert.equal(await evaluate("window.pluginMarketRecoveryFixture.calls.some(c=>c.command==='toggle_plugin')"), false);
  checks.push("Updating a stale synthetic installation binds expectedVersion to the official 1.0.1 snapshot and leaves plugin enablement unchanged");

  assert.deepEqual(await evaluate("window.pluginMarketRecoveryFixture.unexpectedCommands"), []);
  const unexpectedRequest = requests.find(url => { try { return new URL(url).origin !== origin; } catch { return true; } });
  assert.equal(unexpectedRequest, undefined, `Unexpected network request: ${unexpectedRequest}`);
  assert.deepEqual(consoleIssues, []);
  const sourceHashesAtEnd = await sourceFilesSha256();
  assert.deepEqual(sourceHashesAtEnd, sourceHashesAtStart, "Tracked product/fixture/browser source changed during the run");
  successReport = { runId, passed: true, stage, scope: "Real Chromium rendering of App → SystemPanel → ZToolsImportPanel → SettingsPanel → PluginMarketPanel with synthetic Tauri IPC; all catalog/package/plugin data is fixture-only; no network catalog request, archive download, community code execution, user data access, or backend install acceptance", checks,
    initialCounts, catalogAfterClear, targetBranchCounts, targetIds, targetGeometry, compactGeometry, smallGeometry, sourceOpen, persistence, installCall, updateCall, calls: await evaluate("window.pluginMarketRecoveryFixture.calls"),
    unexpectedCommands: await evaluate("window.pluginMarketRecoveryFixture.unexpectedCommands"), networkRequests: requests, navigations, consoleIssues, timedOutCommands,
    sourceFilesSha256: sourceHashesAtStart, sourceFilesSha256AtEnd: sourceHashesAtEnd, sourceHashStable: true, progressLog: progressName,
    screenshots };
} catch (error) {
  const diagnostics = await withDeadline("failure diagnostics", evaluate(`JSON.stringify({url:location.href,readyState:document.readyState,query:document.querySelector('[role=combobox]')?.value,selectedOption:document.querySelector('[role=option][aria-selected=true]')?.innerText,system:document.querySelector('.system-panel')?.innerText.slice(0,1200),importer:document.querySelector('.import-panel')?.innerText.slice(0,1200),candidate:document.querySelector('.candidate-row')?.innerText,recovery:document.querySelector('.market-recovery')?.innerText,market:document.querySelector('.market-panel')?.innerText.slice(0,1200),dialog:document.querySelector('[role=dialog]')?.innerText,fixture:window.pluginMarketRecoveryFixture?.calls})`), 5000).catch(() => "browser context unavailable");
  failureReport = { runId, passed: false, stage, error: error instanceof Error ? error.message : String(error), checks, consoleIssues, requests, navigations, state: diagnostics, screenshots, timedOutCommands, progressLog: progressName,
    sourceFilesSha256: sourceHashesAtStart ?? await sourceFilesSha256().catch(() => ({})), sourceFilesSha256AtEnd: await sourceFilesSha256().catch(() => ({})), processExitEvidence: { runnerPid: process.pid, parentPid: process.ppid, expectedExitCode: 1, externallyObserved: false } };
  await checkpoint("failure-written", { failedStage: stage, error: failureReport.error }).catch(() => {});
  await writeFile(new URL("plugin-market-target-browser-failure.json", output), JSON.stringify(failureReport, null, 2) + "\n").catch(() => {});
  await writeFile(new URL(`plugin-market-target-browser-failure-${runId}.json`, output), JSON.stringify(failureReport, null, 2) + "\n").catch(() => {});
  if (page) await withDeadline("failure screenshot", screenshot("plugin-market-target-browser-failure.png"), 15000).catch(() => {});
  throw error;
} finally {
  cleanupEvidence.cdp.attempted = Boolean(page);
  cleanupEvidence.cdp.status = await withDeadline("close CDP page", page?.close() || Promise.resolve(), 5000)
    .then(() => "fulfilled", error => error instanceof Error && error.message.startsWith("Timed out") ? "timeout" : "rejected");
  const [chromeClosed, viteClosed] = await Promise.all([
    withDeadline("close Chrome", chrome?.close() || Promise.resolve(), 6000)
      .then(() => "fulfilled", error => error instanceof Error && error.message.startsWith("Timed out") ? "timeout" : "rejected"),
    withDeadline("close Vite", server?.close() || Promise.resolve(), 6000)
      .then(() => "fulfilled", error => error instanceof Error && error.message.startsWith("Timed out") ? "timeout" : "rejected"),
  ]);
  cleanupEvidence.chrome.status = chromeClosed;
  cleanupEvidence.vite.status = viteClosed;
  await checkpoint("cleanup-finished").catch(() => {});
  if (failureReport) {
    failureReport.cleanupEvidence = cleanupEvidence;
    await writeFile(new URL("plugin-market-target-browser-failure.json", output), JSON.stringify(failureReport, null, 2) + "\n").catch(() => {});
    await writeFile(new URL(`plugin-market-target-browser-failure-${runId}.json`, output), JSON.stringify(failureReport, null, 2) + "\n").catch(() => {});
  }
  if (successReport) {
    successReport.cleanupEvidence = cleanupEvidence;
    if (cleanupEvidence.cdp.status !== "fulfilled" || cleanupEvidence.chrome.status !== "fulfilled" || cleanupEvidence.vite.status !== "fulfilled") {
      successReport.passed = false;
      successReport.error = "Owned browser/server cleanup was not fully confirmed";
      process.exitCode = 1;
    }
    successReport.processExitEvidence = { runnerPid: process.pid, parentPid: process.ppid, exitCodeAtFinalization: process.exitCode ?? 0, externallyObserved: false };
    await writeFile(new URL("plugin-market-target-browser.json", output), JSON.stringify(successReport, null, 2) + "\n");
    await writeFile(new URL(`plugin-market-target-browser-${runId}.json`, output), JSON.stringify(successReport, null, 2) + "\n");
    console.log(JSON.stringify({ passed: successReport.passed, checks, screenshotCount: successReport.screenshots.length, installCall: successReport.installCall,
      cleanupEvidence, processExitEvidence: successReport.processExitEvidence }));
  }
}
