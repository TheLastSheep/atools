import { injectPluginBridgeFactories } from "./lib/plugin-bridge-fixture.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { transformWithEsbuild } from "vite";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  assertCheckedChecklistRow,
  CdpClient,
  createPageWebSocketUrl,
  delay,
  formatConsoleArgs,
  launchChrome,
  launchViteServer,
} from "./chrome-cdp-smoke-utils.mjs";

const root = new URL("../", import.meta.url);
const checklistRow = "插件 iframe 内右键不会被宿主 `preventDefault` 取消；宿主应收到 `contextmenu` 上报，并在运行状态条显示 `右键菜单` 与目标区域，例如 `iframe button`。";
const layoutChecklistRow = "插件运行态标题栏、subInput、iframe/output body 不互相覆盖；output layer 出现时不和 iframe 同时占位。";
const iframeContextSmokeUrl = "http://localhost:1420/?parity=1&pluginHostSmoke=iframeContext";
const outputUrl = new URL("../output/launcher-ui-2026-10-15/", import.meta.url);
const outputPrefix = process.argv.find((arg) => arg.startsWith("--output-prefix="))?.slice("--output-prefix=".length) || "plugin-iframe-context-navigation";
assert.match(outputPrefix, /^[a-z0-9][a-z0-9-]*$/, "output prefix must be a plain artifact name");
const [componentSource, hostViewSource, appSource, checklistSource] = await Promise.all([
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginHostView.ts", root), "utf8"),
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");
const bridgeTemplate = await injectPluginBridgeFactories(bridgeMatch[1], { subInputEpoch: 1 });
const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("iframe-context-menu-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("iframe-context-menu-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const listeners = new Map();
const postedMessages = [];
const timers = [];
const flushTimers = () => { while (timers.length) timers.shift()(); };

const targetElement = {
  tagName: "BUTTON",
  isContentEditable: false,
};
let preventDefaultCalls = 0;

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
  addEventListener(type, cb, options) {
    const list = listeners.get(type) || [];
    list.push({ cb, options });
    listeners.set(type, list);
  },
  removeEventListener(type, cb) { listeners.set(type, (listeners.get(type) || []).filter(listener => listener.cb !== cb)); },
  dispatchEvent(event) {
    const list = listeners.get(event.type) || [];
    list.forEach(({ cb }) => cb(event));
  },
  getSelection() {
    return { toString: () => "selected text" };
  },
  matchMedia() {
    return { matches: false };
  },
};

const documentStub = {
  readyState: "complete",
  addEventListener(type, cb) {
    const list = listeners.get(`document:${type}`) || [];
    list.push({ cb, options: undefined });
    listeners.set(`document:${type}`, list);
  },
};

class EventStub {
  constructor(type) {
    this.type = type;
  }
}

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  navigator: { platform: "MacIntel", userAgent: "Mozilla/5.0 (Macintosh)" },
  Event: EventStub,
  console: {
    error() {},
    warn() {},
    log() {},
  },
  Date,
  Math,
  Number,
  Promise,
  setTimeout(cb) {
    timers.push(cb);
    return timers.length;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.context-menu.vm.js" });
flushTimers();

const contextMenuListeners = listeners.get("contextmenu") || [];
assert.ok(contextMenuListeners.length > 0, "the injected bridge should observe iframe contextmenu events");
assert.equal(contextMenuListeners[0].options, true, "contextmenu observation should run in capture phase");

windowStub.dispatchEvent({
  type: "contextmenu",
  clientX: 42,
  clientY: 24,
  screenX: 142,
  screenY: 224,
  target: targetElement,
  defaultPrevented: false,
  preventDefault() {
    preventDefaultCalls += 1;
  },
});
flushTimers();

assert.equal(preventDefaultCalls, 0, "the host observer must not cancel plugin iframe contextmenu events");
const contextMenuMessage = postedMessages.find((message) => message.__ipc_plugin_contextmenu__);
assert.ok(contextMenuMessage, "iframe contextmenu should be reported to the PluginPanel host");
assert.deepEqual(JSON.parse(JSON.stringify(contextMenuMessage)), {
  __ipc_plugin_contextmenu__: true,
  x: 42,
  y: 24,
  screenX: 142,
  screenY: 224,
  tagName: "BUTTON",
  editable: false,
  selectedText: "selected text",
  defaultPrevented: false,
});
for (const target of [{ tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }]) {
  windowStub.dispatchEvent({ type: "contextmenu", target, defaultPrevented: false }); flushTimers();
  assert.equal(postedMessages.at(-1).editable, true, "editable context targets should remain editable");
}
const escapeMessages = () => postedMessages.filter(message => message.__ipc_plugin_escape__).length;
const escape = (target, extra = {}) => ({ type: "keydown", key: "Escape", target, ...extra });
for (const target of [targetElement, { tagName: "INPUT" }]) {
  const before = escapeMessages(), event = escape(target);
  windowStub.dispatchEvent(event); event.defaultPrevented = true; flushTimers();
  assert.equal(escapeMessages(), before, "a plugin-consumed Escape must not leave the iframe");
  windowStub.dispatchEvent(escape(target)); flushTimers();
  assert.equal(escapeMessages(), before + 1, "unconsumed Escape should reach the host from editable and ordinary targets");
}
const beforeGuardedEscape = escapeMessages();
for (const extra of [{ isComposing: true }, { keyCode: 229 }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
  windowStub.dispatchEvent(escape(targetElement, extra)); flushTimers();
}
assert.equal(escapeMessages(), beforeGuardedEscape, "composition and modified Escape must stay with the plugin");
assert.equal(preventDefaultCalls, 0, "host observers must not cancel plugin context or keyboard events");

assert.match(componentSource, /type PluginContextMenuInfo/, "PluginPanel should model iframe contextmenu metadata");
assert.match(componentSource, /let lastPluginContextMenu = \$state/, "PluginPanel should track the latest iframe contextmenu");
assert.match(componentSource, /function handlePluginContextMenu/, "PluginPanel should normalize iframe contextmenu messages");
assert.match(componentSource, /if \(data\.__ipc_plugin_contextmenu__\)/, "PluginPanel should handle iframe contextmenu messages");
assert.match(componentSource, /function injectPluginBridge/, "PluginPanel should share bridge injection between real plugins and preview smoke HTML");
assert.match(componentSource, /function loadPreviewPluginHtml[\s\S]*injectPluginBridge/, "Web preview plugin HTML should include the injected bridge");
assert.match(componentSource, /return injectPluginHostScripts\(html, injection\)/, "PluginPanel must use the shared production injector");
const injectionSource = await readFile(new URL("src/lib/pluginBridgeTransportBinding.ts", root), "utf8");
const injectionModule = await transformWithEsbuild(injectionSource, "pluginBridgeTransportBinding.ts", { loader: "ts", target: "esnext" });
const { injectPluginHostScripts } = await import("data:text/javascript;base64," + Buffer.from(injectionModule.code).toString("base64"));
const injectionHtml = '<!doctype html><html><body class="fixture"><button id="target">目标</button><script>window.originalSawBridge=window.bridgeSawBody;</script></body></html>';
const injectedHtml = injectPluginHostScripts(injectionHtml, '<script>window.bridgeSawBody=!!document.body;window.bridgeSawTarget=!!document.getElementById("target");</script>');
assert.ok(injectedHtml.startsWith("<!doctype html>"), "bridge injection must preserve the document doctype");
const injectionDom = new JSDOM(injectedHtml, { runScripts: "dangerously" });
try {
  assert.equal(injectionDom.window.bridgeSawBody, true, "a headless document must have its body before the bridge executes");
  assert.equal(injectionDom.window.bridgeSawTarget, false, "the bridge must execute before the original plugin content");
  assert.equal(injectionDom.window.originalSawBridge, true, "the original plugin script must see its installed bridge");
} finally { injectionDom.window.close(); }
assert.match(hostViewSource, /contextMenuTarget\?: string/, "pluginHostView should accept iframe contextmenu state");
assert.match(hostViewSource, /label:\s*"右键菜单"/, "pluginHostView should surface iframe contextmenu in the runtime strip");
assert.match(appSource, /pluginHostSmoke\s*===\s*"iframeContext"/, "Web preview should expose an iframe context-menu smoke mode");
assert.match(appSource, /右键测试按钮/, "iframe context-menu smoke mode should render a right-click target");

if (!process.argv.includes("--vm-only")) await assertIframeContextSmokeBrowser();
assertCheckedChecklistRow(checklistSource, checklistRow);
assertCheckedChecklistRow(checklistSource, layoutChecklistRow);
console.info(process.argv.includes("--vm-only")
  ? "Synthetic iframe context-menu and Escape VM/source checks passed; browser checks explicitly skipped."
  : "Synthetic iframe context-menu, Escape and navigation regression passed; owned browser and preview server closed.");

async function assertIframeContextSmokeBrowser() {
  let appServer;
  let chrome;
  try {
    appServer = await launchViteServer({ probeUrl: iframeContextSmokeUrl });
    chrome = await launchChrome();
    const pageWebSocketUrl = await createPageWebSocketUrl(chrome.webSocketUrl);
    const page = await CdpClient.connect(pageWebSocketUrl);
    const consoleIssues = [];
    const frameContexts = new Map();
    try {
      page.on("Runtime.executionContextCreated", ({ context }) => { if (context.auxData?.isDefault) frameContexts.set(context.auxData.frameId, context.id); });
      page.on("Runtime.consoleAPICalled", (params) => {
        if (["warning", "error", "assert"].includes(params.type)) {
          consoleIssues.push(`${params.type}: ${formatConsoleArgs(params.args)}`);
        }
      });
      page.on("Runtime.exceptionThrown", (params) => {
        consoleIssues.push(`exception: ${params.exceptionDetails?.text || "Runtime exception"}`);
      });

      await page.send("Runtime.enable");
      await page.send("Page.enable");
      await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `window.__atoolsEscapeTrace = []; window.addEventListener('message', event => { const data = event.data || {}; if (data.__ipc_plugin_escape__ || data.__ipc_subinput__ || data.__atools_test_escape__) window.__atoolsEscapeTrace.push({ at: performance.now(), data, value: document.querySelector('.sub-input')?.value, focus: document.activeElement?.tagName }); });` });
      await page.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
      await page.send("Page.navigate", { url: iframeContextSmokeUrl });

      const initialState = await waitForIframeContextSmoke(page, false);
      assert.equal(initialState.title, "ATools 3.0");
      assert.equal(initialState.pluginTitle, "插件运行态预览");
      assert.equal(initialState.featureCode, "pluginHostSmoke");
      assert.equal(initialState.featureLabel, "", "old preview actions should not show the code as a readable feature name");
      assert.equal(initialState.navigationSourceCount, 0);
      assert.equal(initialState.hasIframeBody, true);
      assert.equal(initialState.outputLayerCount, 0, "iframe context smoke should not render an output layer");
      assert.equal(initialState.outputRowCount, 0, "iframe context smoke should exercise iframe mode, not output rows");
      assert.equal(initialState.contextMenuChip, null);
      assert.deepEqual(initialState.overlaps, [], "iframe context smoke layout regions should not overlap");
      assert.equal(initialState.viteOverlayCount, 0);
      assert.equal(initialState.documentOverflows, false);
      assert.equal(initialState.bodyOverflows, false);
      assert.equal(initialState.navigationCount, 1, "iframe preview must render the shared navigation header");
      assert.equal(initialState.hostInputCount, 1, "this preview should have exactly one host input");
      assert.equal(initialState.launcherInputCount, 0);
      assert.equal(initialState.inputInNavigation, true, "the requested input should belong to the navigation header");
      assert.equal(initialState.inputInsideNavigationBounds, true);
      const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });

      const contextState = await openIframeContextMenuWhenReady(page);
      assert.deepEqual(contextState.contextMenuChip, {
        label: "右键菜单",
        value: "iframe button",
        detail: "iframe 已上报 contextmenu，宿主保留插件自定义事件路径",
      });
      assert.equal(contextState.hasIframeBody, true);
      assert.equal(contextState.outputLayerCount, 0, "iframe context smoke should not render an output layer after contextmenu");
      assert.deepEqual(contextState.overlaps, [], "iframe context smoke layout regions should not overlap after contextmenu");
      assert.equal(contextState.viteOverlayCount, 0);
      assert.equal(contextState.documentOverflows, false);
      assert.equal(contextState.bodyOverflows, false);
      const frameId = (await page.send("Page.getFrameTree")).frameTree.childFrames?.[0]?.frame.id;
      const frameContext = frameId && frameContexts.get(frameId);
      const frameSend = frameContext ? (method, params) => page.send(method, { ...params, contextId: frameContext }) : await attachOpaqueFrame(page);
      const evaluateFrame = async expression => {
        const result = await frameSend("Runtime.evaluate", { expression, returnByValue: true });
        assert.equal(result.exceptionDetails, undefined, "synthetic iframe evaluation should succeed");
        return result.result.value;
      };
      await evaluateFrame(`(() => { window.addEventListener('keydown', event => { if (event.key === 'Escape') setTimeout(() => parent.postMessage({ __atools_test_escape__: true, target: event.target?.tagName, consumed: event.defaultPrevented }, '*'), 0); }); return true; })()`);
      await evaluateFrame(`(() => { const input=document.createElement('input'); input.id='iframe-escape-editable'; input.value='保留文本'; input.addEventListener('keydown',event=>{if(event.key==='Escape')event.preventDefault();}); document.body.append(input); input.focus(); return true; })()`);
      await pressEscape(page);
      const editableState = await waitForIframeState(page, state => state.escapeTrace.some(event => event.data.__atools_test_escape__ && event.data.target === "INPUT" && event.data.consumed), "plugin-consumed editable Escape");
      assert.equal(editableState.hasIframeBody, true, "a consumed editable Escape should keep the plugin open");
      assert.equal(editableState.subInputValue, "time", "a consumed iframe Escape must not clear the host input");
      assert.equal(await evaluateFrame("document.getElementById('iframe-escape-editable').value"), "保留文本");
      const point = await iframeContextTargetPoint(page);
      for (const type of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 });
      await evaluateFrame("document.getElementById('iframe-context-target').focus()");
      await pressEscape(page);
      const clearedState = await waitForIframeState(page, state => state.subInputValue === "" && state.escapeTrace.some(event => event.data.__ipc_plugin_escape__), "first iframe Escape commits the empty host query");
      assert.equal(clearedState.hasIframeBody, true, "first unconsumed Escape should clear the host query");
      assert.equal(clearedState.subInputValue, "");
      assert.equal(await evaluateFrame("document.getElementById('iframe-context-target').focus(); document.activeElement.id"), "iframe-context-target");
      await pressEscape(page);
      const returnedState = await waitForIframeState(page, state => state.escapeTrace.filter(event => event.data.__ipc_plugin_escape__).length >= 2 && !state.hasIframeBody && state.launcherFocused, "second iframe Escape returns to the focused launcher");
      assert.equal(returnedState.hasIframeBody, false, "second unconsumed Escape should return to search");
      assert.equal(returnedState.launcherInputCount, 1);
      assert.equal(returnedState.launcherFocused, true);
      assert.deepEqual(consoleIssues, [], "iframeContext Browser smoke should have 0 console warn/error");
      await mkdir(outputUrl, { recursive: true });
      await writeFile(new URL(`${outputPrefix}.png`, outputUrl), Buffer.from(screenshot.data, "base64"));
      await writeFile(new URL(`${outputPrefix}.json`, outputUrl), JSON.stringify({ passed: true, scope: "Synthetic iframe only; no original plugin execution", initialState, contextState, editableState, clearedState, returnedState, consoleIssues, screenshot: `${outputPrefix}.png` }, null, 2) + "\n");
    } catch (error) {
      await mkdir(outputUrl, { recursive: true });
      const failurePrefix = `${outputPrefix}-failure-${Date.now()}`;
      const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }).catch(() => null);
      if (screenshot) await writeFile(new URL(`${failurePrefix}.png`, outputUrl), Buffer.from(screenshot.data, "base64"));
      const state = await readIframeContextSmokeState(page).catch(() => null);
      await writeFile(new URL(`${failurePrefix}.json`, outputUrl), JSON.stringify({ passed: false, error: String(error), state, consoleIssues, screenshot: screenshot ? `${failurePrefix}.png` : null }, null, 2) + "\n");
      console.error(`Synthetic iframe failure evidence: ${new URL(`${failurePrefix}.json`, outputUrl).pathname}`);
      throw error;
    } finally {
      await page.close();
    }
  } finally {
    await Promise.allSettled([
      chrome?.close?.(),
      appServer?.close?.(),
    ].filter(Boolean));
  }
}

