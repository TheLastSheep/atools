import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { CdpClient, formatConsoleArgs, delay } from "../chrome-cdp-smoke-utils.mjs";
import { isOwnedResourceClean, launchOwnedChrome, launchOwnedVite } from "./launcher-menu-browser-runtime.mjs";
import { originalBrowserControls, originalEventObservationSource } from "./original-plugin-browser-cdp.mjs";
import { runSubnetBrowser, runUuidBrowser } from "./original-plugin-browser-scenarios.mjs";
import { observeOriginalFrameSessions } from "./original-plugin-browser-frames.mjs";
import { boundedOriginalCdp, createOriginalPageTarget, navigateOriginalPage } from "./original-plugin-browser-deadline.mjs";
import { connectOriginalCdpSocket } from "./original-plugin-browser-websocket.mjs";
import { runOriginalImageBrowser } from "./original-plugin-browser-image.mjs";
import { createOriginalBrowserNodeHost } from "./original-plugin-browser-node-host.mjs";

export function allowedOriginalBrowserUrl(url, port, nodeEndpoints = new Set()) {
  if (!/^(https?|wss?):/i.test(url)) return /^(about:|data:|blob:|asset:)/.test(url);
  const parsed = new URL(url);
  return parsed.hostname === "127.0.0.1" && (parsed.port === String(port) || nodeEndpoints.has(url));
}
export async function runOriginalBusinessBrowser({ root, port, report, screenshotPath }) {
  let server, chrome, page, control, frameSessions, nodeHost, failure;
  const deadlineAt = Date.now() + 120000;
  const startupBudget = () => { const remaining = deadlineAt - Date.now(); assert.ok(remaining > 0, "Original browser startup total deadline exceeded"); return Math.min(10000, remaining); };
  report.cleanup = { page: "not_created", app: "not_mounted", vite: { closeState: "not_created", cacheState: "not_created" },
    chrome: { processState: "not_spawned", profileState: "not_created" }, errors: [], allOwnedResourcesClean: false };
  report.checks = []; report.consoleIssues = []; report.requests = []; report.documents = []; report.inputs = [];
  report.loader = []; report.scenarios = {}; report.phase = "setup";
  try {
    try { server = await launchOwnedVite({ root, port }); report.cleanup.vite = { ...server.lifecycle }; }
    catch (error) { if (error.atoolsLifecycle?.vite) report.cleanup.vite = error.atoolsLifecycle.vite; throw error; }
    try { chrome = await launchOwnedChrome(); report.cleanup.chrome = { ...chrome.lifecycle }; }
    catch (error) { if (error.atoolsLifecycle?.chrome) report.cleanup.chrome = error.atoolsLifecycle.chrome; throw error; }
    const target = await createOriginalPageTarget(chrome.webSocketUrl, { timeoutMs: startupBudget() });
    const socket = await connectOriginalCdpSocket(target, { timeoutMs: startupBudget() });
    page = boundedOriginalCdp(new CdpClient(socket), { totalMs: deadlineAt - Date.now() });
    nodeHost = await createOriginalBrowserNodeHost(page, root, report);
    control = originalBrowserControls(page, report);
    report.screenshots = [];
    control.screenshot = async name => {
      const image = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const bytes = Buffer.from(image.data, "base64"), path = screenshotPath.replace(/\.png$/, `-${name}.png`);
      await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
      report.screenshots.push({ name, path, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
    };
    const observeErrors = client => {
      client.on("Runtime.exceptionThrown", event => report.consoleIssues.push({ kind: "exception", message: event.exceptionDetails?.exception?.description || event.exceptionDetails?.text }));
      client.on("Runtime.consoleAPICalled", ({ type, args }) => {
        if (["error", "warning", "assert"].includes(type)) report.consoleIssues.push({ kind: type, message: formatConsoleArgs(args) });
      });
    };
    const observeNetwork = client => {
      const receive = (url, type) => report.requests.push({ url: url.replace(/\/node\/[a-f0-9]{64}/g, "/node/[redacted]"), type,
        allowed: allowedOriginalBrowserUrl(url, port, nodeHost?.endpoints) });
      client.on("Network.requestWillBeSent", event => receive(event.request.url, event.type));
      client.on("Network.webSocketCreated", event => receive(event.url, "WebSocket"));
    };
    observeErrors(page);
    observeNetwork(page);
    frameSessions = await observeOriginalFrameSessions(page, report, (session, id) => {
      control.observeClient(session, id); observeErrors(session); observeNetwork(session);
    }, originalEventObservationSource);
    await page.send("Page.enable"); await page.send("Runtime.enable"); await page.send("Network.enable");
    await page.send("Page.addScriptToEvaluateOnNewDocument", { source: originalEventObservationSource });
    report.browser = await page.send("Browser.getVersion");
    await page.send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1050, deviceScaleFactor: 1, mobile: false });
    await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
    const url = `http://127.0.0.1:${port}/tests/components/original-plugin-business-browser.html?workspace=${encodeURIComponent(root)}`;
    await navigateOriginalPage(page, url); await page.send("Page.bringToFront");
    await control.wait(() => control.evaluate("window.launcherFixtureReady&&document.hasFocus()&&document.visibilityState==='visible'&&!!document.querySelector('[role=combobox]')"), "focused actual App fixture");
    report.cleanup.app = "mounted";
    report.fixture = await control.evaluate("({ready:!!window.launcherFixtureReady,mockIPC:typeof window.__TAURI_INTERNALS__?.invoke==='function',backgroundServices:false,hostDoubles:window.fixture.hostDoubles})");
    await runSubnetBrowser(control, report); await runUuidBrowser(control, report); await runOriginalImageBrowser(control, report);
    report.phase = "final-observation";
    report.fixture.final = await control.evaluate("({calls:window.fixture.calls,rejected:window.fixture.rejected,events:window.fixture.events})");
    assert.deepEqual(report.fixture.final.rejected, [], "No unregistered host IPC calls permitted");
    assert.equal(report.fixture.final.calls.filter(call => call.command === "activate_feature").length, 2);
    assert.equal(report.fixture.final.calls.filter(call => call.command === "activate_image_content_feature").length, 2);
    assert.equal(report.fixture.final.calls.filter(call => call.command === "read_launcher_clipboard_media").length, 2);
    const reads = report.fixture.final.calls.filter(call => call.command === "plugin:fs|read_text_file" || call.command === "read_plugin_preload_module");
    for (const id of ["subnet-calculator", "uuid-kit"]) {
      assert.ok(reads.some(call => call.args.path?.endsWith(`/${id}/index.html`)), "Actual loader must read original HTML: " + id);
      assert.ok(reads.some(call => call.command === "read_plugin_preload_module" && call.args.pluginId === id && call.args.modulePath.endsWith("/preload.js")), "Actual loader must read original preload: " + id);
    }
    assert.ok(reads.some(call => call.args.path?.endsWith("/uuid-kit/uuid-core.js")), "Actual UUID external original core must be loaded");
    for (const file of ["index.html", "app.js", "style.css"]) assert.ok(reads.some(call => call.args.path?.endsWith("/image-stitch/" + file)), "Actual original image resource must be read: " + file);
    const clipboard = report.fixture.final.calls.filter(call => /copy_text|clipboard.*(write|read)|plugin:clipboard|plugin:shell/.test(call.command));
    assert.deepEqual(clipboard, [], "No clipboard or shell operation belongs to these business scenarios");
    await delay(80);
    assert.deepEqual(report.consoleIssues, [], "No browser errors, warnings, assertions or runtime exceptions");
    assert.ok(report.requests.every(item => item.allowed), "Browser requests stay on the owned Vite origin or exact owned Node session endpoints (including delayed CDP events after listener close)");
    report.phase = "completed"; report.status = "passed";
  } catch (error) {
    failure = error; report.status = "failed";
    report.error = { name: error.name, message: error.message, stack: error.stack };
    if (control?.screenshot) await control.screenshot("failure").catch(screenshotError => { report.failureScreenshotError = screenshotError.message; });
    if (control) report.diagnostic = await control.evaluate(`({ready:window.launcherFixtureReady,focused:document.hasFocus(),visibility:document.visibilityState,
      active:document.activeElement?.outerHTML?.slice(0,500),text:document.body.innerText.slice(0,3500),calls:window.fixture?.calls,rejected:window.fixture?.rejected})`).catch(error => ({ readError: error.message }));
  } finally {
    page?.beginCleanup();
    async function close(label, operation) { try { await operation(); } catch (error) { report.cleanup.errors.push(label + ": " + error.message); failure ||= error; } }
    if (control && report.cleanup.app === "mounted") await close("App fixture unmount", async () => {
      const result = await control.evaluate("window.fixture.dispose()");
      report.cleanup.appDetails = result; report.cleanup.app = "unmounted";
      assert.equal(result.listeners, 0, "Actual App must release all mock event subscriptions");
    });
    await close("iframe sessions", async () => { if (frameSessions) report.cleanup.iframeSessions = await frameSessions.close(); });
    await close("Node fixture host", async () => { if (nodeHost) report.cleanup.nodeHost = await nodeHost.close(); });
    await close("page", async () => { if (page) report.cleanup.cdp = await page.close(); report.cleanup.page = page ? "closed" : "not_created"; });
    await close("Chrome", async () => { if (chrome) report.cleanup.chrome = { ...await chrome.close() }; });
    await close("Vite", async () => { if (server) report.cleanup.vite = { ...await server.close() }; });
    report.cleanup.allOwnedResourcesClean = report.cleanup.errors.length === 0
      && ["unmounted", "not_mounted"].includes(report.cleanup.app)
      && ["closed", "not_created"].includes(report.cleanup.page)
      && (!nodeHost || report.cleanup.nodeHost?.allNodeListenersAndProcessesStopped === true)
      && isOwnedResourceClean(report.cleanup.vite.closeState) && isOwnedResourceClean(report.cleanup.vite.cacheState)
      && isOwnedResourceClean(report.cleanup.chrome.processState) && isOwnedResourceClean(report.cleanup.chrome.profileState);
    if (!report.cleanup.allOwnedResourcesClean) failure ||= Error("Owned browser cleanup incomplete");
  }
  if (failure) throw failure;
}
