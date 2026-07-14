import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const componentSource = await readFile(new URL("src/components/PluginPanel.svelte", root), "utf8");

const bridgeMatch = componentSource.match(/const UTOOLS_BRIDGE = `([\s\S]*?)`;/);
assert.ok(bridgeMatch, "PluginPanel should define the injected utools bridge");

let bridgeSource = bridgeMatch[1]
  .replace(/<\\\/script>/g, "</script>")
  .replace(/^\s*<script>\s*/, "")
  .replace(/\s*<\/script>\s*$/, "")
  .replace(/__PLUGIN_ID__/g, JSON.stringify("storage-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("storage-test-feature"));

const listeners = new Map();
const localStorageData = new Map();
const invokeCalls = [];
const postedMessages = [];

const windowStub = {
  parent: {
    postMessage(message) {
      postedMessages.push(message);
    },
  },
  top: {},
  __TAURI_INTERNALS__: {
    async invoke(cmd, args = {}) {
      invokeCalls.push({ cmd, args });
      return null;
    },
  },
  localStorage: {
    setItem(key, value) {
      localStorageData.set(key, String(value));
    },
    getItem(key) {
      return localStorageData.has(key) ? localStorageData.get(key) : null;
    },
    removeItem(key) {
      localStorageData.delete(key);
    },
  },
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
windowStub.parent.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;
windowStub.top.__TAURI_INTERNALS__ = windowStub.__TAURI_INTERNALS__;

class EventStub {
  constructor(type) {
    this.type = type;
  }
}

const context = vm.createContext({
  window: windowStub,
  localStorage: windowStub.localStorage,
  document: {
    readyState: "complete",
    addEventListener() {},
  },
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

assert.equal(typeof windowStub.utools.dbStorage, "object", "utools.dbStorage should be exposed");
assert.equal(typeof windowStub.utools.dbStorage.setItem, "function");
assert.equal(typeof windowStub.utools.dbStorage.getItem, "function");
assert.equal(typeof windowStub.utools.dbStorage.removeItem, "function");

const setResult = windowStub.utools.dbStorage.setItem("profile", { name: "A", count: 2 });
assert.equal(setResult, undefined, "dbStorage.setItem should keep the official void-return shape");
const profile = windowStub.utools.dbStorage.getItem("profile");
assert.equal(profile.name, "A");
assert.equal(profile.count, 2);

windowStub.utools.dbStorage.setItem("token", "abc");
assert.equal(windowStub.utools.dbStorage.getItem("token"), "abc");
windowStub.utools.dbStorage.setItem("enabled", false);
assert.equal(windowStub.utools.dbStorage.getItem("enabled"), false);

windowStub.utools.dbStorage.removeItem("profile");
assert.equal(windowStub.utools.dbStorage.getItem("profile"), null);
assert.equal(windowStub.utools.dbStorage.removeItem("profile"), undefined);

const storedKeys = [...localStorageData.keys()].sort();
assert.deepEqual(storedKeys, [
  "atools:dbStorage:storage-test-plugin:enabled",
  "atools:dbStorage:storage-test-plugin:token",
]);
assert.equal(invokeCalls.length, 0, "dbStorage should remain synchronous and not call async invoke");
assert.deepEqual(postedMessages, [], "dbStorage should not post host messages for sync key/value operations");
assert.match(componentSource, /function _createDbStorage/);
assert.match(componentSource, /dbStorage: _createDbStorage\(\)/);
