import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { launchOwnedChrome } from "./lib/launcher-menu-browser-runtime.mjs";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const runId = randomUUID();
const output = process.env.ATOOLS_PLUGIN_NAV_CLEAR_OUTPUT || `/private/tmp/atools-batch1424-plugin-navigation-clear/browser-${runId}`;
const sourcePaths = [
  "src/components/PluginNavigationBar.svelte",
  "src/lib/pluginHostView.ts",
  "src/lib/pluginNavigationKeys.ts",
  "src/lib/pluginFeatureA11yIds.ts",
  "src/styles/global.css",
  "tests/components/plugin-navigation-bar.test.ts",
  "tests/components/plugin-navigation-clear-browser.html",
  "tests/components/pluginNavigationClearBrowserFixture.ts",
  "scripts/test-plugin-navigation-clear-browser.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/static-browser-fixture.mjs",
  "scripts/lib/launcher-menu-browser-runtime.mjs",
  "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs",
  "scripts/lib/owned-vite-cli-worker.mjs",
  "vite.config.ts",
].sort();
const checks = [], screenshots = [], layouts = [], requests = [], navigations = [], consoleIssues = [], keyboardFailures = [];
const cleanup = { fixture: "not_started", cdp: "not_started", chrome: "not_started", preview: "not_started", build: "not_started" };
let server, chrome, page, buildDirectory, compiledFixture, report, stage = "setup", sourceHashesAtStart;

