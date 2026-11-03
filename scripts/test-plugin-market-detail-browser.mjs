import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { CdpClient, createPageWebSocketUrl, delay, formatConsoleArgs, launchChrome, launchViteServer } from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url), origin = "http://127.0.0.1:1457", runId = randomUUID();
const output = new URL(`output/launcher-ui-2026-10-15/market-detail-${runId}/`, root);
const sources = ["src/components/PluginMarketPanel.svelte", "src/components/PluginMarketDetailDialog.svelte",
  "src/components/PluginMarketSourceAction.svelte", "src/components/PluginMarketTargetNotice.svelte", "src/components/SettingsConfirmDialog.svelte",
  "src/lib/pluginMarketDetailFocus.ts", "src/lib/pluginMarketController.ts", "src/lib/pluginMarketInstallIntent.ts", "src/lib/pluginMarketView.ts", "src/lib/pluginMarketTarget.ts",
  "src/lib/pluginMarketSession.ts", "src/lib/pluginMarketNavigation.ts", "src/lib/pluginMarketStatus.ts", "src/lib/pluginOpen.ts", "src/lib/types.ts", "src/lib/settingsConfirmFocus.ts", "src/lib/modalFocusOwner.ts",
  "src/components/ShellFrame.svelte", "src/components/PermissionPromptHost.svelte", "src/components/PermissionConfirmDialog.svelte", "src/lib/permissionQueue.ts",
  "src/lib/permissionApproval.ts", "src/lib/permissionDialogFocus.ts", "src/lib/permissionPresentation.ts", "src/lib/permissionPreview.ts", "tests/components/permissionHarnessBackend.ts",
  "src/styles/global.css", "tests/components/PluginMarketDetailBrowserHarness.svelte", "tests/components/pluginMarketDetailBrowserFixture.ts",
  "tests/components/plugin-market-detail-browser.html", "scripts/test-plugin-market-detail-browser.mjs", "scripts/chrome-cdp-smoke-utils.mjs",
  "scripts/lib/owned-vite-server.mjs", "scripts/lib/owned-vite-cli-process.mjs", "scripts/lib/owned-vite-cli-worker.mjs"];
const hashSources = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file,
  createHash("sha256").update(await readFile(new URL(file, root))).digest("hex")])));
const report = { runId, status: "incomplete", scope: "Actual PluginMarketPanel/DetailDialog/SettingsConfirmDialog in Chromium, 220 offline metadata fixtures. No real market, download, plugin execution, full SettingsPanel, native WebView or authorization acceptance.",
  checks: [], screenshots: [], consoleIssues: [], blockedExternalRequests: [], cleanupErrors: [] };
