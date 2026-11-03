import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { build } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { CdpClient, createPageWebSocketUrl, delay } from "./chrome-cdp-smoke-utils.mjs";
import { launchManagedChrome } from "./lib/paintbrush-node-save-fixture.mjs";
import { observeOwnedProcessGroup } from "./lib/paintbrush-probe-resource-journal.mjs";
import { capturePanelSources, fingerprintsEqual } from "./lib/native-panel-source-binding.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const runId = randomUUID();
const output = join(root, "output/plugin-inventory-keyboard-browser-2026-10-19", runId);
const reportPath = join(output, "report.json");
const checks = [];
const cleanup = {};
let scratch, chrome, page, before, report;
let stage = "setup";

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function compileFixture() {
  const outputs = await build({
    configFile: false,
    root,
    mode: "test",
    logLevel: "warn",
    plugins: [svelte()],
    build: {
      write: false,
      emptyOutDir: false,
      cssCodeSplit: false,
      minify: true,
      lib: {
        entry: join(root, "tests/components/pluginInventoryKeyboardBrowserFixture.ts"),
        name: "PluginInventoryKeyboardFixture",
        formats: ["iife"],
        fileName: () => "inventory-fixture.js",
      },
      rollupOptions: {
        output: { inlineDynamicImports: true, manualChunks: undefined },
      },
    },
  });
  const files = (Array.isArray(outputs) ? outputs : [outputs]).flatMap(result => result.output ?? []);
  const script = files.find(file => file.type === "chunk" && file.fileName.endsWith(".js"));
  const css = files.find(file => file.type === "asset" && file.fileName.endsWith(".css"));
  assert.ok(script?.code, "Vite should produce one inline IIFE for the actual inventory component");
  assert.ok(css?.source, "Vite should extract the real component styles");
  assert.equal(files.filter(file => file.type === "chunk").length, 1, "The standalone fixture must not need secondary chunks");
  assert.ok(!script.code.includes("import.meta.hot") && !script.code.includes("@vite/client"));
  return { script: script.code, css: Buffer.from(css.source).toString("utf8"), scriptSha256: sha256(script.code), cssSha256: sha256(css.source) };
}

async function cdp(method, params = {}, timeoutMs = 12000) {
  return page.send(method, params, { timeoutMs });
}

async function evaluate(expression) {
  const response = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!response.exceptionDetails, response.exceptionDetails?.exception?.description || response.exceptionDetails?.text);
  return response.result.value;
}

async function waitFor(expression, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(expression);
    if (last) return last;
    await delay(25);
  }
  assert.fail(`Timed out waiting for ${expression}; last=${JSON.stringify(last)}`);
}

async function key(keyName, code, windowsVirtualKeyCode, modifiers = 0) {
  const params = { key: keyName, code, windowsVirtualKeyCode, modifiers };
  const enterText = keyName === "Enter" && modifiers === 0 ? { text: "\r", unmodifiedText: "\r" } : {};
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...enterText });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

async function click(selector) {
  const box = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height,disabled:e.disabled===true}})()`);
  assert.ok(box && box.w > 0 && box.h > 0, `Missing visible control ${selector}`);
  assert.equal(box.disabled, false, `Control is disabled: ${selector}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
}

async function fixture(expression) {
  return evaluate(`window.pluginInventoryKeyboardFixture.${expression}`);
}

async function pageState() {
  return evaluate(`(()=>{const nav=document.querySelector('.pagination');return{label:nav?.querySelector('span')?.textContent.trim()||'1 / 1',
    rows:[...document.querySelectorAll('.plugin-list [data-plugin-detail-id]')].map(e=>e.dataset.pluginDetailId),
    active:document.activeElement?.dataset?.pluginDetailId||document.activeElement?.getAttribute('aria-label')||document.activeElement?.tagName,
    listReads:window.pluginInventoryKeyboardFixture.calls.filter(c=>c.command==='list_plugins').length,
    unexpected:[...window.pluginInventoryKeyboardFixture.unexpectedCommands]}})()`);
}

async function mount(count) {
  await fixture(`mount(${count})`);
  await waitFor("document.querySelector('.plugin-list') && document.querySelectorAll('.plugin-list [data-plugin-detail-id]').length > 0");
  await waitFor("!document.querySelector('.plugin-list')?.getAttribute('aria-busy') || document.querySelector('.plugin-list')?.getAttribute('aria-busy')==='false'");
  const value = await pageState();
  assert.equal(value.rows.length, Math.min(count, 30));
  assert.equal(value.listReads, 1, `Mounting ${count} records should read the inventory once`);
  assert.deepEqual(value.unexpected, []);
  assert.ok(value.rows.length <= 30, "Only one bounded page may be rendered");
  return value;
}

