import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer, delay } from "./chrome-cdp-smoke-utils.mjs";

const origin = "http://127.0.0.1:1453";
const output = new URL("../output/launcher-ui-2026-10-15/", import.meta.url);
let server, chrome, page;
const issues = [], requests = [], checks = [], navigations = [];
async function evaluate(expression) {
  const response = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text);
  return response.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await delay(25); }
  assert.fail("Timed out: " + expression);
}
async function key(key, code, virtualKey, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, modifiers,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey, modifiers });
  await delay(25);
}
async function search(value) {
  await evaluate(`(()=>{const input=document.querySelector('[role=combobox]');input.focus();input.value=${JSON.stringify(value)};input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`);
  await waitFor("document.querySelector('[role=option]')");
}
async function rightClick(selector) {
  const point = await evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:b.right-8,y:b.top+b.height/2};})()`);
  for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, button: "right", clickCount: 1, ...point });
  await waitFor("document.querySelector('[role=menu] button')===document.activeElement");
}
try {
  await mkdir(output, { recursive: true });
  server = await launchViteServer({ port: 1453, probeUrl: origin }); chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
  page.on("Runtime.exceptionThrown", event => issues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (["error", "warning", "assert"].includes(type)) issues.push(type + ":" + formatConsoleArgs(args)); });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  page.on("Page.frameNavigated", event => { if (!event.frame.parentId) navigations.push(event.frame.url); });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 760, height: 560, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await page.send("Page.navigate", { url: origin + "/tests/components/launcher-actions-browser.html" }); await loaded;
  await waitFor("window.launcherFixtureReady");
  await evaluate("document.documentElement.dataset.atoolsTheme='light'");
  await search("字符转换");
  await rightClick('[role=option]');
  const geometry = await evaluate(`(()=>{const menu=document.querySelector('[role=menu]'),r=menu.getBoundingClientRect();return {fits:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,items:[...menu.querySelectorAll('button')].map(b=>b.textContent.trim()),query:document.querySelector('[role=combobox]').value};})()`);
  assert.equal(geometry.fits, true); assert.ok(geometry.items.includes("固定到首页"));
  checks.push("Native browser right-click opens the actual selected source actions without activation");
  await delay(220); // Capture settled product animations, not an intermediate opacity.
  const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL("launcher-actions.png", output), Buffer.from(shot.data, "base64"));
  await key("Escape", "Escape", 27);
  assert.equal(await evaluate("document.querySelector('[role=menu]')===null && document.activeElement===document.querySelector('[role=combobox]') && document.activeElement.value==='字符转换'"), true);
  checks.push("Escape dismisses only the menu, preserving query and search focus");
  await key("F10", "F10", 121, 8); await waitFor("document.querySelector('[role=menu] button')===document.activeElement");
  await key("ArrowDown", "ArrowDown", 40); await key("Home", "Home", 36); await key("Enter", "Enter", 13);
  await waitFor("localStorage.getItem('atools:pinned-commands')==='[\"convert\"]' && !document.querySelector('[role=menu]')");
  checks.push("Shift+F10, arrow/Home navigation and native Enter pin the stable underlying command code");
  await evaluate("document.querySelector('[aria-label=\"清除搜索内容\"]').click()");
  await waitFor("document.querySelector('[aria-label=\"固定指令\"] .recent-label')?.textContent==='字符转换'");
  assert.equal(await evaluate("fixture.calls.filter(c=>c.command==='feature_catalog').length"), 1);
  checks.push("Pinned plugin immediately appears on Home with no additional catalog request");
  await evaluate("fixture.mountFresh(true)");
  await waitFor("document.querySelector('[aria-label=\"固定指令\"] .recent-label')?.textContent==='字符转换'");
  assert.equal(await evaluate("fixture.calls.filter(c=>c.command==='feature_catalog').length"), 1);
  checks.push("Fresh App restores the persisted plugin before its existing catalog promise resolves");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 280, deviceScaleFactor: 1, mobile: false });
  await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
  await rightClick('[aria-label="固定指令"] .recent-item');
  assert.equal(await evaluate("(()=>{const r=document.querySelector('[role=menu]').getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight})()"), true);
  await key("Enter", "Enter", 13);
  await waitFor("!document.querySelector('[aria-label=\"固定指令\"]') && localStorage.getItem('atools:pinned-commands')==='[]'");
  checks.push("Compact 480x280 menu stays in view; native Enter unpins and restores search focus");
  assert.equal(await evaluate("document.activeElement===document.querySelector('[role=combobox]')"), true);
  await evaluate("fixture.releaseCatalog()"); await evaluate("fixture.mountFresh(false)");
  assert.equal(await evaluate("document.querySelector('[aria-label=\"固定指令\"]')===null"), true);
  checks.push("Cancellation persists across another fresh App mount");
  assert.equal(await evaluate("fixture.calls.some(c=>c.command==='activate_feature')"), false);
  assert.ok(!requests.some(url => url.includes("/src/components/PluginPanel.svelte")));
  assert.deepEqual(issues, []);
  const report = { status: "passed", scope: "Chromium preview of production App/Home/Results/Menu with explicit mock IPC installed before first mount; no native backend or plugin execution; no competitor timing claim", checks, geometry, navigations, consoleIssues: issues, screenshot: "launcher-actions.png" };
  await writeFile(new URL("launcher-actions.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} catch (error) {
  console.error(await evaluate("JSON.stringify({query:document.querySelector('[role=combobox]')?.value,active:document.activeElement?.outerHTML,menu:document.querySelector('[role=menu]')?.textContent,pins:localStorage.getItem('atools:pinned-commands'),calls:window.fixture?.calls})").catch(() => "Browser context unavailable"));
  throw error;
} finally { await page?.close(); await Promise.allSettled([chrome?.close(), server?.close()]); }
