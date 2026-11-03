import { loadProductionPluginBridgeTemplate, readPanelHostSource } from "./lib/plugin-panel-source-test-adapter.mjs";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageInfo = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const panelSource = await readPanelHostSource(root, "src/components/PluginPanel.svelte");
const documentSource = await readPanelHostSource(root, "src/lib/pluginPanelDocumentSourceHost.ts");
const compilerSource = await readPanelHostSource(root, "src/lib/pluginPanelBridgeCompiler.ts");
const nativeIdentitySource = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/attachments-and-db-storage.ts");
const providerEntrySource = await readPanelHostSource(root, "src/lib/pluginUtoolsBridgeSource/providers-and-entry-lifecycle.ts");
const capabilitySource = await readFile(new URL("src/lib/pluginBridgeCapabilities.ts", root), "utf8");

const bridgeTemplate = await loadProductionPluginBridgeTemplate(root);

const bridgeSource = bridgeTemplate
  .replace(/__ACTION_PAYLOAD__/g, JSON.stringify(null))
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("system-identity-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("system-identity-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify(packageInfo.productName))
  .replace(/__APP_VERSION__/g, JSON.stringify(packageInfo.version));

const listeners = new Map();
const dispatchedEvents = [];
const storage = new Map();

const windowStub = {
  parent: {
    postMessage() {},
  },
  top: {},
  __TAURI_INTERNALS__: {
    invoke: async (cmd, args) => ({ cmd, args }),
  },
  localStorage: {
    getItem(key) {
      return storage.has(key) ? storage.get(key) : null;
    },
    setItem(key, value) {
      storage.set(key, String(value));
    },
    removeItem(key) {
      storage.delete(key);
    },
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
class CustomEventStub extends EventStub {
  constructor(type, init = {}) {
    super(type);
    this.detail = init.detail;
  }
}

const context = vm.createContext({
  window: windowStub,
  document: documentStub,
  navigator: { platform: "Linux x86_64", userAgent: "Mozilla/5.0 (X11; Linux x86_64)" },
  Event: EventStub,
  CustomEvent: CustomEventStub,
  console: {
    error() {},
    warn() {},
    log() {},
  },
  Date,
  Math,
  TextEncoder,
  setTimeout(cb) {
    cb();
    return 1;
  },
  clearTimeout() {},
});

vm.runInContext(bridgeSource, context, { filename: "UTOOLS_BRIDGE.vm.js" });

assert.equal(typeof windowStub.utools.getNativeId, "function", "utools.getNativeId should be exposed");
const nativeId = windowStub.utools.getNativeId();
assert.match(nativeId, /^atools-native-[a-z0-9-]+$/, "native id should use an ATools stable native-id prefix");
assert.equal(windowStub.utools.getNativeId(), nativeId, "native id should be stable within the same plugin host");
assert.equal(storage.get("atools:nativeId"), nativeId, "native id should persist in localStorage when available");

assert.equal(typeof windowStub.utools.getAppName, "function", "utools.getAppName should be exposed");
assert.equal(windowStub.utools.getAppName(), packageInfo.productName, "app name should follow package productName");

assert.equal(typeof windowStub.utools.getAppVersion, "function", "utools.getAppVersion should be exposed");
assert.equal(windowStub.utools.getAppVersion(), packageInfo.version, "app version should follow package version");

assert.equal(typeof windowStub.utools.isDev, "function", "utools.isDev should be exposed");
assert.equal(windowStub.utools.isDev(), false, "imported plugins should not be reported as uTools developer-tool sessions");

assert.equal(typeof windowStub.utools.isLinux, "function", "utools.isLinux should be exposed");
assert.equal(windowStub.utools.isLinux(), true, "Linux platform detection should use navigator platform/userAgent");

assert.ok(dispatchedEvents.includes("atools-plugin-enter"));
assert.ok(dispatchedEvents.includes("atools-plugin-ready"));

assert.match(panelSource, /import packageInfo from "\.\.\/\.\.\/package\.json"/);
assert.match(panelSource, /productName:\s*packageInfo\.productName[\s\S]*productVersion:\s*packageInfo\.version/,
  "PluginPanel should pass package identity into the document source host");
assert.match(documentSource, /appName:\s*ports\.productName,\s*appVersion:\s*ports\.productVersion/,
  "document source host should pass product identity into bridge compilation");
assert.match(compilerSource, /APP_NAME\|APP_VERSION\)__\/g,\s*token\s*=>\s*pluginBridgeJson\(parameters\[token as keyof typeof parameters\]\)/,
  "bridge compiler should inject the product name and version placeholders");
assert.match(nativeIdentitySource, /function _getNativeId\(\)/, "bridge should keep native id generation in its identity owner");
assert.match(providerEntrySource, /getNativeId:\s*function\(\)/, "bridge should expose utools.getNativeId in its API owner");
assert.match(providerEntrySource, /getAppName:\s*function\(\)/, "bridge should expose getAppName in its API owner");
assert.match(providerEntrySource, /getAppVersion:\s*function\(\)/, "bridge should expose getAppVersion in its API owner");
assert.match(providerEntrySource, /isDev:\s*function\(\)/, "bridge should expose isDev in its API owner");
assert.match(providerEntrySource, /isLinux:\s*function\(\)/, "bridge should expose isLinux in its API owner");
assert.match(capabilitySource, /"getNativeId"/, "shared capability inventory should include getNativeId");
assert.match(capabilitySource, /"getAppName"/, "shared capability inventory should include getAppName");
assert.match(capabilitySource, /"getAppVersion"/, "shared capability inventory should include getAppVersion");
assert.match(capabilitySource, /"isDev"/, "shared capability inventory should include isDev");
assert.match(capabilitySource, /"isLinux"/, "shared capability inventory should include isLinux");