async function focusRow(index) {
  return evaluate(`(()=>{const e=document.querySelectorAll('.plugin-list button[data-plugin-detail-id]')[${index}];e?.focus({preventScroll:true});return e?.dataset.pluginDetailId||null})()`);
}

async function assertStableSideEffects(readsBefore, callsBefore) {
  const current = await pageState();
  assert.equal(current.listReads, readsBefore, "Keyboard navigation must not reread the plugin inventory");
  assert.deepEqual(current.unexpected, [], "The fixture rejects unexpected commands");
  assert.equal((await fixture("calls.length")), callsBefore, "Keyboard-only navigation must issue no IPC");
}

async function verify31() {
  stage = "31-items-cross-page-and-boundaries";
  let state = await mount(31);
  const reads = state.listReads, calls = await fixture("calls.length");
  const origin30 = state.rows[29], target31 = "keyboard-31";
  assert.equal(await focusRow(29), origin30);
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor(`document.activeElement?.dataset.pluginDetailId===${JSON.stringify(target31)}`);
  state = await pageState();
  assert.equal(state.label, "2 / 2 · 31 个");
  assert.deepEqual(state.rows, [target31]);
  const focusout = await fixture("focusoutObservations.find(e=>e.originPluginId==='keyboard-30') || null");
  assert.ok(focusout, "Cross-page DOM replacement should report the originating button's focusout");
  await key("ArrowUp", "ArrowUp", 38);
  await waitFor(`document.activeElement?.dataset.pluginDetailId===${JSON.stringify(origin30)}`);
  state = await pageState();
  assert.equal(state.label, "1 / 2 · 31 个");
  await key("Home", "Home", 36);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-01'");
  await key("ArrowUp", "ArrowUp", 38);
  assert.equal((await pageState()).active, "keyboard-01", "ArrowUp at the first row must not wrap");
  await key("End", "End", 35);
  assert.equal((await pageState()).active, origin30, "End stays on the current page's last row");
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor(`document.activeElement?.dataset.pluginDetailId===${JSON.stringify(target31)}`);
  await key("ArrowDown", "ArrowDown", 40);
  state = await pageState();
  assert.equal(state.label, "2 / 2 · 31 个", "The final page clamps without wrapping");
  assert.equal(state.active, target31);
  await assertStableSideEffects(reads, calls);
  checks.push({ id: "31-row-cross-page", result: "pass", evidence: "ArrowDown 30→31 and ArrowUp 31→30 change exactly one page and preserve selected identity; Home/End and final-page boundary clamp locally.", focusout });
}

async function verify61() {
  stage = "61-items-three-page-boundaries";
  let state = await mount(61);
  const reads = state.listReads, calls = await fixture("calls.length");
  await focusRow(29);
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-31'");
  state = await pageState();
  assert.equal(state.label, "2 / 3 · 61 个");
  assert.equal(state.rows.length, 30);
  await key("Home", "Home", 36);
  assert.equal((await pageState()).active, "keyboard-31", "Home stays within the current page");
  await key("End", "End", 35);
  assert.equal((await pageState()).active, "keyboard-60", "End stays within the current page");
  await key("Home", "Home", 36);
  assert.equal((await pageState()).active, "keyboard-31");
  await key("ArrowUp", "ArrowUp", 38);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-30'");
  await focusRow(29);
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-31'");
  assert.equal((await pageState()).label, "2 / 3 · 61 个");
  await key("End", "End", 35);
  assert.equal((await pageState()).active, "keyboard-60");
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-61'");
  state = await pageState();
  assert.equal(state.label, "3 / 3 · 61 个");
  assert.deepEqual(state.rows, ["keyboard-61"]);
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal((await pageState()).active, "keyboard-61", "The final row clamps without wrapping");
  await key("ArrowUp", "ArrowUp", 38);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-60'");
  state = await pageState();
  assert.equal(state.label, "2 / 3 · 61 个");
  await assertStableSideEffects(reads, calls);
  checks.push({ id: "61-row-three-page", result: "pass", evidence: "Both page edges cross to the adjacent identity, including a one-row final page; rendered DOM stays at or below 30 and only one list_plugins read occurs per mount." });
}

