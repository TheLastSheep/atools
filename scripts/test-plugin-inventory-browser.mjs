import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";

const runId = randomUUID(), origin = "http://127.0.0.1:1464";
const output = new URL(`../output/plugin-inventory-2026-10-16/${runId}/`, import.meta.url);
const checks = [], screenshots = [], network = [], navigation = [], consoleIssues = [], expectedConsole = [], layouts = [], timings = [];
const cleanup = {};
let page, chrome, preview, buildDir, compiled, before, report, stage = "setup";
let keyboardStartupFeatureCatalogRetries = 0;
let keyboardFocusVisibility = { at800: null, at420: null };
async function inputs(dir = resolve("src")) {
  const paths = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) paths.push(...await inputs(file));
    else if (/\.(?:ts|svelte|css)$/.test(file)) paths.push(relative(process.cwd(), file));
  }
  return paths;
}
async function hashes() {
  const files = [...await inputs(), "tests/components/pluginInventoryBrowserFixture.ts", "tests/components/plugin-inventory-browser.html",
    "scripts/test-plugin-inventory-browser.mjs", "scripts/lib/static-browser-fixture.mjs", "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
    "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs", "vite.config.ts", "package.json", "pnpm-lock.yaml"];
  return Object.fromEntries(await Promise.all(files.sort().map(async file => [file, createHash("sha256").update(await readFile(file)).digest("hex")])));
}
async function cdp(method, params = {}) { return page.send(method, params, { timeoutMs: 12000 }); }
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await delay(35); }
  assert.fail(`Timed out: ${expression}`);
}
async function key(key, code, windowsVirtualKeyCode, modifiers = 0) {
  const params = { key, code, windowsVirtualKeyCode, modifiers };
  const enterText = key === "Enter" && modifiers === 0 ? { text: "\r", unmodifiedText: "\r" } : {};
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...enterText });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await delay(50);
}
async function click(expression) {
  const box = await evaluate(`(()=>{const e=${expression};if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return{x,y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,disabled:e.disabled===true,hit:hit===e||e.contains(hit),vw:innerWidth,vh:innerHeight}})()`);
  assert.ok(box, `Missing target: ${expression}`); assert.equal(box.disabled, false, expression);
  assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0 && box.right <= box.vw && box.bottom <= box.vh && box.hit, JSON.stringify(box));
  for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  await delay(70);
}
function q(selector) { return `document.querySelector(${JSON.stringify(selector)})`; }
async function button(text, parent = "document") { return click(`Array.from(${parent}.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`); }
async function fixture(expression) { return evaluate(`window.pluginInventoryFixture.${expression}`); }
async function count(command) { return fixture(`calls.filter(c=>c.command===${JSON.stringify(command)}).length`); }
async function viewport(width, height, theme) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await delay(130);
}
async function shot(name) {
  await cdp("Page.bringToFront"); await delay(100);
  const result = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(result.data, "base64"), file = `${name}.png`;
  await writeFile(new URL(file, output), bytes);
  screenshots.push({ file, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}
async function geometry(label) {
  const value = await evaluate(`(()=>{const box=e=>{if(!e)return null;const r=e.getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}};return{label:${JSON.stringify(label)},width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,inventory:box(document.querySelector('.inventory')),content:box(document.querySelector('.content-panel')),notice:box(document.querySelector('.inventory .notice')),rowCount:document.querySelectorAll('.inventory .plugin-row').length,detail:Boolean(document.querySelector('.plugin-detail')),focused:document.activeElement?.getAttribute('aria-label')||document.activeElement?.textContent?.trim().slice(0,70),overflow:Array.from(document.querySelectorAll('.inventory,.plugin-detail,.inventory .notice,.content-panel')).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)}})()`);
  assert.ok(value.documentWidth <= value.width && value.bodyWidth <= value.width, JSON.stringify(value));
  assert.deepEqual(value.overflow, [], JSON.stringify(value)); assert.ok(value.rowCount <= 30);
  layouts.push(value); return value;
}
async function focusedEntryVisibility() {
  return evaluate(`(()=>{const e=document.activeElement;if(!(e instanceof HTMLButtonElement)||!e.matches('button[data-plugin-detail-id]'))return null;const r=e.getBoundingClientRect();let top=0,right=innerWidth,bottom=innerHeight,left=0;for(let p=e.parentElement;p&&p!==document.documentElement;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(['auto','scroll','hidden','clip'].includes(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}if(['auto','scroll','hidden','clip'].includes(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}}const inset=5;return{id:e.dataset.pluginDetailId,rect:{top:r.top,right:r.right,bottom:r.bottom,left:r.left,width:r.width,height:r.height},clip:{top,right,bottom,left},fullyVisible:r.width>0&&r.height>0&&r.top>=top+inset&&r.right<=right-inset&&r.bottom<=bottom-inset&&r.left>=left+inset}})()`);
}
async function waitForFocusedEntryVisibility(expectedId) {
  const deadline = Date.now() + 12000;
  let value;
  while (Date.now() < deadline) {
    value = await focusedEntryVisibility();
    if (value?.id === expectedId && value.fullyVisible) return value;
    await delay(35);
  }
  assert.fail(`Focused plugin row did not remain fully visible after resize: ${JSON.stringify(value)}`);
}
async function search(text, expectedRows) {
  await click(q('input[aria-label="筛选已安装插件"]'));
  await evaluate("document.querySelector('input[aria-label=\"筛选已安装插件\"]').select()");
  const start = await evaluate("performance.now()");
  await cdp("Input.insertText", { text });
  if (!text) await key("Backspace", "Backspace", 8);
  await waitFor(`document.querySelectorAll('.inventory .plugin-row').length===${expectedRows}`);
  const end = await evaluate("performance.now()");
  timings.push({ queryLength: text.length, rows: expectedRows, inputToObservedRowsMs: end - start, includesCdpRoundTripsAndPolling: true });
}
async function openManagementFromHome() {
  await waitFor("Array.from(document.querySelectorAll('.capability-rail button')).some(e=>e.textContent.trim()==='插件管理')");
  await button("插件管理", "document.querySelector('.capability-rail')");
  await waitFor("document.querySelector('.inventory .plugin-row') && !document.querySelector('.inventory [aria-busy=true]')");
}
async function detail(id) { await click(q(`[data-plugin-detail-id="${id}"]`)); await waitFor("document.querySelector('.plugin-detail h3')===document.activeElement"); }
try {
  await mkdir(output, { recursive: true }); before = await hashes(); buildDir = await mkdtemp(join(tmpdir(), "atools-inventory-browser-"));
  compiled = await buildStaticBrowserFixture({ projectRoot: process.cwd(), entryHtml: "tests/components/plugin-inventory-browser.html", outDir: join(buildDir, "dist") });
  const bundle = (await Promise.all(compiled.outputFiles.filter(f => /\.(?:html|js)$/.test(f)).map(f => readFile(join(buildDir, "dist", f), "utf8")))).join("\n");
  assert.ok(!bundle.includes("@vite/client") && !bundle.includes("import.meta.hot"));
  preview = await previewStaticBrowserFixture({ projectRoot: process.cwd(), outDir: join(buildDir, "dist"), host: "127.0.0.1", port: 1464 });
  chrome = await launchChrome(); page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", e => consoleIssues.push(e.exceptionDetails?.exception?.description || e.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (!["error", "warning", "assert"].includes(type)) return; const line = `${type}:${formatConsoleArgs(args)}`; if (line === "error:Plugin activation failed.") expectedConsole.push(line); else consoleIssues.push(line); });
  page.on("Network.requestWillBeSent", e => network.push(e.request.url));
  page.on("Page.frameNavigated", e => { if (!e.frame.parentId) navigation.push(e.frame.url); });
  await viewport(800, 600, "light"); const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: `${origin}/${compiled.htmlFile}` }); await loaded;
  stage = "home-management-and-bounded-catalogue"; await openManagementFromHome();
  assert.equal(await count("list_plugins"), 1); assert.equal(await evaluate("document.querySelectorAll('.inventory .plugin-row').length"), 30);
  assert.match(await evaluate("document.querySelector('.inventory-header')?.innerText"), /1200/);
  assert.equal(await evaluate("document.querySelectorAll('.settings-header .atools-mark').length"), 1);
  assert.equal(await evaluate("document.querySelector('.settings-header h1')?.textContent"), "设置");
  assert.equal(await evaluate("document.querySelector('.inventory .notice')===null"), true);
  assert.equal(await evaluate("(()=>{const node=document.querySelector('.inventory-announcement');if(!node)return false;const r=node.getBoundingClientRect();return node.textContent.includes('1200')&&r.width<=1&&r.height<=1;})()"), true);
  stage = "installed-inventory-keyboard-enter-escape";
  const listReadsBeforeKeyboard = await count("list_plugins");
  const allCallsBeforeKeyboard = await fixture("calls.length");
  const sideEffectCommands = ["set_setting", "plugin:dialog|open", "activate_feature", "toggle_plugin", "authorize_plugin_permissions", "uninstall_plugin", "install_plugin", "update_plugin_from_path", "call_agent_tool"];
  const sideEffectsBeforeKeyboard = await fixture(`calls.filter(c=>${JSON.stringify(sideEffectCommands)}.includes(c.command)).length`);
  const firstIdentity = await evaluate(`(()=>{const button=document.querySelector('.plugin-list button[data-plugin-detail-id]');button?.focus({preventScroll:true});return button?.dataset.pluginDetailId||null})()`);
  assert.ok(firstIdentity);
  assert.equal(await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]').length"), 30);
  const secondIdentity = await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]')[1]?.dataset.pluginDetailId");
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), secondIdentity);
  await key("Home", "Home", 36);
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), firstIdentity);
  await key("ArrowUp", "ArrowUp", 38);
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), firstIdentity, "ArrowUp at the first row must not wrap");
  assert.equal(await evaluate("document.querySelector('.pagination span')?.textContent.trim()"), "1 / 40 · 1200 个",
    "ArrowUp at the first row must remain on the first page");
  await key("End", "End", 35);
  const lastIdentity = await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]')[29]?.dataset.pluginDetailId");
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), lastIdentity);
  assert.equal(await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]').length"), 30);
  assert.equal(lastIdentity, "catalogue-0044", "The first page ends at the last enabled synthetic catalogue row");
  assert.equal(await fixture("installed.find(plugin=>plugin.id==='catalogue-0045')?.enabled"), false,
    "The next catalogue identity is disabled and is sorted after enabled entries");
  await key("ArrowDown", "ArrowDown", 40);
  await waitFor("document.querySelector('.pagination span')?.textContent.trim() === '2 / 40 · 1200 个'");
  const secondPageFirstIdentity = await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]')[0]?.dataset.pluginDetailId");
  assert.equal(secondPageFirstIdentity, "catalogue-0046", "Cross-page navigation must land on the next enabled item after the disabled record");
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), secondPageFirstIdentity,
    "ArrowDown at a page boundary must focus the first row on the next page");
  await key("ArrowDown", "ArrowDown", 40, 2);
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), secondPageFirstIdentity, "Modified ArrowDown must remain unhandled");
  await evaluate("document.querySelector('input[aria-label=\"筛选已安装插件\"]')?.focus({preventScroll:true})");
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal(await evaluate("document.activeElement?.getAttribute('aria-label')"), "筛选已安装插件", "Search-field navigation must remain native");
  await evaluate(`document.querySelector('[data-plugin-detail-id="${secondPageFirstIdentity}"]')?.focus({preventScroll:true})`);
  await key("ArrowUp", "ArrowUp", 38);
  await waitFor(`document.querySelector('.pagination span')?.textContent.trim() === '1 / 40 · 1200 个' && document.activeElement?.dataset.pluginDetailId === ${JSON.stringify(lastIdentity)}`);
  await evaluate(`document.querySelector('[data-plugin-detail-id="${lastIdentity}"]')?.focus({preventScroll:true})`);
  const openingTitle = await evaluate("document.activeElement?.querySelector('.plugin-copy strong')?.textContent");
  await key("Enter", "Enter", 13);
  await waitFor("document.querySelector('.plugin-detail h3')===document.activeElement");
  assert.equal(await evaluate("document.querySelector('.plugin-detail h3')?.textContent"), openingTitle);
  assert.equal(await evaluate("document.querySelector('.plugin-detail .metadata code')?.textContent"), lastIdentity);
  assert.equal(await evaluate("document.querySelector('.settings-header h1')?.textContent"), "设置");
  await viewport(420, 560, "light"); await geometry("keyboard-opened-detail-420-light");
  await key("Escape", "Escape", 27);
  await waitFor(`document.activeElement?.dataset.pluginDetailId===${JSON.stringify(lastIdentity)}`);
  assert.equal(await evaluate("document.querySelector('.settings-header h1')?.textContent"), "设置");
  await viewport(800, 600, "light");
  keyboardFocusVisibility.at800 = await waitForFocusedEntryVisibility(lastIdentity);
  assert.equal(keyboardFocusVisibility.at800.id, lastIdentity, JSON.stringify(keyboardFocusVisibility.at800));
  assert.equal(keyboardFocusVisibility.at800.fullyVisible, true, JSON.stringify(keyboardFocusVisibility.at800));
  await viewport(420, 560, "light");
  keyboardFocusVisibility.at420 = await waitForFocusedEntryVisibility(lastIdentity);
  assert.equal(keyboardFocusVisibility.at420.fullyVisible, true, JSON.stringify(keyboardFocusVisibility.at420));
  await viewport(800, 600, "light");
  for (let expectedPage = 2; expectedPage <= 40; expectedPage += 1) {
    await key("ArrowDown", "ArrowDown", 40);
    await waitFor(`document.querySelector('.pagination span')?.textContent.trim() === '${expectedPage} / 40 · 1200 个'`);
    const firstPageIdentity = await evaluate("document.querySelector('.plugin-list button[data-plugin-detail-id]')?.dataset.pluginDetailId");
    assert.ok(firstPageIdentity, `Page ${expectedPage} must render a detail row`);
    assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), firstPageIdentity,
      `ArrowDown must focus the first row on page ${expectedPage}`);
    if (expectedPage < 40) await key("End", "End", 35);
  }
  await key("End", "End", 35);
  const finalIdentity = await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]')[29]?.dataset.pluginDetailId");
  assert.ok(finalIdentity);
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), finalIdentity);
  await key("ArrowDown", "ArrowDown", 40);
  assert.equal(await evaluate("document.querySelector('.pagination span')?.textContent.trim()"), "40 / 40 · 1200 个");
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), finalIdentity,
    "ArrowDown at the final row of the full catalogue must clamp without wrapping");
  for (let expectedPage = 39; expectedPage >= 1; expectedPage -= 1) {
    await key("Home", "Home", 36);
    await key("ArrowUp", "ArrowUp", 38);
    await waitFor(`document.querySelector('.pagination span')?.textContent.trim() === '${expectedPage} / 40 · 1200 个'`);
    const lastPageIdentity = await evaluate("document.querySelectorAll('.plugin-list button[data-plugin-detail-id]')[29]?.dataset.pluginDetailId");
    assert.ok(lastPageIdentity, `Page ${expectedPage} must render its final detail row`);
    assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), lastPageIdentity,
      `ArrowUp must focus the final row on page ${expectedPage}`);
  }
  assert.equal(await count("list_plugins"), listReadsBeforeKeyboard, "Keyboard navigation and detail return must not reread the directory");
  assert.equal(await fixture(`calls.filter(c=>${JSON.stringify(sideEffectCommands)}.includes(c.command)).length`), sideEffectsBeforeKeyboard,
    "Keyboard navigation must not activate, open a chooser, or write plugin state");
  const keyboardCallDelta = await fixture(`calls.slice(${allCallsBeforeKeyboard})`);
  assert.ok(keyboardCallDelta.every(call => call.command === "feature_catalog" && call.args && Object.keys(call.args).length === 0),
    `Keyboard interaction emitted an IPC outside the verified empty-argument feature_catalog startup retries: ${JSON.stringify(keyboardCallDelta)}`);
  keyboardStartupFeatureCatalogRetries = keyboardCallDelta.length;
  checks.push(`CDP keyboard navigation crosses adjacent 30-row pages in both directions, lands on the next enabled identity after the disabled fixture record, clamps at the full-catalogue first/final rows, leaves modifiers/search native, Enter opens only the focused identity and focuses its heading, Escape restores that row inside Settings, and 800↔420 resize preserves its identity and full clipped-viewport visibility; list_plugins and plugin side effects do not increase, and ${keyboardStartupFeatureCatalogRetries} verified empty-argument feature_catalog startup retries are recorded`);
  await geometry("home-management-800-light"); await shot("list-800-light");
  await viewport(420, 560, "light"); await geometry("home-management-420-light"); await shot("list-420-light");
  checks.push("Home mounts one settings title/brand and reads the shared inventory once; success is announced without a visible banner, while 1,200 synthetic records render at most 30 rows");

  stage = "query-to-exact-feature-open";
  await viewport(800, 600, "light"); await search("multi-tools-second", 1);
  let targetButton = await evaluate(`(()=>{const e=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open');return e&&{text:e.textContent.trim(),label:e.getAttribute('aria-label'),code:e.dataset.featureCode}})()`);
  assert.deepEqual(targetButton, { text: "打开「本地 JSON 批量压缩」", label: "打开 文本工具集 的功能：本地 JSON 批量压缩", code: "multi-tools-second" });
  await click(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')`);
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  let queryActivations = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(queryActivations.length, 1); assert.equal(queryActivations[0].args.code, "multi-tools-second");
  assert.equal(queryActivations[0].args.expectedPluginId, "multi-tools");

  await search("本地 JSON 批量压缩", 1);
  targetButton = await evaluate(`(()=>{const e=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open');return e&&{text:e.textContent.trim(),label:e.getAttribute('aria-label'),code:e.dataset.featureCode}})()`);
  assert.deepEqual(targetButton, { text: "打开「本地 JSON 批量压缩」", label: "打开 文本工具集 的功能：本地 JSON 批量压缩", code: "multi-tools-second" });
  await click(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')`);
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  queryActivations = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(queryActivations.length, 2); assert.equal(queryActivations[1].args.code, "multi-tools-second");
  assert.equal(queryActivations[1].args.expectedPluginId, "multi-tools");

  await search("本地 JSON 文本", 1);
  targetButton = await evaluate(`(()=>{const e=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open');return e&&{text:e.textContent.trim(),label:e.getAttribute('aria-label'),code:e.dataset.featureCode}})()`);
  assert.deepEqual(targetButton, { text: "打开「本地 JSON 批量压缩」", label: "打开 文本工具集 的功能：本地 JSON 批量压缩", code: "multi-tools-second" });
  await click(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')`);
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  queryActivations = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(queryActivations.length, 3); assert.equal(queryActivations[2].args.code, "multi-tools-second");
  assert.equal(queryActivations[2].args.expectedPluginId, "multi-tools");

  await search("文本工具集", 1);
  targetButton = await evaluate(`(()=>{const e=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open');return e&&{text:e.textContent.trim(),label:e.getAttribute('aria-label'),code:e.dataset.featureCode??null}})()`);
  assert.deepEqual(targetButton, { text: "打开", label: "打开 文本工具集", code: null });
  await click(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')`);
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  queryActivations = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(queryActivations.length, 4); assert.equal(queryActivations[3].args.code, "multi-tools-first");

  await search("共同筛选项", 1);
  targetButton = await evaluate(`(()=>{const e=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open');return e&&{text:e.textContent.trim(),label:e.getAttribute('aria-label'),code:e.dataset.featureCode??null}})()`);
  assert.deepEqual(targetButton, { text: "打开", label: "打开 文本工具集", code: null });
  await click(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')`);
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  queryActivations = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(queryActivations.length, 5); assert.equal(queryActivations[4].args.code, "multi-tools-first");

  await search("multi-tools-long-target", 1);
  const fullTargetLabel = "用于验证窄视口仍完整保留无障碍名称的超长插件功能标题";
  targetButton = await evaluate(`(()=>{const e=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open');return e&&{text:e.textContent.trim(),label:e.getAttribute('aria-label'),title:e.title,code:e.dataset.featureCode}})()`);
  assert.deepEqual(targetButton, { text: `打开「${fullTargetLabel}」`, label: `打开 文本工具集 的功能：${fullTargetLabel}`, title: `打开功能：${fullTargetLabel}`, code: "multi-tools-long-target" });
  await geometry("feature-query-long-label-800"); await shot("feature-query-long-label-800");
  await viewport(420, 560, "light"); await geometry("feature-query-long-label-420"); await shot("feature-query-long-label-420");
  assert.equal(await evaluate(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')?.getAttribute('aria-label')`), `打开 文本工具集 的功能：${fullTargetLabel}`);
  assert.ok(await evaluate(`(()=>{const span=document.querySelector('[data-plugin-id="multi-tools"] button.feature-open span');return Boolean(span&&span.scrollWidth>span.clientWidth&&span.getBoundingClientRect().right<=innerWidth)})()`), "Long visible feature text should truncate within the row while aria-label keeps the full target");
  await click(`document.querySelector('[data-plugin-id="multi-tools"] button.feature-open')`);
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  queryActivations = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(queryActivations.length, 6); assert.equal(queryActivations[5].args.code, "multi-tools-long-target");
  assert.equal(await count("list_plugins"), 1, "List-query targeting must not request a second catalogue");
  checks.push("Unique code, label, and explanation queries each target the matching later feature through App's existing activate_feature request; metadata and ambiguous feature queries preserve first-feature default; a long exact target keeps its full accessible name at 420/800 widths without layout overflow. The App fixture intentionally rejects activation, so plugin business success is not claimed");

  const activationCountBeforeDetail = await count("activate_feature");
  stage = "filter-exact-feature-and-focus"; await search("文本工具集", 1); await detail("multi-tools");
  await geometry("detail-420-light"); await shot("detail-420-light");
  await viewport(800, 600, "dark"); await geometry("detail-800-dark"); await shot("detail-800-dark");
  const detailFeature = await evaluate(`(()=>{const row=document.querySelector('.plugin-detail [data-feature-code="multi-tools-second"]');const button=row?.querySelector('button');return row&&button?{text:row.innerText,label:button.getAttribute('aria-label')}:null})()`);
  assert.ok(detailFeature && detailFeature.label === "打开功能 本地 JSON 批量压缩" && detailFeature.text.includes("压缩本地 JSON 文本并保留缩进规则"), JSON.stringify(detailFeature));
  await click(q('button[data-feature-code="multi-tools-second"]'));
  await waitFor("document.querySelector('.inventory .notice')?.textContent.includes('插件未能打开')");
  const activation = await fixture("calls.filter(c=>c.command==='activate_feature')");
  assert.equal(activation.length, activationCountBeforeDetail + 1);
  assert.equal(activation[activationCountBeforeDetail].args.code, "multi-tools-second");
  assert.equal(activation[activationCountBeforeDetail].args.expectedPluginId, "multi-tools");
  await geometry("exact-feature-failure-800-dark"); await shot("feature-open-failure-800-dark");
  await button("← 返回插件列表"); assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), "multi-tools");
  await search("", 30); await button("下一页");
  const secondPageId = await evaluate("document.querySelector('.plugin-row')?.dataset.pluginId"); await detail(secondPageId); await button("← 返回插件列表");
  assert.equal(await evaluate("document.activeElement?.dataset.pluginDetailId"), secondPageId);
  assert.match(await evaluate("document.querySelector('.pagination')?.textContent"), /2\s*\/\s*40/);
  checks.push("Ordinary installed plugin details receive focus; its second feature uses the real App open handshake with exact owner/code, failure remains visible, and Back restores the initiating row across pages");

  stage = "authorization-and-list-only-recovery"; await search("离线笔记", 1); await detail("offline-notes");
  await viewport(420, 560, "dark"); await button("授权启用", "document.querySelector('.plugin-detail')");
  await waitFor("document.querySelector('[role=dialog]')"); assert.match(await evaluate("document.querySelector('[role=dialog]')?.textContent"), /data/);
  await key("Escape", "Escape", 27); await waitFor("!document.querySelector('[role=dialog]')");
  assert.ok(await evaluate("Boolean(document.querySelector('.inventory'))")); assert.equal(await count("authorize_plugin_permissions"), 0);
  await fixture("failReadAfterMutation()"); await button("授权启用", "document.querySelector('.plugin-detail')");
  await waitFor("document.querySelector('[role=dialog]')"); await button("授权启用", "document.querySelector('[role=dialog]')");
  await waitFor("Array.from(document.querySelectorAll('.inventory button')).some(e=>e.textContent==='重试读取列表')");
  const afterCommit = await fixture("calls.filter(c=>c.command==='authorize_plugin_permissions')"); assert.equal(afterCommit.length, 1);
  assert.ok(await evaluate("Array.from(document.querySelectorAll('.plugin-detail .primary,.plugin-detail footer button,.inventory .toolbar .primary')).every(e=>e.disabled)"));
  await evaluate("document.querySelector('.inventory .notice').scrollIntoView({block:'nearest'})");
  await geometry("authorize-read-failure-420-dark"); await shot("authorize-read-recovery-420-dark");
  await button("重试读取列表"); await waitFor("!Array.from(document.querySelectorAll('.inventory button')).some(e=>e.textContent==='重试读取列表')");
  assert.equal(await count("authorize_plugin_permissions"), 1); assert.equal(await count("toggle_plugin"), 0);
  await fixture("failReadAfterMutation()"); await button("停用插件");
  await waitFor("Array.from(document.querySelectorAll('.inventory button')).some(e=>e.textContent==='重试读取列表')");
  await button("重试读取列表"); await waitFor("document.querySelector('.plugin-detail .primary')?.textContent==='授权启用'");
  assert.equal(await count("toggle_plugin"), 1); await geometry("disable-recovered-420-dark"); await shot("disable-recovered-420-dark");
  checks.push("Authorization confirms actual manifest permissions; Escape cancels only its modal. Successful authorize/disable followed by failed reads lock writes and opening until list-only recovery, without duplicate native actions");

  stage = "builtin-reenable-and-human-reveal"; await button("← 返回插件列表"); await search("内置 JSON", 1);
  await click(q('button[aria-label="启用 内置 JSON"]')); await waitFor("document.querySelector('button[aria-label=\"打开 内置 JSON\"]')");
  assert.equal(await count("authorize_plugin_permissions"), 1); assert.equal(await count("toggle_plugin"), 2);
  await detail("builtin-json"); assert.equal(await evaluate("Array.from(document.querySelectorAll('.plugin-detail button')).some(e=>e.textContent==='卸载插件'||e.textContent==='更新插件')"), false);
  await click(q(".plugin-detail .metadata summary")); await button("打开目录");
  const reveal = await fixture("calls.filter(c=>c.command==='call_agent_tool')"); assert.equal(reveal.length, 1);
  assert.deepEqual(reveal[0].args, { name: "open_or_reveal_path", arguments: { path: "/fixture/installed/builtin-json", reveal: true }, clientId: "atools-ui", confirmed: true });
  checks.push("A disabled builtin re-enables through its trusted native toggle route; imported authorization is separate, builtin update/uninstall remain absent, and reveal uses the human TaskRun capability pipeline");

  stage = "held-picker-and-dispose"; await fixture("plan('plugin:dialog|open','held-picker')"); await button("安装本地插件");
  await waitFor("window.pluginInventoryFixture.calls.some(c=>c.pendingKey==='held-picker')");
  assert.ok(await evaluate("Array.from(document.querySelectorAll('.inventory .toolbar button')).every(e=>e.disabled)"));
  await click(q('button[aria-label="回到主搜索"]')); await waitFor("!document.querySelector('.inventory')");
  await fixture("resolve('held-picker','/fixture/late-picker')"); await delay(120); assert.equal(await count("install_plugin"), 0);
  await click(q('button[aria-label="打开设置"]')); await waitFor("document.querySelector('.settings-panel')");
  await button("已安装插件", "document.querySelector('.settings-sidebar')"); await waitFor("document.querySelector('.inventory .plugin-row')");
  await viewport(800, 600, "light"); await geometry("settings-entry-800-light"); await shot("settings-shared-list-800-light");
  assert.equal(await count("list_plugins"), 7);
  checks.push("The directory picker holds the global lock; leaving disposes its session and a late picker result cannot install. Settings opens the same inventory implementation and reads once");

  stage = "final-audit";
  const after = await hashes(); assert.deepEqual(after, before);
  assert.deepEqual(await fixture("unexpectedCommands"), []); assert.deepEqual(consoleIssues, []); assert.equal(expectedConsole.length, 7);
  assert.deepEqual(navigation, [`${origin}/${compiled.htmlFile}`]);
  assert.ok(network.every(url => new URL(url).origin === origin)); assert.ok(!network.some(url => url.includes("@vite/client")));
  report = { runId, passed: true, stage, scope: "Static Vite build of actual App/SystemPanel/SettingsPanel/installed inventory with synthetic IPC and 1,200 synthetic records. activate_feature is captured then intentionally rejected; plugin business success is not exercised. No OS chooser is executed. Input timing includes CDP round trips/polling; not a native paint/CPU/RSS measure.", checks, keyboardStartupFeatureCatalogRetries, keyboardFocusVisibility, layouts, timings, screenshots, compiled, calls: await fixture("calls"), network, navigation, consoleIssues, expectedConsole, sourceFilesSha256: before, sourceFilesSha256AtEnd: after, sourceHashStable: true };
} catch (error) {
  process.exitCode = 1; report = { runId, passed: false, stage, checks, keyboardStartupFeatureCatalogRetries, keyboardFocusVisibility, layouts, timings, screenshots, error: error.stack || String(error), calls: page ? await fixture("calls").catch(() => []) : [], uiAtFailure: page ? await evaluate("({text:document.querySelector('.inventory')?.innerText?.slice(0,1500),input:document.querySelector('.inventory input')?.value,rows:document.querySelectorAll('.inventory .plugin-row').length,focused:document.activeElement?.outerHTML?.slice(0,500)})").catch(() => null) : null, consoleIssues, expectedConsole, sourceFilesSha256: before };
} finally {
  cleanup.app = page ? await evaluate("window.pluginInventoryFixture?.dispose().then(()=>true)").then(() => "fulfilled", () => "failed") : "not_started";
  for (const [name, value] of [["cdp", page], ["chrome", chrome], ["preview", preview]]) cleanup[name] = value ? await Promise.resolve(value.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.build = buildDir ? await rm(buildDir, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanup).includes("failed")) { process.exitCode = 1; report.passed = false; }
  report.cleanup = cleanup; await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runId, passed: report.passed, stage, checks, screenshots, cleanup, report: new URL("report.json", output).pathname }));
}
