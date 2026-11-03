import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CdpClient, createPageWebSocketUrl, formatConsoleArgs, launchChrome, launchViteServer, delay } from "./chrome-cdp-smoke-utils.mjs";

const origin = "http://127.0.0.1:1488";
const output = process.env.ATOOLS_PENDING_PLUGIN_BROWSER_OUTPUT || `/private/tmp/atools-batch1158-pending-plugin-browser-qa/browser-${randomUUID()}`;
const freezePaths = [
  "src/App.svelte", "src/components/LauncherResultsSurface.svelte", "src/components/ResultRow.svelte", "src/components/ResultsList.svelte",
  "src/components/SearchBar.svelte", "src/components/ShellFrame.svelte", "src/components/PluginPanel.svelte", "src/components/PluginPanelBody.svelte",
  "src/components/SettingsPanel.svelte", "src/styles/global.css", "src/lib/launcherControllerHost.ts", "src/lib/launcherInteractionRuntime.ts",
  "src/lib/launcherNavigationController.ts", "src/lib/launcherPendingPluginActivation.svelte.ts", "src/lib/launcherPluginSessionController.ts",
  "src/lib/launcherResultActionsController.ts", "src/lib/launcherSearchController.ts", "tests/components/launcher-pending-plugin-open-app.test.ts",
  "tests/components/launcher-return-context-app.test.ts", "tests/components/launcherReturnContextFixture.ts",
  "tests/components/launcherPendingPluginBrowserFixture.ts", "tests/components/launcher-pending-plugin-browser.html", "scripts/test-launcher-pending-plugin-browser.mjs",
];
const requiredPins = {
  "src/components/LauncherResultsSurface.svelte": "c14e96e40570afc9311589c21e941f3184d7953887296621c24aa74aa350462e",
  "src/components/ResultRow.svelte": "57755235eb1d13a1ca02ec8181deac61564cd64fc7d9774bd1e20551d10cfc37",
  "src/components/ResultsList.svelte": "257bdbdd5de9b401dd3428c0a17fb8e79d58e5cd96c06973c9399e060a203c4a",
  "src/lib/launcherControllerHost.ts": "2325373423af3d3482bea0d72b43019f27d9c16e3cdf0c16bb81cc55575119cc",
  "src/lib/launcherInteractionRuntime.ts": "9ac41d174ff20560fc2b01a8aaf7871fe4c8ed6ffb77d769c0c38f034bdd42af",
  "src/lib/launcherNavigationController.ts": "602077ff7d9c9514ec9f286277aa16fc1dfe9db78db8852742571f71e12c1096",
  "src/lib/launcherPendingPluginActivation.svelte.ts": "c293e9247a556f5d7bf0175bad9a11915660d4c1ee166c1c86f18a14733b47e8",
  "src/lib/launcherPluginSessionController.ts": "e4461b64f8e414107ede14a3c4bd0487671593eb0d3c3e736e728b2efc7c3984",
  "src/lib/launcherResultActionsController.ts": "a54795ef5784e47823d32a782a09d9eb18b92e428643b36bff3fe455142f76b2",
  "src/lib/launcherSearchController.ts": "63bf6f13a99952aff57bd690c30057eb82062779621e69289bf1cdf9bb04d26b",
  "tests/components/launcher-pending-plugin-open-app.test.ts": "735d68d551a5b28319298b32916e9d65d30697ec241cfe3bc928a9024f988805",
  "tests/components/launcher-return-context-app.test.ts": "8453d97a43fbbb9b7c8f0269e1d1e49c61a5d7455e2ba7dcdb38d4c96166a676",
  "src/App.svelte": "d3aa6cf1344bd5ba3496a6262018d94d95f1ff9e0b1851af669d2323a1ea81f2",
  "src/components/PluginPanel.svelte": "673068cfd2b07bd6e0687e14e09f2a19939003eb8e5cf22bc08ca1fda8fb2105",
  "src/components/PluginPanelBody.svelte": "343bb2ce57e0d228b93ca4d709ee629d3f7828877fe52310ce4b9957824e46d9",
  "src/components/SearchBar.svelte": "7de2d502a51eb975013eb6380399244e9c0fe77c2a848ca9bf071a8d610e712f",
  "src/components/ShellFrame.svelte": "c8e1ef2af650cf5f8bb47c049080de3eb1c05e470d249c49243ab5b6063a1516",
  "src/components/SettingsPanel.svelte": "33c5ae163225cbb866561e85e1bb6fc9bc3bf45f87bce3a346d093685b87492f",
  "src/styles/global.css": "3082e82287f79eddc0a0d3fd822464ece8b2f86b2dc2b7e3131ede7099963fd2",
  "tests/components/launcherReturnContextFixture.ts": "bbd2176ca391cd836cf88f34929310be16d9fee5002668d3e185cbd6729b88a7",
};
let server, chrome, page;
const checks = [], issues = [], expectedErrors = [], requests = [], geometry = [], screenshots = [], screenshotErrors = [], cleanup = [];
let status = "failed", failure, before = [];
let expectedConsoleErrorPhase = null;
let resolveExpectedConsoleError;
const expectedConsoleErrorObserved = new Promise(resolve => { resolveExpectedConsoleError = resolve; });