async function verifyUnaffectedControls() {
  stage = "search-row-actions-modifiers-and-detail-return";
  const state = await mount(61), reads = state.listReads, calls = await fixture("calls.length");
  const searchSelector = 'input[aria-label="筛选已安装插件"]';
  await evaluate(`document.querySelector(${JSON.stringify(searchSelector)}).focus({preventScroll:true})`);
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal((await pageState()).active, "筛选已安装插件", "Search input keeps native arrows");
  const rowAction = await evaluate("document.querySelector('.plugin-list .row-action button')?.getAttribute('aria-label') || null");
  assert.ok(rowAction, "Fixture row should expose an action control");
  await evaluate("document.querySelector('.plugin-list .row-action button')?.focus({preventScroll:true})");
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal((await pageState()).active, rowAction, "Row action controls are not intercepted");
  await focusRow(0);
  const first = await pageState();
  await key("ArrowDown", "ArrowDown", 40, 2);
  assert.equal((await pageState()).active, first.rows[0], "Modified key combinations are not intercepted");
  await key("ArrowDown", "ArrowDown", 40, 8);
  assert.equal((await pageState()).active, first.rows[0], "Shift-modified navigation is not intercepted");
  await focusRow(29);
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor("document.activeElement?.dataset.pluginDetailId==='keyboard-31'");
  assert.equal((await pageState()).label, "2 / 3 · 61 个");
  const selectedId = "keyboard-31";
  await key("Enter", "Enter", 13);
  await waitFor(`document.querySelector('.plugin-detail h3')?.textContent===${JSON.stringify(`插件 ${selectedId.slice(-2)}`)}`);
  await waitFor("document.activeElement?.matches('.plugin-detail h3')");
  const detailId = await evaluate("document.querySelector('.plugin-detail .metadata code')?.textContent");
  assert.equal(detailId, selectedId);
  await key("Escape", "Escape", 27);
  await waitFor(`document.activeElement?.dataset.pluginDetailId===${JSON.stringify(selectedId)}`);
  assert.equal((await pageState()).label, "2 / 3 · 61 个", "Escape restores the same detail identity on its original page");
  await assertStableSideEffects(reads, calls);
  checks.push({ id: "controls-and-detail", result: "pass", evidence: "Search, row actions, and modified arrows retain their own behavior; CDP ArrowDown crosses to page 2, Enter opens that row's detail, and Escape restores the same identity on page 2 without additional IPC." });
}

async function verifyFocusHandoffAndInvalidation() {
  stage = "pending-focus-handoff-and-invalidation";
  let state = await mount(61);
  let reads = state.listReads;
  const handoff = await evaluate(`(()=>{const origin=document.querySelector('.plugin-list button[data-plugin-detail-id="keyboard-30"]');
    const input=document.querySelector('input[aria-label="筛选已安装插件"]');origin?.focus({preventScroll:true});
    const event=new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true});origin?.dispatchEvent(event);
    const pageBeforeFocus=document.querySelector('.pagination span')?.textContent.trim()||null;input?.focus({preventScroll:true});
    return{pageBeforeFocus,defaultPrevented:event.defaultPrevented,activeIsSearch:document.activeElement===input}})()`);
  assert.deepEqual(handoff, { pageBeforeFocus: "1 / 3 · 61 个", defaultPrevented: true, activeIsSearch: true },
    "The DOM key handler must queue the page, then an external focus change must occur before Svelte flushes it");
  await waitFor("document.querySelector('.pagination span')?.textContent.trim()==='2 / 3 · 61 个'");
  assert.equal((await pageState()).active, "筛选已安装插件", "Same-task external focus must not be stolen by a pending completion");
  assert.equal((await pageState()).listReads, reads);

  // This same-task synthetic event sequence makes a refresh win before Svelte's tick completion.
  await evaluate(`(()=>{const origin=document.querySelector('.plugin-list button[data-plugin-detail-id="keyboard-60"]');
    origin?.focus({preventScroll:true});origin?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
    document.querySelector('button[aria-label="刷新插件列表"]')?.click();return true})()`);
  await waitFor("document.querySelector('.plugin-list') && document.querySelector('.plugin-list').getAttribute('aria-busy')==='false'");
  await delay(50);
  state = await pageState();
  assert.equal(state.label, "3 / 3 · 61 个");
  assert.notEqual(state.active, "keyboard-61", "Refresh invalidates the stale focus handoff");
  assert.equal(state.listReads, reads + 1, "The explicit refresh performs exactly one allowed inventory read");
  checks.push({ id: "pending-focus-cancellation", result: "pass", evidence: "The boundary handler and external search focus execute in one JavaScript task while page DOM is still page 1; after Svelte flushes to page 2, search retains focus. A separate same-task refresh invalidates stale completion and adds exactly one explicit list_plugins read." });

  // Move back to page 2, then make a same-task manual page action beat the pending tick.
  await click('.pagination button');
  await waitFor("document.querySelector('.pagination span')?.textContent.trim()==='2 / 3 · 61 个'");
  const manualCalls = await fixture("calls.length");
  await evaluate(`(()=>{const origin=document.querySelector('.plugin-list button[data-plugin-detail-id="keyboard-60"]');
    origin?.focus({preventScroll:true});origin?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
    document.querySelector('.pagination button')?.click();return true})()`);
  await delay(50);
  state = await pageState();
  assert.ok(["1 / 3 · 61 个", "2 / 3 · 61 个"].includes(state.label), "Manual paging must supersede the pending target page");
  assert.notEqual(state.active, "keyboard-61");
  assert.equal(state.rows.length, 30);
  assert.equal(await fixture("calls.length"), manualCalls, "Manual paging must not invoke the native bridge");
}

