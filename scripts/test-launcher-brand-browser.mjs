import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { CdpClient, createPageWebSocketUrl, delay, launchChrome } from "./chrome-cdp-smoke-utils.mjs";
import { buildStaticBrowserFixture, previewStaticBrowserFixture } from "./lib/static-browser-fixture.mjs";

const runId = randomUUID(), root = process.cwd();
const output = join(root, "output/launcher-ui-2026-10-16", "brand-" + runId);
const sources = ["src/components/AToolsMark.svelte", "src/components/SearchBar.svelte", "src/components/SettingsHeader.svelte",
  "src/components/HomeCapabilityRail.svelte", "src/styles/global.css", "tests/components/launcherBrandBrowserFixture.ts",
  "tests/components/launcher-brand-browser.html", "scripts/test-launcher-brand-browser.mjs", "scripts/lib/static-browser-fixture.mjs",
  "scripts/chrome-cdp-smoke-utils.mjs", "scripts/lib/owned-vite-server.mjs",
  "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs"];
const hash = data => createHash("sha256").update(data).digest("hex");
const captureSources = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, hash(await readFile(file))])));
const screenshots = [], layouts = [], keyboardActivations = [], errors = [], requests = [], cleanup = {};
let scratch, server, chrome, page, report, stage = "setup";
const evaluate = async expression => {
  const result = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.text); return result.result.value;
};
async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { const result = await evaluate(expression); if (result) return result; await delay(40); }
  throw Error("Brand fixture state did not arrive");
}
async function key(key, code, windowsVirtualKeyCode) {
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode,
    ...(key === "Enter" ? { text: "\r", unmodifiedText: "\r" } : {}) });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode });
  await delay(60);
}
async function snapshot(name) {
  await delay(80);
  const shot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const bytes = Buffer.from(shot.data, "base64"), file = name + ".png";
  await writeFile(join(output, file), bytes);
  screenshots.push({ file, bytes: bytes.length, sha256: hash(bytes), width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) });
}
try {
  await mkdir(output, { recursive: true }); const before = await captureSources();
  scratch = await mkdtemp(join(tmpdir(), "atools-brand-browser-"));
  const built = await buildStaticBrowserFixture({ projectRoot: root, entryHtml: "tests/components/launcher-brand-browser.html", outDir: scratch });
  server = await previewStaticBrowserFixture({ projectRoot: root, outDir: scratch, host: "127.0.0.1", port: 1460 });
  chrome = await launchChrome(); page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await page.send("Runtime.enable"); await page.send("Page.enable"); await page.send("Network.enable");
  page.on("Runtime.exceptionThrown", event => errors.push(event.exceptionDetails?.text || "Runtime error"));
  page.on("Runtime.consoleAPICalled", event => { if (["error", "warning", "assert"].includes(event.type)) errors.push(event.type); });
  page.on("Network.requestWillBeSent", event => requests.push(event.request.url));
  await page.send("Page.navigate", { url: "http://127.0.0.1:1460/" + built.htmlFile });
  await waitFor("window.atoolsBrandFixture && document.querySelectorAll('.atools-mark').length===4");
  for (const width of [800, 420]) for (const theme of ["light", "dark"]) {
    stage = width + "-" + theme;
    await page.send("Emulation.setDeviceMetricsOverride", { width, height: 700, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: theme }] });
    await evaluate("window.atoolsBrandFixture.setTheme(" + JSON.stringify(theme) + ")");
    await evaluate("document.querySelector('.search-input').focus()"); await key("Tab", "Tab", 9);
    const layout = await evaluate(`(()=>{const button=document.querySelector('.app-badge'),mark=button.querySelector('.atools-mark'),rect=mark.getBoundingClientRect(),style=getComputedStyle(button);return {width:innerWidth,theme:document.documentElement.dataset.atoolsTheme,overflow:document.documentElement.scrollWidth>innerWidth,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,overflowingElements:[...document.querySelectorAll('body *')].map(el=>({el,rect:el.getBoundingClientRect()})).filter(item=>item.rect.width>0&&(item.rect.right>innerWidth+1||item.rect.left< -1)).slice(0,12).map(({el,rect})=>({tag:el.tagName,id:el.id,className:typeof el.className==='string'?el.className:'',left:Math.round(rect.left),right:Math.round(rect.right),width:Math.round(rect.width)})),marks:document.querySelectorAll('.atools-mark').length,oldMarks:document.querySelectorAll('.z-mark').length,mark:{width:rect.width,height:rect.height},focused:document.activeElement===button,focusOutline:style.outlineStyle,focusWidth:style.outlineWidth,background:getComputedStyle(mark).backgroundImage};})()`);
    layouts.push(layout); await snapshot("brand-" + stage + "-keyboard-focus");
    assert.equal(layout.overflow, false); assert.equal(layout.oldMarks, 0); assert.equal(layout.marks, 4);
    assert.deepEqual(layout.mark, { width: 38, height: 38 }); assert.equal(layout.focused, true);
    assert.equal(layout.focusOutline, "solid"); assert.equal(layout.focusWidth, "2px");
    await key("Enter", "Enter", 13);
    keyboardActivations.push(await evaluate("JSON.parse(document.querySelector('#fixture-state').textContent).badgeClicks"));
    await page.send("Runtime.evaluate", { expression: "document.querySelector('[aria-label=\"更多操作\"]').click()" });
    await waitFor("document.querySelector('[role=menu][aria-label=\"设置更多操作\"]')");
    await snapshot("brand-" + stage + "-settings-menu");
    await evaluate("document.querySelector('[role=menuitem]').click()");
    await waitFor("!document.querySelector('[role=menu]')");
  }
  const state = await evaluate("JSON.parse(document.querySelector('#fixture-state').textContent)");
  assert.equal(state.badgeClicks, 4); assert.equal(state.settingsClosed, 4);
  assert.deepEqual(errors, []); assert.equal(requests.some(url => new URL(url).origin !== "http://127.0.0.1:1460"), false);
  assert.equal(requests.some(url => url.includes("@vite/client")), false);
  const after = await captureSources(); assert.deepEqual(after, before);
  report = { runId, passed: true, stage, scope: "Static real SearchBar/SettingsHeader/AToolsMark component fixture in Chromium; callbacks only, no native host, clipboard or plugin execution", sourceHashes: before, sourceHashesAfter: after, layouts, keyboardActivations, state, screenshots, errors, requests };
} catch (error) { report = { runId, passed: false, stage, error: String(error), screenshots, layouts, keyboardActivations, errors, requests,
  fixtureState: page ? await evaluate("JSON.parse(document.querySelector('#fixture-state').textContent)").catch(() => null) : null }; process.exitCode = 1; }
finally {
  cleanup.fixture = page ? await evaluate("window.atoolsBrandFixture?.dispose().then(()=>true)").then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.cdp = page ? await Promise.resolve(page.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.chrome = chrome ? await Promise.resolve(chrome.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.preview = server ? await Promise.resolve(server.close()).then(() => "fulfilled", () => "failed") : "not_started";
  cleanup.scratch = scratch ? await rm(scratch, { recursive: true, force: true }).then(() => "fulfilled", () => "failed") : "not_started";
  if (Object.values(cleanup).includes("failed")) { report.passed = false; process.exitCode = 1; }
  report.cleanup = cleanup; await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ runId, passed: report.passed, stage: report.stage, output, screenshots: screenshots.length, cleanup }));
}
