import { loadProductionPluginBridgeTemplate, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const messageHandlers = await readPanelHostSource(root, "src/lib/pluginPanelMessageHandlers.ts");
const authenticatedMessageHandler = await readPanelHostSource(root, "src/lib/authenticatedPluginMessageHandler.ts");
const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("window-search-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("window-search-test-feature"));

const listeners = new Map();
const postedMessages = [];
const dispatchedEvents = [];

function plainMessage(message) {
  return JSON.parse(JSON.stringify(message));
}

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => ({ cmd, args }),
  },
  addEventListener(type, cb) {
    const list = listeners.get(type) || [];
    list.push(cb);
    listeners.set(type, list);
  },
  dispatchEvent(event) {
    dispatchedEvents.push(event.type);
    const list = listeners.get(event.type) || [];
    list.forEach((cb) => cb(event));
  },
  matchMedia() {
    return { matches: false };
  },
};
windowStub.parent.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;
windowStub.top.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;

const documentStub = {
  readyState: "complete",
  addEventListener(type, cb) {
    const list = listeners.get(`document:${type}`) || [];
    list.push(cb);
    listeners.set(`document:${type}`, list);
  },
};

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  navigator: { platform: "MacIntel" },
  Event,
  CustomEvent,
  console: {
    error() {},
    warn() {},
    log() {},
  },
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

assert.equal(typeof windowStub.utools.getWindowType, "function", "utools.getWindowType should be exposed");
assert.equal(windowStub.utools.getWindowType(), "main", "PluginPanel currently runs plugins in the main window host");

assert.equal(typeof windowStub.utools.findInPage, "function", "utools.findInPage should be exposed");
const findResult = windowStub.utools.findInPage("needle", { forward: false, findNext: true });
assert.equal(findResult, undefined, "findInPage should preserve the official void-return shape");
assert.deepEqual(plainMessage(postedMessages.at(-1)), {
  __ipc_find_in_page__: true,
  text: "needle",
  options: { forward: false, findNext: true },
});

assert.equal(typeof windowStub.utools.stopFindInPage, "function", "utools.stopFindInPage should be exposed");
const stopResult = windowStub.utools.stopFindInPage("keepSelection");
assert.equal(stopResult, undefined, "stopFindInPage should preserve the official void-return shape");
assert.deepEqual(plainMessage(postedMessages.at(-1)), {
  __ipc_stop_find_in_page__: true,
  action: "keepSelection",
});

windowStub.utools.findInPage(null);
assert.deepEqual(plainMessage(postedMessages.at(-1)), {
  __ipc_find_in_page__: true,
  text: "",
  options: {},
});

assert.ok(dispatchedEvents.includes("atools-plugin-enter"));
assert.ok(dispatchedEvents.includes("atools-plugin-ready"));

assert.match(messageHandlers, /function runPluginFindInPage/, "host should run find requests against the plugin iframe");
assert.match(messageHandlers, /const pluginWindow = context\.iframeWindow\(\) as FindableWindow \| null/, "message handler should read the current plugin frame through its context port");
assert.match(messageHandlers, /pluginWindow\.find\(query/, "host should use the current iframe window find API when available");
assert.match(messageHandlers, /function stopPluginFindInPage/, "host should handle stop-find requests");
assert.match(messageHandlers, /removeAllRanges\(\)/, "clearSelection should clear the iframe selection");
assert.match(authenticatedMessageHandler, /__ipc_find_in_page__/, "host should receive findInPage messages");
assert.match(authenticatedMessageHandler, /__ipc_stop_find_in_page__/, "host should receive stopFindInPage messages");
assert.match(capabilitySource, /"getWindowType"/, "shared capability inventory should include getWindowType");
assert.match(capabilitySource, /"findInPage"/, "shared capability inventory should include findInPage");
assert.match(capabilitySource, /"stopFindInPage"/, "shared capability inventory should include stopFindInPage");
