import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import { dirname, resolve, isAbsolute, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, delay } from "./chrome-cdp-smoke-utils.mjs";
import { launchOwnedChrome, launchOwnedVite, isOwnedResourceClean } from "./lib/launcher-menu-browser-runtime.mjs";
import { boundedOriginalCdp, createOriginalPageTarget, navigateOriginalPage } from "./lib/original-plugin-browser-deadline.mjs";
import { connectOriginalCdpSocket } from "./lib/original-plugin-browser-websocket.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.argv[2];
assert(output && isAbsolute(output) && output.endsWith(".json"), "Pass a fresh absolute private report.json path");
assert(relative(root, output).startsWith(`..${sep}`), "Report must be outside the repository");
await mkdir(dirname(output), { recursive: true });
await access(output).then(() => { throw Error("Report already exists"); }, error => { if (error.code !== "ENOENT") throw error; });
const selected = [
  "src/App.svelte", "src/components/ResultsList.svelte", "src/components/ResultRow.svelte", "src/components/SearchBar.svelte",
  "src/components/SearchStatusBar.svelte", "src/lib/searchStatusBar.ts",
  "src/lib/resultListPaging.ts", "src/lib/resultListViewport.ts", "src/lib/resultPresentation.ts", "src/lib/launcherKeyboard.ts",
  "src/lib/keyboardTarget.ts", "src/lib/launcherSearch.ts", "src/styles/global.css", "vite.config.ts", "package.json", "pnpm-lock.yaml",
  "tests/components/launcherPagingBrowserFixture.ts", "tests/components/launcher-paging-browser.html",
  "scripts/probe-launcher-result-paging-browser.mjs", "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs", "scripts/lib/original-plugin-browser-deadline.mjs",
  "scripts/lib/original-plugin-browser-websocket.mjs",
];
async function fingerprints() {
  return Object.fromEntries(await Promise.all(selected.map(async path => { const bytes = await readFile(resolve(root, path));
    return [path, { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }]; })));
}
const report = { schemaVersion: 1, passed: false,
  scope: "Real Chromium layout and CDP key events on production App/components; generated1200-row mock-IPC catalog. No macOS physical keyboard, native IPC/plugin business, competitor or application latency/RSS claim; selected inputs are not a dependency closure.",
  checks: {}, measurements: [], screenshots: [], cleanup: { errors: [], page: "not_created",
    vite: { state: "not_started", closeState: "not_created", cacheState: "not_created" },
    chrome: { state: "not_started", processState: "not_spawned", profileState: "not_created" } }, before: await fingerprints() };
