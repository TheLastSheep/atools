import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
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
const [componentSource, hostViewSource, appSource, checklistSource] = await Promise.all([
  readFile(new URL("src/components/PluginPanel.svelte", root), "utf8"),
  readFile(new URL("src/lib/pluginHostView.ts", root), "utf8"),
  readFile(new URL("src/App.svelte", root), "utf8"),
  readFile(new URL("docs/macos-smoke-checklist.md", root), "utf8"),
]);

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

const bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("iframe-context-menu-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("iframe-context-menu-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const listeners = new Map();
const postedMessages = [];

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
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.context-menu.vm.js" });

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

assert.match(componentSource, /type PluginContextMenuInfo/, "PluginPanel should model iframe contextmenu metadata");
assert.match(componentSource, /let lastPluginContextMenu = \$state/, "PluginPanel should track the latest iframe contextmenu");
assert.match(componentSource, /function handlePluginContextMenu/, "PluginPanel should normalize iframe contextmenu messages");
assert.match(componentSource, /if \(data\.__ipc_plugin_contextmenu__\)/, "PluginPanel should handle iframe contextmenu messages");
assert.match(componentSource, /function injectPluginBridge/, "PluginPanel should share bridge injection between real plugins and preview smoke HTML");
assert.match(componentSource, /function loadPreviewPluginHtml[\s\S]*injectPluginBridge/, "Web preview plugin HTML should include the injected bridge");
assert.match(componentSource, /bodyOpenMatch/, "bridge injection without a head should wait until the body exists");
assert.match(hostViewSource, /contextMenuTarget\?: string/, "pluginHostView should accept iframe contextmenu state");
assert.match(hostViewSource, /label:\s*"右键菜单"/, "pluginHostView should surface iframe contextmenu in the runtime strip");
assert.match(appSource, /pluginHostSmoke\s*===\s*"iframeContext"/, "Web preview should expose an iframe context-menu smoke mode");
assert.match(appSource, /右键测试按钮/, "iframe context-menu smoke mode should render a right-click target");

await assertIframeContextSmokeBrowser();
assertCheckedChecklistRow(checklistSource, checklistRow);
assertCheckedChecklistRow(checklistSource, layoutChecklistRow);

async function assertIframeContextSmokeBrowser() {
  let appServer;
  let chrome;
  try {
    appServer = await launchViteServer({ probeUrl: iframeContextSmokeUrl });
    chrome = await launchChrome();
    const pageWebSocketUrl = await createPageWebSocketUrl(chrome.webSocketUrl);
    const page = await CdpClient.connect(pageWebSocketUrl);
    const consoleIssues = [];
    try {
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
      await page.send("Page.navigate", { url: iframeContextSmokeUrl });

      const initialState = await waitForIframeContextSmoke(page, false);
      assert.equal(initialState.title, "ATools 3.0");
      assert.equal(initialState.pluginTitle, "插件运行态预览");
      assert.equal(initialState.featureCode, "pluginHostSmoke");
      assert.equal(initialState.hasIframeBody, true);
      assert.equal(initialState.outputLayerCount, 0, "iframe context smoke should not render an output layer");
      assert.equal(initialState.outputRowCount, 0, "iframe context smoke should exercise iframe mode, not output rows");
      assert.equal(initialState.contextMenuChip, null);
      assert.deepEqual(initialState.overlaps, [], "iframe context smoke layout regions should not overlap");
      assert.equal(initialState.viteOverlayCount, 0);
      assert.equal(initialState.documentOverflows, false);
      assert.equal(initialState.bodyOverflows, false);

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
      assert.deepEqual(consoleIssues, [], "iframeContext Browser smoke should have 0 console warn/error");
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
        rectOf(".plugin-header"),
        rectOf(".plugin-runtime-strip"),
        rectOf(".sub-input-row"),
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
      return {
        title: document.title,
        pluginTitle: document.querySelector(".plugin-title")?.textContent?.trim() || "",
        featureCode: document.querySelector(".feature-code")?.textContent?.trim() || "",
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