async function verifyQueryInvalidation() {
  stage = "pending-query-invalidation";
  const initial = await mount(61), calls = await fixture("calls.length");
  await evaluate(`(()=>{const origin=document.querySelector('.plugin-list button[data-plugin-detail-id="keyboard-30"]');
    origin?.focus({preventScroll:true});origin?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
    const input=document.querySelector('input[aria-label="筛选已安装插件"]');
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;setter.call(input,'插件 61');
    input.dispatchEvent(new Event('input',{bubbles:true}));input.focus({preventScroll:true});return true})()`);
  await waitFor("document.querySelector('.pagination')===null && document.querySelector('.plugin-list [data-plugin-detail-id]')?.dataset.pluginDetailId==='keyboard-61'");
  await delay(50);
  const state = await pageState();
  assert.equal(state.active, "筛选已安装插件", "Query/filter changes do not restore a stale row focus");
  assert.equal(state.rows.length, 1);
  assert.equal(state.listReads, initial.listReads);
  assert.equal(await fixture("calls.length"), calls, "Filtering must not make another host request");
  checks.push({ id: "pending-query-invalidation", result: "pass", evidence: "A query change in the same task as the boundary key filters to one matching row without restoring the stale cross-page target." });
}

async function verifyExplicitRetryInvalidation() {
  stage = "pending-explicit-retry-invalidation";
  const initial = await mount(61);
  await fixture("failNextList()");
  await click('button[aria-label="刷新插件列表"]');
  await waitFor("document.querySelector('.notice button')?.textContent.trim()==='重试读取列表'");
  const beforeRetry = await fixture("calls.filter(c=>c.command==='list_plugins').length");
  assert.equal(beforeRetry, initial.listReads + 1, "The first failed refresh is a single explicit read");
  await evaluate(`(()=>{const origin=document.querySelector('.plugin-list button[data-plugin-detail-id="keyboard-30"]');
    origin?.focus({preventScroll:true});origin?.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',bubbles:true,cancelable:true}));
    document.querySelector('.notice button')?.click();return true})()`);
  await waitFor("document.querySelector('.pagination span')?.textContent.trim()==='2 / 3 · 61 个'");
  await waitFor("document.querySelector('.plugin-list')?.getAttribute('aria-busy')==='false'");
  await delay(35);
  const state = await pageState();
  assert.notEqual(state.active, "keyboard-31", "An explicit retry must invalidate the stale target focus");
  assert.equal(state.listReads, initial.listReads + 2, "Retry performs one additional explicit list read");
  assert.deepEqual(state.unexpected, []);
  checks.push({ id: "pending-explicit-retry", result: "pass", evidence: "After an actual list-read failure, clicking the component retry action during the cross-page task keeps the new page but does not focus its stale target; list_plugins increases only for the explicit failed read and retry." });
}