async function fingerprint() {
  return Promise.all(freezePaths.map(async path => ({ path, sha256: createHash("sha256").update(await readFile(new URL("../" + path, import.meta.url))).digest("hex") })));
}
async function evaluate(expression) {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, { timeoutMs: 15000 });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeoutMs = 12000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await delay(30); }
  assert.fail("Timed out waiting for: " + expression);
}
async function key(key, code = key, virtual = key === "Enter" ? 13 : key === "Escape" ? 27 : 40) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtual });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtual });
  await delay(45);
}
async function input(value) {
  await evaluate(`(()=>{const e=document.querySelector('[data-atools-search-input]');e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`);
}
async function focusHostForEscape() {
  await evaluate("document.body.setAttribute('tabindex','-1');document.body.focus()");
}
async function click(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,width:r.width,height:r.height,inside:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,hit:e.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))}})()`);
  assert.ok(point && point.width > 0 && point.height > 0 && point.inside && point.hit, "CDP click target is not reachable: " + JSON.stringify(point));
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, x: point.x, y: point.y });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, x: point.x, y: point.y });
  await delay(60);
}
async function screenshot(name) {
  try {
    const result = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(`${output}/${name}.png`, Buffer.from(result.data, "base64"), { flag: "wx" });
    screenshots.push(name);
  } catch (error) { screenshotErrors.push({ name, error: error.stack || String(error) }); }
}
async function navigateFresh(label) {
  const loaded = page.waitForEvent("Page.loadEventFired", 30000);
  await page.send("Page.navigate", { url: `${origin}/tests/components/launcher-pending-plugin-browser.html?scenario=${encodeURIComponent(label)}` });
  await loaded;
  await waitFor("window.launcherPendingPluginReady === true");
}
async function waitForResult(code) {
  await waitFor(`document.querySelector('[role="option"][data-result-code="${code}"]')`);
}
async function assertPreviewNotMounted() {
  assert.equal(await evaluate("document.querySelector('.plugin-panel iframe, iframe[srcdoc]') === null"), true);
}
async function inspectPendingAtWidth(width, code) {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height: 760, deviceScaleFactor: 1, mobile: false });
  await delay(80);
  const value = await evaluate(`(()=>{const row=document.querySelector('[role="option"][data-result-code="${code}"]'),hint=row?.querySelector('.opening-hint'),title=row?.querySelector('.result-title'),shell=document.querySelector('.shell-frame');if(!row||!hint||!title||!shell)return null;const r=row.getBoundingClientRect(),h=hint.getBoundingClientRect(),t=title.getBoundingClientRect(),s=shell.getBoundingClientRect(),described=(row.getAttribute('aria-describedby')||'').split(/\\s+/).includes(hint.id);return{width:innerWidth,height:innerHeight,text:hint.textContent,busy:row.getAttribute('aria-busy'),described,insideViewport:r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&h.left>=0&&h.top>=0&&h.right<=innerWidth&&h.bottom<=innerHeight,insideShell:r.left>=s.left&&r.right<=s.right&&h.left>=s.left&&h.right<=s.right,noOverlap:t.right<=h.left||h.right<=t.left||t.bottom<=h.top||h.bottom<=t.top,row:{left:r.left,right:r.right,top:r.top,bottom:r.bottom},hint:{left:h.left,right:h.right,top:h.top,bottom:h.bottom},title:{left:t.left,right:t.right}}})()`);
  assert.ok(value, `Pending status geometry missing at ${width}px`);
  assert.equal(value.busy, "true");
  assert.equal(value.described, true);
  assert.equal(value.text, "正在打开… · Esc 取消");
  assert.equal(value.insideViewport, true, `Pending status leaves viewport at ${width}px: ${JSON.stringify(value)}`);
  assert.equal(value.insideShell, true, `Pending status leaves shell at ${width}px: ${JSON.stringify(value)}`);
  assert.equal(value.noOverlap, true, `Pending status overlaps row title at ${width}px: ${JSON.stringify(value)}`);
  geometry.push(value);
  await screenshot(`pending-${width}`);
}

await mkdir(output, { recursive: false });
try {
  before = await fingerprint();
  const pins = new Map(before.map(item => [item.path, item.sha256]));
  for (const [path, expected] of Object.entries(requiredPins)) assert.equal(pins.get(path), expected, `Unexpected B1146/v143 browser source pin: ${path}`);
  await writeFile(`${output}/source-before.json`, JSON.stringify(before, null, 2), { flag: "wx" });
  server = await launchViteServer({ port: 1488, probeUrl: origin });
  chrome = await launchChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
  page.on("Runtime.exceptionThrown", event => issues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (type !== "error") return;
    const message = formatConsoleArgs(args);
    if (expectedConsoleErrorPhase === "current-owner-rejection" && message === "Plugin activation failed.") {
      expectedErrors.push({ phase: expectedConsoleErrorPhase, message });
      resolveExpectedConsoleError();
      return;
    }
    issues.push("console.error:" + message);
  });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  await navigateFresh("pending-escape-and-responsive");

  const codes = await evaluate("window.launcherPendingPluginFixture.resultCodes");
  await input(codes.queryA); await waitForResult(codes.alpha);
  await key("Enter"); await waitFor("window.launcherPendingPluginFixture.activationSnapshot().length === 1");
  await key("Enter");
  assert.equal(await evaluate("window.launcherPendingPluginFixture.commandSnapshot('activate_feature').length"), 1, "Repeated real Enter dispatch must coalesce to one activation IPC");
  assert.deepEqual(await evaluate("(({code,expectedPluginId})=>({code,expectedPluginId}))(window.launcherPendingPluginFixture.commandSnapshot('activate_feature')[0])"), { code: codes.alpha, expectedPluginId: "alpha-plugin" });
  for (const width of [360, 640, 900]) await inspectPendingAtWidth(width, codes.alpha);
  checks.push("At 360/640/900px, the selected row exposes aria-busy and its described opening status without overlap or viewport/shell overflow");
  checks.push("Two real CDP Enter presses during one pending attempt issue one owner-bound activate_feature IPC");

  await key("Escape");
  await waitFor("document.querySelector('.opening-hint') === null");
  assert.equal(await evaluate("document.querySelector('[data-atools-search-input]').value"), codes.queryA);
  assert.equal(await evaluate("document.activeElement === document.querySelector('[data-atools-search-input]')"), true);
  assert.equal(await evaluate("document.querySelector('[role=alert]') === null"), true);
  await key("Escape");
  await waitFor("document.querySelector('[data-atools-search-input]').value === ''");
  await evaluate("window.launcherPendingPluginFixture.resolveActivation(0)");
  await delay(100); await assertPreviewNotMounted();
  checks.push("First Escape cancels pending UI while retaining query/focus; second Escape clears search; late resolution stays stale");

  await navigateFresh("query-a-b-a-stale-settlement");
  const codes2 = await evaluate("window.launcherPendingPluginFixture.resultCodes");
  await input(codes2.queryA); await waitForResult(codes2.alpha); await key("Enter");
  await waitFor("window.launcherPendingPluginFixture.activationSnapshot().length === 1");
  await input(codes2.queryB); await waitForResult(codes2.gamma); await key("Enter");
  await waitFor("window.launcherPendingPluginFixture.activationSnapshot().length === 2");
  await input(codes2.queryA); await waitForResult(codes2.alpha); await key("Enter");
  await waitFor("window.launcherPendingPluginFixture.activationSnapshot().length === 3");
  await evaluate("window.launcherPendingPluginFixture.resolveActivation(0)");
  await delay(100);
  assert.equal(await evaluate(`document.querySelector('[role="option"][data-result-code="${codes2.alpha}"]')?.getAttribute('aria-busy')`), "true");
  assert.equal(await evaluate("document.querySelector('[role=alert]') === null"), true);
  assert.equal(await evaluate("window.launcherPendingPluginFixture.pluginExpandSnapshot().length"), 0, "A stale activation cannot trigger an owned plugin expansion");
  expectedConsoleErrorPhase = "current-owner-rejection";
  await evaluate("window.launcherPendingPluginFixture.rejectActivation(2,'FEATURE_OWNER_CHANGED: newest failure')");
  await waitFor("document.querySelector('[role=alert]')?.textContent.includes('来源已变化')");
  const expectedErrorSeen = await Promise.race([expectedConsoleErrorObserved.then(() => true), delay(1500).then(() => false)]);
  assert.equal(expectedErrorSeen, true, "The controlled current-owner rejection should emit its fixed console.error");
  assert.deepEqual(expectedErrors, [{ phase: "current-owner-rejection", message: "Plugin activation failed." }]);
  expectedConsoleErrorPhase = null;
  const newestError = await evaluate("document.querySelector('[role=alert]').textContent");
  await evaluate("window.launcherPendingPluginFixture.rejectActivation(1,'older activation failed')");
  await delay(120);
  assert.equal(await evaluate("document.querySelector('[role=alert]').textContent"), newestError);
  assert.equal(await evaluate("document.querySelector('[data-atools-search-input]').value"), codes2.queryA);
  assert.equal(await evaluate("document.querySelector('[role=option][aria-selected=true]')?.getAttribute('data-result-code')"), codes2.alpha);
  await assertPreviewNotMounted();
  checks.push("Only the intentional current-owner rejection emits the fixed activation console.error; stale rejects and all other browser errors remain failures");
  checks.push("In query A→B→A, old A success cannot replace the newest pending attempt; current A error remains after old B rejects");

  await navigateFresh("committed-expansion-escape");
  const codes3 = await evaluate("window.launcherPendingPluginFixture.resultCodes");
  await input(codes3.queryA); await waitForResult(codes3.alpha);
  await key("ArrowDown"); await waitFor(`document.querySelector('[role="option"][data-result-code="${codes3.beta}"]')?.getAttribute('aria-selected') === 'true'`);
  await evaluate("window.launcherPendingPluginFixture.holdNextPluginExpand()");
  await key("Enter"); await waitFor("window.launcherPendingPluginFixture.activationSnapshot().length === 1");
  await evaluate("window.launcherPendingPluginFixture.resolveActivation(0)");
  await waitFor("window.launcherPendingPluginFixture.pluginExpandSnapshot().length === 1 && window.launcherPendingPluginFixture.pluginExpandSnapshot()[0].height === 400 && document.querySelector('iframe')");
  assert.equal(await evaluate("document.querySelector('[role=option][aria-busy=true]') === null"), true);
  await focusHostForEscape();
  await key("Escape");
  await waitFor("document.querySelector('iframe') === null && document.querySelector('[data-atools-search-input]')?.value === window.launcherPendingPluginFixture.resultCodes.queryA");
  await waitFor(`document.querySelector('[role="option"][data-result-code="${codes3.beta}"]')?.getAttribute('aria-selected') === 'true'`);
  assert.equal(await evaluate(`document.querySelector('[role="option"][aria-selected=true]')?.getAttribute('data-result-code')`), codes3.beta);
  assert.equal(await evaluate("document.activeElement === document.querySelector('[data-atools-search-input]')"), true);
  await evaluate("window.launcherPendingPluginFixture.releasePluginExpand(0)"); await delay(100);
  assert.equal(await evaluate("document.querySelector('iframe') === null"), true);
  checks.push("After activation commits but expand_window waits, Escape follows active-plugin return behavior; releasing expand does not reopen it");

  await navigateFresh("normal-open-return-context");
  const codes4 = await evaluate("window.launcherPendingPluginFixture.resultCodes");
  await input(codes4.queryA); await waitForResult(codes4.alpha); await key("ArrowDown");
  await waitFor(`document.querySelector('[role="option"][data-result-code="${codes4.beta}"]')?.getAttribute('aria-selected') === 'true'`);
  await click(`[role="option"][data-result-code="${codes4.beta}"]`);
  await waitFor("window.launcherPendingPluginFixture.activationSnapshot().length === 1");
  assert.deepEqual(await evaluate("(({code,expectedPluginId})=>({code,expectedPluginId}))(window.launcherPendingPluginFixture.commandSnapshot('activate_feature')[0])"), { code: codes4.beta, expectedPluginId: "beta-plugin" });
  await evaluate("window.launcherPendingPluginFixture.resolveActivation(0)");
  await waitFor("document.querySelector('iframe') && window.launcherPendingPluginFixture.pluginExpandSnapshot().length === 1 && window.launcherPendingPluginFixture.pluginExpandSnapshot()[0].height === 400");
  await focusHostForEscape(); await key("Escape");
  await waitFor("document.querySelector('iframe') === null && document.querySelector('[data-atools-search-input]')?.value === window.launcherPendingPluginFixture.resultCodes.queryA");
  await waitFor(`document.querySelector('[role="option"][data-result-code="${codes4.beta}"]')?.getAttribute('aria-selected') === 'true'`);
  assert.equal(await evaluate(`document.querySelector('[role="option"][aria-selected=true]')?.getAttribute('data-plugin-id')`), "beta-plugin");
  assert.equal(await evaluate(`document.querySelector('[role="option"][aria-selected=true]')?.getAttribute('data-result-code')`), codes4.beta);
  assert.equal(await evaluate("document.activeElement === document.querySelector('[data-atools-search-input]')"), true);
  checks.push("Ordinary result click opens the exact owner/code and return restores raw query, selected plugin identity, and search focus");

  const foreignRequests = requests.filter(url => !url.startsWith(origin) && !/^(data:|blob:|about:)/.test(url));
  assert.deepEqual(foreignRequests, [], "Browser fixture must not make external app requests");
  assert.deepEqual(issues, [], "Chromium console/runtime errors are unexpected");
  const after = await fingerprint();
  await writeFile(`${output}/source-after.json`, JSON.stringify(after, null, 2), { flag: "wx" });
  assert.deepEqual(after, before, "Production and browser fixture source bytes must remain unchanged during QA");
  status = screenshotErrors.length === 0 ? "passed" : "passed_with_screenshot_errors";
} catch (error) {
  failure = error.stack || String(error);
  const state = await evaluate("({text:document.body.innerText,activations:window.launcherPendingPluginFixture?.activationSnapshot(),pluginExpansions:window.launcherPendingPluginFixture?.pluginExpandSnapshot()})").catch(() => null);
  try { await writeFile(`${output}/browser-failure-state.json`, JSON.stringify({ failure, state, issues }, null, 2), { flag: "wx" }); } catch { /* Preserve failure report attempt in final block. */ }
  console.error(failure);
} finally {
  const urls = await evaluate("performance.getEntriesByType('resource').map(entry=>entry.name)").catch(() => []);
  try { await writeFile(`${output}/runtime-resource-urls.json`, JSON.stringify(urls, null, 2), { flag: "wx" }); } catch (error) { cleanup.push("resource-url-write: " + String(error)); }
  for (const [name, close] of [["page", () => page?.close()], ["chrome", () => chrome?.close()], ["vite", () => server?.close()]]) {
    try { await close(); cleanup.push(name + ":closed"); } catch (error) { cleanup.push(name + ":" + String(error)); }
  }
  if (before.length && !await readFile(`${output}/source-after.json`).then(() => true, () => false)) {
    const after = await fingerprint().catch(error => [{ error: String(error) }]);
    try { await writeFile(`${output}/source-after.json`, JSON.stringify(after, null, 2), { flag: "wx" }); } catch (error) { cleanup.push("source-after-write: " + String(error)); }
  }
  const report = { status, checks, issues, expectedErrors, requests: requests.length, foreignRequests: requests.filter(url => !url.startsWith(origin) && !/^(data:|blob:|about:)/.test(url)), geometry, screenshots, screenshotErrors, failure, cleanup,
    scope: "Real Chromium App + ResultRow + PluginPanel with narrowly authorized in-memory mock IPC and preview main_url; no native backend, TaskRun, original-plugin, or cancellation claim." };
  try { await writeFile(`${output}/browser-result.json`, JSON.stringify(report, null, 2) + "\n", { flag: "wx" }); } catch (error) { console.error("Could not write browser-result.json: " + String(error)); status = "failed"; }
}
if (status !== "passed") process.exitCode = 1;
else console.log(JSON.stringify({ status, checks, report: `${output}/browser-result.json` }));
