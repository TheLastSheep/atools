import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

const bridgeSource = bridgeMatch[1]
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

class EventStub {
  constructor(type) {
    this.type = type;
  }
}

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  navigator: { platform: "MacIntel" },
  Event: EventStub,
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

assert.match(componentSource, /function runPluginFindInPage/, "host should run find requests against the plugin iframe");
assert.match(componentSource, /const pluginWindow = iframeRef\?\.contentWindow/, "host should read the plugin iframe window");
assert.match(componentSource, /pluginWindow\.find\(query/, "host should use the iframe window find API when available");
assert.match(componentSource, /function stopPluginFindInPage/, "host should handle stop-find requests");
assert.match(componentSource, /removeAllRanges\(\)/, "clearSelection should clear the iframe selection");
assert.match(componentSource, /__ipc_find_in_page__/, "host should receive findInPage messages");
assert.match(componentSource, /__ipc_stop_find_in_page__/, "host should receive stopFindInPage messages");
assert.match(capabilitySource, /"getWindowType"/, "shared capability inventory should include getWindowType");
assert.match(capabilitySource, /"findInPage"/, "shared capability inventory should include findInPage");
assert.match(capabilitySource, /"stopFindInPage"/, "shared capability inventory should include stopFindInPage");