let server, chrome, page;
const errors = [];
function check(value, name) { assert(value, name); report.checks[name] = true; }
async function evaluate(page, expression) {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, { timeoutMs: 15000 });
  assert(!reply.exceptionDetails, reply.exceptionDetails?.exception?.description || reply.exceptionDetails?.text);
  return reply.result.value;
}
async function waitFor(page, expression, name = expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const value = await evaluate(page, expression); if (value) return value; await delay(25); }
  throw Error("Deadline: " + name);
}
async function key(value, number, modifiers = 0) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: value, code: value, windowsVirtualKeyCode: number, modifiers });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: value, code: value, windowsVirtualKeyCode: number, modifiers });
}
async function state() {
  return evaluate(page, `(() => { const input=document.querySelector('[role=combobox]'),list=document.querySelector('[role=listbox]');
    const id=input?.getAttribute('aria-activedescendant'), option=id&&document.getElementById(id), box=option?.getBoundingClientRect(),viewport=list?.getBoundingClientRect();
    return {id,code:option?.dataset.resultCode,visual:Number(option?.getAttribute('aria-posinset')),selected:option?.getAttribute('aria-selected'),
      count:Number(option?.getAttribute('aria-setsize')),rendered:document.querySelectorAll('[role=option]').length,scroll:list?.scrollTop,height:list?.clientHeight,
      query:input?.value,focused:document.activeElement===input,visible:!!box&&box.top>=viewport.top-1&&box.bottom<=viewport.bottom+1,
      activated:window.fixture.calls.filter(c=>c.command==='activate_feature').length,overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
}
async function shot(name) {
  await evaluate(page, "Promise.all(document.getAnimations().filter(a=>a.effect?.getTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))");
  const result = await page.send("Page.captureScreenshot", { format: "png" });
  const path = resolve(dirname(output), name); const bytes = Buffer.from(result.data, "base64");
  await writeFile(path, bytes, { flag: "wx" }); report.screenshots.push({ path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
}
try {
  server = await launchOwnedVite({ root, port: 15139 });
  chrome = await launchOwnedChrome();
  const socket = await connectOriginalCdpSocket(await createOriginalPageTarget(chrome.webSocketUrl));
  page = boundedOriginalCdp(new CdpClient(socket), { totalMs: 60000, commandMs: 10000, closeMs: 1500 });
  await page.send("Page.enable"); await page.send("Runtime.enable");
  page.on("Runtime.exceptionThrown", event => errors.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 650, deviceScaleFactor: 1, mobile: false });
  await navigateOriginalPage(page, server.origin + "/tests/components/launcher-paging-browser.html");
  await page.send("Page.bringToFront");
  await waitFor(page, "document.hasFocus() && document.visibilityState==='visible' && window.launcherFixtureReady && document.querySelector('[role=combobox]')", "actual visible browser App readiness");
  report.focusAdmission = { command: "Page.bringToFront", focusEmulation: false,
    state: await evaluate(page, "({focused:document.hasFocus(),visibility:document.visibilityState})") };
  await evaluate(page, `(() => { const i=document.querySelector('[role=combobox]'); i.focus(); i.value='page-fixture'; i.dispatchEvent(new InputEvent('input',{bubbles:true})); })()`);
  await waitFor(page, "document.querySelector('[role=option][aria-selected=true]')?.getAttribute('aria-setsize')==='1200'", "complete generated catalog");
  await waitFor(page, "window.fixture.calls.some(c=>c.command==='search_plugin_main_push_candidates') && !document.querySelector('.feedback-strip')", "empty dynamic source settled");
  let previous = await state(); check(previous.visible && previous.focused && !previous.overflow, "Initial actual selected option is visible and focused");
  await shot("paging-light.png");
  for (const [name, number, direction] of [["PageDown", 34, 1], ["PageDown", 34, 1], ["PageUp", 33, -1]]) {
    await key(name, number);
    await waitFor(page, `document.querySelector('[role=combobox]').getAttribute('aria-activedescendant')!==${JSON.stringify(previous.id)}`, "page selection changes");
    await waitFor(page, "document.querySelector('[role=option][aria-selected=true]')!==null");
    await delay(40); const next = await state();
    check((next.visual - previous.visual) * direction > 1, name + " moves a measured page in visual group order " + report.measurements.length);
    check(next.visible && next.focused && next.selected === "true" && next.query === "page-fixture" && next.activated === 0 && next.rendered < 40,
      "Page keeps real virtual option, scroll, query and activation boundaries " + report.measurements.length);
    report.measurements.push({ key: name, before: previous, after: next }); previous = next;
  }
  const stable = previous.id; await key("PageDown", 34, 8); await delay(40);
  check((await state()).id === stable, "Shift PageDown preserves native modified-key ownership");
  await evaluate(page, "document.documentElement.dataset.atoolsTheme='dark'"); await shot("paging-dark.png");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 650, deviceScaleFactor: 1, mobile: false });
  await key("PageDown", 34); await delay(60); const compact = await state();
  check(compact.visible && !compact.overflow && compact.activated === 0, "480px layout retains visible selection without horizontal overflow");
  report.compact = compact; await shot("paging-compact.png");
  const footer = await evaluate(page, `(()=>{
    const node=document.querySelector('.search-status-bar'),copy=node?.querySelector('.status-copy'),hints=node?.querySelector('.status-hints');
    if(!node||!copy||!hints)return null;
    const rect=node.getBoundingClientRect(),cr=copy.getBoundingClientRect(),hr=hints.getBoundingClientRect();
    const visible=element=>!!element.getClientRects().length&&getComputedStyle(element).visibility!=='hidden';
    const items=[...hints.querySelectorAll('.hint')].filter(visible);
    const labels=items.flatMap(item=>[...item.querySelectorAll('kbd,span')].filter(visible));
    const intact=labels.every(label=>{const range=document.createRange();range.selectNodeContents(label);
      const text=range.getBoundingClientRect(),box=label.getBoundingClientRect();return text.left>=box.left-.5&&text.right<=box.right+.5&&text.top>=box.top-.5&&text.bottom<=box.bottom+.5;});
    return {height:rect.height,intact,noOverlap:cr.right<=hr.left+.5,contained:hr.right<=rect.right+.5,
      visibleKeys:items.map(item=>item.querySelector('kbd')?.textContent),visibleLabels:labels.map(label=>label.textContent)};
  })()`);
  check(footer?.height===34&&footer.intact&&footer.noOverlap&&footer.contained
    &&["Enter","Tab","Esc"].every(key=>footer.visibleKeys.includes(key)),
    "Actual 480px App footer keeps complete key labels, separate status and 34px height");
  report.compactFooter=footer;
  check(errors.length === 0, "No browser runtime exceptions"); report.passed = true;
} catch (error) {
  report.error = String(error.stack || error);
  if (error.atoolsLifecycle) Object.assign(report.cleanup, error.atoolsLifecycle);
}
finally {
  for (const [name, resource] of [["page", page], ["chrome", chrome], ["vite", server]]) {
    try { if (resource) { const closed = await resource.close(); report.cleanup[name] = name === "page" ? "closed" : closed;
      if (name === "page") report.transport = closed; } }
    catch (error) { report.cleanup.errors.push(name + ": " + String(error)); if (error.atoolsLifecycle) report.cleanup[name] = error.atoolsLifecycle[name]; }
  }
  report.cleanup.allOwnedResourcesClean = report.cleanup.errors.length === 0
    && ["closed", "not_created"].includes(report.cleanup.page)
    && isOwnedResourceClean(report.cleanup.vite?.closeState) && isOwnedResourceClean(report.cleanup.vite?.cacheState)
    && isOwnedResourceClean(report.cleanup.chrome?.processState) && isOwnedResourceClean(report.cleanup.chrome?.profileState)
    && report.transport?.socketDestroyed===true && report.transport?.pendingAtClose===0
    && report.transport?.eventWaitsAtClose===0 && report.transport?.deadlineTimerCleared===true;
  report.after = await fingerprints(); report.sourcesUnchanged = JSON.stringify(report.before) === JSON.stringify(report.after);
  report.browserErrors = errors; report.passed = report.passed && report.sourcesUnchanged && report.cleanup.allOwnedResourcesClean;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
console.log(JSON.stringify({ passed: report.passed, checks: Object.keys(report.checks).length, cleanup: report.cleanup.allOwnedResourcesClean, sourcesUnchanged: report.sourcesUnchanged, output }));
if (!report.passed) process.exitCode = 1;
