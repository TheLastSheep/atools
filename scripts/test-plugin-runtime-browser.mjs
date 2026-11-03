import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";
import { auditBrowserContrastSample, browserContrastSampleExpression, maxSrgbChannelDelta } from "./lib/runtime-inventory-browser-contrast.mjs";

const runId = randomUUID();
const origin = "http://127.0.0.1:1478";
const outputDir = resolve(`output/ztools-running-inventory-2026-10-26/browser-${runId}`);
const checks = [], screenshots = [], network = [], failedNetwork = [], consoleIssues = [], cleanup = {}, contrastAudits = [], themeDeltas = [];
let browserCdp, page, chrome, preview, buildDir, before, after, report, stage = "setup", chromeBrowserPid = null, closing = false;

async function sourceFiles(dir = resolve("src")) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(file));
    else if (/\.(?:ts|svelte|css)$/.test(file)) files.push(relative(process.cwd(), file));
  }
  return files;
}

async function sourceHashes() {
  const files = [...await sourceFiles(),
    "tests/components/PluginRuntimeBrowserFixture.svelte", "tests/components/pluginRuntimeBrowserFixture.ts",
    "tests/components/plugin-runtime-browser.html", "scripts/test-plugin-runtime-browser.mjs",
    "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/static-browser-fixture.mjs", "scripts/lib/runtime-inventory-browser-contrast.mjs", "scripts/lib/owned-vite-server.mjs",
    "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs", "vite.config.ts", "package.json", "pnpm-lock.yaml"];
  const unique = [...new Set(files)].sort();
  return Object.fromEntries(await Promise.all(unique.map(async file => [
    file, createHash("sha256").update(await readFile(file)).digest("hex"),
  ])));
}

async function cdp(method, params = {}, timeoutMs = 12000) {
  return page.send(method, params, { timeoutMs });
}

async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}

async function waitFor(expression, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(`Boolean((${expression}))`)) return;
    await delay(35);
  }
  assert.fail(`Timed out waiting for fixture UI: ${expression}`);
}

async function click(expression) {
  const box = await evaluate(`(()=>{const e=${expression};if(!e)return null;e.scrollIntoView({block:'nearest',inline:'nearest'});const r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,h=document.elementFromPoint(x,y);return{x,y,left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height,disabled:e.disabled===true,hit:h===e||e.contains(h),vw:innerWidth,vh:innerHeight}})()`);
  assert.ok(box, `Missing click target: ${expression}`);
  assert.equal(box.disabled, false, `Disabled click target: ${expression}`);
  assert.ok(box.width > 0 && box.height > 0 && box.left >= 0 && box.top >= 0
    && box.right <= box.vw && box.bottom <= box.vh && box.hit, `Click target is not visible/hit-testable: ${JSON.stringify(box)}`);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await cdp("Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1 });
  }
  await delay(65);
}

function buttonText(text) {
  return `Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()===${JSON.stringify(text)})`;
}

async function fixture(expression) {
  return evaluate(`window.pluginRuntimeBrowserFixture.${expression}`);
}

async function runtimeReads() {
  return fixture(`calls.filter(call=>call.command==='list_plugin_runtime_sessions').length`);
}

async function viewport(width, height, theme) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
  await delay(130);
}

async function setTheme(system, explicit) {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: system }] });
  await evaluate(`document.documentElement.setAttribute('data-atools-theme',${JSON.stringify(explicit)})`);
  await delay(180);
  const applied = await evaluate("({theme:document.documentElement.dataset.atoolsTheme,systemDark:matchMedia('(prefers-color-scheme: dark)').matches})");
  assert.equal(applied.theme, explicit);
  assert.equal(applied.systemDark, system === "dark");
}

async function captureContrast(label, selector) {
  const sample = await evaluate(browserContrastSampleExpression(selector));
  const audit = auditBrowserContrastSample(sample);
  assert.ok(audit.ratio >= 4.5, `${label} text contrast ${audit.ratio.toFixed(2)}:1 is below WCAG AA 4.5:1`);
  const entry = { label, ...audit };
  contrastAudits.push(entry);
  return entry;
}

