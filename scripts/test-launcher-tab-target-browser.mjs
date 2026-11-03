import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer, delay } from "./chrome-cdp-smoke-utils.mjs";
const origin = "http://127.0.0.1:1486";
const runId = Date.now();
const output = process.env.ATOOLS_TAB_TARGET_OUTPUT || `/private/tmp/atools-batch36-tab-target-delivery/browser-${runId}`;
let server, chrome, page;
const checks = [], issues = [], requests = [], geometry = [];
const freezePaths = ["src/App.svelte", "src/lib/settings.ts", "src/lib/settingsSaveCoordinator.ts", "src/lib/launcherTabTarget.ts", "src/lib/launcherTabTargetController.ts", "src/lib/searchStatusBar.ts", "src/components/LauncherTabTargetPicker.svelte", "src/components/SearchStatusBar.svelte", "src/components/SettingsPanel.svelte", "src/components/HomeCapabilityRail.svelte", "src/components/PluginPanel.svelte", "tests/components/launcherTabTargetBrowserFixture.ts", "tests/components/launcher-tab-target-browser.html", "scripts/test-launcher-tab-target-browser.mjs"];
async function fingerprint() { return Promise.all(freezePaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(new URL("../" + path, import.meta.url))).digest("hex") }))); }
let before;
const raw = "  原文 😀 café　尾部  ";
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression) {
  const end = Date.now() + 12000;
  while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(30); }
  assert.fail("Timed out: " + expression);
}
async function key(key, code = key, virtual = 9, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual, modifiers }); await delay(35);
}
async function input(value) {
  await evaluate(`(()=>{const e=document.querySelector('[data-atools-search-input]');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`);
}
async function reachablePoint(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),s=e.closest('.shell-frame').getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,width:r.width,height:r.height,insideViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,insideWindow:r.left>=s.left&&r.top>=s.top&&r.right<=s.right&&r.bottom<=s.bottom,hit:e.contains(document.elementFromPoint(x,y))};})()`);
  assert.ok(point && point.width > 0 && point.height > 0 && point.insideViewport && point.insideWindow && point.hit, "Real clickable target must fit viewport/window and win hit testing: " + JSON.stringify(point));
  geometry.push({ selector, ...point }); return point;
}
async function click(selector) {
  const { x, y } = await reachablePoint(selector);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, x, y });
  await delay(35);
}
async function screenshot(name) {
  const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(`${output}/${name}.png`, Buffer.from(result.data, "base64"));
}
let status = "failed", failure;
await mkdir(output); // Reject existing output before entering any report-writing handler.
try {
  before = await fingerprint();
  await writeFile(`${output}/source-before.json`, JSON.stringify(before, null, 2), { flag: "wx" });
  server = await launchViteServer({ port: 1486, probeUrl: origin }); chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
  page.on("Runtime.exceptionThrown", e => issues.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (["error", "warning", "assert"].includes(type)) issues.push(type + ":" + formatConsoleArgs(args)); });
  page.on("Network.requestWillBeSent", e => requests.push(e.request.url));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 780, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 30000);
  await page.send("Page.navigate", { url: origin + "/tests/components/launcher-tab-target-browser.html" }); await loaded;
  await waitFor("window.launcherTabTargetReady");
  await input(raw); await key("Tab");
  await waitFor("document.querySelector('[role=status]')?.textContent.includes('尚未设置')");
  assert.equal(await evaluate("document.querySelector('[data-atools-search-input]').value"), raw);
  checks.push("Unconfigured native Tab gives visible feedback and a settings action while retaining exact Unicode/spacing");
  await screenshot("tab-target-unconfigured");
  await click('[aria-label="设置 Tab 目标"]');
  await waitFor("document.querySelector('[aria-label=\"搜索 Tab 目标工具\"]')");
  await evaluate("(()=>{const e=document.querySelector('[aria-label=\"搜索 Tab 目标工具\"]');e.value='converter';e.dispatchEvent(new InputEvent('input',{bubbles:true}));})()");
  await waitFor("document.querySelector('.target-option')?.textContent.includes('字符转换')");
  await evaluate("document.querySelector('.target-option').scrollIntoView({block:'center'})");
  await click('.target-option');
  await waitFor("JSON.parse(localStorage.getItem('atools:settings-general')).tabTarget?.pluginId==='converter'");
  assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('atools:settings-general')).tabTarget"), { pluginId: "converter", code: "convert", label: "字符转换" });
  await evaluate("document.querySelector('[aria-label=\"Tab 固定目标\"]').scrollIntoView({block:'center'})");
  await delay(120);
  await screenshot("tab-target-settings");
  checks.push("Production SettingsPanel picker searches current catalog and persists stable pluginId/code plus display snapshot");
  const reloaded = page.waitForEvent("Page.loadEventFired", 30000);
  await page.send("Page.reload"); await reloaded;
  await waitFor("window.launcherTabTargetReady");
  await waitFor("document.querySelector('.target-tab-hint .full-tab-label')?.textContent.includes('字符转换')");
  assert.deepEqual(await evaluate("(()=>{const hint=document.querySelector('.target-tab-hint'),button=document.querySelector('[aria-label=\"设置 Tab 目标\"]');return {hintTag:hint?.tagName,hintLabel:hint?.querySelector('.full-tab-label')?.textContent,hintAccessibleName:hint?.getAttribute('aria-label'),hintTitle:hint?.title,buttonTag:button?.tagName,buttonLabel:button?.textContent.trim(),buttonHasKeycap:Boolean(button?.querySelector('.keycap'))}})()"), {
    hintTag: "SPAN", hintLabel: "交给 字符转换", hintAccessibleName: "Tab：交给 字符转换", hintTitle: "交给 字符转换", buttonTag: "BUTTON", buttonLabel: "设置目标", buttonHasKeycap: false,
  });
  await input(raw); await waitFor("document.querySelector('[role=option]')?.textContent.includes('其他工具')");
  await key("Tab");
  await waitFor("fixture.calls.some(c=>c.command==='activate_feature')");
  assert.deepEqual(await evaluate("fixture.calls.filter(c=>c.command==='activate_feature').map(c=>c.args)"), [{ code: "convert", payload: raw, expectedPluginId: "converter" }]);
  await waitFor("document.querySelector('.plugin-panel iframe') || document.querySelector('iframe')");
  await screenshot("tab-target-open");
  checks.push("Fresh App restores configured target; native Tab sends exact original input once to configured owner/code despite a different highlighted result");
  await key("Escape", "Escape", 27);
  await waitFor("document.querySelector('[data-atools-search-input]') && !document.querySelector('iframe')");
  assert.equal(await evaluate("document.activeElement===document.querySelector('[data-atools-search-input]')"), true);
  checks.push("Escape closes actual PluginPanel and returns focus to main search");
  await evaluate("fixture.setAvailability('zero')"); await input("no matching results");
  await key("Tab");
  await waitFor("fixture.calls.filter(c=>c.command==='activate_feature').length===2");
  assert.equal(await evaluate("fixture.calls.filter(c=>c.command==='activate_feature').at(-1).args.payload"), "no matching results");
  await key("Escape", "Escape", 27); await waitFor("!document.querySelector('iframe')");
  checks.push("Configured target remains independent of zero current search results");
  for (const state of ["missing", "collision"]) {
    await evaluate(`fixture.setAvailability(${JSON.stringify(state)})`); await input(raw);
    await key("Tab");
    await waitFor("document.querySelector('[role=status]')?.textContent.includes('重新选择')");
    assert.equal(await evaluate("document.querySelector('[data-atools-search-input]').value"), raw);
    assert.equal(await evaluate("fixture.calls.filter(c=>c.command==='activate_feature').length"), 2);
    await reachablePoint('[aria-label="设置 Tab 目标"]');
    checks.push(`${state} current catalog refuses activation and preserves query with a visible hit-tested settings action`);
  }
  await screenshot("tab-target-unavailable");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 420, deviceScaleFactor: 1, mobile: false });
  await reachablePoint('[aria-label="设置 Tab 目标"]');
  await click('[aria-label="设置 Tab 目标"]');
  await waitFor("document.querySelector('[aria-label=\"搜索 Tab 目标工具\"]')");
  checks.push("Unavailable target settings action is reachable at 900 and 480 widths and opens the real picker with native mouse input");
  await key("Escape", "Escape", 27); await waitFor("document.querySelector('[data-atools-search-input]')");
  await evaluate("fixture.setAvailability('ready');fixture.deferActivation()");
  await input(raw); await key("Tab");
  await waitFor("fixture.pendingActivationCount()===1");
  await input("changed while native activation waits");
  await evaluate("fixture.releaseActivations()"); await delay(150);
  assert.equal(await evaluate("document.querySelector('iframe')===null && document.querySelector('[data-atools-search-input]').value==='changed while native activation waits'"), true);
  checks.push("Deferred native activation descriptor is discarded after main query changes; no PluginPanel frame mounts");
  await evaluate("(()=>{const next={...JSON.parse(localStorage.getItem('atools:settings-general')),showRecentInSearch:false,tabTarget:null};localStorage.setItem('atools:settings-general',JSON.stringify(next));window.dispatchEvent(new CustomEvent('atools-settings-updated',{detail:next}));})()");
  for (const value of ["", "   "]) {
    await input(value); await key("Tab");
    await waitFor("document.querySelector('[role=status]')?.textContent.includes('尚未设置')");
    assert.equal(await evaluate("document.querySelector('[data-atools-search-input]').value"), value);
    await reachablePoint('[aria-label="设置 Tab 目标"]');
  }
  await screenshot("tab-target-empty-home-disabled");
  checks.push("Empty and whitespace queries with Home disabled keep exact input and expose visible hit-tested target feedback/action");
  assert.ok(!requests.some(url => !url.startsWith(origin) && !url.startsWith("data:") && !url.startsWith("blob:")), "No external app requests");
  assert.deepEqual(issues, []);
  const after = await fingerprint();
  await writeFile(`${output}/source-after.json`, JSON.stringify(after, null, 2), { flag: "wx" });
  assert.deepEqual(after, before, "Production and fixture source hashes are stable across browser validation");
  status = "passed";
} catch (error) {
  failure = error.stack || String(error);
  const state = await evaluate("({text:document.body.innerText,calls:fixture.calls,settings:localStorage.getItem('atools:settings-general')})").catch(() => null);
  await writeFile(`${output}/browser-failure-state.json`, JSON.stringify({ failure, state, issues }, null, 2));
  console.error(failure);
} finally {
  const runtimeUrls = await evaluate("performance.getEntriesByType('resource').map(entry=>entry.name).filter(url=>/svelte|chunk-|\\.js/.test(url))").catch(() => []);
  await writeFile(`${output}/runtime-script-urls.json`, JSON.stringify(runtimeUrls, null, 2), { flag: "wx" });
  const report = JSON.stringify({ status, checks, issues, geometry, failure, scope: "Real Chromium production App + SettingsPanel + PluginPanel, explicit in-memory mock IPC. Proves frontend stable owner/code and exact payload dispatch, settings persistence and return-to-search. No native backend, TaskRun or original plugin business acceptance claim." }, null, 2) + "\n";
  await writeFile(`${output}/browser-result.json`, report, { flag: "wx" });
  await page?.close(); await Promise.allSettled([chrome?.close(), server?.close()]);
}
if (status !== "passed") process.exitCode = 1;
else console.log(JSON.stringify({ status, checks, report: `${output}/browser-result.json` }));
