import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer, delay } from "./chrome-cdp-smoke-utils.mjs";
import { launcherFrontendSourceFiles } from "./lib/launcher-source-binding.mjs";

const root = new URL("../", import.meta.url), origin = "http://127.0.0.1:1456";
const runId = randomUUID(), output = new URL(`output/launcher-ui-2026-10-15/result-presentation-${runId}/`, root);
const sources = ["scripts/test-launcher-result-presentation-browser.mjs", "tests/components/launcherPresentationBrowserFixture.ts", "tests/components/launcher-presentation-browser.html",
  ...launcherFrontendSourceFiles];
const hashSources = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file,
  createHash("sha256").update(await readFile(new URL(file, root))).digest("hex")])));
let server, chrome, page;
const report = { runId, status: "incomplete", scope: "Chromium production App/Results UI with explicit offline IPC fixtures; no native catalog, plugin, OS hotkey or competitor timing acceptance", checks: [], screenshots: [], consoleIssues: [], externalRequests: [] };
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await delay(25); }
  assert.fail("Timed out: " + expression);
}
async function key(key, code, virtualKey) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey });
  await delay(30);
}
const selectedCode = () => evaluate("document.querySelector('[role=option][aria-selected=true]')?.dataset.resultCode");
try {
  await mkdir(output, { recursive: true });
  report.sourcesBefore = await hashSources();
  server = await launchViteServer({ cwd: root.pathname, port: 1456, probeUrl: origin });
  chrome = await launchChrome(); page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
  report.browserVersion = await page.send("Browser.getVersion");
  page.on("Runtime.exceptionThrown", event => report.consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (["error", "warning", "assert"].includes(type)) report.consoleIssues.push(type + ":" + formatConsoleArgs(args)); });
  page.on("Network.requestWillBeSent", event => { if (/^https?:/.test(event.request.url) && !event.request.url.startsWith(origin + "/")) report.externalRequests.push(event.request.url); });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url: origin + "/tests/components/launcher-presentation-browser.html" }); await loaded;
  await waitFor("window.launcherPresentationReady && document.querySelector('[role=combobox]')");
  await evaluate("(()=>{const input=document.querySelector('[role=combobox]');input.focus();input.value='工具';input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()");
  await waitFor("document.querySelectorAll('[role=option]').length===6");
  report.initial = await evaluate(`(()=>{const rows=[...document.querySelectorAll('[role=option]')];return {
    titles:rows.map(row=>row.querySelector('.result-title').textContent),
    sourceNames:rows.map(row=>row.querySelector('.source-name').textContent),
    rawCodes:rows.map(row=>row.dataset.resultCode),
    visibleText:document.querySelector('[role=listbox]').innerText,
    duplicateDescription:rows.find(row=>row.dataset.resultCode==='color').querySelector('.result-desc')!==null,
    activeDescendant:document.querySelector('[role=combobox]').getAttribute('aria-activedescendant'),
    selectedId:document.querySelector('[role=option][aria-selected=true]').id,
    viewport: (()=>{const list=document.querySelector('[role=listbox]');const viewport=list.querySelector('.result-viewport');return {scrollTop:list.scrollTop,clientHeight:list.clientHeight,offset:viewport.offsetTop,listRect:list.getBoundingClientRect().toJSON(),viewportRect:viewport.getBoundingClientRect().toJSON(),selectedRect:list.querySelector('[aria-selected=true]').getBoundingClientRect().toJSON()};})()};})()`);
  assert.deepEqual(report.initial.titles, ["颜色", "收藏颜色", "字符转换", "MD5", "时间戳转换", "Agent / MCP"]);
  assert.equal(report.initial.duplicateDescription, false);
  assert.ok(!/color-helper|character-transform|包含匹配|精确匹配/.test(report.initial.visibleText));
  assert.equal(report.initial.activeDescendant, report.initial.selectedId);
  report.checks.push("Human-readable names, quiet sources and no duplicate description or visible implementation diagnostics");
  assert.equal(await selectedCode(), "color");
  assert.equal(await evaluate("document.querySelector('[role=listbox]').scrollTop"), 0);
  await key("ArrowDown", "ArrowDown", 40); assert.equal(await selectedCode(), "collect");
  await key("ArrowDown", "ArrowDown", 40); assert.equal(await selectedCode(), "character-transform");
  await key("ArrowUp", "ArrowUp", 38); assert.equal(await selectedCode(), "collect");
  report.checks.push("Actual App keyboard selection follows grouped visual order and keeps underlying codes");
  for (const [theme, width] of [["light", 800], ["dark", 800], ["light", 480], ["dark", 480]]) {
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 600, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.atoolsTheme=${JSON.stringify(theme)}`);
    await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const geometry = await evaluate(`(()=>{const list=document.querySelector('[role=listbox]');return {
      horizontalOverflow:document.documentElement.scrollWidth>innerWidth,
      rows:[...list.querySelectorAll('[role=option]')].map(row=>{const box=row.getBoundingClientRect();const title=row.querySelector('.result-title').getBoundingClientRect();const source=row.querySelector('.result-meta').getBoundingClientRect();return {height:box.height,titleWidth:title.width,overlap:title.right>source.left};})};})()`);
    assert.equal(geometry.horizontalOverflow, false);
    assert.ok(geometry.rows.every(row => row.height === 54 && row.titleWidth > 80 && !row.overlap));
    const file = `search-${theme}-${width}.png`, capture = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(file, output), Buffer.from(capture.data, "base64"));
    report.screenshots.push({ file, theme, width, geometry });
  }
  report.checks.push("800px and 480px light/dark layouts retain exact virtual row geometry without overlap or horizontal overflow");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('[aria-label=插件导航] .feature-tag')?.textContent==='收藏颜色'");
  const activation = await evaluate("fixture.calls.filter(call=>call.command==='activate_feature')");
  assert.equal(activation.length, 1); assert.equal(activation[0].args.code, "collect");
  assert.equal(activation[0].args.expectedPluginId, "color-helper");
  await evaluate("document.querySelector('[aria-label=返回搜索]').click()");
  await waitFor("document.activeElement===document.querySelector('[role=combobox]') && !document.querySelector('.plugin-panel')");
  report.checks.push("Enter opens the displayed feature using its original code; return restores launcher focus");
  assert.deepEqual(report.consoleIssues, []); assert.deepEqual(report.externalRequests, []);
  report.sourcesAfter = await hashSources();
  report.sourcesUnchanged = JSON.stringify(report.sourcesBefore) === JSON.stringify(report.sourcesAfter);
  assert.equal(report.sourcesUnchanged, true);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error);
  report.failureSnapshot = await evaluate("({text:document.body.innerText.slice(0,1800),calls:window.fixture?.calls})").catch(() => null);
  throw error;
} finally {
  await page?.close();
  const cleanup = await Promise.allSettled([chrome?.close(), server?.close()]);
  report.cleanupErrors = cleanup.filter(result => result.status === "rejected").map(result => String(result.reason));
  if (report.cleanupErrors.length) report.status = "failed";
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true }); await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output: output.pathname, status: report.status, checks: report.checks.length }));
  if (report.status !== "passed") process.exitCode = 1;
}