function assertSameExplicitTheme(reference, oppositeSystem, label) {
  const foregroundDelta = maxSrgbChannelDelta(reference.renderedForeground, oppositeSystem.renderedForeground);
  const backgroundDelta = maxSrgbChannelDelta(reference.renderedBackground, oppositeSystem.renderedBackground);
  const delta = Math.max(foregroundDelta, backgroundDelta);
  assert.ok(delta <= 1 / 255 + 1e-5, `${label} changed with system color scheme (sRGB channel delta ${delta.toFixed(5)})`);
  themeDeltas.push({ label, maxSrgbChannelDelta: delta });
}

async function captureErrorPalette(label) {
  return {
    errorNotice: await captureContrast(`${label}-error-notice`, ".runtime-panel .notice.error"),
    rowError: await captureContrast(`${label}-row-error`, ".runtime-panel .row-error"),
  };
}

async function geometry(label) {
  const measured = await evaluate(`(()=>({label:${JSON.stringify(label)},width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,fixtureWidth:document.querySelector('.fixture-root')?.scrollWidth,rows:document.querySelectorAll('.runtime-row').length,overflow:Array.from(document.querySelectorAll('.fixture-root,.runtime-panel,.runtime-list')).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.className)}))()`);
  assert.ok(measured.documentWidth <= measured.width && measured.bodyWidth <= measured.width
    && measured.fixtureWidth <= measured.width, JSON.stringify(measured));
  assert.deepEqual(measured.overflow, [], JSON.stringify(measured));
  layouts.push(measured);
  return measured;
}

async function screenshot(name) {
  await cdp("Page.bringToFront");
  await delay(100);
  const data = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(data.data, "base64");
  await writeFile(join(outputDir, `${name}.png`), bytes);
  screenshots.push({ file: `${name}.png`, sha256: createHash("sha256").update(bytes).digest("hex"),
    width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}

const layouts = [];
async function verifyChromePidExit(pid, timeoutMs = 3500) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) { if (error?.code === "ESRCH") return true; }
    await delay(40);
  }
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === "ESRCH"; }
}