async function pressEscape(page) {
  for (const type of ["keyDown", "keyUp"]) await page.send("Input.dispatchKeyEvent", { type, key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}

async function waitForIframeState(page, predicate, description) {
  const deadline = Date.now() + 5000;
  let state;
  do {
    state = await readIframeContextSmokeState(page);
    if (predicate(state)) return state;
    await delay(25);
  } while (Date.now() < deadline);
  assert.fail(`Timed out waiting for ${description}: ${JSON.stringify(state)}`);
}

async function attachOpaqueFrame(page) {
  const targets = (await page.send("Target.getTargets")).targetInfos.filter(target => target.type === "iframe" && target.url === "about:srcdoc");
  assert.equal(targets.length, 1, "this dedicated temporary browser should contain exactly its one synthetic iframe target");
  const { sessionId } = await page.send("Target.attachToTarget", { targetId: targets[0].targetId });
  const pending = new Map();
  let sequence = 0;
  page.on("Target.receivedMessageFromTarget", event => {
    if (event.sessionId !== sessionId) return;
    const message = JSON.parse(event.message), waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Synthetic iframe CDP timeout: ${method}`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    void page.send("Target.sendMessageToTarget", { sessionId, message: JSON.stringify({ id, method, params }) }).catch(error => { pending.delete(id); clearTimeout(timer); reject(error); });
  });
}

async function openIframeContextMenuWhenReady(page) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    const point = await iframeContextTargetPoint(page);
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: point.x,
      y: point.y,
      button: "right",
      buttons: 2,
      clickCount: 1,
    });
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x,
      y: point.y,
      button: "right",
      buttons: 0,
      clickCount: 1,
    });
    await delay(250);
    state = await readIframeContextSmokeState(page);
    if (state.contextMenuChip?.value === "iframe button") return state;
  } while (Date.now() < deadline);
  return state;
}

async function iframeContextTargetPoint(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const iframe = document.querySelector(".plugin-body iframe");
      if (!iframe) return null;
      const rect = iframe.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return { x: rect.left + 42, y: rect.top + 28 };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to locate iframe context target");
  }
  assert.ok(response.result.value, "iframe context smoke target should exist");
  return response.result.value;
}

async function waitForIframeContextSmoke(page, expectContextMenu) {
  const deadline = Date.now() + 30000;
  let state;
  do {
    state = await readIframeContextSmokeState(page);
    if (
      state.title === "ATools 3.0"
      && state.pluginTitle === "插件运行态预览"
      && state.hasIframeBody
      && state.viteOverlayCount === 0
      && (expectContextMenu ? state.contextMenuChip?.value === "iframe button" : true)
    ) {
      return state;
    }
    await delay(250);
  } while (Date.now() < deadline);
  return state;
}

async function readIframeContextSmokeState(page) {
  const response = await page.send("Runtime.evaluate", {
    returnByValue: true,
    expression: `(() => {
      const rectOf = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const rect = node.getBoundingClientRect();
        return { selector, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const intersects = (a, b) => a && b && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
        && a.left < b.right - 1 && a.right > b.left + 1 && a.top < b.bottom - 1 && a.bottom > b.top + 1;
      const layoutRects = [
        rectOf(".plugin-navigation"),
        rectOf(".plugin-runtime-strip"),
        rectOf(".plugin-body"),
      ].filter(Boolean);
      const overlaps = [];
      for (let i = 0; i < layoutRects.length; i += 1) {
        for (let j = i + 1; j < layoutRects.length; j += 1) {
          if (intersects(layoutRects[i], layoutRects[j])) {
            overlaps.push(layoutRects[i].selector + " overlaps " + layoutRects[j].selector);
          }
        }
      }
      const runtimeChips = Array.from(document.querySelectorAll(".runtime-chip")).map((chip) => ({
        label: chip.querySelector("span")?.textContent?.trim() || "",
        value: chip.querySelector("strong")?.textContent?.trim() || "",
        detail: chip.querySelector("small")?.textContent?.replace(/\\s+/g, " ").trim() || "",
      }));
      const overlaySelectors = [
        "vite-error-overlay",
        ".vite-error-overlay",
        ".svelte-error-overlay",
        "[data-sveltekit-error]",
      ];
      const navigation = document.querySelector(".plugin-navigation"), input = document.querySelector(".sub-input");
      const navRect = rectOf(".plugin-navigation"), inputRect = rectOf(".sub-input");
      const launcherInput = document.querySelector('[data-atools-search-input]');
      return {
        title: document.title,
        pluginTitle: document.querySelector(".plugin-title")?.textContent?.trim() || "",
        featureLabel: navigation?.querySelector(".feature-tag")?.textContent?.trim() || "",
        featureCode: document.querySelector('.plugin-diagnostics [data-plugin-feature-code]')?.textContent?.trim() || "",
        navigationSourceCount: navigation?.querySelectorAll(".plugin-source").length || 0,
        navigationCount: document.querySelectorAll(".plugin-navigation").length,
        hostInputCount: document.querySelectorAll('input:not([type="hidden"])').length,
        launcherInputCount: document.querySelectorAll('[data-atools-search-input]').length,
        launcherFocused: Boolean(launcherInput && document.activeElement === launcherInput),
        inputInNavigation: Boolean(input && navigation?.contains(input)),
        inputInsideNavigationBounds: Boolean(inputRect && navRect && inputRect.left >= navRect.left - 1 && inputRect.right <= navRect.right + 1 && inputRect.top >= navRect.top - 1 && inputRect.bottom <= navRect.bottom + 1),
        subInputValue: input?.value ?? null,
        escapeTrace: window.__atoolsEscapeTrace || [],
        hasIframeBody: Boolean(document.querySelector(".plugin-body iframe")),
        outputLayerCount: document.querySelectorAll(".plugin-output-layer").length,
        outputRowCount: document.querySelectorAll(".result-item").length,
        contextMenuChip: runtimeChips.find((chip) => chip.label === "右键菜单") || null,
        overlaps,
        viteOverlayCount: overlaySelectors.reduce((count, selector) => count + document.querySelectorAll(selector).length, 0),
        documentOverflows: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
        bodyOverflows: document.body.scrollWidth > document.body.clientWidth + 1,
      };
    })()`,
  });
  if (response.exceptionDetails) {
    assert.fail(response.exceptionDetails.text || "Failed to evaluate iframe context smoke state");
  }
  return response.result.value;
}
