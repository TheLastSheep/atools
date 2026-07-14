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
  .replace(/__PLUGIN_ID__/g, JSON.stringify("context-bridge-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("context-bridge-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const listeners = new Map();
const postedMessages = [];

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
  addEventListener(type, cb) {
    const list = listeners.get(type) || [];
    list.push(cb);
    listeners.set(type, list);
  },
  dispatchEvent(event) {
    const list = listeners.get(event.type) || [];
    list.forEach((cb) => cb(event));
  },
  matchMedia() {
    return { matches: false };
  },
};

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

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

function respondToNativeCall(call, payload) {
  const handlers = listeners.get("message") || [];
  handlers.forEach((handler) => handler({
    data: {
      __atools_native_response__: true,
      reqId: call.reqId,
      ...payload,
    },
  }));
}

assert.equal(typeof windowStub.utools.readCurrentBrowserUrl, "function", "utools.readCurrentBrowserUrl should be exposed");
assert.equal(typeof windowStub.utools.getCurrentBrowserUrl, "function", "utools.getCurrentBrowserUrl alias should be exposed");
assert.equal(typeof windowStub.utools.readCurrentFolderPath, "function", "utools.readCurrentFolderPath should be exposed");

const browserPromise = windowStub.utools.readCurrentBrowserUrl();
const browserCall = postedMessages.find((message) => message.method === "readCurrentBrowserUrl");
assert.ok(browserCall, "readCurrentBrowserUrl should route through the native bridge");
assert.deepEqual(plain(browserCall.args), {});
respondToNativeCall(browserCall, { result: "https://example.test/current" });
assert.equal(await browserPromise, "https://example.test/current");

const browserAliasPromise = windowStub.utools.getCurrentBrowserUrl();
const browserAliasCall = postedMessages.findLast((message) => message.method === "readCurrentBrowserUrl");
assert.ok(browserAliasCall, "getCurrentBrowserUrl should reuse the readCurrentBrowserUrl native bridge");
respondToNativeCall(browserAliasCall, { result: null });
assert.equal(await browserAliasPromise, null);

const folderPromise = windowStub.utools.readCurrentFolderPath();
const folderCall = postedMessages.find((message) => message.method === "readCurrentFolderPath");
assert.ok(folderCall, "readCurrentFolderPath should route through the native bridge");
assert.deepEqual(plain(folderCall.args), {});
respondToNativeCall(folderCall, { result: "/Users/example/Desktop/" });
assert.equal(await folderPromise, "/Users/example/Desktop/");

assert.match(componentSource, /readCurrentBrowserUrl:\s*function\(\)/, "bridge should expose readCurrentBrowserUrl()");
assert.match(componentSource, /getCurrentBrowserUrl:\s*function\(\)/, "bridge should expose getCurrentBrowserUrl() as an alias");
assert.match(componentSource, /readCurrentFolderPath:\s*function\(\)/, "bridge should expose readCurrentFolderPath()");
assert.match(componentSource, /case "readCurrentBrowserUrl":/, "host should handle current browser URL reads");
assert.match(componentSource, /case "readCurrentFolderPath":/, "host should handle current Finder folder reads");
assert.match(componentSource, /Google Chrome[\s\S]*Microsoft Edge[\s\S]*Safari/, "browser URL bridge should cover supported macOS browsers");
assert.match(componentSource, /path to desktop/, "Finder folder bridge should fall back to Desktop when no Finder window is open");
assert.match(capabilitySource, /"readCurrentBrowserUrl"/, "shared capability inventory should include readCurrentBrowserUrl");
assert.match(capabilitySource, /"getCurrentBrowserUrl"/, "shared capability inventory should include getCurrentBrowserUrl alias");
assert.match(capabilitySource, /"readCurrentFolderPath"/, "shared capability inventory should include readCurrentFolderPath");
