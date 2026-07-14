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
  .replace(/__PLUGIN_ID__/g, JSON.stringify("all-docs-filter-test-plugin"))
  .replace(/__FEATURE_CODE__/g, JSON.stringify("all-docs-filter-test-feature"))
  .replace(/__APP_NAME__/g, JSON.stringify("ATools 3.0"))
  .replace(/__APP_VERSION__/g, JSON.stringify("3.0.0"));

const allDocs = [
  { _id: "user/a", title: "A" },
  { _id: "user/b", title: "B" },
  { _id: "settings", title: "Settings" },
  { _id: "__attachment__:user/a:attachment", title: "Attachment metadata" },
];
const invokeCalls = [];
const listeners = new Map();

const windowStub = {
  parent: {
    postMessage(message) {
      if (!message?.__ipc_call__) return;
      void windowStub.__TAURI_INTERNALS__.invoke(message.cmd, message.args)
        .then((result) => {
          const callbacks = listeners.get("message") || [];
          callbacks.forEach((callback) => callback({
            data: { __ipc_response__: true, reqId: message.reqId, result },
          }));
        })
        .catch((error) => {
          const callbacks = listeners.get("message") || [];
          callbacks.forEach((callback) => callback({
            data: { __ipc_response__: true, reqId: message.reqId, error: String(error) },
          }));
        });
    },
  },
  top: {},
  __TAURI_INTERNALS__: {
    async invoke(cmd, args = {}) {
      invokeCalls.push({ cmd, args });
      if (cmd === "get_plugin_data") return allDocs;
      return null;
    },
  },
  localStorage: {
    getItem() { return null; },
    setItem() {},
    removeItem() {},
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

assert.equal(typeof windowStub.utools.db.allDocs, "function", "utools.db.allDocs should be exposed");
assert.equal(
  windowStub.utools.db.promises.allDocs,
  windowStub.utools.db.allDocs,
  "promises bridge should expose the same allDocs filter behavior",
);

assert.deepEqual(
  (await windowStub.utools.db.allDocs()).map((doc) => doc._id),
  ["user/a", "user/b", "settings", "__attachment__:user/a:attachment"],
  "allDocs() should return all plugin docs",
);
assert.deepEqual(
  (await windowStub.utools.db.allDocs("user/")).map((doc) => doc._id),
  ["user/a", "user/b"],
  "allDocs(prefix) should return only matching document IDs",
);
assert.deepEqual(
  (await windowStub.utools.db.allDocs(["settings", "missing", "user/a"])).map((doc) => doc._id),
  ["settings", "user/a"],
  "allDocs(ids) should return existing documents in requested ID order",
);
assert.deepEqual(
  (await windowStub.utools.db.promises.allDocs("settings")).map((doc) => doc._id),
  ["settings"],
  "db.promises.allDocs should preserve prefix filtering",
);

assert.ok(
  invokeCalls.every((call) => call.cmd === "get_plugin_data" && call.args.pluginId === "all-docs-filter-test-plugin"),
  "allDocs should keep using the plugin-scoped data bridge",
);
assert.match(componentSource, /function _filterDbDocs/);
assert.match(componentSource, /allDocs: function\(opts\)/);
assert.match(capabilitySource, /"db.allDocs"/);