async function hashSources() {
  return Object.fromEntries(await Promise.all(sourcePaths.map(async (path) => [
    path, createHash("sha256").update(await readFile(resolve(projectRoot, path))).digest("hex"),
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
async function key(keyValue, code, virtualKey) {
  const params = { key: keyValue, code, windowsVirtualKeyCode: virtualKey };
  const text = code === "Enter" ? "\r" : code === "Space" ? " " : undefined;
  const textParams = text === undefined ? {} : { text, unmodifiedText: text };
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", ...params, ...textParams });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  await delay(80);
}
async function click(selector) {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return{x,y,hit:e.contains(document.elementFromPoint(x,y)),width:r.width,height:r.height}})()`);
  assert.ok(point && point.width > 0 && point.height > 0 && point.hit, `Click target is missing or obscured: ${selector}`);
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1 });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1 });
  await delay(60);
}
async function screenshot(name) {
  const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(shot.data, "base64");
  const file = `${name}-${runId}.png`;
  await writeFile(join(output, file), bytes, { flag: "wx" });
  const evidence = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  screenshots.push(evidence);
  return evidence;
}
async function recordKeyboardFailure(label) {
  let metadata = null;
  let metadataCaptureFailed = false;
  let image = null;
  let screenshotCaptureFailed = false;
  try {
    metadata = await evaluate("(()=>{const active=document.activeElement,input=document.querySelector('.sub-input');const callbacks=window.pluginNavigationClearFixture?.callbacks??[];return{activeElement:active?{tag:active.tagName.toLowerCase(),ariaLabel:active.getAttribute('aria-label'),role:active.getAttribute('role')}:null,callbacks:{count:callbacks.length,emptyCount:callbacks.filter(value=>value==='').length},inputValue:input?.value??null,clearExists:Boolean(document.querySelector('.sub-input-clear')),composing:input?.dataset.atoolsComposing==='true'}})()");
  } catch {
    metadataCaptureFailed = true;
  }
  try {
    image = await screenshot(`keyboard-failure-${label}`);
  } catch {
    screenshotCaptureFailed = true;
  }
  keyboardFailures.push({ label, metadata, metadataCaptureFailed, screenshot: image, screenshotCaptureFailed });
}
async function viewport(width, theme) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height: 760, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await evaluate(`document.documentElement.setAttribute('data-atools-theme',${JSON.stringify(theme)})`);
  await waitFor(`innerWidth===${width}&&innerHeight===760`);
  await delay(120);
}
async function layout(label, expectInput, expectClear = expectInput, expectSource = undefined) {
  const state = await evaluate(`(()=>{
    const nav=document.querySelector('.plugin-navigation'),body=document.querySelector('[data-fixture-body]'),input=document.querySelector('.sub-input'),clear=document.querySelector('.sub-input-clear');
    const rect=e=>{if(!e)return null;const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}};
    const visible=e=>{if(!e)return false;const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};
    const hit=e=>{if(!e)return false;const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;return e.contains(document.elementFromPoint(x,y))};
    const controls=Array.from(nav.querySelectorAll('button,input')).map(e=>({label:e.getAttribute('aria-label')||e.title||e.textContent.trim(),rect:rect(e),visible:visible(e),hit:hit(e)}));
    const targets=[...new Set([input,clear,...Array.from(nav.querySelectorAll('button'))])].filter(visible).map(rect);
    const overlaps=[]; for(let i=0;i<targets.length;i++)for(let j=i+1;j<targets.length;j++){const a=targets[i],b=targets[j];if(a.left<b.right-1&&b.left<a.right-1&&a.top<b.bottom-1&&b.top<a.bottom-1)overlaps.push([i,j]);}
    const source=document.querySelector('.plugin-source');
    const actionLabels=Array.from(nav.querySelectorAll('.plugin-actions button')).map(e=>e.textContent.trim());
    return {viewport:{width:innerWidth,height:innerHeight},nav:rect(nav),body:rect(body),input:rect(input),clear:rect(clear),inputVisible:visible(input),clearVisible:visible(clear),sourceVisible:visible(source),featureVisible:visible(document.querySelector('.feature-tag')),actions:actionLabels,runtimeControls:nav.querySelectorAll('.runtime-info-action').length,controls,overlaps,navOverflow:nav.scrollWidth>nav.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth+1,bodyStartsAfterHeader:Boolean(nav&&body&&body.getBoundingClientRect().top>=nav.getBoundingClientRect().bottom-1),theme:getComputedStyle(document.documentElement).getPropertyValue('--bg-secondary').trim(),combobox:input?{role:input.getAttribute('role'),controls:input.getAttribute('aria-controls'),activeDescendant:input.getAttribute('aria-activedescendant')}:null};
  })()`);
  state.label = label;
  assert.equal(state.inputVisible, expectInput, `${label}: wrong input visibility`);
  assert.deepEqual(state.actions, ["设置", "分离"], `${label}: settings/detach actions missing or mislabeled`);
  assert.equal(state.runtimeControls, 1, `${label}: runtime control missing`);
  assert.equal(state.bodyStartsAfterHeader, true, `${label}: navigation overlaps plugin body: ${JSON.stringify(state)}`);
  assert.equal(state.navOverflow, false, `${label}: navigation has horizontal overflow: ${JSON.stringify(state)}`);
  assert.equal(state.pageOverflow, false, `${label}: page has horizontal overflow: ${JSON.stringify(state)}`);
  assert.deepEqual(state.overlaps, [], `${label}: hit targets overlap: ${JSON.stringify(state.overlaps)}`);
  assert.ok(state.controls.every((control) => control.visible && control.hit && control.rect.left >= -1 && control.rect.right <= state.viewport.width + 1), `${label}: a header control is hidden, outside viewport, or obscured: ${JSON.stringify(state.controls)}`);
  if (expectInput) {
    assert.ok(state.input.width >= 80, `${label}: search input below 80 px: ${JSON.stringify(state.input)}`);
    if (expectClear) assert.ok(state.clearVisible && state.clear.width >= 28 && state.clear.height >= 28, `${label}: clear target below 28 px: ${JSON.stringify(state.clear)}`);
    else assert.equal(state.clearVisible, false, `${label}: empty input must not render the clear target`);
    assert.deepEqual(state.combobox, { role: "combobox", controls: "fixture-plugin-results", activeDescendant: "fixture-plugin-result-1" });
  }
  if (expectSource !== undefined) assert.equal(state.sourceVisible, expectSource, `${label}: source visibility differs from the existing compact source policy`);
  return state;
}
async function typeQuery() {
  await click('.sub-input');
  await cdp("Input.insertText", { text: "plugin clear query" });
  await waitFor("window.pluginNavigationClearFixture.callbacks.at(-1)==='plugin clear query' && document.querySelector('.sub-input-clear')");
}
async function clearByKey(keyValue, code, virtualKey, expectedClearCount, label) {
  const hoverPoint = await evaluate("(()=>{const e=document.querySelector('.sub-input-clear'),r=e?.getBoundingClientRect();return r?{x:r.left+r.width/2,y:r.top+r.height/2,before:getComputedStyle(e).backgroundColor}:null})()");
  assert.ok(hoverPoint, `${label}: clear button lacks a measurable hover target`);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: hoverPoint.x, y: hoverPoint.y });
  await delay(180);
  const hoverBackground = await evaluate("getComputedStyle(document.querySelector('.sub-input-clear')).backgroundColor");
  assert.notEqual(hoverBackground, hoverPoint.before, `${label}: hover state did not apply its theme token`);
  await key("Tab", "Tab", 9);
  await waitFor("document.activeElement===document.querySelector('.sub-input-clear')");
  const focusBefore = await evaluate("(()=>{const e=document.activeElement,s=e?getComputedStyle(e):null;return {label:e?.getAttribute('aria-label'),outlineStyle:s?.outlineStyle,outlineWidth:s?.outlineWidth}})()");
  assert.equal(focusBefore.label, "清除插件搜索", `${label}: Tab did not focus the clear button`);
  assert.notEqual(focusBefore.outlineStyle, "none", `${label}: keyboard focus indicator is missing`);
  assert.ok(Number.parseFloat(focusBefore.outlineWidth) >= 1, `${label}: keyboard focus indicator is too small`);
  try {
    await key(keyValue, code, virtualKey);
    const result = await waitFor(`window.pluginNavigationClearFixture.callbacks.filter(value=>value==='').length===${expectedClearCount} && document.activeElement===document.querySelector('.sub-input')`);
    assert.equal(await evaluate("document.querySelector('.sub-input-clear')===null"), true, `${label}: clear button remained after activation`);
    const callbackState = await evaluate("({total:window.pluginNavigationClearFixture.callbacks.length,clearCount:window.pluginNavigationClearFixture.callbacks.filter(value=>value==='').length,inputFocused:document.activeElement===document.querySelector('.sub-input')})");
    assert.deepEqual(callbackState, { total: expectedClearCount * 2, clearCount: expectedClearCount, inputFocused: true }, `${label}: activation was not exactly once per typed value`);
    return { result, callbackState, hoverBackground, focusIndicator: focusBefore };
  } catch (error) {
    await recordKeyboardFailure(label);
    throw error;
  }
}

await mkdir(output, { recursive: false });
try {
  sourceHashesAtStart = await hashSources();
  await writeFile(join(output, "source-before.json"), JSON.stringify(sourceHashesAtStart, null, 2) + "\n", { flag: "wx" });
  buildDirectory = await mkdtemp(join(tmpdir(), `atools-plugin-navigation-clear-${runId}-`));
  stage = "build-static-fixture";
  compiledFixture = await buildStaticBrowserFixture({ projectRoot, entryHtml: "tests/components/plugin-navigation-clear-browser.html", outDir: join(buildDirectory, "dist") });
  assert.equal(compiledFixture.htmlFile, "tests/components/plugin-navigation-clear-browser.html");
  const bundleText = (await Promise.all(compiledFixture.outputFiles.filter((file) => file.endsWith(".html") || file.endsWith(".js")).map((file) => readFile(join(buildDirectory, "dist", file), "utf8")))).join("\n");
  assert.equal(bundleText.includes("@vite/client"), false, "Static fixture must not include Vite dev client/HMR");
  assert.equal(bundleText.includes("import.meta.hot"), false, "Static fixture must not include HMR hooks");
  server = await previewStaticBrowserFixture({ projectRoot, outDir: join(buildDirectory, "dist"), host: "127.0.0.1", port: 0 });
  const address = server.httpServer.address();
  assert.ok(address && typeof address === "object", "Owned Vite preview must have a local bound address");
  const origin = `http://127.0.0.1:${address.port}`;
  chrome = await launchOwnedChrome();
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", event => consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (["error", "warning", "assert"].includes(type)) consoleIssues.push(`${type}:${formatConsoleArgs(args)}`); });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  page.on("Page.frameNavigated", event => { if (!event.frame.parentId) navigations.push(event.frame.url); });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 900, height: 760, deviceScaleFactor: 1, mobile: false });
  const pageUrl = `${origin}/tests/components/plugin-navigation-clear-browser.html`;
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: pageUrl }); await loaded;
  await waitFor("window.pluginNavigationClearFixture && document.querySelector('.plugin-navigation')");
  checks.push("A static Vite build of the actual PluginNavigationBar component starts without Vite client/HMR; fixture scope is component-only, with no App, PluginPanel, plugin code, native host, or competitor comparison");

  for (const width of [320, 480, 900]) for (const theme of ["light", "dark"]) {
    stage = `layout-${width}-${theme}`;
    await viewport(width, theme);
    await evaluate("window.pluginNavigationClearFixture.mountFixture(false)");
    const sourceState = await layout(`${width}-${theme}-source-context`, false, false, width > 520);
    await screenshot(`${width}-${theme}-source-context`);
    await evaluate("window.pluginNavigationClearFixture.mountFixture(true)");
    await waitFor("document.querySelector('.sub-input') && !document.querySelector('.sub-input-clear')");
    const emptyState = await layout(`${width}-${theme}-empty`, true, false);
    await typeQuery();
    const filledState = await layout(`${width}-${theme}-filled`, true);
    await screenshot(`${width}-${theme}-before-clear`);
    const enterResult = await clearByKey("Enter", "Enter", 13, 1, `${width}-${theme}-Enter`);
    await layout(`${width}-${theme}-after-Enter`, true, false);
    await screenshot(`${width}-${theme}-after-Enter`);
    await typeQuery();
    const spaceResult = await clearByKey(" ", "Space", 32, 2, `${width}-${theme}-Space`);
    await layout(`${width}-${theme}-after-Space`, true, false);
    await screenshot(`${width}-${theme}-after-Space`);
    const beforeIme = await evaluate("window.pluginNavigationClearFixture.callbacks.length");
    await typeQuery();
    const beforeCompositionCalls = await evaluate("window.pluginNavigationClearFixture.callbacks.length");
    await cdp("Input.imeSetComposition", { text: "拼音", selectionStart: 2, selectionEnd: 2 });
    await waitFor("document.querySelector('.sub-input')?.dataset.atoolsComposing==='true' && !document.querySelector('.sub-input-clear')");
    const composition = await evaluate("({emptyCalls:window.pluginNavigationClearFixture.callbacks.filter(value=>value==='').length,totalCalls:window.pluginNavigationClearFixture.callbacks.length,clearVisible:Boolean(document.querySelector('.sub-input-clear'))})");
    assert.equal(composition.emptyCalls, 2, `${width}-${theme}: composition unexpectedly cleared the query`);
    assert.equal(composition.clearVisible, false, `${width}-${theme}: clear button exposed during IME composition`);
    assert.equal(composition.totalCalls, beforeCompositionCalls, `${width}-${theme}: composing input unexpectedly reached oninput`);
    checks.push(`${width}px ${theme}: source/actions/runtime context and filled/cleared input layout has no overflow/overlap; real Enter and Space each cleared once and restored input focus; IME hid/guarded clear`);
    layouts.push({ width, theme, source: sourceState, empty: emptyState, filled: filledState, beforeImeCalls: beforeIme, enter: enterResult.callbackState, space: spaceResult.callbackState, composition });
  }
  assert.deepEqual(consoleIssues, []);
  assert.ok(requests.length > 0 && requests.every(url => new URL(url).origin === origin), "Fixture must use only its loopback static preview server");
  assert.deepEqual(navigations, [pageUrl], "Only the fixture's single initial top-level navigation is expected");
  const sourceHashesAtEnd = await hashSources();
  assert.deepEqual(sourceHashesAtEnd, sourceHashesAtStart, "Fixture source pins changed during browser run");
  report = { runId, passed: true, stage, scope: "Isolated static-browser fixture mounting the actual PluginNavigationBar component only. It is not App/plugin panel/original plugin/native IPC or competitor-visual acceptance.", checks, compiledFixture, screenshots, layouts, requests, navigations, consoleIssues, keyboardFailures, sourceHashesAtStart, sourceHashesAtEnd };
} catch (error) {
  report = { runId, passed: false, stage, error: error instanceof Error ? error.stack || error.message : String(error), checks, compiledFixture, screenshots, layouts, requests, navigations, consoleIssues, keyboardFailures, sourceHashesAtStart };
  process.exitCode = 1;
} finally {
  cleanup.fixture = page ? await evaluate("window.pluginNavigationClearFixture?.dispose().then(()=>true)").then(value => value ? "fulfilled" : "failed", () => "not_ready") : "not_started";
  cleanup.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.chrome = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.preview = server ? await Promise.resolve(server.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.build = buildDirectory ? await rm(buildDirectory, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanup).includes("failed")) { process.exitCode = 1; report ??= { passed: false, stage, error: "Runner exited before report creation" }; report.passed = false; report.cleanupError = "Owned fixture cleanup did not complete"; }
  report ??= { passed: false, stage, error: "Runner exited before report creation" };
  report.cleanup = cleanup;
  await writeFile(join(output, "browser-result.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
}
if (report.passed) console.log(JSON.stringify({ passed: true, checks: checks.length, screenshots: screenshots.length, output }));