try {
  await mkdir(outputDir, { recursive: true });
  before = await sourceHashes();
  buildDir = await mkdtemp(join(tmpdir(), "atools-runtime-inventory-browser-"));
  const compiled = await buildStaticBrowserFixture({ projectRoot: process.cwd(),
    entryHtml: "tests/components/plugin-runtime-browser.html", outDir: join(buildDir, "dist") });
  const bundle = (await Promise.all(compiled.outputFiles.filter(file => /\.(?:html|js)$/.test(file))
    .map(file => readFile(join(buildDir, "dist", file), "utf8")))).join("\n");
  assert.ok(!bundle.includes("@vite/client") && !bundle.includes("import.meta.hot"));
  preview = await previewStaticBrowserFixture({ projectRoot: process.cwd(), outDir: join(buildDir, "dist"), host: "127.0.0.1", port: 1478 });
  chrome = await launchChrome();
  browserCdp = await CdpClient.connect(chrome.webSocketUrl);
  try {
    const processes = await browserCdp.send("SystemInfo.getProcessInfo", {}, { timeoutMs: 5000 });
    chromeBrowserPid = processes.processInfo?.find(item => item.type === "browser")?.id ?? null;
  } catch { chromeBrowserPid = null; }
  page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  page.on("Runtime.exceptionThrown", event => {
    if (!closing) consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text || "runtime exception");
  });
  page.on("Runtime.consoleAPICalled", ({ type, args }) => {
    if (!closing && ["error", "warning", "assert"].includes(type)) consoleIssues.push(`${type}:${formatConsoleArgs(args)}`);
  });
  page.on("Network.requestWillBeSent", event => { if (!closing) network.push({ url: event.request.url, method: event.request.method }); });
  page.on("Network.loadingFailed", event => { if (!closing) failedNetwork.push({ requestId: event.requestId, errorText: event.errorText }); });
  await viewport(800, 600, "light");
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: `${origin}/${compiled.htmlFile}` });
  await loaded;
  stage = "running-tab-and-native-snapshot";
  await waitFor("document.querySelector('.fixture-disclaimer') && document.querySelector('.inventory')");
  await waitFor("document.querySelector('.inventory button[aria-pressed]')");
  await click(buttonText("运行会话"));
  await waitFor("document.querySelector('.runtime-list[aria-busy=\"false\"]') && document.querySelectorAll('.runtime-row').length===4");
  assert.equal(await runtimeReads(), 1, "Entering the running tab should make one native inventory read");
  const initialRows = await evaluate("Array.from(document.querySelectorAll('.runtime-row')).map(row=>row.innerText)");
  assert.ok(initialRows.some(text => text.includes("Harris Pasteboard Pro（夹具）") && text.includes("驻留会话") && text.includes("运行中")));
  assert.ok(initialRows.some(text => text.includes("Harris Legacy Node（夹具）") && text.includes("无窗口") && text.includes("载入版本未记录") && text.includes("状态未知")));
  assert.ok(initialRows.some(text => text.includes("Harris Plugin Window（夹具）") && text.includes("插件窗口") && text.includes("正在退出")));
  assert.ok(await evaluate("document.querySelector('.runtime-panel .notice.warning')?.textContent.includes('部分运行状态不可用')"));
  checks.push("The actual installed/running tab renders controlled Harris-labeled fixtures: ready background, legacy Node with null window/revision, stopping browser window, and incomplete coverage warning");

  stage = "warning-contrast-and-explicit-theme";
  await setTheme("light", "light");
  const warningLight = await captureContrast("warning-explicit-light-system-light", ".runtime-panel .notice.warning");
  await setTheme("dark", "dark");
  const warningDark = await captureContrast("warning-explicit-dark-system-dark", ".runtime-panel .notice.warning");
  await setTheme("dark", "light");
  const warningLightOppositeSystem = await captureContrast("warning-explicit-light-system-dark", ".runtime-panel .notice.warning");
  assertSameExplicitTheme(warningLight, warningLightOppositeSystem, "Light warning with an opposite system theme");
  await setTheme("light", "dark");
  const warningDarkOppositeSystem = await captureContrast("warning-explicit-dark-system-light", ".runtime-panel .notice.warning");
  assertSameExplicitTheme(warningDark, warningDarkOppositeSystem, "Dark warning with an opposite system theme");
  await setTheme("light", "light");
  await evaluate("document.documentElement.removeAttribute('data-atools-theme')");
  checks.push("Canvas-resolved warning text/background compositing meets WCAG AA in light/dark; explicit theme colors remain stable when the system scheme is opposite");

  await delay(320);
  assert.equal(await runtimeReads(), 1, "Runtime inventory must remain event driven; it must not poll");
  checks.push("No background polling occurs during a 320 ms stable observation");

  await geometry("running-800-light");
  await screenshot("running-800-light");
  await viewport(420, 600, "light");
  await geometry("running-420-light");
  await click("document.querySelector('.runtime-panel input[aria-label=\"搜索运行会话\"]')");
  await screenshot("running-420-light");
  await viewport(800, 600, "dark");
  await setTheme("dark", "dark");
  await geometry("running-800-dark");
  await screenshot("running-800-dark");

  stage = "stop-pending-and-failure";
  await fixture(`setStopBehavior('fixture-background-instance','hold')`);
  await click(`document.querySelector('button[aria-label^="停止 Harris Pasteboard Pro"]')`);
  await waitFor("Array.from(document.querySelectorAll('.runtime-row')).some(row=>row.innerText.includes('正在退出…'))");
  assert.equal(await runtimeReads(), 1, "A pending stop must not preemptively reread or remove the row");
  assert.ok(await evaluate("document.querySelectorAll('.runtime-row').length===4"));
  await fixture(`resolveHeldStop('fixture-background-instance','failure')`);
  await waitFor("Array.from(document.querySelectorAll('.runtime-row')).some(row=>row.innerText.includes('退出未确认'))");
  assert.ok(await evaluate("Array.from(document.querySelectorAll('.runtime-row')).some(row=>row.innerText.includes('Harris Pasteboard Pro（夹具）'))"));

  stage = "native-read-error-does-not-mean-stopped";
  await fixture("setNextRuntimeReadError()");
  await click(`document.querySelector('.runtime-panel button.refresh')`);
  await waitFor("document.querySelector('.runtime-panel [role=\"alert\"]')?.textContent.includes('运行状态读取失败')");
  assert.ok(await evaluate("document.querySelectorAll('.runtime-row').length===2"), "Failed native read keeps the two owned renderer rows visible");
  assert.ok(await evaluate("!document.querySelector('.runtime-list .empty')"), "A failed read must not render the all-stopped empty state");
  assert.equal(await runtimeReads(), 2);

  stage = "error-contrast-and-explicit-theme";
  await setTheme("light", "light");
  const errorsLight = await captureErrorPalette("errors-explicit-light-system-light");
  await setTheme("dark", "light");
  const errorsLightOppositeSystem = await captureErrorPalette("errors-explicit-light-system-dark");
  for (const key of ["errorNotice", "rowError"]) {
    assertSameExplicitTheme(errorsLight[key], errorsLightOppositeSystem[key], `Light ${key} with an opposite system theme`);
  }
  await setTheme("dark", "dark");
  const errorsDark = await captureErrorPalette("errors-explicit-dark-system-dark");
  await setTheme("light", "dark");
  const errorsDarkOppositeSystem = await captureErrorPalette("errors-explicit-dark-system-light");
  for (const key of ["errorNotice", "rowError"]) {
    assertSameExplicitTheme(errorsDark[key], errorsDarkOppositeSystem[key], `Dark ${key} with an opposite system theme`);
  }
  checks.push("Read-error and stop-error text remain at least 4.5:1 in each explicit theme and keep their composed colors when system light/dark is inverted");

  await setTheme("dark", "dark");
  await geometry("native-read-error-800-dark");
  await screenshot("failure-800-dark");
  checks.push("A held stop stays visible while pending; its controlled failure remains visible, and a native read failure shows an error without claiming all sessions stopped");

  stage = "read-recovery-and-successful-stop";
  await click(`document.querySelector('.runtime-panel button.refresh')`);
  await waitFor("document.querySelector('.runtime-list[aria-busy=\"false\"]') && document.querySelectorAll('.runtime-row').length===4");
  assert.equal(await runtimeReads(), 3);
  await fixture(`setStopBehavior('fixture-background-success-instance','success')`);
  await click(`document.querySelector('button[aria-label^="停止 Harris Live Markdown"]')`);
  await waitFor("!Array.from(document.querySelectorAll('.runtime-row')).some(row=>row.innerText.includes('Harris Live Markdown（夹具）'))");
  assert.equal(await runtimeReads(), 4, "Only confirmed fixture stop success triggers its follow-up snapshot read");
  checks.push("Refreshing recovers from the controlled read failure; a separately controlled stop-success removes only its matching fixture row after the source confirms removal");

  stage = "fixture-empty-snapshot";
  await fixture("clearLocalRows()");
  await fixture("setNativeSnapshotEmpty(true)");
  await click(`document.querySelector('.runtime-panel button.refresh')`);
  await waitFor("document.querySelector('.runtime-list[aria-busy=\"false\"]') && document.querySelector('.runtime-list .empty')");
  assert.equal(await runtimeReads(), 5);
  assert.ok(await evaluate("document.querySelector('.runtime-list .empty')?.textContent.includes('当前没有可显示的运行会话')"));
  checks.push("An explicitly configured empty fixture snapshot renders the empty state; this is only a simulated observation and does not prove OS process termination");

  stage = "source-and-transport-audit";
  after = await sourceHashes();
  assert.deepEqual(after, before, "Source and runner inputs must remain byte stable during the browser fixture");
  assert.deepEqual(await fixture("unexpectedCommands"), [], "Every unrecognized IPC command must fail closed");
  assert.deepEqual(consoleIssues, [], "Browser console/runtime errors must be empty");
  assert.deepEqual(failedNetwork, [], `The browser reported failed network requests: ${JSON.stringify(failedNetwork)}`);
  assert.ok(network.every(({ url }) => {
    const parsed = new URL(url);
    return parsed.origin === origin || parsed.protocol === "data:";
  }), `Unexpected external network request: ${JSON.stringify(network)}`);
  assert.ok(network.some(({ url }) => url === `${origin}/${compiled.htmlFile}`), "The fixture entry must be served by the owned loopback server");
  checks.push("All network requests stayed on the fixture loopback origin, no unknown IPC was attempted, and source hashes remained stable");
  report = {
    runId, passed: true, stage, scope: "Static Vite build of the real PluginInventoryPanel and PluginRuntimePanel with controlled synthetic Tauri IPC and a Svelte runtime-control source. Stop/read outcomes are fixture responses; this does not execute Rust, Node, TaskRun, or OS processes. WCAG ratios use CDP computed colors, canvas sRGB parsing, and compositing through actual ancestor background layers; explicit theme switches are fixture root attributes only.",
    origin, browserProfile: "private profile managed by launchChrome", runnerPid: process.pid, chromeBrowserPid,
    checks, layouts, screenshots, contrastAudits, themeDeltas, compiled,
    calls: await fixture("calls"), unexpectedCommands: await fixture("unexpectedCommands"), network, failedNetwork,
    consoleIssues, sourceHashesBefore: before, sourceHashesAfter: after, sourceHashStable: true,
  };
} catch (error) {
  process.exitCode = 1;
  after = before ? await sourceHashes().catch(() => null) : null;
  report = {
    runId, passed: false, stage, origin, runnerPid: process.pid, chromeBrowserPid, checks, layouts, screenshots, contrastAudits, themeDeltas,
    scope: "Static UI fixture only; contrast/theme checks use fixture root attributes and do not exercise native settings storage or Rust/Node processes.",
    error: error?.stack || String(error), calls: page ? await fixture("calls").catch(() => []) : [],
    unexpectedCommands: page ? await fixture("unexpectedCommands").catch(() => []) : [], network, failedNetwork, consoleIssues,
    sourceHashesBefore: before ?? null, sourceHashesAfter: after, sourceHashStable: before && after ? JSON.stringify(before) === JSON.stringify(after) : null,
  };
} finally {
  closing = true;
  cleanup.fixture = page ? await fixture("dispose()").then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.browserCdp = browserCdp ? await Promise.resolve(browserCdp.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.chromeClose = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.chromeBrowserPidExited = chromeBrowserPid ? await verifyChromePidExit(chromeBrowserPid) : "unconfirmed";
  cleanup.preview = preview ? await Promise.resolve(preview.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.buildDir = buildDir ? await rm(buildDir, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanup).includes("failed") || cleanup.chromeBrowserPidExited !== true) {
    process.exitCode = 1;
    if (report) report.passed = false;
  }
  if (!report) report = { runId, passed: false, stage, error: "No browser fixture report was produced" };
  report.cleanup = cleanup;
  await mkdir(outputDir, { recursive: true });
  await writeFile(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ runId, passed: report.passed, stage, checks, screenshots, cleanup, report: join(outputDir, "report.json") }));
}