let server, chrome, page;
const cdp = (method, params = {}) => page.send(method, params, { timeoutMs: 15000 });
async function evaluate(expression) {
  const result = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  assert.ok(!result.exceptionDetails, result.exceptionDetails?.exception?.description || result.exceptionDetails?.text);
  return result.result.value;
}
async function waitFor(expression) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await delay(25); }
  assert.fail("Timed out: " + expression);
}
async function click(elementExpression) {
  const point = await evaluate(`(()=>{const element=${elementExpression};if(!element)throw Error('Missing click target');const r=element.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
  assert.ok(point.x >= 0 && point.y >= 0);
  await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
  await cdp("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...point });
  await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...point });
}
async function key(key, code, virtualKey, modifiers = 0) {
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: virtualKey, modifiers });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: virtualKey, modifiers });
  await delay(20);
}
const dialog = "document.querySelector('#plugin-market-detail')";
const back = `${dialog}.querySelector('[data-market-detail-close]')`;
async function confirmContrast() {
  const colors = await evaluate(`(()=>{const panel=document.querySelector('.confirm-panel'),style=getComputedStyle(panel);return {background:style.backgroundColor,items:[panel.querySelector('h3'),panel.querySelector('.confirm-message p'),...panel.querySelectorAll('.confirm-actions button')].map(node=>({text:node.textContent.slice(0,40),color:getComputedStyle(node).color,background:getComputedStyle(node).backgroundColor}))};})()`);
  const rgba = value => { const parts = value.match(/[\d.]+/g).map(Number); return [...parts.slice(0, 3), parts[3] ?? 1]; };
  const blend = (color, behind) => color.slice(0, 3).map((channel, index) => channel * color[3] + behind[index] * (1 - color[3]));
  const luminance = color => color.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [.2126, .7152, .0722][index], 0);
  const base = rgba(colors.background);
  assert.equal(base[3], 1, "Confirmation background must be opaque for contrast measurement");
  const items = colors.items.map(item => {
    const background = blend(rgba(item.background), base), foreground = blend(rgba(item.color), background);
    const a = luminance(foreground), b = luminance(background);
    return { ...item, contrast: (Math.max(a, b) + .05) / (Math.min(a, b) + .05) };
  });
  for (const item of items) assert.ok(item.contrast >= 4.5, JSON.stringify(item));
  return { ...colors, items };
}
async function openFirst() {
  await evaluate(`(()=>{const panel=document.querySelector('.market-panel'),input=panel.querySelector('input[type=search]');input.value='样例';input.dispatchEvent(new InputEvent('input',{bubbles:true}));})()`);
  await waitFor("document.querySelectorAll('.plugin-row').length===220");
  await evaluate(`(()=>{const panel=document.querySelector('.market-panel'),row=panel.querySelector('.plugin-row');panel.scrollTop=Math.max(1,row.getBoundingClientRect().top-panel.getBoundingClientRect().top+panel.scrollTop-140);window.detailTrigger=row.querySelector('[aria-haspopup=dialog]');window.catalogScroll=panel.scrollTop;})()`);
  await click("window.detailTrigger");
  await waitFor(`${dialog}?.matches(':modal') && document.activeElement===${back}`);
}
async function assertRestored() {
  await waitFor(`!${dialog} && document.activeElement===window.detailTrigger`);
  assert.equal(await evaluate("document.querySelector('.market-panel').scrollTop===window.catalogScroll"), true);
  assert.equal(await evaluate("document.querySelector('input[type=search]').value"), "样例");
  assert.equal(await evaluate("document.querySelectorAll('.plugin-row').length"), 220);
}
try {
  await mkdir(output, { recursive: true }); report.sourcesBefore = await hashSources();
  server = await launchViteServer({ cwd: root.pathname, port: 1457, probeUrl: origin });
  chrome = await launchChrome(); page = await CdpClient.connect(await createPageWebSocketUrl(chrome.webSocketUrl));
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  report.browserVersion = await cdp("Browser.getVersion");
  page.on("Runtime.exceptionThrown", event => report.consoleIssues.push(event.exceptionDetails?.exception?.description || event.exceptionDetails?.text));
  page.on("Runtime.consoleAPICalled", ({ type, args }) => { if (["error", "warning", "assert"].includes(type)) report.consoleIssues.push(type + ":" + formatConsoleArgs(args)); });
  const interceptions = new Set();
  page.on("Fetch.requestPaused", event => {
    const allowed = event.request.url.startsWith(origin + "/");
    if (!allowed) report.blockedExternalRequests.push(event.request.url);
    const pending = cdp(allowed ? "Fetch.continueRequest" : "Fetch.failRequest", { requestId: event.requestId, ...(!allowed ? { errorReason: "BlockedByClient" } : {}) });
    interceptions.add(pending); pending.catch(error => report.consoleIssues.push(String(error))).finally(() => interceptions.delete(pending));
  });
  await cdp("Fetch.enable", { patterns: [{ urlPattern: "http*", requestStage: "Request" }] });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  const loaded = page.waitForEvent("Page.loadEventFired", 15000);
  await cdp("Page.navigate", { url: origin + "/tests/components/plugin-market-detail-browser.html" }); await loaded;
  await waitFor("window.marketDetailReady && document.querySelectorAll('.plugin-row').length===220");
  report.checks.push("220 offline catalog entries rendered without downloading or executing any plugin");
  for (const [theme, width] of [["light", 800], ["dark", 800], ["light", 480], ["dark", 480]]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 600, deviceScaleFactor: 1, mobile: false });
    await evaluate(`document.documentElement.dataset.atoolsTheme=${JSON.stringify(theme)}`);
    await openFirst();
    const geometry = await evaluate(`(()=>{const node=${dialog},title=node.querySelector('h2'),header=node.querySelector('header'),button=node.querySelector('[data-market-detail-close]'),footer=node.querySelector('footer'),rect=element=>{const r=element.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};return {modal:node.matches(':modal'),dialog:rect(node),title:rect(title),back:rect(button),header:rect(header),footer:rect(footer),horizontalOverflow:node.scrollWidth>node.clientWidth+1,pageOverflow:document.documentElement.scrollWidth>innerWidth,headerOverlap:title.getBoundingClientRect().right>button.getBoundingClientRect().left&&title.getBoundingClientRect().bottom>button.getBoundingClientRect().top,titleText:title.textContent};})()`);
    assert.equal(geometry.modal, true); assert.equal(geometry.titleText, "颜色工具");
    assert.equal(geometry.horizontalOverflow, false); assert.equal(geometry.pageOverflow, false); assert.equal(geometry.headerOverlap, false);
    for (const part of [geometry.dialog, geometry.title, geometry.back, geometry.footer]) {
      assert.ok(part.left >= -1 && part.right <= width + 1 && part.top >= -1 && part.bottom <= 601, JSON.stringify(geometry));
    }
    assert.equal(await evaluate(`(()=>{document.querySelector('input[type=search]').focus();return document.activeElement===${back};})()`), true);
    await key("Tab", "Tab", 9, 8); assert.equal(await evaluate(`document.activeElement===${dialog}.querySelector('footer button')`), true);
    await key("Tab", "Tab", 9); assert.equal(await evaluate(`document.activeElement===${back}`), true);
    const file = `detail-${theme}-${width}.png`, capture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(file, output), Buffer.from(capture.data, "base64")); report.screenshots.push({ file, theme, width, geometry });
    if (theme === "light") await key("Escape", "Escape", 27); else await click(back);
    await assertRestored();
  }
  report.checks.push("800/480 light/dark detail layouts stay within viewport without overlap or horizontal overflow");
  report.checks.push("Native modality blocks catalog focus; real Tab/Shift+Tab wrap, Escape/button close restores original row, query and scroll");
  assert.equal(await evaluate("fixture.calls.filter(call=>call.command==='fetch_official_plugin_target').length"), 0);
  report.checks.push("Catalog, filtering and four detail opens do not prefetch per-plugin release metadata");
  await openFirst(); await click(`${dialog}.querySelector('footer button')`);
  await waitFor("!document.querySelector('#plugin-market-detail') && document.querySelector('.confirm-panel')");
  assert.equal(await evaluate("fixture.confirmations.length"), 1);
  assert.equal(await evaluate("fixture.calls.filter(call=>call.command==='resolve_plugin_market_download')[0].args.plugin.id"), "offline-fixture-1");
  assert.equal(await evaluate("document.querySelector('.confirm-panel').textContent.includes('颜色工具 v1.0.0')"), true);
  const deny = "document.querySelector('.confirm-panel [data-confirm-cancel]')";
  assert.equal(await evaluate(`document.activeElement===${deny}`), true);
  await key("Tab", "Tab", 9, 8);
  assert.equal(await evaluate("document.activeElement===document.querySelector('.confirm-panel .primary')"), true);
  await key("Tab", "Tab", 9); assert.equal(await evaluate(`document.activeElement===${deny}`), true);
  await evaluate("document.querySelector('input[type=search]').focus()");
  assert.equal(await evaluate(`document.activeElement===${deny}`), true);
  await key("Escape", "Escape", 27);
  await waitFor("!document.querySelector('.confirm-panel')");
  report.calls = await evaluate("fixture.calls"); report.confirmations = await evaluate("fixture.confirmations");
  assert.ok(report.calls.every(call => ["list_plugins", "fetch_plugin_market_catalog", "fetch_official_plugin_target", "resolve_plugin_market_download"].includes(call.command)));
  assert.deepEqual(await evaluate("fixture.unexpectedCommands"), []); assert.deepEqual(await evaluate("fixture.globalKeys"), []);
  report.checks.push("Detail install uses the selected identity and opens existing installation confirmation; cancel performs no mutation or plugin execution");
  assert.equal(report.calls.filter(call => call.command === "fetch_official_plugin_target").length, 1);
  assert.ok(report.calls.findIndex(call => call.command === "fetch_official_plugin_target")
    < report.calls.findIndex(call => call.command === "resolve_plugin_market_download"));
  const downloadCount = () => evaluate("fixture.calls.filter(call=>call.command==='resolve_plugin_market_download').length");
  for (const [mode, label] of [["unsupported", "当前平台不支持"], ["missing", "未找到官方发布信息"], ["error", "官方发布信息查询失败"]]) {
    const before = await downloadCount();
    await evaluate(`fixture.preflight.mode=${JSON.stringify(mode)}`);
    await openFirst(); await click(`${dialog}.querySelector('footer button')`);
    await waitFor(`!${dialog} && document.querySelector('section[aria-label=${JSON.stringify(label)}]')`);
    assert.equal(await downloadCount(), before);
    assert.equal(await evaluate("!!document.querySelector('.confirm-panel')"), false);
    const file = `preflight-${mode}.png`;
    await evaluate(`document.querySelector('section[aria-label=${JSON.stringify(label)}]').scrollIntoView({block:'center'})`);
    const capture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    await writeFile(new URL(file, output), Buffer.from(capture.data, "base64"));
    report.screenshots.push({ file, scenario: mode });
  }
  report.checks.push("Unsupported platform, missing release and query failure stop before download resolution and confirmation");
  await evaluate("fixture.preflight.mode='available';fixture.preflight.version='2.0.0'");
  await openFirst(); await click(`${dialog}.querySelector('footer button')`);
  await waitFor("document.querySelector('.confirm-panel')?.textContent.includes('v2.0.0')");
  const fresh = await evaluate("({request:fixture.confirmations.at(-1),resolved:fixture.calls.filter(call=>call.command==='resolve_plugin_market_download').at(-1)})");
  assert.ok(fresh.request.title.includes("发布版本已变化"));
  assert.ok(fresh.request.message.includes("v1.0.0") && fresh.request.message.includes("v2.0.0"));
  assert.equal(fresh.request.confirmLabel, "安装 v2.0.0");
  assert.equal(fresh.resolved.args.plugin.id, "offline-fixture-1");
  assert.equal(fresh.resolved.args.plugin.version, "2.0.0");
  const changedCapture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL("preflight-version-changed.png", output), Buffer.from(changedCapture.data, "base64"));
  report.screenshots.push({ file: "preflight-version-changed.png", scenario: "version-changed" });
  await click("[...document.querySelectorAll('.confirm-panel button')].find(button=>button.textContent==='取消')");
  await waitFor("!document.querySelector('.confirm-panel')");
  report.calls = await evaluate("fixture.calls"); report.confirmations = await evaluate("fixture.confirmations");
  assert.ok(report.calls.every(call => ["list_plugins", "fetch_plugin_market_catalog", "fetch_official_plugin_target", "resolve_plugin_market_download"].includes(call.command)));
  assert.deepEqual(await evaluate("fixture.unexpectedCommands"), []);
  report.checks.push("Changed release uses fresh identity/version in resolver and explicit reconfirmation; cancel performs no installation");
  report.confirmationContrast = [];
  for (const [theme, osTheme] of [["light", "dark"], ["dark", "light"]]) {
    await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: osTheme }] });
    await evaluate(`document.documentElement.dataset.atoolsTheme=${JSON.stringify(theme)}`);
    await openFirst(); await click(`${dialog}.querySelector('footer button')`);
    await waitFor("document.querySelector('.confirm-panel') && document.activeElement===document.querySelector('[data-confirm-cancel]')");
    report.confirmationContrast.push({ theme, osTheme, ...await confirmContrast() });
    const capture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = `confirmation-${theme}-opposite-os.png`;
    await writeFile(new URL(file, output), Buffer.from(capture.data, "base64")); report.screenshots.push({ file, theme, osTheme });
    await key("Escape", "Escape", 27); await waitFor("!document.querySelector('.confirm-panel')");
  }
  report.calls = await evaluate("fixture.calls"); report.confirmations = await evaluate("fixture.confirmations");
  assert.ok(report.calls.every(call => ["list_plugins", "fetch_plugin_market_catalog", "fetch_official_plugin_target", "resolve_plugin_market_download"].includes(call.command)));
  assert.deepEqual(await evaluate("fixture.unexpectedCommands"), []); assert.deepEqual(await evaluate("fixture.globalKeys"), []);
  report.checks.push("Confirmation starts on cancel, contains Tab/focus, owns Escape and meets 4.5:1 text contrast for app themes opposite to OS preference");
  await openFirst(); await click(`${dialog}.querySelector('footer button')`);
  await waitFor("document.querySelector('.confirm-panel') && document.activeElement===document.querySelector('[data-confirm-cancel]')");
  await evaluate("fixture.permissionBackend.add('coexisting-browser',true)");
  await waitFor("document.querySelector('[data-permission-dialog]')");
  await waitFor("document.activeElement===document.querySelector('[data-permission-deny]')");
  await evaluate(`${deny}.focus()`);
  assert.equal(await evaluate("document.activeElement===document.querySelector('[data-permission-deny]')"), true);
  assert.equal(await evaluate("(()=>{const button=document.querySelector('[data-permission-deny]'),r=button.getBoundingClientRect();return document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===button;})()"), true);
  const coexistCapture = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  await writeFile(new URL("confirmation-pending-permission.png", output), Buffer.from(coexistCapture.data, "base64"));
  report.screenshots.push({ file: "confirmation-pending-permission.png", scenario: "two-mounted-dialogs" });
  await key("Escape", "Escape", 27);
  await waitFor(`!document.querySelector('[data-permission-dialog]') && document.activeElement===${deny}`);
  assert.equal(await evaluate("fixture.permissionBackend.calls.some(call=>call.command==='dismiss_pending_agent_request')"), true);
  await key("Escape", "Escape", 27);
  await waitFor("!document.querySelector('.confirm-panel')");
  assert.equal(await evaluate("document.activeElement===window.detailTrigger"), true);
  report.permissionCalls = await evaluate("fixture.permissionBackend.calls");
  assert.equal(report.permissionCalls.some(call => call.command === "call_agent_tool" || call.command === "grant_agent_tool"), false);
  report.calls = await evaluate("fixture.calls"); report.confirmations = await evaluate("fixture.confirmations");
  assert.deepEqual(await evaluate("fixture.unexpectedCommands"), []); assert.deepEqual(await evaluate("fixture.globalKeys"), []);
  report.checks.push("Actual ShellFrame stacking gives the global permission visual/focus ownership, resumes confirmation after deny, then restores the original catalog trigger without approving a task");
  await Promise.allSettled([...interceptions]);
  assert.deepEqual(report.consoleIssues, []); assert.deepEqual(report.blockedExternalRequests, []);
  report.status = "passed";
} catch (error) {
  report.status = "failed"; report.error = String(error);
  report.failureSnapshot = await evaluate("({text:document.body.innerText.slice(0,3000),active:document.activeElement?.outerHTML,calls:window.fixture?.calls})").catch(() => null);
  if (page) await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: false })
    .then(capture => writeFile(new URL("failure.png", output), Buffer.from(capture.data, "base64"))).catch(() => {});
} finally {
  const cleanup = await Promise.allSettled([page?.close(), chrome?.close(), server?.close()]);
  report.cleanupErrors = cleanup.filter(result => result.status === "rejected").map(result => String(result.reason));
  try { report.sourcesAfter = await hashSources(); report.sourcesUnchanged = JSON.stringify(report.sourcesBefore) === JSON.stringify(report.sourcesAfter); }
  catch (error) { report.sourceHashError = String(error); }
  if (report.cleanupErrors.length || !report.sourcesUnchanged) report.status = "failed";
  report.finishedAt = new Date().toISOString();
  await mkdir(output, { recursive: true }); await writeFile(new URL("report.json", output), JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify({ output: output.pathname, status: report.status, checks: report.checks.length }));
  if (report.status !== "passed") process.exitCode = 1;
}
