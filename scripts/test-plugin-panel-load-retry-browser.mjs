import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient, createPageWebSocketUrl, delay, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { build, preview as startPreview } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

const runId = randomUUID();
const reportPath = `/private/tmp/atools-batch46-load-retry/browser-report-${runId}.json`;
const origin = "http://127.0.0.1:1468";
const checks = [];
const screenshots = [];
let buildDir, preview, chrome, page, report = { runId, passed: false, checks, screenshots }, stage = "setup";
const runtimeEvents = [];

async function cdp(method, params = {}) { return page.send(method, params, { timeoutMs: 10000 }); }
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeoutMs = 10000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(25); }
  assert.fail(`Timed out waiting for ${expression}`);
}
async function key(key, code, windowsVirtualKeyCode) {
  const cdpKey = key === "Space" ? " " : key;
  const extra = key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : key === "Space" ? { text: " ", unmodifiedText: " " } : {};
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: cdpKey, code, windowsVirtualKeyCode, ...extra });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: cdpKey, code, windowsVirtualKeyCode });
}
async function viewport(width, height) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await delay(100);
  const geometry = await evaluate(`(()=>{const e=document.querySelector('.plugin-load-failure'),b=e?.querySelector('button'),r=e?.getBoundingClientRect();return{width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,errorWidth:r?.width??0,buttonVisible:Boolean(b&&r&&b.getBoundingClientRect().width>0),overflow:e?e.scrollWidth>e.clientWidth:false}})()`);
  assert.ok(geometry.documentWidth <= width && geometry.bodyWidth <= width && geometry.errorWidth <= width && geometry.buttonVisible && !geometry.overflow, JSON.stringify(geometry));
  return geometry;
}
async function captureScreenshot(name) {
  const result = await cdp("Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
  const bytes = Buffer.from(result.data, "base64");
  const path = `/private/tmp/atools-batch46-load-retry/browser-screen-${runId}-${name}.png`;
  await writeFile(path, bytes);
  screenshots.push({ name, stage, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}

try {
  buildDir = await mkdtemp(join(tmpdir(), "atools-panel-retry-browser-"));
  const outDir = join(buildDir, "dist");
  const buildResult = await build({
    configFile: false,
    root: process.cwd(),
    mode: "test",
    plugins: [svelte()],
    build: { outDir, emptyOutDir: true, rollupOptions: { input: resolve("tests/components/plugin-panel-load-retry-browser.html") } },
  });
  const outputs = (Array.isArray(buildResult) ? buildResult : [buildResult]).flatMap(bundle => bundle.output);
  const htmlOutput = outputs.find(output => output.type === "asset" && output.fileName === "tests/components/plugin-panel-load-retry-browser.html");
  assert.ok(htmlOutput, "static browser fixture HTML was emitted");
  const compiled = { htmlFile: htmlOutput.fileName, chunkCount: outputs.filter(output => output.type === "chunk").length };
  const bundle = (await Promise.all(outputs.filter(output => output.type === "chunk").map(output => readFile(join(outDir, output.fileName), "utf8")))).join("\n");
  assert.ok(!bundle.includes("@vite/client") && !bundle.includes("import.meta.hot"));
  preview = await startPreview({ root: process.cwd(), build: { outDir }, preview: { host: "127.0.0.1", port: 1468, strictPort: true } });
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  const consoleIssues = [];
  page.on("Runtime.consoleAPICalled", event => runtimeEvents.push({ type: event.type, args: (event.args || []).map(arg => arg.value ?? arg.description ?? "").slice(0, 4) }));
  page.on("Network.loadingFailed", event => runtimeEvents.push({ type: "loadingFailed", url: event.requestId, error: event.errorText }));
  page.on("Network.responseReceived", event => runtimeEvents.push({ type: "response", url: event.response.url, status: event.response.status, mime: event.response.mimeType }));
  page.on("Page.frameNavigated", event => runtimeEvents.push({ type: "frameNavigated", url: event.frame?.url }));
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await cdp("Emulation.setDeviceMetricsOverride", { width: 420, height: 720, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 12000);
  await cdp("Page.navigate", { url: `${origin}/${compiled.htmlFile}` }); await loaded;
  stage = "production-panel-initial-failure";
  await waitFor("window.pluginPanelLoadRetryFixture?.ready===true");
  assert.equal(await evaluate("window.pluginPanelLoadRetryFixture.readCount"), 1);
  assert.equal(await evaluate("document.querySelectorAll('iframe[title=Plugin]').length"), 0);
  for (let index = 0; index < 20 && !await evaluate("document.activeElement?.matches('.plugin-load-failure button')"); index++) await key("Tab", "Tab", 9);
  await waitFor("document.activeElement?.matches('.plugin-load-failure button')");
  await evaluate("window.__retryButtonRef=document.querySelector('.plugin-load-failure button')");
  assert.ok(await evaluate("document.activeElement===window.__retryButtonRef"));
  const at800 = await viewport(800, 640);
  await captureScreenshot("initial-error-800");

  stage = "retry-pending-single-flight";
  await key("Enter", "Enter", 13);
  await waitFor("window.pluginPanelLoadRetryFixture.readCount===2 && document.querySelector('.plugin-load-failure button')?.getAttribute('aria-disabled')==='true'");
  assert.ok(await evaluate("document.activeElement===window.__retryButtonRef && document.querySelector('.plugin-load-failure [role=status]')?.textContent.includes('正在重新加载')"));
  await key("Enter", "Enter", 13);
  await key("Enter", "Enter", 13);
  await delay(100);
  assert.equal(await evaluate("window.pluginPanelLoadRetryFixture.readCount"), 2);
  assert.ok(await evaluate("document.querySelector('.plugin-load-failure button')===window.__retryButtonRef && document.activeElement===window.__retryButtonRef"));
  await captureScreenshot("retry-pending-800");
  await evaluate("window.pluginPanelLoadRetryFixture.failPendingRead()");
  await waitFor("window.pluginPanelLoadRetryFixture.errorCount===2 && document.querySelector('.plugin-load-failure [role=alert]')?.textContent.includes('Synthetic retry HTML failure')");
  assert.ok(await evaluate("document.querySelector('.plugin-load-failure button')===window.__retryButtonRef && document.activeElement===window.__retryButtonRef"));
  stage = "retry-second-failure";
  const at420 = await viewport(420, 720);
  await captureScreenshot("retry-failed-420-focus");

  stage = "space-key-success";
  await key("Space", "Space", 32);
  await waitFor("window.pluginPanelLoadRetryFixture.readCount===3 && document.querySelector('iframe[title=Plugin]')?.srcdoc.includes('retry succeeded')");
  await waitFor("!document.querySelector('.plugin-load-failure')");
  await waitFor("document.activeElement===document.querySelector('iframe[title=Plugin]')");
  assert.equal(await evaluate("window.pluginPanelLoadRetryFixture.errorCount"), 2);
  assert.equal(await evaluate("document.querySelectorAll('iframe[title=Plugin]').length"), 1);
  const focusAfterRecovery = await evaluate("document.activeElement===document.querySelector('iframe[title=Plugin]')");
  assert.equal(focusAfterRecovery, true);
  assert.deepEqual(consoleIssues, []);

  stage = "retry-success-preserves-user-focus";
  await evaluate("window.pluginPanelLoadRetryFixture.resetForFocusTakeover()");
  await waitFor("window.pluginPanelLoadRetryFixture.readCount===1 && document.querySelector('.plugin-load-failure button')");
  for (let index = 0; index < 20 && !await evaluate("document.activeElement?.matches('.plugin-load-failure button')"); index++) await key("Tab", "Tab", 9);
  await waitFor("document.activeElement?.matches('.plugin-load-failure button')");
  await key("Enter", "Enter", 13);
  await waitFor("window.pluginPanelLoadRetryFixture.readCount===2 && document.querySelector('.plugin-load-failure button')?.getAttribute('aria-disabled')==='true'");
  const summaryRect = await evaluate("(()=>{const r=document.querySelector('.plugin-diagnostics summary')?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()");
  assert.ok(summaryRect, "production diagnostics summary is available as another focus owner");
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: summaryRect.x, y: summaryRect.y });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: summaryRect.x, y: summaryRect.y, button: "left", clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: summaryRect.x, y: summaryRect.y, button: "left", clickCount: 1 });
  await waitFor("document.activeElement===document.querySelector('.plugin-diagnostics summary')");
  await evaluate("window.pluginPanelLoadRetryFixture.resolvePendingRead()");
  await waitFor("document.querySelector('iframe[title=Plugin]')?.srcdoc.includes('retry succeeded after focus moved')");
  await waitFor("!document.querySelector('.plugin-load-failure')");
  const focusAfterUserTakeover = await evaluate("document.activeElement===document.querySelector('.plugin-diagnostics summary')");
  assert.equal(focusAfterUserTakeover, true, "successful retry must not steal focus after the user moves to another control");
  const focusTakeoverReadCount = await evaluate("window.pluginPanelLoadRetryFixture.readCount");
  const focusTakeoverErrorCount = await evaluate("window.pluginPanelLoadRetryFixture.errorCount");
  assert.equal(focusTakeoverReadCount, 2);
  assert.equal(focusTakeoverErrorCount, 1);
  assert.equal(await evaluate("document.querySelectorAll('iframe[title=Plugin]').length"), 1);
  checks.push("Actual PluginPanel startup failure, busy retry, second failure and recovery retain one button node/focus; Enter and Space trigger explicit attempts, duplicate Enter is single-flight, successful recovery focuses the sole production iframe only while the retry trigger retains focus, and preserves diagnostics-summary focus when the user moves mid-retry; responsive error layout fits at 420px and 800px");
  report = { runId, passed: true, stage: "complete", scope: "Isolated Chromium with production PluginPanel, controlled Tauri bridge and file-read promises; no native app, OS input, plugin business action, or permission grant; no external plugin request exercised, local loopback fixture traffic only observed scope.", checks, screenshots, at420, at800, readCount: 3, errorCount: 2, focusAfterRecovery, focusTakeover: { readCount: focusTakeoverReadCount, errorCount: focusTakeoverErrorCount, focusStayedOnUserControl: focusAfterUserTakeover }, compiled };
} catch (error) {
  process.exitCode = 1;
  const browserState = page ? await evaluate("({href:location.href,readyState:document.readyState,ready:window.pluginPanelLoadRetryFixture?.ready,reads:window.pluginPanelLoadRetryFixture?.readCount,errors:window.pluginPanelLoadRetryFixture?.errorCount,busy:document.querySelector('.plugin-load-failure')?.getAttribute('aria-busy'),buttonDisabled:document.querySelector('.plugin-load-failure button')?.getAttribute('aria-disabled'),retryButtonFocused:document.activeElement===document.querySelector('.plugin-load-failure button'),diagnosticsSummaryFocused:document.activeElement===document.querySelector('.plugin-diagnostics summary'),iframeFocused:document.activeElement===document.querySelector('iframe[title=Plugin]'),body:document.body?.innerText.slice(0,1200),html:document.documentElement?.outerHTML.slice(0,1500),resources:performance.getEntriesByType('resource').map(e=>e.name),fixture:Boolean(window.pluginPanelLoadRetryFixture)})").catch(() => null) : null;
  report = { ...report, passed: false, stage, error: error?.stack || String(error), checks, screenshots, browserState, runtimeEvents };
} finally {
  report.cleanup = {
    panel: page ? await evaluate("window.pluginPanelLoadRetryFixture?.dispose?.().then(()=>true)").then(value => value === true ? "unmounted" : "unknown", () => "failed") : "not_started",
    browser: chrome ? await Promise.resolve(chrome.close()).then(() => "closed", () => "failed") : "not_started",
    cdp: page ? await Promise.resolve(page.close()).then(() => "closed", () => "failed") : "not_started",
    preview: preview ? await Promise.resolve(preview.close()).then(() => "closed", () => "failed") : "not_started",
    build: buildDir ? await rm(buildDir, { recursive: true, force: true }).then(() => "removed", () => "failed") : "not_started",
  };
  if (Object.values(report.cleanup).some(value => value === "failed")) { report.passed = false; process.exitCode = 1; }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runId, passed: report.passed, stage: report.stage, cleanup: report.cleanup, reportPath }));
}