async function run() {
  await mkdir(output, { recursive: true });
  before = await capturePanelSources(root);
  const compiled = await compileFixture();
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${compiled.css.replace(/<\/style/gi, "<\\/style")}</style></head><body><main id="app"></main><script>${compiled.script.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  assert.ok(html.length < 2_500_000, "Inline fixture stays within a modest standalone document budget");
  if (process.argv.includes("--build-only")) {
    report = { runId, passed: true, stage: "build-only", scope: "Cached Vite compile only; no browser was started.", checks: [{ id: "inline-iife", result: "pass", bytes: Buffer.byteLength(html), scriptSha256: compiled.scriptSha256, cssSha256: compiled.cssSha256 }], sourceFilesSha256: before };
    return;
  }

  scratch = await mkdtemp(join(tmpdir(), "atools-inventory-keyboard-browser-"));
  chrome = await launchManagedChrome(scratch, error => String(error?.message || error), error => String(error?.code || "Error"));
  const processBefore = await observeOwnedProcessGroup(chrome.pid, "before-stop");
  assert.equal(processBefore.status, "observed");
  assert.equal(processBefore.leaderMatchesProcessGroup, true);
  const browserInfoClient = await CdpClient.connect(chrome.webSocketUrl);
  let browserVersion;
  try { browserVersion = await browserInfoClient.send("Browser.getVersion", {}, { timeoutMs: 5000 }); }
  finally { await browserInfoClient.close(); }
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable");
  const { frameTree } = await cdp("Page.getFrameTree");
  await cdp("Page.setDocumentContent", { frameId: frameTree.frame.id, html });
  await waitFor("window.pluginInventoryKeyboardFixtureReady===true");

  await verify31();
  await verify61();
  await verifyUnaffectedControls();
  await verifyFocusHandoffAndInvalidation();
  await verifyQueryInvalidation();
  await verifyExplicitRetryInvalidation();
  report = { runId, passed: true, stage: "complete", scope: "Actual PluginInventoryPanel is mounted from an inline cached-Vite IIFE in about:blank with fixture-only Tauri IPC. This validates component keyboard/page/focus behavior, not OS-native keyboard, installed plugin business behavior, or competitor parity.", checks,
    fixture: { url: "about:blank", fixtureHttp: false, rows: [31, 61], maxRenderedRows: 30, scriptBytes: Buffer.byteLength(compiled.script), cssBytes: Buffer.byteLength(compiled.css), scriptSha256: compiled.scriptSha256, cssSha256: compiled.cssSha256 },
    chromium: { pid: chrome.pid, executablePathSha256: sha256(chrome.executable), isolatedEnvironment: true,
      product: browserVersion.product, protocolVersion: browserVersion.protocolVersion }, processBefore,
    sourceFilesSha256: before, sourceHashStable: null };
}

try {
  await run();
} catch (error) {
  process.exitCode = 1;
  report = { runId, passed: false, stage, checks, error: error?.stack || String(error), sourceFilesSha256: before };
} finally {
  if (page) await page.close().then(() => { cleanup.cdpClosed = true; }, error => { cleanup.cdpClosed = false; cleanup.cdpErrorCode = String(error?.code || "Error"); });
  else cleanup.cdpClosed = true;
  if (chrome) {
    const processBefore = report?.processBefore || await observeOwnedProcessGroup(chrome.pid, "before-stop");
    const stop = await chrome.close().catch(error => ({ closeErrorCode: String(error?.code || "Error") }));
    const processAfter = await observeOwnedProcessGroup(chrome.pid, "after-stop", processBefore.identity);
    cleanup.chrome = { ...stop, processBefore: { status: processBefore.status, leaderMatchesProcessGroup: processBefore.leaderMatchesProcessGroup },
      processAfter: { status: processAfter.status, observedGroupEmpty: processAfter.observedGroupEmpty,
        leaderIdentityPresent: processAfter.leaderIdentityPresent, groupMemberCount: processAfter.groupMemberCount } };
    if (!processAfter.observedGroupEmpty || !stop.processCloseObserved || !stop.isolatedEnvironmentRemoved) process.exitCode = 1;
  }
  if (scratch) await rm(scratch, { recursive: true, force: true }).then(() => { cleanup.scratchRemoved = true; }, () => { cleanup.scratchRemoved = false; process.exitCode = 1; });
  if (before) {
    try {
      const after = await capturePanelSources(root);
      if (report) { report.sourceFilesSha256AtEnd = after; report.sourceHashStable = fingerprintsEqual(before, after); }
      if (!fingerprintsEqual(before, after)) process.exitCode = 1;
    } catch (error) { cleanup.sourceRecheckError = String(error?.code || error?.name || "Error"); process.exitCode = 1; }
  }
  if (report) {
    report.passed = process.exitCode !== 1 && report.passed;
    report.cleanup = cleanup;
    await mkdir(output, { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ reportPath, runId, passed: report.passed, stage: report.stage, checks: checks.length, cleanup })}\n`);
  }
}
